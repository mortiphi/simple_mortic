import { createHash } from "node:crypto";

import type {
  CanonicalCheckpoint,
  CanonicalDelta,
  CanonicalItem,
  ConversationArtifact,
  CoverageReceipt,
  DraftCompilation,
  ExtractedItemType,
  ProviderReference
} from "../../shared/types.js";
import { extractedItemTypes } from "../../shared/types.js";

export const extractionLabels: Record<ExtractedItemType, string> = {
  project_state: "Project State Update",
  prioritization: "Prioritisation Update",
  task: "Task Update",
  risk: "Risk Update",
  backlog: "Backlog Update"
};
export const canonicalExtractionTypes = new Set<string>(extractedItemTypes);

export function nowIso(): string {
  return new Date().toISOString();
}

export function hash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "workspace";
}

export type CanonicalChartFile = {
  schemaVersion: "1.0";
  projectId: string;
  checkpoints: CanonicalCheckpoint[];
  canonicalItems: CanonicalItem[];
  deltas: CanonicalDelta[];
  draftCompilations: DraftCompilation[];
  coverageReceipts: CoverageReceipt[];
  artifacts: ConversationArtifact[];
  providerRefs: ProviderReference[];
  createdAt: string;
  updatedAt: string;
};

export function emptyChartFile(projectId: string): CanonicalChartFile {
  const current = nowIso();
  return {
    schemaVersion: "1.0",
    projectId,
    checkpoints: [],
    canonicalItems: [],
    deltas: [],
    draftCompilations: [],
    coverageReceipts: [],
    artifacts: [],
    providerRefs: [],
    createdAt: current,
    updatedAt: current
  };
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
