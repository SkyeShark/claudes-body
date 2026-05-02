'use strict';

// ============================================================================
// app.js — wires the character to: window drag, IPC `say` events,
// tone analysis, voice selection, queue, controls, settings persistence.
// ============================================================================

const $ = (id) => document.getElementById(id);

// ---------- character backend (SVG or VRM) ----------
// `claude` is assigned inside boot(), once we know which backend to spin up.
// User-facing event handlers reference it lazily, so this works as long as
// the user can't interact before assemble() resolves — which is the case,
// since the window is locked + invisible until assembly starts.
let claude;
async function makeBackend() {
  if (window.RENDERER === 'vrm' && window.ClaudeBackend && window.ClaudeBackend.createVrmClaude) {
    document.body.classList.add('renderer-vrm');
    return await window.ClaudeBackend.createVrmClaude($('vrm-stage'));
  }
  return createClaude($('character'));
}

// ---------- settings (persisted via main process) ----------
const DEFAULTS = {
  voiceMode: 'male',      // 'male' (Ryan) | 'female' (Amy)
  lengthCap: 200,         // 0 = no cap. shorter = less lag on long responses
  rate: 0.96,
  muted: false,
  locked: true,           // when true: clicks always pass through to desktop
  windowSize: 'medium',   // 'small' | 'medium' | 'large'
};
let settings = { ...DEFAULTS };

const SIZE_PRESETS = {
  small:  { w: 240, h: 280 },
  medium: { w: 360, h: 420 },
  large:  { w: 540, h: 630 },
};

async function loadSettings() {
  try {
    const stored = await window.cs.getState();
    if (stored && typeof stored === 'object') {
      settings = { ...DEFAULTS, ...stored };
    }
  } catch (_) {}
  // Always boot in locked mode regardless of last-saved state. Unlocking is
  // a per-session action via Ctrl+Shift+L (or the settings checkbox once
  // unlocked). This keeps the character passive by default — clicks pass
  // through to the desktop until the user explicitly grabs him.
  settings.locked = true;
  applySettingsToUI();
}
function persistSettings() {
  try { window.cs.setState(settings); } catch (_) {}
}

// cleanForSpeech / capLength / analyzeTone / TONE_RULES / ANIM_MIN_SCORE
// live in renderer/text-utils.js (loaded as a <script> before this file)
// so the unit-test suite can require() them from Node too.

// ---------- voice picker ----------
let voicesReady = false;
let voiceList   = [];

// Same gender heuristics used by the speak path in character.js — kept in sync.
// Names span Windows SAPI (Zira, Aria, David), macOS (Samantha, Alex, Karen,
// Moira, Fiona, Tessa, Veena), and a few common espeak/festival markers
// for Linux ("+f1", "english+f", "female"). Linux voice packs vary wildly so
// these heuristics will fail-soft to "first English voice" — users can still
// pick a specific voice from the dropdown.
const FEM_NAME_RE = /(zira|aria|jenny|samantha|hazel|karen|susan|linda|cortana|sara|eva|catherine|heather|heera|ivy|joanna|kendra|kimberly|salli|tessa|allison|ava|moira|fiona|veena|kate|serena|victoria|alva|amelie|anna|carmit|damayanti|ellen|kanya|laila|lekha|luciana|mariska|melina|milena|nora|paulina|sin-ji|yuna|zuzana|female|woman|\+f\d?|female1|female2)/i;
const MAS_NAME_RE = /(david|mark|daniel|alex|tom|bruce|james|george|brian|diego|eric|fred|hans|joe|jorge|justin|kenny|matthew|paul|stephen|aaron|albert|arthur|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|junior|oliver|organ|ralph|trinoids|whisper|zarvox|guy|male|\+m\d?|male1|male2)\b/i;

function refreshVoices() {
  if (!window.speechSynthesis) return;
  voiceList = window.speechSynthesis.getVoices() || [];
  voicesReady = voiceList.length > 0;
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = refreshVoices;
  refreshVoices();
}

function buildVoicePrefs() {
  // 'male' or 'female' — drives both Piper (which has dedicated Ryan
  // and Amy voices) and the speechSynthesis fallback (which name-
  // matches against gendered voice names).
  return { gender: settings.voiceMode === 'female' ? 'female' : 'male' };
}

