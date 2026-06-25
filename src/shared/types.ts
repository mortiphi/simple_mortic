export const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];

export type AppServerModelOption = {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  isDefault: boolean;
  inputModalities: string[];
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description?: string;
  }>;
  defaultReasoningEffort: ReasoningEffort;
  serviceTiers: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  defaultServiceTier?: string | null;
};

export type AppServerSandboxPolicySummary = {
  type: "readOnly" | "workspaceWrite" | "externalSandbox" | "dangerFullAccess" | "unknown";
  networkAccess?: boolean | "enabled" | "restricted";
  writableRoots?: string[];
  displayName: string;
  detail?: string;
  dangerous: boolean;
};

export type AppServerApprovalPolicySummary = {
  value: string;
  displayName: string;
  editable: boolean;
};

export type AppServerToolingSummary = {
  namespaceTools?: boolean;
  imageGeneration?: boolean;
  webSearch?: boolean;
  mcpStatus?: "surfaced" | "not-surfaced";
  mcpServers?: Array<{
    name: string;
    status?: string;
  }>;
};

export type AppServerConfigMetadata = {
  source: "app-server" | "fallback";
  error?: string;
  models: AppServerModelOption[];
  selectedModel: string;
  defaultModel: string;
  selectedReasoningEffort: ReasoningEffort;
  selectedServiceTier?: string | null;
  sandboxPolicy: AppServerSandboxPolicySummary;
  approvalPolicy: AppServerApprovalPolicySummary;
  tooling: AppServerToolingSummary;
  runtime: {
    activityBuffer: boolean;
    trace: boolean;
    progressSpeech: boolean;
    outputSchema: boolean;
  };
};

export const codexFilesystemModes = ["readOnly", "workspaceWrite", "dangerFullAccess"] as const;
export type CodexFilesystemMode = (typeof codexFilesystemModes)[number];

export const codexApprovalPolicies = ["never", "on-request", "on-failure"] as const;
export type CodexApprovalPolicy = (typeof codexApprovalPolicies)[number];

export const codexAccessPresets = ["ask", "approve", "full"] as const;
export type CodexAccessPreset = (typeof codexAccessPresets)[number];

export type CodexRuntimePolicy = {
  filesystem: CodexFilesystemMode;
  networkAccess: boolean;
  approvalPolicy: CodexApprovalPolicy;
};

export const scratchModes = ["voice", "text"] as const;

export type ScratchMode = (typeof scratchModes)[number];

export const ttsProviders = ["inworld-ws", "deepgram", "elevenlabs-ws", "elevenlabs", "browser"] as const;

export type TtsProvider = (typeof ttsProviders)[number];

export const sttProviders = ["deepgram-stt", "inworld-stt", "whisper", "browser"] as const;

export type SttProvider = (typeof sttProviders)[number];

export const transportProviders = ["local-browser", "livekit-webrtc"] as const;

export type TransportProvider = (typeof transportProviders)[number];

export const inputPolicies = ["push_to_talk", "live"] as const;

export type InputPolicy = (typeof inputPolicies)[number];

export type TransportState = "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";

export type CaptureState = "muted" | "armed" | "capturing" | "segmenting" | "finalizing";

export type AgentState = "warming" | "listening" | "transcribing" | "thinking" | "speaking" | "interrupted" | "error" | "idle";

export type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptEntry = {
  id: string;
  role: TranscriptRole;
  text: string;
  spokenText?: string;
  notesText?: string;
  sourcesText?: string;
  rawText?: string;
  parserMode?: "ndjson" | "schema" | "invalid";
  parserError?: string;
  createdAt: string;
  reasoningEffort?: ReasoningEffort;
  scratchMode?: ScratchMode;
  failed?: boolean;
};

export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

export type TurnLogEntry = {
  id: string;
  at: string;
  elapsedMs: number;
  label: string;
  detail?: string;
};

