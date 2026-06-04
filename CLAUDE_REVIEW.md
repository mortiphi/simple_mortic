# Claude's Review — Codex Voice (Mortic)

_Date: 2026-04-29_
_Scope: full code review + user-flow latency audit against `MORTIC_MVP_PLAN.md` and `voice_codex_branch_manager_mvp*.md`._

---

## Part 1 — Product State Review

### Product Intent (per PRDs)

Two sets of docs disagree. The two `voice_codex_branch_manager_mvp*.md` files describe a much larger ambition (visual branch graph, React Flow, SQLite, multi-agent reviewer, merge-back). `MORTIC_MVP_PLAN.md` and `README.md` describe the actual narrowed target:

- `npx mortic codex://threads/<id>` opens a localhost web UI for a **disposable scratch fork** of one existing Codex thread.
- Push-to-talk in browser → Codex turn → TTS readback → paste-ready handoff prompt at the end.
- Hard rule: **never mutate the source thread**.
- Browser-native `SpeechRecognition` / `SpeechSynthesis` — no paid providers, no API keys.
- Explicit non-goals: graph UI, branch CRUD, SQLite, VS Code extension, OpenAI keys, realtime.

The branch-manager PRDs are effectively shelved. The repo also still has a duplicate stale PRD (`voice_codex_branch_manager_mvp (1).md`).

### What's Built (real, end-to-end)

- **CLI** (`src/cli/main.ts`) — URI parse, free-port scan, Fastify + optional Vite, opens browser.
- **App-server bridge** (`src/server/appServerBridge.ts`) — real JSON-RPC over WebSocket: `initialize` → `thread/fork` (ephemeral, read-only sandbox) → `turn/start`, with streaming deltas.
- **CLI PTY fallback** (`src/server/cliPtyBridge.ts` + `scripts/codex_pty_worker.py`) — Python PTY drives `codex fork` TUI; rollout-file validation before any prompt is sent.
- **Fork-safety enforcement** — both bridges refuse to send the user's voice input until scratch thread id is proven distinct (`appServerBridge.ts:288-297`, `cliPtyBridge.ts:165-195`); unsafe `exec resume --ephemeral` path gated behind env flag.
- **Storage** (`src/server/storage.ts`) — atomic temp-rename writes, serialized IO queue.
- **Handoff** (`src/server/app.ts:309-346`) — Codex-drafted markdown with a deterministic `localHandoff` fallback.
- **Web UI** (`src/client/App.tsx`) — PTT, transcript, per-turn timing log, handoff editor, archive cleanup on shutdown.

Almost nothing is stubbed. Both Codex and voice integrations are real.

### What's Missing vs MVP Plan

- **Zero tests.** No test runner, no `test` script, no `*.test.*` files. The "never write to source thread" invariant is enforced only at runtime and has no regression coverage.
- **`npx mortic` does not actually work.** `package.json` is `private: true`, unpublished; README documents `npm run start` instead. The headline command in the plan is not yet shippable.
- **POSIX-only.** PTY worker uses `pty.fork`, `os.killpg`, ioctls — Windows silently broken, Linux untested.
- **No client-side type check in `build`** — `tsc` runs on node side only, then `vite build`.
- **Stale PRDs in the tree** — duplicate file with substantive edits, both contradicting actually-built scope.

### Architecture & Code Quality

Layering is sensible: `cli → server/app → server/codex → {appServerBridge | cliPtyBridge}`, with `storage` and `shared` siblings. Clear preferred/fallback router in `codex.ts:224-287`.

Smells:
- **`App.tsx` is 640 lines** — UI, settings, two recognition state machines, polling, TTS, handoff all in one component.
- **`cliPtyBridge.ts` is 817 lines** and the most fragile piece — terminal-scraping with hardcoded TUI strings (`"Working ("`, `"esc to interrupt"`, `"⚠ MCP"`) at `cliPtyBridge.ts:211-231` will break on any Codex CLI version bump.
- **Polling, not streaming, to the client** — UI polls `/api/turn/:turnId` every 500ms; no SSE/WebSocket back to browser.
- **`process.cwd()` baked into fork validation** — launching from a different directory breaks CLI-fallback meta check.
- **Hardcoded model magic** — `model: "default"` silently rewritten to `gpt-5.4` (`appServerBridge.ts:152`); ignores env override.
- **No request validation** (zod/typebox); ad-hoc body checks.
- **Dead code** — `setActiveTurn` exported but unused; `runCodexEphemeralTurn` only reachable via unsafe-fallback flag.
- **No structured server logging** — `console.log` only.

### Top Risks

1. **PTY scraper is a maintenance time bomb.** Tied to one Codex TUI version, no compat test, will break silently on upgrade.
2. **Zero tests on a safety-critical invariant.** A refactor could regress the source-thread-id guard without anyone noticing.
3. **Voice privacy story is incomplete.** Chrome `SpeechRecognition` ships audio to Google; "localhost only" framing in the README is misleading. Safari/Firefox have no fallback beyond text input.
4. **`npx mortic` is the headline UX and doesn't ship.** `private: true`, `bin` points at a build output that isn't part of the documented dev flow.
5. **Platform reach.** Windows users hit cryptic PTY errors; only macOS is exercised.

