#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "evals", "model-runtime-telemetry", "results");
const DEFAULT_THREAD_ID = "019dd798-99ba-7233-9ce5-9c4543e32c0e";
const THREAD_ID = process.env.MORTIC_EVAL_THREAD_ID ?? process.argv[2] ?? DEFAULT_THREAD_ID;
const EFFORT = process.env.MORTIC_EVAL_REASONING ?? "low";
const MODELS = (process.env.MORTIC_EVAL_MODELS ?? "default,gpt-5.4-mini,gpt-5.3-codex-spark,gpt-5.3-codex,gpt-5.4")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

const runtimeTelemetryConversation = [
  "I want Mortic to feel less silent while Codex is working. What runtime telemetry can we safely expose?",
  "Differentiate chain-of-thought from safe progress narration. Be strict about what not to reveal.",
  "Map likely Codex events into spoken phrases, such as started, reading files, editing, running checks, and drafting.",
  "What would you log for benchmarking first-token delay, parser delay, TTS delay, and output delay?",
  "What should Mortic say aloud while waiting, and how often should it speak without becoming annoying?",
  "Give me the next implementation plan in concise form."
];

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseJsonLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readThreadName(threadId) {
  const indexPath = path.join(homedir(), ".codex", "session_index.jsonl");
  try {
    const raw = await readFile(indexPath, "utf8");
    let best = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.id === threadId && typeof record.thread_name === "string") {
          const updatedAt = Date.parse(record.updated_at ?? "");
          if (!best || updatedAt > best.updatedAt) {
            best = {
              threadName: record.thread_name,
              updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
            };
          }
        }
      } catch {
        // Ignore malformed index rows.
      }
    }
    return best?.threadName ?? null;
  } catch {
    // Index is optional.
  }
  return null;
}

function promptForModel(threadName) {
  const namedThread = threadName ? `"${threadName}"` : `thread ${THREAD_ID}`;
  return `You are benchmarking a Mortic voice scratch model for the source Codex thread ${namedThread}.

Treat the following as a six-message user conversation about runtime telemetry. Answer the final user need, but use the whole conversation as context.

${runtimeTelemetryConversation.map((message, index) => `User ${index + 1}: ${message}`).join("\n")}

Return a concise response with:
- verdict on whether safe runtime narration is feasible
- what telemetry events to use
- what not to expose
- a 3-step implementation plan
- one benchmark risk to measure

Do not reveal hidden chain-of-thought.`;
}

function runCodex(model, prompt) {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-c",
    `model_reasoning_effort="${EFFORT}"`
  ];
  if (model !== "default") args.push("-m", model);
  args.push(prompt);

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("codex", args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        model,
        available: false,
        error: error.message,
        wallMs: Date.now() - startedAt,
        stdout,
        stderr
      });
    });
    child.on("close", (code) => {
      const completedAt = Date.now();
      const events = parseJsonLines(stdout);
      const eventTimes = [];
      let currentOffset = 0;
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const foundAt = stdout.indexOf(line, currentOffset);
        currentOffset = foundAt + line.length;
        try {
          const event = JSON.parse(trimmed);
          eventTimes.push({ type: event.type, atApproxMs: null, event });
        } catch {
          // Non-JSON line; ignored.
        }
      }

      const assistant = [...events].reverse().find((event) => event.type === "item.completed" && event.item?.type === "agent_message");
      const usage = [...events].reverse().find((event) => event.type === "turn.completed")?.usage;
      const threadId = events.find((event) => event.type === "thread.started")?.thread_id;
      const eventTypes = [...new Set(events.map((event) => event.type))];
      const firstAgentEventIndex = events.findIndex((event) => event.type === "item.completed" && event.item?.type === "agent_message");

      resolve({
        model,
        available: code === 0 && Boolean(assistant?.item?.text),
        code,
        wallMs: completedAt - startedAt,
        threadId,
        eventTypes,
        firstAgentEventIndex: firstAgentEventIndex >= 0 ? firstAgentEventIndex : null,
        responseChars: assistant?.item?.text?.length ?? 0,
        responsePreview: assistant?.item?.text?.slice(0, 500) ?? "",
        usage,
        stderrPreview: stderr
          .split("\n")
          .filter((line) => /error|invalid|unknown|model|usage/i.test(line))
          .slice(-8)
          .join("\n"),
        error: code === 0 ? undefined : stderr.split("\n").slice(-12).join("\n").trim() || "codex exited non-zero"
      });
    });
  });
}

function summarize(results) {
  const available = results.filter((result) => result.available);
  const ranked = [...available].sort((a, b) => a.wallMs - b.wallMs);
  return {
    testedModels: results.length,
    availableModels: available.map((result) => result.model),
    fastestAvailable: ranked[0]?.model ?? null,
    rankingByWallMs: ranked.map((result) => ({
      model: result.model,
      wallMs: result.wallMs,
      responseChars: result.responseChars,
      outputTokens: result.usage?.output_tokens,
      reasoningOutputTokens: result.usage?.reasoning_output_tokens
    })),
    unavailableModels: results
      .filter((result) => !result.available)
      .map((result) => ({
        model: result.model,
        code: result.code,
        error: result.error || result.stderrPreview
      }))
  };
}

await mkdir(OUT_DIR, { recursive: true });
const threadName = await readThreadName(THREAD_ID);
const prompt = promptForModel(threadName);
const results = [];

for (const model of MODELS) {
  process.stderr.write(`[mortic-eval] testing ${model} (${EFFORT})\n`);
  results.push(await runCodex(model, prompt));
}

const report = {
  createdAt: new Date().toISOString(),
  threadId: THREAD_ID,
  threadName,
  reasoningEffort: EFFORT,
  promptMessages: runtimeTelemetryConversation,
  summary: summarize(results),
  results
};

const outputPath = path.join(OUT_DIR, `runtime-telemetry-models-${nowStamp()}.json`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  outputPath,
  threadName,
  summary: report.summary
}, null, 2));
