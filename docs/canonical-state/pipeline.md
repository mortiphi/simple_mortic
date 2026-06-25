# Canonical State Pipeline

This pipeline is parked design context for future canonical-state work. It is not active implementation.

## Core Flow

1. A scratch transcript accumulates voice or text turns.
2. A future compile/extract action produces draft project-state material.
3. Draft cards remain pending until reviewed.
4. Approved deltas update canonical state.
5. Canonical checkpoints become the durable project chart.
6. Provider conversations remain evidence and metadata, not the source of truth.

## Removed Server Files

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

## Skill Files

```text
skills/mortic-canonical-state/SKILL.md
skills/mortic-canonical-state/references/
skills/mortic-canonical-state/scripts/
skills/mortic-canonical-state/fixtures/corpus.json
```

## Release Caveat

Canonical state is not part of the current release bar. Future work should add new code, tests, and evaluation fixtures alongside the feature when it is reintroduced.
