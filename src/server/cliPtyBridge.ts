import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, open as openFile, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { ReasoningEffort } from "../shared/types.js";

type WorkerMessage =
  | { type: "ready"; pid: number }
  | { type: "output"; text: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

type PendingTurn = {
  id: string;
  startMarker: string;
  marker: string;
  raw: string;
  markerSeen: boolean;
  sawOutput: boolean;
  settleTimer?: NodeJS.Timeout;
  rolloutPollTimer?: NodeJS.Timeout;
  timeoutTimer: NodeJS.Timeout;
  resolve: (text: string) => void;
  reject: (reason: Error) => void;
  onEvent?: (label: string, detail?: string) => void | Promise<void>;
};

type CliSessionKey = {
  threadId: string;
  cwd: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

type ArchiveResult = {
  archived: string[];
  errors: string[];
};

type ForkMeta = {
  id: string;
  filePath: string;
  forkedFromId: string;
};

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const PROCESS_READY_TIMEOUT_MS = 15 * 1000;
const FORK_VALIDATION_TIMEOUT_MS = 20 * 1000;
const SUBMIT_ENTER_DELAY_MS = 500;
const RESPONSE_SETTLE_MS = 150;
const OUTPUT_BUFFER_LIMIT = 64 * 1024;
const PENDING_RAW_LIMIT = 256 * 1024;
const ROLLOUT_TAIL_LIMIT = 512 * 1024;
const ROLLOUT_POLL_MS = 250;
const CODEX_SESSIONS_DIR = path.join(homedir(), ".codex", "sessions");
const CODEX_ARCHIVE_DIR = path.join(homedir(), ".codex", "archived_sessions");

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/\x9B[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x0f/g, "");
}

function cleanTerminalText(value: string): string {
  return stripAnsi(value)
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(-limit) : next;
}

function readConfiguredMcpServerNames(): string[] {
  if (process.env.MORTIC_ENABLE_CODEX_MCP === "1") return [];

  const configPath = path.join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) return [];

  try {
    const config = readFileSync(configPath, "utf8");
    const names = new Set<string>();
    for (const match of config.matchAll(/^\s*\[mcp_servers\.([^\]\s]+)\]\s*$/gm)) {
      names.add(match[1].replace(/^"|"$/g, ""));
    }
    return [...names];
  } catch {
    return [];
  }
}

function mcpDisableArgs(): string[] {
  return readConfiguredMcpServerNames().flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}

async function listJsonlFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return listJsonlFiles(entryPath);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return [entryPath];
      return [];
    })
  );

  return nested.flat();
}

async function readFirstLine(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 64 * 1024 });
    let buffered = "";

    stream.on("data", (chunk) => {
      buffered += chunk;
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex >= 0) {
        stream.destroy();
        resolve(buffered.slice(0, newlineIndex));
      }

      if (buffered.length > 2_000_000) {
        stream.destroy();
        resolve(buffered);
      }
    });
    stream.on("end", () => resolve(buffered));
    stream.on("error", reject);
  });
}

async function readFileTail(filePath: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(filePath);
  const length = Math.min(fileStat.size, maxBytes);
  if (length <= 0) return "";

  const file = await openFile(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, fileStat.size - length);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

function findMorticRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "scripts", "codex_pty_worker.py"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return process.cwd();
}

async function readMorticForkMeta(filePath: string, sourceThreadId: string, startedAtMs: number, expectedCwd: string): Promise<ForkMeta | null> {
  const fileStat = await stat(filePath);
  if (fileStat.mtimeMs < startedAtMs - 5000) return null;

  const firstLine = await readFirstLine(filePath);
  const parsed = JSON.parse(firstLine) as {
    type?: string;
    payload?: {
      id?: string;
      forked_from_id?: string;
      cwd?: string;
      source?: string;
    };
  };

  const isFork =
    parsed.type === "session_meta" &&
    typeof parsed.payload?.id === "string" &&
    parsed.payload?.forked_from_id === sourceThreadId &&
    parsed.payload.id !== sourceThreadId &&
    parsed.payload.cwd === expectedCwd &&
    parsed.payload.source === "cli";

  if (!isFork) return null;

  return {
    id: parsed.payload!.id!,
    filePath,
    forkedFromId: sourceThreadId
  };
}

