import assert from "node:assert/strict";

const {
  CodexProviderAdapter,
  accountIdFromLoginOutput,
  loginStatusFromOutput
} = await import("../dist/node/server/providerAdapters.js");

assert.equal(loginStatusFromOutput(0, "Logged in as user@example.com"), "logged-in");
assert.equal(loginStatusFromOutput(1, "Not logged in. Run codex login."), "logged-out");
assert.equal(loginStatusFromOutput(null, "socket unavailable"), "unknown");
assert.equal(accountIdFromLoginOutput("Logged in as user@example.com"), "user@example.com");

const adapter = new CodexProviderAdapter();
const sourceRef = adapter.sourceReference({
  id: "source-local",
  projectId: "project-local",
  codexThreadId: "source-thread-123",
  title: "Source",
  workspacePath: "/tmp/mortic",
  sourceUri: "codex://threads/source-thread-123",
  createdAt: "2026-05-04T00:00:00.000Z",
  firstSeenAt: "2026-05-04T00:00:00.000Z",
  lastSeenAt: "2026-05-04T00:00:01.000Z",
  tags: [],
  childrenCheckpointIds: [],
  childrenScratchSessionIds: []
});
assert.equal(sourceRef.provider, "codex");
assert.equal(sourceRef.providerRefId, "source-thread-123");
assert.equal(sourceRef.threadId, "source-thread-123");
assert.equal(sourceRef.forkKind, "source");
assert.equal(sourceRef.persisted, true);
assert.equal(sourceRef.actions.resume.available, true);
assert.equal(sourceRef.actions.archive.available, false);
assert.equal(sourceRef.openTarget, "codex://threads/source-thread-123");

const scratchRef = adapter.scratchReference({
  id: "scratch-local",
  projectId: "project-local",
  sourceThreadId: "source-local",
  sourceCheckpointId: "checkpoint-local",
  codexScratchThreadId: "scratch-thread-456",
  forkedFromId: "source-thread-123",
  ephemeral: true,
  title: "Scratch",
  mode: "scratch",
  status: "committed",
  workspacePath: "/tmp/mortic",
  createdAt: "2026-05-04T00:00:00.000Z",
  updatedAt: "2026-05-04T00:00:02.000Z",
  transcriptPath: "/tmp/mortic/transcript.md",
  eventLogPath: "/tmp/mortic/events.jsonl",
  handoffPath: "/tmp/mortic/handoff.md",
  handoffShortPath: "/tmp/mortic/handoff.short.md",
  handoffFullPath: "/tmp/mortic/handoff.full.md",
  extractedItemsPath: "/tmp/mortic/extracted_items.json",
  tags: []
});
assert.equal(scratchRef?.provider, "codex");
assert.equal(scratchRef?.forkKind, "scratch");
assert.equal(scratchRef?.ephemeral, true);
assert.equal(scratchRef?.persisted, false);
assert.equal(scratchRef?.actions.resume.available, false);
assert.match(scratchRef?.actions.resume.disabledReason ?? "", /Ephemeral/);
assert.equal(scratchRef?.openTarget, "codex://threads/scratch-thread-456");

console.log("Provider adapter checks passed");
