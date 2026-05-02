#!/usr/bin/env node
'use strict';

// bake-scale.js — Bake the Hips scale into vertex data, IBMs, morph
// targets, and bone translations. Result: Hips.scale = 1.0, mesh data
// is intrinsically at the target world size, and any glTF/VRM consumer
// (Blender, Unity, three-vrm, ...) renders the character at that size
// without depending on inheritance tricks at the Armature root.
//
// Math (assuming uniform scale S on Hips, identity rotation/scale above):
//
//   Old: jointWorld_OLD * IBM_OLD = identity at bind, with Hips.scale=S
//        introducing S into all descendant world transforms. Mesh verts
//        live at giant local-space scale, render at S*v_local because
//        IBMs were authored for S=1 and the runtime S "leaks through" the
//        skinning matrix.
//
//   New: vertex POSITION *= S        →  v_local now at world scale
//        morph POSITION delta *= S   →  shape keys deform at world scale
//        IBM translation col *= S    →  IBM_NEW = inv(jointWorld_NEW)
//                                        (rotation 3x3 unchanged for uniform S)
//        bone descendant t  *= S     →  bones land at world-correct positions
//        Hips.scale = 1.0
//
//   At bind in NEW setup: jointWorld_NEW * IBM_NEW = identity, v_world =
//   v_local_NEW = world-scale position. Same render output, but the file
//   is now intrinsically at world scale.
//
// Hips's own translation is NOT scaled — it's already at the right world
// position when Hips.scale=1 (its parent has scale 1).
//
// Skinned mesh node TRS is NOT touched (per glTF spec, skin transforms
// override the mesh node's local transform). Bone-parented (non-skinned)
// mesh nodes' translations ARE scaled (they're descendants of Hips).
//
// Usage: node tools/bake-scale.js <input.vrm> <output.vrm>

const fs = require('fs');

const INPUT  = process.argv[2];
const OUTPUT = process.argv[3] || INPUT;
if (!INPUT) { console.error('usage: bake-scale.js <in.vrm> <out.vrm>'); process.exit(1); }

