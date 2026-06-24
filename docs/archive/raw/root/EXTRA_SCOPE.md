# Extra Scope — Beyond Voice Sidecar + Handoff

Scope is: CLI arg → scratch fork → PTT voice → Codex turn → TTS → transcript → handoff prompt.

---

## Server: Entirely Extra Files

| File | Lines | What |
|---|---|---|
| `src/server/canonicalStateSkill.ts` | 755 | Runs Codex skill to extract structured deltas from transcript |
| `src/server/sparkContext.ts` | 481 | Model transition preflight (context saturation, compaction) |
| `src/server/livekit.ts` | 92 | LiveKit WebRTC token management (disabled at runtime) |
| `src/server/runtimeContext.ts` | 315 | Restores Codex session runtime context for security audit |
| `src/server/skillSync.ts` | 183 | Syncs vendored skills to `~/.codex/skills` |
| `src/server/agentRuntimeBridge.ts` | 64 | Abstract bridge interface (only codex impls exist) |
| `src/server/projectStorage.ts` | 1961 | Full canonical project storage |
| `src/server/projectStorage/` (dir) | ~1900 total | common, coverage, extraction, fsio, ids, importNormalize, lifecycle, markdown, codeReconcile |

## Server: Extra Routes in `app.ts`

- `GET/POST /api/project*` — project state, canonical state, chart, coverage, artifacts, draft compilations, approvals, sessions, checkpoints, extractions, fork access
- `GET /api/session/spark-context*` — model transition preflight
- `GET /api/provider/threads` — thread listing (thread switching)
- `GET /api/livekit/*` — LiveKit transport
- `GET /api/tts/elevenlabs/health|ws|stream` — extra TTS endpoints
- `GET /api/tts/deepgram/health|ws|stream` — extra TTS endpoints
- `GET /api/tts/inworld/ws` — extra TTS endpoint

## Client: Extra Components

| File | Lines | What |
|---|---|---|
| `src/client/components/ChartModal.tsx` | 338 | Canonical trace UI (checkpoints, deltas, artifacts) |
| `src/client/components/ProjectPanels.tsx` | 312 | Insights panel, fork trace, scaffold stats, approve-all |
| `src/client/components/SessionModals.tsx` (ExtractionReviewModal) | ~150 | Extraction card review, edit/approve/dismiss |
| `src/client/components/TelemetryPanel.tsx` | 153 | Per-turn latency telemetry |
| `src/client/components/ForkActionSheet.tsx` | 125 | Fork continuation access management |
| `src/client/components/ThreadPicker.tsx` | 79 | Thread switching picker |
| `src/client/components/Markdown.tsx` (extra functions) | ~150 | Chart preview, task plans, extraction helpers |
| `src/client/lib/labels.ts` (extra labels) | ~100 | extraction types/statuses, lifecycle labels, model labels |
| `src/client/lib/spark.ts` | ~50 | Spark preflight helpers |
| `src/client/livekitTransport.ts` | — | LiveKit transport (live mode disabled) |

## Shared Types: Extra-Only

- `MorticProject`, `SourceThreadNode`, `SourceCheckpoint*`, `ScratchSessionNode`
- `ExtractedItem`, `ExtractedItemType`, `ExtractionStatus`, `UpdateExtractedItemRequest`
- `CanonicalItem`, `CanonicalDelta`, `CanonicalCheckpoint`, `CanonicalLifecycle*`
- `DraftCompilation`, `DraftCompilationImport*`, `ApproveCompilation*`, `CompilePlan`, `CompilationSourceWindow`
- `CoverageReceipt`, `ProjectCoverageLatestResponse`
- `ProductionChart`, `ProjectChartResponse`, `ProjectCanonicalStateResponse`, `ProjectStateResponse`
- `ConversationArtifact`, `ProjectArtifactPreviewResponse`
- `HandoffReadiness`
- `ProviderForkRecord`, `ProviderFork*`, `ProviderReference`, `ProviderActionAvailability`
- `ProviderAdapterStatus`, `ProviderThreadSummary`, `ProviderName`
- `RuntimeContextRestore`, `RuntimeContext*`, `RuntimePermissionProfile`, `Runtime*`
- `ModelTransitionStatus`, `ModelTransitionPreflight`, `SparkContext*`
- `LiveKitStatus`, `LiveKitToken*`, `TransportProvider`, `TransportState`
- `InputPolicy`, `inputPolicies`
- `SkillSync*`
- `src/shared/modelProfiles.ts` (entire file — model context windows for spark)

## Scripts: Extra

- `scripts/check_spark_context.mjs` — model transition
- `scripts/check_project_storage.mjs` — project storage
- `scripts/check_project_api_import.mjs` — draft import API
- `scripts/check_canonical_state_skill.mjs` — canonical skill
- `scripts/check_skill_sync.mjs` — skill sync
- `scripts/check_provider_adapters.mjs` — provider adapters
- `scripts/check_pack_contents.mjs` — packaging
- `scripts/eval_mortic_runnability.mjs`
- `scripts/eval_progress_speech.mjs`
- `scripts/check_runtime_context_restore.mjs`
- `scripts/tts_ws_probe.mjs`
- `scripts/eval_deepgram_tts_latency.mjs`
- `scripts/eval_stt_latency.mjs`
- `scripts/fixtures/speech_projection_cases.json`
- `scripts/fixtures/fake_codex/codex`

## Evals: All Extra

- `evals/canonical-extraction/`
- `evals/mortic-voice-output/`
- `evals/model-runtime-telemetry/`

## Skills: Extra

- `skills/mortic-canonical-state/` (entire directory)
- `skills/mortic-voice-output/agents/openai.yaml` (non-Codex provider config)

## Docs: Extra

- `voice_codex_branch_manager_mvp.md` (stale PRD — duplicate exists)
- `voice_codex_branch_manager_mvp (1).md` (identical duplicate)
- `MORTIC_MVP_PLAN.md` (outdated plan doc)
- `CLAUDE_REVIEW.md` (code review notes)
- `AGENT_HANDOFF.md` (partly extra — sections on canonical pipeline)

## Design Mocks: All Extra

- `design-mocks/` (entire directory — 6 files)

## Package.json: Extra Bits

- Dependencies: `livekit-server-sdk`, `livekit-client` (WebRTC transport)
- Scripts: all `eval:*`, `check:spark-context`, `probe:tts`
