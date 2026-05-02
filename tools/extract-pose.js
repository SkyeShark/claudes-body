#!/usr/bin/env node
'use strict';

// extract-pose.js — Read a posed .vrm and write its bone rotations +
// translations to a sidecar JSON file. The renderer loads this at
// startup and applies it to the matching bones on the (clean T-pose)
// claude.vrm, producing the standing pose at runtime.

const fs = require('fs');

const INPUT  = process.argv[2] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claudelatest.vrm';
const OUTPUT = process.argv[3] || 'C:/Users/sdn52/OneDrive/Desktop/claudethinking/claude.pose.json';

const buf = fs.readFileSync(INPUT);
if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB: ' + INPUT);
const c0len = buf.readUInt32LE(12);
const json = JSON.parse(buf.toString('utf8', 20, 20 + c0len));

const pose = {};
for (const n of json.nodes) {
  if (!n.name) continue;
  const r = n.rotation;
  if (!r) continue;
  const isIdentity = r[0] === 0 && r[1] === 0 && r[2] === 0 && Math.abs(r[3] - 1) < 1e-6;
  if (isIdentity) continue;
  pose[n.name] = { rotation: r.slice() };
  // Optionally also capture posed translations / scales if they differ from
  // a sensible default. For our case rotations are the meaningful pose data.
  if (n.translation) pose[n.name].translation = n.translation.slice();
}

fs.writeFileSync(OUTPUT, JSON.stringify(pose, null, 2));
console.log('[pose] extracted', Object.keys(pose).length, 'posed bones from ' + INPUT);
console.log('[pose] →', OUTPUT);
