#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const DEFAULT_APP_URL = "http://127.0.0.1:5152/?api=http%3A%2F%2F127.0.0.1%3A5152";
const DEFAULT_POLL_MS = 500;
const DEFAULT_TURN_TIMEOUT_MS = 60_000;
const DEFAULT_PREWARM_TIMEOUT_MS = 60_000;
const DEFAULT_UI_TIMEOUT_MS = 5_000;

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const RUNNABILITY_PROMPTS = [
  {
    name: "cold first turn",
    kind: "cold",
    text: "hello",
    reasoningEffort: "none",
    thresholds: { firstDeltaMs: 10_000, totalMs: 45_000 }
  },
  {
    name: "warm turn 1",
    kind: "warm",
    text: "say ok in one short sentence",
    reasoningEffort: "none",
    thresholds: { firstDeltaMs: 5_000, totalMs: 20_000 }
  },
  {
    name: "warm turn 2",
    kind: "warm",
    text: "what is the next action in five words",
    reasoningEffort: "none",
    thresholds: { firstDeltaMs: 5_000, totalMs: 20_000 }
  }
];
const FAILURE_RECOVERY_PROMPTS = [
  {
    name: "minimal failure regression",
    kind: "failure",
    text: "say ok in one short sentence",
    reasoningEffort: "minimal",
    expectFailure: true,
    thresholds: { firstDeltaMs: 5_000, totalMs: 20_000 }
  },
  {
    name: "recovery valid turn",
    kind: "recovery",
    text: "recover with ok",
    reasoningEffort: "none",
    thresholds: { firstDeltaMs: 5_000, totalMs: 20_000 }
  }
];

function runtimeContext() {
  const hasProcess = typeof process !== "undefined" && process && typeof process.cwd === "function";
  return {
    argv: hasProcess && Array.isArray(process.argv) ? process.argv : [],
    cwd: globalThis.nodeRepl?.cwd ?? (hasProcess ? process.cwd() : path.dirname(fileURLToPath(import.meta.url))),
    env: hasProcess && process.env ? process.env : {},
    homeDir: globalThis.nodeRepl?.homeDir ?? homedir()
  };
}

function sanitizeStamp(value = new Date().toISOString()) {
  return value.replace(/[:.]/g, "-");
}

function ms(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function truncate(value, max = 220) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function maybeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function apiUrlFromAppUrl(appUrl) {
  const parsed = new URL(appUrl);
  const explicitApi = parsed.searchParams.get("api");
  if (explicitApi) return explicitApi.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, "");
}

function cacheBustedUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("morticEval", Date.now().toString(36));
  return parsed.toString();
}

