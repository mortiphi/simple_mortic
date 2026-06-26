import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AppServerConfigMetadata,
  CodexRuntimePolicy,
  CodexStatus,
  ForkCheckpoint,
  ProviderThreadSummary,
  ReasoningEffort,
  RuntimeContextRestore,
  ScratchMode
} from "../shared/types.js";
import { codexAppServerBridge } from "./appServerBridge.js";
import type { CodexProgressTraceEvent, CodexTurnProgress, CodexVoiceActivity } from "./appServerBridge.js";
import { codexCliPtyBridge } from "./cliPtyBridge.js";
import { codexProviderAdapter } from "./providerAdapters.js";
import { voicePrompt } from "./voiceContract.js";

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_CODEX_MODEL = process.env.MORTIC_CODEX_MODEL ?? "default";
const ALLOW_UNVERIFIED_CODEX_FALLBACKS = process.env.MORTIC_ALLOW_UNVERIFIED_CODEX_FALLBACKS === "1";

type ContinueCheck = () => boolean | Promise<boolean>;

export async function getCodexStatus(): Promise<CodexStatus> {
  const status = await codexProviderAdapter.status();
  return {
    available: status.available,
    path: status.path,
    version: status.version,
    error: status.error
  };
}

export function codexTurnPrompt(prompt: string, scratchMode: ScratchMode = "text"): string {
  return scratchMode === "voice" ? voicePrompt(prompt) : prompt;
}

export async function listCodexRecentThreads(options?: {
  limit?: number;
  cwd?: string | string[];
  searchTerm?: string;
}): Promise<ProviderThreadSummary[]> {
  const normalizedSearch = options?.searchTerm?.trim().toLowerCase();
  const cwdFilters = Array.isArray(options?.cwd)
    ? options.cwd.filter(Boolean)
    : options?.cwd
      ? [options.cwd]
      : [];
  const matchesFilters = (thread: ProviderThreadSummary): boolean => {
    if (cwdFilters.length > 0 && !cwdFilters.some((cwd) => thread.cwd === cwd)) return false;
    if (!normalizedSearch) return true;
    return [
      thread.threadName,
      thread.threadId,
      thread.cwd,
      thread.source,
      thread.sourceUri
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedSearch);
  };

  try {
    const appServerThreads = await codexAppServerBridge.listRecentThreads({
      limit: options?.limit,
      cwd: options?.cwd,
      searchTerm: options?.searchTerm
    });
    const indexedThreads = await codexProviderAdapter.listRecentThreads({ limit: 100 }).catch(() => []);
    const indexedByThreadId = new Map(indexedThreads.map((thread) => [thread.threadId, thread]));
    const merged = appServerThreads.map((thread) => {
      const indexed = indexedByThreadId.get(thread.threadId);
      return {
        ...thread,
        threadName: thread.threadName ?? indexed?.threadName,
        cwd: thread.cwd ?? indexed?.cwd,
        source: thread.source ?? indexed?.source,
        updatedAt: thread.updatedAt ?? indexed?.updatedAt
      };
    });
    const appServerThreadIds = new Set(appServerThreads.map((thread) => thread.threadId));
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    return [
      ...merged,
      ...indexedThreads.filter((thread) => !appServerThreadIds.has(thread.threadId))
    ].filter(matchesFilters).slice(0, limit);
  } catch {
    return (await codexProviderAdapter.listRecentThreads({ limit: 100 }))
      .filter(matchesFilters)
      .slice(0, Math.max(1, Math.min(options?.limit ?? 20, 100)));
  }
}

export async function getCodexAppServerConfig(params: {
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  features: AppServerConfigMetadata["runtime"];
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
}): Promise<AppServerConfigMetadata> {
  return await codexAppServerBridge.appServerConfig(params);
}

function reasoningConfigArg(reasoningEffort: ReasoningEffort): string {
  return `model_reasoning_effort="${reasoningEffort}"`;
}

