#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";
import type { ViteDevServer } from "vite";

import { createMorticServer } from "../server/app.js";
import { getCodexStatus, prewarmCodexScratch, shutdownCodexBridges } from "../server/codex.js";
import { getLiveKitStatus } from "../server/livekit.js";
import { createProjectStore } from "../server/projectStorage.js";
import { codexProviderAdapter } from "../server/providerAdapters.js";
import { resolveRuntimeContext } from "../server/runtimeContext.js";
import { syncVendoredSkills } from "../server/skillSync.js";
import { createSessionStorage } from "../server/storage.js";
import { getSttStatus } from "../server/stt.js";
import { getTtsStatus } from "../server/tts.js";
import { parseThreadUri } from "../shared/threadUri.js";
import { prewarmConfirmationPrompt, prewarmThreadName } from "../shared/prewarmConfirmation.js";
import { defaultScratchSettings } from "../shared/scratchDefaults.js";

type CliOptions = {
  threadRef?: string;
  noOpen: boolean;
  apiPort?: number;
  uiPort?: number;
};

const HOST = "127.0.0.1";

function printHelp(): void {
  console.log(`Mortic

Usage:
  npx mortic codex://threads/<thread-id>
  npx mortic doctor
  npm run dev -- codex://threads/<thread-id>

Commands:
  doctor             Diagnose the install (codex, login, skills, python3, voice keys) and exit

Options:
  --no-open          Do not open the browser automatically
  --api-port <port> Override local API port
  --ui-port <port>  Override local Vite UI port in dev
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    noOpen: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--no-open") {
      options.noOpen = true;
      continue;
    }

    if (arg === "--api-port") {
      options.apiPort = Number(argv[++i]);
      continue;
    }

    if (arg === "--ui-port") {
      options.uiPort = Number(argv[++i]);
      continue;
    }

    if (!options.threadRef) {
      options.threadRef = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return options;
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

async function findFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`Could not find an available port starting at ${preferred}`);
}

function findProjectRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }

  return process.cwd();
}

function titleFromProjectRoot(root: string): string {
  const base = path.basename(root).replace(/[-_]+/g, " ").trim();
  return base ? base.replace(/\b\w/g, (char) => char.toUpperCase()) : "Mortic Project";
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

function morticHomeDir(): string {
  return path.join(homedir(), ".mortic");
}

// Packed installs keep BYOK voice secrets in ~/.mortic/.env; a source checkout
// may also carry a repo-root .env. Both are optional and either may be absent.
// Precedence: real environment variables > repo .env (dev) > ~/.mortic/.env.
// ~/.mortic/.env is read first, and the repo .env may override keys that came
// from it, but never keys that were already exported in the environment.
function loadDotEnv(root: string): string[] {
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

function doctorLine(ok: boolean, label: string, detail: string): void {
  console.log(`${ok ? "✓" : "✗"} ${label.padEnd(8)}${detail}`);
}

// `mortic doctor`: diagnose a fresh install without starting the server. The
// exit code reflects only the hard requirement (codex available + logged in);
// voice keys, python3, and LiveKit are informational because Mortic still
// works with zero keys (browser speech, local transport).
async function runDoctor(): Promise<never> {
  const root = findProjectRoot();
  const loadedEnvFiles = loadDotEnv(root);
  console.log("Mortic doctor\n");

  const provider = await codexProviderAdapter.status();
  const codexOk = provider.available;
  doctorLine(
    codexOk,
    "Codex",
    codexOk
      ? `${provider.version ?? "available"} (${provider.path ?? "on PATH"})`
      : provider.error ?? "codex executable was not found on PATH"
  );

  const loginOk = provider.loginStatus === "logged-in";
  doctorLine(
    loginOk,
    "Login",
    loginOk
      ? `logged in${provider.accountId ? ` (${provider.accountId})` : ""}`
      : `${provider.loginStatus}${provider.loginCommand ? ` — run \`${provider.loginCommand}\`` : ""}`
  );

  const skillResults = await syncVendoredSkills().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    return [{ skill: "*", action: "error" as const, detail, targetDir: "" }];
  });
  const skillsOk = skillResults.length > 0 && skillResults.every((result) => result.action !== "error");
  const skillSummary =
    skillResults
      .map((result) =>
        result.detail && result.action !== "current"
          ? `${result.skill} ${result.action} (${result.detail})`
          : `${result.skill} ${result.action}`
      )
      .join("; ") || "no vendored skills found";
  doctorLine(skillsOk, "Skills", skillSummary);

  if (process.platform === "win32") {
    doctorLine(false, "Python3", "Codex CLI PTY fallback is POSIX only and stays disabled on Windows");
  } else {
    const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
    const pythonOk = !python.error && python.status === 0;
    const pythonVersion = `${python.stdout ?? ""}${python.stderr ?? ""}`.trim();
    doctorLine(
      pythonOk,
      "Python3",
      pythonOk
        ? `${pythonVersion} — Codex CLI PTY fallback available`
        : "python3 not found on PATH — Codex CLI PTY fallback disabled"
    );
  }

  const stt = getSttStatus();
  const tts = getTtsStatus();
  const sttProviders = [
    stt.deepgramConfigured ? "deepgram" : undefined,
    stt.inworldConfigured ? "inworld" : undefined,
    stt.openAIConfigured ? "whisper" : undefined
  ].filter((value): value is string => Boolean(value));
  const ttsProviders = [
    tts.inworldConfigured ? "inworld" : undefined,
    tts.deepgramConfigured ? "deepgram" : undefined,
    tts.elevenLabsConfigured ? "elevenlabs" : undefined
  ].filter((value): value is string => Boolean(value));
  doctorLine(
    true,
    "Voice",
    sttProviders.length === 0 && ttsProviders.length === 0
      ? "browser (free, no keys)"
      : `STT ${sttProviders.join(", ") || "browser"}; TTS ${ttsProviders.join(", ") || "browser"}`
  );

  const liveKit = getLiveKitStatus();
  doctorLine(true, "LiveKit", liveKit.configured ? `configured (${liveKit.url})` : "not configured — local transport only");

  doctorLine(
    true,
    "Env",
    loadedEnvFiles.length > 0
      ? loadedEnvFiles.join(", ")
      : `no .env files (checked ${path.join(morticHomeDir(), ".env")} and ${path.join(root, ".env")})`
  );

  const ready = codexOk && loginOk;
  console.log(ready ? "\nReady: codex is available and logged in." : "\nNot ready: install the Codex CLI and run `codex login`.");
  process.exit(ready ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv[2] === "doctor") {
    await runDoctor();
  }

  const options = parseArgs(process.argv.slice(2));
  const parsed = parseThreadUri(options.threadRef);
  const root = findProjectRoot();
  const launchCwd = process.cwd();
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
  // Vendored skills must reach ~/.codex/skills before the first compile or
  // voice turn; a fresh install has nothing there yet.
  const skillSyncResults = await syncVendoredSkills().catch((error) => {
    console.warn(`Skill sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  const staticDir = path.join(root, "dist", "client");
  const hasStaticBuild = existsSync(path.join(staticDir, "index.html"));
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
    threadId: parsed.threadId,
    projectTitle: titleFromProjectRoot(root)
  });
  await projectStore.syncSession(initialSession, { type: "cli.started" });

  const app = await createMorticServer({
    storage,
    projectStore,
    staticDir: hasStaticBuild ? staticDir : undefined,
    runtimeContext,
    projectTitle: titleFromProjectRoot(root),
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

  if (hasStaticBuild) {
    url = `http://${HOST}:${apiPort}/?api=${encodeURIComponent(`http://${HOST}:${apiPort}`)}`;
  } else {
    // Packed installs always ship dist/client, so this branch only runs from a
    // source checkout. If vite is missing (it is a devDependency and absent in
    // packaged installs), fail with one clear message instead of a stack trace.
    let createViteServer: (typeof import("vite"))["createServer"];
    try {
      ({ createServer: createViteServer } = await import("vite"));
    } catch {
      console.error(
        "No dist/client build was found and vite is not installed: dev UI unavailable in packaged install; rebuild from source (`npm install && npm run build`) or reinstall the package."
      );
      process.exit(1);
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
    url = `http://${HOST}:${uiPort}/?api=${encodeURIComponent(`http://${HOST}:${apiPort}`)}`;
  }

  console.log(`\nMortic is running`);
  console.log(`Source: ${parsed.sourceUri}`);
  console.log(`API:    http://${HOST}:${apiPort}`);
  console.log(`UI:     ${url}`);
  console.log(`Data:   ${storage.sessionDir}`);
  console.log(`Project:${projectStore.projectDir}`);
  console.log(`Runtime:${runtimeContext.status} cwd ${runtimeContext.effectiveCwd}`);
  if (runtimeContext.recordedCwd && runtimeContext.recordedCwd !== runtimeContext.effectiveCwd) {
    console.log(`Intended:${runtimeContext.recordedCwd}`);
  }
  if (runtimeContext.prompt) {
    console.log(`Prompt: ${runtimeContext.prompt}`);
  }
  console.log(`Env:    ${loadedEnvFiles.length > 0 ? loadedEnvFiles.join(", ") : "no .env files (browser voice only unless keys are exported)"}`);
  for (const result of skillSyncResults) {
    if (result.action === "current") continue;
    const note = result.detail ? ` (${result.detail})` : "";
    console.log(`Skill:  ${result.skill} ${result.action}${note}`);
  }
  console.log(`Codex:  ${codex.available ? `${codex.version ?? "available"} at ${codex.path}` : codex.error}`);
  console.log("\nPress Ctrl+C to stop.\n");

  // Boot warm must mirror the exact settings the browser's first prewarm will
  // request (model/effort/mode/caveman are all part of the scratch cache key),
  // or the boot fork is wasted and the first user turn queues behind a second
  // fork. The confirmation turn below holds the bridge operation lock for a few
  // seconds right at launch, before the browser has even opened; without it the
  // first user turn pays the provider context-priming cost itself and starts
  // with no in-context example of the voice NDJSON contract, which is exactly
  // the "first message is very late, then gets repaired" failure.
  if (codex.available) {
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
        if (label === "App-server scratch fork validated") {
          console.log(`Voice scratch prewarmed: ${detail}`);
        }
        if (label === "App-server prewarm confirmation turn completed") {
          console.log("Voice scratch primed: confirmation turn completed");
        }
      }
    }).catch((error) => {
      console.warn(`Voice scratch prewarm failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else {
    console.warn("Skipping voice scratch prewarm: codex is not available. The app serves the onboarding screen until it is.");
  }

  if (!options.noOpen) {
    await open(url);
  }

  const shutdown = async () => {
    await shutdownCodexBridges("Mortic shutdown");
    await vite?.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
