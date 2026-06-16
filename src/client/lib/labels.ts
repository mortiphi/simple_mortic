import type {
  CanonicalDelta,
  ConversationArtifact,
  ExtractedItem,
  ExtractionStatus,
  ProviderReference,
  ReasoningEffort,
  ScratchMode,
  SttProvider,
  TranscriptEntry,
  TransportProvider,
  TtsProvider,
  TurnRun
} from "../../shared/types.js";

export const effortLabels: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh"
};

export const modeLabels: Record<ScratchMode, string> = {
  voice: "Voice",
  text: "Text"
};

export const ttsProviderLabels: Record<TtsProvider, string> = {
  browser: "Browser",
  deepgram: "Deepgram",
  "inworld-ws": "Inworld WS",
  elevenlabs: "ElevenLabs",
  "elevenlabs-ws": "ElevenLabs WS"
};

export const sttProviderLabels: Record<SttProvider, string> = {
  "deepgram-stt": "Deepgram STT",
  "inworld-stt": "Inworld STT",
  whisper: "Whisper",
  browser: "Browser"
};

export const transportLabels: Record<TransportProvider, string> = {
  "local-browser": "Local Browser",
  "livekit-webrtc": "LiveKit WebRTC"
};

export const progressKeyboardLoopUrl = "/assets/progress-keyboard.ogg";

export const extractionTypeLabels: Record<ExtractedItem["type"], string> = {
  project_state: "Project State Update",
  prioritization: "Prioritisation Update",
  task: "Task Update",
  risk: "Risk Update",
  backlog: "Backlog Update"
};

export const extractionTypeShortLabels: Record<ExtractedItem["type"], string> = {
  project_state: "State",
  prioritization: "Priority",
  task: "Task",
  risk: "Risk",
  backlog: "Backlog"
};

export const extractionTypeOrder: ExtractedItem["type"][] = ["project_state", "prioritization", "task", "risk", "backlog"];

export const extractionStatusLabels: Record<ExtractionStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  dismissed: "Dismissed",
  merged: "Merged"
};

export const extractionOperationLabels: Record<string, string> = {
  add: "Create",
  append_evidence: "Append evidence",
  mark_resolved: "Mark resolved",
  deprecate: "Supersede",
  promote_backlog_to_task: "Promote backlog to task",
  demote_task_to_backlog: "Move task to backlog"
};

export const inactiveExtractionLifecycleStatuses = new Set(["resolved", "dropped", "superseded", "stale"]);

export function isExtractionReviewCandidate(item: ExtractedItem): boolean {
  if (item.status !== "draft") return false;
  const lifecycleStatus = item.lifecycleStatusAfter ?? "open";
  return !inactiveExtractionLifecycleStatuses.has(lifecycleStatus);
}

export function extractionActionLabel(item: ExtractedItem): string | undefined {
  if (item.canonicalOperation && extractionOperationLabels[item.canonicalOperation]) {
    return extractionOperationLabels[item.canonicalOperation];
  }
  if (item.delta) return item.delta;
  return undefined;
}

export function extractionReviewSort(left: ExtractedItem, right: ExtractedItem): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

export const extractionReasons: Record<ExtractedItem["type"], string> = {
  project_state: "Picked because it looks like a durable project fact, decision, constraint, or operating rule.",
  prioritization: "Picked because it changes what matters now, next, later, or what is deferred.",
  task: "Picked because it looks like concrete work that can be implemented, tested, or marked done.",
  risk: "Picked because it names a failure mode, blocker, uncertainty, or safety issue.",
  backlog: "Picked because it was explicitly framed as future or deferred work."
};

export function extractionEvidenceLabel(item: ExtractedItem): string {
  if (item.evidenceSource === "handoff_full") return "Evidence from full handoff";
  if (item.evidenceSource === "handoff_short") return "Evidence from short handoff";
  if (item.evidenceSource === "handoff") return "Evidence from handoff";
  if (item.evidenceSource === "session") return "Evidence from session metadata";
  if (item.evidenceSource === "production_json") return "Evidence from production state";
  if (item.evidenceSource === "production_md") return "Evidence from production notes";
  if (item.evidenceSource === "code_state") return "Evidence from workspace commits";
  return "Evidence from transcript";
}

