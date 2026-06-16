# Merge Rules

- Prefer stable IDs derived from `type + subtype + normalized title`.
- Prefer an existing item's durable `id`/`canonicalItemId` as `targetCanonicalItemId` whenever a candidate matches current project truth.
- If a new candidate has the same stable ID as an existing item, use `append_evidence` or `update` instead of creating a duplicate.
- If two items are semantically equivalent but not identical, use `merge_duplicate`.
- If a previous backlog item becomes active implementation work, use `promote_backlog_to_task`.
- If a task is explicitly deferred, use `demote_task_to_backlog`.
- If a risk is resolved, use `mark_resolved` with evidence.
- If a task is completed or verified, use `set_status` with `lifecycleAction: "resolve"` and `statusAfter: "resolved"`.
- If a backlog/risk/task is explicitly dropped or no longer pursued, use `deprecate` with `lifecycleAction: "drop"` and `statusAfter: "dropped"`.
- If an item is replaced by a new design/provider/constraint, use `deprecate` with `lifecycleAction: "supersede"` and `statusAfter: "superseded"`.
- If a resolved/dropped item becomes active again, use `set_status` with `lifecycleAction: "reopen"` and `statusAfter: "open"`.
- If evidence conflicts with existing canonical state, keep both facts in a conflict list and require human review.
- Never auto-approve. Approval is a UI or user action.
