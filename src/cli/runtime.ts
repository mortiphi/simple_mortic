import { existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";
import type { ViteDevServer } from "vite";

import { createMorticServer } from "../server/app.js";
import { getCodexStatus, listCodexRecentThreads, prewarmCodexScratch, shutdownCodexBridges } from "../server/codex.js";
import { createProjectStore } from "../server/projectStorage.js";
import { codexProviderAdapter } from "../server/providerAdapters.js";
import { resolveRuntimeContext } from "../server/runtimeContext.js";
import { syncVendoredSkills } from "../server/skillSync.js";
import { createSessionStorage } from "../server/storage.js";
import { defaultScratchSettings } from "../shared/scratchDefaults.js";
import { parseThreadUri } from "../shared/threadUri.js";
import { prewarmConfirmationPrompt, prewarmThreadName } from "../shared/prewarmConfirmation.js";

const HOST = "127.0.0.1";
const PLACEHOLDER_THREAD_ID = "00000000-0000-0000-0000-000000000000";

export type StartedMorticRuntime = {
  apiBase: string;
  apiPort: number;
  uiPort: number;
  url: string;
  sourceUri: string;
  threadId: string;
  projectRoot: string;
  sessionDir: string;
  projectDir: string;
  close: () => Promise<void>;
};

export type StartMorticRuntimeOptions = {
  threadRef?: string;
  noOpen?: boolean;
  apiPort?: number;
  uiPort?: number;
  launchCwd?: string;
  preferDevServer?: boolean;
  allowRecentThreadFallback?: boolean;
  allowPlaceholderThread?: boolean;
  installSignalHandlers?: boolean;
  onLog?: (line: string) => void;
  onWarn?: (line: string) => void;
};

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, HOST);
  });
}

async function findFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(`Could not find an available port starting at ${preferred}`);
}

export function findProjectRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(current, "package.json"))) return current;
    current = path.dirname(current);
  }

  return process.cwd();
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function morticHomeDir(): string {
  return path.join(homedir(), ".mortic");
}

export function loadDotEnv(root: string): string[] {
  try {
    mkdirSync(morticHomeDir(), { recursive: true });
  } catch {
    // An unwritable home directory must not block boot or doctor.
  }

  const loaded: string[] = [];
  const dotEnvKeys = new Set<string>();
  for (const envPath of new Set([path.join(morticHomeDir(), ".env"), path.join(root, ".env")])) {
    if (!existsSync(envPath)) continue;

    const text = readFileSync(envPath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;

      const key = line.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined && !dotEnvKeys.has(key)) continue;
      process.env[key] = parseDotEnvValue(line.slice(separator + 1));
      dotEnvKeys.add(key);
    }

    loaded.push(envPath);
  }

  return loaded;
}

export async function latestCodexThreadRef(): Promise<string | undefined> {
  const [thread] = await listCodexRecentThreads({ limit: 1 });
  return thread?.sourceUri;
}

async function resolveThreadRef(options: StartMorticRuntimeOptions): Promise<{ threadRef: string; placeholder: boolean }> {
  if (options.threadRef?.trim()) {
    try {
      const parsed = parseThreadUri(options.threadRef);
      return { threadRef: parsed.sourceUri, placeholder: false };
    } catch (error) {
      if (!options.allowRecentThreadFallback && !options.allowPlaceholderThread) throw error;
    }
  }

  if (options.allowRecentThreadFallback) {
    const latest = await latestCodexThreadRef().catch(() => undefined);
    if (latest) return { threadRef: latest, placeholder: false };
  }

  if (options.allowPlaceholderThread) {
    return { threadRef: `codex://threads/${PLACEHOLDER_THREAD_ID}`, placeholder: true };
  }

  throw new Error("Pass a Codex thread URI, for example: npx mortic codex://threads/<thread-id>");
}

