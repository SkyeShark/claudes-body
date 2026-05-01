'use strict';

// ============================================================================
// vrm-character.js — three.js + three-vrm renderer that mirrors the same API
// as the SVG character in character.js. Lets app.js stay untouched: it still
// calls setEmotion / setArmPose / setMouth / speak / startIdle / etc.
//
// The VRM is loaded from assets/claude.vrm. We render into a transparent
// canvas that fills the window, on top of the same Electron click-through
// surface the SVG used. The window background stays transparent so the
// floating-character feeling is preserved.
// ============================================================================

import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// Constants — runtime bone-rotation limits. Defense in depth: even if a
// VRMA animation requests an angle outside this, we clamp before applying.
// Values in radians. Pitch = X axis, yaw = Y, roll = Z (three.js Euler XYZ).
// ---------------------------------------------------------------------------
const D2R = Math.PI / 180;
const Z_AXIS = { x: 0, y: 0, z: 1 };

// Rotates `bone` by `angle` radians around the given WORLD-space axis. The
// rotation is composed with the bone's current local rotation, so calling
// this every frame from a fresh starting state is safe (we always reset
// .rotation/.quaternion from the rest pose first via the caller). Uses the
// parent's world quaternion to convert the world axis into local space.
const _tmpQ = { _: null };  // hoisted out of hot path; created lazily below
const _tmpQ2 = { _: null };
const _tmpAxis = { _: null };
function rotateBoneAroundWorldAxis(bone, worldAxis, angle) {
  if (!bone) return;
  if (!_tmpQ._) { _tmpQ._ = new THREE.Quaternion(); _tmpQ2._ = new THREE.Quaternion(); _tmpAxis._ = new THREE.Vector3(); }
  // Get parent's world rotation
  bone.parent.getWorldQuaternion(_tmpQ._);
  // Express world axis in parent's local frame
  _tmpAxis._.set(worldAxis.x, worldAxis.y, worldAxis.z).applyQuaternion(_tmpQ._.invert());
  // Set the bone's local rotation to that axis-angle
  bone.quaternion.setFromAxisAngle(_tmpAxis._, angle);
}
const BONE_LIMITS = {
  head:           { x: [-15*D2R, 25*D2R], y: [-45*D2R, 45*D2R], z: [-15*D2R, 15*D2R] },
  neck:           { x: [-15*D2R, 15*D2R], y: [-25*D2R, 25*D2R], z: [-10*D2R, 10*D2R] },
  leftShoulder:   { z: [-90*D2R, 30*D2R] },
  rightShoulder:  { z: [-30*D2R, 90*D2R] },
  leftUpperArm:   { x: [-60*D2R, 60*D2R], y: [-90*D2R, 90*D2R], z: [-160*D2R, 30*D2R] },
  rightUpperArm:  { x: [-60*D2R, 60*D2R], y: [-90*D2R, 90*D2R], z: [-30*D2R, 160*D2R] },
  leftLowerArm:   { y: [0*D2R, 150*D2R] },   // hinge
  rightLowerArm:  { y: [-150*D2R, 0*D2R] },  // hinge (mirrored)
  spine:          { x: [-15*D2R, 15*D2R], y: [-30*D2R, 30*D2R], z: [-10*D2R, 10*D2R] },
};

function clampAngle(value, range) {
  if (!range) return value;
  return Math.max(range[0], Math.min(range[1], value));
}

function applyClampedRotation(bone, x, y, z) {
  if (!bone) return;
  const lim = BONE_LIMITS[bone.name] || {};
  bone.rotation.set(
    clampAngle(x || 0, lim.x),
    clampAngle(y || 0, lim.y),
    clampAngle(z || 0, lim.z),
  );
}

