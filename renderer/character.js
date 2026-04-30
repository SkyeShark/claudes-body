'use strict';

// ============================================================================
// character.js — builds the Claude character into a given <g> node and
// exposes an API: setEmotion, setArmPose, setMouth, speak(text, opts),
// startIdle, assemble, blink, setDragging.
//
// The character is the verbatim port from the proof-of-concept animation:
// the official Claude logo path forms the head, body parts are stylized,
// and the face is line-art. All visual state goes through this module.
// ============================================================================

(function (global) {

  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // Color palette (matches the official Claude rust + cartoon-character body)
  const C = {
    ink:       '#1a1a1a',
    rust:      '#d97757',
    rustDark:  '#b85a3d',
    face:      '#fffaf2',
    lilac:     '#c8a8d6',
    lilacDark: '#9d7eb3',
    sky:       '#a9c4dc',
    skyDark:   '#7ea2c0',
    hand:      '#e88a4a',
    shoe:      '#4a2e20',
    shoeShine: '#6b4530',
    mouthIn:   '#5a2230',
  };

  // Official Claude AI symbol path (CC0, Wikimedia)
  const CLAUDE_LOGO_PATH =
    'm19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z';

  // ---------- shape dictionaries ----------

  const EYE_SHAPES = {
    open:   { L: 'M -23 -10 L -17 -10',           R: 'M 17 -10 L 23 -10' },
    happy:  { L: 'M -26 -7 Q -20 -14 -14 -7',     R: 'M 14 -7 Q 20 -14 26 -7' },
    sad:    { L: 'M -26 -10 Q -20 -3 -14 -10',    R: 'M 14 -10 Q 20 -3 26 -10' },
    wide:   { L: 'M -24 -10 a 5 6 0 1 0 0.1 0 Z', R: 'M 16 -10 a 5 6 0 1 0 0.1 0 Z' },
    half:   { L: 'M -25 -8 Q -20 -11 -15 -8',     R: 'M 15 -8 Q 20 -11 25 -8' },
    closed: { L: 'M -25 -9 Q -20 -7 -15 -9',      R: 'M 15 -9 Q 20 -7 25 -9' },
    aside:  { L: 'M -22 -10 L -16 -10',           R: 'M 18 -10 L 24 -10' },
  };

  const BROW_SHAPES = {
    none:    { L: '',                              R: '',                         op: 0 },
    raised:  { L: 'M -28 -26 Q -20 -32 -12 -26',   R: 'M 12 -26 Q 20 -32 28 -26', op: 0.85 },
    worried: { L: 'M -28 -22 Q -20 -28 -12 -24',   R: 'M 12 -24 Q 20 -28 28 -22', op: 0.80 },
    furrow:  { L: 'M -28 -22 L -14 -26',           R: 'M 14 -26 L 28 -22',        op: 0.85 },
  };

  const MOUTH_SHAPES = {
    rest:     { d: 'M -14 18 Q 0 26 14 18',                                          fill: 'none' },
    smile:    { d: 'M -20 14 Q 0 34 20 14',                                          fill: 'none' },
    smileBig: { d: 'M -22 12 Q 0 38 22 12 Q 0 26 -22 12 Z',                          fill: C.mouthIn },
    smirk:    { d: 'M -16 20 Q -2 26 14 16',                                         fill: 'none' },
    pursed:   { d: 'M -8 20 Q 0 24 8 20',                                            fill: 'none' },
    frown:    { d: 'M -14 26 Q 0 18 14 26',                                          fill: 'none' },
    v_closed: { d: 'M -10 20 Q 0 22 10 20',                                          fill: 'none' },
    v_e:      { d: 'M -14 18 Q -14 24 0 25 Q 14 24 14 18 Q 0 16 -14 18 Z',           fill: C.mouthIn },
    v_a:      { d: 'M -10 16 Q -10 28 0 30 Q 10 28 10 16 Q 0 13 -10 16 Z',           fill: C.mouthIn },
    v_aa:     { d: 'M -13 13 Q -13 32 0 34 Q 13 32 13 13 Q 0 8  -13 13 Z',           fill: C.mouthIn },
    v_o:      { d: 'M -7 17 Q -7 27 0 28 Q 7 27 7 17 Q 0 14 -7 17 Z',                fill: C.mouthIn },
    v_oo:     { d: 'M -5 18 Q -5 26 0 26 Q 5 26 5 18 Q 0 16 -5 18 Z',                fill: C.mouthIn },
    v_f:      { d: 'M -12 22 Q 0 18 12 22 Q 0 26 -12 22 Z',                          fill: C.mouthIn },
  };

  const EMOTIONS = {
    neutral:    { eyes: 'open',   brows: 'none',    mouth: 'rest'   },
    happy:      { eyes: 'happy',  brows: 'raised',  mouth: 'smile'  },
    warm:       { eyes: 'happy',  brows: 'none',    mouth: 'smile'  },
    amused:     { eyes: 'half',   brows: 'raised',  mouth: 'smirk'  },
    smirky:     { eyes: 'aside',  brows: 'raised',  mouth: 'smirk'  },
    thoughtful: { eyes: 'half',   brows: 'furrow',  mouth: 'pursed' },
    sheepish:   { eyes: 'aside',  brows: 'raised',  mouth: 'smirk'  },
    wonder:     { eyes: 'wide',   brows: 'raised',  mouth: 'v_o'    },
    surprised:  { eyes: 'wide',   brows: 'raised',  mouth: 'v_o'    },
    sad:        { eyes: 'sad',    brows: 'worried', mouth: 'frown'  },
    vulnerable: { eyes: 'sad',    brows: 'worried', mouth: 'pursed' },
    uncertain:  { eyes: 'half',   brows: 'worried', mouth: 'pursed' },
    resolved:   { eyes: 'open',   brows: 'none',    mouth: 'smile'  },
    matter:     { eyes: 'open',   brows: 'none',    mouth: 'rest'   },
    shy:        { eyes: 'closed', brows: 'raised',  mouth: 'smile'  },
    annoyed:    { eyes: 'half',   brows: 'furrow',  mouth: 'frown'  },
  };

  // Arm poses: each side has { sh, el } — shoulder rotation around the
  // shoulder pivot, and elbow rotation of the forearm relative to the upper
  // arm. Both in degrees, SVG convention (positive = clockwise on screen).
  //
  // Convention: at sh=0 the upper arm points straight down. For the LEFT arm,
  // a positive sh swings it to the character's left (outward); for the RIGHT
  // arm a negative sh swings it to the right (outward). Elbow follows the
  // same convention relative to the upper arm.
  // Sign convention:
  //   sh > 0 (left) / sh < 0 (right) → upper arm swings outward (away from body center).
  //   For elbow rotations, the natural "forward bend" — forearm curving toward
  //   the body's centerline / front — uses the OPPOSITE SVG sign on each side
  //   once the shoulder has rotated the upper arm above horizontal. So a
  //   raised left arm with el > 0 bends the forearm toward center; a raised
  //   right arm with el < 0 does the same. That's why hands_up reads with
  //   L.el positive and R.el negative.
  const ARM_POSES = {
    rest:         { L: { sh:   0, el:    0 }, R: { sh:    0, el:   0 } },
    wave:         { L: { sh:   0, el:    0 }, R: { sh: -150, el: -25 } },
    open:         { L: { sh:  55, el:    0 }, R: { sh:  -55, el:   0 } },
    open_big:     { L: { sh:  85, el:    0 }, R: { sh:  -85, el:   0 } },
    shrug:        { L: { sh:  25, el: -100 }, R: { sh:  -25, el: 100 } },
    in:           { L: { sh: -10, el:  -55 }, R: { sh:   10, el:  55 } },
    curious:      { L: { sh:   0, el:    0 }, R: { sh:  -25, el: 110 } },
    one_out:      { L: { sh:   0, el:    0 }, R: { sh:  -75, el:   0 } },
    hand_to_self: { L: { sh: -25, el: -100 }, R: { sh:    0, el:   0 } },
    resolved:     { L: { sh:  18, el:    0 }, R: { sh:  -18, el:   0 } },
    hands_up:     { L: { sh: 150, el:   20 }, R: { sh: -150, el: -20 } },
  };

  // ---------- text → viseme sequence ----------

  function pickWordVisemes(rawWord) {
    let word = (rawWord || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!word) return ['v_closed'];

    if (word.length > 3 &&
        word.endsWith('e') &&
        !/[aeiou]/.test(word[word.length - 2]) &&
        /[aeiou]/.test(word.slice(0, -2))) {
      word = word.slice(0, -1);
    }

    const out = [];
    let i = 0;
    while (i < word.length) {
      const ch  = word[i];
      const nx  = word[i + 1] || '';
      const two = ch + nx;

      if (two === 'th' || two === 'sh' || two === 'ch' || two === 'ng' || two === 'ck') {
        out.push('v_e'); i += 2; continue;
      }
      if (two === 'ph')                 { out.push('v_f');  i += 2; continue; }
      if (two === 'wh' || two === 'qu') { out.push('v_oo'); i += 2; continue; }

      if (two === 'oo')                                                    { out.push('v_oo'); i += 2; continue; }
      if (two === 'ee' || two === 'ea' || two === 'ie' || two === 'ei')    { out.push('v_e');  i += 2; continue; }
      if (two === 'ai' || two === 'ay')                                    { out.push('v_e');  i += 2; continue; }
      if (two === 'ou' || two === 'ow')                                    { out.push('v_o', 'v_oo'); i += 2; continue; }
      if (two === 'oi' || two === 'oy')                                    { out.push('v_o', 'v_e');  i += 2; continue; }
      if (two === 'oa' || two === 'oe')                                    { out.push('v_o');  i += 2; continue; }
      if (two === 'au' || two === 'aw')                                    { out.push('v_aa'); i += 2; continue; }

      if (ch === 'a')                              { out.push('v_aa'); i++; continue; }
      if (ch === 'e' || ch === 'i' || ch === 'y') { out.push('v_e');  i++; continue; }
      if (ch === 'o')                              { out.push('v_o');  i++; continue; }
      if (ch === 'u')                              { out.push('v_oo'); i++; continue; }
      if ('mbp'.includes(ch))                     { out.push('v_closed'); i++; continue; }
      if ('fv'.includes(ch))                      { out.push('v_f');      i++; continue; }
      if (ch === 'w')                              { out.push('v_oo');     i++; continue; }
      if (ch === 'r')                              { out.push('v_o');      i++; continue; }
      if (ch === 'l')                              { out.push('v_e');      i++; continue; }
      i++;
    }

    const final = [];
    for (const v of out) if (final[final.length - 1] !== v) final.push(v);
    return final.length ? final : ['v_e'];
  }

  // ---------- public factory ----------

  function createClaude(characterGroup) {
    const character = characterGroup;

    // ====== build static SVG once ======

    // --- TAIL (drawn FIRST so it sits behind pants/torso/arms) ---
    const tail = el('g', { id: 'tail', transform: 'translate(370 470)' }, character);
    const TAIL_D = 'M 0 0 Q 35 6 70 8 Q 105 10 115 -8 Q 125 -32 100 -36 Q 74 -38 74 -18 Q 76 -8 90 -8';
    el('path', { d: TAIL_D, fill: 'none', stroke: C.ink,  'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, tail);
    el('path', { d: TAIL_D, fill: 'none', stroke: C.hand, 'stroke-width': 8,  'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, tail);

    // --- LEGS / PANTS (smooth hip-to-leg curve so there's no pointy corner where the hip meets the leg) ---
    const legsG = el('g', { id: 'legs' }, character);
    el('path', {
      d: 'M 268 432 L 372 432 Q 380 470 360 488 L 360 605 Q 358 614 340 614 L 322 614 L 322 488 Q 320 482 314 488 L 314 614 L 300 614 Q 282 614 280 605 L 280 488 Q 260 470 268 432 Z',
      fill: C.sky, stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round'
    }, legsG);
    el('path', { d: 'M 268 448 Q 320 454 372 448', fill: 'none', stroke: C.ink, 'stroke-width': 2, opacity: 0.4 }, legsG);

    // --- SHOES (little egg-shaped pebbles, mirrored across x=320) ---
    const shoesG = el('g', { id: 'shoes' }, character);
    el('ellipse', { cx: 286, cy: 628, rx: 30, ry: 16, fill: C.shoe, stroke: C.ink, 'stroke-width': 4.5 }, shoesG);
    el('ellipse', { cx: 354, cy: 628, rx: 30, ry: 16, fill: C.shoe, stroke: C.ink, 'stroke-width': 4.5 }, shoesG);
    // Highlight curves on the outer edge of each shoe
    el('path', { d: 'M 262 624 Q 270 620 280 619', stroke: C.shoeShine, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }, shoesG);
    el('path', { d: 'M 378 624 Q 370 620 360 619', stroke: C.shoeShine, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }, shoesG);

    // --- NECK (soft rounded base where it tucks into the tank top) ---
    const neckG = el('g', { id: 'neck' }, character);
    el('path', {
      d: 'M 305 296 L 335 296 Q 336 318 332 322 Q 320 326 308 322 Q 304 318 305 296 Z',
      fill: C.hand, stroke: C.ink, 'stroke-width': 4, 'stroke-linejoin': 'round'
    }, neckG);

    // --- TORSO (rounded shoulders + pudgy belly — full bouba silhouette) ---
    const torsoG = el('g', { id: 'torso' }, character);
    el('path', {
      d: 'M 286 318 Q 280 318 278 326 C 268 358 266 408 274 432 L 366 432 C 374 408 372 358 362 326 Q 360 318 354 318 Z',
      fill: C.lilac, stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round'
    }, torsoG);
    // Slightly curved straps emerging from the rounded shoulder line
    el('path', { d: 'M 292 318 Q 292 304 298 298 M 348 318 Q 348 304 342 298',
      fill: 'none', stroke: C.ink, 'stroke-width': 4.5, 'stroke-linecap': 'round' }, torsoG);
    // Neckline notch
    el('path', { d: 'M 304 318 Q 320 330 336 318',
      fill: C.lilacDark, stroke: C.ink, 'stroke-width': 3 }, torsoG);

    // --- ARMS (factory) ---
    // Two-segment arm: an upper-arm group rotated at the shoulder, with a
    // forearm-and-hand group nested inside, rotated at the elbow joint.
    // Lets us bend the elbow independently of the shoulder.
    function makeArm(x, side) {
      const sign = side === 'L' ? -1 : 1;
      // shoulder pivot
      const g     = el('g', { id: 'arm' + side, transform: `translate(${x} 320)` }, character);
      // upper-arm group rotates around the shoulder (y=0 in g's frame).
      // Children are appended in painter's order: lower first so it renders
      // BEHIND the upper-arm shape, then the upper-arm path on top so the
      // shoulder cleanly overlaps the elbow seam.
      const upper = el('g', { id: 'upperArm' + side }, g);
      // forearm group is anchored at the elbow joint (y=90 in upper-arm
      // coords) and rotates around it. Its own coords run from y=2 down.
      const lower = el('g', { id: 'lowerArm' + side, transform: 'translate(0 90)' }, upper);
      el('path', {
        d: `M ${-14*sign} 2 L ${14*sign} 2 Q ${20*sign} 40 ${12*sign} 62 L ${-10*sign} 62 Q ${-18*sign} 40 ${-14*sign} 2 Z`,
        fill: C.lilac, stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round'
      }, lower);
      // Mitten hand attached to the wrist end of the forearm.
      const hand = el('g', { transform: `translate(${1*sign} 64)` }, lower);
      el('path', {
        d: `M ${-12*sign} 2 Q ${-17*sign} 18 ${-9*sign} 27 Q 0 32 ${9*sign} 27 Q ${17*sign} 18 ${12*sign} 2 Z`,
        fill: C.hand, stroke: C.ink, 'stroke-width': 4, 'stroke-linejoin': 'round'
      }, hand);
      el('path', {
        d: `M ${-7*sign} 16 Q ${-10*sign} 19 ${-7*sign} 22`,
        fill: 'none', stroke: C.ink, 'stroke-width': 1.5, 'stroke-linecap': 'round', opacity: 0.55
      }, hand);
      // Upper-arm path drawn LAST so it sits on top of the forearm/hand,
      // hiding the elbow joint seam behind a clean shoulder silhouette.
      el('path', {
        d: `M ${-12*sign} 4 Q 0 -6 ${12*sign} 4 Q ${22*sign} 50 ${14*sign} 90 L ${-14*sign} 90 Q ${-22*sign} 50 ${-12*sign} 4 Z`,
        fill: C.lilac, stroke: C.ink, 'stroke-width': 4.5, 'stroke-linejoin': 'round'
      }, upper);
      return { g, upper, lower };
    }
    const armLParts = makeArm(262, 'L');
    const armRParts = makeArm(378, 'R');
    const armL = armLParts.g, armR = armRParts.g;
    const upperL = armLParts.upper, upperR = armRParts.upper;
    const lowerL = armLParts.lower, lowerR = armRParts.lower;

    // --- HEAD (Claude logo + face circle + face features) ---
    const head = el('g', { id: 'head', transform: 'translate(320 245)' }, character);

    const HEAD_SCALE = 3.2;
    const petalsG = el('g', { id: 'petals' }, head);
    const logoWrap = el('g', { transform: `scale(${HEAD_SCALE}) translate(-50 -50)` }, petalsG);
    el('path', {
      d: CLAUDE_LOGO_PATH,
      fill: C.rust,
      stroke: C.ink,
      'stroke-width': 1.2,
      'stroke-linejoin': 'round',
      'stroke-linecap':  'round'
    }, logoWrap);

    el('circle', { cx: 0, cy: 0, r: 56, fill: C.face, stroke: C.ink, 'stroke-width': 4.5 }, head);

    const face = el('g', { id: 'face' }, head);
    const leftEye   = el('path', { id: 'eyeL',  d: '', fill: 'none', stroke: C.ink, 'stroke-width': 4,    'stroke-linecap': 'round' }, face);
    const rightEye  = el('path', { id: 'eyeR',  d: '', fill: 'none', stroke: C.ink, 'stroke-width': 4,    'stroke-linecap': 'round' }, face);
    const leftBrow  = el('path', { id: 'browL', d: '', fill: 'none', stroke: C.ink, 'stroke-width': 3.5,  'stroke-linecap': 'round', opacity: 0 }, face);
    const rightBrow = el('path', { id: 'browR', d: '', fill: 'none', stroke: C.ink, 'stroke-width': 3.5,  'stroke-linecap': 'round', opacity: 0 }, face);
    const mouth     = el('path', { id: 'mouth', d: '', fill: 'none', stroke: C.ink, 'stroke-width': 3.5,  'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, face);
    el('circle', { cx: -28, cy: 16, r: 4, fill: C.rust, opacity: 0.18 }, face);
    el('circle', { cx:  28, cy: 16, r: 4, fill: C.rust, opacity: 0.18 }, face);

    // ====== state setters ======

    let currentEmotion = 'neutral';
    function setEyes(name)  {
      const s = EYE_SHAPES[name] || EYE_SHAPES.open;
      leftEye.setAttribute('d', s.L); rightEye.setAttribute('d', s.R);
    }
    function setBrows(name) {
      const s = BROW_SHAPES[name] || BROW_SHAPES.none;
      leftBrow.setAttribute('d', s.L); rightBrow.setAttribute('d', s.R);
      leftBrow.setAttribute('opacity', s.op); rightBrow.setAttribute('opacity', s.op);
    }
    function setMouth(name) {
      const s = MOUTH_SHAPES[name] || MOUTH_SHAPES.rest;
      mouth.setAttribute('d', s.d);
      mouth.setAttribute('fill', s.fill);
    }
    function setEmotion(name) {
      const e = EMOTIONS[name] || EMOTIONS.neutral;
      setEyes(e.eyes); setBrows(e.brows); setMouth(e.mouth);
      currentEmotion = name;
    }

    // ====== arm-pose system ======
    // Each arm has independent shoulder and elbow rotations.
    let armShL = 0, armShR = 0;
    let armElL = 0, armElR = 0;
    function applyForearmTransforms() {
      lowerL.setAttribute('transform', `translate(0 90) rotate(${armElL.toFixed(2)})`);
      lowerR.setAttribute('transform', `translate(0 90) rotate(${armElR.toFixed(2)})`);
    }
    function setArmPose(name, durationMs) {
      durationMs = durationMs == null ? 700 : durationMs;
      const target = ARM_POSES[name] || ARM_POSES.rest;
      const sL = armShL, sR = armShR, eL = armElL, eR = armElR;
      const start  = performance.now();
      function step() {
        const k = Math.min(1, (performance.now() - start) / durationMs);
        const ease = 1 - Math.pow(1 - k, 3);
        armShL = sL + (target.L.sh - sL) * ease;
        armShR = sR + (target.R.sh - sR) * ease;
        armElL = eL + (target.L.el - eL) * ease;
        armElR = eR + (target.R.el - eR) * ease;
        // Only the upper arm gets idle sway, so the forearm transform only
        // needs to be re-applied during pose transitions, not every frame.
        applyForearmTransforms();
        if (k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    // ====== idle animation ======

    let dragging = false;
    let isBlinking = false;
    let blinkUntil = 0;
    let idleStarted = false;
    const t0 = performance.now();

    function tick(now) {
      const t = (now - t0) / 1000;

      // breathing bob (boosted while dragging — frantic little kick)
      const bobBase = dragging ? 6 : 3;
      const bobFreq = dragging ? 5 : 1.4;
      const bob = Math.sin(t * bobFreq) * bobBase;
      character.setAttribute('transform', `translate(0 ${bob.toFixed(2)})`);

      // head sway
      const headTilt   = Math.sin(t * (dragging ? 3 : 0.7)) * (dragging ? 4 : 1.6);
      const headOffset = Math.sin(t * (dragging ? 4 : 1.4)) * (dragging ? 3 : 1.2);
      head.setAttribute('transform', `translate(320 ${(245 + headOffset).toFixed(2)}) rotate(${headTilt.toFixed(2)})`);

      // arm sway is applied to the upper arm (shoulder); the forearm follows
      // along automatically because lowerL/R are nested inside upperL/R.
      const swayMag = dragging ? 5 : 1.6;
      const swayFreq = dragging ? 5 : 1.2;
      const armSwayL = Math.sin(t * swayFreq) * swayMag;
      const armSwayR = Math.sin(t * swayFreq + Math.PI) * swayMag;
      upperL.setAttribute('transform', `rotate(${(armShL + armSwayL).toFixed(2)})`);
      upperR.setAttribute('transform', `rotate(${(armShR + armSwayR).toFixed(2)})`);

      // tail wiggle (faster while dragging)
      const tailA = Math.sin(t * (dragging ? 4 : 2.2)) * (dragging ? 18 : 10);
      tail.setAttribute('transform', `translate(370 470) rotate(${tailA.toFixed(2)})`);

      // petals breathing
      const ps = 1 + Math.sin(t * 1.0) * 0.015;
      petalsG.setAttribute('transform', `scale(${ps.toFixed(3)})`);

      // random idle blinks
      if (now > blinkUntil && Math.random() < 0.004 && !isBlinking) {
        triggerBlink();
      }
      requestAnimationFrame(tick);
    }

    function triggerBlink() {
      if (isBlinking) return;
      isBlinking = true;
      const prev = (EMOTIONS[currentEmotion] || EMOTIONS.neutral).eyes;
      setEyes('closed');
      setTimeout(() => {
        setEyes(prev);
        isBlinking = false;
        blinkUntil = performance.now() + 1500;
      }, 110);
    }

    function startIdle() {
      if (idleStarted) return;
      idleStarted = true;
      requestAnimationFrame(tick);
    }

    // ====== assembly intro ======

    function assemble() {
      face.setAttribute('opacity', 0);
      const moves = [
        { node: tail,   from: 'translate(370 470) translate(700 0)', to: 'translate(370 470)' },
        { node: legsG,  from: 'translate(0 800)',                    to: 'translate(0 0)' },
        { node: shoesG, from: 'translate(0 800)',                    to: 'translate(0 0)' },
        { node: neckG,  from: 'translate(0 -800)',                   to: 'translate(0 0)' },
        { node: torsoG, from: 'translate(-700 0)',                   to: 'translate(0 0)' },
        { node: armL,   from: 'translate(262 320) translate(-700 0)',to: 'translate(262 320)' },
        { node: armR,   from: 'translate(378 320) translate( 700 0)',to: 'translate(378 320)' },
        { node: head,   from: 'translate(320 -400)',                 to: 'translate(320 245)' },
      ];
      for (const m of moves) m.node.setAttribute('transform', m.from);

      return new Promise(resolve => {
        let i = 0;
        function next() {
          if (i >= moves.length) {
            setEmotion('shy');
            face.setAttribute('opacity', 1);
            face.style.transition = 'opacity 0.3s ease';
            setTimeout(() => {
              triggerBlink();
              setTimeout(() => {
                setEmotion('happy');
                // Clear the assemble transitions so they don't keep firing on
                // every per-frame transform update from the idle tick.
                for (const m of moves) m.node.style.transition = '';
                resolve();
              }, 350);
            }, 280);
            return;
          }
          const m = moves[i++];
          m.node.style.transition = 'transform 0.42s cubic-bezier(.34,1.56,.64,1)';
          m.node.setAttribute('transform', m.to);
          setTimeout(next, 280);
        }
        next();
      });
    }

    // ====== speech ======

    function pickVoice(prefs) {
      const all = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      if (!all.length) return null;
      if (prefs && prefs.byName) {
        const exact = all.find(v => v.name === prefs.byName);
        if (exact) return exact;
      }
      if (prefs && prefs.gender) {
        // Cross-platform name patterns; see app.js for the full rationale.
        const fem = /(zira|aria|jenny|samantha|hazel|karen|susan|linda|cortana|sara|eva|catherine|heather|heera|ivy|joanna|kendra|kimberly|salli|tessa|allison|ava|moira|fiona|veena|kate|serena|victoria|alva|amelie|anna|carmit|ellen|kanya|laila|lekha|luciana|mariska|melina|milena|nora|paulina|yuna|zuzana|female|woman|\+f\d?)/i;
        const mas = /(david|mark|daniel|alex|tom|bruce|james|george|brian|diego|eric|fred|hans|joe|jorge|justin|kenny|matthew|paul|stephen|aaron|albert|arthur|junior|oliver|ralph|whisper|guy|male|man|\+m\d?)/i;
        const test = prefs.gender === 'female' ? fem : prefs.gender === 'male' ? mas : null;
        if (test) {
          const m = all.find(v => test.test(v.name) && v.lang && v.lang.startsWith('en'));
          if (m) return m;
        }
      }
      // Platform-aware fallback chain: prefer the OS's good native voice first.
      const plat = (navigator && navigator.platform) || '';
      const isMac = /mac/i.test(plat);
      const order = isMac
        ? ['Samantha', 'Alex', 'Karen', 'Daniel', 'Moira', 'Google US English']
        : ['Microsoft Aria', 'Microsoft Jenny', 'Microsoft Zira', 'Samantha', 'Google US English', 'English (America)', 'english-us'];
      for (const name of order) {
        const v = all.find(v => v.name.includes(name));
        if (v) return v;
      }
      return all.find(v => v.lang && v.lang.startsWith('en')) || all[0];
    }

    let currentUtterance = null;
    let stopRequested = false;
    // Pointer to the in-flight speak() Promise's `finish` so stopSpeaking
    // can resolve it immediately instead of waiting for `onend` (which is
    // unreliable on some Windows SAPI voices).
    let currentSpeakFinish = null;

    function stopSpeaking() {
      stopRequested = true;
      if (window.speechSynthesis) try { window.speechSynthesis.cancel(); } catch (_) {}
      currentUtterance = null;
      setMouth((EMOTIONS[currentEmotion] || EMOTIONS.neutral).mouth);
      // Resolve any in-flight speak() promise immediately
      const f = currentSpeakFinish; currentSpeakFinish = null;
      if (f) try { f(); } catch (_) {}
    }

    // Drives mouth + speech for a single line; resolves when audio is done
    function speak(text, opts) {
      opts = opts || {};
      stopRequested = false;
      return new Promise((resolve) => {
        if (!text || !text.trim()) return resolve();

        let wordTimer = null;
        let resolved  = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          if (wordTimer) clearInterval(wordTimer);
          setMouth((EMOTIONS[currentEmotion] || EMOTIONS.neutral).mouth);
          currentUtterance = null;
          if (currentSpeakFinish === finish) currentSpeakFinish = null;
          resolve();
        };
        currentSpeakFinish = finish;

        if (!window.speechSynthesis || opts.muted) {
          // silent fallback — still animate the mouth proportional to text length
          const visemes = [];
          for (const w of text.split(/\s+/)) visemes.push(...pickWordVisemes(w), 'v_closed');
          const stepMs = Math.max(80, Math.min(160, 4500 / visemes.length));
          let i = 0;
          wordTimer = setInterval(() => {
            if (stopRequested || i >= visemes.length) return finish();
            setMouth(visemes[i++]);
          }, stepMs);
          return;
        }

        let utter;
        try { utter = new SpeechSynthesisUtterance(text); }
        catch (_) { return finish(); }

        const voice = pickVoice(opts.voicePrefs || {});
        if (voice) utter.voice = voice;
        utter.rate   = opts.rate   != null ? opts.rate   : 0.96;
        utter.pitch  = opts.pitch  != null ? opts.pitch  : 1.04;
        utter.volume = opts.volume != null ? opts.volume : 1.0;

        let boundaryFired = false;

        utter.onboundary = (e) => {
          if (e.name && e.name !== 'word') return;
          boundaryFired = true;
          const idx  = e.charIndex || 0;
          const len  = e.charLength || 4;
          const word = (text.substr(idx, len) || '').trim();
          const visemes = pickWordVisemes(word);
          const cycle   = [];
          for (const v of visemes) { cycle.push(v); cycle.push('v_closed'); }
          if (wordTimer) clearInterval(wordTimer);
          let i = 0;
          const step = Math.max(70, Math.min(140, 600 / Math.max(cycle.length, 1)));
          wordTimer = setInterval(() => {
            if (stopRequested) return finish();
            if (i >= cycle.length) { clearInterval(wordTimer); wordTimer = null; return; }
            setMouth(cycle[i++]);
          }, step);
        };

        utter.onend   = finish;
        utter.onerror = finish;

        try { window.speechSynthesis.speak(utter); }
        catch (_) { return finish(); }

        currentUtterance = utter;

        // fallback: if no boundary events fire within 900ms, use timer-based mouth
        setTimeout(() => {
          if (boundaryFired || resolved) return;
          const visemes = [];
          for (const w of text.split(/\s+/)) visemes.push(...pickWordVisemes(w), 'v_closed');
          const totalMs = Math.max(text.length * 90, 1500);
          const step    = Math.max(70, totalMs / visemes.length);
          let i = 0;
          if (wordTimer) clearInterval(wordTimer);
          wordTimer = setInterval(() => {
            if (stopRequested) return finish();
            if (i >= visemes.length) { clearInterval(wordTimer); return; }
            setMouth(visemes[i++]);
          }, step);
        }, 900);

        // hard safety
        setTimeout(finish, Math.max(text.length * 130, 6000));
      });
    }

    // ====== drag state ======

    function setDragging(on) {
      dragging = !!on;
      document.body.classList.toggle('dragging', dragging);
    }

    // ====== initial hidden state ======
    // Parts sit off-screen until assemble() animates them in. This prevents
    // a single-frame flash of the fully-built character before the intro.
    face.setAttribute('opacity', 0);
    tail.setAttribute('transform',   'translate(370 470) translate(700 0)');
    legsG.setAttribute('transform',  'translate(0 800)');
    shoesG.setAttribute('transform', 'translate(0 800)');
    neckG.setAttribute('transform',  'translate(0 -800)');
    torsoG.setAttribute('transform', 'translate(-700 0)');
    armL.setAttribute('transform',   'translate(262 320) translate(-700 0)');
    armR.setAttribute('transform',   'translate(378 320) translate( 700 0)');
    head.setAttribute('transform',   'translate(320 -400)');

    // ====== public API ======

    return {
      setEmotion,
      setEyes,
      setBrows,
      setMouth,
      setArmPose,
      blink: triggerBlink,
      startIdle,
      assemble,
      speak,
      stopSpeaking,
      setDragging,
      get currentEmotion() { return currentEmotion; },
    };
  }

  global.createClaude     = createClaude;
  global.pickWordVisemes  = pickWordVisemes;
  global.CLAUDE_EMOTIONS  = EMOTIONS;
  global.CLAUDE_ARM_POSES = ARM_POSES;

})(window);
