import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  CodexProviderAdapter,
  accountIdFromLoginOutput,
  loginStatusFromOutput
} = await import("../dist/node/server/providerAdapters.js");

// Seam gate: no source file outside providerAdapters.ts may invoke the codex
// binary directly. Everything goes through the adapter so provider swaps and
// binary overrides stay a one-file change.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srcDir = path.join(repoRoot, "src");
const violations = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      if (full.endsWith(`${path.sep}providerAdapters.ts`)) continue;
      const text = readFileSync(full, "utf8");
      for (const pattern of [/spawn\(\s*["']codex["']/, /runCommand\(\s*["']codex["']/, /execFile\(\s*["']codex["']/]) {
        if (pattern.test(text)) violations.push(`${path.relative(repoRoot, full)}: ${pattern}`);
      }
    }
  }
}
walk(srcDir);
assert.deepEqual(violations, [], `direct codex invocations outside providerAdapters:\n${violations.join("\n")}`);

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

// Thread discovery: builds a fake CODEX_HOME with two rollout files, an
// archived session (must be excluded), and a malformed file (must be skipped).
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const codexHome = mkdtempSync(path.join(tmpdir(), "mortic-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const sessionsDir = path.join(codexHome, "sessions", "2026", "06");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(path.join(codexHome, "archived_sessions"), { recursive: true });

    const meta = (id, cwd) => `${JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "cli" } })}\n`;
    const olderPath = path.join(sessionsDir, "older.jsonl");
    const newerPath = path.join(sessionsDir, "newer.jsonl");
    writeFileSync(olderPath, meta("thread-older", "/tmp/older"));
    writeFileSync(newerPath, meta("thread-newer", "/tmp/newer"));
    writeFileSync(path.join(sessionsDir, "broken.jsonl"), "not json\n");
    writeFileSync(path.join(codexHome, "archived_sessions", "archived.jsonl"), meta("thread-archived", "/tmp/archived"));
    const now = Date.now() / 1000;
    utimesSync(olderPath, now - 3600, now - 3600);
    utimesSync(newerPath, now, now);

    process.env.CODEX_HOME = codexHome;
    const threads = await adapter.listRecentThreads({ limit: 10 });
    assert.equal(threads.length, 2, "discovery should find exactly the two valid live sessions");
    assert.equal(threads[0].threadId, "thread-newer", "threads should be sorted newest first");
    assert.equal(threads[1].threadId, "thread-older");
    assert.equal(threads[0].sourceUri, "codex://threads/thread-newer");
    assert.equal(threads[0].cwd, "/tmp/newer");
    assert.ok(!threads.some((thread) => thread.threadId === "thread-archived"), "archived sessions must be excluded");

    const limited = await adapter.listRecentThreads({ limit: 1 });
    assert.equal(limited.length, 1, "limit should cap results");
    assert.equal(limited[0].threadId, "thread-newer");
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  }
}

console.log("Provider adapter checks passed");
