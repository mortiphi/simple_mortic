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
  type AgentState,
  type CanonicalDelta,
  type ConversationArtifact,
  type ExtractedItem,
  type ExtractionStatus,
  type InputPolicy,
  type LiveKitStatus,
  type MorticSession,
  type OnboardingStatusResponse,
  type PrewarmResponse,
  type ProjectArtifactPreviewResponse,
  type ProjectCanonicalStateResponse,
  type ProjectChartResponse,
  type ProjectStateResponse,
  type ProviderForkAccessResponse,
  type ProviderForkContinuation,
  type ProviderReference,
  type ReasoningEffort,
  type ScratchSessionNode,
  type ScratchMode,
  type SessionResponse,
  type SparkContextCompactResponse,
  type SparkContextPreflight,
  type SparkContextPreflightResponse,
  type SttProvider,
  type SttStatus,
  type TransportProvider,
  type TtsProvider,
  type TtsStatus,
  type UpdateExtractedItemRequest
} from "../shared/types.js";
import { redactThreadId } from "../shared/threadUri.js";
import { contextWorkReduction, estimateTextTokens, estimateTranscriptTokens, percentReduction } from "../shared/tokenEstimate.js";
import { effectiveReasoningForModel, modelRequiresLowReasoning } from "../shared/modelPolicy.js";
import { modelProfile } from "../shared/modelProfiles.js";
import { ChartTranscriptPreview, MarkdownContent, TaskPlanDetails, dedupeExtractionItems, normalizeExtractionText } from "./components/Markdown.js";
import { CanonicalStateModal, ChartModal } from "./components/ChartModal.js";
import { ExtractionReviewModal, HandoffReviewModal, TranscriptDrawer } from "./components/SessionModals.js";
import { InsightsPanel, SideRail } from "./components/ProjectPanels.js";
import { ForkActionSheet } from "./components/ForkActionSheet.js";
import { OnboardingScreen } from "./components/OnboardingScreen.js";
import { ThreadPicker } from "./components/ThreadPicker.js";
import { apiBase, readStoredEffort, readStoredModel, readStoredScratchMode, readStoredSttProvider, readStoredTransportProvider, readStoredTtsProvider, readStoredVoiceCaveman, writeStoredSetting } from "./lib/api.js";
import { ApiState, PrewarmState } from "./lib/clientTypes.js";
import { formatCount, formatMs, formatSignedMs } from "./lib/format.js";
import { SETTINGS_VERSION, artifactTitle, chartDateLabel, deltaLifecycleLabel, effortLabels, entryLabel, entryMainText, entryNotesLabel, entryParserLabel, extractionActionLabel, extractionEvidenceLabel, extractionReasons, extractionReviewSort, extractionStatusLabels, extractionTypeLabels, extractionTypeOrder, extractionTypeShortLabels, isExtractionReviewCandidate, modeLabels, modelLabels, modelOptions, providerActionText, providerRefTitle, sttProviderLabels, transportLabels, ttsProviderLabels } from "./lib/labels.js";
import { clientUnknownSparkPreflight, needsModelTransitionPreflight, sparkPreflightLabel } from "./lib/spark.js";
import { LIVE_MODE_RUNTIME_ENABLED } from "./lib/voice.js";
import { useVoiceEngine } from "./voice/useVoiceEngine.js";

function workspaceTitle(workspacePath: string | undefined): string | null {
  if (!workspacePath) return null;
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const title = normalized.split("/").filter(Boolean).at(-1);
  return title || null;
}

