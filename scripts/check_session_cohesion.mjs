import assert from "node:assert/strict";

process.env.MORTIC_ACTIVE_TURN_STALE_MS = "1";

const { createMorticServer, defaultMorticPreferences } = await import("../dist/node/server/app.js");
const { createMemoryPreferencesStore } = await import("../dist/node/server/preferences.js");
const { SessionCoordinator } = await import("../dist/node/server/sessionCoordinator.js");

const threadId = "00000000-0000-0000-0000-000000000000";
let session = {
  id: "cohesion-session",
  sourceUri: `codex://threads/${threadId}`,
  threadId,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  transcript: [],
  codex: { available: false, error: "fixture" }
};

const touch = (next) => {
  session = { ...next, updatedAt: new Date().toISOString() };
  return session;
};
const storage = {
  sessionDir: "/tmp/simple-mortic-cohesion-session",
  read: async () => session,
  write: async (next) => { touch(next); },
  resetSource: async (next) => touch({ ...session, ...next, transcript: [], activeTurn: undefined, queuedTurn: undefined }),
  clear: async () => touch({ ...session, transcript: [], composerDraft: undefined, handoff: undefined, handoffShort: undefined, handoffFull: undefined, activeTurn: undefined, queuedTurn: undefined }),
  setActiveTurn: async (activeTurn) => touch({ ...session, activeTurn }),
  updateActiveTurn: async (updater) => touch({ ...session, activeTurn: updater(session.activeTurn, session) }),
  setQueuedTurn: async (queuedTurn) => touch({ ...session, queuedTurn }),
  updateQueuedTurn: async (updater) => touch({ ...session, queuedTurn: updater(session.queuedTurn, session) }),
  append: async (entry) => touch({ ...session, transcript: [...session.transcript, entry] }),
  setHandoff: async ({ handoff, shortPrompt, fullPrompt }) => touch({ ...session, handoff, handoffShort: shortPrompt, handoffFull: fullPrompt }),
  setComposerDraft: async (composerDraft) => touch({ ...session, composerDraft: composerDraft || undefined }),
  setForkCheckpoint: async (forkCheckpoint) => touch({ ...session, forkCheckpoint }),
  transcriptMarkdown: async () => "# Mortic Transcript\n"
};

function sseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended before the expected event");
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) continue;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) return JSON.parse(data.slice(6));
    }
  };
}

