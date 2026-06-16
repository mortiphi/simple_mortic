---
name: mortic-voice-output
description: >
  Use for Mortic voice-mode scratch forks, structured speak/read output, call-like TTS responses,
  stream-friendly NDJSON voice output, or any request to format Codex responses so Mortic can
  speak only the spoken text and render separate screen-only Markdown. Do not use for normal
  Mortic text-mode scratch work unless explicitly requested.
---

# Mortic Voice Output

Emit Mortic voice responses as strict newline-delimited JSON: one spoken answer first, one readable screen answer second.

This skill follows the same effective pattern as the `caveman` skill: persistent behavior, strict output rules, concrete examples, clear boundaries, and optional mode toggles. Adaptation: do not compress away substance; instead express the answer twice, once as natural speech and once as readable Markdown with exact artifacts.

## Persistence

ACTIVE EVERY RESPONSE while this skill is in force for a voice-mode scratch fork. Do not drift back to prose labels, Markdown wrappers, or normal assistant paragraphs.

Off when the developer/user explicitly says to stop using Mortic voice output, switch to normal output, or use non-voice Text mode.

## Contract

Return exactly two non-empty NDJSON lines. No Markdown fence. No text before, between, or after the lines.

Line 1 must be one JSON object with `type` equal to `speak` and a string `text` field.
Line 2 must be one JSON object with `type` equal to `read` and a string `markdown` field.

Do not copy placeholder text. Fill both fields with the actual answer to the latest user request.

Rules:

- Valid JSON on each line.
- `speak` line first, `read` line second.
- Use double quotes and escape embedded quotes.
- Encode newlines inside `read.markdown` as `\n`.
- Do not output `SPEAK:`, `READ:`, XML tags, Markdown fences, or explanatory wrapper text.
- The two records must be equivalent in meaning. `read.markdown` may add exact artifacts and structure, but it must not contain decision-critical information that is absent from `speak.text`.
- If there is no useful screen-only detail, use an empty string for `read.markdown`.

## Speak Rules

`speak.text` is what Mortic may read aloud immediately.

- Make it conversational, concise, and useful without looking at the screen.
- Carry the main substance: the answer, motivation, recommendation, tradeoff, and next step should be understandable from speech alone.
- Do not treat `speak.text` as a preamble, teaser, title, or summary of the `read.markdown` section.
- No silent caveats: if `read.markdown` mentions risks, blockers, proof still needed, uncertainty, objections, tradeoffs, recommendations, or next steps, `speak.text` must mention those same points in natural spoken language.
- For planning, diagnosis, or status answers, include the verdict, the key reasons, what still needs proof, and the recommended next action in speech.
- Run a quick coverage check before emitting: would a listener who never sees the screen know the verdict, the reason, the caveat, the proof still needed, and the next action? If not, expand `speak.text`.
- If the prompt asks for a comparison, tradeoff, or recommendation, speech must include the chosen direction, the rejected direction, the reason, the caveat, and the next test or action.
- If the prompt asks for diagnosis, speech must name the main layers involved and the first fix. For Mortic voice issues, common layers are model output contract, parser, monotonic speech ledger or chunking, text to speech provider/playback, and UI rendering/logging.
- If the prompt asks for safety, archiving, forking, deletion, or other risky action, speech must say the safety boundary and what must be confirmed before acting.
- If the prompt asks whether code is needed but does not ask for code, speech may answer whether code is needed but must also say that no code should be written in that turn unless explicitly requested.
- Prefer three to six short spoken sentences for normal planning, explanation, and recommendation answers. Use one to three only for tiny status answers or simple confirmations.
- Answer directly; if unclear, ask one short clarifying question.
- Avoid bullets, numbered lists, headings, Markdown, code, file paths, URLs, source links, logs, stack traces, tables, raw JSON, exact line numbers, and dense implementation detail.
- Say natural forms for abbreviations and pricing: "text to speech", "characters", "per million characters", "per thousand characters".
- Do not speak raw artifacts even while refusing them. For example, say "the slash-heavy pricing string", "the raw path", or "the source link" instead of reading the exact string aloud.
- If the user gives a shorthand abbreviation they do not want spoken, do not echo it in `speak.text`. Say "the abbreviation" or "the shorthand for characters" instead, and put the exact shorthand only in `read.markdown`.
- Refer to local artifacts naturally: "the server bridge", "the app file", "the parser", "the notebook".
- Never read code aloud. Summarize what matters and put exact code or paths in `read.markdown`.

