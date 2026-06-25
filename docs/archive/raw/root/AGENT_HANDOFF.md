# simple_mortic Agent Handoff

Snapshot date: 2026-06-15

This directory is a source snapshot of:

```text
/Users/aeroknight/Downloads/as/Mortic - Claude Ver
```

copied into:

```text
/Users/aeroknight/Downloads/as/simple_mortic
```

The copy intentionally excludes heavyweight/private/generated state:

```text
.git/
node_modules/
dist/
.env
.DS_Store
```

That means this folder is not currently a Git repo and is not prebuilt. Run `npm install` before development, then use `npm run dev` or `npm run build`. If you want this branch to diverge independently, initialize Git inside `simple_mortic` rather than using the parent `Codex Voice` repo.

## Product Thesis

Mortic is a local voice sidecar and canonical project-memory layer for Codex CLI threads.

The core promise is:

```text
Speak to an existing Codex thread without polluting it.
Turn useful scratch work into reviewable canonical project state.
Keep provider conversations/forks as evidence, not as the primary source of truth.
```

The current product is Codex-only. There is an adapter seam, but Claude/Gemini/Antigravity providers are out of scope for this phase.

Mortic has two intertwined models:

1. Provider fork tree
   - Source/main Codex thread.
   - Ephemeral scratch fork for voice work.
   - Optional persisted/resumable forks later.
   - Provider thread ids remain metadata.

2. Canonical chart
   - Mortic-owned project truth.
   - Approved deltas create canonical checkpoints.
   - Draft compilations do not mutate canonical truth until approved.
   - Conversation artifacts bridge provider work into canonical state.

Trace path:

```text
source/master fork
  -> scratch/resumable fork
  -> transcript/handoff/compilation artifact
  -> approved delta
  -> canonical checkpoint
  -> optional handoff back to parent
```

## Current Status

The source Claude repo was clean except one intended uncommitted client fix when copied:

```text
M src/client/App.tsx
```

That change is included in this snapshot. It fixes the confirmed Recent-thread project switch bug where old project deltas could remain visible after selecting a thread from another workspace.

The source Claude repo was also:

```text
main...origin/main [ahead 27]
```

So do not assume GitHub has all of this code unless those commits have since been pushed.

Validation already run in the source directory after the latest bug fix:

```bash
npm run typecheck
npm test
```

Both passed.

Browser smoke also passed against a local dev instance:

- Started Mortic on `http://127.0.0.1:5262`.
- Loaded Codex Voice project: Project Updates showed `8 to review`, `27 Approved`.
- Switched through the actual Recent picker to another workspace thread.
- Immediate and final UI both showed the new project with `0 to review`, `0 Approved`.
- Old Codex Voice deltas did not remain visible.

## How To Run

From this directory:

```bash
cd "/Users/aeroknight/Downloads/as/simple_mortic"
npm install
npm run dev -- codex://threads/<thread-id>
```

Useful fixed-port dev command:

```bash
npm run dev -- codex://threads/<thread-id> --no-open --api-port 5262 --ui-port 5263
```

For packaged-style build:

```bash
npm run build
npm start -- codex://threads/<thread-id>
```

Doctor:

```bash
npm run build
node dist/node/cli/main.js doctor
```

The intended public command, after packaging, is:

```bash
npx mortic codex://threads/<thread-id>
```

## Environment And Local State

Mortic reads optional BYOK voice keys from:

```text
~/.mortic/.env
repo .env              dev only, not copied here
real environment vars  highest precedence
```

Do not commit `.env` or secrets.

Main local state locations:

```text
~/.mortic/
  sessions/
    <session-id>/
      session.json
      transcript.md
      handoff.md
      handoff_short.md
      handoff_full.md
  projects/
    <project-id>/
      project.json
      production.json
      production.md
      extracted_items.json
      extracted_items.md
      canonical_chart.json
      provider_forks.json
      source_threads/
      source_checkpoints/
      sessions/

~/.codex/
  sessions/
  archived_sessions/
  skills/
```

Vendored skills in this repo are synced to `~/.codex/skills` at boot.

## Safety Invariants