function parseArgs(argv, env) {
  const options = {
    appUrl: env.MORTIC_EVAL_APP_URL ?? DEFAULT_APP_URL,
    apiUrl: env.MORTIC_EVAL_API_URL,
    outDir: env.MORTIC_EVAL_OUT_DIR,
    pollMs: Number(env.MORTIC_EVAL_POLL_MS ?? DEFAULT_POLL_MS),
    turnTimeoutMs: Number(env.MORTIC_EVAL_TURN_TIMEOUT_MS ?? DEFAULT_TURN_TIMEOUT_MS),
    prewarmTimeoutMs: Number(env.MORTIC_EVAL_PREWARM_TIMEOUT_MS ?? DEFAULT_PREWARM_TIMEOUT_MS),
    uiTimeoutMs: Number(env.MORTIC_EVAL_UI_TIMEOUT_MS ?? DEFAULT_UI_TIMEOUT_MS),
    includeFailure: env.MORTIC_EVAL_SKIP_FAILURE !== "1",
    strictUi: env.MORTIC_EVAL_STRICT_UI === "1",
    uiDriver: env.MORTIC_EVAL_UI_DRIVER ?? "auto",
    jsonOnly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-url" || arg === "--url") options.appUrl = argv[++index];
    else if (arg === "--api-url" || arg === "--api") options.apiUrl = argv[++index];
    else if (arg === "--out-dir") options.outDir = argv[++index];
    else if (arg === "--poll-ms") options.pollMs = Number(argv[++index]);
    else if (arg === "--turn-timeout-ms") options.turnTimeoutMs = Number(argv[++index]);
    else if (arg === "--prewarm-timeout-ms") options.prewarmTimeoutMs = Number(argv[++index]);
    else if (arg === "--ui-timeout-ms") options.uiTimeoutMs = Number(argv[++index]);
    else if (arg === "--ui-driver") options.uiDriver = argv[++index];
    else if (arg === "--skip-failure") options.includeFailure = false;
    else if (arg === "--strict-ui") options.strictUi = true;
    else if (arg === "--json-only") options.jsonOnly = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      return { ...options, help: true };
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.apiUrl = (options.apiUrl ?? apiUrlFromAppUrl(options.appUrl)).replace(/\/+$/, "");
  return options;
}

function printHelp() {
  console.log(`Mortic runnability eval

Usage:
  node scripts/eval_mortic_runnability.mjs
  node scripts/eval_mortic_runnability.mjs --app-url http://127.0.0.1:5152/?api=http%3A%2F%2F127.0.0.1%3A5152

Options:
  --api-url <url>             API base URL. Defaults to the app URL's api query param.
  --out-dir <path>            Output directory. Defaults to evals/runnability.
  --poll-ms <ms>              Poll interval for turn completion.
  --turn-timeout-ms <ms>      Per-turn timeout.
  --prewarm-timeout-ms <ms>   Prewarm timeout.
  --ui-driver <auto|iab|playwright|http|none>
  --strict-ui                 Treat missing browser automation as a failure.
  --skip-failure              Skip the known minimal-reasoning failure probe.
  --json-only                 Print only the result JSON.
`);
}

async function requestJson(apiUrl, endpoint, options = {}) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const url = endpoint.startsWith("http") ? endpoint : `${apiUrl}${endpoint}`;
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.headers ?? {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: performance.now() - startedAt,
      json,
      text
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function addFlow(result, flow) {
  result.flows.push({
    flow: flow.flow,
    status: flow.status,
    latencyMs: maybeNumber(flow.latencyMs),
    reason: truncate(flow.reason ?? "", 500),
    details: flow.details ?? {}
  });
}

function providerSummary(sessionResponse, livekitStatus) {
  const session = sessionResponse?.session;
  return {
    sourceUri: session?.sourceUri,
    threadId: session?.threadId,
    activeTurn: session?.activeTurn
      ? {
          id: session.activeTurn.id,
          status: session.activeTurn.status,
          userText: session.activeTurn.userText,
          reasoningEffort: session.activeTurn.reasoningEffort,
          error: session.activeTurn.error
        }
      : null,
    scratchCheckpoint: session?.forkCheckpoint ?? null,
    defaults: {
      reasoningEffort: sessionResponse?.defaultReasoningEffort,
      codexModel: sessionResponse?.defaultCodexModel,
      scratchMode: sessionResponse?.defaultScratchMode
    },
    providers: {
      stt: sessionResponse?.stt,
      tts: sessionResponse?.tts,
      transport: livekitStatus ?? sessionResponse?.livekit
    }
  };
}

async function waitForNoRunningTurn(apiUrl, pollMs, timeoutMs) {
  const startedAt = performance.now();
  let latest = null;
  while (performance.now() - startedAt < timeoutMs) {
    latest = await requestJson(apiUrl, "/api/session", { timeoutMs: 5_000 });
    const active = latest.json?.session?.activeTurn;
    if (!active || active.status !== "running") {
      return { ok: true, elapsedMs: performance.now() - startedAt, session: latest.json?.session };
    }
    await sleep(pollMs);
  }
  return {
    ok: false,
    elapsedMs: performance.now() - startedAt,
    session: latest?.json?.session,
    reason: "Timed out waiting for the current running Mortic turn to finish."
  };
}

function sleep(msValue) {
  return new Promise((resolve) => setTimeout(resolve, msValue));
}

async function probeHealthAndReadiness(result) {
  const health = await requestJson(result.config.apiUrl, "/api/health", { timeoutMs: 5_000 });
  const healthOk = health.ok && health.json?.ok === true;
  addFlow(result, {
    flow: "api health",
    status: healthOk && health.elapsedMs < 500 ? "pass" : "fail",
    latencyMs: health.elapsedMs,
    reason: healthOk ? "ok" : health.error ?? health.text ?? `HTTP ${health.status}`,
    details: { status: health.status, body: health.json ?? health.text ?? null, targetMs: 500 }
  });

  const session = await requestJson(result.config.apiUrl, "/api/session", { timeoutMs: 8_000 });
  const livekit = await requestJson(result.config.apiUrl, "/api/livekit/status", { timeoutMs: 5_000 });
  result.readiness = providerSummary(session.json, livekit.json);
  const sessionOk = session.ok && Boolean(session.json?.session?.threadId);
  const livekitOk = livekit.ok && typeof livekit.json?.defaultTransport === "string";
  const activeStatus = result.readiness.activeTurn?.status ?? "none";
  addFlow(result, {
    flow: "session readiness",
    status: sessionOk && livekitOk ? (activeStatus === "running" ? "warn" : "pass") : "fail",
    latencyMs: session.elapsedMs + livekit.elapsedMs,
    reason: sessionOk
      ? `source ${result.readiness.sourceUri}; active turn ${activeStatus}; transport ${result.readiness.providers.transport?.defaultTransport ?? "unknown"}`
      : session.error ?? session.text ?? `HTTP ${session.status}`,
    details: {
      sessionStatus: session.status,
      livekitStatus: livekit.status,
      readiness: result.readiness
    }
  });
}

async function findBrowserClientPath(homeDir) {
  const baseDir = path.join(homeDir, ".codex", "plugins", "cache", "openai-bundled", "browser");
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(baseDir, entry.name, "scripts", "browser-client.mjs");
    if (!existsSync(candidate)) continue;
    const info = await stat(candidate).catch(() => null);
    candidates.push({ candidate, mtimeMs: info?.mtimeMs ?? 0 });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.candidate ?? null;
}

function uiReadinessFromText(text) {
  const normalized = String(text ?? "").replace(/\r/g, "");
  const runtimeBlock = normalized.match(/Runtime state([\s\S]*?)(?:Scratch|Open transcript|Say or type|Voice controls)/i)?.[1] ?? normalized;
  const flags = {
    transportReady: /Transport\s+(Connected|Ready|Local|Local Browser)/i.test(runtimeBlock),
    micReady: /Mic\s+(PTT ready|Ready|Connected|Available)/i.test(runtimeBlock),
    codexReady: /Codex\s+(Scratch ready|Ready)/i.test(runtimeBlock) || /Scratch ready/i.test(runtimeBlock),
    speechReady: /Speech\s+Ready/i.test(runtimeBlock) || /Ready\s+Scratch ready/i.test(normalized)
  };
  const staleIdleThinking = /\bIDLE\b/i.test(normalized) && /Debug\s*\/\s*Telemetry[\s\S]*Thinking/i.test(normalized);
  return {
    flags,
    staleIdleThinking,
    runtimeText: truncate(runtimeBlock, 500)
  };
}

async function probeUiWithInAppBrowser(result) {
  if (!globalThis.nodeRepl) {
    return {
      status: "skip",
      reason: "Codex in-app browser runtime is not available to this Node process."
    };
  }
  const browserClientPath = await findBrowserClientPath(result.config.homeDir);
  if (!browserClientPath) {
    return {
      status: "fail",
      reason: "Could not find the Browser plugin browser-client.mjs."
    };
  }

  const { setupBrowserRuntime } = await import(pathToFileURL(browserClientPath).href);
  if (!globalThis.agent) {
    await setupBrowserRuntime({ globals: globalThis });
  }
  if (!globalThis.browser) {
    globalThis.browser = await agent.browsers.get("iab");
  }
  await browser.nameSession("🔎 Mortic eval");
  const visibility = await browser.capabilities.get("visibility");
  if (visibility?.set) await visibility.set(true);
  const tab = globalThis.morticEvalTab ?? (await browser.tabs.selected()) ?? (await browser.tabs.new());
  globalThis.morticEvalTab = tab;

  const startedAt = performance.now();
  await tab.goto(cacheBustedUrl(result.config.appUrl));
  await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: result.config.uiTimeoutMs });

  let bodyText = "";
  let sourceValue = "";
  while (performance.now() - startedAt < result.config.uiTimeoutMs) {
    bodyText = await tab.playwright.evaluate(() => document.body?.innerText ?? "", undefined, { timeoutMs: 1_000 });
    sourceValue = await tab.playwright.evaluate(
      () => {
        const input = document.querySelector('input[aria-label="Source"], input[placeholder="codex://threads/<thread-id>"]');
        return input && "value" in input ? String(input.value) : "";
      },
      undefined,
      { timeoutMs: 1_000 }
    );
    if (bodyText.includes("Mortic") && sourceValue.startsWith("codex://threads/")) break;
    await sleep(100);
  }

  const ready = uiReadinessFromText(bodyText);
  const elapsedMs = performance.now() - startedAt;
  const flagsReady = Object.values(ready.flags).every(Boolean);
  return {
    status: bodyText.includes("Mortic") && flagsReady && !ready.staleIdleThinking ? "pass" : "fail",
    latencyMs: elapsedMs,
    reason: ready.staleIdleThinking
      ? "Top runtime looked idle while Debug / Telemetry showed Thinking."
      : flagsReady
        ? `visible source ${sourceValue || "unknown"}`
        : `missing ready flags ${Object.entries(ready.flags).filter(([, value]) => !value).map(([key]) => key).join(", ")}`,
    details: {
      driver: "iab",
      sourceValue,
      ...ready
    }
  };
}

