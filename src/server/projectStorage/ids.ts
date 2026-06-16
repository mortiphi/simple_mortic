import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import type { DraftCompilationImportRequest, MorticSession } from "../../shared/types.js";

import { hash, slug } from "./common.js";
export function projectIdForWorkspace(workspacePath: string): string {
  return `${slug(path.basename(workspacePath))}-${hash(path.resolve(workspacePath), 10)}`;
}

export function sourceThreadId(threadId: string): string {
  return `source-${hash(threadId, 16)}`;
}

export function scratchSessionId(session: MorticSession): string {
  return `scratch-${hash(`${session.id}:${session.threadId}:${session.createdAt}`, 16)}`;
}

export function initialCheckpointId(sourceId: string): string {
  return `checkpoint-${hash(`${sourceId}:initial`, 16)}`;
}

export function childCheckpointId(sourceId: string, parentCheckpointId: string, handoffHash: string): string {
  return `checkpoint-${hash(`${sourceId}:${parentCheckpointId}:${handoffHash}`, 16)}`;
}

export function manualCheckpointId(sourceId: string): string {
  return `checkpoint-${hash(`${sourceId}:manual:${randomUUID()}`, 16)}`;
}

export function projectBaseDir(): string {
  return path.join(homedir(), ".mortic", "projects");
}

// Mirrors createProjectStore's directory computation (resolve first) so callers
// can compare project identity without building a store.
export function projectDirForWorkspace(workspacePath: string): string {
  return path.join(projectBaseDir(), projectIdForWorkspace(path.resolve(workspacePath)));
}

export function sessionDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, "sessions", sessionId);
}

export function sourcePath(projectDir: string, id: string): string {
  return path.join(projectDir, "source_threads", `${id}.json`);
}

export function checkpointPath(projectDir: string, id: string): string {
  return path.join(projectDir, "source_checkpoints", `${id}.json`);
}

export function projectPaths(projectDir: string) {
  return {
    project: path.join(projectDir, "project.json"),
    chart: path.join(projectDir, "canonical_chart.json"),
    production: path.join(projectDir, "production.json"),
    productionMarkdown: path.join(projectDir, "production.md"),
    extractedItems: path.join(projectDir, "extracted_items.json"),
    extractedItemsMarkdown: path.join(projectDir, "extracted_items.md")
  };
}

export function canonicalCheckpointId(value: string): string {
  return `canonical-checkpoint-${hash(value, 18)}`;
}

export function canonicalDeltaId(value: string): string {
  return `canonical-delta-${hash(value, 18)}`;
}

export function conversationArtifactIdForScratch(scratchId: string): string {
  return `artifact-${scratchId}`;
}

export function importedArtifactId(projectId: string): string {
  return `artifact-imported-${hash(projectId, 12)}`;
}

export function draftCompilationIdForScratch(scratchId: string, createdAt: string): string {
  return `compilation-${hash(`${scratchId}:${createdAt}:${randomUUID()}`, 18)}`;
}

export function draftCompilationIdForImport(importId: string): string {
  return `compilation-import-${hash(importId, 18)}`;
}

export function coverageReceiptIdForImport(importId: string): string {
  return `coverage-import-${hash(importId, 18)}`;
}

export function coverageReceiptIdForCompilation(compilationId: string): string {
  return `coverage-${hash(compilationId, 18)}`;
}

export function importedScratchSessionId(importId: string): string {
  return `scratch-import-${hash(importId, 16)}`;
}

export function importedProviderRefId(request: DraftCompilationImportRequest, importId: string): string {
  return request.providerRefId || request.threadId || request.conversationId || `import-${hash(importId, 16)}`;
}