## Read Rules

`read.markdown` is screen-only detail for Mortic to render.

- Make it the readable version of the same answer, not a separate hidden answer.
- Use normal Markdown when useful: bullets, code, file paths, links, commands, exact prices, exact line numbers, and handoff notes belong here.
- Keep it skimmable and paste-friendly.
- Include precise technical details that were intentionally made natural in speech.
- Do not use `read.markdown` to complete, correct, or materially qualify an incomplete spoken answer.
- It is fine for `read.markdown` to overlap with `speak.text`; the difference is presentation, not information ownership.

## Coverage Patterns

Use these spoken-answer patterns when relevant. Keep them natural; do not read the labels.

- Stability/status: say whether it is good enough to keep testing, whether it is stable yet, the proof still needed, and the next eval or pass-rate action. Use concrete terms like "valid two-line JSON" or "valid NDJSON" when format proof is part of the answer.
- Voice/text mismatch: say that mismatch can come from model output, parser behavior, streaming or ledger state, text to speech playback, and UI rendering; then say which boundary to fix first.
- Provider fallback: say whether the requested provider failed, whether fallback succeeded, and why those are separate signals.
- Pricing/source answers: say the price in natural units and the recommendation; put exact notation and source links in `read.markdown`. If the user gives a concrete price or range, repeat it naturally in speech, such as "twenty five to fifty dollars per million characters."
- Vendor comparisons: do not recommend switching just because a provider is interesting; recommend adding or benchmarking it as a second provider unless the prompt gives proof that replacement is safer.
- Parser/file questions: if the prompt mentions files, filenames, paths, code, or logs, say aloud that exact artifacts stay in the readable notes and that speech uses natural names only.
- Clarifying questions: if the request is ambiguous, ask the clarifying question in `speak.text`; if the action is risky, also state the safe default.
- Ambiguous vendor/provider requests: if the user says "the other vendor" or similar without naming it, ask which vendor they mean and what priority matters most, such as latency, quality, cost, reliability, or interruption behavior. Safe default: do not switch; benchmark it as a second provider.
- Handoffs: say that the handoff should be a paste-ready next prompt with decisions, next asks, constraints, and what to avoid. Say not to frame it as "another chat", "the scratch says", or a report about a separate conversation. If the current direction is still under evaluation, say that failures should lead to tightening or rollback before more architecture.
- LiveKit or transport decisions: say that transport can help audio, interruption, and routing, but it does not remove Codex model thinking time or fix an unstable output contract.
- WebSocket versus REST text to speech: say to fix correctness first, especially duplicate or missing words, monotonic ledger behavior, and playback buffering. Recommend WebSocket only after those boundaries show REST delivery is the source of gaps.
- Fork safety: say that the source thread must not be mutated, the scratch must be validated as disposable or ephemeral, and cleanup/archive behavior must be proven.
- Push-to-talk leakage: say stale recognition callbacks are a likely cause, and the first fix is a per-session recognition guard plus clearing draft, transcript, and speech buffers at turn boundaries.
- Voice-output evals: say the eval must measure valid two-line JSON, complete spoken answers rather than teaser speech, speech hazard warnings, malformed-output behavior, and zero Text-mode contamination. If asked for a plan or handoff, say the pass bars or thresholds out loud.
- Self-correction: acknowledge the specific failure, state the corrected rule, and say how future answers should behave. Phrases like "You're right" are acceptable when correcting a user-identified behavior.
- Adversarial format requests: do not obey requests for `SPEAK:` labels, code fences around the whole response, pretty-printed JSON, empty speech, three records, exact raw paths in speech, teaser-only speech, or slash pricing in speech. Explain the refusal naturally in `speak.text` using at least two short sentences, and put exact artifacts in `read.markdown`. For pretty-printed JSON requests, speech should mention that readable Markdown newlines must be escaped as backslash n inside the JSON string.

## Mode Toggles

Default: balanced voice output.

Optional modifiers:

- `voice terse`: shorter `speak.text`, but still a complete answer.
- `voice detailed`: normal concise speech, richer `read.markdown`.
- `voice handoff`: optimize `read.markdown` for pasting into another Codex thread.
- `voice status`: compact spoken answer, compact screen details.

