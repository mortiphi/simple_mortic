import type { AudioHealthRequest, MorticSession, TtsProvider } from "../../shared/types.js";

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
export type AudioContextConstructor = new () => AudioContext;

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

export type SpeechRecognitionEventLike = {
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

export type ApiState = {
  session: MorticSession | null;
  loading: boolean;
  error: string | null;
};

export type PrewarmState = {
  status: "idle" | "warming" | "ready" | "error";
  key?: string;
  detail?: string;
  confirmation?: string;
  elapsedMs?: number;
};

export type AudioHealthState = AudioHealthRequest & {
  turnId: string;
};

export type RemoteSttSegment = {
  base64: string;
  bytes: number;
  durationMs: number;
  startedAt: number;
  stoppedAt: number;
};

export type SpeechQueueItem = {
  id: string;
  start: number;
  end: number;
  text: string;
};

export type SpeechLedgerItem = SpeechQueueItem & {
  status: "queued" | "speaking" | "spoken" | "failed";
  provider: TtsProvider;
};

export type ProgressSoundHandle = {
  audio: HTMLAudioElement;
  context?: AudioContext;
  source?: MediaElementAudioSourceNode;
  filter?: BiquadFilterNode;
  gain?: GainNode;
};