async function probeUiWithPlaywright(result) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return {
      status: "skip",
      reason: "Playwright is not installed in this workspace."
    };
  }

  const browserInstance = await chromium.launch({ headless: true });
  try {
    const page = await browserInstance.newPage();
    const startedAt = performance.now();
    await page.goto(cacheBustedUrl(result.config.appUrl), { waitUntil: "domcontentloaded", timeout: result.config.uiTimeoutMs });
    await page.waitForSelector("main", { timeout: result.config.uiTimeoutMs });
    let bodyText = "";
    let sourceValue = "";
    while (performance.now() - startedAt < result.config.uiTimeoutMs) {
      bodyText = await page.locator("body").innerText({ timeout: 1_000 });
      sourceValue = await page
        .locator('input[aria-label="Source"], input[placeholder="codex://threads/<thread-id>"]')
        .inputValue({ timeout: 1_000 })
        .catch(() => "");
      if (bodyText.includes("Mortic") && sourceValue.startsWith("codex://threads/")) break;
      await sleep(100);
    }
    const ready = uiReadinessFromText(bodyText);
    const elapsedMs = performance.now() - startedAt;
    const flagsReady = Object.values(ready.flags).every(Boolean);
    return {
      status: bodyText.includes("Mortic") && flagsReady && !ready.staleIdleThinking ? "pass" : "fail",
      latencyMs: elapsedMs,
      reason: ready.staleIdleThinking
        ? "Top runtime looked idle while Debug / Telemetry showed Thinking."
        : flagsReady
          ? `visible source ${sourceValue || "unknown"}`
          : `missing ready flags ${Object.entries(ready.flags).filter(([, value]) => !value).map(([key]) => key).join(", ")}`,
      details: {
        driver: "playwright",
        sourceValue,
        ...ready
      }
    };
  } finally {
    await browserInstance.close();
  }
}