// ---------- speak queue ----------
const queue = [];
let speaking = false;
let skipRequested = false;
let currentSpokenText = '';
// While the welcome line is playing, defer every other speech item so
// a Stop hook from another Claude Code project can't preempt it.
let welcomeBlocking = false;

async function processQueue() {
  if (welcomeBlocking) return;
  if (speaking) return;
  if (queue.length === 0) return;
  speaking = true;
  const item = queue.shift();
  await speakItem(item);
  speaking = false;
  // small breath between items
  setTimeout(processQueue, 220);
}

async function speakItem({ text }) {
  const cleaned = cleanForSpeech(text);
  const capped  = capLength(cleaned, Number(settings.lengthCap) || 0);
  if (!capped) return;

  currentSpokenText = capped;

  const tone = analyzeTone(capped);
  if (tone.emotion) claude.setEmotion(tone.emotion);
  if (tone.anim && tone.score >= ANIM_MIN_SCORE && claude.playAnimation) {
    claude.playAnimation(tone.anim);
  }

  await claude.speak(capped, {
    rate:       Number(settings.rate) || 0.96,
    voicePrefs: buildVoicePrefs(),
    muted:      settings.muted,
  });

  currentSpokenText = '';
}

// Cap pending speeches so a chatty session can't backlog us forever.
const QUEUE_MAX = 5;
function enqueue(payload) {
  if (!payload || !payload.text) return;
  // Skip if it's literally the same text already speaking.
  if (speaking && currentSpokenText === payload.text) return;
  // Multiple Claude Code sessions can pipe into the same Claude's Body.
  // Keep up to QUEUE_MAX pending lines so messages from different
  // projects don't kick each other out of the queue. Drop the oldest
  // when full so we don't fall further behind than that.
  if (queue.length >= QUEUE_MAX) queue.shift();
  queue.push({ text: payload.text });
  processQueue();
}

// ---------- IPC: receive lines from the Stop hook ----------
window.cs.onSay((payload) => enqueue(payload));

// User just sent a new message → drop the queue and cut current speech.
// Whatever the character was saying is now stale conversational context.
window.cs.onHush(() => {
  queue.length = 0;
  if (speaking) claude.stopSpeaking();
});

// ---------- click-through + lock + hover transparency ----------
// Default behaviour: only the painted character pixels (and controls) catch
// mouse events. Clicks anywhere else fall through to the desktop. When
// `locked` is on, every click falls through, but we still track hover so we
// can fade the character slightly to show the user knows where it is.
let ignoringMouse = false;
let hoveringChar  = false;

function setIgnore(state) {
  if (ignoringMouse === !!state) return;
  ignoringMouse = !!state;
  // forward: true keeps mousemove flowing to the renderer even while ignoring,
  // so we can keep hit-testing.
  window.cs.setIgnoreMouseEvents(ignoringMouse, { forward: ignoringMouse });
}

function hitTestPoint(x, y) {
  const elt = document.elementFromPoint(x, y);
  if (!elt) return null;
  if (elt.closest && elt.closest('#character')) return 'character';
  // VRM mode: the WebGL canvas covers the whole window; visiblePainted
  // alone treats every canvas pixel as "on the character", so we sample
  // the actual rendered alpha to distinguish painted body pixels from
  // transparent window space.
  if (elt.closest && elt.closest('#vrm-stage')) {
    return (claude && claude.isCharacterPixel && claude.isCharacterPixel(x, y))
      ? 'character'
      : null;
  }
  if (elt.closest && (elt.closest('#controls') || elt.closest('#settingsPanel'))) return 'controls';
  return null;
}

function setHovering(on) {
  if (hoveringChar === !!on) return;
  hoveringChar = !!on;
  document.body.classList.toggle('hovering', hoveringChar);
}

let lastHoverMoveAt = 0;
document.addEventListener('mousemove', (e) => {
  lastHoverMoveAt = performance.now();
  if (isDragging) {
    setIgnore(false);
    return;
  }
  const hit = hitTestPoint(e.clientX, e.clientY);
  // Keep the controls visible while the cursor is on them, not just while
  // it's on the character — otherwise they fade out the moment the user
  // tries to click an icon.
  setHovering(hit === 'character' || hit === 'controls');

  if (settings.locked) {
    // Lock mode: clicks always pass through, regardless of hit-test.
    setIgnore(true);
    return;
  }
  // Normal mode: catch clicks only on character or controls.
  setIgnore(!hit);
});

