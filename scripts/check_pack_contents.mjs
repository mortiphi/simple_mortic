import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Tarball safety check. `npm pack` must produce a self-contained, secret-free
// package: the repo .env (and any other env file) must never ship, internal
// material (caveman/, evals/, planning docs, artifacts) stays out, and the
// runtime essentials (CLI entry, built UI, vendored skills, PTY worker) must
// all be present. Runs with scripts ignored so prepack does not rebuild here.

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: repoRoot,
  encoding: "utf8",
  env: { ...process.env, npm_config_ignore_scripts: "true" },
  maxBuffer: 64 * 1024 * 1024
});

assert.equal(result.error, undefined, `npm pack --dry-run could not start: ${result.error}`);
assert.equal(result.status, 0, `npm pack --dry-run failed (exit ${result.status}): ${result.stderr}`);

const jsonStart = result.stdout.indexOf("[");
assert.ok(jsonStart >= 0, `npm pack --dry-run --json printed no JSON array:\n${result.stdout}`);
const report = JSON.parse(result.stdout.slice(jsonStart));
const files = (report[0]?.files ?? []).map((entry) => entry.path);
assert.ok(files.length > 0, "npm pack reported an empty tarball");

const forbidden = [
  { pattern: /\.env/, label: "env file (secrets must never ship)" },
  { pattern: /^caveman\//, label: "caveman/ nested repo" },
  { pattern: /^evals\//, label: "evals/ internal evaluation data" },
  { pattern: /^(artifacts|design-mocks)\//, label: "internal artifacts/design docs" },
  {
    pattern: /^(AGENTS\.md|CLAUDE_REVIEW\.md|MORTIC_MVP_PLAN\.md|MORTIC_VOICE_ARCHITECTURE\.md|voice_codex_branch_manager_mvp.*\.md|Mortic\.html|\.windsurfrules)$/,
    label: "internal planning/docs file"
  }
];
for (const file of files) {
  for (const { pattern, label } of forbidden) {
    assert.ok(!pattern.test(file), `Tarball must not contain ${label}: ${file}`);
  }
}

const required = [
  "dist/node/cli/main.js",
  "dist/client/index.html",
  "skills/mortic-canonical-state/SKILL.md",
  "scripts/codex_pty_worker.py"
];
for (const file of required) {
  assert.ok(files.includes(file), `Tarball is missing required file: ${file}\nPacked files:\n${files.join("\n")}`);
}

console.log(`Pack contents check passed (${files.length} files; no env files, caveman/, evals/, or internal docs).`);
