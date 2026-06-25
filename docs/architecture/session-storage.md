# Session Storage

Mortic stores voice-sidecar session data locally.

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

## Source Thread Switching

Changing the selected source thread clears the current scratch session and starts a fresh prewarm path for the new thread. The source thread itself remains read-only unless the user manually pastes a handoff back into Codex.
