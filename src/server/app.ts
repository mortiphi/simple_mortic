import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";

import {
  DEFAULT_CODEX_MODEL,
  compactCodexThread,
  createHandoffPrompt,
  getCodexSparkCompactedBase,
  getCodexStatus,
  interruptCodexScratch,
  prepareCodexContextScratch,
  prewarmCodexScratch,
  resetCodexScratch,
  runCodexIsolatedTurn,
  runCodexTurn
} from "./codex.js";
import type { SessionStorage } from "./storage.js";
import type { ProjectStore } from "./projectStorage.js";
import { createProjectStore, projectDirForWorkspace } from "./projectStorage.js";
import { codexProviderAdapter } from "./providerAdapters.js";
import { syncVendoredSkills } from "./skillSync.js";
import { parseThreadUri } from "../shared/threadUri.js";
import { defaultScratchSettings } from "../shared/scratchDefaults.js";
import { estimateTextTokens } from "../shared/tokenEstimate.js";
import { parseMorticVoice } from "../shared/voiceResponse.js";
import { effectiveReasoningForModel } from "../shared/modelPolicy.js";
import { modelProfile } from "../shared/modelProfiles.js";
import {
  prewarmReadyText,
  prewarmThreadName
} from "../shared/prewarmConfirmation.js";
import {
  reasoningEfforts,
  scratchModes,
  extractionStatuses,
  extractedItemTypes,
  providerForkContinuations,
  ttsProviders,
  type AudioHealthRequest,
  type ApproveCompilationRequest,
  type DeepgramHealthResponse,
  type DraftCompilationImportRequest,
  type ElevenLabsHealthResponse,
  type ForkCheckpoint,
  type HandoffRequest,
  type LiveKitTokenRequest,
  type MorticSession,
  type OnboardingStatusResponse,
  type PrewarmRequest,
  type ProgressSpeechTrace,
  type ProviderForkAccessRequest,
  type ProviderForkAccessResponse,
  type ReasoningEffort,
  type RuntimeContextRestore,
  type ScratchMode,
  type SkillSyncStatus,
  type SparkContextCompactRequest,
  type SttTranscriptionRequest,
  type SourceThreadRequest,
  type TtsProvider,
  type TtsSynthesisRequest,
  type TurnLogEntry,
  type TurnRequest,
  type TurnRun,
  type UpdateExtractedItemRequest
} from "../shared/types.js";
import {
  classifyModelTransitionTokenCount,
  preflightFromCompactedFork,
  preflightSparkContext,
  sparkPreflightStartDecision
} from "./sparkContext.js";
import { getLiveKitStatus, createLiveKitToken } from "./livekit.js";
import { configuredMaxSttPayloadBytes, getSttStatus, transcribeAudioWithFallback, type SttFallbackError } from "./stt.js";
import {
  getTtsStatus,
  handleDeepgramWsSession,
  handleElevenLabsWsSession,
  handleInworldWsSession,
  probeDeepgramTts,
  probeElevenLabsTts,
  streamDeepgramTts,
  streamElevenLabsTts
} from "./tts.js";

type MorticServerOptions = {
  storage: SessionStorage;
  projectStore?: ProjectStore;
  staticDir?: string;
  runtimeContext?: RuntimeContextRestore;
  projectTitle?: string;
  resolveRuntimeContext?: (params: { sourceUri: string; threadId: string }) => Promise<RuntimeContextRestore>;
};

const DEFAULT_REASONING_EFFORT: ReasoningEffort = defaultScratchSettings.reasoningEffort;
const DEFAULT_SCRATCH_MODE: ScratchMode = "text";

type EffectiveScratchSettings = {
  scratchMode: ScratchMode;
  reasoningEffort: ReasoningEffort;
  codexModel: string;
  voiceCaveman: boolean;
};

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && reasoningEfforts.includes(value as ReasoningEffort);
}

function isScratchMode(value: unknown): value is ScratchMode {
  return typeof value === "string" && scratchModes.includes(value as ScratchMode);
}

function isTtsProvider(value: unknown): value is TtsProvider {
  return typeof value === "string" && ttsProviders.includes(value as TtsProvider);
}

function isExtractionStatus(value: unknown): value is (typeof extractionStatuses)[number] {
  return typeof value === "string" && extractionStatuses.includes(value as (typeof extractionStatuses)[number]);
}

function isExtractedItemType(value: unknown): value is (typeof extractedItemTypes)[number] {
  return typeof value === "string" && extractedItemTypes.includes(value as (typeof extractedItemTypes)[number]);
}

