# Canonical State Overview

Canonical state management was developed alongside the voice sidecar, then removed from the active implementation when the product surface was narrowed to the Codex scratch-fork voice sidecar.

This folder is retained as parked design context for a future canonical-state-only pass. It is not active product documentation.

## Feature Intent

Canonical state would be Mortic-owned project memory. Instead of treating provider conversations as the source of truth, Mortic could distill useful scratch work into reviewable project-state cards and approved checkpoints.

The intended trace is:

```text
source thread
  -> scratch fork
  -> transcript / handoff / compilation artifact
  -> approved delta
  -> canonical checkpoint
```

## Current Status

The active codebase no longer contains canonical-state routes, project storage, extraction UI, canonical skills, or canonical extraction evals.

Treat canonical state as a future workstream. If it returns, rebuild it deliberately from these docs and fresh requirements rather than assuming the removed implementation is still present.

## Removed Implementation Areas

```text
src/server/canonicalStateSkill.ts
src/server/projectStorage.ts
src/server/projectStorage/
skills/mortic-canonical-state/
scripts/check_canonical_state_skill.mjs
evals/canonical-extraction/
```