// When the cursor leaves the window's bounds entirely, no mousemove
// fires (especially in locked mode with click-through), so the
// 'hovering' class would stay on forever. Poll: if no mousemove for
// 200ms while we think we're hovering, drop hover state.
setInterval(() => {
  if (!hoveringChar) return;
  if (isDragging) return;
  if (performance.now() - lastHoverMoveAt > 200) setHovering(false);
}, 100);

function applyLockState() {
  document.body.classList.toggle('locked', !!settings.locked);
  // When locked, immediately switch to click-through. When unlocked, the
  // mousemove handler will pick up the right state on the next move.
  if (settings.locked) {
    setIgnore(true);
    // Close the settings panel — the gear icon that toggles it is in the
    // controls bar, which hides when locked, so leaving the panel open
    // would strand the user with no way to dismiss it.
    settingsPanel.classList.add('hidden');
  }
}

// Initial state: ignore everything until the first mousemove decides otherwise.
setIgnore(true);

// Global hotkey forwarded from main (Ctrl/Cmd+Shift+L)
window.cs.onToggleLock(() => {
  settings.locked = !settings.locked;
  persistSettings();
  applyLockState();
  // Reflect in the UI
  const lockBox = $('lockToggle');
  if (lockBox) lockBox.checked = settings.locked;
});

// ---------- manual drag implementation (so we can fire animations) ----------
let isDragging  = false;
let isHandDrag  = false;   // true if the drag originated by clicking the
                           // VRM character's left hand. In hand-drag mode
                           // the window stays put and IK pulls the hand
                           // to the cursor while the body ragdolls.
let dragOffset  = { x: 0, y: 0 };
let dragStartPos = null;
let preDragEmotion = 'neutral';

function isNoDragTarget(el) {
  while (el && el !== document.body) {
    if (el.classList && (el.classList.contains('no-drag') || el.tagName === 'BUTTON' ||
                         el.tagName === 'SELECT' || el.tagName === 'INPUT' ||
                         el.tagName === 'OPTION')) return true;
    el = el.parentNode;
  }
  return false;
}

// Track which hand was grabbed so we update the right IK target on move
// and clear the right one on release. null = no hand-grab (window drag).
let handDragSide = null;
// Hand-drag IK projects the cursor's window-relative position onto the
// hand's depth plane each mousemove (`cursorToHandTargetWorld`). The
// hand-follow window loop intentionally LAGS the cursor (HAND_DRAG_FOLLOW
// < 1), so the cursor's clientX/clientY drifts ahead of the window each
// frame — which is exactly the signal we want the IK to track.

document.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  if (isNoDragTarget(e.target)) return;

  // Detect hand-grab. Two conditions must both hold:
  //   1. Cursor is over actual Claude pixels (rejects clicks in empty
  //      transparent space that happen to be near a hand bone's
  //      projected screen position).
  //   2. Cursor is within ~50px of a hand bone's projected position.
  const onCharacter = hitTestPoint(e.clientX, e.clientY) === 'character';
  const grabbedHand = (onCharacter && claude.whichHandHit)
    ? claude.whichHandHit(e.clientX, e.clientY, 50)
    : null;

  isDragging = true;
  isHandDrag = !!grabbedHand;
  handDragSide = grabbedHand;
  dragStartPos = { x: e.screenX, y: e.screenY };
  lastDragScreenX = e.screenX;
  lastDragScreenY = e.screenY;
  // Capture window offset so the window can follow the cursor — we want
  // the character to actually drag across the screen (not stay put).
  try {
    const [winX, winY] = await window.cs.getWindowPosition();
    dragOffset = { x: e.screenX - winX, y: e.screenY - winY };
    // Seed the eased follow at the current window position so it doesn't
    // jump on the first hand-drag mousemove.
    dragCurrentX = winX;
    dragCurrentY = winY;
    dragTargetX  = winX;
    dragTargetY  = winY;
    if (grabbedHand) startHandDragLoop();
  } catch (_) {
    dragOffset = { x: 0, y: 0 };
  }

  preDragEmotion = claude.currentEmotion;
  claude.setEmotion('surprised');
  claude.setDragging(true);
  if (grabbedHand && claude.cursorToHandTargetWorld) {
    const t = claude.cursorToHandTargetWorld(e.clientX, e.clientY, grabbedHand);
    if (t) {
      if (grabbedHand === 'left')  claude.setLeftHandIKTarget(t);
      else                          claude.setRightHandIKTarget(t);
    }
  }

  // Woah-oh-oh while being dragged. Drop any existing TTS first so
  // the woah cuts in immediately rather than queueing behind a prior
  // response. The speak Promise resolves when speech ends; if the
  // user's still dragging, fire another so it loops.
  if (claude.stopSpeaking) claude.stopSpeaking();
  queue.length = 0;
  speaking = false;
  startWoahLoop();
});

