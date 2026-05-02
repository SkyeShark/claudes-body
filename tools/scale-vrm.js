#!/usr/bin/env node
'use strict';

// scale-vrm.js — Scale a VRM uniformly to a target world-space height.
// Operates entirely on the GLB JSON (no Blender), preserving bone weights,
// expression bindings, materials, etc. Just adjusts the Hips scale.
//
// Usage: node scale-vrm.js <input.vrm> <output.vrm> <target_height_m>

const fs = require('fs');

const INPUT  = process.argv[2] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claude-tpose-giant.vrm';
const OUTPUT = process.argv[3] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claude_scaled.vrm';
const TARGET_HEIGHT = parseFloat(process.argv[4] || '1.7');

const raw = fs.readFileSync(INPUT);
if (raw.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const c0len = raw.readUInt32LE(12);
const json = JSON.parse(raw.toString('utf8', 20, 20 + c0len));
const c0pad = (4 - (c0len % 4)) % 4;
const binStart = 20 + c0len + c0pad;
const c1len = raw.readUInt32LE(binStart);
const bin = Buffer.from(raw.slice(binStart + 8, binStart + 8 + c1len));

// Use the body mesh's bbox Y extent across ALL primitives (the body
// can be split into prim0=body, prim1=mane, prim2=shoes, etc — using
// just prim0 misses the mane and over-scales).
const body = json.meshes.find(m => /char/.test(m.name || ''));
if (!body) throw new Error('no body mesh');
let yMin = Infinity, yMax = -Infinity;
for (const p of body.primitives) {
  const acc = json.accessors[p.attributes.POSITION];
  if (acc.min[1] < yMin) yMin = acc.min[1];
  if (acc.max[1] > yMax) yMax = acc.max[1];
}
const meshLocalHeight = yMax - yMin;

const hips = json.nodes.find(n => n.name === 'Hips');
if (!hips) throw new Error('no Hips node');
const oldScale = (hips.scale || [1, 1, 1])[0];
const currentWorldHeight = meshLocalHeight * oldScale;
const factor = TARGET_HEIGHT / currentWorldHeight;
const newScale = oldScale * factor;
console.log('[scale] mesh-local bbox height =', meshLocalHeight.toFixed(2), 'units (includes mane)');
console.log('[scale] current world height   =', currentWorldHeight.toFixed(3), 'm');
console.log('[scale] target  world height   =', TARGET_HEIGHT.toFixed(3), 'm');
console.log('[scale] factor =', factor.toFixed(3) + 'x  Hips scale', oldScale.toFixed(4), '→', newScale.toFixed(4));

hips.scale = [newScale, newScale, newScale];

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
console.log('[out]', OUTPUT, '(' + out.length + ' bytes)');
