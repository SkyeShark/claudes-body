'use strict';

// Preload script — runs in the renderer's isolated world, exposes a small,
// audited API so the renderer never touches Node directly.

const { contextBridge, ipcRenderer } = require('electron');

// Renamed from "claude" to "cs" to avoid colliding with the local
// `const claude = createClaude(...)` declaration in app.js (the preload
// exposes a global on `window`, and re-declaring the same identifier in
// the renderer's top-level script causes a SyntaxError).
contextBridge.exposeInMainWorld('cs', {
  // window position for manual drag implementation
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),
  moveWindow:        (x, y) => ipcRenderer.send('move-window', x, y),
  minimize:          () => ipcRenderer.send('minimize'),
  quit:              () => ipcRenderer.send('quit'),

  // click-through and resize
  setIgnoreMouseEvents: (ignore, options) => ipcRenderer.send('set-ignore-mouse', ignore, options),
  setWindowSize:        (w, h) => ipcRenderer.send('set-window-size', w, h),

  // state persistence
  getState: () => ipcRenderer.invoke('get-state'),
  setState: (s) => ipcRenderer.invoke('set-state', s),

  // incoming text from the Stop hook
  onSay: (callback) => {
    const handler = (_event, payload) => {
      try { callback(payload); } catch (e) { console.error(e); }
    };
    ipcRenderer.on('say', handler);
    return () => ipcRenderer.removeListener('say', handler);
  },

  // "user just sent a new message — hush whatever the character is saying"
  onHush: (callback) => {
    const handler = () => { try { callback(); } catch (e) { console.error(e); } };
    ipcRenderer.on('hush', handler);
    return () => ipcRenderer.removeListener('hush', handler);
  },

  // global hotkey forwarded from the main process (Ctrl/Cmd+Shift+L)
  onToggleLock: (callback) => {
    const handler = () => { try { callback(); } catch (e) { console.error(e); } };
    ipcRenderer.on('toggle-lock', handler);
    return () => ipcRenderer.removeListener('toggle-lock', handler);
  },

  platform: process.platform,
});
