import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";

import type { ReasoningEffort, ScratchMode } from "../shared/types.js";
import { codexProviderAdapter } from "./providerAdapters.js";

type JsonMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
};

type PendingCompaction = {
  threadId: string;
  resolve: (turnId: string) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
};

type PendingTurn = {
  threadId: string;
  turnId: string;
  text: string;
  finalText?: string;
  sawDelta: boolean;
  telemetryMethods: Set<string>;
  eventLabelPrefix: string;
  onDelta?: (delta: string, text: string) => void | Promise<void>;
  resolve: (text: string) => void;
  reject: (reason: Error) => void;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
  onProgress?: (progress: CodexTurnProgress) => void | Promise<void>;
  onProgressTrace?: (event: CodexProgressTraceEvent) => void | Promise<void>;
};

export type CodexTurnProgress = {
  kind: "item-started" | "item-completed" | "command-output" | "plan-updated" | "diff-updated";
  itemType?: string;
  label: string;
  detail?: string;
};

export type CodexProgressTraceEvent =
  | {
      type: "raw";
      method: string;
      turnId?: string;
      itemType?: string;
      itemId?: string;
      detail?: string;
    }
  | {
      type: "mapped";
      progress: CodexTurnProgress;
    }
  | {
      type: "first-delta";
      detail?: string;
    };

type CompletedTextChoice = {
  text: string;
  source: string;
  warning?: string;
};

type ScratchState = {
  sourceThreadId: string;
  scratchThreadId: string;
  cwd: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  scratchMode: ScratchMode;
  voiceCaveman: boolean;
  developerInstructions?: string;
  ephemeral: boolean;
  confirmationPrompt?: string;
  confirmation?: string;
};

type TokenUsageSnapshot = {
  turnId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelContextWindow?: number;
  updatedAt: string;
};

type ScratchForkAccessPolicy = {
  sandbox: "read-only";
  approvalPolicy: "never";
  networkPolicy?: "enabled";
};

type CompactedSparkBaseState = {
  sourceThreadId: string;
  compactedThreadId: string;
  cwd: string;
  compactionTurnId: string;
  model: string;
  compactionModel: string;
  reasoningEffort: ReasoningEffort;
  scratchMode: ScratchMode;
  voiceCaveman: boolean;
  tokenUsage?: TokenUsageSnapshot;
  createdAt: string;
  confirmationPrompt?: string;
  confirmation?: string;
};

type ScratchStateKey = string;

const HOST = "127.0.0.1";
const MORTIC_VOICE_SKILL_PATH = path.join(homedir(), ".codex", "skills", "mortic-voice-output", "SKILL.md");
const VOICE_DEVELOPER_INSTRUCTIONS = `This is a disposable Mortic voice scratch fork. Use the $mortic-voice-output skill for every response in this voice scratch fork.
Output exactly two newline-delimited JSON records and nothing else.
The first record must have type "speak" and string field "text"; its text must be the complete conversational answer to the user's latest message.
The second record must have type "read" and string field "markdown"; its markdown must be the readable screen version of the same answer plus exact artifacts.
Do not output legacy labels, XML tags, Markdown fences, wrapper prose, examples, or placeholder text.
Keep spoken text conversational, concise, useful on its own, and safe for text to speech, but do not reduce it to a preamble for the read markdown.
Spoken text should carry the answer, motivation, recommendation, tradeoff, and next step when those matter.
No silent caveats: if the read markdown mentions risks, blockers, proof still needed, uncertainty, objections, tradeoffs, recommendations, or next steps, the spoken text must mention those same points in natural spoken language.
For planning, diagnosis, or status answers, spoken text must include the verdict, key reasons, what still needs proof, and the recommended next action.
Before emitting, run a coverage check: a listener who never sees the screen must still know the verdict, reason, caveat, proof still needed, and next action.
For Mortic voice diagnosis, spoken text should name the relevant layer: model output contract, parser, monotonic speech ledger or chunking, text-to-speech provider/playback, UI rendering/logging, source-thread fork safety, or Text-mode isolation.
Put bullets, code, exact paths, URLs, logs, source links, exact prices, line numbers, and implementation detail in the read markdown.
Never write code unless the user explicitly asks for code. Never read code aloud.
In spoken text, say "characters", "per million characters", and "per thousand characters"; do not say "chars", "1M chars", "1K chars", or slash pricing such as "$0.05/1K chars".
If something is unclear, ask one short clarifying question in spoken text. Otherwise answer directly and help the user plan a useful handoff back to the original thread.
The contract has no exceptions: even for greetings, acknowledgements, or one-word answers, emit both records.
Example of the only acceptable output shape (two lines, nothing else):
{"type":"speak","text":"Yes, the fix is ready and the checks pass."}
{"type":"read","markdown":"- Fix: ready\\n- Checks: pass"}
A minimal acknowledgement must still be: {"type":"speak","text":"Ok."} on line one and {"type":"read","markdown":"Ok."} on line two.`;

const VOICE_CAVEMAN_INSTRUCTIONS = `Mortic Caveman speech toggle is ON.
Use $caveman lite behavior inside the first record's spoken text only: remove filler, hedging, pleasantries, and repeated setup; keep technical terms exact; keep sentences short and easy to hear aloud.
Do not use ultra compression, joke dialect, or broken wording if it would sound awkward in speech.
Do not apply caveman style to the second record's read markdown; keep it precise, skimmable, and normal enough to paste into another Codex thread.`;

