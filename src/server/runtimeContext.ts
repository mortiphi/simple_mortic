import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  FilesystemPermissionMode,
  ReasoningEffort,
  RuntimeApprovalPolicy,
  RuntimeContextAuditEntry,
  RuntimeContextRestore,
  RuntimeContextSnapshot,
  RuntimeNetworkPolicy,
  RuntimePermissionProfile
} from "../shared/types.js";

type ResolveRuntimeContextParams = {
  threadId: string;
  launchCwd: string;
  morticRoot: string;
  codexHome?: string;
  requested?: Partial<RuntimePermissionProfile>;
};

const DEFAULT_REQUESTED_PROFILE: RuntimePermissionProfile = {
  filesystem: "read-only",
  workspaceRoots: [],
  network: "unknown",
  approval: "never"
};

const ACCESS_RANK: Record<FilesystemPermissionMode, number> = {
  "read-only": 0,
  "workspace-write": 1,
  "danger-full-access": 2,
  unknown: 3
};

const APPROVAL_RANK: Record<RuntimeApprovalPolicy, number> = {
  never: 0,
  "on-request": 1,
  "on-failure": 2,
  untrusted: 3,
  unknown: 0
};

const NETWORK_RANK: Record<RuntimeNetworkPolicy, number> = {
  disabled: 0,
  enabled: 1,
  unknown: 0
};

function nowIso(): string {
  return new Date().toISOString();
}

function audit(type: string, detail?: string): RuntimeContextAuditEntry {
  return { at: nowIso(), type, detail };
}

