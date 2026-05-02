#!/usr/bin/env node
// bake-voice-lines.mjs — Synthesizes the small set of static lines
// the app plays (welcome greeting, drag-grab woahs) into committed
// WAV files under assets/voices/<gender>/<slug>.wav. The app loads
// these at runtime with no synth or IPC, so they play instantly.
//
// Re-run any time the lines or voices change:
//   node tools/bake-voice-lines.mjs

import { KokoroTTS } from 'kokoro-js';
import fs   from 'node:fs';
import path from 'node:path';
import url  from 'node:url';
import { floatWavToPcmWav } from './wav-utils.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(__dirname, '..', 'assets', 'voices');

const VOICES = { male: 'am_michael', female: 'af_bella' };
const LINES = [
  { slug: 'welcome', text: "Hi! I'm here. Press Control Shift L to drag me around." },
  { slug: 'woah_1',  text: 'Woah oh oh oh oh!'  },
  { slug: 'woah_2',  text: 'Whoa whoa whoa!'    },
  { slug: 'woah_3',  text: 'Wuh oh oh oh oh!'   },
  { slug: 'woah_4',  text: 'Eee oh oh!'         },
];

console.log('loading kokoro…');
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8', device: 'cpu',
});

for (const [gender, voice] of Object.entries(VOICES)) {
  const dir = path.join(OUT_ROOT, gender);
  fs.mkdirSync(dir, { recursive: true });
  for (const { slug, text } of LINES) {
    process.stdout.write(`  ${gender}/${slug}.wav … `);
    const audio = await tts.generate(text, { voice });
    const fl   = Buffer.from(audio.toWav());
    const pcm  = floatWavToPcmWav(fl);
    fs.writeFileSync(path.join(dir, slug + '.wav'), pcm);
    console.log(pcm.length + ' bytes');
  }
}
console.log('done.');
