'use strict';

// ============================================================================
// claude-says — Electron main process
//
// Responsibilities:
//   1. Create a transparent, frameless, always-on-top BrowserWindow
//   2. Run a tiny HTTP server on 127.0.0.1:7777 that the Stop hook POSTs to
//   3. Forward incoming text to the renderer via IPC
//   4. Handle window-drag IPC from the renderer (we drive drag manually so we
//      can fire start/end events for animations)
//   5. Persist window position + user preferences across sessions
// ============================================================================

const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const http = require('http');
const fs   = require('fs');
const os   = require('os');

const SERVER_PORT = 7777;
const WIN_WIDTH   = 360;
const WIN_HEIGHT  = 420;

// File the Stop hook writes new lines into. We poll it 5×/sec and forward
// new content to the renderer. Polling instead of fs.watch because fs.watch
// is unreliable on Windows.
const SPOOL_PATH = path.join(os.tmpdir(), 'claude-says-spool.json');

// Claude Code's transcript files. The Stop hook is the preferred path, but
// Claude Code doesn't always invoke it (close-together turns can drop fires).
// We also tail the JSONL transcripts directly as a fallback so no assistant
// turn ever goes unspoken.
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Mutable size — updated when the renderer picks a new size in settings.
// Used by the move-window IPC so the size is enforced on every drag tick
// (Aero Snap / cross-DPI moves can otherwise change it).
let currentWidth  = WIN_WIDTH;
let currentHeight = WIN_HEIGHT;

// Single-instance: if user launches a second copy, focus the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------- settings persistence ----------
function settingsFile() {
  const dir = app.getPath('userData');
  return path.join(dir, 'claude-says-state.json');
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); }
  catch (_) { return {}; }
}
function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(state, null, 2));
  } catch (_) {}
}

// ---------- window ----------
let mainWindow = null;

