# Canonical State Overview

Canonical state management was developed alongside the voice sidecar, then partially deferred when the first release was narrowed to the Codex scratch-fork voice sidecar.

This workstream is important, but it is not the first release product promise.

## Feature Intent

Canonical state is Mortic-owned project memory. Instead of treating provider conversations as the source of truth, Mortic can distill useful scratch work into reviewable project-state cards and approved checkpoints.

The intended trace is:

```text
source thread
  -> scratch fork
  -> transcript / handoff / compilation artifact
  -> approved delta
  -> canonical checkpoint
```

## Current Status

The codebase still contains canonical-state code, UI surfaces, tests, and skills. This means CI may still exercise canonical paths even if the first release messaging avoids promising the feature.

Treat canonical state as an experimental or deferred workstream until a dedicated removal, hiding, or completion pass is done.

## Key Code Areas

```text
src/server/canonicalStateSkill.ts
src/server/projectStorage.ts
src/server/projectStorage/
skills/mortic-canonical-state/
scripts/check_canonical_state_skill.mjs
```

