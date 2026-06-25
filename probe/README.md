# Mercury Probe

A standalone comparison tool for the dual-model voice architecture. Tests whether Mercury-led generation (Mercury preliminary + main model) produces meaningfully better perceived latency than main-model-only generation.

## Setup

1. Copy `.env.example` to `.env` and fill in your API keys:
   ```
   cp .env.example .env
   ```
   - `OPENAI_API_KEY` — get from https://platform.openai.com/api-keys
   - `OPENROUTER_API_KEY` — get from https://openrouter.ai/keys

2. Start the server:
   ```
   npm start
   ```

3. Open http://localhost:3456 in your browser.

## What it tests

Four modes, all streaming text with timing metrics:

| Mode | Description |
|---|---|
| **Main only** | Baseline — just the main model. No Mercury. |
| **Mercury first** | Sequential — Mercury completes its preliminary, then the main model runs with Mercury's text in its prompt. |
| **Race** | Parallel — both start simultaneously, no abort. See who produces first output first and by how much. |
| **Race + resend** | The real architecture — both start, first to produce wins. Loser is aborted. If Mercury wins, the main model is resent with Mercury's text in the prompt. |

## What to look for

**Perceived first content** — the key metric. In "Main only" mode, this is the main model's first byte. In Mercury modes, this is Mercury's first byte (~500ms). If the gap is large (e.g., main model takes 5s to first byte), Mercury is buying ~4.5s of engagement.

**Mercury total vs Main first byte** — in sequential mode, if Mercury's total time is less than the main model's first byte, the main model's answer starts while Mercury is still "playing" — seamless. If Mercury finishes first, there's a gap.

**Race winner consistency** — in race mode, does Mercury win consistently? If the main model sometimes wins (fast models like gpt-4o-mini), the race adds complexity for little benefit.

**Race + resend total** — in the real architecture, the total time from request to main answer complete. Compare this to "Main only" total. If it's similar (because the resend overlaps Mercury's speech), the architecture is net-positive: same completion time, much earlier first content.

## Models

The main model is configurable. Try:
- `gpt-4o` — fast, good baseline
- `gpt-4o-mini` — very fast (Mercury may not win the race)
- `o1-mini` / `o1` — reasoning models, slow first byte (Mercury masks the gap best here)
- `o3-mini` — newer reasoning model

Mercury is always `inception/mercury-2` via OpenRouter (150 token limit).

## Tips

- Try questions that reasoning models spend time on before first token (e.g., "Analyze the time complexity of merging N sorted lists and explain when a heap approach is better than a divide-and-conquer approach").
- Use Cmd/Ctrl+Enter in the question box to run.
- The history table persists across runs in the same session — compare patterns across question types.
- `*` next to a Main first-byte time in history means it was a resend (first turn was aborted).
