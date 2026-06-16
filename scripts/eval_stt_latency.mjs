import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function numberOption(name, fallback) {
  const raw = option(name, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function wordRecall(expected, actual) {
  const expectedWords = normalizeWords(expected);
  const actualWords = new Set(normalizeWords(actual));
  if (expectedWords.length === 0) return 1;
  const hits = expectedWords.filter((word) => actualWords.has(word)).length;
  return hits / expectedWords.length;
}

async function synthesizeWav(text, dir, index) {
  const aiff = path.join(dir, `sample-${index}.aiff`);
  const wav = path.join(dir, `sample-${index}.wav`);
  await execFileAsync("say", ["-o", aiff, text]);
  await execFileAsync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", aiff, wav]);
  return wav;
}

async function transcribe(api, provider, wavPath, text) {
  const audio = await readFile(wavPath);
  const started = Date.now();
  const response = await fetch(`${api.replace(/\/$/, "")}/api/stt/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      provider,
      audioBase64: audio.toString("base64"),
      mimeType: "audio/wav",
      language: "en-US"
    })
  });
  const payload = await response.json().catch(() => ({}));
  const elapsedMs = Date.now() - started;
  return {
    ok: response.ok,
    status: response.status,
    expected: text,
    actual: payload.text ?? "",
    provider: payload.provider ?? provider,
    model: payload.model,
    elapsedMs,
    providerElapsedMs: payload.elapsedMs,
    recall: wordRecall(text, payload.text ?? ""),
    error: payload.error,
    failures: payload.failures
  };
}

const api = option("--api", process.env.MORTIC_API_URL || "http://127.0.0.1:5262");
const provider = option("--provider", process.env.MORTIC_STT_EVAL_PROVIDER || "deepgram-stt");
const repeat = numberOption("--repeat", 1);
const maxLatencyMs = numberOption("--max-latency-ms", 5000);
const minRecall = Number(option("--min-recall", "0.7"));
const samples = [
  "measure local voice latency in simple mortic",
  "interrupt the speaking answer and start listening now",
  "speech test one two three for the voice pipeline"
];

const workDir = path.join(os.tmpdir(), `mortic-stt-eval-${Date.now().toString(36)}`);
await mkdir(workDir, { recursive: true });

try {
  const runs = [];
  let index = 0;
  for (let pass = 0; pass < repeat; pass += 1) {
    for (const sample of samples) {
      const wav = await synthesizeWav(sample, workDir, index);
      runs.push(await transcribe(api, provider, wav, sample));
      index += 1;
    }
  }

  const latencies = runs.map((run) => run.elapsedMs);
  const recalls = runs.map((run) => run.recall);
  const summary = {
    api,
    provider,
    repeat,
    sampleCount: runs.length,
    averageLatencyMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)),
    worstLatencyMs: Math.max(0, ...latencies),
    averageRecall: Number((recalls.reduce((sum, value) => sum + value, 0) / Math.max(1, recalls.length)).toFixed(3)),
    worstRecall: Number(Math.min(1, ...recalls).toFixed(3))
  };
  const pass = runs.every((run) => run.ok) && summary.worstLatencyMs <= maxLatencyMs && summary.worstRecall >= minRecall;
  console.log(JSON.stringify({ summary: { ...summary, maxLatencyMs, minRecall, pass }, runs }, null, 2));
  process.exitCode = pass ? 0 : 1;
} finally {
  await rm(workDir, { recursive: true, force: true });
}