// Static woah audio — committed under assets/voices/<gender>/woah_*.wav.
// Bake them with `node tools/bake-voice-lines.mjs` whenever the lines or
// voices change. Runtime just builds an Audio element pointing at the
// local URL — no IPC, no synth.
const WOAH_SLUGS = ['woah_1', 'woah_2', 'woah_3', 'woah_4'];
function woahUrl(gender, slug) {
  return `../assets/voices/${gender}/${slug}.wav`;
}
// Hold references to prewarmed Audio elements so the browser keeps
// the decoded WAVs in cache and the first drag doesn't pay decode cost.
const _woahPrewarm = [];
function prewarmWoahs() {
  for (const gender of ['male', 'female']) {
    for (const slug of WOAH_SLUGS) {
      const a = new Audio(woahUrl(gender, slug));
      a.preload = 'auto';
      a.muted   = true;     // silently fully load the WAV
      // Trigger a 0-volume play+pause cycle so the browser decodes
      // and caches the audio. Some engines lazy-decode until first
      // play() request even with preload=auto.
      a.play().then(() => { try { a.pause(); a.currentTime = 0; } catch (_) {} })
              .catch(() => {});
      _woahPrewarm.push(a);
    }
  }
}

let woahLoopActive = false;
async function startWoahLoop() {
  if (woahLoopActive) return;
  woahLoopActive = true;
  const gender = settings.voiceMode === 'female' ? 'female' : 'male';
  let i = 0;
  while (isDragging && !settings.muted) {
    const url = woahUrl(gender, WOAH_SLUGS[i++ % WOAH_SLUGS.length]);
    await claude.playClip(url);    // mouth flaps via the renderer's viseme timer
    if (!isDragging) break;
  }
  woahLoopActive = false;
}

let lastDragScreenX = null;
let lastDragScreenY = null;

// In hand-drag we want the window to LAG the cursor — the cursor pulls
// ahead, the hand reaches toward it via IK, and the window catches up
// over time. That gives the "dragging Claude by the hand" feel. The
// easing runs in its own loop independent of mousemove rate.
let dragTargetX = 0, dragTargetY = 0;        // where the window WANTS to be
let dragCurrentX = 0, dragCurrentY = 0;      // where the window currently is
let dragLoopRunning = false;
const HAND_DRAG_FOLLOW = 0.10;               // 0=window doesn't follow, 1=instant.
                                             // Low value lets the cursor pull
                                             // visibly ahead of the body — arm
                                             // IK reaches for the cursor while
                                             // the window slowly catches up,
                                             // selling the "dragging by the
                                             // hand" feel vs. plain window drag.