export async function startMorticRuntime(options: StartMorticRuntimeOptions): Promise<StartedMorticRuntime> {
  const log = options.onLog ?? console.log;
  const warn = options.onWarn ?? console.warn;
  const selectedThread = await resolveThreadRef(options);
  const parsed = parseThreadUri(selectedThread.threadRef);
  const root = findProjectRoot();
  const launchCwd = options.launchCwd ?? process.cwd();
  const runtimeContext = await resolveRuntimeContext({
    threadId: parsed.threadId,
    launchCwd,
    morticRoot: root,
    requested: {
      filesystem: "read-only",
      workspaceRoots: [],
      network: "unknown",
      approval: "never"
    }
  });
  const loadedEnvFiles = loadDotEnv(root);
  const skillSyncResults = await syncVendoredSkills().catch((error) => {
    warn(`Skill sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  const staticDir = path.join(root, "dist", "client");
  const hasStaticBuild = !options.preferDevServer && existsSync(path.join(staticDir, "index.html"));
  const apiPort = options.apiPort ?? (await findFreePort(5152));
  const uiPort = options.uiPort ?? (hasStaticBuild ? apiPort : await findFreePort(5173));

  const codex = await getCodexStatus();
  const storage = await createSessionStorage({
    sourceUri: parsed.sourceUri,
    threadId: parsed.threadId,
    codex,
    runtimeContext
  });
  const initialSession = await storage.read();
  const projectStore = await createProjectStore({
    workspacePath: runtimeContext.effectiveCwd,
    sourceUri: parsed.sourceUri,
    threadId: parsed.threadId
  });
  await projectStore.syncSession(initialSession, { type: "cli.started" });

  const app = await createMorticServer({
    storage,
    projectStore,
    staticDir: hasStaticBuild ? staticDir : undefined,
    runtimeContext,
    resolveRuntimeContext: async ({ threadId }) => await resolveRuntimeContext({
      threadId,
      launchCwd,
      morticRoot: root,
      requested: {
        filesystem: "read-only",
        workspaceRoots: [],
        network: "unknown",
        approval: "never"
      }
    })
  });

  await app.listen({ host: HOST, port: apiPort });

  let vite: ViteDevServer | undefined;
  let url: string;
  const apiBase = `http://${HOST}:${apiPort}`;

  if (hasStaticBuild) {
    url = `${apiBase}/?api=${encodeURIComponent(apiBase)}`;
  } else {
    let createViteServer: (typeof import("vite"))["createServer"];
    try {
      ({ createServer: createViteServer } = await import("vite"));
    } catch {
      throw new Error(
        "No dist/client build was found and vite is not installed: dev UI unavailable in packaged install; rebuild from source (`npm install && npm run build`) or reinstall the package."
      );
    }
    vite = await createViteServer({
      root,
      clearScreen: false,
      logLevel: "info",
      server: {
        host: HOST,
        port: uiPort,
        strictPort: true
      }
    });
    await vite.listen();
    url = `http://${HOST}:${uiPort}/?api=${encodeURIComponent(apiBase)}`;
  }

  log(`\nMortic is running`);
  log(`Source: ${parsed.sourceUri}${selectedThread.placeholder ? " (placeholder)" : ""}`);
  log(`API:    ${apiBase}`);
  log(`UI:     ${url}`);
  log(`Data:   ${storage.sessionDir}`);
  log(`Project:${projectStore.projectDir}`);
  log(`Runtime:${runtimeContext.status} cwd ${runtimeContext.effectiveCwd}`);
  if (runtimeContext.recordedCwd && runtimeContext.recordedCwd !== runtimeContext.effectiveCwd) {
    log(`Intended:${runtimeContext.recordedCwd}`);
  }
  if (runtimeContext.prompt) log(`Prompt: ${runtimeContext.prompt}`);
  log(`Env:    ${loadedEnvFiles.length > 0 ? loadedEnvFiles.join(", ") : "no .env files (browser voice only unless keys are exported)"}`);
  for (const result of skillSyncResults) {
    if (result.action === "current") continue;
    const note = result.detail ? ` (${result.detail})` : "";
    log(`Skill:  ${result.skill} ${result.action}${note}`);
  }
  log(`Codex:  ${codex.available ? `${codex.version ?? "available"} at ${codex.path}` : codex.error}`);
  log("\nPress Ctrl+C to stop.\n");

  if (codex.available && !selectedThread.placeholder) {
    const startupThreadName = (await codexProviderAdapter.threadName(parsed.threadId)) ?? prewarmThreadName(parsed.threadId);
    const startupConfirmation = prewarmConfirmationPrompt({
      threadName: startupThreadName,
      scratchMode: defaultScratchSettings.scratchMode
    });
    void prewarmCodexScratch({
      threadId: parsed.threadId,
      runtimeContext,
      codexModel: "default",
      reasoningEffort: defaultScratchSettings.reasoningEffort,
      scratchMode: defaultScratchSettings.scratchMode,
      voiceCaveman: defaultScratchSettings.voiceCaveman,
      confirmationPrompt: startupConfirmation.prompt,
      onEvent: async (label, detail) => {
        if (label === "App-server scratch fork validated") log(`Voice scratch prewarmed: ${detail}`);
        if (label === "App-server prewarm confirmation turn completed") log("Voice scratch primed: confirmation turn completed");
      }
    }).catch((error) => {
      warn(`Voice scratch prewarm failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else if (!codex.available) {
    warn("Skipping voice scratch prewarm: codex is not available. The app serves the onboarding screen until it is.");
  }

  if (!options.noOpen) await open(url);

  const close = async () => {
    await shutdownCodexBridges("Mortic shutdown");
    await vite?.close();
    await app.close();
  };

  if (options.installSignalHandlers) {
    const shutdown = async () => {
      await close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  return {
    apiBase,
    apiPort,
    uiPort,
    url,
    sourceUri: parsed.sourceUri,
    threadId: parsed.threadId,
    projectRoot: root,
    sessionDir: storage.sessionDir,
    projectDir: projectStore.projectDir,
    close
  };
}
