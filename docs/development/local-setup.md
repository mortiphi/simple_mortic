# Local Setup

## Requirements

- Node.js 20 or newer.
- Codex CLI installed and logged in with `codex login`.
- Linux or macOS for normal development. Windows support is limited by the POSIX-only CLI PTY fallback.

## Install

```bash
npm install
```

## Run In Development

```bash
npm run dev -- codex://threads/<thread-id>
```

Fixed-port development run:

```bash
npm run dev -- codex://threads/<thread-id> --no-open --api-port 5262 --ui-port 5263
```

## Build And Start

```bash
npm run build
npm start -- codex://threads/<thread-id>
```

## Doctor From Source

```bash
npm run build
node dist/node/cli/main.js doctor
```

