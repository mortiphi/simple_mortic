import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const realCodexHome = process.env.CODEX_HOME || path.join(process.env.HOME ?? "", ".codex");
const tempHome = await mkdtemp(path.join(tmpdir(), "mortic-project-api-home-"));
process.env.HOME = tempHome;
process.env.CODEX_HOME = realCodexHome;

const { createMorticServer } = await import("../dist/node/server/app.js");
const { shutdownCodexBridges } = await import("../dist/node/server/codex.js");
const { createProjectStore } = await import("../dist/node/server/projectStorage.js");
const { projectDirForWorkspace, projectIdForWorkspace } = await import("../dist/node/server/projectStorage/ids.js");

const workspacePath = path.join(tempHome, "workspace", "demo");
const workspacePathB = path.join(tempHome, "workspace", "demo-b");
const threadIdB = "api-source-thread-456";
let session = {
  id: "api-session-fixture",
  sourceUri: "codex://threads/api-source-thread-123",
  threadId: "api-source-thread-123",
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:01.000Z",
  transcript: [],
  codex: { available: true, version: "codex-cli fixture" }
};

const storage = {
  sessionDir: path.join(tempHome, "session"),
  read: async () => session,
  write: async (next) => {
    session = next;
  },
  resetSource: async (next) => {
    session = { ...session, ...next, transcript: [], activeTurn: undefined, queuedTurn: undefined, updatedAt: new Date().toISOString() };
    return session;
  },
  clear: async () => {
    session = { ...session, transcript: [], activeTurn: undefined, queuedTurn: undefined, updatedAt: new Date().toISOString() };
    return session;
  },
  setActiveTurn: async (turn) => {
    session = { ...session, activeTurn: turn, updatedAt: new Date().toISOString() };
    return session;
  },
  updateActiveTurn: async (updater) => {
    session = { ...session, activeTurn: updater(session.activeTurn, session), updatedAt: new Date().toISOString() };
    return session;
  },
  setQueuedTurn: async (turn) => {
    session = { ...session, queuedTurn: turn, updatedAt: new Date().toISOString() };
    return session;
  },
  updateQueuedTurn: async (updater) => {
    session = { ...session, queuedTurn: updater(session.queuedTurn, session), updatedAt: new Date().toISOString() };
    return session;
  },
  append: async (entry) => {
    session = { ...session, transcript: [...session.transcript, entry], updatedAt: new Date().toISOString() };
    return session;
  },
  setHandoff: async ({ handoff, shortPrompt, fullPrompt }) => {
    session = { ...session, handoff, handoffShort: shortPrompt, handoffFull: fullPrompt, updatedAt: new Date().toISOString() };
    return session;
  },
  setForkCheckpoint: async (checkpoint) => {
    session = { ...session, forkCheckpoint: checkpoint, updatedAt: new Date().toISOString() };
    return session;
  },
  transcriptMarkdown: async () => "# Mortic Transcript\n"
};

const projectStore = await createProjectStore({
  workspacePath,
  sourceUri: session.sourceUri,
  threadId: session.threadId
});
const runtimeContextFor = (cwd) => ({
  status: "restored",
  trusted: true,
  sameMachineUser: true,
  effectiveCwd: cwd,
  workspaceRoots: [cwd],
  requested: { filesystem: "read-only", workspaceRoots: [], network: "unknown", approval: "never" },
  reason: "check_project_api_import fixture",
  audit: []
});
const app = await createMorticServer({
  storage,
  projectStore,
  canonicalMemoryEnabled: true,
  runtimeContext: runtimeContextFor(workspacePath),
  // The thread reserved for workspace B resolves there; everything else stays in workspace A.
  resolveRuntimeContext: async ({ threadId }) => runtimeContextFor(threadId === threadIdB ? workspacePathB : workspacePath)
});

