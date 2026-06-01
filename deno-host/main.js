// claude-says — Deno + tao/wry webview host (replaces the Electron main process).
//
//   Worker  → static HTTP server (renderer + assets) + state API, own event loop.
//   Main    → transparent/frameless/always-on-top window, blocking app.run().
//   Win32   → window move/resize/click-through + Ctrl+Shift+L (binding can't).
//   Preload → recreates window.cs so the renderer runs UNCHANGED.
//
// The renderer ticks us (~150ms) over IPC; on each tick we poll the Stop-hook
// spool + the Claude Code transcripts and push new assistant text in via
// webview.evaluateScript(window.__cs.emit(...)).

import { Application } from "npm:@webviewjs/webview@0.1.4";
import { join } from "jsr:@std/path@1";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import * as win32 from "./win32.js";

const WIN_TITLE = "Claude's Body";
const DEFAULT_W = 360, DEFAULT_H = 420;

// ---------- paths (match the Electron build) ----------
const TMP = Deno.env.get("TEMP") || Deno.env.get("TMP") || ".";
const SPOOL_PATH = join(TMP, "claude-says-spool.json");
const HOME = Deno.env.get("USERPROFILE") || Deno.env.get("HOME") || ".";
const PROJECTS_DIR = join(HOME, ".claude", "projects");
const APPDATA = Deno.env.get("APPDATA") || HOME;
const STATE_FILE = join(APPDATA, "claudes-body", "claude-says-state.json");

function loadState() {
  try { return JSON.parse(Deno.readTextFileSync(STATE_FILE)); } catch (_) { return {}; }
}

// ---------- start the worker HTTP server, await its port ----------
const worker = new Worker(new URL("./server.worker.js", import.meta.url), { type: "module" });
const { port } = await new Promise((resolve) => {
  worker.onmessage = (e) => { if (e.data?.type === "ready") resolve(e.data); };
});
const BASE = `http://127.0.0.1:${port}`;
console.log(`[claude-says] server ready on ${BASE}`);

// ---------- preload: recreate window.cs ----------
const PRELOAD = `
(function () {
  const pending = new Map(); let nextId = 1;
  const L = { say: [], hush: [], toggleLock: [] };
  function send(o) { try { window.ipc.postMessage(JSON.stringify(o)); } catch (e) {} }
  function call(method, args) {
    const id = nextId++;
    return new Promise((res) => { pending.set(id, res); send({ t: "call", id, method, args }); });
  }
  function notify(method, args) { send({ t: "notify", method, args }); }
  window.__cs = {
    resolve(id, val) { const r = pending.get(id); if (r) { pending.delete(id); r(val); } },
    emit(evt, payload) { (L[evt] || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } }); },
  };
  function sub(arr) { return (cb) => { arr.push(cb); return () => { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1); }; }; }
  window.cs = {
    getWindowPosition: () => call("getWindowPosition"),
    moveWindow: (x, y) => notify("moveWindow", [x, y]),
    minimize: () => notify("minimize"),
    quit: () => notify("quit"),
    setIgnoreMouseEvents: (ignore, options) => notify("setIgnoreMouseEvents", [!!ignore, options || {}]),
    setWindowSize: (w, h) => notify("setWindowSize", [w, h]),
    getState: async () => { try { return await (await fetch("/api/state")).json(); } catch (_) { return {}; } },
    setState: async (s) => { try { await fetch("/api/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(s) }); return true; } catch (_) { return false; } },
    onSay: sub(L.say),
    onHush: sub(L.hush),
    onToggleLock: sub(L.toggleLock),
    platform: "win32",
    saveDebugFrame: (name, dataUrl) => notify("saveDebugFrame", [name, dataUrl]),
    saveIconPng: (dataUrl) => notify("saveIconPng", [dataUrl]),
    ttsAvailable: async () => { try { return (await (await fetch("/api/tts-available")).json()).available; } catch (_) { return false; } },
    ttsSynth: async (text, gender) => { try { return (await (await fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, gender }) })).json()).url || null; } catch (_) { return null; } },
  };
  // Report viewport + DPR so the host can calibrate screen<->CSS scaling.
  function postInit() { send({ t: "notify", method: "__init", args: [window.innerWidth, window.innerHeight, window.devicePixelRatio] }); }
  if (document.readyState !== "loading") postInit();
  window.addEventListener("DOMContentLoaded", postInit);
  window.addEventListener("resize", postInit);
  setTimeout(postInit, 600); setTimeout(postInit, 1500);

  // Drive the host's watchers + hotkey + cursor-forwarding from the renderer's
  // clock. 40ms keeps hover/grab responsive while click-through is active.
  setInterval(() => send({ t: "notify", method: "__tick" }), 40);
})();
`;

