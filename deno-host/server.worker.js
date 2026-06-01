// Worker: static HTTP server (project root) + state API + Kokoro TTS.
// Runs on its own event loop so it keeps serving while the main thread is
// parked inside the blocking webview app.run(). The webview loads
// http://127.0.0.1:<port>/renderer/index.html from here, so all of the
// renderer's relative fetches and its window.cs state/tts calls resolve
// same-origin with no file:// CORS issues.
//
// TTS: we spawn the project's existing tools/kokoro-worker.mjs as a Node
// subprocess (onnxruntime-node — a native addon that won't load in Deno) and
// JSON-RPC over stdio, exactly like the Electron main process did. The
// resulting WAV is served back over HTTP so the renderer plays it through the
// reliable <audio> path (WebView2's speechSynthesis is silent — empty voices).

import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { join, normalize, basename } from "jsr:@std/path@1";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const APPDATA = Deno.env.get("APPDATA") || Deno.env.get("HOME") || ROOT;
const STATE_DIR = join(APPDATA, "claudes-body");
const STATE_FILE = join(STATE_DIR, "claude-says-state.json");
const TTS_DIR = join(Deno.env.get("TEMP") || Deno.env.get("TMP") || ".", "claudes-body-tts");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".wav": "audio/wav", ".mp3": "audio/mpeg",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".vrm": "application/octet-stream", ".vrma": "application/octet-stream",
  ".glb": "model/gltf-binary", ".wasm": "application/wasm",
};
function ext(p) { const i = p.lastIndexOf("."); return i < 0 ? "" : p.slice(i).toLowerCase(); }

function loadState() { try { return JSON.parse(Deno.readTextFileSync(STATE_FILE)); } catch (_) { return {}; } }
function saveState(obj) {
  try { Deno.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) {}
  try { Deno.writeTextFileSync(STATE_FILE, JSON.stringify(obj, null, 2)); return true; } catch (_) { return false; }
}

// ---------- Kokoro TTS subprocess ----------
const KOKORO_VOICES = { male: "am_michael", female: "af_bella" };
let kokoro = null;        // Deno.ChildProcess
let kokoroWriter = null;
let kokoroReady = false;
let kokoroFailed = false;
const ttsPending = new Map();  // id -> { resolve }
let ttsNextId = 1;

function startKokoro() {
  try {
    const cmd = new Deno.Command("node", {
      args: ["tools/kokoro-worker.mjs"],
      cwd: ROOT,
      stdin: "piped", stdout: "piped", stderr: "piped",
    });
    kokoro = cmd.spawn();
    kokoroWriter = kokoro.stdin.getWriter();
    readLines(kokoro.stdout, (line) => {
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      const h = ttsPending.get(msg.id);
      if (!h) return;
      ttsPending.delete(msg.id);
      h.resolve(msg.ok ? msg.path : null);
    });
    readLines(kokoro.stderr, (line) => {
      if (line.includes("ready")) { kokoroReady = true; console.error("[kokoro] ready"); }
      else console.error("[kokoro] " + line);
    });
    kokoro.status.then((s) => {
      console.error("[kokoro] exited", s.code);
      kokoro = null; kokoroReady = false; kokoroFailed = true;
      for (const [, h] of ttsPending) h.resolve(null);
      ttsPending.clear();
    });
  } catch (e) {
    console.error("[kokoro] spawn failed:", e.message);
    kokoroFailed = true;
  }
}

async function readLines(stream, onLine) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln) onLine(ln); }
  }
}

const enc = new TextEncoder();
// Cache synthesized WAVs by (voice|text). The renderer pre-warms the first
// chunk, then claude.speak() re-requests the same chunk — a cache hit makes
// that second call instant, so the audio starts in step with the animation.
const ttsCache = new Map();
const ttsInFlight = new Map();
async function ttsSynthRaw(text, voice) {
  const t0 = Date.now();
  while (!kokoroReady && !kokoroFailed && Date.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 150));
  if (!kokoroReady || !kokoro) return null;
  const id = ttsNextId++;
  const p = new Promise((resolve) => ttsPending.set(id, { resolve }));
  try { await kokoroWriter.write(enc.encode(JSON.stringify({ id, text, voice }) + "\n")); }
  catch (_) { ttsPending.delete(id); return null; }
  return await p; // absolute WAV path or null
}
async function ttsSynth(text, voice) {
  const key = voice + "|" + text;
  const cached = ttsCache.get(key);
  if (cached) { try { Deno.statSync(cached); return cached; } catch (_) { ttsCache.delete(key); } }
  // Coalesce concurrent requests for the same text (pre-warm + claude.speak).
  if (ttsInFlight.has(key)) return await ttsInFlight.get(key);
  const work = ttsSynthRaw(text, voice).then((path) => {
    if (path) {
      ttsCache.set(key, path);
      if (ttsCache.size > 64) ttsCache.delete(ttsCache.keys().next().value);
    }
    ttsInFlight.delete(key);
    return path;
  });
  ttsInFlight.set(key, work);
  return await work;
}

// ---------- static file serving ----------
async function serveFile(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const full = normalize(join(ROOT, "." + rel));
  if (!full.startsWith(normalize(ROOT))) return new Response("forbidden", { status: 403 });
  try {
    const data = await Deno.readFile(full);
    return new Response(data, { headers: { "content-type": MIME[ext(full)] || "application/octet-stream", "cache-control": "no-cache" } });
  } catch (_) { return new Response("not found: " + rel, { status: 404 }); }
}

async function serveTtsAudio(name) {
  const safe = basename(name);
  try {
    const data = await Deno.readFile(join(TTS_DIR, safe));
    return new Response(data, { headers: { "content-type": "audio/wav", "cache-control": "no-cache" } });
  } catch (_) { return new Response("not found", { status: 404 }); }
}

async function handler(req) {
  const url = new URL(req.url);
  const p = url.pathname;

  if (p === "/api/state" && req.method === "GET") return Response.json(loadState());
  if (p === "/api/state" && req.method === "POST") {
    let body = {}; try { body = await req.json(); } catch (_) {}
    // Merge, don't replace: the renderer saves its settings object (no x/y/size),
    // while the host saves window position/size into the same file. A blind
    // replace would let each wipe the other's fields.
    return Response.json({ ok: saveState({ ...loadState(), ...body }) });
  }
  if (p === "/api/tts-available") {
    // Optimistic: true unless the subprocess outright failed to start. The
    // renderer caches this permanently, so we must not report false just
    // because the model is still warming up.
    return Response.json({ available: !kokoroFailed });
  }
  if (p === "/api/tts" && req.method === "POST") {
    let body = {}; try { body = await req.json(); } catch (_) {}
    const voice = KOKORO_VOICES[body.gender] || KOKORO_VOICES.male;
    const path = await ttsSynth(String(body.text || ""), voice);
    console.error(`[tts] synth voice=${voice} -> ${path ? basename(path) : "FAILED"}`);
    return Response.json({ url: path ? `/tts-audio/${basename(path)}` : null });
  }
  if (p.startsWith("/tts-audio/")) return await serveTtsAudio(p.slice("/tts-audio/".length));

  return await serveFile(p === "/" ? "/renderer/index.html" : p);
}

startKokoro();

Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => { self.postMessage({ type: "ready", port, root: ROOT }); },
}, handler);
