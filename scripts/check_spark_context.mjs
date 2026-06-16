import assert from "node:assert/strict";

import {
  classifyModelTransitionTokenCount,
  missingTokenPreflight,
  parseCodexContextStatus,
  preflightFromCompactedFork,
  sparkPreflightStartDecision
} from "../dist/node/server/sparkContext.js";
import {
  modelTransitionSafeSaturation,
  modelTransitionWarningSaturation
} from "../dist/node/shared/types.js";

const threadId = "fixture-thread";
const candidateModel = "gpt-5.3-codex-spark";
const candidateWindow = 127000;

function tokenCount(inputTokens) {
  return {
    inputTokens,
    file: "fixture.jsonl",
    updatedAt: "2026-05-01T00:00:00.000Z"
  };
}

const parsedStatus = parseCodexContextStatus("Session: My thread\nContext: 42% left (73,660 / 127,000)");
assert.equal(parsedStatus?.session, "My thread");
assert.equal(parsedStatus?.leftPct, 42);
assert.equal(parsedStatus?.usedTokens, 73660);
assert.equal(parsedStatus?.totalTokens, 127000);

const blocked = classifyModelTransitionTokenCount({
  threadId,
  candidateModel,
  tokenCount: tokenCount(Math.ceil(candidateWindow * (modelTransitionWarningSaturation + 0.01)))
});
assert.equal(blocked.status, "needs-compaction");
assert.equal(blocked.compactionRequired, true);
assert.equal(blocked.automaticStartAllowed, false);
assert.equal(sparkPreflightStartDecision(blocked, false).allowed, false);
assert.equal(sparkPreflightStartDecision(blocked, true).allowed, false);

const warning = classifyModelTransitionTokenCount({
  threadId,
  candidateModel,
  tokenCount: tokenCount(Math.ceil(candidateWindow * (modelTransitionSafeSaturation + 0.01)))
});
assert.equal(warning.status, "warning");
assert.equal(warning.automaticStartAllowed, false);
assert.equal(warning.manualStartAllowed, true);
assert.equal(sparkPreflightStartDecision(warning, false).allowed, false);
assert.equal(sparkPreflightStartDecision(warning, true).allowed, true);

const afterCompaction = classifyModelTransitionTokenCount({
  threadId,
  candidateModel,
  tokenCount: tokenCount(Math.floor(candidateWindow * 0.5))
});
assert.equal(afterCompaction.status, "safe");
assert.equal(afterCompaction.automaticStartAllowed, true);
assert.equal(sparkPreflightStartDecision(afterCompaction, false).allowed, true);

const compactedFork = preflightFromCompactedFork({
  sourceThreadId: threadId,
  compactedThreadId: "compacted-fixture",
  candidateModel,
  estimatedInputTokens: Math.floor(candidateWindow * 0.45),
  updatedAt: "2026-05-01T00:00:01.000Z"
});
assert.equal(compactedFork.status, "safe");
assert.equal(compactedFork.effectiveThreadId, "compacted-fixture");
assert.equal(compactedFork.compactedForkThreadId, "compacted-fixture");
assert.equal(compactedFork.automaticStartAllowed, true);
assert.ok(compactedFork.detail.includes("original source thread is untouched"));

const compactedForkZeroUsage = preflightFromCompactedFork({
  sourceThreadId: threadId,
  compactedThreadId: "compacted-fixture-zero-usage",
  candidateModel,
  estimatedInputTokens: 0
});
assert.equal(compactedForkZeroUsage.status, "hard-block");
assert.equal(compactedForkZeroUsage.automaticStartAllowed, false);
assert.equal(sparkPreflightStartDecision(compactedForkZeroUsage, false).allowed, false);

const unknown = missingTokenPreflight(threadId, candidateModel, "missing-token-count", "fixture missing telemetry");
assert.equal(unknown.status, "hard-block");
assert.equal(unknown.compactionRequired, false);
assert.equal(unknown.automaticStartAllowed, false);
assert.equal(sparkPreflightStartDecision(unknown, false).allowed, false);

console.log("Model context checks passed");
