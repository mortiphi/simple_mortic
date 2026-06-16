#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);
const OUT_DIR = "/tmp/simple-mortic-progress-eval";
const FILLER_TEXT = "I'm writing the answer now.";

const CASES = [
  {
    name: "fast_simple",
    kind: "fast",
    allowNoSpeech: true,
    text: "Answer in one short sentence: say that progress-speech filler should stay silent for fast answers."
  },
  {
    name: "command_tool",
    kind: "command",
    text: "Use a shell command if available to print exactly mortic-progress-eval, then answer in one short sentence. Do not include command output in spoken text."
  },
  {
    name: "search_tool_like",
    kind: "search",
    text: "If web search or tool checking is available, use it to check whether today's date is June 15, 2026, then answer in one short sentence. If no search tool is available, say so briefly."
  },
  {
    name: "file_change_diff",
    kind: "diff",
    text: "Inspect package.json and prepare a minimal no-op diff plan only if a file-change or diff view is naturally available. Do not edit files. Answer in one short sentence."
  },
  {
    name: "agent_message_started_suppression",
    kind: "filler",
    allowNoSpeech: true,
    text: "Answer in one short sentence: agent message started must not be spoken as progress filler."
  }
];

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    apiUrl: process.env.MORTIC_API_URL || "http://127.0.0.1:5262",
    pollMs: 500,
    turnTimeoutMs: 120_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--api") config.apiUrl = args[++index] ?? config.apiUrl;
    else if (arg === "--poll-ms") config.pollMs = Number(args[++index] ?? config.pollMs);
    else if (arg === "--timeout-ms") config.turnTimeoutMs = Number(args[++index] ?? config.turnTimeoutMs);
  }
  config.apiUrl = config.apiUrl.replace(/\/$/, "");
  return config;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(apiUrl, route, options = {}) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(`${apiUrl}${route}`, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      json,
      text,
      elapsedMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - started)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForNoRunningTurn(config) {
  const started = performance.now();
  while (performance.now() - started < 60_000) {
    const response = await requestJson(config.apiUrl, "/api/session", { timeoutMs: 8_000 });
    if (!response.ok) return { ok: false, reason: response.error ?? response.text ?? `HTTP ${response.status}`, response };
    if (response.json?.session?.activeTurn?.status !== "running") {
      return { ok: true, response };
    }
    await sleep(config.pollMs);
  }
  return { ok: false, reason: "timed out waiting for active turn to finish" };
}

function makeTurnPayload(text, sessionResponse) {
  const now = Date.now();
  const sttProvider = sessionResponse?.stt?.defaultProvider ?? "browser";
  return {
    text,
    scratchMode: "voice",
    reasoningEffort: "none",
    codexModel: "default",
    inputPolicy: "push_to_talk",
    transportProvider: "local-browser",
    transportState: "connected",
    transportStats: {
      packetLoss: 0,
      jitterMs: 0,
      rttMs: 0,
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
      recordingStartedAt: new Date(now - 900).toISOString(),
      recordingStoppedAt: new Date(now - 100).toISOString(),
      firstSpeechDetectedMs: 120,
      firstInterimTranscriptMs: 240,
      firstFinalTranscriptMs: 640,
      finalSttReadyMs: 760,
      sendAfterSpeechMs: 120,
      recognitionErrors: []
    }
  };
}

function textForLabel(label) {
  switch (label) {
    case "Running command":
      return "I'm running a command.";
    case "Reading tool output":
      return "I'm reading tool output.";
    case "Command finished":
      return "Command finished.";
    case "Checking tool":
      return "I'm checking a tool.";
    case "Searching":
      return "I'm searching.";
    case "Preparing changes":
      return "I'm preparing changes.";
    case "Thinking":
      return "I'm thinking through it.";
    case "Checking project":
      return "I'm checking the project.";
    case "Writing answer":
      return FILLER_TEXT;
    default:
      return null;
  }
}

