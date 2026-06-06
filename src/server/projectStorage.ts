import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ApproveCompilationRequest,
  ApproveCompilationResponse,
  CanonicalCheckpoint,
  CanonicalDelta,
  CanonicalItem,
  CanonicalLifecycleStatus,
  ConversationArtifact,
  CommitSessionResponse,
  DraftCompilation,
  ExtractedItem,
  ExtractedItemType,
  HandoffReadiness,
  MorticProject,
  MorticSession,
  ProjectArtifactPreviewResponse,
  ProjectChartResponse,
  ProjectCanonicalStateResponse,
  ProviderReference,
  RuntimeContextRestore,
  ProductionChart,
  ProjectStateResponse,
  ScratchSessionNode,
  SourceCheckpointNode,
  SourceThreadNode,
  TranscriptEntry,
  UpdateExtractedItemRequest
} from "../shared/types.js";
import { extractedItemTypes } from "../shared/types.js";
import { extractItemsWithCanonicalStateSkill } from "./canonicalStateSkill.js";
import { codexProviderAdapter } from "./providerAdapters.js";

export type ProjectStore = {
  projectDir: string;
  syncSession(session: MorticSession, event?: ProjectEvent): Promise<void>;
  recordEvent(session: MorticSession, event: ProjectEvent): Promise<void>;
  snapshot(session?: MorticSession): Promise<ProjectStateResponse>;
  canonicalState(): Promise<ProjectCanonicalStateResponse>;
  chart(runtimeContext?: RuntimeContextRestore): Promise<ProjectChartResponse>;
  artifactPreview(id: string, runtimeContext?: RuntimeContextRestore): Promise<ProjectArtifactPreviewResponse | null>;
  approveCompilation(id: string, request?: ApproveCompilationRequest, runtimeContext?: RuntimeContextRestore): Promise<ApproveCompilationResponse>;
  commitSession(session: MorticSession, approveItemIds?: string[]): Promise<CommitSessionResponse>;
  archiveSession(session: MorticSession): Promise<ProjectStateResponse>;
  updateExtractedItem(id: string, patch: UpdateExtractedItemRequest): Promise<ProjectStateResponse>;
  confirmSourceCheckpoint(): Promise<ProjectStateResponse>;
  dismissSourceCheckpoint(): Promise<ProjectStateResponse>;
  createManualSourceCheckpoint(session: MorticSession): Promise<ProjectStateResponse>;
  markHandoffCopied(session: MorticSession): Promise<ProjectStateResponse>;
};

export type ProjectEvent = {
  type: string;
  at?: string;
  detail?: unknown;
};

type ProjectStoreParams = {
  workspacePath: string;
  sourceUri: string;
  threadId: string;
  projectTitle?: string;
};

const extractionLabels: Record<ExtractedItemType, string> = {
  project_state: "Project State Update",
  prioritization: "Prioritisation Update",
  task: "Task Update",
  risk: "Risk Update",
  backlog: "Backlog Update"
};
const canonicalExtractionTypes = new Set<string>(extractedItemTypes);

function nowIso(): string {
  return new Date().toISOString();
}

function hash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "workspace";
}

function projectIdForWorkspace(workspacePath: string): string {
  return `${slug(path.basename(workspacePath))}-${hash(path.resolve(workspacePath), 10)}`;
}

function sourceThreadId(threadId: string): string {
  return `source-${hash(threadId, 16)}`;
}

function scratchSessionId(session: MorticSession): string {
  return `scratch-${hash(`${session.id}:${session.threadId}:${session.createdAt}`, 16)}`;
}

function initialCheckpointId(sourceId: string): string {
  return `checkpoint-${hash(`${sourceId}:initial`, 16)}`;
}

function childCheckpointId(sourceId: string, parentCheckpointId: string, handoffHash: string): string {
  return `checkpoint-${hash(`${sourceId}:${parentCheckpointId}:${handoffHash}`, 16)}`;
}

function manualCheckpointId(sourceId: string): string {
  return `checkpoint-${hash(`${sourceId}:manual:${randomUUID()}`, 16)}`;
}

function projectBaseDir(): string {
  return path.join(homedir(), ".mortic", "projects");
}

function sessionDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, "sessions", sessionId);
}

function sourcePath(projectDir: string, id: string): string {
  return path.join(projectDir, "source_threads", `${id}.json`);
}

function checkpointPath(projectDir: string, id: string): string {
  return path.join(projectDir, "source_checkpoints", `${id}.json`);
}

function projectPaths(projectDir: string) {
  return {
    project: path.join(projectDir, "project.json"),
    chart: path.join(projectDir, "canonical_chart.json"),
    production: path.join(projectDir, "production.json"),
    productionMarkdown: path.join(projectDir, "production.md"),
    extractedItems: path.join(projectDir, "extracted_items.json"),
    extractedItemsMarkdown: path.join(projectDir, "extracted_items.md")
  };
}

type CanonicalChartFile = {
  schemaVersion: "1.0";
  projectId: string;
  checkpoints: CanonicalCheckpoint[];
  canonicalItems: CanonicalItem[];
  deltas: CanonicalDelta[];
  draftCompilations: DraftCompilation[];
  artifacts: ConversationArtifact[];
  providerRefs: ProviderReference[];
  createdAt: string;
  updatedAt: string;
};

function emptyChartFile(projectId: string): CanonicalChartFile {
  const current = nowIso();
  return {
    schemaVersion: "1.0",
    projectId,
    checkpoints: [],
    canonicalItems: [],
    deltas: [],
    draftCompilations: [],
    artifacts: [],
    providerRefs: [],
    createdAt: current,
    updatedAt: current
  };
}

function canonicalCheckpointId(value: string): string {
  return `canonical-checkpoint-${hash(value, 18)}`;
}

function canonicalDeltaId(value: string): string {
  return `canonical-delta-${hash(value, 18)}`;
}

function conversationArtifactIdForScratch(scratchId: string): string {
  return `artifact-${scratchId}`;
}

function importedArtifactId(projectId: string): string {
  return `artifact-imported-${hash(projectId, 12)}`;
}

function draftCompilationIdForScratch(scratchId: string, createdAt: string): string {
  return `compilation-${hash(`${scratchId}:${createdAt}:${randomUUID()}`, 18)}`;
}

function canonicalStableKey(item: ExtractedItem): string {
  return `${item.type}:${canonicalItemIdForExtractedItem(item)}`;
}

function transcriptHash(entries: TranscriptEntry[]): string {
  return hash(JSON.stringify(entries.map((entry) => ({
    id: entry.id,
    role: entry.role,
    text: entry.text,
    spokenText: entry.spokenText,
    notesText: entry.notesText,
    sourcesText: entry.sourcesText,
    createdAt: entry.createdAt
  }))), 18);
}

function compilationTranscriptBoundaryIndex(entries: TranscriptEntry[], compilation: DraftCompilation): number {
  if (compilation.transcriptEndEntryId) {
    const endIndex = entries.findIndex((entry) => entry.id === compilation.transcriptEndEntryId);
    if (endIndex >= 0) return endIndex;
  }
  if (typeof compilation.transcriptEntryCount === "number" && compilation.transcriptEntryCount > 0) {
    return Math.min(compilation.transcriptEntryCount - 1, entries.length - 1);
  }
  return -1;
}

function transcriptAfterLatestCompilation(entries: TranscriptEntry[], compilations: DraftCompilation[], scratchId: string): TranscriptEntry[] {
  let latestBoundary = -1;
  let latestUpdatedAt = "";
  for (const compilation of compilations) {
    if (compilation.scratchSessionId !== scratchId) continue;
    const boundary = compilationTranscriptBoundaryIndex(entries, compilation);
    if (boundary > latestBoundary || (boundary === latestBoundary && compilation.updatedAt > latestUpdatedAt)) {
      latestBoundary = boundary;
      latestUpdatedAt = compilation.updatedAt;
    }
  }
  return entries.slice(latestBoundary + 1);
}

function compileScopedItemId(itemId: string, compilationId: string): string {
  return `item-${hash(`${compilationId}:${itemId}`, 18)}`;
}

function itemAliases(item: Pick<ExtractedItem, "id" | "canonicalItemId" | "targetCanonicalItemId">): string[] {
  return [item.id, item.canonicalItemId, item.targetCanonicalItemId].filter((id): id is string => Boolean(id));
}

function itemMatchesAnyId(item: Pick<ExtractedItem, "id" | "canonicalItemId" | "targetCanonicalItemId">, id: string): boolean {
  return itemAliases(item).includes(id);
}

function canonicalTargetKeyForId(items: ExtractedItem[], id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const direct = items.find((item) => itemMatchesAnyId(item, id));
  return direct ? canonicalItemIdForExtractedItem(direct) : id;
}

function reviewTargetKey(item: ExtractedItem, items: ExtractedItem[]): string {
  return canonicalTargetKeyForId(items, item.targetCanonicalItemId) ?? canonicalItemIdForExtractedItem(item);
}

function reviewOperationKey(item: ExtractedItem): string {
  return item.canonicalOperation ?? item.lifecycleAction ?? "create";
}

function isPendingDraftItem(item: ExtractedItem): boolean {
  return item.status === "draft" && Boolean(item.sourceCompilationId);
}

function samePendingDraftSurface(left: ExtractedItem, right: ExtractedItem): boolean {
  return extractionFingerprint(left.type, left.title, left.body) === extractionFingerprint(right.type, right.title, right.body);
}

function findPendingDraftMatch(existingItems: ExtractedItem[], incoming: ExtractedItem): ExtractedItem | undefined {
  const pending = existingItems.filter(isPendingDraftItem);
  const directPendingTarget = incoming.targetCanonicalItemId
    ? pending.find((item) => itemMatchesAnyId(item, incoming.targetCanonicalItemId ?? ""))
    : undefined;
  if (directPendingTarget) return directPendingTarget;

  const targetKey = reviewTargetKey(incoming, existingItems);
  const operationKey = reviewOperationKey(incoming);
  const matchedByTarget = pending.find((item) => {
    if (reviewTargetKey(item, existingItems) !== targetKey) return false;
    if (operationKey === "append_evidence" || reviewOperationKey(item) === "append_evidence") return true;
    return reviewOperationKey(item) === operationKey || item.type === incoming.type;
  });
  if (matchedByTarget) return matchedByTarget;

  return pending.find((item) => samePendingDraftSurface(item, incoming));
}

function mergedReconciledItems(left: ExtractedItem["reconcilesWith"], right: ExtractedItem["reconcilesWith"]): ExtractedItem["reconcilesWith"] {
  const byId = new Map<string, NonNullable<ExtractedItem["reconcilesWith"]>[number]>();
  for (const item of [...(left ?? []), ...(right ?? [])]) byId.set(`${item.type}:${item.id}`, item);
  return byId.size > 0 ? [...byId.values()] : undefined;
}

function mergePendingDraftEvidence(existing: ExtractedItem, incoming: ExtractedItem, updatedAt: string): ExtractedItem {
  return {
    ...existing,
    confidence: Math.max(existing.confidence, incoming.confidence),
    selectionReason: existing.selectionReason ?? incoming.selectionReason,
    reconciliationReason: existing.reconciliationReason ?? incoming.reconciliationReason,
    conflicts: [...new Set([...(existing.conflicts ?? []), ...(incoming.conflicts ?? [])])],
    reconcilesWith: mergedReconciledItems(existing.reconcilesWith, incoming.reconcilesWith),
    transcriptAnchor: incoming.transcriptAnchor ?? existing.transcriptAnchor,
    updatedAt
  };
}

