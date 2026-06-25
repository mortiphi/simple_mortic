# Mortic Voice Pipeline

## Current Local Path

Mortic stays a local browser sidecar around a disposable Codex scratch fork.

```text
browser mic
  -> STT provider
  -> Codex scratch turn
  -> Mortic voice-output parser
  -> TTS provider
  -> transcript + handoff prompt
```

The source Codex thread is only read/forked. Voice turns go to the scratch thread, and the user leaves with a handoff prompt.

## STT Providers

Priority is:

```text
Inworld STT -> Whisper -> Browser SpeechRecognition
```

Inworld and Whisper run through the local server so API keys stay out of the browser. Browser SpeechRecognition remains available when credentials are absent or remote STT is not desired.

Remote STT records WAV segments in the browser, sends each segment to `/api/stt/transcribe`, and lets the server use the requested provider with fallback:

```text
inworld-stt request -> Inworld STT, then Whisper if configured
whisper request -> Whisper, then Inworld if configured
browser request -> browser-native recognition only
```

Segments soft-roll around 10 seconds and hard-roll around 18 seconds or a local byte threshold. The server still enforces a configurable body cap through `MORTIC_MAX_STT_PAYLOAD_MB`; payload limits are not removed.

Push-to-talk and Live mode share the same capture machinery:

- Push-to-talk submits only after explicit stop/release/send.
- Live mode keeps listening and finalizes when local voice activity timing sees the end of a user turn.
- Both paths use per-session IDs so stale recognition callbacks or late segment responses cannot leak into a new turn.

## TTS Providers

Priority is configurable in the UI:

```text
Inworld WS -> ElevenLabs WS -> ElevenLabs REST -> Browser SpeechSynthesis
```

WebSocket providers keep one local socket per assistant turn. The client only sends monotonic speakable text ranges, and Browser TTS remains the fallback. A short finish delay is used so final text does not close the upstream provider before the last audio chunk has a chance to arrive.

## LiveKit Direction

LiveKit should be treated as the audio/session transport layer, not a replacement for the Codex scratch architecture.

Best future fit:

```text
LiveKit room
  -> participant audio, VAD, barge-in, reconnection
  -> Mortic STT/TTS adapters or LiveKit Inference
  -> same Codex scratch turn API
  -> same handoff prompt
```

Before coding LiveKit-specific APIs, verify current SDK signatures against live docs or the LiveKit MCP server. The local MVP should continue to run without LiveKit credentials.

The MCP server has been added globally with:

```bash
codex mcp add --url https://docs.livekit.io/mcp livekit-docs
```

This running Codex session did not hot-load the new MCP tools, so this iteration uses official LiveKit docs plus an env-gated client/server transport wrapper. A fresh Codex session should expose the MCP docs tools.

Current LiveKit implementation:

- Server endpoint `/api/livekit/status` reports configuration.
- Server endpoint `/api/livekit/token` creates a room token when LiveKit env vars are present.
- Client transport can connect to LiveKit, publish a microphone track, keep it muted by default, expose reconnect state, audio level, track state, jitter, round-trip time, packet loss, and reconnect count where available.
- Input policy remains separate from transport: Push-to-talk and Live both drive when audio is accepted and when text is submitted to Codex.

## Fork Checkpoints

At voice prewarm, Mortic stores a checkpoint when the app-server returns a validated scratch fork:

```text
sourceThreadId
scratchThreadId
forkedAt
checkpointInstruction
firstScratchTurnId when available
```

Handoff generation uses this checkpoint only as conversion guidance: prioritize post-checkpoint decisions, actionables, risks, tests, and conclusions, and treat inherited source context as background. The handoff prompt itself must remain paste-ready user instructions for the original Codex thread.

## Test Bar

Minimum checks before treating a voice path as stable:

- STT provider status selects the right default and fallback order.
- Voice-output parser keeps `speak.text` and `read.markdown` separate.
- TTS queued ranges are monotonic and do not replay final text.
- Smaller-model context gating never mutates the source thread.
- Browser UI shows mic, Codex, speech, handoff, and provider errors clearly.
- Push-to-talk does not submit before explicit stop/release/send.
- Live mode can finalize a turn through voice activity timing.
- Long speech uses segmented STT and does not hit payload-too-large.
- Fork checkpoint metadata is present for voice scratches and handoff generation prioritizes post-checkpoint content.
