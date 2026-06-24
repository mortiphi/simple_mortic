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

---

## Part 3 — Follow-up Review: Canonical-State Skill & Release Maturity

_Date: 2026-06-10. Parts 1–2 above pre-date the project-storage/canonical-state system and are stale on latency (SSE streaming, sentence-chunked TTS, and audio-health telemetry now exist). This part reviews what was built since._

_Caveat: the skill is judged from its caller (`src/server/canonicalStateSkill.ts`) and its outputs (`~/.mortic/projects/*/production.md`); the skill package itself (`~/.codex/skills/mortic-canonical-state/SKILL.md`, `merge_rules.md`, schema) was not read directly._

### Canonical-State Skill Quality: B-

Engineering around the skill is good; the core extraction architecture is fragile.

**Good**
- Strict containment pipeline: skill docs + schema + merge rules → model → JSON → external `validate_delta.mjs` → deterministic script fallback → human approval gate. Nothing auto-mutates canonical state.
- The lifecycle normalization layer distrusts the model correctly: a claimed `resolve`/`drop`/`supersede` is downgraded to `append_evidence` or `create` unless the text contains an explicit directive (`isExplicitLifecycleDirective`).
- Output quality is real: production.md cards have compact titles, project-native rationale, lifecycle provenance, and session links.

**Bad**
- **~20 stacked "Important:" prompt rules are scar tissue.** Each rule patches a past failure mode in prose ("don't extract button explanations", "summary must not say transcript"). This prompt is at end-of-life: the next model bump or a new transcript style will regress silently. Migrate to few-shot examples plus an eval-gated rubric instead of adding rule 21.
- **Regex post-filters compound the fragility.** `isAssistantExplanationCandidate`, the lifecycle directive regexes, and promote/demote text-sniffing (`/\b(move|promote|convert|turn)\b.{0,80}\bbacklog\b/`) are English heuristics deciding state-machine transitions. They work on observed data, are brittle against paraphrase, and break fully on non-English input.
- **No extraction-quality eval.** `evals/` covers voice output and runnability; nothing scores extraction precision/recall against golden transcripts. The canonical backlog itself acknowledges this gap (conflict-case fixtures, side-fork import eval, reconcile-against-code). The riskiest LLM surface in the product is the least eval'd.
- Hardcoded `gpt-5.4-mini` + Codex CLI exec means extraction quality is married to one provider/model. The adapter seam exists everywhere except here.

### Release Maturity: strong alpha / pre-beta

**Genuinely mature**
- Safety invariants (fork validation, no source-thread writes, approval gates) are enforced in code and tests, not just docs.
- Telemetry depth is unusual for this stage: per-turn timing, audio health, coverage receipts with provable evidence boundaries.
- Test discipline is real: assertion-dense check scripts; idempotency, overlap, and legacy-backfill cases in the in-flight import work. Typecheck clean.
- The canonical data model is the durable IP: receipt chaining, supersede-keeps-history, an explicit lifecycle vocabulary.

**Release blockers, in order**
1. **Single-user/single-process assumptions.** One session file, in-memory turn streams, flat JSON under `~/.mortic`, no locking beyond a serialized IO queue. Fine locally; fails on a second window.
2. **Distribution.** `npx mortic` still doesn't ship (`private: true`), the PTY worker is POSIX-only, Chrome-first. The headline UX is unbuildable by an outsider.
3. **Provider coupling.** The value proposition ("Mortic owns truth, providers are evidence") needs at least two providers to be credible; today `ProviderName = "codex"`. A Claude adapter is the proof.
4. **Onboarding cliff.** The product is concept-dense (forks, checkpoints, deltas, receipts, compilations, artifacts) and the UI exposes nearly all of it. The backlog already names the fix: remove source-checkpoint clutter, add a project picker.
5. **Two megafiles.** `App.tsx` (~4.8k lines) and `projectStorage.ts` (~3k) are a growing velocity tax; cheaper to split now than post-release.
6. **Extraction eval gap** (above) — release means strangers' transcripts hit those regexes.

### Recommended sequence

Commit the in-flight coverage-receipts/import work → extraction golden-set eval → Claude provider adapter → UI simplification pass → packaging. Release talk becomes realistic after those, not before.
