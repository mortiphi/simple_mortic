import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// First-turn warm regression check. Drives the real CodexAppServerBridge
// against scripts/fixtures/fake_codex (a minimal fake `codex app-server`)
// to prove three properties behind the "first message is very late" fix:
//   1. boot prewarm settings stay aligned with the client defaults
//      (mismatched settings silently waste the boot fork),
//   2. a failed app-server start does not poison the cached readiness
//      promise (the next attempt must retry, not re-throw forever),
//   3. a turn submitted concurrently with prewarm reuses the same scratch
//      fork: exactly one thread/fork request reaches the app-server.

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const fakeCodexDir = path.join(scriptsDir, "fixtures", "fake_codex");
const fakeCodexBin = path.join(fakeCodexDir, "codex");
assert.ok(existsSync(fakeCodexBin), "fake codex fixture is missing");
chmodSync(fakeCodexBin, 0o755);

const statsDir = mkdtempSync(path.join(tmpdir(), "mortic-first-turn-"));
const statsPath = path.join(statsDir, "stats.jsonl");

process.env.PATH = `${fakeCodexDir}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.FAKE_CODEX_STATS = statsPath;
process.env.MORTIC_APPSERVER_READY_TIMEOUT_MS = "2000";
delete process.env.MORTIC_SCRATCH_FORK_NETWORK;
delete process.env.MORTIC_SCRATCH_NETWORK;

const { defaultScratchSettings } = await import("../dist/node/shared/scratchDefaults.js");
const { CodexAppServerBridge } = await import("../dist/node/server/appServerBridge.js");

// 1. Boot/client default alignment.
assert.equal(defaultScratchSettings.scratchMode, "voice", "default scratch mode must stay voice");
assert.equal(defaultScratchSettings.reasoningEffort, "none", "default reasoning effort must stay none");
assert.equal(defaultScratchSettings.voiceCaveman, false, "default caveman toggle must stay off");

const bridge = new CodexAppServerBridge();
const scratchParams = {
  sourceThreadId: "fake-source-thread",
  cwd: statsDir,
  model: "default",
  reasoningEffort: defaultScratchSettings.reasoningEffort,
  scratchMode: defaultScratchSettings.scratchMode,
  voiceCaveman: defaultScratchSettings.voiceCaveman
};

try {
  // 2. Failed start must not poison readiness.
  process.env.FAKE_CODEX_FAIL_READY = "1";
  await assert.rejects(
    () => bridge.runTurn({ ...scratchParams, prompt: "hello" }),
    /readyz|exited/,
    "start should fail while readyz is failing"
  );
  delete process.env.FAKE_CODEX_FAIL_READY;

  // 3. Concurrent prewarm + turn after recovery: exactly one fork.
  const warm = bridge.warmScratch(scratchParams);
  const turn = bridge.runTurn({ ...scratchParams, prompt: "hello again" });
  const [, text] = await Promise.all([warm, turn]);
  assert.equal(text, "fake answer", "turn should resolve with the fake app-server answer");

  const events = readFileSync(statsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const forks = events.filter((event) => event.type === "fork");
  const turns = events.filter((event) => event.type === "turn");
  assert.equal(forks.length, 1, `concurrent prewarm + turn must create exactly one scratch fork, saw ${forks.length}`);
  assert.equal(turns.length, 1, "exactly one turn should reach the app-server");
  assert.equal(forks[0].sourceThreadId, "fake-source-thread", "fork must target the source thread");
  assert.equal(forks[0].params?.sandbox, "read-only", "default scratch fork must stay read-only");
  assert.equal(forks[0].params?.approvalPolicy, "never", "default scratch fork must not request approvals");
  assert.equal(forks[0].params?.networkPolicy, undefined, "default scratch fork must not opt into network explicitly");

  await bridge.shutdown("default access check complete");

  // 4. Experimental progress-telemetry mode: give scratch forks network access
  // while still forbidding filesystem writes and approval escalation.
  process.env.MORTIC_SCRATCH_FORK_NETWORK = "1";
  const networkBridge = new CodexAppServerBridge();
  const networkText = await networkBridge.runTurn({ ...scratchParams, prompt: "network check" });
  assert.equal(networkText, "fake answer", "network-enabled scratch should still complete");

  const networkEvents = readFileSync(statsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const networkFork = networkEvents.filter((event) => event.type === "fork").at(-1);
  assert.equal(networkFork?.params?.sandbox, "read-only", "network-enabled scratch fork must stay read-only");
  assert.equal(networkFork?.params?.approvalPolicy, "never", "network-enabled scratch fork must not request approvals");
  assert.equal(networkFork?.params?.networkPolicy, "enabled", "network-enabled scratch fork must request network access");
  await networkBridge.shutdown("network access check complete");
} finally {
  await bridge.shutdown("check complete").catch(() => {});
  rmSync(statsDir, { recursive: true, force: true });
}

console.log("First-turn warm checks passed");
