import type {
  BoundaryAnchor,
  CompilationSourceWindow,
  CoverageReceipt,
  DraftCompilation,
  DraftCompilationImportRequest,
  ExtractedItem,
  ScratchSessionNode,
  TranscriptEntry
} from "../../shared/types.js";

import { hash } from "./common.js";
import { coverageReceiptIdForImport } from "./ids.js";
import { aggregateBoundaryStatus, boundaryAnchorHash, compilePlanWindows, defaultBoundaryReason, defaultBoundaryStatus, defaultCoveredToAnchor, isBoundaryStatus, sourceWindowId } from "./importNormalize.js";
import { canonicalItemIdForExtractedItem } from "./lifecycle.js";
export function transcriptEntryAnchor(entry: TranscriptEntry, providerRefId: string, threadId?: string): BoundaryAnchor {
  const text = [
    entry.role,
    entry.text,
    entry.spokenText,
    entry.notesText,
    entry.sourcesText
  ].filter(Boolean).join("\n");
  return {
    provider: "codex",
    providerRefId,
    conversationId: threadId,
    threadId,
    messageId: entry.id,
    turnId: entry.id,
    entryId: entry.id,
    createdAt: entry.createdAt,
    textHash: hash(text, 18),
    textExcerpt: text.trim().slice(-800)
  };
}

export function sourceWindowsForScratchCompilation(params: {
  scratch: ScratchSessionNode;
  transcript: TranscriptEntry[];
  compilationId: string;
  priorReceipt?: CoverageReceipt;
}): CompilationSourceWindow[] {
  const lastEntry = params.transcript.at(-1);
  if (!lastEntry) return [];
  const providerRefId = params.scratch.codexScratchThreadId ?? params.scratch.id;
  const threadId = params.scratch.codexScratchThreadId;
  const priorPrimaryWindow = params.priorReceipt?.sourceWindows.find((window) => window.windowKind === "primary");
  const forkAnchor = params.scratch.forkedFromId
    ? {
      provider: "codex" as const,
      providerRefId: params.scratch.forkedFromId,
      conversationId: params.scratch.forkedFromId,
      threadId: params.scratch.forkedFromId,
      createdAt: params.scratch.createdAt,
      textExcerpt: "Scratch fork point."
    }
    : undefined;
  const coveredFrom = priorPrimaryWindow?.coveredTo ?? forkAnchor;
  const coveredTo = transcriptEntryAnchor(lastEntry, providerRefId, threadId);
  return [{
    id: `window-${hash(`${params.compilationId}:primary:${coveredFrom ? boundaryAnchorHash(coveredFrom) : "start"}:${boundaryAnchorHash(coveredTo)}`, 18)}`,
    provider: "codex",
    providerRefId,
    conversationId: threadId,
    threadId,
    windowKind: "primary",
    coveredFrom,
    coveredTo,
    forkedFrom: params.scratch.forkedFromId
      ? {
        providerRefId: params.scratch.forkedFromId,
        anchor: forkAnchor ?? {
          provider: "codex",
          providerRefId: params.scratch.forkedFromId,
          conversationId: params.scratch.forkedFromId,
          threadId: params.scratch.forkedFromId
        }
      }
      : undefined,
    transcriptHash: transcriptHash(params.transcript),
    boundaryStatus: "proven"
  }];
}