function unsafeSpeech(text) {
  return /```|stack trace|traceback|^\s*at\s+\S+|\b(error|exception):|\/Users\/|src\/|node_modules|[{}\[\]<>]|;|\n/i.test(text);
}

function evaluateCase(testCase, turn, wallMs) {
  const trace = turn?.progressTrace ?? null;
  const failures = [];
  const warnings = [];
  const spoken = trace?.spokenStatuses ?? [];
  const firstDeltaMs = trace?.firstAssistantDeltaMs;
  const decisions = trace?.decisions ?? [];
  const mapped = trace?.mappedEvents ?? [];
  const raw = trace?.rawNotifications ?? [];
  const usefulMappedBeforeDelta = mapped.filter((event) => {
    if (event.label === "Writing answer") return false;
    return firstDeltaMs === undefined || event.elapsedMs <= firstDeltaMs;
  });

  if (!trace) failures.push("missing progressTrace");
  if (turn?.status !== "completed") failures.push(`turn did not complete: ${turn?.status ?? "missing"}`);
  if (turn?.error) failures.push(`turn error: ${turn.error}`);
  if (spoken.includes(FILLER_TEXT)) failures.push("agentMessage filler was spoken");
  if (spoken.length === 1 && spoken[0] === FILLER_TEXT) failures.push("only spoken status was filler");
  if (firstDeltaMs !== undefined && decisions.some((decision) => decision.decision === "spoken" && decision.elapsedMs > firstDeltaMs)) {
    failures.push("progress status spoken after first assistant delta");
  }
  if (spoken.some(unsafeSpeech)) failures.push("unsafe internal content was spoken");
  if (spoken.length > 3) failures.push("more than three statuses spoken");
  if (new Set(spoken).size !== spoken.length) failures.push("progress statuses repeated");

  for (const text of spoken) {
    const matchingMapped = usefulMappedBeforeDelta.some((event) => textForLabel(event.label) === text);
    if (!matchingMapped) failures.push(`spoken status lacks matching pre-delta lifecycle event: ${text}`);
  }

  const agentStartedBeforeDelta = raw.some((event) => {
    return event.method === "item/started"
      && event.itemType === "agentMessage"
      && (firstDeltaMs === undefined || event.elapsedMs <= firstDeltaMs);
  });
  const suppressedAgentStarted = decisions.some((decision) => {
    return decision.label === "Writing answer"
      && decision.decision === "suppressed"
      && decision.reason === "agent-message-filler";
  });
  if (testCase.kind === "filler" && agentStartedBeforeDelta && !suppressedAgentStarted) {
    failures.push("agentMessage started appeared before first delta but no filler suppression decision was recorded");
  }
  if (testCase.kind === "filler" && !agentStartedBeforeDelta) {
    warnings.push("agentMessage started did not arrive before first delta in this run");
  }

  if (usefulMappedBeforeDelta.length === 0) warnings.push("no useful lifecycle events arrived before first assistant delta");
  if (!testCase.allowNoSpeech && usefulMappedBeforeDelta.length > 0 && spoken.length === 0) {
    warnings.push("useful lifecycle events arrived, but no status was spoken");
  }

  const verdict = failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass";
  return {
    name: testCase.name,
    kind: testCase.kind,
    verdict,
    wallMs: Math.round(wallMs),
    failures,
    warnings,
    firstAssistantDeltaMs: firstDeltaMs,
    spokenStatuses: spoken,
    serverTraceVerdict: trace?.verdict,
    serverTraceReasons: trace?.reasons ?? [],
    counts: {
      rawNotifications: raw.length,
      mappedEvents: mapped.length,
      decisions: decisions.length,
      usefulMappedBeforeDelta: usefulMappedBeforeDelta.length
    },
    trace,
    turn: {
      id: turn?.id,
      status: turn?.status,
      metrics: turn?.metrics,
      logs: turn?.logs
    }
  };
}

async function runCase(config, sessionResponse, testCase) {
  const ready = await waitForNoRunningTurn(config);
  if (!ready.ok) {
    return {
      name: testCase.name,
      verdict: "fail",
      failures: [ready.reason],
      warnings: [],
      trace: null
    };
  }

  const payload = makeTurnPayload(testCase.text, sessionResponse);
  const started = performance.now();
  const post = await requestJson(config.apiUrl, "/api/turn", {
    method: "POST",
    timeoutMs: 15_000,
    body: payload
  });
  if (!post.ok || !post.json?.turnId) {
    return {
      name: testCase.name,
      verdict: "fail",
      failures: [post.json?.error ?? post.error ?? post.text ?? `HTTP ${post.status}`],
      warnings: [],
      trace: null
    };
  }

  let latest = null;
  while (performance.now() - started < config.turnTimeoutMs) {
    const status = await requestJson(config.apiUrl, `/api/turn/${post.json.turnId}`, { timeoutMs: 8_000 });
    latest = status.json;
    if (TERMINAL_TURN_STATUSES.has(latest?.turn?.status)) {
      return evaluateCase(testCase, latest.turn, performance.now() - started);
    }
    await sleep(config.pollMs);
  }

  return {
    name: testCase.name,
    verdict: "fail",
    failures: [`timed out waiting for turn ${post.json.turnId}`],
    warnings: [],
    trace: latest?.turn?.progressTrace ?? null,
    turn: latest?.turn ?? null
  };
}

async function main() {
  const config = parseArgs();
  const startedAt = new Date().toISOString();
  const session = await requestJson(config.apiUrl, "/api/session", { timeoutMs: 10_000 });
  if (!session.ok) {
    throw new Error(`Cannot reach Mortic API ${config.apiUrl}: ${session.error ?? session.text ?? session.status}`);
  }
  const features = session.json?.features ?? {};
  if (!features.progressSpeech || !features.progressSpeechTrace) {
    throw new Error(
      `Progress speech trace is not enabled. Restart server with MORTIC_PROGRESS_SPEECH=1 MORTIC_PROGRESS_SPEECH_TRACE=1. Current features: ${JSON.stringify(features)}`
    );
  }

  const results = [];
  for (const testCase of CASES) {
    process.stdout.write(`running ${testCase.name}...\n`);
    results.push(await runCase(config, session.json, testCase));
  }

  const failures = results.filter((result) => result.verdict === "fail");
  const warnings = results.filter((result) => result.verdict === "warn");
  const summary = {
    verdict: failures.length > 0 ? "fail" : warnings.length > 0 ? "warn" : "pass",
    cases: results.length,
    pass: results.filter((result) => result.verdict === "pass").length,
    warn: warnings.length,
    fail: failures.length
  };
  const output = {
    eval: "simple-mortic-progress-speech",
    startedAt,
    completedAt: new Date().toISOString(),
    config,
    features,
    summary,
    results
  };

  await mkdir(OUT_DIR, { recursive: true });
  const filename = `progress-eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const outputPath = path.join(OUT_DIR, filename);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(JSON.stringify({
    summary,
    outputPath,
    cases: results.map((result) => ({
      name: result.name,
      verdict: result.verdict,
      spoken: result.spokenStatuses ?? [],
      firstAssistantDeltaMs: result.firstAssistantDeltaMs,
      failures: result.failures,
      warnings: result.warnings
    }))
  }, null, 2));

  if (summary.verdict === "fail") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
