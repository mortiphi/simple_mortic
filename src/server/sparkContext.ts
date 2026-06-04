import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

import { modelProfile } from "../shared/modelProfiles.js";
import {
  modelTransitionSafeSaturation,
  modelTransitionWarningSaturation,
  type SparkContextPreflight
} from "../shared/types.js";

type TokenCountCandidate = {
  inputTokens: number;
  modelContextWindow?: number;
  updatedAt?: string;
  file: string;
};

type StatusParseResult = {
  session?: string;
  leftPct: number;
  usedTokens?: number;
  totalTokens?: number;
  source: "scratch-status" | "tui-footer-status";
};

type SessionFileCandidate = {
  file: string;
  mtimeMs: number;
};

type SparkStartDecision = {
  allowed: boolean;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function tokenUsageInputTokens(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  return numberField(value, "input_tokens") ?? numberField(value, "inputTokens");
}

function cleanTerminalText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r/g, "\n");
}

function parseTokenNumber(value: string): number {
  return Number.parseInt(value.replace(/[,\s]/g, ""), 10);
}

function modelWindowEnvKey(model: string): string {
  return `MORTIC_MODEL_WINDOW_${model.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function envCandidateWindow(model: string): number | undefined {
  const raw = process.env[modelWindowEnvKey(model)];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw.replace(/[,_\s]/g, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function candidateWindowForModel(model: string): number | undefined {
  return envCandidateWindow(model) ?? modelProfile(model).contextWindowTokens;
}

export function parseCodexContextStatus(text: string): StatusParseResult | null {
  const clean = cleanTerminalText(text);
  const session = clean.match(/^Session:\s*(.+)$/im)?.[1]?.trim();
  const context = clean.match(/^Context:\s*(\d+(?:\.\d+)?)%\s+left\s+\(([\d,\s]+)\/\s*([\d,\s]+)\)/im);
  if (context) {
    const leftPct = Number.parseFloat(context[1]);
    const usedTokens = parseTokenNumber(context[2]);
    const totalTokens = parseTokenNumber(context[3]);
    if (Number.isFinite(leftPct) && Number.isFinite(usedTokens) && Number.isFinite(totalTokens)) {
      return {
        session,
        leftPct,
        usedTokens,
        totalTokens,
        source: "scratch-status"
      };
    }
  }

  const footer = clean.match(/(\d+(?:\.\d+)?)%\s+context\s+left/i);
  if (footer) {
    const leftPct = Number.parseFloat(footer[1]);
    if (Number.isFinite(leftPct)) {
      return {
        session,
        leftPct,
        source: "tui-footer-status"
      };
    }
  }

  return null;
}

function tokenCountFromLine(line: string, file: string): TokenCountCandidate | null {
  if (!line.includes("\"token_count\"")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const timestamp = stringField(parsed, "timestamp");
  const payload = parsed.payload;
  if (!isRecord(payload) || payload.type !== "token_count") return null;
  const info = payload.info;
  if (!isRecord(info)) return null;

  const lastUsage = info.last_token_usage ?? info.lastTokenUsage;
  const totalUsage = info.total_token_usage ?? info.totalTokenUsage;
  const inputTokens = tokenUsageInputTokens(lastUsage) ?? tokenUsageInputTokens(totalUsage);
  if (inputTokens === undefined) return null;

  return {
    inputTokens,
    modelContextWindow: numberField(info, "model_context_window") ?? numberField(info, "modelContextWindow"),
    updatedAt: timestamp,
    file
  };
}

async function* walkJsonlFiles(root: string): AsyncGenerator<string> {
  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return;
  }

  for await (const entry of dir) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      yield fullPath;
    }
  }
}

async function findSessionFiles(threadId: string): Promise<SessionFileCandidate[]> {
  const roots = [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".codex", "archived_sessions")
  ];
  const candidates: SessionFileCandidate[] = [];

  for (const root of roots) {
    for await (const file of walkJsonlFiles(root)) {
      if (!basename(file).includes(threadId)) continue;
      try {
        const fileStat = await stat(file);
        candidates.push({
          file,
          mtimeMs: fileStat.mtimeMs
        });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }

  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function latestTokenCountFromFile(file: string): Promise<TokenCountCandidate | null> {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  let latest: TokenCountCandidate | null = null;
  for await (const line of lines) {
    const candidate = tokenCountFromLine(line, file);
    if (!candidate) continue;
    if (!latest) {
      latest = candidate;
      continue;
    }
    const latestTime = latest.updatedAt ? Date.parse(latest.updatedAt) : NaN;
    const candidateTime = candidate.updatedAt ? Date.parse(candidate.updatedAt) : NaN;
    if (
      (Number.isFinite(candidateTime) && (!Number.isFinite(latestTime) || candidateTime >= latestTime)) ||
      (!candidate.updatedAt && !latest.updatedAt)
    ) {
      latest = candidate;
    }
  }

  return latest;
}

export async function latestThreadTokenCount(threadId: string): Promise<TokenCountCandidate | null> {
  const sessionFiles = await findSessionFiles(threadId);
  let latest: TokenCountCandidate | null = null;
  for (const candidate of sessionFiles) {
    const tokenCount = await latestTokenCountFromFile(candidate.file);
    if (!tokenCount) continue;
    if (!latest) {
      latest = tokenCount;
      continue;
    }
    const latestTime = latest.updatedAt ? Date.parse(latest.updatedAt) : NaN;
    const candidateTime = tokenCount.updatedAt ? Date.parse(tokenCount.updatedAt) : NaN;
    if (Number.isFinite(candidateTime) && (!Number.isFinite(latestTime) || candidateTime >= latestTime)) {
      latest = tokenCount;
    }
  }
  return latest;
}

function basePreflight(params: {
  threadId: string;
  candidateModel: string;
  candidateWindow?: number;
}): Pick<
  SparkContextPreflight,
  | "threadId"
  | "candidateModel"
  | "candidateModelLabel"
  | "candidateModelContextWindow"
  | "safeBudgetTokens"
  | "hardGateTokens"
  | "modelContextWindowTokens"
  | "directStartSaturation"
  | "hardGateSaturation"
> {
  const profile = modelProfile(params.candidateModel);
  const candidateWindow = params.candidateWindow ?? candidateWindowForModel(profile.id);
  return {
    threadId: params.threadId,
    candidateModel: profile.id,
    candidateModelLabel: profile.label,
    candidateModelContextWindow: candidateWindow,
    safeBudgetTokens: candidateWindow ? Math.floor(candidateWindow * modelTransitionSafeSaturation) : 0,
    hardGateTokens: candidateWindow ? Math.floor(candidateWindow * modelTransitionWarningSaturation) : 0,
    modelContextWindowTokens: candidateWindow,
    directStartSaturation: modelTransitionSafeSaturation,
    hardGateSaturation: modelTransitionWarningSaturation
  };
}

export function classifyModelTransitionTokenCount(params: {
  threadId: string;
  candidateModel: string;
  tokenCount: TokenCountCandidate;
  scratchThreadId?: string;
  source?: SparkContextPreflight["source"];
}): SparkContextPreflight {
  const profile = modelProfile(params.candidateModel);
  const candidateWindow = candidateWindowForModel(profile.id);
  if (!candidateWindow) {
    return unknownModelWindowPreflight(params.threadId, params.candidateModel, "Candidate model context window is unknown, so Mortic will not move this source context into it automatically.");
  }

  const saturation = params.tokenCount.inputTokens / candidateWindow;
  const status =
    saturation >= 1
      ? "hard-block"
      : saturation > modelTransitionWarningSaturation
        ? "needs-compaction"
        : saturation > modelTransitionSafeSaturation
          ? "warning"
          : "safe";
  const input = params.tokenCount.inputTokens.toLocaleString();
  const saturationText = `${Math.round(saturation * 100)}%`;
  const candidate = `${profile.label}'s ${candidateWindow.toLocaleString()} token window`;
  const source = basename(params.tokenCount.file);
  const detail =
    status === "safe"
      ? `${input} context tokens use ${saturationText} of ${candidate}; direct start is allowed. Source: ${source}.`
      : status === "warning"
        ? `${input} context tokens use ${saturationText} of ${candidate}; explicit approval is required before starting this model. Source: ${source}.`
        : status === "needs-compaction"
          ? `${input} context tokens use ${saturationText} of ${candidate}; compact the disposable scratch and re-check before starting this model. Source: ${source}.`
          : `${input} context tokens exceed ${candidate}; this model is hard-blocked unless scratch compaction succeeds and re-checks below the gate. Source: ${source}.`;

  return {
    ...basePreflight({
      threadId: params.threadId,
      candidateModel: params.candidateModel,
      candidateWindow
    }),
    status,
    inputTokens: params.tokenCount.inputTokens,
    saturation,
    scratchThreadId: params.scratchThreadId,
    automaticStartAllowed: status === "safe",
    manualStartAllowed: status === "warning",
    compactionRequired: status === "needs-compaction" || status === "hard-block",
    sourceModelContextWindow: params.tokenCount.modelContextWindow,
    source: params.source ?? "codex-session-token-count",
    updatedAt: params.tokenCount.updatedAt,
    detail
  };
}

