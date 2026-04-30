#!/usr/bin/env node
'use strict';

// ============================================================================
// claude-says — Claude Code Stop hook
//
// Claude Code invokes this script every time the assistant finishes a turn.
// Hook payload arrives on stdin as JSON, e.g.:
//   { "session_id":"...", "transcript_path":"/path/to/transcript.jsonl",
//     "cwd":"...", "hook_event_name":"Stop" }
//
// We:
//   1. Read the transcript JSONL
//   2. Find the last assistant text content (defensively across shapes)
//   3. POST it to the running claude-says app on 127.0.0.1:7777
//
// If the app isn't running, we fail silently — never block Claude Code.
// ============================================================================

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HARD_TIMEOUT_MS = 5000;
// File the Electron app polls for new lines to speak. Local I/O is far more
// reliable than HTTP — Claude Code can't mark this hook as "slow" because
// we never wait on a network round-trip; we just write and exit.
const SPOOL_PATH = path.join(os.tmpdir(), 'claude-says-spool.json');

// Debug log so we can see what Claude Code is feeding the hook and what
// text we extracted. Comment out / remove after debugging.
const LOG_PATH = path.join(os.tmpdir(), 'claude-says-hook.log');
function debugLog(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdinBuf += chunk; });
process.stdin.on('end', handlePayload);

// safety net — if stdin never closes for some reason, exit so we don't hang
setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);

function handlePayload() {
  debugLog(`hook fired; stdin bytes=${stdinBuf.length}`);
  let payload;
  try { payload = JSON.parse(stdinBuf || '{}'); }
  catch (e) { debugLog(`bad payload json: ${e.message}`); return process.exit(0); }

  const tp = payload && payload.transcript_path;
  debugLog(`transcript_path=${tp}`);
  if (!tp || !fs.existsSync(tp)) {
    debugLog(`transcript missing — exiting`);
    return process.exit(0);
  }

  let raw;
  try { raw = fs.readFileSync(tp, 'utf8'); }
  catch (e) { debugLog(`read fail: ${e.message}`); return process.exit(0); }

  const lines = raw.split('\n').filter(Boolean);
  debugLog(`transcript lines=${lines.length}`);
  const text = extractLastAssistantText(lines);
  debugLog(`extracted text (first 200): ${(text || '').slice(0, 200)}`);
  if (!text) {
    debugLog(`no text in current turn — skipping`);
    return process.exit(0);
  }

  // Skip duplicates — Claude Code can fire Stop multiple times per turn.
  const last = getLastPosted();
  if (text === last) {
    debugLog(`duplicate of last posted — skipping`);
    return process.exit(0);
  }
  setLastPosted(text);

  writeSpool(text);
  debugLog(`spooled ${text.length} chars`);
  process.exit(0);
}

// Atomic write to the spool file: write to a temp path then rename, so the
// Electron-side watcher never reads a half-written file.
function writeSpool(text) {
  const tmp = SPOOL_PATH + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify({
      text,
      source: 'claude-code',
      ts: Date.now() + Math.random(),
    }));
    fs.renameSync(tmp, SPOOL_PATH);
  } catch (e) {
    debugLog(`spool write failed: ${e.message}`);
  }
}

// Walks the JSONL backwards looking for the most recent assistant TEXT
// content within the CURRENT TURN. Each model invocation becomes its own
// JSONL line — many are thinking-only or tool_use-only (no text). We need
// to stop at a user message or tool_result so we don't accidentally
// surface text from an OLD turn when the latest entries are silent.
function extractLastAssistantText(lines) {
  // Just walk back and find the most recent assistant entry that has a
  // non-empty TEXT block. Don't try to detect turn boundaries — Claude Code
  // spawns Stop hooks asynchronously, so by the time we run the user's NEXT
  // message may already be in the transcript and would falsely stop us.
  // The dedupe file (claude-says-last.txt) prevents re-speaking the same
  // text from a previous turn.
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch (_) { continue; }

    const role = entry.role || (entry.message && entry.message.role) || entry.type;
    if (role !== 'assistant' && entry.type !== 'assistant') continue;

    const content = entry.content != null
      ? entry.content
      : (entry.message && entry.message.content);

    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // Only explicit text blocks — exclude thinking, tool_use, etc.
      text = content
        .filter(c => c && c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text || '')
        .join('\n');
    }

    text = text && text.trim();
    if (text) return text;
  }
  return '';
}

// Avoid re-speaking the same text on duplicate Stop fires.
const LAST_POST_PATH = path.join(os.tmpdir(), 'claude-says-last.txt');
function getLastPosted() {
  try { return fs.readFileSync(LAST_POST_PATH, 'utf8'); } catch (_) { return ''; }
}
function setLastPosted(text) {
  try { fs.writeFileSync(LAST_POST_PATH, text); } catch (_) {}
}

// (HTTP path removed — see writeSpool above. The Electron app's HTTP server
// is still kept for direct curl testing, but the production hook path is the
// fast local-file spool.)
