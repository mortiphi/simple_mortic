#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";
import type { ViteDevServer } from "vite";

import { createMorticServer } from "../server/app.js";
import { getCodexStatus, prewarmCodexScratch, resetCodexScratch } from "../server/codex.js";
import { createProjectStore } from "../server/projectStorage.js";
import { resolveRuntimeContext } from "../server/runtimeContext.js";
import { createSessionStorage } from "../server/storage.js";
import { parseThreadUri } from "../shared/threadUri.js";
import { prewarmConfirmationPrompt, prewarmThreadName } from "../shared/prewarmConfirmation.js";

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
  npm run dev -- codex://threads/<thread-id>

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

function loadDotEnv(root: string): boolean {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return false;

  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = parseDotEnvValue(line.slice(separator + 1));
  }

  return true;
}

async function main(): Promise<void> {
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
  const loadedDotEnv = loadDotEnv(root);
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

  if (hasStaticBuild) {
    url = `http://${HOST}:${apiPort}/?api=${encodeURIComponent(`http://${HOST}:${apiPort}`)}`;
  } else {
    const { createServer: createViteServer } = await import("vite");
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
  console.log(`Env:    ${loadedDotEnv ? path.join(root, ".env") : "no .env file"}`);
  console.log(`Codex:  ${codex.available ? `${codex.version ?? "available"} at ${codex.path}` : codex.error}`);
  console.log("\nPress Ctrl+C to stop.\n");

  const startupConfirmation = prewarmConfirmationPrompt({
    threadName: prewarmThreadName(parsed.threadId),
    scratchMode: "voice"
  });

  void prewarmCodexScratch({
    threadId: parsed.threadId,
    runtimeContext,
    codexModel: "default",
    reasoningEffort: "medium",
    scratchMode: "voice",
    confirmationPrompt: startupConfirmation.prompt,
    onEvent: async (label, detail) => {
      if (label === "App-server scratch fork validated") {
        console.log(`Voice scratch prewarmed: ${detail}`);
      }
      if (label === "App-server prewarm confirmation turn completed") {
        console.log(`Voice scratch confirmation requested: ${startupConfirmation.expected}`);
      }
    }
  }).catch((error) => {
    console.warn(`Voice scratch prewarm failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (!options.noOpen) {
    await open(url);
  }

  const shutdown = async () => {
    await resetCodexScratch();
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
