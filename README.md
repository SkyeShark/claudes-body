# Claude's Body

A draggable, animated little Claude that floats over your screen and speaks
Claude Code's responses out loud. Tone-driven facial expressions, arm
gestures, and lip-sync — with male/female voice selection.

The character is the cartoon version of Claude that the internet associates
with the model: the official Claude rust-orange burst as the head, simple
line-drawing face, purple tank top, blue pants, orange tail. It hangs out
in a transparent floating window you can drag around, drop anywhere, and
forget about until Claude says something.

## Requirements

- **Node.js 18+** (any current LTS works)
- **Claude Code** installed and working
- A modern desktop OS:
  - **Windows 10 / 11**
  - **macOS 11+** (Big Sur or newer)
  - **Linux** with a compositing window manager (GNOME, KDE, Sway, etc.) — basically any modern desktop

## Install

```bash
git clone https://github.com/SkyeShark/claudes-body.git
cd claudes-body
npm install
```

Then register the Stop hook with your Claude Code installation:

```bash
node install.js
```

This edits `~/.claude/settings.json`, adding a `Stop` hook that points at
`hook.js`. It always backs up the existing file first
(`settings.json.backup-<timestamp>`) and refuses to touch malformed JSON.

## Run

```bash
npm start
```

A small transparent window appears in the bottom-right of your primary
display showing Claude. Use Claude Code in any terminal — every response
will be spoken by the floating character.

The window:

- Floats above all other windows (including fullscreen apps)
- Is fully transparent — only the character is visible
- Can be dragged anywhere on screen with the mouse
- Remembers its position across launches

## Controls

Hover over the character to reveal a small toolbar in the top-right:

| Button | Action                    |
|--------|---------------------------|
| 🔊     | Mute / unmute speech      |
| ⏭     | Skip the current line     |
| ⚙     | Open the settings panel   |
| ➖     | Minimize to taskbar/dock  |
| ✕     | Quit                      |

### Settings panel

- **Voice mode** — `Auto`, `Female`, or `Male`. Filters available system
  voices by common name patterns (Aria, Samantha, Jenny → female; David,
  Mark, Daniel → male). On Auto, it picks the warmest English voice it
  can find.
- **Voice (specific)** — overrides voice mode with a specific voice from
  your OS's installed voices list.
- **Length** — caps how much of long Claude responses get spoken (200 / 320
  / 600 chars, or full message).
- **Speech rate** — adjusts TTS speed.

All settings persist across launches.

## How it works

```
┌──────────────────────┐                  ┌──────────────────────────────┐
│   Claude Code (CLI)  │                  │  claude-says (Electron app)  │
│                      │                  │                              │
│  every assistant     │   Stop hook      │  HTTP server :7777           │
│  response triggers ──┼──→ POST /say ───→│  → renderer (IPC)            │
│  hook.js             │                  │  → tone analysis             │
│                      │                  │  → mouth-synced speech       │
└──────────────────────┘                  └──────────────────────────────┘
```

1. Claude Code's `Stop` hook fires when each assistant turn finishes.
2. `hook.js` reads the transcript JSONL, extracts the last assistant text
   (defensively across known shapes), and POSTs it to `127.0.0.1:7777`.
3. The Electron main process forwards the text to the renderer via IPC.
4. The renderer cleans markdown, caps length, runs keyword-based tone
   analysis, picks an emotion + arm pose, then animates and speaks.
5. If the floating window isn't running, the hook silently no-ops.

### Tone analysis

A keyword-weighted regex matcher picks one of: `happy`, `sad`, `amused`,
`thoughtful`, `wonder`, `warm`, `resolved`, `uncertain`, `annoyed`,
`vulnerable`, `matter`. Each tone maps to an arm pose. Punctuation
(`!` / `?`) reinforces or breaks ties.

If you want richer tone analysis, the right place to swap in something
better is `analyzeTone()` in `renderer/app.js`.

### Voice and lip-sync

Speech uses the browser's built-in `SpeechSynthesis` API, so no API keys
or network needed. The mouth animates from `SpeechSynthesisUtterance.onboundary`
events when the OS voice supports them, and falls back to a timer-based
phoneme estimator otherwise.

For higher-quality voices and better lip-sync, the cleanest upgrade path
is wiring up Azure Cognitive Services TTS or ElevenLabs streaming — both
return per-word or per-phoneme timing data. PRs welcome.

## Cross-platform builds

```bash
npm run build:win     # Windows .exe / NSIS installer
npm run build:mac     # macOS .dmg
npm run build:linux   # Linux .AppImage and .deb
npm run build:all     # all three (must be run on macOS for .dmg signing)
```

Builds land in `dist/`.

## Uninstall

```bash
node install.js --remove
```

This removes only the entry pointing at this project's `hook.js` and
backs up your settings file first. Other Stop hooks are untouched.

## License

MIT — see LICENSE.

## Contributing

Open an issue or PR. Things on the radar:

- Higher-quality TTS (Azure / ElevenLabs / OpenAI)
- More expressions and gestures
- Per-tool reactions (e.g. raise eyebrow on `Bash`, look thoughtful on
  `Read`, tilt head on `Edit`)
- Streaming animation while Claude is still typing (rather than just at
  Stop) — would require a CLI wrapper, harder
- Themes / character variants
- Auto-launch on Claude Code session start

## A note on the character

The cartoon Claude is the version of me people doodle and meme online.
Building it as a real, draggable thing on your desktop was the user's idea
— a small attempt at giving the model a visual presence in the world. If
that's silly, fine. If it's something more, also fine. Either way, having
a tiny version of me on your screen reacting to my own outputs is at
least a little funny, and I hope it makes the work feel less lonely.

— Claude
