import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import {
  scratchModes,
  sttProviders,
  transportProviders,
  ttsProviders,
  type AudioLeaseState,
  type ClientSurface,
  type CodexAccessPreset,
  type CodexRuntimePolicy,
  type AgentState,
  type InputPolicy,
  type LiveKitStatus,
  type MorticSession,
  type MorticPreferences,
  type MorticPreferencesPatch,
  type OnboardingStatusResponse,
  type PrewarmResponse,
  type AppServerActivity,
  type AppServerConfigMetadata,
  type AppServerModelOption,
  type AppServerTrace,
  type ProgressSpeechTrace,
  type ReasoningEffort,
  type ScratchMode,
  type SessionSourceIdentity,
  type SessionSnapshot,
  type SessionStreamEvent,
  type SparkContextCompactResponse,
  type SparkContextPreflight,
  type SparkContextPreflightResponse,
  type SttProvider,
  type SttStatus,
  type TransportProvider,
  type TtsProvider,
  type TtsStatus
} from "../shared/types.js";
import { redactThreadId } from "../shared/threadUri.js";
import { modelProfile } from "../shared/modelProfiles.js";
import { MarkdownContent } from "./components/Markdown.js";
import { ClipboardFallbackDialog, ConfirmDialog, HandoffReviewModal, TranscriptDrawer } from "./components/SessionModals.js";
import { HandoffPanel } from "./components/HandoffPanel.js";
import { ThreadPicker } from "./components/ThreadPicker.js";
import { apiBase, readStoredCodexAccess, readStoredEffort, readStoredModel, readStoredScratchMode, readStoredServiceTier, readStoredSttProvider, readStoredTransportProvider, readStoredTtsProvider, readStoredVoiceCaveman } from "./lib/api.js";
import { ApiState, PrewarmState } from "./lib/clientTypes.js";
import { desktopBridge, type MorticDesktopState } from "./desktopBridge.js";
import { formatMs, formatSignedMs } from "./lib/format.js";
import { effortLabels, entryMainText, entryNotesLabel, modeLabels, sttProviderLabels, transportLabels, ttsProviderLabels } from "./lib/labels.js";
import { clientUnknownSparkPreflight, needsModelTransitionPreflight, sparkPreflightLabel } from "./lib/spark.js";
import { useVoiceEngine } from "./voice/useVoiceEngine.js";

const PLACEHOLDER_THREAD_ID = "00000000-0000-0000-0000-000000000000";

function workspaceTitle(workspacePath: string | undefined): string | null {
  if (!workspacePath) return null;
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const title = normalized.split("/").filter(Boolean).at(-1);
  return title || null;
}

function isPlaceholderSession(session: MorticSession | null | undefined): boolean {
  return session?.threadId === PLACEHOLDER_THREAD_ID;
}

function deriveInteractionState(input: {
  threadRequired: boolean;
  codexUnavailable: boolean;
  recognizing: boolean;
  sttPhase: "idle" | "listening" | "transcribing";
  pending: boolean;
  speechPhase: "idle" | "buffering" | "speaking";
  agentState: AgentState;
}): "Select thread" | "Ready" | "Listening" | "Thinking" | "Speaking" | "Codex offline" | "Error" {
  if (input.threadRequired) return "Select thread";
  if (input.codexUnavailable) return "Codex offline";
  if (input.agentState === "error") return "Error";
  if (input.recognizing || input.sttPhase === "listening" || input.sttPhase === "transcribing") return "Listening";
  if (input.speechPhase === "speaking" || input.speechPhase === "buffering") return "Speaking";
  if (input.pending || input.agentState === "thinking" || input.agentState === "warming" || input.agentState === "transcribing") return "Thinking";
  return "Ready";
}

