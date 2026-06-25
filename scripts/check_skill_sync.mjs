import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Skill sync regression check. Proves the four sync outcomes against a temp
// CODEX_HOME-style target root:
//   install   -> missing skill is copied with a Mortic manifest
//   adopt     -> identical unmanaged copy gains a manifest, files untouched
//   keep-user -> edited copies (managed or unmanaged) are never overwritten
//   upgrade   -> pristine managed copy is replaced when the vendored content changes

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsDir);
const vendorDir = path.join(repoRoot, "skills");
assert.ok(existsSync(path.join(vendorDir, "mortic-voice-output", "SKILL.md")), "vendored voice-output skill missing");

const { syncVendoredSkills } = await import("../dist/node/server/skillSync.js");

const targetRoot = mkdtempSync(path.join(tmpdir(), "mortic-skill-sync-"));
const voiceTarget = path.join(targetRoot, "mortic-voice-output");
const manifestPath = path.join(voiceTarget, ".mortic-skill-manifest.json");
const skillMdPath = path.join(voiceTarget, "SKILL.md");

function actionsByName(results) {
  return new Map(results.map((result) => [result.skill, result.action]));
}

try {
  // 1. Fresh target: voice-output skill installs.
  let actions = actionsByName(await syncVendoredSkills({ vendorDir, targetRoot }));
  assert.equal(actions.get("mortic-voice-output"), "installed");
  assert.ok(existsSync(manifestPath), "install should write a manifest");
  const installedSkillMd = readFileSync(skillMdPath, "utf8");

  // 2. Re-sync with no changes: everything reports current.
  actions = actionsByName(await syncVendoredSkills({ vendorDir, targetRoot }));
  assert.equal(actions.get("mortic-voice-output"), "current");

  // 3. Identical unmanaged copy: manifest removed, content identical -> adopted.
  rmSync(manifestPath);
  actions = actionsByName(await syncVendoredSkills({ vendorDir, targetRoot }));
  assert.equal(actions.get("mortic-voice-output"), "adopted");
  assert.ok(existsSync(manifestPath), "adopt should restore the manifest");
  assert.equal(readFileSync(skillMdPath, "utf8"), installedSkillMd, "adopt must not rewrite files");

  // 4. User edits a managed copy: never overwritten.
  writeFileSync(skillMdPath, `${installedSkillMd}\n<!-- local edit -->\n`);
  actions = actionsByName(await syncVendoredSkills({ vendorDir, targetRoot }));
  assert.equal(actions.get("mortic-voice-output"), "kept-user-copy");
  assert.match(readFileSync(skillMdPath, "utf8"), /local edit/, "user edit must survive sync");

  // 5. Edited unmanaged copy (manifest gone too): still kept.
  rmSync(manifestPath);
  actions = actionsByName(await syncVendoredSkills({ vendorDir, targetRoot }));
  assert.equal(actions.get("mortic-voice-output"), "kept-user-copy");
  assert.match(readFileSync(skillMdPath, "utf8"), /local edit/, "unmanaged edit must survive sync");

  // 6. Upgrade: pristine managed copy, vendored content changed.
  rmSync(voiceTarget, { recursive: true, force: true });
  await syncVendoredSkills({ vendorDir, targetRoot });
  const vendorCopy = mkdtempSync(path.join(tmpdir(), "mortic-skill-vendor-"));
  try {
    const { cpSync } = await import("node:fs");
    cpSync(vendorDir, vendorCopy, { recursive: true });
    const vendorSkillMd = path.join(vendorCopy, "mortic-voice-output", "SKILL.md");
    writeFileSync(vendorSkillMd, `${readFileSync(vendorSkillMd, "utf8")}\n<!-- v2 -->\n`);
    actions = actionsByName(await syncVendoredSkills({ vendorDir: vendorCopy, targetRoot }));
    assert.equal(actions.get("mortic-voice-output"), "upgraded");
    assert.match(readFileSync(skillMdPath, "utf8"), /v2/, "upgrade should replace managed content");
  } finally {
    rmSync(vendorCopy, { recursive: true, force: true });
  }
} finally {
  rmSync(targetRoot, { recursive: true, force: true });
}

console.log("Skill sync checks passed");