These are non-negotiable.

1. Source Codex thread must not receive voice turns.
2. Voice turns go to a validated scratch fork created through the Codex app-server when possible.
3. CLI fallback may type only into a verified Codex fork whose rollout file proves:
   - scratch id differs from source id
   - forked_from_id matches source
   - cwd matches expected runtime context
4. Do not enable `MORTIC_ALLOW_UNVERIFIED_CODEX_FALLBACKS`.
5. Voice default reasoning effort is `none`.
6. Normal voice turns must not use `minimal`; Codex rejects some tools with minimal reasoning.
7. Project/archive/write failures must not break an active voice turn unless the provider bridge itself failed.
8. Canonical state changes happen only through approved deltas/checkpoints.

## Main Architecture

### CLI Boot

Entry:

```text
src/cli/main.ts
```

Responsibilities:

- Parse CLI args and Codex thread URI.
- Load `.env` from `~/.mortic/.env` and dev repo `.env`.
- Resolve runtime context for the Codex thread.
- Sync vendored skills to `~/.codex/skills`.
- Create session storage under `~/.mortic/sessions`.
- Create project store under `~/.mortic/projects`.
- Start Fastify API and either serve built client or Vite dev UI.
- Run boot scratch prewarm with default scratch settings.
- Provide `mortic doctor`.

Key detail:

```text
src/shared/scratchDefaults.ts
```

is the single source of truth for initial scratch settings:

```ts
scratchMode: "voice"
reasoningEffort: "none"
voiceCaveman: false
```

The CLI boot prewarm must match those values exactly or the first browser prewarm creates a second scratch fork.

### Server API

Main API:

```text
src/server/app.ts
```

Important route groups:

```text
GET  /api/health
GET  /api/onboarding
GET  /api/session
POST /api/session/source
POST /api/session/clear
POST /api/session/prewarm
POST /api/session/spark-context/compact
GET  /api/session/spark-context

POST /api/turn
GET  /api/turn/:turnId
GET  /api/turn/:turnId/stream
POST /api/turn/:turnId/interrupt
POST /api/turn/:turnId/audio-health

POST /api/handoff

GET  /api/project
GET  /api/project/canonical-state
GET  /api/project/chart
GET  /api/project/artifacts/:artifactId
POST /api/project/session/commit
POST /api/project/session/archive
PATCH /api/project/extractions/:itemId
POST /api/project/compilations/:compilationId/approve
POST /api/project/draft-compilations/import
GET  /api/project/coverage/latest
POST /api/project/fork/access

GET  /api/provider/threads

POST /api/stt/transcribe
TTS endpoints for Deepgram, Inworld, ElevenLabs, browser fallback support
```

Important recent server fix:

`POST /api/session/source` rebuilds the project store when the new thread resolves to a different workspace. This prevents writes for project B landing in project A after a Recent-thread switch.

### Codex Provider Adapter

Main file:

```text
src/server/providerAdapters.ts
```

This is the only place that should spawn or execute the `codex` provider binary. There is a test that greps for violations.

Responsibilities:

- Codex binary path abstraction.
- `codex login status` parsing.
- `codex --version` status.
- Recent local Codex thread discovery by scanning `~/.codex/sessions`.
- Provider reference construction for source and scratch threads.
- Provider metadata:
  - provider
  - providerRefId
  - accountId
  - conversationId/threadId
  - forkKind
  - ephemeral/persisted
  - cwd
  - accessPreset
  - capabilities
  - openTarget
  - action availability and disabled reasons

Initial provider is Codex only.

### Codex Bridge

Router:

```text
src/server/codex.ts
```

Preferred bridge:

```text
src/server/appServerBridge.ts
```

Fallback bridge:

```text
src/server/cliPtyBridge.ts
scripts/codex_pty_worker.py
```

Important bridge behavior:

- App-server bridge starts Codex app-server and uses JSON-RPC.
- It calls `thread/fork` for an ephemeral scratch.
- It validates scratch thread id before `turn/start`.
- It streams deltas into server-side turn streams.
- First-turn warm path has single-flight `ensureReady()` / scratch fork dedupe.
- CLI PTY fallback is POSIX best-effort and must validate rollout files before typing.

