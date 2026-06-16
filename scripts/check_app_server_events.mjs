#!/usr/bin/env node
import assert from "node:assert/strict";

import { normalizeAppServerNotification } from "../dist/node/server/appServerEvents.js";

function normalize(method, params) {
  return normalizeAppServerNotification({ method, params });
}

{
  const event = normalize("item/reasoning/summaryTextDelta", {
    threadId: "thread",
    turnId: "turn",
    itemId: "reasoning-1",
    delta: "Reading the current app-server bridge and mapping events."
  });
  assert.equal(event.raw.detail, "Reading the current app-server bridge and mapping events.");
  assert.equal(event.activity?.kind, "reasoning");
  assert.equal(event.activity?.display, true);
}

{
  const event = normalize("item/reasoning/textDelta", {
    threadId: "thread",
    turnId: "turn",
    itemId: "reasoning-1",
    delta: "private internal reasoning that must not render"
  });
  assert.match(event.raw.detail ?? "", /^reasoning text delta \d+ bytes$/);
  assert.equal(event.activity?.display, false);
  assert.doesNotMatch(event.raw.detail ?? "", /private internal reasoning/);
}

{
  const event = normalize("item/commandExecution/outputDelta", {
    threadId: "thread",
    turnId: "turn",
    itemId: "cmd-1",
    delta: "SECRET_TOKEN=abc123\nstack trace\n/Users/aeroknight/private"
  });
  assert.match(event.raw.detail ?? "", /^command output delta \d+ bytes$/);
  assert.equal(event.activity?.label, "Reviewing command result");
  assert.doesNotMatch(event.raw.detail ?? "", /SECRET_TOKEN|stack trace|aeroknight/);
}

{
  const event = normalize("turn/plan/updated", {
    threadId: "thread",
    turnId: "turn",
    explanation: "Inspect app-server docs and wire the event adapter.",
    plan: [{ step: "Inspect", status: "completed" }]
  });
  assert.equal(event.activity?.kind, "plan");
  assert.equal(event.activity?.display, true);
  assert.match(event.activity?.detail ?? "", /1 plan steps/);
}

{
  const event = normalize("item/fileChange/patchUpdated", {
    threadId: "thread",
    turnId: "turn",
    itemId: "patch-1",
    changes: [{ path: "/Users/aeroknight/Downloads/as/simple_mortic/src/server/app.ts" }]
  });
  assert.equal(event.activity?.kind, "file");
  assert.equal(event.activity?.label, "Preparing changes");
  assert.doesNotMatch(event.activity?.detail ?? "", /Users\/aeroknight/);
}

console.log("app-server event normalization checks passed");