// ---------- create window ----------
const state = loadState();
const W = Number.isFinite(state.width) ? state.width : DEFAULT_W;   // CSS px (renderer's units)
const H = Number.isFinite(state.height) ? state.height : DEFAULT_H;

// Make the process DPI-aware and read the scale BEFORE creating the window, so
// we can create it at the right PHYSICAL size (the binding sizes in physical
// px). This avoids a mid-session resize, which the renderer doesn't re-layout
// cleanly. The renderer then initializes once at W x H CSS px (like Electron).
win32.ensureDpiAware();
let scale = win32.getSystemScale() || 1;
const physW = Math.round(W * scale);
const physH = Math.round(H * scale);

// Initial placement (physical px): saved spot, else bottom-right above taskbar.
let initX, initY;
if (Number.isFinite(state.x) && Number.isFinite(state.y)) {
  initX = Math.round(state.x * scale); initY = Math.round(state.y * scale);
} else {
  const wa = win32.getWorkArea();
  if (wa) { initX = wa.right - physW - Math.round(16 * scale); initY = wa.bottom - physH - Math.round(16 * scale); }
}
console.log(`[claude-says] scale=${scale} physical=${physW}x${physH} at ${initX},${initY}`);

// WebView2 gates audio/AudioContext autoplay behind a user gesture by default.
// The renderer routes its welcome WAV (and all speech) through an AudioContext
// for lip-sync, so a suspended context means the audio never plays, 'ended'
// never fires, welcomeBlocking stays true, and the speech queue freezes — i.e.
// Claude only ever plays the greeting (if that). Pass the Chromium flag that
// disables the gesture requirement so AudioContext starts running immediately.
Deno.env.set("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--autoplay-policy=no-user-gesture-required");

const app = new Application();
const win = app.createBrowserWindow({
  title: WIN_TITLE,
  width: physW,
  height: physH,
  x: initX,
  y: initY,
  transparent: true,
  decorations: false,
  alwaysOnTop: true,
  resizable: false,
  visible: true,
});

const webview = win.createWebview({
  url: `${BASE}/renderer/index.html`,
  preload: PRELOAD,
  transparent: true,
  enableDevtools: true,
  autoplay: true, // allow the welcome WAV (and all speech) to play without a user gesture
});

// Custom taskbar/window icon (the Electron build icon, pre-decoded to raw
// 256x256 RGBA — the binding wants pixel bytes, not a path).
try {
  const rgba = Deno.readFileSync(fromFileUrl(new URL("./icon-256.rgba", import.meta.url)));
  win.setWindowIcon(Array.from(rgba), 256, 256);
  console.log("[claude-says] window icon set (256x256 rgba)");
} catch (e) {
  console.log("[claude-says] window icon failed:", e.message);
}

