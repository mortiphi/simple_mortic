# Mortic API Flow, Audio Flow, and Debug Telemetry

This document explains the full Mortic runtime flow as it exists in the current codebase, with emphasis on session boot, scratch prewarm, user turns, STT, TTS, Codex app-server events, handoff generation, and what is or is not persisted for later debugging.

It also answers the specific questions raised during the investigation:

- Are audio files or chunks stored?
- What is the optional prewarm confirmation turn?
- What exactly is stored in `forkCheckpoint`?
- Is prewarm confirmation hardcoded or returned by the app-server?
- How does scratch caching work?
- What happens if model, service tier, reasoning effort, voice mode, or access policy changes?
- Why does Mortic ensure a scratch exists again for each turn?
- What are Codex app-server turns, items, reasoning deltas, agent-message deltas, and `turn/completed`?
- Where does the final output actually come from?
- Are all app-server notifications persisted?
- What are `Cache-Control`, `Blob`, object URLs, and `AudioBuffer`?
- What would need to be persisted for rich turn analysis by an LLM?

## Important Terms

### Source Codex Thread

The original Codex thread selected by the user.

Example:

```text
codex://threads/019efcad-8e15-7e21-9d71-ddc1241d0993
```

Mortic is designed not to write voice turns directly into this source thread.

### Mortic Session

A local Mortic session folder under:

```text
~/.mortic/sessions/<mortic-session-id>/
```

Primary files:

```text
session.json
transcript.md
handoff.md
```

One source Codex thread can have many Mortic sessions. One Mortic session points at one source Codex thread.

### Scratch Thread

An ephemeral Codex app-server fork created from the source thread. Mortic sends voice turns to this scratch fork, not to the source thread.

### Turn

In Mortic, a turn is one user request and one assistant response cycle.

In Codex app-server terms, a turn is also a lifecycle started by `turn/start` and completed by `turn/completed`.

### Item

An item is a unit inside a Codex app-server turn, such as:

```text
userMessage
reasoning
agentMessage
commandExecution
fileChange
mcpToolCall
```

A single turn can contain many items.

## Key Source Files

Runtime boot:

```text
src/cli/runtime.ts
```

Session storage:

```text
src/server/storage.ts
```

Fastify API routes:

```text
src/server/app.ts
```

Codex routing wrapper:

```text
src/server/codex.ts
```

Codex app-server websocket bridge:

```text
src/server/appServerBridge.ts
```

STT provider calls:

```text
src/server/stt.ts
```

TTS provider calls:

```text
src/server/tts.ts
```

Client voice pipeline:

```text
src/client/voice/useVoiceEngine.ts
```

Client TTS playback:

```text
src/client/tts.ts
```

Shared types:

```text
src/shared/types.ts
```

Prewarm confirmation text:

```text
src/shared/prewarmConfirmation.ts
```

## High-Level Flow

At a high level:

```text
Mortic starts
  -> resolve selected source Codex thread
  -> create or restore Mortic session folder
  -> start local Fastify API
  -> serve UI, either static build or Vite dev UI
  -> optionally prewarm a scratch Codex fork

User speaks
  -> browser STT or remote STT produces text
  -> client POSTs /api/turn
  -> server appends user transcript entry
  -> server creates activeTurn with logs, metrics, trace placeholders
  -> server sends turn to Codex scratch via app-server bridge
  -> app-server emits lifecycle notifications and answer deltas
  -> server streams deltas/logs to client via SSE
  -> client converts speakable answer chunks to TTS audio
  -> server appends assistant transcript entry
  -> activeTurn is finalized as completed/failed/interrupted

User asks for handoff
  -> client POSTs /api/handoff
  -> server converts Mortic transcript into a handoff prompt
  -> server asks Codex to generate short/full prompts
  -> server persists handoff fields and handoff.md
```

## Runtime Boot Flow

### Entry Point

`startMorticRuntime()` is the main boot function.

Location:

```text
src/cli/runtime.ts
```