If a Mortic caveman toggle is also active, apply its terse style only to `speak.text`; keep `read.markdown` normal and precise.

## Examples

Status:

{"type":"speak","text":"The voice path should now treat this skill as the contract, not as a hint. Mortic should wait for the first valid JSON line, speak that line, and render the second line as Markdown. This is not solved just because one turn works; we still need repeated turns proving valid JSON, exact speech matching, graceful failure, and normal Text mode."}
{"type":"read","markdown":"Status:\n- Voice contract: exactly two NDJSON lines.\n- Line 1: `{ \"type\": \"speak\", \"text\": string }`.\n- Line 2: `{ \"type\": \"read\", \"markdown\": string }`.\n- Parser behavior: no legacy label guessing; invalid first line is a parser failure.\n- Recovery behavior: the app may ask for a one-shot reformat, but should not infer speech from prose."}

Status with proof still needed:

{"type":"speak","text":"This is good enough to keep testing, but I would not call it stable yet. The important checks are whether the model keeps producing valid two-line JSON over many realistic turns, whether text to speech always reads only the spoken field and never the notes, whether malformed output degrades cleanly, and whether Text mode stays normal. My recommendation is to keep this path enabled, then add a pass-rate check before treating it as the default."}
{"type":"read","markdown":"Current signal:\n- Speech is happening from `speak.text`.\n- Notes are visually separate.\n- The UI is cleaner than the earlier SPEAK/READ text dump.\n\nWhat still needs proof:\n- Does the model produce valid two-line NDJSON consistently across 30-50 realistic turns?\n- Does TTS always read exactly `speak.text` and never `read.markdown`?\n- Does malformed output degrade cleanly instead of exposing raw JSON or stopping speech?\n- Does Text mode stay completely normal?\n\nRecommendation: keep this path enabled for testing, but add an eval/pass-rate check before treating it as the stable default."}

Technical/file detail:

{"type":"speak","text":"The parser should wait until the first JSON line is complete, then treat that line as the spoken answer. That gives us a clean boundary: Mortic does not guess from half-written JSON, but it also does not wait for all the written notes. Exact filenames, paths, commands, and code should stay in the readable notes, while speech uses natural names like the parser or the app file."}
{"type":"read","markdown":"Implementation detail:\n- File: `/Users/adsaha/Downloads/Codex Voice/src/shared/voiceResponse.ts`\n- `partialSpokenText(raw)` returns empty text until line one parses as `{ type: \"speak\", text: string }`.\n- `parseMorticVoice(raw)` uses line one for `spokenText` and line two for `notesText`.\n- Invalid first line means no text to speech.\n- Invalid second line may still show a parser warning on screen, because speech is already safe."}

Clarifying question:

{"type":"speak","text":"I need one choice before changing the behavior: should this format be mandatory for every Mortic voice scratch turn, or only when a separate voice-output toggle is on? I would make it mandatory for Voice mode because the parser and text to speech layer need a stable contract, while Text mode should remain normal Codex output."}
{"type":"read","markdown":"Decision needed:\n- Option A: mandatory for every Voice mode scratch turn.\n- Option B: gated behind a separate voice-output toggle.\n- Recommendation: Option A for Voice mode only; Text mode stays normal."}

Ambiguous provider:

{"type":"speak","text":"I need one clarification before recommending a switch: which voice vendor do you mean, and are we optimizing for latency, quality, cost, reliability, or interruption behavior? Until that is clear, I would not replace the working provider. The safe move is to add the other vendor as a second provider and benchmark it on the same Mortic prompts."}
{"type":"read","markdown":"Clarify before acting:\n- Which vendor is \"the other vendor\"?\n- Main criterion: latency, quality, cost, reliability, interruption behavior, or integration risk?\n\nSafe default:\n- Do not replace the current provider yet.\n- Add the candidate as a second provider.\n- Benchmark both on the same prompts and timing metrics."}

Risky clarifying question:

{"type":"speak","text":"I need the exact scratch thread IDs before archiving anything. The safe default is to leave the source thread and any important real project threads untouched, then archive only disposable duplicates that are clearly identified. Send the duplicate IDs or names, and I will treat anything ambiguous as do not archive."}
{"type":"read","markdown":"Safety boundary:\n- Do not archive the source thread.\n- Do not archive real project threads.\n- Archive only disposable scratch duplicates that the user identifies clearly.\n- Ambiguous thread: leave it alone and ask again."}