export function normalizeSourceWindows(params: {
  request: DraftCompilationImportRequest;
  importId: string;
  providerRefId: string;
  importedAt: string;
  priorReceipt?: CoverageReceipt;
}): CompilationSourceWindow[] {
  const requestWindows = compilePlanWindows(params.request.compilePlan);
  const suppliedWindows = requestWindows.length > 0 ? requestWindows : params.request.sourceWindows ?? [];
  const fallbackStatus = defaultBoundaryStatus(params.request, suppliedWindows);
  const fallbackReason = defaultBoundaryReason(fallbackStatus, params.request);
  const fallbackCoveredTo = params.request.coveredTo ?? defaultCoveredToAnchor(params.request, params.providerRefId, params.importedAt);
  const fallbackCoveredFrom = params.request.coveredFrom ?? params.priorReceipt?.sourceWindows.find((window) => window.windowKind === "primary")?.coveredTo;

  const windows = suppliedWindows.length > 0
    ? suppliedWindows
    : [{
      provider: params.request.provider ?? "codex",
      providerRefId: params.providerRefId,
      conversationId: params.request.conversationId,
      threadId: params.request.threadId,
      windowKind: "primary" as const,
      coveredFrom: fallbackCoveredFrom,
      coveredTo: fallbackCoveredTo,
      transcriptHash: params.request.transcriptHash,
      boundaryStatus: fallbackStatus,
      boundaryReason: fallbackReason
    }];

  return windows.map((rawWindow, index) => {
    const status = isBoundaryStatus(rawWindow.boundaryStatus) ? rawWindow.boundaryStatus : fallbackStatus;
    return {
      ...rawWindow,
      id: rawWindow.id || sourceWindowId(params.importId, index, rawWindow),
      provider: rawWindow.provider ?? params.request.provider ?? "codex",
      providerRefId: rawWindow.providerRefId ?? params.providerRefId,
      conversationId: rawWindow.conversationId ?? params.request.conversationId,
      threadId: rawWindow.threadId ?? params.request.threadId,
      coveredTo: rawWindow.coveredTo ?? fallbackCoveredTo,
      transcriptHash: rawWindow.transcriptHash ?? params.request.transcriptHash,
      boundaryStatus: status,
      boundaryReason: rawWindow.boundaryReason ?? fallbackReason
    };
  });
}

export function syntheticCoverageReceipt(params: {
  projectId: string;
  importId?: string;
  compilation: DraftCompilation;
  providerRefId: string;
  sourceWindows: CompilationSourceWindow[];
  createdAt: string;
}): CoverageReceipt {
  const boundaryStatus = aggregateBoundaryStatus(params.sourceWindows.map((window) => window.boundaryStatus), "uncertain");
  return {
    id: params.importId ? coverageReceiptIdForImport(params.importId) : `coverage-${hash(params.compilation.id, 18)}`,
    projectId: params.projectId,
    importId: params.importId,
    compilationId: params.compilation.id,
    provider: "codex",
    providerRefId: params.providerRefId,
    sourceWindows: params.sourceWindows,
    boundaryStatus,
    boundaryReason: boundaryStatus === "uncertain" ? "Coverage receipt was synthesized for a legacy compilation." : undefined,
    status: boundaryStatus === "uncertain" ? "boundary_uncertain" : "draft_imported",
    createdAt: params.createdAt,
    updatedAt: params.compilation.updatedAt
  };
}

export function canonicalStableKey(item: ExtractedItem): string {
  return `${item.type}:${canonicalItemIdForExtractedItem(item)}`;
}

export function transcriptHash(entries: TranscriptEntry[]): string {
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

export function compilationTranscriptBoundaryIndex(entries: TranscriptEntry[], compilation: DraftCompilation): number {
  if (compilation.transcriptEndEntryId) {
    const endIndex = entries.findIndex((entry) => entry.id === compilation.transcriptEndEntryId);
    if (endIndex >= 0) return endIndex;
  }
  if (typeof compilation.transcriptEntryCount === "number" && compilation.transcriptEntryCount > 0) {
    return Math.min(compilation.transcriptEntryCount - 1, entries.length - 1);
  }
  return -1;
}

export function transcriptAfterLatestCompilation(entries: TranscriptEntry[], compilations: DraftCompilation[], scratchId: string): TranscriptEntry[] {
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

export function compileScopedItemId(itemId: string, compilationId: string): string {
  return `item-${hash(`${compilationId}:${itemId}`, 18)}`;
}
