import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ApproveCompilationRequest,
  ApproveCompilationResponse,
  BoundaryAnchor,
  BoundaryStatus,
  CanonicalCheckpoint,
  CanonicalDelta,
  CanonicalItem,
  CanonicalLifecycleAction,
  CanonicalLifecycleStatus,
  CompilationSourceWindow,
  CompilePlan,
  ConversationArtifact,
  CommitSessionResponse,
  CoverageReceipt,
  DraftCompilation,
  DraftCompilationImportRequest,
  DraftCompilationImportResponse,
  ExtractedItem,
  ExtractedItemType,
  HandoffReadiness,
  MorticProject,
  MorticSession,
  ProjectArtifactPreviewResponse,
  ProjectChartResponse,
  ProviderForkContinuation,
  ProviderForkRecord,
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
import { canonicalLifecycleActions, canonicalLifecycleStatuses, extractedItemTypes } from "../shared/types.js";
import { extractItemsWithCanonicalStateSkill } from "./canonicalStateSkill.js";
import { codexProviderAdapter } from "./providerAdapters.js";
import { matchCommitsToItems, readRecentCommits } from "./projectStorage/codeReconcile.js";
import { CanonicalChartFile, canonicalExtractionTypes, emptyChartFile, hash, nowIso, unique } from "./projectStorage/common.js";
import { canonicalStableKey, compileScopedItemId, normalizeSourceWindows, sourceWindowsForScratchCompilation, syntheticCoverageReceipt, transcriptAfterLatestCompilation, transcriptHash } from "./projectStorage/coverage.js";
import { isWeakExtractionItem, isWorkflowGuidanceItem } from "./projectStorage/extraction.js";
import { previewFile, readJson, serializeOperations, writeAtomic } from "./projectStorage/fsio.js";
import { canonicalCheckpointId, canonicalDeltaId, checkpointPath, childCheckpointId, conversationArtifactIdForScratch, coverageReceiptIdForCompilation, coverageReceiptIdForImport, draftCompilationIdForImport, draftCompilationIdForScratch, importedArtifactId, importedProviderRefId, importedScratchSessionId, initialCheckpointId, manualCheckpointId, projectBaseDir, projectIdForWorkspace, projectPaths, scratchSessionId, sessionDir, sourcePath, sourceThreadId } from "./projectStorage/ids.js";
import { aggregateBoundaryStatus, cleanImportedBody, cleanImportedTitle, cleanTaskPlanMarkdown, defaultBoundaryReason, defaultBoundaryStatus, defaultImportedLifecycleStatus, importRequestFingerprint, importedCandidateType, importedDeltaValue, importedLifecycleAction, importedLifecycleStatus, importedLifecycleStatusBefore } from "./projectStorage/importNormalize.js";
import { applyLifecycleSideEffects, canonicalItemIdForExtractedItem, isPendingDraftItem, itemMatchesAnyId, latestCheckpoint, latestDeltaForCanonicalItem, latestDeltaForStableKey, lifecycleStatusForItem, reconcileGeneratedWithPendingDrafts, sameCanonicalBody, shouldCreateCanonicalDelta, sortedCheckpoints, withCanonicalItems, withLifecycleDefaults } from "./projectStorage/lifecycle.js";
import { handoffHashForSession, productionFrom, renderExtractedMarkdown, renderProductionMarkdown, sessionTitle, sourceCheckpointTitle, sourceTitle, transcriptMarkdown } from "./projectStorage/markdown.js";

export { projectDirForWorkspace } from "./projectStorage/ids.js";

