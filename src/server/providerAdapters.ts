import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import type {
  ProviderActionAvailability,
  ProviderAdapterStatus,
  ProviderReference,
  RuntimeContextRestore,
  ScratchSessionNode,
  SourceThreadNode
} from "../shared/types.js";

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

function hash(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function nowIso(): string {
  return new Date().toISOString();
}

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

function action(available: boolean, disabledReason?: string): ProviderActionAvailability {
  return available ? { available } : { available, disabledReason };
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

function accessPresetFromRuntime(runtimeContext?: RuntimeContextRestore): string | undefined {
  const profile = runtimeContext?.restored?.permissionProfile ?? runtimeContext?.requested;
  if (!profile) return undefined;
  return `${profile.filesystem}; network=${profile.network}; approval=${profile.approval}`;
}

function baseReference(params: {
  providerRefId: string;
  threadId?: string;
  forkKind: ProviderReference["forkKind"];
  ephemeral: boolean;
  persisted: boolean;
  cwd?: string;
  accessPreset?: string;
  accountId?: string;
  openTarget?: string;
  capabilities: string[];
  actions: ProviderReference["actions"];
  createdAt: string;
  updatedAt: string;
}): ProviderReference {
  return {
    id: `provider-codex-${hash(params.providerRefId)}`,
    provider: "codex",
    providerRefId: params.providerRefId,
    accountId: params.accountId,
    conversationId: params.threadId,
    threadId: params.threadId,
    forkKind: params.forkKind,
    ephemeral: params.ephemeral,
    persisted: params.persisted,
    cwd: params.cwd,
    accessPreset: params.accessPreset,
    capabilities: params.capabilities,
    openTarget: params.openTarget,
    actions: params.actions,
    createdAt: params.createdAt,
    updatedAt: params.updatedAt
  };
}

export class CodexProviderAdapter {
  async status(): Promise<ProviderAdapterStatus> {
    try {
      const pathResult = await runCommand("which", ["codex"]);
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
        runCommand("codex", ["--version"]),
        runCommand("codex", ["login", "status"]).catch((error) => ({
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

  sourceReference(source: SourceThreadNode, runtimeContext?: RuntimeContextRestore, accountId?: string): ProviderReference {
    return baseReference({
      providerRefId: source.codexThreadId,
      threadId: source.codexThreadId,
      forkKind: "source",
      ephemeral: false,
      persisted: true,
      cwd: runtimeContext?.effectiveCwd ?? source.workspacePath,
      accessPreset: accessPresetFromRuntime(runtimeContext),
      accountId,
      openTarget: source.sourceUri,
      capabilities: ["open", "copy-link", "fork"],
      actions: {
        resume: action(true),
        fork: action(true),
        archive: action(false, "Source thread archive is not controlled by Mortic yet.")
      },
      createdAt: source.createdAt,
      updatedAt: source.lastSeenAt
    });
  }

  scratchReference(scratch: ScratchSessionNode, runtimeContext?: RuntimeContextRestore, accountId?: string): ProviderReference | null {
    if (!scratch.codexScratchThreadId) return null;
    const openTarget = `codex://threads/${scratch.codexScratchThreadId}`;
    const resumable = !scratch.ephemeral;
    return baseReference({
      providerRefId: scratch.codexScratchThreadId,
      threadId: scratch.codexScratchThreadId,
      forkKind: scratch.ephemeral ? "scratch" : "persisted",
      ephemeral: scratch.ephemeral,
      persisted: !scratch.ephemeral,
      cwd: runtimeContext?.effectiveCwd ?? scratch.workspacePath,
      accessPreset: accessPresetFromRuntime(runtimeContext),
      accountId,
      openTarget,
      capabilities: ["open", "copy-link", "local-transcript"],
      actions: {
        resume: action(resumable, scratch.ephemeral ? "Ephemeral Codex scratches may not remain resumable after archive." : undefined),
        fork: action(!scratch.ephemeral, scratch.ephemeral ? "Ephemeral Codex scratches are metadata-only for provider forking in this pass." : undefined),
        archive: action(false, "Provider archive action is not implemented yet.")
      },
      createdAt: scratch.createdAt,
      updatedAt: scratch.updatedAt
    });
  }
}

export const codexProviderAdapter = new CodexProviderAdapter();
