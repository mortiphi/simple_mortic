import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const harnessPath = path.join(codexHome, "skills", "mortic-canonical-state", "scripts", "run_harness.mjs");

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