function normalizeCodexModel(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_CODEX_MODEL;
  const clean = value.trim();
  return clean || DEFAULT_CODEX_MODEL;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function estimateTokens(bytes: number): number {
  return estimateTextTokens("x".repeat(bytes));
}

function formatMetricMs(ms: number | undefined): string {
  if (typeof ms !== "number") return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatSignedMetricMs(ms: number | undefined): string {
  if (typeof ms !== "number") return "-";
  return `${ms >= 0 ? "+" : "-"}${formatMetricMs(Math.abs(ms))}`;
}

function effectiveScratchSettings(params: {
  scratchMode: ScratchMode;
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  voiceCaveman?: boolean;
}): EffectiveScratchSettings {
  const codexModel = normalizeCodexModel(params.codexModel);
  const requestedReasoning =
    params.scratchMode === "voice" && params.reasoningEffort === "minimal"
      ? DEFAULT_REASONING_EFFORT
      : params.reasoningEffort;
  return {
    scratchMode: params.scratchMode,
    reasoningEffort: effectiveReasoningForModel(codexModel, requestedReasoning),
    codexModel,
    voiceCaveman: params.scratchMode === "voice" && params.voiceCaveman === true
  };
}

function needsModelTransitionPreflight(model: string): boolean {
  return modelProfile(model).id !== "default";
}

async function effectiveSparkPreflight(threadId: string, settings?: EffectiveScratchSettings, runtimeContext?: RuntimeContextRestore) {
  const candidateModel = settings?.codexModel ?? "gpt-5.3-codex-spark";
  const compacted = settings
    ? getCodexSparkCompactedBase({
        threadId,
        runtimeContext,
        codexModel: settings.codexModel,
        reasoningEffort: settings.reasoningEffort,
        scratchMode: settings.scratchMode,
        voiceCaveman: settings.voiceCaveman
      })
    : null;
  if (compacted) {
    return preflightFromCompactedFork({
      sourceThreadId: threadId,
      compactedThreadId: compacted.compactedThreadId,
      candidateModel,
      estimatedInputTokens: compacted.estimatedInputTokens,
      updatedAt: compacted.updatedAt
    });
  }
  if (settings) {
    const scratch = await prepareCodexContextScratch({
      threadId,
      runtimeContext,
      reasoningEffort: settings.reasoningEffort,
      scratchMode: settings.scratchMode,
      voiceCaveman: settings.voiceCaveman
    });
    const scratchInputTokens = scratch.tokenUsage?.inputTokens ?? scratch.tokenUsage?.totalTokens;
    if (typeof scratchInputTokens === "number" && Number.isFinite(scratchInputTokens) && scratchInputTokens > 0) {
      return classifyModelTransitionTokenCount({
        threadId,
        candidateModel,
        scratchThreadId: scratch.scratchThreadId,
        source: "scratch-token-count",
        tokenCount: {
          inputTokens: scratchInputTokens,
          modelContextWindow: scratch.tokenUsage?.modelContextWindow,
          updatedAt: scratch.tokenUsage?.updatedAt,
          file: `scratch-${scratch.scratchThreadId}`
        }
      });
    }
    const fallback = await preflightSparkContext(threadId, candidateModel);
    return {
      ...fallback,
      scratchThreadId: scratch.scratchThreadId,
      detail: `${fallback.detail} A disposable scratch fork was created first (${scratch.scratchThreadId}), but Codex did not expose scratch token usage yet; Mortic used the latest local session token telemetry for the fit check.`
    };
  }
  return await preflightSparkContext(threadId, candidateModel);
}

function logEntry(startMs: number, label: string, detail?: string): TurnLogEntry {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startMs,
    label,
    detail
  };
}

function featureConfig() {
  return {
    speechProjection: process.env.MORTIC_SPEECH_PROJECTION !== "0",
    progressSounds: process.env.MORTIC_PROGRESS_SOUNDS === "1",
    progressSpeech: process.env.MORTIC_PROGRESS_SPEECH === "1",
    progressSpeechTrace: process.env.MORTIC_PROGRESS_SPEECH_TRACE === "1" || process.env.MORTIC_PROGRESS_SPEECH === "1"
  };
}

const MAX_PROGRESS_STATUSES_PER_TURN = 3;
const PROGRESS_SPEECH_THROTTLE_MS = 2400;
const FILLER_PROGRESS_SPEECH = new Set(["I'm writing the answer now."]);

function progressSpeechTextForLabel(label: string): string | null {
  switch (label) {
    case "Running command":
      return "I'm running a command.";
    case "Reading tool output":
      return "I'm reading tool output.";
    case "Command finished":
      return "Command finished.";
    case "Checking tool":
      return "I'm checking a tool.";
    case "Searching":
      return "I'm searching.";
    case "Preparing changes":
      return "I'm preparing changes.";
    case "Thinking":
      return "I'm thinking through it.";
    case "Checking project":
      return "I'm checking the project.";
    default:
      return null;
  }
}

function isUnsafeProgressSpeech(text: string): boolean {
  return /```|stack trace|traceback|^\s*at\s+\S+|\b(error|exception):|\/Users\/|src\/|node_modules|[{}\[\]<>]|;|\n/i.test(text);
}

function finalizeProgressTrace(trace: ProgressSpeechTrace): ProgressSpeechTrace {
  const reasons: string[] = [];
  const firstDeltaMs = trace.firstAssistantDeltaMs;
  const spoken = trace.spokenStatuses;
  const usefulMappedBeforeDelta = trace.mappedEvents.filter((event) => {
    if (event.label === "Writing answer") return false;
    return firstDeltaMs === undefined || event.elapsedMs <= firstDeltaMs;
  });
  const spokenSet = new Set(spoken);

  if (spoken.includes("I'm writing the answer now.")) {
    reasons.push("agent-message filler was spoken");
  }
  if (spoken.length === 1 && FILLER_PROGRESS_SPEECH.has(spoken[0] ?? "")) {
    reasons.push("only spoken status was filler");
  }
  if (firstDeltaMs !== undefined && trace.decisions.some((decision) => decision.decision === "spoken" && decision.elapsedMs > firstDeltaMs)) {
    reasons.push("progress status spoken after first assistant delta");
  }
  if (spoken.some(isUnsafeProgressSpeech)) {
    reasons.push("unsafe internal content was spoken");
  }
  if (spoken.length > MAX_PROGRESS_STATUSES_PER_TURN) {
    reasons.push("more than three statuses were spoken");
  }
  if (spokenSet.size !== spoken.length) {
    reasons.push("progress statuses repeated");
  }

  const verdict = reasons.length > 0
    ? "fail"
    : usefulMappedBeforeDelta.length === 0
      ? "warn"
      : "pass";
  const finalReasons = reasons.length > 0
    ? reasons
    : verdict === "warn"
      ? ["no useful lifecycle events arrived before first assistant delta"]
      : ["spoken statuses correspond to real pre-delta lifecycle events"];

  return {
    ...trace,
    verdict,
    reasons: finalReasons
  };
}

async function addTurnLog(
  storage: SessionStorage,
  turnId: string,
  startMs: number,
  label: string,
  detail?: string,
  updates?: Partial<TurnRun>
): Promise<MorticSession> {
  return await storage.updateActiveTurn((turn) => {
    if (!turn || turn.id !== turnId) return turn;
    if (turn.status !== "running" && updates?.status !== "interrupted") return turn;

    return {
      ...turn,
      ...updates,
      updatedAt: new Date().toISOString(),
      logs: [...turn.logs, logEntry(startMs, label, detail)],
      metrics: {
        ...turn.metrics,
        ...updates?.metrics
      }
    };
  });
}

function audioHealthDetail(metrics: TurnRun["metrics"]): string {
  const provider = metrics.ttsProvider ?? "unknown";
  const streamed = metrics.streamedChars ?? 0;
  const final = metrics.finalChars ?? "-";
  const queued = metrics.queuedChars ?? 0;
  const spoken = metrics.spokenChars ?? 0;
  const chunks = metrics.spokenChunks ?? 0;
  const queuedRanges = metrics.queuedRanges ? ` queued ranges ${metrics.queuedRanges}` : "";
  const spokenRanges = metrics.spokenRanges ? ` spoken ranges ${metrics.spokenRanges}` : "";
  const status = metrics.ttsError ? `tts error: ${metrics.ttsError}` : "tts ok";
  const isStreamingWsTts = metrics.ttsProvider === "elevenlabs-ws" || metrics.ttsProvider === "inworld-ws";
  const isBufferedTts = metrics.ttsProvider === "deepgram" || isStreamingWsTts;
  const serverToClient = metrics.firstClientDeltaMs !== undefined && metrics.firstDeltaMs !== undefined
    ? Math.max(0, metrics.firstClientDeltaMs - metrics.firstDeltaMs)
    : undefined;
  const clientToQueued = metrics.firstSpeechQueuedMs !== undefined && metrics.firstClientDeltaMs !== undefined
    ? Math.max(0, metrics.firstSpeechQueuedMs - metrics.firstClientDeltaMs)
    : undefined;
  const queuedToSpeech = metrics.firstSpeechStartMs !== undefined && metrics.firstSpeechQueuedMs !== undefined
    ? Math.max(0, metrics.firstSpeechStartMs - metrics.firstSpeechQueuedMs)
    : undefined;
  const queuedToTtsRequest = metrics.firstTtsRequestMs !== undefined && metrics.firstSpeechQueuedMs !== undefined
    ? Math.max(0, metrics.firstTtsRequestMs - metrics.firstSpeechQueuedMs)
    : undefined;
  const ttsRequestToResolved = metrics.firstTtsResolvedMs !== undefined && metrics.firstTtsRequestMs !== undefined
    ? Math.max(0, metrics.firstTtsResolvedMs - metrics.firstTtsRequestMs)
    : undefined;
  const localGaps = ` · client delta ${formatMetricMs(metrics.firstClientDeltaMs)} · server->client ${formatMetricMs(serverToClient)} · client->queued ${formatMetricMs(clientToQueued)} · queued->tts ${formatMetricMs(queuedToTtsRequest)} · tts resolve ${formatMetricMs(ttsRequestToResolved)} · queued->speech ${formatMetricMs(queuedToSpeech)}`;
  const bufferedTiming = isBufferedTts
    ? ` · ${isStreamingWsTts ? "ws connect" : "tts response"} ${formatMetricMs(metrics.ttsConnectMs)} · audio bytes ${formatMetricMs(metrics.firstAudioChunkMs)} · audio play ${formatMetricMs(metrics.firstAudioPlayMs)}`
      : "";
  const buffer = metrics.audioBufferUnderruns ? ` · underruns ${metrics.audioBufferUnderruns}` : "";
  const close = metrics.ttsCloseCode ? ` · close ${metrics.ttsCloseCode}${metrics.ttsCloseReason ? ` ${metrics.ttsCloseReason}` : ""}` : "";
  const timing = `text first ${formatMetricMs(metrics.firstDeltaMs)}${localGaps} · visible ${formatMetricMs(metrics.firstVisibleTextMs)} · speakable ${formatMetricMs(metrics.firstSpeakableTextMs)} · queued ${formatMetricMs(metrics.firstSpeechQueuedMs)} · speech start ${formatMetricMs(metrics.firstSpeechStartMs)}${bufferedTiming} · final ${formatMetricMs(metrics.finalTextMs)} · speech after final ${formatSignedMetricMs(metrics.speechAfterFinalMs)}${buffer}${close}`;
  const providerStatus = metrics.ttsProviderStatus ? ` provider ${metrics.ttsProviderStatus}` : "";
  return `${provider}: ${timing}; streamed ${streamed} chars, final ${final} chars, queued ${queued} chars, spoken ${spoken} chars, chunks ${chunks}, ${status}${providerStatus}${queuedRanges}${spokenRanges}`;
}

async function updateAudioHealth(
  storage: SessionStorage,
  turnId: string,
  body: AudioHealthRequest
): Promise<MorticSession> {
  return await storage.updateActiveTurn((turn) => {
    if (!turn || turn.id !== turnId) return turn;

    const startMs = Number.isNaN(Date.parse(turn.createdAt)) ? Date.now() : Date.parse(turn.createdAt);
    const ttsError = typeof body.ttsError === "string" && body.ttsError.trim() ? body.ttsError.trim().slice(0, 240) : undefined;
    const speechAfterFinalMs = typeof body.speechAfterFinalMs === "number" && Number.isFinite(body.speechAfterFinalMs)
      ? Math.floor(body.speechAfterFinalMs)
      : turn.metrics.speechAfterFinalMs;
    const metrics: TurnRun["metrics"] = {
      ...turn.metrics,
      streamedChars: nonNegativeInt(body.streamedChars) ?? turn.metrics.streamedChars ?? 0,
      finalChars: nonNegativeInt(body.finalChars) ?? turn.metrics.finalChars,
      queuedChars: nonNegativeInt(body.queuedChars) ?? turn.metrics.queuedChars ?? 0,
      spokenChars: nonNegativeInt(body.spokenChars) ?? turn.metrics.spokenChars ?? 0,
      queuedRanges: typeof body.queuedRanges === "string" ? body.queuedRanges.slice(0, 600) : turn.metrics.queuedRanges,
      spokenRanges: typeof body.spokenRanges === "string" ? body.spokenRanges.slice(0, 600) : turn.metrics.spokenRanges,
      spokenChunks: nonNegativeInt(body.spokenChunks) ?? turn.metrics.spokenChunks ?? 0,
      ttsProvider: body.provider,
      ttsError,
      ttsProviderStatus: typeof body.ttsProviderStatus === "string" ? body.ttsProviderStatus.slice(0, 160) : turn.metrics.ttsProviderStatus,
      firstClientDeltaMs: nonNegativeInt(body.firstClientDeltaMs) ?? turn.metrics.firstClientDeltaMs,
      firstVisibleTextMs: nonNegativeInt(body.firstVisibleTextMs) ?? turn.metrics.firstVisibleTextMs,
      firstSpeakableTextMs: nonNegativeInt(body.firstSpeakableTextMs) ?? turn.metrics.firstSpeakableTextMs,
      firstSpeechQueuedMs: nonNegativeInt(body.firstSpeechQueuedMs) ?? turn.metrics.firstSpeechQueuedMs,
      firstTtsRequestMs: nonNegativeInt(body.firstTtsRequestMs) ?? turn.metrics.firstTtsRequestMs,
      firstTtsResolvedMs: nonNegativeInt(body.firstTtsResolvedMs) ?? turn.metrics.firstTtsResolvedMs,
      firstSpeechStartMs: nonNegativeInt(body.firstSpeechStartMs) ?? turn.metrics.firstSpeechStartMs,
      firstSpeechEndMs: nonNegativeInt(body.firstSpeechEndMs) ?? turn.metrics.firstSpeechEndMs,
      ttsConnectMs: nonNegativeInt(body.ttsConnectMs) ?? turn.metrics.ttsConnectMs,
      firstAudioChunkMs: nonNegativeInt(body.firstAudioChunkMs) ?? turn.metrics.firstAudioChunkMs,
      firstAudioPlayMs: nonNegativeInt(body.firstAudioPlayMs) ?? turn.metrics.firstAudioPlayMs,
      audioBufferUnderruns: nonNegativeInt(body.audioBufferUnderruns) ?? turn.metrics.audioBufferUnderruns,
      ttsCloseCode: nonNegativeInt(body.ttsCloseCode) ?? turn.metrics.ttsCloseCode,
      ttsCloseReason: typeof body.ttsCloseReason === "string" ? body.ttsCloseReason.slice(0, 160) : turn.metrics.ttsCloseReason,
      finalTextMs: nonNegativeInt(body.finalTextMs) ?? turn.metrics.finalTextMs,
      speechAfterFinalMs
    };
    const detail = audioHealthDetail(metrics);
    const entry = logEntry(startMs, "Audio health", detail);
    const existingLogIndex = turn.logs.findIndex((log) => log.label === "Audio health");
    const logs =
      existingLogIndex === -1
        ? [...turn.logs, entry]
        : turn.logs.map((log, index) => (index === existingLogIndex ? entry : log));

    return {
      ...turn,
      updatedAt: new Date().toISOString(),
      logs,
      metrics
    };
  });
}

type HandoffPrompts = {
  handoff: string;
  shortPrompt: string;
  fullPrompt: string;
};

function combineHandoffPrompts(shortPrompt: string, fullPrompt: string): string {
  return `# Short Prompt

${shortPrompt.trim()}

# Full Prompt

${fullPrompt.trim()}`;
}

const HANDOFF_DEVELOPER_INSTRUCTIONS = `This is a disposable Mortic handoff generation fork from the user's main source thread.
Do not use the Mortic voice NDJSON contract.
Return markdown only, with exactly these headings:
# Short Prompt
# Full Prompt
Write both sections as direct instructions the user can paste into the original Codex thread.
Do not mention Mortic, scratch forks, source threads, thread IDs, transcript processing, summaries, recaps, or this conversion process.
Use inherited source-thread context only when needed to make the next instruction coherent.`;

function voiceRepairPrompt(params: { error: string; rawText: string }): string {
  const raw = params.rawText.trim().slice(0, 6000);
  return `Your previous response did not satisfy the Mortic voice output contract.

Rewrite the same answer as exactly two newline-delimited JSON objects and nothing else.

Line one must be a valid JSON object with "type":"speak" and a string "text" field.
Line two must be a valid JSON object with "type":"read" and a string "markdown" field.

Rules:
- The first line's text must be the complete conversational answer, safe to read aloud.
- The second line's markdown must be the readable screen version with exact details.
- Escape newlines inside markdown as \\n.
- Do not output Markdown fences, labels, bullets outside JSON, examples, wrapper prose, or placeholder text.

Parser error: ${params.error}

Previous response:
${raw}`;
}

function prewarmConfirmationText(raw: string, scratchMode: ScratchMode): string {
  if (scratchMode !== "voice") return raw.trim();
  const parsed = parseMorticVoice(raw);
  if (!parsed.ok) {
    throw new Error(`Prewarm confirmation was not valid Mortic voice output: ${parsed.error}`);
  }
  return parsed.parts.spokenText;
}

function parseHandoffPrompts(markdown: string): HandoffPrompts {
  const shortMatch = markdown.match(/# Short Prompt\s+([\s\S]*?)(?=\n# Full Prompt\s+|$)/i);
  const fullMatch = markdown.match(/# Full Prompt\s+([\s\S]*)$/i);
  const shortPrompt = (shortMatch?.[1] ?? "").trim();
  const fullPrompt = (fullMatch?.[1] ?? markdown).trim();

  if (shortPrompt && fullPrompt) {
    return {
      handoff: combineHandoffPrompts(shortPrompt, fullPrompt),
      shortPrompt,
      fullPrompt
    };
  }

  return {
    handoff: markdown.trim(),
    shortPrompt: markdown.trim(),
    fullPrompt: markdown.trim()
  };
}

function localHandoff(_sourceUri: string, transcriptMarkdown: string): HandoffPrompts {
  const shortPrompt = "Please read the captured working notes, extract the concrete actionables, and continue with the next implementation step in this chat without treating the notes as a recap.";
  const fullPrompt = `Please use the captured working notes below only as input for deciding what to do next. Extract the concrete actionables, constraints, risks, and validation steps, then continue in this chat with the next implementation step. Do not summarize the notes back to me, do not describe this as another conversation, and do not assume code changed unless the notes explicitly say so.

Captured working notes:

${transcriptMarkdown}`;
  return {
    handoff: combineHandoffPrompts(shortPrompt, fullPrompt),
    shortPrompt,
    fullPrompt
  };
}

function handoffTranscriptOnly(markdown: string): string {
  return markdown
    .replace(/^Source thread:.*(?:\n|$)/im, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function checkpointFromPrewarmLogs(params: {
  session: MorticSession;
  scratchMode: ScratchMode;
  logs: Array<{ label: string; detail?: string; elapsedMs: number }>;
  checkpointInstruction?: string;
}): ForkCheckpoint | undefined {
  if (params.scratchMode !== "voice") return undefined;
  const forkLog = [...params.logs].reverse().find((log) => log.label.includes("scratch fork validated") && log.detail);
  const turnLog = [...params.logs].reverse().find((log) => log.label.includes("turn started") && log.detail);
  const scratchThreadId = forkLog?.detail?.match(/^([0-9a-f-]{20,})\s+forked from/i)?.[1];
  if (!scratchThreadId || scratchThreadId === params.session.threadId) return undefined;
  return {
    sourceThreadId: params.session.threadId,
    scratchThreadId,
    forkedAt: new Date().toISOString(),
    checkpointInstruction: params.checkpointInstruction,
    firstScratchTurnId: turnLog?.detail?.trim() || undefined
  };
}

export async function createMorticServer(options: MorticServerOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: configuredMaxSttPayloadBytes() + 512 * 1024
  });
  const turnStreams = new Map<string, Set<(event: unknown) => void>>();
  const turnReplay = new Map<string, { text: string; updatedAt: string }>();
  let runtimeContext = options.runtimeContext;

  function currentRuntimeContext(session?: MorticSession): RuntimeContextRestore | undefined {
    return session?.runtimeContext ?? runtimeContext;
  }

  function sessionResponse(session: MorticSession) {
    return {
      session,
      runtimeContext: currentRuntimeContext(session),
      defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
      defaultCodexModel: DEFAULT_CODEX_MODEL,
      defaultScratchMode: defaultScratchSettings.scratchMode,
      features: featureConfig(),
      tts: getTtsStatus(),
      stt: getSttStatus(),
      livekit: getLiveKitStatus()
    };
  }

  function emitTurnEvent(turnId: string, event: unknown): void {
    const listeners = turnStreams.get(turnId);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  }

  function subscribeTurn(turnId: string, listener: (event: unknown) => void): () => void {
    const listeners = turnStreams.get(turnId) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    turnStreams.set(turnId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        turnStreams.delete(turnId);
      }
    };
  }

  function updateTurnReplay(turnId: string, text: string): void {
    turnReplay.set(turnId, {
      text,
      updatedAt: new Date().toISOString()
    });
  }

  function clearTurnReplay(turnId: string): void {
    turnReplay.delete(turnId);
  }

  function warnProjectStoreFailure(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Mortic project store ${operation} failed: ${message}`);
  }

  async function syncProjectSession(session: MorticSession, type: string, detail?: unknown): Promise<void> {
    try {
      await options.projectStore?.syncSession(session, {
        type,
        detail
      });
    } catch (error) {
      warnProjectStoreFailure(`syncSession(${type})`, error);
    }
  }

  async function recordProjectEvent(session: MorticSession, type: string, detail?: unknown): Promise<void> {
    try {
      await options.projectStore?.recordEvent(session, {
        type,
        detail
      });
    } catch (error) {
      warnProjectStoreFailure(`recordEvent(${type})`, error);
    }
  }

  await app.register(cors, {
    origin: true
  });
  await app.register(websocket);

  app.get("/api/health", async () => {
    return { ok: true };
  });

  app.get("/api/onboarding", async (): Promise<OnboardingStatusResponse> => {
    const provider = await codexProviderAdapter.status();
    // Re-running the sync here is idempotent and self-healing: a missing or
    // stale managed copy is restored on the spot, so the skills step only
    // blocks when sync itself fails. User-edited copies are reported, never
    // overwritten.
    const skills = await syncVendoredSkills().catch((error): SkillSyncStatus[] => [
      {
        skill: "vendored-skills",
        action: "error",
        detail: error instanceof Error ? error.message : String(error),
        targetDir: ""
      }
    ]);
    return {
      provider,
      skills,
      ready:
        provider.available &&
        provider.loginStatus !== "logged-out" &&
        skills.every((skill) => skill.action !== "error")
    };
  });

  app.get("/api/session", async () => {
    const session = await options.storage.read();
    await syncProjectSession(session, "session.loaded");
    return sessionResponse(session);
  });

  app.get("/api/project", async () => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return {
        error: "Project storage is unavailable"
      };
    }
    return options.projectStore.snapshot(session);
  });

  app.get("/api/project/canonical-state", async (_request, reply) => {
    if (!options.projectStore) {
      return reply.code(503).send({
        error: "Project storage is unavailable"
      });
    }
    return options.projectStore.canonicalState();
  });

  app.get("/api/project/chart", async (_request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({
        error: "Project storage is unavailable"
      });
    }
    return options.projectStore.chart(currentRuntimeContext(session));
  });

  app.post<{ Body: ProviderForkAccessRequest }>("/api/project/fork/access", async (request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({
        error: "Project storage is unavailable"
      });
    }
    const body = request.body ?? ({} as ProviderForkAccessRequest);
    if (!body.providerRefId || !providerForkContinuations.includes(body.requestedAccessPreset)) {
      return reply.code(400).send({
        error: `providerRefId and a requestedAccessPreset of ${providerForkContinuations.join(", ")} are required`
      });
    }
    try {
      const providerForks = await options.projectStore.setProviderForkAccess(
        body.providerRefId,
        body.requestedAccessPreset,
        currentRuntimeContext(session)
      );
      return { providerForks } satisfies ProviderForkAccessResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.startsWith("Unknown provider fork") ? 404 : 500).send({ error: message });
    }
  });

  app.get<{
    Querystring: {
      provider?: string;
      providerRefId?: string;
      conversationId?: string;
      threadId?: string;
      importId?: string;
      includeAll?: string;
    };
  }>("/api/project/coverage/latest", async (request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({
        error: "Project storage is unavailable"
      });
    }
    const chart = await options.projectStore.chart(currentRuntimeContext(session));
    const provider = request.query.provider || "codex";
    const coverageReceipts = chart.coverageReceipts
      .filter((receipt) => receipt.provider === provider)
      .filter((receipt) => !request.query.providerRefId || receipt.providerRefId === request.query.providerRefId)
      .filter((receipt) => !request.query.conversationId || receipt.conversationId === request.query.conversationId)
      .filter((receipt) => !request.query.threadId || receipt.threadId === request.query.threadId)
      .filter((receipt) => !request.query.importId || receipt.importId === request.query.importId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      projectId: chart.project.id,
      receipt: coverageReceipts[0],
      coverageReceipts: request.query.includeAll === "true" ? coverageReceipts : coverageReceipts.slice(0, 1)
    };
  });

  app.get<{ Params: { artifactId: string } }>("/api/project/artifacts/:artifactId", async (request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({
        error: "Project storage is unavailable"
      });
    }
    const preview = await options.projectStore.artifactPreview(request.params.artifactId, currentRuntimeContext(session));
    if (!preview) {
      return reply.code(404).send({ error: "Artifact not found" });
    }
    return preview;
  });

  app.post<{ Body: DraftCompilationImportRequest }>("/api/project/draft-compilations/import", async (request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable", session });
    }
    if (session.activeTurn?.status === "running") {
      return reply.code(409).send({ error: "A turn is running. Finish or interrupt it before importing canonical draft deltas.", session });
    }
    try {
      return await options.projectStore.importDraftCompilation(request.body, session, currentRuntimeContext(session));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message, session });
    }
  });

  app.post<{ Params: { compilationId: string }; Body: ApproveCompilationRequest }>("/api/project/compilations/:compilationId/approve", async (request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable", session });
    }
    if (session.activeTurn?.status === "running") {
      return reply.code(409).send({ error: "A turn is running. Finish or interrupt it before approving canonical deltas.", session });
    }
    try {
      return await options.projectStore.approveCompilation(request.params.compilationId, request.body, currentRuntimeContext(session));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes("not found") ? 404 : 400).send({ error: message, session });
    }
  });

  app.get<{
    Querystring: {
      codexModel?: string;
      reasoningEffort?: string;
      scratchMode?: string;
      voiceCaveman?: string;
    };
  }>("/api/session/spark-context", async (request) => {
    const session = await options.storage.read();
    const effective = effectiveScratchSettings({
      scratchMode: isScratchMode(request.query.scratchMode) ? request.query.scratchMode : DEFAULT_SCRATCH_MODE,
      reasoningEffort: isReasoningEffort(request.query.reasoningEffort)
        ? request.query.reasoningEffort
        : DEFAULT_REASONING_EFFORT,
      codexModel: request.query.codexModel,
      voiceCaveman: request.query.voiceCaveman === "true"
    });
    return {
      session,
      preflight: await effectiveSparkPreflight(session.threadId, effective, currentRuntimeContext(session))
    };
  });

  app.post<{ Body: SparkContextCompactRequest }>("/api/session/spark-context/compact", async (request, reply) => {
    const startedAt = Date.now();
    const logs: Array<{ label: string; detail?: string; elapsedMs: number }> = [];
    const body = request.body;
    const session = await options.storage.read();
    const effective = effectiveScratchSettings({
      scratchMode: isScratchMode(body?.scratchMode) ? body.scratchMode : DEFAULT_SCRATCH_MODE,
      reasoningEffort: isReasoningEffort(body?.reasoningEffort) ? body.reasoningEffort : DEFAULT_REASONING_EFFORT,
      codexModel: body?.codexModel,
      voiceCaveman: body?.voiceCaveman
    });
    const before = await effectiveSparkPreflight(session.threadId, effective, currentRuntimeContext(session));

    if (session.activeTurn?.status === "running") {
      return reply.code(409).send({
        error: "A Mortic turn is already running. Interrupt or wait before compacting context.",
        session,
        before,
        preflight: before,
        compacted: false,
        logs
      });
    }

    if (body?.confirm !== true) {
      return reply.code(400).send({
        error: "Compaction requires explicit confirmation.",
        session,
        before,
        preflight: before,
        compacted: false,
        logs
      });
    }

    if (before.status === "hard-block" && !before.compactionRequired) {
      return reply.code(409).send({
        error: "Candidate model context telemetry is not actionable. Mortic will not compact without a known candidate window and context reading.",
        session,
        before,
        preflight: before,
        compacted: false,
        logs
      });
    }

    if (before.status === "safe") {
      return {
        session,
        before,
        preflight: before,
        compacted: false,
        logs
      };
    }

    // Risk check: context compaction is an explicit user-approved state change,
    // but it must never mutate the source Codex thread. Mortic first creates a
    // disposable compact-base fork, compacts only that fork, and then runs the candidate model
    // turns directly on the compacted fork. This can improve latency/context
    // fit, but compression can hide older details and surprise users who skip
    // manual review.
    try {
      logs.push({
        label: "Fork compaction requested",
        detail: before.detail,
        elapsedMs: Date.now() - startedAt
      });
      const compaction = await compactCodexThread({
        threadId: session.threadId,
        runtimeContext: currentRuntimeContext(session),
        codexModel: effective.codexModel,
        reasoningEffort: effective.reasoningEffort,
        scratchMode: effective.scratchMode,
        voiceCaveman: effective.voiceCaveman,
        onEvent: (label, detail) => {
          logs.push({
            label,
            detail,
            elapsedMs: Date.now() - startedAt
          });
        }
      });
      const preflight = preflightFromCompactedFork({
        sourceThreadId: session.threadId,
        compactedThreadId: compaction.compactedThreadId,
        candidateModel: effective.codexModel,
        estimatedInputTokens: compaction.estimatedInputTokens,
        updatedAt: compaction.updatedAt
      });
      logs.push({
        label: "Preflight after fork compaction",
        detail: preflight.detail,
        elapsedMs: Date.now() - startedAt
      });
      return {
        session: await options.storage.read(),
        before,
        preflight,
        compacted: true,
        logs
      };
    } catch (error) {
      const latest = await effectiveSparkPreflight(session.threadId, effective, currentRuntimeContext(session));
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
        session: await options.storage.read(),
        before,
        preflight: latest,
        compacted: false,
        logs
      });
    }
  });

  app.post<{ Body: SourceThreadRequest }>("/api/session/source", async (request, reply) => {
    try {
      const parsed = parseThreadUri(request.body?.sourceUri);
      const nextRuntimeContext = options.resolveRuntimeContext
        ? await options.resolveRuntimeContext({ sourceUri: parsed.sourceUri, threadId: parsed.threadId })
        : runtimeContext;
      // When the new thread resolves to a different workspace, rebuild the
      // project store BEFORE touching scratch or session state so the routes
      // reading options.projectStore serve the new project — and so a store
      // failure leaves the previous source thread fully intact. Same workspace
      // means same project dir, so the existing store is kept as-is.
      let nextProjectStore: ProjectStore | undefined;
      if (
        options.projectStore &&
        nextRuntimeContext &&
        projectDirForWorkspace(nextRuntimeContext.effectiveCwd) !== options.projectStore.projectDir
      ) {
        try {
          nextProjectStore = await createProjectStore({
            workspacePath: nextRuntimeContext.effectiveCwd,
            sourceUri: parsed.sourceUri,
            threadId: parsed.threadId,
            projectTitle: options.projectTitle
          });
        } catch (error) {
          return reply.code(500).send({
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      runtimeContext = nextRuntimeContext;
      await resetCodexScratch();
      const updated = await options.storage.resetSource({
        sourceUri: parsed.sourceUri,
        threadId: parsed.threadId,
        codex: await getCodexStatus(),
        runtimeContext
      });
      if (nextProjectStore) {
        options.projectStore = nextProjectStore;
      }
      await syncProjectSession(updated, "source_thread.selected", { sourceUri: parsed.sourceUri, threadId: parsed.threadId });
      return sessionResponse(updated);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/api/session/clear", async () => {
    await resetCodexScratch();
    const session = await options.storage.clear();
    await syncProjectSession(session, "session.cleared");
    return sessionResponse(session);
  });

  app.post<{ Body: { approveItemIds?: string[] } }>("/api/project/session/commit", async (request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable", session });
    }
    if (session.activeTurn?.status === "running") {
      return reply.code(409).send({ error: "A turn is running. Finish or interrupt it before committing.", session });
    }
    const approveItemIds = Array.isArray(request.body?.approveItemIds)
      ? request.body.approveItemIds.filter((id): id is string => typeof id === "string")
      : [];
    return options.projectStore.commitSession(session, approveItemIds);
  });

  app.post("/api/project/session/archive", async (_request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable", session });
    }
    if (session.activeTurn?.status === "running") {
      return reply.code(409).send({ error: "A turn is running. Finish or interrupt it before archiving.", session });
    }
    return options.projectStore.archiveSession(session);
  });

  app.post("/api/project/checkpoint/confirm", async (_request, reply) => {
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable" });
    }
    return options.projectStore.confirmSourceCheckpoint();
  });

  app.post("/api/project/checkpoint/dismiss", async (_request, reply) => {
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable" });
    }
    return options.projectStore.dismissSourceCheckpoint();
  });

  app.post("/api/project/checkpoint/manual", async (_request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable", session });
    }
    return options.projectStore.createManualSourceCheckpoint(session);
  });

  app.post("/api/project/handoff-copied", async (_request, reply) => {
    const session = await options.storage.read();
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable", session });
    }
    return options.projectStore.markHandoffCopied(session);
  });

  app.patch<{ Params: { itemId: string }; Body: UpdateExtractedItemRequest }>("/api/project/extractions/:itemId", async (request, reply) => {
    if (!options.projectStore) {
      return reply.code(503).send({ error: "Project storage is unavailable" });
    }
    const patch: UpdateExtractedItemRequest = {};
    if (isExtractionStatus(request.body?.status)) patch.status = request.body.status;
    if (isExtractedItemType(request.body?.type)) patch.type = request.body.type;
    if (typeof request.body?.title === "string") patch.title = request.body.title;
    if (typeof request.body?.body === "string") patch.body = request.body.body;
    if (request.body && Object.prototype.hasOwnProperty.call(request.body, "taskPlanMarkdown")) {
      patch.taskPlanMarkdown = typeof request.body.taskPlanMarkdown === "string" ? request.body.taskPlanMarkdown : undefined;
    }
    if (typeof request.body?.mergeIntoId === "string") patch.mergeIntoId = request.body.mergeIntoId;
    if (request.body?.retire === true) patch.retire = true;
    return options.projectStore.updateExtractedItem(request.params.itemId, patch);
  });

  app.get<{ Querystring: { limit?: string } }>("/api/provider/threads", async (request) => {
    const limit = Number(request.query.limit);
    const threads = await codexProviderAdapter.listRecentThreads({
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined
    });
    return {
      provider: "codex",
      threads
    };
  });

  app.get("/api/stt", async () => {
    return getSttStatus();
  });

  app.get("/api/livekit/status", async () => {
    return getLiveKitStatus();
  });

  app.post<{ Body: LiveKitTokenRequest }>("/api/livekit/token", async (request, reply) => {
    const token = await createLiveKitToken(request.body ?? {});
    if (!token.configured) return reply.code(503).send(token);
    return token;
  });

  app.post<{ Body: SttTranscriptionRequest }>("/api/stt/transcribe", async (request, reply) => {
    try {
      const result = await transcribeAudioWithFallback(request.body);
      return result;
    } catch (error) {
      const failures = error instanceof Error && Array.isArray((error as Partial<SttFallbackError>).failures)
        ? (error as SttFallbackError).failures
        : [];
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error),
        failures,
        stt: getSttStatus()
      });
    }
  });

  app.get("/api/tts", async () => {
    return getTtsStatus();
  });

  app.get("/api/tts/elevenlabs/health", async (): Promise<ElevenLabsHealthResponse> => {
    return await probeElevenLabsTts();
  });

  app.get("/api/tts/deepgram/health", async (): Promise<DeepgramHealthResponse> => {
    return await probeDeepgramTts();
  });

  app.get("/api/tts/elevenlabs/ws", { websocket: true }, (socket) => {
    handleElevenLabsWsSession(socket);
  });

  app.get("/api/tts/deepgram/ws", { websocket: true }, (socket) => {
    handleDeepgramWsSession(socket);
  });

  app.get("/api/tts/inworld/ws", { websocket: true }, (socket) => {
    handleInworldWsSession(socket);
  });

  app.post<{ Body: TtsSynthesisRequest }>("/api/tts/elevenlabs/stream", async (request, reply) => {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!text) {
      return reply.code(400).send({ error: "TTS text is required" });
    }

    try {
      const audio = await streamElevenLabsTts(text);
      reply.header("Content-Type", audio.contentType);
      reply.header("Cache-Control", "no-store");
      if (audio.contentLength) reply.header("Content-Length", audio.contentLength);
      return reply.send(Readable.fromWeb(audio.body));
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post<{ Body: TtsSynthesisRequest }>("/api/tts/deepgram/stream", async (request, reply) => {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (!text) {
      return reply.code(400).send({ error: "TTS text is required" });
    }

    try {
      const audio = await streamDeepgramTts(text);
      reply.header("Content-Type", audio.contentType);
      reply.header("Cache-Control", "no-store");
      if (audio.contentLength) reply.header("Content-Length", audio.contentLength);
      return reply.send(Readable.fromWeb(audio.body));
    } catch (error) {
      return reply.code(502).send({
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post<{ Body: PrewarmRequest }>("/api/session/prewarm", async (request, reply) => {
    const startedAt = Date.now();
    const body = request.body;
    const logs: Array<{ label: string; detail?: string; elapsedMs: number }> = [];

    if (!isScratchMode(body?.scratchMode)) {
      return reply.code(400).send({ error: "Invalid scratch mode" });
    }

    if (!isReasoningEffort(body?.reasoningEffort)) {
      return reply.code(400).send({ error: "Invalid reasoning effort" });
    }

    const session = await options.storage.read();
    if (session.activeTurn?.status === "running") {
      return reply.code(409).send({
        error: "A Mortic turn is already running. Prewarm after it finishes or interrupt it first.",
        session
      });
    }

    const effective = effectiveScratchSettings({
      scratchMode: body.scratchMode,
      reasoningEffort: body.reasoningEffort,
      codexModel: body.codexModel,
      voiceCaveman: body.voiceCaveman
    });
    const sparkPreflight = needsModelTransitionPreflight(effective.codexModel)
      ? await effectiveSparkPreflight(session.threadId, effective, currentRuntimeContext(session))
      : undefined;
    const sparkDecision = sparkPreflight
      ? sparkPreflightStartDecision(sparkPreflight, body.allowModelContextRisk === true || body.allowSparkContextRisk === true)
      : { allowed: true };
    if (!sparkDecision.allowed) {
      return reply.code(409).send({
        error: sparkDecision.error,
        session,
        sparkPreflight
      });
    }
    const readyThreadName = (await codexProviderAdapter.threadName(session.threadId)) ?? prewarmThreadName(session.threadId);
    const readyText = prewarmReadyText(readyThreadName);

    try {
      await prewarmCodexScratch({
        threadId: session.threadId,
        runtimeContext: currentRuntimeContext(session),
        scratchMode: effective.scratchMode,
        reasoningEffort: effective.reasoningEffort,
        codexModel: effective.codexModel,
        voiceCaveman: effective.voiceCaveman,
        onEvent: (label, detail) => {
          logs.push({
            label,
            detail,
            elapsedMs: Date.now() - startedAt
          });
        }
      });
      logs.push({
        label: "Prewarm ready",
        detail: readyText,
        elapsedMs: Date.now() - startedAt
      });
      const latest = await options.storage.read();
      const checkpoint = checkpointFromPrewarmLogs({
        session: latest,
        scratchMode: effective.scratchMode,
        logs,
        checkpointInstruction:
          "Prioritize Mortic turns after this fork checkpoint when generating handoff prompts; inherited source context is only background."
      });
      const sessionWithCheckpoint = checkpoint ? await options.storage.setForkCheckpoint(checkpoint) : latest;
      await syncProjectSession(sessionWithCheckpoint, "scratch.prewarmed", {
        scratchMode: effective.scratchMode,
        codexModel: effective.codexModel,
        reasoningEffort: effective.reasoningEffort,
        checkpoint
      });

      return {
        session: sessionWithCheckpoint,
        scratchMode: effective.scratchMode,
        reasoningEffort: effective.reasoningEffort,
        codexModel: effective.codexModel,
        voiceCaveman: effective.voiceCaveman,
        prewarmConfirmation: effective.scratchMode === "voice" ? readyText : undefined,
        prewarmMs: Date.now() - startedAt,
        logs
      };
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
        session: await options.storage.read(),
        scratchMode: effective.scratchMode,
        reasoningEffort: effective.reasoningEffort,
        codexModel: effective.codexModel,
        voiceCaveman: effective.voiceCaveman,
        prewarmMs: Date.now() - startedAt,
        logs
      });
    }
  });

  app.post<{ Body: TurnRequest }>("/api/turn", async (request, reply) => {
    const requestStartMs = Date.now();
    const body = request.body;
    const sessionBeforeTurn = await options.storage.read();

    if (!body || typeof body.text !== "string" || !body.text.trim()) {
      return reply.code(400).send({ error: "Turn text is required" });
    }

    if (!isReasoningEffort(body.reasoningEffort)) {
      return reply.code(400).send({ error: "Invalid reasoning effort" });
    }

    const effective = effectiveScratchSettings({
      scratchMode: isScratchMode(body.scratchMode) ? body.scratchMode : DEFAULT_SCRATCH_MODE,
      reasoningEffort: body.reasoningEffort,
      codexModel: body.codexModel,
      voiceCaveman: body.voiceCaveman
    });
    const sparkPreflight = needsModelTransitionPreflight(effective.codexModel)
      ? await effectiveSparkPreflight(sessionBeforeTurn.threadId, effective, currentRuntimeContext(sessionBeforeTurn))
      : undefined;
    const sparkDecision = sparkPreflight
      ? sparkPreflightStartDecision(sparkPreflight, body.allowModelContextRisk === true || body.allowSparkContextRisk === true)
      : { allowed: true };
    if (!sparkDecision.allowed) {
      return reply.code(409).send({
        error: sparkDecision.error,
        session: sessionBeforeTurn,
        sparkPreflight
      });
    }
    const effectiveScratchMode = effective.scratchMode;
    const effectiveReasoningEffort = effective.reasoningEffort;
    const effectiveCodexModel = effective.codexModel;

    if (sessionBeforeTurn.activeTurn?.status === "running") {
      return reply.code(409).send({
        error: "A Mortic turn is already running. Interrupt or wait for it to finish before starting another.",
        session: sessionBeforeTurn
      });
    }

    const turnId = randomUUID();
    const userEntry = {
      id: randomUUID(),
      role: "user" as const,
      text: body.text.trim(),
      createdAt: new Date().toISOString(),
      reasoningEffort: effectiveReasoningEffort,
      scratchMode: effectiveScratchMode
    };
    const startMs = Date.now();
    const progressFeatures = featureConfig();
    const progressTrace: ProgressSpeechTrace | undefined =
      progressFeatures.progressSpeechTrace && effectiveScratchMode === "voice"
        ? {
            enabled: progressFeatures.progressSpeech,
            rawNotifications: [],
            mappedEvents: [],
            decisions: [],
            spokenStatuses: []
          }
        : undefined;
    let progressLastSpokenElapsedMs: number | undefined;
    const progressSpokenTexts = new Set<string>();
    const emitLogUpdate = (session: MorticSession) => {
      if (!session.activeTurn || session.activeTurn.id !== turnId) return;
      emitTurnEvent(turnId, {
        type: "log",
        turn: session.activeTurn
      });
    };
    const logAndEmit = async (
      label: string,
      detail?: string,
      updates?: Partial<TurnRun>
    ): Promise<MorticSession> => {
      const updated = await addTurnLog(options.storage, turnId, startMs, label, detail, updates);
      await recordProjectEvent(updated, "turn.log", { turnId, label, detail });
      emitLogUpdate(updated);
      return updated;
    };
    const isCurrentTurnRunning = async (): Promise<boolean> => {
      const latest = await options.storage.read();
      return latest.activeTurn?.id === turnId && latest.activeTurn.status === "running";
    };
    const activeTurn: TurnRun = {
      id: turnId,
      status: "running",
      userText: userEntry.text,
      reasoningEffort: effectiveReasoningEffort,
      codexModel: effectiveCodexModel,
      scratchMode: effectiveScratchMode,
      voiceCaveman: effective.voiceCaveman,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [logEntry(startMs, "Request received", `${Buffer.byteLength(userEntry.text, "utf8")} user-text bytes`)],
      progressTrace,
      metrics: {
        serverAcceptMs: Date.now() - requestStartMs,
        sttProvider: body.sttMetrics?.provider,
        sttSegmentCount: body.sttMetrics?.segmentCount,
        sttPayloadBytes: body.sttMetrics?.payloadBytes,
        recordingDurationMs: body.sttMetrics?.recordingDurationMs,
        recordingStartedAt: body.sttMetrics?.recordingStartedAt,
        recordingStoppedAt: body.sttMetrics?.recordingStoppedAt,
        firstSpeechDetectedMs: body.sttMetrics?.firstSpeechDetectedMs,
        firstInterimTranscriptMs: body.sttMetrics?.firstInterimTranscriptMs,
        firstFinalTranscriptMs: body.sttMetrics?.firstFinalTranscriptMs,
        finalSttReadyMs: body.sttMetrics?.finalSttReadyMs,
        sendAfterSpeechMs: body.sttMetrics?.sendAfterSpeechMs,
        recognitionErrors: body.sttMetrics?.recognitionErrors?.join(" | "),
        transportProvider: body.transportProvider,
        transportState: body.transportState,
        transportPacketLoss: body.transportStats?.packetLoss,
        transportJitterMs: body.transportStats?.jitterMs,
        transportRttMs: body.transportStats?.rttMs,
        transportReconnects: body.transportStats?.reconnects,
        transportTrackState: body.transportStats?.trackState,
        transportMuted: body.transportStats?.muted,
        transportAudioLevel: body.transportStats?.audioLevel
      }
    };

    await options.storage.write({
      ...sessionBeforeTurn,
      transcript: [...sessionBeforeTurn.transcript, userEntry],
      handoff: undefined,
      activeTurn
    });
    await syncProjectSession(await options.storage.read(), "turn.user_appended", {
      turnId,
      entryId: userEntry.id,
      scratchMode: effectiveScratchMode,
      codexModel: effectiveCodexModel
    });

    void (async () => {
      const codexStartMs = Date.now();
      const finalizeProgress = () => progressTrace ? finalizeProgressTrace(progressTrace) : undefined;
      try {
        const session = await options.storage.read();
        const prompt = userEntry.text;
        const promptBytes = Buffer.byteLength(prompt, "utf8");
        let appTurnStartElapsedMs: number | undefined;
        let firstDeltaElapsedMs: number | undefined;
        const updateProgressTrace = async () => {
          if (!progressTrace) return;
          await options.storage.updateActiveTurn((turn) => {
            if (!turn || turn.id !== turnId) return turn;
            return {
              ...turn,
              progressTrace: { ...progressTrace },
              updatedAt: new Date().toISOString()
            };
          });
        };
        const recordProgressDecision = async (
          label: string,
          decision: "eligible" | "spoken" | "suppressed",
          reason?: string,
          speakableText?: string
        ) => {
          if (!progressTrace) return;
          progressTrace.decisions.push({
            elapsedMs: Date.now() - startMs,
            label,
            decision,
            reason,
            speakableText
          });
          await updateProgressTrace();
        };
        await logAndEmit(
          "Utterance prepared",
          `${promptBytes} bytes, est ${estimateTokens(promptBytes)} tokens`,
          {
            metrics: {
              promptBytes,
              promptTokensEstimate: estimateTokens(promptBytes)
            }
          }
        );

        const onDelta = (delta: string, text: string) =>
          void isCurrentTurnRunning().then((running) => {
            if (!running) return;
            updateTurnReplay(turnId, text);
            emitTurnEvent(turnId, {
              type: "delta",
              turnId,
              delta,
              text,
              scratchMode: effectiveScratchMode
            });
          });
        const onEvent = async (label: string, detail?: string) => {
          if (!(await isCurrentTurnRunning())) return;
          const elapsedMs = Date.now() - startMs;
          const metrics: TurnRun["metrics"] = {};
          // Voice-parser repair runs a second turn through the same bridge;
          // only the first attempt's timings are the turn's latency metrics.
          if (label === "App-server turn started" && appTurnStartElapsedMs === undefined) {
            appTurnStartElapsedMs = elapsedMs;
            metrics.appTurnStartMs = elapsedMs;
          }
          if (label === "App-server first model delta" && firstDeltaElapsedMs === undefined) {
            firstDeltaElapsedMs = elapsedMs;
            if (progressTrace && progressTrace.firstAssistantDeltaMs === undefined) {
              progressTrace.firstAssistantDeltaMs = elapsedMs;
              void updateProgressTrace();
            }
            metrics.firstDeltaMs = elapsedMs;
            if (appTurnStartElapsedMs !== undefined) {
              metrics.modelWaitMs = Math.max(0, elapsedMs - appTurnStartElapsedMs);
            }
          }
          await logAndEmit(label, detail, Object.keys(metrics).length > 0 ? { metrics } : undefined);
        };
        const onProgressTrace = async (event: {
          type: "raw";
          method: string;
          turnId?: string;
          itemType?: string;
          itemId?: string;
          detail?: string;
        } | {
          type: "mapped";
          progress: { kind: string; label: string; itemType?: string; detail?: string };
        } | {
          type: "first-delta";
          detail?: string;
        }) => {
          if (!progressTrace) return;
          const elapsedMs = Date.now() - startMs;
          if (event.type === "raw") {
            progressTrace.rawNotifications.push({
              elapsedMs,
              method: event.method,
              turnId: event.turnId,
              itemType: event.itemType,
              itemId: event.itemId,
              detail: event.detail
            });
            if (event.method === "item/started" && event.itemType === "agentMessage") {
              progressTrace.decisions.push({
                elapsedMs,
                label: "Writing answer",
                decision: "suppressed",
                reason: "agent-message-filler",
                speakableText: "I'm writing the answer now."
              });
            }
          } else if (event.type === "mapped") {
            progressTrace.mappedEvents.push({
              elapsedMs,
              kind: event.progress.kind,
              label: event.progress.label,
              itemType: event.progress.itemType,
              detail: event.progress.detail
            });
          } else if (progressTrace.firstAssistantDeltaMs === undefined) {
            progressTrace.firstAssistantDeltaMs = elapsedMs;
          }
          await updateProgressTrace();
        };
        const onProgress = async (progress: { label: string; detail?: string }) => {
          const elapsedMs = Date.now() - startMs;
          const text = progressSpeechTextForLabel(progress.label);
          let suppressionReason: string | undefined;
          if (!progressFeatures.progressSpeech) suppressionReason = "feature-disabled";
          else if (effectiveScratchMode !== "voice") suppressionReason = "not-voice";
          else if (!(await isCurrentTurnRunning())) suppressionReason = "turn-not-running";
          else if (!text) suppressionReason = progress.label === "Writing answer" ? "agent-message-filler" : "no-speakable-text";
          else if (progressTrace?.firstAssistantDeltaMs !== undefined || firstDeltaElapsedMs !== undefined) suppressionReason = "after-first-assistant-delta";
          else if (progressTrace && progressTrace.spokenStatuses.length >= MAX_PROGRESS_STATUSES_PER_TURN) suppressionReason = "max-statuses";
          else if (text && progressSpokenTexts.has(text)) suppressionReason = "repeat";
          else if (text && progressLastSpokenElapsedMs !== undefined && elapsedMs - progressLastSpokenElapsedMs < PROGRESS_SPEECH_THROTTLE_MS) suppressionReason = "throttled";
          else if (text && isUnsafeProgressSpeech(text)) suppressionReason = "unsafe";

          if (suppressionReason || !text) {
            await recordProgressDecision(progress.label, "suppressed", suppressionReason ?? "no-speakable-text", text ?? undefined);
            return;
          }

          await recordProgressDecision(progress.label, "eligible", undefined, text);
          progressLastSpokenElapsedMs = elapsedMs;
          progressSpokenTexts.add(text);
          progressTrace?.spokenStatuses.push(text);
          await recordProgressDecision(progress.label, "spoken", undefined, text);
          emitTurnEvent(turnId, {
            type: "status",
            turnId,
            label: progress.label,
            detail: progress.detail,
            speakable: true,
            scratchMode: effectiveScratchMode
          });
        };
        const runPrompt = async (promptText: string): Promise<string> =>
          await runCodexTurn({
            threadId: session.threadId,
            runtimeContext: currentRuntimeContext(session),
            prompt: promptText,
            userText: promptText,
            reasoningEffort: effectiveReasoningEffort,
            codexModel: effectiveCodexModel,
            scratchMode: effectiveScratchMode,
            voiceCaveman: effective.voiceCaveman,
            shouldContinue: isCurrentTurnRunning,
            onDelta,
            onEvent,
            onProgress,
            onProgressTrace
          });

        let codexText = await runPrompt(prompt);
        let voiceParse = effectiveScratchMode === "voice" ? parseMorticVoice(codexText) : undefined;
        let voiceRepairAttempted = false;
        if (voiceParse && !voiceParse.ok && (await isCurrentTurnRunning())) {
          voiceRepairAttempted = true;
          await logAndEmit("Voice parser repair started", voiceParse.error);
          codexText = await runPrompt(voiceRepairPrompt({ error: voiceParse.error, rawText: codexText }));
          voiceParse = parseMorticVoice(codexText);
          await logAndEmit(
            voiceParse.ok ? "Voice parser repair completed" : "Voice parser repair failed",
            voiceParse.ok
              ? `ndjson${voiceParse.parts.parserError ? ` warning: ${voiceParse.parts.parserError}` : ""}`
              : voiceParse.error
          );
        }
        const voiceParts = voiceParse?.ok ? voiceParse.parts : undefined;
        const assistantText = voiceParts?.displayText ?? (voiceParse ? "Mortic could not parse the voice response." : codexText);
        const spokenText = voiceParts?.spokenText;
        const notesText = voiceParts?.notesText ?? (voiceParse && !voiceParse.ok
          ? `Mortic parser error: ${voiceParse.error}\n\nRaw output:\n\n\`\`\`text\n${voiceParse.rawText.trim()}\n\`\`\``
          : undefined);

        if (voiceParse && !voiceRepairAttempted) {
          await logAndEmit(
            voiceParse.ok ? "Voice parser" : "Voice parser error",
            voiceParse.ok
              ? `ndjson${voiceParse.parts.parserError ? ` warning: ${voiceParse.parts.parserError}` : ""}`
              : voiceParse.error
          );
        }

        const assistantEntry = {
          id: randomUUID(),
          role: "assistant" as const,
          text: assistantText,
          spokenText,
          notesText,
          rawText: voiceParse ? codexText : undefined,
          parserMode: voiceParts?.parserMode ?? (voiceParse ? "invalid" as const : undefined),
          parserError: voiceParts?.parserError ?? (voiceParse && !voiceParse.ok ? voiceParse.error : undefined),
          createdAt: new Date().toISOString(),
          reasoningEffort: effectiveReasoningEffort,
          scratchMode: effectiveScratchMode
        };
        const latestBeforeAppend = await options.storage.read();
        if (latestBeforeAppend.activeTurn?.id !== turnId || latestBeforeAppend.activeTurn.status !== "running") return;
        const withAssistant = await options.storage.append(assistantEntry);
        await syncProjectSession(withAssistant, "turn.assistant_appended", {
          turnId,
          entryId: assistantEntry.id,
          parserMode: assistantEntry.parserMode
        });
        const updated = await logAndEmit("Assistant response appended", `${Buffer.byteLength(assistantText, "utf8")} display bytes`, {
          status: "completed",
          responseEntryId: assistantEntry.id,
          progressTrace: finalizeProgress(),
          metrics: {
            codexLatencyMs: Date.now() - codexStartMs,
            totalMs: Date.now() - startMs,
            outputMs: firstDeltaElapsedMs !== undefined ? Math.max(0, Date.now() - startMs - firstDeltaElapsedMs) : undefined
          }
        });
        if (updated.activeTurn?.id === turnId) {
          clearTurnReplay(turnId);
          emitTurnEvent(turnId, {
            type: "completed",
            turn: updated.activeTurn,
            session: updated
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const assistantEntry = {
          id: randomUUID(),
          role: "assistant" as const,
          text: message,
          createdAt: new Date().toISOString(),
          reasoningEffort: effectiveReasoningEffort,
          scratchMode: effectiveScratchMode,
          failed: true
        };
        const latestBeforeAppend = await options.storage.read();
        if (latestBeforeAppend.activeTurn?.id !== turnId || latestBeforeAppend.activeTurn.status !== "running") return;
        const withFailure = await options.storage.append(assistantEntry);
        await syncProjectSession(withFailure, "turn.failed_assistant_appended", {
          turnId,
          entryId: assistantEntry.id,
          error: message
        });
        const updated = await logAndEmit("Turn failed", message, {
          status: "failed",
          error: message,
          responseEntryId: assistantEntry.id,
          progressTrace: finalizeProgress(),
          metrics: {
            codexLatencyMs: Date.now() - codexStartMs,
            totalMs: Date.now() - startMs
          }
        });
        if (updated.activeTurn?.id === turnId) {
          clearTurnReplay(turnId);
          emitTurnEvent(turnId, {
            type: "failed",
            turn: updated.activeTurn,
            session: updated
          });
        }
      }
    })();

    const updated = await options.storage.read();
    return reply.code(202).send({
      turnId,
      session: updated,
      serverAcceptMs: Date.now() - requestStartMs
    });
  });

  app.get<{ Params: { turnId: string } }>("/api/turn/:turnId", async (request, reply) => {
    const session = await options.storage.read();
    const turn = session.activeTurn?.id === request.params.turnId ? session.activeTurn : null;

    if (!turn) {
      return reply.code(404).send({ turn: null, session });
    }

    const replay = turn.status === "running" ? turnReplay.get(request.params.turnId) : undefined;
    return {
      turn,
      session,
      replayText: replay?.text,
      replayUpdatedAt: replay?.updatedAt
    };
  });

  app.post<{ Params: { turnId: string }; Body: AudioHealthRequest }>("/api/turn/:turnId/audio-health", async (request, reply) => {
    const body = request.body;
    if (!body || !isTtsProvider(body.provider)) {
      return reply.code(400).send({ error: "Invalid TTS provider" });
    }

    const session = await options.storage.read();
    const turn = session.activeTurn?.id === request.params.turnId ? session.activeTurn : null;
    if (!turn) {
      return reply.code(404).send({ error: "Turn not found", session });
    }

    const updated = await updateAudioHealth(options.storage, request.params.turnId, body);
    await recordProjectEvent(updated, "turn.audio_health", { turnId: request.params.turnId, provider: body.provider, ttsError: body.ttsError });
    if (updated.activeTurn?.id === request.params.turnId) {
      emitTurnEvent(request.params.turnId, {
        type: "log",
        turn: updated.activeTurn
      });
    }
    return {
      turn: updated.activeTurn ?? null,
      session: updated
    };
  });

  app.post<{ Params: { turnId: string } }>("/api/turn/:turnId/interrupt", async (request) => {
    const session = await options.storage.read();
    const turn = session.activeTurn?.id === request.params.turnId ? session.activeTurn : null;

    if (!turn || turn.status !== "running") {
      return {
        interrupted: false,
        session
      };
    }

    const startMs = Number.isNaN(Date.parse(turn.createdAt)) ? Date.now() : Date.parse(turn.createdAt);
    const updated = await addTurnLog(options.storage, request.params.turnId, startMs, "Turn interrupted", "local interrupt requested", {
      status: "interrupted",
      metrics: {
        totalMs: Date.now() - startMs
      }
    });
    await syncProjectSession(updated, "turn.interrupted", { turnId: request.params.turnId });

    if (updated.activeTurn?.id === request.params.turnId) {
      clearTurnReplay(request.params.turnId);
      emitTurnEvent(request.params.turnId, {
        type: "interrupted",
        turn: updated.activeTurn,
        session: updated
      });
    }

    await interruptCodexScratch();

    return {
      interrupted: true,
      session: updated
    };
  });

  app.get<{ Params: { turnId: string } }>("/api/turn/:turnId/stream", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    const writeEvent = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const session = await options.storage.read();
    const turn = session.activeTurn?.id === request.params.turnId ? session.activeTurn : null;
    const replay = turn?.status === "running" ? turnReplay.get(request.params.turnId) : undefined;
    writeEvent({
      type: "snapshot",
      turn,
      session,
      replayText: replay?.text,
      replayUpdatedAt: replay?.updatedAt
    });

    if (!turn || turn.status !== "running") {
      reply.raw.end();
      return;
    }

    const unsubscribe = subscribeTurn(request.params.turnId, (event) => {
      writeEvent(event);
      if (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        (event.type === "completed" || event.type === "failed" || event.type === "interrupted")
      ) {
        unsubscribe();
        reply.raw.end();
      }
    });

    request.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });
  });

  app.post<{ Body: HandoffRequest }>("/api/handoff", async (request) => {
    const body = request.body;
    const codexModel = normalizeCodexModel(body?.codexModel);
    const requestedReasoning = isReasoningEffort(body?.reasoningEffort) ? body.reasoningEffort : DEFAULT_REASONING_EFFORT;
    const reasoningEffort = effectiveReasoningForModel(codexModel, requestedReasoning);
    const session = await options.storage.read();
    const transcriptMarkdown = handoffTranscriptOnly(await options.storage.transcriptMarkdown(session));
    const prompt = createHandoffPrompt({
      sourceUri: session.sourceUri,
      transcriptMarkdown,
      checkpoint: session.forkCheckpoint
    });

    const validateHandoff = (handoff: string) => {
      if (!/# Short Prompt\b/i.test(handoff) || !/# Full Prompt\b/i.test(handoff)) {
        throw new Error("Handoff response was missing the required prompt headings");
      }
      return handoff;
    };

    try {
      let handoff: string;
      try {
        handoff = validateHandoff(await runCodexTurn({
          threadId: session.threadId,
          runtimeContext: currentRuntimeContext(session),
          prompt,
          userText: "Generate Mortic handoff prompts from the scratch transcript.",
          reasoningEffort,
          codexModel,
          scratchMode: "text",
          developerInstructions: HANDOFF_DEVELOPER_INSTRUCTIONS,
          requireAppServer: true
        }));
      } catch {
        handoff = validateHandoff(await runCodexIsolatedTurn({
          prompt,
          reasoningEffort,
          codexModel
        }));
      }
      const prompts = parseHandoffPrompts(handoff);
      const updated = await options.storage.setHandoff(prompts);
      await syncProjectSession(updated, "handoff.generated", { generatedBy: "codex" });
      return { ...prompts, session: updated, generatedBy: "codex" };
    } catch {
      const prompts = localHandoff(session.sourceUri, transcriptMarkdown);
      const updated = await options.storage.setHandoff(prompts);
      await syncProjectSession(updated, "handoff.generated", { generatedBy: "local" });
      return { ...prompts, session: updated, generatedBy: "local" };
    }
  });

  if (options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: "/"
    });
  }

  return app;
}