export function unknownModelWindowPreflight(threadId: string, candidateModel: string, detail: string): SparkContextPreflight {
  return {
    ...basePreflight({ threadId, candidateModel }),
    status: "hard-block",
    automaticStartAllowed: false,
    manualStartAllowed: false,
    compactionRequired: false,
    source: "unknown-model-window",
    detail
  };
}

export function missingTokenPreflight(
  threadId: string,
  candidateModel: string,
  source: "missing-codex-session" | "missing-token-count" | "compacted-fork-missing-token-usage",
  detail: string,
  scratchThreadId?: string
): SparkContextPreflight {
  return {
    ...basePreflight({ threadId, candidateModel }),
    status: "hard-block",
    scratchThreadId,
    automaticStartAllowed: false,
    manualStartAllowed: false,
    compactionRequired: false,
    source,
    detail
  };
}

export function preflightFromCompactedFork(params: {
  sourceThreadId: string;
  compactedThreadId: string;
  candidateModel: string;
  estimatedInputTokens?: number;
  updatedAt?: string;
}): SparkContextPreflight {
  if (
    params.estimatedInputTokens === undefined ||
    !Number.isFinite(params.estimatedInputTokens) ||
    params.estimatedInputTokens <= 0
  ) {
    return {
      ...missingTokenPreflight(
        params.sourceThreadId,
        params.candidateModel,
        "compacted-fork-missing-token-usage",
        `A disposable compacted fork is ready (${params.compactedThreadId}), but Codex did not expose a positive compacted-context token estimate. Mortic will not start the candidate model automatically.`
      ),
      effectiveThreadId: params.compactedThreadId,
      compactedForkThreadId: params.compactedThreadId,
      updatedAt: params.updatedAt
    };
  }

  const preflight = classifyModelTransitionTokenCount({
    threadId: params.sourceThreadId,
    candidateModel: params.candidateModel,
    tokenCount: {
      inputTokens: params.estimatedInputTokens,
      file: `compacted-fork-${params.compactedThreadId}`,
      updatedAt: params.updatedAt
    },
    scratchThreadId: params.compactedThreadId,
    source: "compacted-fork-token-usage"
  });

  return {
    ...preflight,
    effectiveThreadId: params.compactedThreadId,
    compactedForkThreadId: params.compactedThreadId,
    detail: `${params.estimatedInputTokens.toLocaleString()} estimated compacted-fork tokens use ${Math.round((params.estimatedInputTokens / (preflight.candidateModelContextWindow ?? 1)) * 100)}% of ${preflight.candidateModelLabel}'s ${preflight.candidateModelContextWindow?.toLocaleString() ?? "unknown"} token window. The original source thread is untouched.`
  };
}

