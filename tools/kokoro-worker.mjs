// kokoro-worker.mjs — runs in a separate Node child process so its
// onnxruntime inference can't block the Electron main thread (mouse,
// IPC, audio playback all stall while inference runs in-process).
//
// Protocol (newline-delimited JSON, one msg per line):
//   stdin:  { id, text, voice }
//   stdout: { id, ok: true, wav: <base64 16-bit PCM WAV> }
//        | { id, ok: false, error: "..." }
//   stderr: free-form log lines (parent prefixes them on console).
//
// On startup, "ready" is written to stderr once the model is loaded.

import { KokoroTTS } from 'kokoro-js';
import readline from 'node:readline';
import { floatWavToPcmWav } from './wav-utils.mjs';

process.stderr.write('[kokoro-worker] loading model…\n');
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8', device: 'cpu',
});
process.stderr.write('[kokoro-worker] ready\n');

// Serialize requests in a queue so multiple in-flight synth calls
// don't all hammer onnxruntime at once.
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  const { id, text, voice } = job;
  try {
    const audio = await tts.generate(text, { voice });
    const fl = Buffer.from(audio.toWav());
    const pc = floatWavToPcmWav(fl);
    process.stdout.write(JSON.stringify({ id, ok: true, wav: pc.toString('base64') }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String(e?.message || e) }) + '\n');
  }
  busy = false;
  setImmediate(pump);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) { return; }
  queue.push(msg);
  pump();
});