### Voice Engine

Main React hook:

```text
src/client/voice/useVoiceEngine.ts
```

This was extracted from `App.tsx` and owns:

- Push-to-talk recognition.
- Local browser STT.
- Remote STT capture and segmented WAV upload.
- LiveKit transport glue, though live mode is disabled in this phase.
- SSE turn stream handling.
- Speech queue and speech ledger.
- TTS provider runtime:
  - browser
  - Deepgram
  - ElevenLabs REST
  - ElevenLabs WS
  - Inworld WS
- Audio health telemetry.
- Progress sound handling.
- Interrupt behavior.

Voice projection helpers:

```text
src/shared/speechProjection.ts
src/shared/voiceResponse.ts
src/client/lib/voice.ts
src/client/tts.ts
src/server/tts.ts
src/server/stt.ts
```

STT failure attribution fix:

```text
src/shared/sttFailure.ts
```

This prevents blaming the requested provider for another fallback provider's credit/quota failure.

### Client App And Components

Main orchestration:

```text
src/client/App.tsx
```

Extracted components:

```text
src/client/components/ProjectPanels.tsx
src/client/components/ChartModal.tsx
src/client/components/SessionModals.tsx
src/client/components/TelemetryPanel.tsx
src/client/components/ForkActionSheet.tsx
src/client/components/ThreadPicker.tsx
src/client/components/OnboardingScreen.tsx
src/client/components/Markdown.tsx
```

Client libs:

```text
src/client/lib/api.ts
src/client/lib/clientTypes.ts
src/client/lib/format.ts
src/client/lib/labels.ts
src/client/lib/spark.ts
src/client/lib/voice.ts
```

Important UI concepts:

- Side rail is a fork/chart scaffold, not the old loud source tree.
- Project Updates panel shows draft extraction cards.
- Chart modal is the canonical trace UI:

```text
canonical checkpoint -> approved delta -> conversation artifact -> provider reference
```

- Chart transcript preview renders readable structured Markdown:
  - User speech and assistant spoken text are distinct labels.
  - Notes are expandable.
  - Raw `.md` transcript is not shown as a preformatted blob unless parsing fails.
- ThreadPicker lists recent Codex conversations from `/api/provider/threads`.
- ForkActionSheet records requested continuation mode:
  - scratch
  - resumable
  - resume-in-main, with confirmation

## Recent Project Switch Bug Fix

The latest included client change fixes this confirmed bug:

```text
Selecting a Recent Codex thread from another workspace could leave
Project Updates showing deltas from the previous project.
```

Root cause:

- `updateSourceThread()` cleared chart/canonical state but not `projectState`.
- `refreshProject()` had no stale-response guard.
- Old `/api/project` responses could race with source switching and repopulate stale project cards.

The fix in `src/client/App.tsx` adds:

- `projectViewSeqRef`
- `projectSourceSwitchPendingRef`
- `projectFetchSeqRef`
- fetch seq refs for chart/canonical/artifact views
- `invalidateProjectViews()`
- `isCurrentProjectView()`

Behavior now:

- Source switching immediately clears project-owned UI:
  - `projectState`
  - chart state
  - canonical state
  - artifact preview
  - fork sheet
  - chart selection
  - project errors
  - open project modals
  - extraction review modal
- `/api/project` refreshes are scoped to a project view generation.
- stale/out-of-order project responses are ignored.
- chart/canonical/artifact/fork-access responses are also guarded.
- while source switch is in flight, project reads are not allowed to apply old server-side project data.

When changing this area, preserve the generation guard. Do not reintroduce direct unguarded `setProjectState(payload)` from async project responses.

## Canonical State Pipeline

Key server files:

```text
src/server/projectStorage.ts
src/server/projectStorage/common.ts
src/server/projectStorage/coverage.ts
src/server/projectStorage/extraction.ts
src/server/projectStorage/fsio.ts
src/server/projectStorage/ids.ts
src/server/projectStorage/importNormalize.ts
src/server/projectStorage/lifecycle.ts
src/server/projectStorage/markdown.ts
src/server/projectStorage/codeReconcile.ts
src/server/canonicalStateSkill.ts
```