async function probeUiWithHttp(result) {
  const response = await requestJson("", result.config.appUrl, {
    timeoutMs: result.config.uiTimeoutMs,
    headers: { Accept: "text/html" }
  });
  const htmlHasRoot = typeof response.text === "string" && response.text.includes('<div id="root"');
  return {
    status: result.config.strictUi ? "fail" : "warn",
    latencyMs: response.elapsedMs,
    reason: htmlHasRoot
      ? "Served app shell, but no browser automation driver was available for visible ready-state timing."
      : response.error ?? response.text ?? `HTTP ${response.status}`,
    details: {
      driver: "http",
      status: response.status,
      htmlHasRoot
    }
  };
}

async function probeUiBoot(result) {
  let ui;
  if (result.config.uiDriver === "none") {
    ui = { status: "skip", reason: "UI probe disabled by --ui-driver none." };
  } else if (result.config.uiDriver === "iab") {
    ui = await probeUiWithInAppBrowser(result).catch((error) => ({
      status: "fail",
      reason: error instanceof Error ? error.message : String(error)
    }));
  } else if (result.config.uiDriver === "playwright") {
    ui = await probeUiWithPlaywright(result).catch((error) => ({
      status: "fail",
      reason: error instanceof Error ? error.message : String(error)
    }));
  } else {
    ui = await probeUiWithInAppBrowser(result).catch((error) => ({
      status: "skip",
      reason: error instanceof Error ? error.message : String(error)
    }));
    if (ui.status === "skip") {
      ui = await probeUiWithPlaywright(result).catch((error) => ({
        status: "skip",
        reason: error instanceof Error ? error.message : String(error)
      }));
    }
    if (ui.status === "skip") {
      ui = await probeUiWithHttp(result);
    }
  }

  const status = ui.status === "pass" && maybeNumber(ui.latencyMs) < 2_000
    ? "pass"
    : ui.status === "pass"
      ? "fail"
      : ui.status;
  addFlow(result, {
    flow: "ui boot readiness",
    status: result.config.strictUi && status === "warn" ? "fail" : status,
    latencyMs: ui.latencyMs,
    reason: status === "pass" ? ui.reason : ui.reason ?? "UI readiness failed",
    details: {
      targetMs: 2_000,
      ...ui.details
    }
  });
}

