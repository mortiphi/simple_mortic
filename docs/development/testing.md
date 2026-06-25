# Testing

## Main Checks

```bash
npm run typecheck
npm test
```

`npm test` currently builds the app and desktop entry, then runs validation scripts for preferences, sessions, voice, skill sync, model context, input control, speech projection, app-server events, provider adapters, and pack contents.

## Release Build Checks

```bash
npm run dist:linux:dir
npm run dist:linux:deb
npm run check:release-artifacts
node dist/node/cli/main.js doctor
```

## Useful Individual Scripts

```text
scripts/check_preferences_store.mjs
scripts/check_session_cohesion.mjs
scripts/check_voice_pipeline.mjs
scripts/check_first_turn_warm.mjs
scripts/check_skill_sync.mjs
scripts/check_spark_context.mjs
scripts/check_input_control.mjs
scripts/check_speech_projection.mjs
scripts/check_app_server_events.mjs
scripts/check_provider_adapters.mjs
scripts/check_pack_contents.mjs
```

## Evals

```text
evals/model-runtime-telemetry/
evals/mortic-voice-output/
```
