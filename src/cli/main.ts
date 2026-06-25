#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getLiveKitStatus } from "../server/livekit.js";
import { codexProviderAdapter } from "../server/providerAdapters.js";
import { getSttStatus } from "../server/stt.js";
import { getTtsStatus } from "../server/tts.js";
import { startMorticRuntime } from "./runtime.js";

type CliOptions = {
  threadRef?: string;
  noOpen: boolean;
  apiPort?: number;
  uiPort?: number;
};

function printHelp(): void {
  console.log(`Mortic

Usage:
  npx mortic codex://threads/<thread-id>
  npx mortic doctor
  npm run dev -- codex://threads/<thread-id>

Commands:
  doctor             Diagnose the install (codex, login, python3, voice keys) and exit

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
  await startMorticRuntime({
    threadRef: options.threadRef,
    noOpen: options.noOpen,
    apiPort: options.apiPort,
    uiPort: options.uiPort,
    launchCwd: process.cwd(),
    installSignalHandlers: true
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
