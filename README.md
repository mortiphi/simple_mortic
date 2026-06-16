# Mortic

Mortic is a local voice sidecar and canonical project-memory layer for Codex CLI threads. Point it at a thread and talk to a scratch fork of that thread by voice — the source thread is never mutated. When a scratch session is worth keeping, Compile distills it into reviewable project-state cards (tasks, risks, decisions) that you approve into a canonical project chart. Everything runs on localhost against your existing Codex login.

## Requirements

- Node.js >= 20
- Codex CLI installed and logged in (`codex login`)
- macOS or Linux. Windows works too, minus the Codex CLI PTY fallback (the primary app-server bridge is cross-platform).

## Quick start

```bash
npx mortic codex://threads/<thread-id>
```

This starts a localhost web app and opens it in your browser. The thread id is the UUID Codex shows in its resume picker (`codex resume`); a bare UUID also works as the argument. Once running, the app's Source thread field includes a Recent picker for switching threads.

Check your install:

```bash
npx mortic doctor
```

If `codex` is missing or logged out, Mortic still boots and serves a first-run onboarding screen that walks you through fixing it.

## Voice and cost (bring your own keys)

Mortic ships with zero cloud keys and never proxies or funds voice traffic.

- **No keys (default):** voice uses the browser's built-in SpeechRecognition / SpeechSynthesis. Free. Privacy caveat: in Chrome, browser speech recognition sends audio to Google's servers.
- **Optional cloud voice:** put your own keys in `~/.mortic/.env`. You pay those providers directly. Adding a key upgrades the voice tier on the next boot — no reinstall.

| Key | Enables |
| --- | --- |
| `DEEPGRAM_API_KEY` | Deepgram STT (Nova-2) and TTS (Aura) |
| `INWORLD_API_KEY` | Inworld STT and TTS |
| `OPENAI_API_KEY` | Whisper STT |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS |

Optionally, `LIVEKIT_URL` + `LIVEKIT_API_KEY` + `LIVEKIT_API_SECRET` switch audio transport from the local browser to LiveKit WebRTC. Real environment variables take precedence over `.env` files.

## Safety model

- The source Codex thread is never written to. Voice turns land in a scratch fork created through the Codex app-server (ephemeral `thread/fork`), validated to have a thread id different from the source before any turn is sent.
- If the app-server bridge fails, Mortic falls back to a Codex CLI fork driven over a PTY — and only types into it after verifying the fork's rollout file (`forked_from_id` matches the source, id differs, cwd matches). Unverified fallbacks stay disabled unless you opt in explicitly.
- Compile output is draft-only: cards stay pending until you approve them into the canonical chart.

Scratch transcripts and the canonical chart live under `~/.mortic/`. Retired fork rollouts are archived to `~/.codex/archived_sessions/`.

## Doctor

`npx mortic doctor` prints a diagnosis like this (illustrative):

```text
Mortic doctor

✓ Codex   codex-cli 0.48.0 (/usr/local/bin/codex)
✓ Login   logged in
✓ Skills  mortic-canonical-state current; mortic-voice-output current
✓ Python3 Python 3.12.4 — Codex CLI PTY fallback available
✓ Voice   browser (free, no keys)
✓ LiveKit not configured — local transport only
✓ Env     ~/.mortic/.env

Ready: codex is available and logged in.
```

Only Codex and Login gate the exit code; python3, voice keys, and LiveKit are informational.

## Development

```bash
git clone <repo-url> mortic && cd mortic
npm install
npm run dev -- codex://threads/<thread-id>
npm test
```

## License

MIT