async function archiveRolloutFile(filePath: string): Promise<string> {
  await mkdir(CODEX_ARCHIVE_DIR, { recursive: true });

  const baseName = path.basename(filePath);
  let destination = path.join(CODEX_ARCHIVE_DIR, baseName);
  if (existsSync(destination)) {
    const parsed = path.parse(baseName);
    destination = path.join(CODEX_ARCHIVE_DIR, `${parsed.name}.${Date.now()}${parsed.ext}`);
  }

  await rename(filePath, destination);
  return destination;
}

function isUiLine(line: string): boolean {
  const clean = line.trim();
  return (
    !clean ||
    clean === "•" ||
    clean === "◦" ||
    clean === "›" ||
    clean === "Implement {feature}" ||
    clean.includes("Working (") ||
    clean.includes("esc to interrupt") ||
    clean.includes("gpt-") ||
    clean.startsWith("Token usage:") ||
    clean.startsWith("To continue this session") ||
    clean.startsWith("WARNING:") ||
    clean.startsWith("Continue anyway?") ||
    clean.startsWith("⚠ Heads up") ||
    clean.startsWith("⚠ MCP") ||
    clean.startsWith("MCP startup incomplete") ||
    clean.startsWith("Starting MCP servers")
  );
}

function cleanResponseLine(line: string): string {
  const promptIndex = line.indexOf("›");
  const withoutPrompt = promptIndex >= 0 ? line.slice(0, promptIndex) : line;
  return withoutPrompt.trimEnd();
}

function dedupeAdjacent(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (result[result.length - 1] !== line) result.push(line);
  }
  return result;
}

function normalizeResponseLines(value: string, marker: string): string {
  return dedupeAdjacent(
    value
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => !isUiLine(line))
      .map((line, index) => (index === 0 ? line.trimStart().replace(/^•\s*/, "") : line.replace(/^ {0,2}/, "")))
      .map(cleanResponseLine)
      .map((line) => line.replace(marker, "").trimEnd())
      .filter((line) => !isUiLine(line))
  )
    .join("\n")
    .trim();
}

function extractResponse(raw: string, startMarker: string, marker: string): string {
  const clean = cleanTerminalText(raw);
  const markerIndex = clean.lastIndexOf(marker);
  const startMarkerIndex = clean.lastIndexOf(startMarker);

  if (startMarkerIndex >= 0 && markerIndex > startMarkerIndex) {
    const betweenMarkers = clean.slice(startMarkerIndex + startMarker.length, markerIndex);
    const markedResponse = normalizeResponseLines(betweenMarkers, marker);
    if (markedResponse && markedResponse !== "<your answer>") return markedResponse;
  }

  const beforeMarker = markerIndex >= 0 ? clean.slice(0, markerIndex) : clean;
  const lines = beforeMarker
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !isUiLine(line));

  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trimStart().startsWith("• ")) {
      start = i;
      break;
    }
  }

  const candidate = start >= 0 ? lines.slice(start) : lines.slice(-24);
  const response = normalizeResponseLines(candidate.join("\n"), marker);
  if (response) return response;

  throw new Error("Codex CLI completed but Mortic could not parse the assistant response");
}

function extractMarkedText(value: string, startMarker: string, marker: string): string | null {
  const startMarkerIndex = value.lastIndexOf(startMarker);
  if (startMarkerIndex < 0) return null;

  const markerIndex = value.indexOf(marker, startMarkerIndex + startMarker.length);
  if (markerIndex <= startMarkerIndex) return null;

  const response = value.slice(startMarkerIndex + startMarker.length, markerIndex).trim();
  return response || null;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  return Object.values(value).flatMap(collectStrings);
}