function createWindow() {
  const state    = loadState();
  if (Number.isFinite(state.width))  currentWidth  = state.width;
  if (Number.isFinite(state.height)) currentHeight = state.height;
  const display  = screen.getPrimaryDisplay();
  const work     = display.workArea;
  const defaultX = work.x + work.width  - currentWidth  - 24;
  const defaultY = work.y + work.height - currentHeight - 24;

  // Icon-capture mode wants a square canvas so the mane fits without
  // horizontal clipping.
  const iconCapture = process.argv.includes('--capture-icon');
  if (iconCapture) { currentWidth = 512; currentHeight = 512; }
  mainWindow = new BrowserWindow({
    title: "Claude's Body",
    width:  currentWidth,
    height: currentHeight,
    x: Number.isFinite(state.x) ? state.x : defaultX,
    y: Number.isFinite(state.y) ? state.y : defaultY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Float above fullscreen apps too (so we ride along with VS Code in fullscreen)
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  if (mainWindow.setVisibleOnAllWorkspaces) {
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  const indexPath = path.join(__dirname, 'renderer', 'index.html');
  const captureIcon = process.argv.includes('--capture-icon');
  console.log('[claude-says] loading', indexPath, captureIcon ? '(icon-capture mode)' : '');
  if (captureIcon) {
    mainWindow.loadFile(indexPath, { search: 'capture=icon' });
  } else {
    mainWindow.loadFile(indexPath);
  }

  // Surface renderer crashes / load failures
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[claude-says] did-fail-load (${code}) ${desc} → ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[claude-says] render-process-gone:`, details);
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer ${level}] ${source}:${line} ${message}`);
  });

  // DevTools off by default. Set CLAUDE_SAYS_DEBUG=1 to turn back on.
  if (process.env.CLAUDE_SAYS_DEBUG === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('moved', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [x, y] = mainWindow.getPosition();
    const s = loadState();
    s.x = x; s.y = y;
    saveState(s);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- spool watcher (preferred path; hook writes here, we poll) ----------
let spoolPollTimer  = null;
let spoolLastMtime  = 0;
let spoolLastTs     = 0;

function startSpoolWatcher() {
  // Initialize with the current mtime so we don't replay any stale event
  // that's already sitting in the spool from a previous session.
  try { spoolLastMtime = fs.statSync(SPOOL_PATH).mtimeMs; } catch (_) {}

  spoolPollTimer = setInterval(() => {
    let stat;
    try { stat = fs.statSync(SPOOL_PATH); }
    catch (_) { return; }                // file doesn't exist yet
    if (stat.mtimeMs <= spoolLastMtime) return;
    spoolLastMtime = stat.mtimeMs;

    let raw;
    try { raw = fs.readFileSync(SPOOL_PATH, 'utf8'); }
    catch (_) { return; }
    if (!raw || !raw.trim()) return;

    let data;
    try { data = JSON.parse(raw); }
    catch (_) { return; }

    if (!data || typeof data.text !== 'string' || !data.text.trim()) return;
    if (data.ts && data.ts === spoolLastTs) return;
    spoolLastTs = data.ts;

    sendSay(data.text.trim(), data.source || 'spool');
  }, 200);
}

// ---------- transcript watcher (fallback for missed Stop hook fires) ----------
// Walks ~/.claude/projects/**/*.jsonl, picks the most-recently-modified file,
// and extracts the latest assistant text. Sends to renderer via the same IPC
// path the spool uses. We dedupe against `lastSpokenText` so a single turn
// can't be spoken twice (whichever source — hook or transcript — wins).
let transcriptPollTimer = null;
let transcriptLastFile  = '';
let transcriptLastMtime = 0;
let transcriptLastUserIdx = -1;
let lastSpokenText      = '';

function listJsonlFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listJsonlFiles(full));
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function findActiveTranscript() {
  const files = listJsonlFiles(PROJECTS_DIR);
  let best = null;
  let bestMtime = 0;
  for (const f of files) {
    let stat;
    try { stat = fs.statSync(f); } catch (_) { continue; }
    if (stat.mtimeMs > bestMtime) {
      bestMtime = stat.mtimeMs;
      best = f;
    }
  }
  return best ? { file: best, mtime: bestMtime } : null;
}

// Returns { text, lastUserIdx } — text is the most recent assistant text block
// AFTER the last genuine user message (so we don't replay stale text from a
// previous turn while the user is waiting for the new one). lastUserIdx is the
// line index of the last user message; renderer uses it to know "user just
// spoke, hush whatever you were saying".
function scanTranscript(raw) {
  const lines = raw.split('\n');
  let lastUserIdx = -1;
  // First pass: find the last real user message (not a tool_result).
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]; if (!ln) continue;
    let entry; try { entry = JSON.parse(ln); } catch (_) { continue; }
    const role = entry.role || (entry.message && entry.message.role) || entry.type;
    if (role !== 'user' && entry.type !== 'user') continue;
    const content = entry.content != null
      ? entry.content
      : (entry.message && entry.message.content);
    // tool_result entries are also "user" role; only count entries that have
    // a real text block from a human (or a string content).
    let isHumanMsg = false;
    if (typeof content === 'string' && content.trim()) isHumanMsg = true;
    else if (Array.isArray(content)) {
      isHumanMsg = content.some(c => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim());
    }
    if (isHumanMsg) { lastUserIdx = i; break; }
  }
  // Second pass: walk back from end, but stop at lastUserIdx — only assistant
  // text strictly AFTER the user's latest message counts.
  let text = '';
  for (let i = lines.length - 1; i > lastUserIdx; i--) {
    const ln = lines[i]; if (!ln) continue;
    let entry; try { entry = JSON.parse(ln); } catch (_) { continue; }
    const role = entry.role || (entry.message && entry.message.role) || entry.type;
    if (role !== 'assistant' && entry.type !== 'assistant') continue;
    const content = entry.content != null
      ? entry.content
      : (entry.message && entry.message.content);
    let t = '';
    if (typeof content === 'string') t = content;
    else if (Array.isArray(content)) {
      t = content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text || '')
        .join('\n');
    }
    t = t && t.trim();
    if (t) { text = t; break; }
  }
  return { text, lastUserIdx };
}

