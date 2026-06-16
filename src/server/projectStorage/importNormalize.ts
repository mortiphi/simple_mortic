import type {
  BoundaryAnchor,
  BoundaryStatus,
  CanonicalLifecycleAction,
  CanonicalLifecycleStatus,
  CompilationSourceWindow,
  CompilePlan,
  DraftCompilationImportRequest,
  ExtractedItem,
  ExtractedItemType
} from "../../shared/types.js";
import { canonicalLifecycleActions, canonicalLifecycleStatuses, extractedItemTypes } from "../../shared/types.js";

import { hash } from "./common.js";
import { itemTitle } from "./extraction.js";
export function importedCandidateType(type: DraftCompilationImportRequest["candidateDeltas"][number]["type"]): ExtractedItemType | null {
  if (type === "project_state_update") return "project_state";
  if (type === "prioritisation_update" || type === "prioritization_update") return "prioritization";
  if (type === "task_update") return "task";
  if (type === "risk_update") return "risk";
  if (type === "backlog_update") return "backlog";
  return extractedItemTypes.includes(type as ExtractedItemType) ? type as ExtractedItemType : null;
}

export function importedLifecycleAction(value: unknown): CanonicalLifecycleAction {
  return typeof value === "string" && canonicalLifecycleActions.includes(value as CanonicalLifecycleAction)
    ? value as CanonicalLifecycleAction
    : "create";
}

export function importedLifecycleStatus(value: unknown, fallback: CanonicalLifecycleStatus = "open"): CanonicalLifecycleStatus {
  return typeof value === "string" && canonicalLifecycleStatuses.includes(value as CanonicalLifecycleStatus)
    ? value as CanonicalLifecycleStatus
    : fallback;
}

export function importedLifecycleStatusBefore(value: unknown): ExtractedItem["lifecycleStatusBefore"] {
  if (value === null) return null;
  return typeof value === "string" && canonicalLifecycleStatuses.includes(value as CanonicalLifecycleStatus)
    ? value as CanonicalLifecycleStatus
    : undefined;
}

export function defaultImportedLifecycleStatus(action: CanonicalLifecycleAction): CanonicalLifecycleStatus {
  if (action === "resolve") return "resolved";
  if (action === "drop") return "dropped";
  if (action === "supersede") return "superseded";
  return "open";
}

export function importedDeltaValue(value: unknown, fallback: ExtractedItem["delta"]): ExtractedItem["delta"] {
  return value === "new" || value === "changed" || value === "unchanged" ? value : fallback;
}

export function cleanImportedTitle(type: ExtractedItemType, title: string, body: string): string {
  const cleaned = title
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:$/, "");
  const fallback = itemTitle(type, body).replace(/[*`]/g, "").replace(/:$/, "").trim();
  return (cleaned || fallback || "Imported Mortic delta").slice(0, 84);
}

export function cleanImportedBody(body: string): string {
  const cleaned = body.replace(/\r/g, "").trim();
  return cleaned.endsWith(":") ? `${cleaned}.` : cleaned;
}

export function cleanTaskPlanMarkdown(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\r/g, "").trim();
  return cleaned || undefined;
}

export function importRequestFingerprint(request: DraftCompilationImportRequest): string {
  return hash(JSON.stringify({
    title: request.title,
    summary: request.summary,
    provider: request.provider,
    providerRefId: request.providerRefId,
    conversationId: request.conversationId,
    threadId: request.threadId,
    transcriptHash: request.transcriptHash,
    transcriptExcerpt: request.transcriptExcerpt,
    candidateDeltas: request.candidateDeltas
  }), 24);
}

export function isBoundaryStatus(value: unknown): value is BoundaryStatus {
  return value === "proven" || value === "anchored" || value === "uncertain";
}

export function boundaryRank(status: BoundaryStatus): number {
  if (status === "uncertain") return 2;
  if (status === "anchored") return 1;
  return 0;
}

export function aggregateBoundaryStatus(statuses: BoundaryStatus[], fallback: BoundaryStatus): BoundaryStatus {
  if (statuses.length === 0) return fallback;
  return statuses.sort((left, right) => boundaryRank(right) - boundaryRank(left))[0] ?? fallback;
}

export function boundaryAnchorHash(anchor: BoundaryAnchor | undefined): string {
  return hash(JSON.stringify(anchor ?? {}), 12);
}

export function sourceWindowId(importId: string, index: number, window: CompilationSourceWindow): string {
  return `window-${hash(`${importId}:${index}:${window.windowKind}:${boundaryAnchorHash(window.coveredFrom)}:${boundaryAnchorHash(window.coveredTo)}`, 18)}`;
}

export function compilePlanWindows(plan: CompilePlan | undefined): CompilationSourceWindow[] {
  if (!plan) return [];
  return [
    ...plan.primaryWindows,
    ...(plan.referenceWindows ?? []),
    ...(plan.excludedWindows ?? [])
  ];
}

export function defaultBoundaryStatus(request: DraftCompilationImportRequest, windows: CompilationSourceWindow[]): BoundaryStatus {
  if (isBoundaryStatus(request.boundaryStatus)) return request.boundaryStatus;
  if (windows.length > 0) return aggregateBoundaryStatus(windows.map((window) => window.boundaryStatus), "uncertain");
  if (request.transcriptHash || request.transcriptExcerpt || request.coveredTo) return "anchored";
  return "uncertain";
}

export function defaultBoundaryReason(status: BoundaryStatus, request: DraftCompilationImportRequest): string | undefined {
  if (request.boundaryReason?.trim()) return request.boundaryReason.trim();
  if (status === "uncertain") return "Import did not include stable source-window boundary anchors.";
  if (status === "anchored") return "Boundary is anchored by transcript hash/excerpt rather than provider message ids.";
  return undefined;
}

export function defaultCoveredToAnchor(request: DraftCompilationImportRequest, providerRefId: string, importedAt: string): BoundaryAnchor {
  const excerpt = request.transcriptExcerpt?.trim();
  return {
    provider: request.provider ?? "codex",
    providerRefId,
    conversationId: request.conversationId,
    threadId: request.threadId,
    createdAt: importedAt,
    transcriptHash: request.transcriptHash,
    textHash: excerpt ? hash(excerpt, 18) : undefined,
    textExcerpt: excerpt ? excerpt.slice(-800) : undefined
  };
}
