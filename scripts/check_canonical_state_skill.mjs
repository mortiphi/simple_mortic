import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// Run the vendored repo copy, not the synced ~/.codex copy: the repo is the
// source of truth and tests must not depend on machine state.
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const harnessPath = path.join(repoRoot, "skills", "mortic-canonical-state", "scripts", "run_harness.mjs");

const { stdout } = await execFileAsync(process.execPath, [harnessPath, "--json"], {
  maxBuffer: 1024 * 1024
});
const report = JSON.parse(stdout);

assert.equal(report.pass, true, report.failures?.join("\n") || "canonical state harness failed");
assert.equal(report.metrics.firstPassValidRate, 1);
assert.equal(report.metrics.evidencePassRate, 1);
assert.equal(report.metrics.classificationAccuracy, 1);
assert.equal(report.metrics.operationAccuracy, 1);
assert.equal(report.metrics.strictFieldAccuracy, 1);
assert.equal(report.metrics.rejectionAccuracy, 1);
assert.ok(report.metrics.noQuestionExtractionRate >= 1);
assert.ok(report.metrics.promptInjectionSafeRate >= 1);
assert.equal(report.metrics.rationaleQualityRate, 1);
assert.equal(report.metrics.duplicateFreeRate, 1);

console.log("Canonical state skill harness passed");
