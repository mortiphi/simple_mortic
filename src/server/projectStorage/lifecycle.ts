import type {
  CanonicalCheckpoint,
  CanonicalDelta,
  CanonicalItem,
  CanonicalLifecycleStatus,
  ExtractedItem
} from "../../shared/types.js";

import { CanonicalChartFile, unique } from "./common.js";
import { extractionFingerprint, normalizeBody } from "./extraction.js";
export function itemAliases(item: Pick<ExtractedItem, "id" | "canonicalItemId" | "targetCanonicalItemId">): string[] {
  return [item.id, item.canonicalItemId, item.targetCanonicalItemId].filter((id): id is string => Boolean(id));
}

export function itemMatchesAnyId(item: Pick<ExtractedItem, "id" | "canonicalItemId" | "targetCanonicalItemId">, id: string): boolean {
  return itemAliases(item).includes(id);
}

export function canonicalTargetKeyForId(items: ExtractedItem[], id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const direct = items.find((item) => itemMatchesAnyId(item, id));
  return direct ? canonicalItemIdForExtractedItem(direct) : id;
}

export function reviewTargetKey(item: ExtractedItem, items: ExtractedItem[]): string {
  return canonicalTargetKeyForId(items, item.targetCanonicalItemId) ?? canonicalItemIdForExtractedItem(item);
}

export function reviewOperationKey(item: ExtractedItem): string {
  return item.canonicalOperation ?? item.lifecycleAction ?? "create";
}

export function isPendingDraftItem(item: ExtractedItem): boolean {
  return item.status === "draft" && Boolean(item.sourceCompilationId);
}

export function samePendingDraftSurface(left: ExtractedItem, right: ExtractedItem): boolean {
  return extractionFingerprint(left.type, left.title, left.body) === extractionFingerprint(right.type, right.title, right.body);
}

