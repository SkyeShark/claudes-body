// wav-utils.mjs — convert Kokoro's 32-bit IEEE-float WAV (format=3,
// 24kHz mono) into standard 16-bit PCM WAV that Electron's <audio>
// element decodes without errors. Shared by kokoro-worker.mjs,
// bake-voice-lines.mjs, and the unit-test suite.

export function floatWavToPcmWav(buf) {
  const fmt = buf.readUInt16LE(20);
  if (fmt === 1) return buf;          // already PCM, leave alone
  const ch = buf.readUInt16LE(22);
  const sr = buf.readUInt32LE(24);
  // Walk chunks past 'fmt ' to find 'data' — the format chunk size
  // can vary, so don't assume data starts at offset 44.
  let p = 12;
  let dataOff = -1, dataLen = 0;
  while (p < buf.length - 8) {
    const id  = buf.toString('ascii', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    if (id === 'data') { dataOff = p + 8; dataLen = len; break; }
    p += 8 + len;
  }
  if (dataOff < 0) throw new Error('no data chunk');
  const sampleCount = dataLen / 4;
  const out = Buffer.alloc(44 + sampleCount * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + sampleCount * 2, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);                // fmt chunk size
  out.writeUInt16LE(1, 20);                 // PCM
  out.writeUInt16LE(ch, 22);
  out.writeUInt32LE(sr, 24);
  out.writeUInt32LE(sr * ch * 2, 28);       // byte rate
  out.writeUInt16LE(ch * 2, 32);            // block align
  out.writeUInt16LE(16, 34);                // bits per sample
  out.write('data', 36);
  out.writeUInt32LE(sampleCount * 2, 40);
  for (let i = 0; i < sampleCount; i++) {
    let s = buf.readFloatLE(dataOff + i * 4);
    if (s > 1) s = 1; else if (s < -1) s = -1;
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return out;
}