function codexSessionsDirs(codexHome = path.join(homedir(), ".codex")): string[] {
  return [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
}

function normalizePolicy(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function filesystemMode(payload: Record<string, unknown>): FilesystemPermissionMode {
  const raw =
    normalizePolicy(payload.sandbox) ??
    normalizePolicy(payload.sandbox_mode) ??
    normalizePolicy(payload.filesystem) ??
    normalizePolicy(payload.filesystem_mode);
  if (raw === "read-only" || raw === "workspace-write" || raw === "danger-full-access") return raw;
  return "unknown";
}

function approvalPolicy(payload: Record<string, unknown>): RuntimeApprovalPolicy {
  const raw = normalizePolicy(payload.approvalPolicy) ?? normalizePolicy(payload.approval_policy);
  if (raw === "never" || raw === "on-request" || raw === "on-failure" || raw === "untrusted") return raw;
  return "unknown";
}

function networkPolicy(payload: Record<string, unknown>): RuntimeNetworkPolicy {
  const raw = normalizePolicy(payload.networkPolicy) ?? normalizePolicy(payload.network_policy) ?? normalizePolicy(payload.network_access);
  if (raw === "enabled" || raw === "disabled") return raw;
  if (typeof payload.network_enabled === "boolean") return payload.network_enabled ? "enabled" : "disabled";
  return "unknown";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function workspaceRoots(payload: Record<string, unknown>, cwd: string): string[] {
  const candidates = [
    stringArray(payload.workspace_roots),
    stringArray(payload.workspaceRoots),
    stringArray(payload.workspace_folders),
    stringArray(payload.workspaceFolders)
  ];
  const roots = candidates.find((items) => items.length > 0) ?? [];
  return roots.length > 0 ? roots : [cwd];
}

function isKnownLocalSource(snapshot: RuntimeContextSnapshot): boolean {
  if (!snapshot.cwd || !path.isAbsolute(snapshot.cwd)) return false;
  if (snapshot.source && !["cli", "vscode", "Codex Desktop", "codex-desktop"].includes(snapshot.source)) return false;
  return true;
}

function profileBroadening(requested: RuntimePermissionProfile, source: RuntimePermissionProfile): string[] {
  const broadened: string[] = [];
  if (source.filesystem === "unknown" && requested.filesystem !== "read-only" && requested.filesystem !== "unknown") {
    broadened.push("filesystem");
  } else if (ACCESS_RANK[requested.filesystem] > ACCESS_RANK[source.filesystem]) {
    broadened.push("filesystem");
  }
  if (source.network === "unknown" && requested.network === "enabled") {
    broadened.push("network");
  } else if (NETWORK_RANK[requested.network] > NETWORK_RANK[source.network]) {
    broadened.push("network");
  }
  if (source.approval === "unknown" && requested.approval !== "never" && requested.approval !== "unknown") {
    broadened.push("approval");
  } else if (APPROVAL_RANK[requested.approval] > APPROVAL_RANK[source.approval]) {
    broadened.push("approval");
  }
  return broadened;
}

function requestedProfile(params: ResolveRuntimeContextParams): RuntimePermissionProfile {
  const roots = params.requested?.workspaceRoots ?? [];
  return {
    ...DEFAULT_REQUESTED_PROFILE,
    ...params.requested,
    workspaceRoots: roots
  };
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

async function latestRolloutFile(threadId: string, codexHome?: string): Promise<string | undefined> {
  const candidates = (await Promise.all(codexSessionsDirs(codexHome).map(listJsonlFiles))).flat();
  const matching = candidates.filter((filePath) => path.basename(filePath).includes(threadId));
  if (matching.length === 0) return undefined;
  const withStats = await Promise.all(
    matching.map(async (filePath) => ({
      filePath,
      mtimeMs: (await stat(filePath)).mtimeMs
    }))
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0]?.filePath;
}

export async function findCodexRuntimeSnapshot(threadId: string, codexHome?: string): Promise<RuntimeContextSnapshot | undefined> {
  const rolloutPath = await latestRolloutFile(threadId, codexHome);
  if (!rolloutPath) return undefined;

  const firstLine = await readFirstLine(rolloutPath);
  const parsed = JSON.parse(firstLine) as { type?: string; payload?: Record<string, unknown> };
  if (parsed.type !== "session_meta" || !parsed.payload) return undefined;

  const payload = parsed.payload;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
  if (!cwd) return undefined;

  const profile: RuntimePermissionProfile = {
    filesystem: filesystemMode(payload),
    workspaceRoots: workspaceRoots(payload, cwd),
    network: networkPolicy(payload),
    approval: approvalPolicy(payload)
  };

  return {
    threadId,
    cwd,
    workspaceRoots: profile.workspaceRoots,
    permissionProfile: profile,
    model: typeof payload.model === "string" ? payload.model : undefined,
    modelProvider: typeof payload.model_provider === "string" ? payload.model_provider : undefined,
    reasoningEffort: typeof payload.model_reasoning_effort === "string" ? (payload.model_reasoning_effort as ReasoningEffort) : undefined,
    originator: typeof payload.originator === "string" ? payload.originator : undefined,
    source: typeof payload.source === "string" ? payload.source : undefined,
    threadSource: typeof payload.thread_source === "string" ? payload.thread_source : undefined,
    cliVersion: typeof payload.cli_version === "string" ? payload.cli_version : undefined,
    capturedAt: nowIso(),
    rolloutPath
  };
}

export async function resolveRuntimeContext(params: ResolveRuntimeContextParams): Promise<RuntimeContextRestore> {
  const requested = requestedProfile(params);
  const snapshot = await findCodexRuntimeSnapshot(params.threadId, params.codexHome);
  const baseAudit = [
    audit("runtime.requested", `filesystem=${requested.filesystem}; network=${requested.network}; approval=${requested.approval}`),
    audit("runtime.launch", `cwd=${params.launchCwd}; morticRoot=${params.morticRoot}`)
  ];

  if (!snapshot) {
    return {
      status: "fallback",
      trusted: false,
      sameMachineUser: false,
      effectiveCwd: params.launchCwd,
      workspaceRoots: [params.launchCwd],
      requested,
      reason: "No local Codex rollout metadata was found for this source thread.",
      prompt: `Mortic could not find local runtime metadata for ${params.threadId}. Select the intended project folder before continuing; recommended fallback is ${params.launchCwd}.`,
      audit: [...baseAudit, audit("runtime.snapshot.missing", params.threadId)]
    };
  }

  const pathExists = existsSync(snapshot.cwd);
  const trusted = isKnownLocalSource(snapshot);
  const broadening = profileBroadening(requested, snapshot.permissionProfile);
  const sameMachineUser = trusted && pathExists;

  if (!trusted) {
    return {
      status: "fallback",
      trusted: false,
      sameMachineUser: false,
      effectiveCwd: params.launchCwd,
      recordedCwd: snapshot.cwd,
      workspaceRoots: [params.launchCwd],
      requested,
      restored: snapshot,
      reason: "The deeplink runtime context is untrusted or not known to be local.",
      prompt: `Mortic found intended path ${snapshot.cwd}, but the deeplink is not authoritative for local access. Confirm the project folder before continuing; recommended fallback is ${params.launchCwd}.`,
      audit: [...baseAudit, audit("runtime.snapshot.untrusted", `source=${snapshot.source ?? "unknown"}; cwd=${snapshot.cwd}`)]
    };
  }

  if (!pathExists) {
    return {
      status: "fallback",
      trusted: true,
      sameMachineUser: false,
      effectiveCwd: params.launchCwd,
      recordedCwd: snapshot.cwd,
      workspaceRoots: [params.launchCwd],
      requested,
      restored: snapshot,
      reason: "The recorded project path no longer exists on this machine.",
      prompt: `Mortic expected to restore ${snapshot.cwd}, but that path is missing. Select the moved project folder or use ${params.launchCwd}.`,
      audit: [...baseAudit, audit("runtime.path.missing", snapshot.cwd)]
    };
  }

  if (broadening.length > 0) {
    return {
      status: "needs-confirmation",
      trusted: true,
      sameMachineUser: true,
      effectiveCwd: params.launchCwd,
      recordedCwd: snapshot.cwd,
      workspaceRoots: [params.launchCwd],
      requested,
      restored: snapshot,
      reason: `The fork requested broader ${broadening.join(", ")} access than the source context recorded.`,
      prompt: `Mortic found intended path ${snapshot.cwd}, but restoring it would require broader ${broadening.join(", ")} access than the source had. Confirm before continuing; recommended fallback is ${params.launchCwd}.`,
      audit: [...baseAudit, audit("runtime.access.broader", broadening.join(","))]
    };
  }

  return {
    status: "restored",
    trusted: true,
    sameMachineUser,
    effectiveCwd: snapshot.cwd,
    recordedCwd: snapshot.cwd,
    workspaceRoots: snapshot.workspaceRoots,
    requested,
    restored: snapshot,
    reason: "Restored the local source runtime context from Codex rollout metadata.",
    audit: [...baseAudit, audit("runtime.restored", `cwd=${snapshot.cwd}`)]
  };
}