async function readMarkedResponseFromRollout(filePath: string, startMarker: string, marker: string): Promise<string | null> {
  const tail = await readFileTail(filePath, ROLLOUT_TAIL_LIMIT);
  const lines = tail.split("\n").filter((line) => line.includes(marker) || line.includes(startMarker));

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as unknown;
      for (const value of collectStrings(parsed)) {
        const response = extractMarkedText(value, startMarker, marker);
        if (response) return response;
      }
    } catch {
      const response = extractMarkedText(lines[i], startMarker, marker);
      if (response) return response;
    }
  }

  return null;
}

function hasCompletedMarkedResponse(raw: string, startMarker: string, marker: string): boolean {
  const clean = cleanTerminalText(raw);
  const markerIndex = clean.lastIndexOf(marker);
  const startMarkerIndex = clean.lastIndexOf(startMarker);
  if (startMarkerIndex < 0 || markerIndex <= startMarkerIndex) return false;

  const betweenMarkers = clean.slice(startMarkerIndex + startMarker.length, markerIndex);
  const markedResponse = normalizeResponseLines(betweenMarkers, marker);
  return Boolean(markedResponse && markedResponse !== "<your answer>");
}

function compactPromptForTui(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function makeVoicePrompt(turnId: string, userText: string): { prompt: string; startMarker: string; marker: string } {
  const startMarker = `[[MORTIC_ANSWER_START:${turnId}]]`;
  const marker = `[[MORTIC_DONE:${turnId}]]`;
  const cleanText = compactPromptForTui(userText);
  const startTokenRecipe = `"[[MORTIC_ANSWER_START:" + "${turnId}" + "]]"`;
  const endTokenRecipe = `"[[MORTIC_DONE:" + "${turnId}" + "]]"`;
  return {
    startMarker,
    marker,
    prompt: `${cleanText} Reply concisely. Then output only the final answer wrapped in Mortic capture tokens. Construct the start token by joining ${startTokenRecipe}. Construct the end token by joining ${endTokenRecipe}. Output order: start token, answer, end token.`
  };
}

export class CodexCliPtyBridge {
  private process?: ChildProcessWithoutNullStreams;
  private pendingTurn?: PendingTurn;
  private key?: CliSessionKey;
  private ready?: Promise<void>;
  private turnQueue: Promise<void> = Promise.resolve();
  private outputBuffer = "";
  private updatePromptSkipped = false;
  private forkStartedAtMs?: number;
  private forkFiles = new Set<string>();
  private activeForkSessionId?: string;
  private activeForkFilePath?: string;

  async runTurn(params: {
    sourceThreadId: string;
    cwd: string;
    prompt: string;
    userText?: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    onEvent?: (label: string, detail?: string) => void | Promise<void>;
  }): Promise<string> {
    const run = async () => {
      const turnId = randomUUID();
      const { prompt, startMarker, marker } = makeVoicePrompt(turnId, params.userText ?? params.prompt);

      if (this.hasLiveSession(params.sourceThreadId, params.cwd, params.model, params.reasoningEffort)) {
        await this.ready;
        await params.onEvent?.("CLI warm prompt typed", `${Buffer.byteLength(prompt, "utf8")} bytes`);
        return await this.submitPrompt(prompt, startMarker, marker, params.onEvent);
      }

      return await this.startWithPrompt(params.sourceThreadId, params.cwd, params.model, params.reasoningEffort, prompt, startMarker, marker, params.onEvent);
    };

    const previous = this.turnQueue;
    let releaseQueue!: () => void;
    this.turnQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      return await run();
    } catch (error) {
      await this.stopAndArchive(params.onEvent);
      throw error;
    } finally {
      releaseQueue();
    }
  }

  async reset(): Promise<ArchiveResult> {
    return this.stopAndArchive();
  }

  private hasLiveSession(threadId: string, cwd: string, model: string, reasoningEffort: ReasoningEffort): boolean {
    return Boolean(
      this.ready &&
        this.key?.threadId === threadId &&
        this.key.cwd === cwd &&
        this.key.model === model &&
        this.key.reasoningEffort === reasoningEffort &&
        this.process &&
        !this.process.killed &&
        this.activeForkSessionId
    );
  }

  private async startWithPrompt(
    threadId: string,
    cwd: string,
    model: string,
    reasoningEffort: ReasoningEffort,
    prompt: string,
    startMarker: string,
    marker: string,
    onEvent?: (label: string, detail?: string) => void | Promise<void>
  ): Promise<string> {
    await this.stopAndArchive(onEvent);
    this.key = { threadId, cwd, model, reasoningEffort };
    this.ready = this.start(threadId, cwd, model, reasoningEffort, onEvent);
    await this.ready;
    const forkSessionId = await this.waitForValidatedFork(threadId, cwd, onEvent);
    this.activeForkSessionId = forkSessionId;
    await onEvent?.("CLI fork validated", `${forkSessionId} forked from ${threadId}`);

    const responsePromise = this.createPendingTurn(startMarker, marker, onEvent);
    await onEvent?.("CLI startup prompt armed", `${Buffer.byteLength(prompt, "utf8")} bytes`);
    this.write({ type: "write", text: prompt });
    setTimeout(() => {
      this.write({ type: "write", text: "\r" });
      void onEvent?.("CLI startup prompt submitted", "sent Enter to Codex TUI");
    }, SUBMIT_ENTER_DELAY_MS).unref?.();
    return await responsePromise;
  }

  private start(
    threadId: string,
    cwd: string,
    model: string,
    reasoningEffort: ReasoningEffort,
    onEvent?: (label: string, detail?: string) => void | Promise<void>
  ): Promise<void> {
    const workerPath = path.join(findMorticRoot(), "scripts", "codex_pty_worker.py");
    const modelArgs = model && model !== "default" ? ["-m", model] : [];
    const disabledMcpArgs = mcpDisableArgs();
    const args = [
      workerPath,
      "--",
      "codex",
      "fork",
      ...modelArgs,
      "-c",
      `model_reasoning_effort="${reasoningEffort}"`,
      "-c",
      "check_for_update_on_startup=false",
      ...disabledMcpArgs,
      "-s",
      "read-only",
      "-a",
      "never",
      "-C",
      cwd,
      threadId
    ];

    this.forkStartedAtMs = Date.now();
    const child = spawn("python3", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor"
      }
    });
    this.process = child;
    this.outputBuffer = "";
    this.updatePromptSkipped = false;
    this.forkFiles.clear();
    this.activeForkSessionId = undefined;
    this.activeForkFilePath = undefined;
    void onEvent?.("CLI fork process started", `python3 ${args.map(shellQuote).join(" ")}`);
    if (disabledMcpArgs.length > 0) {
      void onEvent?.("CLI MCP disabled", `${disabledMcpArgs.length / 2} configured server(s); set MORTIC_ENABLE_CODEX_MCP=1 to keep them`);
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) void onEvent?.("CLI worker stderr", text.slice(0, 500));
    });

    const reader = readline.createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      let message: WorkerMessage;
      try {
        message = JSON.parse(line) as WorkerMessage;
      } catch {
        void onEvent?.("CLI worker parse warning", line.slice(0, 500));
        return;
      }
      void this.handleWorkerMessage(message, onEvent);
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("exit", onExit);
        child.off("mortic-worker-ready", onReady);
        reject(new Error("Timed out waiting for Codex CLI PTY"));
      }, PROCESS_READY_TIMEOUT_MS);

      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("exit", onExit);
        resolve();
      };

      const onExit = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("mortic-worker-ready", onReady);
        reject(new Error(`Codex CLI exited before ready with code ${code ?? "unknown"}`));
      };

      child.once("mortic-worker-ready", onReady);
      child.on("exit", onExit);
      timeout.unref?.();
    });
  }

  private async handleWorkerMessage(message: WorkerMessage, onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<void> {
    if (message.type === "ready") {
      await onEvent?.("CLI PTY ready", `pid ${message.pid}`);
      this.process?.emit("mortic-worker-ready");
      void this.discoverForkFiles(onEvent);
      return;
    }

    if (message.type === "error") {
      await onEvent?.("CLI PTY error", message.message);
      this.pendingTurn?.reject(new Error(message.message));
      this.pendingTurn = undefined;
      return;
    }

    if (message.type === "exit") {
      const error = new Error(`Codex CLI exited with code ${message.code ?? "unknown"}`);
      this.pendingTurn?.reject(error);
      this.pendingTurn = undefined;
      this.ready = undefined;
      this.process = undefined;
      await onEvent?.("CLI process exited", `exit code ${message.code ?? "unknown"}`);
      return;
    }

    this.outputBuffer = appendBounded(this.outputBuffer, message.text, OUTPUT_BUFFER_LIMIT);
    const clean = cleanTerminalText(this.outputBuffer).slice(-4000);
    if (
      !this.updatePromptSkipped &&
      clean.includes("Update available") &&
      clean.includes("Update now") &&
      clean.includes("Skip")
    ) {
      this.updatePromptSkipped = true;
      this.write({ type: "write", text: "2\r\r" });
      await onEvent?.("CLI update prompt skipped", "selected Skip; did not install update");
      return;
    }

    const pending = this.pendingTurn;
    if (!pending) return;

    pending.raw = appendBounded(pending.raw, message.text, PENDING_RAW_LIMIT);
    if (!pending.sawOutput) {
      pending.sawOutput = true;
      await pending.onEvent?.("CLI first output", cleanTerminalText(message.text).slice(0, 200));
    }

    if (!pending.markerSeen && hasCompletedMarkedResponse(pending.raw, pending.startMarker, pending.marker)) {
      pending.markerSeen = true;
      await pending.onEvent?.("CLI done marker seen", pending.marker);
      await this.discoverForkFiles(pending.onEvent);
    }

    if (pending.markerSeen) {
      if (pending.settleTimer) clearTimeout(pending.settleTimer);
      pending.settleTimer = setTimeout(() => {
        this.finishPendingTurn();
      }, RESPONSE_SETTLE_MS);
    }
  }

  private submitPrompt(prompt: string, startMarker: string, marker: string, onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<string> {
    if (!this.process || this.process.killed) {
      return Promise.reject(new Error("Codex CLI bridge is not running"));
    }

    const responsePromise = this.createPendingTurn(startMarker, marker, onEvent);
    this.write({ type: "write", text: prompt });
    setTimeout(() => {
      this.write({ type: "write", text: "\r" });
      void onEvent?.("CLI warm prompt submitted", "sent Enter to Codex TUI");
    }, SUBMIT_ENTER_DELAY_MS).unref?.();
    return responsePromise;
  }

  private createPendingTurn(startMarker: string, marker: string, onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<string> {
    if (this.pendingTurn) {
      return Promise.reject(new Error("Codex CLI bridge already has a running turn"));
    }

    return new Promise<string>((resolve, reject) => {
      const pending: PendingTurn = {
        id: marker,
        startMarker,
        marker,
        raw: "",
        markerSeen: false,
        sawOutput: false,
        resolve,
        reject,
        onEvent,
        timeoutTimer: setTimeout(() => {
          this.pendingTurn = undefined;
          reject(new Error("Timed out waiting for Codex CLI response"));
        }, TURN_TIMEOUT_MS)
      };
      pending.timeoutTimer.unref?.();
      this.pendingTurn = pending;
      this.startRolloutPolling(pending);
    });
  }

  private startRolloutPolling(pending: PendingTurn): void {
    const filePath = this.activeForkFilePath;
    if (!filePath) return;

    const poll = async () => {
      if (this.pendingTurn !== pending) return;

      try {
        const response = await readMarkedResponseFromRollout(filePath, pending.startMarker, pending.marker);
        if (response) {
          await pending.onEvent?.("CLI rollout done marker seen", pending.marker);
          this.finishPendingTurn(response);
          return;
        }
      } catch {
        // The rollout file may be mid-write; keep polling until the turn timeout.
      }

      if (this.pendingTurn !== pending) return;
      pending.rolloutPollTimer = setTimeout(() => {
        void poll();
      }, ROLLOUT_POLL_MS);
      pending.rolloutPollTimer.unref?.();
    };

    pending.rolloutPollTimer = setTimeout(() => {
      void poll();
    }, ROLLOUT_POLL_MS);
    pending.rolloutPollTimer.unref?.();
  }

  private finishPendingTurn(responseOverride?: string): void {
    const pending = this.pendingTurn;
    if (!pending) return;
    this.pendingTurn = undefined;
    if (pending.settleTimer) clearTimeout(pending.settleTimer);
    if (pending.rolloutPollTimer) clearTimeout(pending.rolloutPollTimer);
    clearTimeout(pending.timeoutTimer);

    try {
      const response = responseOverride ?? extractResponse(pending.raw, pending.startMarker, pending.marker);
      void pending.onEvent?.("CLI response parsed", `${Buffer.byteLength(response, "utf8")} bytes`);
      pending.resolve(response);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private write(payload: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async discoverForkFiles(onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<ForkMeta[]> {
    if (!this.key || !this.forkStartedAtMs) return [];

    const found: ForkMeta[] = [];

    try {
      const files = await listJsonlFiles(CODEX_SESSIONS_DIR);
      for (const file of files) {
        if (this.forkFiles.has(file)) continue;
        try {
          const meta = await readMorticForkMeta(file, this.key.threadId, this.forkStartedAtMs, this.key.cwd);
          if (!meta) continue;

          this.forkFiles.add(file);
          this.activeForkSessionId = meta.id;
          this.activeForkFilePath = meta.filePath;
          found.push(meta);
          await onEvent?.("CLI fork file tracked", `${meta.id} ${file}`);
        } catch {
          // Ignore unrelated or partially-written rollout files.
        }
      }
    } catch (error) {
      await onEvent?.("CLI fork archive scan failed", error instanceof Error ? error.message : String(error));
    }

    return found;
  }

  private async waitForValidatedFork(
    threadId: string,
    cwd: string,
    onEvent?: (label: string, detail?: string) => void | Promise<void>
  ): Promise<string> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < FORK_VALIDATION_TIMEOUT_MS) {
      const metas = await this.discoverForkFiles(onEvent);
      const match = metas.find((meta) => meta.forkedFromId === threadId && meta.id !== threadId);
      if (match) return match.id;
      if (this.activeForkSessionId && this.activeForkSessionId !== threadId) return this.activeForkSessionId;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Codex CLI fork was not validated for source ${threadId} in cwd ${cwd}; refusing to send a voice turn to an unverified session`);
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    if (!child || child.killed) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
        finish();
      }, 3000);
      forceTimer.unref?.();

      child.once("close", finish);
      child.once("exit", finish);
      this.write({ type: "stop" });
    });
  }

  private async stopAndArchive(onEvent?: (label: string, detail?: string) => void | Promise<void>): Promise<ArchiveResult> {
    const archived: string[] = [];
    const errors: string[] = [];

    if (this.pendingTurn) {
      this.pendingTurn.reject(new Error("Codex CLI bridge reset"));
      clearTimeout(this.pendingTurn.timeoutTimer);
      if (this.pendingTurn.settleTimer) clearTimeout(this.pendingTurn.settleTimer);
      if (this.pendingTurn.rolloutPollTimer) clearTimeout(this.pendingTurn.rolloutPollTimer);
      this.pendingTurn = undefined;
    }

    await this.discoverForkFiles(onEvent);
    await this.stopProcess();
    await this.discoverForkFiles(onEvent);

    for (const file of this.forkFiles) {
      try {
        if (!existsSync(file)) continue;
        const destination = await archiveRolloutFile(file);
        archived.push(destination);
        await onEvent?.("CLI fork archived", destination);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${file}: ${message}`);
        await onEvent?.("CLI fork archive failed", `${file}: ${message}`);
      }
    }

    this.process = undefined;
    this.ready = undefined;
    this.outputBuffer = "";
    this.updatePromptSkipped = false;
    this.forkStartedAtMs = undefined;
    this.forkFiles.clear();
    this.activeForkSessionId = undefined;
    this.activeForkFilePath = undefined;

    return { archived, errors };
  }
}

export const codexCliPtyBridge = new CodexCliPtyBridge();
