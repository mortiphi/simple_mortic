export type ModelProfile = {
  id: string;
  label: string;
  contextWindowTokens?: number;
  source: "registry" | "unknown";
};

const MODEL_WINDOWS: Record<string, number> = {
  "gpt-5.5": 256_000,
  "gpt-5.4": 256_000,
  "gpt-5.3-codex": 256_000,
  "gpt-5.4-mini": 127_000,
  "gpt-5.3-codex-spark": 127_000
};

const MODEL_LABELS: Record<string, string> = {
  default: "Thread native model",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex-spark": "Codex Spark",
  "gpt-5.3-codex": "Codex"
};

export function normalizeModelId(model: string | undefined): string {
  const clean = typeof model === "string" ? model.trim() : "";
  return clean || "default";
}

export function modelProfile(model: string | undefined): ModelProfile {
  const id = normalizeModelId(model);
  return {
    id,
    label: MODEL_LABELS[id] ?? id,
    contextWindowTokens: MODEL_WINDOWS[id],
    source: MODEL_WINDOWS[id] === undefined ? "unknown" : "registry"
  };
}

export function modelContextWindow(model: string | undefined): number | undefined {
  return modelProfile(model).contextWindowTokens;
}

export function modelHasKnownSmallerWindow(model: string | undefined): boolean {
  const id = normalizeModelId(model);
  return id !== "default" && modelContextWindow(id) !== undefined;
}