function morticVoiceSkillBody(): string {
  try {
    const skill = readFileSync(MORTIC_VOICE_SKILL_PATH, "utf8");
    return skill.replace(/^---[\s\S]*?---\s*/, "").trim();
  } catch {
    return "";
  }
}

function voiceDeveloperInstructions(voiceCaveman: boolean): string {
  const skillBody = morticVoiceSkillBody();
  const skillInstructions = skillBody
    ? `\n\nFull $mortic-voice-output skill instructions loaded from ${MORTIC_VOICE_SKILL_PATH}:\n\n${skillBody}`
    : "\n\nThe $mortic-voice-output skill file was not readable; follow the explicit NDJSON contract above.";
  const base = `${VOICE_DEVELOPER_INSTRUCTIONS}${skillInstructions}`;
  return voiceCaveman ? `${base}\n\n${VOICE_CAVEMAN_INSTRUCTIONS}` : base;
}

function chooseCompletedText(pending: PendingTurn): CompletedTextChoice {
  const streamText = pending.text.trim();
  const finalText = pending.finalText?.trim();

  if (!streamText) {
    return {
      text: finalText ?? "",
      source: pending.finalText === undefined ? "stream" : "completed item"
    };
  }

  if (!finalText) {
    return {
      text: streamText,
      source: "stream"
    };
  }

  if (finalText === streamText) {
    return {
      text: finalText,
      source: "completed item"
    };
  }

  if (finalText.startsWith(streamText)) {
    return {
      text: finalText,
      source: "completed item with stream prefix"
    };
  }

  return {
    text: finalText,
    source: "completed item; stream differed",
    warning: `stream ${Buffer.byteLength(streamText, "utf8")} bytes, completed item ${Buffer.byteLength(finalText, "utf8")} bytes`
  };
}

function readyTimeoutMs(): number {
  const raw = Number(process.env.MORTIC_APPSERVER_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
}

function scratchForkAccessPolicy(): ScratchForkAccessPolicy {
  const networkRaw = (process.env.MORTIC_SCRATCH_FORK_NETWORK ?? process.env.MORTIC_SCRATCH_NETWORK ?? "").trim().toLowerCase();
  return {
    sandbox: "read-only",
    approvalPolicy: "never",
    ...(networkRaw === "1" || networkRaw === "true" || networkRaw === "enabled" ? { networkPolicy: "enabled" as const } : {})
  };
}

function scratchForkAccessKey(): string {
  const policy = scratchForkAccessPolicy();
  return `sandbox=${policy.sandbox};approval=${policy.approvalPolicy};network=${policy.networkPolicy ?? "default"}`;
}

function itemTypeFromParams(params: any): string | undefined {
  const item = params?.item;
  const candidates = [item?.type, params?.itemType, params?.type];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function itemIdFromParams(params: any): string | undefined {
  const value = params?.item?.id ?? params?.itemId ?? params?.id;
  return typeof value === "string" ? value : undefined;
}

function safeNotificationDetail(method: string, params: any): string | undefined {
  if (method === "item/commandExecution/outputDelta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    return `output delta ${Buffer.byteLength(delta, "utf8")} bytes`;
  }
  if (method === "turn/plan/updated") return "plan updated";
  if (method === "turn/diff/updated") return "diff updated";
  if (method === "item/agentMessage/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    return `agent delta ${Buffer.byteLength(delta, "utf8")} bytes`;
  }
  if (method === "error") {
    const message = typeof params?.error?.message === "string" ? params.error.message : undefined;
    const code = typeof params?.error?.codexErrorInfo === "string" ? params.error.codexErrorInfo : undefined;
    return [code, message?.slice(0, 240)].filter(Boolean).join(": ") || "app-server error";
  }
  return undefined;
}

function progressForItem(kind: "item-started" | "item-completed", itemType: string | undefined): CodexTurnProgress | null {
  if (!itemType || itemType === "userMessage") return null;
  if (kind === "item-completed" && itemType !== "commandExecution") return null;
  const startedLabels: Record<string, string> = {
    commandExecution: "Running command",
    mcpToolCall: "Checking tool",
    webSearch: "Searching",
    fileChange: "Preparing changes",
    reasoning: "Thinking"
  };
  if (kind === "item-completed" && itemType === "commandExecution") {
    return { kind, itemType, label: "Command finished" };
  }
  const label = startedLabels[itemType];
  return label ? { kind, itemType, label } : null;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, HOST);
  });
}