It performs these steps:

1. Resolve the input thread reference.
2. Parse it into `sourceUri` and `threadId`.
3. Find the project root.
4. Restore runtime context from Codex rollout metadata.
5. Load env files from `~/.mortic/.env` and project `.env`.
6. Sync vendored skills.
7. Pick an API port.
8. Pick a UI port or static UI path.
9. Check Codex availability.
10. Create or restore session storage.
11. Create the Fastify app.
12. Start the API server.
13. Start Vite in dev mode if needed.
14. Optionally open the UI.
15. Optionally start background scratch prewarm.

### API and UI Ports

In dev mode, two ports can exist:

```text
API server: Fastify backend
UI server: Vite React dev server
```

Example:

```text
5153 = API
5173 = Vite UI
```

The Electron window and a normal browser can both load the same Vite UI and talk to the same API.

### Session Creation or Restoration

The server calls:

```text
createSessionStorage({
  sourceUri,
  threadId,
  codex,
  runtimeContext
})
```

Location:

```text
src/server/storage.ts
```

`createSessionStorage()` checks `~/.mortic/sessions/` for an existing session with the same `sourceUri` or `threadId`. It prefers a recent non-empty completed session. If none exists, it creates a new session.

Persisted session shape includes:

```text
id
sourceUri
threadId
createdAt
updatedAt
transcript[]
codex
runtimeContext
forkCheckpoint?
activeTurn?
queuedTurn?
handoff?
handoffShort?
handoffFull?
composerDraft?
```

## Session Storage Files

Each Mortic session writes:

```text
session.json
transcript.md
handoff.md
```

Writes are atomic:

```text
write temp file
rename temp file to final path
```

This is in `writeTextAtomic()` in `src/server/storage.ts`.

### What Is Persisted Today

Persisted:

```text
session metadata
source thread id
runtime context
visible transcript
assistant spoken/read split
raw voice output text
fork checkpoint
handoff text
one activeTurn object
```

Not persisted today:

```text
raw mic audio
STT WAV segment files
TTS MP3/PCM/audio files
all historical TurnRun telemetry
all full app-server websocket payloads
all prewarm app-server request/response details
all handoff telemetry details
```

## Prewarm Flow

Prewarm is meant to reduce first-turn latency by creating and optionally priming a scratch fork before the user speaks.

There are two prewarm paths:

1. Runtime startup prewarm.
2. UI/API prewarm through `/api/session/prewarm`.

### Startup Prewarm

In `src/cli/runtime.ts`, after the API starts, if Codex is available and the selected thread is not a placeholder, Mortic calls:

```ts
prewarmCodexScratch({
  threadId,
  runtimeContext,
  codexModel: "default",
  reasoningEffort: defaultScratchSettings.reasoningEffort,
  scratchMode: defaultScratchSettings.scratchMode,
  voiceCaveman: defaultScratchSettings.voiceCaveman,
  confirmationPrompt: startupConfirmation.prompt,
  onEvent
})
```

This path does pass a confirmation prompt.

### API Prewarm

The UI/API prewarm endpoint is:

```text
POST /api/session/prewarm
```

Location:

```text
src/server/app.ts
```

It:

1. Validates scratch mode and reasoning effort.
2. Checks no turn is currently running.
3. Computes effective scratch settings.
4. Performs model-context preflight if needed.
5. Looks up a human-readable thread name.
6. Computes local `readyText`.
7. Calls `prewarmCodexScratch()`.
8. Builds and stores a `forkCheckpoint` from prewarm logs if possible.
9. Returns prewarm status.

Important detail: this route currently computes `readyText` but does not pass `confirmationPrompt` into `prewarmCodexScratch()`. So API prewarm likely creates/warms the fork, but does not run the confirmation turn.

### Optional Confirmation Turn

The optional confirmation turn is a tiny app-server `turn/start` call inside the scratch fork.

It happens only when `prewarmCodexScratch()` receives a `confirmationPrompt`.