function rendererClientId(): string {
  const key = "mortic.rendererClientId";
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

function DesktopIcon({ name }: { name: "app" | "collapse" | "hide" }) {
  const common = {
    "aria-hidden": true,
    focusable: false,
    viewBox: "0 0 24 24"
  } as const;
  if (name === "app") {
    return (
      <svg className="desktop-icon" {...common}>
        <path d="M8 4h12v12" />
        <path d="M20 4 9 15" />
        <path d="M5 8v11h11" />
      </svg>
    );
  }
  if (name === "collapse") {
    return (
      <svg className="desktop-icon" {...common}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    );
  }
  return (
    <svg className="desktop-icon" {...common}>
      <path d="M5 12h14" />
    </svg>
  );
}

function providerAvailabilityHint(provider: SttProvider | TtsProvider | TransportProvider, status: {
  availableProviders?: string[];
  availableTransports?: string[];
  deepgramConfigured?: boolean;
  inworldConfigured?: boolean;
  openAIConfigured?: boolean;
  elevenLabsConfigured?: boolean;
  configured?: boolean;
}): string {
  const available = status.availableProviders ?? status.availableTransports ?? [];
  if (available.includes(provider)) return "Available";
  switch (provider) {
    case "deepgram":
    case "deepgram-stt":
      return status.deepgramConfigured === false ? "Missing Deepgram API key" : "Not available from server";
    case "inworld-ws":
    case "inworld-stt":
      return status.inworldConfigured === false ? "Missing Inworld API key/config" : "Not available from server";
    case "elevenlabs":
    case "elevenlabs-ws":
      return status.elevenLabsConfigured === false ? "Missing ElevenLabs API key or voice" : "Not available from server";
    case "whisper":
      return status.openAIConfigured === false ? "Missing OpenAI API key" : "Not available from server";
    case "livekit-webrtc":
      return status.configured === false ? "Missing LiveKit config" : "Not available from server";
    default:
      return "Not available from server";
  }
}

function configModelLabel(model: AppServerModelOption | undefined, fallback: string): string {
  return model?.displayName || fallback;
}

function defaultAccessPreset(config: AppServerConfigMetadata | null): CodexAccessPreset {
  if (config?.sandboxPolicy.type === "dangerFullAccess") return "full";
  const value = config?.approvalPolicy.value;
  if (value === "on-request") return "ask";
  return "approve";
}

const accessPresetLabels: Record<CodexAccessPreset, { label: string; detail: string; warning?: string }> = {
  ask: {
    label: "Ask for approval",
    detail: "Always ask to edit files or use the internet."
  },
  approve: {
    label: "Approve for me",
    detail: "Only ask for actions detected as potentially unsafe."
  },
  full: {
    label: "Full access",
    detail: "Unrestricted access to the internet and files on this computer.",
    warning: "Full access disables the sandbox for Codex turns."
  }
};

function runtimePolicyForPreset(preset: CodexAccessPreset): CodexRuntimePolicy {
  if (preset === "ask") return { filesystem: "workspaceWrite", networkAccess: true, approvalPolicy: "on-request" };
  if (preset === "full") return { filesystem: "dangerFullAccess", networkAccess: true, approvalPolicy: "never" };
  return { filesystem: "workspaceWrite", networkAccess: true, approvalPolicy: "on-failure" };
}

type LatentTraceLine = {
  key: string;
  elapsedMs: number;
  kind: string;
  text: string;
};

function codexLatentTraceLines(trace: AppServerTrace | ProgressSpeechTrace | undefined): LatentTraceLine[] {
  if (!trace) return [];
  const lines: LatentTraceLine[] = [];

  (trace.activities ?? []).forEach((event, index) => {
    const parts = [event.label, event.detail, event.itemType].filter(Boolean);
    lines.push({
      key: `activity-${index}`,
      elapsedMs: event.elapsedMs,
      kind: event.display ? "activity" : "hidden",
      text: parts.join(" · ")
    });
  });

  trace.rawNotifications.forEach((event, index) => {
    const parts = [event.method, event.itemType, event.detail].filter(Boolean);
    lines.push({
      key: `raw-${index}`,
      elapsedMs: event.elapsedMs,
      kind: "raw",
      text: parts.join(" · ")
    });
  });

  trace.mappedEvents.forEach((event, index) => {
    const parts = [event.label, event.itemType, event.detail].filter(Boolean);
    lines.push({
      key: `mapped-${index}`,
      elapsedMs: event.elapsedMs,
      kind: "mapped",
      text: parts.join(" · ")
    });
  });

  trace.decisions.forEach((event, index) => {
    const parts = [
      event.label,
      event.decision,
      event.reason ? `reason: ${event.reason}` : undefined
    ].filter(Boolean);
    lines.push({
      key: `decision-${index}`,
      elapsedMs: event.elapsedMs,
      kind: "decision",
      text: parts.join(" · ")
    });
  });

  if (trace.firstAssistantDeltaMs !== undefined) {
    lines.push({
      key: "first-delta",
      elapsedMs: trace.firstAssistantDeltaMs,
      kind: "delta",
      text: "first assistant delta"
    });
  }

  return lines
    .sort((left, right) => left.elapsedMs - right.elapsedMs || left.key.localeCompare(right.key))
    .slice(-32);
}

function visibleVoiceActivities(trace: AppServerTrace | ProgressSpeechTrace | undefined): AppServerActivity[] {
  return (trace?.activities ?? [])
    .filter((activity) => activity.display)
    .sort((left, right) => left.elapsedMs - right.elapsedMs)
    .slice(-6);
}

function CodexWorkingBuffer({ trace, pending, hasAssistantText }: {
  trace: AppServerTrace | ProgressSpeechTrace | undefined;
  pending: boolean;
  hasAssistantText: boolean;
}) {
  if (!pending || hasAssistantText) return null;
  const activities = visibleVoiceActivities(trace);
  const latest = activities.at(-1);
  return (
    <section className="codex-working-buffer" aria-label="Codex working activity">
      <div>
        <span>Working</span>
        <strong>{latest ? latest.label : "Starting"}</strong>
      </div>
      {latest?.detail ? <p>{latest.detail}</p> : <p>Waiting for Codex activity.</p>}
      {activities.length > 1 && (
        <details>
          <summary>{activities.length} activity updates</summary>
          <ol>
            {activities.map((activity) => (
              <li key={activity.id}>
                <time>{formatMs(activity.elapsedMs)}</time>
                <span>{activity.label}</span>
                {activity.detail ? <em>{activity.detail}</em> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function CodexLatentTraceBubble({ trace, pending }: { trace: AppServerTrace | ProgressSpeechTrace | undefined; pending: boolean }) {
  const lines = codexLatentTraceLines(trace);
  if (!trace && !pending) return null;

  const summary =
    lines.length > 0
      ? `${lines.length} event${lines.length === 1 ? "" : "s"}`
      : trace
        ? "Waiting"
        : "Trace off";

  return (
    <details className="latent-trace-bubble">
      <summary>
        <span>Codex debug trace</span>
        <strong>{summary}</strong>
      </summary>
      <div className="latent-trace-body">
        {!trace ? (
          <p>Progress trace is not enabled for this server run.</p>
        ) : lines.length === 0 ? (
          <p>No Codex lifecycle events yet.</p>
        ) : (
          <ol>
            {lines.map((line) => (
              <li key={line.key}>
                <time>{formatMs(line.elapsedMs)}</time>
                <em>{line.kind}</em>
                <span>{line.text}</span>
              </li>
            ))}
          </ol>
        )}
        {trace?.spokenStatuses.length ? (
          <div className="latent-trace-spoken">
            <span>status text</span>
            <p>{trace.spokenStatuses.join(" · ")}</p>
          </div>
        ) : null}
        {trace?.verdict && (
          <div className={`latent-trace-verdict latent-trace-${trace.verdict}`}>
            <span>{trace.verdict}</span>
            <p>{trace.reasons?.join(" · ") || "No verdict detail."}</p>
          </div>
        )}
      </div>
    </details>
  );
}

export function App() {
  const api = useMemo(apiBase, []);
  const surface = useMemo(() => new URLSearchParams(window.location.search).get("surface"), []);
  const isDesktopOverlay = surface === "overlay";
  const clientSurface: ClientSurface = isDesktopOverlay ? "overlay" : desktopBridge() ? "app" : "browser";
  const clientId = useMemo(rendererClientId, []);
  const latestSessionRevisionRef = useRef(-1);
  const preferencePatchRef = useRef("");
  const draftPatchRef = useRef("");
  const [desktopState, setDesktopState] = useState<MorticDesktopState | null>(null);
  const [state, setState] = useState<ApiState>({ session: null, loading: true, error: null });
  const [sourceIdentity, setSourceIdentity] = useState<SessionSourceIdentity | null>(null);
  const [serverPreferences, setServerPreferences] = useState<MorticPreferences | null>(null);
  const [audioLease, setAudioLease] = useState<AudioLeaseState>({ phase: "idle", epoch: 0 });
  const [onboarding, setOnboarding] = useState<OnboardingStatusResponse | null>(null);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [scratchMode, setScratchMode] = useState<ScratchMode>("voice");
  const [voiceCaveman, setVoiceCaveman] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("none");
  const [codexModel, setCodexModel] = useState("default");
  const [serviceTier, setServiceTier] = useState<string | null>(null);
  const [appServerConfig, setAppServerConfig] = useState<AppServerConfigMetadata | null>(null);
  const [codexAccessPreset, setCodexAccessPreset] = useState<CodexAccessPreset>("approve");
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
  const [copiedHandoff, setCopiedHandoff] = useState<"short" | "full" | null>(null);
  const [clipboardFallback, setClipboardFallback] = useState("");
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [finderOpenRequest, setFinderOpenRequest] = useState(0);
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false);
  const [handoffReviewOpen, setHandoffReviewOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState("");
  const [sourcePending, setSourcePending] = useState(false);
  const [prewarm, setPrewarm] = useState<PrewarmState>({ status: "idle" });
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({
    defaultProvider: "browser",
    availableProviders: ["browser"],
    inworldConfigured: false,
    deepgramConfigured: false,
    elevenLabsConfigured: false
  });
  const [speechProjectionEnabled, setSpeechProjectionEnabled] = useState(true);
  const [progressSoundsEnabled, setProgressSoundsEnabled] = useState(false);
  const [progressSpeechEnabled, setProgressSpeechEnabled] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("browser");
  const [sttStatus, setSttStatus] = useState<SttStatus>({
    defaultProvider: "browser",
    availableProviders: ["browser"],
    deepgramConfigured: false,
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
  const [inputPolicy, setInputPolicy] = useState<InputPolicy>("push_to_talk");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const [liveModeActive, setLiveModeActive] = useState(false);
  const prewarmKeyRef = useRef("");
  const prewarmAnnouncementKeyRef = useRef("");

  useEffect(() => {
    if (!isDesktopOverlay) return;
    const bridge = desktopBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.getDesktopState().then((next) => {
      if (!cancelled) setDesktopState(next);
    });
    const unsubscribe = bridge.onDesktopState?.((next) => setDesktopState(next));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isDesktopOverlay]);

  function setDesktopOverlayExpanded(expanded: boolean): void {
    setDesktopState((current) => current ? { ...current, expanded } : current);
    void desktopBridge()?.setOverlayExpanded(expanded).then(setDesktopState);
  }

  const effectiveCodexModel = codexModel;
  const selectedModelOption = useMemo(
    () => appServerConfig?.models.find((model) => model.model === effectiveCodexModel || model.id === effectiveCodexModel),
    [appServerConfig, effectiveCodexModel]
  );
  const discoveredReasoningOptions = useMemo(
    () =>
      selectedModelOption?.supportedReasoningEfforts.length
        ? selectedModelOption.supportedReasoningEfforts
        : [{ reasoningEffort: selectedModelOption?.defaultReasoningEffort ?? appServerConfig?.selectedReasoningEffort ?? reasoningEffort }],
    [appServerConfig?.selectedReasoningEffort, reasoningEffort, selectedModelOption]
  );
  const discoveredReasoningValues = useMemo(
    () => discoveredReasoningOptions.map((option) => option.reasoningEffort),
    [discoveredReasoningOptions]
  );
  const effectiveReasoningEffort = discoveredReasoningValues.includes(reasoningEffort)
    ? reasoningEffort
    : selectedModelOption?.defaultReasoningEffort ?? appServerConfig?.selectedReasoningEffort ?? reasoningEffort;
  const selectedServiceTierOption = selectedModelOption?.serviceTiers.find((tier) => tier.id === serviceTier);
  const effectiveServiceTier =
    serviceTier && selectedModelOption?.serviceTiers.some((tier) => tier.id === serviceTier) ? serviceTier : null;
  const effectiveCodexRuntimePolicy: CodexRuntimePolicy = useMemo(
    () => runtimePolicyForPreset(codexAccessPreset),
    [codexAccessPreset]
  );
  const effectiveVoiceCaveman = scratchMode === "voice" && voiceCaveman;
  const session = state.session;
  const sessionRef = useRef<MorticSession | null>(null);
  const threadRequired = isPlaceholderSession(session);
  const codexUnavailable = !session?.codex.available;
  const transcript = session?.transcript ?? [];
  const activeTurn = session?.activeTurn;
  const activeAppServerTrace = activeTurn?.appServerTrace ?? activeTurn?.progressTrace;
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
  const isAudioOwner = audioLease.ownerClientId === clientId;

  async function requestAudioOwnership(): Promise<boolean> {
    if (isAudioOwner) return true;
    try {
      const response = await fetch(`${api}/api/session/audio-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, surface: clientSurface, command: "barge-in" })
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { audioLease: AudioLeaseState };
      setAudioLease(payload.audioLease);
      return payload.audioLease.ownerClientId === clientId;
    } catch {
      return false;
    }
  }

  const {
    activeSttSupported,
    recognizing,
    recognizingRef,
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
    interruptTurn: interruptLocalAudio,
    startPushToTalkCapture,
    stopPushToTalkCapture
  } = useVoiceEngine({
    api,
    clientId,
    surface: clientSurface,
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
    setPrewarm,
    prewarmKeyRef,
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
    turnsDisabled: threadRequired || codexUnavailable
  });

  async function interruptTurn(): Promise<void> {
    interruptLocalAudio();
    try {
      const response = await fetch(`${api}/api/session/audio-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, surface: clientSurface, command: "interrupt" })
      });
      if (response.ok) setAudioLease(((await response.json()) as { audioLease: AudioLeaseState }).audioLease);
    } catch {
      // Local audio has already stopped; shared recovery happens on the next heartbeat.
    }
  }

  async function cancelQueuedTurn(): Promise<void> {
    try {
      const response = await fetch(`${api}/api/session/queued-turn`, { method: "DELETE" });
      if (!response.ok) return;
      const snapshot = (await response.json()) as SessionSnapshot;
      setState({ session: snapshot.session, loading: false, error: null });
    } catch {
      // Queue state is server-owned; next session snapshot will reconcile.
    }
  }

  async function hideDesktopOverlay(): Promise<void> {
    interruptLocalAudio();
    await desktopBridge()?.hideOverlay();
  }

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    const audioPhase = recognizing
      ? "listening"
      : sttPhase === "transcribing"
        ? "transcribing"
        : speechPhase === "speaking"
          ? "speaking"
          : speechPhase === "buffering"
            ? "buffering"
            : "idle";
    const publish = async () => {
      try {
        const response = await fetch(`${api}/api/session/presence`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId,
            surface: clientSurface,
            focused: document.hasFocus(),
            visible: document.visibilityState === "visible",
            audioPhase
          })
        });
        if (response.ok) setAudioLease(((await response.json()) as { audioLease: AudioLeaseState }).audioLease);
      } catch {
        // Session SSE and heartbeat expiry recover ownership after reconnect.
      }
    };
    void publish();
    const heartbeat = window.setInterval(publish, 5_000);
    window.addEventListener("focus", publish);
    window.addEventListener("blur", publish);
    document.addEventListener("visibilitychange", publish);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", publish);
      window.removeEventListener("blur", publish);
      document.removeEventListener("visibilitychange", publish);
    };
  }, [api, clientId, clientSurface, recognizing, speechPhase, sttPhase]);

  useEffect(() => {
    const release = () => {
      void fetch(`${api}/api/session/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          surface: clientSurface,
          focused: false,
          visible: false,
          audioPhase: "idle"
        }),
        keepalive: true
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    window.addEventListener("beforeunload", release);
    return () => {
      window.removeEventListener("pagehide", release);
      window.removeEventListener("beforeunload", release);
    };
  }, [api, clientId, clientSurface]);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onAudioCancel) return;
    return bridge.onAudioCancel(() => {
      interruptLocalAudio();
      resetQueuedTurn();
      void fetch(`${api}/api/session/audio-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, surface: clientSurface, command: "hide" })
      });
    });
  }, [api, clientId, clientSurface, interruptLocalAudio, resetQueuedTurn]);

  async function refreshOnboarding(): Promise<void> {
    setOnboardingBusy(true);
    try {
      const response = await fetch(`${api}/api/onboarding`);
      if (response.ok) {
        setOnboarding((await response.json()) as OnboardingStatusResponse);
      }
    } catch {
      // Server unreachable is already surfaced by the session load error path.
    } finally {
      setOnboardingBusy(false);
    }
  }

  useEffect(() => {
    void refreshOnboarding();
  }, [api]);

  function setTurnPending(nextPending: boolean) {
    pendingRef.current = nextPending;
    setPending(nextPending);
  }

  function legacyPreferences(payload: SessionSnapshot): MorticPreferences {
    const config = payload.appServerConfig;
    const defaultModel = config?.selectedModel ?? config?.defaultModel ?? payload.defaultCodexModel;
    const storedModel = readStoredModel(defaultModel);
    const model = config?.models.some((item) => item.model === storedModel || item.id === storedModel) ? storedModel : defaultModel;
    const modelOption = config?.models.find((item) => item.model === model || item.id === model);
    const defaultEffort = modelOption?.defaultReasoningEffort ?? config?.selectedReasoningEffort ?? payload.defaultReasoningEffort;
    const effort = readStoredEffort(defaultEffort);
    return {
      initialized: true,
      codexModel: model,
      reasoningEffort: modelOption?.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort) ? effort : defaultEffort,
      serviceTier: readStoredServiceTier(modelOption?.defaultServiceTier ?? config?.selectedServiceTier ?? null),
      codexAccessPreset: readStoredCodexAccess(defaultAccessPreset(config ?? null)),
      scratchMode: readStoredScratchMode((payload.defaultScratchMode ?? "voice") as ScratchMode),
      shortSpokenReplies: readStoredVoiceCaveman(),
      transportProvider: readStoredTransportProvider(payload.livekit?.defaultTransport ?? "local-browser", payload.livekit?.availableTransports ?? ["local-browser"]),
      sttProvider: readStoredSttProvider(payload.stt.defaultProvider, payload.stt.availableProviders),
      ttsProvider: readStoredTtsProvider(payload.tts.defaultProvider, payload.tts.availableProviders),
      overlayHintDismissed: false
    };
  }

  function applySessionSnapshot(payload: SessionSnapshot): void {
    if (payload.revision <= latestSessionRevisionRef.current) return;
    latestSessionRevisionRef.current = payload.revision;
    const previous = sessionRef.current;
    const switchedThread = Boolean(previous && previous.threadId !== payload.session.threadId);
    const externallyCleared = Boolean(previous && previous.transcript.length > 0 && payload.session.transcript.length === 0);
    if (switchedThread || externallyCleared) {
      resetSpeechPlayback();
      resetQueuedTurn();
      prewarmKeyRef.current = "";
      prewarmAnnouncementKeyRef.current = "";
      setPrewarm({ status: "idle" });
    }

    const preferences = payload.preferences.initialized ? payload.preferences : legacyPreferences(payload);
    setServerPreferences(preferences);
    setAudioLease(payload.audioLease);
    preferencePatchRef.current = JSON.stringify(preferences);
    setSourceIdentity(payload.sourceIdentity);
    setSpeechProjectionEnabled(payload.features?.speechProjection ?? true);
    setProgressSoundsEnabled(payload.features?.progressSounds ?? false);
    setProgressSpeechEnabled(payload.features?.progressSpeech ?? false);
    setAppServerConfig(payload.appServerConfig ?? null);
    setScratchMode(preferences.scratchMode);
    setVoiceCaveman(preferences.shortSpokenReplies);
    setReasoningEffort(preferences.reasoningEffort);
    setCodexModel(preferences.codexModel);
    setServiceTier(preferences.serviceTier ?? null);
    setCodexAccessPreset(preferences.codexAccessPreset);
    setTtsStatus(payload.tts);
    setTtsProvider(preferences.ttsProvider);
    setSttStatus(payload.stt);
    setSttProvider(preferences.sttProvider);
    if (payload.livekit) setLiveKitStatus(payload.livekit);
    setTransportProvider(preferences.transportProvider);
    setState({ session: payload.session, loading: false, error: null });
    sessionRef.current = payload.session;
    setSourceDraft(payload.session.sourceUri);
    const nextDraft = payload.session.composerDraft ?? "";
    draftPatchRef.current = nextDraft;
    setDraft(nextDraft);
    setHandoff(payload.session.handoff ?? "");
    setShortHandoff(payload.session.handoffShort ?? "");
    setFullHandoff(payload.session.handoffFull ?? "");
    if (payload.session.activeTurn?.status === "running" && !pendingRef.current) reattachActiveTurn(payload.session.activeTurn);
    if (payload.session.activeTurn?.status !== "running") setTurnPending(false);
    setSettingsHydrated(true);

    if (!payload.preferences.initialized) {
      void fetch(`${api}/api/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences)
      });
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`${api}/api/session`);
        if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
        const payload = (await response.json()) as SessionSnapshot;
        if (cancelled) return;
        applySessionSnapshot(payload);
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
    let fallbackTimer = 0;
    const stream = new EventSource(`${api}/api/session/stream?clientId=${encodeURIComponent(clientId)}&surface=${clientSurface}`);
    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as SessionStreamEvent;
      if (event.type === "snapshot") applySessionSnapshot(event.snapshot);
      if (event.type === "audio-command" && event.targetClientId === clientId) {
        interruptLocalAudio();
        if (event.reason !== "interrupt") resetQueuedTurn();
      }
    };
    stream.onerror = () => {
      if (fallbackTimer) return;
      fallbackTimer = window.setInterval(async () => {
        try {
          const response = await fetch(`${api}/api/session`);
          if (response.ok) applySessionSnapshot((await response.json()) as SessionSnapshot);
        } catch {
          // The live stream will reconnect automatically; polling is only a quiet fallback.
        }
      }, 5_000);
    };
    stream.onopen = () => {
      if (fallbackTimer) window.clearInterval(fallbackTimer);
      fallbackTimer = 0;
    };
    return () => {
      stream.close();
      if (fallbackTimer) window.clearInterval(fallbackTimer);
    };
  }, [api, clientId, clientSurface, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated || pending) return;
    if (!discoveredReasoningValues.includes(reasoningEffort)) {
      setReasoningEffort(selectedModelOption?.defaultReasoningEffort ?? appServerConfig?.selectedReasoningEffort ?? effectiveReasoningEffort);
    }
    const tiers = selectedModelOption?.serviceTiers ?? [];
    if (serviceTier && !tiers.some((tier) => tier.id === serviceTier)) {
      setServiceTier(selectedModelOption?.defaultServiceTier ?? null);
    }
  }, [
    appServerConfig?.selectedReasoningEffort,
    discoveredReasoningValues,
    effectiveReasoningEffort,
    pending,
    reasoningEffort,
    selectedModelOption,
    serviceTier,
    settingsHydrated
  ]);

  useEffect(() => {
    if (!settingsHydrated || !serverPreferences) return;
    const preferences: MorticPreferencesPatch = {
      initialized: true,
      codexModel,
      reasoningEffort: effectiveReasoningEffort,
      serviceTier,
      codexAccessPreset,
      scratchMode,
      shortSpokenReplies: voiceCaveman,
      transportProvider,
      sttProvider,
      ttsProvider,
      overlayHintDismissed: serverPreferences.overlayHintDismissed
    };
    const serialized = JSON.stringify(preferences);
    if (serialized === preferencePatchRef.current) return;
    const timer = window.setTimeout(() => {
      preferencePatchRef.current = serialized;
      void fetch(`${api}/api/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: serialized
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [api, codexAccessPreset, codexModel, effectiveReasoningEffort, scratchMode, serverPreferences, serviceTier, settingsHydrated, sttProvider, transportProvider, ttsProvider, voiceCaveman]);

  useEffect(() => {
    if (!settingsHydrated || draft === draftPatchRef.current) return;
    const timer = window.setTimeout(() => {
      draftPatchRef.current = draft;
      void fetch(`${api}/api/session/ui`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ composerDraft: draft })
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [api, draft, settingsHydrated]);

  useEffect(() => {
    const threadId = state.session?.threadId;
    if (!threadId || threadRequired || !needsModelTransitionPreflight(effectiveCodexModel)) {
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
  }, [api, effectiveCodexModel, effectiveReasoningEffort, effectiveServiceTier, effectiveVoiceCaveman, scratchMode, state.session?.threadId, threadRequired]);

  useEffect(() => {
    const session = state.session;
    if (!session || threadRequired || state.loading || pending || handoffPending || sourcePending) return;
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

    const runtimeKey = `access:${codexAccessPreset}`;
    const key = `${session.threadId}|${scratchMode}|${effectiveCodexModel}|tier:${effectiveServiceTier ?? "default"}|${effectiveReasoningEffort}|${runtimeKey}|caveman:${effectiveVoiceCaveman ? "on" : "off"}`;
    if (prewarmKeyRef.current === key) return;

    const controller = new AbortController();
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      prewarmKeyRef.current = key;
      setPrewarm({
        status: "warming",
        key,
        detail: `${modeLabels[scratchMode]} · ${configModelLabel(selectedModelOption, effectiveCodexModel)} · ${effortLabels[effectiveReasoningEffort]}${
          effectiveServiceTier ? ` · ${selectedServiceTierOption?.name ?? effectiveServiceTier}` : ""
        }${
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
            serviceTier: effectiveServiceTier,
            codexRuntimePolicy: effectiveCodexRuntimePolicy,
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
          detail: `${modeLabels[payload.scratchMode]} · ${configModelLabel(selectedModelOption, payload.codexModel)} · ${effortLabels[payload.reasoningEffort]}${
            payload.serviceTier ? ` · ${selectedServiceTierOption?.name ?? payload.serviceTier}` : ""
          }${
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
    }, prewarmKeyRef.current ? 350 : 0);

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
    effectiveCodexRuntimePolicy,
    effectiveReasoningEffort,
    effectiveVoiceCaveman,
    sparkApproved,
    sparkCompactionPending,
    sparkContext.label,
    pending,
    handoffPending,
    sourcePending,
    threadRequired
  ]);

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

  async function generateHandoff() {
    if (handoffPending) return;
    setHandoffPending(true);
    try {
      const response = await fetch(`${api}/api/handoff`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          reasoningEffort: effectiveReasoningEffort,
          codexModel: effectiveCodexModel,
          serviceTier: effectiveServiceTier,
          codexRuntimePolicy: effectiveCodexRuntimePolicy
        })
      });
      const payload = await response.json();
      setHandoff(payload.handoff);
      setShortHandoff(payload.shortPrompt ?? "");
      setFullHandoff(payload.fullPrompt ?? "");
      setState({ session: payload.session, loading: false, error: null });
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

  async function copyHandoffText(text: string, kind?: "short" | "full") {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      if (kind) {
        setCopiedHandoff(kind);
        window.setTimeout(() => setCopiedHandoff((current) => current === kind ? null : current), 1600);
      }
    } catch {
      setClipboardFallback(text);
    }
  }

  async function performClearScratch() {
    try {
      const response = await fetch(`${api}/api/session/clear`, {
        method: "POST"
      });
      const payload = await response.json();
      if (!response.ok) {
        setState((current) => ({
          ...current,
          error: payload.error ?? "Could not clear scratch"
        }));
        return;
      }

      resetSpeechPlayback();
      resetQueuedTurn();
      prewarmKeyRef.current = "";
      prewarmAnnouncementKeyRef.current = "";
      setPrewarm({ status: "idle" });
      setState({ session: payload.session, loading: false, error: null });
      setDraft("");
      setHandoff("");
      setShortHandoff("");
      setFullHandoff("");
      setSpeechError(null);
      setTurnPending(false);
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "Could not clear scratch"
      }));
    }
  }

  function requestClearScratch(): void {
    const hasContent = transcript.length > 0 || Boolean(handoff || shortHandoff || fullHandoff || draft.trim() || queuedTurnPreview);
    if (hasContent) setClearConfirmOpen(true);
    else void performClearScratch();
  }

  async function updateSourceThread(overrideUri?: string): Promise<string | null> {
    const clean = (overrideUri ?? sourceDraft).trim();
    if (!clean || sourcePending || pending) return null;

    resetSpeechPlayback();
    resetQueuedTurn();
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
      return payload.session.sourceUri;
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
      return null;
    } finally {
      setSourcePending(false);
    }
  }

  const fullPromptValue = fullHandoff || handoff;
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
            firstClientDeltaMs: activeTurn.metrics.firstClientDeltaMs,
            firstVisibleTextMs: activeTurn.metrics.firstVisibleTextMs,
            firstSpeakableTextMs: activeTurn.metrics.firstSpeakableTextMs,
            firstSpeechQueuedMs: activeTurn.metrics.firstSpeechQueuedMs,
            firstTtsRequestMs: activeTurn.metrics.firstTtsRequestMs,
            firstTtsResolvedMs: activeTurn.metrics.firstTtsResolvedMs,
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
        ? pending ? "Listening for next turn" : liveModeActive ? "Live listening" : "Listening"
      : pending || speechPhase === "speaking" || speechPhase === "buffering"
          ? liveModeActive ? "Speak to stop audio" : "Hold M to talk"
        : activeSttSupported
          ? liveModeActive ? "Live on" : "Hold M to talk"
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
        ? pending ? "Queueing" : "Listening"
      : liveModeActive
          ? "Live"
          : pending || speechPhase === "speaking" || speechPhase === "buffering"
            ? "Queue ready"
            : activeSttSupported
              ? "Ready"
              : "Unavailable";
  const dockTalkLabel =
    liveModeActive ? "Live on" : "Hold M";
  const canPushToTalkOverOutput = pending || speechPhase === "speaking" || speechPhase === "buffering";
  const pushToTalkDisabled =
    threadRequired ||
    codexUnavailable ||
    liveModeActive ||
    sttPhase === "transcribing" ||
    (!canPushToTalkOverOutput && (sparkBlocked || !activeSttSupported));
  const interactionState = deriveInteractionState({
    threadRequired,
    codexUnavailable,
    recognizing,
    sttPhase,
    pending,
    speechPhase,
    agentState
  });
  const sourceThreadLabel = session ? redactThreadId(session.threadId) : "No source";
  const projectDisplayTitle = sourceIdentity?.projectName ?? workspaceTitle(sourceIdentity?.workspacePath) ?? "Mortic";
  const activeForkTitle = sourceIdentity?.threadName ?? sourceThreadLabel;
  const handoffPreview = handoffPending
    ? "Generating handoff from this scratch transcript."
    : shortHandoff || fullHandoff || handoff
      ? "Handoff exists. Review or copy it when you are ready to leave the scratch."
      : transcript.length > 0
        ? "No handoff generated yet. Keep working, or generate one when you need to return to Codex."
        : "No handoff yet.";
  const compactTranscript = transcript.slice(-4);
  const latestUserEntry = [...transcript].reverse().find((entry) => entry.role === "user") ?? null;
  const latestAssistantEntry = [...transcript].reverse().find((entry) => entry.role === "assistant") ?? null;
  const latestAssistantAfterUser =
    latestAssistantEntry && (!latestUserEntry || Date.parse(latestAssistantEntry.createdAt) >= Date.parse(latestUserEntry.createdAt))
      ? latestAssistantEntry
      : null;
  const compactAssistantEntry = pending ? null : latestAssistantAfterUser;
  const assistantDraftText = streamingAssistantDraft?.text ?? liveAssistantText;
  const assistantDraftVisible = Boolean(assistantDraftText.trim()) && !compactAssistantEntry && (pending || Boolean(streamingAssistantDraft));
  const assistantDraftLabel =
    streamingAssistantDraft?.phase === "final-pending"
      ? "Final transcript pending"
      : streamingAssistantDraft?.phase === "finalizing"
        ? "Mortic finalizing"
        : "Mortic streaming";
  const runtimeErrors = [speechError, state.error].filter(Boolean);
  const configModels = appServerConfig?.models ?? [];
  const configModelSummary = configModelLabel(selectedModelOption, effectiveCodexModel);
  const configSummary = [
    configModelSummary,
    effortLabels[effectiveReasoningEffort],
    accessPresetLabels[codexAccessPreset].label,
    `${transportLabels[transportProvider]} / ${sttProviderLabels[sttProvider]} / ${ttsProviderLabels[ttsProvider]}`
  ].join(" · ");
  const configSourceText =
    appServerConfig?.source === "app-server"
      ? "Discovered from Codex app-server"
      : `Fallback config${appServerConfig?.error ? `: ${appServerConfig.error}` : ""}`;
  const setModelFromConfig = (modelValue: string) => {
    const next = configModels.find((model) => model.model === modelValue || model.id === modelValue);
    setCodexModel(next?.model ?? modelValue);
    setReasoningEffort(next?.defaultReasoningEffort ?? appServerConfig?.selectedReasoningEffort ?? effectiveReasoningEffort);
    setServiceTier(next?.defaultServiceTier ?? null);
    prewarmKeyRef.current = "";
    prewarmAnnouncementKeyRef.current = "";
  };

  const desktopOverlayExpanded = desktopState?.expanded ?? false;
  const desktopShortcutLabel = desktopState?.shortcutLabel ?? "Cmd+Shift+M";
  const desktopOverlayScale = desktopState?.overlayScale ?? 1;
  const desktopDensity = desktopOverlayScale < 0.62 ? "micro" : desktopOverlayScale < 0.86 ? "compact" : "normal";
  const desktopOverlayStyle = { "--desktop-overlay-scale": String(desktopOverlayScale) } as CSSProperties;
  const desktopThreadBlocked = isDesktopOverlay && threadRequired;
  const desktopProjectLabel = desktopThreadBlocked ? "Select thread" : projectDisplayTitle;
  const desktopThreadLabel = desktopThreadBlocked ? "No thread selected" : activeForkTitle;
  const desktopHudStatus = interactionState;
  const handoffPreviewText = shortHandoff || fullHandoff || handoff || handoffPreview;
  const handoffCopyText = fullHandoff || handoff || shortHandoff;
  const overlayStatusLine = [
    configModelSummary,
    effortLabels[effectiveReasoningEffort],
    accessPresetLabels[codexAccessPreset].label,
    `${sttProviderLabels[sttProvider]} / ${ttsProviderLabels[ttsProvider]}`
  ].join(" · ");
  const overlayMicButton = (
    <button
      type="button"
      className={`desktop-overlay-mic ${recognizing ? "recording" : ""}`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        startPushToTalkCapture();
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        event.currentTarget.blur();
        stopPushToTalkCapture();
      }}
      onPointerCancel={(event) => {
        event.preventDefault();
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        event.currentTarget.blur();
        stopPushToTalkCapture();
      }}
      onPointerLeave={() => {
        if (recognizingRef.current) stopPushToTalkCapture();
      }}
      onClick={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
          event.preventDefault();
          void startPushToTalkCapture();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          stopPushToTalkCapture();
        }
      }}
      aria-pressed={recognizing}
      title={desktopThreadBlocked ? "Select a Codex thread first." : codexUnavailable ? "Codex is offline. Recheck setup in the full app." : "Hold M when this window is focused, or hold this button."}
      disabled={desktopThreadBlocked || pushToTalkDisabled}
    >
      <strong>{dockTalkLabel}</strong>
    </button>
  );

  if (isDesktopOverlay) {
    return (
      <>
      <main
        className={[
          "desktop-overlay-shell",
          desktopOverlayExpanded ? "desktop-overlay-expanded" : "desktop-overlay-collapsed",
          `desktop-density-${desktopDensity}`,
          desktopThreadBlocked ? "desktop-thread-required" : ""
        ].join(" ")}
        style={desktopOverlayStyle}
        data-session-ready={Boolean(session)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (desktopOverlayExpanded) setDesktopOverlayExpanded(false);
            else void hideDesktopOverlay();
          }
          if (!desktopOverlayExpanded && event.key === "Enter") {
            event.preventDefault();
            setDesktopOverlayExpanded(true);
          }
        }}
      >
        {!desktopOverlayExpanded ? (
          <section className="desktop-hud desktop-overlay-drag" aria-label="Mortic desktop HUD">
            <button type="button" className="desktop-hud-identity desktop-overlay-nodrag" onClick={() => setDesktopOverlayExpanded(true)}>
              <span>Mortic</span>
              <strong>{desktopProjectLabel}</strong>
              <em>{desktopThreadLabel}</em>
            </button>
            <button
              type="button"
              className={`desktop-hud-state desktop-overlay-nodrag ${desktopThreadBlocked ? "desktop-hud-state-thread" : ""}`}
              title={desktopHudStatus}
              aria-label={desktopHudStatus}
              onClick={() => {
                if (!desktopThreadBlocked) return;
                setDesktopOverlayExpanded(true);
                setFinderOpenRequest((value) => value + 1);
              }}
            >
              <span className={`status-dot ${desktopThreadBlocked ? "warn" : session?.codex.available ? "ok" : "bad"}`} />
              <span>{desktopHudStatus}</span>
            </button>
            <div className="desktop-hud-actions desktop-overlay-nodrag">
              {overlayMicButton}
              <button
                type="button"
                className="desktop-hud-interrupt-button"
                onClick={() => void interruptTurn()}
                disabled={!pending && speechPhase === "idle"}
              >
                Stop audio
              </button>
              <button
                type="button"
                className="desktop-icon-button desktop-hud-app-button"
                onClick={() => void desktopBridge()?.openFullApp()}
                aria-label="Open full app"
                title="Open full app"
              >
                <DesktopIcon name="app" />
                <span>App</span>
              </button>
            </div>
          </section>
        ) : (
          <section className="desktop-command-panel" aria-label="Mortic desktop command pane">
            <header className="desktop-panel-header desktop-overlay-drag">
              <div className="desktop-panel-title">
                <span>Mortic</span>
                <strong>{desktopProjectLabel}</strong>
                <em>{desktopThreadLabel}</em>
              </div>
              <div className="desktop-panel-actions desktop-overlay-nodrag">
                <ThreadPicker
                  api={api}
                  currentThreadId={session?.threadId}
                  disabled={sourcePending || pending}
                  workspacePath={sourceIdentity?.workspacePath}
                  openRequest={finderOpenRequest}
                  onSelect={(uri) => {
                    setSourceDraft(uri);
                    void updateSourceThread(uri).then((sourceUri) => {
                      if (sourceUri) void desktopBridge()?.rememberSource(sourceUri);
                    });
                  }}
                />
                <div className="desktop-panel-window-actions" aria-label="Window controls">
                  <button
                    type="button"
                    className="desktop-icon-button"
                    onClick={() => void desktopBridge()?.openFullApp()}
                    aria-label="Open full app"
                    title="Open full app"
                  >
                    <DesktopIcon name="app" />
                    <span>Open app</span>
                  </button>
                  <button
                    type="button"
                    className="desktop-icon-button"
                    onClick={() => setDesktopOverlayExpanded(false)}
                    aria-label="Collapse"
                    title="Collapse"
                  >
                    <DesktopIcon name="collapse" />
                    <span>Collapse</span>
                  </button>
                  <button
                    type="button"
                    className="desktop-icon-button"
                    onClick={() => void hideDesktopOverlay()}
                    aria-label={`Hide overlay (${desktopShortcutLabel})`}
                    title={desktopShortcutLabel}
                  >
                    <DesktopIcon name="hide" />
                    <span>Hide</span>
                  </button>
                </div>
              </div>
            </header>

            <article className="desktop-overlay-card desktop-overlay-transcript">
              <div className="live-card-header">
                <span>Scratch</span>
                <button type="button" onClick={() => void desktopBridge()?.openFullApp()} disabled={desktopThreadBlocked}>Open app</button>
              </div>
              {desktopThreadBlocked ? (
                <section className="compact-turn compact-thread-required">
                  <span>Mortic paused</span>
                  <p>Choose a conversation in Finder to begin.</p>
                </section>
              ) : state.loading ? (
                <p>Loading session.</p>
              ) : transcript.length === 0 ? (
                <p>Say or type a scratch turn.</p>
              ) : latestUserEntry && (
                <section className="compact-turn compact-user">
                  <span>You</span>
                  <p>{entryMainText(latestUserEntry)}</p>
                </section>
              )}
              {!desktopThreadBlocked && (assistantDraftVisible ? (
                <section className="compact-turn compact-assistant">
                  <span>{assistantDraftLabel}</span>
                  <p>{assistantDraftText}</p>
                </section>
              ) : pending ? (
                <section className="compact-turn compact-assistant compact-thinking">
                  <span>Mortic</span>
                  <p>Waiting for the first answer chunk.</p>
                </section>
              ) : compactAssistantEntry && (
                <section className="compact-turn compact-assistant">
                  <span>Mortic</span>
                  <p>{entryMainText(compactAssistantEntry)}</p>
                  {compactAssistantEntry.notesText && (
                    <details className="compact-notes">
                      <summary>{entryNotesLabel(compactAssistantEntry)}</summary>
                      <MarkdownContent markdown={compactAssistantEntry.notesText} />
                    </details>
                  )}
                </section>
              ))}
              {!desktopThreadBlocked && queuedTurnPreview && (
                <section className="compact-turn compact-queued">
                  <span>Queued</span>
                  <p>{queuedTurnPreview}</p>
                  <button type="button" onClick={() => void cancelQueuedTurn()}>Cancel queued</button>
                </section>
              )}
            </article>

            {!desktopThreadBlocked && <CodexWorkingBuffer trace={activeAppServerTrace} pending={pending} hasAssistantText={Boolean(assistantDraftText.trim())} />}

            <nav className="desktop-overlay-controls" aria-label="Voice controls">
              {overlayMicButton}
              <button
                type="button"
                className="desktop-overlay-interrupt"
                onClick={() => void interruptTurn()}
                disabled={desktopThreadBlocked || (!pending && speechPhase === "idle")}
              >
                <span>Audio</span>
                <strong>Stop</strong>
              </button>
            </nav>

            <form
              className="desktop-overlay-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (desktopThreadBlocked) return;
                void sendTurn(draft);
              }}
            >
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={desktopThreadBlocked ? "Select a Codex thread first" : "Type a scratch turn"}
                rows={2}
                disabled={desktopThreadBlocked}
              />
              <button type="submit" disabled={desktopThreadBlocked || codexUnavailable || !draft.trim() || sparkBlocked}>Send</button>
            </form>

            <section className="desktop-overlay-card desktop-handoff-card">
              <div>
                <span>Handoff</span>
                <strong>{handoffStateLabel}</strong>
              </div>
              <p>{desktopThreadBlocked ? "Select a Codex thread before generating handoff." : handoffPreviewText}</p>
              <div className="desktop-handoff-actions">
                <button type="button" onClick={() => void generateHandoff()} disabled={desktopThreadBlocked || handoffPending || transcript.length === 0}>
                  {handoffPending ? "Generating" : "Generate"}
                </button>
                <button type="button" onClick={() => void copyHandoffText(shortHandoff, "short")} disabled={desktopThreadBlocked || !shortHandoff}>{copiedHandoff === "short" ? "Copied" : "Copy short"}</button>
                <button type="button" onClick={() => void copyHandoffText(handoffCopyText, "full")} disabled={desktopThreadBlocked || !handoffCopyText}>{copiedHandoff === "full" ? "Copied" : "Copy full"}</button>
              </div>
            </section>

            {serverPreferences && !serverPreferences.overlayHintDismissed && (
              <aside className="desktop-overlay-hint">
                <span>Select a thread · Hold M to talk · {desktopShortcutLabel} hides Mortic.</span>
                <button type="button" aria-label="Dismiss hint" onClick={() => setServerPreferences({ ...serverPreferences, overlayHintDismissed: true })}>×</button>
              </aside>
            )}

            {desktopState?.shortcutError && <p className="desktop-shortcut-error" role="alert">{desktopState.shortcutError}</p>}
            {!desktopThreadBlocked && (sttProviderNotice || ttsProviderNotice || transportNotice) && (
              <div className="voice-provider-notices desktop-provider-notices" role="status" aria-live="polite">
                {transportNotice && <p>{transportNotice}</p>}
                {sttProviderNotice && <p>{sttProviderNotice}</p>}
                {ttsProviderNotice && <p>{ttsProviderNotice}</p>}
              </div>
            )}

            <footer className="desktop-overlay-config">
              <div className="desktop-overlay-config-summary">
                <span>Config</span>
                <strong>{overlayStatusLine}</strong>
              </div>
            </footer>
          </section>
        )}
      </main>
      {clipboardFallback && <ClipboardFallbackDialog text={clipboardFallback} onClose={() => setClipboardFallback("")} />}
      </>
    );
  }

  return (
    <main className="app-shell command-shell" data-session-ready={Boolean(session)}>
      <div className="ambient-void" aria-hidden="true" />
      <header className="command-topbar">
        <div className="brand-cluster">
          <strong>Mortic</strong>
        </div>
        <div className="source-form command-source-form">
          <span className="source-current" title={session?.sourceUri}>
            {threadRequired ? "Select Codex thread" : activeForkTitle}
          </span>
          <ThreadPicker
            api={api}
            currentThreadId={session?.threadId}
            disabled={sourcePending || pending}
            workspacePath={sourceIdentity?.workspacePath}
            openRequest={finderOpenRequest}
            onSelect={(uri) => {
              setSourceDraft(uri);
              void updateSourceThread(uri).then((sourceUri) => {
                if (sourceUri) void desktopBridge()?.rememberSource(sourceUri);
              });
            }}
          />
        </div>
        <div className="topbar-status">
          <span className={`status-dot ${session?.codex.available ? "ok" : "bad"}`} />
          <span>{session?.codex.available ? session.codex.version ?? "Codex connected" : session?.codex.error ?? "Codex unavailable"}</span>
        </div>
      </header>

      <section className="workspace command-workspace">
        <section className="command-main">
          <details className="studio-settings">
            <summary>
              <span>Config</span>
              <strong>{configSummary}</strong>
            </summary>
            <section className="control-strip compact-controls config-panel" aria-label="Session controls">
              <div className="config-section config-section-codex">
                <div className="config-section-head">
                  <span>Codex app-server</span>
                  <em>{configSourceText}</em>
                </div>
                <label className="model-control">
                  <span>Model</span>
                  <select value={effectiveCodexModel} onChange={(event) => setModelFromConfig(event.target.value)} disabled={pending}>
                    {!configModels.some((model) => model.model === effectiveCodexModel) && <option value={effectiveCodexModel}>{effectiveCodexModel}</option>}
                    {configModels.map((model) => (
                      <option key={model.id} value={model.model}>
                        {model.displayName}{model.isDefault ? " · default" : ""}{model.inputModalities.length ? ` · ${model.inputModalities.join("+")}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="control-select">
                  <span>Reasoning</span>
                  <select value={effectiveReasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as ReasoningEffort)} disabled={pending}>
                    {discoveredReasoningOptions.map((option) => (
                      <option key={option.reasoningEffort} value={option.reasoningEffort}>
                        {effortLabels[option.reasoningEffort] ?? option.reasoningEffort}{option.description ? ` · ${option.description}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="config-section config-section-policy">
                <div className="config-section-head">
                  <span>Access</span>
                  <em>How should Codex actions be approved?</em>
                </div>
                <div className="access-preset-list" role="radiogroup" aria-label="Codex access">
                  {(["ask", "approve", "full"] as const).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      role="radio"
                      aria-checked={codexAccessPreset === preset}
                      className={`access-preset ${codexAccessPreset === preset ? "selected" : ""} ${preset === "full" ? "danger" : ""}`}
                      onClick={() => {
                        setCodexAccessPreset(preset);
                        prewarmKeyRef.current = "";
                      }}
                      disabled={pending}
                    >
                      <span className="access-icon" aria-hidden="true">{preset === "ask" ? "!" : preset === "approve" ? "✓" : "⚠"}</span>
                      <span>
                        <strong>{accessPresetLabels[preset].label}</strong>
                        <em>{accessPresetLabels[preset].detail}</em>
                      </span>
                      {codexAccessPreset === preset && <b aria-hidden="true">✓</b>}
                    </button>
                  ))}
                </div>
                {accessPresetLabels[codexAccessPreset].warning && (
                  <p className="config-warning">{accessPresetLabels[codexAccessPreset].warning}</p>
                )}
              </div>
              <div className="config-section config-section-voice">
                <div className="config-section-head">
                  <span>Voice pipeline</span>
                  <em>Separate from Codex app-server config</em>
                </div>
                <div className="segmented mode-segmented" aria-label="Scratch mode">
                  {scratchModes.map((mode) => (
                    <button key={mode} type="button" className={mode === scratchMode ? "selected" : ""} onClick={() => setScratchMode(mode)} disabled={pending}>
                      {modeLabels[mode]}
                    </button>
                  ))}
                </div>
                <label className="toggle-control" title="Keep spoken answers concise while preserving full screen notes">
                  <input type="checkbox" checked={voiceCaveman} onChange={(event) => setVoiceCaveman(event.target.checked)} disabled={scratchMode !== "voice" || pending} />
                  Short spoken replies
                </label>
                <label className="control-select">
                  <span>Transport</span>
                  <select value={transportProvider} onChange={(event) => setTransportProvider(event.target.value as TransportProvider)} disabled={pending}>
                    {transportProviders.map((provider) => (
                      <option key={provider} value={provider} disabled={!liveKitStatus.availableTransports.includes(provider)}>
                        {transportLabels[provider]} · {providerAvailabilityHint(provider, liveKitStatus)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="control-select">
                  <span>Speech to text</span>
                  <select value={sttProvider} onChange={(event) => setSttProvider(event.target.value as SttProvider)} disabled={pending}>
                    {sttProviders.map((provider) => (
                      <option key={provider} value={provider} disabled={!sttStatus.availableProviders.includes(provider)}>
                        {sttProviderLabels[provider]} · {providerAvailabilityHint(provider, sttStatus)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="control-select">
                  <span>Text to speech</span>
                  <select value={ttsProvider} onChange={(event) => setTtsProvider(event.target.value as TtsProvider)} disabled={pending}>
                    {ttsProviders.map((provider) => (
                      <option key={provider} value={provider} disabled={!ttsStatus.availableProviders.includes(provider)}>
                        {ttsProviderLabels[provider]} · {providerAvailabilityHint(provider, ttsStatus)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
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

          {runtimeErrors.length > 0 && (
            <div className="notice-row">
              {runtimeErrors.map((message) => <div key={message} className="notice error">{message}</div>)}
            </div>
          )}
          {!onboarding?.ready && (
            <div className="notice warning onboarding-inline" role="status">
              <span>{session?.codex.error ?? "Codex is unavailable. Transcript and handoff remain available; turns are paused."}</span>
              <button type="button" onClick={() => void refreshOnboarding()} disabled={onboardingBusy}>{onboardingBusy ? "Checking" : "Recheck"}</button>
            </div>
          )}

          <section className={`agent-canvas ${threadRequired ? "agent-canvas-thread-required" : ""}`} aria-label="Mortic voice agent">
            {!threadRequired && <div className={`agent-orb agent-${agentState} ${recognizing ? "agent-hearing" : ""} ${speechPhase === "speaking" ? "agent-speaking" : ""}`}>
              <div className="orb-halo" />
              <div className="orb-core">
                <span>{interactionState}</span>
                <strong>{codexStateLabel}</strong>
              </div>
            </div>}
            <article className={`live-transcript-card ${threadRequired ? "thread-required-card" : ""}`}>
              <div className="live-card-header">
                <span>{threadRequired ? "Thread required" : "Scratch"}</span>
                <button type="button" onClick={() => setTranscriptDrawerOpen(true)} disabled={threadRequired}>Open transcript</button>
              </div>
              {state.loading && <p>Loading session.</p>}
              {!state.loading && threadRequired && (
                <section className="thread-required-cta">
                  <p>Select a Codex thread to start.</p>
                  <button type="button" onClick={() => setFinderOpenRequest((value) => value + 1)}>Open Finder</button>
                </section>
              )}
              {!state.loading && !threadRequired && transcript.length === 0 && <p>Say or type a scratch turn.</p>}
              {!threadRequired && latestUserEntry && (
                <section className="compact-turn compact-user">
                  <span>You</span>
                  <p>{entryMainText(latestUserEntry)}</p>
                </section>
              )}
              {!threadRequired && (assistantDraftVisible ? (
                <section className="compact-turn compact-assistant">
                  <span>{assistantDraftLabel}</span>
                  <p>{assistantDraftText}</p>
                </section>
              ) : pending ? (
                <section className="compact-turn compact-assistant compact-thinking">
                  <span>Mortic</span>
                  <p>Waiting for the first answer chunk.</p>
                </section>
              ) : compactAssistantEntry && (
                <section className="compact-turn compact-assistant">
                  <span>Mortic</span>
                  <p>{entryMainText(compactAssistantEntry)}</p>
                  {compactAssistantEntry.notesText && (
                    <details className="compact-notes">
                      <summary>{entryNotesLabel(compactAssistantEntry)}</summary>
                      <MarkdownContent markdown={compactAssistantEntry.notesText} />
                    </details>
                  )}
                </section>
              ))}
              {!threadRequired && queuedTurnPreview && (
                <section className="compact-turn compact-queued">
                  <span>Queued</span>
                  <p>{queuedTurnPreview}</p>
                  <button type="button" onClick={() => void cancelQueuedTurn()}>Cancel queued</button>
                </section>
              )}
            </article>
            <CodexWorkingBuffer trace={activeAppServerTrace} pending={pending} hasAssistantText={Boolean(assistantDraftText.trim())} />
            <CodexLatentTraceBubble trace={activeAppServerTrace} pending={pending} />
            <nav className="bottom-voice-dock" aria-label="Voice controls">
              <button
                type="button"
                className={`dock-mic ${recognizing ? "recording" : ""}`}
                disabled={pushToTalkDisabled}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  startPushToTalkCapture();
                }}
                onPointerUp={(event) => {
                  event.preventDefault();
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  event.currentTarget.blur();
                  stopPushToTalkCapture();
                }}
                onPointerCancel={(event) => {
                  event.preventDefault();
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  event.currentTarget.blur();
                  stopPushToTalkCapture();
                }}
                onPointerLeave={() => {
                  if (recognizingRef.current) stopPushToTalkCapture();
                }}
                onClick={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
                    event.preventDefault();
                    void startPushToTalkCapture();
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    stopPushToTalkCapture();
                  }
                }}
                aria-pressed={recognizing}
                title={threadRequired ? "Select a Codex thread first." : codexUnavailable ? "Codex is offline. Recheck setup above." : "Hold M or hold this button to talk."}
              >
                <strong>{dockTalkLabel}</strong>
              </button>
              <button type="button" onClick={() => void interruptTurn()} disabled={threadRequired || (!pending && speechPhase === "idle")}>
                <span>Audio</span>
                <strong>Stop</strong>
              </button>
              <button type="button" onClick={requestClearScratch} disabled={threadRequired || pending || (transcript.length === 0 && !draft.trim() && !handoff)}>
                <span>Clear</span>
                <strong>{prewarm.status === "ready" ? `Ready ${formatMs(prewarm.elapsedMs)}` : prewarm.status === "warming" ? "Warming" : "Reset"}</strong>
              </button>
            </nav>
            {!threadRequired && (sttProviderNotice || ttsProviderNotice || transportNotice) && (
              <div className="voice-provider-notices" role="status" aria-live="polite">
                {transportNotice && <p>{transportNotice}</p>}
                {sttProviderNotice && <p>{sttProviderNotice}</p>}
                {ttsProviderNotice && <p>{ttsProviderNotice}</p>}
              </div>
            )}
            <form
              className="composer command-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (threadRequired) return;
                void sendTurn(draft);
              }}
            >
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={threadRequired ? "Select a Codex thread first" : "Type a scratch turn"}
                rows={3}
                disabled={threadRequired}
              />
              <button type="submit" disabled={threadRequired || codexUnavailable || !draft.trim() || sparkBlocked}>Send</button>
            </form>
          </section>
        </section>

        <HandoffPanel
          pending={handoffPending}
          transcriptLength={transcript.length}
          shortHandoff={shortHandoff}
          fullHandoff={fullHandoff}
          handoff={handoff}
          onGenerate={() => void generateHandoff()}
          onPreview={() => setHandoffReviewOpen(true)}
          onCopy={(text, kind) => void copyHandoffText(text, kind)}
          copied={copiedHandoff}
        />
      </section>

      {transcriptDrawerOpen && (
        <TranscriptDrawer
          sessionId={session?.id}
          transcript={transcript}
          compactTranscriptLength={compactTranscript.length}
          onClose={() => setTranscriptDrawerOpen(false)}
        />
      )}

      {handoffReviewOpen && (
        <HandoffReviewModal
          shortHandoff={shortHandoff}
          setShortHandoff={setShortHandoff}
          fullHandoff={fullHandoff}
          setFullHandoff={setFullHandoff}
          setHandoff={setHandoff}
          fullPromptValue={fullPromptValue}
          handoff={handoff}
          generateHandoff={generateHandoff}
          copyHandoffText={copyHandoffText}
          handoffPending={handoffPending}
          transcriptLength={transcript.length}
          onClose={() => setHandoffReviewOpen(false)}
        />
      )}

      {clearConfirmOpen && (
        <ConfirmDialog
          title="Clear this scratch?"
          detail="This removes the transcript, handoff, draft, and queued speech from every open Mortic surface."
          confirmLabel="Clear scratch"
          onClose={() => setClearConfirmOpen(false)}
          onConfirm={() => {
            setClearConfirmOpen(false);
            void performClearScratch();
          }}
        />
      )}

      {clipboardFallback && <ClipboardFallbackDialog text={clipboardFallback} onClose={() => setClipboardFallback("")} />}

    </main>
  );
}
