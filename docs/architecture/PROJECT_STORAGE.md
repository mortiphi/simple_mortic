# Project Storage

Mortic stores session data locally and, when enabled, project/canonical memory data locally.

## Session State

Sessions live under:

```text
~/.mortic/sessions/
```

Session artifacts can include:

- `session.json`
- `transcript.md`
- `handoff.md`
- `handoff_short.md`
- `handoff_full.md`

## Project Memory State

Project memory lives under:

```text
~/.mortic/projects/
```

Project artifacts can include:

- `project.json`
- `production.json`
- `production.md`
- `extracted_items.json`
- `extracted_items.md`
- `canonical_chart.json`
- `provider_forks.json`
- source-thread and checkpoint folders,
- session links.

## Source Thread Switching

The server rebuilds the project store when a selected source thread resolves to a different workspace. The client also guards project views by generation so stale project responses do not repopulate the UI after switching threads.

When editing source-switch behavior, preserve the project-view generation guard in `src/client/App.tsx`.