function extractScratchId(prewarmResponse) {
  const checkpointId = prewarmResponse?.session?.forkCheckpoint?.scratchThreadId;
  if (checkpointId) return checkpointId;
  const validated = prewarmResponse?.logs?.find((log) => /scratch fork validated/i.test(log.label));
  return validated?.detail?.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] ?? null;
}

async function prewarm(result) {
  const ready = await waitForNoRunningTurn(result.config.apiUrl, result.config.pollMs, 60_000);
  if (!ready.ok) {
    addFlow(result, {
      flow: "prewarm",
      status: "fail",
      latencyMs: ready.elapsedMs,
      reason: ready.reason,
      details: { activeTurn: ready.session?.activeTurn ?? null }
    });
    return;
  }

  const response = await requestJson(result.config.apiUrl, "/api/session/prewarm", {
    method: "POST",
    timeoutMs: result.config.prewarmTimeoutMs,
    body: {
      scratchMode: "voice",
      reasoningEffort: "none",
      codexModel: "default"
    }
  });
  const scratchId = extractScratchId(response.json);
  result.prewarm = {
    ok: response.ok,
    status: response.status,
    prewarmMs: response.json?.prewarmMs ?? response.elapsedMs,
    scratchId,
    error: response.json?.error,
    logs: response.json?.logs ?? []
  };
  addFlow(result, {
    flow: "prewarm",
    status: response.ok ? "pass" : (response.json?.error ? "warn" : "fail"),
    latencyMs: response.json?.prewarmMs ?? response.elapsedMs,
    reason: response.ok
      ? `scratch ${scratchId ?? "unknown"}`
      : response.json?.error ?? response.error ?? response.text ?? `HTTP ${response.status}`,
    details: result.prewarm
  });
}

function makeTurnPayload(text, reasoningEffort, readiness) {
  const now = Date.now();
  const startedAt = new Date(now - 900).toISOString();
  const stoppedAt = new Date(now - 100).toISOString();
  const sttProvider = readiness?.providers?.stt?.defaultProvider ?? "browser";
  const transportProvider = readiness?.providers?.transport?.defaultTransport ?? "local-browser";
  return {
    text,
    scratchMode: "voice",
    reasoningEffort,
    codexModel: "default",
    inputPolicy: "push_to_talk",
    transportProvider,
    transportState: transportProvider === "livekit-webrtc" ? "connected" : "connected",
    transportStats: {
      packetLoss: 0,
      jitterMs: 0,
      rttMs: transportProvider === "livekit-webrtc" ? 25 : 0,
      reconnects: 0,
      trackState: "live",
      muted: false,
      audioLevel: 0.04
    },
    sttMetrics: {
      provider: sttProvider,
      requestedProvider: sttProvider,
      segmentCount: 1,
      payloadBytes: 3200,
      recordingDurationMs: 800,
      recordingStartedAt: startedAt,
      recordingStoppedAt: stoppedAt,
      firstSpeechDetectedMs: 120,
      firstInterimTranscriptMs: 240,
      firstFinalTranscriptMs: 640,
      finalSttReadyMs: 760,
      sendAfterSpeechMs: 120,
      recognitionErrors: []
    }
  };
}

function turnBridge(turn) {
  const text = (turn?.logs ?? []).map((log) => `${log.label} ${log.detail ?? ""}`).join("\n");
  if (/Unsafe fallback enabled|unverified/i.test(text)) return "unsafe";
  if (/CLI fork validated|verified codex CLI fork fallback|CLI warm prompt/i.test(text)) return "cli-validated";
  if (/App-server/i.test(text)) return "app-server";
  return "unknown";
}

function turnLogElapsed(turn, labelPattern) {
  const regex = labelPattern instanceof RegExp ? labelPattern : new RegExp(labelPattern, "i");
  const entry = turn?.logs?.find((log) => regex.test(log.label));
  return maybeNumber(entry?.elapsedMs);
}

