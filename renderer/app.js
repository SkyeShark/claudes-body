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
  voiceMode: 'auto',      // 'auto' | 'female' | 'male'
  voiceName: '',          // specific voice override
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

// ---------- text cleanup (strip markdown / code / SSE noise) ----------
function cleanForSpeech(input) {
  let text = String(input || '');

  // strip XML/HTML-ish tags (system reminders, command output blocks, etc.)
  text = text.replace(/<[^>]+>/g, ' ');

  // fenced code blocks → "code block" placeholder so we don't read code aloud
  text = text.replace(/```[\s\S]*?```/g, ' . code block . ');

  // inline code → unwrap
  text = text.replace(/`([^`]+)`/g, '$1');

  // markdown emphasis
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g,     '$1');
  text = text.replace(/__([^_]+)__/g,     '$1');
  text = text.replace(/_([^_]+)_/g,       '$1');

  // headers
  text = text.replace(/^#+\s+/gm, '');

  // list bullets
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');

  // links: keep label, drop URL
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function capLength(text, cap) {
  if (!cap || text.length <= cap) return text;
  // first paragraph if it fits
  const firstPara = text.split(/\n\n+/)[0].trim();
  if (firstPara.length <= cap) return firstPara;
  // accumulate sentences up to the cap
  const sentences = firstPara.match(/[^.!?]+[.!?]+/g) || [firstPara];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > cap) break;
    out += s;
  }
  if (!out) out = firstPara.slice(0, Math.max(cap - 3, 1)) + '...';
  return out.trim();
}

// ---------- tone analyzer ----------
// Keyword-weighted heuristic — fast, dependency-free, surprisingly readable.
// Returns { emotion, pose } compatible with character.js dictionaries.
// Each tone offers a small family of poses. We pick one at random per turn,
// skipping whatever pose was used last, so the character doesn't keep doing
// the exact same gesture every time the same word shows up.
const TONE_RULES = [
  // Only true emotional-affect words count as sad. Technical constraints
  // ("can't", "unable", "missing", "broken") show up constantly in normal
  // explanation and shouldn't change the character's mood.
  { tone: 'sad',        poses: ['in', 'hand_to_self'],            score: 3,
    re: /\b(sorry|unfortunately|regret(?:fully)?|sadly|alas|disappointed|disheartened|terrible|awful|unhappy|grieve|mourning|heartbroken)\b/i },
  { tone: 'annoyed',    poses: ['in', 'shrug'],                   score: 2,
    re: /\b(error|exception|invalid|denied|forbidden|reject(?:ed)?|conflict|frustrated|annoying|dammit|argh|ugh)\b/i },
  { tone: 'uncertain',  poses: ['shrug', 'in', 'curious'],        score: 3,
    re: /\b(not sure|unclear|don'?t know|unsure|might not|possibly|i'?m not certain|hard to say|can'?t tell)\b/i },
  { tone: 'thoughtful', poses: ['curious', 'in', 'shrug'],        score: 2,
    re: /\b(consider|think|perhaps|maybe|might|could|wonder|hmm|let me|let's|investigate|examine|analy[sz]e)\b/i },
  { tone: 'wonder',     poses: ['open_big', 'hands_up'],          score: 2,
    re: /\b(amazing|incredible|fascinating|whoa|wow)\b/i },
  { tone: 'amused',     poses: ['rest', 'one_out', 'curious'],    score: 1,
    re: /\b(haha|lol|funny|interesting|cute|nice|oh)\b/i },
  { tone: 'warm',       poses: ['hand_to_self', 'one_out', 'open', 'resolved'], score: 2,
    re: /\b(thank(?:s| you)|appreciate|welcome|kind|glad|happy to|here for)\b/i },
  { tone: 'happy',      poses: ['wave', 'open', 'resolved', 'one_out'],         score: 2,
    re: /\b(great|awesome|excellent|perfect|love|wonderful|fantastic|excited|done|works|success|fixed|ready|hi|hello|hey|greetings)\b/i },
  { tone: 'resolved',   poses: ['open', 'resolved', 'one_out'],   score: 2,
    re: /\b(definitely|certainly|absolutely|sure|of course|exactly|right|will|should|complete)\b/i },
];

let lastPose = 'rest';
function pickPose(poses) {
  if (!poses || poses.length === 0) return 'rest';
  if (poses.length === 1) return poses[0];
  const choices = poses.filter(p => p !== lastPose);
  const list = choices.length ? choices : poses;
  return list[Math.floor(Math.random() * list.length)];
}

function analyzeTone(text) {
  const scores = {};
  let bestTone  = 'matter';
  let bestPoses = ['rest'];
  let bestScore = 0;

  for (const r of TONE_RULES) {
    const matches = (text.match(r.re) || []).length;
    if (matches > 0) {
      const s = (scores[r.tone] = (scores[r.tone] || 0) + matches * r.score);
      if (s > bestScore) {
        bestScore = s;
        bestTone  = r.tone;
        bestPoses = r.poses;
      }
    }
  }

  // punctuation hints (reinforces / breaks ties)
  const exclaims  = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  if (questions >= 1 && bestScore < 3) {
    bestTone = 'thoughtful'; bestPoses = ['curious', 'in', 'shrug'];
  }
  if (exclaims >= 2 && bestScore < 3) {
    bestTone = 'happy'; bestPoses = ['wave', 'open', 'one_out'];
  }

  const pose = pickPose(bestPoses);
  lastPose = pose;
  return { emotion: bestTone, pose };
}

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

  const sel = $('voiceSelect');
  if (!sel) return;
  const current = sel.value;

  // Filter to match the selected voice mode so the dropdown only offers
  // voices that actually fit the chosen gender.
  let visible = voiceList;
  if (settings.voiceMode === 'female') {
    visible = voiceList.filter(v => FEM_NAME_RE.test(v.name));
  } else if (settings.voiceMode === 'male') {
    visible = voiceList.filter(v => MAS_NAME_RE.test(v.name));
  }

  sel.innerHTML = '<option value="">— default —</option>';
  for (const v of visible) {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(opt);
  }

  // Try to keep the current selection if still in the filtered list.
  if (current && visible.some(v => v.name === current)) {
    sel.value = current;
  } else if (settings.voiceName && visible.some(v => v.name === settings.voiceName)) {
    sel.value = settings.voiceName;
  } else {
    // Selection no longer matches the mode — clear it so Auto mapping kicks in.
    sel.value = '';
    if (settings.voiceName) {
      settings.voiceName = '';
      persistSettings();
    }
  }
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = refreshVoices;
  refreshVoices();
}

function buildVoicePrefs() {
  return {
    byName: settings.voiceName || null,
    gender: settings.voiceMode === 'female' ? 'female'
          : settings.voiceMode === 'male'   ? 'male'
          : null,
  };
}

// ---------- speak queue ----------
const queue = [];
let speaking = false;
let skipRequested = false;
let currentSpokenText = '';

async function processQueue() {
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
  claude.setEmotion(tone.emotion);
  claude.setArmPose(tone.pose, 700);

  await claude.speak(capped, {
    rate:       Number(settings.rate) || 0.96,
    voicePrefs: buildVoicePrefs(),
    muted:      settings.muted,
  });

  currentSpokenText = '';
  // gentle return to neutral
  claude.setArmPose('rest', 600);
}

function enqueue(payload) {
  if (!payload || !payload.text) return;
  // Always speak the MOST RECENT response. If a new one arrives while we're
  // still speaking an older one, drop the queue and cut off the current line.
  // Otherwise the character keeps falling further behind as more responses
  // come in. Skip if the same text is already in flight.
  const inFlight = speaking && currentSpokenText === payload.text;
  if (inFlight) return;
  queue.length = 0;
  queue.push({ text: payload.text });
  if (speaking) claude.stopSpeaking();
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
  if (elt.closest && (elt.closest('#controls') || elt.closest('#settingsPanel'))) return 'controls';
  return null;
}

function setHovering(on) {
  if (hoveringChar === !!on) return;
  hoveringChar = !!on;
  document.body.classList.toggle('hovering', hoveringChar);
}

document.addEventListener('mousemove', (e) => {
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
let dragOffset  = { x: 0, y: 0 };
let dragStartPos = null;
let preDragEmotion = 'neutral';
let preDragPose    = 'rest';

function isNoDragTarget(el) {
  while (el && el !== document.body) {
    if (el.classList && (el.classList.contains('no-drag') || el.tagName === 'BUTTON' ||
                         el.tagName === 'SELECT' || el.tagName === 'INPUT' ||
                         el.tagName === 'OPTION')) return true;
    el = el.parentNode;
  }
  return false;
}

document.addEventListener('mousedown', async (e) => {
  if (e.button !== 0) return;
  if (isNoDragTarget(e.target)) return;

  isDragging = true;
  dragStartPos = { x: e.screenX, y: e.screenY };
  try {
    const [winX, winY] = await window.cs.getWindowPosition();
    dragOffset = { x: e.screenX - winX, y: e.screenY - winY };
  } catch (_) {
    dragOffset = { x: 0, y: 0 };
  }

  // remember and switch to "being grabbed" pose — actual hands-up startle.
  preDragEmotion = claude.currentEmotion;
  preDragPose    = 'rest'; // we don't know previous arm pose from outside; safe default
  claude.setEmotion('surprised');
  claude.setArmPose('hands_up', 180);
  claude.setDragging(true);
});

document.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const newX = e.screenX - dragOffset.x;
  const newY = e.screenY - dragOffset.y;
  window.cs.moveWindow(newX, newY);
});

function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  claude.setDragging(false);
  // dizzy little blink, then snap back to a happy resting state
  claude.blink();
  setTimeout(() => {
    claude.setEmotion('happy');
    claude.setArmPose('rest', 500);
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
  // Re-filter the specific-voice dropdown so it only shows voices matching
  // the new mode.
  refreshVoices();
});
$('voiceSelect').addEventListener('change', (e) => {
  settings.voiceName = e.target.value;
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
  $('voiceSelect').value = settings.voiceName || '';
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
  await claude.assemble();
  claude.startIdle();

  // welcome wave on first launch
  setTimeout(() => {
    enqueue({ text: "Hi. I'm here. Press Control Shift L to grab me." });
  }, 400);
})();
