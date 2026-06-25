import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillSyncAction, SkillSyncStatus } from "../shared/types.js";

// Mortic depends on skills that must live under ~/.codex/skills so `codex exec`
// can load them, but a fresh npx install has no way to put them there. The
// vendored copies in the repo's skills/ directory are the source of truth and
// this module syncs them at boot. Policy: a copy Mortic wrote (tracked by the
// manifest below) may be upgraded in place; a copy the user created or edited
// is never overwritten, only reported, so local skill experiments survive
// Mortic upgrades.

const MANIFEST_FILENAME = ".mortic-skill-manifest.json";

export type { SkillSyncAction };
export type SkillSyncResult = SkillSyncStatus;

type SkillManifest = {
  managedBy: "mortic";
  contentSha: string;
  syncedAt: string;
};

async function listSkillFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === MANIFEST_FILENAME) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSkillFiles(full, base)));
    } else if (entry.isFile()) {
      files.push(path.relative(base, full));
    }
  }
  return files.sort();
}

async function skillContentSha(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of await listSkillFiles(dir)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(path.join(dir, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readManifest(targetDir: string): Promise<SkillManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(targetDir, MANIFEST_FILENAME), "utf8")) as SkillManifest;
    return parsed?.managedBy === "mortic" && typeof parsed.contentSha === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeManifest(targetDir: string, contentSha: string): Promise<void> {
  const manifest: SkillManifest = {
    managedBy: "mortic",
    contentSha,
    syncedAt: new Date().toISOString()
  };
  await writeFile(path.join(targetDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function installSkill(vendorSkillDir: string, targetDir: string, vendorSha: string): Promise<void> {
  await mkdir(path.dirname(targetDir), { recursive: true });
  // Replace rather than merge so files removed from the vendored skill do not
  // linger in the managed copy after an upgrade.
  await rm(targetDir, { recursive: true, force: true });
  await cp(vendorSkillDir, targetDir, { recursive: true });
  await writeManifest(targetDir, vendorSha);
}

export function defaultSkillsTargetRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "skills");
}

// Works from both the compiled tree (dist/node/server) and the dev tree
// (src/server): walk upward until the vendored skills directory appears.
export function findVendoredSkillsDir(): string | null {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, "skills");
    if (existsSync(path.join(candidate, "mortic-voice-output", "SKILL.md"))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export async function syncVendoredSkills(params?: {
  vendorDir?: string;
  targetRoot?: string;
}): Promise<SkillSyncResult[]> {
  const vendorDir = params?.vendorDir ?? findVendoredSkillsDir();
  if (!vendorDir) {
    return [
      {
        skill: "*",
        action: "error",
        detail: "Vendored skills directory not found next to the Mortic install",
        targetDir: params?.targetRoot ?? defaultSkillsTargetRoot()
      }
    ];
  }

  const targetRoot = params?.targetRoot ?? defaultSkillsTargetRoot();
  const results: SkillSyncResult[] = [];
  const entries = await readdir(vendorDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = entry.name;
    const vendorSkillDir = path.join(vendorDir, skill);
    const targetDir = path.join(targetRoot, skill);
    try {
      const vendorSha = await skillContentSha(vendorSkillDir);
      const targetStat = await stat(targetDir).catch(() => null);

      if (!targetStat) {
        await installSkill(vendorSkillDir, targetDir, vendorSha);
        results.push({ skill, action: "installed", targetDir });
        continue;
      }

      const targetSha = await skillContentSha(targetDir);
      const manifest = await readManifest(targetDir);

      if (!manifest) {
        if (targetSha === vendorSha) {
          // Pre-existing copy with identical content: take ownership so future
          // upgrades flow, without changing any file the user can see.
          await writeManifest(targetDir, vendorSha);
          results.push({ skill, action: "adopted", targetDir });
        } else {
          results.push({
            skill,
            action: "kept-user-copy",
            detail: "Existing skill was not installed by Mortic and differs from the vendored copy",
            targetDir
          });
        }
        continue;
      }

      if (targetSha !== manifest.contentSha) {
        results.push({
          skill,
          action: "kept-user-copy",
          detail: "Mortic-managed skill was edited locally; not overwriting",
          targetDir
        });
        continue;
      }

      if (targetSha === vendorSha) {
        results.push({ skill, action: "current", targetDir });
        continue;
      }

      await installSkill(vendorSkillDir, targetDir, vendorSha);
      results.push({ skill, action: "upgraded", targetDir });
    } catch (error) {
      results.push({
        skill,
        action: "error",
        detail: error instanceof Error ? error.message : String(error),
        targetDir
      });
    }
  }
  return results;
}