Startup prewarm passes one.

The `/api/session/prewarm` route currently does not appear to pass one.

### Confirmation Text

The local helper:

```ts
prewarmReadyText(threadName)
```

returns:

```text
I am ready to continue work on <threadName>
```

For voice mode, `prewarmConfirmationPrompt()` builds a prompt that tells Codex:

```text
Return exactly two newline-delimited JSON objects and nothing else.
Line 1 must be exactly {"type":"speak","text":"I am ready..."}
Line 2 must be exactly {"type":"read","markdown":""}
```

So the expected text is locally generated and hard constrained. The actual confirmation output, when a confirmation turn is run, comes back from the app-server scratch turn. But it is expected to be exactly the local phrase.

### Scratch Fork Creation

The fork is created in:

```text
src/server/appServerBridge.ts
```

Function:

```ts
ensureScratchThread(...)
```

It sends app-server request:

```text
thread/fork
```

Parameters include:

```text
threadId: sourceThreadId
model
serviceTier
cwd
approvalPolicy
sandbox
networkPolicy
config.model_reasoning_effort
developerInstructions
ephemeral: true
persistExtendedHistory: false
```

Validation:

```text
scratchThreadId must exist
scratchThreadId must not equal sourceThreadId
response.thread.ephemeral must be true
```

If validation passes, the scratch state is cached in memory.

## Scratch Cache

The scratch cache key is built by `scratchKey()`:

```text
sourceThreadId
cwd
model
serviceTier
reasoningEffort
scratchMode
voiceCaveman
scratchForkAccessKey()
developerInstructions
```

The result is a string like:

```text
source|cwd|model|tier:default|medium|voice|0|access-policy|developer-instructions
```

### What Changes the Cache Key

Changing any of these means Mortic will not reuse the old scratch entry:

```text
source thread
cwd
model
service tier
reasoning effort
scratch mode
voice caveman mode
access policy
developer instructions
```

It should create or select a different scratch for future turns.

### Why Ensure Scratch Exists Again For Every Turn

Every real user turn calls through `runCodexTurn()`.

That calls the app-server bridge, which calls `ensureScratchThread()`.

This does not mean it always forks again.

It means:

```text
look for a cached matching scratch
if found, reuse it
if missing, create a new scratch fork
```

This is necessary because:

```text
prewarm may not have run
prewarm may have failed
the server may have restarted
the user may have changed model/settings
the cwd or access policy may have changed
the scratch cache is memory-only
```

### Is The Cache Persisted?

No. The scratch cache is in memory in the app-server bridge.

`forkCheckpoint` is persisted in `session.json`, but that is not the same thing as restoring the scratch cache.

## Fork Checkpoint

`forkCheckpoint` is a structured object stored on the Mortic session.

It is not a transcript message.

It is not itself an app-server message.

It is built from prewarm logs by:

```ts
checkpointFromPrewarmLogs(...)
```

Stored shape:

```ts
{
  sourceThreadId: string;
  scratchThreadId: string;
  forkedAt: string;
  checkpointInstruction?: string;
  firstScratchTurnId?: string;
}
```

How fields are populated:

```text
sourceThreadId
  from the Mortic session threadId

scratchThreadId
  parsed from an event detail like:
  "<scratchThreadId> forked from <sourceThreadId>"

forkedAt
  current timestamp when checkpoint is created

checkpointInstruction
  supplied by endpoint caller

firstScratchTurnId
  parsed from a log whose label contains "turn started"
```

`firstScratchTurnId` is an app-server turn id, not a transcript entry id.

If no confirmation turn happened, `firstScratchTurnId` can be absent.

## Why Settings May Revert

This was not fully debugged, but the code has several normalization paths that can explain it.

### Client Local Defaults

Client settings can come from localStorage through helpers like:

```text
readStoredModel
readStoredEffort
readStoredServiceTier
readStoredScratchMode
```

These only apply if:

```text
mortic.settingsVersion === SETTINGS_VERSION
```