function reconcileGeneratedWithPendingDrafts(existingItems: ExtractedItem[], generated: ExtractedItem[], updatedAt: string): {
  items: ExtractedItem[];
  generated: ExtractedItem[];
  mergedIds: string[];
} {
  if (generated.length === 0) return { items: existingItems, generated, mergedIds: [] };
  const byId = new Map(existingItems.map((item) => [item.id, item]));
  const kept: ExtractedItem[] = [];
  const mergedIds: string[] = [];

  for (const item of generated) {
    const match = findPendingDraftMatch([...byId.values(), ...kept], item);
    if (!match) {
      kept.push(item);
      continue;
    }
    byId.set(match.id, mergePendingDraftEvidence(match, item, updatedAt));
    mergedIds.push(item.id);
  }

  return {
    items: existingItems.map((item) => byId.get(item.id) ?? item),
    generated: kept,
    mergedIds
  };
}

function sameCanonicalBody(delta: CanonicalDelta, item: ExtractedItem): boolean {
  return normalizeBody(`${delta.title}\n${delta.body}`).toLowerCase() === normalizeBody(`${item.title}\n${item.body}`).toLowerCase() &&
    (delta.lifecycleAction ?? "create") === (item.lifecycleAction ?? "create") &&
    (delta.lifecycleStatusAfter ?? "open") === lifecycleStatusForItem(item);
}

function sortedCheckpoints(checkpoints: CanonicalCheckpoint[]): CanonicalCheckpoint[] {
  return [...checkpoints].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

function latestCheckpoint(checkpoints: CanonicalCheckpoint[]): CanonicalCheckpoint | undefined {
  return sortedCheckpoints(checkpoints).at(-1);
}

function latestDeltaForStableKey(deltas: CanonicalDelta[], stableKey: string): CanonicalDelta | undefined {
  return [...deltas]
    .filter((delta) => delta.stableKey === stableKey)
    .sort((a, b) => b.version - a.version || b.approvedAt.localeCompare(a.approvedAt))[0];
}

function latestDeltaForCanonicalItem(deltas: CanonicalDelta[], canonicalItemId: string): CanonicalDelta | undefined {
  return [...deltas]
    .filter((delta) => delta.canonicalItemId === canonicalItemId)
    .sort((a, b) => b.version - a.version || b.approvedAt.localeCompare(a.approvedAt))[0];
}

const inactiveLifecycleStatuses = new Set<CanonicalLifecycleStatus>(["resolved", "dropped", "superseded", "stale"]);

function lifecycleStatusForItem(item: Pick<ExtractedItem, "status" | "lifecycleStatusAfter">): CanonicalLifecycleStatus {
  if (item.lifecycleStatusAfter) return item.lifecycleStatusAfter;
  if (item.status === "merged") return "superseded";
  return "open";
}

function canonicalItemIdForExtractedItem(item: Pick<ExtractedItem, "id" | "canonicalItemId" | "targetCanonicalItemId">): string {
  return item.canonicalItemId || item.targetCanonicalItemId || item.id;
}

function shouldCreateCanonicalDelta(item: ExtractedItem): boolean {
  return item.lifecycleAction !== "no_op";
}

function currentApprovedItems(items: ExtractedItem[]): ExtractedItem[] {
  const currentByCanonicalId = new Map<string, ExtractedItem>();
  const sorted = [...items]
    .filter((item) => item.status === "approved")
    .filter(shouldCreateCanonicalDelta)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.updatedAt.localeCompare(b.updatedAt));
  for (const item of sorted) {
    currentByCanonicalId.set(canonicalItemIdForExtractedItem(item), item);
  }
  return [...currentByCanonicalId.values()];
}

function lifecycleStatusForDelta(delta: CanonicalDelta): CanonicalLifecycleStatus {
  if (delta.status === "superseded") return "superseded";
  return delta.lifecycleStatusAfter ?? "open";
}

function canonicalItemsFromDeltas(deltas: CanonicalDelta[]): CanonicalItem[] {
  const byId = new Map<string, CanonicalItem>();
  for (const delta of [...deltas].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt))) {
    const canonicalItemId = delta.canonicalItemId ?? delta.stableKey ?? delta.id;
    const previous = byId.get(canonicalItemId);
    const deltaIds = [...(previous?.deltaIds ?? []), delta.id];
    byId.set(canonicalItemId, {
      id: canonicalItemId,
      projectId: delta.projectId,
      type: delta.type,
      title: delta.title,
      body: delta.body,
      lifecycleStatus: lifecycleStatusForDelta(delta),
      latestDeltaId: delta.id,
      deltaIds,
      conversationArtifactId: delta.conversationArtifactId,
      providerRefIds: delta.providerRefIds,
      evidenceSource: delta.evidenceSource,
      evidenceEntryId: delta.evidenceEntryId,
      evidenceQuote: delta.evidenceQuote,
      createdAt: previous?.createdAt ?? delta.createdAt,
      updatedAt: delta.updatedAt
    });
  }
  return [...byId.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

function withDeltaLifecycleDefaults(delta: CanonicalDelta): CanonicalDelta {
  const canonicalItemId = delta.canonicalItemId ?? delta.stableKey ?? delta.id;
  return {
    ...delta,
    canonicalItemId,
    lifecycleAction: delta.lifecycleAction ?? "create",
    lifecycleStatusBefore: delta.lifecycleStatusBefore,
    lifecycleStatusAfter: delta.lifecycleStatusAfter ?? (delta.status === "superseded" ? "superseded" : "open"),
    targetCanonicalItemId: delta.targetCanonicalItemId,
    canonicalOperation: delta.canonicalOperation ?? "add",
    mergeStrategy: delta.mergeStrategy ?? "append_unique",
    reconcilesWith: delta.reconcilesWith ?? [],
    conflicts: delta.conflicts ?? []
  };
}

function withCanonicalItems(chart: CanonicalChartFile): CanonicalChartFile {
  const deltas = chart.deltas.map(withDeltaLifecycleDefaults);
  return {
    ...chart,
    deltas,
    canonicalItems: canonicalItemsFromDeltas(deltas)
  };
}

function matchesCanonicalTarget(item: ExtractedItem, targetId: string): boolean {
  return item.id === targetId || item.canonicalItemId === targetId || item.targetCanonicalItemId === targetId;
}

function withLifecycleDefaults(item: ExtractedItem): ExtractedItem {
  return {
    ...item,
    canonicalItemId: canonicalItemIdForExtractedItem(item),
    lifecycleAction: item.lifecycleAction ?? "create",
    lifecycleStatusAfter: lifecycleStatusForItem(item)
  };
}

function applyLifecycleSideEffects(items: ExtractedItem[], selectedItems: ExtractedItem[], updatedAt: string): ExtractedItem[] {
  const sideEffectTargets = selectedItems
    .filter((item) => item.canonicalOperation === "promote_backlog_to_task" || item.canonicalOperation === "demote_task_to_backlog")
    .map((item) => ({
      targetId: item.targetCanonicalItemId,
      mergedIntoId: item.canonicalItemId || item.id
    }))
    .filter((item): item is { targetId: string; mergedIntoId: string } => Boolean(item.targetId));
  if (sideEffectTargets.length === 0) return items;

  return items.map((item) => {
    const target = sideEffectTargets.find((candidate) => matchesCanonicalTarget(item, candidate.targetId) && item.id !== candidate.mergedIntoId);
    if (!target) return item;
    return {
      ...item,
      lifecycleAction: "supersede",
      lifecycleStatusAfter: "superseded",
      mergedIntoId: target.mergedIntoId,
      updatedAt
    };
  });
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

async function previewFile(filePath: string | undefined, maxChars = 24_000): Promise<string | undefined> {
  if (!filePath || !existsSync(filePath)) return undefined;
  const text = await readFile(filePath, "utf8");
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars / 2));
  const tail = text.slice(text.length - Math.floor(maxChars / 2));
  return `${head}\n\n[... ${text.length - maxChars} chars omitted ...]\n\n${tail}`;
}

async function writeAtomic(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  await writeFile(tempPath, text, "utf8");
  await mkdir(dir, { recursive: true });
  await rename(tempPath, filePath);
}

function serializeOperations() {
  let queue: Promise<unknown> = Promise.resolve();

  return async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return await run;
  };
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function entryToMarkdown(entry: TranscriptEntry): string {
  const mode = entry.scratchMode ? ` · ${entry.scratchMode}` : "";
  const effort = entry.reasoningEffort ? ` · ${entry.reasoningEffort}` : "";
  const failed = entry.failed ? " · failed" : "";
  const parts = [`## ${entry.role} · ${entry.createdAt}${mode}${effort}${failed}`];
  if (entry.spokenText) parts.push(`Spoken:\n${entry.spokenText.trim()}`);
  const mainText = entry.spokenText ? entry.notesText || entry.text : entry.text;
  if (mainText?.trim()) parts.push(`${entry.spokenText ? "Notes" : "Text"}:\n${mainText.trim()}`);
  if (entry.sourcesText?.trim()) parts.push(`Sources:\n${entry.sourcesText.trim()}`);
  return `${parts.join("\n\n")}\n`;
}

function transcriptMarkdown(session: MorticSession): string {
  const body = session.transcript.map(entryToMarkdown).join("\n");
  return `# Mortic Transcript\n\nSource thread: ${session.sourceUri}\n\n${body}`.trim() + "\n";
}

function sessionTitle(session: MorticSession): string {
  const firstUser = session.transcript.find((entry) => entry.role === "user")?.text.trim();
  if (firstUser) return firstUser.replace(/\s+/g, " ").slice(0, 78);
  return `Scratch ${session.threadId.slice(0, 8)}`;
}

function sourceTitle(threadId: string): string {
  return `Codex ${threadId.slice(0, 8)}`;
}

function sourceCheckpointTitle(source: SourceThreadNode, index = 1): string {
  return index <= 1 ? "Initial checkpoint" : `Checkpoint ${index}`;
}

function handoffHashForSession(session: MorticSession): string | null {
  const text = [session.handoffShort, session.handoffFull, session.handoff].filter(Boolean).join("\n\n").trim();
  return text ? hash(text, 18) : null;
}

type ExtractionCandidate = {
  type: ExtractedItemType;
  title?: string;
  body: string;
  entryId: string;
  role: TranscriptEntry["role"];
  createdAt: string;
  confidence: number;
  evidenceSource: NonNullable<ExtractedItem["evidenceSource"]>;
  selectionReason: string;
};

function cleanExtractionLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+|\d+[.)]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lineCandidates(entry: TranscriptEntry): string[] {
  if (entry.role !== "assistant") return [];
  const text = [entry.notesText, entry.spokenText]
    .filter(Boolean)
    .join("\n")
    .replace(/\r/g, "");
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .map(cleanExtractionLine)
    .filter((line) => line.length >= 24)
    .filter((line) => !/^(yes|no|yep|right|you asked|the answer is)\b/i.test(line))
    .filter((line) => !line.endsWith("?"))
    .filter((line) => !line.endsWith(":"))
    .slice(0, 18);
}

function handoffEvidenceSource(sourceId: string): NonNullable<ExtractedItem["evidenceSource"]> {
  if (sourceId === "handoff_short") return "handoff_short";
  if (sourceId === "handoff_full") return "handoff_full";
  return "handoff";
}