export function App() {
  const api = useMemo(apiBase, []);
  const [state, setState] = useState<ApiState>({ session: null, loading: true, error: null });
  const [onboarding, setOnboarding] = useState<OnboardingStatusResponse | null>(null);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
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
  const [chartState, setChartState] = useState<ProjectChartResponse | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [chartPending, setChartPending] = useState(false);
  const projectViewSeqRef = useRef(0);
  const projectSourceSwitchPendingRef = useRef(false);
  const projectFetchSeqRef = useRef(0);
  const chartFetchSeqRef = useRef(0);
  const chartPendingSeqRef = useRef(0);
  const canonicalFetchSeqRef = useRef(0);
  const canonicalPendingSeqRef = useRef(0);
  const artifactFetchSeqRef = useRef(0);
  const artifactPendingSeqRef = useRef(0);
  const [chartSearch, setChartSearch] = useState("");
  const [chartTypeFilter, setChartTypeFilter] = useState<ExtractedItem["type"] | "all">("all");
  const [selectedChartCheckpointId, setSelectedChartCheckpointId] = useState("");
  const [selectedChartDeltaId, setSelectedChartDeltaId] = useState("");
  const [forkSheetSessionId, setForkSheetSessionId] = useState<string | null>(null);
  const [forkAccessPending, setForkAccessPending] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<ProjectArtifactPreviewResponse | null>(null);
  const [artifactPending, setArtifactPending] = useState(false);
  const [transcriptDrawerOpen, setTranscriptDrawerOpen] = useState(false);
  const [handoffReviewOpen, setHandoffReviewOpen] = useState(false);
  const [extractionReviewOpen, setExtractionReviewOpen] = useState(false);
  const [extractionReviewTab, setExtractionReviewTab] = useState<"pending" | "approved">("pending");
  const [editingExtractionId, setEditingExtractionId] = useState<string | null>(null);
  const [editingExtractionType, setEditingExtractionType] = useState<ExtractedItem["type"]>("project_state");
  const [editingExtractionTitle, setEditingExtractionTitle] = useState("");
  const [editingExtractionBody, setEditingExtractionBody] = useState("");
  const [editingExtractionTaskPlan, setEditingExtractionTaskPlan] = useState("");
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

  const {
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
    announcePrewarmConfirmation,
    reattachActiveTurn,
    resetSpeechPlayback,
    sendTurn,
    interruptTurn,
    setLiveActive,
    startPushToTalkCapture,
    stopPushToTalkCapture
  } = useVoiceEngine({
    api,
    state,
    setState,
    scratchMode,
    effectiveCodexModel,
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
    setLiveModeActive
  });

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

  function invalidateProjectViews(): number {
    const seq = projectViewSeqRef.current + 1;
    projectViewSeqRef.current = seq;
    projectFetchSeqRef.current += 1;
    chartFetchSeqRef.current += 1;
    canonicalFetchSeqRef.current += 1;
    artifactFetchSeqRef.current += 1;
    chartPendingSeqRef.current = 0;
    canonicalPendingSeqRef.current = 0;
    artifactPendingSeqRef.current = 0;
    setProjectState(null);
    setChartState(null);
    setCanonicalState(null);
    setArtifactPreview(null);
    setChartPending(false);
    setCanonicalStatePending(false);
    setArtifactPending(false);
    setProjectError(null);
    setChartOpen(false);
    setCanonicalStateOpen(false);
    setExtractionReviewOpen(false);
    setForkSheetSessionId(null);
    setSelectedChartCheckpointId("");
    setSelectedChartDeltaId("");
    return seq;
  }

  function isCurrentProjectView(seq: number): boolean {
    return seq === projectViewSeqRef.current;
  }

  async function refreshProject(options: { projectViewSeq?: number } = {}): Promise<void> {
    if (projectSourceSwitchPendingRef.current) return;
    const projectViewSeq = options.projectViewSeq ?? projectViewSeqRef.current;
    const fetchSeq = ++projectFetchSeqRef.current;
    try {
      const response = await fetch(`${api}/api/project`);
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? `Project request failed: ${response.status}`);
      }
      if (projectViewSeq !== projectViewSeqRef.current || fetchSeq !== projectFetchSeqRef.current) return;
      setProjectState(payload);
      setProjectError(null);
    } catch (error) {
      if (projectViewSeq !== projectViewSeqRef.current || fetchSeq !== projectFetchSeqRef.current) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openCanonicalState(): Promise<void> {
    if (projectSourceSwitchPendingRef.current) return;
    if (canonicalStatePending) return;
    const seq = ++canonicalFetchSeqRef.current;
    canonicalPendingSeqRef.current = seq;
    setCanonicalStatePending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/canonical-state`);
      const payload = (await response.json()) as ProjectCanonicalStateResponse & { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? `Canonical state request failed: ${response.status}`);
      }
      if (seq !== canonicalFetchSeqRef.current) return;
      setCanonicalState(payload);
      setCanonicalStateOpen(true);
    } catch (error) {
      if (seq !== canonicalFetchSeqRef.current) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === canonicalPendingSeqRef.current) setCanonicalStatePending(false);
    }
  }

  function selectInitialChartNodes(payload: ProjectChartResponse): void {
    const checkpoint = [...payload.checkpoints].sort((a, b) => b.approvedAt.localeCompare(a.approvedAt))[0];
    setSelectedChartCheckpointId(checkpoint?.id ?? "");
    const delta = checkpoint
      ? payload.deltas.find((candidate) => checkpoint.approvedDeltaIds.includes(candidate.id))
      : payload.deltas[0];
    setSelectedChartDeltaId(delta?.id ?? "");
  }

  async function refreshProjectChart(options: { open?: boolean; preserveSelection?: boolean } = {}): Promise<void> {
    if (projectSourceSwitchPendingRef.current) return;
    if (chartPending) return;
    const seq = ++chartFetchSeqRef.current;
    chartPendingSeqRef.current = seq;
    setChartPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/chart`);
      const payload = (await response.json()) as ProjectChartResponse & { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? `Project chart request failed: ${response.status}`);
      }
      if (seq !== chartFetchSeqRef.current) return;
      setChartState(payload);
      if (options.open) setChartOpen(true);
      if (!options.preserveSelection) selectInitialChartNodes(payload);
    } catch (error) {
      if (seq !== chartFetchSeqRef.current) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === chartPendingSeqRef.current) setChartPending(false);
    }
  }

  async function openProjectChart(): Promise<void> {
    await refreshProjectChart({ open: true });
  }

  function openForkSheet(scratch: ScratchSessionNode): void {
    setForkSheetSessionId(scratch.id);
    // The sheet reads requested/effective access from the fork tree; refresh
    // it in the background so the record is current (or appears at all when
    // the chart was never opened this session).
    void refreshProjectChart({ preserveSelection: true });
  }

  async function setForkAccess(providerRefId: string, continuation: ProviderForkContinuation): Promise<void> {
    if (projectSourceSwitchPendingRef.current) return;
    const projectViewSeq = projectViewSeqRef.current;
    setForkAccessPending(true);
    try {
      const response = await fetch(`${api}/api/project/fork/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerRefId, requestedAccessPreset: continuation })
      });
      const payload = (await response.json()) as ProviderForkAccessResponse & { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? `Fork access update failed: ${response.status}`);
      }
      if (!isCurrentProjectView(projectViewSeq)) return;
      chartFetchSeqRef.current += 1;
      setChartState((previous) => (previous ? { ...previous, providerForks: payload.providerForks } : previous));
    } catch (error) {
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setForkAccessPending(false);
    }
  }

  async function loadArtifactPreview(artifactId: string): Promise<void> {
    if (projectSourceSwitchPendingRef.current) return;
    if (!artifactId) {
      setArtifactPreview(null);
      return;
    }
    const seq = ++artifactFetchSeqRef.current;
    artifactPendingSeqRef.current = seq;
    setArtifactPending(true);
    try {
      const response = await fetch(`${api}/api/project/artifacts/${encodeURIComponent(artifactId)}`);
      const payload = (await response.json()) as ProjectArtifactPreviewResponse & { error?: string };
      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? `Artifact preview failed: ${response.status}`);
      }
      if (seq !== artifactFetchSeqRef.current) return;
      setArtifactPreview(payload);
    } catch (error) {
      if (seq !== artifactFetchSeqRef.current) return;
      setProjectError(error instanceof Error ? error.message : String(error));
      setArtifactPreview(null);
    } finally {
      if (seq === artifactPendingSeqRef.current) setArtifactPending(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const response = await fetch(`${api}/api/session`);
        if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
        const payload = (await response.json()) as SessionResponse;
        if (cancelled) return;
        const defaultEffort = payload.defaultReasoningEffort;
        const defaultModel = payload.defaultCodexModel;
        const defaultMode = (payload.defaultScratchMode ?? "voice") as ScratchMode;
        const tts = payload.tts;
        const stt = payload.stt;
        const livekit = payload.livekit;
        setSpeechProjectionEnabled(payload.features?.speechProjection ?? true);
        setProgressSoundsEnabled(payload.features?.progressSounds ?? false);
        setProgressSpeechEnabled(payload.features?.progressSpeech ?? false);
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
        if (payload.session.activeTurn?.status === "running") {
          reattachActiveTurn(payload.session.activeTurn);
        } else {
          setTurnPending(false);
        }
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
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.reasoningEffort", voiceSafeReasoningEffort);
  }, [settingsHydrated, voiceSafeReasoningEffort]);

  useEffect(() => {
    if (!chartOpen || !chartState || !selectedChartDeltaId) {
      setArtifactPreview(null);
      return;
    }
    const selected = chartState.deltas.find((delta) => delta.id === selectedChartDeltaId);
    if (!selected) {
      setArtifactPreview(null);
      return;
    }
    void loadArtifactPreview(selected.conversationArtifactId);
  }, [chartOpen, chartState, selectedChartDeltaId]);

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
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.codexModel", codexModel);
  }, [settingsHydrated, codexModel]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.scratchMode", scratchMode);
  }, [settingsHydrated, scratchMode]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.voiceCaveman", String(voiceCaveman));
  }, [settingsHydrated, voiceCaveman]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.ttsProvider", ttsProvider);
  }, [settingsHydrated, ttsProvider]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.sttProvider", sttProvider);
  }, [settingsHydrated, sttProvider]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.transportProvider", transportProvider);
  }, [settingsHydrated, transportProvider]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeStoredSetting("mortic.settingsVersion", SETTINGS_VERSION);
    writeStoredSetting("mortic.inputPolicy", inputPolicy);
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
    const projectViewSeq = projectViewSeqRef.current;
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
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectState(payload);
      if (chartOpen || approveItemIds.length > 0) {
        void refreshProjectChart({ preserveSelection: chartOpen });
      }
    } catch (error) {
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function archiveCurrentSession() {
    if (projectPending || pending) return;
    const projectViewSeq = projectViewSeqRef.current;
    setProjectPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/session/archive`, {
        method: "POST"
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Archive session failed");
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectState(payload);
    } catch (error) {
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function runProjectAction(path: string, errorMessage: string) {
    if (projectPending || pending) return;
    const projectViewSeq = projectViewSeqRef.current;
    setProjectPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}${path}`, {
        method: "POST"
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? errorMessage);
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectState(payload);
    } catch (error) {
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function patchExtraction(itemId: string, patch: UpdateExtractedItemRequest) {
    if (projectPending) return;
    const projectViewSeq = projectViewSeqRef.current;
    setProjectPending(true);
    setProjectError(null);
    try {
      const response = await fetch(`${api}/api/project/extractions/${encodeURIComponent(itemId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(patch)
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Extraction update failed");
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectState(payload);
      if (patch.status === "approved") setExtractionReviewTab("approved");
      if (patch.status === "approved" || patch.retire || chartOpen) {
        void refreshProjectChart({ preserveSelection: chartOpen });
      }
    } catch (error) {
      if (!isCurrentProjectView(projectViewSeq)) return;
      setProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectPending(false);
    }
  }

  async function updateExtraction(itemId: string, status: ExtractionStatus) {
    await patchExtraction(itemId, { status });
  }

  function beginEditExtraction(item: ExtractedItem) {
    setEditingExtractionId(item.id);
    setEditingExtractionType(item.type);
    setEditingExtractionTitle(item.title);
    setEditingExtractionBody(item.body);
    setEditingExtractionTaskPlan(item.taskPlanMarkdown ?? "");
  }

  function cancelEditExtraction() {
    setEditingExtractionId(null);
    setEditingExtractionType("project_state");
    setEditingExtractionTitle("");
    setEditingExtractionBody("");
    setEditingExtractionTaskPlan("");
  }

  async function saveExtractionEdit(itemId: string) {
    const title = editingExtractionTitle.trim();
    const body = editingExtractionBody.trim();
    const taskPlanMarkdown = editingExtractionTaskPlan.trim();
    if (!title || !body) return;
    await patchExtraction(itemId, { type: editingExtractionType, title, body, taskPlanMarkdown });
    cancelEditExtraction();
  }

  async function retireExtraction(itemId: string) {
    await patchExtraction(itemId, { retire: true });
    cancelEditExtraction();
  }

  async function copyText(text: string) {
    if (!text) return;
    await navigator.clipboard.writeText(text);
  }

  async function copyHandoffText(text: string) {
    if (!text) return;
    const projectViewSeq = projectViewSeqRef.current;
    await copyText(text);
    try {
      const response = await fetch(`${api}/api/project/handoff-copied`, {
        method: "POST"
      });
      const payload = (await response.json()) as ProjectStateResponse & { error?: string };
      if (response.ok && !payload.error && isCurrentProjectView(projectViewSeq)) setProjectState(payload);
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

  async function updateSourceThread(overrideUri?: string) {
    const clean = (overrideUri ?? sourceDraft).trim();
    if (!clean || sourcePending) return;

    projectSourceSwitchPendingRef.current = true;
    const projectViewSeq = invalidateProjectViews();
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
      projectSourceSwitchPendingRef.current = false;
      void refreshProject({ projectViewSeq });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
      projectSourceSwitchPendingRef.current = false;
      void refreshProject({ projectViewSeq });
    } finally {
      projectSourceSwitchPendingRef.current = false;
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
          ? liveModeActive ? "Speak to interrupt" : "M to mute and talk"
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
            ? "Mute ready"
            : activeSttSupported
              ? "M ready"
              : "Unavailable";
  const dockTalkLabel =
    sttPhase === "transcribing"
      ? "Transcribing"
      : liveModeActive
        ? "Live on"
        : recognizing
          ? pending ? "Click M to send" : "Release to send"
          : pending || speechPhase === "speaking" || speechPhase === "buffering"
            ? "Mute + talk"
            : "Hold M";
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
  const draftExtractions = dedupeExtractionItems(projectState?.extractedItems.filter(isExtractionReviewCandidate) ?? [])
    .sort(extractionReviewSort);
  const approvedExtractions = dedupeExtractionItems(projectState?.extractedItems.filter((item) => item.status === "approved") ?? [])
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const reviewExtractions = extractionReviewTab === "approved" ? approvedExtractions : draftExtractions;
  const pendingExtractionCounts = extractionTypeOrder
    .map((type) => ({
      type,
      total: draftExtractions.filter((item) => item.type === type).length
    }))
    .filter((item) => item.total > 0);
  const reviewExtractionCounts = extractionTypeOrder
    .map((type) => ({
      type,
      total: reviewExtractions.filter((item) => item.type === type).length
    }))
    .filter((item) => item.total > 0);
  const projectSources = projectState?.sourceThreads ?? [];
  const scratchSessions = projectState?.scratchSessions ?? [];
  const chartCheckpoints = chartState?.checkpoints ?? [];
  const chartDeltas = chartState?.deltas ?? [];
  const chartArtifacts = chartState?.artifacts ?? [];
  const chartProviderRefs = chartState?.providerRefs ?? [];
  const chartCodexStatus = chartState?.providerAdapters.find((adapter) => adapter.provider === "codex") ?? null;
  const chartTimelineCheckpoints = [...chartCheckpoints].sort((left, right) => right.approvedAt.localeCompare(left.approvedAt));
  const selectedChartCheckpoint = chartCheckpoints.find((checkpoint) => checkpoint.id === selectedChartCheckpointId) ?? chartCheckpoints.at(-1) ?? null;
  const selectedChartDelta = chartDeltas.find((delta) => delta.id === selectedChartDeltaId) ?? null;
  const selectedChartArtifact = selectedChartDelta
    ? chartArtifacts.find((artifact) => artifact.id === selectedChartDelta.conversationArtifactId)
    : null;
  const selectedProviderRefs = selectedChartArtifact
    ? chartProviderRefs.filter((ref) => selectedChartArtifact.providerRefIds.includes(ref.id))
    : [];
  const normalizedChartSearch = normalizeExtractionText(chartSearch);
  const visibleChartDeltas = chartDeltas
    .filter((delta) => !selectedChartCheckpoint || selectedChartCheckpoint.approvedDeltaIds.includes(delta.id))
    .filter((delta) => chartTypeFilter === "all" || delta.type === chartTypeFilter)
    .filter((delta) => {
      if (!normalizedChartSearch) return true;
      const artifact = chartArtifacts.find((candidate) => candidate.id === delta.conversationArtifactId);
      return normalizeExtractionText(`${delta.title} ${delta.body} ${delta.taskPlanMarkdown ?? ""} ${artifact?.title ?? ""}`).includes(normalizedChartSearch);
    });
  const chartDeltaCounts = extractionTypeOrder
    .map((type) => ({
      type,
      total: chartDeltas.filter((delta) => delta.type === type && (!selectedChartCheckpoint || selectedChartCheckpoint.approvedDeltaIds.includes(delta.id))).length
    }))
    .filter((item) => item.total > 0);
  const sourceThreadLabel = session ? redactThreadId(session.threadId) : "No source";
  const recentForkSessions = [...scratchSessions]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);
  const forkSheetScratch = forkSheetSessionId
    ? scratchSessions.find((scratch) => scratch.id === forkSheetSessionId) ?? null
    : null;
  const forkSheetRecord = forkSheetScratch
    ? chartState?.providerForks.find(
        (fork) =>
          fork.scratchSessionId === forkSheetScratch.id ||
          (Boolean(forkSheetScratch.codexScratchThreadId) && fork.providerRefId === forkSheetScratch.codexScratchThreadId)
      ) ?? null
    : null;
  const latestChartDelta = [...chartDeltas].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const latestChartArtifact = latestChartDelta
    ? chartArtifacts.find((artifact) => artifact.id === latestChartDelta.conversationArtifactId) ?? null
    : [...chartArtifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  const latestChartCheckpoint = chartTimelineCheckpoints[0] ?? null;
  const activeProviderReference = activeProjectSession?.codexScratchThreadId
    ? chartProviderRefs.find((ref) => ref.providerRefId === activeProjectSession.codexScratchThreadId || ref.threadId === activeProjectSession.codexScratchThreadId) ?? null
    : activeProjectSource?.codexThreadId
      ? chartProviderRefs.find((ref) => ref.providerRefId === activeProjectSource.codexThreadId || ref.threadId === activeProjectSource.codexThreadId) ?? null
      : null;
  const workspaceProjectTitle = workspaceTitle(projectState?.project.workspacePath ?? activeProjectSource?.workspacePath);
  const storedProjectTitle = projectState?.project.title?.trim();
  const projectDisplayTitle =
    storedProjectTitle && storedProjectTitle !== activeProjectSource?.title
      ? storedProjectTitle
      : workspaceProjectTitle ?? storedProjectTitle ?? "Mortic project";
  const activeForkTitle = activeProjectSource?.title ?? activeProjectSession?.title ?? sourceThreadLabel;
  const activeForkStatus = activeProjectSession?.status ?? (activeProjectSource ? "source" : "unlinked");
  const activeForkAccess = activeProviderReference?.accessPreset ?? activeProjectSession?.mode ?? scratchMode;
  const activeForkPersistence = activeProviderReference
    ? activeProviderReference.ephemeral
      ? "ephemeral"
      : activeProviderReference.persisted
        ? "persisted"
        : "local"
    : activeProjectSession?.ephemeral
      ? "ephemeral"
      : "local";
  const scaffoldStats = [
    { label: "Sources", value: String(projectSources.length || (session ? 1 : 0)) },
    { label: "Forks", value: String(scratchSessions.length) },
    { label: "Drafts", value: String(draftExtractions.length) },
    { label: "Approved", value: String(approvedExtractions.length) }
  ];
  const scaffoldTrace = [
    { label: "Master", value: projectDisplayTitle },
    { label: "Fork", value: activeForkTitle },
    { label: "Artifact", value: latestChartArtifact?.title ?? "Transcript / compile artifact" },
    { label: "Delta", value: latestChartDelta?.title ?? approvedExtractions[0]?.title ?? "No approved delta yet" },
    { label: "Checkpoint", value: latestChartCheckpoint?.title ?? (approvedExtractions.length > 0 ? "Initial canonical checkpoint" : "No canonical checkpoint yet") }
  ];
  const canonicalChartSummary = [
    `${chartCheckpoints.length || (approvedExtractions.length > 0 ? 1 : 0)} checkpoints`,
    `${chartDeltas.length || approvedExtractions.length} deltas`,
    `${chartState?.draftCompilations.length ?? 0} compilations`
  ].join(" · ");
  const primaryExtraction = reviewExtractions[0] ?? null;
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
  const compactTranscript = transcript.slice(-4);
  const latestUserEntry = [...transcript].reverse().find((entry) => entry.role === "user") ?? null;
  const latestAssistantEntry = [...transcript].reverse().find((entry) => entry.role === "assistant") ?? null;
  const compactAssistantEntry = pending ? null : latestAssistantEntry;
  const runtimeErrors = [speechError, state.error, projectError].filter(Boolean);

  return (
    <main className="app-shell command-shell">
      <div className="ambient-void" aria-hidden="true" />
      <header className="command-topbar">
        <div className="brand-cluster">
          <strong>Mortic</strong>
        </div>
        <div className="source-form command-source-form">
          <span className="source-current" title={session?.sourceUri}>
            {activeProjectSource?.title ?? projectState?.project.title ?? "Pick Codex thread"}
          </span>
          <ThreadPicker
            api={api}
            currentThreadId={session?.threadId}
            disabled={sourcePending}
            onSelect={(uri) => {
              setSourceDraft(uri);
              void updateSourceThread(uri);
            }}
          />
        </div>
        <div className="topbar-status">
          <span className={`status-dot ${session?.codex.available ? "ok" : "bad"}`} />
          <span>{session?.codex.available ? session.codex.version ?? "Codex connected" : session?.codex.error ?? "Codex unavailable"}</span>
        </div>
      </header>

      <section className="workspace command-workspace">
        <SideRail
          projectTitle={projectDisplayTitle}
          refreshProject={refreshProject}
          projectPending={projectPending}
          openProjectChart={openProjectChart}
          chartPending={chartPending}
          openCanonicalState={openCanonicalState}
          canonicalStatePending={canonicalStatePending}
          scaffoldStats={scaffoldStats}
          activeForkStatus={activeForkStatus}
          activeForkTitle={activeForkTitle}
          activeForkPersistence={activeForkPersistence}
          activeForkAccess={activeForkAccess}
          activeProviderReference={activeProviderReference}
          activeProjectSession={activeProjectSession}
          activeProjectSource={activeProjectSource}
          session={session}
          scaffoldTrace={scaffoldTrace}
          scratchSessionsCount={scratchSessions.length}
          recentForkSessions={recentForkSessions}
          onSelectFork={openForkSheet}
          canonicalChartSummary={canonicalChartSummary}
          latestChartCheckpoint={latestChartCheckpoint}
          latestChartDelta={latestChartDelta}
          latestChartArtifact={latestChartArtifact}
          approvedExtractions={approvedExtractions}
          commitCurrentSession={() => commitCurrentSession()}
          pending={pending}
          transcriptLength={transcript.length}
        />

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

          {runtimeErrors.length > 0 && (
            <div className="notice-row">
              {runtimeErrors.map((message) => <div key={message} className="notice error">{message}</div>)}
            </div>
          )}

          <section className="agent-canvas" aria-label="Mortic voice agent">
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
                    <details className="compact-notes">
                      <summary>{entryNotesLabel(compactAssistantEntry)}</summary>
                      <MarkdownContent markdown={compactAssistantEntry.notesText} />
                    </details>
                  )}
                </section>
              )}
              {queuedTurnPreview && (
                <section className="compact-turn compact-queued">
                  <span>Queued</span>
                  <p>{queuedTurnPreview}</p>
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
              >
                <span>{recognizing ? "Listening" : "M"}</span>
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
              <button type="submit" disabled={!draft.trim() || sparkBlocked}>{pending ? "Queue" : "Send"}</button>
            </form>
          </section>
        </section>

        <InsightsPanel
          draftExtractions={draftExtractions}
          openProjectChart={openProjectChart}
          chartPending={chartPending}
          openCanonicalState={openCanonicalState}
          canonicalStatePending={canonicalStatePending}
          approveAllDrafts={() => commitCurrentSession(draftExtractions.map((item) => item.id))}
          projectPending={projectPending}
          pending={pending}
          pendingExtractionCounts={pendingExtractionCounts}
          extractionPreview={extractionPreview}
          onOpenReview={() => setExtractionReviewOpen(true)}
          handoffStateLabel={handoffStateLabel}
          generateHandoff={generateHandoff}
          handoffPending={handoffPending}
          transcriptLength={transcript.length}
          handoffPreview={handoffPreview}
          tokenBudget={tokenBudget}
          futureSavingsLine={futureSavingsLine}
          copyHandoffText={copyHandoffText}
          shortHandoff={shortHandoff}
          fullHandoff={fullHandoff}
          handoff={handoff}
          onOpenHandoffReview={() => setHandoffReviewOpen(true)}
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

      {extractionReviewOpen && (
        <ExtractionReviewModal
          extractionReviewTab={extractionReviewTab}
          setExtractionReviewTab={setExtractionReviewTab}
          approvedExtractions={approvedExtractions}
          draftExtractions={draftExtractions}
          reviewExtractions={reviewExtractions}
          reviewExtractionCounts={reviewExtractionCounts}
          editingExtractionId={editingExtractionId}
          editingExtractionType={editingExtractionType}
          setEditingExtractionType={setEditingExtractionType}
          editingExtractionTitle={editingExtractionTitle}
          setEditingExtractionTitle={setEditingExtractionTitle}
          editingExtractionBody={editingExtractionBody}
          setEditingExtractionBody={setEditingExtractionBody}
          editingExtractionTaskPlan={editingExtractionTaskPlan}
          setEditingExtractionTaskPlan={setEditingExtractionTaskPlan}
          beginEditExtraction={beginEditExtraction}
          cancelEditExtraction={cancelEditExtraction}
          saveExtractionEdit={saveExtractionEdit}
          retireExtraction={retireExtraction}
          updateExtraction={updateExtraction}
          openProjectChart={openProjectChart}
          openCanonicalState={openCanonicalState}
          chartPending={chartPending}
          canonicalStatePending={canonicalStatePending}
          projectPending={projectPending}
          onClose={() => setExtractionReviewOpen(false)}
        />
      )}

      {handoffReviewOpen && (
        <HandoffReviewModal
          draftExtractions={draftExtractions}
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

      {chartOpen && chartState && (
        <ChartModal
          chartState={chartState}
          chartPending={chartPending}
          chartSearch={chartSearch}
          setChartSearch={setChartSearch}
          chartTypeFilter={chartTypeFilter}
          setChartTypeFilter={setChartTypeFilter}
          chartCodexStatus={chartCodexStatus}
          chartCheckpoints={chartCheckpoints}
          chartTimelineCheckpoints={chartTimelineCheckpoints}
          chartDeltas={chartDeltas}
          visibleChartDeltas={visibleChartDeltas}
          chartDeltaCounts={chartDeltaCounts}
          chartArtifacts={chartArtifacts}
          selectedChartCheckpoint={selectedChartCheckpoint}
          selectedChartDelta={selectedChartDelta}
          selectedChartArtifact={selectedChartArtifact}
          selectedProviderRefs={selectedProviderRefs}
          artifactPreview={artifactPreview}
          artifactPending={artifactPending}
          setSelectedChartCheckpointId={setSelectedChartCheckpointId}
          setSelectedChartDeltaId={setSelectedChartDeltaId}
          refreshProjectChart={refreshProjectChart}
          copyText={copyText}
          onClose={() => setChartOpen(false)}
        />
      )}

      {canonicalStateOpen && canonicalState && (
        <CanonicalStateModal
          canonicalState={canonicalState}
          copyText={copyText}
          onClose={() => setCanonicalStateOpen(false)}
        />
      )}

      {forkSheetScratch && (
        <ForkActionSheet
          key={forkSheetScratch.id}
          scratch={forkSheetScratch}
          fork={forkSheetRecord}
          pending={forkAccessPending || chartPending}
          onSelect={(providerRefId, continuation) => void setForkAccess(providerRefId, continuation)}
          onClose={() => setForkSheetSessionId(null)}
        />
      )}

      {onboarding && !onboarding.ready && (
        <OnboardingScreen status={onboarding} busy={onboardingBusy} onRecheck={() => void refreshOnboarding()} />
      )}
    </main>
  );
}
