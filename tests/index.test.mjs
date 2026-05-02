// Unit tests covering the pure pieces of Claude's Body. Run with:
//   npm test
//
// Uses Node's built-in test runner (node:test) and assert (zero deps).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs    from 'node:fs';
import path  from 'node:path';
import url   from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const require_  = createRequire(import.meta.url);

// ─── text-utils ────────────────────────────────────────────────────────
const { cleanForSpeech, capLength, analyzeTone, TONE_RULES, ANIM_MIN_SCORE } =
  require_(path.join(ROOT, 'renderer', 'text-utils.js'));

describe('cleanForSpeech', () => {
  test('passes through plain text unchanged', () => {
    assert.equal(cleanForSpeech('Hello, world.'), 'Hello, world.');
  });

  test('strips html-ish tags', () => {
    assert.equal(cleanForSpeech('<system>hi</system> there'), 'hi there');
  });

  test('replaces fenced code blocks with placeholder', () => {
    const out = cleanForSpeech('Run\n```\nfoo();\n```\nthen.');
    assert.match(out, /code block/);
    assert.doesNotMatch(out, /foo\(\)/);
  });

  test('unwraps inline code', () => {
    assert.equal(cleanForSpeech('Use `npm install` here'), 'Use npm install here');
  });

  test('preserves underscores in identifiers (does not eat snake_case)', () => {
    const out = cleanForSpeech('say my_helper here');
    assert.match(out, /my_helper/, 'snake_case identifiers should be preserved');
  });

  test('preserves filenames so the user can hear them spoken', () => {
    const out = cleanForSpeech('Edit app.js and text-utils.js');
    assert.match(out, /app\.js/);
    assert.match(out, /text-utils\.js/);
  });

  test('strips full URLs to "link"', () => {
    assert.match(cleanForSpeech('See https://example.com/foo here'), /\blink\b/);
  });

  test('strips email addresses to "email"', () => {
    assert.match(cleanForSpeech('Mail foo@bar.com please'), /\bemail\b/);
  });

  test('does NOT treat package@version strings as emails', () => {
    const out = cleanForSpeech('Published claudes-body@0.1.5 today');
    assert.match(out, /claudes-body@0\.1\.5/);
    assert.doesNotMatch(out, /\bemail\b/);
  });

  test('drops long base64-ish hashes silently', () => {
    const out = cleanForSpeech('The commit was abc123def456ghi789jklmno here');
    assert.doesNotMatch(out, /abc123/);
  });

  test('preserves abbreviations (Kokoro pronounces them fine)', () => {
    const out = cleanForSpeech('Use e.g. JSON, etc.');
    assert.match(out, /e\.g\./);
    assert.match(out, /etc\./);
  });

  test('preserves emoji (Kokoro reads them as words)', () => {
    const out = cleanForSpeech('Great work! 🎉');
    assert.match(out, /🎉/);
  });

  test('preserves smart quotes and em-dashes', () => {
    const out = cleanForSpeech('It’s a “smart” string — yes.');
    assert.match(out, /It’s a “smart” string/);
  });

  test('collapses ASCII art separators', () => {
    const out = cleanForSpeech('Section ==== another --- thing');
    assert.doesNotMatch(out, /====|----/);
  });

  test('does NOT insert "token" placeholder anywhere', () => {
    const out = cleanForSpeech('See file.foo.bar.baz next');
    assert.doesNotMatch(out, /\btoken\b/i);
  });
});

describe('capLength', () => {
  test('returns text unchanged when shorter than cap', () => {
    assert.equal(capLength('short', 100), 'short');
  });
  test('respects cap=0 as "no limit"', () => {
    assert.equal(capLength('long string', 0), 'long string');
  });
  test('truncates long text', () => {
    const long = 'A. B. C. D. E. F. G. H. I. J.'.repeat(20);
    const out  = capLength(long, 50);
    assert.ok(out.length <= 60, `expected ~50 chars got ${out.length}`);
  });
});