function cleanCodexError(details: string): string {
  const modelVersionMatch = details.match(/The '([^']+)' model requires a newer version of Codex\.[^"}\n]*/);
  if (modelVersionMatch) {
    return `${modelVersionMatch[0]} Mortic now overrides the model by default; choose another model in the UI if this persists.`;
  }

  const errorLines = details
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ERROR:") || line.includes("invalid_request_error") || line.includes("Invalid refresh token"));

  if (errorLines.length > 0) {
    return Array.from(new Set(errorLines)).slice(0, 4).join("\n");
  }

  return details.split("\n").slice(-8).join("\n").trim() || "Codex failed without a readable error message";
}

function extractBridgeErrorMessage(message: string): string {
  try {
    const parsed = JSON.parse(message);
    if (typeof parsed?.error?.message === "string") return parsed.error.message;
    if (typeof parsed?.message === "string") return parsed.message;
  } catch {
    // fall through to the original text
  }

  return message;
}

function isNonRetryableBridgeError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("usagelimitexceeded") ||
    lower.includes("hit your usage limit") ||
    lower.includes("invalid refresh token") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized")
  );
}

export async function runCodexEphemeralTurn(params: {
  threadId: string;
  prompt: string;
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  scratchMode?: ScratchMode;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
}): Promise<string> {
  const workDir = await mkdtemp(path.join(tmpdir(), "mortic-codex-"));
  const outputPath = path.join(workDir, "last-message.md");
  const modelArgs = params.codexModel && params.codexModel !== "default" ? ["-m", params.codexModel] : [];

  try {
    const result = await codexProviderAdapter.runExec(
      [
        "exec",
        "resume",
        "--ephemeral",
        "--skip-git-repo-check",
        ...modelArgs,
        "-c",
        reasoningConfigArg(params.reasoningEffort),
        "--output-last-message",
        outputPath,
        params.threadId,
        "-"
      ],
      {
        stdin: params.prompt,
        timeoutMs: COMMAND_TIMEOUT_MS,
        observer: {
          onStart: (detail) => params.onEvent?.("Codex process started", detail),
          onFirstStdout: (detail) => params.onEvent?.("First stdout", detail),
          onFirstStderr: (detail) => params.onEvent?.("First stderr", detail),
          onExit: (detail) => params.onEvent?.("Codex process exited", detail)
        }
      }
    );

    let finalMessage = "";
    try {
      finalMessage = (await readFile(outputPath, "utf8")).trim();
    } catch {
      finalMessage = result.stdout.trim();
    }

    if (result.code !== 0) {
      const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n\n");
      throw new Error(cleanCodexError(details || `Codex exited with code ${result.code}`));
    }

    if (!finalMessage) {
      throw new Error("Codex completed without a final message");
    }

    await params.onEvent?.("Final response written", `${Buffer.byteLength(finalMessage, "utf8")} bytes`);
    return finalMessage;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function runCodexIsolatedTurn(params: {
  prompt: string;
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
}): Promise<string> {
  const workDir = await mkdtemp(path.join(tmpdir(), "mortic-handoff-"));
  const outputPath = path.join(workDir, "last-message.md");
  const modelArgs = params.codexModel && params.codexModel !== "default" ? ["-m", params.codexModel] : [];

  try {
    const result = await codexProviderAdapter.runExec(
      [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--cd",
        workDir,
        ...modelArgs,
        "-c",
        reasoningConfigArg(params.reasoningEffort),
        "--output-last-message",
        outputPath,
        "-"
      ],
      {
        stdin: params.prompt,
        timeoutMs: COMMAND_TIMEOUT_MS,
        observer: {
          onStart: (detail) => params.onEvent?.("Codex isolated process started", detail),
          onFirstStdout: (detail) => params.onEvent?.("Codex isolated first stdout", detail),
          onFirstStderr: (detail) => params.onEvent?.("Codex isolated first stderr", detail),
          onExit: (detail) => params.onEvent?.("Codex isolated process exited", detail)
        }
      }
    );

    let finalMessage = "";
    try {
      finalMessage = (await readFile(outputPath, "utf8")).trim();
    } catch {
      finalMessage = result.stdout.trim();
    }

    if (result.code !== 0) {
      const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n\n");
      throw new Error(cleanCodexError(details || `Codex exited with code ${result.code}`));
    }

    if (!finalMessage) {
      throw new Error("Codex completed without a final message");
    }

    await params.onEvent?.("Codex isolated final response written", `${Buffer.byteLength(finalMessage, "utf8")} bytes`);
    return finalMessage;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function runCodexTurn(params: {
  threadId: string;
  runtimeContext?: RuntimeContextRestore;
  prompt: string;
  userText?: string;
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  serviceTier?: string | null;
  codexRuntimePolicy?: CodexRuntimePolicy;
  scratchMode?: ScratchMode;
  developerInstructions?: string;
  requireAppServer?: boolean;
  shouldContinue?: ContinueCheck;
  onDelta?: (delta: string, text: string) => void | Promise<void>;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
  onProgress?: (progress: CodexTurnProgress) => void | Promise<void>;
  onVoiceActivity?: (activity: CodexVoiceActivity) => void | Promise<void>;
  onProgressTrace?: (event: CodexProgressTraceEvent) => void | Promise<void>;
}): Promise<string> {
  const model = params.codexModel || DEFAULT_CODEX_MODEL;
  const scratchMode = params.scratchMode ?? "text";
  const cwd = params.runtimeContext?.effectiveCwd ?? process.cwd();
  const prompt = codexTurnPrompt(params.prompt, scratchMode);
  const shouldContinue = async () => (params.shouldContinue ? await params.shouldContinue() : true);

  if (!(await shouldContinue())) {
    throw new Error("Codex turn interrupted");
  }
  await params.onEvent?.("Runtime context", `${params.runtimeContext?.status ?? "fallback"} cwd ${cwd}`);

  try {
    await params.onEvent?.("Bridge selected", "persistent codex app-server scratch");
    const text = await codexAppServerBridge.runTurn({
      sourceThreadId: params.threadId,
      cwd,
      prompt,
      reasoningEffort: params.reasoningEffort,
      model,
      serviceTier: params.serviceTier,
      codexRuntimePolicy: params.codexRuntimePolicy,
      scratchMode,
      developerInstructions: params.developerInstructions,
      onDelta: params.onDelta,
      onEvent: params.onEvent,
      onProgress: params.onProgress,
      onVoiceActivity: params.onVoiceActivity,
      onProgressTrace: params.onProgressTrace
    });

    if (!text) {
      throw new Error("Codex app-server completed without response text");
    }

    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.onEvent?.("App-server bridge failed", message);
    if (!(await shouldContinue())) {
      throw new Error("Codex turn interrupted");
    }

    if (isNonRetryableBridgeError(message)) {
      throw new Error(extractBridgeErrorMessage(message));
    }
    if (params.requireAppServer) {
      throw new Error(extractBridgeErrorMessage(message));
    }
    if (model !== "default") {
      throw new Error(
        `Non-native model scratch requires the validated app-server bridge. Mortic disabled CLI fallback so it cannot create a visible fork from the source thread. Details: ${extractBridgeErrorMessage(message)}`
      );
    }
  }

  try {
    if (!(await shouldContinue())) {
      throw new Error("Codex turn interrupted");
    }
    await params.onEvent?.("Bridge selected", "verified codex CLI fork fallback");
    const text = await codexCliPtyBridge.runTurn({
      sourceThreadId: params.threadId,
      cwd,
      prompt,
      userText: params.userText,
      reasoningEffort: params.reasoningEffort,
      model,
      onEvent: params.onEvent
    });

    if (!text) {
      throw new Error("Codex CLI completed without response text");
    }

    return text;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.onEvent?.("CLI fork fallback failed", message);
    if (!(await shouldContinue())) {
      throw new Error("Codex turn interrupted");
    }

    if (!ALLOW_UNVERIFIED_CODEX_FALLBACKS) {
      throw new Error(
        `Mortic refused to continue without a validated scratch thread. This protects the source thread from voice turns. Details: ${message}`
      );
    }
  }

  if (!(await shouldContinue())) {
    throw new Error("Codex turn interrupted");
  }
  await params.onEvent?.("Unsafe fallback enabled", "MORTIC_ALLOW_UNVERIFIED_CODEX_FALLBACKS=1");
  return runCodexEphemeralTurn({ ...params, prompt });
}

export async function prewarmCodexScratch(params: {
  threadId: string;
  runtimeContext?: RuntimeContextRestore;
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  serviceTier?: string | null;
  codexRuntimePolicy?: CodexRuntimePolicy;
  scratchMode?: ScratchMode;
  confirmationPrompt?: string;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
}): Promise<{ confirmation?: string }> {
  return await codexAppServerBridge.warmScratch({
    sourceThreadId: params.threadId,
    cwd: params.runtimeContext?.effectiveCwd ?? process.cwd(),
    model: params.codexModel || DEFAULT_CODEX_MODEL,
    serviceTier: params.serviceTier,
    codexRuntimePolicy: params.codexRuntimePolicy,
    reasoningEffort: params.reasoningEffort,
    scratchMode: params.scratchMode ?? "text",
    confirmationPrompt: params.confirmationPrompt,
    onEvent: params.onEvent
  });
}

export async function prepareCodexContextScratch(params: {
  threadId: string;
  runtimeContext?: RuntimeContextRestore;
  reasoningEffort: ReasoningEffort;
  scratchMode?: ScratchMode;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
}): Promise<{
  scratchThreadId: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    modelContextWindow?: number;
    updatedAt: string;
  };
}> {
  return await codexAppServerBridge.prepareContextScratch({
    sourceThreadId: params.threadId,
    cwd: params.runtimeContext?.effectiveCwd ?? process.cwd(),
    reasoningEffort: params.reasoningEffort,
    scratchMode: params.scratchMode ?? "text",
    onEvent: params.onEvent
  });
}

export async function compactCodexThread(params: {
  threadId: string;
  runtimeContext?: RuntimeContextRestore;
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  scratchMode?: ScratchMode;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
}): Promise<{
  turnId: string;
  compactedThreadId: string;
  estimatedInputTokens?: number;
  updatedAt?: string;
}> {
  const result = await codexAppServerBridge.compactThread({
    sourceThreadId: params.threadId,
    cwd: params.runtimeContext?.effectiveCwd ?? process.cwd(),
    targetModel: params.codexModel || DEFAULT_CODEX_MODEL,
    compactionModel: DEFAULT_CODEX_MODEL,
    reasoningEffort: params.reasoningEffort,
    scratchMode: params.scratchMode ?? "text",
    onEvent: params.onEvent
  });
  const estimatedInputTokens =
    typeof result.tokenUsage?.outputTokens === "number" &&
    Number.isFinite(result.tokenUsage.outputTokens) &&
    result.tokenUsage.outputTokens > 0
      ? result.tokenUsage.outputTokens
      : typeof result.tokenUsage?.inputTokens === "number" &&
          Number.isFinite(result.tokenUsage.inputTokens) &&
          result.tokenUsage.inputTokens > 0
        ? result.tokenUsage.inputTokens
        : undefined;
  return {
    turnId: result.turnId,
    compactedThreadId: result.compactedThreadId,
    // The app-server token usage for the compaction turn is not a perfect future
    // context counter. Zero or missing output tokens means Codex did not expose a
    // usable compacted-context estimate, so candidate-model preflight must remain blocked.
    estimatedInputTokens,
    updatedAt: result.tokenUsage?.updatedAt
  };
}

export function getCodexSparkCompactedBase(params: {
  threadId: string;
  runtimeContext?: RuntimeContextRestore;
  codexModel: string;
  reasoningEffort: ReasoningEffort;
  scratchMode: ScratchMode;
}): {
  compactedThreadId: string;
  estimatedInputTokens?: number;
  updatedAt?: string;
} | null {
  const state = codexAppServerBridge.getCompactedSparkBase({
    sourceThreadId: params.threadId,
    cwd: params.runtimeContext?.effectiveCwd ?? process.cwd(),
    model: params.codexModel,
    reasoningEffort: params.reasoningEffort,
    scratchMode: params.scratchMode
  });
  if (!state) return null;
  const estimatedInputTokens =
    typeof state.tokenUsage?.outputTokens === "number" &&
    Number.isFinite(state.tokenUsage.outputTokens) &&
    state.tokenUsage.outputTokens > 0
      ? state.tokenUsage.outputTokens
      : undefined;
  return {
    compactedThreadId: state.compactedThreadId,
    estimatedInputTokens,
    updatedAt: state.tokenUsage?.updatedAt ?? state.createdAt
  };
}

export async function resetCodexScratch(): Promise<void> {
  await codexCliPtyBridge.reset();
  await codexAppServerBridge.resetScratch();
}

export async function shutdownCodexBridges(reason?: string): Promise<void> {
  await codexCliPtyBridge.reset();
  await codexAppServerBridge.shutdown(reason);
}

export async function interruptCodexScratch(onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
  await codexAppServerBridge.interrupt(onEvent);
  await codexCliPtyBridge.reset();
}

export function createHandoffPrompt(params: {
  sourceUri: string;
  transcriptMarkdown: string;
  checkpoint?: ForkCheckpoint;
}): string {
  const checkpointInstruction = params.checkpoint
    ? `Checkpoint context for the conversion only:
- A disposable scratch fork was created at ${params.checkpoint.forkedAt}.
- Prioritize decisions, actionables, risks, tests, conclusions, and explicit user corrections after this checkpoint.
- Use inherited/source context only as background when it is necessary to make the next prompt coherent.
- The generated prompts must not mention the checkpoint, scratch fork, thread IDs, or this conversion process.`
    : `Checkpoint context for the conversion only:
- Prioritize the concrete turns captured in Mortic.
- Use inherited/source context only as background when it is necessary to make the next prompt coherent.
- The generated prompts must not mention Mortic, scratch forks, thread IDs, or this conversion process.`;
  return `Convert the captured Mortic chat into two paste-ready instruction prompts for the user's original Codex chat.

This is not a recap task. Read the chat, infer what the user wants done next, pull out the actionables, constraints, decisions, open risks, and tests, then write the next message the user should paste into Codex.

${checkpointInstruction}

Return markdown with exactly these headings:
# Short Prompt
# Full Prompt

Rules:
- Write each section as the user's direct instruction to Codex, not as a summary of a conversation.
- Do not mention Mortic, a scratch session, a transcript, "the scratch says", notes, a source thread, or any thread URI.
- Do not say "we discussed", "the conversation", "the notes", "the transcript", "the scratch", "the session", "summary", "recap", or "handoff".
- Do not frame this as a report about another chat.
- Each section must be actionable in the current chat.
- The short prompt should be one concise instruction paragraph.
- The full prompt should be a fuller instruction prompt with concrete next tasks, constraints, implementation details, validation steps, and any risks to check.
- Prefer imperative language: "Please implement...", "Please inspect...", "Please fix...", "Please verify...".
- If several actionables exist, the full prompt may use bullets, but every bullet should be an instruction or requirement, not a historical recap.
- Do not organize the answer as "What I discussed", "Decisions", "Requests", "Context", or "Summary".
- Do not claim code was changed unless the transcript explicitly says so.
- Do not include raw transcript content. Only include distilled actionables and required context.
- If the chat has no clear implementation request, produce a prompt asking Codex to help decide the next concrete step from the constraints.

Captured chat to convert:
${params.transcriptMarkdown}`;
}
