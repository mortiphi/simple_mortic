# Mortic

Mortic is a local voice sidecar for Codex threads.

## Run

```bash
npm install
npm run build
npm run start -- codex://threads/<thread-id>
```

For development:

```bash
npm run dev -- codex://threads/<thread-id>
```

The command starts a localhost web app and uses the existing Codex CLI login. No OpenAI API key or paid voice provider is required for the MVP.

You can also paste a different `codex://threads/<thread-id>` link into the Source thread field in the web app. Switching source threads starts a fresh scratch transcript for that source.

## Voice

Mortic keeps browser-native speech APIs as the free fallback, but the voice layer has explicit STT and TTS provider selection:

```text
STT:
- Deepgram Nova-2 when DEEPGRAM_API_KEY is set
- Inworld STT when INWORLD_API_KEY is set
- Whisper when OPENAI_API_KEY is set
- browser SpeechRecognition fallback

TTS:
- Inworld WebSocket when INWORLD_API_KEY is set
- Deepgram Aura when DEEPGRAM_API_KEY is set
- ElevenLabs WebSocket / REST when ELEVENLABS_API_KEY is set
- browser SpeechSynthesis fallback
```

Chrome is the first supported target. If remote STT credentials are missing or browser speech recognition is unavailable, use the text box.

Optional STT configuration:

```bash
MORTIC_STT_PROVIDER=deepgram-stt
DEEPGRAM_STT_MODEL=nova-2
MORTIC_STT_INWORLD_MODEL=inworld/inworld-stt-1
MORTIC_STT_WHISPER_MODEL=whisper-1
MORTIC_STT_LANGUAGE=en-US
MORTIC_MAX_STT_PAYLOAD_MB=8
```

Optional TTS configuration:

```bash
MORTIC_TTS_PROVIDER=deepgram
DEEPGRAM_API_KEY=...
DEEPGRAM_TTS_MODEL=aura-2-thalia-en
DEEPGRAM_TTS_TIMEOUT_MS=15000
```

If the app shows that microphone or browser speech recognition is not allowed, the browser denied speech capture for the localhost page. Allow microphone access for the page or use the text box fallback.

Click `Start Voice` to begin capture, then `Stop & Send` when you are done. Remote STT capture rolls over into smaller segments around 10 seconds of silence-friendly audio and hard-rolls around 18 seconds so long speech does not become one oversized request. If the browser ends recognition early, Mortic restarts it while the capture is active and only submits when you stop.

The optional `Space PTT` checkbox enables keyboard push-to-talk. It is off by default so this localhost page does not steal the spacebar or microphone focus from the regular Codex app dictation. Mortic also stops browser recognition when the page loses focus.

## Transport And Input Policy

Mortic separates audio transport from input policy:

```text
Transport:
- Local Browser
- LiveKit WebRTC when LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are set

Input control:
- Push-to-talk accepts audio only while the user explicitly starts/holds/stops capture
- Live mode keeps capture open and uses local voice activity timing to decide when to finalize a turn
```

LiveKit setup:

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

The LiveKit docs MCP was installed with:

```bash
codex mcp add --url https://docs.livekit.io/mcp livekit-docs
```

A fresh Codex session may be required before those MCP tools appear in the tool list.

## Turn Timing

Each turn shows live timing for:

```text
request received
utterance prepared
bridge selected
CLI fork process started
CLI PTY ready
app-server scratch fork validated
app-server turn/start sent
app-server first model delta
app-server turn completed
assistant response appended
```

The panel also shows utterance bytes, estimated utterance tokens, UI dispatch latency, Codex latency, and total latency. Normal voice turns do not send Mortic's saved transcript back into Codex; the local transcript is only used later to generate a handoff summary.

## Reasoning Effort

Each voice/manual turn includes a model field and a reasoning selector.

The default model is:

```text
gpt-5.4-mini
```

This keeps the voice loop on the lowest-latency Codex model by default and avoids inheriting a too-new global Codex config, such as `gpt-5.5` on an older Codex CLI. Override it with:

```bash
MORTIC_CODEX_MODEL=gpt-5.4 npm run start -- codex://threads/<thread-id>
```

Or edit the Model field in the UI.

The reasoning options are:

```text
none, minimal, low, medium, high, xhigh
```

The app-server scratch bridge passes this to Codex turn requests. The verified CLI fallback passes it as:

```bash
codex fork -m '<model>' -c 'model_reasoning_effort="<effort>"' <thread-id>
```

The UI defaults to `none` so it can override a stronger global Codex config during voice scratch sessions.

## Current Bridge

Mortic first tries a persistent Codex app-server bridge:

```text
codex app-server
thread/fork ephemeral=true
validate scratch thread id != source thread id
turn/start on the scratch thread
read assistant deltas from app-server
```

Normal app-server turns do not add marker instructions. The goal is to match Codex app/view latency by using the same structured turn protocol instead of driving and scraping the terminal UI.

If app-server fails, Mortic falls back to a verified Codex CLI PTY bridge:

```text
codex fork <thread-id>
wait for a new session_meta with forked_from_id=<thread-id> and id!=<thread-id>
type the current voice utterance into the TUI
press Enter
read the answer from the validated fork rollout file
```

For voice scratch turns, Mortic disables configured MCP servers and Codex update checks on the forked CLI process. This avoids waiting on unrelated MCP startup or update prompts. To keep MCP enabled for experiments:

```bash
MORTIC_ENABLE_CODEX_MCP=1 npm run start -- codex://threads/<thread-id>
```

The CLI fallback starts `codex fork` without the voice utterance as a startup prompt. It only types the utterance after it has found and validated the new fork rollout file. That guard checks:

```text
session_meta.type=session_meta
session_meta.payload.id != source thread id
session_meta.payload.forked_from_id == source thread id
session_meta.payload.cwd == Mortic project folder
session_meta.payload.source == cli
```

Fallback to `codex exec resume` is disabled by default because it does not prove it is writing to a scratch thread. To experiment with that unsafe fallback, opt in explicitly:

```bash
MORTIC_ALLOW_UNVERIFIED_CODEX_FALLBACKS=1 npm run start -- codex://threads/<thread-id>
```

Clearing the scratch transcript or switching source threads also drops the cached live app-server scratch and verified CLI fork, so the next turn starts from a fresh fork.

When a live Mortic fork is no longer needed, Mortic archives its Codex rollout file. This happens when:

```text
the user generates a handoff
the scratch transcript is cleared
the source thread is switched
the Mortic server shuts down
```

Archive cleanup is best-effort and only targets Codex rollout files whose `session_meta.forked_from_id` matches the source thread and whose working directory is the Mortic project folder. Archived fork files move to:

```text
~/.codex/archived_sessions/
```

## Local Files

Scratch sessions are stored under:

```text
~/.mortic/sessions/
```

Each session writes:

```text
session.json
transcript.md
handoff.md
```