// ---------- emit helpers (host → renderer) ----------
const dec = new TextDecoder();
// JSON.stringify leaves U+2028/U+2029 raw — legal in JSON, illegal in a JS
// string literal — which would make evaluateScript throw and silently drop the
// event. Escape them so any assistant text survives the round-trip.
function jsLit(v) { return JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function emit(evt, payload) {
  try { webview.evaluateScript(`window.__cs && window.__cs.emit(${jsLit(evt)}, ${jsLit(payload)})`); }
  catch (e) { console.error("[emit] failed:", e.message); }
}
function resolve(id, val) {
  try { webview.evaluateScript(`window.__cs && window.__cs.resolve(${id}, ${jsLit(val)})`); }
  catch (e) { console.error("[resolve] failed:", e.message); }
}

// ---------- transcript / spool watching (ported from Electron main.js) ----------
const RECENT_SIZE = 8;
const recentSpoken = [];
function sendSay(text, source) {
  if (!text) return;
  if (recentSpoken.includes(text)) { console.log(`[claude-says] say skipped (dupe, ${source})`); return; }
  console.log(`[claude-says] say (${source}): ${JSON.stringify(text.slice(0, 70))}`);
  recentSpoken.push(text);
  if (recentSpoken.length > RECENT_SIZE) recentSpoken.shift();
  emit("say", { text, source, ts: Date.now() });
}

let spoolLastMtime = 0, spoolLastTs = 0;
try { spoolLastMtime = Deno.statSync(SPOOL_PATH).mtime?.getTime() || 0; } catch (_) {}
function pollSpool() {
  let st;
  try { st = Deno.statSync(SPOOL_PATH); } catch (_) { return; }
  const mt = st.mtime?.getTime() || 0;
  if (mt <= spoolLastMtime) return;
  spoolLastMtime = mt;
  let data;
  try { data = JSON.parse(Deno.readTextFileSync(SPOOL_PATH)); } catch (_) { return; }
  if (!data || typeof data.text !== "string" || !data.text.trim()) return;
  if (data.ts && data.ts === spoolLastTs) return;
  spoolLastTs = data.ts;
  sendSay(data.text.trim(), data.source || "spool");
}

function listJsonl(dir, out) {
  let entries;
  try { entries = Deno.readDirSync(dir); } catch (_) { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory) listJsonl(full, out);
    else if (e.isFile && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}
function findActiveTranscript() {
  const files = listJsonl(PROJECTS_DIR, []);
  let best = null, bestMt = 0;
  for (const f of files) {
    let st; try { st = Deno.statSync(f); } catch (_) { continue; }
    const mt = st.mtime?.getTime() || 0;
    if (mt > bestMt) { bestMt = mt; best = f; }
  }
  return best ? { file: best, mtime: bestMt } : null;
}
function scanTranscript(raw) {
  const lines = raw.split("\n");
  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]; if (!ln) continue;
    let entry; try { entry = JSON.parse(ln); } catch (_) { continue; }
    const role = entry.role || (entry.message && entry.message.role) || entry.type;
    if (role !== "user" && entry.type !== "user") continue;
    const content = entry.content != null ? entry.content : (entry.message && entry.message.content);
    let isHuman = false;
    if (typeof content === "string" && content.trim()) isHuman = true;
    else if (Array.isArray(content)) isHuman = content.some((c) => c && c.type === "text" && typeof c.text === "string" && c.text.trim());
    if (isHuman) { lastUserIdx = i; break; }
  }
  let text = "";
  for (let i = lines.length - 1; i > lastUserIdx; i--) {
    const ln = lines[i]; if (!ln) continue;
    let entry; try { entry = JSON.parse(ln); } catch (_) { continue; }
    const role = entry.role || (entry.message && entry.message.role) || entry.type;
    if (role !== "assistant" && entry.type !== "assistant") continue;
    const content = entry.content != null ? entry.content : (entry.message && entry.message.content);
    let t = "";
    if (typeof content === "string") t = content;
    else if (Array.isArray(content)) t = content.filter((c) => c && c.type === "text" && typeof c.text === "string").map((c) => c.text || "").join("\n");
    t = t && t.trim();
    if (t) { text = t; break; }
  }
  return { text, lastUserIdx };
}

let trLastFile = "", trLastMtime = 0, trLastUserIdx = -1;
(function seedTranscript() {
  const active = findActiveTranscript();
  if (!active) return;
  trLastFile = active.file; trLastMtime = active.mtime;
  try {
    const scan = scanTranscript(Deno.readTextFileSync(active.file));
    trLastUserIdx = scan.lastUserIdx;
    if (scan.text) recentSpoken.push(scan.text);
  } catch (_) {}
})();
function pollTranscript() {
  const active = findActiveTranscript();
  if (!active) return;
  if (active.file === trLastFile && active.mtime <= trLastMtime) return;
  trLastFile = active.file; trLastMtime = active.mtime;
  let raw; try { raw = Deno.readTextFileSync(active.file); } catch (_) { return; }
  const { text, lastUserIdx } = scanTranscript(raw);
  console.log(`[claude-says] transcript change: ${active.file.split(/[\\/]/).pop()} textLen=${text ? text.length : 0} userIdx=${lastUserIdx}/${trLastUserIdx}`);
  if (lastUserIdx > trLastUserIdx) { trLastUserIdx = lastUserIdx; emit("hush", null); }
  if (text) sendSay(text, "transcript");
}

// Click-through state + screen<->CSS scale calibration.
//   scale = (window width in GetWindowRect-space) / (CSS viewport width).
// This is self-calibrating: it equals the DPI factor when the process is
// DPI-aware, and 1.0 when Windows is virtualizing coords for a DPI-unaware
// process — so screen<->CSS conversions are correct either way.
// Click-through state. `scale` (declared up top) is the screen<->CSS ratio used
// for cursor forwarding and drag/move; the window is already sized at W x H CSS
// px, so calibrate just confirms the ratio from the renderer's reported viewport.
let clickThrough = false;
let cssW = W, cssH = H;
let lastPos = null, lastPosSave = 0;

