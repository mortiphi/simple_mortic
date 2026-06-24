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
- Canonical/project panels exist in the codebase but are separate from the first-release product promise.

## Source Switch Guard

`src/client/App.tsx` contains project-view generation guards that prevent stale project data from appearing after switching source threads.

Do not reintroduce unguarded async project responses such as direct stale `setProjectState(payload)` calls after source switching.