function handoffSelectionReason(sourceId: string): string {
  if (sourceId === "handoff_short") {
    return "Picked from the short handoff prompt because it states the highest-order continuation action.";
  }
  if (sourceId === "handoff_full") {
    return "Picked from the full handoff prompt because it is the curated, action-oriented summary of this scratch session.";
  }
  return "Picked from the handoff prompt because it is already condensed for the next Codex step.";
}

function isHandoffSectionHeading(line: string): boolean {
  return line.endsWith(":") && line.length <= 130 && !line.endsWith("?:");
}

function summarizeHandoffSection(heading: string, lines: string[]): string | null {
  const cleaned = lines
    .map(cleanExtractionLine)
    .filter((line) => line.length >= 8)
    .filter((line) => !isWorkflowGuidance(line));
  if (cleaned.length === 0) return null;
  const preview = cleaned.slice(0, 6).join("; ");
  const suffix = cleaned.length > 6 ? `; plus ${cleaned.length - 6} more.` : "";
  return `${heading.replace(/:$/, "")}: ${preview}${suffix}`;
}

function handoffTextCandidates(session: MorticSession): Array<{
  sourceId: "handoff_short" | "handoff_full" | "handoff";
  body: string;
}> {
  const sources: Array<{ sourceId: "handoff_short" | "handoff_full" | "handoff"; text?: string }> = [];
  if (session.handoffFull?.trim()) {
    sources.push({ sourceId: "handoff_full", text: session.handoffFull });
  } else if (session.handoffShort?.trim()) {
    sources.push({ sourceId: "handoff_short", text: session.handoffShort });
  } else if (session.handoff?.trim()) {
    sources.push({ sourceId: "handoff", text: session.handoff });
  }

  const candidates: Array<{ sourceId: "handoff_short" | "handoff_full" | "handoff"; body: string }> = [];
  for (const source of sources) {
    const lines = (source.text ?? "").replace(/\r/g, "").split("\n");
    let activeHeading: string | null = null;
    let activeLines: string[] = [];
    const flushSection = () => {
      if (!activeHeading) return;
      const section = summarizeHandoffSection(activeHeading, activeLines);
      if (section) candidates.push({ sourceId: source.sourceId, body: section });
      activeHeading = null;
      activeLines = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^#{1,6}\s+/.test(line)) continue;
      const cleaned = cleanExtractionLine(line);
      if (!cleaned || isWorkflowGuidance(cleaned)) continue;
      if (isHandoffSectionHeading(cleaned)) {
        flushSection();
        activeHeading = cleaned;
        activeLines = [];
        continue;
      }
      if (activeHeading) {
        activeLines.push(cleaned);
        continue;
      }
      if (cleaned.length >= 28 && !cleaned.endsWith("?")) {
        candidates.push({ sourceId: source.sourceId, body: cleaned });
      }
    }
    flushSection();
  }

  return candidates;
}

function classifyLine(line: string): ExtractedItemType | null {
  const lower = line.toLowerCase();
  if (isWorkflowGuidance(lower)) return null;
  if (/^(risk|blocker|uncertainty|warning|failure|issue|problem)\s*[:.-]/i.test(line)) return "risk";
  if (/^(task|todo|next step|fix|implement|add|write|test|run|verify)\s*[:.-]/i.test(line)) return "task";
  if (/^(backlog|later|future|idea|nice-to-have|defer|deferred)\s*[:.-]/i.test(line)) return "backlog";
  if (/^(priority|prioritization|prioritisation|most important|now|deferred because)\s*[:.-]/i.test(line)) return "prioritization";
  if (/^(project state|state update|decision|constraint|architecture|objective|current summary|fact)\s*[:.-]/i.test(line)) return "project_state";

  if (lower.includes("permission denied") || lower.includes("failed") || lower.includes("unsafe") || lower.includes("blocked")) return "risk";
  if (lower.includes("should implement") || lower.includes("needs to implement") || lower.includes("add a ") || lower.includes("fix ")) return "task";
  if (lower.includes("defer") || lower.includes("future work") || lower.includes("nice-to-have") || lower.includes("later")) return "backlog";
  if (lower.includes("priority") || lower.includes("most important") || lower.includes("secondary") || lower.includes("deferred because")) return "prioritization";
  if (lower.includes("source thread must") || lower.includes("do not mutate") || lower.includes("we decided") || lower.includes("objective")) return "project_state";
  return null;
}

function classifyHandoffCandidate(line: string): ExtractedItemType | null {
  const lower = line.toLowerCase();
  if (isWorkflowGuidance(lower)) return null;
  if (/^(acceptance criteria|failure gates|risk gates|risks?|blockers?|known issues?)\s*:/i.test(line)) return "risk";
  if (/^(requirements?|please build|please implement|please capture|please add|please iterate|test plan|validation)\s*[:.-]?/i.test(line)) return "task";
  if (/^(priority|prioriti[sz]ation|focus|recommended next|treat this as|do not add|keep one)\s*[:.-]?/i.test(line)) return "prioritization";
  if (/^(project state|contract|constraints?|architecture|source safety|product rule)\s*[:.-]?/i.test(line)) return "project_state";
  if (/^(backlog|later|future|deferred|nice-to-have)\s*[:.-]/i.test(line)) return "backlog";

  if (lower.includes("treat this as") || lower.includes("not a provider-switching task") || lower.includes("do not add more")) return "prioritization";
  if (lower.includes("source thread must") || lower.includes("do not mutate") || lower.includes("output contract") || lower.includes("tts reads only")) return "project_state";
  if (lower.includes("fails if") || lower.includes("failure") || lower.includes("unsupported/static-risk") || lower.includes("fallback cannot hide")) return "risk";
  if (lower.includes("please implement") || lower.includes("please build") || lower.includes("add a ") || lower.includes("capture per-turn") || lower.includes("record requested provider")) return "task";
  if (lower.includes("future work") || lower.includes("nice-to-have") || lower.includes("deferred feature")) return "backlog";
  return classifyLine(line);
}

function isWorkflowGuidance(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("commit is a local checkpoint") ||
    lower.includes("commit again later") ||
    lower.includes("point of no return") ||
    lower.includes("generate handoff") ||
    lower.includes("missing short handoff") ||
    lower.includes("missing full handoff") ||
    lower.includes("if you want to chat more") ||
    lower.includes("approve all") ||
    lower.includes("handoff readiness") ||
    lower.includes("later commits can add or refine") ||
    lower.includes("extract items such as decisions") ||
    lower.includes("look for the project card") ||
    lower.includes("the first tree is there") ||
    lower.includes("acknowledged. the intended canonical instruction") ||
    lower.includes("not guaranteed. based on the current canonical state") ||
    lower.includes("safe acceptance check") ||
    lower.includes("desired behavior:") ||
    lower.includes("expected result after approval") ||
    lower.includes("old backlog record remains") ||
    lower.includes("previous backlog record") ||
    lower.includes("tasks includes") ||
    lower.includes("backlog no longer shows") ||
    lower.includes("you say:")
  );
}

function isWorkflowGuidanceItem(item: ExtractedItem): boolean {
  return isWorkflowGuidance(`${item.title}\n${item.body}`);
}

function isWeakExtractionItem(item: ExtractedItem): boolean {
  const title = item.title.trim();
  const body = item.body.trim();
  return (
    /^#{1,6}\s+/.test(title) ||
    /^#{1,6}\s+/.test(body) ||
    /\*\*|`/.test(title) ||
    /^(yes|no|yep|right)\b/i.test(title) ||
    title.length > 84 ||
    title.endsWith(":") ||
    body.endsWith(":")
  );
}

function itemTitle(type: ExtractedItemType, line: string): string {
  const clean = line.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
  const withoutLead = clean.replace(/^(project state|state update|decision|constraint|architecture|objective|current summary|fact|priority|prioritization|prioritisation|most important|now|task|todo|next step|fix|implement|add|write|test|run|verify|risk|blocker|uncertainty|warning|failure|issue|problem|backlog|later|future|idea|nice-to-have|defer|deferred)\s*[:.-]\s*/i, "");
  return withoutLead.slice(0, 96);
}

function handoffCandidateTitle(type: ExtractedItemType, body: string): string {
  const lower = body.toLowerCase();
  if (lower.includes("voice latency eval harness")) return "Implement Mortic voice latency eval harness";
  if (lower.startsWith("requirements:")) return "Add conversation-level provider benchmark requirements";
  if (lower.startsWith("please capture per-turn timestamps")) return "Capture turn-level latency timings";
  if (lower.startsWith("please add provider-side event logging")) return "Log provider WebSocket timing events";
  if (lower.startsWith("acceptance criteria:")) return "Add strict provider and playback failure gates";
  if (lower.startsWith("please iterate based on the measurements")) return "Iterate based on measured latency bottlenecks";
  if (lower.includes("output contract")) return "Preserve the Mortic voice output contract";
  if (lower.includes("source thread") && lower.includes("do not mutate")) return "Preserve source-thread safety";
  if (type === "prioritization" && lower.includes("not a provider-switching task")) return "Prioritize measurement before provider switching";
  return itemTitle(type, body);
}

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function extractionFingerprint(type: ExtractedItemType, title: string, body: string): string {
  return `${type}:${normalizeBody(`${title} ${body}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180)}`;
}

function extractionDelta(previous: ExtractedItem | undefined, body: string): ExtractedItem["delta"] {
  if (!previous) return "new";
  return normalizeBody(previous.body) === normalizeBody(body) ? "unchanged" : "changed";
}

function handoffExtractionCandidates(session: MorticSession): ExtractionCandidate[] {
  const candidates: ExtractionCandidate[] = [];
  const createdAt = session.updatedAt || nowIso();
  for (const source of handoffTextCandidates(session)) {
    const type = classifyHandoffCandidate(source.body);
    if (!type) continue;
    candidates.push({
      type,
      title: handoffCandidateTitle(type, source.body),
      body: source.body,
      entryId: source.sourceId,
      role: "assistant",
      createdAt,
      confidence: source.sourceId === "handoff_full" ? 0.86 : 0.82,
      evidenceSource: handoffEvidenceSource(source.sourceId),
      selectionReason: handoffSelectionReason(source.sourceId)
    });
  }
  return candidates;
}

function transcriptExtractionCandidates(session: MorticSession): ExtractionCandidate[] {
  const candidates: ExtractionCandidate[] = [];
  for (const entry of session.transcript) {
    for (const line of lineCandidates(entry)) {
      const type = classifyLine(line);
      if (!type) continue;
      candidates.push({
        type,
        body: line,
        entryId: entry.id,
        role: entry.role,
        createdAt: entry.createdAt,
        confidence: type === "project_state" || type === "risk" ? 0.78 : 0.7,
        evidenceSource: "transcript",
        selectionReason: "Picked from the transcript because no handoff-derived item covered this concrete update."
      });
    }
  }
  return candidates;
}

function extractItems(params: {
  projectId: string;
  sourceThreadId: string;
  scratchSessionId: string;
  session: MorticSession;
  existing: ExtractedItem[];
  approveItemIds?: Set<string>;
}): ExtractedItem[] {
  const createdAt = nowIso();
  const existingById = new Map(params.existing.map((item) => [item.id, item]));
  const existingByFingerprint = new Map(
    params.existing.map((item) => [extractionFingerprint(item.type, item.title, item.body), item])
  );
  const handoffCandidates = handoffExtractionCandidates(params.session);
  const candidatePool = handoffCandidates.length > 0
    ? handoffCandidates
    : transcriptExtractionCandidates(params.session);
  const extracted: ExtractedItem[] = [];
  const seen = new Set<string>();

  for (const candidate of candidatePool) {
    if (extracted.filter((item) => item.type === candidate.type).length >= 3) continue;
    const title = candidate.title ?? itemTitle(candidate.type, candidate.body);
    const fingerprint = extractionFingerprint(candidate.type, title, candidate.body);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const id = `item-${hash(`${params.scratchSessionId}:${candidate.entryId}:${candidate.type}:${title}`, 18)}`;
    const previous = existingById.get(id) ?? existingByFingerprint.get(fingerprint);
    extracted.push({
      id,
      projectId: params.projectId,
      sourceThreadId: params.sourceThreadId,
      scratchSessionId: params.scratchSessionId,
      sourceTurnId: candidate.entryId,
      type: candidate.type,
      title,
      body: candidate.body,
      confidence: candidate.confidence,
      status: params.approveItemIds?.has(id) ? "approved" : previous?.status ?? "draft",
      delta: extractionDelta(previous, candidate.body),
      evidenceSource: candidate.evidenceSource,
      selectionReason: candidate.selectionReason,
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: createdAt,
      transcriptAnchor: {
        entryId: candidate.entryId,
        role: candidate.role,
        createdAt: candidate.createdAt,
        quote: candidate.body.slice(0, 240)
      },
      mergedIntoId: previous?.mergedIntoId
    });
  }

  return extracted.slice(0, 10);
}

function renderExtractedMarkdown(items: ExtractedItem[]): string {
  const rows = items
    .map((item) => {
      const details = [
        `  - ${item.body}`,
        item.lifecycleStatusAfter ? `  - Lifecycle: ${item.lifecycleAction ?? "create"} -> ${item.lifecycleStatusAfter}` : undefined,
        item.targetCanonicalItemId ? `  - Target: ${item.targetCanonicalItemId}` : undefined,
        item.selectionReason ? `  - Why picked: ${item.selectionReason}` : undefined,
        item.transcriptAnchor?.quote ? `  - Evidence: ${item.transcriptAnchor.quote}` : undefined
      ].filter(Boolean);
      return `- **${extractionLabels[item.type]}** [${item.status}${item.delta ? `, ${item.delta}` : ""}] ${item.title}\n${details.join("\n")}`;
    })
    .join("\n");
  return `# Mortic Extracted Items\n\n${rows || "No extracted items yet."}\n`;
}

function productionFrom(params: {
  project: MorticProject;
  sources: SourceThreadNode[];
  sessions: ScratchSessionNode[];
  items: ExtractedItem[];
  previous?: ProductionChart;
}): ProductionChart {
  const approved = currentApprovedItems(params.items);
  const byType = (type: ExtractedItemType) => approved.filter((item) => item.type === type);
  return {
    projectId: params.project.id,
    projectTitle: params.project.title,
    workspacePath: params.project.workspacePath,
    currentProjectSummary:
      params.previous?.currentProjectSummary ||
      `Local Mortic production chart for ${params.project.title}. Approved items are promoted here from scratch sessions only.`,
    canonicalSourceThreads: params.sources.map((source) => ({
      id: source.id,
      title: source.title,
      sourceUri: source.sourceUri
    })),
    projectStateUpdates: byType("project_state"),
    prioritizationUpdates: byType("prioritization"),
    taskUpdates: byType("task"),
    riskUpdates: byType("risk"),
    backlogUpdates: byType("backlog"),
    linkedScratchSessions: params.sessions
      .filter((session) => session.status === "committed" || session.status === "archived")
      .map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status
      })),
    linkedSourceThreads: params.sources.map((source) => source.id),
    lastApprovedHandoff: params.previous?.lastApprovedHandoff,
    updatedAt: nowIso()
  };
}