const raw = fs.readFileSync(INPUT);
if (raw.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const c0len = raw.readUInt32LE(12);
const json = JSON.parse(raw.toString('utf8', 20, 20 + c0len));
const c0pad = (4 - (c0len % 4)) % 4;
const binStart = 20 + c0len + c0pad;
const c1len = raw.readUInt32LE(binStart);
const bin = Buffer.from(raw.slice(binStart + 8, binStart + 8 + c1len));

// ------------------------------------------------------------------
// Find S — read it from Hips.scale (set by scale-vrm.js).
// ------------------------------------------------------------------
const hipsIdx = json.nodes.findIndex(n => n.name === 'Hips');
if (hipsIdx < 0) throw new Error("no node named 'Hips'");
const hips = json.nodes[hipsIdx];
const S = (hips.scale || [1,1,1])[0];
if (Math.abs(S - 1.0) < 1e-6) {
  console.log('[bake-scale] Hips already at 1.0 — nothing to do');
  fs.copyFileSync(INPUT, OUTPUT);
  process.exit(0);
}
console.log(`[bake-scale] S = ${S.toFixed(6)} (baking into mesh data)`);

// ------------------------------------------------------------------
// Accessor utilities. Handle byteStride and sparse encoding.
// ------------------------------------------------------------------
const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT16 = 5123;
const COMPONENT_UINT32 = 5125;

function elementSize(type) {
  return ({ SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT2:4, MAT3:9, MAT4:16 })[type] * 4;
}

function scaleVec3InBuffer(byteOffset, count, byteStride, factor) {
  const stride = byteStride || 12;
  for (let i = 0; i < count; i++) {
    const o = byteOffset + i * stride;
    bin.writeFloatLE(bin.readFloatLE(o)     * factor, o);
    bin.writeFloatLE(bin.readFloatLE(o + 4) * factor, o + 4);
    bin.writeFloatLE(bin.readFloatLE(o + 8) * factor, o + 8);
  }
}

const touchedPos = new Set();
const touchedIbm = new Set();

function scaleVec3Accessor(idx, factor, label) {
  if (touchedPos.has(idx)) return;
  touchedPos.add(idx);
  const acc = json.accessors[idx];
  if (acc.type !== 'VEC3') throw new Error(`${label}: expected VEC3, got ${acc.type}`);
  if (acc.componentType !== COMPONENT_FLOAT) throw new Error(`${label}: expected FLOAT, got ${acc.componentType}`);

  // Dense data (if present)
  if (acc.bufferView !== undefined) {
    const bv = json.bufferViews[acc.bufferView];
    const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    scaleVec3InBuffer(offset, acc.count, bv.byteStride, factor);
  }

  // Sparse data (morph targets often use this — base is implicit zero,
  // only specific indices have explicit deltas)
  if (acc.sparse) {
    const sv = acc.sparse.values;
    const svBv = json.bufferViews[sv.bufferView];
    const svOffset = (svBv.byteOffset || 0) + (sv.byteOffset || 0);
    scaleVec3InBuffer(svOffset, acc.sparse.count, svBv.byteStride, factor);
  }

  if (acc.min) acc.min = acc.min.map(v => v * factor);
  if (acc.max) acc.max = acc.max.map(v => v * factor);
}

function scaleIbmAccessor(idx, factor, label) {
  if (touchedIbm.has(idx)) return;
  touchedIbm.add(idx);
  const acc = json.accessors[idx];
  if (acc.type !== 'MAT4') throw new Error(`${label}: expected MAT4, got ${acc.type}`);
  if (acc.componentType !== COMPONENT_FLOAT) throw new Error(`${label}: expected FLOAT, got ${acc.componentType}`);
  if (!acc.bufferView) throw new Error(`${label}: IBM accessor has no bufferView`);
  const bv = json.bufferViews[acc.bufferView];
  const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 64;
  // Column-major 4x4: translation is column 3 = bytes 48,52,56 within the matrix
  for (let i = 0; i < acc.count; i++) {
    const m = offset + i * stride;
    bin.writeFloatLE(bin.readFloatLE(m + 48) * factor, m + 48);
    bin.writeFloatLE(bin.readFloatLE(m + 52) * factor, m + 52);
    bin.writeFloatLE(bin.readFloatLE(m + 56) * factor, m + 56);
  }
}

// ------------------------------------------------------------------
// Step 1: scale every POSITION (mesh) and morph target POSITION delta.
// ------------------------------------------------------------------
let nMeshAcc = 0, nMorphAcc = 0;
for (const mesh of json.meshes || []) {
  for (const prim of mesh.primitives || []) {
    if (prim.attributes && prim.attributes.POSITION !== undefined) {
      const before = touchedPos.size;
      scaleVec3Accessor(prim.attributes.POSITION, S, `${mesh.name||'mesh'}.POSITION`);
      if (touchedPos.size > before) nMeshAcc++;
    }
    for (const target of prim.targets || []) {
      if (target.POSITION !== undefined) {
        const before = touchedPos.size;
        scaleVec3Accessor(target.POSITION, S, `${mesh.name||'mesh'}.morphPOSITION`);
        if (touchedPos.size > before) nMorphAcc++;
      }
    }
  }
}
console.log(`[bake-scale]   POSITION accessors scaled: ${nMeshAcc} mesh + ${nMorphAcc} morph`);

// ------------------------------------------------------------------
// Step 2: scale every IBM translation column.
// ------------------------------------------------------------------
let nIbm = 0;
for (const skin of json.skins || []) {
  if (skin.inverseBindMatrices !== undefined) {
    const before = touchedIbm.size;
    scaleIbmAccessor(skin.inverseBindMatrices, S, `skin '${skin.name||''}'.IBM`);
    if (touchedIbm.size > before) nIbm++;
  }
}
console.log(`[bake-scale]   IBM accessors scaled: ${nIbm}`);

// ------------------------------------------------------------------
// Step 3: scale bone descendant translations (Hips's children, recursive).
// Hips's OWN translation is NOT scaled — its world position is already
// correct when Hips.scale=1, since Armature/parent has scale 1.
// ------------------------------------------------------------------
let nBones = 0;
function walkAndScale(idx) {
  const node = json.nodes[idx];
  if (node.translation) {
    node.translation = node.translation.map(v => v * S);
    nBones++;
  }
  for (const c of node.children || []) walkAndScale(c);
}
for (const c of (hips.children || [])) walkAndScale(c);
console.log(`[bake-scale]   bone descendant translations scaled: ${nBones}`);

// ------------------------------------------------------------------
// Step 4: spring bone hit radii (VRMC_springBone), if present.
// ------------------------------------------------------------------
const sb = json.extensions && json.extensions.VRMC_springBone;
if (sb && Array.isArray(sb.colliders)) {
  let nColliders = 0;
  for (const col of sb.colliders) {
    const shape = col.shape || {};
    for (const k of ['sphere', 'capsule']) {
      if (shape[k]) {
        if (shape[k].radius != null) shape[k].radius *= S;
        if (shape[k].offset)   shape[k].offset   = shape[k].offset.map(v => v * S);
        if (shape[k].tail)     shape[k].tail     = shape[k].tail.map(v => v * S);
        nColliders++;
      }
    }
  }
  console.log(`[bake-scale]   spring bone colliders scaled: ${nColliders}`);
}

// ------------------------------------------------------------------
// Step 5: set Hips.scale = 1.0.
// ------------------------------------------------------------------
delete hips.scale;
console.log('[bake-scale]   Hips.scale → 1.0');

// ------------------------------------------------------------------
// Repack and write.
// ------------------------------------------------------------------
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