async function findPort(start: number): Promise<number> {
  for (let port = start; port < start + 80; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No free app-server port starting at ${start}`);
}

export class CodexAppServerBridge {
  private process?: ChildProcess;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private pendingTurns = new Map<string, PendingTurn>();
  private pendingCompactions = new Map<string, PendingCompaction>();
  private ready?: Promise<void>;
  private scratches = new Map<ScratchStateKey, ScratchState>();
  private compactedSparkBases = new Map<string, CompactedSparkBaseState>();
  private tokenUsageByThread = new Map<string, TokenUsageSnapshot>();
  private port?: number;
  private scratchArchives = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();

  async runTurn(params: {
    sourceThreadId: string;
    cwd: string;
    prompt: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    scratchMode: ScratchMode;
    voiceCaveman?: boolean;
    developerInstructions?: string;
    onDelta?: (delta: string, text: string) => void | Promise<void>;
    onEvent?: (label: string, detail?: string) => void | Promise<void>;
    onProgress?: (progress: CodexTurnProgress) => void | Promise<void>;
    onProgressTrace?: (event: CodexProgressTraceEvent) => void | Promise<void>;
  }): Promise<string> {
    return this.withOperationLock(async () => {
      await this.ensureReady(params.model, params.reasoningEffort, params.onEvent);
      const compacted = params.developerInstructions
        ? null
        : this.getCompactedSparkBaseFor(
            params.sourceThreadId,
            params.cwd,
            params.model,
            params.reasoningEffort,
            params.scratchMode,
            Boolean(params.voiceCaveman)
          );
      const scratchThreadId = compacted
        ? compacted.compactedThreadId
        : await this.ensureScratchThread(
            params.sourceThreadId,
            params.model,
            params.reasoningEffort,
            params.scratchMode,
            Boolean(params.voiceCaveman),
            params.cwd,
            params.developerInstructions,
            params.onEvent
          );
      if (compacted) {
        await params.onEvent?.(
          "App-server compacted scratch selected",
          `${compacted.compactedThreadId} forked from ${params.sourceThreadId}`
        );
      }

      return await this.runScratchTurn({
        scratchThreadId,
        prompt: params.prompt,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        eventLabelPrefix: "App-server",
        onDelta: params.onDelta,
        onEvent: params.onEvent,
        onProgress: params.onProgress,
        onProgressTrace: params.onProgressTrace
      });
    });
  }

  async warmScratch(params: {
    sourceThreadId: string;
    cwd: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    scratchMode?: ScratchMode;
    voiceCaveman?: boolean;
    confirmationPrompt?: string;
    onEvent?: (label: string, detail?: string) => void | Promise<void>;
  }): Promise<{ confirmation?: string }> {
    return await this.withOperationLock(async () => {
      await this.ensureReady(params.model, params.reasoningEffort, params.onEvent);
      const scratchMode = params.scratchMode ?? "text";
      const voiceCaveman = Boolean(params.voiceCaveman);
      const compacted = this.getCompactedSparkBaseFor(
        params.sourceThreadId,
        params.cwd,
        params.model,
        params.reasoningEffort,
        scratchMode,
        voiceCaveman
      );
      const scratchThreadId = compacted
        ? compacted.compactedThreadId
        : await this.ensureScratchThread(
            params.sourceThreadId,
            params.model,
            params.reasoningEffort,
            scratchMode,
            voiceCaveman,
            params.cwd,
            undefined,
            params.onEvent
          );
      if (compacted) {
        await params.onEvent?.(
          "App-server compacted scratch selected",
          `${compacted.compactedThreadId} forked from ${params.sourceThreadId}`
        );
      }
      const scratchConfigKey = this.scratchKey(
        params.sourceThreadId,
        params.cwd,
        params.model,
        params.reasoningEffort,
        scratchMode,
        voiceCaveman,
        undefined
      );
      const cached = this.scratches.get(scratchConfigKey);

      if (!params.confirmationPrompt) return {};
      if (
        compacted?.confirmationPrompt === params.confirmationPrompt &&
        compacted.confirmation
      ) {
        await params.onEvent?.("App-server prewarm confirmation reused", compacted.confirmation.slice(0, 240));
        return { confirmation: compacted.confirmation };
      }
      if (
        cached?.scratchThreadId === scratchThreadId &&
        cached.confirmationPrompt === params.confirmationPrompt &&
        cached.confirmation
      ) {
        await params.onEvent?.("App-server prewarm confirmation reused", cached.confirmation.slice(0, 240));
        return { confirmation: cached.confirmation };
      }

      const confirmation = await this.runScratchTurn({
        scratchThreadId,
        prompt: params.confirmationPrompt,
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        eventLabelPrefix: "App-server prewarm confirmation",
        onEvent: params.onEvent
      });
      const existing = this.scratches.get(scratchConfigKey);
      if (compacted) {
        compacted.confirmationPrompt = params.confirmationPrompt;
        compacted.confirmation = confirmation;
      } else if (existing?.scratchThreadId === scratchThreadId) {
        this.scratches.set(scratchConfigKey, {
          ...existing,
          confirmationPrompt: params.confirmationPrompt,
          confirmation
        });
      }
      return { confirmation };
    });
  }

  async prepareContextScratch(params: {
    sourceThreadId: string;
    cwd: string;
    reasoningEffort: ReasoningEffort;
    scratchMode: ScratchMode;
    voiceCaveman?: boolean;
    onEvent?: (label: string, detail?: string) => void | Promise<void>;
  }): Promise<{ scratchThreadId: string; tokenUsage?: TokenUsageSnapshot }> {
    return await this.withOperationLock(async () => {
      await this.ensureReady("default", params.reasoningEffort, params.onEvent);
      const scratchThreadId = await this.ensureScratchThread(
        params.sourceThreadId,
        "default",
        params.reasoningEffort,
        params.scratchMode,
        Boolean(params.voiceCaveman),
        params.cwd,
        undefined,
        params.onEvent
      );
      return {
        scratchThreadId,
        tokenUsage: this.tokenUsageByThread.get(scratchThreadId)
      };
    });
  }

  async resetScratch(onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    await this.withOperationLock(async () => {
      await this.archiveScratches(this.scratches.values(), onEvent);
      this.scratches.clear();
      for (const state of this.compactedSparkBases.values()) {
        this.scratchArchives.add(state.compactedThreadId);
      }
      this.compactedSparkBases.clear();
      await this.archiveQueuedScratchThreads(onEvent);
    });
  }

  async shutdown(reason = "Mortic shutdown", onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    await this.withOperationLock(async () => {
      await this.archiveScratches(this.scratches.values(), onEvent);
      this.scratches.clear();
      for (const state of this.compactedSparkBases.values()) {
        this.scratchArchives.add(state.compactedThreadId);
      }
      this.compactedSparkBases.clear();
      await this.archiveQueuedScratchThreads(onEvent);
      await this.stop(reason, onEvent);
    });
  }

  async interrupt(onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    if (this.pendingTurns.size > 0) {
      for (const pendingTurn of this.pendingTurns.values()) {
        pendingTurn.reject(new Error("Codex turn interrupted"));
      }
      this.pendingTurns.clear();
    }
    this.rejectPending(new Error("Codex turn interrupted"));
    await onEvent?.("App-server turn interrupted", "pending turns cancelled");
  }

  async compactThread(params: {
    sourceThreadId: string;
    cwd: string;
    targetModel: string;
    compactionModel: string;
    reasoningEffort: ReasoningEffort;
    scratchMode: ScratchMode;
    voiceCaveman?: boolean;
    onEvent?: (label: string, detail?: string) => void | Promise<void>;
  }): Promise<{ turnId: string; compactedThreadId: string; tokenUsage?: TokenUsageSnapshot }> {
    return await this.withOperationLock(async () => {
      await this.ensureReady(params.compactionModel, params.reasoningEffort, params.onEvent);
      for (const [key, previous] of this.compactedSparkBases.entries()) {
        if (previous.sourceThreadId !== params.sourceThreadId) continue;
        this.scratchArchives.add(previous.compactedThreadId);
        this.compactedSparkBases.delete(key);
      }
      await this.archiveQueuedScratchThreads(params.onEvent);

      const compactedThreadId = await this.createCompactionBaseFork(
        params.sourceThreadId,
        params.compactionModel,
        params.reasoningEffort,
        params.scratchMode,
        Boolean(params.voiceCaveman),
        params.cwd,
        params.onEvent
      );
      const completion = this.waitForCompaction(compactedThreadId, params.onEvent);
      try {
        // This is deliberately only called by Mortic's explicit "Compact then retry" flow.
        // Context compression can discard or rewrite old conversational detail, so Mortic
        // never runs it on the source thread. We compact only this disposable fork, then
        // run Spark turns directly on that compacted disposable base. Forking from this
        // ephemeral base is intentionally avoided because Codex app-server may not have a
        // rollout record for it, and CLI fallback must not create visible source forks.
        await this.request("thread/compact/start", { threadId: compactedThreadId });
        await params.onEvent?.("App-server fork compaction started", `${compactedThreadId} forked from ${params.sourceThreadId}`);
        const turnId = await completion;
        await params.onEvent?.("App-server fork compaction completed", turnId);
        await new Promise((resolve) => setTimeout(resolve, 250));
        const tokenUsage = this.tokenUsageByThread.get(compactedThreadId);
        this.compactedSparkBases.set(
          this.compactedSparkBaseKey(
            params.sourceThreadId,
            params.cwd,
            params.targetModel,
            params.reasoningEffort,
            params.scratchMode,
            Boolean(params.voiceCaveman)
          ),
          {
            sourceThreadId: params.sourceThreadId,
            compactedThreadId,
            cwd: params.cwd,
            compactionTurnId: turnId,
            model: params.targetModel,
            compactionModel: params.compactionModel,
            reasoningEffort: params.reasoningEffort,
            scratchMode: params.scratchMode,
            voiceCaveman: Boolean(params.voiceCaveman),
            tokenUsage,
            createdAt: new Date().toISOString()
          }
        );
        await this.archiveScratches(this.scratches.values(), params.onEvent);
        this.scratches.clear();
        return { turnId, compactedThreadId, tokenUsage };
      } catch (error) {
        const pending = this.pendingCompactions.get(compactedThreadId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingCompactions.delete(compactedThreadId);
        }
        this.scratchArchives.add(compactedThreadId);
        await this.archiveQueuedScratchThreads(params.onEvent, 1);
        throw error;
      }
    });
  }

  getCompactedSparkBase(params: {
    sourceThreadId: string;
    cwd: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    scratchMode: ScratchMode;
    voiceCaveman?: boolean;
  }): CompactedSparkBaseState | null {
    return this.getCompactedSparkBaseFor(
      params.sourceThreadId,
      params.cwd,
      params.model,
      params.reasoningEffort,
      params.scratchMode,
      Boolean(params.voiceCaveman)
    );
  }

  private async archiveScratchThread(threadId: string, onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    if (!threadId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      await this.request("thread/archive", { threadId });
      await onEvent?.("App-server scratch archived", threadId);
    } catch (error) {
      await onEvent?.("App-server scratch archive skipped", error instanceof Error ? error.message : String(error));
    }
  }

  private async withOperationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureReady(model: string, effort: ReasoningEffort, onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    if (this.ready) {
      await this.ready;
      return;
    }

    // A failed start must not poison the cached readiness promise, or every
    // later turn fails until the whole Mortic process restarts.
    this.ready = (async () => {
      try {
        await this.start(model, effort, onEvent);
      } catch (error) {
        await this.stop(
          `app-server start failed: ${error instanceof Error ? error.message : String(error)}`,
          onEvent
        ).catch(() => {});
        this.ready = undefined;
        throw error;
      }
    })();
    await this.ready;
  }

  private async start(model: string, effort: ReasoningEffort, onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    this.port = await findPort(6167);
    const url = `ws://${HOST}:${this.port}`;
    const args = [
      "app-server",
      "--listen",
      url
    ];
    if (model !== "default") {
      args.push("-c", `model="${model}"`);
    }
    args.push("-c", `model_reasoning_effort="${effort}"`);

    const child = codexProviderAdapter.spawnProcess(args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    this.process = child;
    await onEvent?.("App-server process started", `${codexProviderAdapter.binary()} ${args.join(" ")}`);

    let sawStdout = false;
    let sawStderr = false;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text && !sawStdout) {
        sawStdout = true;
        void onEvent?.("App-server first stdout", text.slice(0, 500));
      }
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text && !sawStderr) {
        sawStderr = true;
        void onEvent?.("App-server first stderr", text.slice(0, 500));
      }
    });
    child.on("exit", (code) => {
      if (this.process !== child) return;
      this.rejectPending(new Error(`Codex app-server exited with code ${code ?? "unknown"}`));
      this.ready = undefined;
      this.ws = undefined;
      this.scratches.clear();
      this.compactedSparkBases.clear();
      this.tokenUsageByThread.clear();
      this.process = undefined;
    });
    // A missing codex binary emits 'error' (never 'exit'); without a listener
    // that crashes the whole Mortic process instead of failing this start.
    child.on("error", (error) => {
      if (this.process !== child) return;
      this.rejectPending(new Error(`Codex app-server failed to start: ${error.message}`));
      this.ready = undefined;
      this.ws = undefined;
      this.process = undefined;
    });
    const startFailure = new Promise<never>((_, reject) => {
      child.once("error", (error) => reject(new Error(`Codex app-server failed to start: ${error.message}`)));
      child.once("exit", (code) => reject(new Error(`Codex app-server exited with code ${code ?? "unknown"} during startup`)));
    });
    // Post-startup exits also reject this promise; mark it handled so they
    // never surface as unhandled rejections.
    startFailure.catch(() => {});

    await Promise.race([this.waitForReadyz(), startFailure]);
    await Promise.race([this.connect(url), startFailure]);
    await this.request("initialize", {
      clientInfo: {
        name: "mortic",
        title: "Mortic",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.sendNotification("initialized");
    await onEvent?.("App-server initialized", url);
    void this.archiveQueuedScratchThreads(onEvent);
  }

  private async stop(reason: string, onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    const child = this.process;
    this.rejectPending(new Error(reason));
    this.ws?.close();
    this.ws = undefined;
    this.ready = undefined;
    this.scratches.clear();
    this.compactedSparkBases.clear();
    this.tokenUsageByThread.clear();
    this.port = undefined;

    if (!child || child.killed) {
      this.process = undefined;
      return;
    }

    await onEvent?.("App-server process stopping", reason);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve();
      };
      const termTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 100);
      const killTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        finish();
      }, 1500);
      termTimer.unref?.();
      killTimer.unref?.();

      child.once("close", finish);
      child.once("exit", finish);
      child.kill("SIGTERM");
    });

    if (this.process === child) this.process = undefined;
    await onEvent?.("App-server process stopped", reason);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const pendingTurn of this.pendingTurns.values()) {
      pendingTurn.reject(error);
    }
    this.pendingTurns.clear();
    for (const pending of this.pendingCompactions.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingCompactions.clear();
  }

  private waitForCompaction(
    threadId: string,
    onEvent?: (label: string, detail?: string) => void | Promise<void>
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCompactions.delete(threadId);
        reject(new Error("Timed out waiting for Codex context compaction to finish"));
      }, 15 * 60 * 1000);
      timeout.unref?.();

      this.pendingCompactions.set(threadId, {
        threadId,
        resolve,
        reject,
        timeout,
        onEvent
      });
    });
  }

  private async completeCompaction(threadId: string, turnId: string, label: string): Promise<boolean> {
    const pending = this.pendingCompactions.get(threadId);
    if (!pending) return false;

    this.pendingCompactions.delete(threadId);
    clearTimeout(pending.timeout);
    await pending.onEvent?.(label, turnId);
    pending.resolve(turnId);
    return true;
  }

  private async archiveScratches(
    states: Iterable<ScratchState>,
    onEvent?: (label: string, detail?: string) => void | Promise<void>
  ): Promise<void> {
    const statesArray = Array.from(states);
    for (const state of statesArray) {
      this.scratchArchives.add(state.scratchThreadId);
    }
    await this.archiveQueuedScratchThreads(onEvent);
  }

  private scratchKey(
    sourceThreadId: string,
    cwd: string,
    model: string,
    effort: ReasoningEffort,
    scratchMode: ScratchMode,
    voiceCaveman: boolean,
    developerInstructions?: string
  ): ScratchStateKey {
    return `${sourceThreadId}|${cwd}|${model}|${effort}|${scratchMode}|${voiceCaveman ? "1" : "0"}|${scratchForkAccessKey()}|${developerInstructions ?? ""}`;
  }

  private compactedSparkBaseKey(
    sourceThreadId: string,
    cwd: string,
    model: string,
    effort: ReasoningEffort,
    scratchMode: ScratchMode,
    voiceCaveman: boolean
  ): string {
    return this.scratchKey(sourceThreadId, cwd, model, effort, scratchMode, voiceCaveman);
  }

  private getCompactedSparkBaseFor(
    sourceThreadId: string,
    cwd: string,
    model: string,
    effort: ReasoningEffort,
    scratchMode: ScratchMode,
    voiceCaveman: boolean
  ): CompactedSparkBaseState | null {
    return this.compactedSparkBases.get(
      this.compactedSparkBaseKey(sourceThreadId, cwd, model, effort, scratchMode, voiceCaveman)
    ) ?? null;
  }

  private async createCompactionBaseFork(
    sourceThreadId: string,
    model: string,
    effort: ReasoningEffort,
    scratchMode: ScratchMode,
    voiceCaveman: boolean,
    cwd: string,
    onEvent?: (label: string, detail?: string) => void | Promise<void>
  ): Promise<string> {
    await onEvent?.("App-server compact-base fork started", sourceThreadId);
    const accessPolicy = scratchForkAccessPolicy();
    const response = await this.request("thread/fork", {
      threadId: sourceThreadId,
      path: null,
      model: model === "default" ? null : model,
      modelProvider: null,
      serviceTier: null,
      cwd,
      approvalPolicy: accessPolicy.approvalPolicy,
      approvalsReviewer: null,
      sandbox: accessPolicy.sandbox,
      ...(accessPolicy.networkPolicy ? { networkPolicy: accessPolicy.networkPolicy } : {}),
      config: {
        model_reasoning_effort: effort
      },
      baseInstructions: null,
      developerInstructions: scratchMode === "voice" ? voiceDeveloperInstructions(voiceCaveman) : null,
      ephemeral: true,
      persistExtendedHistory: false
    });

    const compactedThreadId = response?.thread?.id;
    if (!compactedThreadId) {
      throw new Error("Codex app-server did not return a compact-base thread id");
    }
    if (compactedThreadId === sourceThreadId) {
      throw new Error("Codex app-server returned the source thread id as compact-base fork; refusing to compact");
    }
    if (response?.thread?.ephemeral !== true) {
      throw new Error("Codex app-server compact-base fork was not ephemeral; refusing to compact");
    }

    await onEvent?.("App-server compact-base fork validated", `${compactedThreadId} forked from ${sourceThreadId}`);
    return compactedThreadId;
  }

  private async archiveQueuedScratchThreads(
    onEvent?: (label: string, detail?: string) => void | Promise<void>,
    max?: number
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.scratchArchives.size === 0) return;

    const threadIds = [...this.scratchArchives];
    const limited = typeof max === "number" ? threadIds.slice(0, max) : threadIds;
    for (const threadId of limited) {
      this.scratchArchives.delete(threadId);
      await this.archiveScratchThread(threadId, onEvent);
    }
  }

  private waitForReadyz(): Promise<void> {
    const started = Date.now();
    const readyUrl = `http://${HOST}:${this.port}/readyz`;

    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const response = await fetch(readyUrl);
          if (response.ok) {
            resolve();
            return;
          }
        } catch {
          // keep polling
        }

        if (Date.now() - started > readyTimeoutMs()) {
          reject(new Error("Timed out waiting for Codex app-server readyz"));
          return;
        }

        setTimeout(tick, 150);
      };
      void tick();
    });
  }

  private connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Codex app-server websocket error"));
      ws.onmessage = (event) => this.handleMessage(String(event.data));
      ws.onclose = () => {
        this.ws = undefined;
      };
    });
  }

  private async ensureScratchThread(
    sourceThreadId: string,
    model: string,
    effort: ReasoningEffort,
    scratchMode: ScratchMode,
    voiceCaveman: boolean,
    cwd: string,
    developerInstructions?: string,
    onEvent?: (label: string, detail?: string) => void | Promise<void>
  ): Promise<string> {
    const key = this.scratchKey(sourceThreadId, cwd, model, effort, scratchMode, voiceCaveman, developerInstructions);
    const existing = this.scratches.get(key);
    if (existing?.scratchThreadId) {
      return existing.scratchThreadId;
    }

    await onEvent?.("App-server scratch fork started", sourceThreadId);
    const accessPolicy = scratchForkAccessPolicy();
    const response = await this.request("thread/fork", {
      threadId: sourceThreadId,
      path: null,
      model: model === "default" ? null : model,
      modelProvider: null,
      serviceTier: null,
      cwd,
      approvalPolicy: accessPolicy.approvalPolicy,
      approvalsReviewer: null,
      sandbox: accessPolicy.sandbox,
      ...(accessPolicy.networkPolicy ? { networkPolicy: accessPolicy.networkPolicy } : {}),
      config: {
        model_reasoning_effort: effort
      },
      baseInstructions: null,
      developerInstructions: developerInstructions ?? (scratchMode === "voice" ? voiceDeveloperInstructions(voiceCaveman) : null),
      ephemeral: true,
      persistExtendedHistory: false
    });

    const scratchThreadId = response?.thread?.id;
    if (!scratchThreadId) {
      throw new Error("Codex app-server did not return a scratch thread id");
    }
    if (scratchThreadId === sourceThreadId) {
      throw new Error("Codex app-server returned the source thread id as the scratch thread; refusing to continue");
    }
    if (response?.thread?.ephemeral !== true) {
      throw new Error("Codex app-server scratch thread was not ephemeral; refusing to continue");
    }

    const state: ScratchState = {
      sourceThreadId,
      scratchThreadId,
      cwd,
      model,
      reasoningEffort: effort,
      scratchMode,
      voiceCaveman,
      developerInstructions,
      ephemeral: true
    };
    this.scratches.set(key, state);
    await onEvent?.("App-server scratch fork validated", `${scratchThreadId} forked from ${sourceThreadId}`);
    return scratchThreadId;
  }

  private async runScratchTurn(params: {
    scratchThreadId: string;
    prompt: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    eventLabelPrefix: string;
    onDelta?: (delta: string, text: string) => void | Promise<void>;
    onEvent?: (label: string, detail?: string) => void | Promise<void>;
    onProgress?: (progress: CodexTurnProgress) => void | Promise<void>;
    onProgressTrace?: (event: CodexProgressTraceEvent) => void | Promise<void>;
  }): Promise<string> {
    await params.onEvent?.(`${params.eventLabelPrefix} turn/start sent`, `scratch ${params.scratchThreadId}`);
    const response = await this.request("turn/start", {
      threadId: params.scratchThreadId,
      input: [
        {
          type: "text",
          text: params.prompt,
          text_elements: []
        }
      ],
      model: params.model === "default" ? null : params.model,
      effort: params.reasoningEffort
    });

    const turnId = response?.turn?.id;
    if (!turnId) {
      throw new Error("Codex app-server did not return a turn id");
    }

    await params.onEvent?.(`${params.eventLabelPrefix} turn started`, turnId);
    return await new Promise<string>((resolve, reject) => {
      this.pendingTurns.set(turnId, {
        threadId: params.scratchThreadId,
        turnId,
        text: "",
        sawDelta: false,
        telemetryMethods: new Set<string>(),
        eventLabelPrefix: params.eventLabelPrefix,
        onDelta: params.onDelta,
        resolve,
        reject,
        onEvent: params.onEvent,
        onProgress: params.onProgress,
        onProgressTrace: params.onProgressTrace
      });
    });
  }

  private request(method: string, params: any): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server websocket is not open"));
    }

    const id = this.nextId++;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws?.send(JSON.stringify(payload));
    });
  }

  private sendNotification(method: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ method }));
  }

  private handleMessage(raw: string): void {
    let message: JsonMessage;
    try {
      message = JSON.parse(raw) as JsonMessage;
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (!message.method) return;
    void this.handleNotification(message);
  }

  private rememberTokenUsage(params: any): void {
    const threadId = params?.threadId;
    const usage = params?.tokenUsage;
    if (typeof threadId !== "string" || !usage) return;
    const last = usage.last;
    const total = usage.total;
    this.tokenUsageByThread.set(threadId, {
      turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      inputTokens: typeof last?.inputTokens === "number" ? last.inputTokens : undefined,
      outputTokens: typeof last?.outputTokens === "number" ? last.outputTokens : undefined,
      totalTokens: typeof total?.totalTokens === "number" ? total.totalTokens : undefined,
      modelContextWindow: typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : undefined,
      updatedAt: new Date().toISOString()
    });
  }

  private async handleNotification(message: JsonMessage): Promise<void> {
    const method = message.method;
    if (!method) return;
    const traceRaw = async (pending: PendingTurn | undefined) => {
      if (!pending) return;
      await pending.onProgressTrace?.({
        type: "raw",
        method,
        turnId: message.params?.turnId ?? message.params?.turn?.id,
        itemType: itemTypeFromParams(message.params),
        itemId: itemIdFromParams(message.params),
        detail: safeNotificationDetail(method, message.params)
      });
    };
    const traceMapped = async (pending: PendingTurn | undefined, progress: CodexTurnProgress | null) => {
      if (!pending || !progress) return;
      await pending.onProgressTrace?.({ type: "mapped", progress });
    };

    if (method === "thread/tokenUsage/updated") {
      this.rememberTokenUsage(message.params);
    }

    if (method === "item/agentMessage/delta") {
      const turnId = message.params?.turnId;
      const pending = this.pendingTurns.get(turnId);
      if (!pending) return;
      const delta = String(message.params?.delta ?? "");
      const isFirstDelta = !pending.sawDelta;
      pending.sawDelta = true;
      pending.text += delta;
      await pending.onDelta?.(delta, pending.text);
      if (isFirstDelta) {
        await pending.onProgressTrace?.({ type: "first-delta", detail: safeNotificationDetail(method, message.params) });
        await pending.onEvent?.(`${pending.eventLabelPrefix} first model delta`, delta);
      }
      return;
    }

    if (method === "item/started") {
      const turnId = message.params?.turnId;
      const pending = this.pendingTurns.get(turnId);
      await traceRaw(pending);
      if (pending && !pending.sawDelta) {
        const progress = progressForItem("item-started", itemTypeFromParams(message.params));
        await traceMapped(pending, progress);
        if (progress) await pending.onProgress?.(progress);
      }
      return;
    }

    if (method === "item/completed") {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turnId;
      const item = message.params?.item;
      if (item?.type === "contextCompaction" && typeof threadId === "string") {
        await this.completeCompaction(threadId, String(turnId ?? item.id ?? ""), "App-server context compaction item completed");
        return;
      }
      const pending = this.pendingTurns.get(turnId);
      await traceRaw(pending);
      if (pending && item?.type === "agentMessage" && typeof item.text === "string") {
        pending.finalText = item.text;
      }
      if (pending && !pending.sawDelta) {
        const progress = progressForItem("item-completed", itemTypeFromParams(message.params));
        await traceMapped(pending, progress);
        if (progress) await pending.onProgress?.(progress);
      }
      return;
    }

    if (method === "item/commandExecution/outputDelta") {
      const turnId = message.params?.turnId;
      const pending = this.pendingTurns.get(turnId);
      await traceRaw(pending);
      if (pending && !pending.sawDelta) {
        const progress: CodexTurnProgress = { kind: "command-output", itemType: "commandExecution", label: "Reading tool output" };
        await traceMapped(pending, progress);
        await pending.onProgress?.(progress);
      }
      return;
    }

    if (method === "turn/plan/updated" || method === "turn/diff/updated") {
      const turnId = message.params?.turnId ?? message.params?.turn?.id;
      const pending = this.pendingTurns.get(turnId);
      await traceRaw(pending);
      if (!pending || pending.sawDelta) return;
      const progress: CodexTurnProgress =
        method === "turn/plan/updated"
          ? { kind: "plan-updated", label: "Checking project" }
          : { kind: "diff-updated", label: "Preparing changes" };
      await traceMapped(pending, progress);
      await pending.onProgress?.(progress);
      return;
    }

    if (method === "turn/completed") {
      const turnId = message.params?.turn?.id;
      const threadId = message.params?.threadId;
      if (typeof threadId === "string" && this.pendingCompactions.has(threadId)) {
        await this.completeCompaction(threadId, String(turnId ?? ""), "App-server compaction turn completed");
        return;
      }
      const pending = this.pendingTurns.get(turnId);
      if (!pending) return;
      this.pendingTurns.delete(turnId);
      const choice = chooseCompletedText(pending);
      if (choice.warning) {
        await pending.onEvent?.(`${pending.eventLabelPrefix} final/stream mismatch`, choice.warning);
      }
      await pending.onEvent?.(
        `${pending.eventLabelPrefix} turn completed`,
        choice.text ? `${Buffer.byteLength(choice.text, "utf8")} bytes from ${choice.source}` : "no response text"
      );
      pending.resolve(choice.text.trim());
      return;
    }

    if (method === "thread/compacted") {
      const threadId = message.params?.threadId;
      const turnId = message.params?.turnId;
      if (typeof threadId !== "string") return;
      await this.completeCompaction(threadId, String(turnId ?? ""), "App-server thread compacted");
      return;
    }

    if (method === "error") {
      for (const pending of this.pendingTurns.values()) {
        await pending.onProgressTrace?.({
          type: "raw",
          method,
          turnId: message.params?.turnId ?? message.params?.turn?.id,
          itemType: itemTypeFromParams(message.params),
          itemId: itemIdFromParams(message.params),
          detail: safeNotificationDetail(method, message.params)
        });
        pending.reject(new Error(JSON.stringify(message.params ?? message)));
      }
      this.pendingTurns.clear();
      for (const pending of this.pendingCompactions.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(JSON.stringify(message.params ?? message)));
      }
      this.pendingCompactions.clear();
      return;
    }

    const turnId =
      message.params?.turnId ??
      message.params?.turn?.id ??
      message.params?.item?.turnId ??
      message.params?.item?.turn_id;
    const pending = this.pendingTurns.get(turnId);
    if (!pending) return;

    if (pending.telemetryMethods.has(method)) return;
    pending.telemetryMethods.add(method);
    if (pending.telemetryMethods.size > 12) return;

    const detail = JSON.stringify(message.params ?? {})
      .replace(/\s+/g, " ")
      .slice(0, 240);
    await pending.onEvent?.(`${pending.eventLabelPrefix} telemetry`, `${method}${detail && detail !== "{}" ? ` ${detail}` : ""}`);
  }
}

export const codexAppServerBridge = new CodexAppServerBridge();
