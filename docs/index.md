# Mortic Docs

This directory separates current release truth, deferred design notes, future product plans, architecture notes, reviews, and raw historical source material.

## Current Release Scope

- [Voice Sidecar MVP](current/voice-sidecar-mvp.md): original MVP plan for the Codex scratch-fork voice sidecar.
- [Safety Invariants](current/safety-invariants.md): rules that must hold for source-thread safety and release readiness.
- [Scope Boundaries](current/scope-boundaries.md): extracted notes on first-release scope versus deferred work.

The current product surface is the desktop voice sidecar for Codex scratch forks. Canonical/project-memory code has been removed from the active app.

## Canonical State

- [Canonical State Overview](canonical-state/overview.md): parked design notes for a future canonical-state workstream.
- [Canonical State Pipeline](canonical-state/pipeline.md): intended future pipeline, not active implementation.

## Architecture

- [System Overview](architecture/system-overview.md): CLI boot, server, client, skills, and runtime shape.
- [Codex Bridge](architecture/codex-bridge.md): app-server bridge, CLI PTY fallback, and provider boundaries.
- [Voice Pipeline](architecture/voice-pipeline.md): STT, Codex turn, voice-output parsing, and TTS.
- [Session Storage](architecture/session-storage.md): local storage shape for voice-sidecar sessions.
- [Client UI](architecture/client-ui.md): extracted UI concepts and key client files.

## Development

- [Local Setup](development/local-setup.md): development commands and source-build doctor flow.
- [Local State](development/local-state.md): environment and state directories.
- [Testing](development/testing.md): test scripts, evals, and release validation commands.
- [Agent Guide](development/agent-guide.md): working rules for future agents in this repo.

## Release

- [Development Setup](release/development-setup.md): branch model, GitHub settings, and release flow setup.
- [Release Checklist](release/release.md): release commands and post-release checks.
- [Release Criteria](release/release-criteria.md): release readiness bar.
- [Packaging](release/packaging.md): desktop package notes extracted from handoff material.

## Future Product Direction

- [Future Branch Manager Spec](future/future-branch-manager-spec.md): later rewrite of the branch-manager idea.
- [Future Branch Manager Spec Original](future/future-branch-manager-spec-original.md): earlier branch-manager spec with additional sketches and references.

## Reviews

- [Claude Review](reviews/claude-review.md): product and release maturity review.
- [Ensemble Adversarial Review](reviews/ensemble-adversarial-review.md): UX/UI adversarial review.

## Archive

Raw pre-cleanup docs are preserved under [archive/raw](archive/raw/), grouped by original location:

- `archive/raw/root/`: root-level docs as they existed before this reorganization.
- `archive/raw/docs/`: files that were already under `docs/` before this reorganization.
- `archive/snapshots/`: snapshot-style handoff documents retained for historical context.