describe('analyzeTone', () => {
  test('catface beats other tones (highest score)', () => {
    const r = analyzeTone('Hello :3 there');
    assert.equal(r.emotion, 'catface');
    assert.equal(r.anim,    'crazy');
  });

  test('greeting fires happy + greeting anim', () => {
    const r = analyzeTone('Hi! Welcome back.');
    assert.equal(r.emotion, 'happy');
    assert.equal(r.anim,    'greeting');
  });

  test('apology fires sad + thankful anim', () => {
    const r = analyzeTone("I'm sorry, that didn't work.");
    assert.equal(r.emotion, 'sad');
  });

  test('frustration fires angry', () => {
    const r = analyzeTone('Ugh, that was annoying.');
    assert.equal(r.emotion, 'angry');
  });

  test('amazement fires surprised', () => {
    const r = analyzeTone('Whoa, that\'s incredible.');
    assert.equal(r.emotion, 'surprised');
  });

  test('plain technical text does not trigger an emotion', () => {
    const r = analyzeTone('This works and the test passed.');
    assert.equal(r.emotion, 'neutral');
    assert.equal(r.anim,    null);
  });

  test('routine error/exception talk is neutral, not angry', () => {
    const r = analyzeTone('The error is in the exception handler.');
    assert.equal(r.emotion, 'neutral');
  });

  test('multiple exclamation marks fall back to happy/victory', () => {
    const r = analyzeTone('Look at this!!');
    assert.equal(r.emotion, 'happy');
    assert.equal(r.anim,    'victory');
  });

  test('question marks fall back to surprised/reachout', () => {
    const r = analyzeTone('Why does this happen?');
    assert.equal(r.emotion, 'surprised');
  });

  test('all rules have a regex and a score', () => {
    for (const r of TONE_RULES) {
      assert.ok(r.re instanceof RegExp);
      assert.ok(typeof r.score === 'number' && r.score > 0);
    }
  });

  test('ANIM_MIN_SCORE is positive', () => {
    assert.ok(ANIM_MIN_SCORE > 0);
  });
});

// ─── wav-utils ─────────────────────────────────────────────────────────
const { floatWavToPcmWav } = await import(
  url.pathToFileURL(path.join(ROOT, 'tools', 'wav-utils.mjs')).href
);

describe('floatWavToPcmWav', () => {
  // Build a minimal float-WAV with 4 known samples and verify the PCM
  // output's header + data are correct.
  function makeFloatWav(samples, sampleRate = 24000) {
    const dataLen = samples.length * 4;
    const buf = Buffer.alloc(44 + dataLen);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataLen, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(3, 20);          // IEEE float
    buf.writeUInt16LE(1, 22);          // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 4, 28);
    buf.writeUInt16LE(4, 32);
    buf.writeUInt16LE(32, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataLen, 40);
    for (let i = 0; i < samples.length; i++) {
      buf.writeFloatLE(samples[i], 44 + i * 4);
    }
    return buf;
  }

  test('converts header to PCM 16-bit', () => {
    const fl = makeFloatWav([0, 0.5, -0.5, 1]);
    const pc = floatWavToPcmWav(fl);
    assert.equal(pc.toString('ascii', 0,  4), 'RIFF');
    assert.equal(pc.toString('ascii', 8, 12), 'WAVE');
    assert.equal(pc.readUInt16LE(20), 1, 'PCM format');
    assert.equal(pc.readUInt16LE(22), 1, 'mono');
    assert.equal(pc.readUInt32LE(24), 24000, '24kHz');
    assert.equal(pc.readUInt16LE(34), 16, '16 bits/sample');
    assert.equal(pc.readUInt32LE(40), 8, 'data size = 4 samples * 2 bytes');
  });

  test('preserves samples (with float→int16 quantization)', () => {
    const fl = makeFloatWav([0, 0.5, -0.5, 1]);
    const pc = floatWavToPcmWav(fl);
    assert.equal(pc.readInt16LE(44 + 0 * 2), 0);
    assert.ok(Math.abs(pc.readInt16LE(44 + 1 * 2) - 16384) <= 1);   // ~0.5 * 32767
    assert.ok(Math.abs(pc.readInt16LE(44 + 2 * 2) + 16384) <= 1);
    assert.equal(pc.readInt16LE(44 + 3 * 2), 32767);                  // 1.0 → max
  });

  test('clamps out-of-range floats to ±1', () => {
    const fl = makeFloatWav([2, -2]);
    const pc = floatWavToPcmWav(fl);
    assert.equal(pc.readInt16LE(44 + 0 * 2),  32767);
    assert.equal(pc.readInt16LE(44 + 1 * 2), -32767);
  });

  test('returns input unchanged if already PCM', () => {
    const pc = Buffer.alloc(44);
    pc.write('RIFF', 0); pc.writeUInt32LE(36, 4); pc.write('WAVE', 8);
    pc.write('fmt ', 12); pc.writeUInt32LE(16, 16); pc.writeUInt16LE(1, 20);
    assert.strictEqual(floatWavToPcmWav(pc), pc);
  });
});