export function sparkPreflightStartDecision(
  preflight: SparkContextPreflight,
  allowManualRisk: boolean
): SparkStartDecision {
  if (preflight.automaticStartAllowed) return { allowed: true };
  if (preflight.status === "warning" && preflight.manualStartAllowed && allowManualRisk) return { allowed: true };
  if (preflight.compactionRequired) {
    return {
      allowed: false,
      error: `${preflight.candidateModelLabel} is blocked because the scratch context does not safely fit. Compact the disposable scratch and retry.`
    };
  }
  if (preflight.status === "warning") {
    return {
      allowed: false,
      error: `${preflight.candidateModelLabel} context is in the warning zone. Approve start or compact first.`
    };
  }
  return {
    allowed: false,
    error: `${preflight.candidateModelLabel} context preflight is hard-blocked. ${preflight.detail}`
  };
}

export async function preflightSparkContext(threadId: string, candidateModel = "gpt-5.3-codex-spark"): Promise<SparkContextPreflight> {
  const latest = await latestThreadTokenCount(threadId);
  if (latest) {
    return classifyModelTransitionTokenCount({
      threadId,
      candidateModel,
      tokenCount: latest
    });
  }

  const sessionFiles = await findSessionFiles(threadId);
  if (sessionFiles.length === 0) {
    return missingTokenPreflight(
      threadId,
      candidateModel,
      "missing-codex-session",
      "Could not find a local Codex session file for this thread. Mortic will not start a smaller candidate model automatically."
    );
  }

  return missingTokenPreflight(
    threadId,
    candidateModel,
    "missing-token-count",
    `Found ${sessionFiles.length} local Codex session file${sessionFiles.length === 1 ? "" : "s"}, but none contained token_count telemetry. Mortic will not start a smaller candidate model automatically.`
  );
}