function startHandDragLoop() {
  if (dragLoopRunning) return;
  dragLoopRunning = true;
  function step() {
    if (!isDragging || !isHandDrag) {
      dragLoopRunning = false;
      return;  // bail without scheduling another frame
    }
    // Snap when essentially caught up — avoids sub-pixel oscillation that
    // can look like the window drifting on its own.
    const dx = dragTargetX - dragCurrentX;
    const dy = dragTargetY - dragCurrentY;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      dragCurrentX = dragTargetX;
      dragCurrentY = dragTargetY;
    } else {
      dragCurrentX += dx * HAND_DRAG_FOLLOW;
      dragCurrentY += dy * HAND_DRAG_FOLLOW;
    }
    window.cs.moveWindow(Math.round(dragCurrentX), Math.round(dragCurrentY));
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  if (isHandDrag) {
    // Eased follow: target updates instantly, window catches up smoothly.
    dragTargetX = e.screenX - dragOffset.x;
    dragTargetY = e.screenY - dragOffset.y;
    // IK target = cursor's window-relative position, projected onto the
    // hand's depth plane. The hand bone tracks under the pointer
    // visually. As the window lags-then-catches-up, the cursor's
    // clientX/clientY shifts each frame — that's the signal.
    if (handDragSide && claude.cursorToHandTargetWorld) {
      const t = claude.cursorToHandTargetWorld(e.clientX, e.clientY, handDragSide);
      if (t) {
        if (handDragSide === 'left')  claude.setLeftHandIKTarget(t);
        else                           claude.setRightHandIKTarget(t);
      }
    }
    if (lastDragScreenX != null && claude.setDragVelocity) {
      claude.setDragVelocity(e.screenX - lastDragScreenX, e.screenY - lastDragScreenY);
    }
    lastDragScreenX = e.screenX;
    lastDragScreenY = e.screenY;
    return;
  }
  // Window-drag: cursor moves the whole window directly.
  const newX = e.screenX - dragOffset.x;
  const newY = e.screenY - dragOffset.y;
  window.cs.moveWindow(newX, newY);
  if (lastDragScreenX != null && claude.setDragVelocity) {
    claude.setDragVelocity(e.screenX - lastDragScreenX, e.screenY - lastDragScreenY);
  }
  lastDragScreenX = e.screenX;
  lastDragScreenY = e.screenY;
});

function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  lastDragScreenX = null;
  lastDragScreenY = null;
  if (isHandDrag) {
    isHandDrag = false;
    handDragSide = null;
    if (claude.clearHandIKTargets) claude.clearHandIKTargets();
  }
  claude.setDragging(false);
  // Cut off the woah-loop in flight. The loop's `while (isDragging)`
  // condition takes over but the current utterance was already queued
  // by the SpeechSynthesis engine — stopSpeaking flushes it so it
  // doesn't keep talking after release.
  if (claude.stopSpeaking) claude.stopSpeaking();
  // dizzy little blink, then snap back to a happy resting state
  claude.blink();
  setTimeout(() => {
    claude.setEmotion('happy');
    setTimeout(() => {
      // if not currently speaking, settle to neutral
      if (!speaking) claude.setEmotion('neutral');
    }, 800);
  }, 140);
}

document.addEventListener('mouseup', endDrag);
document.addEventListener('mouseleave', endDrag);
window.addEventListener('blur', endDrag);

// ---------- controls ----------
const muteBtn     = $('muteBtn');
const skipBtn     = $('skipBtn');
const settingsBtn = $('settingsBtn');
const minBtn      = $('minBtn');
const quitBtn     = $('quitBtn');
const settingsPanel = $('settingsPanel');

muteBtn.addEventListener('click', () => {
  settings.muted = !settings.muted;
  document.body.classList.toggle('muted', settings.muted);
  muteBtn.textContent = settings.muted ? '🔈' : '🔊';
  if (settings.muted) claude.stopSpeaking();
  persistSettings();
});

skipBtn.addEventListener('click', () => {
  claude.stopSpeaking();
});

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

minBtn.addEventListener('click', () => window.cs.minimize());
quitBtn.addEventListener('click', () => window.cs.quit());

$('voiceMode').addEventListener('change', (e) => {
  settings.voiceMode = e.target.value;
  persistSettings();
});
$('lengthCap').addEventListener('change', (e) => {
  settings.lengthCap = Number(e.target.value);
  persistSettings();
});
$('rate').addEventListener('input', (e) => {
  settings.rate = Number(e.target.value);
  persistSettings();
});
$('sizeSelect').addEventListener('change', (e) => {
  settings.windowSize = e.target.value;
  persistSettings();
  const sz = SIZE_PRESETS[settings.windowSize] || SIZE_PRESETS.medium;
  window.cs.setWindowSize(sz.w, sz.h);
});
$('lockToggle').addEventListener('change', (e) => {
  settings.locked = !!e.target.checked;
  persistSettings();
  applyLockState();
});