// ---------------------------------------------------------------------------
// Pose dictionary — translates the existing pose names into bone rotations.
// Each pose specifies, per side, the shoulder Z (swing-out) and the elbow
// hinge angle. Values are degrees-friendly and converted to radians at use.
// ---------------------------------------------------------------------------
// VRM authored T-pose has arms extended outward (along ±X). Bringing the
// arms to rest = down by the sides = ~90° rotation around Z. We anchor
// REST at sh=90 on both sides and offset relative to that for other poses.
// Smaller sh = arm raised; larger sh = arm tucked further inward/down.
const ARM_POSES_3D = {
  rest:         { L: { sh: 90,  el:    0 }, R: { sh: 90,   el:    0 } },
  wave:         { L: { sh: 90,  el:    0 }, R: { sh: -60,  el:  -25 } },
  open:         { L: { sh: 35,  el:    0 }, R: { sh: 35,   el:    0 } },
  open_big:     { L: { sh: 5,   el:    0 }, R: { sh: 5,    el:    0 } },
  shrug:        { L: { sh: 65,  el:  -90 }, R: { sh: 65,   el:  -90 } },
  in:           { L: { sh: 100, el:  -55 }, R: { sh: 100,  el:  -55 } },
  curious:      { L: { sh: 90,  el:    0 }, R: { sh: 65,   el: -110 } },
  one_out:      { L: { sh: 90,  el:    0 }, R: { sh: 15,   el:    0 } },
  hand_to_self: { L: { sh: 115, el: -100 }, R: { sh: 90,   el:    0 } },
  resolved:     { L: { sh: 72,  el:    0 }, R: { sh: 72,   el:    0 } },
  hands_up:     { L: { sh: -60, el:   20 }, R: { sh: -60,  el:   20 } },
};

// VRM expression names (we'll set up our own decal frames here later, for now
// just track current emotion so the rest of app.js's API works).
const SUPPORTED_EMOTIONS = new Set([
  'neutral','happy','warm','amused','smirky','thoughtful','sheepish','wonder',
  'surprised','sad','vulnerable','uncertain','resolved','matter','shy','annoyed',
]);

// ---------------------------------------------------------------------------
// Auto-weighting — per-mesh, position-based, runtime-only.
// ---------------------------------------------------------------------------
// Per-mesh candidate bone sets. Each entry is a list of bone-name regexes;
// any bone in the mesh's skeleton matching one of these patterns becomes a
// weighting candidate. Vertices then get their 4 closest candidates with
// inverse-distance weights, normalized to sum to 1.
// Bone names in this rig use camelCase suffix (shoulderL, upper_legR) — no
// period separator. Patterns target the suffix directly.
const MESH_CANDIDATES = [
  { match: /claudeburstmane|burst|mane/i, bones: ['head$'], rigid: true },
  { match: /head\+?neck|head|face/i,      bones: ['head$', 'neck$'] },
  { match: /torso\+?arms\+?hands|torso|body|arms|hands/i,
    bones: ['spine$', 'chest$', 'shoulder[LR]$', 'upper_arm[LR]$',
            'lower_arm[LR]$', 'hand[LR]$'] },
  { match: /legs/i, bones: ['hips$', 'upper_leg[LR]$', 'lower_leg[LR]$'] },
  { match: /feet|foot|toes/i, bones: ['foot[LR]$', 'lower_leg[LR]$', 'toes[LR]$'] },
  { match: /tail/i, bones: ['hips$', 'spine$'] },  // no tail bones; rigid to hips for now
];

function pickCandidate(sm) {
  // GLTF importers rename meshes to Cube009 etc.; the friendly region name
  // (feet, head+neck, claudeburstmane) is stored on the parent Object3D.
  const names = [sm.name, sm.parent?.name, sm.parent?.parent?.name].filter(Boolean);
  for (const c of MESH_CANDIDATES) {
    for (const n of names) if (c.match.test(n)) return c;
  }
  return null;
}

