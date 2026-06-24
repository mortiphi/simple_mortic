# Agent Guide

This guide is extracted from the original handoff and should be treated as repo-local working context.

## Preserve Core Safety

- Do not send voice turns to the source Codex thread.
- Keep scratch-fork validation intact.
- Keep `src/shared/scratchDefaults.ts` as the source of truth for initial scratch settings.
- Preserve the project-view generation guard in `src/client/App.tsx`.

## Respect Workstream Boundaries

The first release is the voice sidecar and desktop package.

Canonical state management and future branch-manager work should be treated as separate workstreams unless a task explicitly asks to change them.

## Keep Provider Boundaries

Provider process execution should stay in:

```text
src/server/providerAdapters.ts
src/server/codex.ts
src/server/appServerBridge.ts
src/server/cliPtyBridge.ts
```

## Validate Changes

For normal code changes:

```bash
npm run typecheck
npm test
```

For release/package changes:

```bash
npm run dist:linux:dir
npm run dist:linux:deb
```