If the settings version changes or localStorage is unavailable, the UI falls back to defaults.

### Server Preferences

The server also stores preferences in:

```text
~/.mortic/preferences.json
```

The client applies server preferences from `/api/session`.

### Model/Reasoning/Service-Tier Normalization

The client checks whether selected reasoning effort and service tier are supported by the selected model.

If not, it resets them to defaults.

The server endpoint:

```text
PATCH /api/preferences
```

also rejects unsupported values.

So a user may observe settings "reverting" if:

```text
the selected model is not in app-server config
the selected reasoning effort is not supported by the selected model
the selected service tier is not supported by the selected model
another client snapshot overwrites local state
localStorage and server preferences disagree
settings version invalidates browser-local values
```

### Multiple Clients

Electron and a browser tab can both talk to the same backend.

Both receive `/api/session/stream` snapshots.

Both can PATCH preferences.

So a browser and Electron window can race or appear to undo each other if they have different local state and both are active.

## User Speech Flow

There are two STT modes:

```text
browser STT
remote STT
```

### Browser STT

Browser STT uses:

```text
window.SpeechRecognition
window.webkitSpeechRecognition
```

Flow:

```text
user holds push-to-talk
  -> browser SpeechRecognition starts
  -> interim transcript updates draft
  -> final transcript accumulates in browser
  -> stop push-to-talk
  -> sendTurn(text)
```

Mortic does not receive raw audio in this mode.

Chrome or the browser may send audio to its own speech service, but that is outside Mortic's server.

Persisted from this path:

```text
final recognized text
normal turn metrics after /api/turn
```

Not persisted:

```text
audio
interim transcript stream
browser provider internals
```

### Remote STT

Remote STT uses:

```text
navigator.mediaDevices.getUserMedia
AudioContext
ScriptProcessor
Float32Array chunks
WAV PCM16 encoding
POST /api/stt/transcribe
```

Flow:

```text
user holds push-to-talk
  -> getUserMedia opens microphone
  -> Web Audio captures Float32 chunks
  -> RMS threshold detects speech
  -> chunks segment on soft/hard limits
  -> Float32 chunks are merged
  -> audio is downsampled to 16 kHz
  -> audio is encoded as WAV PCM16
  -> WAV bytes are base64 encoded
  -> client POSTs each segment to /api/stt/transcribe
  -> server forwards audio to selected STT provider
  -> server returns text
  -> client joins segment texts
  -> client calls sendTurn(finalText, sttMetrics)
```

Segment creation is in:

```text
makeAudioSegment()
```

Remote transcription is in:

```text
transcribeRemoteAudio()
```

### Remote STT Server Endpoint

Endpoint:

```text
POST /api/stt/transcribe
```

Request:

```ts
{
  provider?: SttProvider;
  audioBase64: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  segmentIndex?: number;
  segmentCount?: number;
  recordingSessionId?: number;
}
```

Server behavior:

```text
decode base64 to Buffer
check size limit
send bytes to Deepgram/Inworld/Whisper
return text/provider/model/elapsedMs
fallback across configured providers if needed
```

### Are STT Audio Files Stored?

No.

Remote STT audio exists as:

```text
Float32 chunks in browser memory
WAV bytes in browser memory
base64 JSON payload over HTTP
Buffer in server memory
provider request body
```

Then it is discarded.

Persisted today:

```text
sttProvider
requestedProvider
segmentCount
payloadBytes
recordingDurationMs
recordingStartedAt
recordingStoppedAt
firstSpeechDetectedMs
firstFinalTranscriptMs
finalSttReadyMs
sendAfterSpeechMs
fallbackReason
recognitionErrors
```

Not persisted:

```text
Float32 chunks
WAV bytes
base64 audio
provider raw response
per-segment full debug history
```

## Turn Start Flow

Client calls:

```text
POST /api/turn
```

Request includes:

```text
text
reasoningEffort
codexModel
serviceTier
codexRuntimePolicy
scratchMode
voiceCaveman
sttMetrics
transportProvider
inputPolicy
clientId
surface
transportState
transportStats
```