try {
  await app.ready();
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);

  const sessionResponse = await app.inject({ method: "GET", url: "/api/session" });
  assert.equal(sessionResponse.statusCode, 200);
  assert.equal(sessionResponse.json().session.threadId, "api-source-thread-123");

  const importPack = {
    schemaVersion: "1.0",
    importId: "api-import-001",
    title: "API import route fixture",
    summary: "API import should create reviewable draft cards and no canonical checkpoint.",
    provider: "codex",
    providerRefId: "api-codex-scratch-001",
    conversationId: "api-codex-scratch-001",
    threadId: "api-codex-scratch-001",
    compilePlan: {
      id: "api-compile-plan-001",
      mode: "scratch_only",
      primaryWindows: [
        {
          provider: "codex",
          providerRefId: "api-codex-scratch-001",
          conversationId: "api-codex-scratch-001",
          threadId: "api-codex-scratch-001",
          windowKind: "primary",
          coveredTo: {
            provider: "codex",
            providerRefId: "api-codex-scratch-001",
            conversationId: "api-codex-scratch-001",
            threadId: "api-codex-scratch-001",
            messageId: "api-message-010",
            createdAt: "2026-06-06T00:00:10.000Z",
            transcriptHash: "api-import-transcript-hash-001",
            textExcerpt: "A Codex scratch skill posted this pack so the user can approve it inside Mortic."
          },
          transcriptHash: "api-import-transcript-hash-001",
          boundaryStatus: "proven"
        }
      ]
    },
    transcriptExcerpt: "A Codex scratch skill posted this pack so the user can approve it inside Mortic.",
    transcriptHash: "api-import-transcript-hash-001",
    candidateDeltas: [
      {
        id: "api-draft-card",
        type: "task_update",
        title: "Expose draft import API",
        body: "The Mortic server should expose a draft import API used by the canonical-state skill.",
        lifecycleAction: "create",
        lifecycleStatusAfter: "open"
      }
    ]
  };

  const imported = await app.inject({
    method: "POST",
    url: "/api/project/draft-compilations/import",
    payload: importPack
  });
  assert.equal(imported.statusCode, 200);
  const importedPayload = imported.json();
  assert.equal(importedPayload.createdItems.length, 1);
  assert.equal(importedPayload.createdItems[0].status, "draft");
  assert.equal(importedPayload.coverageReceipt.importId, "api-import-001");
  assert.equal(importedPayload.coverageReceipt.boundaryStatus, "proven");
  assert.equal(importedPayload.coverageReceipt.mode, "scratch_only");
  assert.equal(importedPayload.compilation.coverageReceiptId, importedPayload.coverageReceipt.id);
  assert.equal(importedPayload.checkpoints.length, 0, "draft import should not create canonical checkpoints");
  assert.equal(importedPayload.deltas.length, 0, "draft import should not create canonical deltas");

  const repeat = await app.inject({
    method: "POST",
    url: "/api/project/draft-compilations/import",
    payload: importPack
  });
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.json().compilation.id, importedPayload.compilation.id);
  assert.equal(repeat.json().coverageReceipt.id, importedPayload.coverageReceipt.id);

  const latestCoverage = await app.inject({
    method: "GET",
    url: "/api/project/coverage/latest?provider=codex&providerRefId=api-codex-scratch-001"
  });
  assert.equal(latestCoverage.statusCode, 200);
  assert.equal(latestCoverage.json().receipt.id, importedPayload.coverageReceipt.id);
  assert.equal(latestCoverage.json().coverageReceipts.length, 1);

  const project = await app.inject({ method: "GET", url: "/api/project" });
  assert.equal(project.statusCode, 200);
  assert.ok(project.json().extractedItems.some((item) => item.id === importedPayload.createdItems[0].id));

  const edited = await app.inject({
    method: "PATCH",
    url: `/api/project/extractions/${encodeURIComponent(importedPayload.createdItems[0].id)}`,
    payload: {
      type: "backlog",
      title: "Expose draft import API as backlog",
      body: "Keep this imported API card editable before approval so the user can correct kind, title, and body."
    }
  });
  assert.equal(edited.statusCode, 200);
  const editedItem = edited.json().extractedItems.find((item) => item.id === importedPayload.createdItems[0].id);
  assert.equal(editedItem.type, "backlog");
  assert.equal(editedItem.status, "draft");

  const preview = await app.inject({
    method: "GET",
    url: `/api/project/artifacts/${encodeURIComponent(importedPayload.compilation.conversationArtifactId)}`
  });
  assert.equal(preview.statusCode, 200);
  assert.match(preview.json().transcriptPreview, /Codex scratch skill posted this pack/);
  assert.ok(preview.json().providerRefs.some((ref) => ref.providerRefId === "api-codex-scratch-001"));

  const approved = await app.inject({
    method: "POST",
    url: `/api/project/compilations/${encodeURIComponent(importedPayload.compilation.id)}/approve`,
    payload: { extractedItemIds: [importedPayload.createdItems[0].id] }
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().approvedDeltaIds.length, 1);
  assert.equal(approved.json().checkpoints.length, 1);
  assert.equal(approved.json().deltas.length, 1);
  assert.equal(approved.json().deltas[0].type, "backlog");
  assert.equal(approved.json().deltas[0].title, "Expose draft import API as backlog");

  // Switching the source thread to one that resolves to a different workspace
  // must rebind the project store: /api/project serves the new project and the
  // old project's store stops receiving session writes.
  const projectDirA = projectDirForWorkspace(workspacePath);
  const projectDirB = projectDirForWorkspace(workspacePathB);
  const listSessions = async (projectDir) => {
    try {
      return (await readdir(path.join(projectDir, "sessions"), { recursive: true })).sort();
    } catch {
      return [];
    }
  };
  const workspaceASessionsBefore = await listSessions(projectDirA);

  const switched = await app.inject({
    method: "POST",
    url: "/api/session/source",
    payload: { sourceUri: `codex://threads/${threadIdB}` }
  });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().session.threadId, threadIdB);
  assert.equal(switched.json().runtimeContext.effectiveCwd, workspacePathB);

  const projectB = await app.inject({ method: "GET", url: "/api/project" });
  assert.equal(projectB.statusCode, 200);
  assert.equal(projectB.json().project.id, projectIdForWorkspace(workspacePathB));
  assert.equal(projectB.json().project.workspacePath, workspacePathB);

  const workspaceASessionsAfter = await listSessions(projectDirA);
  assert.deepEqual(
    workspaceASessionsAfter,
    workspaceASessionsBefore,
    "workspace A's project dir must gain no session files from the switch"
  );
  assert.ok(
    (await listSessions(projectDirB)).length > 0,
    "workspace B's project dir should hold the synced session after the switch"
  );

  // Switching to the same thread again resolves to the same cwd and project
  // dir, so the rebuild is skipped and the request still succeeds.
  const repeatSwitch = await app.inject({
    method: "POST",
    url: "/api/session/source",
    payload: { sourceUri: `codex://threads/${threadIdB}` }
  });
  assert.equal(repeatSwitch.statusCode, 200);
  assert.equal(repeatSwitch.json().session.threadId, threadIdB);

  // Switching back to a workspace-A thread builds a fresh store over the
  // original project dir and reports the original project id and data.
  const switchedBack = await app.inject({
    method: "POST",
    url: "/api/session/source",
    payload: { sourceUri: "codex://threads/api-source-thread-123" }
  });
  assert.equal(switchedBack.statusCode, 200);
  const projectA = await app.inject({ method: "GET", url: "/api/project" });
  assert.equal(projectA.statusCode, 200);
  assert.equal(projectA.json().project.id, projectIdForWorkspace(workspacePath));
  assert.equal(projectA.json().project.workspacePath, workspacePath);
  assert.ok(
    projectA.json().extractedItems.some((item) => item.id === importedPayload.createdItems[0].id),
    "original project data must survive the source-switch round trip"
  );
} finally {
  await app.close();
  await shutdownCodexBridges("Project API import harness complete");
  await rm(tempHome, { recursive: true, force: true });
}

console.log("Project API import checks passed");
process.exit(0);