// Ring buffer of recently-spoken texts. We dedupe across the whole window,
// not just the most recent — otherwise a late-firing Stop hook for an older
// turn can overwrite the current turn's audio. 8 entries is plenty: it covers
// several turns of pipeline lag without growing unbounded.
const RECENT_SIZE = 8;
const recentSpoken = [];

function sendSay(text, source) {
  if (!text) return;
  if (recentSpoken.includes(text)) return;
  recentSpoken.push(text);
  if (recentSpoken.length > RECENT_SIZE) recentSpoken.shift();
  lastSpokenText = text;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('say', { text, source, ts: Date.now() });
  }
}

function startTranscriptWatcher() {
  // Seed lastSpokenText with whatever's currently in the active transcript so
  // we don't replay the most recent message on launch.
  const active = findActiveTranscript();
  if (active) {
    transcriptLastFile  = active.file;
    transcriptLastMtime = active.mtime;
    try {
      const raw = fs.readFileSync(active.file, 'utf8');
      const scan = scanTranscript(raw);
      lastSpokenText        = scan.text;
      transcriptLastUserIdx = scan.lastUserIdx;
      if (scan.text) recentSpoken.push(scan.text);
    } catch (_) {}
  }

  transcriptPollTimer = setInterval(() => {
    const active = findActiveTranscript();
    if (!active) return;
    if (active.file === transcriptLastFile && active.mtime <= transcriptLastMtime) return;
    transcriptLastFile  = active.file;
    transcriptLastMtime = active.mtime;
    let raw;
    try { raw = fs.readFileSync(active.file, 'utf8'); }
    catch (_) { return; }
    const { text, lastUserIdx } = scanTranscript(raw);
    // New user message → hush whatever the character was saying. The previous
    // turn's audio is now stale conversational context.
    if (lastUserIdx > transcriptLastUserIdx) {
      transcriptLastUserIdx = lastUserIdx;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hush');
      }
    }
    if (text) sendSay(text, 'transcript');
  }, 500);
}

// ---------- HTTP server (kept for direct curl testing / external integrations) ----------
let httpServer = null;

function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/say') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 200000) { req.destroy(); }
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('say', payload);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Returns a PNG screenshot of the current renderer state. Used for
    // iterating on the 3D rig from the assistant side without a human in
    // the loop — capture, inspect via image read, adjust, repeat.
    if (req.method === 'GET' && req.url === '/screenshot') {
      if (!mainWindow || mainWindow.isDestroyed()) {
        res.writeHead(503); res.end('no window'); return;
      }
      mainWindow.webContents.capturePage().then(image => {
        const png = image.toPNG();
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        res.end(png);
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err && err.message));
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  httpServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.warn(`[claude-says] port ${SERVER_PORT} already in use; another instance may be running.`);
    } else {
      console.error('[claude-says] server error:', err);
    }
  });

  httpServer.listen(SERVER_PORT, '127.0.0.1', () => {
    console.log(`[claude-says] listening on http://127.0.0.1:${SERVER_PORT}`);
  });
}

// ---------- IPC handlers (renderer ↔ main) ----------
ipcMain.handle('get-window-position', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return [0, 0];
  return mainWindow.getPosition();
});

// Force the window to its canonical size on every move so nothing (Aero Snap,
// DPI rescale crossing monitors, etc.) can make the character "grow" between drags.
ipcMain.on('move-window', (_event, x, y) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    width:  currentWidth,
    height: currentHeight,
  }, false);
});