Server behavior:

1. Validate text and reasoning effort.
2. Compute effective scratch settings.
3. Run spark/model-context preflight if needed.
4. If a turn is already running, store queued turn and return 202.
5. Create a user transcript entry.
6. Create a new Mortic `TurnRun`.
7. Store it as `session.activeTurn`.
8. Append the user entry to `transcript`.
9. Start async Codex work.
10. Return `{ turnId, session }`.

Initial `TurnRun` stores:

```text
id
status: running
userText
reasoningEffort
codexModel
serviceTier
codexRuntimePolicy
scratchMode
voiceCaveman
createdAt
updatedAt
logs[]
metrics{}
appServerTrace?
progressTrace?
```

## Codex App-Server Turn Flow

The server async task calls:

```ts
runCodexTurn(...)
```

`runCodexTurn()` prefers the app-server bridge:

```text
Bridge selected: persistent codex app-server scratch
```

It falls back to CLI fork only if allowed and applicable.

### App-Server Request

The bridge sends:

```text
turn/start
```

Request includes:

```text
threadId: scratchThreadId
input: [{ type: "text", text: prompt }]
model
serviceTier
sandboxPolicy
approvalPolicy
effort
summary
outputSchema
```

The immediate response gives a Codex app-server turn id:

```text
response.turn.id
```

That response is not the final assistant answer.

### Notifications

After `turn/start`, the app-server websocket sends notifications.

Important notifications:

```text
turn/started
item/started
item/reasoning/summaryPartAdded
item/reasoning/summaryTextDelta
item/reasoning/textDelta
turn/plan/updated
turn/diff/updated
item/commandExecution/outputDelta
item/mcpToolCall/progress
item/agentMessage/delta
item/completed
thread/tokenUsage/updated
turn/completed
error
```

### Turn vs Item

Turn:

```text
one whole user request lifecycle
```

Item:

```text
one object/event inside the turn
```

Examples:

```text
userMessage item
reasoning item
agentMessage item
tool call item
command output item
file change item
```

### Reasoning Delta vs Agent Message Delta

Reasoning deltas:

```text
item/reasoning/summaryTextDelta
item/reasoning/textDelta
```

These are progress/thinking/summary events. Mortic uses them for debug traces and possible progress speech before the actual answer begins.

Agent message deltas:

```text
item/agentMessage/delta
```

These are actual assistant answer text. Mortic streams these to the client and uses them to generate live speech.

### Where The Final Output Comes From

The final assistant output is built from websocket notifications, not from the immediate `turn/start` response.

The bridge accumulates:

```text
agentMessage delta text
```

It can also use:

```text
final agentMessage item text
```

When `turn/completed` arrives, the bridge chooses the completed text and resolves the `runCodexTurn()` promise with that text.

So:

```text
turn/start response
  -> gives turn id only

websocket notifications
  -> provide progress, deltas, final text, completion

runCodexTurn promise
  -> resolves with final assistant text after turn/completed
```

### What Is `turn/completed`?

`turn/completed` is the app-server notification that the Codex turn is done.

When the bridge receives it:

1. It finds the pending turn by id.
2. It removes it from `pendingTurns`.
3. It chooses final text from stream/final item.
4. It logs `App-server turn completed`.
5. It resolves the pending promise.

Then `src/server/app.ts` creates an assistant transcript entry.

## Mortic Server Trace and Logs

During the Codex turn, `src/server/app.ts` wires callbacks:

```text
onDelta
onEvent
onProgress
onVoiceActivity
onProgressTrace
```

These update:

```text
activeTurn.logs
activeTurn.metrics
activeTurn.appServerTrace
activeTurn.progressTrace
turnReplay
SSE turn stream
```

### `onDelta`

Receives actual assistant answer text from `item/agentMessage/delta`.

It:

```text
updates replay text
emits SSE event type "delta"
```