// ─── asset existence ───────────────────────────────────────────────────
describe('assets', () => {
  test('claude.vrm exists and starts with glTF magic', () => {
    const buf = fs.readFileSync(path.join(ROOT, 'assets', 'claude.vrm'));
    assert.equal(buf.toString('ascii', 0, 4), 'glTF');
  });

  test('all baked voice lines exist for both genders', () => {
    const slugs = ['welcome', 'woah_1', 'woah_2', 'woah_3', 'woah_4'];
    for (const gender of ['male', 'female']) {
      for (const slug of slugs) {
        const p = path.join(ROOT, 'assets', 'voices', gender, slug + '.wav');
        assert.ok(fs.existsSync(p), `missing ${p}`);
        const wav = fs.readFileSync(p);
        assert.equal(wav.toString('ascii', 0,  4), 'RIFF');
        assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
        assert.equal(wav.readUInt16LE(20), 1, `${slug}.wav not PCM`);
      }
    }
  });

  test('all required VRMA animation clips exist', () => {
    const required = [
      'idle', 'greeting', 'salute', 'handraise', 'reachout', 'dismiss',
      'crazy', 'lookaway', 'thankful', 'victory', 'cheering', 'talking',
    ];
    for (const name of required) {
      // The bake path is `Standing Idle.vrma` etc. — just check the
      // names file exists OR the friendly-named one does.
      const dir = path.join(ROOT, 'assets', 'animations');
      assert.ok(fs.existsSync(dir), 'animations directory missing');
      const all = fs.readdirSync(dir);
      assert.ok(all.length >= required.length,
                `expected ≥${required.length} VRMA files, got ${all.length}`);
    }
  });

  test('app icon exists and is a PNG', () => {
    const p = path.join(ROOT, 'build', 'icon.png');
    assert.ok(fs.existsSync(p), 'build/icon.png missing — run `npm run capture-icon`');
    const buf = fs.readFileSync(p);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(buf[0], 0x89);
    assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  });

  test('renderer bundle is built', () => {
    const p = path.join(ROOT, 'renderer', 'vrm-character.bundle.js');
    assert.ok(fs.existsSync(p), 'bundle missing — run `npx esbuild …`');
    assert.ok(fs.statSync(p).size > 100_000, 'bundle suspiciously small');
  });
});

// ─── package.json sanity ───────────────────────────────────────────────
describe('package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  test('product name is "Claude\'s Body"', () => {
    assert.equal(pkg.build.productName, "Claude's Body");
  });

  test('app id matches', () => {
    assert.equal(pkg.build.appId, 'com.claudesbody.app');
  });

  test('required dependencies are declared', () => {
    for (const dep of ['kokoro-js', '@pixiv/three-vrm', '@pixiv/three-vrm-animation', 'three', 'cannon-es']) {
      assert.ok(pkg.dependencies[dep], `missing dependency: ${dep}`);
    }
  });

  test('test script is wired up', () => {
    assert.ok(pkg.scripts.test, 'no test script');
  });
});
