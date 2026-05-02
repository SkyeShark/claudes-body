#!/usr/bin/env node
'use strict';

// symmetrize-mouth-morphs.js — Edit a VRM/glTF in place: for each mouth
// morph target whose name appears in DEFAULT_TARGETS, zero the X-component
// of every position delta. The morph then opens/widens the mouth vertically
// without translating it sideways.
//
// Why we need this: the source-authored mouth shape keys for `surprised`,
// `aa`, `ih`, `ou`, `oh` push every vertex in -X (mean ΔX ≈ -12 mm), so
// the mouth visibly shifts to one side at high weights. Visemes switch
// every ~120 ms during speech and the asymmetry isn't noticed there, but
// `surprised` holds at full weight and the lopsidedness shows.
//
// This tool fixes the asymmetry in the file itself, so the model is
// usable in any VRM consumer (not just our own pipeline output).
//
// Usage:
//   node tools/symmetrize-mouth-morphs.js <input.vrm> [output.vrm]
//   (in-place if output is omitted)

const fs = require('fs');
const path = require('path');

const DEFAULT_TARGETS = new Set(['surprised', 'aa', 'ih', 'ou', 'oh']);

const INPUT  = process.argv[2];
const OUTPUT = process.argv[3] || INPUT;
if (!INPUT) {
  console.error('usage: symmetrize-mouth-morphs.js <in.vrm> [out.vrm]');
  process.exit(1);
}

// ---------- read GLB ----------
const raw = fs.readFileSync(INPUT);
if (raw.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const c0len = raw.readUInt32LE(12);
const json = JSON.parse(raw.toString('utf8', 20, 20 + c0len));
const c0pad = (4 - (c0len % 4)) % 4;
const binStart = 20 + c0len + c0pad;
const c1len = raw.readUInt32LE(binStart);
const bin = Buffer.from(raw.slice(binStart + 8, binStart + 8 + c1len));

function targetNamesOf(meshIdx) {
  const m = json.meshes[meshIdx];
  return (m.extras || {}).targetNames
      || ((m.primitives[0] || {}).extras || {}).targetNames
      || [];
}

function zeroXOnAccessor(accIdx) {
  const acc = json.accessors[accIdx];
  if (!acc || acc.type !== 'VEC3') return 0;
  let touched = 0;
  // Dense data
  if (acc.bufferView !== undefined) {
    const bv = json.bufferViews[acc.bufferView];
    const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = bv.byteStride || 12;
    for (let i = 0; i < acc.count; i++) bin.writeFloatLE(0, off + i * stride);
    touched += acc.count;
  }
  // Sparse data
  if (acc.sparse) {
    const sv = acc.sparse.values;
    const svBv = json.bufferViews[sv.bufferView];
    const svOff = (svBv.byteOffset || 0) + (sv.byteOffset || 0);
    const stride = svBv.byteStride || 12;
    for (let i = 0; i < acc.sparse.count; i++) bin.writeFloatLE(0, svOff + i * stride);
    touched += acc.sparse.count;
  }
  if (acc.min) acc.min[0] = 0;
  if (acc.max) acc.max[0] = 0;
  return touched;
}

let nSymmetrized = 0;
for (const m of json.meshes) {
  if (!/mouth/i.test(m.name || '')) continue;
  const names = targetNamesOf(json.meshes.indexOf(m));
  for (const prim of (m.primitives || [])) {
    for (let t = 0; t < (prim.targets || []).length; t++) {
      const tgt = prim.targets[t];
      if (tgt.POSITION === undefined) continue;
      if (!DEFAULT_TARGETS.has(names[t])) continue;
      const n = zeroXOnAccessor(tgt.POSITION);
      if (n > 0) {
        nSymmetrized++;
        console.log(`[symmetrize] '${names[t]}' (${n} verts) on mesh '${m.name}'`);
      }
    }
  }
}
if (nSymmetrized === 0) {
  console.log('[symmetrize] no matching mouth targets — nothing to do');
  process.exit(0);
}

// ---------- repack GLB ----------
const newJsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = (4 - (newJsonBuf.length % 4)) % 4;
const paddedJson = jsonPad ? Buffer.concat([newJsonBuf, Buffer.alloc(jsonPad, 0x20)]) : newJsonBuf;
const binPad = (4 - (bin.length % 4)) % 4;
const paddedBin = binPad ? Buffer.concat([bin, Buffer.alloc(binPad, 0x00)]) : bin;
const total = 12 + 8 + paddedJson.length + 8 + paddedBin.length;
const out = Buffer.alloc(total);
out.write('glTF', 0, 4, 'ascii');
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
out.writeUInt32LE(paddedJson.length, 12);
out.write('JSON', 16, 4, 'ascii');
paddedJson.copy(out, 20);
const binChunkOff = 20 + paddedJson.length;
out.writeUInt32LE(paddedBin.length, binChunkOff);
out.write('BIN\0', binChunkOff + 4, 4, 'ascii');
paddedBin.copy(out, binChunkOff + 8);
fs.writeFileSync(OUTPUT, out);
console.log(`[out] ${OUTPUT} (${out.length} bytes)`);
