#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const OUT_DIR = "/tmp/simple-mortic-app-server-probe";
const TERMINAL = new Set(["completed", "failed", "interrupted"]);

const CASES = [
  {
    name: "simple",
    text: "Answer in one short sentence: app-server activity probe simple case."
  },
  {
    name: "command",
    text: "If a shell command is available, run a harmless command to print mortic-app-server-probe, then answer in one short sentence."
  },
  {
    name: "file_context",
    text: "Inspect package.json if available and answer in one short sentence with the package name."
  },
  {
    name: "diff_or_plan",
    text: "Prepare a no-op implementation plan for Simple Mortic without editing files, then answer in one short sentence."
  }
];

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    api: process.env.MORTIC_API_URL || "http://127.0.0.1:5262",
    timeoutMs: 120_000,
    pollMs: 500
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--api") config.api = args[++index] ?? config.api;
    else if (args[index] === "--timeout-ms") config.timeoutMs = Number(args[++index] ?? config.timeoutMs);
    else if (args[index] === "--poll-ms") config.pollMs = Number(args[++index] ?? config.pollMs);
  }
  config.api = config.api.replace(/\/$/, "");
  return config;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(config, route, init = {}) {
  const response = await fetch(`${config.api}${route}`, {
    method: init.method ?? "GET",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(json?.error ?? text ?? `HTTP ${response.status}`);
  }
  return json;
}

async function waitIdle(config) {
  const started = performance.now();
  while (performance.now() - started < 60_000) {
    const payload = await requestJson(config, "/api/session");
    if (payload.session?.activeTurn?.status !== "running") return payload;
    await sleep(config.pollMs);
  }
  throw new Error("Timed out waiting for existing turn to finish");
}

async function runCase(config, testCase, sessionPayload) {
  await waitIdle(config);
  const now = Date.now();
  const started = performance.now();
  const post = await requestJson(config, "/api/turn", {
    method: "POST",
    body: {
      text: testCase.text,
      scratchMode: "voice",
      reasoningEffort: "none",
      codexModel: "default",
      inputPolicy: "push_to_talk",
      transportProvider: "local-browser",
      transportState: "connected",
      sttMetrics: {
        provider: sessionPayload.stt?.defaultProvider ?? "browser",
        segmentCount: 1,
        payloadBytes: 2000,
        recordingDurationMs: 700,
        recordingStartedAt: new Date(now - 800).toISOString(),
        recordingStoppedAt: new Date(now - 100).toISOString(),
        finalSttReadyMs: 650,
        sendAfterSpeechMs: 90,
        recognitionErrors: []
      }
    }
  });

  while (performance.now() - started < config.timeoutMs) {
    const payload = await requestJson(config, `/api/turn/${post.turnId}`);
    if (TERMINAL.has(payload.turn?.status)) {
      const trace = payload.turn?.appServerTrace ?? payload.turn?.progressTrace ?? null;
      return {
        name: testCase.name,
        turnId: post.turnId,
        status: payload.turn?.status,
        wallMs: Math.round(performance.now() - started),
        firstActivityMs: trace?.firstActivityMs,
        firstAssistantDeltaMs: trace?.firstAssistantDeltaMs,
        metrics: payload.turn?.metrics,
        rawNotifications: trace?.rawNotifications ?? [],
        activities: trace?.activities ?? [],
        mappedEvents: trace?.mappedEvents ?? []
      };
    }
    await sleep(config.pollMs);
  }
  throw new Error(`Timed out waiting for ${testCase.name}`);
}

async function main() {
  const config = parseArgs();
  const startedAt = new Date().toISOString();
  const sessionPayload = await requestJson(config, "/api/session");
  const results = [];
  for (const testCase of CASES) {
    process.stdout.write(`probing ${testCase.name}...\n`);
    results.push(await runCase(config, testCase, sessionPayload));
  }
  await mkdir(OUT_DIR, { recursive: true });
  const outputPath = path.join(OUT_DIR, `app-server-probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const output = {
    probe: "simple-mortic-app-server-events",
    startedAt,
    completedAt: new Date().toISOString(),
    config,
    results
  };
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    cases: results.map((result) => ({
      name: result.name,
      status: result.status,
      firstActivityMs: result.firstActivityMs,
      firstAssistantDeltaMs: result.firstAssistantDeltaMs,
      rawNotifications: result.rawNotifications.length,
      activities: result.activities.length
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
