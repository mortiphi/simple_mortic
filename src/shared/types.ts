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
  forkCheckpoint?: ForkCheckpoint;
  codex: CodexStatus;
  runtimeContext?: RuntimeContextRestore;
  activeTurn?: TurnRun;
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

export const extractedItemTypes = ["project_state", "prioritization", "task", "risk", "backlog"] as const;

export type ExtractedItemType = (typeof extractedItemTypes)[number];

export const extractionStatuses = ["draft", "approved", "dismissed", "merged"] as const;

export type ExtractionStatus = (typeof extractionStatuses)[number];

export const canonicalLifecycleActions = [
  "create",
  "update",
  "append_evidence",
  "resolve",
  "drop",
  "supersede",
  "reopen",
  "no_op"
] as const;

export type CanonicalLifecycleAction = (typeof canonicalLifecycleActions)[number];

export const canonicalLifecycleStatuses = [
  "open",
  "in_progress",
  "resolved",
  "dropped",
  "superseded",
  "stale"
] as const;

export type CanonicalLifecycleStatus = (typeof canonicalLifecycleStatuses)[number];

export type CanonicalReconciledItem = {
  id: string;
  type: ExtractedItemType;
  title: string;
  status: CanonicalLifecycleStatus;
  score: number;
};

export const scratchSessionStatuses = ["active", "draft", "committed", "archived", "discarded"] as const;

export type ScratchSessionStatus = (typeof scratchSessionStatuses)[number];

export type ExtractedItem = {
  id: string;
  projectId: string;
  sourceThreadId: string;
  scratchSessionId: string;
  sourceCompilationId?: string;
  sourceTurnId?: string;
  type: ExtractedItemType;
  title: string;
  body: string;
  taskPlanMarkdown?: string;
  confidence: number;
  status: ExtractionStatus;
  delta?: "new" | "changed" | "unchanged";
  canonicalItemId?: string;
  targetCanonicalItemId?: string | null;
  lifecycleAction?: CanonicalLifecycleAction;
  lifecycleStatusBefore?: CanonicalLifecycleStatus | null;
  lifecycleStatusAfter?: CanonicalLifecycleStatus;
  canonicalOperation?: string;
  mergeStrategy?: string;
  reconcilesWith?: CanonicalReconciledItem[];
  reconciliationReason?: string;
  conflicts?: string[];
  evidenceSource?: "transcript" | "handoff_short" | "handoff_full" | "handoff" | "session" | "production_json" | "production_md" | "code_state";
  selectionReason?: string;
  createdAt: string;
  updatedAt: string;
  transcriptAnchor?: {
    entryId: string;
    role: TranscriptRole;
    createdAt: string;
    quote?: string;
  };
  mergedIntoId?: string;
};

export type ProviderName = "codex";

export type ProviderForkKind = "source" | "scratch" | "persisted" | "unknown";

export type ProviderActionAvailability = {
  available: boolean;
  disabledReason?: string;
};

export type ProviderReference = {
  id: string;
  provider: ProviderName;
  providerRefId: string;
  accountId?: string;
  conversationId?: string;
  threadId?: string;
  forkKind: ProviderForkKind;
  ephemeral: boolean;
  persisted: boolean;
  cwd?: string;
  accessPreset?: string;
  capabilities: string[];
  openTarget?: string;
  actions: {
    resume: ProviderActionAvailability;
    fork: ProviderActionAvailability;
    archive: ProviderActionAvailability;
  };
  createdAt: string;
  updatedAt: string;
};

export const providerForkStatuses = ["active", "archived", "stale"] as const;

export type ProviderForkStatus = (typeof providerForkStatuses)[number];

// Persisted fork-tree record (provider_forks.json). Provider thread ids stay
// adapter metadata here; canonical chart identity never depends on them.
export type ProviderForkRecord = {
  id: string;
  projectId: string;
  provider: ProviderName;
  providerRefId: string;
  threadId?: string;
  parentProviderRefId?: string;
  forkKind: ProviderForkKind;
  status: ProviderForkStatus;
  title?: string;
  sourceThreadId?: string;
  scratchSessionId?: string;
  requestedAccessPreset?: string;
  effectiveAccessPreset?: string;
  accessCanChange?: boolean;
  accessDisabledReason?: string;
  accessSource?: string;
  accessGrantedAt?: string;
  createdAt: string;
  updatedAt: string;
};

// Continuation modes a user can request for a fork from the action sheet.
// "scratch" is the safe default; "resume-in-main" sends future work to the
// source thread and always needs explicit confirmation in the UI.
export const providerForkContinuations = ["scratch", "resumable", "resume-in-main"] as const;