function assistantForTurn(session, turn) {
  if (!session || !turn?.responseEntryId) return null;
  return session.transcript?.find((entry) => entry.id === turn.responseEntryId) ?? null;
}

function summarizeTurn(run, response, wallMs, kind, thresholds) {
  const turn = response.turn;
  const session = response.session;
  const metrics = turn?.metrics ?? {};
  const assistant = assistantForTurn(session, turn);
  const firstDeltaMs = maybeNumber(metrics.firstDeltaMs) ?? turnLogElapsed(turn, /first model delta/i);
  const totalMs = maybeNumber(metrics.totalMs) ?? wallMs;
  const bridge = turnBridge(turn);
  const parser = {
    mode: assistant?.parserMode ?? null,
    error: assistant?.parserError ?? null,
    spokenChars: assistant?.spokenText?.length ?? null,
    notesChars: assistant?.notesText?.length ?? null
  };
  const tts = {
    provider: metrics.ttsProvider ?? null,
    providerStatus: metrics.ttsProviderStatus ?? null,
    firstSpeechQueuedMs: metrics.firstSpeechQueuedMs ?? null,
    firstSpeechStartMs: metrics.firstSpeechStartMs ?? null,
    firstAudioChunkMs: metrics.firstAudioChunkMs ?? null,
    firstAudioPlayMs: metrics.firstAudioPlayMs ?? null,
    error: metrics.ttsError ?? null
  };

  const details = {
    kind,
    turnId: run.turnId,
    status: turn?.status ?? null,
    text: run.text,
    reasoningEffort: run.reasoningEffort,
    wallMs,
    metrics,
    firstDeltaMs,
    modelWaitMs: metrics.modelWaitMs ?? null,
    appTurnStartMs: metrics.appTurnStartMs ?? null,
    totalMs,
    parser,
    tts,
    bridge,
    error: turn?.error ?? null,
    logs: turn?.logs ?? []
  };

  let status = "pass";
  const failures = [];
  if (!turn || turn.status !== "completed") failures.push(`turn ${turn?.status ?? "missing"}`);
  if (bridge === "unknown") failures.push("bridge provenance unknown");
  if (bridge === "unsafe") failures.push("successful path used unsafe/unverified fallback");
  if (typeof firstDeltaMs !== "number") failures.push("missing firstDeltaMs");
  else if (firstDeltaMs >= thresholds.firstDeltaMs) failures.push(`first delta ${ms(firstDeltaMs)} >= ${ms(thresholds.firstDeltaMs)}`);
  if (typeof totalMs !== "number") failures.push("missing totalMs");
  else if (totalMs >= thresholds.totalMs) failures.push(`completed ${ms(totalMs)} >= ${ms(thresholds.totalMs)}`);
  if (parser.mode === "invalid") failures.push(`voice parser invalid${parser.error ? `: ${parser.error}` : ""}`);
  if (failures.length > 0) status = "fail";
  else if (!parser.mode || parser.error) status = "warn";

  return {
    flow: run.name,
    status,
    latencyMs: totalMs,
    reason: failures.length > 0
      ? failures.join("; ")
      : `${bridge}; firstDelta ${ms(firstDeltaMs)}; modelWait ${ms(metrics.modelWaitMs)}; parser ${parser.mode ?? "unknown"}`,
    details
  };
}

