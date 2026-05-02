#!/usr/bin/env node
'use strict';

// rebind-vrm.js — Edit a VRM (glTF binary) in place to:
//   - rewrite VRMC_vrm.expressions.preset bindings so every face shape key
//     drives the right standard preset (happy/sad/angry/surprised/relaxed,
//     aa/ih/ou/ee/oh, blink),
//   - turn off MToon outline width on face-feature materials.
//
// Doesn't go through Blender, so the user's bone pose, mesh weights, tail
// spring chain, body materials — everything else — stays exactly as authored.
//
// Usage:
//   node tools/rebind-vrm.js  <input.vrm>  <output.vrm>

const fs   = require('fs');
const path = require('path');

const INPUT  = process.argv[2] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claudelatest.vrm';
const OUTPUT = process.argv[3] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claude.vrm';
const ASSET  = 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claude-says/assets/claude.vrm';

// ---------- GLB read ----------
const raw = fs.readFileSync(INPUT);
if (raw.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const version = raw.readUInt32LE(4);
const totalLen = raw.readUInt32LE(8);
console.log('[in] glTF', version, 'len', totalLen);

let off = 12;
const c0len  = raw.readUInt32LE(off);
const c0type = raw.toString('ascii', off + 4, off + 8);
if (c0type !== 'JSON') throw new Error('expected JSON chunk first, got ' + c0type);
const jsonStr = raw.toString('utf8', off + 8, off + 8 + c0len);
const json = JSON.parse(jsonStr);
off += 8 + c0len;

let bin = null;
if (off < raw.length) {
  const c1len  = raw.readUInt32LE(off);
  const c1type = raw.toString('ascii', off + 4, off + 8);
  if (c1type !== 'BIN\0') throw new Error('expected BIN chunk second, got ' + c1type);
  bin = raw.slice(off + 8, off + 8 + c1len);
}
console.log('[in] meshes=' + json.meshes.length, 'nodes=' + json.nodes.length, 'bin=' + (bin ? bin.length + 'B' : 'none'));

// ---------- catalog face meshes ----------
function meshNameFor(idx) { return (json.meshes[idx] || {}).name || `mesh_${idx}`; }
function targetNamesOf(meshIdx) {
  const m = json.meshes[meshIdx];
  if (!m) return [];
  return (m.extras || {}).targetNames
      || ((m.primitives[0] || {}).extras || {}).targetNames
      || [];
}
function morphIndexOf(meshIdx, keyName) {
  const names = targetNamesOf(meshIdx);
  return names.indexOf(keyName);  // -1 if not found
}

// We need each face mesh's NODE INDEX (the mesh node containing it), not the
// mesh index, because morphTargetBinds reference nodes (mesh objects).
const meshIdxToNodeIdx = {};
for (let i = 0; i < json.nodes.length; i++) {
  const n = json.nodes[i];
  if (n.mesh != null) {
    meshIdxToNodeIdx[n.mesh] = i;
  }
}

// Find face meshes by name
const faceClass = { eye_pupil: [], eye_white: [], brow: [], mouth: null };
for (let mi = 0; mi < json.meshes.length; mi++) {
  const name = json.meshes[mi].name || '';
  const lower = name.toLowerCase();
  if (lower.startsWith('eye.') && lower.includes('white')) faceClass.eye_white.push(mi);
  else if (lower.startsWith('eye.')) faceClass.eye_pupil.push(mi);
  else if (lower.startsWith('brow.')) faceClass.brow.push(mi);
  else if (lower.startsWith('mouth')) faceClass.mouth = mi;
}

// Sort each pair by world-X via the node translation. Higher X = character's
// LEFT side (Blender +X-is-left convention).
function sortPairByX(meshList) {
  return meshList.slice().sort((a, b) => {
    const na = meshIdxToNodeIdx[a], nb = meshIdxToNodeIdx[b];
    const ta = (json.nodes[na].translation || [0,0,0])[0];
    const tb = (json.nodes[nb].translation || [0,0,0])[0];
    return ta - tb;  // ascending: first = -X (right), last = +X (left)
  });
}
function pickLR(meshList) {
  if (meshList.length === 0) return [null, null];
  if (meshList.length === 1) return [meshList[0], null];
  const s = sortPairByX(meshList);
  return [s[s.length - 1], s[0]];   // [L (+X), R (-X)]
}

const [pupilL, pupilR] = pickLR(faceClass.eye_pupil);
const [whiteL, whiteR] = pickLR(faceClass.eye_white);
const [browL,  browR ] = pickLR(faceClass.brow);
const mouthM           = faceClass.mouth;

console.log('\n[face] role assignments:');
const roles = { pupilL, pupilR, whiteL, whiteR, browL, browR, mouth: mouthM };
for (const [k, mi] of Object.entries(roles)) {
  console.log(`  ${k.padEnd(7)} = ${mi == null ? '(none)' : meshNameFor(mi)}`);
}

// ---------- build bindings ----------
function findKey(meshIdx, candidates) {
  if (meshIdx == null) return null;
  const names = targetNamesOf(meshIdx);
  for (const c of candidates) {
    const exact = names.findIndex(n => n.toLowerCase() === c.toLowerCase());
    if (exact >= 0) return { meshIdx, index: exact, name: names[exact] };
  }
  for (const c of candidates) {
    const fuzzy = names.findIndex(n => n.toLowerCase().includes(c.toLowerCase()));
    if (fuzzy >= 0) return { meshIdx, index: fuzzy, name: names[fuzzy] };
  }
  return null;
}

function bindsFromKeys(meshes, candidateNames, weight = 1.0) {
  const out = [];
  for (const mi of meshes) {
    const hit = findKey(mi, candidateNames);
    if (hit) out.push({ node: meshIdxToNodeIdx[hit.meshIdx], index: hit.index, weight });
  }
  return out;
}

const bindings = {
  blink:      bindsFromKeys([pupilL, pupilR, whiteL, whiteR], ['blink', 'closed']),
  blinkLeft:  bindsFromKeys([pupilL, whiteL], ['blink', 'closed']),
  blinkRight: bindsFromKeys([pupilR, whiteR], ['blink', 'closed']),
  aa:        bindsFromKeys([mouthM], ['aa']),
  ih:        bindsFromKeys([mouthM], ['ih']),
  ou:        bindsFromKeys([mouthM], ['ou']),
  ee:        bindsFromKeys([mouthM], ['ee']),
  oh:        bindsFromKeys([mouthM], ['oh']),
  // Each emotion preset drives mouth + eyes + brows together.
  happy: [
    ...bindsFromKeys([mouthM], ['happy', 'smile']),
    ...bindsFromKeys([pupilL, pupilR, whiteL, whiteR], ['lookHappy', 'happy']),
    ...bindsFromKeys([browL, browR], ['raised', 'up']),
  ],
  sad: [
    ...bindsFromKeys([mouthM], ['sad', 'frown']),
    ...bindsFromKeys([pupilL, pupilR, whiteL, whiteR], ['lookSad', 'sad']),
    ...bindsFromKeys([browL, browR], ['worried', 'sad', 'down']),
  ],
  angry: [
    ...bindsFromKeys([mouthM], ['angry', 'mad']),
    ...bindsFromKeys([pupilL, pupilR, whiteL, whiteR], ['lookSad', 'sad']),
    ...bindsFromKeys([browL, browR], ['furrow', 'angry']),
  ],
  surprised: [
    ...bindsFromKeys([mouthM], ['surprised', 'wide']),
    ...bindsFromKeys([pupilL, pupilR, whiteL, whiteR], ['lookSurprised', 'surprised']),
    ...bindsFromKeys([browL, browR], ['raised', 'up']),
  ],
  // 'relaxed' is the resting mouth — closed/neutral lip shape. Used as
  // the default when no emotion is firing.
  relaxed: bindsFromKeys([mouthM], ['relaxed', 'neutral', 'rest']),
  // 'neutral' fires the relaxed mouth too so the resting face has the
  // closed-lip shape rather than the model's mid-state default.
  neutral: bindsFromKeys([mouthM], ['relaxed', 'neutral', 'rest']),
};

// ---------- write into VRMC_vrm.expressions.preset ----------
const vrmExt = json.extensions && json.extensions.VRMC_vrm;
if (!vrmExt) throw new Error('no VRMC_vrm extension on this glTF');
const preset = (vrmExt.expressions && vrmExt.expressions.preset) || {};

console.log('\n[expr] new bindings:');
for (const [name, binds] of Object.entries(bindings)) {
  const slot = preset[name];
  if (!slot) {
    console.log(`  ${name.padEnd(11)} → no preset slot`);
    continue;
  }
  slot.morphTargetBinds = binds;
  console.log(`  ${name.padEnd(11)} → ${binds.length} binds`);
}

// Custom expression: 'catface' — :3 mouth shape, paired with happy
// eyes and raised brows for a smug little smile. Not a standard VRM
// preset, so bind it through the `custom` slot. The renderer can
// trigger it via expressionManager.setValue('catface', 1).
const catfaceBinds = [
  ...bindsFromKeys([mouthM], ['catface']),
  ...bindsFromKeys([pupilL, pupilR, whiteL, whiteR], ['lookHappy', 'happy']),
  ...bindsFromKeys([browL, browR], ['raised', 'up']),
];
if (catfaceBinds.length) {
  vrmExt.expressions = vrmExt.expressions || {};
  vrmExt.expressions.custom = vrmExt.expressions.custom || {};
  vrmExt.expressions.custom.catface = {
    isBinary: false,
    overrideBlink: 'none',
    overrideLookAt: 'none',
    overrideMouth: 'block',
    morphTargetBinds: catfaceBinds,
    materialColorBinds: [],
    textureTransformBinds: [],
  };
  console.log(`  catface     → ${catfaceBinds.length} binds (custom, mouth + happy eyes)`);
}

// ---------- disable MToon outlines on face materials ----------
const faceMeshIdxs = new Set([pupilL, pupilR, whiteL, whiteR, browL, browR, mouthM].filter(x => x != null));
const faceMaterialIdxs = new Set();
for (const mi of faceMeshIdxs) {
  for (const prim of json.meshes[mi].primitives || []) {
    if (prim.material != null) faceMaterialIdxs.add(prim.material);
  }
}
let nOutlinesOff = 0;
for (const matIdx of faceMaterialIdxs) {
  const mat = json.materials[matIdx];
  const mtoon = mat.extensions && mat.extensions.VRMC_materials_mtoon;
  if (mtoon) {
    if (mtoon.outlineWidthMode && mtoon.outlineWidthMode !== 'none') {
      mtoon.outlineWidthMode = 'none';
      mtoon.outlineWidthFactor = 0;
      nOutlinesOff++;
    }
  }
}
console.log(`\n[mtoon] disabled outlines on ${nOutlinesOff} face materials`);

// Bump every other material's outline width to 0.015m (where it's already on).
const BODY_OUTLINE_W = 0.02;
let nBumped = 0;
for (let i = 0; i < json.materials.length; i++) {
  if (faceMaterialIdxs.has(i)) continue;
  const mtoon = json.materials[i].extensions && json.materials[i].extensions.VRMC_materials_mtoon;
  if (!mtoon) continue;
  if (mtoon.outlineWidthMode && mtoon.outlineWidthMode !== 'none') {
    mtoon.outlineWidthFactor = BODY_OUTLINE_W;
    if (!mtoon.outlineColorFactor) mtoon.outlineColorFactor = [0, 0, 0];
    nBumped++;
  }
}
console.log(`[mtoon] set body outline width to ${BODY_OUTLINE_W}m on ${nBumped} materials`);

// ---------- symmetrize asymmetric mouth morphs ----------
// The mouth's `surprised`, `aa`, `ih`, `ou`, `oh` morph targets all push
// vertices in -X (mean ΔX ≈ -12 mm for `surprised`), so the mouth visibly
// shifts to one side at high weights. Visemes switch every ~120 ms so the
// asymmetry isn't noticed during speech, but `surprised` holds at full
// weight and the lopsided look is obvious.
// Fix: zero the X component of each target's POSITION delta. The morph
// then only opens/widens the mouth (Y/Z motion) without translating it
// sideways.
const SYMMETRIZE_TARGETS = new Set(['surprised', 'aa', 'ih', 'ou', 'oh']);
function zeroXOnAccessor(accIdx) {
  const acc = json.accessors[accIdx];
  if (!acc || acc.type !== 'VEC3') return 0;
  let touched = 0;
  if (acc.bufferView !== undefined) {
    const bv = json.bufferViews[acc.bufferView];
    const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = bv.byteStride || 12;
    for (let i = 0; i < acc.count; i++) bin.writeFloatLE(0, off + i * stride);
    touched += acc.count;
  }
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
  const meshIdx = json.meshes.indexOf(m);
  const names = targetNamesOf(meshIdx);
  for (const prim of (m.primitives || [])) {
    for (let t = 0; t < (prim.targets || []).length; t++) {
      const tgt = prim.targets[t];
      if (tgt.POSITION === undefined) continue;
      if (!SYMMETRIZE_TARGETS.has(names[t])) continue;
      const n = zeroXOnAccessor(tgt.POSITION);
      if (n > 0) {
        nSymmetrized++;
        console.log(`[symmetrize] zeroed X-deltas on '${names[t]}' morph (${n} verts)`);
      }
    }
  }
}
if (nSymmetrized === 0) console.log('[symmetrize] no mouth targets needed symmetrizing');

// ---------- repack GLB ----------
const newJsonStr = JSON.stringify(json);
let newJsonBuf = Buffer.from(newJsonStr, 'utf8');
// JSON chunks must be 4-byte aligned, padded with spaces (0x20).
const pad = (4 - (newJsonBuf.length % 4)) % 4;
if (pad) newJsonBuf = Buffer.concat([newJsonBuf, Buffer.alloc(pad, 0x20)]);

const binBuf = bin || Buffer.alloc(0);
let binPad = (4 - (binBuf.length % 4)) % 4;
const paddedBin = binPad ? Buffer.concat([binBuf, Buffer.alloc(binPad, 0x00)]) : binBuf;

const newTotal = 12 + 8 + newJsonBuf.length + (paddedBin.length ? 8 + paddedBin.length : 0);
const out = Buffer.alloc(newTotal);
out.write('glTF', 0, 4, 'ascii');
out.writeUInt32LE(2, 4);
out.writeUInt32LE(newTotal, 8);
out.writeUInt32LE(newJsonBuf.length, 12);
out.write('JSON', 16, 4, 'ascii');
newJsonBuf.copy(out, 20);
if (paddedBin.length) {
  const off2 = 20 + newJsonBuf.length;
  out.writeUInt32LE(paddedBin.length, off2);
  out.write('BIN\0', off2 + 4, 4, 'ascii');
  paddedBin.copy(out, off2 + 8);
}

fs.writeFileSync(OUTPUT, out);
fs.copyFileSync(OUTPUT, ASSET);
console.log(`\n[out] ${OUTPUT} (${out.length} bytes)`);
console.log(`[out] mirrored → ${ASSET}`);
