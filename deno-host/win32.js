// Win32 FFI helpers — fills the gaps the webview binding doesn't expose:
// window move/resize (no setPosition/setSize in @webviewjs/webview), click-through,
// and global-hotkey detection. This is what Electron does internally; we do it
// directly via user32.dll. Windows-only; on other platforms these become no-ops.

const IS_WIN = Deno.build.os === "windows";

let user32 = null;
if (IS_WIN) {
  try {
    user32 = Deno.dlopen("user32.dll", {
      FindWindowW:       { parameters: ["pointer", "pointer"], result: "pointer" },
      GetWindowRect:     { parameters: ["pointer", "pointer"], result: "i32" },
      SetWindowPos:      { parameters: ["pointer", "pointer", "i32", "i32", "i32", "i32", "u32"], result: "i32" },
      GetWindowLongW:    { parameters: ["pointer", "i32"], result: "i32" },
      SetWindowLongW:    { parameters: ["pointer", "i32", "i32"], result: "i32" },
      GetAsyncKeyState:  { parameters: ["i32"], result: "i16" },
      ShowWindow:        { parameters: ["pointer", "i32"], result: "i32" },
      GetCursorPos:      { parameters: ["pointer"], result: "i32" },
      SystemParametersInfoW: { parameters: ["u32", "u32", "pointer", "u32"], result: "i32" },
      SetProcessDPIAware:{ parameters: [], result: "i32" },
      GetDpiForSystem:   { parameters: [], result: "u32" },
    });
  } catch (e) {
    console.error("[win32] dlopen failed:", e.message);
  }
}

// Make the process DPI-aware up front (before the window exists) so cursor /
// window / work-area coords come back in true physical pixels and GetDpiForSystem
// reports the real DPI. Must run before the webview creates its window.
export function ensureDpiAware() {
  if (!user32) return;
  try { user32.symbols.SetProcessDPIAware(); } catch (_) {}
}

// Display scale (1.0 at 96 DPI, 1.5 at 144 DPI, ...).
export function getSystemScale() {
  if (!user32) return 1;
  try { const dpi = user32.symbols.GetDpiForSystem(); return dpi > 0 ? dpi / 96 : 1; }
  catch (_) { return 1; }
}

// Constants
const GWL_EXSTYLE      = -20;
const WS_EX_LAYERED    = 0x00080000;
const WS_EX_TRANSPARENT= 0x00000020;
const SWP_NOSIZE       = 0x0001;
const SWP_NOMOVE       = 0x0002;
const SWP_NOZORDER     = 0x0004;
const SWP_NOACTIVATE   = 0x0010;
const SW_MINIMIZE      = 6;

function wstr(s) {
  const u16 = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) u16[i] = s.charCodeAt(i);
  u16[s.length] = 0;
  return u16;
}

let cachedHwnd = null;
let cachedTitle = null;

// Find (and cache) the top-level window by its exact title.
export function findWindow(title) {
  if (!user32) return null;
  if (cachedHwnd && cachedTitle === title) return cachedHwnd;
  const buf = wstr(title);
  const hwnd = user32.symbols.FindWindowW(null, Deno.UnsafePointer.of(buf));
  if (hwnd && Deno.UnsafePointer.value(hwnd) !== 0n) {
    cachedHwnd = hwnd;
    cachedTitle = title;
    return hwnd;
  }
  return null;
}

export function getWindowRect(title) {
  const hwnd = findWindow(title);
  if (!hwnd) return null;
  const rect = new Int32Array(4); // left, top, right, bottom
  const ok = user32.symbols.GetWindowRect(hwnd, Deno.UnsafePointer.of(rect));
  if (!ok) return null;
  return { x: rect[0], y: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] };
}

export function moveWindow(title, x, y) {
  const hwnd = findWindow(title);
  if (!hwnd) return false;
  user32.symbols.SetWindowPos(hwnd, null, x | 0, y | 0, 0, 0,
    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  return true;
}

export function resizeWindow(title, w, h) {
  const hwnd = findWindow(title);
  if (!hwnd) return false;
  user32.symbols.SetWindowPos(hwnd, null, 0, 0, w | 0, h | 0,
    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  return true;
}

export function minimizeWindow(title) {
  const hwnd = findWindow(title);
  if (!hwnd) return false;
  user32.symbols.ShowWindow(hwnd, SW_MINIMIZE);
  return true;
}

// Toggle click-through (mouse events fall through to the desktop behind us).
export function setClickThrough(title, ignore) {
  const hwnd = findWindow(title);
  if (!hwnd) return false;
  let ex = user32.symbols.GetWindowLongW(hwnd, GWL_EXSTYLE);
  if (ignore) ex |= (WS_EX_LAYERED | WS_EX_TRANSPARENT);
  else        ex &= ~WS_EX_TRANSPARENT; // keep LAYERED; only TRANSPARENT gates hit-testing
  user32.symbols.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | 0);
  return true;
}

// Primary monitor work area (excludes the taskbar), screen coords.
const SPI_GETWORKAREA = 0x0030;
export function getWorkArea() {
  if (!user32) return null;
  const rect = new Int32Array(4); // left, top, right, bottom
  const ok = user32.symbols.SystemParametersInfoW(SPI_GETWORKAREA, 0, Deno.UnsafePointer.of(rect), 0);
  if (!ok) return null;
  return { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] };
}

// Global cursor position in screen coordinates.
export function getCursorPos() {
  if (!user32) return null;
  const pt = new Int32Array(2);
  const ok = user32.symbols.GetCursorPos(Deno.UnsafePointer.of(pt));
  if (!ok) return null;
  return { x: pt[0], y: pt[1] };
}

// Edge-detected Ctrl+Shift+L. Call every tick; returns true once per press.
const VK_CONTROL = 0x11, VK_SHIFT = 0x10, VK_L = 0x4C;
let lockComboWasDown = false;
export function pollLockHotkey() {
  if (!user32) return false;
  const down = (vk) => (user32.symbols.GetAsyncKeyState(vk) & 0x8000) !== 0;
  const combo = down(VK_CONTROL) && down(VK_SHIFT) && down(VK_L);
  const fired = combo && !lockComboWasDown;
  lockComboWasDown = combo;
  return fired;
}