export type TurnMetrics = {
  transcriptBytes?: number;
  promptBytes?: number;
  promptTokensEstimate?: number;
  serverAcceptMs?: number;
  appTurnStartMs?: number;
  firstDeltaMs?: number;
  firstClientDeltaMs?: number;
  modelWaitMs?: number;
  outputMs?: number;
  firstVisibleTextMs?: number;
  firstSpeakableTextMs?: number;
  firstSpeechQueuedMs?: number;
  firstTtsRequestMs?: number;
  firstTtsResolvedMs?: number;
  firstSpeechStartMs?: number;
  firstSpeechEndMs?: number;
  ttsConnectMs?: number;
  firstAudioChunkMs?: number;
  firstAudioPlayMs?: number;
  audioBufferUnderruns?: number;
  ttsCloseCode?: number;
  ttsCloseReason?: string;
  finalTextMs?: number;
  speechAfterFinalMs?: number;
  codexLatencyMs?: number;
  totalMs?: number;
  streamedChars?: number;
  finalChars?: number;
  queuedChars?: number;
  spokenChars?: number;
  queuedRanges?: string;
  spokenRanges?: string;
  spokenChunks?: number;
  ttsProvider?: TtsProvider;
  ttsError?: string;
  ttsProviderStatus?: string;
  bargeInStartedMs?: number;
  bargeInAudioStopMs?: number;
  bargeInCaptureStartMs?: number;
  bargeInFirstMicFrameMs?: number;
  bargeInFirstSpeechDetectedMs?: number;
  bargeInQueuedMs?: number;
  sttProvider?: SttProvider;
  sttSegmentCount?: number;
  sttPayloadBytes?: number;
  recordingDurationMs?: number;
  recordingStartedAt?: string;
  recordingStoppedAt?: string;
  firstSpeechDetectedMs?: number;
  firstInterimTranscriptMs?: number;
  firstFinalTranscriptMs?: number;
  finalSttReadyMs?: number;
  sendAfterSpeechMs?: number;
  recognitionErrors?: string;
  interruptionLatencyMs?: number;
  firstAppServerActivityMs?: number;
  transportProvider?: TransportProvider;
  transportState?: TransportState;
  transportPacketLoss?: number;
  transportJitterMs?: number;
  transportRttMs?: number;
  transportReconnects?: number;
  transportTrackState?: string;
  transportMuted?: boolean;
  transportAudioLevel?: number;
};

export type TurnRun = {
  id: string;
  status: TurnStatus;
  userText: string;
  reasoningEffort: ReasoningEffort;
  codexModel: string;
  serviceTier?: string | null;
  codexRuntimePolicy?: CodexRuntimePolicy;
  scratchMode: ScratchMode;
  voiceCaveman?: boolean;
  createdAt: string;
  updatedAt: string;
  logs: TurnLogEntry[];
  metrics: TurnMetrics;
  appServerTrace?: AppServerTrace;
  progressTrace?: ProgressSpeechTrace;
  error?: string;
  responseEntryId?: string;
};

export type AppServerActivityKind =
  | "reasoning"
  | "plan"
  | "diff"
  | "command"
  | "tool"
  | "search"
  | "file"
  | "assistant"
  | "turn"
  | "system";

export type AppServerActivity = {
  id: string;
  elapsedMs: number;
  kind: AppServerActivityKind;
  label: string;
  detail?: string;
  itemType?: string;
  itemId?: string;
  method?: string;
  display: boolean;
};

export type AppServerTraceRawNotification = {
  elapsedMs: number;
  method: string;
  turnId?: string;
  itemType?: string;
  itemId?: string;
  detail?: string;
};

export type AppServerTraceMappedEvent = {
  elapsedMs: number;
  kind: string;
  label: string;
  itemType?: string;
  detail?: string;
};

export type AppServerTraceDecision = {
  elapsedMs: number;
  label: string;
  decision: "eligible" | "spoken" | "suppressed";
  reason?: string;
  speakableText?: string;
};

export type AppServerTrace = {
  enabled: boolean;
  rawNotifications: AppServerTraceRawNotification[];
  mappedEvents: AppServerTraceMappedEvent[];
  activities: AppServerActivity[];
  decisions: AppServerTraceDecision[];
  firstAssistantDeltaMs?: number;
  firstActivityMs?: number;
  spokenStatuses: string[];
  verdict?: "pass" | "warn" | "fail";
  reasons?: string[];
};

export type ProgressSpeechTrace = AppServerTrace;

