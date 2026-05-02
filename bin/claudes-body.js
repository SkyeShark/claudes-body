#!/usr/bin/env node
'use strict';

// CLI launcher for `npm install -g claudes-body && claudes-body`.
// Spawns the bundled electron binary against this package's root so
// the app runs the same way `npm start` does in a clone.

const path = require('path');
const { spawn } = require('child_process');

const electronPath = require('electron');   // resolves to the local electron binary
const appPath      = path.join(__dirname, '..');

const child = spawn(electronPath, [appPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
});
child.on('close', (code) => process.exit(code ?? 0));
