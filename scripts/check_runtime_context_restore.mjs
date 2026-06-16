import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveRuntimeContext } from "../dist/node/server/runtimeContext.js";

async function writeRollout(codexHome, threadId, payload) {
  const dir = path.join(codexHome, "sessions", "2026", "06", "03");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-2026-06-03T00-00-00-${threadId}.jsonl`);
  await writeFile(filePath, `${JSON.stringify({ type: "session_meta", payload: { id: threadId, ...payload } })}\n`, "utf8");
  return filePath;
}

function readOnlyRequest(overrides = {}) {
  return {
    filesystem: "read-only",
    workspaceRoots: [],
    network: "unknown",
    approval: "never",
    ...overrides
  };
}

async function runCase(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "mortic-runtime-context-"));

try {
  await runCase("repo-backed source restores the recorded workspace root", async () => {
    const codexHome = path.join(tempRoot, "codex-a");
    const repo = path.join(tempRoot, "repo-a");
    await mkdir(repo, { recursive: true });
    await writeRollout(codexHome, "thread-a", {
      cwd: repo,
      source: "cli",
      sandbox: "read-only",
      approval_policy: "never",
      network_policy: "disabled",
      model_provider: "openai"
    });

    const result = await resolveRuntimeContext({
      threadId: "thread-a",
      launchCwd: tempRoot,
      morticRoot: tempRoot,
      codexHome,
      requested: readOnlyRequest()
    });

    assert.equal(result.status, "restored");
    assert.equal(result.effectiveCwd, repo);
    assert.equal(result.workspaceRoots[0], repo);
    assert.equal(result.requested.approval, "never");
    assert.equal(result.restored?.permissionProfile.network, "disabled");
  });

  await runCase("read-only source remains read-only without confirmation", async () => {
    const codexHome = path.join(tempRoot, "codex-b");
    const repo = path.join(tempRoot, "repo-b");
    await mkdir(repo, { recursive: true });
    await writeRollout(codexHome, "thread-b", {
      cwd: repo,
      source: "cli",
      sandbox: "read-only",
      approval_policy: "never"
    });

    const result = await resolveRuntimeContext({
      threadId: "thread-b",
      launchCwd: tempRoot,
      morticRoot: tempRoot,
      codexHome,
      requested: readOnlyRequest()
    });

    assert.equal(result.status, "restored");
    assert.equal(result.requested.filesystem, "read-only");
  });

  await runCase("workspace-write restores only for the same valid project root", async () => {
    const codexHome = path.join(tempRoot, "codex-c");
    const repo = path.join(tempRoot, "repo-c");
    await mkdir(repo, { recursive: true });
    await writeRollout(codexHome, "thread-c", {
      cwd: repo,
      source: "cli",
      sandbox: "workspace-write",
      approval_policy: "on-request",
      network_policy: "enabled"
    });

    const result = await resolveRuntimeContext({
      threadId: "thread-c",
      launchCwd: tempRoot,
      morticRoot: tempRoot,
      codexHome,
      requested: readOnlyRequest({ filesystem: "workspace-write", network: "enabled", approval: "on-request" })
    });

    assert.equal(result.status, "restored");
    assert.equal(result.effectiveCwd, repo);
  });

  await runCase("missing recorded paths produce a prompt and fallback", async () => {
    const codexHome = path.join(tempRoot, "codex-d");
    const missing = path.join(tempRoot, "missing-repo");
    await writeRollout(codexHome, "thread-d", {
      cwd: missing,
      source: "cli",
      sandbox: "read-only"
    });

    const result = await resolveRuntimeContext({
      threadId: "thread-d",
      launchCwd: tempRoot,
      morticRoot: tempRoot,
      codexHome,
      requested: readOnlyRequest()
    });

    assert.equal(result.status, "fallback");
    assert.equal(result.effectiveCwd, tempRoot);
    assert.match(result.prompt ?? "", /missing/);
    assert.match(result.prompt ?? "", new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  await runCase("broader access requests require confirmation", async () => {
    const codexHome = path.join(tempRoot, "codex-e");
    const repo = path.join(tempRoot, "repo-e");
    await mkdir(repo, { recursive: true });
    await writeRollout(codexHome, "thread-e", {
      cwd: repo,
      source: "cli",
      sandbox: "read-only",
      approval_policy: "never",
      network_policy: "disabled"
    });

    const result = await resolveRuntimeContext({
      threadId: "thread-e",
      launchCwd: tempRoot,
      morticRoot: tempRoot,
      codexHome,
      requested: readOnlyRequest({ filesystem: "workspace-write", network: "enabled", approval: "on-request" })
    });

    assert.equal(result.status, "needs-confirmation");
    assert.match(result.reason, /filesystem/);
    assert.match(result.reason, /network/);
    assert.match(result.reason, /approval/);
  });

  await runCase("untrusted deeplinks do not auto-grant local access", async () => {
    const codexHome = path.join(tempRoot, "codex-f");
    const repo = path.join(tempRoot, "repo-f");
    await mkdir(repo, { recursive: true });
    await writeRollout(codexHome, "thread-f", {
      cwd: repo,
      source: "remote-browser",
      sandbox: "workspace-write"
    });

    const result = await resolveRuntimeContext({
      threadId: "thread-f",
      launchCwd: tempRoot,
      morticRoot: tempRoot,
      codexHome,
      requested: readOnlyRequest()
    });

    assert.equal(result.status, "fallback");
    assert.equal(result.trusted, false);
    assert.equal(result.effectiveCwd, tempRoot);
    assert.match(result.prompt ?? "", /not authoritative/);
  });

  await runCase("network and approval restoration is recorded and auditable", async () => {
    const codexHome = path.join(tempRoot, "codex-g");
    const repo = path.join(tempRoot, "repo-g");
    await mkdir(repo, { recursive: true });
    await writeRollout(codexHome, "thread-g", {
      cwd: repo,
      source: "Codex Desktop",
      approvalPolicy: "on-request",
      networkPolicy: "enabled",
      sandbox: "workspace-write"
    });

    const result = await resolveRuntimeContext({
      threadId: "thread-g",
      launchCwd: tempRoot,
      morticRoot: tempRoot,
      codexHome,
      requested: readOnlyRequest()
    });

    assert.equal(result.restored?.permissionProfile.network, "enabled");
    assert.equal(result.restored?.permissionProfile.approval, "on-request");
    assert.ok(result.audit.some((entry) => entry.type === "runtime.requested"));
    assert.ok(result.audit.some((entry) => entry.type === "runtime.restored"));
  });
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