async function runTurn(result, run) {
  const ready = await waitForNoRunningTurn(result.config.apiUrl, result.config.pollMs, 60_000);
  if (!ready.ok) {
    const flow = {
      flow: run.name,
      status: "fail",
      latencyMs: ready.elapsedMs,
      reason: ready.reason,
      details: { activeTurn: ready.session?.activeTurn ?? null }
    };
    addFlow(result, flow);
    return { ok: false, flow };
  }

  const payload = makeTurnPayload(run.text, run.reasoningEffort, result.readiness);
  const postStartedAt = performance.now();
  const post = await requestJson(result.config.apiUrl, "/api/turn", {
    method: "POST",
    timeoutMs: 15_000,
    body: payload
  });
  if (!post.ok || !post.json?.turnId) {
    const flow = {
      flow: run.name,
      status: "fail",
      latencyMs: post.elapsedMs,
      reason: post.json?.error ?? post.error ?? post.text ?? `HTTP ${post.status}`,
      details: {
        status: post.status,
        body: post.json ?? post.text ?? null,
        payload: { ...payload, text: run.text }
      }
    };
    addFlow(result, flow);
    return { ok: false, flow };
  }

  const turnId = post.json.turnId;
  let latest = null;
  while (performance.now() - postStartedAt < result.config.turnTimeoutMs) {
    const status = await requestJson(result.config.apiUrl, `/api/turn/${turnId}`, {
      timeoutMs: 8_000
    });
    latest = status.json;
    const turnStatus = latest?.turn?.status;
    if (TERMINAL_TURN_STATUSES.has(turnStatus)) {
      const wallMs = performance.now() - postStartedAt;
      const flow = run.expectFailure
        ? summarizeFailureTurn({ ...run, turnId }, latest, wallMs)
        : summarizeTurn({ ...run, turnId }, latest, wallMs, run.kind, run.thresholds);
      addFlow(result, flow);
      result.turns.push(flow.details);
      return {
        ok: flow.status !== "fail",
        flow,
        turn: latest.turn,
        session: latest.session
      };
    }
    await sleep(result.config.pollMs);
  }

  const flow = {
    flow: run.name,
    status: "fail",
    latencyMs: performance.now() - postStartedAt,
    reason: `Timed out after ${ms(result.config.turnTimeoutMs)} waiting for turn completion.`,
    details: {
      turnId,
      latest
    }
  };
  addFlow(result, flow);
  return { ok: false, flow };
}

function summarizeFailureTurn(run, response, wallMs) {
  const turn = response.turn;
  const session = response.session;
  const metrics = turn?.metrics ?? {};
  const assistant = assistantForTurn(session, turn);
  const bridge = turnBridge(turn);
  const clearReason = Boolean(turn?.error || assistant?.text);
  const terminal = TERMINAL_TURN_STATUSES.has(turn?.status);
  const expectedFailure = turn?.status === "failed";
  const details = {
    kind: "failure-recovery",
    turnId: run.turnId,
    status: turn?.status ?? null,
    text: run.text,
    reasoningEffort: run.reasoningEffort,
    wallMs,
    metrics,
    bridge,
    error: turn?.error ?? null,
    surfacedReason: turn?.error ?? assistant?.text ?? null,
    logs: turn?.logs ?? []
  };
  return {
    flow: run.name,
    status: terminal && clearReason ? (expectedFailure ? "pass" : "warn") : "fail",
    latencyMs: metrics.totalMs ?? wallMs,
    reason: expectedFailure
      ? truncate(`captured minimal-reasoning regression: ${turn?.error ?? assistant?.text ?? "failed"}`)
      : terminal
        ? `minimal-reasoning failure did not reproduce; turn ended ${turn?.status}`
        : `failure path not terminal: ${turn?.status ?? "missing"}`,
    details
  };
}

function compareWarmTurns(result, cold, warmTurns) {
  if (!cold?.flow?.details || warmTurns.length === 0) return;
  const coldFirstDelta = cold.flow.details.firstDeltaMs;
  const coldTotal = cold.flow.details.totalMs;
  const warmDetails = warmTurns.map((turn) => turn.flow?.details).filter(Boolean);
  const allBelowTargets = warmDetails.every((turn) => turn.firstDeltaMs < 5_000 && turn.totalMs < 20_000);
  const fasterThanCold = warmDetails.every((turn) => {
    if (typeof coldFirstDelta !== "number" || typeof coldTotal !== "number") return false;
    return turn.firstDeltaMs <= coldFirstDelta || turn.totalMs <= coldTotal;
  });
  addFlow(result, {
    flow: "warm comparison",
    status: allBelowTargets && fasterThanCold ? "pass" : "warn",
    latencyMs: warmDetails.length
      ? Math.round(warmDetails.reduce((sum, turn) => sum + (turn.totalMs ?? 0), 0) / warmDetails.length)
      : undefined,
    reason: fasterThanCold
      ? "warm turns stayed below cold-start latency"
      : `warm timings did not beat cold consistently; cold firstDelta ${ms(coldFirstDelta)}, total ${ms(coldTotal)}`,
    details: {
      cold: { firstDeltaMs: coldFirstDelta, totalMs: coldTotal },
      warm: warmDetails.map((turn) => ({
        turnId: turn.turnId,
        firstDeltaMs: turn.firstDeltaMs,
        totalMs: turn.totalMs
      }))
    }
  });
}