let placed = false;
function calibrate(innerW, innerH) {
  cssW = innerW || cssW;
  cssH = innerH || cssH;
  const r = win32.getWindowRect(WIN_TITLE);
  if (r && r.width > 0 && cssW > 0) {
    scale = r.width / cssW;
    console.log(`[claude-says] calibrate: rect=${r.width}x${r.height} css=${cssW}x${cssH} scale=${scale.toFixed(3)}`);
  }
  // The binding ignores x/y at creation (it centers the window), so enforce the
  // intended placement here, once, after the window is realized.
  if (!placed && Number.isFinite(initX) && Number.isFinite(initY)) {
    placed = true;
    win32.moveWindow(WIN_TITLE, initX, initY);
    console.log(`[claude-says] moved to ${initX},${initY}`);
  }
}

// While click-through is active the window receives no mouse input, so the
// renderer can't hit-test to know when the cursor returns over the character.
// We forward it ourselves: poll the global cursor, map screen→CSS coords, and
// synthesize a mousemove. This is the equivalent of Electron's forward:true.
let lastFwdX = -1, lastFwdY = -1;
function forwardCursor() {
  const c = win32.getCursorPos();
  if (!c) return;
  if (c.x === lastFwdX && c.y === lastFwdY) return; // only forward on real movement
  lastFwdX = c.x; lastFwdY = c.y;
  const r = win32.getWindowRect(WIN_TITLE);
  if (!r || r.width <= 0 || r.height <= 0) return;
  const px = c.x - r.x, py = c.y - r.y;
  if (px < 0 || py < 0 || px > r.width || py > r.height) return;
  const x = Math.round(px / scale);   // screen-space → CSS px
  const y = Math.round(py / scale);
  try {
    webview.evaluateScript(
      `document.dispatchEvent(new MouseEvent('mousemove',{clientX:${x},clientY:${y},bubbles:true}))`,
    );
  } catch (_) {}
}

let lastSpoolPoll = 0, lastTranscriptPoll = 0;
function onTick() {
  const now = performance.now();
  if (now - lastSpoolPoll > 180) { lastSpoolPoll = now; pollSpool(); }
  if (now - lastTranscriptPoll > 500) { lastTranscriptPoll = now; pollTranscript(); }
  if (win32.pollLockHotkey()) { console.log("[claude-says] Ctrl+Shift+L"); emit("toggleLock", null); }
  if (clickThrough) forwardCursor();
}

// ---------- IPC dispatch (renderer → host) ----------
webview.onIpcMessage((msg) => {
  let m;
  try { m = JSON.parse(dec.decode(msg.body)); } catch (_) { return; }
  const method = m.method;
  const a = m.args || [];
  try {
    switch (method) {
      case "__init": calibrate(a[0], a[1]); break;
      case "__tick": onTick(); break;
      case "moveWindow": {
        win32.moveWindow(WIN_TITLE, Math.round(a[0] * scale), Math.round(a[1] * scale));
        lastPos = [a[0], a[1]];
        const now = performance.now();
        if (now - lastPosSave > 800) {
          lastPosSave = now;
          const s = loadState(); s.x = a[0]; s.y = a[1];
          try { Deno.writeTextFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {}
        }
        break;
      }
      case "setWindowSize": {
        cssW = a[0]; cssH = a[1];
        win32.resizeWindow(WIN_TITLE, Math.round(a[0] * scale), Math.round(a[1] * scale));
        const s = loadState(); s.width = a[0]; s.height = a[1];
        try { Deno.writeTextFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {}
        break;
      }
      case "setIgnoreMouseEvents": clickThrough = !!a[0]; win32.setClickThrough(WIN_TITLE, a[0]); break;
      case "minimize": win32.minimizeWindow(WIN_TITLE); break;
      case "quit": {
        if (lastPos) { const s = loadState(); s.x = lastPos[0]; s.y = lastPos[1]; try { Deno.writeTextFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {} }
        app.exit();
        break;
      }
      case "getWindowPosition": {
        const r = win32.getWindowRect(WIN_TITLE);
        resolve(m.id, r ? [Math.round(r.x / scale), Math.round(r.y / scale)] : [0, 0]);
        break;
      }
      case "saveDebugFrame": case "saveIconPng": break; // not needed for normal run
      default: break;
    }
  } catch (e) { console.error("[ipc]", method, e.message); }
});

console.log(`[claude-says] spool=${SPOOL_PATH}`);
console.log(`[claude-says] projects=${PROJECTS_DIR}`);
console.log(`[claude-says] seeded transcript=${trLastFile || "(none)"}`);
console.log("[claude-says] entering event loop");
app.run();
