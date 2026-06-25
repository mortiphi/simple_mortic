# Mortic MVP Plan

## Product Definition

Mortic is a local voice sidecar for Codex threads.

The first MVP lets a user copy a Codex app deep link, launch a local web app with `npx mortic`, speak to a disposable scratch version of that thread, and generate a handoff prompt that can be pasted back into the original Codex app chat.

The first product is not a branch manager, visual graph, VS Code extension, or full agent operating system. Those come later.

## Primary User Flow

```text
1. User is working in the Codex app.
2. User copies a thread link:
   codex://threads/<thread-id>
3. User runs:
   npx mortic codex://threads/<thread-id>
4. Mortic starts a localhost backend and opens a browser UI.
5. User speaks to the selected Codex thread through a scratch voice session.
6. Mortic keeps a visible transcript.
7. User ends the session.
8. Mortic generates a final handoff prompt.
9. Mortic archives or discards the scratch thread/session.
10. User pastes the handoff prompt into the original Codex app chat.
```

## MVP Promise

```text
Speak to an existing Codex app thread without polluting it.
Leave with one clean handoff prompt.
```

## Package And Command

Package name:

```text
mortic
```

Primary command:

```bash
npx mortic codex://threads/019dbdcd-9916-7680-a6c2-af7a26dbd0bb
```

Optional local development command:

```bash
npm run dev -- codex://threads/<thread-id>
```

Command behavior:

```text
1. Parse the Codex thread URI.
2. Verify Codex CLI is installed and logged in.
3. Start or connect to Codex app-server.
4. Start Mortic backend.
5. Start Mortic web UI.
6. Open browser to the voice scratch session.
```

## Technical Shape

```text
mortic CLI
  - parses codex://threads/<id>
  - starts local services
  - opens browser

Mortic backend
  - local Node/Fastify server
  - talks to Codex CLI/app-server
  - stores temporary scratch transcripts
  - generates handoff prompt

Mortic web UI
  - Vite + React + TypeScript
  - browser push-to-talk STT
  - browser TTS
  - transcript and handoff review

Codex bridge
  - preferred: codex app-server thread APIs
  - fallback: codex exec resume --ephemeral
```

## Local Codex Protocol Check

Checked against local `codex-cli 0.118.0`.

The generated experimental app-server bindings expose the thread operations Mortic needs:

```text
thread/read
thread/fork
turn/start
thread/archive
```

Useful local protocol details:

```text
thread/read:
- accepts threadId
- can include turns/history

thread/fork:
- accepts threadId
- supports configuration overrides
- supports ephemeral forks

turn/start:
- accepts threadId
- accepts user input array
- supports model, effort, cwd, sandbox, and approval overrides

thread/archive:
- accepts threadId
```

This means the best implementation path is app-server first, with `codex exec resume --ephemeral` kept as a fallback.

## Free Testing Stack

Use browser-native voice first.

```text
Speech-to-text: browser SpeechRecognition
Text-to-speech: browser SpeechSynthesis
LLM/context: user's existing Codex CLI/app login
External API key: none
```

This keeps first testing free. Chrome should be the first target because browser speech recognition support is uneven.

Optional later providers:

```text
STT:
- OpenAI gpt-4o-mini-transcribe
- OpenAI whisper-1
- ElevenLabs Scribe
- local faster-whisper

TTS:
- OpenAI gpt-4o-mini-tts
- OpenAI tts-1
- ElevenLabs
```

Do not add paid voice providers before the browser-only path works.

## Codex Thread Strategy

Preferred app-server strategy:

```text
1. thread/read source thread.
2. thread/fork source into an ephemeral scratch thread if supported.
3. turn/start voice-derived user turns on scratch thread.
4. generate final handoff prompt from scratch transcript.
5. thread/archive scratch thread only if the fork was persisted.
6. leave source thread untouched.
```

Fallback CLI strategy:

```bash
codex exec resume <thread-id> --ephemeral "<scratch prompt + current voice turn>"
```

The fallback is less clean but useful for a same-day prototype. It avoids durable thread bloat by using ephemeral runs.

## Browser UI

Single screen for MVP:

```text
┌────────────────────────────────────────────────────────────┐
│ Mortic                                                     │
│ Source: codex://threads/<thread-id>                         │
├────────────────────────────────────────────────────────────┤
│ Status: connected to Codex                                 │
│                                                            │
│                [ Hold Space To Talk ]                       │
│                                                            │
│ Transcript                                                  │
│ You: ...                                                    │
│ Codex scratch: ...                                          │
│                                                            │
│ Scratch Notes                                               │
│ - decisions                                                 │
│ - open questions                                            │
│ - tasks                                                     │
│                                                            │
│ [End Session] [Generate Handoff] [Copy Handoff]             │
└────────────────────────────────────────────────────────────┘
```