function renderProductionMarkdown(production: ProductionChart): string {
  const renderItems = (items: ExtractedItem[]) => items.map((item) => {
    const lifecycleStatus = lifecycleStatusForItem(item);
    const lifecycleLabel = lifecycleStatus === "open" ? "" : ` _${lifecycleStatus}_`;
    const lines = [
      `- **${item.title}**${lifecycleLabel}`,
      `  - ${item.body}`,
      item.lifecycleAction ? `  - Lifecycle: ${item.lifecycleAction}${item.lifecycleStatusBefore ? ` (${item.lifecycleStatusBefore} -> ${lifecycleStatus})` : ` -> ${lifecycleStatus}`}` : undefined,
      item.targetCanonicalItemId ? `  - Reconciles: ${item.targetCanonicalItemId}` : undefined,
      `  - Session: ${item.scratchSessionId}`
    ].filter(Boolean);
    return lines.join("\n");
  }).join("\n");
  const section = (title: string, items: ExtractedItem[]) => {
    const active = items.filter((item) => !inactiveLifecycleStatuses.has(lifecycleStatusForItem(item)));
    const historical = items.filter((item) => inactiveLifecycleStatuses.has(lifecycleStatusForItem(item)));
    return [
      `## ${title}`,
      "",
      active.length ? renderItems(active) : "None.",
      historical.length ? `\n### Historical\n\n${renderItems(historical)}` : "",
      ""
    ].join("\n");
  };

  return [
    `# ${production.projectTitle} Production Chart`,
    `Workspace: ${production.workspacePath}`,
    "",
    `Updated: ${production.updatedAt}`,
    "",
    "## Summary",
    "",
    production.currentProjectSummary,
    "",
    section("Project State Updates", production.projectStateUpdates),
    section("Prioritisation Updates", production.prioritizationUpdates),
    section("Task Updates", production.taskUpdates),
    section("Risk Updates", production.riskUpdates),
    section("Backlog Updates", production.backlogUpdates),
    "## Source Threads",
    "",
    production.canonicalSourceThreads.map((source) => `- ${source.title}: ${source.sourceUri}`).join("\n") || "None.",
    "",
    "## Scratch Sessions",
    "",
    production.linkedScratchSessions.map((session) => `- ${session.title} (${session.status})`).join("\n") || "None.",
    ""
  ].join("\n");
}

function computeReadiness(session: MorticSession, scratch: ScratchSessionNode, items: ExtractedItem[]): HandoffReadiness {
  const missing: string[] = [];
  const risksOrQuestions = items.some((item) => item.type === "risk") || items.some((item) => item.type === "project_state");
  const signals = {
    hasUserGoal: session.transcript.some((entry) => entry.role === "user" && entry.text.trim().length > 12),
    hasSourceThreadId: Boolean(session.threadId),
    hasSessionTitle: Boolean(scratch.title.trim()),
    hasSessionDescription: Boolean(scratch.description?.trim() || scratch.summary?.trim()),
    hasUsefulSummary: Boolean(scratch.summary?.trim()),
    hasExtraction: items.some((item) => item.status !== "dismissed"),
    hasShortHandoff: Boolean(session.handoffShort?.trim()),
    hasFullHandoff: Boolean(session.handoffFull?.trim() || session.handoff?.trim()),
    hasRiskOrQuestionState: risksOrQuestions,
    transcriptNotEmpty: session.transcript.length > 0,
    noActiveTurnRunning: session.activeTurn?.status !== "running",
    noForkSafetyWarning: !session.forkCheckpoint || session.forkCheckpoint.scratchThreadId !== session.forkCheckpoint.sourceThreadId
  };
  const labels: Record<keyof typeof signals, string> = {
    hasUserGoal: "user goal",
    hasSourceThreadId: "source thread",
    hasSessionTitle: "session title",
    hasSessionDescription: "session description",
    hasUsefulSummary: "session summary",
    hasExtraction: "draft or approved extraction",
    hasShortHandoff: "short handoff",
    hasFullHandoff: "full handoff",
    hasRiskOrQuestionState: "risks/project state reviewed",
    transcriptNotEmpty: "transcript",
    noActiveTurnRunning: "no active turn",
    noForkSafetyWarning: "scratch fork safety"
  };
  for (const [key, value] of Object.entries(signals) as Array<[keyof typeof signals, boolean]>) {
    if (!value) missing.push(labels[key]);
  }
  const passed = Object.values(signals).filter(Boolean).length;
  const percentage = Math.round((passed / Object.keys(signals).length) * 100);
  const status = !signals.noForkSafetyWarning || !signals.hasSourceThreadId
    ? "unsafe"
    : percentage >= 82 && signals.noActiveTurnRunning
      ? "ready-to-commit"
      : "needs-review";
  return { percentage, status, missing, signals };
}