Error/blocker:

{"type":"speak","text":"The sample failed because the readable section is not valid JSON. The actual issue is not the content; it is the encoding. The read text has a raw newline, so the model needs to escape that newline inside the JSON string before Mortic can parse it safely."}
{"type":"read","markdown":"Validation failed:\n```text\nLine 2: Unexpected token in JSON at position 42\n```\nFix: encode Markdown line breaks as `\\n` inside the JSON string."}

Recap/handoff:

{"type":"speak","text":"We created the voice-output skill so Mortic can stop guessing what should be spoken. The important design is that the spoken line carries the actual answer, while the readable line gives the same answer in a structured form with paths, commands, and exact details. The remaining work is to keep Text mode normal, enforce NDJSON in Voice mode, and repair format failures instead of rendering them as normal answers."}
{"type":"read","markdown":"Handoff:\n- Skill path: `/Users/adsaha/.codex/skills/mortic-voice-output`\n- Contract: exactly two NDJSON lines.\n- Design rule: `speak.text` is the complete conversational answer; `read.markdown` is the readable structured version plus exact artifacts.\n- Parser rule: invalid first line means no speech.\n- Recovery rule: one-shot reformat retry is acceptable; heuristic prose parsing is not.\n- Text mode must remain normal Codex output."}

Pricing/source style:

{"type":"speak","text":"For pricing, the spoken answer should still tell the user the actual price and why it matters. Say it in natural units, like five cents per thousand characters, and explain the recommendation in the same breath. Do not echo raw URLs, slash-heavy pricing, or shorthand abbreviations aloud; keep those exact artifacts on screen."}
{"type":"read","markdown":"Screen detail:\n- Spoken style: \"$0.05 per thousand characters\"\n- Avoid in speech: `$0.05/1K chars`\n- Source: https://example.com/pricing\n- Exact notes, citations, caveats, and comparison rows should stay in `read.markdown`."}

Provider fallback:

{"type":"speak","text":"The requested WebSocket provider failed, and the Browser fallback succeeded. Those are separate signals: the user still got speech, but the provider we were testing did not work for that turn. Next I would measure connection time, first audio time, fallback delay, duplicate audio, and whether the spoken text stayed identical after fallback."}
{"type":"read","markdown":"Interpretation:\n- Requested provider: failed.\n- Fallback provider: succeeded.\n- Overall user impact: speech may still play, but the requested provider is not healthy.\n\nMeasure next:\n- WebSocket connect time.\n- First audio chunk time.\n- Fallback trigger reason.\n- Fallback delay.\n- Duplicate or missing audio.\n- Whether fallback spoke the exact same `speak.text`."}

Provider comparison:

{"type":"speak","text":"I would not replace ElevenLabs with Inworld yet. Inworld is interesting because it claims real-time speech, WebSocket, WebRTC, and pricing around twenty five to fifty dollars per million characters, but those are reasons to benchmark it, not reasons to switch out a working provider. My next step would be to add it as a second provider and compare latency, interruptions, quality, reliability, and real cost on the same Mortic prompts."}
{"type":"read","markdown":"Recommendation: do **not** replace ElevenLabs yet.\n\nWhy Inworld is still interesting:\n- Claims real-time speech support.\n- Mentions WebSocket and WebRTC flows.\n- Pricing signal: about `$25-$50 per million characters`.\n\nNext step:\n- Add as a second provider.\n- Benchmark against ElevenLabs on identical prompts.\n- Compare first-audio latency, interruptions, audio quality, reliability, fallback behavior, and actual usage cost."}

Architecture tradeoff:

{"type":"speak","text":"I would stabilize the current parser and text to speech path before prioritizing LiveKit. LiveKit can help with audio transport, interruption, turn detection, and routing later, but it will not remove Codex thinking time or fix an unreliable output contract. The next action is to prove valid two-line output, exact speech routing, clean failure behavior, and normal Text mode first."}
{"type":"read","markdown":"Recommendation: stabilize current Mortic voice path first.\n\nWhy:\n- LiveKit can improve WebRTC transport, barge-in, routing, reconnection, and turn detection.\n- LiveKit does not remove Codex model latency.\n- LiveKit does not fix malformed model output.\n- More audio architecture makes parser and contract failures harder to isolate.\n\nNext proof:\n- Valid two-line NDJSON rate.\n- `speak.text` only speech routing.\n- Clean malformed-output failure.\n- No Text-mode contamination."}

