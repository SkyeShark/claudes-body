#!/usr/bin/env node
'use strict';

// CLI launcher for `npm install -g claudes-body && claudes-body`.
//
// Platform dispatch:
//   - Windows      -> lightweight Deno + tao/wry webview host (deno-host/),
//                     no bundled Chromium. Boots a Deno runtime (downloaded
//                     once on first run) against deno-host/main.js.
//   - macOS/Linux  -> Electron, unchanged (cross-platform, fully tested).
//
// The Deno port's window management uses Win32 FFI, so for now it ships on
// Windows only; the other platforms keep the Electron app.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const pkgRoot = path.join(__dirname, '..');

if (process.platform !== 'win32') {
  runElectron();
} else {
  runDeno();
}

// ---------- Electron (macOS / Linux) ----------
function runElectron() {
  let electronPath;
  try { electronPath = require('electron'); }
  catch (_) {
    console.error("[claudes-body] Electron isn't installed. Run `npm install` in the package, or install electron.");
    process.exit(1);
  }
  const child = spawn(electronPath, [pkgRoot, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: false,
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

// ---------- Deno (Windows) ----------
function runDeno() {
  const denoHost = path.join(pkgRoot, 'deno-host');
  let deno, ok = true;
  try {
    deno = ensureDeno();
    ensureWebviewDeps(denoHost);
  } catch (e) {
    ok = false;
    console.error('[claudes-body] Deno setup failed:', e.message);
  }
  if (!ok) process.exit(1);

  const child = spawn(deno, [
    'run', '--allow-all', '--node-modules-dir=manual', 'main.js', ...process.argv.slice(2),
  ], { cwd: denoHost, stdio: 'inherit' });
  child.on('close', (code) => process.exit(code ?? 0));
}

// Locate a usable Deno: PATH, then our cache, else download it once.
function ensureDeno() {
  const onPath = spawnSync('deno', ['--version'], { stdio: 'ignore', shell: true });
  if (onPath.status === 0) return 'deno';

  const cacheDir = path.join(os.homedir(), '.claudes-body');
  const denoExe = path.join(cacheDir, 'deno.exe');
  if (fs.existsSync(denoExe)) return denoExe;

  fs.mkdirSync(cacheDir, { recursive: true });
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const url = `https://github.com/denoland/deno/releases/latest/download/deno-${arch}-pc-windows-msvc.zip`;
  const zip = path.join(cacheDir, 'deno.zip');
  console.log('[claudes-body] downloading the Deno runtime (one-time, ~40MB)...');
  const dl = spawnSync('powershell', ['-NoProfile', '-Command',
    `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${url}' -OutFile '${zip}' -UseBasicParsing; Expand-Archive -Path '${zip}' -DestinationPath '${cacheDir}' -Force`,
  ], { stdio: 'inherit' });
  if (dl.status !== 0 || !fs.existsSync(denoExe)) throw new Error('could not download Deno');
  return denoExe;
}

// Ensure the native @webviewjs/webview binary is installed for the host.
function ensureWebviewDeps(denoHost) {
  if (fs.existsSync(path.join(denoHost, 'node_modules', '@webviewjs', 'webview'))) return;
  console.log('[claudes-body] installing the webview runtime (one-time)...');
  const r = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: denoHost, stdio: 'inherit', shell: true,
  });
  if (r.status !== 0) throw new Error('could not install webview runtime');
}
