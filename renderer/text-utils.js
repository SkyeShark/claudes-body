'use strict';

// text-utils.js — pure text-processing helpers shared by the renderer
// (loaded as a <script> before app.js, attaches to window) and the
// node test suite (loaded via require()).

function cleanForSpeech(input) {
  let text = String(input || '');

  // strip XML/HTML-ish tags (system reminders, command output blocks, etc.)
  text = text.replace(/<[^>]+>/g, ' ');

  // ":3" emoticon → "meow". Otherwise Kokoro reads it as the digit "3"
  // and you lose the cat-face energy. \b after the 3 keeps timestamps
  // ("1:32") and clock notation safe.
  text = text.replace(/:3\b/g, ' meow ');

  // fenced code blocks → "code block" placeholder so we don't read code aloud
  text = text.replace(/```[\s\S]*?```/g, ' . code block . ');

  // inline code → unwrap
  text = text.replace(/`([^`]+)`/g, '$1');

  // markdown emphasis. The underscore variants need word-boundary
  // guards on both sides so they don't eat underscores from snake_case
  // identifiers and turn "my_helper_function" into "myhelperfunction".
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g,     '$1');
  text = text.replace(/(^|[^\w])__([^_]+)__(?=$|[^\w])/g, '$1$2');
  text = text.replace(/(^|[^\w])_([^_]+)_(?=$|[^\w])/g,   '$1$2');

  text = text.replace(/^#+\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');

  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Strip raw URLs only if they're long enough to be tedious. Short
  // URLs ("fish.audio", "https://x.com") read fine; long ones with
  // paths and query strings spell out for many seconds.
  const URL_MAX = 28;
  text = text.replace(/\bhttps?:\/\/\S+/gi, m => m.length > URL_MAX ? ' link ' : m);
  text = text.replace(/\bwww\.\S+/gi,       m => m.length > URL_MAX ? ' link ' : m);

  // Long base64-ish hashes (20+ chars of mixed letters and digits
  // with no separator). These sound like noise; drop silently.
  text = text.replace(/\b(?=\w{20,}\b)(?=\w*\d)(?=\w*[A-Za-z])\w+/g, ' ');

  // Symbol-run decorations like "====", "----", "****". Pure visual
  // noise that has no audio meaning.
  text = text.replace(/[-_*=~]{3,}/g, ' ');

  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function capLength(text, cap) {
  if (!cap || text.length <= cap) return text;
  // first paragraph if it fits
  const para = text.split(/\n\n+/)[0] || '';
  if (para.length <= cap) return para;
  // truncate at the last sentence boundary that fits
  const s = text.slice(0, cap);
  const m = s.match(/^[\s\S]*[.!?](?=[^.!?]*$)/);
  return (m ? m[0] : s).trim();
}

const TONE_RULES = [
  { emotion: 'catface', anim: 'crazy',     score: 5,
    re: /(?::3\b|\b(?:meow|smug|mischievous|cheeky|sly|teehee|hehehe|gotcha|nyah|nya~?|purr|kitty)\b)/i },
  { emotion: 'happy',   anim: 'greeting',  score: 4,
    re: /\b(hi|hello|hey|howdy|greetings|good morning|good afternoon|good evening)\b/i },
  { emotion: 'happy',   anim: 'thankful',  score: 4,
    re: /\b(thank(?:s| you)|appreciate|grateful|welcome|here for you)\b/i },
  { emotion: 'sad',     anim: 'thankful',  score: 4,
    re: /\b(sorry|apolog(?:y|ies|ize)|unfortunately|regret(?:fully|table)?|sadly|alas|disappointed|disheartened|heartbroken|grieve|mourning)\b/i },
  { emotion: 'angry',   anim: 'dismiss',   score: 4,
    re: /\b(frustrat(?:ed|ing)|annoy(?:ed|ing)|dammit|damn|argh|ugh|outrageous|ridiculous|seriously\?|absolutely not)\b/i },
  { emotion: 'surprised', anim: 'reachout', score: 4,
    re: /\b(whoa|wow|amazing|incredible|fascinating|unbelievable|astonish(?:ed|ing)|stunning|holy)\b/i },
  { emotion: 'happy',   anim: 'victory',   score: 3,
    re: /\b(awesome|excellent|perfect|love(?:ly)?|wonderful|fantastic|excited|brilliant|hooray|woohoo|yay|congratulations|congrats|nailed it)\b/i },
  { emotion: 'happy',   anim: 'handraise', score: 3,
    re: /\b(definitely|absolutely|certainly|of course|without a doubt)\b/i },
  { emotion: 'angry',   anim: 'dismiss',   score: 3,
    re: /\b(nope|no way|not happening|reject(?:ed)?|cannot accept)\b/i },
  { emotion: null,      anim: 'lookaway',  score: 3,
    re: /\b(awkward|embarrass(?:ed|ing)|sheepish|my bad|whoops|oops|that'?s on me)\b/i },
];
const ANIM_MIN_SCORE = 3;

// Split text at REAL sentence boundaries (period+space+capital, or
// end-of-text). Avoids chopping version strings like "0.1.7" into
// ".1"/".7" fragments. Every sentence becomes its own chunk so the
// first one plays as soon as it's synthed (~3s for typical sentences)
// instead of waiting for all sentences to merge (~12s+ for long
// responses). The maxLen parameter only kicks in for very long
// single sentences with no internal breaks; we keep it as one chunk
// rather than hard-splitting mid-clause.
function chunkText(text, maxLen = 400) {
  const sentences = [];
  let last = 0;
  const pattern = /[.!?]+\s+(?=[A-Z])|[.!?]+\s*$/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    sentences.push(text.slice(last, m.index + m[0].length).trim());
    last = m.index + m[0].length;
  }
  if (last < text.length) sentences.push(text.slice(last).trim());
  const filtered = sentences.filter(s => s.length > 0);
  if (filtered.length === 0) return [text];
  // Don't merge — each sentence is its own chunk. Kokoro synths them
  // serially in the worker; while chunk 1 plays, chunk 2 is already
  // being synthed, so playback is smooth without the front-load wait.
  // (maxLen is now a soft hint kept for the test interface.)
  return filtered;
}

function analyzeTone(text) {
  // Score = rule.score for any matched rule (not multiplied by match
  // count). Earlier the score was `(matches || []).length * score`,
  // but `String.match(re)` without /g returns an array containing the
  // whole-match plus each capture group, so a regex like /\b(hi|hey)\b/
  // would silently double its score. Cleaner to just test().
  let best = null;
  let bestScore = 0;
  for (const r of TONE_RULES) {
    if (!r.re.test(text)) continue;
    if (r.score > bestScore) { bestScore = r.score; best = r; }
  }
  const exclaims  = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;
  if (!best && exclaims >= 2)  return { emotion: 'happy',     anim: 'victory',  score: 2 };
  if (!best && questions >= 1) return { emotion: 'surprised', anim: 'reachout', score: 2 };
  if (!best) return { emotion: 'neutral', anim: null, score: 0 };
  return { emotion: best.emotion, anim: best.anim, score: bestScore };
}

// Browser side-effect: hang the helpers off `window` so app.js can
// call them as module-level functions with no import boilerplate.
if (typeof window !== 'undefined') {
  window.cleanForSpeech = cleanForSpeech;
  window.capLength      = capLength;
  window.chunkText      = chunkText;
  window.analyzeTone    = analyzeTone;
  window.TONE_RULES     = TONE_RULES;
  window.ANIM_MIN_SCORE = ANIM_MIN_SCORE;
}
// Node side: CommonJS export so the test suite can require() this file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cleanForSpeech, capLength, chunkText, analyzeTone, TONE_RULES, ANIM_MIN_SCORE };
}
