# Scope Boundaries

This note separates the voice sidecar from adjacent or deferred work.

## First-Release Core

The narrow voice sidecar scope is:

```text
CLI arg -> scratch fork -> push-to-talk voice -> Codex turn -> TTS -> transcript -> handoff prompt
```

For the first downloadable desktop release, avoid expanding the public promise beyond this unless a feature is already required for the packaged app to boot safely.

## Removed Or Deferred Workstreams

The repo still contains reference docs, evals, design mocks, and future specs beyond the narrow voice-sidecar MVP. These areas should be treated deliberately rather than accidentally included in release scope.

### Canonical State And Project Memory

Canonical-state and project-memory implementation has been removed from the active app. Removed areas include:

- `src/server/canonicalStateSkill.ts`
- `src/server/projectStorage.ts`
- `src/server/projectStorage/`
- project/canonical API routes under `/api/project*`
- canonical chart, extraction review, draft compilation, and approval UI
- `skills/mortic-canonical-state/`
- canonical/project storage tests and evals

Future canonical-state work should restart from the parked docs under `docs/canonical-state/`, not from active server/client code.

### Advanced Runtime And Context Features

Extra runtime/context features include:

- Spark/model-transition preflight and compaction helpers.
- runtime context restore and security audit helpers.
- vendored skill sync.
- provider thread listing and thread switching.

Some of these may still be needed by the current app, but they are broader than the original narrow CLI-arg sidecar loop.

### Voice And Transport Extensions

Beyond the basic browser/local voice loop, the repo contains:

- LiveKit transport plumbing.
- extra Deepgram, ElevenLabs, and Inworld TTS endpoints.
- STT/TTS latency probes.
- provider fallback and telemetry surfaces.

These should be documented and exposed according to actual release readiness.

### Client UI Extras

Removed UI surfaces include:

- canonical chart/project panels,
- extraction review modals,
- fork action sheets,
- telemetry panels,
- Spark/context UI,
- thread switching picker,
- Markdown helpers for chart and extraction rendering.

The current user story stays focused on the voice sidecar.

### Evals, Design Mocks, And Future Plans

The following are useful repo assets but not first-release product surface:

- `evals/`
- `design-mocks/`
- future branch-manager specs under `docs/future/`
- review artifacts under `docs/reviews/`

Keep them organized as reference material, not as user-facing release promises.

## Practical Rule

When preparing the first release, classify changes as one of:

- required for the voice sidecar to work safely,
- packaging/release infrastructure,
- future canonical-state work,
- future branch-manager work,
- internal evaluation/design/reference material.

If a change does not serve the voice sidecar or release infrastructure, keep it out of the first-release path unless it prevents tests or packaging from passing.
