#!/usr/bin/env node
'use strict';

// split-pose.js — Take a posed .vrm and produce two files:
//   1. claude.vrm        — same mesh, but bone node rotations zeroed AND
//                           inverseBindMatrices recomputed for the T-pose
//                           rest. This is a "clean T-pose" VRM that other
//                           tools can read without confusion.
//   2. claude.pose.json   — the user-authored bone rotations + translations,
//                           keyed by bone name. The renderer applies these
//                           at startup so the model shows the standing pose.
//
// Why this approach: Blender's VRM exporter writes node rotations AND the
// inverseBindMatrices that go with them, so at runtime they cancel and the
// mesh renders in T-pose. Splitting the pose out into a sidecar JSON, with
// a freshly-recomputed T-pose bind, makes the math correct.

const fs = require('fs');

const INPUT  = process.argv[2] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claudelatest.vrm';
const OUTPUT = process.argv[3] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claude.vrm';
const POSE   = process.argv[4] || OUTPUT.replace(/\.vrm$/, '.pose.json');

// ---------------- minimal Mat4 / Vec3 helpers (column-major like glTF) -----
function mat4Identity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}
function quatToMat4(q) {
  const [x,y,z,w] = q;
  const xx=x*x, yy=y*y, zz=z*z;
  const xy=x*y, xz=x*z, yz=y*z;
  const wx=w*x, wy=w*y, wz=w*z;
  return [
    1-2*(yy+zz), 2*(xy+wz),   2*(xz-wy),   0,
    2*(xy-wz),   1-2*(xx+zz), 2*(yz+wx),   0,
    2*(xz+wy),   2*(yz-wx),   1-2*(xx+yy), 0,
    0, 0, 0, 1,
  ];
}
function mat4Translate(t) {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, t[0],t[1],t[2],1];
}
function mat4Scale(s) {
  return [s[0],0,0,0, 0,s[1],0,0, 0,0,s[2],0, 0,0,0,1];
}
function mat4Mul(a, b) {  // a * b, column-major
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c*4 + r] = 0;
    for (let k = 0; k < 4; k++) o[c*4 + r] += a[k*4 + r] * b[c*4 + k];
  }
  return o;
}
function mat4Invert(m) {  // 4x4 inverse via cofactors
  const inv = new Array(16);
  inv[0]  =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
  inv[4]  = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
  inv[8]  =  m[4]*m[9]*m[15]  - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
  inv[12] = -m[4]*m[9]*m[14]  + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
  inv[1]  = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
  inv[5]  =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
  inv[9]  = -m[0]*m[9]*m[15]  + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
  inv[13] =  m[0]*m[9]*m[14]  - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
  inv[2]  =  m[1]*m[6]*m[15]  - m[1]*m[7]*m[14]  - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7]  - m[13]*m[3]*m[6];
  inv[6]  = -m[0]*m[6]*m[15]  + m[0]*m[7]*m[14]  + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7]  + m[12]*m[3]*m[6];
  inv[10] =  m[0]*m[5]*m[15]  - m[0]*m[7]*m[13]  - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7]  - m[12]*m[3]*m[5];
  inv[14] = -m[0]*m[5]*m[14]  + m[0]*m[6]*m[13]  + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6]  + m[12]*m[2]*m[5];
  inv[3]  = -m[1]*m[6]*m[11]  + m[1]*m[7]*m[10]  + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7]   + m[9]*m[3]*m[6];
  inv[7]  =  m[0]*m[6]*m[11]  - m[0]*m[7]*m[10]  - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7]   - m[8]*m[3]*m[6];
  inv[11] = -m[0]*m[5]*m[11]  + m[0]*m[7]*m[9]   + m[4]*m[1]*m[11] - m[4]*m[3]*m[9]  - m[8]*m[1]*m[7]   + m[8]*m[3]*m[5];
  inv[15] =  m[0]*m[5]*m[10]  - m[0]*m[6]*m[9]   - m[4]*m[1]*m[10] + m[4]*m[2]*m[9]  + m[8]*m[1]*m[6]   - m[8]*m[2]*m[5];
  let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
  if (det === 0) return mat4Identity();
  det = 1.0 / det;
  return inv.map(x => x * det);
}

// ---------------- read GLB --------------------------------------------------
const raw = fs.readFileSync(INPUT);
if (raw.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
let off = 12;
const c0len = raw.readUInt32LE(off);
const json = JSON.parse(raw.toString('utf8', off + 8, off + 8 + c0len));
const c0pad = (4 - (c0len % 4)) % 4;
let bin = null;
let binStart = off + 8 + c0len + c0pad;
if (binStart < raw.length) {
  const c1len  = raw.readUInt32LE(binStart);
  bin = Buffer.from(raw.slice(binStart + 8, binStart + 8 + c1len));
}
console.log('[in] meshes=' + json.meshes.length, 'nodes=' + json.nodes.length, 'skins=' + (json.skins||[]).length);

// ---------------- harvest pose & zero rotations -----------------------------
const pose = {};
for (const n of json.nodes) {
  if (!n.name) continue;
  if (n.rotation) {
    const r = n.rotation;
    const isIdentity = r[0]===0 && r[1]===0 && r[2]===0 && Math.abs(r[3]-1)<1e-6;
    if (!isIdentity) {
      pose[n.name] = { rotation: r.slice() };
      n.rotation = [0, 0, 0, 1];   // zero in the file
    }
  }
}
console.log('[pose] harvested ' + Object.keys(pose).length + ' bone rotations into sidecar');

// ---------------- recompute inverseBindMatrices (T-pose bind) ---------------
// For every skin's joints, walk the parent chain using the (now zeroed)
// rotations + the original translations / scales, and recompute the inverse
// bind. This makes inverseBindMatrices match the T-pose-rest the .vrm now
// describes.
const parent = new Array(json.nodes.length).fill(-1);
for (let i = 0; i < json.nodes.length; i++) {
  for (const c of (json.nodes[i].children || [])) parent[c] = i;
}
function nodeLocalMatrix(idx) {
  const n = json.nodes[idx];
  const T = mat4Translate(n.translation || [0, 0, 0]);
  const R = quatToMat4(n.rotation       || [0, 0, 0, 1]);
  const S = mat4Scale(n.scale           || [1, 1, 1]);
  return mat4Mul(mat4Mul(T, R), S);
}
function nodeWorldMatrix(idx) {
  let m = nodeLocalMatrix(idx);
  let p = parent[idx];
  while (p >= 0) {
    m = mat4Mul(nodeLocalMatrix(p), m);
    p = parent[p];
  }
  return m;
}

let nIbmRewritten = 0;
for (const skin of json.skins || []) {
  const acc = json.accessors[skin.inverseBindMatrices];
  const bufView = json.bufferViews[acc.bufferView];
  const baseOff = (bufView.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = 64;
  for (let j = 0; j < skin.joints.length; j++) {
    const jointIdx = skin.joints[j];
    const world = nodeWorldMatrix(jointIdx);
    const ibm = mat4Invert(world);
    for (let k = 0; k < 16; k++) {
      bin.writeFloatLE(ibm[k], baseOff + j * stride + k * 4);
    }
    nIbmRewritten++;
  }
}
console.log('[ibm] recomputed ' + nIbmRewritten + ' inverseBindMatrices');

// ---------------- repack GLB ------------------------------------------------
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
fs.writeFileSync(POSE, JSON.stringify(pose, null, 2));
console.log('[out] ' + OUTPUT + ' (' + out.length + ' bytes)');
console.log('[out] ' + POSE);