// Settings panel size selector
ipcMain.on('set-window-size', (_event, w, h) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  currentWidth  = Math.round(w);
  currentHeight = Math.round(h);
  const [x, y] = mainWindow.getPosition();
  mainWindow.setBounds({ x, y, width: currentWidth, height: currentHeight }, false);
  const s = loadState();
  s.width = currentWidth; s.height = currentHeight;
  saveState(s);
});

ipcMain.on('quit', () => app.quit());

// Click-through toggle. The renderer flips this based on whether the cursor is
// over the character body (or controls). When ignoring, mouse events fall
// through to whatever's underneath the floater on the desktop. `forward: true`
// keeps mousemove events flowing to the renderer so we can keep hit-testing.
ipcMain.on('set-ignore-mouse', (_event, ignore, options) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(!!ignore, options || { forward: true });
});

ipcMain.on('minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('get-state',  ()       => loadState());
ipcMain.handle('set-state',  (_e, s)  => { saveState(s); return true; });

// ---------- Kokoro TTS (out-of-process) ----------
// onnxruntime-node's session.run blocks the Node event loop during
// inference. In the Electron main process that means mouse, IPC, and
// audio playback all stutter for several seconds per synth. Run it
// in a separate child process instead and JSON-RPC over stdio.
const KOKORO_VOICES = { male: 'am_michael', female: 'af_bella' };
let kokoroProc = null;
let kokoroReady = false;
const kokoroPending = new Map();   // id → { resolve, reject }
let kokoroNextId = 1;
let kokoroLineBuf = '';

function spawnKokoro() {
  if (kokoroProc) return;
  const { spawn } = require('child_process');
  const workerPath = path.join(__dirname, 'tools', 'kokoro-worker.mjs');
  console.log('[kokoro] spawning worker:', workerPath);
  // Cap ONNX runtime / OpenMP thread count so the synth doesn't peg
  // every core on the machine while the user is doing other work.
  // Four threads keeps RTF around ~0.3 — fast enough that even when
  // a long chunk follows a short one, the long one finishes synthing
  // before the short one's audio ends (no gap). Most modern desktops
  // have 8+ logical cores, so leaving 4+ free preserves system
  // responsiveness in other apps.
  const SYNTH_THREADS = '4';
  kokoroProc = spawn(process.execPath, [workerPath], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OMP_NUM_THREADS:        SYNTH_THREADS,
      ORT_NUM_THREADS:        SYNTH_THREADS,
      MKL_NUM_THREADS:        SYNTH_THREADS,
      OPENBLAS_NUM_THREADS:   SYNTH_THREADS,
    },
  });
  kokoroProc.stdout.on('data', (chunk) => {
    kokoroLineBuf += chunk.toString('utf8');
    let idx;
    while ((idx = kokoroLineBuf.indexOf('\n')) >= 0) {
      const line = kokoroLineBuf.slice(0, idx);
      kokoroLineBuf = kokoroLineBuf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (_) { continue; }
      const handler = kokoroPending.get(msg.id);
      if (!handler) continue;
      kokoroPending.delete(msg.id);
      if (msg.ok) handler.resolve(msg.path);
      else        handler.reject(new Error(msg.error || 'kokoro error'));
    }
  });
  kokoroProc.stderr.on('data', (d) => {
    const txt = d.toString();
    process.stderr.write('[kokoro-worker] ' + txt);
    if (txt.includes('[kokoro-worker] ready')) kokoroReady = true;
  });
  kokoroProc.on('exit', (code) => {
    console.log('[kokoro] worker exited', code);
    kokoroProc = null;
    kokoroReady = false;
    for (const [, h] of kokoroPending) h.reject(new Error('kokoro worker died'));
    kokoroPending.clear();
  });
}
function kokoroSynth(text, voice) {
  return new Promise((resolve, reject) => {
    if (!kokoroProc) spawnKokoro();
    const id = kokoroNextId++;
    kokoroPending.set(id, { resolve, reject });
    kokoroProc.stdin.write(JSON.stringify({ id, text, voice }) + '\n');
  });
}
// Warm the worker on app ready so the first synth doesn't pay the
// model-load penalty.
app.whenReady().then(() => { spawnKokoro(); });

