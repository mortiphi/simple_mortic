import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import {
  type AudioHealthRequest,
  type CaptureState,
  type ClientSurface,
  type CodexRuntimePolicy,
  type InputPolicy,
  type LiveKitStatus,
  type MorticSession,
  type ReasoningEffort,
  type ScratchMode,
  type SparkContextPreflight,
  type SttProvider,
  type SttProviderFailure,
  type SttStatus,
  type SttTranscriptionResponse,
  type SttTurnMetrics,
  type TranscriptEntry,
  type TransportProvider,
  type TransportState,
  type TtsHealthResponse,
  type TtsProvider,
  type TurnRun,
  type TurnStatusResponse,
  type TurnStreamEvent
} from "../../shared/types.js";
import { partialSpokenText } from "../../shared/voiceResponse.js";
import { projectSpeech, shouldUseExactSpeechProjection } from "../../shared/speechProjection.js";
import { attributeSttFailure } from "../../shared/sttFailure.js";
import { hasAssistantOutputForBargeIn } from "../../shared/bargeInControl.js";
import {
  isCurrentRecognitionSession,
  isEditableShortcutTarget,
  keyboardIntentForKeyDown,
  keyboardIntentForKeyUp,
  shouldSubmitCapturedTurn
} from "../../shared/inputControl.js";
import {
  createBrowserTtsProvider,
  createDeepgramTtsProvider,
  createElevenLabsTtsProvider,
  createElevenLabsWsTtsProvider,
  createInworldWsTtsProvider,
  type RuntimeTtsProvider,
  type TtsSpeakCallbacks
} from "../tts.js";
import { MorticLiveKitTransport, type LiveKitTransportStats } from "../livekitTransport.js";
import { ApiState, AudioHealthState, PrewarmState, ProgressSoundHandle, RemoteSttSegment, SpeechLedgerItem, SpeechQueueItem, SpeechRecognitionLike } from "../lib/clientTypes.js";
import { formatBytes, formatMs } from "../lib/format.js";
import { progressKeyboardLoopUrl, sttProviderLabels, ttsProviderLabels } from "../lib/labels.js";
import { needsModelTransitionPreflight } from "../lib/spark.js";
import { HARD_STT_SEGMENT_MS, LIVE_MODE_RUNTIME_ENABLED, MAX_LOCAL_SEGMENT_BYTES, REMOTE_STT_SAMPLE_RATE, SOFT_STT_SEGMENT_MS, audioContextConstructor, bytesToBase64, chooseSpeakableEnd, downsampleFloat32, encodeWavPcm16, friendlySpeechError, isBufferedTtsProvider, isSpeakableText, mergeFloat32, rangeSummary } from "../lib/voice.js";

const TTS_CHUNK_WATCHDOG_MS = 60000;
const ASSISTANT_DRAFT_FINALIZING_MS = 1400;

type BargeInSource = "push-to-talk" | "interrupt-button" | "live-vad";

type BargeInPhase = "idle" | "barge_capture" | "transcribing" | "queued_next_turn";

type AssistantDraftPhase = "streaming" | "finalizing" | "final-pending";

type StreamingAssistantDraft = {
  turnId: string | null;
  text: string;
  phase: AssistantDraftPhase;
};

type BargeInState = {
  id: number;
  source: BargeInSource;
  phase: BargeInPhase;
  startedAt: number;
  outputTurnId: string | null;
  pendingAtStart: boolean;
  firstMicFrameAt?: number;
  firstSpeechDetectedAt?: number;
};

export interface VoiceEngineParams {
  api: string;
  clientId: string;
  surface: ClientSurface;
  state: ApiState;
  setState: Dispatch<SetStateAction<ApiState>>;
  scratchMode: ScratchMode;
  effectiveCodexModel: string;
  effectiveServiceTier?: string | null;
  effectiveCodexRuntimePolicy: CodexRuntimePolicy;
  effectiveReasoningEffort: ReasoningEffort;
  effectiveVoiceCaveman: boolean;
  sparkApproved: boolean;
  sparkBlocked: boolean;
  sparkPreflightPending: boolean;
  sparkCompactionPending: boolean;
  sparkContext: { label: string; compactionRequired: boolean };
  setSparkPreflight: Dispatch<SetStateAction<SparkContextPreflight | null>>;
  setSparkApprovalKey: Dispatch<SetStateAction<string>>;
  setDraft: Dispatch<SetStateAction<string>>;
  pending: boolean;
  pendingRef: MutableRefObject<boolean>;
  setTurnPending: (nextPending: boolean) => void;
  setPrewarm: Dispatch<SetStateAction<PrewarmState>>;
  prewarmKeyRef: MutableRefObject<string>;
  prewarmAnnouncementKeyRef: MutableRefObject<string>;
  speechProjectionEnabled: boolean;
  progressSoundsEnabled: boolean;
  progressSpeechEnabled: boolean;
  ttsProvider: TtsProvider;
  sttStatus: SttStatus;
  sttProvider: SttProvider;
  setSttProvider: Dispatch<SetStateAction<SttProvider>>;
  liveKitStatus: LiveKitStatus;
  transportProvider: TransportProvider;
  inputPolicy: InputPolicy;
  setInputPolicy: Dispatch<SetStateAction<InputPolicy>>;
  liveModeActive: boolean;
  setLiveModeActive: Dispatch<SetStateAction<boolean>>;
  isAudioOwner: boolean;
  requestAudioOwnership: () => Promise<boolean>;
  turnsDisabled: boolean;
}

