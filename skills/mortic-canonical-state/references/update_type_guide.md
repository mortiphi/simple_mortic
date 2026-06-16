# Update Type Guide

Use this guide whenever you assign a bucket or subtype.

## Subtype Vocabulary (closed sets — never invent a subtype)

- `project_state_update`: `objective` | `decision` | `constraint` | `architecture_fact` | `operating_rule` | `current_summary` | `glossary` | `source_safety` | `contract`
- `prioritisation_update`: `now` | `next` | `sequence` | `deprioritised` | `blocked_until` | `dependency`
- `task_update`: `create` | `test` | `fix` | `replace` | `complete` | `split` | `drop` | `block` | `unblock`
- `risk_update`: `source_thread_pollution` | `security` | `latency` | `cost` | `ux_confusion` | `data_loss` | `voice_quality` | `architecture`
- `backlog_update`: `future_enhancement` | `research_item` | `deferred_task` | `feature_idea`

Subtype hints:

- Source-thread safety rules ("never touch the source thread") -> `source_safety`, not `operating_rule`.
- Voice/TTS output shape rules ("TTS reads only spoken text") -> `contract`.
- Audio static, TTS quality, garbled speech -> `voice_quality`. Misattribution, silent fallback, confusing provider switches -> `ux_confusion`. Noisy text polluting canonical state -> `architecture`.
- A decided verification/measurement/comparison ("test that", "verify", "benchmark", "compare providers") -> task subtype `test`. New buildable work -> `create`. A finished task -> `complete`.
- "X before Y", "measure first, then decide" -> prioritisation subtype `sequence`.

## Project State Update

Use for durable facts future Mortic/Codex agents should believe: objective, decision, constraint, operating rule, architecture fact, glossary, or current project summary.

Do not use for a user question, a transient UI state, a one-off model answer, or a recommendation the user has not accepted.

## Prioritisation Update

Use when the session changes what matters now, next, later, blocked, or dependent. It explains sequencing and tradeoff, not the work item itself.

## Task Update

Use only for concrete work that can be implemented, tested, reviewed, completed, split, blocked, unblocked, or dropped.

## Risk Update

Use for things that could break the product, confuse the user, lose data, leak secrets, increase cost, pollute the source thread, or cause latency/quality problems.

## Backlog Update

Use only for explicit future work the user wants preserved. Do not turn "we can commit again later" or generic workflow text into backlog.

## Bucket Decision Rules

- A user imperative ("add X", "wire Y", "make Z open the viewer") is `task_update` subtype `create` — even when it sounds like a rule. Rules are only `project_state_update` when they constrain how ALL future work behaves.
- One delta per atomic fact. A turn with a `Task:` line and a `Test:` line yields two task deltas (`create`, then `test`). Never merge labeled lines into one delta.
- A decision-plus-guardrail sentence ("store transcripts locally; never rely on Codex retention") yields a `decision` delta and a separate `constraint` delta — both `project_state_update`. The guardrail is not a risk unless someone names a failure mode.
- A sequencing plan ("measure latency before switching providers, build the eval harness") yields a `prioritisation_update` (`sequence`) for the ordering AND a `task_update` (`test`) for the concrete harness work.
- An accepted provider recommendation that settles a comparison or check is `task_update` (`test`), not backlog.
- In a side-fork or scaffold planning session, each distinct planned feature the user wants kept is its own `backlog_update`; do not collapse several features into one item, and do not promote them to tasks unless the user starts the work now.
- Markdown headings, section scaffolding, and restatements of state that already exists in production extract to NOTHING — return an empty candidate list if that is all there is.

## Anti-Patterns

- User asks "can we do X?" -> no canonical delta unless the answer settles a decision or task.
- Assistant explains a UI button -> no canonical delta.
- "Commit again later" -> no backlog; it is workflow guidance.
- "Maybe someday" with no user interest -> rejected candidate.
- Rejected idea -> rejected candidate unless user says to track it.