const app = await createMorticServer({
  storage,
  canonicalMemoryEnabled: false,
  preferencesStore: createMemoryPreferencesStore(defaultMorticPreferences()),
  runtimeContext: {
    status: "fallback",
    trusted: true,
    sameMachineUser: true,
    effectiveCwd: "/tmp/simple-mortic-cohesion",
    workspaceRoots: ["/tmp/simple-mortic-cohesion"],
    requested: { filesystem: "read-only", workspaceRoots: [], network: "unknown", approval: "never" },
    reason: "fixture",
    audit: []
  }
});

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const [firstResponse, secondResponse] = await Promise.all([
    fetch(`${base}/api/session/stream?clientId=overlay&surface=overlay`, { signal: firstController.signal }),
    fetch(`${base}/api/session/stream?clientId=app&surface=app`, { signal: secondController.signal })
  ]);
  const firstEvent = sseReader(firstResponse);
  const secondEvent = sseReader(secondResponse);
  const [firstInitial, secondInitial] = await Promise.all([firstEvent(), secondEvent()]);
  assert.equal(firstInitial.type, "snapshot");
  assert.equal(secondInitial.type, "snapshot");

  const draftResponse = await fetch(`${base}/api/session/ui`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ composerDraft: "shared draft" })
  });
  assert.equal(draftResponse.status, 200);
  const [firstDraft, secondDraft] = await Promise.all([firstEvent(), secondEvent()]);
  assert.equal(firstDraft.snapshot.session.composerDraft, "shared draft");
  assert.equal(secondDraft.snapshot.session.composerDraft, "shared draft");
  assert.equal(firstDraft.snapshot.revision, secondDraft.snapshot.revision);
  assert(firstDraft.snapshot.revision > firstInitial.snapshot.revision);

  const disabled = await fetch(`${base}/api/project`);
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).code, "canonical_memory_disabled");

  const preferences = await fetch(`${base}/api/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shortSpokenReplies: true })
  });
  assert.equal(preferences.status, 200);
  const [firstPreferences, secondPreferences] = await Promise.all([firstEvent(), secondEvent()]);
  assert.equal(firstPreferences.snapshot.preferences.shortSpokenReplies, true);
  assert.equal(secondPreferences.snapshot.preferences.shortSpokenReplies, true);

  const invalidPreferences = await fetch(`${base}/api/preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ttsProvider: "not-a-provider" })
  });
  assert.equal(invalidPreferences.status, 400, "invalid provider preferences must be rejected");

  await storage.setActiveTurn({
    id: "running-turn",
    status: "running",
    userText: "busy",
    reasoningEffort: "none",
    codexModel: "fixture",
    scratchMode: "text",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
    metrics: {}
  });
  const queuedResponse = await fetch(`${base}/api/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "queued follow-up",
      reasoningEffort: "none",
      scratchMode: "text",
      clientId: "overlay",
      surface: "overlay"
    })
  });
  assert.equal(queuedResponse.status, 202);
  const queuedPayload = await queuedResponse.json();
  assert.equal(queuedPayload.queued, true);
  assert.equal(queuedPayload.session.queuedTurn.text, "queued follow-up");
  const [firstQueued, secondQueued] = await Promise.all([firstEvent(), secondEvent()]);
  assert.equal(firstQueued.snapshot.session.queuedTurn.text, "queued follow-up");
  assert.equal(secondQueued.snapshot.session.queuedTurn.text, "queued follow-up");

  const cancelQueuedResponse = await fetch(`${base}/api/session/queued-turn`, { method: "DELETE" });
  assert.equal(cancelQueuedResponse.status, 200);
  const [firstQueuedClear, secondQueuedClear] = await Promise.all([firstEvent(), secondEvent()]);
  assert.equal(firstQueuedClear.snapshot.session.queuedTurn, undefined);
  assert.equal(secondQueuedClear.snapshot.session.queuedTurn, undefined);
  await storage.setActiveTurn(undefined);

  const clearResponse = await fetch(`${base}/api/session/clear`, { method: "POST" });
  assert.equal(clearResponse.status, 200);
  const [firstClear, secondClear] = await Promise.all([firstEvent(), secondEvent()]);
  assert.equal(firstClear.snapshot.session.composerDraft, undefined);
  assert.equal(secondClear.snapshot.session.composerDraft, undefined);
  assert(firstClear.snapshot.revision > firstPreferences.snapshot.revision);

  firstController.abort();
  secondController.abort();

  const reconnectController = new AbortController();
  const reconnectResponse = await fetch(`${base}/api/session/stream?clientId=overlay-reconnected&surface=overlay`, { signal: reconnectController.signal });
  const reconnectEvent = await sseReader(reconnectResponse)();
  assert.equal(reconnectEvent.type, "snapshot");
  assert(reconnectEvent.snapshot.revision >= firstClear.snapshot.revision, "reconnected clients must receive the latest revision");
  reconnectController.abort();
} finally {
  await app.close();
}

const coordinatorEvents = [];
const coordinator = new SessionCoordinator(() => undefined);
coordinator.subscribe((event) => coordinatorEvents.push(event));
coordinator.presence({ clientId: "overlay", surface: "overlay", focused: true, visible: true, audioPhase: "speaking" });
coordinator.presence({ clientId: "app", surface: "app", focused: true, visible: true, audioPhase: "idle" });
assert.equal(coordinator.state().ownerClientId, "overlay", "active speech owner must survive a focus transfer");
assert.equal(coordinator.state().pendingClientId, "app");
coordinator.presence({ clientId: "overlay", surface: "overlay", focused: false, visible: false, audioPhase: "idle" });
assert.equal(coordinator.state().ownerClientId, "app", "pending focused surface should own idle audio");
coordinator.command({ clientId: "overlay", surface: "overlay", command: "barge-in" });
assert.equal(coordinator.state().ownerClientId, "overlay");
assert(coordinatorEvents.some((event) => event.type === "audio-command" && event.targetClientId === "app"));

coordinator.command({ clientId: "app", surface: "app", command: "interrupt" });
assert.equal(coordinator.state().ownerClientId, "app");
assert.equal(coordinator.state().phase, "idle");
assert(coordinatorEvents.some((event) => event.type === "audio-command" && event.targetClientId === "overlay" && event.reason === "interrupt"));

coordinator.command({ clientId: "app", surface: "app", command: "hide" });
assert.equal(coordinator.state().ownerClientId, undefined, "explicit hide must release an idle lease");

const visibleIdleCoordinatorEvents = [];
const visibleIdleCoordinator = new SessionCoordinator(() => undefined);
visibleIdleCoordinator.subscribe((event) => visibleIdleCoordinatorEvents.push(event));
visibleIdleCoordinator.presence({ clientId: "overlay", surface: "overlay", focused: true, visible: true, audioPhase: "idle" });
visibleIdleCoordinator.presence({ clientId: "app", surface: "app", focused: true, visible: true, audioPhase: "idle" });
assert.equal(visibleIdleCoordinator.state().ownerClientId, "overlay", "passive focus must not silently steal a visible owner");
assert.equal(visibleIdleCoordinator.state().pendingClientId, "app");
visibleIdleCoordinator.command({ clientId: "app", surface: "app", command: "barge-in" });
assert.equal(visibleIdleCoordinator.state().ownerClientId, "app", "explicit barge-in should transfer ownership");
assert(
  visibleIdleCoordinatorEvents.some((event) => event.type === "audio-command" && event.targetClientId === "overlay"),
  "explicit barge-in should tell the previous owner to stop local audio"
);

const expiringCoordinator = new SessionCoordinator(() => undefined);
expiringCoordinator.presence({ clientId: "abandoned", surface: "browser", focused: true, visible: true, audioPhase: "idle" });
await new Promise((resolve) => setTimeout(resolve, 2));
assert.equal(expiringCoordinator.sweep(0), true, "abandoned leases must expire");
assert.equal(expiringCoordinator.state().ownerClientId, undefined);

console.log("session cohesion checks passed");
