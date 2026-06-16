---
name: mortic-canonical-state
description: Use when extracting, validating, reviewing, applying, or evaluating Mortic canonical project-state deltas from scratch transcripts, production.json, production.md, extracted items, or session metadata. This skill treats canonical state as local Mortic-owned state and never mutates Codex source threads.
---

# Mortic Canonical State

Use this skill when a Mortic scratch session, Codex app work session, production chart, or extracted-item set needs to become reviewable project state. Treat the process as a compiler and reconciler, not a summary:

```text
existing production state + scratch transcript
  -> candidate lifecycle deltas
  -> reconciliation against existing project truth
  -> deterministic validation
  -> human review packet
  -> approved apply step
  -> regenerated production.md
```

## Invariants

- Never mutate, compact, or send turns to the Codex source thread.
- Never write canonical state directly from raw model prose. Produce typed deltas first.
- Every candidate delta must cite evidence from transcript, session metadata, production.json, or production.md.
- User questions are not canonical state by themselves.
- Assistant recommendations are candidates, not approved truth.
- Discarded or rejected ideas must not become tasks or backlog unless the user explicitly keeps them.
- Prefer updating, merging, or appending evidence to existing items over creating duplicates.
- Reconcile every compilation against current canonical state before presenting candidates.
- Reconcile against existing draft compilations too. If a later compile discusses an unresolved draft candidate, update or attach evidence to that pending draft instead of creating duplicate active candidates.
- Assistant explanations, expected-result checklists, safe acceptance checks, and “what should happen after approval” prose are context, not canonical state by themselves. Use them only as evidence for an explicit user instruction or existing pending candidate.
- When the user explicitly moves work from backlog to task, emit `canonicalOperation: "promote_backlog_to_task"` with the existing backlog item as `targetCanonicalItemId`; do not create a separate active task while leaving the backlog item active.
- Tasks, risks, and backlog items have lifecycle: `open`, `in_progress`, `resolved`, `dropped`, `superseded`, or `stale`.
- A resolved/dropped/superseded item remains historical truth but must not appear as active project work.

## Update Buckets

Use exactly these top-level buckets:

- `project_state_update`: objective, current summary, decision, constraint, architecture fact, operating rule, glossary.
- `prioritisation_update`: what matters now, next, later, is deprioritised, blocked, or dependent.
- `task_update`: concrete work that can be implemented, tested, reviewed, completed, blocked, split, dropped, or unblocked.
- `risk_update`: data loss, source-thread pollution, security, privacy, latency, cost, UX confusion, architecture, model error, packaging.
- `backlog_update`: explicit future work, research item, deferred task, plugin candidate, UI idea, or enhancement.

Read `references/update_type_guide.md` when bucket choice is unclear. Read `references/merge_rules.md` when production state already has similar items or when a candidate may resolve, drop, supersede, reopen, promote, or demote existing project truth.

## Lifecycle Reconciliation

For each candidate, first build a compact index from `production.json`, `production.md`, and existing extracted items. Match by durable item ID, normalized title, bucket/type, and body token overlap. Then choose one lifecycle action:

- `create`: new canonical item.
- `append_evidence`: same item, no state change.
- `update`: same item, meaning or priority changed.
- `resolve`: task/risk/backlog is completed or no longer applies.
- `drop`: explicitly discarded or no longer pursued.
- `supersede`: replaced by a newer item or provider/design choice.
- `reopen`: previously resolved/dropped item is active again.
- `no_op`: already represented and no new evidence should be applied.

Every non-create candidate must include `targetCanonicalItemId` when a matching item exists, plus `statusBefore`, `statusAfter`, `reconcilesWith`, and `reconciliationReason`.

## Required Output

Return a `CanonicalStateDeltaSet` matching `references/canonical_delta_schema.json`. The UI should show candidates for review; approved deltas can be applied with the bundled scripts.

Important shape:

```json
{
  "schemaVersion": "1.0",
  "projectId": "project-id",
  "sourceThreadId": "source-thread-id",
  "scratchSessionId": "scratch-session-id",
  "summary": "What changed in this scratch session.",
  "candidateDeltas": [
    {
      "operation": "mark_resolved",
      "targetCanonicalItemId": "risk-static-audio",
      "lifecycleAction": "resolve",
      "statusBefore": "open",
      "statusAfter": "resolved"
    }
  ],
  "rejectedCandidates": [],
  "warnings": [],
  "requiresHumanReview": true
}
```

## Push Drafts To Mortic App

When working in a Codex scratch or side fork that may be ephemeral, preserve useful project-state work by pushing a draft compilation pack to the running Mortic app before the conversation is abandoned. This is still review-only:

- Do not write `production.json`, `production.md`, `extracted_items.json`, or canonical chart files directly.
- Do not mark any candidate approved from the skill.
- Post candidates to Mortic as draft cards, then tell the user to approve or dismiss them in the app.
- Include `provider: "codex"` and the best available `threadId`, `conversationId`, or `providerRefId` when a Codex deep link/reference is known. If it is not known, still push the draft pack so local transcript/provenance is preserved.
- Include compile boundary metadata when available: `priorBoundaryReceiptId` or `priorImportId`, `basisCompilationId`, `sourceWindows` or `compilePlan`, `coveredFrom`, `coveredTo`, `boundaryStatus`, and `boundaryReason`. The push script will opportunistically query Mortic's latest coverage receipt for the same provider reference and fill `priorBoundaryReceiptId`, `basisCompilationId`, and `coveredFrom` when the pack omits them.
- Default side-fork semantics are `scratch_only`: the current scratch/side conversation is primary evidence. Parent/source-thread remainder should be marked as `excludedWindows` or `referenceWindows` unless the user explicitly asks to compile it too.
- Include a concise `transcriptExcerpt` with the evidence span that produced the deltas.

Draft import shape:

```json
{
  "schemaVersion": "1.0",
  "importId": "stable-human-readable-id",
  "title": "Scratch work import",
  "summary": "What changed in this Codex scratch.",
  "provider": "codex",
  "providerRefId": "codex-thread-or-scratch-id-if-known",
  "compilePlan": {
    "mode": "scratch_only",
    "primaryWindows": [
      {
        "provider": "codex",
        "providerRefId": "codex-thread-or-scratch-id-if-known",
        "windowKind": "primary",
        "coveredTo": {
          "messageId": "last-message-id-if-known",
          "transcriptHash": "hash-of-covered-evidence"
        },
        "boundaryStatus": "proven"
      }
    ]
  },
  "transcriptExcerpt": "Evidence from the scratch conversation.",
  "candidateDeltas": [
    {
      "id": "stable-candidate-id",
      "type": "task_update",
      "title": "Add Mortic draft import route",
      "body": "Mortic should accept review-only draft compilation packs from the canonical-state skill.",
      "lifecycleAction": "create",
      "statusAfter": "open",
      "evidenceQuote": "Relevant scratch quote."
    }
  ]
}
```

Push to a running local Mortic app:

```bash
node scripts/push_draft_compilation.mjs draft-pack.json --api http://127.0.0.1:5152
```

Use `MORTIC_API_URL` instead of `--api` when the app is on a different local port. Re-running the same `importId` should be idempotent in the app.

## Scripts

Run from the skill directory:

- Extract candidates from an input packet:
  `node scripts/extract_state_delta.mjs input.json > delta-set.json`
- Validate a delta set:
  `node scripts/validate_delta.mjs delta-set.json input.json`
- Apply approved deltas:
  `node scripts/apply_delta.mjs production.json delta-set.json approved-ids.json > production.next.json`
- Render readable markdown:
  `node scripts/render_production_md.mjs production.next.json > production.md`
- Push draft candidates into the running Mortic review queue:
  `node scripts/push_draft_compilation.mjs draft-pack.json --api http://127.0.0.1:5152`
- Check evidence quotes:
  `node scripts/check_evidence_refs.mjs delta-set.json input.json`
- Run the eval harness:
  `node scripts/run_harness.mjs`

The harness must pass before treating extraction changes as stable. It checks extraction, rejection, lifecycle action, target resolution, and approved-apply behavior. If it fails, tighten or roll back the skill before adding runtime architecture.
