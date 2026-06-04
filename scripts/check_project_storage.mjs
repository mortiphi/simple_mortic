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

const risk = committed.createdItems.find((item) => item.type === "risk");
assert.ok(risk, "risk extraction should exist");
const sourceSafety = committed.createdItems.find((item) => /Do not mutate the source Codex thread/.test(item.body));
assert.ok(sourceSafety, "source-thread safety extraction should exist");
snapshot = await store.updateExtractedItem(sourceSafety.id, { status: "approved" });
assert.equal(snapshot.extractedItems.find((item) => item.id === sourceSafety.id)?.status, "approved");
assert.equal(snapshot.production.riskUpdates.some((item) => item.id === sourceSafety.id), true);

const recommitted = await store.commitSession(session);
assert.equal(recommitted.createdItems.some((item) => item.delta === "unchanged"), true, "repeat commit should compare against existing items");

const productionPath = path.join(store.projectDir, "production.md");
const productionMarkdown = await readFile(productionPath, "utf8");
assert.match(productionMarkdown, /Production Chart/);
assert.match(productionMarkdown, /Do not mutate the source Codex thread/);

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