export type CodexStatus = {
  available: boolean;
  path?: string;
  version?: string;
  error?: string;
};

export type FilesystemPermissionMode = "read-only" | "workspace-write" | "danger-full-access" | "unknown";

export type RuntimeNetworkPolicy = "enabled" | "disabled" | "unknown";

export type RuntimeApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted" | "unknown";

export type RuntimePermissionProfile = {
  filesystem: FilesystemPermissionMode;
  workspaceRoots: string[];
  network: RuntimeNetworkPolicy;
  approval: RuntimeApprovalPolicy;
};

export type RuntimeContextSnapshot = {
  threadId: string;
  cwd: string;
  workspaceRoots: string[];
  permissionProfile: RuntimePermissionProfile;
  model?: string;
  modelProvider?: string;
  reasoningEffort?: ReasoningEffort;
  originator?: string;
  source?: string;
  threadSource?: string;
  cliVersion?: string;
  capturedAt: string;
  rolloutPath?: string;
};

export type RuntimeContextRestoreStatus = "restored" | "fallback" | "needs-confirmation";

export type RuntimeContextAuditEntry = {
  at: string;
  type: string;
  detail?: string;
};

export type RuntimeContextRestore = {
  status: RuntimeContextRestoreStatus;
  trusted: boolean;
  sameMachineUser: boolean;
  effectiveCwd: string;
  recordedCwd?: string;
  workspaceRoots: string[];
  requested: RuntimePermissionProfile;
  restored?: RuntimeContextSnapshot;
  reason: string;
  prompt?: string;
  audit: RuntimeContextAuditEntry[];
};

export type QueuedTurn = {
  id: string;
  status: "queued" | "draining";
  text: string;
  createdAt: string;
  updatedAt: string;
  sourceUri: string;
  threadId: string;
  sourceClientId?: string;
  sourceSurface?: ClientSurface;
  request: TurnRequest;
};

export type MorticSession = {
  id: string;
  sourceUri: string;
  threadId: string;
  createdAt: string;
  updatedAt: string;
  clearedAt?: string;
  transcript: TranscriptEntry[];
  handoff?: string;
  handoffShort?: string;
  handoffFull?: string;
  composerDraft?: string;
  forkCheckpoint?: ForkCheckpoint;
  codex: CodexStatus;
  runtimeContext?: RuntimeContextRestore;
  activeTurn?: TurnRun;
  queuedTurn?: QueuedTurn;
};

export const clientSurfaces = ["overlay", "app", "browser"] as const;
export type ClientSurface = (typeof clientSurfaces)[number];

export const audioLeasePhases = ["idle", "listening", "transcribing", "buffering", "speaking"] as const;
export type AudioLeasePhase = (typeof audioLeasePhases)[number];

export type SessionSourceIdentity = {
  projectName: string;
  workspacePath: string;
  threadName: string;
  threadId: string;
  sourceUri: string;
};

export type MorticPreferences = {
  initialized: boolean;
  codexModel: string;
  reasoningEffort: ReasoningEffort;
  serviceTier?: string | null;
  codexAccessPreset: CodexAccessPreset;
  scratchMode: ScratchMode;
  shortSpokenReplies: boolean;
  transportProvider: TransportProvider;
  sttProvider: SttProvider;
  ttsProvider: TtsProvider;
  overlayHintDismissed: boolean;
};

export type AudioLeaseState = {
  ownerClientId?: string;
  ownerSurface?: ClientSurface;
  pendingClientId?: string;
  pendingSurface?: ClientSurface;
  phase: AudioLeasePhase;
  epoch: number;
};

export type SessionSnapshot = SessionResponse & {
  revision: number;
  reason: string;
  sourceIdentity: SessionSourceIdentity;
  preferences: MorticPreferences;
  audioLease: AudioLeaseState;
};

export type SessionStreamEvent =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "audio-command"; targetClientId: string; command: "stop"; reason: "interrupt" | "barge-in" | "hide" };

export type SessionUiPatch = {
  composerDraft?: string;
};

export type MorticPreferencesPatch = Partial<Omit<MorticPreferences, "initialized">> & {
  initialized?: boolean;
};