function autoWeight(rootScene, vrm) {
  const skinnedMeshes = [];
  rootScene.traverse(o => { if (o.isSkinnedMesh) skinnedMeshes.push(o); });

  for (const sm of skinnedMeshes) {
    const friendly = `${sm.name}<-${sm.parent?.name}`;
    const cand = pickCandidate(sm);
    if (!cand) {
      console.warn('[autoWeight] no candidate set for mesh:', friendly,
                   'skin bones:', sm.skeleton.bones.length,
                   'first 4:', sm.skeleton.bones.slice(0,4).map(b => b.name).join(','));
      continue;
    }
    const skel  = sm.skeleton;
    const bones = skel.bones;

    // Build candidate index list: indices into skel.bones that match any
    // pattern in this mesh's candidate set.
    const candIdx = [];
    for (let i = 0; i < bones.length; i++) {
      const name = bones[i].name;
      if (cand.bones.some(p => new RegExp(p).test(name))) candIdx.push(i);
    }
    if (!candIdx.length) {
      console.warn('[autoWeight] no matching bones for mesh:', sm.name,
                   'tried patterns:', cand.bones,
                   'available:', bones.map(b => b.name).join(','));
      continue;
    }

    const geom    = sm.geometry;
    const posAttr = geom.attributes.position;
    const skinIdx = geom.attributes.skinIndex;
    const skinWt  = geom.attributes.skinWeight;
    if (!posAttr || !skinIdx || !skinWt) {
      console.warn('[autoWeight] missing attrs on mesh:', sm.name);
      continue;
    }

    // Cache bone world positions (T-pose is current state).
    sm.updateMatrixWorld(true);
    bones.forEach(b => b.updateMatrixWorld(true));
    // Recompute inverseBindMatrices for the CURRENT pose. The exported file
    // only weighted to bone[0], so the inverses for other bones are likely
    // identity or stale — when we suddenly assign a vertex to handL, three.js
    // multiplies by garbage and the vertex flies off / collapses to origin.
    // Treating the current pose as the new bind pose fixes that.
    skel.boneInverses.forEach((m, i) => {
      m.copy(bones[i].matrixWorld).invert();
    });
    const bonePos = candIdx.map(i => bones[i].getWorldPosition(new THREE.Vector3()));

    const v   = new THREE.Vector3();
    const out = new Array(candIdx.length);
    // Per-vertex rigid binding: each vertex gets its single closest bone at
    // weight 1.0. Multi-bone blending caused arm vertices to be pulled
    // simultaneously by the unmoving spine and the rotating shoulder, which
    // collapsed the geometry. We pay for this with sharp seams at joints,
    // but at least every visible vertex moves cleanly with one parent.
    const k   = 1;
    const meshMat = sm.matrixWorld;

    for (let vi = 0; vi < posAttr.count; vi++) {
      v.fromBufferAttribute(posAttr, vi).applyMatrix4(meshMat);

      // distance² to each candidate bone
      for (let i = 0; i < candIdx.length; i++) {
        const d2 = bonePos[i].distanceToSquared(v);
        out[i] = { i: candIdx[i], d2 };
      }
      out.sort((a, b) => a.d2 - b.d2);

      // Inverse-distance weights for the top k bones; rigid mode = single bone.
      let wsum = 0;
      const winners = out.slice(0, k);
      for (const w of winners) {
        w.w  = cand.rigid ? 1 : 1 / Math.max(0.0001, Math.sqrt(w.d2));
        wsum += w.w;
      }
      for (const w of winners) w.w /= wsum;

      // Pad to 4 entries (skinIndex/skinWeight buffers always store 4).
      while (winners.length < 4) winners.push({ i: 0, w: 0 });

      skinIdx.setXYZW(vi, winners[0].i, winners[1].i, winners[2].i, winners[3].i);
      skinWt .setXYZW(vi, winners[0].w, winners[1].w, winners[2].w, winners[3].w);
    }
    skinIdx.needsUpdate = true;
    skinWt .needsUpdate = true;
    console.log('[autoWeight]', sm.name, '→', candIdx.length, 'candidate bones,',
                cand.rigid ? 'rigid' : 'top-' + k);
  }
}