Client receives it and starts showing/speaking partial answer text.

### `onEvent`

Receives bridge lifecycle labels like:

```text
Runtime context
Bridge selected
App-server turn/start sent
App-server turn started
App-server first model delta
App-server turn completed
```

It stores these in `activeTurn.logs`.

It also derives metrics:

```text
appTurnStartMs
firstDeltaMs
modelWaitMs
```

### `onProgressTrace`

Receives normalized raw/mapped app-server events.

It stores:

```text
rawNotifications[]
mappedEvents[]
firstAssistantDeltaMs
```

### `onProgress`

Converts some app-server progress into possible spoken status text, such as a short "thinking" style update before first answer delta.

It records decisions:

```text
eligible
spoken
suppressed
```

Suppression reasons include:

```text
feature-disabled
not-voice
turn-not-running
no-speakable-text
after-first-assistant-delta
max-statuses
repeat
throttled
unsafe
```

### Are All Notifications Persisted?

No.

Persisted today:

```text
normalized raw notification summary:
  elapsedMs
  method
  turnId
  itemType
  itemId
  detail

mapped events:
  elapsedMs
  kind
  label
  itemType
  detail

activities
decisions
logs
metrics
```

Not persisted:

```text
full original websocket notification payload
all request payloads
all response payloads
historical telemetry for every completed turn
```

Also important: this is stored under `session.activeTurn`. The session does not currently keep a durable `turnRuns[]` history.

## Turn Stream To Client

Client uses:

```text
GET /api/turn/:turnId/stream
```

This is an SSE stream.

SSE events include:

```text
snapshot
log
status
voiceActivity
delta
completed
failed
interrupted
```

If EventSource is unavailable, client falls back to polling:

```text
GET /api/turn/:turnId
```

## Assistant Voice Output

There are multiple TTS paths.

### Browser TTS

Uses:

```text
SpeechSynthesisUtterance
```

There is no audio file in Mortic.

### HTTP TTS

Example endpoint:

```text
POST /api/tts/deepgram/stream
POST /api/tts/elevenlabs/stream
```

Server forwards text to provider and streams audio bytes back to client.

The client can create:

```text
Blob
object URL
HTMLAudioElement
```

or decode bytes into:

```text
AudioBuffer
```

depending on provider path.

### WebSocket TTS

Endpoints:

```text
GET /api/tts/elevenlabs/ws
GET /api/tts/deepgram/ws
GET /api/tts/inworld/ws
```

Server opens upstream provider websocket.

Provider audio arrives as base64 PCM/WAV-like chunks.

Client decodes chunks and schedules playback with Web Audio.

### Blob, Object URL, AudioBuffer

Blob:

```text
browser binary object holding audio bytes
```

Object URL:

```text
temporary local URL pointing at a Blob
```

Example:

```text
blob:http://127.0.0.1:5173/...
```

AudioBuffer:

```text
decoded PCM audio data inside Web Audio API
```

HTMLAudioElement path:

```text
Blob -> object URL -> new Audio(objectUrl) -> play
```

Web Audio path:

```text
ArrayBuffer/base64 -> decodeAudioData or PCM decode -> AudioBuffer -> AudioBufferSourceNode -> speakers
```

### Are TTS Audio Files Stored?

No.

Persisted today:

```text
ttsProvider
streamedChars
queuedChars
spokenChars
queuedRanges
spokenRanges
spokenChunks
firstTtsRequestMs
firstTtsResolvedMs
firstAudioChunkMs
firstAudioPlayMs
firstSpeechStartMs
firstSpeechEndMs
audioBufferUnderruns
ttsCloseCode
ttsCloseReason
ttsProviderStatus
ttsError
```

Not persisted:

```text
MP3 files
PCM files
base64 TTS chunks
Blob contents
Object URLs
AudioBuffers
per-chunk byte sizes
per-chunk provider raw payloads
```

## Audio Health Endpoint

The client tracks TTS/audio playback timing locally and posts it back:

```text
POST /api/turn/:turnId/audio-health
```

This updates the server-side `activeTurn.metrics`.

Fields include:

```text
provider
streamedChars
finalChars
queuedChars
spokenChars
queuedRanges
spokenRanges
spokenChunks
firstClientDeltaMs
firstVisibleTextMs
firstSpeakableTextMs
firstSpeechQueuedMs
firstTtsRequestMs
firstTtsResolvedMs
firstSpeechStartMs
firstSpeechEndMs
ttsConnectMs
firstAudioChunkMs
firstAudioPlayMs
audioBufferUnderruns
finalTextMs
speechAfterFinalMs
barge-in timings
```

This is good telemetry, but today it lands on the single `activeTurn`.

## Cache-Control

`Cache-Control` is an HTTP response header that tells browsers and proxies how to cache a response.

For TTS audio streams, Mortic sends:

```text
Cache-Control: no-store
```

Meaning:

```text
do not store this response in browser/proxy cache
```

This is important for privacy and to avoid stale audio.

For SSE streams, Mortic sends:

```text
Cache-Control: no-cache, no-transform
```

Meaning:

```text
do not cache the live stream
do not transform/rebuffer/compress it in a way that breaks streaming
```

## Handoff Flow

Endpoint:

```text
POST /api/handoff
```

Flow:

1. Read current session.
2. Generate transcript markdown.
3. Remove source-thread header from transcript.
4. Build handoff prompt with optional checkpoint context.
5. Try Codex app-server turn with `requireAppServer: true`.
6. If that fails, fallback to isolated local Codex exec.
7. Validate `# Short Prompt` and `# Full Prompt`.
8. Store handoff fields.
9. Write `handoff.md`.

Persisted:

```text
handoff
handoffShort
handoffFull
handoff.md
```

Not persisted today:

```text
handoff app-server turn id
handoff request timing
handoff app-server notifications
isolated fallback telemetry
full error chain
```

## Current Eval Harness Reality

The runtime eval harnesses can capture per-turn telemetry while they are actively running because they:

```text
POST /api/turn
receive turnId
poll /api/turn/:turnId
read active turn metrics/logs/trace
write their own eval result
```

Examples:

```text
scripts/eval_mortic_runnability.mjs
scripts/eval_progress_speech.mjs
scripts/probe_app_server_events.mjs
```

But normal user sessions do not currently persist all completed turn telemetry into a historical array.

Therefore:

```text
eval run output can contain multi-turn telemetry
ordinary session.json generally contains transcript plus one activeTurn telemetry bundle
```

## Current Persistence Gaps

For later LLM analysis of an actual conversation, current storage is insufficient for deep operational reconstruction.

An LLM can study:

```text
what the user said
what the assistant said
spoken/read split
parser behavior in assistant entries
source thread id
runtime context
fork checkpoint
handoff output
one activeTurn telemetry object
```

An LLM cannot fully answer:

```text
which turn was slowest across the whole session
which STT segment failed in turn 3
what TTS audio chunks were generated in turn 5
whether every turn reused the same scratch
how long prewarm fork request took
what exact app-server notifications arrived for every turn
what happened during handoff generation
whether audio buffering got worse over the session
```

## Recommended Rich Debug Persistence

The highest-value change is to persist structured run history, not build a UI first.

### Session-Level Runs

Add:

```ts
prewarmRuns?: PrewarmRun[];
handoffRuns?: HandoffRun[];
turnRuns?: TurnRun[];
```

### PrewarmRun

Useful fields:

```text
id
startedAt
completedAt
sourceThreadId
cwd
model
serviceTier
reasoningEffort
scratchMode
voiceCaveman
accessPolicy
cacheKey
cacheHit
scratchThreadId
forkStartedAt
forkCompletedAt
forkElapsedMs
confirmationPromptSent
confirmationTurnId
confirmationStartedAt
confirmationCompletedAt
confirmationElapsedMs
confirmationText
logs[]
errors[]
```

### TurnRun History