// Voice engine owns recognition/capture, speech queueing, TTS, streamed turn events,
// PTT/barge-in, audio-health reporting, and transport integration.
export function useVoiceEngine(params: VoiceEngineParams) {
  const {
    api,
    clientId,
    surface,
    state,
    setState,
    scratchMode,
    effectiveCodexModel,
    effectiveServiceTier,
    effectiveCodexRuntimePolicy,
    effectiveReasoningEffort,
    effectiveVoiceCaveman,
    sparkApproved,
    sparkBlocked,
    sparkPreflightPending,
    sparkCompactionPending,
    sparkContext,
    setSparkPreflight,
    setSparkApprovalKey,
    setDraft,
    pending,
    pendingRef,
    setTurnPending,
    prewarmAnnouncementKeyRef,
    speechProjectionEnabled,
    progressSoundsEnabled,
    progressSpeechEnabled,
    ttsProvider,
    sttStatus,
    sttProvider,
    setSttProvider,
    liveKitStatus,
    transportProvider,
    inputPolicy,
    setInputPolicy,
    liveModeActive,
    setLiveModeActive,
    isAudioOwner,
    requestAudioOwnership,
    turnsDisabled
  } = params;
  const isAudioOwnerRef = useRef(isAudioOwner);
  const previousAudioOwnerRef = useRef(isAudioOwner);
  const audioOwnerHydratedRef = useRef(false);

  useEffect(() => {
    const wasOwner = previousAudioOwnerRef.current;
    isAudioOwnerRef.current = isAudioOwner;
    previousAudioOwnerRef.current = isAudioOwner;
    if (!audioOwnerHydratedRef.current) {
      audioOwnerHydratedRef.current = true;
      return;
    }
    if (wasOwner && !isAudioOwner) {
      cancelSpeechAudio();
      if (recognizingRef.current || sttPhaseRef.current !== "idle") discardCapture(false);
      setTtsProviderNotice("Audio moved to another Mortic window.");
    }
  }, [isAudioOwner]);

  const [transportState, setTransportState] = useState<TransportState>("disconnected");
  const [transportStats, setTransportStats] = useState<LiveKitTransportStats>({
    reconnects: 0,
    trackState: "none",
    muted: true,
    audioLevel: 0
  });
  const [transportNotice, setTransportNotice] = useState<string | null>(null);
  const [captureState, setCaptureState] = useState<CaptureState>("muted");
  const [lastSttTurnMetrics, setLastSttTurnMetrics] = useState<SttTurnMetrics | null>(null);
  const [audioHealth, setAudioHealth] = useState<AudioHealthState | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [ttsProviderNotice, setTtsProviderNotice] = useState<string | null>(null);
  const [sttProviderNotice, setSttProviderNotice] = useState<string | null>(null);
  const [sttPhase, setSttPhase] = useState<"idle" | "listening" | "transcribing">("idle");
  const [lastSttMeta, setLastSttMeta] = useState<{ provider: SttProvider; elapsedMs: number; bytes: number; fallbackReason?: string } | null>(null);
  const [uiDispatchMs, setUiDispatchMs] = useState<number | null>(null);
  const [progressVisible, setProgressVisible] = useState(false);
  const [queuedTurnPreview, setQueuedTurnPreview] = useState<string | null>(null);
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
    bytesCaptured: number;
    lastDraftUpdateAt: number;
    lastDraftSeconds: number;
    firstSpeechDetectedMs?: number;
  } | null>(null);
  const liveKitTransportRef = useRef<MorticLiveKitTransport | null>(null);
  const recognitionSessionRef = useRef(0);
  const holdingToTalkRef = useRef(false);
  const pushToTalkHeldRef = useRef(false);
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
  const speechPlaybackGenerationRef = useRef(0);
  const mutedSpeechTurnIdRef = useRef<string | null>(null);
  const bargeInCaptureRef = useRef(false);
  const bargeInStateRef = useRef<BargeInState | null>(null);
  const bargeInSequenceRef = useRef(0);
  const bargeInNoSpeechTimerRef = useRef<number | null>(null);
  const pttViewportRestoreRef = useRef<{ x: number; y: number; until: number } | null>(null);
  const ttsRuntimeRef = useRef<RuntimeTtsProvider | null>(null);
  const progressSoundRef = useRef<ProgressSoundHandle | null>(null);
  const progressSpeechGenerationRef = useRef(0);
  const progressSpeechActiveRef = useRef(false);
  const progressSpeechLastAtRef = useRef(0);
  const progressSpeechCountRef = useRef(0);
  const progressSpeechLabelsRef = useRef<Set<string>>(new Set());
  const currentTurnIdRef = useRef<string | null>(null);
  const currentTurnScratchModeRef = useRef<ScratchMode | null>(null);
  const exactSpeechProjectionRef = useRef(false);
  const audioTimingBaseRef = useRef<number | null>(null);
  const audioHealthRef = useRef<AudioHealthState | null>(null);
  const assistantVisibleStartedRef = useRef(false);
  const audioHealthSyncTimerRef = useRef<number | null>(null);
  const audioHealthSyncInFlightRef = useRef(false);
  const audioHealthSyncQueuedRef = useRef(false);
  const prewarmAnnouncementGenerationRef = useRef(0);
  const assistantDraftFinalizingTimerRef = useRef<number | null>(null);
  const [liveAssistantText, setLiveAssistantText] = useState("");
  const [streamingAssistantDraft, setStreamingAssistantDraft] = useState<StreamingAssistantDraft | null>(null);

  const recognitionSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const remoteSttSupported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(audioContextConstructor());
  const activeSttSupported = sttProvider === "browser" ? recognitionSupported : remoteSttSupported;
  const session = state.session;
  const activeTurn = session?.activeTurn;

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

  useEffect(() => {
    return () => clearAssistantDraftFinalizingTimer();
  }, []);

  function elapsedSinceTurnStart(): number | undefined {
    if (audioTimingBaseRef.current === null) return undefined;
    return Math.max(0, Math.round(performance.now() - audioTimingBaseRef.current));
  }

  function resolveAssistantDraftTurnId(turnId?: string): string | null {
    return turnId ?? currentTurnIdRef.current ?? state.session?.activeTurn?.id ?? null;
  }

  function clearAssistantDraftFinalizingTimer(): void {
    if (assistantDraftFinalizingTimerRef.current !== null) {
      window.clearTimeout(assistantDraftFinalizingTimerRef.current);
      assistantDraftFinalizingTimerRef.current = null;
    }
  }

  function scheduleAssistantDraftFinalizing(turnId?: string): void {
    clearAssistantDraftFinalizingTimer();
    const draftTurnId = resolveAssistantDraftTurnId(turnId);
    assistantDraftFinalizingTimerRef.current = window.setTimeout(() => {
      assistantDraftFinalizingTimerRef.current = null;
      setStreamingAssistantDraft((current) => {
        if (!current || current.phase !== "streaming") return current;
        if (draftTurnId && current.turnId && current.turnId !== draftTurnId) return current;
        return { ...current, phase: "finalizing" };
      });
    }, ASSISTANT_DRAFT_FINALIZING_MS);
  }

  function setAssistantDraft(text: string, phase: AssistantDraftPhase, turnId?: string): void {
    if (!text.trim()) return;
    const draftTurnId = resolveAssistantDraftTurnId(turnId);
    setStreamingAssistantDraft({ turnId: draftTurnId, text, phase });
    if (phase === "streaming") {
      scheduleAssistantDraftFinalizing(draftTurnId ?? undefined);
    } else {
      clearAssistantDraftFinalizingTimer();
    }
  }

  function clearAssistantDraft(): void {
    clearAssistantDraftFinalizingTimer();
    setStreamingAssistantDraft(null);
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

    if (pendingRef.current || recognitionRef.current || !isAudioOwnerRef.current) return;
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
        if (!isBufferedTtsProvider(result.spokenBy)) {
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

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const warmup = new SpeechSynthesisUtterance("");
    window.speechSynthesis.speak(warmup);
    window.speechSynthesis.cancel();
  }, []);

	  useEffect(() => {
	    const browserProvider = createBrowserTtsProvider();
	    const deepgramProvider = createDeepgramTtsProvider(api, browserProvider);
	    const elevenLabsWsProvider = createElevenLabsWsTtsProvider(api, browserProvider);
	    ttsRuntimeRef.current =
	      ttsProvider === "inworld-ws"
	        ? createInworldWsTtsProvider(api, elevenLabsWsProvider)
	        : ttsProvider === "deepgram"
	          ? deepgramProvider
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
	    if (ttsProvider !== "deepgram" && ttsProvider !== "elevenlabs") {
	      setTtsProviderNotice(null);
	      return () => {
	        cancelled = true;
	      };
	    }
	
	    const label = ttsProviderLabels[ttsProvider];
	    setTtsProviderNotice(`Checking ${label}`);
	    fetch(`${api}/api/tts/${ttsProvider}/health`)
	      .then(async (response) => {
	        const payload = (await response.json()) as TtsHealthResponse;
	        if (cancelled) return;
	        if (payload.available) {
	          setTtsProviderNotice(`${label} ready ${formatMs(payload.elapsedMs)}`);
	          return;
	        }
	        setTtsProviderNotice(`${label} unavailable, using Browser (${payload.status}${payload.detail ? `: ${payload.detail}` : ""})`);
	      })
	      .catch((error) => {
	        if (cancelled) return;
	        setTtsProviderNotice(`${label} unavailable, using Browser (${error instanceof Error ? error.message : String(error)})`);
	      });

    return () => {
      cancelled = true;
    };
  }, [api, ttsProvider]);

  useEffect(() => {
    if (sttProvider === "deepgram-stt") {
      setSttProviderNotice(
        sttStatus.deepgramConfigured
          ? `Deepgram STT ready${sttStatus.deepgramModel ? ` · ${sttStatus.deepgramModel}` : ""}; Inworld/Whisper fallback active`
          : "Deepgram STT unavailable; set DEEPGRAM_API_KEY or choose Browser"
      );
      return;
    }
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
  }, [
    recognitionSupported,
    sttProvider,
    sttStatus.deepgramConfigured,
    sttStatus.deepgramModel,
    sttStatus.inworldConfigured,
    sttStatus.inworldModel,
    sttStatus.openAIConfigured,
    sttStatus.whisperModel
  ]);

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
    if (!pending) {
      setProgressVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setProgressVisible(true), 1000);
    return () => window.clearTimeout(timer);
  }, [pending, activeTurn?.id]);

  useEffect(() => {
    if (pending || activeTurn?.status === "running" || speakingRef.current || speechQueueRef.current.length > 0) return;
    finishSpeechAfterQueueRef.current = false;
    if (speechPhaseRef.current !== "idle") {
      speechPhaseRef.current = "idle";
      setSpeechPhase("idle");
    }
  }, [pending, activeTurn?.id, activeTurn?.status]);

  useEffect(() => {
    if (!progressSoundsEnabled || !progressVisible || !pending || liveAssistantText.trim()) {
      stopProgressSound();
      return;
    }
    if (progressSoundRef.current) return;

    const audio = new Audio(progressKeyboardLoopUrl);
    audio.dataset.morticAudio = "progress";
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = 0.08;
    const handle: ProgressSoundHandle = { audio };
    const Constructor = audioContextConstructor();

    if (Constructor) {
      try {
        const context = new Constructor();
        const source = context.createMediaElementSource(audio);
        const filter = context.createBiquadFilter();
        const gain = context.createGain();
        filter.type = "lowpass";
        filter.frequency.value = 1800;
        gain.gain.value = 0.14;
        source.connect(filter);
        filter.connect(gain);
        gain.connect(context.destination);
        audio.volume = 1;
        Object.assign(handle, { context, source, filter, gain });
      } catch {
        audio.volume = 0.08;
      }
    }

    progressSoundRef.current = handle;
    void Promise.resolve(handle.context?.state === "suspended" ? handle.context.resume() : undefined)
      .then(() => audio.play())
      .catch(() => {
        stopProgressSound();
      });

    return () => {
      stopProgressSound();
    };
  }, [liveAssistantText, pending, progressSoundsEnabled, progressVisible]);

  useEffect(() => {
    setQueuedTurnPreview(state.session?.queuedTurn?.text ?? null);
  }, [state.session?.queuedTurn?.id, state.session?.queuedTurn?.text, state.session?.queuedTurn?.status]);

  useEffect(() => {
    return () => {
      stopProgressSound();
      resetSpeechPlayback();
    };
  }, []);

  function stopProgressSound(): void {
    const handle = progressSoundRef.current;
    if (!handle) return;
    progressSoundRef.current = null;
    handle.audio.pause();
    handle.audio.currentTime = 0;
    handle.source?.disconnect();
    handle.filter?.disconnect();
    handle.gain?.disconnect();
    if (handle.context && handle.context.state !== "closed") {
      void handle.context.close().catch(() => undefined);
    }
  }

  function progressSpeechText(label: string): string | null {
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

  function resetProgressSpeech(cancelAudio = false): void {
    progressSpeechGenerationRef.current += 1;
    progressSpeechActiveRef.current = false;
    progressSpeechLastAtRef.current = 0;
    progressSpeechCountRef.current = 0;
    progressSpeechLabelsRef.current.clear();
    if (cancelAudio) ttsRuntimeRef.current?.cancel();
  }

  function cancelProgressSpeech(): void {
    if (!progressSpeechActiveRef.current) return;
    resetProgressSpeech(true);
  }

  function speakProgressStatus(payload: Extract<TurnStreamEvent, { type: "status" }>): void {
    if (!isAudioOwnerRef.current || !progressSpeechEnabled || !payload.speakable || payload.scratchMode !== "voice") return;
    if (!pendingRef.current || currentTurnScratchModeRef.current !== "voice") return;
    if (liveAssistantTextRef.current.trim() || speakingRef.current || speechQueueRef.current.length > 0) return;
    if (progressSpeechCountRef.current >= 3) return;

    const text = progressSpeechText(payload.label);
    if (!text || progressSpeechLabelsRef.current.has(text)) return;

    const now = performance.now();
    if (progressSpeechLastAtRef.current && now - progressSpeechLastAtRef.current < 2400) return;

    const provider = ttsRuntimeRef.current;
    if (!provider) return;

    progressSpeechLastAtRef.current = now;
    progressSpeechCountRef.current += 1;
    progressSpeechLabelsRef.current.add(text);
    progressSpeechActiveRef.current = true;
    const generation = progressSpeechGenerationRef.current;
    setSpeechPhase("buffering");

    void provider
      .speak(text, {
        onStart: () => {
          if (progressSpeechGenerationRef.current === generation && progressSpeechActiveRef.current) setSpeechPhase("speaking");
        },
        onAudioPlay: () => {
          if (progressSpeechGenerationRef.current === generation && progressSpeechActiveRef.current) setSpeechPhase("speaking");
        },
        onStatus: (status) => setTtsProviderNotice(status)
      })
      .catch((error) => {
        console.warn("[Mortic] progress speech stopped", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (progressSpeechGenerationRef.current !== generation) return;
        progressSpeechActiveRef.current = false;
        if (!speakingRef.current && speechQueueRef.current.length === 0) setSpeechPhase("idle");
      });
  }

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
    assistantVisibleStartedRef.current = false;
    speechPlaybackGenerationRef.current += 1;
    mutedSpeechTurnIdRef.current = null;
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
    mutedSpeechTurnIdRef.current = null;
    audioTimingBaseRef.current = startedAtMs;
    audioHealthRef.current = null;
    setAudioHealth(null);
    setSpeechPhase("idle");
  }

  function turnStartPerformanceMs(turn: TurnRun): number {
    const createdAtMs = Date.parse(turn.createdAt);
    if (!Number.isFinite(createdAtMs)) return performance.now();
    return performance.now() - Math.max(0, Date.now() - createdAtMs);
  }

  function reattachActiveTurn(turn: TurnRun): void {
    currentTurnScratchModeRef.current = turn.scratchMode;
    setTurnPending(true);
    setSpeechError(null);
    setLiveAssistantText("");
    clearAssistantDraft();
    liveAssistantTextRef.current = "";
    const startedAtMs = turnStartPerformanceMs(turn);
    if (turn.scratchMode === "voice") {
      startAudioHealth(turn.id, startedAtMs);
    } else {
      startTextTurnTracking(turn.id, startedAtMs);
    }
    if (typeof EventSource !== "undefined") {
      streamTurn(turn.id);
    } else {
      void pollTurn(turn.id);
    }
  }

  async function syncAudioHealth(turnId: string) {
    if (audioHealthSyncInFlightRef.current) {
      audioHealthSyncQueuedRef.current = true;
      return;
    }
    const health = audioHealthRef.current;
    if (!health || health.turnId !== turnId) return;

    audioHealthSyncInFlightRef.current = true;
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
          firstClientDeltaMs: health.firstClientDeltaMs,
          firstVisibleTextMs: health.firstVisibleTextMs,
          firstSpeakableTextMs: health.firstSpeakableTextMs,
          firstSpeechQueuedMs: health.firstSpeechQueuedMs,
          firstTtsRequestMs: health.firstTtsRequestMs,
          firstTtsResolvedMs: health.firstTtsResolvedMs,
          firstSpeechStartMs: health.firstSpeechStartMs,
          firstSpeechEndMs: health.firstSpeechEndMs,
          ttsConnectMs: health.ttsConnectMs,
          firstAudioChunkMs: health.firstAudioChunkMs,
          firstAudioPlayMs: health.firstAudioPlayMs,
          audioBufferUnderruns: health.audioBufferUnderruns,
          ttsCloseCode: health.ttsCloseCode,
          ttsCloseReason: health.ttsCloseReason,
          finalTextMs: health.finalTextMs,
          speechAfterFinalMs: health.speechAfterFinalMs,
          bargeInStartedMs: health.bargeInStartedMs,
          bargeInAudioStopMs: health.bargeInAudioStopMs,
          bargeInCaptureStartMs: health.bargeInCaptureStartMs,
          bargeInFirstMicFrameMs: health.bargeInFirstMicFrameMs,
          bargeInFirstSpeechDetectedMs: health.bargeInFirstSpeechDetectedMs,
          bargeInQueuedMs: health.bargeInQueuedMs,
          interruptionLatencyMs: health.interruptionLatencyMs
        })
      });
      const payload = await response.json();
      if (payload.session) {
        setState({ session: payload.session, loading: false, error: response.ok ? null : payload.error ?? "Audio health update failed" });
      }
    } catch (error) {
      console.warn("[Mortic] audio health update failed", error);
    } finally {
      audioHealthSyncInFlightRef.current = false;
      if (audioHealthSyncQueuedRef.current) {
        audioHealthSyncQueuedRef.current = false;
        scheduleAudioHealthSync(turnId);
      }
    }
  }

  function scheduleAudioHealthSync(turnId: string, delayMs = 250): void {
    if (audioHealthSyncTimerRef.current !== null) return;
    audioHealthSyncTimerRef.current = window.setTimeout(() => {
      audioHealthSyncTimerRef.current = null;
      void syncAudioHealth(turnId);
    }, delayMs);
  }

  function updateAudioHealthAndSync(patch: Partial<AudioHealthState>): void {
    const next = updateAudioHealth(patch);
    if (next && currentTurnIdRef.current) scheduleAudioHealthSync(currentTurnIdRef.current);
  }

  function recordFirstAudioTiming<K extends keyof AudioHealthRequest>(key: K): void {
    const patch = firstTimingPatch(key);
    if (patch) updateAudioHealthAndSync(patch);
  }

  function ttsDiagnosticsCallbacks(onStart?: () => void, playbackGeneration = speechPlaybackGenerationRef.current): TtsSpeakCallbacks {
    const active = () => playbackGeneration === speechPlaybackGenerationRef.current && !speechMutedForCurrentTurn();
    return {
      onStart: () => {
        if (active()) onStart?.();
      },
      onConnect: () => {
        if (active()) recordFirstAudioTiming("ttsConnectMs");
      },
      onAudioChunk: () => {
        if (active()) recordFirstAudioTiming("firstAudioChunkMs");
      },
      onAudioPlay: () => {
        if (active()) recordFirstAudioTiming("firstAudioPlayMs");
      },
      onBufferUnderrun: () => {
        if (!active()) return;
        const current = audioHealthRef.current?.audioBufferUnderruns ?? 0;
        updateAudioHealthAndSync({ audioBufferUnderruns: current + 1 });
      },
      onClose: (code, reason) => {
        if (!active()) return;
        updateAudioHealthAndSync({
          ttsCloseCode: code,
          ttsCloseReason: reason
        });
      },
      onStatus: (status) => {
        if (!active()) return;
        updateAudioHealthAndSync({ ttsProviderStatus: status });
      }
    };
  }

  async function speakWithWatchdog(
    provider: RuntimeTtsProvider,
    text: string,
    callbacks: TtsSpeakCallbacks
  ) {
    let timeoutId: number | undefined;
    try {
      return await Promise.race([
        provider.speak(text, callbacks),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            provider.cancel();
            reject(new Error(`TTS chunk did not resolve within ${TTS_CHUNK_WATCHDOG_MS} ms`));
          }, TTS_CHUNK_WATCHDOG_MS);
        })
      ]);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }

  function finishSpeechTurnIfReady(): void {
    if (!finishSpeechAfterQueueRef.current || speakingRef.current || speechQueueRef.current.length > 0) return;
    finishSpeechAfterQueueRef.current = false;
    ttsRuntimeRef.current?.finishTurn?.();
  }

  function clearBargeInNoSpeechTimer(): void {
    if (bargeInNoSpeechTimerRef.current === null) return;
    window.clearTimeout(bargeInNoSpeechTimerRef.current);
    bargeInNoSpeechTimerRef.current = null;
  }

  function scheduleBargeInNoSpeechTimeout(sessionId: number): void {
    clearBargeInNoSpeechTimer();
    bargeInNoSpeechTimerRef.current = window.setTimeout(() => {
      bargeInNoSpeechTimerRef.current = null;
      const capture = audioCaptureRef.current;
      if (!bargeInCaptureRef.current || !capture || capture.sessionId !== sessionId || capture.firstSpeechDetectedMs !== undefined) return;
      bargeInCaptureRef.current = false;
      stopRemoteSttCapture({ submit: false, emptyNotice: false });
      setSttProviderNotice("Audio muted. No speech captured for the next turn.");
    }, 8000);
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

    const playbackGeneration = speechPlaybackGenerationRef.current;
    speakingRef.current = true;
    setSpeechPhase("speaking");
    speechLedgerRef.current = speechLedgerRef.current.map((item) =>
      item.id === next.id ? { ...item, status: "speaking" } : item
    );
    syncAudioLedger();
    try {
      const provider = ttsRuntimeRef.current;
      if (!provider) throw new Error("TTS provider is not ready");
      const ttsRequestPatch = firstTimingPatch("firstTtsRequestMs");
      if (ttsRequestPatch) updateAudioHealthAndSync(ttsRequestPatch);
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
        if (currentTurnIdRef.current) scheduleAudioHealthSync(currentTurnIdRef.current, 120);
      };
      const result = await speakWithWatchdog(provider, next.text, ttsDiagnosticsCallbacks(recordSpeechStart, playbackGeneration));
      if (playbackGeneration !== speechPlaybackGenerationRef.current) return;
      const ttsResolvedPatch = firstTimingPatch("firstTtsResolvedMs");
      if (ttsResolvedPatch) updateAudioHealthAndSync(ttsResolvedPatch);
      if (!isBufferedTtsProvider(result.spokenBy)) recordSpeechStart();
      speechLedgerRef.current = speechLedgerRef.current.map((item) =>
        item.id === next.id ? { ...item, status: "spoken", provider: result.spokenBy } : item
      );
      spokenCharsRef.current = Math.max(spokenCharsRef.current, next.end);
      spokenChunkCountRef.current = speechLedgerRef.current.filter((item) => item.status === "spoken").length;
      const endPatch = isBufferedTtsProvider(result.spokenBy) ? null : firstTimingPatch("firstSpeechEndMs");
      syncAudioLedger(result.spokenBy);
      if (endPatch) updateAudioHealth(endPatch);
      if (endPatch && currentTurnIdRef.current) scheduleAudioHealthSync(currentTurnIdRef.current, 120);
      if (result.fallbackReason) {
        const providerLabel = ttsProviderLabels[ttsProvider];
        const fallbackLabel = ttsProviderLabels[result.spokenBy];
        const message = `${providerLabel} unavailable, using ${fallbackLabel}: ${result.fallbackReason}`;
        setTtsProviderNotice(`${providerLabel} unavailable, using ${fallbackLabel}`);
        updateAudioHealth({ ttsProviderStatus: message });
        if (currentTurnIdRef.current) scheduleAudioHealthSync(currentTurnIdRef.current, 120);
      }
    } catch (error) {
      if (playbackGeneration !== speechPlaybackGenerationRef.current) return;
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
      if (currentTurnIdRef.current) scheduleAudioHealthSync(currentTurnIdRef.current, 120);
    } finally {
      if (playbackGeneration !== speechPlaybackGenerationRef.current) return;
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
    speechPlaybackGenerationRef.current += 1;
    prewarmAnnouncementGenerationRef.current += 1;
    progressSpeechGenerationRef.current += 1;
    progressSpeechActiveRef.current = false;
    speechQueueRef.current = [];
    speakingRef.current = false;
    finishSpeechAfterQueueRef.current = false;
    spokenChunkCountRef.current = 0;
    speechPhaseRef.current = "idle";
    setSpeechPhase("idle");
    ttsRuntimeRef.current?.cancel();
    stopProgressSound();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    for (const media of Array.from(document.querySelectorAll<HTMLMediaElement>('[data-mortic-audio="tts"]'))) {
      media.muted = true;
      media.pause();
      try {
        media.currentTime = 0;
      } catch {
        // Some media streams reject seeking; pausing and clearing the source still stops playback.
      }
      media.removeAttribute("src");
      media.load();
    }
  }

  function speechMutedForCurrentTurn(): boolean {
    return Boolean(currentTurnIdRef.current && mutedSpeechTurnIdRef.current === currentTurnIdRef.current);
  }

  function resetSpeechPlayback() {
    liveAssistantTextRef.current = "";
    resetProgressSpeech(false);
    cancelSpeechAudio();
    cancelAudioCapture();
    clearRecognitionBuffers(false);
    setLiveAssistantText("");
    clearAssistantDraft();
    lastQueuedCharRef.current = 0;
    spokenCharsRef.current = 0;
    speechLedgerRef.current = [];
    currentTurnIdRef.current = null;
    currentTurnScratchModeRef.current = null;
    mutedSpeechTurnIdRef.current = null;
    bargeInCaptureRef.current = false;
    bargeInStateRef.current = null;
    clearBargeInNoSpeechTimer();
    assistantVisibleStartedRef.current = false;
    exactSpeechProjectionRef.current = false;
    audioTimingBaseRef.current = null;
    audioHealthRef.current = null;
    setAudioHealth(null);
    streamRef.current?.close();
    streamRef.current = null;
  }

  function resetQueuedTurn() {
    bargeInCaptureRef.current = false;
    bargeInStateRef.current = null;
    clearBargeInNoSpeechTimer();
  }

  function clearRecognitionBuffers(clearDraft = false) {
    speechBufferRef.current = "";
    interimBufferRef.current = "";
    if (clearDraft) setDraft("");
  }

  function assistantOutputActiveForBargeIn(): boolean {
    return hasAssistantOutputForBargeIn({
      pending: pendingRef.current,
      speechPhase: speechPhaseRef.current,
      speaking: speakingRef.current,
      speechQueueLength: speechQueueRef.current.length,
      progressSpeechActive: progressSpeechActiveRef.current
    });
  }

  function setBargeInPhase(phase: BargeInPhase): void {
    const current = bargeInStateRef.current;
    if (!current) return;
    bargeInStateRef.current = { ...current, phase };
  }

  function patchBargeInAudioHealth(patch: Partial<AudioHealthState>, delayMs = 60): void {
    const turnId = currentTurnIdRef.current ?? state.session?.activeTurn?.id ?? null;
    if (!turnId) return;
    updateAudioHealth(patch);
    scheduleAudioHealthSync(turnId, delayMs);
  }

  function recordBargeInCaptureStart(): void {
    if (!bargeInStateRef.current) return;
    patchBargeInAudioHealth({ bargeInCaptureStartMs: elapsedSinceTurnStart() }, 80);
  }

  function recordBargeInFirstMicFrame(): void {
    const current = bargeInStateRef.current;
    if (!current || current.firstMicFrameAt !== undefined) return;
    bargeInStateRef.current = { ...current, firstMicFrameAt: performance.now() };
    patchBargeInAudioHealth({ bargeInFirstMicFrameMs: elapsedSinceTurnStart() }, 80);
  }

  function recordBargeInFirstSpeechDetected(): void {
    const current = bargeInStateRef.current;
    if (!current || current.firstSpeechDetectedAt !== undefined) return;
    bargeInStateRef.current = { ...current, firstSpeechDetectedAt: performance.now() };
    patchBargeInAudioHealth({ bargeInFirstSpeechDetectedMs: elapsedSinceTurnStart() }, 80);
  }

  function recordBargeInQueued(): void {
    const current = bargeInStateRef.current;
    if (!current) return;
    setBargeInPhase("queued_next_turn");
    patchBargeInAudioHealth({ bargeInQueuedMs: elapsedSinceTurnStart() }, 80);
  }

  function beginLocalBargeIn(source: BargeInSource, captureNextTurn = true): boolean {
    const outputActive = assistantOutputActiveForBargeIn();
    if (!outputActive) return false;
    const activeTurnId = currentTurnIdRef.current ?? state.session?.activeTurn?.id ?? null;
    bargeInSequenceRef.current += 1;
    bargeInStateRef.current = {
      id: bargeInSequenceRef.current,
      source,
      phase: captureNextTurn ? "barge_capture" : "idle",
      startedAt: performance.now(),
      outputTurnId: activeTurnId,
      pendingAtStart: pendingRef.current
    };
    bargeInCaptureRef.current = captureNextTurn;
    if (activeTurnId) {
      mutedSpeechTurnIdRef.current = activeTurnId;
      currentTurnIdRef.current = activeTurnId;
      patchBargeInAudioHealth({
        ttsProviderStatus: "Local audio muted for barge-in",
        bargeInStartedMs: elapsedSinceTurnStart(),
        bargeInAudioStopMs: elapsedSinceTurnStart()
      });
    }
    cancelSpeechAudio();
    setSttProviderNotice(captureNextTurn ? "Audio muted. Listening for next turn." : "Audio muted.");
    return true;
  }

  function interruptSpeechOnly(source: BargeInSource = "push-to-talk", captureNextTurn = true): void {
    resetProgressSpeech(false);
    if (!beginLocalBargeIn(source, captureNextTurn)) cancelSpeechAudio();
  }

  function preservePushToTalkViewport(): void {
    const restore = {
      x: window.scrollX,
      y: window.scrollY,
      until: performance.now() + 1800
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
    bargeInCaptureRef.current = false;
    clearBargeInNoSpeechTimer();
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
    capture.bytesCaptured = 44;
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
    clearBargeInNoSpeechTimer();
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
    bargeInCaptureRef.current = false;
    clearBargeInNoSpeechTimer();
    clearRecognitionBuffers(clearDraft);
    cancelAudioCapture();
    setRecognizing(false);
    recognizingRef.current = false;
    return recognition;
  }

  function recognitionText(): string {
    return `${speechBufferRef.current} ${interimBufferRef.current}`.trim();
  }

  function projectedAssistantSpeechText(text: string): string {
    if (!speechProjectionEnabled) return text;
    return projectSpeech(text, { exact: exactSpeechProjectionRef.current }).speechText;
  }

  function queueAvailableSpeech(assistantText: string, force = false): boolean {
    let queued = false;
    while (lastQueuedCharRef.current < assistantText.length) {
      const start = lastQueuedCharRef.current;
      const end = chooseSpeakableEnd(assistantText, start, force, ttsProvider);
      if (end === null || end <= start) break;
      const speakablePatch = firstTimingPatch("firstSpeakableTextMs");
      if (speakablePatch) updateAudioHealth(speakablePatch);
      enqueueSpeechRange(start, end, assistantText.slice(start, end));
      queued = true;
    }
    return queued;
  }

  function handleAssistantText(
    displayText: string,
    options: { force?: boolean; final?: boolean; turnId?: string; spokenText?: string } = {}
  ) {
    if (!displayText.trim()) return;
    const speechText = projectedAssistantSpeechText(options.spokenText ?? displayText);
    if (!speechText.trim()) {
      setLiveAssistantText(displayText);
      if (!options.final) setAssistantDraft(displayText, "streaming", options.turnId);
      return;
    }
    if (!isAudioOwnerRef.current) {
      liveAssistantTextRef.current = speechText;
      lastQueuedCharRef.current = speechText.length;
      assistantVisibleStartedRef.current = true;
      setLiveAssistantText(displayText);
      if (!options.final) setAssistantDraft(displayText, "streaming", options.turnId);
      if (options.final) exactSpeechProjectionRef.current = false;
      setSpeechPhase("idle");
      return;
    }
    const previousSpeechText = liveAssistantTextRef.current;
    const speechDiverged = Boolean(previousSpeechText && speechText !== previousSpeechText && !speechText.startsWith(previousSpeechText));
    if (speechDiverged) {
      console.warn("[Mortic] assistant text diverged from previously streamed text; stopping audio and keeping screen truth", {
        previousChars: previousSpeechText.length,
        nextChars: speechText.length,
        lastQueuedChar: lastQueuedCharRef.current
      });
      cancelSpeechAudio();
      speechLedgerRef.current = [];
      spokenCharsRef.current = 0;
      lastQueuedCharRef.current = speechText.length;
      setTtsProviderNotice("Answer corrected while streaming. Audio stopped; screen shows the corrected answer.");
      updateAudioHealth({
        ttsProviderStatus: "Assistant speech corrected while streaming; audio stopped before replay."
      });
    }

    liveAssistantTextRef.current = speechText;
    const finalPatch = options.final ? firstTimingPatch("finalTextMs") : null;
    const speechAfterFinalMs =
      finalPatch?.finalTextMs !== undefined && audioHealthRef.current?.firstSpeechStartMs !== undefined
        ? audioHealthRef.current.firstSpeechStartMs - finalPatch.finalTextMs
        : audioHealthRef.current?.speechAfterFinalMs;
    updateAudioHealth({
      ...(finalPatch ?? {}),
      streamedChars: Math.max(audioHealthRef.current?.streamedChars ?? 0, speechText.length),
      finalChars: options.final ? speechText.length : audioHealthRef.current?.finalChars,
      speechAfterFinalMs
    });
    if (speechText.trim() && !speechDiverged) {
      setSpeechPhase(speechMutedForCurrentTurn() ? "idle" : speakingRef.current ? "speaking" : "buffering");
    }

    if (speechMutedForCurrentTurn()) {
      const visiblePatch = displayText.trim() ? firstTimingPatch("firstVisibleTextMs") : null;
      assistantVisibleStartedRef.current = true;
      setLiveAssistantText(displayText);
      if (!options.final) setAssistantDraft(displayText, "streaming", options.turnId);
      if (visiblePatch) updateAudioHealth(visiblePatch);
      syncAudioLedger();
      if (options.turnId) scheduleAudioHealthSync(options.turnId, options.final ? 60 : 250);
      if (options.final) {
        ttsRuntimeRef.current?.finishTurn?.();
        exactSpeechProjectionRef.current = false;
      }
      setSpeechPhase("idle");
      return;
    }

    if (!speechDiverged && (!previousSpeechText || speechText.startsWith(previousSpeechText))) {
      const queued = queueAvailableSpeech(speechText, Boolean(options.force));
      if (assistantVisibleStartedRef.current || queued) {
        const visiblePatch = displayText.trim() ? firstTimingPatch("firstVisibleTextMs") : null;
        assistantVisibleStartedRef.current = true;
        setLiveAssistantText(displayText);
        if (!options.final) setAssistantDraft(displayText, "streaming", options.turnId);
        if (visiblePatch) updateAudioHealth(visiblePatch);
      }
    } else if (speechDiverged) {
      const visiblePatch = displayText.trim() ? firstTimingPatch("firstVisibleTextMs") : null;
      assistantVisibleStartedRef.current = true;
      setLiveAssistantText(displayText);
      if (!options.final) setAssistantDraft(displayText, "streaming", options.turnId);
      if (visiblePatch) updateAudioHealth(visiblePatch);
    }
    syncAudioLedger();
    if (options.turnId) scheduleAudioHealthSync(options.turnId, options.final ? 60 : 250);
    if (options.final) {
      finishSpeechAfterQueueRef.current = true;
      finishSpeechTurnIfReady();
      exactSpeechProjectionRef.current = false;
    }

    if (lastQueuedCharRef.current >= speechText.length && !speakingRef.current && speechQueueRef.current.length === 0) {
      setSpeechPhase("idle");
    }
  }

  function handleTextAssistantText(displayText: string) {
    if (!displayText.trim()) return;
    liveAssistantTextRef.current = displayText;
    assistantVisibleStartedRef.current = true;
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

  function handleDeltaText(rawText: string, mode: ScratchMode = currentTurnScratchModeRef.current ?? "voice", turnId?: string) {
    cancelProgressSpeech();
    if (mode === "text") {
      handleTextAssistantText(rawText);
      return;
    }

    const clientDeltaPatch = firstTimingPatch("firstClientDeltaMs");
    if (clientDeltaPatch) updateAudioHealthAndSync(clientDeltaPatch);
    const spokenText = partialSpokenText(rawText);
    if (!spokenText.trim()) return;
    handleAssistantText(spokenText, { spokenText, turnId });
  }

  function reconcileFinalAssistant(session: MorticSession, turn: TurnRun): boolean {
    const finalEntry = turn.responseEntryId
      ? session.transcript.find((entry) => entry.id === turn.responseEntryId)
      : undefined;
    if (finalEntry) {
      clearAssistantDraft();
      handleFinalAssistantText(finalEntry, turn.id, turn.scratchMode);
      return true;
    }

    if (turn.scratchMode === "voice") {
      const currentLiveText = liveAssistantTextRef.current.trim() ? liveAssistantTextRef.current : liveAssistantText;
      const fallbackText = (turn.error ?? currentLiveText).trim();
      if (fallbackText) {
        setLiveAssistantText(fallbackText);
        setAssistantDraft(fallbackText, "final-pending", turn.id);
      }
    } else {
      const fallbackText = (turn.error ?? liveAssistantTextRef.current).trim();
      if (fallbackText) handleTextAssistantText(fallbackText);
    }
    return false;
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
      if (intent === "push-to-talk-down") {
        event.preventDefault();
        void startPushToTalkCapture();
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
      if (intent === "push-to-talk-up") {
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

  async function sendTurn(text: string, options: { sttMetrics?: SttTurnMetrics } = {}) {
    if (turnsDisabled) return;
    const clean = text.trim();
    if (!clean) return;
    const wasPending = pendingRef.current;
    const turnScratchMode = scratchMode;
    if (bargeInStateRef.current) setBargeInPhase("idle");
    if (needsModelTransitionPreflight(effectiveCodexModel) && (sparkPreflightPending || sparkCompactionPending || !sparkApproved)) {
      setState((current) => ({
        ...current,
        error: `${sparkContext.label}. ${
          sparkContext.compactionRequired ? "Compact then retry before starting this scratch." : "Approve candidate model before starting this scratch."
        }`
      }));
      return;
    }

    if (!wasPending) {
      resetSpeechPlayback();
      exactSpeechProjectionRef.current = shouldUseExactSpeechProjection(clean);
      currentTurnScratchModeRef.current = turnScratchMode;
      setTurnPending(true);
    }
    clearRecognitionBuffers(true);
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
          serviceTier: effectiveServiceTier,
          codexRuntimePolicy: effectiveCodexRuntimePolicy,
          scratchMode: turnScratchMode,
          voiceCaveman: effectiveVoiceCaveman,
          allowModelContextRisk: sparkApproved,
          allowSparkContextRisk: sparkApproved,
          sttMetrics: options.sttMetrics,
          transportProvider,
          inputPolicy,
          clientId,
          surface,
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
      if (payload.queued) {
        recordBargeInQueued();
        setQueuedTurnPreview(payload.queuedTurn?.text ?? clean);
        return;
      }
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
        if (turn?.status === "running") {
          setTurnPending(true);
          currentTurnScratchModeRef.current = turn.scratchMode;
          if (payload.replayText) handleDeltaText(payload.replayText, turn.scratchMode, turn.id);
          return;
        }
        if (!turn) return;
        setTurnPending(false);
        const finalFound = reconcileFinalAssistant(payload.session, turn);
        stream.close();
        streamRef.current = null;
        if (!finalFound && turn.status === "completed") {
          void pollTurn(turn.id, { finalTranscriptRetries: 6 });
        }
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

      if (payload.type === "status") {
        speakProgressStatus(payload);
        return;
      }

      if (payload.type === "voiceActivity") {
        setState((current) => {
          const session = current.session;
          const turn = session?.activeTurn;
          if (!turn || turn.id !== payload.turnId) return current;
          const previousTrace = turn.appServerTrace ?? turn.progressTrace;
          const nextTrace = previousTrace
            ? {
                ...previousTrace,
                firstActivityMs: previousTrace.firstActivityMs ?? payload.activity.elapsedMs,
                activities: previousTrace.activities.some((activity) => activity.id === payload.activity.id)
                  ? previousTrace.activities
                  : [...previousTrace.activities, payload.activity]
              }
            : undefined;
          return {
            ...current,
            session: {
              ...session,
              activeTurn: {
                ...turn,
                appServerTrace: nextTrace,
                progressTrace: nextTrace ?? turn.progressTrace
              }
            }
          };
        });
        return;
      }

      if (payload.type === "delta") {
        handleDeltaText(payload.text, payload.scratchMode, payload.turnId);
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
      const finalFound = reconcileFinalAssistant(payload.session, payload.turn);
      stream.close();
      streamRef.current = null;
      if (!finalFound && payload.type === "completed") {
        void pollTurn(payload.turn.id, { finalTranscriptRetries: 6 });
      }
    };

    stream.onerror = () => {
      stream.close();
      streamRef.current = null;
      void pollTurn(turnId);
    };
  }

  async function pollTurn(turnId: string, options: { finalTranscriptRetries?: number } = {}) {
    try {
      let finalTranscriptRetries = options.finalTranscriptRetries ?? 0;
      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const response = await fetch(`${api}/api/turn/${turnId}`);
        const payload = (await response.json()) as TurnStatusResponse & { error?: string };
        if (!response.ok) {
          setState((current) => ({ ...current, error: payload.error ?? "Could not read turn status" }));
          setTurnPending(false);
          return;
        }

        setState({ session: payload.session, loading: false, error: null });
        const turn = payload.turn as TurnRun | null;

        if (turn?.status === "running") {
          if (payload.replayText) handleDeltaText(payload.replayText, turn.scratchMode, turn.id);
          continue;
        }

        if (!turn) {
          continue;
        }

        setTurnPending(false);
        if (turn.status === "interrupted") {
          resetSpeechPlayback();
          return;
        }
        const finalFound = reconcileFinalAssistant(payload.session, turn);
        if (!finalFound && turn.status === "completed" && finalTranscriptRetries > 0) {
          finalTranscriptRetries -= 1;
          continue;
        }
        return;
      }
    } finally {
      // polling exits through status transitions above
    }
  }

  function interruptTurn() {
    interruptSpeechOnly("interrupt-button", false);
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
    if (bargeInCaptureRef.current) setBargeInPhase("transcribing");
    setSttPhase("transcribing");
    sttPhaseRef.current = "transcribing";
    setCaptureState("finalizing");
    setDraft("");
    setSpeechError(null);
    setSttProviderNotice(`${sttProviderLabels[sttProvider]} transcribing ${recording.segments.length} segment${recording.segments.length === 1 ? "" : "s"} · ${formatBytes(recording.bytes)}`);

    let remoteSttFailures: SttProviderFailure[] = [];
    try {
      const transcribeSegment = async (segment: RemoteSttSegment, index: number): Promise<SttTranscriptionResponse & { error?: string }> => {
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
            prompt: "Codex, Mortic, Deepgram, Nova, Inworld, ElevenLabs, LiveKit, WebRTC, VAD, TTS, STT",
            segmentIndex: index,
            segmentCount: recording.segments.length,
            recordingSessionId: recording.sessionId
          })
        });
        const payload = (await response.json()) as SttTranscriptionResponse & { error?: string };
        // Empty text on a 200 is a valid silent segment, not a failure.
        if (!response.ok || typeof payload.text !== "string") {
          remoteSttFailures = Array.isArray(payload.failures) ? payload.failures : [];
          throw new Error(payload.error ?? "Remote transcription failed");
        }
        return payload;
      };

      const transcribeSegmentWithRetry = async (segment: RemoteSttSegment, index: number): Promise<SttTranscriptionResponse & { error?: string }> => {
        try {
          return await transcribeSegment(segment, index);
        } catch (firstError) {
          try {
            return await transcribeSegment(segment, index);
          } catch (secondError) {
            throw new Error(
              `Segment ${index + 1} failed after retry: ${
                secondError instanceof Error ? secondError.message : firstError instanceof Error ? firstError.message : String(secondError)
              }`
            );
          }
        }
      };

      const payloads =
        recording.segments.length === 1
          ? [await transcribeSegmentWithRetry(recording.segments[0], 0)]
          : (await Promise.allSettled(recording.segments.map((segment, index) => transcribeSegmentWithRetry(segment, index)))).flatMap((result) =>
              result.status === "fulfilled" ? [result.value] : []
            );

      if (payloads.length === 0) {
        throw new Error("Remote transcription failed for every segment");
      }
      if (payloads.length < recording.segments.length) {
        setSttProviderNotice(`${sttProviderLabels[sttProvider]} transcribed ${payloads.length}/${recording.segments.length} segments; missing audio was skipped after retry.`);
      }

      if (!isCurrentRecognitionSession(recognitionSessionRef.current, recording.sessionId)) return;
      let finalPayload: SttTranscriptionResponse | null = null;
      let fallbackReason: string | undefined;
      const texts: string[] = [];
      for (const payload of payloads) {
        if (!isCurrentRecognitionSession(recognitionSessionRef.current, recording.sessionId)) return;
        finalPayload = payload;
        fallbackReason = fallbackReason ?? payload.fallbackReason;
        texts.push(payload.text.trim());
      }
      setDraft(texts.join(" ").replace(/\s+/g, " ").trim());
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
      const attribution = attributeSttFailure(sttProvider, remoteSttFailures, message);
      const providerLabel = (provider: string) => sttProviderLabels[provider as SttProvider] ?? provider;
      if (attribution.switchToBrowser && recognitionSupported) {
        setSttProvider("browser");
        setSpeechError(`${providerLabel(sttProvider)} credits are exhausted. Switched to Browser STT; hold push-to-talk again.`);
        setSttProviderNotice(`Browser STT selected because ${providerLabel(sttProvider)} credits are exhausted`);
      } else if (attribution.creditProvider) {
        // A fallback provider is out of credits, not the requested one:
        // attribute correctly and keep the requested provider selected.
        const requestedDetail = attribution.requestedMessage ?? message;
        setSpeechError(
          `Speech-to-text stopped: ${providerLabel(sttProvider)} failed (${requestedDetail}); fallback ${providerLabel(String(attribution.creditProvider))} is out of credits.`
        );
        setSttProviderNotice(`${providerLabel(sttProvider)} failed; retry, use Browser, or type the turn`);
      } else {
        setSpeechError(`Speech-to-text stopped: ${message}`);
        setSttProviderNotice(`${providerLabel(sttProvider)} failed; use Browser or type the turn`);
      }
    } finally {
      bargeInCaptureRef.current = false;
      clearBargeInNoSpeechTimer();
      setRecognizing(false);
      recognizingRef.current = false;
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
    }
  }

  async function startRemoteSttCapture() {
    if (!navigator.mediaDevices?.getUserMedia || recognizing) {
      if (!navigator.mediaDevices?.getUserMedia) {
        bargeInCaptureRef.current = false;
        setSpeechError("Microphone capture is unavailable in this browser. Use Browser STT or the text box.");
      }
      return;
    }

    const keepBargeInCapture = bargeInCaptureRef.current;
    const sessionId = recognitionSessionRef.current + 1;
    recognitionSessionRef.current = sessionId;
    clearRecognitionBuffers(true);
    cancelAudioCapture();
    bargeInCaptureRef.current = keepBargeInCapture;
    setSpeechError(null);
    setLastSttMeta(null);
    setLastSttTurnMetrics(null);

    try {
      if (transportProvider === "livekit-webrtc") {
        void liveKitTransportRef.current?.setMuted(false).catch((error) => {
          setTransportNotice(error instanceof Error ? error.message : String(error));
        });
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
        if (bargeInCaptureRef.current) recordBargeInFirstMicFrame();
        const input = new Float32Array(event.inputBuffer.getChannelData(0));
        const capture = audioCaptureRef.current;
        capture.chunks.push(input);
        capture.bytesCaptured += input.length * 2;
        let sumSquares = 0;
        for (let index = 0; index < input.length; index += 1) sumSquares += input[index] * input[index];
        const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
        const now = performance.now();
        if (rms > 0.018) {
          lastSpeechAt = now;
          if (bargeInCaptureRef.current) clearBargeInNoSpeechTimer();
          if (capture.firstSpeechDetectedMs === undefined) {
            capture.firstSpeechDetectedMs = Math.round(now - capture.sessionStartedAt);
            if (bargeInCaptureRef.current) recordBargeInFirstSpeechDetected();
            if (liveModeActiveRef.current && assistantOutputActiveForBargeIn()) {
              interruptSpeechOnly("live-vad");
            }
          }
        }
        const seconds = (now - capture.sessionStartedAt) / 1000;
        const segmentMs = now - capture.segmentStartedAt;
        const segmentBytesEstimate = capture.bytesCaptured;
        if (segmentMs >= HARD_STT_SEGMENT_MS || segmentBytesEstimate >= MAX_LOCAL_SEGMENT_BYTES) {
          rolloverAudioSegment(sessionId, true);
        } else if (segmentMs >= SOFT_STT_SEGMENT_MS && now - lastSpeechAt > 450) {
          rolloverAudioSegment(sessionId, false);
        }
        const draftSeconds = Math.floor(seconds * 4) / 4;
        if (now - capture.lastDraftUpdateAt >= 250 || draftSeconds !== capture.lastDraftSeconds) {
          capture.lastDraftUpdateAt = now;
          capture.lastDraftSeconds = draftSeconds;
          setDraft(liveModeActiveRef.current ? `Live listening... ${seconds.toFixed(1)} s` : `Listening... ${seconds.toFixed(1)} s`);
        }
        if (
          (liveModeActiveRef.current || (bargeInCaptureRef.current && bargeInStateRef.current?.source !== "push-to-talk")) &&
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
        segments: [],
        bytesCaptured: 44,
        lastDraftUpdateAt: 0,
        lastDraftSeconds: -1
      };
      recognizingRef.current = true;
      sttPhaseRef.current = "listening";
      setRecognizing(true);
      setSttPhase("listening");
      setCaptureState("capturing");
      setSttProviderNotice(`${sttProviderLabels[sttProvider]} listening`);
      if (bargeInCaptureRef.current) recordBargeInCaptureStart();
      if (bargeInCaptureRef.current) scheduleBargeInNoSpeechTimeout(sessionId);
    } catch (error) {
      bargeInCaptureRef.current = false;
      clearBargeInNoSpeechTimer();
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
    clearBargeInNoSpeechTimer();
    recognizingRef.current = false;
    setRecognizing(false);
    if (transportProvider === "livekit-webrtc") {
      void liveKitTransportRef.current?.setMuted(true);
    }
    if (!submit) {
      bargeInCaptureRef.current = false;
      recognitionSessionRef.current += 1;
      clearRecognitionBuffers(true);
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
      setDraft("");
      return;
    }
    if (!recording || !shouldSubmitCapturedTurn({ submitRequested: submit, speechDetected: recording.firstSpeechDetectedMs !== undefined, transcriptText: "remote audio" })) {
      bargeInCaptureRef.current = false;
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
      bargeInCaptureRef.current = false;
      setSttPhase("idle");
      sttPhaseRef.current = "idle";
      setCaptureState("muted");
      setDraft("");
      setSpeechError("I did not capture any audio. Try again or use the text box.");
      return;
    }
    bargeInCaptureRef.current = false;
    void transcribeRemoteAudio({ ...recording, sessionId });
  }

  function startRecognition() {
    if (!bargeInCaptureRef.current && assistantOutputActiveForBargeIn()) {
      interruptSpeechOnly();
    }
    if (sttProvider !== "browser") {
      void startRemoteSttCapture();
      return;
    }
    if (!recognitionSupported || recognizing) return;
    const sessionId = recognitionSessionRef.current + 1;
    recognitionSessionRef.current = sessionId;
    holdingToTalkRef.current = liveModeActiveRef.current || pushToTalkHeldRef.current;
    stopRequestedRef.current = false;
    discardSpeechOnEndRef.current = false;
    clearRecognitionBuffers(true);
    startRecognitionEngine(sessionId);
  }

  function startRecognitionEngine(sessionId: number) {
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = !bargeInCaptureRef.current;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      if (!isCurrentRecognitionSession(recognitionSessionRef.current, sessionId) || recognitionRef.current !== recognition) return;
      interimBufferRef.current = "";
      let heardSpeech = false;
      for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (transcript.trim()) heardSpeech = true;
        if (result.isFinal) {
          speechBufferRef.current = `${speechBufferRef.current} ${transcript}`.trim();
        } else {
          interimBufferRef.current = `${interimBufferRef.current} ${transcript}`.trim();
        }
      }
      if (bargeInCaptureRef.current && heardSpeech) recordBargeInFirstSpeechDetected();
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
      bargeInCaptureRef.current = false;
      clearRecognitionBuffers(true);
      if (shouldSubmitCapturedTurn({ submitRequested: !shouldDiscard, speechDetected: Boolean(text), transcriptText: text })) {
        void sendTurn(text);
      }
    };

    recognitionRef.current = recognition;
    setRecognizing(true);
    try {
      recognition.start();
      if (bargeInCaptureRef.current) recordBargeInCaptureStart();
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
      pushToTalkHeldRef.current = false;
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

  async function startPushToTalkCapture() {
    preservePushToTalkViewport();
    if (turnsDisabled) return;
    if (!isAudioOwnerRef.current && !(await requestAudioOwnership())) {
      setSpeechError("Mortic could not move microphone control to this window.");
      return;
    }
    if (bargeInCaptureRef.current && (recognizingRef.current || sttPhaseRef.current === "listening")) {
      stopRecognition({ submit: true, emptyNotice: false });
      return;
    }
    beginLocalBargeIn("push-to-talk");
    if (liveModeActiveRef.current || recognizingRef.current || sttPhaseRef.current === "transcribing") return;
    pushToTalkHeldRef.current = true;
    setInputPolicy("push_to_talk");
    startRecognition();
  }

  function stopPushToTalkCapture() {
    preservePushToTalkViewport();
    pushToTalkHeldRef.current = false;
    if (liveModeActiveRef.current) return;
    if (bargeInCaptureRef.current) return;
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
        void requestAudioOwnership().then((owned) => {
          if (owned) startRecognition();
        });
      }
    }, speechPhase === "speaking" || speechPhase === "buffering" ? 0 : 250);
    return () => window.clearTimeout(timer);
  }, [activeSttSupported, liveModeActive, pending, recognizing, speechPhase, sparkBlocked, sttPhase, sttProvider, transportProvider]);

  return {
    activeSttSupported,
    recognizing,
    recognizingRef,
    liveModeActiveRef,
    speechError,
    setSpeechError,
    speechPhase,
    sttPhase,
    sttProviderNotice,
    ttsProviderNotice,
    transportState,
    transportNotice,
    audioHealth,
    uiDispatchMs,
    progressVisible,
    queuedTurnPreview,
    liveAssistantText,
    streamingAssistantDraft,
    announcePrewarmConfirmation,
    reattachActiveTurn,
    resetSpeechPlayback,
    resetQueuedTurn,
    sendTurn,
    interruptTurn,
    setLiveActive,
    startPushToTalkCapture,
    stopPushToTalkCapture
  };
}