export type ProviderForkContinuation = (typeof providerForkContinuations)[number];

export type ProviderForkAccessRequest = {
  providerRefId: string;
  requestedAccessPreset: ProviderForkContinuation;
};

export type ProviderForkAccessResponse = {
  providerForks: ProviderForkRecord[];
};

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

export type ConversationArtifact = {
  id: string;
  projectId: string;
  title: string;
  artifactKind: "scratch-session" | "source-thread" | "import";
  sourceThreadId?: string;
  sourceCheckpointId?: string;
  scratchSessionId?: string;
  transcriptPath?: string;
  handoffPath?: string;
  eventLogPath?: string;
  providerRefIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type DraftCompilation = {
  id: string;
  projectId: string;
  scratchSessionId: string;
  conversationArtifactId: string;
  candidateDeltaIds: string[];
  extractedItemIds: string[];
  coverageReceiptId?: string;
  sourceWindowIds?: string[];
  boundaryStatus?: BoundaryStatus;
  boundaryReason?: string;
  transcriptStartEntryId?: string;
  transcriptEndEntryId?: string;
  transcriptEntryCount?: number;
  transcriptHash?: string;
  basisCheckpointId?: string;
  basisCompilationId?: string;
  basisDraftCompilationIds?: string[];
  summary?: string;
  status: "draft" | "partially-approved" | "approved" | "superseded";
  createdAt: string;
  updatedAt: string;
};

export type BoundaryStatus = "proven" | "anchored" | "uncertain";

export type BoundaryAnchor = {
  provider?: ProviderName;
  providerRefId?: string;
  conversationId?: string;
  threadId?: string;
  messageId?: string;
  turnId?: string;
  entryId?: string;
  createdAt?: string;
  tokenOffset?: number;
  textHash?: string;
  transcriptHash?: string;
  textExcerpt?: string;
};

export type CompilationSourceWindow = {
  id?: string;
  provider?: ProviderName;
  providerRefId?: string;
  conversationId?: string;
  threadId?: string;
  windowKind: "primary" | "reference" | "excluded";
  coveredFrom?: BoundaryAnchor;
  coveredTo: BoundaryAnchor;
  forkedFrom?: {
    providerRefId: string;
    anchor: BoundaryAnchor;
  };
  tokenEstimate?: number;
  transcriptHash?: string;
  boundaryStatus: BoundaryStatus;
  boundaryReason?: string;
};

export type CompilePlan = {
  id?: string;
  mode: "scratch_only" | "parent_remainder" | "lineage" | "custom";
  primaryWindows: CompilationSourceWindow[];
  referenceWindows?: CompilationSourceWindow[];
  excludedWindows?: CompilationSourceWindow[];
  warnings?: string[];
  createdAt?: string;
};

export type CoverageReceipt = {
  id: string;
  projectId: string;
  importId?: string;
  compilationId: string;
  provider: ProviderName;
  providerRefId: string;
  conversationId?: string;
  threadId?: string;
  extractionProviderRefId?: string;
  extractionThreadId?: string;
  extractionBaseThreadId?: string;
  extractionMode?: "scratch_of_scratch" | "source_parallel" | "isolated" | "script";
  planId?: string;
  mode?: CompilePlan["mode"];
  priorReceiptId?: string;
  priorImportId?: string;
  basisCompilationId?: string;
  sourceWindows: CompilationSourceWindow[];
  boundaryStatus: BoundaryStatus;
  boundaryReason?: string;
  status: "draft_imported" | "partially_approved" | "approved" | "reviewed_empty" | "superseded" | "boundary_uncertain";
  approvedDeltaIds?: string[];
  checkpointId?: string;
  checkpointIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type CanonicalDelta = {
  id: string;
  projectId: string;
  stableKey: string;
  version: number;
  type: ExtractedItemType;
  title: string;
  body: string;
  taskPlanMarkdown?: string;
  status: "approved" | "superseded";
  canonicalItemId: string;
  targetCanonicalItemId?: string | null;
  lifecycleAction: CanonicalLifecycleAction;
  lifecycleStatusBefore?: CanonicalLifecycleStatus | null;
  lifecycleStatusAfter: CanonicalLifecycleStatus;
  canonicalOperation?: string;
  mergeStrategy?: string;
  reconcilesWith?: CanonicalReconciledItem[];
  reconciliationReason?: string;
  conflicts?: string[];
  checkpointId: string;
  previousDeltaId?: string;
  sourceExtractedItemId?: string;
  sourceCompilationId?: string;
  conversationArtifactId: string;
  providerRefIds: string[];
  evidenceSource?: ExtractedItem["evidenceSource"];
  evidenceEntryId?: string;
  evidenceQuote?: string;
  localPaths: {
    transcript?: string;
    handoff?: string;
    eventLog?: string;
  };
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalItem = {
  id: string;
  projectId: string;
  type: ExtractedItemType;
  title: string;
  body: string;
  taskPlanMarkdown?: string;
  lifecycleStatus: CanonicalLifecycleStatus;
  latestDeltaId: string;
  deltaIds: string[];
  conversationArtifactId: string;
  providerRefIds: string[];
  evidenceSource?: ExtractedItem["evidenceSource"];
  evidenceEntryId?: string;
  evidenceQuote?: string;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalCheckpoint = {
  id: string;
  projectId: string;
  title: string;
  parentCheckpointId?: string;
  approvedDeltaIds: string[];
  sourceArtifactIds: string[];
  createdAt: string;
  approvedAt: string;
  imported: boolean;
};

export type MorticProject = {
  id: string;
  title: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  canonicalSourceThreadIds: string[];
  activeSourceThreadId?: string;
  activeSourceCheckpointId?: string;
  activeScratchSessionId?: string;
  pendingSourceCheckpoint?: SourceCheckpointProposal;
};

export type SourceCheckpointDetectionSource = "initial" | "handoff-marker" | "manual" | "status-fingerprint";

export type SourceCheckpointProposal = {
  sourceThreadId: string;
  sourceCheckpointId: string;
  derivedFromScratchSessionId: string;
  derivedFromHandoffHash: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  reason: string;
};

export type SourceThreadNode = {
  id: string;
  projectId: string;
  codexThreadId: string;
  title: string;
  description?: string;
  workspacePath: string;
  sourceUri: string;
  createdAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  knownTextPreview?: string;
  knownSummary?: string;
  tags: string[];
  childrenCheckpointIds: string[];
  childrenScratchSessionIds: string[];
};

export type SourceCheckpointNode = {
  id: string;
  projectId: string;
  sourceThreadId: string;
  codexThreadId: string;
  sourceUri: string;
  parentCheckpointId?: string;
  derivedFromScratchSessionId?: string;
  derivedFromHandoffHash?: string;
  title: string;
  createdAt: string;
  observedAt: string;
  lastSeenAt: string;
  detectionSource: SourceCheckpointDetectionSource;
  contextFingerprint?: string;
  childrenScratchSessionIds: string[];
};

export type ScratchSessionNode = {
  id: string;
  projectId: string;
  sourceThreadId: string;
  sourceCheckpointId?: string;
  parentScratchSessionId?: string;
  codexScratchThreadId?: string;
  forkedFromId?: string;
  ephemeral: boolean;
  title: string;
  description?: string;
  summary?: string;
  mode: "scratch" | "branch" | "production";
  status: ScratchSessionStatus;
  workspacePath: string;
  model?: string;
  provider?: string;
  transport?: TransportProvider;
  sttProvider?: SttProvider;
  ttsProvider?: TtsProvider;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  committedAt?: string;
  transcriptPath: string;
  eventLogPath: string;
  handoffPath: string;
  handoffShortPath: string;
  handoffFullPath: string;
  extractedItemsPath: string;
  tags: string[];
};

export type ProductionChart = {
  projectId: string;
  projectTitle: string;
  workspacePath: string;
  currentProjectSummary: string;
  canonicalSourceThreads: Array<{
    id: string;
    title: string;
    sourceUri: string;
  }>;
  projectStateUpdates: ExtractedItem[];
  prioritizationUpdates: ExtractedItem[];
  taskUpdates: ExtractedItem[];
  riskUpdates: ExtractedItem[];
  backlogUpdates: ExtractedItem[];
  linkedScratchSessions: Array<{
    id: string;
    title: string;
    status: ScratchSessionStatus;
  }>;
  linkedSourceThreads: string[];
  lastApprovedHandoff?: string;
  updatedAt: string;
};

export type HandoffReadiness = {
  percentage: number;
  status: "ready-to-commit" | "needs-review" | "unsafe";
  missing: string[];
  signals: {
    hasUserGoal: boolean;
    hasSourceThreadId: boolean;
    hasSessionTitle: boolean;
    hasSessionDescription: boolean;
    hasUsefulSummary: boolean;
    hasExtraction: boolean;
    hasShortHandoff: boolean;
    hasFullHandoff: boolean;
    hasRiskOrQuestionState: boolean;
    transcriptNotEmpty: boolean;
    noActiveTurnRunning: boolean;
    noForkSafetyWarning: boolean;
  };
};

export type ProjectStateResponse = {
  project: MorticProject;
  sourceThreads: SourceThreadNode[];
  sourceCheckpoints: SourceCheckpointNode[];
  scratchSessions: ScratchSessionNode[];
  extractedItems: ExtractedItem[];
  production: ProductionChart;
  readiness: HandoffReadiness;
};

export type ProjectCanonicalStateResponse = {
  projectDir: string;
  productionPath: string;
  productionMarkdownPath: string;
  extractedItemsPath: string;
  extractedItemsMarkdownPath: string;
  project: MorticProject;
  sourceThreads: SourceThreadNode[];
  sourceCheckpoints: SourceCheckpointNode[];
  scratchSessions: ScratchSessionNode[];
  extractedItems: ExtractedItem[];
  production: ProductionChart;
  productionMarkdown: string;
  extractedItemsMarkdown: string;
};

export type ProjectChartResponse = {
  projectDir: string;
  chartPath: string;
  project: MorticProject;
  sourceThreads: SourceThreadNode[];
  sourceCheckpoints: SourceCheckpointNode[];
  checkpoints: CanonicalCheckpoint[];
  canonicalItems: CanonicalItem[];
  deltas: CanonicalDelta[];
  draftCompilations: DraftCompilation[];
  coverageReceipts: CoverageReceipt[];
  artifacts: ConversationArtifact[];
  providerRefs: ProviderReference[];
  providerForks: ProviderForkRecord[];
  providerAdapters: ProviderAdapterStatus[];
};

export type ProjectCoverageLatestResponse = {
  projectId: string;
  coverageReceipts: CoverageReceipt[];
  receipt?: CoverageReceipt;
};

export type ProjectArtifactPreviewResponse = {
  artifact: ConversationArtifact;
  providerRefs: ProviderReference[];
  transcriptPreview?: string;
  handoffPreview?: string;
  eventPreview?: string;
  paths: {
    transcript?: string;
    handoff?: string;
    eventLog?: string;
  };
};

export type ApproveCompilationRequest = {
  candidateDeltaIds?: string[];
  extractedItemIds?: string[];
};

export type ApproveCompilationResponse = ProjectChartResponse & {
  projectState: ProjectStateResponse;
  checkpoint?: CanonicalCheckpoint;
  approvedDeltaIds: string[];
};

export type DraftCompilationImportCandidate = {
  id?: string;
  type: ExtractedItemType | "project_state_update" | "prioritisation_update" | "prioritization_update" | "task_update" | "risk_update" | "backlog_update";
  title: string;
  body: string;
  taskPlanMarkdown?: string;
  confidence?: number;
  delta?: ExtractedItem["delta"];
  canonicalItemId?: string;
  targetCanonicalItemId?: string | null;
  lifecycleAction?: CanonicalLifecycleAction;
  lifecycleStatusBefore?: CanonicalLifecycleStatus | null;
  lifecycleStatusAfter?: CanonicalLifecycleStatus;
  canonicalOperation?: string;
  mergeStrategy?: string;
  reconcilesWith?: CanonicalReconciledItem[];
  reconciliationReason?: string;
  conflicts?: string[];
  evidenceQuote?: string;
  selectionReason?: string;
};

export type DraftCompilationImportRequest = {
  schemaVersion?: "1.0";
  importId?: string;
  title?: string;
  summary?: string;
  provider?: ProviderName;
  providerRefId?: string;
  conversationId?: string;
  threadId?: string;
  sourceUri?: string;
  baseCheckpointId?: string;
  basisCompilationId?: string;
  priorImportId?: string;
  priorBoundaryReceiptId?: string;
  compilePlan?: CompilePlan;
  sourceWindows?: CompilationSourceWindow[];
  coveredFrom?: BoundaryAnchor;
  coveredTo?: BoundaryAnchor;
  boundaryStatus?: BoundaryStatus;
  boundaryReason?: string;
  transcriptExcerpt?: string;
  transcriptHash?: string;
  createdAt?: string;
  candidateDeltas: DraftCompilationImportCandidate[];
};

export type DraftCompilationImportResponse = ProjectChartResponse & {
  projectState: ProjectStateResponse;
  compilation: DraftCompilation;
  createdItems: ExtractedItem[];
  coverageReceipt: CoverageReceipt;
  artifact?: ConversationArtifact;
};

export type CommitSessionRequest = {
  approveItemIds?: string[];
};

export type CommitSessionResponse = ProjectStateResponse & {
  committedSession: ScratchSessionNode;
  createdItems: ExtractedItem[];
};

export type UpdateExtractedItemRequest = {
  status?: ExtractionStatus;
  type?: ExtractedItemType;
  title?: string;
  body?: string;
  taskPlanMarkdown?: string;
  mergeIntoId?: string;
  retire?: boolean;
};
