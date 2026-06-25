# Client UI

Main orchestration:

```text
src/client/App.tsx
```

Main voice hook:

```text
src/client/voice/useVoiceEngine.ts
```

## Key Components

```text
src/client/components/HandoffPanel.tsx
src/client/components/Markdown.tsx
src/client/components/OnboardingScreen.tsx
src/client/components/SessionModals.tsx
src/client/components/ThreadPicker.tsx
```

## Client Libraries

```text
src/client/lib/api.ts
src/client/lib/clientTypes.ts
src/client/lib/format.ts
src/client/lib/labels.ts
src/client/lib/spark.ts
src/client/lib/voice.ts
```

## Important UI Concepts

- The source thread picker lists recent Codex conversations.
- Voice turns land in scratch forks, not source threads.
- Transcript and handoff surfaces should make spoken text and notes distinct.
- Canonical/project-memory panels are not part of the active client surface.

## Source Switch Guard

When the selected source thread changes, the client clears the current scratch session and rehydrates from the server snapshot for the new thread.