MVP controls:

```text
- Hold Space to talk
- Stop session
- Generate handoff
- Copy handoff
- Save transcript
```

Avoid graph UI, branch CRUD, settings pages, accounts, and provider selection in the first cut.

## Handoff Prompt Format

```markdown
# Mortic Voice Scratch Handoff

Source thread:
codex://threads/<source-thread-id>

What I discussed:
- ...

Decisions:
- ...

Requests for the original Codex thread:
- ...

Context to preserve:
- ...

Do not assume the scratch thread is durable. Use this handoff as the source of truth for what should continue in the original thread.
```

## Local Files

Store local scratch artifacts outside the user's repo by default.

```text
~/.mortic/
  sessions/
    <session-id>/
      session.json
      transcript.md
      handoff.md
  logs/
```

Do not write API keys or Codex auth into Mortic files.

For this repository, development work stays inside:

```text
/Users/adsaha/Downloads/Codex Voice
```

## Security Boundaries

```text
- Mortic runs locally only.
- The browser UI talks only to localhost.
- Codex auth remains owned by Codex CLI/app-server.
- Mortic does not ask for OpenAI API keys in MVP.
- Source thread is not mutated unless the user explicitly sends the handoff back.
- Scratch sessions are archived/discarded by default after handoff generation.
```

## Milestones

### Milestone 0: Feasibility Spike

Goal:

```text
Prove that a Codex app deep link can be parsed and used to read/resume/fork through local Codex tooling.
```

Build/test:

```text
- URI parser for codex://threads/<id>
- codex CLI detection
- app-server startup or connection
- basic source thread read, if available
- fallback ephemeral `codex exec resume`
```

Done when:

```text
Given a thread URI, Mortic can get a Codex response tied to that thread without manually pasting context.
```

### Milestone 1: Local Web Shell

Goal:

```text
Launch a browser app from `npx mortic`.
```

Build:

```text
- CLI entrypoint
- Fastify backend
- Vite React frontend
- session status endpoint
- open browser on startup
```

Done when:

```text
npx mortic codex://threads/<id> opens a local page that shows the parsed thread id and Codex connection status.
```

### Milestone 2: Free Voice Loop

Goal:

```text
Speak into the browser and get spoken/text response back.
```

Build:

```text
- push-to-talk capture through browser SpeechRecognition
- response playback through SpeechSynthesis
- visible transcript
- backend turn endpoint
```

Done when:

```text
The user can hold Space, speak, see transcript text, get a Codex-derived text response, and hear browser TTS.
```

### Milestone 3: Scratch Isolation

Goal:

```text
Keep voice turns disposable and avoid source-thread pollution.
```

Build:

```text
- scratch session model
- append-only transcript
- app-server fork/archive if reliable
- ephemeral fallback if fork/archive is not reliable
```

Done when:

```text
Voice turns do not alter the source Codex app thread.
```

### Milestone 4: Handoff Prompt

Goal:

```text
Turn the scratch transcript into a clean handoff prompt.
```

Build:

```text
- generate handoff endpoint
- editable markdown handoff view
- copy button
- save handoff.md
```

Done when:

```text
The user can finish a voice session and paste a useful handoff into the original Codex app chat.
```

## First Implementation Decision

Start with the CLI fallback and browser voice UI if app-server thread APIs are slower to wire up.

The fastest proving loop is:

```text
npx mortic <thread-uri>
→ parse thread id
→ browser SpeechRecognition turn
→ codex exec resume <thread-id> --ephemeral
→ browser SpeechSynthesis response
→ handoff prompt
```

Then replace the Codex bridge internals with app-server `thread/read`, `thread/fork`, `turn/start`, and `thread/archive`.

## Explicit Non-Goals

```text
- hosted SaaS web app
- user accounts
- OpenAI API-key setup
- ElevenLabs setup
- branch graph
- SQLite
- VS Code extension
- always-listening microphone
- realtime speech-to-speech
- automatic writes to source thread
```

## Open Questions

```text
1. Does Codex app expose a reliable "copy thread deep link" path for all users?
2. Does `codex://threads/<id>` always map to the session id accepted by local Codex CLI/app-server?
3. Can app-server be started and controlled cleanly from a third-party local helper?
4. Does browser SpeechRecognition work well enough on the user's target browser?
5. Should the first release support only macOS, or macOS/Linux from day one?
```

## Recommended Next Step

Build Milestone 0 as a small Node script before scaffolding the full UI.

The first file should prove:

```text
node scripts/probe-thread.js codex://threads/<id>
```

and report:

```text
- parsed thread id
- codex CLI path
- codex version
- whether app-server can start
- whether fallback `codex exec resume --ephemeral` can run
```