function printTable(result) {
  const rows = result.flows.map((flow) => ({
    Flow: flow.flow,
    Status: flow.status,
    Latency: ms(flow.latencyMs),
    Reason: truncate(flow.reason, 80)
  }));
  const columns = ["Flow", "Status", "Latency", "Reason"];
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.min(
        90,
        Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length))
      )
    ])
  );
  const line = columns.map((column) => "-".repeat(widths[column])).join("  ");
  const formatRow = (row) =>
    columns.map((column) => String(row[column] ?? "").padEnd(widths[column])).join("  ");
  console.log(formatRow(Object.fromEntries(columns.map((column) => [column, column]))));
  console.log(line);
  for (const row of rows) console.log(formatRow(row));
}

async function writeResults(result) {
  const outDir = result.config.outDir ?? path.join(result.config.rootDir, "evals", "runnability");
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, `mortic-runnability-${result.startedStamp}.json`);
  result.outputPath = filePath;
  await writeFile(filePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return filePath;
}

export async function runMorticRunnabilityEval(options = {}) {
  const context = runtimeContext();
  const parsed = {
    ...parseArgs(options.argv ?? [], context.env),
    ...options
  };
  parsed.apiUrl = (parsed.apiUrl ?? apiUrlFromAppUrl(parsed.appUrl)).replace(/\/+$/, "");
  parsed.rootDir = parsed.rootDir ?? context.cwd;
  parsed.homeDir = parsed.homeDir ?? context.homeDir;

  const result = {
    startedAt: new Date().toISOString(),
    startedStamp: sanitizeStamp(),
    config: {
      appUrl: parsed.appUrl,
      apiUrl: parsed.apiUrl,
      rootDir: parsed.rootDir,
      homeDir: parsed.homeDir,
      outDir: parsed.outDir,
      pollMs: parsed.pollMs,
      turnTimeoutMs: parsed.turnTimeoutMs,
      prewarmTimeoutMs: parsed.prewarmTimeoutMs,
      uiTimeoutMs: parsed.uiTimeoutMs,
      uiDriver: parsed.uiDriver,
      strictUi: parsed.strictUi,
      includeFailure: parsed.includeFailure
    },
    readiness: null,
    prewarm: null,
    turns: [],
    flows: []
  };

  await probeHealthAndReadiness(result);
  await probeUiBoot(result);
  await prewarm(result);

  const [coldPrompt, ...warmPrompts] = RUNNABILITY_PROMPTS;
  const cold = await runTurn(result, coldPrompt);

  const warmRuns = [];
  for (const prompt of warmPrompts) {
    warmRuns.push(await runTurn(result, prompt));
  }
  compareWarmTurns(result, cold, warmRuns);

  if (parsed.includeFailure) {
    await runTurn(result, FAILURE_RECOVERY_PROMPTS[0]);
    const afterFailure = await requestJson(result.config.apiUrl, "/api/session", { timeoutMs: 8_000 });
    const active = afterFailure.json?.session?.activeTurn;
    addFlow(result, {
      flow: "post-failure readiness",
      status: active?.status === "running" ? "fail" : "pass",
      latencyMs: afterFailure.elapsedMs,
      reason: active?.status === "running"
        ? "active turn still running after failure probe"
        : `active turn ${active?.status ?? "none"}; ready for next valid turn`,
      details: {
        activeTurn: active ?? null
      }
    });
    await runTurn(result, FAILURE_RECOVERY_PROMPTS[1]);
  }

  result.finishedAt = new Date().toISOString();
  result.summary = {
    status: result.flows.some((flow) => flow.status === "fail") ? "fail" : "pass",
    pass: result.flows.filter((flow) => flow.status === "pass").length,
    warn: result.flows.filter((flow) => flow.status === "warn").length,
    fail: result.flows.filter((flow) => flow.status === "fail").length,
    skip: result.flows.filter((flow) => flow.status === "skip").length
  };
  await writeResults(result);

  if (!parsed.jsonOnly) {
    printTable(result);
    console.log(`\nJSON: ${result.outputPath}`);
  } else {
    console.log(JSON.stringify(result));
  }

  return result;
}

function isMain() {
  if (typeof process === "undefined" || !process.argv?.[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const context = runtimeContext();
  const parsed = parseArgs(context.argv.slice(2), context.env);
  if (!parsed.help) {
    runMorticRunnabilityEval(parsed)
      .then((result) => {
        if (result.summary?.fail > 0) process.exitCode = 1;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