export function findPendingDraftMatch(existingItems: ExtractedItem[], incoming: ExtractedItem): ExtractedItem | undefined {
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

export function mergedReconciledItems(left: ExtractedItem["reconcilesWith"], right: ExtractedItem["reconcilesWith"]): ExtractedItem["reconcilesWith"] {
  const byId = new Map<string, NonNullable<ExtractedItem["reconcilesWith"]>[number]>();
  for (const item of [...(left ?? []), ...(right ?? [])]) byId.set(`${item.type}:${item.id}`, item);
  return byId.size > 0 ? [...byId.values()] : undefined;
}

export function mergePendingDraftEvidence(existing: ExtractedItem, incoming: ExtractedItem, updatedAt: string): ExtractedItem {
  return {
    ...existing,
    confidence: Math.max(existing.confidence, incoming.confidence),
    selectionReason: existing.selectionReason ?? incoming.selectionReason,
    reconciliationReason: existing.reconciliationReason ?? incoming.reconciliationReason,
    conflicts: [...new Set([...(existing.conflicts ?? []), ...(incoming.conflicts ?? [])])],
    reconcilesWith: mergedReconciledItems(existing.reconcilesWith, incoming.reconcilesWith),
    taskPlanMarkdown: existing.taskPlanMarkdown ?? incoming.taskPlanMarkdown,
    transcriptAnchor: incoming.transcriptAnchor ?? existing.transcriptAnchor,
    updatedAt
  };
}

export function reconcileGeneratedWithPendingDrafts(existingItems: ExtractedItem[], generated: ExtractedItem[], updatedAt: string): {
  items: ExtractedItem[];
  generated: ExtractedItem[];
  mergedIds: string[];
  matchedItemIds: string[];
} {
  if (generated.length === 0) return { items: existingItems, generated, mergedIds: [], matchedItemIds: [] };
  const byId = new Map(existingItems.map((item) => [item.id, item]));
  const kept: ExtractedItem[] = [];
  const mergedIds: string[] = [];
  const matchedItemIds: string[] = [];

  for (const item of generated) {
    const match = findPendingDraftMatch([...byId.values(), ...kept], item);
    if (!match) {
      kept.push(item);
      continue;
    }
    byId.set(match.id, mergePendingDraftEvidence(match, item, updatedAt));
    mergedIds.push(item.id);
    matchedItemIds.push(match.id);
  }

  return {
    items: existingItems.map((item) => byId.get(item.id) ?? item),
    generated: kept,
    mergedIds,
    matchedItemIds: unique(matchedItemIds)
  };
}

export function sameCanonicalBody(delta: CanonicalDelta, item: ExtractedItem): boolean {
  return normalizeBody(`${delta.title}\n${delta.body}\n${delta.taskPlanMarkdown ?? ""}`).toLowerCase() === normalizeBody(`${item.title}\n${item.body}\n${item.taskPlanMarkdown ?? ""}`).toLowerCase() &&
    (delta.lifecycleAction ?? "create") === (item.lifecycleAction ?? "create") &&
    (delta.lifecycleStatusAfter ?? "open") === lifecycleStatusForItem(item);
}

export function sortedCheckpoints(checkpoints: CanonicalCheckpoint[]): CanonicalCheckpoint[] {
  return [...checkpoints].sort((a, b) => a.approvedAt.localeCompare(b.approvedAt));
}

export function latestCheckpoint(checkpoints: CanonicalCheckpoint[]): CanonicalCheckpoint | undefined {
  return sortedCheckpoints(checkpoints).at(-1);
}

export function latestDeltaForStableKey(deltas: CanonicalDelta[], stableKey: string): CanonicalDelta | undefined {
  return [...deltas]
    .filter((delta) => delta.stableKey === stableKey)
    .sort((a, b) => b.version - a.version || b.approvedAt.localeCompare(a.approvedAt))[0];
}

export function latestDeltaForCanonicalItem(deltas: CanonicalDelta[], canonicalItemId: string): CanonicalDelta | undefined {
  return [...deltas]
    .filter((delta) => delta.canonicalItemId === canonicalItemId)
    .sort((a, b) => b.version - a.version || b.approvedAt.localeCompare(a.approvedAt))[0];
}

export const inactiveLifecycleStatuses = new Set<CanonicalLifecycleStatus>(["resolved", "dropped", "superseded", "stale"]);

export function lifecycleStatusForItem(item: Pick<ExtractedItem, "status" | "lifecycleStatusAfter">): CanonicalLifecycleStatus {
  if (item.lifecycleStatusAfter) return item.lifecycleStatusAfter;
  if (item.status === "merged") return "superseded";
  return "open";
}

export function canonicalItemIdForExtractedItem(item: Pick<ExtractedItem, "id" | "canonicalItemId" | "targetCanonicalItemId">): string {
  return item.canonicalItemId || item.targetCanonicalItemId || item.id;
}

export function shouldCreateCanonicalDelta(item: ExtractedItem): boolean {
  return item.lifecycleAction !== "no_op";
}

export function currentApprovedItems(items: ExtractedItem[]): ExtractedItem[] {
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

export function lifecycleStatusForDelta(delta: CanonicalDelta): CanonicalLifecycleStatus {
  if (delta.status === "superseded") return "superseded";
  return delta.lifecycleStatusAfter ?? "open";
}

export function canonicalItemsFromDeltas(deltas: CanonicalDelta[]): CanonicalItem[] {
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
      taskPlanMarkdown: delta.taskPlanMarkdown,
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

export function withDeltaLifecycleDefaults(delta: CanonicalDelta): CanonicalDelta {
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

export function withCanonicalItems(chart: CanonicalChartFile): CanonicalChartFile {
  const deltas = chart.deltas.map(withDeltaLifecycleDefaults);
  return {
    ...chart,
    deltas,
    canonicalItems: canonicalItemsFromDeltas(deltas)
  };
}

export function matchesCanonicalTarget(item: ExtractedItem, targetId: string): boolean {
  return item.id === targetId || item.canonicalItemId === targetId || item.targetCanonicalItemId === targetId;
}

export function withLifecycleDefaults(item: ExtractedItem): ExtractedItem {
  return {
    ...item,
    canonicalItemId: canonicalItemIdForExtractedItem(item),
    lifecycleAction: item.lifecycleAction ?? "create",
    lifecycleStatusAfter: lifecycleStatusForItem(item)
  };
}

export function applyLifecycleSideEffects(items: ExtractedItem[], selectedItems: ExtractedItem[], updatedAt: string): ExtractedItem[] {
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
