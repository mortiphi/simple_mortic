# Mortic Voice Output Eval

This is the first skill-only eval harness for `$mortic-voice-output`.

It measures whether the skill produces the contract Mortic needs before we add more voice runtime architecture:

```jsonl
{"type":"speak","text":"complete spoken answer"}
{"type":"read","markdown":"readable screen version"}
```

## What It Measures

Hard shape metrics:

- First-pass valid NDJSON rate.
- Valid first `speak.text` line rate.
- Valid second `read.markdown` line rate.
- Speech hazard warning rate from the bundled validator.
- Average and p95 spoken length.
- Text-mode contamination rate for controls that should not use voice NDJSON.

Semantic proxy metrics:

- Whether `speak.text` is a complete spoken answer, not a teaser for `read.markdown`.
- Whether critical caveats in the readable notes are also present in natural speech.
- Whether speech covers prompt-specific required points.

The semantic metric is intentionally inspectable rather than magical: each prompt in [prompts.json](./prompts.json) has `mustCover` groups with regex alternatives. This does not replace human review or an LLM judge, but it catches the current failure mode where Notes carry important caveats that speech omits.

## Pass Bars

The current bars are stored in [prompts.json](./prompts.json):

- 90%+ first-pass valid NDJSON.
- 95%+ valid first `speak.text` line.
- 95%+ valid second `read.markdown` line.
- 90%+ complete spoken answer rate.
- 10% or less speech hazard warning rate.
- Zero Text-mode contamination.
- p95 spoken length at or below 1,200 characters.

If this eval fails, the next step should be tightening or rolling back the skill, not adding more voice architecture.

## Generate A Live Run

This uses the installed Codex CLI and the installed skill at:

```text
/Users/adsaha/.codex/skills/mortic-voice-output/SKILL.md
```

Run a small smoke sample first:

```bash
node evals/mortic-voice-output/run.mjs generate --limit 5
```

Live generation defaults to `gpt-5.4` with `medium` reasoning, matching the Mortic voice-mode target more closely than the normal Codex CLI default.

If the Codex CLI is slow or blocked, use a shorter timeout for a quick path check:

```bash
node evals/mortic-voice-output/run.mjs generate --limit 1 --timeout-ms 30000
```

Run the full corpus:

```bash
node evals/mortic-voice-output/run.mjs generate
```

Use a specific model:

```bash
node evals/mortic-voice-output/run.mjs generate --model gpt-5.4 --reasoning medium
```

The generated run is written to `evals/mortic-voice-output/runs/<timestamp>.json`.

## Score A Run

Score the latest run:

```bash
node evals/mortic-voice-output/run.mjs score
```

Score a specific run:

```bash
node evals/mortic-voice-output/run.mjs score --input evals/mortic-voice-output/runs/<timestamp>.json
```

Emit machine-readable output:

```bash
node evals/mortic-voice-output/run.mjs score --input evals/mortic-voice-output/runs/<timestamp>.json --json
```

## Subagent Workflow

For Codex app testing, generate shard prompts:

```bash
node evals/mortic-voice-output/run.mjs subagent-prompts --shards 4
```

This writes `evals/mortic-voice-output/subagent-shards/shard-*.md`.

Use one Codex subagent per shard. Each subagent should return JSON with:

```json
{
  "results": [
    { "id": "prompt-id", "output": "exact model output" }
  ]
}
```

Combine those result objects into a run file shaped like:

```json
{
  "version": 1,
  "metadata": {
    "generatedAt": "manual-subagent-run",
    "model": "subagents",
    "skillPath": "/Users/adsaha/.codex/skills/mortic-voice-output/SKILL.md"
  },
  "results": []
}
```

Then score it with the same `score` command.

## Interpreting Failures

Hard contract failures mean the parser cannot safely trust the output.

Speech hazard warnings mean the output parsed, but the spoken field may still be awkward or unsafe to read aloud.

Complete-answer failures mean the output may look nice in the UI but still fail the call experience because the important answer is hidden in Notes.
