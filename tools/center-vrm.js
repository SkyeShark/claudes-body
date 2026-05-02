#!/usr/bin/env node
'use strict';

// center-vrm.js — Zero out the scene root (Armature) translation so the
// VRM's origin sits between the character's feet instead of off to the
// side. Compensates the IBMs so skinning still renders the character at
// the same visible world position (now == origin).
//
// Why this is needed: when authored in Blender, the Armature object can
// be placed anywhere in the scene. On VRM export that placement becomes
// `Armature.translation` on the scene root node. Game engines and VRM
// viewers will show the character offset by that translation, and the
// mesh's "origin" pivot in Blender lands at that offset rather than at
// the character. Standard practice: mesh origin between the feet.
//
// Math: bone_world_OLD = T(t_arm) * R_chain. IBM_OLD = inv(bone_world_OLD)
// = inv(R_chain) * T(-t_arm). After zeroing Armature.translation:
// bone_world_NEW = R_chain. We want IBM_NEW = inv(R_chain) =
// IBM_OLD * T(t_arm). For each IBM 4x4 matrix:
//
//     new_translation_col = old_translation_col + R_3x3 * t_arm
//
// rotation 3x3 unchanged, just last column adjusted.
//
// Usage: node tools/center-vrm.js <input.vrm> <output.vrm>

const fs = require('fs');

const INPUT  = process.argv[2];
const OUTPUT = process.argv[3] || INPUT;
if (!INPUT) { console.error('usage: center-vrm.js <in.vrm> <out.vrm>'); process.exit(1); }

const raw = fs.readFileSync(INPUT);
if (raw.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const c0len = raw.readUInt32LE(12);
const json = JSON.parse(raw.toString('utf8', 20, 20 + c0len));
const c0pad = (4 - (c0len % 4)) % 4;
const binStart = 20 + c0len + c0pad;
const c1len = raw.readUInt32LE(binStart);
const bin = Buffer.from(raw.slice(binStart + 8, binStart + 8 + c1len));

// Find the scene root that owns the skeleton. Single-root VRMs put the
// Armature node here; if we found multiple roots we'd need to pick the
// one that's an ancestor of Hips, but glTF VRMs in practice are single-
// root, so we just use scenes[0].nodes[0].
if (!json.scenes || !json.scenes[0] || !json.scenes[0].nodes || json.scenes[0].nodes.length === 0) {
  throw new Error('no scene root');
}
if (json.scenes[0].nodes.length > 1) {
  console.warn('[center] multiple scene roots — operating on first one only');
}
const rootIdx = json.scenes[0].nodes[0];
const root = json.nodes[rootIdx];

const t = root.translation || [0, 0, 0];
if (Math.abs(t[0]) < 1e-6 && Math.abs(t[1]) < 1e-6 && Math.abs(t[2]) < 1e-6) {
  console.log('[center] root translation already zero — nothing to do');
  fs.copyFileSync(INPUT, OUTPUT);
  process.exit(0);
}
console.log(`[center] root '${root.name}' translation = (${t.map(v=>v.toFixed(4)).join(', ')})`);

// Adjust every IBM by the root translation. IBMs are 4x4 column-major
// floats. Translation column is bytes 48..56 within each matrix.
// Rotation/scale 3x3 lives in columns 0..2 (rows 0..2 → bytes 0,4,8 for
// col0; 16,20,24 for col1; 32,36,40 for col2).
const seenIbm = new Set();
let nIbm = 0;
for (const skin of json.skins || []) {
  const idx = skin.inverseBindMatrices;
  if (idx === undefined || seenIbm.has(idx)) continue;
  seenIbm.add(idx);
  const acc = json.accessors[idx];
  if (acc.type !== 'MAT4') throw new Error(`expected MAT4, got ${acc.type}`);
  const bv = json.bufferViews[acc.bufferView];
  const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 64;
  for (let i = 0; i < acc.count; i++) {
    const m = offset + i * stride;
    // R column 0: bytes 0,4,8  → R[0][0], R[1][0], R[2][0]
    // R column 1: bytes 16,20,24 → R[0][1], R[1][1], R[2][1]
    // R column 2: bytes 32,36,40 → R[0][2], R[1][2], R[2][2]
    const r00 = bin.readFloatLE(m + 0),  r10 = bin.readFloatLE(m + 4),  r20 = bin.readFloatLE(m + 8);
    const r01 = bin.readFloatLE(m + 16), r11 = bin.readFloatLE(m + 20), r21 = bin.readFloatLE(m + 24);
    const r02 = bin.readFloatLE(m + 32), r12 = bin.readFloatLE(m + 36), r22 = bin.readFloatLE(m + 40);
    // R * t (3x3 times 3-vector)
    const dx = r00 * t[0] + r01 * t[1] + r02 * t[2];
    const dy = r10 * t[0] + r11 * t[1] + r12 * t[2];
    const dz = r20 * t[0] + r21 * t[1] + r22 * t[2];
    bin.writeFloatLE(bin.readFloatLE(m + 48) + dx, m + 48);
    bin.writeFloatLE(bin.readFloatLE(m + 52) + dy, m + 52);
    bin.writeFloatLE(bin.readFloatLE(m + 56) + dz, m + 56);
  }
  nIbm++;
}
console.log(`[center] adjusted IBMs in ${nIbm} accessor(s) (${seenIbm.size} unique)`);

// Children of the root that are MESH NODES (e.g., body mesh) had their
// world position equal to root.translation (since they have identity
// local transform). The mesh's "origin" in any DCC tool is this world
// position. Zeroing root.translation moves the mesh origin to (0,0,0).
// For mesh nodes that have their OWN translation, we'd want to leave
// them alone — only the root's contribution is being removed.

// Bone children of the root (Hips) — their translation stays in the
// root's local frame. After zeroing, Hips's world position drops by
// |t_arm|. The IBMs we just adjusted compensate so the SKINNED mesh
// renders at the same visible world position (now centered on origin).

delete root.translation;
console.log('[center] root.translation → (0, 0, 0)');

// Repack
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
