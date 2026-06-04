import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import {
  reasoningEfforts,
  scratchModes,
  sttProviders,
  transportProviders,
  ttsProviders,
  type AudioHealthRequest,
  type AgentState,
  type CaptureState,
  type ElevenLabsHealthResponse,
  type ExtractedItem,
  type ExtractionStatus,
  type InputPolicy,
  type LiveKitStatus,
  type MorticSession,
  type PrewarmResponse,
  type ProjectCanonicalStateResponse,
  type ProjectStateResponse,
  type ReasoningEffort,
  type ScratchSessionNode,
  type ScratchMode,
  type SparkContextCompactResponse,
  type SparkContextPreflight,
  type SparkContextPreflightResponse,
  type SttProvider,
  type SttStatus,
  type SttTurnMetrics,
  type SttTranscriptionResponse,
  type TranscriptEntry,
  type TransportProvider,
  type TransportState,
  type TtsProvider,
  type TtsStatus,
  type TurnRun,
  type TurnStreamEvent
} from "../shared/types.js";
import { redactThreadId } from "../shared/threadUri.js";
import { contextWorkReduction, estimateTextTokens, estimateTranscriptTokens, percentReduction } from "../shared/tokenEstimate.js";
import { partialSpokenText } from "../shared/voiceResponse.js";
import { effectiveReasoningForModel, modelRequiresLowReasoning } from "../shared/modelPolicy.js";
import { modelProfile } from "../shared/modelProfiles.js";
import {
  interruptResumeAction,
  isCurrentRecognitionSession,
  isEditableShortcutTarget,
  keyboardIntentForKeyDown,
  keyboardIntentForKeyUp,
  shouldSubmitCapturedTurn
} from "../shared/inputControl.js";
import {
  createBrowserTtsProvider,
  createElevenLabsTtsProvider,
  createElevenLabsWsTtsProvider,
  createInworldWsTtsProvider,
  type RuntimeTtsProvider,
  type TtsSpeakCallbacks
} from "./tts.js";
import { MorticLiveKitTransport, type LiveKitTransportStats } from "./livekitTransport.js";

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type AudioContextConstructor = new () => AudioContext;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

type SpeechRecognitionEventLike = {
  resultIndex?: number;
  results: ArrayLike<{
    isFinal?: boolean;
    0: {
      transcript: string;
    };
  }>;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type ApiState = {
  session: MorticSession | null;
  loading: boolean;
  error: string | null;
};

type PrewarmState = {
  status: "idle" | "warming" | "ready" | "error";
  key?: string;
  detail?: string;
  confirmation?: string;
  elapsedMs?: number;
};

type AudioHealthState = AudioHealthRequest & {
  turnId: string;
};

type RemoteSttSegment = {
  base64: string;
  bytes: number;
  durationMs: number;
  startedAt: number;
  stoppedAt: number;
};

type SpeechQueueItem = {
  id: string;
  start: number;
  end: number;
  text: string;
};

type SpeechLedgerItem = SpeechQueueItem & {
  status: "queued" | "speaking" | "spoken" | "failed";
  provider: TtsProvider;
};

const effortLabels: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh"
};

const modeLabels: Record<ScratchMode, string> = {
  voice: "Voice",
  text: "Text"
};

const ttsProviderLabels: Record<TtsProvider, string> = {
  browser: "Browser",
  "inworld-ws": "Inworld WS",
  elevenlabs: "ElevenLabs",
  "elevenlabs-ws": "ElevenLabs WS"
};

const sttProviderLabels: Record<SttProvider, string> = {
  "inworld-stt": "Inworld STT",
  whisper: "Whisper",
  browser: "Browser"
};

const transportLabels: Record<TransportProvider, string> = {
  "local-browser": "Local Browser",
  "livekit-webrtc": "LiveKit WebRTC"
};

const extractionTypeLabels: Record<ExtractedItem["type"], string> = {
  project_state: "Project State Update",
  prioritization: "Prioritisation Update",
  task: "Task Generated",
  risk: "Risk Update",
  backlog: "Backlog Update"
};

const extractionTypeShortLabels: Record<ExtractedItem["type"], string> = {
  project_state: "State",
  prioritization: "Priority",
  task: "Task",
  risk: "Risk",
  backlog: "Backlog"
};

const extractionTypeOrder: ExtractedItem["type"][] = ["project_state", "prioritization", "task", "risk", "backlog"];

const extractionStatusLabels: Record<ExtractionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  dismissed: "Dismissed",
  merged: "Merged"
};

const extractionReasons: Record<ExtractedItem["type"], string> = {
  project_state: "Picked because it looks like a durable project fact, decision, constraint, or operating rule.",
  prioritization: "Picked because it changes what matters now, next, later, or what is deferred.",
  task: "Picked because it looks like concrete work that can be implemented, tested, or marked done.",
  risk: "Picked because it names a failure mode, blocker, uncertainty, or safety issue.",
  backlog: "Picked because it was explicitly framed as future or deferred work."
};

function extractionEvidenceLabel(item: ExtractedItem): string {
  if (item.evidenceSource === "handoff_full") return "Evidence from full handoff";
  if (item.evidenceSource === "handoff_short") return "Evidence from short handoff";
  if (item.evidenceSource === "handoff") return "Evidence from handoff";
  if (item.evidenceSource === "session") return "Evidence from session metadata";
  if (item.evidenceSource === "production_json") return "Evidence from production state";
  if (item.evidenceSource === "production_md") return "Evidence from production notes";
  return "Evidence from transcript";
}

const SETTINGS_VERSION = "voice-mode-v5";
const modelOptions = ["default", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.3-codex"];
const modelLabels: Record<string, string> = {
  default: "Thread native",
  "gpt-5.5": "GPT-5.5 · full context",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex-spark": "Codex Spark · fast, smaller context",
  "gpt-5.3-codex": "Codex"
};
const MIN_SPEAKABLE_CHARS = 8;
const BROWSER_FIRST_CHUNK_CHARS = MIN_SPEAKABLE_CHARS;
const BROWSER_MIN_CHUNK_CHARS = 32;
const BROWSER_MAX_CHUNK_CHARS = 180;
const ELEVENLABS_FIRST_CHUNK_CHARS = 32;
const ELEVENLABS_MIN_CHUNK_CHARS = 80;
const ELEVENLABS_MAX_CHUNK_CHARS = 260;
const REMOTE_STT_SAMPLE_RATE = 16000;
const SOFT_STT_SEGMENT_MS = 10_000;
const HARD_STT_SEGMENT_MS = 18_000;
const MAX_LOCAL_SEGMENT_BYTES = 5 * 1024 * 1024;
const LIVE_MODE_RUNTIME_ENABLED = false;

function isElevenLabsProvider(provider: TtsProvider): boolean {
  return provider === "elevenlabs" || provider === "elevenlabs-ws" || provider === "inworld-ws";
}

function isStreamingWsProvider(provider: TtsProvider): boolean {
  return provider === "elevenlabs-ws" || provider === "inworld-ws";
}

function apiBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("api");
  return fromQuery ?? "http://127.0.0.1:5152";
}

function readStoredEffort(defaultEffort: ReasoningEffort): ReasoningEffort {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultEffort;
  const stored = window.localStorage.getItem("mortic.reasoningEffort");
  return reasoningEfforts.includes(stored as ReasoningEffort) ? (stored as ReasoningEffort) : defaultEffort;
}

function readStoredModel(defaultModel: string): string {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultModel;
  return window.localStorage.getItem("mortic.codexModel") || defaultModel;
}

function readStoredScratchMode(defaultMode: ScratchMode): ScratchMode {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultMode;
  const stored = window.localStorage.getItem("mortic.scratchMode");
  return scratchModes.includes(stored as ScratchMode) ? (stored as ScratchMode) : defaultMode;
}

function readStoredVoiceCaveman(): boolean {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return false;
  return window.localStorage.getItem("mortic.voiceCaveman") === "true";
}

function readStoredTtsProvider(defaultProvider: TtsProvider, availableProviders: TtsProvider[]): TtsProvider {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultProvider;
  const stored = window.localStorage.getItem("mortic.ttsProvider");
  return ttsProviders.includes(stored as TtsProvider) && availableProviders.includes(stored as TtsProvider)
    ? (stored as TtsProvider)
    : defaultProvider;
}

function readStoredSttProvider(defaultProvider: SttProvider, availableProviders: SttProvider[]): SttProvider {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultProvider;
  const stored = window.localStorage.getItem("mortic.sttProvider");
  return sttProviders.includes(stored as SttProvider) && availableProviders.includes(stored as SttProvider)
    ? (stored as SttProvider)
    : defaultProvider;
}

function readStoredTransportProvider(defaultProvider: TransportProvider, availableProviders: TransportProvider[]): TransportProvider {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultProvider;
  const stored = window.localStorage.getItem("mortic.transportProvider");
  return transportProviders.includes(stored as TransportProvider) && availableProviders.includes(stored as TransportProvider)
    ? (stored as TransportProvider)
    : defaultProvider;
}

function readStoredInputPolicy(): InputPolicy {
  if (window.localStorage.getItem("mortic.settingsVersion") !== SETTINGS_VERSION) return "push_to_talk";
  const stored = window.localStorage.getItem("mortic.inputPolicy");
  return stored === "live" ? "live" : "push_to_talk";
}

function isSpeakableText(text: string): boolean {
  return /[A-Za-z0-9]/.test(text) && text.trim().length >= MIN_SPEAKABLE_CHARS;
}

function findSentenceEnd(text: string, minChars: number): number | null {
  const sentencePattern = /[.!?](?=\s|$)|\n{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = sentencePattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minChars) return end;
  }
  return null;
}

function lastWhitespaceBefore(text: string, maxChars: number): number | null {
  const safeMax = Math.min(maxChars, text.length);
  const index = text.slice(0, safeMax).search(/\s+\S*$/);
  if (index <= 0) return null;
  return index;
}

function chooseSpeakableEnd(text: string, start: number, force: boolean, provider: TtsProvider): number | null {
  if (start >= text.length) return null;
  const remaining = text.slice(start);
  if (!isSpeakableText(remaining) && !force) return null;

  const minChars =
    isElevenLabsProvider(provider)
      ? start === 0
        ? ELEVENLABS_FIRST_CHUNK_CHARS
        : ELEVENLABS_MIN_CHUNK_CHARS
      : start === 0
        ? BROWSER_FIRST_CHUNK_CHARS
        : BROWSER_MIN_CHUNK_CHARS;
  const maxChars = isElevenLabsProvider(provider) ? ELEVENLABS_MAX_CHUNK_CHARS : BROWSER_MAX_CHUNK_CHARS;

  if (force) {
    return isSpeakableText(remaining) ? text.length : null;
  }

  const sentenceEnd = findSentenceEnd(remaining, minChars);
  if (sentenceEnd !== null) return start + sentenceEnd;

  if (remaining.length < maxChars) return null;
  const whitespaceEnd = lastWhitespaceBefore(remaining, maxChars);
  return start + (whitespaceEnd ?? maxChars);
}

function rangeSummary(items: SpeechLedgerItem[], statuses: SpeechLedgerItem["status"][]): string {
  return items
    .filter((item) => statuses.includes(item.status))
    .map((item) => `${item.start}-${item.end}`)
    .join(",");
}

function entryLabel(entry: TranscriptEntry): string {
  if (entry.role === "user") return "You";
  if (entry.failed) return "Mortic error";
  return "Mortic";
}

function entryMainText(entry: TranscriptEntry): string {
  if (entry.notesText && entry.spokenText) return entry.spokenText;
  return entry.text;
}

function entryNotesLabel(entry: TranscriptEntry): string {
  return entry.spokenText ? "Read" : "Notes";
}

function entryParserLabel(entry: TranscriptEntry): string | null {
  if (!entry.parserMode) return null;
  if (entry.parserMode === "invalid") return "Parser failed";
  if (entry.parserError) return "Parser warning";
  return null;
}

function MarkdownContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
      {markdown}
    </ReactMarkdown>
  );
}

function normalizeExtractionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/^#+\s+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeExtractionItems(items: ExtractedItem[]): ExtractedItem[] {
  const byKey = new Map<string, ExtractedItem>();
  for (const item of items) {
    const key = `${item.type}:${normalizeExtractionText(item.title || item.body)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const currentRank = item.status === "approved" ? 2 : item.status === "draft" ? 1 : 0;
    const existingRank = existing.status === "approved" ? 2 : existing.status === "draft" ? 1 : 0;
    if (currentRank > existingRank || item.updatedAt > existing.updatedAt) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function friendlySpeechError(error: string): string {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone or browser speech recognition is not allowed in this browser. Allow microphone access for this localhost page, or use the text box.";
  }

  if (error === "no-speech") {
    return "I did not catch speech. Try again or use the text box.";
  }

  if (error === "network") {
    return "Browser speech recognition hit a network error. Use the text box if it keeps failing.";
  }

  return `Speech recognition failed: ${error}`;
}

function shouldSwitchRemoteSttToBrowser(error: string): boolean {
  const clean = error.toLowerCase();
  return (
    clean.includes("no credits remaining") ||
    clean.includes("add credits") ||
    clean.includes("insufficient credits") ||
    clean.includes("quota") ||
    clean.includes("billing")
  );
}

function formatMs(ms: number | undefined): string {
  if (typeof ms !== "number") return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatSignedMs(ms: number | undefined): string {
  if (typeof ms !== "number") return "-";
  const sign = ms >= 0 ? "+" : "-";
  return `${sign}${formatMs(Math.abs(ms))}`;
}

function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== "number") return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPercent(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return `${Math.round(value * 100)}%`;
}

function mergeFloat32(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function downsampleFloat32(buffer: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (outputRate === inputRate) return buffer;
  if (outputRate > inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accumulator = 0;
    let count = 0;
    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accumulator += buffer[index];
      count += 1;
    }
    result[offsetResult] = count > 0 ? accumulator / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function audioContextConstructor(): AudioContextConstructor | null {
  const candidate = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}

function needsModelTransitionPreflight(model: string): boolean {
  return modelProfile(model).id !== "default";
}

function sparkPreflightLabel(preflight: SparkContextPreflight | null, pending: boolean): string {
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

function clientUnknownSparkPreflight(threadId: string, detail: string): SparkContextPreflight {
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

export function App() {
  const api = useMemo(apiBase, []);
  const [state, setState] = useState<ApiState>({ session: null, loading: true, error: null });
  const [scratchMode, setScratchMode] = useState<ScratchMode>("voice");
  const [voiceCaveman, setVoiceCaveman] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("none");
  const [codexModel, setCodexModel] = useState("default");
  const [sparkApprovalKey, setSparkApprovalKey] = useState("");
  const [sparkPreflight, setSparkPreflight] = useState<SparkContextPreflight | null>(null);
  const [sparkPreflightPending, setSparkPreflightPending] = useState(false);
  const [sparkCompactionPending, setSparkCompactionPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [handoffPending, setHandoffPending] = useState(false);
  const [handoff, setHandoff] = useState("");
  const [shortHandoff, setShortHandoff] = useState("");
  const [fullHandoff, setFullHandoff] = useState("");
  const [projectState, setProjectState] = useState<ProjectStateResponse | null>(null);
  const [projectPending, setProjectPending] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [canonicalState, setCanonicalState] = useState<ProjectCanonicalStateResponse | null>(null);
  const [canonicalStateOpen, setCanonicalStateOpen] = useState(false);
  const [canonicalStatePending, setCanonicalStatePending] = useState(false);
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false);
  const [handoffReviewOpen, setHandoffReviewOpen] = useState(false);
  const [extractionReviewOpen, setExtractionReviewOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");
  const [sourcePending, setSourcePending] = useState(false);
  const [prewarm, setPrewarm] = useState<PrewarmState>({ status: "idle" });
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({
    defaultProvider: "browser",
    availableProviders: ["browser"],
    inworldConfigured: false,
    elevenLabsConfigured: false
  });
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("browser");
  const [sttStatus, setSttStatus] = useState<SttStatus>({
    defaultProvider: "browser",
    availableProviders: ["browser"],
    inworldConfigured: false,
    openAIConfigured: false
  });
  const [sttProvider, setSttProvider] = useState<SttProvider>("browser");
  const [liveKitStatus, setLiveKitStatus] = useState<LiveKitStatus>({
    configured: false,
    defaultTransport: "local-browser",
    availableTransports: ["local-browser"]
  });
  const [transportProvider, setTransportProvider] = useState<TransportProvider>("local-browser");
  const [transportState, setTransportState] = useState<TransportState>("disconnected");
  const [transportStats, setTransportStats] = useState<LiveKitTransportStats>({
    reconnects: 0,
    trackState: "none",
    muted: true,
    audioLevel: 0
  });
  const [transportNotice, setTransportNotice] = useState<string | null>(null);
  const [inputPolicy, setInputPolicy] = useState<InputPolicy>("push_to_talk");
  const [captureState, setCaptureState] = useState<CaptureState>("muted");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [lastSttTurnMetrics, setLastSttTurnMetrics] = useState<SttTurnMetrics | null>(null);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [audioHealth, setAudioHealth] = useState<AudioHealthState | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [ttsProviderNotice, setTtsProviderNotice] = useState<string | null>(null);
  const [sttProviderNotice, setSttProviderNotice] = useState<string | null>(null);
  const [sttPhase, setSttPhase] = useState<"idle" | "listening" | "transcribing">("idle");
  const [lastSttMeta, setLastSttMeta] = useState<{ provider: SttProvider; elapsedMs: number; bytes: number; fallbackReason?: string } | null>(null);
  const [uiDispatchMs, setUiDispatchMs] = useState<number | null>(null);
  const [liveModeActive, setLiveModeActive] = useState(false);
  const [speechPhase, setSpeechPhase] = useState<"idle" | "buffering" | "speaking">("idle");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioCaptureRef = useRef<{
    stream: MediaStream;
    context: AudioContext;
    processor: ScriptProcessorNode;
    source: MediaStreamAudioSourceNode;
    sink: GainNode;
    chunks: Float32Array[];
    startedAt: number;
    segmentStartedAt: number;
    sessionStartedAt: number;
    sessionId: number;
    segments: RemoteSttSegment[];
    firstSpeechDetectedMs?: number;
  } | null>(null);
  const liveKitTransportRef = useRef<MorticLiveKitTransport | null>(null);
  const recognitionSessionRef = useRef(0);
  const holdingToTalkRef = useRef(false);
  const spaceHeldRef = useRef(false);
  const liveModeActiveRef = useRef(false);
  const liveToggleComboDownRef = useRef(false);
  const speechPhaseRef = useRef<"idle" | "buffering" | "speaking">("idle");
  const sttPhaseRef = useRef<"idle" | "listening" | "transcribing">("idle");
  const recognizingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const discardSpeechOnEndRef = useRef(false);
  const speechBufferRef = useRef("");
  const interimBufferRef = useRef("");
  const streamRef = useRef<EventSource | null>(null);
  const liveAssistantTextRef = useRef("");
  const speechQueueRef = useRef<SpeechQueueItem[]>([]);
  const speechLedgerRef = useRef<SpeechLedgerItem[]>([]);
  const lastQueuedCharRef = useRef(0);
  const spokenCharsRef = useRef(0);
  const speakingRef = useRef(false);
  const finishSpeechAfterQueueRef = useRef(false);
  const spokenChunkCountRef = useRef(0);
  const pttViewportRestoreRef = useRef<{ x: number; y: number; until: number } | null>(null);
  const ttsRuntimeRef = useRef<RuntimeTtsProvider | null>(null);
  const currentTurnIdRef = useRef<string | null>(null);
  const currentTurnScratchModeRef = useRef<ScratchMode | null>(null);
  const audioTimingBaseRef = useRef<number | null>(null);
  const audioHealthRef = useRef<AudioHealthState | null>(null);
  const prewarmKeyRef = useRef("");
  const prewarmAnnouncementKeyRef = useRef("");
  const prewarmAnnouncementGenerationRef = useRef(0);
  const [liveAssistantText, setLiveAssistantText] = useState("");

  const recognitionSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const remoteSttSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(audioContextConstructor());
  const activeSttSupported = sttProvider === "browser" ? recognitionSupported : remoteSttSupported;
  const effectiveCodexModel = codexModel;
  const voiceSafeReasoningEffort = scratchMode === "voice" && reasoningEffort === "minimal" ? "none" : reasoningEffort;
  const effectiveReasoningEffort = effectiveReasoningForModel(effectiveCodexModel, voiceSafeReasoningEffort);
  const effectiveVoiceCaveman = scratchMode === "voice" && voiceCaveman;
  const session = state.session;
  const transcript = session?.transcript ?? [];
  const activeTurn = session?.activeTurn;
  const currentSparkPreflight =
    sparkPreflight?.threadId === session?.threadId && sparkPreflight?.candidateModel === effectiveCodexModel
      ? sparkPreflight
      : null;
  const sparkContext = useMemo(() => {
    if (!needsModelTransitionPreflight(effectiveCodexModel)) {
      return {
        key: "",
        status: "not_applicable" as const,
        requiresApproval: false,
        compactionRequired: false,
        manualStartAllowed: false,
        label: "Native model selected"
      };
    }

    const key = [
      session?.threadId ?? "no-thread",
      effectiveCodexModel,
      effectiveReasoningEffort,
      scratchMode,
      effectiveVoiceCaveman ? "caveman-on" : "caveman-off",
      currentSparkPreflight?.status ?? "hard-block",
      currentSparkPreflight?.inputTokens ?? "unknown",
      currentSparkPreflight?.updatedAt ?? "no-timestamp"
    ].join("|");
    const status = currentSparkPreflight?.status ?? "hard-block";
    return {
      key,
      status,
      requiresApproval: !(currentSparkPreflight?.automaticStartAllowed ?? false),
      compactionRequired: currentSparkPreflight?.compactionRequired ?? false,
      manualStartAllowed: currentSparkPreflight?.manualStartAllowed ?? false,
      label: sparkPreflightLabel(currentSparkPreflight, sparkPreflightPending)
    };
  }, [
    currentSparkPreflight,
    effectiveCodexModel,
    effectiveReasoningEffort,
    effectiveVoiceCaveman,
    scratchMode,
    session?.threadId,
    sparkPreflightPending
  ]);
  const sparkApproved =
    !sparkContext.requiresApproval ||
    (!sparkPreflightPending && !sparkContext.compactionRequired && sparkApprovalKey === sparkContext.key);
  const sparkBlocked =
    needsModelTransitionPreflight(effectiveCodexModel) && (sparkPreflightPending || sparkCompactionPending || !sparkApproved);

  useEffect(() => {
    liveModeActiveRef.current = liveModeActive;
  }, [liveModeActive]);

  useEffect(() => {
    speechPhaseRef.current = speechPhase;
  }, [speechPhase]);

  useEffect(() => {
    sttPhaseRef.current = sttPhase;
  }, [sttPhase]);

  useEffect(() => {
    recognizingRef.current = recognizing;
  }, [recognizing]);

  function setTurnPending(nextPending: boolean) {
    pendingRef.current = nextPending;
    setPending(nextPending);
  }

  function elapsedSinceTurnStart(): number | undefined {
    if (audioTimingBaseRef.current === null) return undefined;
    return Math.max(0, Math.round(performance.now() - audioTimingBaseRef.current));
  }

  function firstTimingPatch<K extends keyof AudioHealthRequest>(key: K): Pick<AudioHealthRequest, K> | null {
    const elapsed = elapsedSinceTurnStart();
    if (elapsed === undefined || audioHealthRef.current?.[key] !== undefined) return null;
    return { [key]: elapsed } as Pick<AudioHealthRequest, K>;
  }

  function finishPrewarmAnnouncement(generation: number): void {
    if (prewarmAnnouncementGenerationRef.current !== generation || pendingRef.current) return;
    setSpeechPhase("idle");
  }

  function announcePrewarmConfirmation(key: string, confirmation: string | undefined, mode: ScratchMode): void {
    const text = confirmation?.trim();
    if (!text || mode !== "voice") return;
    if (prewarmAnnouncementKeyRef.current === key) return;

    if (pendingRef.current || recognitionRef.current) return;
    const provider = ttsRuntimeRef.current;
    if (!provider) {
      window.setTimeout(() => announcePrewarmConfirmation(key, text, mode), 250);
      return;
    }
    prewarmAnnouncementKeyRef.current = key;

    const generation = prewarmAnnouncementGenerationRef.current + 1;
    prewarmAnnouncementGenerationRef.current = generation;
    setSpeechPhase("buffering");

    const callbacks: TtsSpeakCallbacks = {
      onStart: () => {
        if (prewarmAnnouncementGenerationRef.current === generation) setSpeechPhase("speaking");
      },
      onAudioPlay: () => {
        if (prewarmAnnouncementGenerationRef.current === generation) setSpeechPhase("speaking");
      },
      onStatus: (status) => setTtsProviderNotice(status),
      onClose: () => window.setTimeout(() => finishPrewarmAnnouncement(generation), 250)
    };

    provider.beginTurn?.(callbacks);
    void provider
      .speak(text, callbacks)
      .then((result) => {
        provider.finishTurn?.();
        if (result.fallbackReason) {
          const providerLabel = ttsProviderLabels[ttsProvider];
          setTtsProviderNotice(`${providerLabel} unavailable, using Browser`);
        }
        if (!isStreamingWsProvider(result.spokenBy)) {
          finishPrewarmAnnouncement(generation);
          return;
        }

        const estimatedSpeechMs = Math.max(1200, Math.min(5000, text.split(/\s+/).filter(Boolean).length * 320));
        window.setTimeout(() => finishPrewarmAnnouncement(generation), estimatedSpeechMs);
      })
      .catch((error) => {
        if (prewarmAnnouncementGenerationRef.current !== generation) return;
        setSpeechPhase("idle");
        setSpeechError(`Ready announcement failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  async function refreshProject(): Promise<void> {
    try {
      const response = await fetch(`${api}/api/project`);
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? `Project request failed: ${response.status}`);
      }
      setProjectState(payload);
      setProjectError(null);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openCanonicalState(): Promise<void> {
    if (canonicalStatePending) return;
    setCanonicalStatePending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/canonical-state`);
      const payload = (await response.json()) as ProjectCanonicalStateResponse & { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? `Canonical state request failed: ${response.status}`);
      }
      setCanonicalState(payload);
      setCanonicalStateOpen(true);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setCanonicalStatePending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`${api}/api/session`);
        if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
        const payload = await response.json();
        if (cancelled) return;
        const defaultEffort = payload.defaultReasoningEffort as ReasoningEffort;
        const defaultModel = payload.defaultCodexModel as string;
        const defaultMode = (payload.defaultScratchMode ?? "voice") as ScratchMode;
        const tts = payload.tts as TtsStatus;
        const stt = payload.stt as SttStatus;
        const livekit = payload.livekit as LiveKitStatus | undefined;
        setScratchMode(readStoredScratchMode(defaultMode));
        setVoiceCaveman(readStoredVoiceCaveman());
        setReasoningEffort(readStoredEffort(defaultEffort));
        setCodexModel(readStoredModel(defaultModel));
        setTtsStatus(tts);
        setTtsProvider(readStoredTtsProvider(tts.defaultProvider, tts.availableProviders));
        setSttStatus(stt);
        setSttProvider(readStoredSttProvider(stt.defaultProvider, stt.availableProviders));
        if (livekit) {
          setLiveKitStatus(livekit);
          setTransportProvider(readStoredTransportProvider(livekit.defaultTransport, livekit.availableTransports));
        }
        setInputPolicy("push_to_talk");
        setLiveModeActive(false);
        setState({ session: payload.session, loading: false, error: null });
        setSourceDraft(payload.session.sourceUri);
        setHandoff(payload.session.handoff ?? "");
        setShortHandoff(payload.session.handoffShort ?? "");
        setFullHandoff(payload.session.handoffFull ?? "");
        setSettingsHydrated(true);
        void refreshProject();
      } catch (error) {
        if (cancelled) return;
        setState({
          session: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        });
        setSettingsHydrated(true);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.reasoningEffort", voiceSafeReasoningEffort);
  }, [settingsHydrated, voiceSafeReasoningEffort]);

  useEffect(() => {
    if (scratchMode === "voice" && reasoningEffort === "minimal") {
      setReasoningEffort("none");
    }
  }, [reasoningEffort, scratchMode]);

  useEffect(() => {
    if (!state.session) return;
    void refreshProject();
  }, [state.session?.updatedAt, state.session?.transcript.length, state.session?.handoff, state.session?.handoffShort, state.session?.handoffFull]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.codexModel", codexModel);
  }, [settingsHydrated, codexModel]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.scratchMode", scratchMode);
  }, [settingsHydrated, scratchMode]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.voiceCaveman", String(voiceCaveman));
  }, [settingsHydrated, voiceCaveman]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.ttsProvider", ttsProvider);
  }, [settingsHydrated, ttsProvider]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.sttProvider", sttProvider);
  }, [settingsHydrated, sttProvider]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.transportProvider", transportProvider);
  }, [settingsHydrated, transportProvider]);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem("mortic.settingsVersion", SETTINGS_VERSION);
    window.localStorage.setItem("mortic.inputPolicy", inputPolicy);
  }, [settingsHydrated, inputPolicy]);

  useEffect(() => {
    const threadId = state.session?.threadId;
    if (!threadId || !needsModelTransitionPreflight(effectiveCodexModel)) {
      setSparkPreflight(null);
      setSparkPreflightPending(false);
      setSparkApprovalKey("");
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setSparkPreflight(null);
    setSparkPreflightPending(true);
    setSparkApprovalKey("");

    void (async () => {
      try {
        const query = new URLSearchParams({
          codexModel: effectiveCodexModel,
          reasoningEffort: effectiveReasoningEffort,
          scratchMode,
          voiceCaveman: String(effectiveVoiceCaveman)
        });
        const response = await fetch(`${api}/api/session/spark-context?${query.toString()}`, {
          signal: controller.signal
        });
        const payload = (await response.json()) as SparkContextPreflightResponse & { error?: string };
        if (cancelled) return;

        if (!response.ok || !payload.preflight) {
          setSparkPreflight(clientUnknownSparkPreflight(
            threadId,
            payload.error ?? "Candidate model context preflight failed. Mortic will not start the model automatically."
          ));
          return;
        }

        setSparkPreflight(payload.preflight);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        setSparkPreflight(clientUnknownSparkPreflight(
          threadId,
          error instanceof Error ? error.message : String(error)
        ));
      } finally {
        if (!cancelled) setSparkPreflightPending(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, effectiveCodexModel, effectiveReasoningEffort, effectiveVoiceCaveman, scratchMode, state.session?.threadId]);

  useEffect(() => {
    const session = state.session;
    if (!session || state.loading || pending || handoffPending || sourcePending) return;
    if (session.activeTurn?.status === "running") return;
    if (!effectiveCodexModel.trim()) return;
    if (needsModelTransitionPreflight(effectiveCodexModel) && (sparkCompactionPending || !sparkApproved)) {
      prewarmKeyRef.current = "";
      setPrewarm({
        status: "idle",
        detail: sparkCompactionPending ? "Scratch compaction is running" : sparkContext.label
      });
      return;
    }

    const key = `${session.threadId}|${scratchMode}|${effectiveCodexModel}|${effectiveReasoningEffort}|caveman:${effectiveVoiceCaveman ? "on" : "off"}`;
    if (prewarmKeyRef.current === key) return;

    const controller = new AbortController();
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      prewarmKeyRef.current = key;
      setPrewarm({
        status: "warming",
        key,
        detail: `${modeLabels[scratchMode]} · ${effectiveCodexModel} · ${effortLabels[effectiveReasoningEffort]}${
          scratchMode === "voice" ? ` · Caveman ${effectiveVoiceCaveman ? "on" : "off"}` : ""
        }`
      });

      try {
        const response = await fetch(`${api}/api/session/prewarm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            scratchMode,
            reasoningEffort: effectiveReasoningEffort,
            codexModel: effectiveCodexModel,
            voiceCaveman: effectiveVoiceCaveman,
            allowModelContextRisk: sparkApproved,
            allowSparkContextRisk: sparkApproved
          }),
          signal: controller.signal
        });
        const payload = (await response.json()) as PrewarmResponse & { error?: string };
        if (cancelled) return;

        if (!response.ok) {
          const sparkPayload = payload as PrewarmResponse & { error?: string; sparkPreflight?: SparkContextPreflight };
          if (sparkPayload.sparkPreflight) {
            setSparkPreflight(sparkPayload.sparkPreflight);
            setSparkApprovalKey("");
          }
          prewarmKeyRef.current = "";
          prewarmAnnouncementKeyRef.current = "";
          setPrewarm({
            status: "error",
            key,
            detail: payload.error ?? "Scratch prewarm failed",
            elapsedMs: payload.prewarmMs
          });
          return;
        }

        setPrewarm({
          status: "ready",
          key,
          detail: `${modeLabels[payload.scratchMode]} · ${payload.codexModel} · ${effortLabels[payload.reasoningEffort]}${
            payload.scratchMode === "voice" ? ` · Caveman ${payload.voiceCaveman ? "on" : "off"}` : ""
          }${payload.prewarmConfirmation ? ` · ${payload.prewarmConfirmation}` : ""}`,
          confirmation: payload.prewarmConfirmation,
          elapsedMs: payload.prewarmMs
        });
        announcePrewarmConfirmation(key, payload.prewarmConfirmation, payload.scratchMode);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        prewarmKeyRef.current = "";
        prewarmAnnouncementKeyRef.current = "";
        setPrewarm({
          status: "error",
          key,
          detail: error instanceof Error ? error.message : String(error)
        });
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    api,
    state.session?.threadId,
    state.session?.activeTurn?.status,
    state.loading,
    scratchMode,
    effectiveCodexModel,
    effectiveReasoningEffort,
    effectiveVoiceCaveman,
    sparkApproved,
    sparkCompactionPending,
    sparkContext.label,
    pending,
    handoffPending,
    sourcePending
  ]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const warmup = new SpeechSynthesisUtterance("");
    window.speechSynthesis.speak(warmup);
    window.speechSynthesis.cancel();
  }, []);

  useEffect(() => {
    const browserProvider = createBrowserTtsProvider();
    const elevenLabsWsProvider = createElevenLabsWsTtsProvider(api, browserProvider);
    ttsRuntimeRef.current =
      ttsProvider === "inworld-ws"
        ? createInworldWsTtsProvider(api, elevenLabsWsProvider)
        : ttsProvider === "elevenlabs"
        ? createElevenLabsTtsProvider(api, browserProvider)
        : ttsProvider === "elevenlabs-ws"
          ? elevenLabsWsProvider
        : browserProvider;

    return () => {
      ttsRuntimeRef.current?.cancel();
    };
  }, [api, ttsProvider]);

  useEffect(() => {
    let cancelled = false;
    if (ttsProvider === "inworld-ws") {
      setTtsProviderNotice("Inworld WS selected; ElevenLabs then Browser fallback active");
      return () => {
        cancelled = true;
      };
    }
    if (ttsProvider === "elevenlabs-ws") {
      setTtsProviderNotice("ElevenLabs WS selected; Browser fallback active");
      return () => {
        cancelled = true;
      };
    }
    if (ttsProvider !== "elevenlabs") {
      setTtsProviderNotice(null);
      return () => {
        cancelled = true;
      };
    }

    setTtsProviderNotice("Checking ElevenLabs");
    fetch(`${api}/api/tts/elevenlabs/health`)
      .then(async (response) => {
        const payload = (await response.json()) as ElevenLabsHealthResponse;
        if (cancelled) return;
        if (payload.available) {
          setTtsProviderNotice(`ElevenLabs ready ${formatMs(payload.elapsedMs)}`);
          return;
        }
        setTtsProviderNotice(`ElevenLabs unavailable, using Browser (${payload.status}${payload.detail ? `: ${payload.detail}` : ""})`);
      })
      .catch((error) => {
        if (cancelled) return;
        setTtsProviderNotice(`ElevenLabs unavailable, using Browser (${error instanceof Error ? error.message : String(error)})`);
      });

    return () => {
      cancelled = true;
    };
  }, [api, ttsProvider]);

  useEffect(() => {
    if (sttProvider === "inworld-stt") {
      setSttProviderNotice(
        sttStatus.inworldConfigured
          ? `Inworld STT ready${sttStatus.inworldModel ? ` · ${sttStatus.inworldModel}` : ""}; Whisper fallback active`
          : "Inworld STT unavailable; set INWORLD_API_KEY or choose Browser"
      );
      return;
    }
    if (sttProvider === "whisper") {
      setSttProviderNotice(
        sttStatus.openAIConfigured
          ? `Whisper ready${sttStatus.whisperModel ? ` · ${sttStatus.whisperModel}` : ""}`
          : "Whisper unavailable; set OPENAI_API_KEY or choose Browser"
      );
      return;
    }
    setSttProviderNotice(recognitionSupported ? "Browser STT ready" : "Browser STT unavailable in this browser");
  }, [recognitionSupported, sttProvider, sttStatus.inworldConfigured, sttStatus.inworldModel, sttStatus.openAIConfigured, sttStatus.whisperModel]);

  useEffect(() => {
    if (transportProvider !== "livekit-webrtc") {
      setTransportState("disconnected");
      setTransportNotice("Local browser audio transport selected");
      void liveKitTransportRef.current?.disconnect();
      liveKitTransportRef.current = null;
      return;
    }

    if (!liveKitStatus.configured) {
      setTransportState("failed");
      setTransportNotice(liveKitStatus.error ?? "LiveKit is not configured");
      return;
    }

    const transport = new MorticLiveKitTransport(api, {
      onState: setTransportState,
      onStats: setTransportStats,
      onError: (error) => {
        setTransportState("failed");
        setTransportNotice(error);
      }
    });
    liveKitTransportRef.current = transport;
    const roomName = session?.threadId ? `mortic-${session.threadId.slice(0, 8)}` : "mortic-local";
    setTransportState("connecting");
    setTransportNotice("Connecting LiveKit WebRTC");
    void transport
      .connect(roomName)
      .then(() => {
        setTransportNotice("LiveKit WebRTC connected; mic stays muted until Push-to-talk or Live mode accepts audio");
      })
      .catch((error) => {
        setTransportState("failed");
        setTransportNotice(error instanceof Error ? error.message : String(error));
      });

    return () => {
      void transport.disconnect();
      if (liveKitTransportRef.current === transport) liveKitTransportRef.current = null;
    };
  }, [api, liveKitStatus.configured, liveKitStatus.error, session?.threadId, transportProvider]);

  useEffect(() => {
    if (state.error || speechError) {
      setAgentState("error");
      return;
    }
    if (pending) {
      setAgentState(speechPhase === "speaking" ? "speaking" : liveAssistantText ? "speaking" : "thinking");
      return;
    }
    if (sttPhase === "transcribing") {
      setAgentState("transcribing");
      return;
    }
    if (recognizing) {
      setAgentState("listening");
      return;
    }
    if (prewarm.status === "warming") {
      setAgentState("warming");
      return;
    }
    setAgentState("idle");
  }, [liveAssistantText, pending, prewarm.status, recognizing, speechError, speechPhase, state.error, sttPhase]);

  useEffect(() => {
    return () => {
      resetSpeechPlayback();
    };
  }, []);

  function updateAudioHealth(patch: Partial<AudioHealthState>): AudioHealthState | null {
    const current = audioHealthRef.current;
    if (!current) return null;
    const next = {
      ...current,
      ...patch
    };
    audioHealthRef.current = next;
    setAudioHealth(next);
    return next;
  }

  function syncAudioLedger(provider: TtsProvider = ttsProvider): AudioHealthState | null {
    const queuedRanges = rangeSummary(speechLedgerRef.current, ["queued", "speaking", "spoken", "failed"]);
    const spokenRanges = rangeSummary(speechLedgerRef.current, ["spoken"]);
    return updateAudioHealth({
      provider,
      queuedChars: lastQueuedCharRef.current,
      spokenChars: spokenCharsRef.current,
      queuedRanges,
      spokenRanges,
      spokenChunks: speechLedgerRef.current.length
    });
  }

  function startAudioHealth(turnId: string, startedAtMs: number) {
    currentTurnIdRef.current = turnId;
    currentTurnScratchModeRef.current = "voice";
    audioTimingBaseRef.current = startedAtMs;
    spokenChunkCountRef.current = 0;
    lastQueuedCharRef.current = 0;
    spokenCharsRef.current = 0;
    finishSpeechAfterQueueRef.current = false;
    speechLedgerRef.current = [];
    const next: AudioHealthState = {
      turnId,
      provider: ttsProvider,
      streamedChars: 0,
      queuedChars: 0,
      spokenChars: 0,
      queuedRanges: "",
      spokenRanges: "",
      spokenChunks: 0,
      audioBufferUnderruns: 0
    };
    audioHealthRef.current = next;
    setAudioHealth(next);
    ttsRuntimeRef.current?.beginTurn?.(ttsDiagnosticsCallbacks());
  }

  function startTextTurnTracking(turnId: string, startedAtMs: number) {
    currentTurnIdRef.current = turnId;
    currentTurnScratchModeRef.current = "text";
    audioTimingBaseRef.current = startedAtMs;
    audioHealthRef.current = null;
    setAudioHealth(null);
    setSpeechPhase("idle");
  }

  async function syncAudioHealth(turnId: string) {
    const health = audioHealthRef.current;
    if (!health || health.turnId !== turnId) return;

    try {
      const response = await fetch(`${api}/api/turn/${turnId}/audio-health`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          provider: health.provider,
          streamedChars: health.streamedChars,
          finalChars: health.finalChars,
          queuedChars: health.queuedChars,
          spokenChars: health.spokenChars,
          queuedRanges: health.queuedRanges,
          spokenRanges: health.spokenRanges,
          spokenChunks: health.spokenChunks,
          ttsError: health.ttsError,
          ttsProviderStatus: health.ttsProviderStatus,
          firstVisibleTextMs: health.firstVisibleTextMs,
          firstSpeakableTextMs: health.firstSpeakableTextMs,
          firstSpeechQueuedMs: health.firstSpeechQueuedMs,
          firstSpeechStartMs: health.firstSpeechStartMs,
          firstSpeechEndMs: health.firstSpeechEndMs,
          ttsConnectMs: health.ttsConnectMs,
          firstAudioChunkMs: health.firstAudioChunkMs,
          firstAudioPlayMs: health.firstAudioPlayMs,
          audioBufferUnderruns: health.audioBufferUnderruns,
          ttsCloseCode: health.ttsCloseCode,
          ttsCloseReason: health.ttsCloseReason,
          finalTextMs: health.finalTextMs,
          speechAfterFinalMs: health.speechAfterFinalMs
        })
      });
      const payload = await response.json();
      if (payload.session) {
        setState({ session: payload.session, loading: false, error: response.ok ? null : payload.error ?? "Audio health update failed" });
      }
    } catch (error) {
      console.warn("[Mortic] audio health update failed", error);
    }
  }

  function updateAudioHealthAndSync(patch: Partial<AudioHealthState>): void {
    const next = updateAudioHealth(patch);
    if (next && currentTurnIdRef.current) void syncAudioHealth(currentTurnIdRef.current);
  }

  function recordFirstAudioTiming<K extends keyof AudioHealthRequest>(key: K): void {
    const patch = firstTimingPatch(key);
    if (patch) updateAudioHealthAndSync(patch);
  }

  function ttsDiagnosticsCallbacks(onStart?: () => void): TtsSpeakCallbacks {
    return {
      onStart,
      onConnect: () => recordFirstAudioTiming("ttsConnectMs"),
      onAudioChunk: () => recordFirstAudioTiming("firstAudioChunkMs"),
      onAudioPlay: () => recordFirstAudioTiming("firstAudioPlayMs"),
      onBufferUnderrun: () => {
        const current = audioHealthRef.current?.audioBufferUnderruns ?? 0;
        updateAudioHealthAndSync({ audioBufferUnderruns: current + 1 });
      },
      onClose: (code, reason) => {
        updateAudioHealthAndSync({
          ttsCloseCode: code,
          ttsCloseReason: reason
        });
      },
      onStatus: (status) => {
        updateAudioHealthAndSync({ ttsProviderStatus: status });
      }
    };
  }

  function finishSpeechTurnIfReady(): void {
    if (!finishSpeechAfterQueueRef.current || speakingRef.current || speechQueueRef.current.length > 0) return;
    finishSpeechAfterQueueRef.current = false;
    ttsRuntimeRef.current?.finishTurn?.();
  }

  async function flushSpeechQueue() {
    if (speakingRef.current) return;
    const next = speechQueueRef.current.shift();
    if (!next) {
      finishSpeechTurnIfReady();
      const hasUnqueuedText = liveAssistantTextRef.current.length > lastQueuedCharRef.current;
      setSpeechPhase(pending && hasUnqueuedText ? "buffering" : "idle");
      return;
    }

    speakingRef.current = true;
    setSpeechPhase("speaking");
    speechLedgerRef.current = speechLedgerRef.current.map((item) =>
      item.id === next.id ? { ...item, status: "speaking" } : item
    );
    syncAudioLedger();
    try {
      const provider = ttsRuntimeRef.current;
      if (!provider) throw new Error("TTS provider is not ready");
      let speechStartRecorded = false;
      const recordSpeechStart = () => {
        if (speechStartRecorded) return;
        speechStartRecorded = true;
        const patch = firstTimingPatch("firstSpeechStartMs");
        if (!patch) return;
        const finalTextMs = audioHealthRef.current?.finalTextMs;
        updateAudioHealth({
          ...patch,
          speechAfterFinalMs: finalTextMs !== undefined ? (patch.firstSpeechStartMs as number) - finalTextMs : undefined
        });
        if (currentTurnIdRef.current) void syncAudioHealth(currentTurnIdRef.current);
      };
      const result = await provider.speak(next.text, ttsDiagnosticsCallbacks(recordSpeechStart));
      if (!isStreamingWsProvider(result.spokenBy)) recordSpeechStart();
      speechLedgerRef.current = speechLedgerRef.current.map((item) =>
        item.id === next.id ? { ...item, status: "spoken", provider: result.spokenBy } : item
      );
      spokenCharsRef.current = Math.max(spokenCharsRef.current, next.end);
      spokenChunkCountRef.current = speechLedgerRef.current.filter((item) => item.status === "spoken").length;
      const endPatch = isStreamingWsProvider(result.spokenBy) ? null : firstTimingPatch("firstSpeechEndMs");
      syncAudioLedger(result.spokenBy);
      if (endPatch) updateAudioHealth(endPatch);
      if (endPatch && currentTurnIdRef.current) void syncAudioHealth(currentTurnIdRef.current);
      if (result.fallbackReason) {
        const providerLabel = ttsProviderLabels[ttsProvider];
        const fallbackLabel = ttsProviderLabels[result.spokenBy];
        const message = `${providerLabel} unavailable, using ${fallbackLabel}: ${result.fallbackReason}`;
        setTtsProviderNotice(`${providerLabel} unavailable, using ${fallbackLabel}`);
        updateAudioHealth({ ttsProviderStatus: message });
        if (currentTurnIdRef.current) void syncAudioHealth(currentTurnIdRef.current);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[Mortic] text-to-speech stopped", {
        error: message,
        textChars: next.text.length
      });
      setSpeechError(`Text-to-speech stopped: ${message}`);
      speechLedgerRef.current = speechLedgerRef.current.map((item) =>
        item.id === next.id ? { ...item, status: "failed" } : item
      );
      syncAudioLedger();
      updateAudioHealth({ ttsError: message });
      if (currentTurnIdRef.current) void syncAudioHealth(currentTurnIdRef.current);
    } finally {
      speakingRef.current = false;
      finishSpeechTurnIfReady();
      void flushSpeechQueue();
    }
  }

  function enqueueSpeechRange(start: number, end: number, text: string) {
    if (end <= start || !isSpeakableText(text)) {
      lastQueuedCharRef.current = Math.max(lastQueuedCharRef.current, end);
      return;
    }
    const item: SpeechQueueItem = {
      id: `${start}-${end}-${speechLedgerRef.current.length}`,
      start,
      end,
      text
    };
    lastQueuedCharRef.current = end;
    const queuedPatch = firstTimingPatch("firstSpeechQueuedMs");
    speechLedgerRef.current.push({
      ...item,
      status: "queued",
      provider: ttsProvider
    });
    syncAudioLedger();
    if (queuedPatch) updateAudioHealth(queuedPatch);
    speechQueueRef.current.push(item);
    void flushSpeechQueue();
  }

  function cancelSpeechAudio() {
    speechQueueRef.current = [];
    speakingRef.current = false;
    finishSpeechAfterQueueRef.current = false;
    spokenChunkCountRef.current = 0;
    speechPhaseRef.current = "idle";
    setSpeechPhase("idle");
    ttsRuntimeRef.current?.cancel();
  }

  function resetSpeechPlayback() {
    liveAssistantTextRef.current = "";
    cancelSpeechAudio();
    cancelAudioCapture();
    clearRecognitionBuffers(false);
    setLiveAssistantText("");
    lastQueuedCharRef.current = 0;
    spokenCharsRef.current = 0;
    speechLedgerRef.current = [];
    currentTurnIdRef.current = null;
    currentTurnScratchModeRef.current = null;
    audioTimingBaseRef.current = null;
    audioHealthRef.current = null;
    setAudioHealth(null);
    streamRef.current?.close();
    streamRef.current = null;
  }

  function clearRecognitionBuffers(clearDraft = false) {
    speechBufferRef.current = "";
    interimBufferRef.current = "";
    if (clearDraft) setDraft("");
  }

  function interruptSpeechOnly(): void {
    cancelSpeechAudio();
    setLiveAssistantText("");
  }

  function preservePushToTalkViewport(): void {
    const restore = {
      x: window.scrollX,
      y: window.scrollY,
      until: performance.now() + 700
    };
    pttViewportRestoreRef.current = restore;
    const restoreFrame = () => {
      if (pttViewportRestoreRef.current !== restore || performance.now() > restore.until) return;
      window.scrollTo(restore.x, restore.y);
      window.requestAnimationFrame(restoreFrame);
    };
    window.requestAnimationFrame(restoreFrame);
  }

  function discardCapture(clearDraft = true): void {
    const recognition = invalidateRecognition(clearDraft);
    recognition?.stop();
    clearRecognitionBuffers(clearDraft);
    cancelAudioCapture();
    if (transportProvider === "livekit-webrtc") {
      void liveKitTransportRef.current?.setMuted(true);
    }
  }

  function makeAudioSegment(
    capture: NonNullable<typeof audioCaptureRef.current>,
    stoppedAt: number
  ): RemoteSttSegment | null {
    const merged = mergeFloat32(capture.chunks);
    capture.chunks = [];
    const startedAt = capture.segmentStartedAt;
    capture.segmentStartedAt = stoppedAt;
    if (merged.length === 0) return null;
    const downsampled = downsampleFloat32(merged, capture.context.sampleRate, REMOTE_STT_SAMPLE_RATE);
    const wav = encodeWavPcm16(downsampled, REMOTE_STT_SAMPLE_RATE);
    return {
      base64: bytesToBase64(wav),
      bytes: wav.byteLength,
      durationMs: Math.max(0, Math.round(stoppedAt - startedAt)),
      startedAt,
      stoppedAt
    };
  }

  function rolloverAudioSegment(sessionId: number, hard = false): void {
    const capture = audioCaptureRef.current;
    if (!capture || capture.sessionId !== sessionId) return;
    const now = performance.now();
    const segment = makeAudioSegment(capture, now);
    if (segment) capture.segments.push(segment);
    setCaptureState(hard ? "segmenting" : "capturing");
    setSttProviderNotice(
      `${sttProviderLabels[sttProvider]} segment ${capture.segments.length} captured · ${formatBytes(segment?.bytes)}`
    );
  }

  function stopAudioCapture(): { segments: RemoteSttSegment[]; bytes: number; durationMs: number; startedAt: number; stoppedAt: number; firstSpeechDetectedMs?: number } | null {
    const capture = audioCaptureRef.current;
    if (!capture) return null;
    audioCaptureRef.current = null;

    capture.processor.disconnect();
    capture.source.disconnect();
    capture.sink.disconnect();
    void capture.context.close().catch(() => undefined);
    for (const track of capture.stream.getTracks()) track.stop();

    const stoppedAt = performance.now();
    const finalSegment = makeAudioSegment(capture, stoppedAt);
    if (finalSegment) capture.segments.push(finalSegment);
    if (capture.segments.length === 0) return null;
    return {
      segments: capture.segments,
      bytes: capture.segments.reduce((sum, segment) => sum + segment.bytes, 0),
      durationMs: Math.max(0, Math.round(stoppedAt - capture.sessionStartedAt)),
      startedAt: capture.sessionStartedAt,
      stoppedAt,
      firstSpeechDetectedMs: capture.firstSpeechDetectedMs
    };
  }

  function cancelAudioCapture() {
    stopAudioCapture();
    setSttPhase("idle");
    sttPhaseRef.current = "idle";
    setRecognizing(false);
    recognizingRef.current = false;
    setCaptureState("muted");
  }

  function invalidateRecognition(clearDraft = false): SpeechRecognitionLike | null {
    recognitionSessionRef.current += 1;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    holdingToTalkRef.current = false;
    stopRequestedRef.current = true;
    discardSpeechOnEndRef.current = true;
    clearRecognitionBuffers(clearDraft);
    cancelAudioCapture();
    setRecognizing(false);
    recognizingRef.current = false;
    return recognition;
  }

  function recognitionText(): string {
    return `${speechBufferRef.current} ${interimBufferRef.current}`.trim();
  }

  function queueAvailableSpeech(assistantText: string, force = false) {
    while (lastQueuedCharRef.current < assistantText.length) {
      const start = lastQueuedCharRef.current;
      const end = chooseSpeakableEnd(assistantText, start, force, ttsProvider);
      if (end === null || end <= start) break;
      const speakablePatch = firstTimingPatch("firstSpeakableTextMs");
      if (speakablePatch) updateAudioHealth(speakablePatch);
      enqueueSpeechRange(start, end, assistantText.slice(start, end));
    }
  }

  function handleAssistantText(
    displayText: string,
    options: { force?: boolean; final?: boolean; turnId?: string; spokenText?: string } = {}
  ) {
    if (!displayText.trim()) return;
    const speechText = options.spokenText ?? displayText;
    const previousSpeechText = liveAssistantTextRef.current;
    if (previousSpeechText && speechText !== previousSpeechText && !speechText.startsWith(previousSpeechText)) {
      console.warn("[Mortic] assistant text diverged from previously streamed text; keeping monotonic speech ledger", {
        previousChars: previousSpeechText.length,
        nextChars: speechText.length,
        lastQueuedChar: lastQueuedCharRef.current
      });
    }

    liveAssistantTextRef.current = speechText;
    setLiveAssistantText(displayText);
    const visiblePatch = displayText.trim() ? firstTimingPatch("firstVisibleTextMs") : null;
    const finalPatch = options.final ? firstTimingPatch("finalTextMs") : null;
    const speechAfterFinalMs =
      finalPatch?.finalTextMs !== undefined && audioHealthRef.current?.firstSpeechStartMs !== undefined
        ? audioHealthRef.current.firstSpeechStartMs - finalPatch.finalTextMs
        : audioHealthRef.current?.speechAfterFinalMs;
    updateAudioHealth({
      ...(visiblePatch ?? {}),
      ...(finalPatch ?? {}),
      streamedChars: Math.max(audioHealthRef.current?.streamedChars ?? 0, speechText.length),
      finalChars: options.final ? speechText.length : audioHealthRef.current?.finalChars,
      speechAfterFinalMs
    });
    if (speechText.trim()) {
      setSpeechPhase(speakingRef.current ? "speaking" : "buffering");
    }

    if (!previousSpeechText || speechText.startsWith(previousSpeechText)) {
      queueAvailableSpeech(speechText, Boolean(options.force));
    }
    syncAudioLedger();
    if (options.turnId) void syncAudioHealth(options.turnId);
    if (options.final) {
      finishSpeechAfterQueueRef.current = true;
      finishSpeechTurnIfReady();
    }

    if (lastQueuedCharRef.current >= speechText.length && !speakingRef.current && speechQueueRef.current.length === 0) {
      setSpeechPhase("idle");
    }
  }

  function handleTextAssistantText(displayText: string) {
    if (!displayText.trim()) return;
    liveAssistantTextRef.current = displayText;
    setLiveAssistantText(displayText);
  }

  function handleFinalAssistantText(entry: TranscriptEntry, turnId?: string, mode: ScratchMode = entry.scratchMode ?? currentTurnScratchModeRef.current ?? "voice") {
    if (mode === "text") {
      handleTextAssistantText(entry.text);
      return;
    }

    if (!entry.spokenText) {
      handleTextAssistantText(entry.text);
      return;
    }

    handleAssistantText(entry.text, { force: true, final: true, turnId, spokenText: entry.spokenText });
  }

  function handleDeltaText(rawText: string, mode: ScratchMode = currentTurnScratchModeRef.current ?? "voice") {
    if (mode === "text") {
      handleTextAssistantText(rawText);
      return;
    }

    const spokenText = partialSpokenText(rawText);
    if (!spokenText.trim()) return;
    handleAssistantText(spokenText, { spokenText });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const intent = keyboardIntentForKeyDown({
        code: event.code,
        key: event.key,
        repeat: event.repeat,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        editableTarget: isEditableShortcutTarget(event.target),
        liveToggleArmed: liveToggleComboDownRef.current,
        liveModeActive: liveModeActiveRef.current
      });
      if (intent === "toggle-live") {
        event.preventDefault();
        liveToggleComboDownRef.current = true;
        toggleLiveMode();
        return;
      }
      if (intent === "space-down") {
        event.preventDefault();
        startPushToTalkCapture();
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      const intent = keyboardIntentForKeyUp({
        code: event.code,
        key: event.key,
        editableTarget: isEditableShortcutTarget(event.target),
        liveModeActive: liveModeActiveRef.current
      });
      if (intent === "reset-live-toggle") {
        liveToggleComboDownRef.current = false;
        return;
      }
      if (intent === "space-up") {
        event.preventDefault();
        stopPushToTalkCapture();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [liveModeActive, pending, recognizing, speechPhase, sttPhase, sttProvider, transportProvider]);

  useEffect(() => {
    function stopAmbientRecognition() {
      const recognition = invalidateRecognition(true);
      recognition?.stop();
    }

    window.addEventListener("blur", stopAmbientRecognition);
    document.addEventListener("visibilitychange", stopAmbientRecognition);
    return () => {
      window.removeEventListener("blur", stopAmbientRecognition);
      document.removeEventListener("visibilitychange", stopAmbientRecognition);
      stopAmbientRecognition();
    };
  }, []);

  async function compactSparkThenRetry() {
    if (!session || !currentSparkPreflight || sparkCompactionPending || pending) return;
    const confirmed = window.confirm(
      "Compact only the disposable scratch fork and re-check whether this candidate model can safely start? The original source Codex thread will not be compacted or mutated."
    );
    if (!confirmed) return;

    setSparkCompactionPending(true);
    setSparkApprovalKey("");
    setState((current) => ({ ...current, error: null }));
    setPrewarm({ status: "warming", detail: "Compacting disposable scratch context" });

    try {
      const response = await fetch(`${api}/api/session/spark-context/compact`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          confirm: true,
          reasoningEffort: effectiveReasoningEffort,
          codexModel: effectiveCodexModel,
          scratchMode,
          voiceCaveman: effectiveVoiceCaveman
        })
      });
      const payload = (await response.json()) as SparkContextCompactResponse & { error?: string };
      if (payload.preflight) {
        setSparkPreflight(payload.preflight);
      }

      if (!response.ok) {
        setState((current) => ({
          ...current,
          session: payload.session ?? current.session,
          error: payload.error ?? "Scratch compaction failed"
        }));
        setPrewarm({ status: "error", detail: payload.error ?? "Scratch compaction failed" });
        return;
      }

      setState((current) => ({
        ...current,
        session: payload.session ?? current.session,
        error: null
      }));
      prewarmKeyRef.current = "";
      prewarmAnnouncementKeyRef.current = "";
      setPrewarm({
        status: "idle",
        detail:
          payload.preflight.status === "safe"
            ? "Compaction completed; candidate model preflight is safe"
            : payload.preflight.detail
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error)
      }));
      setPrewarm({
        status: "error",
        detail: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSparkCompactionPending(false);
    }
  }

  async function sendTurn(text: string, options: { sttMetrics?: SttTurnMetrics } = {}) {
    const clean = text.trim();
    if (!clean || pendingRef.current) return;
    const turnScratchMode = scratchMode;
    if (needsModelTransitionPreflight(effectiveCodexModel) && (sparkPreflightPending || sparkCompactionPending || !sparkApproved)) {
      setState((current) => ({
        ...current,
        error: `${sparkContext.label}. ${
          sparkContext.compactionRequired ? "Compact then retry before starting this scratch." : "Approve candidate model before starting this scratch."
        }`
      }));
      return;
    }

    resetSpeechPlayback();
    clearRecognitionBuffers(true);
    currentTurnScratchModeRef.current = turnScratchMode;
    setTurnPending(true);
    setUiDispatchMs(null);
    setDraft("");
    setSpeechError(null);

    try {
      const uiStart = performance.now();
      const response = await fetch(`${api}/api/turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: clean,
          reasoningEffort: effectiveReasoningEffort,
          codexModel: effectiveCodexModel,
          scratchMode: turnScratchMode,
          voiceCaveman: effectiveVoiceCaveman,
          allowModelContextRisk: sparkApproved,
          allowSparkContextRisk: sparkApproved,
          sttMetrics: options.sttMetrics,
          transportProvider,
          inputPolicy,
          transportState,
          transportStats
        })
      });
      const payload = await response.json();
      setUiDispatchMs(Math.round(performance.now() - uiStart));
      if (!response.ok) {
        if (payload.sparkPreflight) {
          setSparkPreflight(payload.sparkPreflight);
          setSparkApprovalKey("");
        }
        setState({ session: payload.session ?? state.session, loading: false, error: payload.error ?? "Codex turn failed" });
        setTurnPending(false);
        return;
      }
      setState({ session: payload.session, loading: false, error: null });
      if (turnScratchMode === "voice") {
        startAudioHealth(payload.turnId, uiStart);
      } else {
        startTextTurnTracking(payload.turnId, uiStart);
      }
      if (typeof EventSource !== "undefined") {
        streamTurn(payload.turnId);
      } else {
        void pollTurn(payload.turnId);
      }
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
      setTurnPending(false);
    }
  }

  function streamTurn(turnId: string) {
    streamRef.current?.close();
    const stream = new EventSource(`${api}/api/turn/${turnId}/stream`);
    streamRef.current = stream;

    stream.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TurnStreamEvent;

      if (payload.type === "snapshot") {
        setState({ session: payload.session, loading: false, error: null });
        const turn = payload.turn;
        if (!turn || turn.status === "running") return;
        setTurnPending(false);
        if (turn.responseEntryId) {
          const assistant = payload.session.transcript.find((entry) => entry.id === turn.responseEntryId);
          if (assistant) {
            handleFinalAssistantText(assistant, turn.id, turn.scratchMode);
          }
        }
        setLiveAssistantText("");
        stream.close();
        streamRef.current = null;
        return;
      }

      if (payload.type === "log") {
        setState((current) => {
          if (!current.session) return current;
          return {
            ...current,
            session: {
              ...current.session,
              activeTurn: payload.turn
            },
            error: null
          };
        });
        return;
      }

      if (payload.type === "delta") {
        handleDeltaText(payload.text, payload.scratchMode);
        return;
      }

      setState({
        session: payload.session,
        loading: false,
        error: payload.type === "failed" ? payload.turn.error ?? "Codex turn failed" : null
      });
      setTurnPending(false);
      if (payload.type === "interrupted") {
        resetSpeechPlayback();
        stream.close();
        streamRef.current = null;
        return;
      }
      const finalEntry = payload.turn.responseEntryId
        ? payload.session.transcript.find((entry) => entry.id === payload.turn.responseEntryId)
        : undefined;
      if (finalEntry) {
        handleFinalAssistantText(finalEntry, payload.turn.id, payload.turn.scratchMode);
      } else {
        if (payload.turn.scratchMode === "voice") {
          handleAssistantText(payload.turn.error ?? liveAssistantTextRef.current, { force: true, final: true, turnId: payload.turn.id });
        } else {
          handleTextAssistantText(payload.turn.error ?? liveAssistantTextRef.current);
        }
      }
      setLiveAssistantText("");
      stream.close();
      streamRef.current = null;
    };

    stream.onerror = () => {
      stream.close();
      streamRef.current = null;
      void pollTurn(turnId);
    };
  }

  async function pollTurn(turnId: string) {
    try {
      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const response = await fetch(`${api}/api/turn/${turnId}`);
        const payload = await response.json();
        if (!response.ok) {
          setState((current) => ({ ...current, error: payload.error ?? "Could not read turn status" }));
          setTurnPending(false);
          return;
        }

        setState({ session: payload.session, loading: false, error: null });
        const turn = payload.turn as TurnRun | null;

        if (!turn || turn.status === "running") {
          continue;
        }

        setTurnPending(false);
        if (turn.status === "interrupted") {
          resetSpeechPlayback();
          return;
        }
        if (turn.status === "completed" && turn.responseEntryId) {
          const assistant = payload.session.transcript.find((entry: TranscriptEntry) => entry.id === turn.responseEntryId);
          if (assistant) {
            handleFinalAssistantText(assistant, turn.id, turn.scratchMode);
          }
        }
        setLiveAssistantText("");
        return;
      }
    } finally {
      // polling exits through status transitions above
    }
  }

  function resumeCaptureAfterInterrupt(): void {
    const action = interruptResumeAction({ liveModeActive: liveModeActiveRef.current, spaceHeld: spaceHeldRef.current });
    if (action === "listen-live") {
      window.setTimeout(() => {
        if (liveModeActiveRef.current && !pendingRef.current && !recognizingRef.current) startRecognition();
      }, 80);
      return;
    }
    if (action === "capture-push-to-talk" && !pendingRef.current && !recognizingRef.current) {
      window.setTimeout(() => {
        if (spaceHeldRef.current && !liveModeActiveRef.current && !pendingRef.current && !recognizingRef.current) {
          startPushToTalkCapture();
        }
      }, 80);
    }
  }

  async function interruptTurn() {
    const turnId = state.session?.activeTurn?.status === "running" ? state.session.activeTurn.id : null;
    if (turnId) {
      syncAudioLedger();
      updateAudioHealth({
        streamedChars: liveAssistantTextRef.current.length,
        finalChars: liveAssistantTextRef.current.length,
        spokenChunks: speechLedgerRef.current.length
      });
      await syncAudioHealth(turnId);
    }
    resetSpeechPlayback();
    setTurnPending(false);
    if (!turnId) {
      resumeCaptureAfterInterrupt();
      return;
    }

    try {
      const response = await fetch(`${api}/api/turn/${turnId}/interrupt`, {
        method: "POST"
      });
      const payload = await response.json();
      if (payload.session) {
        setState({ session: payload.session, loading: false, error: response.ok ? null : payload.error ?? "Could not interrupt turn" });
        if (response.ok) {
          prewarmKeyRef.current = "";
          prewarmAnnouncementKeyRef.current = "";
          setPrewarm({ status: "idle" });
        }
      }
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      resumeCaptureAfterInterrupt();
    }
  }

  async function transcribeRemoteAudio(recording: {
    segments: RemoteSttSegment[];
    bytes: number;
    durationMs: number;
    startedAt: number;
    stoppedAt: number;
    firstSpeechDetectedMs?: number;
    sessionId: number;
  }) {
    if (!isCurrentRecognitionSession(recognitionSessionRef.current, recording.sessionId)) return;
    setSttPhase("transcribing");
    sttPhaseRef.current = "transcribing";
    setCaptureState("finalizing");
    setDraft("");
    setSpeechError(null);
    setSttProviderNotice(`${sttProviderLabels[sttProvider]} transcribing ${recording.segments.length} segment${recording.segments.length === 1 ? "" : "s"} · ${formatBytes(recording.bytes)}`);

    try {
      const texts: string[] = [];
      let finalPayload: (SttTranscriptionResponse & { fallbackReason?: string }) | null = null;
      let fallbackReason: string | undefined;
      for (let index = 0; index < recording.segments.length; index += 1) {
        if (!isCurrentRecognitionSession(recognitionSessionRef.current, recording.sessionId)) return;
        const segment = recording.segments[index];
        const response = await fetch(`${api}/api/stt/transcribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            provider: sttProvider,
            audioBase64: segment.base64,
            mimeType: "audio/wav",
            language: "en-US",
            prompt: "Codex, Mortic, Inworld, ElevenLabs, LiveKit, WebRTC, VAD, TTS, STT",
            segmentIndex: index,
            segmentCount: recording.segments.length,
            recordingSessionId: recording.sessionId
          })
        });
        const payload = (await response.json()) as (SttTranscriptionResponse & { fallbackReason?: string }) & { error?: string };
        if (!response.ok || !payload.text) {
          throw new Error(payload.error ?? "Remote transcription failed");
        }
        if (!isCurrentRecognitionSession(recognitionSessionRef.current, recording.sessionId)) return;
        finalPayload = payload;
        fallbackReason = fallbackReason ?? payload.fallbackReason;
        texts.push(payload.text.trim());
        setDraft(texts.join(" ").replace(/\s+/g, " ").trim());
      }
      if (!finalPayload) throw new Error("Remote transcription returned no segments");
      const finalText = texts.join(" ").replace(/\s+/g, " ").trim();
      if (!isCurrentRecognitionSession(recognitionSessionRef.current, recording.sessionId)) return;
      const finalReadyElapsed = Math.round(performance.now() - recording.startedAt);
      setLastSttMeta({
        provider: finalPayload.provider,
        elapsedMs: finalPayload.elapsedMs,
        bytes: recording.bytes,
        fallbackReason
      });
      setLastSttTurnMetrics({
        provider: finalPayload.provider,
        requestedProvider: sttProvider,
        segmentCount: recording.segments.length,
        payloadBytes: recording.bytes,
        recordingDurationMs: recording.durationMs,
        recordingStartedAt: new Date(Date.now() - Math.round(performance.now() - recording.startedAt)).toISOString(),
        recordingStoppedAt: new Date().toISOString(),
        firstSpeechDetectedMs: recording.firstSpeechDetectedMs,
        firstFinalTranscriptMs: finalReadyElapsed,
        finalSttReadyMs: finalReadyElapsed,
        sendAfterSpeechMs: Math.max(0, Math.round(performance.now() - recording.stoppedAt)),
        fallbackReason
      });
      setSttProviderNotice(
        `${sttProviderLabels[finalPayload.provider]} transcribed ${recording.segments.length} segment${recording.segments.length === 1 ? "" : "s"} in ${formatMs(finalPayload.elapsedMs)}${
          fallbackReason ? ` after fallback` : ""
        }`
      );
      setDraft(finalText);
      if (!finalText) {
        setSttProviderNotice("No speech detected; empty turn discarded");
        return;
      }
      await sendTurn(finalText, {
        sttMetrics: {
          provider: finalPayload.provider,
          requestedProvider: sttProvider,
          segmentCount: recording.segments.length,
          payloadBytes: recording.bytes,
          recordingDurationMs: recording.durationMs,
          recordingStartedAt: new Date(Date.now() - Math.round(performance.now() - recording.startedAt)).toISOString(),
          recordingStoppedAt: new Date().toISOString(),
          firstSpeechDetectedMs: recording.firstSpeechDetectedMs,
          firstFinalTranscriptMs: finalReadyElapsed,
          finalSttReadyMs: finalReadyElapsed,
          sendAfterSpeechMs: Math.max(0, Math.round(performance.now() - recording.stoppedAt)),
          fallbackReason
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastSttTurnMetrics((current) => current ? { ...current, recognitionErrors: [...(current.recognitionErrors ?? []), message] } : null);
      if (shouldSwitchRemoteSttToBrowser(message) && recognitionSupported) {
        setSttProvider("browser");
        setSpeechError(`${sttProviderLabels[sttProvider]} credits are exhausted. Switched to Browser STT; hold push-to-talk again.`);
        setSttProviderNotice("Browser STT selected because remote STT credits are exhausted");
      } else {
        setSpeechError(`Speech-to-text stopped: ${message}`);
        setSttProviderNotice(`${sttProviderLabels[sttProvider]} failed; use Browser or type the turn`);
      }
    } finally {
      setRecognizing(false);
      recognizingRef.current = false;
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
    }
  }

  async function startRemoteSttCapture() {
    if (!navigator.mediaDevices?.getUserMedia || pendingRef.current || recognizing) {
      if (!navigator.mediaDevices?.getUserMedia) {
        setSpeechError("Microphone capture is unavailable in this browser. Use Browser STT or the text box.");
      }
      return;
    }

    const sessionId = recognitionSessionRef.current + 1;
    recognitionSessionRef.current = sessionId;
    clearRecognitionBuffers(true);
    cancelAudioCapture();
    setSpeechError(null);
    setLastSttMeta(null);
    setLastSttTurnMetrics(null);

    try {
      if (transportProvider === "livekit-webrtc") {
        await liveKitTransportRef.current?.setMuted(false);
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
      if (!isCurrentRecognitionSession(recognitionSessionRef.current, sessionId)) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      const Constructor = audioContextConstructor();
      if (!Constructor) throw new Error("Web Audio capture is unavailable in this browser.");
      const context = new Constructor();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const sink = context.createGain();
      sink.gain.value = 0;
      const chunks: Float32Array[] = [];
      const startedAt = performance.now();
      let lastSpeechAt = 0;
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (!isCurrentRecognitionSession(recognitionSessionRef.current, sessionId) || !audioCaptureRef.current) return;
        const input = new Float32Array(event.inputBuffer.getChannelData(0));
        const capture = audioCaptureRef.current;
        capture.chunks.push(input);
        let sumSquares = 0;
        for (let index = 0; index < input.length; index += 1) sumSquares += input[index] * input[index];
        const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
        const now = performance.now();
        if (rms > 0.018) {
          lastSpeechAt = now;
          if (capture.firstSpeechDetectedMs === undefined) {
            capture.firstSpeechDetectedMs = Math.round(now - capture.sessionStartedAt);
            if (liveModeActiveRef.current && (speechPhaseRef.current === "speaking" || speechPhaseRef.current === "buffering")) {
              interruptSpeechOnly();
            }
          }
        }
        const seconds = (now - capture.sessionStartedAt) / 1000;
        const segmentMs = now - capture.segmentStartedAt;
        const segmentBytesEstimate = capture.chunks.reduce((sum, chunk) => sum + chunk.length * 2, 44);
        if (segmentMs >= HARD_STT_SEGMENT_MS || segmentBytesEstimate >= MAX_LOCAL_SEGMENT_BYTES) {
          rolloverAudioSegment(sessionId, true);
        } else if (segmentMs >= SOFT_STT_SEGMENT_MS && now - lastSpeechAt > 450) {
          rolloverAudioSegment(sessionId, false);
        }
        setDraft(liveModeActiveRef.current ? `Live listening... ${seconds.toFixed(1)} s` : `Listening... ${seconds.toFixed(1)} s`);
        if (
          liveModeActiveRef.current &&
          capture.firstSpeechDetectedMs !== undefined &&
          now - lastSpeechAt > 1300 &&
          now - capture.sessionStartedAt > 1700
        ) {
          stopRemoteSttCapture();
        }
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      audioCaptureRef.current = {
        stream,
        context,
        processor,
        source,
        sink,
        chunks,
        startedAt,
        segmentStartedAt: startedAt,
        sessionStartedAt: startedAt,
        sessionId,
        segments: []
      };
      recognizingRef.current = true;
      sttPhaseRef.current = "listening";
      setRecognizing(true);
      setSttPhase("listening");
      setCaptureState("capturing");
      setSttProviderNotice(`${sttProviderLabels[sttProvider]} listening`);
    } catch (error) {
      if (transportProvider === "livekit-webrtc") {
        void liveKitTransportRef.current?.setMuted(true);
      }
      setRecognizing(false);
      recognizingRef.current = false;
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
      setSpeechError(error instanceof Error ? friendlySpeechError(error.message) : String(error));
    }
  }

  function stopRemoteSttCapture(options: { submit?: boolean; emptyNotice?: boolean } = {}) {
    const submit = options.submit ?? true;
    const emptyNotice = options.emptyNotice ?? true;
    const sessionId = recognitionSessionRef.current;
    const recording = stopAudioCapture();
    recognizingRef.current = false;
    setRecognizing(false);
    if (transportProvider === "livekit-webrtc") {
      void liveKitTransportRef.current?.setMuted(true);
    }
    if (!submit) {
      recognitionSessionRef.current += 1;
      clearRecognitionBuffers(true);
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
      setDraft("");
      return;
    }
    if (!recording || !shouldSubmitCapturedTurn({ submitRequested: submit, speechDetected: recording.firstSpeechDetectedMs !== undefined, transcriptText: "remote audio" })) {
      recognitionSessionRef.current += 1;
      clearRecognitionBuffers(true);
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
      setDraft("");
      if (emptyNotice) setSttProviderNotice("No speech detected; empty turn discarded");
      return;
    }
    if (recording.segments.length === 0) {
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
      setDraft("");
      setSpeechError("I did not capture any audio. Try again or use the text box.");
      return;
    }
    void transcribeRemoteAudio({ ...recording, sessionId });
  }

  function startRecognition() {
    if (speechPhaseRef.current === "speaking" || speechPhaseRef.current === "buffering") {
      interruptSpeechOnly();
    }
    if (sttProvider !== "browser") {
      void startRemoteSttCapture();
      return;
    }
    if (!recognitionSupported || pendingRef.current || recognizing) return;
    const sessionId = recognitionSessionRef.current + 1;
    recognitionSessionRef.current = sessionId;
    holdingToTalkRef.current = liveModeActiveRef.current || spaceHeldRef.current;
    stopRequestedRef.current = false;
    discardSpeechOnEndRef.current = false;
    clearRecognitionBuffers(true);
    startRecognitionEngine(sessionId);
  }

  function startRecognitionEngine(sessionId: number) {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      if (!isCurrentRecognitionSession(recognitionSessionRef.current, sessionId) || recognitionRef.current !== recognition) return;
      interimBufferRef.current = "";
      for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          speechBufferRef.current = `${speechBufferRef.current} ${transcript}`.trim();
        } else {
          interimBufferRef.current = `${interimBufferRef.current} ${transcript}`.trim();
        }
      }
      setDraft(`${speechBufferRef.current} ${interimBufferRef.current}`.trim());
    };

    recognition.onerror = (event) => {
      if (!isCurrentRecognitionSession(recognitionSessionRef.current, sessionId) || recognitionRef.current !== recognition) return;
      setSpeechError(friendlySpeechError(event.error ?? "unknown"));
    };

    recognition.onend = () => {
      if (!isCurrentRecognitionSession(recognitionSessionRef.current, sessionId) || recognitionRef.current !== recognition) return;
      recognitionRef.current = null;

      if (holdingToTalkRef.current && !stopRequestedRef.current) {
        window.setTimeout(() => {
          if (isCurrentRecognitionSession(recognitionSessionRef.current, sessionId) && holdingToTalkRef.current && !stopRequestedRef.current) {
            startRecognitionEngine(sessionId);
          }
        }, 100);
        return;
      }

      setRecognizing(false);
      const text = recognitionText();
      const shouldDiscard = discardSpeechOnEndRef.current;
      discardSpeechOnEndRef.current = false;
      clearRecognitionBuffers(true);
      if (shouldSubmitCapturedTurn({ submitRequested: !shouldDiscard, speechDetected: Boolean(text), transcriptText: text })) {
        void sendTurn(text);
      }
    };

    recognitionRef.current = recognition;
    setRecognizing(true);
    try {
      recognition.start();
    } catch (error) {
      if (isCurrentRecognitionSession(recognitionSessionRef.current, sessionId)) {
        invalidateRecognition(true);
      }
      setRecognizing(false);
      setSpeechError(error instanceof Error ? error.message : String(error));
    }
  }

  function stopRecognition(options: { submit?: boolean; emptyNotice?: boolean } = {}) {
    const submit = options.submit ?? true;
    const emptyNotice = options.emptyNotice ?? true;
    if (sttProvider !== "browser") {
      stopRemoteSttCapture({ submit, emptyNotice });
      return;
    }
    const recognition = recognitionRef.current;
    const text = recognitionText();
    invalidateRecognition(true);
    recognition?.stop();
    if (shouldSubmitCapturedTurn({ submitRequested: submit, speechDetected: Boolean(text), transcriptText: text })) {
      void sendTurn(text);
    }
    if (submit && !text && emptyNotice) setSttProviderNotice("No speech detected; empty turn discarded");
  }

  function setLiveActive(nextActive: boolean) {
    if (nextActive && !LIVE_MODE_RUNTIME_ENABLED) {
      liveModeActiveRef.current = false;
      setLiveModeActive(false);
      setInputPolicy("push_to_talk");
      setTtsProviderNotice("Live mode is paused until echo-safe turn detection is ready. Use push-to-talk.");
      return;
    }

    if (nextActive) {
      liveModeActiveRef.current = true;
      spaceHeldRef.current = false;
      setInputPolicy("live");
      setLiveModeActive(true);
      setSpeechError(null);
      return;
    }

    liveModeActiveRef.current = false;
    setLiveModeActive(false);
    setInputPolicy("push_to_talk");
    if (recognizingRef.current || sttPhaseRef.current === "transcribing") {
      stopRecognition({ submit: false, emptyNotice: false });
    } else {
      discardCapture(true);
    }
  }

  function toggleLiveMode() {
    setLiveActive(!liveModeActiveRef.current);
  }

  function startPushToTalkCapture() {
    preservePushToTalkViewport();
    if (liveModeActiveRef.current || recognizingRef.current || sttPhaseRef.current === "transcribing") return;
    spaceHeldRef.current = true;
    if (speechPhaseRef.current === "speaking" || speechPhaseRef.current === "buffering") {
      interruptSpeechOnly();
    }
    if (pendingRef.current) {
      void interruptTurn();
      return;
    }
    setInputPolicy("push_to_talk");
    startRecognition();
  }

  function stopPushToTalkCapture() {
    spaceHeldRef.current = false;
    if (liveModeActiveRef.current) return;
    if (recognizingRef.current || sttPhaseRef.current === "listening") {
      stopRecognition({ submit: true, emptyNotice: false });
    }
  }

  useEffect(() => {
    if (!liveModeActive) return;
    if (!activeSttSupported || pending || recognizing || sttPhase === "transcribing" || sparkBlocked) return;
    const timer = window.setTimeout(() => {
      if (
        liveModeActiveRef.current &&
        activeSttSupported &&
        !pendingRef.current &&
        !recognizingRef.current &&
        sttPhaseRef.current !== "transcribing"
      ) {
        startRecognition();
      }
    }, speechPhase === "speaking" || speechPhase === "buffering" ? 0 : 250);
    return () => window.clearTimeout(timer);
  }, [activeSttSupported, liveModeActive, pending, recognizing, speechPhase, sparkBlocked, sttPhase, sttProvider, transportProvider]);

  async function generateHandoff() {
    if (handoffPending) return;
    setHandoffPending(true);
    try {
      const response = await fetch(`${api}/api/handoff`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reasoningEffort: effectiveReasoningEffort, codexModel: effectiveCodexModel })
      });
      const payload = await response.json();
      setHandoff(payload.handoff);
      setShortHandoff(payload.shortPrompt ?? "");
      setFullHandoff(payload.fullPrompt ?? "");
      setState({ session: payload.session, loading: false, error: null });
      void refreshProject();
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setHandoffPending(false);
    }
  }

  async function commitCurrentSession(approveItemIds: string[] = []) {
    if (projectPending || pending) return;
    setProjectPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/session/commit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ approveItemIds })
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Commit session failed");
      setProjectState(payload);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function archiveCurrentSession() {
    if (projectPending || pending) return;
    setProjectPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/session/archive`, {
        method: "POST"
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Archive session failed");
      setProjectState(payload);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function runProjectAction(path: string, errorMessage: string) {
    if (projectPending || pending) return;
    setProjectPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}${path}`, {
        method: "POST"
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? errorMessage);
      setProjectState(payload);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function confirmCheckpointProposal() {
    await runProjectAction("/api/project/checkpoint/confirm", "Could not create checkpoint");
  }

  async function dismissCheckpointProposal() {
    await runProjectAction("/api/project/checkpoint/dismiss", "Could not dismiss checkpoint");
  }

  async function createManualCheckpoint() {
    await runProjectAction("/api/project/checkpoint/manual", "Could not create manual checkpoint");
  }

  async function updateExtraction(itemId: string, status: ExtractionStatus) {
    if (projectPending) return;
    setProjectPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/extractions/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ status })
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Extraction update failed");
      setProjectState(payload);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function copyText(text: string) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
  }

  async function copyHandoffText(text: string) {
    if (!text) return;
    await copyText(text);
    try {
      const response = await fetch(`${api}/api/project/handoff-copied`, {
        method: "POST"
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (response.ok && !payload.error) setProjectState(payload);
    } catch {
      // Copy should not fail just because project checkpoint bookkeeping failed.
    }
  }

  async function clearScratch() {
    resetSpeechPlayback();
    prewarmKeyRef.current = "";
    prewarmAnnouncementKeyRef.current = "";
    setPrewarm({ status: "idle" });
    const response = await fetch(`${api}/api/session/clear`, {
      method: "POST"
    });
    const payload = await response.json();
    setState({ session: payload.session, loading: false, error: response.ok ? null : payload.error ?? "Could not clear scratch" });
    void refreshProject();
    setDraft("");
    setHandoff("");
    setShortHandoff("");
    setFullHandoff("");
    setSpeechError(null);
    setTurnPending(false);
  }

  async function updateSourceThread() {
    const clean = sourceDraft.trim();
    if (!clean || sourcePending) return;

    resetSpeechPlayback();
    prewarmKeyRef.current = "";
    prewarmAnnouncementKeyRef.current = "";
    setPrewarm({ status: "idle" });
    setSourcePending(true);
    setSpeechError(null);

    try {
      const response = await fetch(`${api}/api/session/source`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sourceUri: clean })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? "Could not update source thread");
      }
      setState({ session: payload.session, loading: false, error: null });
      setSourceDraft(payload.session.sourceUri);
      setDraft("");
      setHandoff("");
      setShortHandoff("");
      setFullHandoff("");
      setTurnPending(false);
      void refreshProject();
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    } finally {
      setSourcePending(false);
    }
  }

  const fullPromptValue = fullHandoff || handoff;
  const tokenBudget = useMemo(() => {
    const transcriptTokens = estimateTranscriptTokens(transcript);
    const shortTokens = estimateTextTokens(shortHandoff);
    const fullTokens = estimateTextTokens(fullPromptValue);
    const compare = (tokens: number, hasPrompt: boolean) => {
      const savedTokens = Math.max(0, transcriptTokens - tokens);
      return {
        hasPrompt,
        tokens,
        savedTokens,
        savedPercent: percentReduction(transcriptTokens, tokens),
        contextWorkSavedPercent: contextWorkReduction(transcriptTokens, tokens),
        savedOverFiveTurns: savedTokens * 5,
        savedOverTenTurns: savedTokens * 10
      };
    };

    return {
      transcriptTokens,
      short: compare(shortTokens, Boolean(shortHandoff.trim())),
      full: compare(fullTokens, Boolean(fullPromptValue.trim()))
    };
  }, [transcript, shortHandoff, fullPromptValue]);
  const futureSavingsLine = useMemo(() => {
    const fiveTurnParts = [
      tokenBudget.short.hasPrompt ? `short ${formatCount(tokenBudget.short.savedOverFiveTurns)}` : "",
      tokenBudget.full.hasPrompt ? `full ${formatCount(tokenBudget.full.savedOverFiveTurns)}` : ""
    ].filter(Boolean);
    const tenTurnParts = [
      tokenBudget.short.hasPrompt ? `short ${formatCount(tokenBudget.short.savedOverTenTurns)}` : "",
      tokenBudget.full.hasPrompt ? `full ${formatCount(tokenBudget.full.savedOverTenTurns)}` : ""
    ].filter(Boolean);

    if (fiveTurnParts.length === 0) return "";
    return `Avoided input over 5 future turns: ${fiveTurnParts.join(", ")}. Over 10: ${tenTurnParts.join(", ")}.`;
  }, [tokenBudget]);
  const visibleAudioHealth =
    activeTurn && audioHealth?.turnId === activeTurn.id
      ? audioHealth
      : activeTurn?.metrics.ttsProvider
        ? {
            turnId: activeTurn.id,
            provider: activeTurn.metrics.ttsProvider,
            streamedChars: activeTurn.metrics.streamedChars ?? 0,
            finalChars: activeTurn.metrics.finalChars,
            queuedChars: activeTurn.metrics.queuedChars,
            spokenChars: activeTurn.metrics.spokenChars,
            queuedRanges: activeTurn.metrics.queuedRanges,
            spokenRanges: activeTurn.metrics.spokenRanges,
            spokenChunks: activeTurn.metrics.spokenChunks ?? 0,
            ttsError: activeTurn.metrics.ttsError,
            ttsProviderStatus: activeTurn.metrics.ttsProviderStatus,
            firstVisibleTextMs: activeTurn.metrics.firstVisibleTextMs,
            firstSpeakableTextMs: activeTurn.metrics.firstSpeakableTextMs,
            firstSpeechQueuedMs: activeTurn.metrics.firstSpeechQueuedMs,
            firstSpeechStartMs: activeTurn.metrics.firstSpeechStartMs,
            firstSpeechEndMs: activeTurn.metrics.firstSpeechEndMs,
            ttsConnectMs: activeTurn.metrics.ttsConnectMs,
            firstAudioChunkMs: activeTurn.metrics.firstAudioChunkMs,
            firstAudioPlayMs: activeTurn.metrics.firstAudioPlayMs,
            audioBufferUnderruns: activeTurn.metrics.audioBufferUnderruns,
            ttsCloseCode: activeTurn.metrics.ttsCloseCode,
            ttsCloseReason: activeTurn.metrics.ttsCloseReason,
            finalTextMs: activeTurn.metrics.finalTextMs,
            speechAfterFinalMs: activeTurn.metrics.speechAfterFinalMs
          }
        : null;
  const micStateLabel =
    sttPhase === "transcribing"
      ? "Transcribing"
      : recognizing
        ? liveModeActive ? "Live listening" : "Listening"
        : speechPhase === "speaking" || speechPhase === "buffering"
          ? liveModeActive ? "Speak to interrupt" : "Hold Space to interrupt"
        : activeSttSupported
          ? liveModeActive ? "Live on" : "Hold Space to talk"
          : "Unavailable";
  const codexStateLabel =
    pending
      ? "Thinking"
      : prewarm.status === "warming"
        ? "Warming"
        : prewarm.status === "ready"
          ? "Scratch ready"
          : prewarm.status === "error"
            ? "Warm failed"
            : "Idle";
  const speechStateLabel =
    speechPhase === "speaking"
      ? "Speaking"
      : speechPhase === "buffering"
        ? "Buffering"
        : ttsStatus.availableProviders.includes(ttsProvider)
          ? "Ready"
          : "Unavailable";
  const handoffStateLabel = handoffPending ? "Generating" : shortHandoff || fullHandoff ? "Ready" : `${transcript.length} turns`;
  const transportStateLabel =
    transportProvider === "livekit-webrtc"
      ? transportState === "connected"
        ? "Connected"
        : transportState === "connecting"
          ? "Connecting"
          : transportState === "reconnecting"
            ? "Reconnecting"
            : transportState === "failed"
              ? "Failed"
              : "Disconnected"
      : "Local";
  const compactMicStateLabel =
    sttPhase === "transcribing"
      ? "Transcribing"
      : recognizing
        ? "Listening"
        : liveModeActive
          ? "Live"
          : speechPhase === "speaking" || speechPhase === "buffering"
            ? "Interrupt ready"
            : activeSttSupported
              ? "PTT ready"
              : "Unavailable";
  const dockTalkLabel =
    sttPhase === "transcribing"
      ? "Transcribing"
      : liveModeActive
        ? "Live on"
        : recognizing
          ? "Release to send"
          : speechPhase === "speaking" || speechPhase === "buffering"
            ? "Interrupt"
            : "Hold to talk";
  const canPushToTalkInterrupt = pending || speechPhase === "speaking" || speechPhase === "buffering";
  const pushToTalkDisabled =
    liveModeActive ||
    sttPhase === "transcribing" ||
    (!canPushToTalkInterrupt && (sparkBlocked || !activeSttSupported));
  const activeProjectSession = projectState?.scratchSessions.find(
    (candidate) => candidate.id === projectState.project.activeScratchSessionId
  ) ?? projectState?.scratchSessions[0] ?? null;
  const activeProjectSource = activeProjectSession
    ? projectState?.sourceThreads.find((source) => source.id === activeProjectSession.sourceThreadId) ?? null
    : projectState?.sourceThreads[0] ?? null;
  const activeExtractions = activeProjectSession
    ? dedupeExtractionItems(projectState?.extractedItems.filter((item) => item.scratchSessionId === activeProjectSession.id && item.status !== "dismissed") ?? [])
    : [];
  const draftExtractions = activeExtractions.filter((item) => item.status === "draft");
  const approvedExtractions = projectState?.extractedItems.filter((item) => item.status === "approved") ?? [];
  const extractionCounts = extractionTypeOrder
    .map((type) => ({
      type,
      total: activeExtractions.filter((item) => item.type === type).length,
      draft: activeExtractions.filter((item) => item.type === type && item.status === "draft").length,
      approved: activeExtractions.filter((item) => item.type === type && item.status === "approved").length
    }))
    .filter((item) => item.total > 0);
  const projectSources = projectState?.sourceThreads ?? [];
  const sourceCheckpoints = projectState?.sourceCheckpoints ?? [];
  const scratchSessions = projectState?.scratchSessions ?? [];
  const checkpointProposal = projectState?.project.pendingSourceCheckpoint ?? null;
  const primaryExtraction = activeExtractions[0] ?? null;
  const extractionPreview = primaryExtraction
    ? primaryExtraction.title
    : "No project updates compiled yet.";
  const handoffPreview = handoffPending
    ? "Generating handoff from this scratch transcript."
    : shortHandoff || fullHandoff || handoff
      ? "Handoff exists. Review or copy it when you are ready to leave the scratch."
      : transcript.length > 0
        ? "No handoff generated yet. Keep working, or generate one when you need to return to Codex."
        : "No handoff yet.";
  const sourceThreadLabel = session ? redactThreadId(session.threadId) : "No source";
  const compactTranscript = transcript.slice(-4);
  const latestUserEntry = [...transcript].reverse().find((entry) => entry.role === "user") ?? null;
  const latestAssistantEntry = [...transcript].reverse().find((entry) => entry.role === "assistant") ?? null;
  const compactAssistantEntry = pending ? null : latestAssistantEntry;
  const runtimeContextNotice = session?.runtimeContext?.prompt
    ?? (session?.runtimeContext
      ? `Runtime context ${session.runtimeContext.status}: ${session.runtimeContext.effectiveCwd}`
      : "");
  const runtimeNotices = [
    runtimeContextNotice,
    !activeSttSupported
      ? sttProvider === "browser"
        ? "Browser speech recognition is unavailable here. Choose Inworld STT, Whisper, or use the text box."
        : "Microphone capture is unavailable here. Choose Browser STT if supported or use the text box."
      : "",
    prewarm.status === "ready" && prewarm.confirmation ? prewarm.confirmation : "",
    transportNotice ?? "",
    sttProviderNotice ?? "",
    ttsProviderNotice ?? ""
  ].filter(Boolean);
  const runtimeErrors = [speechError, state.error, projectError].filter(Boolean);
  const systemSummary = [
    transportProvider === "livekit-webrtc" ? `LiveKit ${transportStateLabel.toLowerCase()}` : null,
    activeSttSupported ? sttProviderLabels[sttProvider] : "STT unavailable",
    ttsStatus.availableProviders.includes(ttsProvider) ? ttsProviderLabels[ttsProvider] : "TTS unavailable",
    prewarm.status === "ready" ? "Scratch ready" : prewarm.status === "warming" ? "Warming" : null
  ].filter(Boolean).join(" · ");
  const progressPanel = activeTurn ? (
    <section className={`progress-panel progress-${activeTurn.status}`}>
      <div className="progress-header">
        <div>
          <h2>
            {activeTurn.status === "running"
              ? "Thinking"
              : activeTurn.status === "completed"
                ? "Turn Complete"
                : activeTurn.status === "interrupted"
                  ? "Turn Interrupted"
                  : "Turn Failed"}
          </h2>
          <p>
            UI dispatch {formatMs(uiDispatchMs ?? activeTurn.metrics.serverAcceptMs)} · Codex{" "}
            {formatMs(activeTurn.metrics.codexLatencyMs)} · total {formatMs(activeTurn.metrics.totalMs)}
          </p>
          {(activeTurn.metrics.appTurnStartMs !== undefined || activeTurn.metrics.firstDeltaMs !== undefined) && (
            <p>
              Startup {formatMs(activeTurn.metrics.appTurnStartMs)} · model wait{" "}
              {formatMs(activeTurn.metrics.modelWaitMs)} · output {formatMs(activeTurn.metrics.outputMs)}
            </p>
          )}
          {pending && <p>Voice {speechPhase === "speaking" ? "speaking" : speechPhase === "buffering" ? "buffering" : "idle"}</p>}
        </div>
        <div className="progress-badge">
          {modeLabels[activeTurn.scratchMode ?? "text"]} · {activeTurn.codexModel} · {effortLabels[activeTurn.reasoningEffort]}
          {activeTurn.scratchMode === "voice" ? ` · Caveman ${activeTurn.voiceCaveman ? "on" : "off"}` : ""}
        </div>
      </div>
      <div className="metrics-row">
        <span>Transcript {activeTurn.metrics.transcriptBytes ?? "-"} bytes</span>
        <span>Prompt {activeTurn.metrics.promptBytes ?? "-"} bytes</span>
        <span>Est. {activeTurn.metrics.promptTokensEstimate ?? "-"} tokens</span>
        {activeTurn.metrics.sttProvider && (
          <span>
            STT {sttProviderLabels[activeTurn.metrics.sttProvider]} · {activeTurn.metrics.sttSegmentCount ?? 1} segments ·{" "}
            {formatBytes(activeTurn.metrics.sttPayloadBytes)}
          </span>
        )}
        {activeTurn.metrics.transportProvider && (
          <span>
            Transport {transportLabels[activeTurn.metrics.transportProvider]} · {activeTurn.metrics.transportState ?? "-"} · RTT{" "}
            {formatMs(activeTurn.metrics.transportRttMs)}
          </span>
        )}
      </div>
      {(activeTurn.metrics.recordingDurationMs !== undefined || activeTurn.metrics.transportProvider) && (
        <div className="audio-timing">
          recording {formatMs(activeTurn.metrics.recordingDurationMs)} · first speech{" "}
          {formatMs(activeTurn.metrics.firstSpeechDetectedMs)} · STT ready {formatMs(activeTurn.metrics.finalSttReadyMs)} · send after
          speech {formatMs(activeTurn.metrics.sendAfterSpeechMs)} · segments {activeTurn.metrics.sttSegmentCount ?? "-"} · payload{" "}
          {formatBytes(activeTurn.metrics.sttPayloadBytes)}
          {activeTurn.metrics.transportProvider && (
            <>
              {" "}
              · packet loss {activeTurn.metrics.transportPacketLoss ?? "-"} · jitter {formatMs(activeTurn.metrics.transportJitterMs)} · reconnects{" "}
              {activeTurn.metrics.transportReconnects ?? 0} · track {activeTurn.metrics.transportTrackState ?? "-"} · muted{" "}
              {activeTurn.metrics.transportMuted ? "yes" : "no"}
            </>
          )}
        </div>
      )}
      {visibleAudioHealth && (
        <>
          <div className="audio-timing">
            text first {formatMs(activeTurn.metrics.firstDeltaMs)} · visible {formatMs(visibleAudioHealth.firstVisibleTextMs)} ·
            speakable {formatMs(visibleAudioHealth.firstSpeakableTextMs)} · queued {formatMs(visibleAudioHealth.firstSpeechQueuedMs)} ·
            speech start {formatMs(visibleAudioHealth.firstSpeechStartMs)}
            {(visibleAudioHealth.provider === "elevenlabs-ws" || visibleAudioHealth.provider === "inworld-ws") && (
              <>
                {" "}
                · ws connect {formatMs(visibleAudioHealth.ttsConnectMs)} · ws audio {formatMs(visibleAudioHealth.firstAudioChunkMs)} ·
                audio play {formatMs(visibleAudioHealth.firstAudioPlayMs)}
              </>
            )}{" "}
            · final {formatMs(visibleAudioHealth.finalTextMs)} ·
            speech after final {formatSignedMs(visibleAudioHealth.speechAfterFinalMs)}
          </div>
          {visibleAudioHealth.ttsProviderStatus && <div className="tts-status-line">{visibleAudioHealth.ttsProviderStatus}</div>}
          <div className={`audio-health${visibleAudioHealth.ttsError ? " audio-health-error" : ""}`}>
            <span>{ttsProviderLabels[visibleAudioHealth.provider]}</span>
            <span>Streamed {visibleAudioHealth.streamedChars} chars</span>
            <span>Final {visibleAudioHealth.finalChars ?? "-"} chars</span>
            <span>Queued {visibleAudioHealth.queuedChars ?? 0} chars</span>
            <span>Spoken {visibleAudioHealth.spokenChars ?? 0} chars</span>
            <span>Chunks {visibleAudioHealth.spokenChunks}</span>
            {(visibleAudioHealth.provider === "elevenlabs-ws" || visibleAudioHealth.provider === "inworld-ws") && <span>Underruns {visibleAudioHealth.audioBufferUnderruns ?? 0}</span>}
            {(visibleAudioHealth.provider === "elevenlabs-ws" || visibleAudioHealth.provider === "inworld-ws") && (
              <span>
                Close {visibleAudioHealth.ttsCloseCode ?? "-"}
                {visibleAudioHealth.ttsCloseReason ? ` ${visibleAudioHealth.ttsCloseReason}` : ""}
              </span>
            )}
            <span>Queued ranges {visibleAudioHealth.queuedRanges || "-"}</span>
            <span>Spoken ranges {visibleAudioHealth.spokenRanges || "-"}</span>
            <span>{visibleAudioHealth.ttsError ? `TTS error: ${visibleAudioHealth.ttsError}` : "TTS ok"}</span>
          </div>
        </>
      )}
      <ol className="turn-log">
        {activeTurn.logs.map((log) => (
          <li key={log.id}>
            <span>{formatMs(log.elapsedMs)}</span>
            <strong>{log.label}</strong>
            {log.detail && <em>{log.detail}</em>}
          </li>
        ))}
      </ol>
    </section>
  ) : null;

  return (
    <main className="app-shell command-shell">
      <div className="ambient-void" aria-hidden="true" />
      <header className="command-topbar">
        <div className="brand-cluster">
          <strong>Mortic</strong>
        </div>
        <form
          className="source-form command-source-form"
          onSubmit={(event) => {
            event.preventDefault();
            void updateSourceThread();
          }}
        >
          <label htmlFor="source-thread">Source</label>
          <input
            id="source-thread"
            value={sourceDraft}
            onChange={(event) => setSourceDraft(event.target.value)}
            placeholder="codex://threads/<thread-id>"
            spellCheck={false}
          />
          <button type="submit" disabled={sourcePending || !sourceDraft.trim()}>
            {sourcePending ? "Opening" : "Open"}
          </button>
        </form>
        <div className="topbar-status">
          <span className={`status-dot ${session?.codex.available ? "ok" : "bad"}`} />
          <span>{session?.codex.available ? session.codex.version ?? "Codex connected" : session?.codex.error ?? "Codex unavailable"}</span>
        </div>
      </header>

      <section className="workspace command-workspace">
        <aside className="side-rail">
          <section className="rail-tree" aria-label="Project tree">
            <div className="rail-heading">
              <div>
                <span>Project</span>
                <h2>{projectState?.project.title ?? "Mortic project"}</h2>
              </div>
              <button type="button" onClick={() => void refreshProject()} disabled={projectPending} title="Sync Mortic's local project archive from disk">
                Sync
              </button>
            </div>
            <div className="rail-actions">
              <button type="button" onClick={() => void openCanonicalState()} disabled={canonicalStatePending}>
                State
              </button>
              <button type="button" onClick={() => void createManualCheckpoint()} disabled={projectPending}>
                Checkpoint
              </button>
            </div>
            {checkpointProposal && (
              <div className="checkpoint-proposal">
                <strong>Possible new checkpoint</strong>
                <p>{checkpointProposal.reason}</p>
                <div>
                  <button type="button" onClick={() => void confirmCheckpointProposal()} disabled={projectPending}>Create</button>
                  <button type="button" onClick={() => void dismissCheckpointProposal()} disabled={projectPending}>Continue</button>
                </div>
              </div>
            )}
            <div className="session-stack">
              {projectSources.length === 0 && (
                <div className="source-node selected-source">
                  <div className="source-node-header">
                    <span>Source</span>
                    <strong>{sourceThreadLabel}</strong>
                  </div>
                  <code title={session?.sourceUri}>{session ? `codex://${redactThreadId(session.threadId)}` : "Paste a codex:// thread"}</code>
                </div>
              )}
              {projectSources.map((source) => {
                const checkpoints = sourceCheckpoints
                  .filter((checkpoint) => checkpoint.sourceThreadId === source.id)
                  .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                const legacySessions = scratchSessions
                  .filter((scratch) => scratch.sourceThreadId === source.id && !scratch.sourceCheckpointId)
                  .slice(0, 6);
                return (
                  <div key={source.id} className={`source-node ${source.id === activeProjectSource?.id ? "selected-source" : ""}`}>
                    <div className="source-node-header">
                      <span>Source</span>
                      <strong>{source.title}</strong>
                    </div>
                    <code title={source.sourceUri}>codex://{redactThreadId(source.codexThreadId)}</code>
                    <div className="source-session-children">
                      {checkpoints.length === 0 && legacySessions.length === 0 && <p className="empty-inline">No scratch sessions yet.</p>}
                      {checkpoints.map((checkpoint) => {
                        const checkpointSessions = scratchSessions.filter((scratch) => scratch.sourceCheckpointId === checkpoint.id).slice(0, 5);
                        return (
                          <section
                            key={checkpoint.id}
                            className={`checkpoint-node ${checkpoint.id === projectState?.project.activeSourceCheckpointId ? "selected-checkpoint" : ""}`}
                          >
                            <div>
                              <strong>{checkpoint.title}</strong>
                              <span>{checkpoint.detectionSource}</span>
                            </div>
                            <small>{checkpoint.parentCheckpointId ? "Child checkpoint" : "Base checkpoint"}</small>
                            <div className="checkpoint-session-children">
                              {checkpointSessions.length === 0 && <p className="empty-inline">No scratch sessions yet.</p>}
                              {checkpointSessions.map((scratch) => (
                                <article key={scratch.id} className={`session-node ${scratch.id === activeProjectSession?.id ? "selected-session" : ""}`}>
                                  <div>
                                    <strong>{scratch.title}</strong>
                                    <span>{scratch.status}</span>
                                  </div>
                                  <p>{scratch.summary || "Commit to generate a canonical summary."}</p>
                                </article>
                              ))}
                            </div>
                          </section>
                        );
                      })}
                      {legacySessions.map((scratch) => (
                        <article key={scratch.id} className={`session-node ${scratch.id === activeProjectSession?.id ? "selected-session" : ""}`}>
                          <div>
                            <strong>{scratch.title}</strong>
                            <span>{scratch.status}</span>
                          </div>
                          <p>{scratch.summary || "Commit to generate a canonical summary."}</p>
                        </article>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
          <button className="rail-commit" type="button" onClick={() => void commitCurrentSession()} disabled={projectPending || pending || transcript.length === 0}>
            {projectPending ? "Compiling" : "Compile Notes"}
          </button>
        </aside>

        <section className="command-main">
          <details className="studio-settings">
            <summary>
              <span>Config</span>
              <strong>{transportLabels[transportProvider]} · {sttProviderLabels[sttProvider]} · {ttsProviderLabels[ttsProvider]} · {modelLabels[effectiveCodexModel] ?? effectiveCodexModel}</strong>
            </summary>
            <section className="control-strip compact-controls" aria-label="Session controls">
              <div className="segmented mode-segmented" aria-label="Scratch mode">
                {scratchModes.map((mode) => (
                  <button key={mode} type="button" className={mode === scratchMode ? "selected" : ""} onClick={() => setScratchMode(mode)} disabled={pending}>
                    {modeLabels[mode]}
                  </button>
                ))}
              </div>
              <label className="toggle-control" title="Apply Caveman-lite compression to spoken voice answers only">
                <input type="checkbox" checked={voiceCaveman} onChange={(event) => setVoiceCaveman(event.target.checked)} disabled={scratchMode !== "voice" || pending} />
                Caveman speech
              </label>
              <label className="control-select">
                <span>Transport</span>
                <select value={transportProvider} onChange={(event) => setTransportProvider(event.target.value as TransportProvider)} disabled={pending}>
                  {transportProviders.map((provider) => (
                    <option key={provider} value={provider} disabled={!liveKitStatus.availableTransports.includes(provider)}>
                      {transportLabels[provider]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="control-select">
                <span>Speech to text</span>
                <select value={sttProvider} onChange={(event) => setSttProvider(event.target.value as SttProvider)} disabled={pending}>
                  {sttProviders.map((provider) => (
                    <option key={provider} value={provider} disabled={!sttStatus.availableProviders.includes(provider)}>
                      {sttProviderLabels[provider]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="control-select">
                <span>Text to speech</span>
                <select value={ttsProvider} onChange={(event) => setTtsProvider(event.target.value as TtsProvider)} disabled={pending}>
                  {ttsProviders.map((provider) => (
                    <option key={provider} value={provider} disabled={!ttsStatus.availableProviders.includes(provider)}>
                      {ttsProviderLabels[provider]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="model-control">
                <span>Model</span>
                <select value={effectiveCodexModel} onChange={(event) => setCodexModel(event.target.value)} disabled={pending}>
                  {!modelOptions.includes(effectiveCodexModel) && <option value={effectiveCodexModel}>{effectiveCodexModel}</option>}
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>{modelLabels[model] ?? model}</option>
                  ))}
                </select>
              </label>
              <label className="control-select">
                <span>Reasoning</span>
                <select value={effectiveReasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)} disabled={pending}>
                  {reasoningEfforts.map((effort) => (
                    <option
                      key={effort}
                      value={effort}
                      disabled={
                        (scratchMode === "voice" && effort === "minimal") ||
                        (modelRequiresLowReasoning(effectiveCodexModel) && (effort === "none" || effort === "minimal"))
                      }
                    >
                      {effortLabels[effort]}
                    </option>
                  ))}
                </select>
              </label>
            {needsModelTransitionPreflight(effectiveCodexModel) && (
              <div className={`spark-context spark-context-${sparkContext.status}`} title={currentSparkPreflight?.detail}>
                <span>{sparkContext.label}</span>
                {sparkContext.compactionRequired ? (
                  <button type="button" onClick={() => void compactSparkThenRetry()} disabled={pending || sparkPreflightPending || sparkCompactionPending}>
                    {sparkCompactionPending ? "Compacting" : "Compact Then Retry"}
                  </button>
                ) : sparkContext.requiresApproval && (
                  <button
                    type="button"
                    onClick={() => {
                      setSparkApprovalKey(sparkContext.key);
                      prewarmKeyRef.current = "";
                      prewarmAnnouncementKeyRef.current = "";
                      setPrewarm({ status: "idle", detail: "Candidate model approved" });
                    }}
                    disabled={sparkApproved || pending || sparkPreflightPending || sparkCompactionPending}
                  >
                    {sparkApproved ? "Approved" : sparkPreflightPending ? "Checking" : "Start Anyway"}
                  </button>
                )}
              </div>
            )}
            </section>
          </details>

          {runtimeNotices.length > 0 && (
            <details className="system-note-strip">
              <summary>
                <span>{systemSummary || "System ready"}</span>
                <em>{runtimeNotices.length} note{runtimeNotices.length === 1 ? "" : "s"}</em>
              </summary>
              <div>
                {runtimeNotices.map((message) => <p key={message}>{message}</p>)}
              </div>
            </details>
          )}
          {runtimeErrors.length > 0 && (
            <div className="notice-row">
              {runtimeErrors.map((message) => <div key={message} className="notice error">{message}</div>)}
            </div>
          )}

          <section className="agent-canvas" aria-label="Mortic voice agent">
            <div className="agent-status-row" aria-label="Runtime state">
              <span className={`agent-status-pill state-${transportState === "failed" ? "bad" : transportState === "connecting" || transportState === "reconnecting" ? "busy" : "ok"}`}>
                <em>Transport</em>
                <strong>{transportStateLabel}</strong>
              </span>
              <span className={`agent-status-pill state-${activeSttSupported ? recognizing || sttPhase !== "idle" ? "busy" : "ok" : "bad"}`}>
                <em>Mic</em>
                <strong>{compactMicStateLabel}</strong>
              </span>
              <span className={`agent-status-pill state-${prewarm.status === "error" || sparkBlocked ? "bad" : prewarm.status === "warming" || pending ? "busy" : "ok"}`}>
                <em>Codex</em>
                <strong>{codexStateLabel}</strong>
              </span>
              <span className={`agent-status-pill state-${speechPhase === "speaking" || speechPhase === "buffering" ? "busy" : ttsStatus.availableProviders.includes(ttsProvider) ? "ok" : "bad"}`}>
                <em>Speech</em>
                <strong>{speechStateLabel}</strong>
              </span>
            </div>
            <div className={`agent-orb agent-${agentState} ${recognizing ? "agent-hearing" : ""} ${speechPhase === "speaking" ? "agent-speaking" : ""}`}>
              <div className="orb-halo" />
              <div className="orb-core">
                <span>{agentState === "idle" ? "READY" : agentState.toUpperCase()}</span>
                <strong>{codexStateLabel}</strong>
              </div>
            </div>
            <article className="live-transcript-card">
              <div className="live-card-header">
                <span>Scratch</span>
                <button type="button" onClick={() => setTranscriptDrawerOpen(true)}>Open transcript</button>
              </div>
              {state.loading && <p>Loading session.</p>}
              {!state.loading && transcript.length === 0 && <p>Say or type a scratch turn.</p>}
              {latestUserEntry && (
                <section className="compact-turn compact-user">
                  <span>You</span>
                  <p>{entryMainText(latestUserEntry)}</p>
                </section>
              )}
              {pending && liveAssistantText ? (
                <section className="compact-turn compact-assistant">
                  <span>Mortic streaming</span>
                  <p>{liveAssistantText}</p>
                </section>
              ) : pending ? (
                <section className="compact-turn compact-assistant compact-thinking">
                  <span>Mortic</span>
                  <p>Thinking.</p>
                </section>
              ) : compactAssistantEntry && (
                <section className="compact-turn compact-assistant">
                  <span>Mortic</span>
                  <p>{entryMainText(compactAssistantEntry)}</p>
                  {compactAssistantEntry.notesText && (
                    <details className="entry-notes entry-read-disclosure">
                      <summary>{entryNotesLabel(compactAssistantEntry)}</summary>
                      <div className="entry-notes-content">
                        <MarkdownContent markdown={compactAssistantEntry.notesText} />
                      </div>
                    </details>
                  )}
                </section>
              )}
            </article>
            <nav className="bottom-voice-dock" aria-label="Voice controls">
              <button
                type="button"
                onClick={() => setLiveActive(!liveModeActiveRef.current)}
                className={liveModeActive ? "dock-active" : ""}
                disabled={!LIVE_MODE_RUNTIME_ENABLED}
                title="Live mode is paused until echo-safe turn detection is ready."
              >
                <span>Live</span>
                <strong>{liveModeActive ? "On" : "Off"}</strong>
              </button>
              <button
                type="button"
                className={`dock-mic ${recognizing ? "recording" : ""}`}
                disabled={pushToTalkDisabled}
                onPointerDown={(event) => {
                  event.preventDefault();
                  startPushToTalkCapture();
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  stopPushToTalkCapture();
                }}
                onPointerCancel={(event) => {
                  event.preventDefault();
                  stopPushToTalkCapture();
                }}
                onPointerLeave={() => {
                  if (recognizingRef.current) stopPushToTalkCapture();
                }}
                onClick={(event) => event.preventDefault()}
              >
                <span>{recognizing ? "Listening" : "Push"}</span>
                <strong>{dockTalkLabel}</strong>
              </button>
              <button type="button" onClick={() => void interruptTurn()} disabled={!pending && speechPhase === "idle"}>
                <span>Interrupt</span>
                <strong>{speechPhase === "speaking" ? "Speaking" : "Stop"}</strong>
              </button>
              <button type="button" onClick={clearScratch} disabled={pending || transcript.length === 0}>
                <span>Clear</span>
                <strong>{prewarm.status === "ready" ? `Ready ${formatMs(prewarm.elapsedMs)}` : prewarm.status === "warming" ? "Warming" : "Reset"}</strong>
              </button>
            </nav>
            <form
              className="composer command-composer"
              onSubmit={(event) => {
                event.preventDefault();
                void sendTurn(draft);
              }}
            >
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type a scratch turn" rows={3} />
              <button type="submit" disabled={pending || !draft.trim() || sparkBlocked}>{pending ? "Running" : "Send"}</button>
            </form>
          </section>

          <details className="telemetry-panel" open={Boolean(activeTurn)}>
            <summary>Debug / Telemetry</summary>
            {progressPanel ?? <p className="empty-inline">No active turn telemetry yet.</p>}
          </details>
        </section>

        <aside className="insights-panel">
          <section className="project-card extraction-card">
            <div className="project-card-header">
              <div>
                <span>Project updates</span>
                <h2>{draftExtractions.length} to review</h2>
              </div>
              <div className="project-header-actions">
                <button type="button" onClick={() => void openCanonicalState()} disabled={canonicalStatePending}>Open State</button>
                <button type="button" onClick={() => void commitCurrentSession(activeExtractions.map((item) => item.id))} disabled={projectPending || pending || activeExtractions.length === 0}>Approve all</button>
              </div>
            </div>
            <div className="extraction-chip-row" aria-label="Project update counts">
              {extractionCounts.length === 0 ? (
                <span className="extraction-chip extraction-chip-empty">No updates</span>
              ) : (
                extractionCounts.map((item) => (
                  <span key={item.type} className={`extraction-chip extraction-chip-${item.type}`}>
                    <strong>{item.total}</strong> {extractionTypeShortLabels[item.type]}
                  </span>
                ))
              )}
            </div>
            <p className="compact-card-line">{extractionPreview}</p>
            <button className="card-open-button" type="button" onClick={() => setExtractionReviewOpen(true)}>
              Review updates
            </button>
          </section>

          <section className="project-card handoff-card">
            <div className="project-card-header">
              <div>
                <span>Handoff</span>
                <h2>{handoffStateLabel}</h2>
              </div>
              <button type="button" onClick={generateHandoff} disabled={handoffPending || transcript.length === 0}>{handoffPending ? "Generating" : "Generate"}</button>
            </div>
            <p className="compact-card-line">{handoffPreview}</p>
            <details className="card-disclosure">
              <summary>Open handoff tools</summary>
              <div className="token-budget">
                <div className="token-budget-header">
                  <span>Token budget</span>
                  <strong>{formatCount(tokenBudget.transcriptTokens)} transcript</strong>
                </div>
                <div className="token-budget-grid">
                  <div>
                    <span>Short</span>
                    <strong>{tokenBudget.short.hasPrompt ? formatCount(tokenBudget.short.tokens) : "-"}</strong>
                    <em>{tokenBudget.short.hasPrompt ? `${formatCount(tokenBudget.short.savedTokens)} fewer` : "Generate to compare"}</em>
                  </div>
                  <div>
                    <span>Full</span>
                    <strong>{tokenBudget.full.hasPrompt ? formatCount(tokenBudget.full.tokens) : "-"}</strong>
                    <em>{tokenBudget.full.hasPrompt ? `${formatCount(tokenBudget.full.savedTokens)} fewer` : "Generate to compare"}</em>
                  </div>
                </div>
                {futureSavingsLine && <p>{futureSavingsLine}</p>}
              </div>
              <div className="handoff-actions">
                <button type="button" onClick={() => void copyHandoffText(shortHandoff)} disabled={!shortHandoff}>Copy Short</button>
                <button type="button" onClick={() => void copyHandoffText(fullHandoff || handoff)} disabled={!fullHandoff && !handoff}>Copy Full</button>
                <button type="button" onClick={() => setHandoffReviewOpen(true)} disabled={!shortHandoff && !fullHandoff && !handoff}>Open</button>
              </div>
            </details>
          </section>
        </aside>
      </section>

      {transcriptDrawerOpen && (
        <div className="drawer-backdrop" role="presentation" onClick={() => setTranscriptDrawerOpen(false)}>
          <section className="transcript-drawer" role="dialog" aria-modal="true" aria-label="Expanded transcript" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <span>ID: {session?.id ?? "no-session"}</span>
                <h2>Expanded Transcript</h2>
              </div>
              <button type="button" onClick={() => setTranscriptDrawerOpen(false)}>Close</button>
            </div>
            <div className="transcript drawer-transcript">
              {compactTranscript.length === 0 && <div className="empty">No scratch turns yet</div>}
              {transcript.map((entry) => {
                const parserLabel = entryParserLabel(entry);
                return (
                  <article key={entry.id} className={`entry entry-${entry.role} ${entry.failed ? "entry-failed" : ""} ${entry.parserMode === "invalid" ? "entry-parser-invalid" : ""}`}>
                    <div className="entry-meta">
                      <span>{entryLabel(entry)}</span>
                      <div className="entry-meta-right">
                        {parserLabel && <span className="entry-parser-status">{parserLabel}</span>}
                        <span>{entry.scratchMode ? `${modeLabels[entry.scratchMode]} · ` : ""}{entry.reasoningEffort ? effortLabels[entry.reasoningEffort] : ""}</span>
                      </div>
                    </div>
                    {entry.notesText || entry.sourcesText ? (
                      <div className="entry-body">
                        <p>{entryMainText(entry)}</p>
                        {entry.notesText && (
                          <details className="entry-notes entry-read-disclosure" open>
                            <summary>{entryNotesLabel(entry)}</summary>
                            <div className="entry-notes-content"><MarkdownContent markdown={entry.notesText} /></div>
                          </details>
                        )}
                        {entry.sourcesText && (
                          <div className="entry-sources">
                            <span>Sources</span>
                            <div className="entry-notes-content"><MarkdownContent markdown={entry.sourcesText} /></div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p>{entry.text}</p>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {extractionReviewOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setExtractionReviewOpen(false)}>
          <section className="extraction-review-modal" role="dialog" aria-modal="true" aria-label="Project update review" onClick={(event) => event.stopPropagation()}>
            <div className="extraction-review-header">
              <div>
                <span>Project updates</span>
                <h2>{draftExtractions.length} waiting for review</h2>
                <p>Approve only the updates that should enter Mortic canonical state.</p>
              </div>
              <div className="project-header-actions">
                <button type="button" onClick={() => void openCanonicalState()} disabled={canonicalStatePending}>Open State</button>
                <button type="button" onClick={() => setExtractionReviewOpen(false)}>Close</button>
              </div>
            </div>
            <div className="extraction-chip-row extraction-modal-chips">
              {extractionCounts.length === 0 ? (
                <span className="extraction-chip extraction-chip-empty">No updates found</span>
              ) : (
                extractionCounts.map((item) => (
                  <span key={item.type} className={`extraction-chip extraction-chip-${item.type}`}>
                    <strong>{item.total}</strong> {extractionTypeLabels[item.type]}
                  </span>
                ))
              )}
              {approvedExtractions.length > 0 && <span className="extraction-chip extraction-chip-approved"><strong>{approvedExtractions.length}</strong> approved total</span>}
            </div>
            <div className="extraction-review-list">
              {activeExtractions.length === 0 && (
                <p className="empty-inline">Compile a session after real decisions, tasks, risks, priorities, constraints, or deferred work appear in the scratch transcript.</p>
              )}
              {activeExtractions.map((item) => (
                <article key={item.id} className={`extraction-item extraction-${item.type} extraction-status-${item.status}`}>
                  <div className="extraction-topline">
                    <span>{extractionTypeLabels[item.type]}</span>
                    <em>{item.delta ? `${extractionStatusLabels[item.status]} · ${item.delta}` : extractionStatusLabels[item.status]}</em>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                  <div className="extraction-why">
                    <strong>Why picked</strong>
                    <span>{item.selectionReason ?? extractionReasons[item.type]}</span>
                    {item.transcriptAnchor?.quote && (
                      <>
                        <small>{extractionEvidenceLabel(item)}</small>
                        <q>{item.transcriptAnchor.quote}</q>
                      </>
                    )}
                    <em>{item.delta ? `Delta: ${item.delta}. ` : ""}Confidence {Math.round(item.confidence * 100)}%</em>
                  </div>
                  <div className="extraction-actions">
                    <button type="button" onClick={() => void updateExtraction(item.id, "approved")} disabled={projectPending || item.status === "approved"}>Approve</button>
                    <button type="button" onClick={() => void updateExtraction(item.id, "dismissed")} disabled={projectPending}>Dismiss</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {handoffReviewOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setHandoffReviewOpen(false)}>
          <section className="handoff-review-modal" role="dialog" aria-modal="true" aria-label="Handoff review" onClick={(event) => event.stopPropagation()}>
            <div className="handoff-review-header">
              <div>
                <span>{activeExtractions.length} candidates pending</span>
                <h2>Handoff Review</h2>
                <p>Review the scratch handoff before carrying it back to the source thread.</p>
              </div>
              <button type="button" onClick={() => setHandoffReviewOpen(false)}>Close</button>
            </div>
            <div className="handoff-review-body">
              <aside>
                {activeExtractions.length === 0 && <p className="empty-inline">No extraction candidates yet.</p>}
                {activeExtractions.slice(0, 5).map((item) => (
                  <article key={item.id} className={item.status === "approved" ? "active" : ""}>
                    <span>{extractionTypeLabels[item.type]}</span>
                    <strong>{item.title}</strong>
                    <p>{item.body}</p>
                  </article>
                ))}
              </aside>
              <section className="handoff-editor-split">
                <label>
                  <span>Short prompt</span>
                  <textarea
                    className="handoff-editor"
                    value={shortHandoff}
                    onChange={(event) => {
                      setShortHandoff(event.target.value);
                      setHandoff(`# Short Prompt\n\n${event.target.value}\n\n# Full Prompt\n\n${fullHandoff}`);
                    }}
                    placeholder="Generate a concise next instruction"
                  />
                </label>
                <label>
                  <span>Full prompt</span>
                  <textarea
                    className="handoff-editor"
                    value={fullPromptValue}
                    onChange={(event) => {
                      setFullHandoff(event.target.value);
                      setHandoff(`# Short Prompt\n\n${shortHandoff}\n\n# Full Prompt\n\n${event.target.value}`);
                    }}
                    placeholder="Generate a fuller actionable instruction"
                  />
                </label>
              </section>
            </div>
            <footer>
              <button type="button" onClick={() => void generateHandoff()} disabled={handoffPending || transcript.length === 0}>{handoffPending ? "Generating" : "Regenerate"}</button>
              <button type="button" onClick={() => void copyHandoffText(shortHandoff)} disabled={!shortHandoff}>Copy Short</button>
              <button type="button" className="primary-action" onClick={() => void copyHandoffText(fullHandoff || handoff)} disabled={!fullHandoff && !handoff}>Copy Full</button>
            </footer>
          </section>
        </div>
      )}

      {canonicalStateOpen && canonicalState && (
        <div className="modal-backdrop" role="presentation" onClick={() => setCanonicalStateOpen(false)}>
          <section className="canonical-modal" role="dialog" aria-modal="true" aria-label="Project canonical state" onClick={(event) => event.stopPropagation()}>
            <div className="canonical-modal-header">
              <div>
                <span>Canonical state</span>
                <h2>{canonicalState.project.title}</h2>
                <p>{canonicalState.projectDir}</p>
              </div>
              <div className="project-header-actions">
                <button type="button" onClick={() => void copyText(canonicalState.productionMarkdown)}>Copy Markdown</button>
                <button type="button" onClick={() => setCanonicalStateOpen(false)}>Close</button>
              </div>
            </div>
            <div className="canonical-modal-body">
              <section className="canonical-pane">
                <div className="canonical-pane-header">
                  <span>Production chart</span>
                  <small>{canonicalState.productionMarkdownPath}</small>
                </div>
                <div className="markdown-body canonical-markdown"><MarkdownContent markdown={canonicalState.productionMarkdown} /></div>
              </section>
              <section className="canonical-pane">
                <div className="canonical-pane-header">
                  <span>Extracted items</span>
                  <small>{canonicalState.extractedItemsMarkdownPath}</small>
                </div>
                <div className="markdown-body canonical-markdown"><MarkdownContent markdown={canonicalState.extractedItemsMarkdown} /></div>
              </section>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
