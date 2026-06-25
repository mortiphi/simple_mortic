# Codex Bridge

Mortic talks to Codex through a provider boundary. The first release target is Codex-only.

## Provider Adapter

Main file:

```text
src/server/providerAdapters.ts
```

This is the provider boundary for Codex binary discovery, login status, version checks, recent thread discovery, and provider metadata.

Keep provider process execution behind this adapter or the bridge layer. Do not scatter direct `codex` binary calls through unrelated server code.

## Bridge Router

Main router:

```text
src/server/codex.ts
```

It selects the preferred app-server bridge and falls back to the CLI PTY bridge when allowed and safe.

## App-Server Bridge

Main file:

```text
src/server/appServerBridge.ts
```

Responsibilities:

- start the Codex app-server,
- initialize JSON-RPC,
- call `thread/fork` for an ephemeral scratch,
- validate the scratch thread id before `turn/start`,
- stream deltas into Mortic turn streams,
- dedupe first-turn scratch prewarm.

## CLI PTY Fallback

Files:

```text
src/server/cliPtyBridge.ts
scripts/codex_pty_worker.py
```

The PTY fallback is POSIX best-effort. It must validate rollout files before typing user input.

Fallback typing is unsafe unless the rollout file proves:

- the scratch id differs from the source id,
- `forked_from_id` matches the source,
- cwd matches expected runtime context.

