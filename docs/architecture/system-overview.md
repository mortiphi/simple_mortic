# System Overview

Mortic is a local desktop/browser sidecar for Codex scratch forks. The current release target is the voice sidecar.

## CLI Boot

Entry point:

```text
src/cli/main.ts
src/cli/runtime.ts
```

Responsibilities:

- parse CLI args and Codex thread URI,
- load optional `.env` files,
- resolve runtime context for the selected Codex thread,
- sync vendored skills to `~/.codex/skills`,
- create session storage under `~/.mortic/sessions`,
- start the Fastify API,
- serve either the built client or Vite dev UI,
- prewarm the default scratch fork,
- provide `mortic doctor` from source builds and future CLI distributions.

## Server

Main API file:

```text
src/server/app.ts
```

Important route groups:

- session health, onboarding, source thread switching, clear, prewarm,
- turn start, turn stream, interrupt, audio health,
- handoff generation,
- provider thread discovery,
- STT and TTS endpoints.

## Client

Main client files:

```text
src/client/App.tsx
src/client/voice/useVoiceEngine.ts
src/client/components/
src/client/lib/
```

The client owns the interaction shell, source-thread picker, push-to-talk, transcript display, handoff review, and config controls.

## Desktop

Desktop wrapper:

```text
src/desktop/main.ts
src/desktop/preload.cjs
```

The packaged Linux desktop app launches the local Mortic runtime and presents the app as `mortic-desktop`.

## Shared Code

Shared types and policy helpers live under:

```text
src/shared/
```

Important files include:

- `types.ts`
- `scratchDefaults.ts`
- `threadUri.ts`
- `speechProjection.ts`
- `voiceResponse.ts`
- `modelPolicy.ts`

## Vendored Skills

Mortic currently vendors local skills under:

```text
skills/mortic-voice-output/
```

They are synced to `~/.codex/skills` at boot and by `mortic doctor`.