export type ClientPresenceRequest = {
  clientId: string;
  surface: ClientSurface;
  focused: boolean;
  visible: boolean;
  audioPhase?: AudioLeasePhase;
};

export type AudioCommandRequest = {
  clientId: string;
  surface: ClientSurface;
  command: "interrupt" | "barge-in" | "hide";
};

export type SessionResponse = {
  session: MorticSession;
  runtimeContext?: RuntimeContextRestore;
  defaultReasoningEffort: ReasoningEffort;
  defaultCodexModel: string;
  defaultScratchMode?: ScratchMode;
  features?: {
    speechProjection: boolean;
    progressSounds: boolean;
    progressSpeech: boolean;
    progressSpeechTrace: boolean;
    appServerActivity: boolean;
    appServerTrace: boolean;
    voiceOutputSchema: boolean;
  };
  appServerConfig?: AppServerConfigMetadata;
  tts: TtsStatus;
  stt: SttStatus;
  livekit: LiveKitStatus;
};

export type ForkCheckpoint = {
  sourceThreadId: string;
  scratchThreadId: string;
  forkedAt: string;
  sourceSummaryAtFork?: string;
  checkpointInstruction?: string;
  firstScratchTurnId?: string;
};

export type TtsStatus = {
  defaultProvider: TtsProvider;
  availableProviders: TtsProvider[];
  inworldConfigured: boolean;
  inworldVoiceId?: string;
  inworldModelId?: string;
  deepgramConfigured: boolean;
  deepgramModelId?: string;
  elevenLabsConfigured: boolean;
  elevenLabsVoiceId?: string;
  elevenLabsModelId?: string;
};

export type SttStatus = {
  defaultProvider: SttProvider;
  availableProviders: SttProvider[];
  deepgramConfigured: boolean;
  deepgramModel?: string;
  inworldConfigured: boolean;
  inworldModel?: string;
  openAIConfigured: boolean;
  whisperModel?: string;
  maxPayloadBytes?: number;
};

export type LiveKitStatus = {
  configured: boolean;
  url?: string;
  defaultTransport: TransportProvider;
  availableTransports: TransportProvider[];
  error?: string;
};

export type LiveKitTokenRequest = {
  roomName?: string;
  identity?: string;
};

export type LiveKitTokenResponse = {
  configured: boolean;
  url?: string;
  token?: string;
  roomName?: string;
  identity?: string;
  expiresInSeconds?: number;
  error?: string;
};

export const modelTransitionSafeSaturation = 0.7;
export const modelTransitionWarningSaturation = 0.85;

export type ModelTransitionStatus = "safe" | "warning" | "needs-compaction" | "hard-block";

export type ModelTransitionPreflight = {
  threadId: string;
  status: ModelTransitionStatus;
  inputTokens?: number;
  saturation?: number;
  sourceThreadId?: string;
  scratchThreadId?: string;
  candidateModel: string;
  candidateModelLabel: string;
  candidateModelContextWindow?: number;
  safeBudgetTokens: number;
  hardGateTokens: number;
  modelContextWindowTokens?: number;
  directStartSaturation: number;
  hardGateSaturation: number;
  automaticStartAllowed: boolean;
  manualStartAllowed: boolean;
  compactionRequired: boolean;
  effectiveThreadId?: string;
  compactedForkThreadId?: string;
  sourceModelContextWindow?: number;
  source:
    | "codex-session-token-count"
    | "scratch-token-count"
    | "scratch-status"
    | "tui-footer-status"
    | "unknown-model-window"
    | "missing-codex-session"
    | "missing-token-count"
    | "compacted-fork-token-usage"
    | "compacted-fork-missing-token-usage";
  updatedAt?: string;
  detail: string;
};

export const sparkContextWindowTokens = 127000;
export const sparkContextDirectStartSaturation = modelTransitionSafeSaturation;
export const sparkContextHardGateSaturation = modelTransitionWarningSaturation;
export const sparkContextSafeTokens = Math.floor(sparkContextWindowTokens * sparkContextDirectStartSaturation);
export const sparkContextHardGateTokens = Math.floor(sparkContextWindowTokens * sparkContextHardGateSaturation);

export type SparkContextStatus = ModelTransitionStatus;
export type SparkContextPreflight = ModelTransitionPreflight;