### Bottom Line

A **focused, near-complete MVP prototype of the narrow scope** in `MORTIC_MVP_PLAN.md` — not the broader branch-manager PRD, which is quietly dead. The voice-fork-handoff loop is genuinely real (real JSON-RPC, real PTY fallback, real fork-safety checks, real persistence). What's missing is the productization layer: tests, packaging for `npx`, cross-platform support, and breaking up two oversized files. It's closer to "feature-complete prototype" than "scaffolding" but has a meaningful hardening gap before it can ship.

---

## Part 2 — User-Flow Latency Audit

**Intent under test:** "Codex opens, and it is just a TTS+STT layer over Codex. We don't use a different LLM, we don't change prompts. It runs at Codex speeds. If thinking takes time, it takes time — but STT and TTS should not be an issue."

### Verdict: Not a Thin Pass-Through

The intent is broken in four meaningful ways. None require architectural changes to fix.

### Prompt Fidelity

- **App-server path is faithful.** `appServerBridge.ts:79-90` sends `prompt = userEntry.text` verbatim in the JSON-RPC envelope.
- **CLI fallback path mutates the prompt.** `cliPtyBridge.ts:347-358` injects *"Reply concisely. Then output only the final answer wrapped in Mortic capture tokens..."* into every turn. That's a style instruction Codex wouldn't otherwise see. Whitespace also gets collapsed by `compactPromptForTui`.

### Model Fidelity

- `appServerBridge.ts:152` — when the user picks `default`, the app-server is launched pinned to `gpt-5.4`. Codex's *own* default is bypassed.
- `codex.ts:17` — UI default is `gpt-5.4-mini`, not "let Codex decide."

### Latency Budget (ordered by impact)

| # | Source | Cost | Where |
|---|---|---|---|
| 1 | **TTS waits for the whole response.** App-server already streams `item/agentMessage/delta` but the route only resolves on `turn/completed`. | Adds full generation time before first audio | `appServerBridge.ts:350-360`, `App.tsx:280-285` |
| 2 | **Client polls `/api/turn/:turnId` every 500ms** instead of SSE/WS. | 0–500ms per state read | `App.tsx:262` |
| 3 | **CLI fork validation polls up to 20s** for rollout file to appear; first turn after reset is gated. | 250ms–20s on first turn | `cliPtyBridge.ts:51`, :737-748 |
| 4 | **Hard 500ms delay between typing prompt and pressing Enter** in CLI TUI. | +500ms per CLI turn | `cliPtyBridge.ts:52` (`SUBMIT_ENTER_DELAY_MS`) |
| 5 | **Rollout poll 250ms + 150ms response settle** in CLI path. | +400ms per CLI turn | `cliPtyBridge.ts:53,57` |
| 6 | **PTT waits for `onend` to send**; 100ms restart loop while held. | full-utterance buffering + 100ms per restart | `App.tsx:331-348` |
| 7 | **`speechSynthesis.cancel()`+`speak()` cold per turn** — no warmup. | ~300ms first turn (macOS) | `App.tsx:70-77` |

Good: app-server stays alive across turns, one scratch fork per session (not per turn), WebSocket reused.

### Streaming Gap (the headline issue)

Server already has streaming deltas. Client never sees them. Fastify resolves only on completion (`app.ts:242`), client polls at 500ms, TTS speaks the whole blob. **You wait for the entire response twice over** — once for Codex to finish, once for the next poll tick — before any audio.

### Prioritized Fixes

1. **Stream deltas to the client; TTS at sentence boundaries.** Add SSE `GET /api/turn/:turnId/stream`, push deltas already collected at `appServerBridge.ts:350-360`, client speaks per `[.!?]\s`. Single biggest win — user hears Codex while it's still generating.
2. **Replace 500ms poll with the same SSE/WS channel.** Removes `App.tsx:262` and the per-poll `storage.read()` round-trips.
3. **Stop rewriting `default` to `gpt-5.4`.** `appServerBridge.ts:152` — don't pass `-c model=...` when user picked `default`. Change `codex.ts:17` default to `default`.
4. **Stop wrapping the CLI prompt.** `cliPtyBridge.ts:347-358` — drop "Reply concisely". Markers can be a trailing protocol line, not embedded as user-visible instruction; or read the natural answer from rollout JSONL without markers entirely.
5. **Send the turn the moment PTT is released**, not after `recognition.onend`. Remove the 100ms restart timer (`App.tsx:335-339`).
6. **Cut `SUBMIT_ENTER_DELAY_MS` to ~50ms** (`cliPtyBridge.ts:52`); drop `RESPONSE_SETTLE_MS` to 0 once rollout-tail path is reliable.
7. **Warm `speechSynthesis`** with an empty utterance at session load.
8. **Replace polling fork validation with `fs.watch`** on `~/.codex/sessions/` (`cliPtyBridge.ts:744`).

Net effect of (1)+(2): TTS begins mid-generation. That's what "Codex speeds with a voice on it" actually means — and it's the change that makes the product feel correct.
