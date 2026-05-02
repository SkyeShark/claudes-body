'use strict';

// ============================================================================
// vrm-character.js — three.js + three-vrm renderer. Mirrors most of the
// API of the legacy SVG character (character.js) so app.js can call the
// same setEmotion / setMouth / speak / startIdle / setDragging / etc.
//
// The VRM is loaded from assets/claude.vrm. We render into a transparent
// canvas that fills the window, on top of the same Electron click-through
// surface the SVG used. The window background stays transparent so the
// floating-character feeling is preserved.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import * as CANNON from 'cannon-es';
// Re-export so test pages can grab them off the bundle global
export { THREE, GLTFLoader, VRMLoaderPlugin, VRMAnimationLoaderPlugin, CANNON };

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

// VRM expression names (we'll set up our own decal frames here later, for now
// just track current emotion so the rest of app.js's API works).
const SUPPORTED_EMOTIONS = new Set([
  'neutral','happy','warm','amused','smirky','thoughtful','sheepish','wonder',
  'surprised','sad','vulnerable','uncertain','resolved','matter','shy','annoyed',
  'angry','catface','smug','cat','relaxed','rest',
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
    // Recompute inverseBindMatrices treating the CURRENT pose as the new
    // bind. The skinning shader does `vertex_world = boneMat * invBind *
    // vertex_local`, where vertex_local is in mesh-local space. So:
    //   invBind = inverse(bone.matrixWorld) * mesh.matrixWorld
    // The earlier version missed the mesh.matrixWorld factor, which is why
    // re-weighting at bind-pose still distorted the mesh.
    skel.boneInverses.forEach((m, i) => {
      m.copy(bones[i].matrixWorld).invert().multiply(sm.matrixWorld);
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
    preserveDrawingBuffer: true,  // so canvas.toDataURL captures real frames
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

  // Authored in Blender at point (1.43825, -0.356749, 1.56646) m, 10W white
  // with shadows. Converted Z-up → Y-up. Driven as a DirectionalLight
  // pointing from that position toward the model's center (MToon doesn't
  // light from point/spot, so we approximate with a directional from the
  // same direction).
  const blenderLight = new THREE.DirectionalLight(0xffffff, 2.0);
  blenderLight.position.set(1.43825, 1.56646, 0.356749);
  blenderLight.target.position.set(0, 1.0, 0);  // aim at character mid-height
  blenderLight.castShadow = true;
  blenderLight.shadow.mapSize.set(1024, 1024);
  blenderLight.shadow.camera.near  = 0.1;
  blenderLight.shadow.camera.far   = 6;
  blenderLight.shadow.camera.left  = -1.5;
  blenderLight.shadow.camera.right =  1.5;
  blenderLight.shadow.camera.top   =  2.5;
  blenderLight.shadow.camera.bottom= -0.5;
  scene.add(blenderLight);
  scene.add(blenderLight.target);

  // --- load the VRM via three-vrm's VRMLoaderPlugin ---
  // Gives us proper MToon material rendering, expressionManager,
  // humanoid bone normalization, and (later) spring bones. The pose
  // normalization that previously broke us is now harmless — Claude_Fixed
  // has the desired pose baked into its rest, so normalization is a no-op.
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  // Same loader handles .vrma files too — VRMAnimationLoaderPlugin
  // attaches a `vrmAnimations` array to gltf.userData when the glTF
  // declares the VRMC_vrm_animation extension.
  loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.loadAsync('../assets/claude.vrm');
  const vrm = gltf.userData.vrm;
  if (!vrm) throw new Error('VRMLoaderPlugin did not produce a vrm in userData');
  const vrmRoot = vrm.scene;
  console.log('[vrm] loaded; humanoid bones=',
              vrm.humanoid ? Object.keys(vrm.humanoid.humanBones).length : 0,
              'expressions=',
              vrm.expressionManager ? vrm.expressionManager.expressions.length : 0);

  scene.add(vrmRoot);

  // Stop three-vrm from overwriting raw bone rotations every frame with
  // copies from the normalized humanoid skeleton — we drive raw bones
  // directly so deltas compose naturally with the file's authored rest
  // pose (arms-down standing pose, not T-pose).
  if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = false;
  // No flip needed: this VRM (built from finalCLAUDEweightpaint.fbx via
  // tools/fbx-to-vrm.py) is authored with the face along +Z, which the
  // default three.js camera (looking down -Z) sees front-on.
  vrm.scene.position.y = 0;

  // The starburst mane is a separate SkinnedMesh; we leave it parented at
  // the scene root and let the auto-weight pass bind its vertices to the
  // head bone. (Earlier we tried headBone.attach() but it broke the mesh's
  // bind transform, doubling the head offset and floating the mane.)

  // Frame the camera around the (now-reparented) model. If HEAD_ZOOM is on,
  // tighten the framing to just the head sphere so we can see the face.
  const box    = new THREE.Box3().setFromObject(gltf.scene);
  const size   = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  const fovRad = camera.fov * Math.PI / 180;
  const headBone = vrm.humanoid?.getNormalizedBoneNode?.('head')
                ?? vrm.humanoid?.getBoneNode?.('head');
  if (window.HEAD_ZOOM && headBone) {
    const headPos = new THREE.Vector3();
    headBone.getWorldPosition(headPos);
    // Approximate head sphere center. In icon-capture mode, lift the
    // center higher up so the mane is centered (not the face), which
    // crops out the body cleanly.
    const headTop = new THREE.Vector3();
    headBone.localToWorld(headTop.set(0, 0.25, 0));
    const lerpT = window.CAPTURE_ICON ? 0.85 : 0.5;
    const sphereCenter = headPos.clone().lerp(headTop, lerpT);
    const headHeight = window.HEAD_ZOOM_FIT || 0.5;
    const dist = (headHeight * 0.5 / Math.tan(fovRad / 2)) * 1.2;
    camera.position.set(sphereCenter.x, sphereCenter.y, dist);
    camera.lookAt(sphereCenter.x, sphereCenter.y, 0);
    camera.near = 0.05;
    camera.far  = dist * 4 + 5;
    console.log('[vrm] HEAD_ZOOM camera at', sphereCenter, 'dist=' + dist.toFixed(3));
  } else {
    const fitSize = Math.max(size.x, size.y);
    const dist = (fitSize * 0.5 / Math.tan(fovRad / 2)) * 1.4;
    camera.position.set(center.x, center.y, center.z + dist);
    camera.lookAt(center.x, center.y, center.z);
    camera.near = 0.05;
    camera.far  = dist * 4 + 10;
    console.log('[cam] center=', center.x.toFixed(2), center.y.toFixed(2), center.z.toFixed(2),
                'size=', size.x.toFixed(2), size.y.toFixed(2), size.z.toFixed(2));
  }
  camera.updateProjectionMatrix();

  // ---- humanoid bone lookup via three-vrm ----
  // vrm.humanoid maps standardized humanoid bone names ('head', 'leftUpperArm',
  // ...) to the scene's actual bone nodes, regardless of how the source
  // armature named them. We use RAW bones (the actual scene nodes) so their
  // initial quaternion is the file's authored rest pose, not the abstract
  // T-pose neutral that the normalized bones present.
  const getBone = (name) => vrm.humanoid?.getRawBoneNode?.(name)
                         ?? vrm.humanoid?.getBoneNode?.(name)
                         ?? null;
  const bones = {
    head:          getBone('head'),
    neck:          getBone('neck'),
    leftShoulder:  getBone('leftShoulder'),
    rightShoulder: getBone('rightShoulder'),
    leftUpperArm:  getBone('leftUpperArm'),
    rightUpperArm: getBone('rightUpperArm'),
    leftLowerArm:  getBone('leftLowerArm'),
    rightLowerArm: getBone('rightLowerArm'),
    spine:         getBone('spine'),
    chest:         getBone('chest'),
    // Legs — needed for ragdoll physics during drag.
    leftUpperLeg:  getBone('leftUpperLeg'),
    rightUpperLeg: getBone('rightUpperLeg'),
    leftLowerLeg:  getBone('leftLowerLeg'),
    rightLowerLeg: getBone('rightLowerLeg'),
    // Hips: not ragdolled, but its world position is driven each frame
    // from spine's "head" (the hips end of the torso) so the tail and
    // legs translate with the body during drag.
    hips:          getBone('hips'),
    // Hand bones — used by IK as the chain end-effectors and for click
    // hit-testing on hand-grab.
    leftHand:      getBone('leftHand'),
    rightHand:     getBone('rightHand'),
  };
  // Tail base — root of the spring-bone chain. Rotating this each
  // frame propagates motion down the tail through the spring sim.
  // Found by name since it isn't a humanoid preset.
  let tailBase = null;
  vrm.scene.traverse(o => {
    if (o.isBone && /^tailbase$/i.test(o.name)) tailBase = o;
  });
  console.log('[tail] tailbase =', tailBase ? tailBase.name : 'NOT FOUND');
  const tailRestQ = tailBase ? tailBase.quaternion.clone() : null;
  // Tail bones aren't ragdolled — three-vrm's VRMC_springBone simulation
  // animates them. With Hips translating during drag (driven from the
  // spine body's hip end), the spring sim sees parent motion and the
  // tail wags naturally.
  console.log('[vrm] bones.hips =', bones.hips ? bones.hips.name : 'NULL',
              'parent =', bones.hips?.parent?.name);

  // Initial state
  let currentEmotion = 'neutral';
  let dragging = false;
  let isBlinking = false;
  // The authored VRM file already includes a proper standing pose (legs,
  // feet, tail, arms). Snapshot every posed bone's authored quaternion so
  // we can compose runtime arm-pose deltas ON TOP of the rest pose instead
  // of overwriting it.
  const restRot = {};
  for (const [name, bone] of Object.entries(bones)) {
    if (bone) restRot[name] = bone.quaternion.clone();
  }
  // ---- VRMA animation mixer ----
  // VRMA = VRM Animation, a glTF-based clip format with humanoid bone
  // tracks. We load each .vrma into an AnimationClip retargeted to
  // Claude's bones via createVRMAnimationClip, then play through a
  // standard three.js AnimationMixer. Loaded clips are cached by name.
  const animMixer = new THREE.AnimationMixer(vrm.scene);
  const animClock = new THREE.Clock();
  const animClips = new Map();        // name → THREE.AnimationClip
  let   currentAnimAction = null;
  let   animSuppressIK    = false;    // while true, IK + manual armPose
                                      // are gated off so the clip owns the
                                      // bones cleanly.

  // Two anti-clip passes for the mane vs chest:
  //   1) limitHeadBow — caps the head's forward pitch (world frame) so
  //      a clip like Thankful that bows forward can't bring the mane's
  //      bottom petal forward into the chest.
  //   2) clampHeadAboveChest — ensures the head's world-Y stays at
  //      least (rest_distance − margin) above the chest's world-Y. This
  //      catches squats / spine bends (Cheering) where the chest rises
  //      toward the head even though head pitch is fine.
  // Both run after vrm.update so corrections land on raw bones.
  const MAX_HEAD_BOW    = Math.PI / 6;       // 30° forward
  const HEAD_CHEST_GIVE = 0.05;              // m of vertical squish allowed
  const _hbWorldX       = new THREE.Vector3(1, 0, 0);
  const _hbHeadUp       = new THREE.Vector3();
  const _hbHeadWorldQ   = new THREE.Quaternion();

  // Track head's world-Y clearance over EVERY relevant upper-body
  // bone (chest, both shoulders). Cheering's spine arch + shoulder
  // raise lifts the shoulder bones toward the head while the chest
  // bone itself barely moves; tracking only chest misses that.
  const HEAD_CLEAR_BONES = ['chest', 'spine', 'leftShoulder', 'rightShoulder'];
  const _hdRestLocalPos = new THREE.Vector3();
  const _hdRestAbove    = {};                // bone name → rest(head_y − bone_y)
  const _hdHeadPos      = new THREE.Vector3();
  const _hdBonePos      = new THREE.Vector3();
  const _hdWorldLift    = new THREE.Vector3();
  const _hdLocalLift    = new THREE.Vector3();
  const _hdParentInvQ   = new THREE.Quaternion();
  if (bones.head) {
    _hdRestLocalPos.copy(bones.head.position);
    const _h = new THREE.Vector3();
    const _b = new THREE.Vector3();
    bones.head.getWorldPosition(_h);
    for (const name of HEAD_CLEAR_BONES) {
      if (!bones[name]) continue;
      bones[name].getWorldPosition(_b);
      _hdRestAbove[name] = _h.y - _b.y;
    }
  }

  function limitHeadBow() {
    if (!bones.head) return;
    bones.head.getWorldQuaternion(_hbHeadWorldQ);
    _hbHeadUp.set(0, 1, 0).applyQuaternion(_hbHeadWorldQ);
    const bow = Math.atan2(_hbHeadUp.z, _hbHeadUp.y);
    if (bow > MAX_HEAD_BOW) {
      bones.head.rotateOnWorldAxis(_hbWorldX, -(bow - MAX_HEAD_BOW));
      bones.head.updateMatrixWorld(true);
    }
  }

  function clampHeadAboveBody() {
    if (!bones.head) return;
    bones.head.getWorldPosition(_hdHeadPos);
    // Find the largest deficit across all tracked bones.
    let maxLift = 0;
    for (const name of HEAD_CLEAR_BONES) {
      if (!bones[name] || _hdRestAbove[name] === undefined) continue;
      bones[name].getWorldPosition(_hdBonePos);
      const above = _hdHeadPos.y - _hdBonePos.y;
      const minAbove = _hdRestAbove[name] - HEAD_CHEST_GIVE;
      const deficit = minAbove - above;
      if (deficit > maxLift) maxLift = deficit;
    }
    if (maxLift <= 0) {
      bones.head.position.copy(_hdRestLocalPos);
      return;
    }
    // Convert the world-Y lift to head-bone-local (parent = neck).
    bones.head.parent.getWorldQuaternion(_hdParentInvQ).invert();
    _hdWorldLift.set(0, maxLift, 0);
    _hdLocalLift.copy(_hdWorldLift).applyQuaternion(_hdParentInvQ);
    bones.head.position.copy(_hdRestLocalPos).add(_hdLocalLift);
    bones.head.updateMatrixWorld(true);
  }

  async function loadAnimation(name, url) {
    if (animClips.has(name)) return animClips.get(name);
    const animLoader = new GLTFLoader();
    animLoader.register(parser => new VRMAnimationLoaderPlugin(parser));
    const animGltf = await animLoader.loadAsync(url);
    const vrmAnim = (animGltf.userData.vrmAnimations || [])[0];
    if (!vrmAnim) throw new Error('no VRMC_vrm_animation in ' + url);
    const clip = createVRMAnimationClip(vrmAnim, vrm);
    clip.name = name;
    animClips.set(name, clip);
    console.log('[vrma] loaded', name, 'duration=' + clip.duration.toFixed(2) + 's',
                'tracks=' + clip.tracks.length);
    return clip;
  }

  // Play a previously-loaded clip. opts.loop=true for seamless looping
  // (e.g. idle/talking baselines). opts.fade controls cross-fade in
  // seconds when interrupting an existing clip.
  function playAnimation(name, opts = {}) {
    const clip = animClips.get(name);
    if (!clip) { console.warn('[vrma] not loaded:', name); return null; }
    const next = animMixer.clipAction(clip);
    next.reset();
    next.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !opts.loop;
    const fade = opts.fade ?? 0.25;
    if (currentAnimAction && currentAnimAction !== next) {
      currentAnimAction.fadeOut(fade);
      next.fadeIn(fade).play();
    } else {
      next.play();
    }
    currentAnimAction = next;
    animSuppressIK = true;
    // VRMA tracks target the NORMALIZED humanoid bones. Re-enable
    // auto-propagation so vrm.update() copies the animated rotations
    // back into the raw scene bones (which is what we render). We turn
    // it back off in stopAnimation/finished so the rest of our code
    // (manual armPose, IK, ragdoll) keeps owning the raw bones.
    if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = true;
    return next;
  }

  function stopAnimation(fade = 0.2) {
    if (currentAnimAction) {
      currentAnimAction.fadeOut(fade);
      currentAnimAction = null;
    }
    // Snap bones back to authored rest after the fade completes.
    setTimeout(() => {
      animSuppressIK = false;
      if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = false;
      for (const [name, bone] of Object.entries(bones)) {
        if (bone && restRot[name]) bone.quaternion.copy(restRot[name]);
      }
    }, fade * 1000 + 30);
  }

  animMixer.addEventListener('finished', (e) => {
    // One-shot finished. Resume looping idle through playAnimation so
    // we get its crossfade (the previous code only faded idle IN, not
    // the finished action OUT, leaving both at weight 1 with
    // clampWhenFinished — bones blended halfway between gesture-end
    // and idle, which read as "stuck mid-pose").
    const action = e.action;
    if (!action || action.loop !== THREE.LoopOnce) return;
    if (dragging) return;
    if (animClips.has('idle')) playAnimation('idle', { loop: true, fade: 0.35 });
  });

  // ---- IK rest data ----
  // Two-bone IK for an arm: shoulder → elbow → hand. At runtime we
  // solve for joint rotations that put the hand at a target world
  // position. Captured ONCE at load before any physics runs.
  function captureArmIK(side) {
    const upper = bones[side + 'UpperArm'];
    const lower = bones[side + 'LowerArm'];
    const hand  = bones[side + 'Hand'];
    if (!upper || !lower || !hand) {
      console.warn('[ik]', side, 'arm bones missing:', !!upper, !!lower, !!hand);
      return null;
    }
    upper.updateWorldMatrix(true, false);
    lower.updateWorldMatrix(true, false);
    hand.updateWorldMatrix(true, false);
    const sW = new THREE.Vector3(); upper.getWorldPosition(sW);
    const eW = new THREE.Vector3(); lower.getWorldPosition(eW);
    const hW = new THREE.Vector3(); hand.getWorldPosition(hW);
    const upperRestWorldQ = new THREE.Quaternion(); upper.getWorldQuaternion(upperRestWorldQ);
    const lowerRestWorldQ = new THREE.Quaternion(); lower.getWorldQuaternion(lowerRestWorldQ);
    return {
      upper, lower, hand,
      L1: sW.distanceTo(eW),
      L2: eW.distanceTo(hW),
      // Direction from each bone's pivot to its child, in WORLD space at
      // rest. Used to compute the rotation delta that points the bone
      // toward a new direction.
      upperRestWorldDir: eW.clone().sub(sW).normalize(),
      lowerRestWorldDir: hW.clone().sub(eW).normalize(),
      upperRestWorldQ,
      lowerRestWorldQ,
      // Tracks the previous frame's clamped delta angle (radians, signed,
      // measured from the upper arm rest direction in the X-Y plane).
      // Used by clampTargetToArmROM to keep the unwrap continuous: when
      // the cursor sweeps around through the anatomically-forbidden back
      // of the body, we DON'T want the arm to snap to the opposite limit.
      // null = fresh grab, no history yet.
      prevClampDelta: null,
    };
  }
  const leftArmIK  = captureArmIK('left');
  const rightArmIK = captureArmIK('right');
  console.log('[ik] left arm:', leftArmIK
    ? `L1=${leftArmIK.L1.toFixed(3)} L2=${leftArmIK.L2.toFixed(3)}`
    : 'NOT AVAILABLE');
  console.log('[ik] right arm:', rightArmIK
    ? `L1=${rightArmIK.L1.toFixed(3)} L2=${rightArmIK.L2.toFixed(3)}`
    : 'NOT AVAILABLE');

  // Two-bone IK solver in 2D (X-Y plane). Given a target world position,
  // computes new bone quaternions that put the hand at the target while
  // keeping the elbow on the natural-bend side (below the shoulder→target
  // line, mimicking gravity-pulled-down elbow position).
  const _ikDeltaQ      = new THREE.Quaternion();
  const _ikParentInvQ  = new THREE.Quaternion();
  const _ikNewWorldQ   = new THREE.Quaternion();
  const _ikDir1        = new THREE.Vector3();
  const _ikDir2        = new THREE.Vector3();
  const _ikSnapUpper   = new THREE.Quaternion();
  const _ikSnapLower   = new THREE.Quaternion();
  const _ikTargetQ     = new THREE.Quaternion();

  // Anatomical limits on shoulder rotation from rest, in radians.
  // Asymmetric: arms can swing UP/OVER almost fully (real shoulders do
  // ~180° of forward flexion), but only ~100° BELOW rest before the
  // arm would clip through the torso.
  // BACK = how far the arm can swing BELOW the rest line (down + slightly behind)
  // FORWARD = how far the arm can swing UP and OVER (overhead → across-body)
  const ARM_REACH_BACK_LIMIT    = Math.PI * 0.55;  // ~99° (arm can swing down past T-pose)
  const ARM_REACH_FORWARD_LIMIT = Math.PI * 0.78;  // ~140° (overhead reach without
                                                   //   over-rotating past natural max)

  // Clamp a desired target so the upper arm rotation from rest stays
  // within anatomical bounds. `ik` carries `upperRestWorldDir` plus
  // `prevClampDelta` for continuity-preserving unwrap.
  function clampTargetToArmROM(targetWorld, S, ik, sideSign) {
    const restDir = ik.upperRestWorldDir;
    // Vector from shoulder to target in the X-Y plane
    const tx = targetWorld.x - S.x;
    const ty = targetWorld.y - S.y;
    const dist = Math.sqrt(tx * tx + ty * ty);
    if (dist < 0.001) return targetWorld;

    const restAng = Math.atan2(restDir.y, restDir.x);
    const tgtAng  = Math.atan2(ty, tx);
    let delta = tgtAng - restAng;
    // If we have history, pick the 2π wrap that keeps delta closest to
    // the previous clamped value. Without this, sweeping the cursor
    // through the anatomically-forbidden back of the body causes
    // delta to flip sign on the unit circle and the arm snaps to the
    // opposite limit. With it, an over-the-limit motion just stays
    // pinned to the same boundary it was already at.
    const prev = ik.prevClampDelta;
    if (prev != null) {
      while (delta - prev >  Math.PI) delta -= 2 * Math.PI;
      while (delta - prev < -Math.PI) delta += 2 * Math.PI;
    } else {
      while (delta >  Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
    }

    // sideSign mirrors the limit for left vs right (left arm rotates
    // one direction for "across body", right arm the other).
    const minAng = -ARM_REACH_BACK_LIMIT * sideSign;
    const maxAng =  ARM_REACH_FORWARD_LIMIT * sideSign;
    const lo = Math.min(minAng, maxAng);
    const hi = Math.max(minAng, maxAng);
    const clamped = Math.max(lo, Math.min(hi, delta));
    ik.prevClampDelta = clamped;
    if (clamped === delta) return targetWorld;

    const newAng = restAng + clamped;
    return new THREE.Vector3(
      S.x + dist * Math.cos(newAng),
      S.y + dist * Math.sin(newAng),
      targetWorld.z,
    );
  }

  function applyArmIK(ik, targetWorld, sideSign, blend = 1) {
    if (!ik || blend <= 0) return;
    ik.upper.parent.updateMatrixWorld(true);
    const S = new THREE.Vector3(); ik.upper.getWorldPosition(S);

    // Apply anatomical clamp so arm can't swing into impossible angles.
    targetWorld = clampTargetToArmROM(targetWorld, S, ik, sideSign);

    // Compute elbow world position via 2-bone IK in the X-Y plane.
    const dx = targetWorld.x - S.x;
    const dy = targetWorld.y - S.y;
    let D = Math.sqrt(dx * dx + dy * dy);
    const reach = ik.L1 + ik.L2;
    let elbowWorld;
    if (D >= reach - 0.001 || D < 0.001) {
      D = Math.max(D, 0.001);
      const ux = dx / D, uy = dy / D;
      elbowWorld = new THREE.Vector3(S.x + ux * ik.L1, S.y + uy * ik.L1, S.z);
    } else {
      const ux = dx / D, uy = dy / D;
      const along = (ik.L1 * ik.L1 + D * D - ik.L2 * ik.L2) / (2 * D);
      const perp = Math.sqrt(Math.max(0, ik.L1 * ik.L1 - along * along));
      // Pick the perpendicular that puts the elbow on the gravity-natural
      // side — i.e. below the shoulder→target line where possible. When
      // both perpendiculars are horizontal (target straight above/below),
      // we tie-break with sideSign so the elbow stays anatomically
      // sensible for the arm being moved.
      let px = -uy, py = ux;
      if (py > 0) { px = -px; py = -py; }
      elbowWorld = new THREE.Vector3(
        S.x + ux * along + px * perp,
        S.y + uy * along + py * perp,
        S.z,
      );
    }

    // Snapshot the current (pre-IK) bone quaternions so we can slerp
    // toward the IK result by `blend`. When blend=0, the arm fully
    // keeps its current pose; when blend=1, IK fully owns it.
    _ikSnapUpper.copy(ik.upper.quaternion);
    _ikSnapLower.copy(ik.lower.quaternion);

    // Upper arm: compute IK quaternion in a temp, then slerp from
    // snapshot to that temp by blend. The slerp target MUST be a
    // separate quaternion — `q.copy(a).slerp(q, t)` aliases the source
    // and target so the slerp degenerates to a, dropping the IK pose.
    _ikDir1.subVectors(elbowWorld, S).normalize();
    _ikDeltaQ.setFromUnitVectors(ik.upperRestWorldDir, _ikDir1);
    _ikNewWorldQ.copy(_ikDeltaQ).multiply(ik.upperRestWorldQ);
    ik.upper.parent.getWorldQuaternion(_ikParentInvQ).invert();
    _ikTargetQ.copy(_ikParentInvQ).multiply(_ikNewWorldQ);
    if (blend >= 1) ik.upper.quaternion.copy(_ikTargetQ);
    else            ik.upper.quaternion.copy(_ikSnapUpper).slerp(_ikTargetQ, blend);
    ik.upper.updateMatrixWorld(true);

    // Lower arm: same trick, separate target quaternion.
    _ikDir2.subVectors(targetWorld, elbowWorld).normalize();
    _ikDeltaQ.setFromUnitVectors(ik.lowerRestWorldDir, _ikDir2);
    _ikNewWorldQ.copy(_ikDeltaQ).multiply(ik.lowerRestWorldQ);
    ik.lower.parent.getWorldQuaternion(_ikParentInvQ).invert();
    _ikTargetQ.copy(_ikParentInvQ).multiply(_ikNewWorldQ);
    if (blend >= 1) ik.lower.quaternion.copy(_ikTargetQ);
    else            ik.lower.quaternion.copy(_ikSnapLower).slerp(_ikTargetQ, blend);
    ik.lower.updateMatrixWorld(true);
  }

  // IK targets — set externally each frame for whichever hand is held.
  // ikLeftHandTarget/ikRightHandTarget reflect the user's CURRENT intent
  // (null = released). ikLastTargetL/R hold the most recent non-null
  // target so we can keep applying IK during ease-out, slerp-ing from
  // the IK pose back to the animation pose.
  let ikLeftHandTarget  = null;
  let ikRightHandTarget = null;
  let ikLastTargetL     = null;
  let ikLastTargetR     = null;
  let ikBlendL          = 0;
  let ikBlendR          = 0;
  const IK_BLEND_RATE   = 0.18;   // per-tick exponential approach to target
  function setLeftHandIKTarget(v)  { ikLeftHandTarget  = v; if (v) ikLastTargetL = v; }
  function setRightHandIKTarget(v) { ikRightHandTarget = v; if (v) ikLastTargetR = v; }
  function clearLeftHandIKTarget()  {
    ikLeftHandTarget = null;
    if (leftArmIK) leftArmIK.prevClampDelta = null;
  }
  function clearRightHandIKTarget() {
    ikRightHandTarget = null;
    if (rightArmIK) rightArmIK.prevClampDelta = null;
  }
  function clearHandIKTargets() {
    ikLeftHandTarget = null; ikRightHandTarget = null;
    if (leftArmIK)  leftArmIK.prevClampDelta  = null;
    if (rightArmIK) rightArmIK.prevClampDelta = null;
  }

  // Hit-test: is the given client-space (window) point near a hand's
  // projected screen position? Returns 'left'/'right'/null. The 'left'
  // and 'right' bone names refer to Claude's anatomical sides.
  function whichHandHit(clientX, clientY, tolerancePx = 80) {
    const rect = renderer.domElement.getBoundingClientRect();
    function distTo(bone) {
      if (!bone) return Infinity;
      bone.updateWorldMatrix(true, false);
      const w = new THREE.Vector3(); bone.getWorldPosition(w);
      const p = w.clone().project(camera);
      const sx = rect.left + (p.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top  + (1 - (p.y * 0.5 + 0.5)) * rect.height;
      const dx = clientX - sx, dy = clientY - sy;
      return Math.sqrt(dx * dx + dy * dy);
    }
    const dL = distTo(bones.leftHand);
    const dR = distTo(bones.rightHand);
    const closest = Math.min(dL, dR);
    if (closest > tolerancePx) return null;
    return dL <= dR ? 'left' : 'right';
  }
  // Backwards-compat: old code calls isLeftHandHit.
  function isLeftHandHit(clientX, clientY, tolerancePx = 80) {
    return whichHandHit(clientX, clientY, tolerancePx) === 'left';
  }

  // Convert a client-space screen point to a world position on a plane
  // at the named hand's current Z.
  const _csRaycaster = new THREE.Raycaster();
  const _csPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  function cursorToHandTargetWorld(clientX, clientY, side = 'left') {
    const handBone = bones[side + 'Hand'];
    if (!handBone) return null;
    const handWorld = new THREE.Vector3();
    handBone.getWorldPosition(handWorld);
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    _csRaycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    _csPlane.constant = -handWorld.z;
    const out = new THREE.Vector3();
    return _csRaycaster.ray.intersectPlane(_csPlane, out) ? out : null;
  }

  // Returns true if the canvas's rendered alpha at this client point is
  // above ALPHA_HIT — i.e., the cursor is over an actual painted pixel
  // of Claude (silhouette), not a transparent area of the window.
  // Uses a 1×1 readPixels — cheap enough to call on every mousemove.
  // Requires the WebGLRenderer to have preserveDrawingBuffer: true
  // (otherwise the framebuffer is cleared after present).
  const _hitPixel = new Uint8Array(4);
  const ALPHA_HIT = 16;   // ~6% opacity threshold
  function isCharacterPixel(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const xCss = clientX - rect.left;
    const yCss = clientY - rect.top;
    if (xCss < 0 || yCss < 0 || xCss >= rect.width || yCss >= rect.height) return false;
    const dpr = renderer.getPixelRatio();
    const canvasW = renderer.domElement.width;
    const canvasH = renderer.domElement.height;
    const px = Math.floor(xCss * dpr);
    // WebGL origin is bottom-left, DOM origin is top-left.
    const py = Math.floor(canvasH - yCss * dpr - 1);
    if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) return false;
    const gl = renderer.getContext();
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, _hitPixel);
    return _hitPixel[3] >= ALPHA_HIT;
  }

  // ---- real ragdoll physics via cannon-es ----
  // Each ragdolled bone gets a CANNON.Body sized to the bone segment.
  // Bodies are connected by PointToPointConstraint at joint positions.
  // A KINEMATIC anchor at the top of the chain holds everything up; when
  // the user drags the window, we move that anchor and the rest of the
  // body dangles from gravity + constraints.
  //
  // Built lazily on first drag (cheap to keep null until then), torn down
  // on release so the rest pose snaps back instantly.

  // Humanoid bones that get a rigid body (looked up via vrm.humanoid).
  // Tail is NOT here — we let three-vrm's existing VRMC_springBone sim
  // animate the tail, since it's literally what spring bones are for.
  // With Hips translating during drag (driven by spine-body physics),
  // the spring sim sees the parent moving and the tail wags naturally.
  const RAGDOLL_HUMAN_BONES = [
    'spine', 'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm',
    'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg',
  ];
  // child-bone → parent-body. spine attaches to the kinematic anchor.
  const RAGDOLL_PARENT = {
    leftUpperArm: 'spine',  rightUpperArm: 'spine',
    leftUpperLeg: 'spine',  rightUpperLeg: 'spine',
    leftLowerArm: 'leftUpperArm',
    rightLowerArm: 'rightUpperArm',
    leftLowerLeg: 'leftUpperLeg',
    rightLowerLeg: 'rightUpperLeg',
  };
  // Per-bone soft angle limit around the hinge axis (world Z). When a
  // body's deviation from rest exceeds the limit, a restoring torque is
  // applied each frame to push it back. cannon-es HingeConstraint has
  // no built-in limit, so we add this manually.
  // Values in radians. The default of π/2 (90°) lets bodies swing nearly
  // a quarter circle — plenty for most ragdoll motion without folding
  // legs into the chest.
  // Asymmetric anatomical limits, in radians, around the world-Z hinge.
  // Sign convention: positive Z-rotation is counter-clockwise viewed
  // from +Z (camera). For Claude's LEFT arm (his anatomical left =
  // screen right), +Z rotates the arm OUTWARD (toward T-pose); -Z
  // rotates it ACROSS the torso. Right arm is mirrored.
  // Generous outward range; tiny inward range so arms can't fold
  // through the chest.
  const ANGLE_LIMITS = {
    spine:         { min: -Math.PI * 0.20, max: Math.PI * 0.20 },
    leftUpperArm:  { min: -Math.PI * 0.05, max: Math.PI * 0.70 },  // -9° in, +126° out
    rightUpperArm: { min: -Math.PI * 0.70, max: Math.PI * 0.05 },  // mirror
    leftLowerArm:  { min: -Math.PI * 0.55, max: Math.PI * 0.10 },  // elbow bends inward
    rightLowerArm: { min: -Math.PI * 0.10, max: Math.PI * 0.55 },
    leftUpperLeg:  { min: -Math.PI * 0.20, max: Math.PI * 0.30 },
    rightUpperLeg: { min: -Math.PI * 0.30, max: Math.PI * 0.20 },
    leftLowerLeg:  { min: -Math.PI * 0.55, max: 0.0 },             // knee bends one way
    rightLowerLeg: { min: -Math.PI * 0.55, max: 0.0 },
  };
  const LIMIT_K = 80;   // restoring torque per radian past the limit
  const REST_K  = 2.5;  // gentle pull toward rest at all times — keeps
                        // bodies from drifting away over many drag impulses
  const MAX_ANG_V = 10; // rad/s cap — kills runaway tumbling outright
  const MAX_LIN_V = 4;  // m/s cap on body linear velocity
  const BONE_RADIUS = 0.04;     // capsule-ish thickness
  const BONE_MASS   = 1.0;      // uniform mass for now; tune later

  let physicsWorld = null;
  let ragdollData  = null;       // map: name → { body, length, restWorldQ, parentBoneRestWorldQ }
  let kinematicAnchor = null;
  let pendingDragDx = 0;
  let pendingDragDy = 0;

  // Reusable temp objects (created once, reused per frame).
  const _v3a = new THREE.Vector3();
  const _v3b = new THREE.Vector3();
  const _qa  = new THREE.Quaternion();
  const _qb  = new THREE.Quaternion();
  const _qc  = new THREE.Quaternion();
  const _yAxis = new THREE.Vector3(0, 1, 0);

  function buildRagdoll() {
    // Reduced gravity (cannon-es ragdoll example precedent) — the chain
    // settles into "dangle" without thrashing wildly. Real-world g would
    // make a ~1m chain swing through huge angles in 1 second of drag.
    physicsWorld = new CANNON.World({ gravity: new CANNON.Vec3(0, -5, 0) });
    physicsWorld.solver.iterations = 24;
    physicsWorld.solver.tolerance   = 0.001;

    ragdollData = {};

    // Per-bone setup: rigid body sized to bone length, oriented so its
    // local Y axis points along the bone's tail direction (head→tail is
    // body-local +Y). So body-local -Y end = bone HEAD (joint to parent),
    // body-local +Y end = bone TAIL (joint to child).
    for (const name of RAGDOLL_HUMAN_BONES) {
      const bone = bones[name];
      if (!bone) continue;
      bone.updateWorldMatrix(true, false);
      const child = bone.children.find(c => c.isBone || c.children?.length);
      if (!child) continue;
      child.updateWorldMatrix(true, false);

      const headWorld = new THREE.Vector3(); bone.getWorldPosition(headWorld);
      const tailWorld = new THREE.Vector3(); child.getWorldPosition(tailWorld);
      const length = headWorld.distanceTo(tailWorld);
      if (length < 1e-4) continue;

      const center = headWorld.clone().lerp(tailWorld, 0.5);
      const dir = tailWorld.clone().sub(headWorld).normalize();
      const bodyRestWorldQ = new THREE.Quaternion().setFromUnitVectors(_yAxis, dir);

      const body = new CANNON.Body({
        mass: BONE_MASS,
        shape: new CANNON.Box(new CANNON.Vec3(BONE_RADIUS * 1.5, length / 2, BONE_RADIUS)),
        position: new CANNON.Vec3(center.x, center.y, center.z),
        quaternion: new CANNON.Quaternion(bodyRestWorldQ.x, bodyRestWorldQ.y, bodyRestWorldQ.z, bodyRestWorldQ.w),
        linearDamping: 0.3,
        angularDamping: 0.6,
        collisionFilterGroup: 2,
        collisionFilterMask: 0,     // no self-collision
      });
      // Lock to 2D physics: bodies can only translate in X-Y plane and
      // rotate around world Z (the hinge axis). Prevents the "rotate to
      // side-view → tumbling glitch" because bodies physically CAN'T
      // turn out of the lateral plane.
      body.linearFactor.set(1, 1, 0);
      body.angularFactor.set(0, 0, 1);
      physicsWorld.addBody(body);

      const boneRestWorldQ = new THREE.Quaternion();
      bone.getWorldQuaternion(boneRestWorldQ);

      ragdollData[name] = {
        body, length,
        headLocal: new CANNON.Vec3(0, -length / 2, 0),  // body local: bone head end
        tailLocal: new CANNON.Vec3(0,  length / 2, 0),  // body local: bone tail end
        headWorld, tailWorld,
        boneRestWorldQ,
        bodyRestWorldQ,
      };
    }

    // HingeConstraint per joint with the hinge axis = world Z. Restricts
    // ALL relative rotation between connected bodies to one degree of
    // freedom (the X-Y plane), structurally preventing pretzel-twist.
    // Convert world Z into each body's local frame at rest so the
    // constraint refers to the same world direction in both bodies.
    const _worldZ = new THREE.Vector3(0, 0, 1);
    const _tmpQ = new THREE.Quaternion();
    let nConstraints = 0;
    for (const [child, parent] of Object.entries(RAGDOLL_PARENT)) {
      const c = ragdollData[child], p = ragdollData[parent];
      if (!c || !p) continue;
      const jointWorld = new CANNON.Vec3(c.headWorld.x, c.headWorld.y, c.headWorld.z);
      const parentLocal = new CANNON.Vec3();
      p.body.pointToLocalFrame(jointWorld, parentLocal);

      const axisAv = _worldZ.clone().applyQuaternion(_tmpQ.copy(p.bodyRestWorldQ).invert());
      const axisBv = _worldZ.clone().applyQuaternion(_tmpQ.copy(c.bodyRestWorldQ).invert());

      physicsWorld.addConstraint(new CANNON.HingeConstraint(p.body, c.body, {
        pivotA: parentLocal,
        pivotB: c.headLocal,
        axisA: new CANNON.Vec3(axisAv.x, axisAv.y, axisAv.z),
        axisB: new CANNON.Vec3(axisBv.x, axisBv.y, axisBv.z),
      }));
      nConstraints++;
    }
    console.log('[ragdoll] joints:', nConstraints, '(hinge around world Z, 1-DOF)');

    // Snapshot the Hips bone's rest LOCAL position so we can offset it
    // each frame to match the physics-driven hips location, then restore
    // it when ragdoll tears down.
    if (bones.hips) {
      ragdollData._hipsRestLocalPos = bones.hips.position.clone();
    }

    // Kinematic anchor at the spine's TAIL (chest area). The whole body
    // dangles from this point. During drag, the anchor moves with the
    // cursor — its motion pulls the constraint chain.
    if (ragdollData.spine) {
      const sp = ragdollData.spine;
      kinematicAnchor = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        position: new CANNON.Vec3(sp.tailWorld.x, sp.tailWorld.y, sp.tailWorld.z),
      });
      physicsWorld.addBody(kinematicAnchor);

      physicsWorld.addConstraint(new CANNON.PointToPointConstraint(
        kinematicAnchor, new CANNON.Vec3(0, 0, 0),
        sp.body, sp.tailLocal,
      ));
    }

    console.log('[ragdoll] built', Object.keys(ragdollData).length, 'bodies');
  }

  function teardownRagdoll() {
    if (!physicsWorld) return;
    // Restore Hips's local position before clearing ragdollData.
    if (ragdollData?._hipsRestLocalPos && bones.hips) {
      bones.hips.position.copy(ragdollData._hipsRestLocalPos);
    }
    physicsWorld = null;
    ragdollData = null;
    kinematicAnchor = null;
    // Snap bones back to rest quaternion.
    for (const [name, q] of Object.entries(restRot)) {
      if (bones[name]) bones[name].quaternion.copy(q);
    }
  }

  // World-space "size" of one screen pixel — used to convert the cursor's
  // pixel velocity into physics-world velocity for the kinematic anchor.
  // Calibrated so a 200-px window jerk ≈ 0.3m of anchor motion (visible
  // ragdoll without flinging the body across the screen).
  const PX_TO_WORLD   = 0.0004;
  const ANCHOR_MAX_V  = 2.0;  // m/s — cap so fast cursor jerks don't whip
                              // the chain into chaotic spinning angles
  function _clampMag(v, mx) { return v > mx ? mx : (v < -mx ? -mx : v); }

  function updateRagdoll(dt) {
    if (!physicsWorld) return;
    if (kinematicAnchor && dragging) {
      // Velocity-based anchor follows cursor delta (capped). Stays bounded
      // around the original chest position so the body can't drift outside
      // the window's render area.
      const vx = _clampMag(pendingDragDx * PX_TO_WORLD / dt, ANCHOR_MAX_V);
      const vy = _clampMag(-pendingDragDy * PX_TO_WORLD / dt, ANCHOR_MAX_V);
      kinematicAnchor.velocity.set(vx, vy, 0);
    } else if (kinematicAnchor) {
      kinematicAnchor.velocity.set(0, 0, 0);
    }
    pendingDragDx = 0;
    pendingDragDy = 0;

    // Hard angle limits (anatomical bounds). 2D-locked bodies rotate
    // only around world Z, so the angle-around-Z math is unambiguous.
    // Limits are asymmetric so e.g. arms can swing freely OUT but
    // can't fold across the torso.
    for (const [name, data] of Object.entries(ragdollData)) {
      const lim = ANGLE_LIMITS[name];
      if (lim == null || !data?.body) continue;
      _qa.set(data.body.quaternion.x, data.body.quaternion.y, data.body.quaternion.z, data.body.quaternion.w);
      _qb.copy(data.bodyRestWorldQ).invert();
      _qa.multiply(_qb);
      const angleZ = 2 * Math.atan2(_qa.z, _qa.w);
      if (angleZ > lim.max) {
        data.body.torque.z += -(angleZ - lim.max) * LIMIT_K;
      } else if (angleZ < lim.min) {
        data.body.torque.z += -(angleZ - lim.min) * LIMIT_K;
      }
    }

    physicsWorld.step(1/60, dt, 3);

    // Velocity caps — runaway tumbling and explosive flings are both
    // numerical-instability symptoms. Hard-clamp magnitudes so the
    // simulation can't blow up regardless of how hard the user shakes.
    for (const data of Object.values(ragdollData)) {
      if (!data || !data.body) continue;
      const av = data.body.angularVelocity;
      const aSpeed = Math.sqrt(av.x*av.x + av.y*av.y + av.z*av.z);
      if (aSpeed > MAX_ANG_V) {
        const s = MAX_ANG_V / aSpeed;
        av.x *= s; av.y *= s; av.z *= s;
      }
      const lv = data.body.velocity;
      const lSpeed = Math.sqrt(lv.x*lv.x + lv.y*lv.y + lv.z*lv.z);
      if (lSpeed > MAX_LIN_V) {
        const s = MAX_LIN_V / lSpeed;
        lv.x *= s; lv.y *= s; lv.z *= s;
      }
    }

    // Drive Hips bone's WORLD position from the spine body's head (= the
    // physics location where hips is supposed to be). This makes the tail
    // and legs (Hips's scene children) translate with the dangling body.
    // Guard against NaN — a single physics blowup shouldn't permanently
    // teleport the mesh out of frame.
    if (bones.hips && ragdollData.spine) {
      const sp = ragdollData.spine;
      const headWorld = new CANNON.Vec3();
      sp.body.pointToWorldFrame(sp.headLocal, headWorld);
      if (Number.isFinite(headWorld.x) && Number.isFinite(headWorld.y) && Number.isFinite(headWorld.z)) {
        const v = new THREE.Vector3(headWorld.x, headWorld.y, headWorld.z);
        bones.hips.parent.worldToLocal(v);
        if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
          // Log every ~30 frames how much Hips has moved from its rest
          // local position — this tells us whether the Hips translation
          // is actually firing and by how much.
          if ((Date.now() / 16 | 0) % 30 === 0) {
            const r = ragdollData._hipsRestLocalPos;
            if (r) {
              console.log('[hips] Δ from rest:',
                (v.x - r.x).toFixed(3),
                (v.y - r.y).toFixed(3),
                (v.z - r.z).toFixed(3));
            }
          }
          bones.hips.position.copy(v);
        }
      }
    } else if (!bones.hips) {
      // One-time warn if hips is null — explains why tail isn't moving
      // with the body.
      if (!ragdollData._hipsWarned) {
        ragdollData._hipsWarned = true;
        console.warn('[hips] bone is NULL — tail will not translate with body');
      }
    }

    // Copy each body's world quaternion back to its bone's local quaternion.
    //
    // Math: at build time, body and bone differ by a fixed delta D in world
    // space, defined by:   bodyRest = boneRest * D   so   D = boneRest⁻¹ · bodyRest
    // At runtime, that delta still holds:   bodyNow = boneNow * D
    // → boneNow = bodyNow · D⁻¹ = bodyNow · bodyRest⁻¹ · boneRest
    // Then convert world → local by left-multiplying parent.worldQuaternion⁻¹.
    for (const [name, data] of Object.entries(ragdollData)) {
      const bone = bones[name];
      if (!bone || !data?.body) continue;
      _qa.set(data.body.quaternion.x, data.body.quaternion.y,
              data.body.quaternion.z, data.body.quaternion.w);
      _qb.copy(data.bodyRestWorldQ).invert();
      _qa.multiply(_qb);
      _qa.multiply(data.boneRestWorldQ);
      bone.parent.getWorldQuaternion(_qb);
      _qa.premultiply(_qb.invert()).normalize();
      bone.quaternion.copy(_qa);
    }
    // Head bone is locked: never write to it. Stays at rest pose.
  }

  // --- expression / emotion ---
  // Catface is held visually for CATFACE_HOLD_MS once triggered, and
  // visemes are blocked during the hold so the :3 mouth shape isn't
  // immediately replaced by aa/oh/etc. when speech starts.
  const CATFACE_HOLD_MS = 12000;
  let catfaceLockUntil = 0;
  function isCatfaceLocked() { return performance.now() < catfaceLockUntil; }

  function setEmotion(name) {
    if (!SUPPORTED_EMOTIONS.has(name)) name = 'neutral';
    // While catface is locked, ignore any non-catface emotion change.
    if (isCatfaceLocked() && name !== 'catface' && name !== 'smug' && name !== 'cat') {
      return;
    }
    currentEmotion = name;
    const em = vrm.expressionManager;
    if (!em) return;
    // Clear every face-driving expression so they don't stack.
    ['happy','sad','angry','surprised','relaxed','catface','neutral'].forEach(k => em.setValue(k, 0));
    const map = {
      happy: 'happy', warm: 'happy', amused: 'happy',
      surprised: 'surprised', wonder: 'surprised',
      sad: 'sad', vulnerable: 'sad',
      annoyed: 'angry', angry: 'angry',
      catface: 'catface', smug: 'catface', cat: 'catface',
      neutral: 'relaxed', relaxed: 'relaxed', rest: 'relaxed',
    };
    const m = map[name];
    if (m) em.setValue(m, 1);
    if (m === 'catface') catfaceLockUntil = performance.now() + CATFACE_HOLD_MS;
  }

  // --- mouth / visemes ---
  // Standard visemes "aa","ih","ou","ee","oh" plus the custom :3 shape
  // ("catface") authored on this model.
  const VISEME_MAP = {
    v_closed: null,
    v_e:  'ee', v_a: 'aa', v_aa: 'aa', v_o: 'oh', v_oo: 'ou', v_f: 'ih',
    catface: 'catface', cat: 'catface', smirk: 'catface',
    rest: null, smile: null, pursed: null, frown: null, smileBig: null,
  };
  function setMouth(name) {
    const em = vrm.expressionManager;
    if (!em) return;
    // While the catface expression is locked, swallow viseme writes so
    // speech doesn't replace the :3 mouth shape mid-hold.
    if (isCatfaceLocked() && name !== 'catface' && name !== 'cat' && name !== 'smirk') {
      return;
    }
    ['aa','ih','ou','ee','oh','catface'].forEach(k => em.setValue(k, 0));
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
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.src = ''; } catch (_) {}
      currentAudio = null;
    }
    setMouth('v_closed');
    const f = currentSpeakFinish; currentSpeakFinish = null;
    if (f) try { f(); } catch (_) {}
  }

  // Play a pre-rendered audio file (e.g. baked welcome / woah lines)
  // with the same mouth-flap viseme timer as live synth, so the static
  // WAVs don't look mute. Returns a Promise that resolves when audio
  // ends (or fails).
  function playClip(url, opts) {
    opts = opts || {};
    // Preempt any in-flight speech the same way speak() does.
    if (currentAudio) {
      try {
        currentAudio.onerror = null;
        currentAudio.onended = null;
        currentAudio.pause();
        currentAudio.src = '';
      } catch (_) {}
      currentAudio = null;
    }
    if (window.speechSynthesis) try { window.speechSynthesis.cancel(); } catch (_) {}
    if (currentSpeakFinish) {
      const prev = currentSpeakFinish; currentSpeakFinish = null;
      try { prev(); } catch (_) {}
    }
    return new Promise((resolve) => {
      const audio = new Audio(url);
      audio.volume       = opts.volume       != null ? opts.volume       : 1.0;
      audio.playbackRate = opts.playbackRate != null ? opts.playbackRate : 1.0;
      currentAudio = audio;
      const visemeTimer = setInterval(() => {
        if (audio.paused || audio.ended) return;
        setMouth(Math.random() < 0.5 ? 'v_e' : 'v_a');
      }, 140);
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearInterval(visemeTimer);
        setMouth('v_closed');
        if (currentAudio === audio) currentAudio = null;
        if (currentSpeakFinish === finish) currentSpeakFinish = null;
        resolve();
      };
      currentSpeakFinish = finish;
      audio.onended = finish;
      audio.onerror = (e) => {
        const err = audio.error;
        console.warn('[clip] audio error code=', err?.code, 'src=', url);
        finish();
      };
      audio.play().catch((e) => {
        console.warn('[clip] play() rejected:', e?.message);
        finish();
      });
    });
  }

  // ---- Neural TTS (Kokoro) detection (cached) ----
  let _ttsKnownAvailable = null;  // null=unknown, true/false=cached
  async function ttsAvailable() {
    if (_ttsKnownAvailable !== null) return _ttsKnownAvailable;
    if (!window.cs?.ttsAvailable) return (_ttsKnownAvailable = false);
    try { _ttsKnownAvailable = !!(await window.cs.ttsAvailable()); }
    catch (_) { _ttsKnownAvailable = false; }
    return _ttsKnownAvailable;
  }

  let currentAudio = null;
  function speak(text, opts) {
    opts = opts || {};
    // PREEMPT: a new speak call always cuts off any prior in-flight
    // speech. Prevents woah-loop overlapping with the regular queue,
    // and prevents two responses talking at once if hooks fire fast.
    if (currentAudio) {
      try {
        // Silence the prior element's error handler — we're about to
        // nuke its src, which fires an error event we don't care
        // about (it's just our intentional preempt).
        currentAudio.onerror = null;
        currentAudio.onended = null;
        currentAudio.pause();
        currentAudio.src = '';
      } catch (_) {}
      currentAudio = null;
    }
    if (window.speechSynthesis) try { window.speechSynthesis.cancel(); } catch (_) {}
    if (currentSpeakFinish) {
      const prev = currentSpeakFinish;
      currentSpeakFinish = null;
      try { prev(); } catch (_) {}
    }
    stopRequested = false;
    return new Promise(async (resolve) => {
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
      if (opts.muted) return finish();

      const gender = (opts.voicePrefs && opts.voicePrefs.gender) || 'male';

      // Try the neural TTS first.
      if (await ttsAvailable()) {
        try {
          const dataUrl = await window.cs.ttsSynth(text, gender);
          if (stopRequested || currentSpeakFinish !== finish) return finish();
          if (dataUrl) {
            const audio = new Audio(dataUrl);
            audio.playbackRate = opts.rate != null ? opts.rate : 1.0;
            audio.volume       = opts.volume != null ? opts.volume : 1.0;
            currentAudio = audio;
            // Crude visemes — toggle the mouth at ~7Hz while audio plays.
            const visemeTimer = setInterval(() => {
              if (audio.paused || audio.ended) return;
              setMouth(Math.random() < 0.5 ? 'v_e' : 'v_a');
            }, 140);
            const cleanup = () => {
              clearInterval(visemeTimer);
              if (currentAudio === audio) currentAudio = null;
              finish();
            };
            audio.onended = cleanup;
            audio.onerror = (e) => {
              const err = audio.error;
              console.warn('[tts] audio error code=', err?.code, 'msg=', err?.message,
                           'src len=', dataUrl.length);
              cleanup();
            };
            try {
              await audio.play();
              return;
            } catch (playErr) {
              console.warn('[tts] play() rejected — falling back to speechSynthesis:', playErr?.message);
              clearInterval(visemeTimer);
              if (currentAudio === audio) currentAudio = null;
              audio.onended = null; audio.onerror = null;
            }
          } else {
            console.warn('[tts] synth returned null, falling back');
          }
        } catch (e) {
          console.warn('[tts] failed, falling back:', e.message);
        }
      }

      // Fallback: browser SpeechSynthesis.
      if (!window.speechSynthesis) return finish();
      let utter;
      try { utter = new SpeechSynthesisUtterance(text); } catch (_) { return finish(); }
      const v = pickVoice(opts.voicePrefs || {});
      if (v) utter.voice = v;
      utter.rate   = opts.rate   != null ? opts.rate   : 0.96;
      utter.pitch  = opts.pitch  != null ? opts.pitch  : 1.04;
      utter.volume = opts.volume != null ? opts.volume : 1.0;
      utter.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        setMouth('v_e');
        setTimeout(() => setMouth('v_closed'), 120);
      };
      utter.onend = utter.onerror = finish;
      try { window.speechSynthesis.speak(utter); } catch (_) { return finish(); }
      currentUtterance = utter;
    });
  }

  // Per-emotion tail wag profiles. ampY = peak Y-axis (side-to-side)
  // amplitude in radians, freq = Hz, ampX = peak X-axis (up-down)
  // bias for tail droop/perk. Spring bones smear and propagate this
  // through the rest of the chain naturally.
  const TAIL_PROFILES = {
    happy:     { ampY: 0.45, freq: 1.8, ampX:  0.10 },
    catface:   { ampY: 0.25, freq: 0.6, ampX:  0.05 },
    surprised: { ampY: 0.05, freq: 0.4, ampX:  0.20 }, // puffed up, mostly still
    sad:       { ampY: 0.08, freq: 0.5, ampX: -0.25 }, // tucked low
    angry:     { ampY: 0.55, freq: 2.6, ampX: -0.05 }, // sharp lashing
    neutral:   { ampY: 0.10, freq: 0.6, ampX:  0.00 }, // gentle idle sway
  };
  const _tailQ = new THREE.Quaternion();
  const _tailE = new THREE.Euler();
  function driveTail(nowMs) {
    if (!tailBase || !tailRestQ) return;
    const prof = TAIL_PROFILES[currentEmotion] || TAIL_PROFILES.neutral;
    const t = nowMs / 1000;
    const phase = t * prof.freq * 2 * Math.PI;
    const yaw   = Math.sin(phase) * prof.ampY;
    const pitch = prof.ampX;
    _tailE.set(pitch, yaw, 0, 'YXZ');
    _tailQ.setFromEuler(_tailE);
    // Compose the wag onto the rest pose so we don't drift.
    tailBase.quaternion.copy(tailRestQ).multiply(_tailQ);
  }

  // --- idle + per-frame update ---
  let idleStarted = false;
  const t0 = performance.now();
  let lastBlinkMs = t0;
  // ---- debug screenshot pipeline ----
  // While dragging, snap the canvas every N frames and ship it via IPC
  // to main, which writes it to %TEMP%/claude-says-debug/. Lets the
  // developer see ragdoll behavior they can't otherwise observe.
  let _dbgFrame = 0;
  function saveDebugFrameMaybe() {
    if (!dragging && !ikLeftHandTarget) return;
    if (_dbgFrame++ % 12 !== 0) return;       // ~5 Hz at 60fps
    if (!window.cs?.saveDebugFrame) return;
    try {
      const url = renderer.domElement.toDataURL('image/png');
      window.cs.saveDebugFrame('drag_' + String(_dbgFrame).padStart(4, '0'), url);
    } catch (_) {}
  }

  function tick(now) {
    // Random idle blink — morph-target only, doesn't touch bones, so it
    // can't disturb the authored standing pose.
    if (!isBlinking && now - lastBlinkMs > 2500 && Math.random() < 0.005) {
      triggerBlink();
      lastBlinkMs = now;
    }
    updateRagdoll(1/60);
    // Mixer is gated during drag — physics owns bones in that mode and
    // a stale action shouldn't compete. Drain the clock anyway so the
    // next mixer.update doesn't see a giant accumulated delta.
    if (dragging) {
      animClock.getDelta();
    } else {
      animMixer.update(animClock.getDelta());
    }
    if (vrm.expressionManager) vrm.expressionManager.update();
    // Per-emotion tail wag. Rotate tailbase before vrm.update so the
    // spring-bone sim sees the new root orientation and propagates the
    // motion down the chain. Different emotions get different wag
    // amplitudes / frequencies so the tail reads the mood.
    driveTail(now);
    // Run three-vrm's full update every frame, including during drag.
    // Tail spring bones are now driven by Hips translation (which our
    // ragdoll updates from the spine body's head position); their sim
    // doesn't fight my code anymore because tail isn't in the ragdoll.
    if (vrm.update) vrm.update(1/60);
    // Apply IK AFTER vrm.update so it's the last writer to arm bones.
    // GRAB: blend snaps to 1 — IK takes over the arm immediately so
    //       the hand doesn't stay glued to the animation pose.
    // RELEASE: blend eases from 1 back to 0 over a few frames, slerping
    //          the arm from its IK pose back to the current animation
    //          pose. We keep applying IK against the LAST known target
    //          while blend > 0.
    {
      if (ikLeftHandTarget)  ikBlendL = 1;
      else                   ikBlendL += (0 - ikBlendL) * IK_BLEND_RATE;
      if (ikRightHandTarget) ikBlendR = 1;
      else                   ikBlendR += (0 - ikBlendR) * IK_BLEND_RATE;
      if (ikBlendL < 0.001) { ikBlendL = 0; ikLastTargetL = null; }
      if (ikBlendR < 0.001) { ikBlendR = 0; ikLastTargetR = null; }
      if (ikBlendL > 0 && ikLastTargetL) applyArmIK(leftArmIK,  ikLastTargetL,  1, ikBlendL);
      if (ikBlendR > 0 && ikLastTargetR) applyArmIK(rightArmIK, ikLastTargetR, -1, ikBlendR);
    }
    // Anti-clip pass: keep the mane out of the chest/shoulders. Runs
    // AFTER vrm.update so corrections land on raw bones we render.
    if (animSuppressIK && currentAnimAction) {
      limitHeadBow();
      clampHeadAboveBody();
    }
    renderer.render(scene, camera);
    saveDebugFrameMaybe();
    requestAnimationFrame(tick);
  }
  function startIdle() {
    if (idleStarted) return;
    idleStarted = true;
    requestAnimationFrame(tick);
  }

  // ---- developer auto-drag test ----
  // Set window.AUTO_DRAG_TEST = true (or pass --auto-drag CLI flag) and
  // we'll run a programmatic shake sequence when the page opens. Frames
  // get saved to %TEMP%/claude-says-debug/ via the saveDebugFrame IPC.
  // STRESS-TEST drag pattern: 8s of rapid back-and-forth at varied
  // periods + amplitudes, including a violent fast burst, to surface
  // tumbling-glitch instability if it still exists.
  window.runAutoDragTest = async function runAutoDragTest() {
    console.log('[auto-drag-stress] starting');
    setDragging(true);
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {
      const t = (performance.now() - t0) / 1000;  // seconds
      // Period ramps from 250ms → 80ms → 250ms (mid-test fast burst)
      const period = (t < 3) ? 250 : (t < 5) ? 80 : 250;
      const amp    = (t < 3) ? 200 : (t < 5) ? 400 : 200;
      const dx = Math.sin((t * 1000) / period * Math.PI * 2) * amp;
      const dy = Math.sin((t * 1000) / period * Math.PI * 2 + 1.0) * (amp * 0.4);
      setDragVelocity(dx, dy);
      await new Promise(r => requestAnimationFrame(r));
    }
    setDragging(false);
    console.log('[auto-drag] released');
    await new Promise(r => setTimeout(r, 1000));
    console.log('[auto-drag] done');
  };
  // Auto-drag-test available via window.runAutoDragTest() in devtools.
  //   setTimeout(() => window.runAutoDragTest(), 1500);

  // IK auto-test: orbits the left hand target around the shoulder for
  // 6s so we can verify the 2-bone IK visually. Saves frames the same
  // way the drag test does.
  window.runAutoIKTest = async function runAutoIKTest() {
    if (!leftArmIK) { console.warn('[ik-test] no IK data'); return; }
    console.log('[ik-test] starting');
    const S = new THREE.Vector3(); leftArmIK.upper.getWorldPosition(S);
    const radius = (leftArmIK.L1 + leftArmIK.L2) * 0.85;
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      const t = (performance.now() - t0) / 1000;
      const angle = t * Math.PI;
      const tx = S.x + radius * Math.cos(angle);
      const ty = S.y + radius * Math.sin(angle);
      setLeftHandIKTarget(new THREE.Vector3(tx, ty, S.z));
      await new Promise(r => requestAnimationFrame(r));
    }
    clearLeftHandIKTarget();
    console.log('[ik-test] done');
  };
  // Disabled on auto-load — call window.runAutoIKTest() in devtools to verify.
  //   setTimeout(() => window.runAutoIKTest(), 1500);

  // Combined ragdoll + hand IK test: grab the hand and drag it through a
  // path while the body ragdolls underneath. Frames saved to debug folder.
  window.runAutoHandGrabTest = async function runAutoHandGrabTest() {
    if (!leftArmIK) { console.warn('[hand-grab-test] no IK data'); return; }
    console.log('[hand-grab-test] starting');
    setDragging(true);  // builds ragdoll + enables debug-frame saves
    const S = new THREE.Vector3(); leftArmIK.upper.getWorldPosition(S);
    const reach = leftArmIK.L1 + leftArmIK.L2;

    // Path: a figure-eight sweeping across both sides + above + below
    // the shoulder, clamped to within reach.
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      const t = (performance.now() - t0) / 1000;
      const ax = Math.sin(t * Math.PI) * reach * 0.7;
      const ay = Math.sin(t * 2 * Math.PI) * reach * 0.5;
      setLeftHandIKTarget(new THREE.Vector3(S.x + ax, S.y + ay, S.z));
      await new Promise(r => requestAnimationFrame(r));
    }
    clearLeftHandIKTarget();
    setDragging(false);
    console.log('[hand-grab-test] done');
  };
  // ----- Pull-up specific test: simulate cursor going straight UP from
  // the left hand for 4 seconds, capturing frames. Lets me verify
  // visually whether the arm rotates upward as expected.
  window.runAutoPullUpTest = async function runAutoPullUpTest() {
    if (!leftArmIK) { console.warn('[pull-up] no IK data'); return; }
    console.log('[pull-up] starting');
    setDragging(true);
    const handStart = new THREE.Vector3();
    leftArmIK.hand.getWorldPosition(handStart);
    const reach = leftArmIK.L1 + leftArmIK.L2;
    // Move target upward over 4s, stopping just past full reach above shoulder.
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      const t = (performance.now() - t0) / 4000;  // 0..1
      const dy = t * reach * 1.2;                 // 0 .. 1.2 * reach
      setLeftHandIKTarget(new THREE.Vector3(
        handStart.x,
        handStart.y + dy,
        handStart.z,
      ));
      await new Promise(r => requestAnimationFrame(r));
    }
    clearLeftHandIKTarget();
    setDragging(false);
    console.log('[pull-up] done');
  };
  // Disabled on auto-load — call window.runAutoPullUpTest() in devtools.
  //   setTimeout(() => window.runAutoPullUpTest(), 1500);

  // --- assembly intro disabled: the authored pose is what we render. ---
  async function assemble() { return; }

  function setDragging(on) {
    on = !!on;
    if (on === dragging) return;
    dragging = on;
    if (on) {
      animSuppressIK = false;
      if (vrm.humanoid) vrm.humanoid.autoUpdateHumanBones = false;
      buildRagdoll();
    } else {
      teardownRagdoll();
      pendingDragDx = 0;
      pendingDragDy = 0;
      if (vrm.humanoid && currentAnimAction) {
        vrm.humanoid.autoUpdateHumanBones = true;
      }
    }
  }
  // Called from app.js while dragging — pass screen-pixel deltas since
  // the last call. Accumulates; tick() consumes it once per frame.
  function setDragVelocity(dx, dy) {
    pendingDragDx += dx || 0;
    pendingDragDy += dy || 0;
  }

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
    blink: triggerBlink,
    startIdle,
    assemble,
    speak,
    stopSpeaking,
    playClip,
    setDragging,
    setDragVelocity,
    setLeftHandIKTarget,
    setRightHandIKTarget,
    clearLeftHandIKTarget,
    clearRightHandIKTarget,
    clearHandIKTargets,
    isLeftHandHit,
    whichHandHit,
    cursorToHandTargetWorld,
    isCharacterPixel,
    loadAnimation,
    playAnimation,
    stopAnimation,
    get currentEmotion() { return currentEmotion; },
  };
}
