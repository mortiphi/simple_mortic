# Testing

## Main Checks

```bash
npm run typecheck
npm test
```

`npm test` currently builds the app and desktop entry, then runs validation scripts for preferences, sessions, voice, skill sync, model context, input control, speech projection, provider adapters, project storage, canonical state, and pack contents.

## Release Build Checks

```bash
npm run dist:linux:dir
npm run dist:linux:deb
node dist/node/cli/main.js doctor
```

## Useful Individual Scripts

```text
scripts/check_preferences_store.mjs
scripts/check_session_cohesion.mjs
scripts/check_voice_pipeline.mjs
scripts/check_first_turn_warm.mjs
scripts/check_skill_sync.mjs
scripts/check_project_storage.mjs
scripts/check_canonical_state_skill.mjs
scripts/check_pack_contents.mjs
```

## Evals

```text
evals/canonical-extraction/
evals/model-runtime-telemetry/
evals/mortic-voice-output/
```

