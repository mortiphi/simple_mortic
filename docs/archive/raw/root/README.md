# Mortic

Mortic is a local voice sidecar and canonical project-memory layer for Codex CLI threads. Point it at a thread and talk to a scratch fork of that thread by voice — the source thread is never mutated. When a scratch session is worth keeping, Compile distills it into reviewable project-state cards (tasks, risks, decisions) that you approve into a canonical project chart. Everything runs on localhost against your existing Codex login.

## Requirements

- Codex CLI installed and logged in (`codex login`)
- Linux desktop with Debian/Ubuntu package support for the first release.
- Node.js >= 20 only when developing from source.

## Quick start

Download the latest `.deb` from [GitHub Releases](https://github.com/Aeroknight786/simple_mortic/releases), then install it:

```bash
sudo apt install ./mortic-0.1.0-amd64.deb
```

Launch **Mortic** from your desktop app menu, or run:

```bash
mortic-desktop
```

Mortic starts a localhost app against your existing Codex login. Pick a recent Codex thread from the Source thread field, or paste a thread id from `codex resume`.

Check your Codex install from a source checkout:

```bash
npm run build
node dist/node/cli/main.js doctor
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

`mortic doctor` is available from source builds and future CLI distributions. It prints a diagnosis like this (illustrative):

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

## Linux desktop packages

For Linux users, prefer the packaged desktop build. Do not ask users to run Electron from `node_modules`, and do not rely on an npm/npx install path for the first release.

Build the Debian/Ubuntu desktop package:

```bash
npm run dist:linux
```

This writes a `.deb` artifact to `release/`. The package installs the desktop app as `mortic-desktop`. The generated Debian/RPM post-install hook configures Electron's `chrome-sandbox` under `/opt/Mortic`, so users do not need to manually `chown` or `chmod` the helper in a project checkout.

Build RPM on a release machine with `rpmbuild` installed:

```bash
npm run dist:linux:rpm
```

Build both package formats:

```bash
npm run dist:linux:all
```

Quickly validate the packaged app layout without building installers:

```bash
npm run dist:linux:dir
```

## License

MIT