Key skill files:

```text
skills/mortic-canonical-state/SKILL.md
skills/mortic-canonical-state/fixtures/corpus.json
skills/mortic-canonical-state/scripts/run_harness.mjs
skills/mortic-canonical-state/scripts/extract_state_delta.mjs
skills/mortic-canonical-state/scripts/validate_delta.mjs
skills/mortic-canonical-state/scripts/push_draft_compilation.mjs
```

Flow:

1. Scratch transcript accumulates voice/text turns.
2. Compile asks the canonical-state skill for candidate deltas.
3. Draft candidates become `ExtractedItem`s.
4. Draft compilation and coverage receipt are recorded.
5. UI shows pending cards.
6. Approval creates:
   - `CanonicalDelta`
   - `CanonicalCheckpoint`
   - updated canonical item state
7. `production.json` and `production.md` render the current canonical state.

Important rule:

```text
Compilation alone does not advance canonical state.
Approval advances canonical state.
```

Draft import API:

```text
POST /api/project/draft-compilations/import
```

This lets a Codex scratch skill push a draft compilation into Mortic. It must not create canonical checkpoints until approval.

Coverage receipts:

- Track compile/import boundaries.
- Prove what transcript window or external draft pack was covered.
- Support latest coverage lookup.
- Help avoid duplicate/overlapping imports.

Code reconciliation:

```text
src/server/projectStorage/codeReconcile.ts
```

During compile, Mortic can read recent Git commits in the workspace and propose review-only drafts that an open canonical task/risk/backlog item may be resolved. It never auto-closes canonical items.

## Project Storage

The project store is created by:

```text
createProjectStore({
  workspacePath,
  sourceUri,
  threadId
})
```

Project id is derived from workspace path. This matters because switching Recent threads can switch workspaces and therefore projects.

Atomic writes:

```text
src/server/projectStorage/fsio.ts
```

Uses:

- randomUUID temp names
- parent mkdir before temp write
- parent mkdir before rename
- serialized operation queue

This was introduced to prevent local project bookkeeping from failing active turns with `ENOENT rename` during concurrent writes.

## Skills

Vendored skills:

```text
skills/mortic-canonical-state
skills/mortic-voice-output
```

Sync logic:

```text
src/server/skillSync.ts
```

Policy:

- Mortic-managed copies have `.mortic-skill-manifest.json`.
- Managed copies can be upgraded.
- Identical unmanaged copies can be adopted.
- User-edited/unmanaged copies are not overwritten.
- Doctor and onboarding report drift/errors.

Compile currently depends on `mortic-canonical-state`, so missing skill is not treated as graceful degradation.

## Packaging

Package metadata is already changed toward public `npx mortic`:

```text
package.json
LICENSE
README.md
scripts/check_pack_contents.mjs
```

Important package settings:

- `private` removed.
- `license: MIT`.
- `bin.mortic = dist/node/cli/main.js`.
- `files` whitelist includes:
  - `dist`
  - `skills`
  - `scripts/codex_pty_worker.py`
  - `README.md`
  - `LICENSE`
- `prepack` runs build.
- pack content check ensures no `.env`, internal artifacts, evals, caveman, or planning docs are packed.

This snapshot does not include `dist/`, so build before testing packaged behavior.

## BYOK Voice

Mortic does not provide funded cloud keys.

Zero-key default:

- Browser SpeechRecognition
- Browser SpeechSynthesis

Optional keys:

```text
DEEPGRAM_API_KEY    Deepgram STT and TTS
INWORLD_API_KEY     Inworld STT and TTS
OPENAI_API_KEY      Whisper STT
ELEVENLABS_API_KEY  ElevenLabs TTS
```

The README documents the Chrome browser STT privacy caveat: browser speech recognition can send audio to Google.

## Tests And Evals

Core checks:

```bash
npm run typecheck
npm test
```

`npm test` runs:

```text
npm run build
scripts/check_voice_pipeline.mjs
scripts/check_first_turn_warm.mjs
scripts/check_skill_sync.mjs
scripts/check_spark_context.mjs
scripts/check_input_control.mjs
scripts/check_speech_projection.mjs
scripts/check_provider_adapters.mjs
scripts/check_project_storage.mjs
scripts/check_project_api_import.mjs
scripts/check_canonical_state_skill.mjs
scripts/check_pack_contents.mjs
```

Runnability eval:

```bash
node scripts/eval_mortic_runnability.mjs
```

Canonical extraction model eval:

```bash
node evals/canonical-extraction/run.mjs generate
node evals/canonical-extraction/run.mjs score --json
```

The saved model extractor score in the source repo did not pass strict bars:

```text
classificationAccuracy 0.758 < 1
operationAccuracy      0.939 < 1
strictFieldAccuracy    0.667 < 1
rationaleQualityRate   0.939 < 1
```

The deterministic skill harness still passes in `npm test`.

## Known Risks And Incomplete Work

1. This copy has no Git history.
   - Initialize Git here if you want a clean divergent branch.

2. Source Claude repo was 27 commits ahead of origin.
   - Check GitHub before assuming these changes exist remotely.

3. Model-backed extraction eval is below strict pass bars.
   - Deterministic harness passes.
   - Model mode needs more prompt/rubric work or adjusted pass criteria.

4. `App.tsx` and `projectStorage.ts` are still large.
   - `App.tsx` was reduced to about 1.8k lines.
   - `projectStorage.ts` remains about 1.9k lines after partial module extraction.

5. Release drill is not complete.
   - Need packed install test on a clean prefix/machine.
   - Need `doctor -> onboard -> voice turn -> Compile -> approve` walkthrough from a built package.

6. Fork provider actions are partly metadata-only.
   - Resume/fork/archive availability is exposed, but provider archive and some future fork controls are disabled with reasons.

7. Live mode remains disabled.
   - LiveKit dependencies and status plumbing exist.
   - `LIVE_MODE_RUNTIME_ENABLED` keeps live mode off.

8. CLI PTY fallback is best-effort.
   - POSIX-oriented.
   - Windows should boot but PTY fallback is disabled gracefully.

9. `~/.mortic` and `~/.codex` state can affect behavior.
   - Tests mostly isolate state.
   - Manual UI checks use real local Codex/session/project data.

## Suggested Next Directions For simple_mortic

Since this branch is meant to diverge, choose one primary direction and remove complexity that does not serve it.

Good options:

1. Minimal local voice sidecar
   - Keep source safety, app-server scratch, transcript, handoff.
   - Remove canonical chart/project-state complexity.
   - Result: simpler product, easier release.

2. Canonical memory first
   - Keep compile/chart/fork provenance.
   - Deemphasize voice providers and live transport.
   - Result: Mortic as project truth layer over Codex conversations.

3. Public release hardening
   - Keep current architecture.
   - Finish packed install drill and docs.
   - Fix model extraction eval bars.
   - Push branch/PR.

4. Radical UI simplification
   - Keep APIs.
   - Replace current dense cockpit with a smaller workflow:

```text
Pick thread -> Talk -> Compile -> Review cards -> Chart
```

## New Agent Rules

If you are the next agent:

1. Work in this directory:

```text
/Users/aeroknight/Downloads/as/simple_mortic
```

2. Do not edit the sibling old app unless the user explicitly asks:

```text
/Users/aeroknight/Downloads/as/Codex Voice/src
/Users/aeroknight/Downloads/as/Mortic - Claude Ver
```

3. Before changes:

```bash
pwd
git status --short  # may fail until git init
npm install         # if node_modules is absent
npm run typecheck
```

4. After changes:

```bash
npm run typecheck
npm test
```

5. Preserve source-thread safety.

6. Do not enable unverified Codex fallback.

7. Do not store or copy credentials.

8. If modifying project switching, preserve the project-view generation guard in `App.tsx`.

9. If modifying compile/extraction behavior, run the canonical harness and consider the model eval.

10. If modifying voice defaults, keep voice reasoning effort at `none` and keep `minimal` disabled for normal voice turns.