Today `TurnRun` exists but only as `activeTurn`.

Persist every finalized turn into:

```text
session.turnRuns[]
```

Each turn should link to transcript entries:

```text
userEntryId
assistantEntryId / responseEntryId
appServerTurnId
scratchThreadId
```

Keep:

```text
logs[]
metrics{}
appServerTrace
progressTrace
parser info
errors
fallbacks
```

### STT Run Details

Add:

```text
sttRuns[]
```

or nest under each turn:

```text
turn.stt
```

Useful fields:

```text
provider
requestedProvider
fallbackChain
recordingSessionId
recordingStartedAt
recordingStoppedAt
recordingDurationMs
firstSpeechDetectedMs
segmentCount
segments[]
  index
  bytes
  durationMs
  startedOffsetMs
  stoppedOffsetMs
  providerElapsedMs
  textChars
  error
payloadBytes
finalTextChars
finalSttReadyMs
sendAfterSpeechMs
```

### TTS Run Details

Add:

```text
ttsRuns[]
```

or nest under each turn:

```text
turn.tts
```

Useful fields:

```text
provider
fallbackChain
chunks[]
  index
  textStart
  textEnd
  textChars
  requestedAtMs
  firstAudioChunkMs
  resolvedMs
  firstPlayMs
  bytes if known
  format if known
  error
queuedRanges
spokenRanges
spokenChunks
bufferUnderruns
closeCode
closeReason
```

### App-Server Notification Details

Store more complete notification summaries per turn:

```text
method
elapsedMs
turnId
threadId
itemId
itemType
itemStatus
deltaChars
detailPreview
rawPayloadPreview or redactedRawPayload
```

Avoid storing huge raw payloads forever by default.

### HandoffRun

Useful fields:

```text
id
startedAt
completedAt
model
reasoningEffort
serviceTier
attempts[]
  kind: app-server | isolated
  startedAt
  completedAt
  elapsedMs
  turnId
  generatedBy
  error
shortPromptBytes
fullPromptBytes
```

## Raw Audio Storage Recommendation

Do not store raw audio by default.

Voice recordings are sensitive.

Recommended modes:

```text
off
metadata
samples
```

### off

No audio media stored.

### metadata

Store only:

```text
segment count
segment duration
segment bytes
sample rate
format
provider timings
text chars
```

This should be the default rich analytics mode.

### samples

Store actual WAV/TTS chunks for a small number of turns only.

Recommended safeguards:

```text
explicit opt-in
visible indicator
small retention limit
delete button
never include in handoff
never commit to repo
store under session debug folder
```

Possible path:

```text
~/.mortic/sessions/<session-id>/debug-audio/<turn-id>/
  stt-segment-000.wav
  tts-chunk-000.mp3
  manifest.json
```

## Suggested First Implementation Direction

The first useful implementation should be storage-only:

1. Add `turnRuns?: TurnRun[]` to `MorticSession`.
2. On terminal turn states, append finalized `activeTurn` to `turnRuns`.
3. Link `userEntryId` and `responseEntryId`.
4. Add prewarm run persistence.
5. Add handoff run persistence.
6. Expand STT/TTS metadata, still no raw audio by default.
7. Add a small export script to produce JSON/CSV for LLM analysis.

No UI is required at first.

## Summary

Current Mortic already has most of the runtime measurements needed to understand performance:

```text
STT timing
model/app-server timing
first delta timing
TTS timing
audio playback timing
progress trace
app-server lifecycle events
parser output
fallback/error notes
```

But the storage model is too shallow for retrospective analysis of an entire real conversation. It stores the full transcript, but only one rich `activeTurn` bundle.

For the workflow "ask an LLM what happened in this voice session," the critical improvement is durable structured persistence:

```text
prewarmRuns[]
turnRuns[]
stt metadata
tts metadata
handoffRuns[]
optional short-lived debug audio samples
```

Once that exists, a debug UI is optional. The session JSON itself becomes the debuggable artifact.