export function chartDateLabel(value: string | undefined): string {
  if (!value) return "-";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

export function providerRefTitle(ref: ProviderReference): string {
  return `${ref.provider} ${ref.forkKind}${ref.ephemeral ? " ephemeral" : ref.persisted ? " persisted" : ""}`;
}

export function providerActionText(action: ProviderReference["actions"]["resume"], label: string): string {
  return action.available ? `${label}: available` : `${label}: ${action.disabledReason ?? "disabled"}`;
}

export function artifactTitle(artifact: ConversationArtifact | undefined): string {
  if (!artifact) return "No artifact";
  return artifact.title || artifact.id;
}

export function turnProgressSummary(turn: TurnRun | null | undefined): { phase: string; detail: string; elapsedMs?: number } {
  if (!turn) return { phase: "Sending", detail: "Waiting for Mortic to accept the turn" };
  const latest = turn.logs.at(-1);
  const label = latest?.label ?? "Turn running";
  const detail = latest?.detail ?? "";

  if (turn.metrics.firstDeltaMs !== undefined) {
    if (/tool/i.test(label)) return { phase: "Using a tool", detail: detail || label, elapsedMs: latest?.elapsedMs };
    return { phase: "Streaming response", detail: detail || label, elapsedMs: latest?.elapsedMs };
  }

  if (/request received/i.test(label)) return { phase: "Preparing turn", detail: detail || "User text received", elapsedMs: latest?.elapsedMs };
  if (/utterance prepared/i.test(label)) return { phase: "Preparing prompt", detail, elapsedMs: latest?.elapsedMs };
  if (/runtime context/i.test(label)) return { phase: "Restoring workspace", detail, elapsedMs: latest?.elapsedMs };
  if (/bridge selected/i.test(label)) return { phase: "Starting Codex bridge", detail, elapsedMs: latest?.elapsedMs };
  if (/turn\/start sent/i.test(label)) return { phase: "Starting scratch turn", detail, elapsedMs: latest?.elapsedMs };
  if (/turn started/i.test(label)) return { phase: "Waiting for first token", detail: detail || "Codex accepted the turn", elapsedMs: latest?.elapsedMs };
  if (/first model delta/i.test(label)) return { phase: "Streaming response", detail, elapsedMs: latest?.elapsedMs };

  return { phase: label, detail, elapsedMs: latest?.elapsedMs };
}

export function deltaLifecycleLabel(delta: CanonicalDelta): string {
  return `${delta.lifecycleAction ?? "create"} -> ${delta.lifecycleStatusAfter ?? "open"}`;
}

export const SETTINGS_VERSION = "voice-mode-v6";
export const modelOptions = ["default", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.3-codex"];
export const modelLabels: Record<string, string> = {
  default: "Thread native",
  "gpt-5.5": "GPT-5.5 · full context",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex-spark": "Codex Spark · fast, smaller context",
  "gpt-5.3-codex": "Codex"
};

export function entryLabel(entry: TranscriptEntry): string {
  if (entry.role === "user") return "You";
  if (entry.failed) return "Mortic error";
  return "Mortic";
}

export function entryMainText(entry: TranscriptEntry): string {
  if (entry.notesText && entry.spokenText) return entry.spokenText;
  return entry.text;
}

export function entryNotesLabel(entry: TranscriptEntry): string {
  return entry.spokenText ? "Read" : "Notes";
}

export function entryParserLabel(entry: TranscriptEntry): string | null {
  if (!entry.parserMode) return null;
  if (entry.parserMode === "invalid") return "Parser failed";
  if (entry.parserError) return "Parser warning";
  return null;
}
