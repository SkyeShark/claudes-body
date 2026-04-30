#!/usr/bin/env node
'use strict';

// ============================================================================
// claude-says — installer
//
// Adds (or removes) a Stop hook to the user's Claude Code settings file
// at ~/.claude/settings.json. Always backs up the existing file first.
//
// Usage:
//   node install.js           # install
//   node install.js --remove  # uninstall
// ============================================================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HOME          = os.homedir();
const SETTINGS_DIR  = path.join(HOME, '.claude');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
const HOOK_PATH     = path.resolve(__dirname, 'hook.js');
const HOOK_COMMAND  = `node "${HOOK_PATH}"`;

const isRemove = process.argv.includes('--remove') || process.argv.includes('-r');

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`✗ Could not parse ${SETTINGS_FILE}: ${e.message}`);
    console.error('  Refusing to overwrite. Please fix the JSON and re-run.');
    process.exit(1);
  }
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return null;
  const stamp  = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${SETTINGS_FILE}.backup-${stamp}`;
  fs.copyFileSync(SETTINGS_FILE, backup);
  return backup;
}

function writeSettings(settings) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

// Look for our hook by command match. We don't trust order or shape because
// the user may have other Stop hooks too — we only touch our own entry.
// We require the path to look like "...claude-says...hook.js" to avoid
// false-matching another tool that happens to have a hook.js in it.
function isOurEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(h => {
    if (!h || !h.command) return false;
    const cmd = h.command;
    if (cmd === HOOK_COMMAND) return true;
    return /claude.?says/i.test(cmd) && /hook\.js/.test(cmd);
  });
}

function install() {
  console.log('claude-says: installing Stop hook into', SETTINGS_FILE);
  const settings = readSettings();
  const backup   = backupSettings();
  if (backup) console.log('  backup →', backup);

  settings.hooks      = settings.hooks      || {};
  settings.hooks.Stop = settings.hooks.Stop || [];

  const existing = settings.hooks.Stop.find(isOurEntry);
  if (existing) {
    // refresh the command path in case the install location moved
    existing.hooks = [{ type: 'command', command: HOOK_COMMAND }];
    console.log('  hook already present — refreshed command path');
  } else {
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });
    console.log('  added new Stop hook');
  }

  writeSettings(settings);

  console.log('\n✓ installed.');
  console.log('\nStart the floating Claude:');
  console.log('  npm start');
  console.log('\nThen use Claude Code normally — the character will speak each response.');
  console.log('\nTo uninstall: node install.js --remove');
}

function uninstall() {
  console.log('claude-says: removing Stop hook from', SETTINGS_FILE);
  if (!fs.existsSync(SETTINGS_FILE)) {
    console.log('  no settings file found; nothing to do.');
    return;
  }
  const settings = readSettings();
  const backup   = backupSettings();
  if (backup) console.log('  backup →', backup);

  if (settings.hooks && Array.isArray(settings.hooks.Stop)) {
    const before = settings.hooks.Stop.length;
    settings.hooks.Stop = settings.hooks.Stop.filter(e => !isOurEntry(e));
    const removed = before - settings.hooks.Stop.length;
    console.log(`  removed ${removed} entr${removed === 1 ? 'y' : 'ies'}`);

    // tidy up empty containers
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  } else {
    console.log('  no Stop hooks present.');
  }

  writeSettings(settings);
  console.log('\n✓ uninstalled.');
}

if (isRemove) uninstall();
else          install();