function applySettingsToUI() {
  $('voiceMode').value   = settings.voiceMode;
  $('lengthCap').value   = String(settings.lengthCap);
  $('rate').value        = String(settings.rate);
  $('sizeSelect').value  = settings.windowSize || 'medium';
  $('lockToggle').checked = !!settings.locked;
  muteBtn.textContent    = settings.muted ? '🔈' : '🔊';
  document.body.classList.toggle('muted', settings.muted);
  applyLockState();
}

// ---------- boot ----------
(async function boot() {
  await loadSettings();
  // wait briefly for voices to populate
  setTimeout(refreshVoices, 250);

  try {
    claude = await makeBackend();
  } catch (e) {
    console.error('VRM backend failed, falling back to SVG:', e);
    document.body.classList.remove('renderer-vrm');
    claude = createClaude($('character'));
  }

  // Icon capture mode — render a few frames of the head-zoomed
  // character on a transparent canvas, dump it as PNG, exit.
  if (window.CAPTURE_ICON) {
    await claude.assemble();
    claude.startIdle();
    claude.setEmotion('happy');
    setTimeout(() => {
      const canvas = document.querySelector('#vrm-stage canvas');
      if (canvas) {
        const dataUrl = canvas.toDataURL('image/png');
        window.cs.saveIconPng(dataUrl);
      } else {
        console.error('[icon] no canvas found');
      }
    }, 1500);
    return;
  }
  await claude.assemble();
  claude.startIdle();

  // Try VRMA animations: preload a starter set so they're ready to play
  // on key/event triggers. Names map 1-9 to keyboard quick-play.
  if (claude.loadAnimation && claude.playAnimation) {
    const ANIM_KEYS = [
      ['1', 'greeting',   '../assets/animations/Standing Greeting.vrma'],
      ['2', 'salute',     '../assets/animations/Salute.vrma'],
      ['3', 'handraise',  '../assets/animations/Hand Raising.vrma'],
      ['4', 'reachout',   '../assets/animations/Reaching Out.vrma'],
      ['5', 'dismiss',    '../assets/animations/Dismissing Gesture.vrma'],
      ['6', 'crazy',      '../assets/animations/Crazy Gesture.vrma'],
      ['7', 'lookaway',   '../assets/animations/Look Away Gesture.vrma'],
      ['8', 'thankful',   '../assets/animations/Thankful.vrma'],
      ['9', 'victory',    '../assets/animations/Victory.vrma'],
      ['0', 'cheering',   '../assets/animations/Cheering.vrma'],
      ['t', 'talking',    '../assets/animations/Talking.vrma'],
      ['i', 'idle',       '../assets/animations/Standing Idle.vrma'],
    ];
    for (const [, name, url] of ANIM_KEYS) {
      try { await claude.loadAnimation(name, url); }
      catch (e) { console.warn('[vrma] failed to load', name, e); }
    }
    document.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const map = ANIM_KEYS.find(([k]) => k === e.key);
      if (!map) return;
      const [, name] = map;
      const loop = (name === 'idle' || name === 'talking');
      claude.playAnimation(name, { loop });
    });

    // Welcome wave — happy face + greeting clip + baked welcome WAV.
    // The static WAV plays instantly; no synth or IPC needed.
    claude.playAnimation('idle', { loop: true });
    claude.setEmotion('happy');
    welcomeBlocking = true;
    setTimeout(async () => {
      claude.playAnimation('greeting');
      const gender = settings.voiceMode === 'female' ? 'female' : 'male';
      try { await claude.playClip(`../assets/voices/${gender}/welcome.wav`); }
      finally {
        welcomeBlocking = false;
        // Drain anything that arrived while we were welcoming.
        setTimeout(processQueue, 100);
      }
    }, 600);

    // Prewarm the woah WAVs so the FIRST drag doesn't pay the
    // sync-decode cost. Without this, the initial drag stutters
    // while the renderer decodes the audio on demand. After a few
    // hundred ms the browser has decoded each file and subsequent
    // plays are instant.
    prewarmWoahs();
  }

})();
