import type { SparkContextPreflight } from "../../shared/types.js";
import { modelProfile } from "../../shared/modelProfiles.js";

import { formatCount, formatPercent } from "./format.js";
export function needsModelTransitionPreflight(model: string): boolean {
  return modelProfile(model).id !== "default";
}

export function sparkPreflightLabel(preflight: SparkContextPreflight | null, pending: boolean): string {
  if (pending) return "Checking candidate model context";
  if (!preflight) return "Candidate model context unknown - blocked";

  if (preflight.status === "safe") {
    const input = preflight.inputTokens !== undefined ? formatCount(preflight.inputTokens) : "unknown";
    const candidate = preflight.candidateModelLabel ?? preflight.candidateModel;
    return preflight.compactedForkThreadId
      ? `${candidate} safe on compacted scratch - ${input} tokens, ${formatPercent(preflight.saturation)} of candidate window`
      : `${candidate} safe - ${input} tokens, ${formatPercent(preflight.saturation)} of candidate window`;
  }

  if (preflight.status === "warning") {
    const input = preflight.inputTokens !== undefined ? formatCount(preflight.inputTokens) : "unknown";
    const candidate = preflight.candidateModelLabel ?? preflight.candidateModel;
    return preflight.compactedForkThreadId
      ? `${candidate} warning on compacted scratch - ${input} tokens, ${formatPercent(preflight.saturation)} of candidate window; approval required`
      : `${candidate} warning - ${input} tokens, ${formatPercent(preflight.saturation)} of candidate window; approval required`;
  }

  if (preflight.status === "needs-compaction") {
    const input = preflight.inputTokens !== undefined ? formatCount(preflight.inputTokens) : "unknown";
    const candidate = preflight.candidateModelLabel ?? preflight.candidateModel;
    return `${candidate} needs compaction - ${input} tokens, ${formatPercent(preflight.saturation)} of candidate window; compact scratch then retry`;
  }

  const candidate = preflight.candidateModelLabel ?? preflight.candidateModel;
  const input = preflight.inputTokens !== undefined ? formatCount(preflight.inputTokens) : "unknown";
  return `${candidate} hard blocked - ${input} tokens, ${formatPercent(preflight.saturation)} of candidate window`;
}

export function clientUnknownSparkPreflight(threadId: string, detail: string): SparkContextPreflight {
  const profile = modelProfile("unknown");
  return {
    threadId,
    status: "hard-block",
    candidateModel: profile.id,
    candidateModelLabel: profile.label,
    safeBudgetTokens: 0,
    hardGateTokens: 0,
    directStartSaturation: 0.7,
    hardGateSaturation: 0.85,
    automaticStartAllowed: false,
    manualStartAllowed: false,
    compactionRequired: false,
    source: "missing-codex-session",
    detail
  };
}
