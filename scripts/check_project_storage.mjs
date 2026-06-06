import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const realCodexHome = process.env.CODEX_HOME || path.join(process.env.HOME ?? "", ".codex");
const tempHome = await mkdtemp(path.join(tmpdir(), "mortic-project-home-"));
process.env.HOME = tempHome;
process.env.CODEX_HOME = realCodexHome;
process.env.MORTIC_CANONICAL_EXTRACTOR = "script";

const { createProjectStore } = await import("../dist/node/server/projectStorage.js");

const workspacePath = path.join(tempHome, "workspace", "demo");
const session = {
  id: "session-fixture",
  sourceUri: "codex://threads/source-thread-123",
  threadId: "source-thread-123",
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:02.000Z",
  codex: { available: true, version: "codex-cli fixture" },
  forkCheckpoint: {
    sourceThreadId: "source-thread-123",
    scratchThreadId: "scratch-thread-456",
    forkedAt: "2026-05-04T00:00:01.000Z",
    checkpointInstruction: "Only use post-checkpoint Mortic turns for handoff actionables."
  },
  transcript: [
    {
      id: "turn-user-1",
      role: "user",
      text: "We need to decide how to archive Mortic scratch sessions locally.",
      createdAt: "2026-05-04T00:00:03.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    },
    {
      id: "turn-assistant-1",
      role: "assistant",
      text: "Archive locally and keep source clean.",
      spokenText: "We should archive the scratch locally and keep the source thread clean.",
      notesText: [
        "Project State: Store scratch transcripts under the local project.",
        "Prioritization: Source-thread cleanliness is more important than preserving ephemeral Codex fork state.",
        "Task: Add tests for project storage and production chart generation.",
        "Risk: Do not mutate the source Codex thread during commit.",
        "Backlog: Add old-session migration only if it stays quick.",
        "Commit again later to add or refine more project state.",
        "### Freeze architecture while measuring",
        "Do not switch providers again yet. Keep the current architecture stable:"
      ].join("\n"),
      createdAt: "2026-05-04T00:00:04.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ],
  handoff: "# Short Prompt\n\nContinue with project storage.\n\n# Full Prompt\n\nContinue with local project storage and extraction tests.",
  handoffShort: "Continue with project storage.",
  handoffFull: [
    "Please continue by implementing local project storage and extraction tests. Treat source-thread cleanliness as the priority over preserving ephemeral Codex fork state.",
    "",
    "Project rule:",
    "- Commit Session updates only Mortic local archive and production state.",
    "- Do not mutate the source Codex thread during commit.",
    "",
    "Requirements:",
    "- Store scratch transcripts under the local project.",
    "- Add tests for project storage and production chart generation.",
    "- Compare extracted items against the existing extracted-items file and mark unchanged items.",
    "",
    "Risk gates:",
    "- Refuse to continue if the scratch thread matches the source thread.",
    "- Workflow copy from the UI should not become a backlog item."
  ].join("\n")
};

const store = await createProjectStore({
  workspacePath,
  sourceUri: session.sourceUri,
  threadId: session.threadId
});

await store.syncSession(session, { type: "test.session_synced" });
let snapshot = await store.snapshot(session);

assert.equal(snapshot.project.workspacePath, workspacePath);
assert.equal(snapshot.sourceThreads.length, 1);
assert.equal(snapshot.sourceThreads[0].codexThreadId, "source-thread-123");
assert.equal(snapshot.scratchSessions.length, 1);
assert.equal(snapshot.scratchSessions[0].codexScratchThreadId, "scratch-thread-456");
assert.equal(snapshot.scratchSessions[0].ephemeral, true);
assert.equal(snapshot.scratchSessions[0].forkedFromId, "source-thread-123");
assert.equal(snapshot.scratchSessions[0].description, undefined);
assert.equal(snapshot.scratchSessions[0].summary, undefined);
assert.notEqual(snapshot.scratchSessions[0].codexScratchThreadId, snapshot.sourceThreads[0].codexThreadId);
assert.equal(snapshot.sourceCheckpoints.length, 1);
assert.equal(snapshot.sourceCheckpoints[0].sourceThreadId, snapshot.sourceThreads[0].id);
assert.equal(snapshot.sourceCheckpoints[0].detectionSource, "initial");
assert.equal(snapshot.scratchSessions[0].sourceCheckpointId, snapshot.sourceCheckpoints[0].id);
assert.deepEqual(snapshot.sourceThreads[0].childrenCheckpointIds, [snapshot.sourceCheckpoints[0].id]);

await stat(snapshot.scratchSessions[0].transcriptPath);
await stat(snapshot.scratchSessions[0].eventLogPath);
const eventLog = await readFile(snapshot.scratchSessions[0].eventLogPath, "utf8");
assert.match(eventLog, /test\.session_synced/);

const siblingSession = {
  ...session,
  id: "session-fixture-sibling",
  createdAt: "2026-05-04T00:00:10.000Z",
  updatedAt: "2026-05-04T00:00:12.000Z",
  forkCheckpoint: {
    sourceThreadId: "source-thread-123",
    scratchThreadId: "scratch-thread-789",
    forkedAt: "2026-05-04T00:00:11.000Z",
    checkpointInstruction: "Independent sibling scratch under the same source checkpoint."
  }
};
await store.syncSession(siblingSession, { type: "test.sibling_session_synced" });
snapshot = await store.snapshot(siblingSession);
const firstSourceCheckpointIds = snapshot.sourceCheckpoints
  .filter((checkpoint) => checkpoint.sourceThreadId === snapshot.sourceThreads.find((source) => source.codexThreadId === "source-thread-123")?.id)
  .map((checkpoint) => checkpoint.id);
assert.equal(firstSourceCheckpointIds.length, 1, "same source state should still have one checkpoint");
const firstSourceSessions = snapshot.scratchSessions.filter((scratch) => scratch.sourceThreadId === snapshot.sourceThreads.find((source) => source.codexThreadId === "source-thread-123")?.id);
assert.equal(new Set(firstSourceSessions.map((scratch) => scratch.sourceCheckpointId)).size, 1, "sibling scratches should share the active checkpoint");

const secondSession = {
  ...session,
  id: "session-fixture-two",
  sourceUri: "codex://threads/source-thread-999",
  threadId: "source-thread-999",
  forkCheckpoint: {
    sourceThreadId: "source-thread-999",
    scratchThreadId: "scratch-thread-999",
    forkedAt: "2026-05-04T00:01:01.000Z",
    checkpointInstruction: "Independent scratch child under the second source thread."
  },
  transcript: [
    {
      id: "turn-user-second",
      role: "user",
      text: "Ask a quick unrelated question in a separate scratch.",
      createdAt: "2026-05-04T00:01:03.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
await store.syncSession(secondSession, { type: "test.second_session_synced" });
snapshot = await store.snapshot(secondSession);
assert.equal(snapshot.sourceThreads.length, 2);
assert.equal(snapshot.scratchSessions.length, 3);
assert.equal(snapshot.sourceCheckpoints.length, 2);
for (const source of snapshot.sourceThreads) {
  const children = snapshot.scratchSessions.filter((scratch) => scratch.sourceThreadId === source.id);
  assert.ok(children.length >= 1, "each source thread should own its own scratch children");
  assert.equal(children.every((scratch) => scratch.forkedFromId === source.codexThreadId), true);
}

await store.recordEvent(session, { type: "handoff.generated" });
snapshot = await store.snapshot();
assert.ok(snapshot.project.pendingSourceCheckpoint, "handoff generation should create a pending continuation marker");
assert.equal(snapshot.sourceCheckpoints.filter((checkpoint) => checkpoint.sourceThreadId === snapshot.project.pendingSourceCheckpoint.sourceThreadId).length, 1);

snapshot = await store.confirmSourceCheckpoint();
assert.equal(snapshot.project.pendingSourceCheckpoint, undefined);
const confirmedCheckpointId = snapshot.project.activeSourceCheckpointId;
assert.ok(confirmedCheckpointId, "confirming a continuation should activate a child checkpoint");
const confirmedCheckpoint = snapshot.sourceCheckpoints.find((checkpoint) => checkpoint.id === confirmedCheckpointId);
assert.equal(confirmedCheckpoint?.detectionSource, "handoff-marker");
assert.equal(confirmedCheckpoint?.parentCheckpointId, firstSourceCheckpointIds[0]);

const postHandoffSession = {
  ...session,
  id: "session-fixture-post-handoff",
  createdAt: "2026-05-04T00:02:00.000Z",
  updatedAt: "2026-05-04T00:02:02.000Z",
  forkCheckpoint: {
    sourceThreadId: "source-thread-123",
    scratchThreadId: "scratch-thread-post-handoff",
    forkedAt: "2026-05-04T00:02:01.000Z",
    checkpointInstruction: "Scratch after pasted handoff should attach to child checkpoint."
  }
};
await store.syncSession(postHandoffSession, { type: "test.post_handoff_session_synced" });
snapshot = await store.snapshot(postHandoffSession);
assert.equal(
  snapshot.scratchSessions.find((scratch) => scratch.codexScratchThreadId === "scratch-thread-post-handoff")?.sourceCheckpointId,
  confirmedCheckpointId,
  "new scratches after confirmation should attach to the child checkpoint"
);

await store.recordEvent(secondSession, { type: "handoff.generated" });
snapshot = await store.snapshot();
assert.ok(snapshot.project.pendingSourceCheckpoint, "second source should expose a pending continuation marker");
const pendingCheckpointId = snapshot.project.pendingSourceCheckpoint.sourceCheckpointId;
snapshot = await store.dismissSourceCheckpoint();
assert.equal(snapshot.project.pendingSourceCheckpoint, undefined);
const secondFollowUpSession = {
  ...secondSession,
  id: "session-fixture-second-follow-up",
  createdAt: "2026-05-04T00:03:00.000Z",
  updatedAt: "2026-05-04T00:03:02.000Z",
  forkCheckpoint: {
    sourceThreadId: "source-thread-999",
    scratchThreadId: "scratch-thread-second-follow-up",
    forkedAt: "2026-05-04T00:03:01.000Z",
    checkpointInstruction: "Dismissed continuation keeps this source on the current checkpoint."
  }
};
await store.syncSession(secondFollowUpSession, { type: "test.second_follow_up_session_synced" });
snapshot = await store.snapshot(secondFollowUpSession);
assert.equal(
  snapshot.scratchSessions.find((scratch) => scratch.codexScratchThreadId === "scratch-thread-second-follow-up")?.sourceCheckpointId,
  pendingCheckpointId,
  "dismissing a continuation should keep later scratches on the current checkpoint"
);

const committed = await store.commitSession(session);
assert.equal(committed.committedSession.status, "committed");
assert.ok(committed.committedSession.summary?.length > 20, "commit should create a canonical session summary");
assert.doesNotMatch(committed.committedSession.summary, /^Extracted \d+ canonical-state/i);
assert.doesNotMatch(committed.committedSession.summary, /cannot implement|workspace is currently read-only/i);
assert.ok(committed.createdItems.length >= 4, "commit should create canonical extraction items");
assert.equal(committed.createdItems.every((item) => item.status === "draft"), true);
assert.equal(committed.createdItems.every((item) => ["project_state", "prioritization", "task", "risk", "backlog"].includes(item.type)), true);
assert.equal(
  committed.createdItems.some((item) => item.evidenceSource === "transcript" && item.selectionReason && item.type === "task"),
  true,
  "commit should produce transcript-backed skill extraction for action items"
);
assert.equal(
  committed.createdItems.every((item) => !/handoff/i.test(item.selectionReason ?? "") && !/extracted from/i.test(item.selectionReason ?? "")),
  true,
  "selection reasons should describe project relevance, not extractor provenance"
);
assert.equal(
  committed.createdItems.some((item) => /commit again later/i.test(item.title) || /commit again later/i.test(item.body)),
  false,
  "commit workflow copy should not become a backlog item"
);
assert.equal(
  committed.createdItems.some((item) => /^###/.test(item.title) || /current architecture stable:$/.test(item.body)),
  false,
  "markdown headings and preface lines should not become canonical items"
);

let chart = await store.chart();
const compilation = chart.draftCompilations.find((item) => item.scratchSessionId === committed.committedSession.id);
assert.ok(compilation, "commit should create a draft compilation");
assert.equal(compilation.status, "draft", "compilation alone should not approve canonical state");
assert.equal(chart.checkpoints.length, 0, "compilation should not create canonical checkpoints");
assert.equal(chart.deltas.length, 0, "compilation should not create approved canonical deltas");
assert.equal(compilation.transcriptEntryCount, session.transcript.length, "compilation should record transcript coverage");
assert.equal(compilation.transcriptEndEntryId, session.transcript.at(-1).id, "compilation should record transcript end boundary");
assert.ok(committed.createdItems.every((item) => item.sourceCompilationId === compilation.id), "items should belong to the immutable compilation snapshot");

const firstCompileItemIds = committed.createdItems.map((item) => item.id);
const repeatedCommit = await store.commitSession(session);
chart = await store.chart();
assert.equal(repeatedCommit.createdItems.length, 0, "recompiling without new transcript entries should not create duplicate candidates");
assert.equal(
  chart.draftCompilations.filter((item) => item.scratchSessionId === repeatedCommit.committedSession.id).length,
  1,
  "recompiling without new transcript entries should not create a duplicate compilation snapshot"
);
snapshot = await store.snapshot(session);
for (const itemId of firstCompileItemIds) {
  assert.ok(snapshot.extractedItems.some((item) => item.id === itemId), `recompile should preserve pending item ${itemId}`);
}

const incrementalSession = {
  ...session,
  updatedAt: "2026-05-04T00:03:30.000Z",
  transcript: [
    ...session.transcript,
    {
      id: "turn-user-incremental-compile",
      role: "user",
      text: "Task: Add compile-window regression test so repeated compile without new transcript entries creates no duplicate candidates.",
      createdAt: "2026-05-04T00:03:30.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
const incrementalCommit = await store.commitSession(incrementalSession);
assert.equal(incrementalCommit.createdItems.length, 1, "new transcript entries should still compile into new candidates");
chart = await store.chart();
const incrementalCompilation = chart.draftCompilations.find(
  (item) => item.scratchSessionId === incrementalCommit.committedSession.id && item.id !== compilation.id
);
assert.ok(incrementalCompilation, "new transcript entries should create an incremental compilation snapshot");
assert.equal(incrementalCompilation.transcriptStartEntryId, "turn-user-incremental-compile", "incremental compilation should start at the first uncompiled turn");
assert.equal(incrementalCompilation.transcriptEntryCount, 1, "incremental compilation should cover only new transcript entries");
assert.ok(
  incrementalCompilation.basisDraftCompilationIds?.includes(compilation.id),
  "new compile snapshot should record pending draft compilations it reconciled against"
);

const risk = committed.createdItems.find((item) => item.type === "risk");
assert.ok(risk, "risk extraction should exist");
const sourceSafety = committed.createdItems.find((item) => /Do not mutate the source Codex thread/.test(item.body));
assert.ok(sourceSafety, "source-thread safety extraction should exist");
await assert.rejects(
  () => store.approveCompilation(compilation.id, { extractedItemIds: ["missing-item-id"] }),
  /Invalid selected item\(s\) for compilation/,
  "invalid explicit approval selections should not approve the whole compilation"
);
const approvedFromCompilation = await store.approveCompilation(compilation.id, { extractedItemIds: [sourceSafety.id] });
snapshot = approvedFromCompilation.projectState;
assert.equal(snapshot.extractedItems.find((item) => item.id === sourceSafety.id)?.status, "approved");
assert.equal(snapshot.production.riskUpdates.some((item) => item.id === sourceSafety.id), true);
assert.equal(approvedFromCompilation.checkpoints.length, 1, "approval should create a canonical checkpoint");
assert.equal(approvedFromCompilation.deltas.length, 1, "approval should create a canonical delta");
assert.equal(approvedFromCompilation.checkpoints[0].approvedDeltaIds[0], approvedFromCompilation.deltas[0].id);
assert.equal(approvedFromCompilation.sourceCheckpoints.some((checkpoint) => checkpoint.id === approvedFromCompilation.checkpoints[0].id), false, "source checkpoints are observations, not canonical checkpoints");

const approvedDelta = approvedFromCompilation.deltas[0];
const artifactPreview = await store.artifactPreview(approvedDelta.conversationArtifactId);
assert.ok(artifactPreview?.transcriptPreview?.includes("Mortic Transcript"), "approved delta should resolve to a readable transcript artifact");
assert.ok(artifactPreview.providerRefs.some((ref) => ref.provider === "codex" && ref.providerRefId === "scratch-thread-456"), "artifact should expose adapter-shaped Codex scratch provider ref");
const scratchProviderRef = artifactPreview.providerRefs.find((ref) => ref.providerRefId === "scratch-thread-456");
assert.equal(scratchProviderRef?.actions.resume.available, false, "ephemeral scratches should not be marked resumable");
assert.equal(approvedDelta.lifecycleAction, "create", "approved deltas should carry lifecycle metadata");
assert.equal(approvedDelta.lifecycleStatusAfter, "open", "new approved deltas should become open canonical items");
assert.ok(
  approvedFromCompilation.canonicalItems.some((item) => item.id === approvedDelta.canonicalItemId && item.lifecycleStatus === "open"),
  "chart response should include a current canonical item index"
);

const correctionTask = committed.createdItems.find((item) => item.type === "task");
assert.ok(correctionTask, "task extraction should exist for correction regression");
await store.updateExtractedItem(correctionTask.id, { status: "approved" });
chart = await store.chart();
let correctionDeltas = chart.deltas
  .filter((delta) => delta.sourceExtractedItemId === correctionTask.id)
  .sort((left, right) => left.version - right.version);
assert.equal(correctionDeltas.length, 1, "approving a correction fixture should create an initial task delta");
assert.equal(correctionDeltas[0].version, 1);

await store.updateExtractedItem(correctionTask.id, {
  title: `${correctionTask.title} (edited)`,
  body: `${correctionTask.body}\n\nManual correction: keep this task wording concise.`
});
chart = await store.chart();
correctionDeltas = chart.deltas
  .filter((delta) => delta.sourceExtractedItemId === correctionTask.id)
  .sort((left, right) => left.version - right.version);
assert.equal(correctionDeltas.length, 2, "editing an approved card should create a new canonical delta");
assert.equal(correctionDeltas[0].status, "superseded", "editing should supersede the previous approved delta");
assert.equal(correctionDeltas[1].version, 2, "approved edit should increment canonical delta version");
assert.equal(correctionDeltas[1].previousDeltaId, correctionDeltas[0].id, "approved edit should link to the previous delta");
assert.equal(correctionDeltas[1].lifecycleAction, "update", "approved edit should be an update lifecycle action");
assert.match(correctionDeltas[1].body, /Manual correction/);

const retiredCorrectionSnapshot = await store.updateExtractedItem(correctionTask.id, { retire: true });
chart = await store.chart();
correctionDeltas = chart.deltas
  .filter((delta) => delta.sourceExtractedItemId === correctionTask.id)
  .sort((left, right) => left.version - right.version);
assert.equal(correctionDeltas.length, 3, "retiring an approved card should create a canonical delta");
assert.equal(correctionDeltas[2].version, 3);
assert.equal(correctionDeltas[2].previousDeltaId, correctionDeltas[1].id);
assert.equal(correctionDeltas[2].lifecycleAction, "drop");
assert.equal(correctionDeltas[2].lifecycleStatusAfter, "dropped");
assert.equal(retiredCorrectionSnapshot.extractedItems.find((item) => item.id === correctionTask.id)?.status, "approved", "retired cards stay approved for provenance");
assert.ok(
  chart.canonicalItems.some((item) => item.id === correctionDeltas[2].canonicalItemId && item.lifecycleStatus === "dropped"),
  "retired card should appear as dropped in the canonical item index"
);

const resolvedRiskSession = {
  ...session,
  id: "session-fixture-resolve-risk",
  createdAt: "2026-05-04T00:04:00.000Z",
  updatedAt: "2026-05-04T00:04:02.000Z",
  forkCheckpoint: {
    sourceThreadId: "source-thread-123",
    scratchThreadId: "scratch-thread-resolve-risk",
    forkedAt: "2026-05-04T00:04:01.000Z",
    checkpointInstruction: "Resolve an existing canonical risk from the approved production chart."
  },
  transcript: [
    {
      id: "turn-resolve-user",
      role: "user",
      text: "Mark the source thread mutation risk resolved after the storage work.",
      createdAt: "2026-05-04T00:04:03.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    },
    {
      id: "turn-resolve-assistant",
      role: "assistant",
      text: "The source mutation risk is resolved.",
      notesText: "Risk: Do not mutate the source Codex thread during commit is resolved after verified scratch-only commit storage.",
      createdAt: "2026-05-04T00:04:04.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
const resolvedCommit = await store.commitSession(resolvedRiskSession);
const resolvedCompilationChart = await store.chart();
const resolvedCompilation = resolvedCompilationChart.draftCompilations.find((item) => item.scratchSessionId === resolvedCommit.committedSession.id);
assert.ok(resolvedCompilation, "resolved-risk commit should create a compilation");
const sourceSafetyCanonicalId = sourceSafety.canonicalItemId ?? sourceSafety.id;
const resolvedRisk = resolvedCommit.createdItems.find((item) => item.lifecycleAction === "resolve" && item.targetCanonicalItemId === sourceSafetyCanonicalId);
assert.ok(resolvedRisk, "resolved-risk commit should produce a lifecycle resolution item");
assert.equal(resolvedRisk.targetCanonicalItemId, sourceSafetyCanonicalId, "resolution should target the approved canonical risk");
const approvedResolution = await store.approveCompilation(resolvedCompilation.id, { extractedItemIds: [resolvedRisk.id] });
const resolutionDelta = approvedResolution.deltas.find((delta) => delta.sourceExtractedItemId === resolvedRisk.id);
assert.equal(resolutionDelta?.lifecycleAction, "resolve");
assert.equal(resolutionDelta?.lifecycleStatusBefore, "open");
assert.equal(resolutionDelta?.lifecycleStatusAfter, "resolved");
assert.equal(resolutionDelta?.targetCanonicalItemId, sourceSafetyCanonicalId);
assert.ok(
  approvedResolution.canonicalItems.some((item) => item.id === sourceSafetyCanonicalId && item.lifecycleStatus === "resolved"),
  "approving a lifecycle resolution should update the canonical item index"
);

const supersedeMentionSession = {
  ...session,
  id: "session-fixture-supersede-mention",
  createdAt: "2026-05-04T00:05:00.000Z",
  updatedAt: "2026-05-04T00:05:02.000Z",
  forkCheckpoint: {
    sourceThreadId: "source-thread-123",
    scratchThreadId: "scratch-thread-supersede-mention",
    forkedAt: "2026-05-04T00:05:01.000Z",
    checkpointInstruction: "Capture a risk that mentions supersede behavior without making it a supersede action."
  },
  transcript: [
    {
      id: "turn-supersede-mention",
      role: "user",
      text: "Risk: Supersede flow can erase history. Track the risk that compile or approval reconciliation can hide older wording if supersede handling is wrong.",
      createdAt: "2026-05-04T00:05:03.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
const supersedeMentionCommit = await store.commitSession(supersedeMentionSession);
const supersedeMention = supersedeMentionCommit.createdItems.find((item) => /Supersede flow can erase history/.test(item.title) || /Supersede flow can erase history/.test(item.body));
assert.ok(supersedeMention, "supersede-word risk should be extracted");
assert.equal(supersedeMention.lifecycleAction, "create", "mentioning a supersede flow should not supersede the risk itself");
assert.equal(supersedeMention.lifecycleStatusAfter, "open");
const supersedeMentionChart = await store.chart();
const supersedeMentionCompilation = supersedeMentionChart.draftCompilations.find((item) => item.scratchSessionId === supersedeMentionCommit.committedSession.id);
assert.ok(supersedeMentionCompilation, "supersede-word risk compile should create a compilation");
await store.approveCompilation(supersedeMentionCompilation.id, { extractedItemIds: [supersedeMention.id] });
const supersedeMentionCanonicalId = supersedeMention.canonicalItemId ?? supersedeMention.id;

const duplicateSupersedeMentionSession = {
  ...supersedeMentionSession,
  id: "session-fixture-supersede-mention-duplicate",
  createdAt: "2026-05-04T00:06:00.000Z",
  updatedAt: "2026-05-04T00:06:02.000Z",
  forkCheckpoint: {
    sourceThreadId: "source-thread-123",
    scratchThreadId: "scratch-thread-supersede-mention-duplicate",
    forkedAt: "2026-05-04T00:06:01.000Z",
    checkpointInstruction: "Repeat the supersede wording risk to verify duplicate lifecycle handling."
  },
  transcript: [
    {
      id: "turn-supersede-mention-duplicate",
      role: "user",
      text: "Risk: Supersede flow can erase history. Track the risk that compile or approval reconciliation can hide older wording if supersede handling is wrong.",
      createdAt: "2026-05-04T00:06:03.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
const duplicateSupersedeMentionCommit = await store.commitSession(duplicateSupersedeMentionSession);
const duplicateSupersedeMention = duplicateSupersedeMentionCommit.createdItems.find((item) => /Supersede flow can erase history/.test(item.title) || /Supersede flow can erase history/.test(item.body));
assert.ok(duplicateSupersedeMention, "duplicate supersede-word risk should be extracted for review");
assert.equal(duplicateSupersedeMention.status, "draft", "duplicate extraction should not inherit approved status");
assert.equal(duplicateSupersedeMention.lifecycleAction, "append_evidence", "duplicate supersede-word risk should append evidence, not supersede itself");
assert.equal(duplicateSupersedeMention.lifecycleStatusAfter, "open");
assert.equal(duplicateSupersedeMention.targetCanonicalItemId, supersedeMentionCanonicalId);
await store.updateExtractedItem(duplicateSupersedeMention.id, { status: "dismissed" });
chart = await store.chart();
const dismissedDuplicateCompilation = chart.draftCompilations.find((item) => item.scratchSessionId === duplicateSupersedeMentionCommit.committedSession.id);
assert.equal(dismissedDuplicateCompilation?.status, "superseded", "dismissing every item in a compilation should close the draft compilation");

const backlog = committed.createdItems.find((item) => item.type === "backlog");
assert.ok(backlog, "backlog extraction should exist");
snapshot = await store.updateExtractedItem(backlog.id, { status: "approved" });
chart = await store.chart();
assert.ok(chart.deltas.some((delta) => delta.sourceExtractedItemId === backlog.id), "legacy extraction approval path should create a canonical delta");

const promotionSession = {
  ...session,
  id: "session-fixture-promote-backlog",
  createdAt: "2026-05-04T00:07:00.000Z",
  updatedAt: "2026-05-04T00:07:02.000Z",
  forkCheckpoint: {
    sourceThreadId: "source-thread-123",
    scratchThreadId: "scratch-thread-promote-backlog",
    forkedAt: "2026-05-04T00:07:01.000Z",
    checkpointInstruction: "Promote an approved backlog item into active task work."
  },
  transcript: [
    {
      id: "turn-promote-backlog-user",
      role: "user",
      text: `I want to move ${backlog.title} out of backlog and into tasks.`,
      createdAt: "2026-05-04T00:07:03.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
const promotionCommit = await store.commitSession(promotionSession);
assert.equal(promotionCommit.createdItems.length, 1, "promotion intent should create one draft candidate");
const promotionItem = promotionCommit.createdItems[0];
assert.equal(promotionItem.type, "task", "promotion should create a task candidate");
assert.equal(promotionItem.canonicalOperation, "promote_backlog_to_task", "promotion should carry an explicit canonical operation");
assert.equal(promotionItem.targetCanonicalItemId, backlog.canonicalItemId ?? backlog.id, "promotion should target the existing backlog item");

const duplicatePromotionSession = {
  ...promotionSession,
  updatedAt: "2026-05-04T00:07:12.000Z",
  transcript: [
    ...promotionSession.transcript,
    {
      id: "turn-promote-backlog-repeat",
      role: "user",
      text: `Move ${backlog.title} from backlog to task so it is no longer active backlog.`,
      createdAt: "2026-05-04T00:07:12.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
const duplicatePromotionCommit = await store.commitSession(duplicatePromotionSession);
assert.equal(duplicatePromotionCommit.createdItems.length, 0, "recompiling an unresolved promotion should merge into the pending draft");
assert.equal(duplicatePromotionCommit.committedSession.summary, "Updated existing pending canonical drafts.", "merged recompiles should not inherit noisy extraction summaries");
snapshot = await store.snapshot(duplicatePromotionSession);
assert.equal(
  snapshot.extractedItems.filter((item) => item.status === "draft" && item.canonicalOperation === "promote_backlog_to_task" && item.targetCanonicalItemId === (backlog.canonicalItemId ?? backlog.id)).length,
  1,
  "only one pending promotion draft should remain active"
);

const explanationOnlySession = {
  ...duplicatePromotionSession,
  updatedAt: "2026-05-04T00:07:22.000Z",
  transcript: [
    ...duplicatePromotionSession.transcript,
    {
      id: "turn-promotion-question",
      role: "user",
      text: "If I compile now, will the previous backlog item get retired?",
      createdAt: "2026-05-04T00:07:20.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    },
    {
      id: "turn-promotion-explanation",
      role: "assistant",
      text: "Not guaranteed. Based on the current canonical state, the desired behavior is that compiling now creates a draft promotion candidate.",
      notesText: [
        "Desired behavior:",
        `- Tasks includes ${backlog.title}.`,
        "- Backlog no longer shows it as active.",
        "- The old backlog record remains linked as provenance or historical state.",
        "Safe acceptance check after approval: the task appears once and no duplicate active backlog remains."
      ].join("\n"),
      createdAt: "2026-05-04T00:07:21.000Z",
      scratchMode: "voice",
      reasoningEffort: "low"
    }
  ]
};
const explanationOnlyCommit = await store.commitSession(explanationOnlySession);
assert.equal(explanationOnlyCommit.createdItems.length, 0, "assistant acceptance-check prose should not create draft candidates");
assert.equal(explanationOnlyCommit.committedSession.summary, "No new canonical candidates since the last compilation.", "explanation-only compiles should get a no-op summary");
snapshot = await store.snapshot(explanationOnlySession);
assert.equal(
  snapshot.extractedItems.filter((item) => item.status === "draft" && item.canonicalOperation === "promote_backlog_to_task" && item.targetCanonicalItemId === (backlog.canonicalItemId ?? backlog.id)).length,
  1,
  "explanation compile should not grow the promotion review queue"
);

chart = await store.chart();
const promotionCompilation = chart.draftCompilations.find((item) => item.extractedItemIds.includes(promotionItem.id));
assert.ok(promotionCompilation, "promotion candidate should belong to a draft compilation");
const approvedPromotion = await store.approveCompilation(promotionCompilation.id, { extractedItemIds: [promotionItem.id] });
const promotedBacklog = approvedPromotion.projectState.extractedItems.find((item) => item.id === backlog.id);
assert.equal(promotedBacklog?.lifecycleStatusAfter, "superseded", "approving promotion should retire the old backlog item");
assert.equal(promotedBacklog?.mergedIntoId, promotionItem.canonicalItemId, "retired backlog should link to the promoted task");
assert.ok(
  approvedPromotion.projectState.production.taskUpdates.some((item) => item.id === promotionItem.id && item.canonicalOperation === "promote_backlog_to_task"),
  "approved promotion should appear as a task update"
);

await rm(path.join(store.projectDir, "canonical_chart.json"), { force: true });
const migratedStore = await createProjectStore({
  workspacePath,
  sourceUri: session.sourceUri,
  threadId: session.threadId
});
const migratedChart = await migratedStore.chart();
assert.ok(migratedChart.checkpoints.some((checkpoint) => checkpoint.imported), "legacy approved items should import into an initial checkpoint");
assert.ok(migratedChart.deltas.every((delta) => delta.conversationArtifactId), "imported deltas should keep artifact provenance");

const recommitted = await store.commitSession(session);
assert.equal(recommitted.createdItems.some((item) => item.delta === "unchanged"), true, "repeat commit should compare against existing items");

const productionPath = path.join(store.projectDir, "production.md");
const productionMarkdown = await readFile(productionPath, "utf8");
assert.match(productionMarkdown, /Production Chart/);
assert.match(productionMarkdown, /Do not mutate the source Codex thread/);
assert.match(productionMarkdown, /Historical/);
assert.match(productionMarkdown, /_resolved_/);

const extractedMarkdown = await readFile(path.join(store.projectDir, "extracted_items.md"), "utf8");
assert.match(extractedMarkdown, /Risk Update/);
assert.match(extractedMarkdown, /unchanged/);

const canonical = await store.canonicalState();
assert.match(canonical.productionMarkdown, /Production Chart/);
assert.match(canonical.extractedItemsMarkdown, /Mortic Extracted Items/);
assert.equal(canonical.projectDir, store.projectDir);

snapshot = await store.archiveSession(session);
assert.ok(snapshot.scratchSessions.some((item) => item.status === "archived" || item.status === "committed"));

const legacyTarget = snapshot.scratchSessions[0];
const legacySessionPath = path.join(path.dirname(legacyTarget.eventLogPath), "session.json");
const legacySession = JSON.parse(await readFile(legacySessionPath, "utf8"));
delete legacySession.sourceCheckpointId;
await writeFile(legacySessionPath, `${JSON.stringify(legacySession, null, 2)}\n`, "utf8");
await rm(path.join(store.projectDir, "source_checkpoints"), { recursive: true, force: true });
snapshot = await store.snapshot();
assert.ok(snapshot.sourceCheckpoints.length >= 1, "legacy projects should lazily recreate base checkpoints");
assert.ok(
  snapshot.scratchSessions.find((scratch) => scratch.id === legacyTarget.id)?.sourceCheckpointId,
  "legacy scratch sessions should be assigned a source checkpoint"
);

await rm(tempHome, { recursive: true, force: true });
console.log("Project storage checks passed");
