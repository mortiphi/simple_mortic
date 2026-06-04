import type { ReasoningEffort } from "./types.js";

export function modelRequiresLowReasoning(model: string | undefined): boolean {
  return typeof model === "string" && model.toLowerCase().includes("spark");
}

export function effectiveReasoningForModel(model: string | undefined, effort: ReasoningEffort): ReasoningEffort {
  if (modelRequiresLowReasoning(model) && (effort === "none" || effort === "minimal")) return "low";
  return effort;
}