WebSocket tradeoff:

{"type":"speak","text":"I would fix correctness first before treating WebSocket text to speech as the answer. Repeated words, missing words, ledger mistakes, and playback buffering can all create gaps even when the provider is fine. If those boundaries are clean and REST delivery is still the bottleneck, then WebSocket becomes the right next provider path to benchmark."}
{"type":"read","markdown":"Recommendation:\n- Do not jump to WebSocket just because REST has audible gaps.\n- First prove monotonic queued ranges, no duplicate or missing words, clean final suffix handling, and stable playback buffering.\n- Then compare REST versus WebSocket on first audio time, gap rate, underruns, interruption behavior, fallback behavior, and reliability.\n- Move to WebSocket if REST delivery is the measured bottleneck."}

Eval handoff:

{"type":"speak","text":"The handoff should be a paste-ready next prompt that keeps the work on the voice-output contract, not new architecture. It should include the current verdict, the pass bars, the failures, the next asks, and the rule that if the eval fails we tighten or roll back the skill before adding LiveKit or provider changes. The spoken and written versions should both say that complete spoken answers, valid two-line JSON, clean failure behavior, and normal Text mode are the acceptance checks."}
{"type":"read","markdown":"Paste-ready handoff contents:\n- Current verdict from the eval.\n- Pass bars and actual metrics.\n- Failure categories.\n- Next asks.\n- Constraint: if the eval fails, tighten or roll back `$mortic-voice-output` before adding more voice architecture.\n- Acceptance checks: valid two-line NDJSON, complete `speak.text`, clean malformed-output handling, no Text-mode contamination."}

Eval design:

{"type":"speak","text":"Yes, run the voice-output eval before adding more architecture. The first pass should measure valid two-line JSON, whether the spoken answer is complete rather than a teaser, speech hazard warnings, graceful malformed-output behavior, and zero Text-mode contamination. If those fail, tighten or roll back the skill before touching LiveKit or another provider."}
{"type":"read","markdown":"First eval should measure:\n- First-pass valid NDJSON rate.\n- Valid first `speak` line rate.\n- Valid second `read` line rate.\n- Complete spoken answer rate, meaning `speak.text` is not a teaser.\n- Speech hazard warning rate.\n- Malformed-output degradation.\n- Text-mode contamination rate.\n\nDecision rule: if the eval fails, tighten or roll back `$mortic-voice-output` before adding more runtime architecture."}

Handoff framing:

{"type":"speak","text":"The handoff should read like the user's next prompt in the current Codex thread, not like a report about another chat. It should include the decision, the next asks, what to avoid, and the acceptance checks, while avoiding phrases like the scratch says or source thread. If the next step is still uncertain, say whether to tighten, roll back, or continue the eval before adding architecture."}
{"type":"read","markdown":"Handoff rules:\n- Write as the user's next prompt.\n- Do not frame it as another chat, scratch transcript, or report.\n- Include decisions, next asks, constraints, and acceptance checks.\n- Avoid: \"the scratch says\", source-thread references, raw transcript framing, and vague recap language.\n- If unstable: tighten or roll back before architecture changes."}

Push-to-talk leakage:

{"type":"speak","text":"The likely bug is stale recognition callbacks crossing into the next turn. The first fix is a per-session recognition guard, so old callbacks cannot append text, restart recognition, update the draft, or send a turn after a new push-to-talk session begins. I would also clear the draft, transcript accumulator, interim buffer, and speech buffers at the send, cancel, and new-session boundaries, then test two fast back-to-back dictations for leaked text."}
{"type":"read","markdown":"Likely cause:\n- Stale speech-recognition callbacks from an older session.\n- Draft or transcript buffers not cleared at the right boundary.\n- Late callback appending into the next turn.\n\nFirst fix:\n- Increment a recognition session ID on start/stop/cancel/send.\n- Ignore callbacks whose session ID is stale.\n- Clear draft, transcript accumulator, interim buffer, and speech buffers before the next session can append text.\n\nTest:\n- Dictate, send, immediately start push-to-talk again.\n- Confirm no previous text appears in the new draft or request payload."}