export type SparkContextPreflightResponse = {
  session: MorticSession;
  preflight: SparkContextPreflight;
};

export type SparkContextCompactRequest = {
  confirm: boolean;
  reasoningEffort?: ReasoningEffort;
  codexModel?: string;
  scratchMode?: ScratchMode;
  voiceCaveman?: boolean;
};

export type SparkContextCompactResponse = {
  session: MorticSession;
  before: SparkContextPreflight;
  preflight: SparkContextPreflight;
  compacted: boolean;
  logs: Array<{
    label: string;
    detail?: string;
    elapsedMs: number;
  }>;
};

export type TtsHealthResponse = {
  available: boolean;
  status: "ok" | "not_configured" | "auth_error" | "quota_or_rate_limit" | "timeout" | "network_error" | "server_error" | "unknown_error";
  detail?: string;
  elapsedMs: number;
};

export type ElevenLabsHealthResponse = TtsHealthResponse;

export type DeepgramHealthResponse = TtsHealthResponse;

export type TurnRequest = {
  text: string;
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  serviceTier?: string | null;
  codexRuntimePolicy?: CodexRuntimePolicy;
  scratchMode?: ScratchMode;
  voiceCaveman?: boolean;
  allowModelContextRisk?: boolean;
  allowSparkContextRisk?: boolean;
  sttMetrics?: SttTurnMetrics;
  transportProvider?: TransportProvider;
  inputPolicy?: InputPolicy;
  clientId?: string;
  surface?: ClientSurface;
  transportState?: TransportState;
  transportStats?: {
    packetLoss?: number;
    jitterMs?: number;
    rttMs?: number;
    reconnects?: number;
    trackState?: string;
    muted?: boolean;
    audioLevel?: number;
  };
};

export type PrewarmRequest = {
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  serviceTier?: string | null;
  codexRuntimePolicy?: CodexRuntimePolicy;
  scratchMode: ScratchMode;
  voiceCaveman?: boolean;
  allowModelContextRisk?: boolean;
  allowSparkContextRisk?: boolean;
};

export type PrewarmResponse = {
  session: MorticSession;
  scratchMode: ScratchMode;
  reasoningEffort: ReasoningEffort;
  codexModel: string;
  serviceTier?: string | null;
  voiceCaveman?: boolean;
  prewarmConfirmation?: string;
  prewarmMs: number;
  logs: Array<{
    label: string;
    detail?: string;
    elapsedMs: number;
  }>;
};

export type TtsSynthesisRequest = {
  text: string;
};

export type SttTranscriptionRequest = {
  provider?: SttProvider;
  audioBase64: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
  segmentIndex?: number;
  segmentCount?: number;
  recordingSessionId?: number;
};

export type SttProviderFailure = {
  provider: SttProvider | string;
  message: string;
};

export type SttTranscriptionResponse = {
  text: string;
  provider: SttProvider;
  model: string;
  elapsedMs: number;
  segmentIndex?: number;
  segmentCount?: number;
  fallbackReason?: string;
  failures?: SttProviderFailure[];
};

export type SttTurnMetrics = {
  provider: SttProvider;
  requestedProvider: SttProvider;
  segmentCount: number;
  payloadBytes: number;
  recordingDurationMs: number;
  recordingStartedAt: string;
  recordingStoppedAt: string;
  firstSpeechDetectedMs?: number;
  firstInterimTranscriptMs?: number;
  firstFinalTranscriptMs?: number;
  finalSttReadyMs?: number;
  sendAfterSpeechMs?: number;
  recognitionErrors?: string[];
  fallbackReason?: string;
};

