# Safety Invariants

These rules should stay true as the repo moves toward a first desktop release.

## Source Thread Safety

1. The source Codex thread must not receive voice turns.
2. Voice turns must go to a validated scratch fork.
3. Scratch fork ids must differ from the source thread id.
4. CLI fallback may type only into a verified Codex fork whose rollout file proves:
   - `forked_from_id` matches the source.
   - the scratch id differs from the source id.
   - the cwd matches the expected runtime context.
5. Do not enable `MORTIC_ALLOW_UNVERIFIED_CODEX_FALLBACKS` for normal release builds.

## Voice Turn Defaults

1. Voice default reasoning effort is `none`.
2. Normal voice turns must not request `minimal` reasoning, because some Codex tool paths reject it.
3. Initial scratch settings must come from `src/shared/scratchDefaults.ts`.
4. CLI boot prewarm and browser prewarm must use the same default scratch settings to avoid duplicate scratch forks.

## Canonical State Boundaries

Canonical/project-memory implementation is not part of the active product surface. If this workstream returns later, canonical state changes must happen only through approved deltas and checkpoints. Draft material and scratch transcripts are evidence or pending material until explicitly approved.

## Operational Resilience

Project/archive/write failures should not break an active voice turn unless the provider bridge itself failed.

The first release should be able to boot with:

- no cloud voice keys,
- local browser voice fallback,
- Codex CLI installed and logged in,
- optional cloud provider keys supplied by the user.