export type ProjectStore = {
  projectDir: string;
  syncSession(session: MorticSession, event?: ProjectEvent): Promise<void>;
  recordEvent(session: MorticSession, event: ProjectEvent): Promise<void>;
  snapshot(session?: MorticSession): Promise<ProjectStateResponse>;
  canonicalState(): Promise<ProjectCanonicalStateResponse>;
  chart(runtimeContext?: RuntimeContextRestore): Promise<ProjectChartResponse>;
  artifactPreview(id: string, runtimeContext?: RuntimeContextRestore): Promise<ProjectArtifactPreviewResponse | null>;
  importDraftCompilation(request: DraftCompilationImportRequest, session?: MorticSession, runtimeContext?: RuntimeContextRestore): Promise<DraftCompilationImportResponse>;
  approveCompilation(id: string, request?: ApproveCompilationRequest, runtimeContext?: RuntimeContextRestore): Promise<ApproveCompilationResponse>;
  commitSession(session: MorticSession, approveItemIds?: string[]): Promise<CommitSessionResponse>;
  archiveSession(session: MorticSession): Promise<ProjectStateResponse>;
  updateExtractedItem(id: string, patch: UpdateExtractedItemRequest): Promise<ProjectStateResponse>;
  setProviderForkAccess(providerRefId: string, requestedAccessPreset: ProviderForkContinuation, runtimeContext?: RuntimeContextRestore): Promise<ProviderForkRecord[]>;
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

const codeReconcileDraftLimit = 3;

function codeReconcileTitle(itemTitle: string): string {
  const full = `Code suggests resolved: ${itemTitle}`.replace(/\s+/g, " ").trim();
  if (full.length <= 72) return full;
  const words = full.split(" ");
  let compact = "";
  for (const word of words) {
    const candidate = compact ? `${compact} ${word}` : word;
    if (candidate.length > 72) break;
    compact = candidate;
  }
  return (compact || full.slice(0, 72)).replace(/[,:;.-]\s*$/, "");
}

// Compile-time reconciliation against the workspace git history (read-only):
// when a recent commit subject overlaps an open canonical task/risk/backlog
// title, propose a review-only "looks done" resolution draft. The drafts are
// never auto-approved; a human resolves the canonical item in the UI.
async function codeReconcileDraftItems(params: {
  projectId: string;
  sourceThreadId: string;
  scratchSessionId: string;
  workspacePath: string;
  canonicalItems: CanonicalItem[];
  existingItems: ExtractedItem[];
  extractionItems: ExtractedItem[];
}): Promise<ExtractedItem[]> {
  const openItems = params.canonicalItems.filter((item) =>
    (item.type === "task" || item.type === "risk" || item.type === "backlog") &&
    (item.lifecycleStatus === "open" || item.lifecycleStatus === "in_progress")
  );
  if (openItems.length === 0) return [];
  const sinceIso = openItems
    .map((item) => item.createdAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const commits = await readRecentCommits(params.workspacePath, sinceIso, 50);
  if (commits.length === 0) return [];
  const pendingDrafts = params.existingItems.filter(isPendingDraftItem);
  // Any prior non-approved code_state suggestion (pending draft, dismissed,
  // merged) blocks re-proposing the same canonical item: a reviewer's "no"
  // must not resurrect on the next compile.
  const alreadyCovered = (canonicalItemId: string): boolean =>
    params.extractionItems.some((item) => itemMatchesAnyId(item, canonicalItemId)) ||
    pendingDrafts.some((item) => itemMatchesAnyId(item, canonicalItemId)) ||
    params.existingItems.some((item) =>
      item.evidenceSource === "code_state" && item.status !== "approved" && itemMatchesAnyId(item, canonicalItemId)
    );
  const createdAt = nowIso();
  return matchCommitsToItems(openItems, commits)
    .filter((match) => !alreadyCovered(match.item.id))
    .sort((left, right) => right.score - left.score)
    .slice(0, codeReconcileDraftLimit)
    .map(({ item, commit }) => {
      const shortHash = commit.hash.slice(0, 7);
      return {
        id: `item-${hash(`${params.scratchSessionId}:code-reconcile:${item.id}`, 18)}`,
        projectId: params.projectId,
        sourceThreadId: params.sourceThreadId,
        scratchSessionId: params.scratchSessionId,
        type: item.type,
        title: codeReconcileTitle(item.title),
        body: `Workspace commit ${shortHash} "${commit.subject}" appears to complete this item. Review and approve to resolve.`,
        confidence: 0.55,
        status: "draft",
        delta: "changed",
        canonicalItemId: item.id,
        targetCanonicalItemId: item.id,
        lifecycleAction: "resolve",
        lifecycleStatusBefore: item.lifecycleStatus,
        lifecycleStatusAfter: "resolved",
        canonicalOperation: item.type === "risk" ? "mark_resolved" : "set_status",
        mergeStrategy: "update_existing",
        evidenceSource: "code_state",
        selectionReason: `Workspace commit ${shortHash} "${commit.subject}" appears to complete this open ${item.type}.`,
        createdAt,
        updatedAt: createdAt,
        transcriptAnchor: {
          entryId: commit.hash,
          role: "system",
          createdAt: commit.committedAt,
          quote: `${shortHash} ${commit.subject}`.slice(0, 240)
        }
      } satisfies ExtractedItem;
    });
}

export async function createProjectStore(params: ProjectStoreParams): Promise<ProjectStore> {
  const workspacePath = path.resolve(params.workspacePath);
  const projectId = projectIdForWorkspace(workspacePath);
  const projectDir = path.join(projectBaseDir(), projectId);
  const paths = projectPaths(projectDir);
  const now = nowIso();
  const enqueue = serializeOperations();
  const workspaceProjectTitle = params.projectTitle ?? (path.basename(workspacePath) || "Mortic Project");

  await mkdir(path.join(projectDir, "source_threads"), { recursive: true });
  await mkdir(path.join(projectDir, "source_checkpoints"), { recursive: true });
  await mkdir(path.join(projectDir, "sessions"), { recursive: true });

  async function readProject(): Promise<MorticProject> {
    const fallback: MorticProject = {
      id: projectId,
      title: workspaceProjectTitle,
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

  function isGeneratedSourceTitle(title: string | undefined, threadId: string): boolean {
    return !title || title === sourceTitle(threadId) || title === `Codex ${threadId.slice(0, 8)}`;
  }

  function isGeneratedScratchTitle(title: string | undefined, threadId: string): boolean {
    return !title || title === `Scratch ${threadId.slice(0, 8)}` || title.endsWith(" scratch");
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
      coverageReceipts: chart.coverageReceipts ?? [],
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
        taskPlanMarkdown: item.taskPlanMarkdown,
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
    coverageReceiptId?: string;
    sourceWindows?: CompilationSourceWindow[];
    boundaryStatus?: BoundaryStatus;
    boundaryReason?: string;
    basisCheckpointId?: string;
    basisCompilationId?: string;
    transcriptHash?: string;
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
      coverageReceiptId: params.coverageReceiptId,
      sourceWindowIds: params.sourceWindows?.map((window) => window.id).filter((id): id is string => Boolean(id)),
      boundaryStatus: params.boundaryStatus,
      boundaryReason: params.boundaryReason,
      transcriptStartEntryId: firstTranscriptEntry?.id,
      transcriptEndEntryId: lastTranscriptEntry?.id,
      transcriptEntryCount: params.transcript.length,
      transcriptHash: params.transcriptHash ?? transcriptHash(params.transcript),
      basisCheckpointId: params.basisCheckpointId ?? latestCheckpoint(chart.checkpoints)?.id,
      basisCompilationId: params.basisCompilationId,
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

  async function upsertCoverageReceipt(receipt: CoverageReceipt, runtimeContext?: RuntimeContextRestore): Promise<void> {
    const chart = await readCanonicalChart(runtimeContext);
    await writeChartStorage({
      ...chart,
      coverageReceipts: [
        receipt,
        ...chart.coverageReceipts.filter((candidate) => candidate.id !== receipt.id)
      ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    });
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
    const sourceCompilation = sourceCompilationId
      ? chart.draftCompilations.find((compilation) => compilation.id === sourceCompilationId)
      : undefined;
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

      const artifactId = sourceCompilation?.extractedItemIds.includes(item.id)
        ? sourceCompilation.conversationArtifactId
        : artifacts.has(conversationArtifactIdForScratch(item.scratchSessionId))
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
        taskPlanMarkdown: item.taskPlanMarkdown,
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
      if (sourceCompilationId && compilation.id !== sourceCompilationId && !compilation.extractedItemIds.some((id) => selectedIds.has(id))) return compilation;
      if (!sourceCompilationId && !compilation.extractedItemIds.some((id) => selectedIds.has(id))) return compilation;
      const compilationItemIds = new Set(compilation.extractedItemIds);
      const approvedInCompilation = updatedItems.filter((item) => compilationItemIds.has(item.id) && item.status === "approved").length;
      return {
        ...compilation,
        status: approvedInCompilation >= compilation.extractedItemIds.length ? "approved" as const : "partially-approved" as const,
        updatedAt: current
      };
    });
    const touchedCompilationIds = new Set(
      draftCompilations
        .filter((compilation) => compilation.extractedItemIds.some((id) => selectedIds.has(id)))
        .map((compilation) => compilation.id)
    );
    const coverageReceipts = chart.coverageReceipts.map((receipt) => {
      if (!touchedCompilationIds.has(receipt.compilationId)) return receipt;
      const compilation = draftCompilations.find((candidate) => candidate.id === receipt.compilationId);
      const receiptStatus = compilation?.status === "approved"
        ? "approved" as const
        : compilation?.status === "partially-approved"
          ? "partially_approved" as const
          : receipt.status;
      return {
        ...receipt,
        status: receiptStatus,
        approvedDeltaIds: unique([...(receipt.approvedDeltaIds ?? []), ...approvedDeltaIds]),
        checkpointId: receipt.checkpointId ?? checkpoint?.id,
        checkpointIds: unique([...(receipt.checkpointIds ?? []), ...(checkpoint ? [checkpoint.id] : [])]),
        updatedAt: current
      };
    });

    chart = {
      ...chart,
      checkpoints: checkpoint ? [...chart.checkpoints, checkpoint] : chart.checkpoints,
      deltas: nextDeltas,
      draftCompilations,
      coverageReceipts,
      artifacts: [...artifacts.values()]
    };
    await writeChartStorage(chart);
    await rebuildProduction();
    return { checkpoint, approvedDeltaIds };
  }

  const providerForksPath = path.join(projectDir, "provider_forks.json");

  async function readProviderForks(): Promise<ProviderForkRecord[]> {
    const records = await readJson<ProviderForkRecord[]>(providerForksPath, []);
    return Array.isArray(records) ? records : [];
  }

  // Reconcile the persisted fork tree against what the project actually
  // knows: source threads and scratch sessions seed records, persisted
  // records keep user-facing state (status, requested access) across syncs.
  async function reconcileProviderForks(runtimeContext?: RuntimeContextRestore): Promise<ProviderForkRecord[]> {
    const [sources, sessions, existing] = await Promise.all([readSources(), readSessions(), readProviderForks()]);
    const byRefId = new Map(existing.map((record) => [record.providerRefId, record]));
    const current = nowIso();
    const sourceThreadById = new Map(sources.map((source) => [source.id, source]));

    const next = new Map<string, ProviderForkRecord>();
    const upsert = (seed: Omit<ProviderForkRecord, "createdAt" | "updatedAt">) => {
      const previous = byRefId.get(seed.providerRefId);
      next.set(seed.providerRefId, {
        ...seed,
        status: previous?.status ?? seed.status,
        requestedAccessPreset: previous?.requestedAccessPreset ?? seed.requestedAccessPreset,
        accessGrantedAt: previous?.accessGrantedAt ?? seed.accessGrantedAt,
        createdAt: previous?.createdAt ?? current,
        updatedAt: current
      });
    };

    for (const source of sources) {
      const ref = codexProviderAdapter.sourceReference(source, runtimeContext);
      upsert({
        id: `fork-${hash(ref.providerRefId, 16)}`,
        projectId,
        provider: "codex",
        providerRefId: ref.providerRefId,
        threadId: ref.threadId,
        forkKind: "source",
        status: "active",
        title: source.title,
        sourceThreadId: source.id,
        effectiveAccessPreset: ref.accessPreset,
        accessCanChange: false,
        accessDisabledReason: "Source thread access is owned by the provider session.",
        accessSource: "provider"
      });
    }

    for (const scratch of sessions) {
      const ref = codexProviderAdapter.scratchReference(scratch, runtimeContext);
      if (!ref) continue;
      const parentSource = sourceThreadById.get(scratch.sourceThreadId);
      upsert({
        id: `fork-${hash(ref.providerRefId, 16)}`,
        projectId,
        provider: "codex",
        providerRefId: ref.providerRefId,
        threadId: ref.threadId,
        parentProviderRefId: parentSource?.codexThreadId,
        forkKind: ref.forkKind,
        status: scratch.status === "archived" || scratch.status === "discarded" ? "archived" : "active",
        title: scratch.title,
        sourceThreadId: scratch.sourceThreadId,
        scratchSessionId: scratch.id,
        effectiveAccessPreset: ref.accessPreset,
        accessCanChange: scratch.ephemeral === false,
        accessDisabledReason: scratch.ephemeral ? "Ephemeral scratch access is fixed at fork time." : undefined,
        accessSource: "fork"
      });
    }

    // Records whose backing thread disappeared from project state go stale
    // rather than vanishing, so the tree can still show what existed.
    for (const record of existing) {
      if (next.has(record.providerRefId)) continue;
      next.set(record.providerRefId, {
        ...record,
        status: record.status === "archived" ? "archived" : "stale",
        updatedAt: current
      });
    }

    const records = [...next.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    await writeAtomic(providerForksPath, `${JSON.stringify(records, null, 2)}\n`);
    return records;
  }

  async function setProviderForkAccess(
    providerRefId: string,
    requestedAccessPreset: ProviderForkContinuation,
    runtimeContext?: RuntimeContextRestore
  ): Promise<ProviderForkRecord[]> {
    // Reconcile first so a freshly-seeded fork can be targeted immediately.
    const records = await reconcileProviderForks(runtimeContext);
    const target = records.find((record) => record.providerRefId === providerRefId);
    if (!target) {
      throw new Error(`Unknown provider fork: ${providerRefId}`);
    }
    const current = nowIso();
    const updated = records.map((record) =>
      record.providerRefId === providerRefId
        ? { ...record, requestedAccessPreset, updatedAt: current }
        : record
    );
    await writeAtomic(providerForksPath, `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
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
      providerForks: await reconcileProviderForks(runtimeContext),
      checkpoints: sortedCheckpoints(chart.checkpoints),
      canonicalItems: [...chart.canonicalItems].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
      deltas: [...chart.deltas].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt)),
      draftCompilations: [...chart.draftCompilations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      coverageReceipts: [...chart.coverageReceipts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
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
    const indexedThreadName = await codexProviderAdapter.threadName(session.threadId);
    const title = isGeneratedSourceTitle(existing?.title, session.threadId)
      ? sourceTitle(session.threadId, indexedThreadName)
      : existing?.title ?? sourceTitle(session.threadId, indexedThreadName);
    const next: SourceThreadNode = {
      id,
      projectId,
      codexThreadId: session.threadId,
      title,
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
    const currentProjectTitle = project.title;
    const nextProjectTitle =
      !currentProjectTitle || currentProjectTitle === indexedThreadName || currentProjectTitle === path.basename(workspacePath)
        ? workspaceProjectTitle
        : currentProjectTitle;
    await writeProject({
      ...project,
      title: nextProjectTitle,
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
    const title = isGeneratedScratchTitle(existing?.title, session.threadId)
      ? sessionTitle(session, source.title)
      : existing?.title ?? sessionTitle(session, source.title);
    const next: ScratchSessionNode = {
      id,
      projectId,
      sourceThreadId: source.id,
      sourceCheckpointId: existing?.sourceCheckpointId ?? checkpoint.id,
      parentScratchSessionId: existing?.parentScratchSessionId,
      codexScratchThreadId,
      forkedFromId: session.forkCheckpoint?.sourceThreadId ?? existing?.forkedFromId,
      ephemeral: Boolean(codexScratchThreadId) || existing?.ephemeral === true,
      title,
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

  async function importDraftCompilation(
    request: DraftCompilationImportRequest,
    session?: MorticSession,
    runtimeContext?: RuntimeContextRestore
  ): Promise<DraftCompilationImportResponse> {
    if (request.provider && request.provider !== "codex") {
      throw new Error(`Unsupported provider for draft compilation import: ${request.provider}`);
    }
    if (!Array.isArray(request.candidateDeltas) || request.candidateDeltas.length === 0) {
      throw new Error("Draft compilation import requires at least one candidate delta.");
    }

    const importId = request.importId?.trim() || importRequestFingerprint(request);
    const compilationId = draftCompilationIdForImport(importId);
    const existingChart = await readCanonicalChart(runtimeContext);
    const existingCompilation = existingChart.draftCompilations.find((candidate) => candidate.id === compilationId);
    if (existingCompilation) {
      const existingItems = await readItems();
      const chartResponse = await projectChartResponse(runtimeContext);
      const providerRefId = importedProviderRefId(request, importId);
      const storedReceipt = chartResponse.coverageReceipts.find((receipt) => receipt.compilationId === existingCompilation.id);
      const existingReceipt = storedReceipt ??
        syntheticCoverageReceipt({
          projectId,
          importId,
          compilation: existingCompilation,
          providerRefId,
          sourceWindows: normalizeSourceWindows({
            request,
            importId,
            providerRefId,
            importedAt: existingCompilation.createdAt
          }),
          createdAt: existingCompilation.createdAt
        });
      if (!storedReceipt) {
        await upsertCoverageReceipt(existingReceipt, runtimeContext);
      }
      const response = storedReceipt ? chartResponse : await projectChartResponse(runtimeContext);
      return {
        ...response,
        projectState: await snapshot(),
        compilation: existingCompilation,
        createdItems: existingItems.filter((item) => existingCompilation.extractedItemIds.includes(item.id)),
        coverageReceipt: existingReceipt,
        artifact: response.artifacts.find((artifact) => artifact.id === existingCompilation.conversationArtifactId)
      };
    }

    const projectBeforeImport = await readProject();
    const current = nowIso();
    const importedAt = request.createdAt?.trim() || current;
    const providerRefId = importedProviderRefId(request, importId);
    const priorReceipt = request.priorBoundaryReceiptId
      ? existingChart.coverageReceipts.find((receipt) => receipt.id === request.priorBoundaryReceiptId)
      : request.priorImportId
        ? existingChart.coverageReceipts.find((receipt) => receipt.importId === request.priorImportId)
        : existingChart.coverageReceipts
          .filter((receipt) =>
            receipt.provider === (request.provider ?? "codex") &&
            (
              receipt.providerRefId === providerRefId ||
              (request.threadId && receipt.threadId === request.threadId) ||
              (request.conversationId && receipt.conversationId === request.conversationId)
            )
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const sourceWindows = normalizeSourceWindows({
      request,
      importId,
      providerRefId,
      importedAt,
      priorReceipt
    });
    const boundaryStatus = aggregateBoundaryStatus(sourceWindows.map((window) => window.boundaryStatus), defaultBoundaryStatus(request, sourceWindows));
    const boundaryReason = defaultBoundaryReason(boundaryStatus, request) ?? sourceWindows.find((window) => window.boundaryReason)?.boundaryReason;
    const coverageReceiptId = coverageReceiptIdForImport(importId);
    const sourceThread = session?.threadId || params.threadId;
    const sourceUri = session?.sourceUri || request.sourceUri || params.sourceUri;
    const sourceRuntime = runtimeContext ?? session?.runtimeContext;
    const candidateLines = request.candidateDeltas
      .map((candidate, index) => `${index + 1}. ${candidate.type}: ${candidate.title}`)
      .join("\n");
    const excerpt = request.transcriptExcerpt?.trim();
    const assistantText = [
      request.summary?.trim() || "Imported draft canonical deltas from a Mortic-aware Codex scratch.",
      excerpt ? `Transcript excerpt:\n${excerpt}` : undefined,
      candidateLines ? `Candidate deltas:\n${candidateLines}` : undefined
    ].filter(Boolean).join("\n\n");
    const transcript: TranscriptEntry[] = [
      {
        id: `import-user-${hash(importId, 8)}`,
        role: "user",
        text: "Push this Codex scratch work to Mortic as reviewable draft deltas.",
        createdAt: importedAt,
        scratchMode: "text",
        reasoningEffort: "none"
      },
      {
        id: `import-assistant-${hash(importId, 8)}`,
        role: "assistant",
        text: assistantText,
        createdAt: importedAt,
        scratchMode: "text",
        reasoningEffort: "none"
      }
    ];
    const importSession: MorticSession = {
      id: importedScratchSessionId(importId),
      sourceUri,
      threadId: sourceThread,
      createdAt: importedAt,
      updatedAt: importedAt,
      transcript,
      codex: session?.codex ?? { available: true },
      runtimeContext: sourceRuntime,
      forkCheckpoint: {
        sourceThreadId: sourceThread,
        scratchThreadId: providerRefId,
        forkedAt: importedAt,
        checkpointInstruction: "Imported from a Mortic canonical-state skill draft pack; review inside Mortic before approval."
      }
    };

    const scratch = await upsertScratch(importSession);
    const committedScratch: ScratchSessionNode = {
      ...scratch,
      status: "committed",
      summary: request.summary?.trim() || "Imported Mortic-aware Codex draft deltas.",
      committedAt: current,
      updatedAt: current
    };
    await writeAtomic(path.join(sessionDir(projectDir, scratch.id), "session.json"), `${JSON.stringify(committedScratch, null, 2)}\n`);

    const generated: ExtractedItem[] = request.candidateDeltas.map((candidate, index) => {
      const type = importedCandidateType(candidate.type);
      if (!type) {
        throw new Error(`Unsupported candidate delta type at index ${index}: ${candidate.type}`);
      }
      const body = cleanImportedBody(candidate.body);
      if (!body) {
        throw new Error(`Candidate delta at index ${index} is missing a body.`);
      }
      const taskPlanMarkdown = cleanTaskPlanMarkdown(candidate.taskPlanMarkdown);
      const title = cleanImportedTitle(type, candidate.title, body);
      const lifecycleAction = importedLifecycleAction(candidate.lifecycleAction);
      const fallbackStatus = defaultImportedLifecycleStatus(lifecycleAction);
      const targetCanonicalItemId = candidate.targetCanonicalItemId ?? candidate.canonicalItemId ?? null;
      const rawCandidateId = candidate.id?.trim() || `imported-candidate-${hash(`${importId}:${index}:${type}:${title}:${body}`, 18)}`;
      const canonicalItemId = candidate.canonicalItemId ?? targetCanonicalItemId ?? rawCandidateId;
      const defaultDelta: ExtractedItem["delta"] = targetCanonicalItemId || lifecycleAction !== "create" ? "changed" : "new";
      return {
        id: compileScopedItemId(rawCandidateId, compilationId),
        projectId,
        sourceThreadId: committedScratch.sourceThreadId,
        scratchSessionId: committedScratch.id,
        sourceCompilationId: compilationId,
        sourceTurnId: transcript[1].id,
        type,
        title,
        body,
        taskPlanMarkdown,
        confidence: typeof candidate.confidence === "number" ? Math.max(0, Math.min(1, candidate.confidence)) : 0.86,
        status: "draft",
        delta: importedDeltaValue(candidate.delta, defaultDelta),
        canonicalItemId,
        targetCanonicalItemId,
        lifecycleAction,
        lifecycleStatusBefore: importedLifecycleStatusBefore(candidate.lifecycleStatusBefore),
        lifecycleStatusAfter: importedLifecycleStatus(candidate.lifecycleStatusAfter, fallbackStatus),
        canonicalOperation: candidate.canonicalOperation,
        mergeStrategy: candidate.mergeStrategy ?? "append_unique",
        reconcilesWith: candidate.reconcilesWith,
        reconciliationReason: candidate.reconciliationReason,
        conflicts: candidate.conflicts,
        evidenceSource: "transcript",
        selectionReason: candidate.selectionReason ?? "Pushed from a Mortic-aware Codex skill draft compilation.",
        createdAt: current,
        updatedAt: current,
        transcriptAnchor: {
          entryId: transcript[1].id,
          role: "assistant",
          createdAt: importedAt,
          quote: (candidate.evidenceQuote?.trim() || excerpt || body).slice(0, 500)
        }
      };
    });

    const existingItems = await readItems();
    const reconciled = reconcileGeneratedWithPendingDrafts(existingItems, generated, current);
    const finalGenerated = reconciled.generated;
    const nextItems = [...reconciled.items, ...finalGenerated];
    const itemById = new Map(nextItems.map((item) => [item.id, item]));
    const compilationItemIds = unique([...finalGenerated.map((item) => item.id), ...reconciled.matchedItemIds]);
    const compilationItems = compilationItemIds.map((id) => itemById.get(id)).filter((item): item is ExtractedItem => Boolean(item));
    await writeItems(nextItems);
    await writeAtomic(
      committedScratch.extractedItemsPath,
      `${JSON.stringify(nextItems.filter((item) => item.scratchSessionId === committedScratch.id), null, 2)}\n`
    );

    const compilation = await createDraftCompilation({
      scratch: committedScratch,
      items: compilationItems,
      summary: compilationItems.length > 0
        ? request.summary?.trim() || `Imported ${compilationItems.length} draft canonical ${compilationItems.length === 1 ? "delta" : "deltas"}.`
        : "Updated existing pending canonical drafts from an imported Codex skill pack.",
      compilationId,
      transcript,
      coverageReceiptId,
      sourceWindows,
      boundaryStatus,
      boundaryReason,
      transcriptHash: request.transcriptHash,
      basisCheckpointId: request.baseCheckpointId,
      basisCompilationId: request.basisCompilationId,
      createdAt: current
    });
    const coverageReceipt: CoverageReceipt = {
      id: coverageReceiptId,
      projectId,
      importId,
      compilationId,
      provider: request.provider ?? "codex",
      providerRefId,
      conversationId: request.conversationId,
      threadId: request.threadId,
      planId: request.compilePlan?.id,
      mode: request.compilePlan?.mode,
      priorReceiptId: priorReceipt?.id ?? request.priorBoundaryReceiptId,
      priorImportId: priorReceipt?.importId ?? request.priorImportId,
      basisCompilationId: request.basisCompilationId,
      sourceWindows,
      boundaryStatus,
      boundaryReason,
      status: boundaryStatus === "uncertain"
        ? "boundary_uncertain"
        : compilationItems.length === 0
          ? "reviewed_empty"
          : "draft_imported",
      createdAt: current,
      updatedAt: current
    };
    await upsertCoverageReceipt(coverageReceipt, runtimeContext);
    await recordEvent(importSession, {
      type: "draft_compilation.imported",
      detail: {
        importId,
        compilationId,
        coverageReceiptId,
        boundaryStatus,
        provider: request.provider ?? "codex",
        providerRefId,
        createdItems: finalGenerated.length,
        compilationItems: compilationItems.length,
        mergedIntoPendingItems: reconciled.mergedIds.length
      }
    });
    const projectAfterImport = await readProject();
    await writeProject({
      ...projectAfterImport,
      activeSourceThreadId: projectBeforeImport.activeSourceThreadId ?? projectAfterImport.activeSourceThreadId,
      activeSourceCheckpointId: projectBeforeImport.activeSourceCheckpointId ?? projectAfterImport.activeSourceCheckpointId,
      activeScratchSessionId: projectBeforeImport.activeScratchSessionId ?? projectAfterImport.activeScratchSessionId
    });
    await rebuildProduction();

    const chartResponse = await projectChartResponse(runtimeContext);
    return {
      ...chartResponse,
      projectState: await snapshot(),
      compilation,
      createdItems: finalGenerated,
      coverageReceipt,
      artifact: chartResponse.artifacts.find((artifact) => artifact.id === compilation.conversationArtifactId)
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
        extractionBaseThreadId: scratch.codexScratchThreadId,
        runtimeContext: session.runtimeContext,
        hash,
        nowIso
      })
      : {
        items: [] as ExtractedItem[],
        summary: "No new transcript entries since the last compilation."
      };
    const reconcileDrafts = transcriptForCompilation.length > 0 && process.env.MORTIC_COMPILE_RECONCILE !== "0"
      ? await codeReconcileDraftItems({
        projectId,
        sourceThreadId: source.id,
        scratchSessionId: scratch.id,
        workspacePath,
        canonicalItems: chartBeforeCompilation.canonicalItems,
        existingItems,
        extractionItems: extraction.items
      })
      : [];
    const extractionItems = [...extraction.items, ...reconcileDrafts];
    const generatedItemIds = new Map(extractionItems.map((item) => [item.id, compileScopedItemId(item.id, compilationId)]));
    const generated = extractionItems.map((item) => {
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
    const itemById = new Map(items.map((item) => [item.id, item]));
    const compilationItemIds = unique([...finalGenerated.map((item) => item.id), ...reconciled.matchedItemIds]);
    const compilationItems = compilationItemIds.map((id) => itemById.get(id)).filter((item): item is ExtractedItem => Boolean(item));
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
    const priorReceipt = chartBeforeCompilation.coverageReceipts
      .filter((receipt) => {
        const receiptCompilation = chartBeforeCompilation.draftCompilations.find((candidate) => candidate.id === receipt.compilationId);
        return receiptCompilation?.scratchSessionId === scratch.id || receipt.providerRefId === (scratch.codexScratchThreadId ?? scratch.id);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const sourceWindows = sourceWindowsForScratchCompilation({
      scratch: committedSession,
      transcript: transcriptForCompilation,
      compilationId,
      priorReceipt
    });
    const boundaryStatus = aggregateBoundaryStatus(sourceWindows.map((window) => window.boundaryStatus), "proven");
    const coverageReceiptId = coverageReceiptIdForCompilation(compilationId);
    const compilation = transcriptForCompilation.length > 0
      ? await createDraftCompilation({
        scratch: committedSession,
        items: compilationItems,
        summary: compilationSummary,
        compilationId,
        transcript: transcriptForCompilation,
        coverageReceiptId,
        sourceWindows,
        boundaryStatus,
        basisCompilationId: priorReceipt?.compilationId,
        createdAt: compilationCreatedAt
      })
      : undefined;
    if (compilation) {
      await upsertCoverageReceipt({
        id: coverageReceiptId,
        projectId,
        compilationId: compilation.id,
        provider: "codex",
        providerRefId: committedSession.codexScratchThreadId ?? committedSession.id,
        conversationId: committedSession.codexScratchThreadId,
        threadId: committedSession.codexScratchThreadId,
        extractionProviderRefId: extraction.providerExtraction?.providerRefId,
        extractionThreadId: extraction.providerExtraction?.threadId,
        extractionBaseThreadId: extraction.providerExtraction?.baseThreadId,
        extractionMode: extraction.providerExtraction?.mode,
        mode: "scratch_only",
        priorReceiptId: priorReceipt?.id,
        priorImportId: priorReceipt?.importId,
        basisCompilationId: priorReceipt?.compilationId,
        sourceWindows,
        boundaryStatus,
        status: boundaryStatus === "uncertain"
          ? "boundary_uncertain"
          : compilationItems.length === 0
            ? "reviewed_empty"
            : "draft_imported",
        createdAt: compilationCreatedAt,
        updatedAt: committedAt
      });
    }
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
    const taskPlanMarkdown = "taskPlanMarkdown" in patch ? cleanTaskPlanMarkdown(patch.taskPlanMarkdown) : undefined;
    const nextType = patch.type;
    const contentChanged = Boolean(
      sourceItem &&
      ((nextType !== undefined && nextType !== sourceItem.type) ||
        (title !== undefined && title !== "" && title !== sourceItem.title) ||
        (body !== undefined && body !== "" && body !== sourceItem.body) ||
        ("taskPlanMarkdown" in patch && taskPlanMarkdown !== sourceItem.taskPlanMarkdown))
    );
    const approvedCorrection = Boolean(sourceItem?.status === "approved" && (contentChanged || retiring));
    const nextItems = items.map((item) => {
      if (item.id !== id) return item;
      const nextTitle = title || item.title;
      const nextBody = body || item.body;
      return {
        ...item,
        type: nextType ?? item.type,
        title: nextTitle,
        body: nextBody,
        taskPlanMarkdown: "taskPlanMarkdown" in patch ? taskPlanMarkdown : item.taskPlanMarkdown,
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
    importDraftCompilation: (request, session, runtimeContext) => enqueue(() => importDraftCompilation(request, session, runtimeContext)),
    approveCompilation: (id, request, runtimeContext) => enqueue(() => approveCompilation(id, request, runtimeContext)),
    commitSession: (session, approveItemIds) => enqueue(() => commitSession(session, approveItemIds)),
    archiveSession: (session) => enqueue(() => archiveSession(session)),
    updateExtractedItem: (id, patch) => enqueue(() => updateExtractedItem(id, patch)),
    setProviderForkAccess: (providerRefId, requestedAccessPreset, runtimeContext) =>
      enqueue(() => setProviderForkAccess(providerRefId, requestedAccessPreset, runtimeContext)),
    confirmSourceCheckpoint: () => enqueue(() => confirmSourceCheckpoint()),
    dismissSourceCheckpoint: () => enqueue(() => dismissSourceCheckpoint()),
    createManualSourceCheckpoint: (session) => enqueue(() => createManualSourceCheckpoint(session)),
    markHandoffCopied: (session) => enqueue(() => markHandoffCopied(session))
  };
}