export async function createProjectStore(params: ProjectStoreParams): Promise<ProjectStore> {
  const workspacePath = path.resolve(params.workspacePath);
  const projectId = projectIdForWorkspace(workspacePath);
  const projectDir = path.join(projectBaseDir(), projectId);
  const paths = projectPaths(projectDir);
  const now = nowIso();
  const enqueue = serializeOperations();

  await mkdir(path.join(projectDir, "source_threads"), { recursive: true });
  await mkdir(path.join(projectDir, "source_checkpoints"), { recursive: true });
  await mkdir(path.join(projectDir, "sessions"), { recursive: true });

  async function readProject(): Promise<MorticProject> {
    const fallback: MorticProject = {
      id: projectId,
      title: params.projectTitle ?? (path.basename(workspacePath) || "Mortic Project"),
      workspacePath,
      createdAt: now,
      updatedAt: now,
      canonicalSourceThreadIds: []
    };
    return readJson(paths.project, fallback);
  }

  async function writeProject(project: MorticProject): Promise<void> {
    await writeAtomic(paths.project, `${JSON.stringify({ ...project, updatedAt: nowIso() }, null, 2)}\n`);
  }

  async function readSources(): Promise<SourceThreadNode[]> {
    let entries;
    try {
      entries = await readdir(path.join(projectDir, "source_threads"), { withFileTypes: true });
    } catch {
      return [];
    }
    const sources: SourceThreadNode[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const source = await readJson(path.join(projectDir, "source_threads", entry.name), undefined as unknown as SourceThreadNode);
      if (source) {
        sources.push({
          ...source,
          tags: source.tags ?? [],
          childrenCheckpointIds: source.childrenCheckpointIds ?? [],
          childrenScratchSessionIds: source.childrenScratchSessionIds ?? []
        });
      }
    }
    return sources.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function readCheckpoints(): Promise<SourceCheckpointNode[]> {
    let entries;
    try {
      entries = await readdir(path.join(projectDir, "source_checkpoints"), { withFileTypes: true });
    } catch {
      return [];
    }
    const checkpoints: SourceCheckpointNode[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const checkpoint = await readJson(path.join(projectDir, "source_checkpoints", entry.name), undefined as unknown as SourceCheckpointNode);
      if (checkpoint) {
        checkpoints.push({
          ...checkpoint,
          childrenScratchSessionIds: checkpoint.childrenScratchSessionIds ?? []
        });
      }
    }
    return checkpoints.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function readSessions(): Promise<ScratchSessionNode[]> {
    let entries;
    try {
      entries = await readdir(path.join(projectDir, "sessions"), { withFileTypes: true });
    } catch {
      return [];
    }
    const sessions: ScratchSessionNode[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(projectDir, "sessions", entry.name, "session.json");
      if (!existsSync(filePath)) continue;
      const session = await readJson(filePath, undefined as unknown as ScratchSessionNode);
      if (session) sessions.push({ ...session, tags: session.tags ?? [] });
    }
    return sessions.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function writeChartStorage(chart: CanonicalChartFile): Promise<void> {
    await writeAtomic(paths.chart, `${JSON.stringify({ ...withCanonicalItems(chart), updatedAt: nowIso() }, null, 2)}\n`);
  }

  async function readChartStorage(): Promise<CanonicalChartFile> {
    const fallback = emptyChartFile(projectId);
    const chart = await readJson(paths.chart, fallback);
    return {
      ...fallback,
      ...chart,
      schemaVersion: "1.0",
      projectId,
      checkpoints: chart.checkpoints ?? [],
      canonicalItems: chart.canonicalItems ?? [],
      deltas: chart.deltas ?? [],
      draftCompilations: chart.draftCompilations ?? [],
      artifacts: chart.artifacts ?? [],
      providerRefs: chart.providerRefs ?? []
    };
  }

  function conversationArtifactForScratch(scratch: ScratchSessionNode, providerRefIds: string[]): ConversationArtifact {
    return {
      id: conversationArtifactIdForScratch(scratch.id),
      projectId,
      title: scratch.title,
      artifactKind: "scratch-session",
      sourceThreadId: scratch.sourceThreadId,
      sourceCheckpointId: scratch.sourceCheckpointId,
      scratchSessionId: scratch.id,
      transcriptPath: scratch.transcriptPath,
      handoffPath: scratch.handoffPath,
      eventLogPath: scratch.eventLogPath,
      providerRefIds,
      createdAt: scratch.createdAt,
      updatedAt: scratch.updatedAt
    };
  }

  async function syncChartArtifacts(chart: CanonicalChartFile, runtimeContext?: RuntimeContextRestore): Promise<CanonicalChartFile> {
    const sources = await readSources();
    const sessions = await readSessions();
    const providerRefs = new Map(chart.providerRefs.map((ref) => [ref.id, ref]));
    const sourceProviderRefIds = new Map<string, string>();

    for (const source of sources) {
      const ref = codexProviderAdapter.sourceReference(source, runtimeContext);
      providerRefs.set(ref.id, { ...providerRefs.get(ref.id), ...ref, accountId: providerRefs.get(ref.id)?.accountId });
      sourceProviderRefIds.set(source.id, ref.id);
    }

    const artifacts = new Map(chart.artifacts.map((artifact) => [artifact.id, artifact]));
    for (const scratch of sessions) {
      const scratchRef = codexProviderAdapter.scratchReference(scratch, runtimeContext);
      if (scratchRef) {
        providerRefs.set(scratchRef.id, { ...providerRefs.get(scratchRef.id), ...scratchRef, accountId: providerRefs.get(scratchRef.id)?.accountId });
      }
      const providerRefIds = unique([
        scratchRef?.id,
        sourceProviderRefIds.get(scratch.sourceThreadId)
      ].filter((id): id is string => Boolean(id)));
      const artifact = conversationArtifactForScratch(scratch, providerRefIds);
      artifacts.set(artifact.id, {
        ...artifacts.get(artifact.id),
        ...artifact
      });
    }

    return {
      ...chart,
      artifacts: [...artifacts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      providerRefs: [...providerRefs.values()].sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  async function ensureImportedApprovedCheckpoint(chart: CanonicalChartFile, chartAlreadyExists: boolean): Promise<CanonicalChartFile> {
    if (chartAlreadyExists) return chart;
    if (chart.checkpoints.length > 0 || chart.deltas.length > 0) return chart;
    const approvedItems = (await readItems()).filter((item) => item.status === "approved");
    if (approvedItems.length === 0) return chart;

    const sessions = await readSessions();
    const artifacts = new Map(chart.artifacts.map((artifact) => [artifact.id, artifact]));
    const deltas: CanonicalDelta[] = [];
    const checkpointId = canonicalCheckpointId(`${projectId}:imported-approved-updates`);
    const approvedAt = nowIso();
    const sourceArtifactIds = new Set<string>();

    for (const rawItem of approvedItems.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const item = withLifecycleDefaults(rawItem);
      if (!shouldCreateCanonicalDelta(item)) continue;
      const scratch = sessions.find((session) => session.id === item.scratchSessionId);
      const artifactId = scratch ? conversationArtifactIdForScratch(scratch.id) : importedArtifactId(projectId);
      if (!artifacts.has(artifactId)) {
        artifacts.set(artifactId, {
          id: artifactId,
          projectId,
          title: scratch?.title ?? "Imported approved project updates",
          artifactKind: scratch ? "scratch-session" : "import",
          sourceThreadId: item.sourceThreadId,
          scratchSessionId: scratch?.id,
          transcriptPath: scratch?.transcriptPath,
          handoffPath: scratch?.handoffPath,
          eventLogPath: scratch?.eventLogPath,
          providerRefIds: [],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        });
      }
      sourceArtifactIds.add(artifactId);
      const stableKey = canonicalStableKey(item);
      const canonicalItemId = canonicalItemIdForExtractedItem(item);
      const previous = latestDeltaForCanonicalItem(deltas, canonicalItemId) ?? latestDeltaForStableKey(deltas, stableKey);
      const version = previous ? previous.version + 1 : 1;
      const providerRefIds = artifacts.get(artifactId)?.providerRefIds ?? [];
      deltas.push({
        id: canonicalDeltaId(`${checkpointId}:${item.id}:${version}`),
        projectId,
        stableKey,
        version,
        type: item.type,
        title: item.title,
        body: item.body,
        status: "approved",
        canonicalItemId,
        targetCanonicalItemId: item.targetCanonicalItemId,
        lifecycleAction: item.lifecycleAction ?? "create",
        lifecycleStatusBefore: item.lifecycleStatusBefore,
        lifecycleStatusAfter: lifecycleStatusForItem(item),
        canonicalOperation: item.canonicalOperation,
        mergeStrategy: item.mergeStrategy,
        reconcilesWith: item.reconcilesWith,
        reconciliationReason: item.reconciliationReason,
        conflicts: item.conflicts,
        checkpointId,
        previousDeltaId: previous?.id,
        sourceExtractedItemId: item.id,
        conversationArtifactId: artifactId,
        providerRefIds,
        evidenceSource: item.evidenceSource,
        evidenceEntryId: item.transcriptAnchor?.entryId ?? item.sourceTurnId,
        evidenceQuote: item.transcriptAnchor?.quote,
        localPaths: {
          transcript: scratch?.transcriptPath,
          handoff: scratch?.handoffPath,
          eventLog: scratch?.eventLogPath
        },
        approvedAt,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      });
    }

    return {
      ...chart,
      checkpoints: [
        {
          id: checkpointId,
          projectId,
          title: "Imported approved project updates",
          approvedDeltaIds: deltas.map((delta) => delta.id),
          sourceArtifactIds: [...sourceArtifactIds],
          createdAt: approvedAt,
          approvedAt,
          imported: true
        }
      ],
      deltas,
      artifacts: [...artifacts.values()]
    };
  }

  async function readCanonicalChart(runtimeContext?: RuntimeContextRestore): Promise<CanonicalChartFile> {
    const chartAlreadyExists = existsSync(paths.chart);
    let chart = await readChartStorage();
    chart = await syncChartArtifacts(chart, runtimeContext);
    chart = await ensureImportedApprovedCheckpoint(chart, chartAlreadyExists);
    chart = withCanonicalItems(chart);
    await writeChartStorage(chart);
    return chart;
  }

  async function readItems(): Promise<ExtractedItem[]> {
    const items = await readJson(paths.extractedItems, [] as ExtractedItem[]);
    return items.filter((item) => canonicalExtractionTypes.has(item.type) && item.delta && !isWorkflowGuidanceItem(item) && !isWeakExtractionItem(item));
  }

  async function writeItems(items: ExtractedItem[]): Promise<void> {
    const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeAtomic(paths.extractedItems, `${JSON.stringify(sorted, null, 2)}\n`);
    await writeAtomic(paths.extractedItemsMarkdown, renderExtractedMarkdown(sorted));
  }

  async function createDraftCompilation(params: {
    scratch: ScratchSessionNode;
    items: ExtractedItem[];
    summary?: string;
    compilationId: string;
    transcript: TranscriptEntry[];
    createdAt: string;
  }): Promise<DraftCompilation> {
    const chart = await readCanonicalChart();
    const firstTranscriptEntry = params.transcript[0];
    const lastTranscriptEntry = params.transcript.at(-1);
    const basisDraftCompilationIds = chart.draftCompilations
      .filter((compilation) => compilation.status === "draft" || compilation.status === "partially-approved")
      .map((compilation) => compilation.id);
    const compilation: DraftCompilation = {
      id: params.compilationId,
      projectId,
      scratchSessionId: params.scratch.id,
      conversationArtifactId: conversationArtifactIdForScratch(params.scratch.id),
      candidateDeltaIds: params.items.map((item) => item.id),
      extractedItemIds: params.items.map((item) => item.id),
      transcriptStartEntryId: firstTranscriptEntry?.id,
      transcriptEndEntryId: lastTranscriptEntry?.id,
      transcriptEntryCount: params.transcript.length,
      transcriptHash: transcriptHash(params.transcript),
      basisCheckpointId: latestCheckpoint(chart.checkpoints)?.id,
      basisDraftCompilationIds,
      summary: params.summary,
      status: params.items.length === 0
        ? "approved"
        : params.items.every((item) => item.status === "approved")
          ? "approved"
          : params.items.some((item) => item.status === "approved")
            ? "partially-approved"
            : "draft",
      createdAt: params.createdAt,
      updatedAt: params.createdAt
    };
    await writeChartStorage({
      ...chart,
      draftCompilations: [
        compilation,
        ...chart.draftCompilations
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    });
    return compilation;
  }

  async function refreshDraftCompilationStatuses(items: ExtractedItem[], updatedAt = nowIso()): Promise<void> {
    const itemById = new Map(items.map((item) => [item.id, item]));
    let chart = await readCanonicalChart();
    let changed = false;
    const draftCompilations = chart.draftCompilations.map((compilation) => {
      if (compilation.extractedItemIds.length === 0) return compilation;
      const compilationItems = compilation.extractedItemIds.map((id) => itemById.get(id)).filter((item): item is ExtractedItem => Boolean(item));
      if (compilationItems.length !== compilation.extractedItemIds.length) return compilation;
      const approvedCount = compilationItems.filter((item) => item.status === "approved").length;
      const draftCount = compilationItems.filter((item) => item.status === "draft").length;
      const dismissedCount = compilationItems.filter((item) => item.status === "dismissed").length;
      const nextStatus =
        dismissedCount === compilationItems.length
          ? "superseded"
          : approvedCount === compilationItems.length
            ? "approved"
            : approvedCount > 0
              ? "partially-approved"
              : draftCount > 0
                ? "draft"
                : compilation.status;
      if (nextStatus === compilation.status) return compilation;
      changed = true;
      return {
        ...compilation,
        status: nextStatus,
        updatedAt
      };
    });
    if (!changed) return;
    chart = {
      ...chart,
      draftCompilations
    };
    await writeChartStorage(chart);
  }

  async function approveExtractedItems(itemIds: string[], sourceCompilationId?: string): Promise<{ checkpoint?: CanonicalCheckpoint; approvedDeltaIds: string[] }> {
    const selectedIds = new Set(itemIds);
    if (selectedIds.size === 0) return { approvedDeltaIds: [] };

    const current = nowIso();
    const existingItems = await readItems();
    const selectedItems = existingItems.filter((item) => selectedIds.has(item.id) && item.status !== "dismissed");
    if (selectedItems.length === 0) return { approvedDeltaIds: [] };

    const updatedItems = applyLifecycleSideEffects(
      existingItems.map((item) =>
        selectedIds.has(item.id) && item.status !== "dismissed"
          ? withLifecycleDefaults({ ...item, status: "approved" as const, updatedAt: current })
          : item
      ),
      selectedItems.map(withLifecycleDefaults),
      current
    );
    await writeItems(updatedItems);

    let chart = await readCanonicalChart();
    const artifacts = new Map(chart.artifacts.map((artifact) => [artifact.id, artifact]));
    const nextDeltas = [...chart.deltas];
    const approvedDeltaIds: string[] = [];
    const sourceArtifactIds = new Set<string>();
    const checkpointId = canonicalCheckpointId(`${projectId}:approval:${current}:${randomUUID()}`);

    for (const rawItem of selectedItems) {
      const item = withLifecycleDefaults(rawItem);
      if (!shouldCreateCanonicalDelta(item)) continue;
      const stableKey = canonicalStableKey(item);
      const canonicalItemId = canonicalItemIdForExtractedItem(item);
      const previous = latestDeltaForCanonicalItem(nextDeltas, canonicalItemId) ?? latestDeltaForStableKey(nextDeltas, stableKey);
      if (previous && sameCanonicalBody(previous, item)) continue;

      const artifactId = artifacts.has(conversationArtifactIdForScratch(item.scratchSessionId))
        ? conversationArtifactIdForScratch(item.scratchSessionId)
        : importedArtifactId(projectId);
      if (!artifacts.has(artifactId)) {
        artifacts.set(artifactId, {
          id: artifactId,
          projectId,
          title: "Approved project update",
          artifactKind: "import",
          sourceThreadId: item.sourceThreadId,
          scratchSessionId: item.scratchSessionId,
          providerRefIds: [],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        });
      }
      const artifact = artifacts.get(artifactId);
      const providerRefIds = artifact?.providerRefIds ?? [];
      const version = previous ? previous.version + 1 : 1;
      const delta: CanonicalDelta = {
        id: canonicalDeltaId(`${checkpointId}:${item.id}:${version}`),
        projectId,
        stableKey,
        version,
        type: item.type,
        title: item.title,
        body: item.body,
        status: "approved",
        canonicalItemId,
        targetCanonicalItemId: item.targetCanonicalItemId,
        lifecycleAction: item.lifecycleAction ?? "create",
        lifecycleStatusBefore: item.lifecycleStatusBefore,
        lifecycleStatusAfter: lifecycleStatusForItem(item),
        canonicalOperation: item.canonicalOperation,
        mergeStrategy: item.mergeStrategy,
        reconcilesWith: item.reconcilesWith,
        reconciliationReason: item.reconciliationReason,
        conflicts: item.conflicts,
        checkpointId,
        previousDeltaId: previous?.id,
        sourceExtractedItemId: item.id,
        sourceCompilationId,
        conversationArtifactId: artifactId,
        providerRefIds,
        evidenceSource: item.evidenceSource,
        evidenceEntryId: item.transcriptAnchor?.entryId ?? item.sourceTurnId,
        evidenceQuote: item.transcriptAnchor?.quote,
        localPaths: {
          transcript: artifact?.transcriptPath,
          handoff: artifact?.handoffPath,
          eventLog: artifact?.eventLogPath
        },
        approvedAt: current,
        createdAt: current,
        updatedAt: current
      };
      if (previous) {
        const previousIndex = nextDeltas.findIndex((candidate) => candidate.id === previous.id);
        if (previousIndex >= 0) nextDeltas[previousIndex] = { ...nextDeltas[previousIndex], status: "superseded", updatedAt: current };
      }
      if (item.targetCanonicalItemId && item.targetCanonicalItemId !== canonicalItemId) {
        const targetPrevious = latestDeltaForCanonicalItem(nextDeltas, item.targetCanonicalItemId);
        if (targetPrevious) {
          const targetPreviousIndex = nextDeltas.findIndex((candidate) => candidate.id === targetPrevious.id);
          if (targetPreviousIndex >= 0) nextDeltas[targetPreviousIndex] = { ...nextDeltas[targetPreviousIndex], status: "superseded", updatedAt: current };
        }
      }
      nextDeltas.push(delta);
      approvedDeltaIds.push(delta.id);
      sourceArtifactIds.add(artifactId);
    }

    let checkpoint: CanonicalCheckpoint | undefined;
    if (approvedDeltaIds.length > 0) {
      checkpoint = {
        id: checkpointId,
        projectId,
        title: `Approved ${approvedDeltaIds.length} canonical ${approvedDeltaIds.length === 1 ? "delta" : "deltas"}`,
        parentCheckpointId: latestCheckpoint(chart.checkpoints)?.id,
        approvedDeltaIds,
        sourceArtifactIds: [...sourceArtifactIds],
        createdAt: current,
        approvedAt: current,
        imported: false
      };
    }

    const draftCompilations = chart.draftCompilations.map((compilation) => {
      if (sourceCompilationId && compilation.id !== sourceCompilationId) return compilation;
      if (!sourceCompilationId && !compilation.extractedItemIds.some((id) => selectedIds.has(id))) return compilation;
      const compilationItemIds = new Set(compilation.extractedItemIds);
      const approvedInCompilation = updatedItems.filter((item) => compilationItemIds.has(item.id) && item.status === "approved").length;
      return {
        ...compilation,
        status: approvedInCompilation >= compilation.extractedItemIds.length ? "approved" as const : "partially-approved" as const,
        updatedAt: current
      };
    });

    chart = {
      ...chart,
      checkpoints: checkpoint ? [...chart.checkpoints, checkpoint] : chart.checkpoints,
      deltas: nextDeltas,
      draftCompilations,
      artifacts: [...artifacts.values()]
    };
    await writeChartStorage(chart);
    await rebuildProduction();
    return { checkpoint, approvedDeltaIds };
  }

  async function projectChartResponse(runtimeContext?: RuntimeContextRestore): Promise<ProjectChartResponse> {
    const chart = await readCanonicalChart(runtimeContext);
    const status = await codexProviderAdapter.status();
    const providerRefs = chart.providerRefs.map((ref) =>
      ref.provider === "codex" && status.accountId && !ref.accountId
        ? { ...ref, accountId: status.accountId }
        : ref
    );
    return {
      projectDir,
      chartPath: paths.chart,
      project: await readProject(),
      sourceThreads: await readSources(),
      sourceCheckpoints: await readCheckpoints(),
      checkpoints: sortedCheckpoints(chart.checkpoints),
      canonicalItems: [...chart.canonicalItems].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
      deltas: [...chart.deltas].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt)),
      draftCompilations: [...chart.draftCompilations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      artifacts: [...chart.artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      providerRefs,
      providerAdapters: [status]
    };
  }

  async function writeProduction(production: ProductionChart): Promise<void> {
    await writeAtomic(paths.production, `${JSON.stringify(production, null, 2)}\n`);
    await writeAtomic(paths.productionMarkdown, renderProductionMarkdown(production));
  }

  async function writeSourceNode(source: SourceThreadNode): Promise<void> {
    await writeAtomic(sourcePath(projectDir, source.id), `${JSON.stringify(source, null, 2)}\n`);
  }

  async function readCheckpoint(id: string): Promise<SourceCheckpointNode | null> {
    return readJson<SourceCheckpointNode | null>(checkpointPath(projectDir, id), null);
  }

  async function writeCheckpointNode(checkpoint: SourceCheckpointNode): Promise<void> {
    await writeAtomic(checkpointPath(projectDir, checkpoint.id), `${JSON.stringify(checkpoint, null, 2)}\n`);
  }

  async function ensureInitialCheckpoint(source: SourceThreadNode): Promise<SourceCheckpointNode> {
    const id = initialCheckpointId(source.id);
    const existing = await readCheckpoint(id);
    const current = nowIso();
    const checkpoint: SourceCheckpointNode = {
      id,
      projectId,
      sourceThreadId: source.id,
      codexThreadId: source.codexThreadId,
      sourceUri: source.sourceUri,
      title: existing?.title ?? sourceCheckpointTitle(source),
      createdAt: existing?.createdAt ?? source.firstSeenAt ?? current,
      observedAt: existing?.observedAt ?? source.firstSeenAt ?? current,
      lastSeenAt: current,
      detectionSource: existing?.detectionSource ?? "initial",
      contextFingerprint: existing?.contextFingerprint,
      childrenScratchSessionIds: existing?.childrenScratchSessionIds ?? []
    };
    await writeCheckpointNode(checkpoint);
    await writeSourceNode({
      ...source,
      childrenCheckpointIds: Array.from(new Set([...(source.childrenCheckpointIds ?? []), id])),
      childrenScratchSessionIds: source.childrenScratchSessionIds ?? []
    });
    return checkpoint;
  }

  async function checkpointForScratch(source: SourceThreadNode, existing?: ScratchSessionNode | null): Promise<SourceCheckpointNode> {
    if (existing?.sourceCheckpointId) {
      const checkpoint = await readCheckpoint(existing.sourceCheckpointId);
      if (checkpoint && checkpoint.sourceThreadId === source.id) return checkpoint;
    }

    const project = await readProject();
    if (project.activeSourceCheckpointId) {
      const checkpoint = await readCheckpoint(project.activeSourceCheckpointId);
      if (checkpoint && checkpoint.sourceThreadId === source.id) return checkpoint;
    }

    const checkpoints = (await readCheckpoints()).filter((checkpoint) => checkpoint.sourceThreadId === source.id);
    const latest = checkpoints.at(-1);
    return latest ?? ensureInitialCheckpoint(source);
  }

  async function attachScratchToCheckpoint(source: SourceThreadNode, checkpoint: SourceCheckpointNode, scratchId: string): Promise<void> {
    const current = nowIso();
    await writeCheckpointNode({
      ...checkpoint,
      lastSeenAt: current,
      childrenScratchSessionIds: Array.from(new Set([...(checkpoint.childrenScratchSessionIds ?? []), scratchId]))
    });
    const latestSource = await readJson<SourceThreadNode | null>(sourcePath(projectDir, source.id), null);
    await writeSourceNode({
      ...(latestSource ?? source),
      childrenCheckpointIds: Array.from(new Set([...(latestSource?.childrenCheckpointIds ?? source.childrenCheckpointIds ?? []), checkpoint.id])),
      childrenScratchSessionIds: Array.from(new Set([...(latestSource?.childrenScratchSessionIds ?? source.childrenScratchSessionIds ?? []), scratchId]))
    });
  }

  async function ensureCheckpointCoverage(): Promise<void> {
    const sources = await readSources();
    const sessions = await readSessions();
    for (const source of sources) {
      const initial = await ensureInitialCheckpoint(source);
      const checkpointIds = new Set((await readCheckpoints()).map((checkpoint) => checkpoint.id));
      for (const session of sessions.filter((candidate) => candidate.sourceThreadId === source.id)) {
        const assignedCheckpointId = session.sourceCheckpointId && checkpointIds.has(session.sourceCheckpointId)
          ? session.sourceCheckpointId
          : initial.id;
        const checkpoint = await readCheckpoint(assignedCheckpointId) ?? initial;
        if (session.sourceCheckpointId !== assignedCheckpointId) {
          await writeAtomic(
            path.join(sessionDir(projectDir, session.id), "session.json"),
            `${JSON.stringify({ ...session, sourceCheckpointId: assignedCheckpointId }, null, 2)}\n`
          );
        }
        await attachScratchToCheckpoint(source, checkpoint, session.id);
      }
    }
  }

  async function setPendingContinuationFromHandoff(session: MorticSession, scratch: ScratchSessionNode): Promise<void> {
    const handoffHash = handoffHashForSession(session);
    if (!handoffHash || !scratch.sourceCheckpointId) return;
    const project = await readProject();
    if (
      project.pendingSourceCheckpoint?.sourceCheckpointId === scratch.sourceCheckpointId &&
      project.pendingSourceCheckpoint.derivedFromHandoffHash === handoffHash
    ) {
      return;
    }
    const existingChild = (await readCheckpoints()).find((checkpoint) =>
      checkpoint.parentCheckpointId === scratch.sourceCheckpointId &&
      checkpoint.derivedFromHandoffHash === handoffHash
    );
    if (existingChild) {
      await writeProject({
        ...project,
        activeSourceThreadId: scratch.sourceThreadId,
        activeSourceCheckpointId: existingChild.id,
        pendingSourceCheckpoint: undefined
      });
      return;
    }
    const current = nowIso();
    await writeProject({
      ...project,
      pendingSourceCheckpoint: {
        sourceThreadId: scratch.sourceThreadId,
        sourceCheckpointId: scratch.sourceCheckpointId,
        derivedFromScratchSessionId: scratch.id,
        derivedFromHandoffHash: handoffHash,
        title: `After handoff from ${scratch.title}`,
        createdAt: current,
        updatedAt: current,
        reason: "A handoff was generated from this checkpoint. If you paste it back into the same Codex thread and continue there, create a child checkpoint before the next Mortic scratch."
      }
    });
  }

  async function upsertSource(session: MorticSession): Promise<SourceThreadNode> {
    const id = sourceThreadId(session.threadId);
    const existing = await readJson<SourceThreadNode | null>(sourcePath(projectDir, id), null);
    const current = nowIso();
    const next: SourceThreadNode = {
      id,
      projectId,
      codexThreadId: session.threadId,
      title: existing?.title ?? sourceTitle(session.threadId),
      description: existing?.description,
      workspacePath,
      sourceUri: session.sourceUri,
      createdAt: existing?.createdAt ?? current,
      firstSeenAt: existing?.firstSeenAt ?? current,
      lastSeenAt: current,
      knownTextPreview: existing?.knownTextPreview,
      knownSummary: existing?.knownSummary,
      tags: existing?.tags ?? [],
      childrenCheckpointIds: existing?.childrenCheckpointIds ?? [],
      childrenScratchSessionIds: Array.from(new Set([...(existing?.childrenScratchSessionIds ?? []), scratchSessionId(session)]))
    };
    await writeSourceNode(next);

    const project = await readProject();
    await writeProject({
      ...project,
      activeSourceThreadId: id,
      canonicalSourceThreadIds: Array.from(new Set([...project.canonicalSourceThreadIds, id]))
    });
    return next;
  }

  async function upsertScratch(session: MorticSession): Promise<ScratchSessionNode> {
    const source = await upsertSource(session);
    const id = scratchSessionId(session);
    const dir = sessionDir(projectDir, id);
    const filePath = path.join(dir, "session.json");
    const existing = await readJson<ScratchSessionNode | null>(filePath, null);
    const checkpoint = await checkpointForScratch(source, existing);
    const current = nowIso();
    const codexScratchThreadId = session.forkCheckpoint?.scratchThreadId ?? existing?.codexScratchThreadId;
    const next: ScratchSessionNode = {
      id,
      projectId,
      sourceThreadId: source.id,
      sourceCheckpointId: existing?.sourceCheckpointId ?? checkpoint.id,
      parentScratchSessionId: existing?.parentScratchSessionId,
      codexScratchThreadId,
      forkedFromId: session.forkCheckpoint?.sourceThreadId ?? existing?.forkedFromId,
      ephemeral: Boolean(codexScratchThreadId) || existing?.ephemeral === true,
      title: existing?.title ?? sessionTitle(session),
      description: existing?.description,
      summary: existing?.summary,
      mode: existing?.mode ?? "scratch",
      status: existing?.status === "committed" || existing?.status === "archived" || existing?.status === "discarded" ? existing.status : "active",
      workspacePath,
      model: session.activeTurn?.codexModel ?? existing?.model,
      provider: existing?.provider,
      transport: session.activeTurn?.metrics.transportProvider ?? existing?.transport,
      sttProvider: session.activeTurn?.metrics.sttProvider ?? existing?.sttProvider,
      ttsProvider: session.activeTurn?.metrics.ttsProvider ?? existing?.ttsProvider,
      createdAt: existing?.createdAt ?? session.createdAt,
      updatedAt: current,
      archivedAt: existing?.archivedAt,
      committedAt: existing?.committedAt,
      transcriptPath: path.join(dir, "transcript.md"),
      eventLogPath: path.join(dir, "events.jsonl"),
      handoffPath: path.join(dir, "handoff.md"),
      handoffShortPath: path.join(dir, "handoff.short.md"),
      handoffFullPath: path.join(dir, "handoff.full.md"),
      extractedItemsPath: path.join(dir, "extracted_items.json"),
      tags: existing?.tags ?? []
    };
    await mkdir(dir, { recursive: true });
    await writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
    await writeAtomic(next.transcriptPath, transcriptMarkdown(session));
    await writeAtomic(next.handoffPath, session.handoff ?? "");
    await writeAtomic(next.handoffShortPath, session.handoffShort ?? "");
    await writeAtomic(next.handoffFullPath, session.handoffFull ?? "");
    await attachScratchToCheckpoint(source, checkpoint, id);

    const project = await readProject();
    await writeProject({
      ...project,
      activeSourceThreadId: source.id,
      activeSourceCheckpointId: checkpoint.id,
      activeScratchSessionId: id
    });
    return next;
  }

  async function recordEvent(session: MorticSession, event: ProjectEvent): Promise<void> {
    const scratch = await upsertScratch(session);
    const line = JSON.stringify({
      at: event.at ?? nowIso(),
      type: event.type,
      detail: event.detail
    });
    await mkdir(path.dirname(scratch.eventLogPath), { recursive: true });
    await appendFile(scratch.eventLogPath, `${line}\n`, "utf8");
    if (event.type === "handoff.generated" || event.type === "handoff.copied") {
      await setPendingContinuationFromHandoff(session, scratch);
    }
  }

  async function syncSession(session: MorticSession, event?: ProjectEvent): Promise<void> {
    await upsertScratch(session);
    if (event) await recordEvent(session, event);
  }

  async function rebuildProduction(currentSession?: MorticSession): Promise<{ production: ProductionChart; scratch?: ScratchSessionNode }> {
    await ensureCheckpointCoverage();
    const project = await readProject();
    const sources = await readSources();
    const sessions = await readSessions();
    const previous = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const items = await readItems();
    const production = productionFrom({ project, sources, sessions, items, previous });
    await writeProduction(production);
    const scratch = currentSession ? await upsertScratch(currentSession) : undefined;
    return { production, scratch };
  }

  async function snapshot(session?: MorticSession): Promise<ProjectStateResponse> {
    if (session) await upsertScratch(session);
    await ensureCheckpointCoverage();
    const project = await readProject();
    const sources = await readSources();
    const checkpoints = await readCheckpoints();
    const sessions = await readSessions();
    const items = await readItems();
    const previous = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const production = productionFrom({ project, sources, sessions, items, previous });
    await writeProduction(production);
    const activeScratch =
      session ? await upsertScratch(session) : sessions.find((candidate) => candidate.id === project.activeScratchSessionId) ?? sessions[0];
    const readiness = activeScratch && session
      ? computeReadiness(session, activeScratch, items.filter((item) => item.scratchSessionId === activeScratch.id))
      : {
          percentage: 0,
          status: "needs-review" as const,
          missing: ["active scratch session"],
          signals: {
            hasUserGoal: false,
            hasSourceThreadId: false,
            hasSessionTitle: false,
            hasSessionDescription: false,
            hasUsefulSummary: false,
            hasExtraction: false,
            hasShortHandoff: false,
            hasFullHandoff: false,
            hasRiskOrQuestionState: false,
            transcriptNotEmpty: false,
            noActiveTurnRunning: true,
            noForkSafetyWarning: true
          }
        };
    return {
      project: await readProject(),
      sourceThreads: await readSources(),
      sourceCheckpoints: checkpoints,
      scratchSessions: await readSessions(),
      extractedItems: await readItems(),
      production,
      readiness
    };
  }

  async function canonicalState(): Promise<ProjectCanonicalStateResponse> {
    await ensureCheckpointCoverage();
    const project = await readProject();
    const sources = await readSources();
    const checkpoints = await readCheckpoints();
    const sessions = await readSessions();
    const items = await readItems();
    const previous = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const production = productionFrom({ project, sources, sessions, items, previous });
    await writeProduction(production);
    await writeItems(items);
    return {
      projectDir,
      productionPath: paths.production,
      productionMarkdownPath: paths.productionMarkdown,
      extractedItemsPath: paths.extractedItems,
      extractedItemsMarkdownPath: paths.extractedItemsMarkdown,
      project: await readProject(),
      sourceThreads: await readSources(),
      sourceCheckpoints: checkpoints,
      scratchSessions: await readSessions(),
      extractedItems: await readItems(),
      production,
      productionMarkdown: await readFile(paths.productionMarkdown, "utf8"),
      extractedItemsMarkdown: await readFile(paths.extractedItemsMarkdown, "utf8")
    };
  }

  async function chart(runtimeContext?: RuntimeContextRestore): Promise<ProjectChartResponse> {
    await ensureCheckpointCoverage();
    return projectChartResponse(runtimeContext);
  }

  async function artifactPreview(id: string, runtimeContext?: RuntimeContextRestore): Promise<ProjectArtifactPreviewResponse | null> {
    const response = await projectChartResponse(runtimeContext);
    const artifact = response.artifacts.find((candidate) => candidate.id === id);
    if (!artifact) return null;
    const providerRefIds = new Set(artifact.providerRefIds);
    return {
      artifact,
      providerRefs: response.providerRefs.filter((ref) => providerRefIds.has(ref.id)),
      transcriptPreview: await previewFile(artifact.transcriptPath),
      handoffPreview: await previewFile(artifact.handoffPath, 16_000),
      eventPreview: await previewFile(artifact.eventLogPath, 16_000),
      paths: {
        transcript: artifact.transcriptPath,
        handoff: artifact.handoffPath,
        eventLog: artifact.eventLogPath
      }
    };
  }

  async function approveCompilation(id: string, request?: ApproveCompilationRequest, runtimeContext?: RuntimeContextRestore): Promise<ApproveCompilationResponse> {
    const chartFile = await readCanonicalChart(runtimeContext);
    const compilation = chartFile.draftCompilations.find((candidate) => candidate.id === id);
    if (!compilation) {
      throw new Error(`Draft compilation not found: ${id}`);
    }
    const requestedIds = unique([
      ...(request?.extractedItemIds ?? []),
      ...(request?.candidateDeltaIds ?? [])
    ]);
    const compilationSelectableIds = new Set([
      ...compilation.extractedItemIds,
      ...compilation.candidateDeltaIds
    ]);
    const invalidIds = requestedIds.filter((itemId) => !compilationSelectableIds.has(itemId));
    if (invalidIds.length > 0) {
      throw new Error(`Invalid selected item(s) for compilation ${id}: ${invalidIds.join(", ")}`);
    }
    const idsToApprove = requestedIds.length > 0 ? requestedIds : compilation.extractedItemIds;
    const approval = await approveExtractedItems(idsToApprove, id);
    return {
      ...(await projectChartResponse(runtimeContext)),
      projectState: await snapshot(),
      checkpoint: approval.checkpoint,
      approvedDeltaIds: approval.approvedDeltaIds
    };
  }

  async function commitSession(session: MorticSession, approveItemIds?: string[]): Promise<CommitSessionResponse> {
    const source = await upsertSource(session);
    const scratch = await upsertScratch(session);
    const approveSet = new Set(approveItemIds ?? []);
    const compilationCreatedAt = nowIso();
    const compilationId = draftCompilationIdForScratch(scratch.id, compilationCreatedAt);
    const existingItems = await readItems();
    const chartBeforeCompilation = await readCanonicalChart();
    const transcriptForCompilation = transcriptAfterLatestCompilation(session.transcript, chartBeforeCompilation.draftCompilations, scratch.id);
    const scopedSession: MorticSession = {
      ...session,
      transcript: transcriptForCompilation,
      updatedAt: transcriptForCompilation.at(-1)?.createdAt ?? session.updatedAt
    };
    const project = await readProject();
    const sources = await readSources();
    const sessions = await readSessions();
    const previousProduction = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const production = productionFrom({ project, sources, sessions, items: existingItems, previous: previousProduction });
    const extraction = transcriptForCompilation.length > 0
      ? await extractItemsWithCanonicalStateSkill({
        projectId,
        sourceThreadId: source.id,
        scratchSessionId: scratch.id,
        session: scopedSession,
        production,
        existing: existingItems,
        approveItemIds: approveSet,
        hash,
        nowIso
      })
      : {
        items: [] as ExtractedItem[],
        summary: "No new transcript entries since the last compilation."
      };
    const generatedItemIds = new Map(extraction.items.map((item) => [item.id, compileScopedItemId(item.id, compilationId)]));
    const generated = extraction.items.map((item) => {
      const scopedId = generatedItemIds.get(item.id) ?? compileScopedItemId(item.id, compilationId);
      return {
        ...item,
        id: scopedId,
        sourceCompilationId: compilationId,
        canonicalItemId: item.canonicalItemId ?? item.id,
        mergedIntoId: item.mergedIntoId
          ? generatedItemIds.get(item.mergedIntoId) ?? item.mergedIntoId
          : item.mergedIntoId
      };
    });
    const reconciled = reconcileGeneratedWithPendingDrafts(existingItems, generated, compilationCreatedAt);
    const finalGenerated = reconciled.generated;
    const items = [...reconciled.items, ...finalGenerated];
    const compilationSummary = finalGenerated.length > 0
      ? extraction.summary
      : reconciled.mergedIds.length > 0
        ? "Updated existing pending canonical drafts."
        : "No new canonical candidates since the last compilation.";
    await writeItems(items);
    await writeAtomic(
      scratch.extractedItemsPath,
      `${JSON.stringify(items.filter((item) => item.scratchSessionId === scratch.id), null, 2)}\n`
    );

    const committedAt = nowIso();
    const committedSession: ScratchSessionNode = {
      ...scratch,
      status: "committed",
      summary: compilationSummary,
      committedAt,
      updatedAt: committedAt
    };
    await writeAtomic(path.join(sessionDir(projectDir, scratch.id), "session.json"), `${JSON.stringify(committedSession, null, 2)}\n`);
    const compilation = transcriptForCompilation.length > 0
      ? await createDraftCompilation({
        scratch: committedSession,
        items: finalGenerated,
        summary: compilationSummary,
        compilationId,
        transcript: transcriptForCompilation,
        createdAt: compilationCreatedAt
      })
      : undefined;
    const approvedGeneratedIds = finalGenerated.filter((item) => item.status === "approved").map((item) => item.id);
    if (approvedGeneratedIds.length > 0 && compilation) {
      await approveExtractedItems(approvedGeneratedIds, compilation.id);
    }
    const existingApprovalIds = [...approveSet].filter((id) => existingItems.some((item) => item.id === id));
    if (existingApprovalIds.length > 0) {
      await approveExtractedItems(existingApprovalIds);
    }
    await recordEvent(session, {
      type: "session.committed",
      detail: {
        scratchSessionId: scratch.id,
        createdItems: finalGenerated.length,
        approvedItems: finalGenerated.filter((item) => item.status === "approved").length,
        mergedIntoPendingItems: reconciled.mergedIds.length
      }
    });
    await rebuildProduction(session);
    return {
      ...(await snapshot(session)),
      committedSession,
      createdItems: finalGenerated
    };
  }

  async function archiveSession(session: MorticSession): Promise<ProjectStateResponse> {
    const scratch = await upsertScratch(session);
    const archivedAt = nowIso();
    await writeAtomic(
      path.join(sessionDir(projectDir, scratch.id), "session.json"),
      `${JSON.stringify({ ...scratch, status: "archived", archivedAt, updatedAt: archivedAt }, null, 2)}\n`
    );
    await recordEvent(session, { type: "session.archived", detail: { scratchSessionId: scratch.id } });
    await rebuildProduction(session);
    return snapshot(session);
  }

  async function updateExtractedItem(id: string, patch: UpdateExtractedItemRequest): Promise<ProjectStateResponse> {
    const items = await readItems();
    const approving = patch.status === "approved";
    const retiring = patch.retire === true;
    const current = nowIso();
    const sourceItem = items.find((item) => item.id === id);
    const title = patch.title?.trim();
    const body = patch.body?.trim();
    const contentChanged = Boolean(
      sourceItem &&
      ((title !== undefined && title !== "" && title !== sourceItem.title) ||
        (body !== undefined && body !== "" && body !== sourceItem.body))
    );
    const approvedCorrection = Boolean(sourceItem?.status === "approved" && (contentChanged || retiring));
    const nextItems = items.map((item) => {
      if (item.id !== id) return item;
      const nextTitle = title || item.title;
      const nextBody = body || item.body;
      return {
        ...item,
        title: nextTitle,
        body: nextBody,
        status: approving || retiring || approvedCorrection ? "approved" as const : patch.status ?? item.status,
        mergedIntoId: patch.mergeIntoId ?? item.mergedIntoId,
        lifecycleAction: retiring
          ? "drop" as const
          : approvedCorrection && (!item.lifecycleAction || item.lifecycleAction === "create")
            ? "update" as const
            : item.lifecycleAction,
        lifecycleStatusBefore: retiring ? item.lifecycleStatusAfter ?? "open" : item.lifecycleStatusBefore,
        lifecycleStatusAfter: retiring ? "dropped" as const : item.lifecycleStatusAfter,
        canonicalOperation: retiring ? "drop" : approvedCorrection ? item.canonicalOperation ?? "update" : item.canonicalOperation,
        updatedAt: current
      };
    });
    await writeItems(nextItems);
    await refreshDraftCompilationStatuses(nextItems);
    if (approving || approvedCorrection || retiring) {
      await approveExtractedItems([id]);
    } else {
      await rebuildProduction();
    }
    return snapshot();
  }

  async function confirmSourceCheckpoint(): Promise<ProjectStateResponse> {
    const project = await readProject();
    const pending = project.pendingSourceCheckpoint;
    if (!pending) return snapshot();
    const source = (await readSources()).find((candidate) => candidate.id === pending.sourceThreadId);
    const parent = await readCheckpoint(pending.sourceCheckpointId);
    if (!source || !parent) {
      await writeProject({ ...project, pendingSourceCheckpoint: undefined });
      return snapshot();
    }
    const id = childCheckpointId(source.id, parent.id, pending.derivedFromHandoffHash);
    const existing = await readCheckpoint(id);
    const current = nowIso();
    const checkpoint: SourceCheckpointNode = existing ?? {
      id,
      projectId,
      sourceThreadId: source.id,
      codexThreadId: source.codexThreadId,
      sourceUri: source.sourceUri,
      parentCheckpointId: parent.id,
      derivedFromScratchSessionId: pending.derivedFromScratchSessionId,
      derivedFromHandoffHash: pending.derivedFromHandoffHash,
      title: pending.title,
      createdAt: current,
      observedAt: current,
      lastSeenAt: current,
      detectionSource: "handoff-marker",
      childrenScratchSessionIds: []
    };
    await writeCheckpointNode({ ...checkpoint, lastSeenAt: current });
    await writeSourceNode({
      ...source,
      childrenCheckpointIds: Array.from(new Set([...(source.childrenCheckpointIds ?? []), id]))
    });
    await writeProject({
      ...project,
      activeSourceThreadId: source.id,
      activeSourceCheckpointId: id,
      pendingSourceCheckpoint: undefined
    });
    return snapshot();
  }

  async function dismissSourceCheckpoint(): Promise<ProjectStateResponse> {
    const project = await readProject();
    if (!project.pendingSourceCheckpoint) return snapshot();
    await writeProject({
      ...project,
      pendingSourceCheckpoint: undefined
    });
    return snapshot();
  }

  async function createManualSourceCheckpoint(session: MorticSession): Promise<ProjectStateResponse> {
    const source = await upsertSource(session);
    const parent = await checkpointForScratch(source, null);
    const checkpoints = (await readCheckpoints()).filter((checkpoint) => checkpoint.sourceThreadId === source.id);
    const id = manualCheckpointId(source.id);
    const current = nowIso();
    const checkpoint: SourceCheckpointNode = {
      id,
      projectId,
      sourceThreadId: source.id,
      codexThreadId: source.codexThreadId,
      sourceUri: source.sourceUri,
      parentCheckpointId: parent.id,
      title: sourceCheckpointTitle(source, checkpoints.length + 1),
      createdAt: current,
      observedAt: current,
      lastSeenAt: current,
      detectionSource: "manual",
      childrenScratchSessionIds: []
    };
    await writeCheckpointNode(checkpoint);
    await writeSourceNode({
      ...source,
      childrenCheckpointIds: Array.from(new Set([...(source.childrenCheckpointIds ?? []), id]))
    });
    const project = await readProject();
    await writeProject({
      ...project,
      activeSourceThreadId: source.id,
      activeSourceCheckpointId: id,
      pendingSourceCheckpoint: undefined
    });
    return snapshot();
  }

  async function markHandoffCopied(session: MorticSession): Promise<ProjectStateResponse> {
    const scratch = await upsertScratch(session);
    await recordEvent(session, { type: "handoff.copied", detail: { scratchSessionId: scratch.id } });
    return snapshot(session);
  }

  const initialProject = await readProject();
  await writeProject(initialProject);
  await readCanonicalChart();

  return {
    projectDir,
    syncSession: (session, event) => enqueue(() => syncSession(session, event)),
    recordEvent: (session, event) => enqueue(() => recordEvent(session, event)),
    snapshot: (session) => enqueue(() => snapshot(session)),
    canonicalState: () => enqueue(() => canonicalState()),
    chart: (runtimeContext) => enqueue(() => chart(runtimeContext)),
    artifactPreview: (id, runtimeContext) => enqueue(() => artifactPreview(id, runtimeContext)),
    approveCompilation: (id, request, runtimeContext) => enqueue(() => approveCompilation(id, request, runtimeContext)),
    commitSession: (session, approveItemIds) => enqueue(() => commitSession(session, approveItemIds)),
    archiveSession: (session) => enqueue(() => archiveSession(session)),
    updateExtractedItem: (id, patch) => enqueue(() => updateExtractedItem(id, patch)),
    confirmSourceCheckpoint: () => enqueue(() => confirmSourceCheckpoint()),
    dismissSourceCheckpoint: () => enqueue(() => dismissSourceCheckpoint()),
    createManualSourceCheckpoint: (session) => enqueue(() => createManualSourceCheckpoint(session)),
    markHandoffCopied: (session) => enqueue(() => markHandoffCopied(session))
  };
}