// ---------------------------------------------------------------------------
// Factory — wires up scene, camera, renderer, model, and returns the same
// API surface as createClaude() in character.js so app.js doesn't have to
// know which backend it's talking to.
// ---------------------------------------------------------------------------
export async function createVrmClaude(canvasParent) {
  // --- scene & renderer ---
  const renderer = new THREE.WebGLRenderer({
    alpha: true,           // transparent background
    antialias: true,
    premultipliedAlpha: false,
  });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const sizeOf = () => {
    const r = canvasParent.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  };
  const { w, h } = sizeOf();
  renderer.setSize(w, h, false);
  canvasParent.appendChild(renderer.domElement);
  renderer.domElement.id = 'vrm-canvas';

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 20);
  // Camera framing is recomputed once the model loads so the whole character
  // fits the viewport regardless of model height.
  camera.position.set(0, 1.4, 3.0);
  camera.lookAt(0, 1.0, 0);

  // soft toon-friendly lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(0.4, 1.0, 0.7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffe6cc, 0.4);
  rim.position.set(-0.6, 0.4, -0.3);
  scene.add(rim);

  // --- load the VRM ---
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync('../assets/claude.vrm');
  const vrm  = gltf.userData.vrm;
  if (!vrm) throw new Error('vrm-character: VRM extension not found in claude.vrm');
  if (!vrm.scene) throw new Error('vrm-character: vrm.scene missing — three-vrm version mismatch?');
  console.log('[vrm] loaded, humanoid bones=', vrm.humanoid && Object.keys(vrm.humanoid.humanBones || {}).length);

  // VRMUtils cleanup is skipped intentionally: this model arrived with
  // weights collapsed to bone[0] only, and combineSkeletons sees that as
  // a sign each mesh's skeleton has only one bone, leaving us unable to
  // weight to anything else. We'll repaint weights ourselves and the
  // optimizer can run later when the model is properly bound.

  scene.add(vrm.scene);
  vrm.scene.rotation.y = Math.PI;
  vrm.scene.position.y = 0;

  // The starburst mane was authored as a separate mesh; reparent under
  // the head bone so it follows the head wherever it goes.
  const headBone = vrm.humanoid?.getNormalizedBoneNode('head')
                ?? vrm.humanoid?.getBoneNode?.('head');
  const manes = [];
  gltf.scene.traverse((obj) => {
    if (obj.isMesh && /claudeburstmane|burst|mane/i.test(obj.name)) manes.push(obj);
  });
  if (headBone && manes.length) {
    for (const m of manes) {
      headBone.attach(m);
      m.position.set(0, 0, 0);
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
    }
  }

  // Frame the camera around the (now-reparented) model.
  const box    = new THREE.Box3().setFromObject(gltf.scene);
  const size   = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  const fovRad = camera.fov * Math.PI / 180;
  const dist   = (size.y * 0.5 / Math.tan(fovRad / 2)) * 1.05;
  camera.position.set(center.x, center.y, dist);
  camera.lookAt(center.x, center.y, 0);
  camera.near = 0.1;
  camera.far  = dist * 4 + 5;
  camera.updateProjectionMatrix();

  // Auto-weight pass: the model arrived with skins referenced but with
  // every weight collapsed onto bone[0], so the mesh stayed at bind pose
  // forever. We re-paint weights at runtime by walking every SkinnedMesh's
  // vertices in world space, assigning each to its single closest bone in
  // a per-mesh candidate set, and recomputing inverseBindMatrices for the
  // current pose. This is a runtime stand-in for a proper Blender
  // weight-paint pass — adequate for arms/head/legs to move recognizably,
  // but produces sharp seams at joints we'll need to clean up later.
  autoWeight(gltf.scene, vrm);

  // Cache humanoid bones we drive from poses
  const H = vrm.humanoid;
  const bones = {
    head:          H?.getNormalizedBoneNode('head'),
    neck:          H?.getNormalizedBoneNode('neck'),
    leftShoulder:  H?.getNormalizedBoneNode('leftShoulder'),
    rightShoulder: H?.getNormalizedBoneNode('rightShoulder'),
    leftUpperArm:  H?.getNormalizedBoneNode('leftUpperArm'),
    rightUpperArm: H?.getNormalizedBoneNode('rightUpperArm'),
    leftLowerArm:  H?.getNormalizedBoneNode('leftLowerArm'),
    rightLowerArm: H?.getNormalizedBoneNode('rightLowerArm'),
    spine:         H?.getNormalizedBoneNode('spine'),
    chest:         H?.getNormalizedBoneNode('chest'),
  };

  // Initial state
  let currentEmotion = 'neutral';
  let dragging = false;
  let isBlinking = false;
  // Start at the rest pose (arms by sides, not the bind-pose T-shape).
  let armSh = { L: ARM_POSES_3D.rest.L.sh, R: ARM_POSES_3D.rest.R.sh };
  let armEl = { L: ARM_POSES_3D.rest.L.el, R: ARM_POSES_3D.rest.R.el };

  // --- pose application ---
  function applyArmPose(name, durationMs) {
    durationMs = durationMs == null ? 700 : durationMs;
    const target = ARM_POSES_3D[name] || ARM_POSES_3D.rest;
    const startSh = { L: armSh.L, R: armSh.R };
    const startEl = { L: armEl.L, R: armEl.R };
    const t0 = performance.now();
    function step() {
      const k = Math.min(1, (performance.now() - t0) / durationMs);
      const e = 1 - Math.pow(1 - k, 3);
      armSh.L = startSh.L + (target.L.sh - startSh.L) * e;
      armSh.R = startSh.R + (target.R.sh - startSh.R) * e;
      armEl.L = startEl.L + (target.L.el - startEl.L) * e;
      armEl.R = startEl.R + (target.R.el - startEl.R) * e;
      if (k < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // --- expression / emotion ---
  function setEmotion(name) {
    if (!SUPPORTED_EMOTIONS.has(name)) name = 'neutral';
    currentEmotion = name;
    // Drive VRM expression manager if mappings exist (these are stubs in the
    // current model; harmless no-ops if the named expressions aren't present).
    const em = vrm.expressionManager;
    if (em) {
      ['happy','sad','angry','surprised','relaxed'].forEach(k => em.setValue(k, 0));
      const map = { happy: 'happy', warm: 'happy', amused: 'happy', surprised: 'surprised',
                    wonder: 'surprised', sad: 'sad', vulnerable: 'sad', annoyed: 'angry' };
      const m = map[name];
      if (m) em.setValue(m, 1);
    }
  }

  // --- mouth / visemes ---
  // Three-vrm has standard visemes "aa","ih","ou","ee","oh"; map our names.
  const VISEME_MAP = {
    v_closed: null,
    v_e:  'ee', v_a: 'aa', v_aa: 'aa', v_o: 'oh', v_oo: 'ou', v_f: 'ih',
    rest: null, smile: null, smirk: null, pursed: null, frown: null, smileBig: null,
  };
  function setMouth(name) {
    const em = vrm.expressionManager;
    if (!em) return;
    ['aa','ih','ou','ee','oh'].forEach(k => em.setValue(k, 0));
    const m = VISEME_MAP[name];
    if (m) em.setValue(m, 0.9);
  }
  function setEyes()  {} // SVG-only; no-op for parity with the API
  function setBrows() {} // SVG-only; no-op

  // --- blink ---
  function triggerBlink() {
    const em = vrm.expressionManager;
    if (!em || isBlinking) return;
    isBlinking = true;
    em.setValue('blink', 1);
    setTimeout(() => { em.setValue('blink', 0); isBlinking = false; }, 110);
  }

  // --- speak (delegates to Web Speech API; same shape as character.js) ---
  let currentUtterance = null;
  let currentSpeakFinish = null;
  let stopRequested = false;

  function pickVoice(prefs) {
    const all = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    if (!all.length) return null;
    if (prefs && prefs.byName) {
      const exact = all.find(v => v.name === prefs.byName);
      if (exact) return exact;
    }
    if (prefs && prefs.gender) {
      const fem = /(zira|aria|jenny|samantha|hazel|karen|susan|moira|fiona|veena|tessa|allison|ava|female)/i;
      const mas = /(david|mark|daniel|alex|tom|james|george|brian|fred|oliver|ralph|male)/i;
      const test = prefs.gender === 'female' ? fem : mas;
      const m = all.find(v => test.test(v.name) && v.lang && v.lang.startsWith('en'));
      if (m) return m;
    }
    return all.find(v => v.lang && v.lang.startsWith('en')) || all[0];
  }

  function stopSpeaking() {
    stopRequested = true;
    if (window.speechSynthesis) try { window.speechSynthesis.cancel(); } catch (_) {}
    setMouth('v_closed');
    const f = currentSpeakFinish; currentSpeakFinish = null;
    if (f) try { f(); } catch (_) {}
  }

  function speak(text, opts) {
    opts = opts || {};
    stopRequested = false;
    return new Promise((resolve) => {
      if (!text || !text.trim()) return resolve();
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        setMouth('v_closed');
        if (currentSpeakFinish === finish) currentSpeakFinish = null;
        resolve();
      };
      currentSpeakFinish = finish;
      if (!window.speechSynthesis || opts.muted) return finish();
      let utter;
      try { utter = new SpeechSynthesisUtterance(text); } catch (_) { return finish(); }
      const v = pickVoice(opts.voicePrefs || {});
      if (v) utter.voice = v;
      utter.rate   = opts.rate   != null ? opts.rate   : 0.96;
      utter.pitch  = opts.pitch  != null ? opts.pitch  : 1.04;
      utter.volume = opts.volume != null ? opts.volume : 1.0;
      utter.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        // simple amplitude-style: alternate open/closed mouth on each word
        setMouth('v_e');
        setTimeout(() => setMouth('v_closed'), 120);
      };
      utter.onend = utter.onerror = finish;
      try { window.speechSynthesis.speak(utter); } catch (_) { return finish(); }
      currentUtterance = utter;
    });
  }

  // --- idle + per-frame update ---
  let idleStarted = false;
  const t0 = performance.now();
  let lastBlinkMs = t0;
  function tick(now) {
    const t = (now - t0) / 1000;

    // breathing (head bob via spine slight rotation)
    const breath = Math.sin(t * 1.4) * 0.015;
    if (bones.spine) bones.spine.position.y = breath * 0.5;

    // gentle head sway when idle
    const headYaw   = Math.sin(t * (dragging ? 3 : 0.7)) * (dragging ? 0.18 : 0.05);
    const headPitch = Math.sin(t * (dragging ? 4 : 1.4)) * (dragging ? 0.12 : 0.03);
    applyClampedRotation(bones.head, headPitch, headYaw, 0);

    // arm sway
    const swayMag  = (dragging ? 5 : 1.6) * D2R;
    const swayFreq = dragging ? 5 : 1.2;
    const swayL = Math.sin(t * swayFreq) * swayMag;
    const swayR = Math.sin(t * swayFreq + Math.PI) * swayMag;

    // For this VRM rig, the upper-arm bone's local +Y points outward along
    // the arm. Rotating around the bone's local X swings the arm forward/back
    // in the world; rotating around local Z swings it up/down (the axis we
    // want for "T-pose → arms by sides"). Convention found by experiment:
    //   - LEFT arm: local Z, NEGATIVE values bring the hand down
    //   - RIGHT arm: local Z, POSITIVE values bring the hand down
    // sh in our table is in degrees, with rest=90 meaning arms by sides.
    // Apply rotations as quaternions around the WORLD Z axis (the
    // "swing the arm down" axis in screen space). For each bone we
    // convert world-space rotation into the bone's local frame by
    // composing with the parent's world quaternion. This sidesteps the
    // per-bone Euler-axis confusion entirely.
    // Sign convention found by capture: rotating around world +Z by a
    // POSITIVE angle swings the LEFT arm DOWN; the right arm is mirrored.
    rotateBoneAroundWorldAxis(bones.leftUpperArm,  Z_AXIS,  armSh.L * D2R + swayL);
    rotateBoneAroundWorldAxis(bones.rightUpperArm, Z_AXIS, -armSh.R * D2R + swayR);
    // Elbow hinge: rotate around the bone's parent's local Y (which is the
    // upper-arm length axis once everything settles). Using a fixed local
    // axis here is safe because lower_arm always inherits upper_arm's frame.
    if (bones.leftLowerArm)  bones.leftLowerArm.rotation.set(0,  -armEl.L * D2R, 0);
    if (bones.rightLowerArm) bones.rightLowerArm.rotation.set(0,  armEl.R * D2R, 0);

    // random idle blinks
    if (!isBlinking && now - lastBlinkMs > 2000 && Math.random() < 0.005) {
      triggerBlink();
      lastBlinkMs = now;
    }

    if (vrm.update) vrm.update(0.016);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  function startIdle() {
    if (idleStarted) return;
    idleStarted = true;
    requestAnimationFrame(tick);
  }

  // --- assembly intro: just settle the model in place from a small jump ---
  async function assemble() {
    vrm.scene.position.y = -0.5;
    const t0 = performance.now();
    return new Promise(resolve => {
      function step() {
        const k = Math.min(1, (performance.now() - t0) / 600);
        const e = 1 - Math.pow(1 - k, 3);
        vrm.scene.position.y = -0.5 + 0.5 * e;
        if (k < 1) requestAnimationFrame(step);
        else resolve();
      }
      step();
    });
  }

  function setDragging(on) { dragging = !!on; }

  // --- resize ---
  window.addEventListener('resize', () => {
    const { w, h } = sizeOf();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  return {
    setEmotion,
    setEyes,
    setBrows,
    setMouth,
    setArmPose: applyArmPose,
    blink: triggerBlink,
    startIdle,
    assemble,
    speak,
    stopSpeaking,
    setDragging,
    get currentEmotion() { return currentEmotion; },
  };
}