export type AudioHealthRequest = {
  provider: TtsProvider;
  streamedChars: number;
  finalChars?: number;
  queuedChars?: number;
  spokenChars?: number;
  queuedRanges?: string;
  spokenRanges?: string;
  spokenChunks: number;
  ttsError?: string;
  ttsProviderStatus?: string;
  firstClientDeltaMs?: number;
  firstVisibleTextMs?: number;
  firstSpeakableTextMs?: number;
  firstSpeechQueuedMs?: number;
  firstTtsRequestMs?: number;
  firstTtsResolvedMs?: number;
  firstSpeechStartMs?: number;
  firstSpeechEndMs?: number;
  ttsConnectMs?: number;
  firstAudioChunkMs?: number;
  firstAudioPlayMs?: number;
  audioBufferUnderruns?: number;
  ttsCloseCode?: number;
  ttsCloseReason?: string;
  finalTextMs?: number;
  speechAfterFinalMs?: number;
  bargeInStartedMs?: number;
  bargeInAudioStopMs?: number;
  bargeInCaptureStartMs?: number;
  bargeInFirstMicFrameMs?: number;
  bargeInFirstSpeechDetectedMs?: number;
  bargeInQueuedMs?: number;
  interruptionLatencyMs?: number;
};

export type ElevenLabsWsClientMessage =
  | {
      type: "start";
    }
  | {
      type: "text";
      text: string;
      flush?: boolean;
    }
  | {
      type: "flush";
    }
  | {
      type: "finish";
    }
  | {
      type: "cancel";
    };

export type ElevenLabsWsServerMessage =
  | {
      type: "ready";
      elapsedMs: number;
      format: "pcm_16000" | "wav";
    }
  | {
      type: "audio";
      audio: string;
      elapsedMs: number;
      format: "pcm_16000" | "wav";
    }
  | {
      type: "final";
      elapsedMs: number;
    }
  | {
      type: "status";
      status: string;
      detail?: string;
      elapsedMs: number;
    }
  | {
      type: "error";
      error: string;
      status?: ElevenLabsHealthResponse["status"];
      code?: number;
      elapsedMs: number;
    };

export type TurnResponse = {
  turnId: string;
  session: MorticSession;
  serverAcceptMs: number;
};

export type TurnStatusResponse = {
  turn: TurnRun | null;
  session: MorticSession;
  replayText?: string;
  replayUpdatedAt?: string;
};

export type HandoffRequest = {
  reasoningEffort: ReasoningEffort;
  codexModel?: string;
  serviceTier?: string | null;
  codexRuntimePolicy?: CodexRuntimePolicy;
};

export type HandoffResponse = {
  handoff: string;
  shortPrompt: string;
  fullPrompt: string;
  session: MorticSession;
  generatedBy: "codex" | "local";
};

export type SourceThreadRequest = {
  sourceUri: string;
};

export type TurnStreamEvent =
  | {
      type: "snapshot";
      turn: TurnRun | null;
      session: MorticSession;
      replayText?: string;
      replayUpdatedAt?: string;
    }
  | {
      type: "delta";
      turnId: string;
      delta: string;
      text: string;
      scratchMode: ScratchMode;
    }
  | {
      type: "log";
      turn: TurnRun;
    }
  | {
      type: "status";
      turnId: string;
      label: string;
      detail?: string;
      speakable: boolean;
      scratchMode: ScratchMode;
    }
  | {
      type: "voiceActivity";
      turnId: string;
      activity: AppServerActivity;
      scratchMode: ScratchMode;
    }
  | {
      type: "completed" | "failed" | "interrupted";
      turn: TurnRun;
      session: MorticSession;
    };

export type ProviderName = "codex";

export type ProviderThreadSummary = {
  provider: ProviderName;
  threadId: string;
  sourceUri: string;
  threadName?: string;
  cwd?: string;
  source?: string;
  updatedAt: string;
  preview?: string;
};

export type ProviderThreadsResponse = {
  provider: ProviderName;
  threads: ProviderThreadSummary[];
};

export type ProviderAdapterStatus = {
  provider: ProviderName;
  available: boolean;
  path?: string;
  version?: string;
  loginStatus: "logged-in" | "logged-out" | "unknown";
  accountId?: string;
  canStartLogin: boolean;
  loginCommand?: string;
  error?: string;
};

export type SkillSyncAction = "installed" | "upgraded" | "adopted" | "current" | "kept-user-copy" | "error";

export type SkillSyncStatus = {
  skill: string;
  action: SkillSyncAction;
  detail?: string;
  targetDir: string;
};

export type OnboardingStatusResponse = {
  provider: ProviderAdapterStatus;
  skills: SkillSyncStatus[];
  ready: boolean;
};
