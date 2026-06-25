import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  ProviderAdapterStatus,
  ProviderThreadSummary
} from "../shared/types.js";

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export type CommandObserver = {
  onStart?: (detail: string) => void | Promise<void>;
  onFirstStdout?: (detail: string) => void | Promise<void>;
  onFirstStderr?: (detail: string) => void | Promise<void>;
  onExit?: (detail: string) => void | Promise<void>;
};

function runCommand(command: string, args: string[], timeoutMs = 5000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

export function accountIdFromLoginOutput(output: string): string | undefined {
  const normalized = output.replace(/\r/g, "\n");
  const email = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email) return email;
  return normalized.match(/\b(?:account|user|logged in as)\s*[:=]?\s*([A-Za-z0-9._@-]+)/i)?.[1];
}

export function loginStatusFromOutput(code: number | null, output: string): ProviderAdapterStatus["loginStatus"] {
  const normalized = output.toLowerCase();
  if (code === 0 && /(logged in|authenticated|signed in|active account)/i.test(output)) return "logged-in";
  if (/(not logged in|not authenticated|logged out|sign in|login required)/i.test(output)) return "logged-out";
  return code === 0 ? "logged-in" : "unknown";
}

function codexSessionsRoot(): string {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
}

function codexSessionIndexPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "session_index.jsonl");
}

async function listJsonlFilesWithMtime(root: string): Promise<Array<{ file: string; mtimeMs: number }>> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return listJsonlFilesWithMtime(entryPath);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const fileStat = await stat(entryPath).catch(() => null);
        return fileStat ? [{ file: entryPath, mtimeMs: fileStat.mtimeMs }] : [];
      }
      return [];
    })
  );
  return nested.flat();
}

function readFirstLine(filePath: string): Promise<string> {
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

async function readThreadNamesFromSessionIndex(): Promise<Map<string, { threadName: string; updatedAt: string }>> {
  const indexPath = codexSessionIndexPath();
  if (!existsSync(indexPath)) return new Map();

  const names = new Map<string, { threadName: string; updatedAt: string }>();
  const content = await readFile(indexPath, "utf8").catch(() => "");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown; updated_at?: unknown };
      if (typeof parsed.id !== "string" || typeof parsed.thread_name !== "string") continue;
      const threadName = parsed.thread_name.trim();
      if (!threadName) continue;
      const updatedAt = typeof parsed.updated_at === "string" ? parsed.updated_at : "";
      const current = names.get(parsed.id);
      if (!current || updatedAt.localeCompare(current.updatedAt) >= 0) {
        names.set(parsed.id, { threadName, updatedAt });
      }
    } catch {
      // Ignore malformed index rows; rollout metadata still makes the thread selectable.
    }
  }
  return names;
}

function isSubagentSessionSource(source: unknown): boolean {
  if (!source) return false;
  if (typeof source === "string") return source.toLowerCase().includes("subagent");
  if (typeof source !== "object") return false;
  const sourceRecord = source as { subagent?: unknown };
  return Boolean(sourceRecord.subagent);
}

export class CodexProviderAdapter {
  // All Codex process invocations flow through this adapter so a future
  // second provider (or a renamed binary) is a one-file change. No call
  // site outside this module may spawn the provider binary directly;
  // check_provider_adapters.mjs greps for violations.
  binary(): string {
    return process.env.MORTIC_CODEX_BINARY || "codex";
  }

  spawnProcess(args: string[], options: SpawnOptions): ChildProcess {
    return spawn(this.binary(), args, options);
  }

  runExec(
    args: string[],
    options?: { stdin?: string; timeoutMs?: number; observer?: CommandObserver }
  ): Promise<CommandResult> {
    const command = this.binary();
    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;
    const observer = options?.observer;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let sawStdout = false;
      let sawStderr = false;

      void observer?.onStart?.(`${command} ${args.join(" ")}`);

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command} ${args.join(" ")}`));
      }, timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
        if (!sawStdout) {
          sawStdout = true;
          void observer?.onFirstStdout?.(String(chunk).slice(0, 500));
        }
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
        if (!sawStderr) {
          sawStderr = true;
          void observer?.onFirstStderr?.(String(chunk).slice(0, 500));
        }
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        void observer?.onExit?.(`exit code ${code ?? "unknown"}`);
        resolve({ stdout, stderr, code });
      });

      if (options?.stdin) {
        child.stdin?.write(options.stdin);
      }
      child.stdin?.end();
    });
  }

  // Discover recent Codex conversations from local rollout files so the
  // project picker can offer threads without the user pasting URIs. Reads
  // only each file's first session_meta line; archived sessions are not
  // scanned because codexSessionsRoot() excludes archived_sessions.
  async listRecentThreads(options?: { limit?: number }): Promise<ProviderThreadSummary[]> {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    const files = (await listJsonlFilesWithMtime(codexSessionsRoot())).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const threadNames = await readThreadNamesFromSessionIndex();
    const byThread = new Map<string, ProviderThreadSummary>();
    for (const candidate of files) {
      if (byThread.size >= limit) break;
      try {
        const firstLine = await readFirstLine(candidate.file);
        const parsed = JSON.parse(firstLine) as {
          type?: string;
          payload?: { id?: string; cwd?: string; source?: unknown; forked_from_id?: string };
        };
        if (parsed.type !== "session_meta" || typeof parsed.payload?.id !== "string") continue;
        if (isSubagentSessionSource(parsed.payload.source)) continue;
        const threadId = parsed.payload.id;
        if (byThread.has(threadId)) continue;
        const indexed = threadNames.get(threadId);
        byThread.set(threadId, {
          provider: "codex",
          threadId,
          sourceUri: `codex://threads/${threadId}`,
          threadName: indexed?.threadName,
          cwd: parsed.payload.cwd,
          source: typeof parsed.payload.source === "string" ? parsed.payload.source : undefined,
          updatedAt: new Date(candidate.mtimeMs).toISOString()
        });
      } catch {
        // Unreadable or non-rollout file; skip.
      }
    }
    return [...byThread.values()];
  }

  async threadName(threadId: string): Promise<string | undefined> {
    return (await readThreadNamesFromSessionIndex()).get(threadId)?.threadName;
  }

  async status(): Promise<ProviderAdapterStatus> {
    try {
      const pathResult = await runCommand("which", [this.binary()]);
      const codexPath = pathResult.stdout.trim();
      if (!codexPath || pathResult.code !== 0) {
        return {
          provider: "codex",
          available: false,
          loginStatus: "unknown",
          canStartLogin: false,
          error: "codex executable was not found on PATH"
        };
      }

      const [versionResult, loginResult] = await Promise.all([
        runCommand(this.binary(), ["--version"]),
        runCommand(this.binary(), ["login", "status"]).catch((error) => ({
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          code: null
        }))
      ]);
      const loginText = `${loginResult.stdout}\n${loginResult.stderr}`.trim();
      const loginStatus = loginStatusFromOutput(loginResult.code, loginText);
      return {
        provider: "codex",
        available: versionResult.code === 0,
        path: codexPath,
        version: versionResult.stdout.trim() || undefined,
        loginStatus,
        accountId: accountIdFromLoginOutput(loginText),
        canStartLogin: loginStatus !== "logged-in",
        loginCommand: loginStatus !== "logged-in" ? "codex login" : undefined,
        error: versionResult.code === 0 ? undefined : versionResult.stderr.trim()
      };
    } catch (error) {
      return {
        provider: "codex",
        available: false,
        loginStatus: "unknown",
        canStartLogin: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

}

export const codexProviderAdapter = new CodexProviderAdapter();
