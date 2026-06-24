# Mortic Docs

This directory separates current release truth, experimental workstreams, future product plans, architecture notes, reviews, and raw historical source material.

## Current Release Scope

- [Voice Sidecar MVP](current/VOICE_SIDECAR_MVP.md): original MVP plan for the Codex scratch-fork voice sidecar.
- [Safety Invariants](current/SAFETY_INVARIANTS.md): rules that must hold for source-thread safety and release readiness.
- [Scope Boundaries](current/SCOPE_BOUNDARIES.md): extracted notes on first-release scope versus deferred work.

The first release target is the desktop voice sidecar for Codex scratch forks. Canonical state management exists in the codebase but is not the primary first-release product promise.

## Canonical State

- [Canonical State Overview](canonical-state/OVERVIEW.md): what the feature is, why it exists, and why it is treated separately from the first release.
- [Canonical State Pipeline](canonical-state/PIPELINE.md): extracted implementation flow and file map.

## Architecture

- [System Overview](architecture/SYSTEM_OVERVIEW.md): CLI boot, server, client, skills, and runtime shape.
- [Codex Bridge](architecture/CODEX_BRIDGE.md): app-server bridge, CLI PTY fallback, and provider boundaries.
- [Voice Pipeline](architecture/VOICE_PIPELINE.md): STT, Codex turn, voice-output parsing, and TTS.
- [Project Storage](architecture/PROJECT_STORAGE.md): local storage shape for sessions and project memory.
- [Client UI](architecture/CLIENT_UI.md): extracted UI concepts and key client files.

## Development

- [Local Setup](development/LOCAL_SETUP.md): development commands and source-build doctor flow.
- [Local State](development/LOCAL_STATE.md): environment and state directories.
- [Testing](development/TESTING.md): test scripts, evals, and release validation commands.
- [Agent Guide](development/AGENT_GUIDE.md): working rules for future agents in this repo.

## Release

- [Development Setup](release/DEVELOPMENT_SETUP.md): branch model, GitHub settings, and release flow setup.
- [Release Checklist](release/RELEASE.md): release commands and post-release checks.
- [Release Criteria](release/RELEASE_CRITERIA.md): release readiness bar.
- [Packaging](release/PACKAGING.md): desktop package notes extracted from handoff material.

## Future Product Direction

- [Future Branch Manager Spec](future/FUTURE_BRANCH_MANAGER_SPEC.md): later rewrite of the branch-manager idea.
- [Future Branch Manager Spec Original](future/FUTURE_BRANCH_MANAGER_SPEC_ORIGINAL.md): earlier branch-manager spec with additional sketches and references.

## Reviews

- [Claude Review](reviews/CLAUDE_REVIEW.md): product and release maturity review.
- [Ensemble Adversarial Review](reviews/ENSEMBLE_ADVERSARIAL_REVIEW.md): UX/UI adversarial review.

## Archive

Raw pre-cleanup docs are preserved under [archive/raw](archive/raw/), grouped by original location:

- `archive/raw/root/`: root-level docs as they existed before this reorganization.
- `archive/raw/docs/`: files that were already under `docs/` before this reorganization.
- `archive/snapshots/`: snapshot-style handoff documents retained for historical context.