ipcMain.handle('tts-available', () => kokoroReady);
ipcMain.handle('tts-synth', async (_event, text, gender) => {
  if (!text || !text.trim()) return null;
  if (!kokoroReady) return null;
  const voice = KOKORO_VOICES[gender] || KOKORO_VOICES.male;
  console.log('[kokoro] synth gender=', gender, 'voice=', voice, 'text=', JSON.stringify(text));
  try {
    const t0 = Date.now();
    const wavPath = await kokoroSynth(text, voice);
    if (!wavPath) return null;
    const sz = (() => { try { return fs.statSync(wavPath).size; } catch (_) { return 0; } })();
    console.log('[kokoro] synth ok:', sz, 'bytes,', (Date.now() - t0) + 'ms,', path.basename(wavPath));
    // Schedule deletion after the audio's almost certainly played out.
    // 60s is conservative for any sentence-length response.
    setTimeout(() => { try { fs.unlinkSync(wavPath); } catch (_) {} }, 60000);
    // Return as a file:// URL the renderer can use directly with <Audio>.
    // pathToFileURL handles the Windows backslash / drive-letter mangling.
    return require('url').pathToFileURL(wavPath).href;
  } catch (e) {
    console.error('[kokoro] synth failed:', e?.message);
    return null;
  }
});

// Save the icon dataURL to build/icon.png and exit. Used by the
// `npm run capture-icon` flow.
ipcMain.on('save-icon-png', (_event, dataUrl) => {
  try {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!m) return;
    const dir = path.join(__dirname, 'build');
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, 'icon.png');
    fs.writeFileSync(outPath, Buffer.from(m[1], 'base64'));
    console.log('[icon] saved', outPath, 'bytes=', m[1].length * 0.75 | 0);
    setTimeout(() => app.quit(), 500);
  } catch (e) {
    console.error('[icon] save failed:', e);
  }
});

// Debug-only: write a PNG dataURL from the renderer to disk.
ipcMain.on('save-debug-frame', (_event, name, dataUrl) => {
  try {
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!m) return;
    const dir = path.join(os.tmpdir(), 'claude-says-debug');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = String(name || 'frame').replace(/[^\w.-]/g, '_');
    fs.writeFileSync(path.join(dir, safeName + '.png'), Buffer.from(m[1], 'base64'));
  } catch (e) {
    console.error('[debug] saveDebugFrame failed:', e);
  }
});

// ---------- app lifecycle ----------
app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.setName("Claude's Body");
if (process.platform === 'win32') {
  app.setAppUserModelId('com.claudesbody.app');
}

app.whenReady().then(() => {
  startHttpServer();
  startSpoolWatcher();
  startTranscriptWatcher();
  createWindow();

  // Global hotkey to toggle "lock" mode (click-through everywhere). Lets the
  // user grab the character even when locked-and-passive, since clicks alone
  // can't reach a click-through window.
  const ok = globalShortcut.register('CommandOrControl+Shift+L', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-lock');
    }
  });
  if (!ok) console.warn('[claude-says] could not register Ctrl/Cmd+Shift+L hotkey');

  // On Mac, hide from the dock — we're a floating utility, not an app the user
  // alt-tabs to. Comment this out if you want it to appear in the dock.
  if (process.platform === 'darwin' && app.dock && app.dock.hide) {
    try { app.dock.hide(); } catch (_) {}
  }
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  if (spoolPollTimer)      try { clearInterval(spoolPollTimer); }      catch (_) {}
  if (transcriptPollTimer) try { clearInterval(transcriptPollTimer); } catch (_) {}
});

app.on('window-all-closed', () => {
  if (httpServer) {
    try { httpServer.close(); } catch (_) {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
