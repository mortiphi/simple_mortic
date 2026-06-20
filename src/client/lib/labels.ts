import type {
  ReasoningEffort,
  ScratchMode,
  SttProvider,
  TranscriptEntry,
  TransportProvider,
  TtsProvider
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

export const SETTINGS_VERSION = "voice-mode-v6";

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