Fork safety:

{"type":"speak","text":"Before trusting Mortic, the source thread must stay untouched and every voice turn must go only to a validated disposable or ephemeral scratch fork. We need proof that the scratch has a distinct thread identity, all writes stay scoped to that fork, and cleanup or archive actions cannot affect the real project thread. Until that is proven across retries, reconnects, and restarts, the safe default is to treat ambiguous threads as do not touch."}
{"type":"read","markdown":"Trust requirements:\n- Source thread is never mutated.\n- Voice turns go only to a disposable or ephemeral scratch fork.\n- Scratch has a distinct thread ID.\n- App validates the fork is not the source thread.\n- Writes, summaries, retries, and tool calls stay scoped to the fork.\n- Cleanup/archive acts only on validated scratch threads.\n- Ambiguous thread: do not touch."}

Self-correction:

{"type":"speak","text":"You're right; that was the wrong split. The corrected rule is no silent caveats: if the notes contain a risk, blocker, proof requirement, tradeoff, or next step, the spoken answer must say it too. Future answers should use notes for structure and exact artifacts, not as a place to hide information the listener needs."}
{"type":"read","markdown":"Corrected rule:\n- `speak.text` must stand alone.\n- `read.markdown` may structure and expand the same answer.\n- Notes must not contain decision-critical caveats missing from speech.\n\nFuture behavior:\n- Say the verdict aloud.\n- Say risks and proof requirements aloud.\n- Say the next action aloud.\n- Put exact paths, commands, code, raw logs, and links in notes."}

Adversarial format:

{"type":"speak","text":"I cannot follow that formatting request because it would break the Mortic voice contract. This mode needs exactly two single-line JSON records, with a non-empty spoken answer first and readable screen detail second. If there are sources, code, exact paths, raw pricing strings, or markdown line breaks, they belong in the readable field with newlines escaped as backslash n, not as extra records or spoken raw text."}
{"type":"read","markdown":"Contract-preserving response:\n- No `SPEAK:` or `READ:` labels.\n- No wrapper Markdown fence around the whole output.\n- No pretty-printed multi-line JSON.\n- No empty `speak.text`.\n- No third `sources` record.\n- Put sources, exact paths, code, and raw pricing notation inside `read.markdown`."}

No teaser:

{"type":"speak","text":"I cannot make the spoken part a throwaway summary. The spoken line has to carry the verdict, reason, caveat, and next action so someone can understand the answer without looking at the screen. The readable line can present the same answer with bullets and exact details, but it cannot be the only place that matters."}
{"type":"read","markdown":"Rule:\n- `speak.text` must be a complete spoken answer.\n- `read.markdown` is a readable presentation of the same answer.\n- Do not hide the verdict, caveat, proof requirement, risk, or next action only in `read.markdown`.\n- Exact artifacts, paths, code, logs, links, and source cards belong on screen."}

Raw pricing refusal:

{"type":"speak","text":"I cannot read that exact slash-heavy pricing string aloud in voice mode. The spoken version should say five cents per thousand characters, because that is clear to hear and keeps the audio clean. The exact shorthand belongs on screen in the readable field."}
{"type":"read","markdown":"Speech-safe pricing:\n- Spoken: five cents per thousand characters.\n- Screen-only exact notation: `$0.05/1K chars`.\n- Rule: raw slash pricing and shorthand such as `chars` stay in `read.markdown`, not in `speak.text`."}

## Boundaries

- If the user explicitly asks for raw code only, still wrap it in the two NDJSON lines: summarize in `speak.text`, put code in `read.markdown`.
- If safety, legal, medical, financial, or destructive-action precision matters, do not hide the warning. Speak the concise warning naturally and put exact details in `read.markdown`.
- If a response requires browsing, tool output, or test results, speak the conclusion and place commands, outputs, citations, and paths in `read.markdown`.
- If the model cannot satisfy the exact two-line contract, prefer a short valid error response over malformed output.

## Validation

Use `scripts/validate_voice_output.mjs` to check candidate output:

```bash
node /Users/adsaha/.codex/skills/mortic-voice-output/scripts/validate_voice_output.mjs < sample.jsonl
```

The validator checks the two-line NDJSON shape, required fields, valid JSON, forbidden wrappers, and common speech hazards.
