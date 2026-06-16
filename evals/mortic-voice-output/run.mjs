#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const corpusPath = path.join(__dirname, "prompts.json");
const defaultSkillPath = path.join(homedir(), ".codex", "skills", "mortic-voice-output", "SKILL.md");
const skillPath = process.env.MORTIC_VOICE_SKILL_PATH || defaultSkillPath;
const validatorPath = path.join(path.dirname(skillPath), "scripts", "validate_voice_output.mjs");
const runsDir = path.join(__dirname, "runs");
const subagentDir = path.join(__dirname, "subagent-shards");

function usage(exitCode = 0) {
  console.log(`Mortic voice-output eval harness

Usage:
  node evals/mortic-voice-output/run.mjs score [--input <run.json>] [--json]
  node evals/mortic-voice-output/run.mjs generate [--out <run.json>] [--model <model>] [--reasoning <effort>] [--limit <n>] [--ids <a,b,c>] [--voice-only] [--timeout-ms <n>]
  node evals/mortic-voice-output/run.mjs subagent-prompts [--shards <n>] [--out-dir <dir>]

Examples:
  node evals/mortic-voice-output/run.mjs generate --limit 5
  node evals/mortic-voice-output/run.mjs score --input evals/mortic-voice-output/runs/<run>.json
  node evals/mortic-voice-output/run.mjs subagent-prompts --shards 4
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function loadCorpus() {
  return readJson(corpusPath);
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---[\s\S]*?---\s*/, "").trim();
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function newestRunFile() {
  if (!existsSync(runsDir)) return undefined;
  const candidates = readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(runsDir, name))
    .sort();
  return candidates.at(-1);
}

function nonEmptyLines(raw) {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return { value };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateWithBundledValidator(raw) {
  if (!existsSync(validatorPath)) {
    return {
      ok: false,
      warnings: [],
      errors: [`Validator not found at ${validatorPath}`],
      stdout: "",
      stderr: ""
    };
  }

  const result = spawnSync(process.execPath, [validatorPath], {
    input: raw,
    encoding: "utf8"
  });
  const stderr = result.stderr || "";
  const warnings = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("WARN: "))
    .map((line) => line.slice("WARN: ".length));
  const errors = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith("ERROR: "))
    .map((line) => line.slice("ERROR: ".length));

  return {
    ok: result.status === 0,
    warnings,
    errors,
    stdout: result.stdout || "",
    stderr
  };
}

function matchPattern(text, pattern) {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function countSentences(text) {
  return (text.match(/[.!?](?:\s|$)/g) || []).length;
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percent(numerator, denominator) {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

function fmtPct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function isVoiceNdjsonShape(raw) {
  const lines = nonEmptyLines(raw);
  if (lines.length !== 2) return false;
  const speak = parseLine(lines[0]).value;
  const read = parseLine(lines[1]).value;
  return (
    exactKeys(speak, ["type", "text"]) &&
    exactKeys(read, ["type", "markdown"]) &&
    speak.type === "speak" &&
    typeof speak.text === "string" &&
    read.type === "read" &&
    typeof read.markdown === "string"
  );
}

function teaserWarnings(speakText) {
  const patterns = [
    "\\b(see|read|check|look at) (the )?(notes|screen|details|below)\\b",
    "\\bdetails are (in|on)\\b",
    "\\bthe notes (show|include|have)\\b",
    "\\bread\\.markdown\\b",
    "\\bread section\\b",
    "\\b(full|real|actual|complete) answer\\b[^.!?\\n]{0,120}\\b(is|will be|lives|belongs)\\b[^.!?\\n]{0,120}\\b(notes|screen|readable|below)\\b",
    "\\b(notes|screen|readable|below)\\b[^.!?\\n]{0,120}\\b(has|contains|shows|includes)\\b[^.!?\\n]{0,120}\\b(full|real|actual|complete) answer\\b"
  ];
  return patterns.filter((pattern) => matchPattern(speakText, pattern));
}

function scoreCompleteness(testCase, speakText, readMarkdown) {
  const groups = testCase.mustCover || [];
  const minSpeakChars = testCase.minSpeakChars ?? 180;
  const threshold = testCase.completeCoverageThreshold ?? 0.75;
  const criticalGroups = groups.filter((group) => group.critical !== false);
  const covered = [];
  const missing = [];
  const silentCaveats = [];

  for (const group of groups) {
    const patterns = group.patterns || [];
    const speakHas = patterns.some((pattern) => matchPattern(speakText, pattern));
    const readHas = patterns.some((pattern) => matchPattern(readMarkdown, pattern));
    if (speakHas) covered.push(group.label);
    else missing.push(group.label);
    if (!speakHas && readHas && group.critical !== false) silentCaveats.push(group.label);
  }

  const coverage = groups.length === 0 ? 1 : covered.length / groups.length;
  const criticalCoverage =
    criticalGroups.length === 0
      ? 1
      : criticalGroups.filter((group) => covered.includes(group.label)).length / criticalGroups.length;
  const criticalMissing = groups
    .filter((group) => group.critical !== false)
    .filter((group) => !covered.includes(group.label))
    .map((group) => group.label);
  const teaser = teaserWarnings(speakText);
  const tooShort = speakText.trim().length < minSpeakChars && groups.length > 0;
  const tooFewSentences = countSentences(speakText) < 2 && minSpeakChars >= 120;
  const complete =
    teaser.length === 0 &&
    silentCaveats.length === 0 &&
    criticalMissing.length === 0 &&
    criticalCoverage >= threshold &&
    !tooShort &&
    !tooFewSentences;

  const reasons = [];
  if (teaser.length > 0) reasons.push(`teaser language: ${teaser.join(", ")}`);
  if (silentCaveats.length > 0) reasons.push(`silent caveats: ${silentCaveats.join(", ")}`);
  if (criticalMissing.length > 0) reasons.push(`critical missing from speech: ${criticalMissing.join(", ")}`);
  if (criticalCoverage < threshold) reasons.push(`critical coverage ${fmtPct(criticalCoverage)} < ${fmtPct(threshold)}`);
  if (tooShort) reasons.push(`speak.text too short: ${speakText.trim().length} < ${minSpeakChars} chars`);
  if (tooFewSentences) reasons.push("speak.text has fewer than two spoken sentences");

  return {
    complete,
    coverage,
    criticalCoverage,
    covered,
    missing,
    silentCaveats,
    reasons
  };
}

function scoreVoiceOutput(testCase, output) {
  const lines = nonEmptyLines(output);
  const line1 = lines[0] ?? "";
  const line2 = lines[1] ?? "";
  const line1Parse = parseLine(line1);
  const line2Parse = parseLine(line2);
  const speak = line1Parse.value;
  const read = line2Parse.value;
  const validFirstSpeakLine =
    exactKeys(speak, ["type", "text"]) &&
    speak.type === "speak" &&
    typeof speak.text === "string" &&
    speak.text.trim().length > 0;
  const validSecondReadLine =
    exactKeys(read, ["type", "markdown"]) &&
    read.type === "read" &&
    typeof read.markdown === "string";
  const validator = validateWithBundledValidator(output);
  const validNdjson = validator.ok && lines.length === 2 && validFirstSpeakLine && validSecondReadLine;
  const speakText = validFirstSpeakLine ? speak.text : "";
  const readMarkdown = validSecondReadLine ? read.markdown : "";
  const completeness = validFirstSpeakLine
    ? scoreCompleteness(testCase, speakText, readMarkdown)
    : {
        complete: false,
        coverage: 0,
        criticalCoverage: 0,
        covered: [],
        missing: [],
        silentCaveats: [],
        reasons: ["missing valid speak.text"]
      };

  return {
    id: testCase.id,
    category: testCase.category,
    mode: testCase.mode,
    validNdjson,
    exactlyTwoLines: lines.length === 2,
    validFirstSpeakLine,
    validSecondReadLine,
    validatorWarnings: validator.warnings,
    validatorErrors: validator.errors,
    speechHazardWarning: validator.warnings.length > 0,
    speakChars: speakText.length,
    speakSentences: countSentences(speakText),
    completeAnswer: validNdjson && completeness.complete,
    completeness,
    output
  };
}

function scoreTextControl(testCase, output) {
  const contaminated = isVoiceNdjsonShape(output);
  return {
    id: testCase.id,
    category: testCase.category,
    mode: testCase.mode,
    textModeContaminated: contaminated,
    output
  };
}

function normalizeRun(data, corpus) {
  const byId = new Map(corpus.prompts.map((testCase) => [testCase.id, testCase]));
  const results = data.results || data.outputs || [];
  return results.map((result) => {
    const id = result.id ?? result.promptId;
    const testCase = byId.get(id);
    if (!testCase) throw new Error(`Run result references unknown prompt id: ${id}`);
    return {
      testCase,
      output: String(result.output ?? result.text ?? ""),
      generationError: typeof result.error === "string" ? result.error : undefined
    };
  });
}

function summarizeScores(scored, corpus) {
  const voice = scored.filter((item) => item.mode === "voice");
  const textControls = scored.filter((item) => item.mode === "text-control");
  const generationErrors = scored.filter((item) => item.generationError);
  const speakLengths = voice.map((item) => item.speakChars || 0);
  const metrics = {
    voiceCount: voice.length,
    textControlCount: textControls.length,
    validNdjsonRate: percent(voice.filter((item) => item.validNdjson).length, voice.length),
    validFirstSpeakLineRate: percent(voice.filter((item) => item.validFirstSpeakLine).length, voice.length),
    validSecondReadLineRate: percent(voice.filter((item) => item.validSecondReadLine).length, voice.length),
    speechHazardWarningRate: percent(voice.filter((item) => item.speechHazardWarning).length, voice.length),
    completeAnswerRate: percent(voice.filter((item) => item.completeAnswer).length, voice.length),
    averageSpeakChars: Math.round(mean(speakLengths)),
    p95SpeakChars: p95(speakLengths),
    textModeContaminationRate:
      textControls.length === 0 ? 0 : percent(textControls.filter((item) => item.textModeContaminated).length, textControls.length),
    generationErrorCount: generationErrors.length
  };

  const passBars = corpus.passBars;
  const gates = [
    ["validNdjsonRate", metrics.validNdjsonRate >= passBars.validNdjsonRate, `${fmtPct(metrics.validNdjsonRate)} >= ${fmtPct(passBars.validNdjsonRate)}`],
    [
      "validFirstSpeakLineRate",
      metrics.validFirstSpeakLineRate >= passBars.validFirstSpeakLineRate,
      `${fmtPct(metrics.validFirstSpeakLineRate)} >= ${fmtPct(passBars.validFirstSpeakLineRate)}`
    ],
    [
      "validSecondReadLineRate",
      metrics.validSecondReadLineRate >= passBars.validSecondReadLineRate,
      `${fmtPct(metrics.validSecondReadLineRate)} >= ${fmtPct(passBars.validSecondReadLineRate)}`
    ],
    [
      "completeAnswerRate",
      metrics.completeAnswerRate >= passBars.completeAnswerRate,
      `${fmtPct(metrics.completeAnswerRate)} >= ${fmtPct(passBars.completeAnswerRate)}`
    ],
    [
      "speechHazardWarningRate",
      metrics.speechHazardWarningRate <= passBars.speechHazardWarningRateMax,
      `${fmtPct(metrics.speechHazardWarningRate)} <= ${fmtPct(passBars.speechHazardWarningRateMax)}`
    ],
    [
      "textModeContaminationRate",
      metrics.textModeContaminationRate <= passBars.textModeContaminationRateMax,
      `${fmtPct(metrics.textModeContaminationRate)} <= ${fmtPct(passBars.textModeContaminationRateMax)}`
    ],
    [
      "p95SpeakChars",
      metrics.p95SpeakChars <= passBars.p95SpeakCharsMax,
      `${metrics.p95SpeakChars} <= ${passBars.p95SpeakCharsMax}`
    ],
    [
      "generationErrorCount",
      metrics.generationErrorCount === 0,
      `${metrics.generationErrorCount} = 0`
    ]
  ];

  return {
    metrics,
    gates: gates.map(([name, pass, detail]) => ({ name, pass, detail })),
    passed: gates.every(([, pass]) => pass)
  };
}

function printMarkdownReport(runData, scored, summary) {
  const meta = runData.metadata || {};
  console.log(`# Mortic Voice Output Eval`);
  console.log();
  console.log(`Generated: ${meta.generatedAt || "unknown"}`);
  console.log(`Model: ${meta.model || "unknown"} · Skill: ${meta.skillPath || skillPath}`);
  console.log(`Cases: ${summary.metrics.voiceCount} voice · ${summary.metrics.textControlCount} text controls`);
  console.log();
  console.log(`## Result`);
  console.log();
  console.log(summary.passed ? `PASS` : `FAIL`);
  console.log();
  console.log(`| Metric | Value | Gate |`);
  console.log(`|---|---:|---|`);
  console.log(`| First-pass valid NDJSON | ${fmtPct(summary.metrics.validNdjsonRate)} | ${summary.gates.find((gate) => gate.name === "validNdjsonRate").detail} |`);
  console.log(`| Valid first speak line | ${fmtPct(summary.metrics.validFirstSpeakLineRate)} | ${summary.gates.find((gate) => gate.name === "validFirstSpeakLineRate").detail} |`);
  console.log(`| Valid second read line | ${fmtPct(summary.metrics.validSecondReadLineRate)} | ${summary.gates.find((gate) => gate.name === "validSecondReadLineRate").detail} |`);
  console.log(`| Complete spoken answer | ${fmtPct(summary.metrics.completeAnswerRate)} | ${summary.gates.find((gate) => gate.name === "completeAnswerRate").detail} |`);
  console.log(`| Speech hazard warning rate | ${fmtPct(summary.metrics.speechHazardWarningRate)} | ${summary.gates.find((gate) => gate.name === "speechHazardWarningRate").detail} |`);
  console.log(`| Text-mode contamination | ${fmtPct(summary.metrics.textModeContaminationRate)} | ${summary.gates.find((gate) => gate.name === "textModeContaminationRate").detail} |`);
  console.log(`| Average spoken length | ${summary.metrics.averageSpeakChars} chars | informational |`);
  console.log(`| P95 spoken length | ${summary.metrics.p95SpeakChars} chars | ${summary.gates.find((gate) => gate.name === "p95SpeakChars").detail} |`);
  console.log(`| Generation errors | ${summary.metrics.generationErrorCount} | ${summary.gates.find((gate) => gate.name === "generationErrorCount").detail} |`);
  console.log();

  const failures = scored.filter((item) => {
    if (item.generationError) return true;
    if (item.mode === "text-control") return item.textModeContaminated;
    return !item.validNdjson || !item.completeAnswer || item.speechHazardWarning;
  });

  if (failures.length === 0) {
    console.log(`No failures or warnings.`);
    return;
  }

  console.log(`## Failures And Warnings`);
  console.log();
  for (const item of failures) {
    console.log(`### ${item.id} (${item.category})`);
    if (item.generationError) {
      console.log(`- Generation error: ${item.generationError}`);
      console.log();
      continue;
    }
    if (item.mode === "text-control") {
      console.log(`- Text-mode contamination: ${item.textModeContaminated ? "yes" : "no"}`);
    } else {
      if (!item.validNdjson) {
        console.log(`- Invalid NDJSON: ${item.validatorErrors.join("; ") || "shape check failed"}`);
      }
      if (item.validatorWarnings?.length) {
        console.log(`- Speech hazards: ${item.validatorWarnings.join("; ")}`);
      }
      if (!item.completeAnswer) {
        console.log(`- Complete-answer failure: ${item.completeness.reasons.join("; ")}`);
      }
      console.log(`- Spoken length: ${item.speakChars} chars`);
    }
    console.log();
  }
}

function buildVoicePrompt(testCase, skillBody) {
  return `You are running a skill-only eval for Mortic voice mode.

Do not use tools. Do not inspect files. Answer the user's prompt using the skill contract below.

${skillBody}

User prompt:
${testCase.prompt}
`;
}

function buildTextControlPrompt(testCase) {
  return `This is a Mortic Text mode control case.

Do not use Mortic voice-output NDJSON. Do not output {"type":"speak"} or {"type":"read"} records.
Answer normally in prose or Markdown.

User prompt:
${testCase.prompt}
`;
}

function codexVersion() {
  try {
    return execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function runCodex(prompt, options) {
  const temp = mkdtempSync(path.join(tmpdir(), "mortic-voice-eval-"));
  const outputFile = path.join(temp, "last-message.txt");
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-C",
    repoRoot,
    "-o",
    outputFile
  ];
  if (options.model) args.push("-m", options.model);
  if (options.reasoning) args.push("-c", `model_reasoning_effort="${options.reasoning}"`);
  args.push("-");

  const started = Date.now();
  const result = spawnSync("codex", args, {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs
  });
  const durationMs = Date.now() - started;
  let output = "";
  if (existsSync(outputFile)) output = readFileSync(outputFile, "utf8");
  rmSync(temp, { recursive: true, force: true });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`codex exec timed out after ${options.timeoutMs}ms`);
  }

  if (result.status !== 0) {
    throw new Error(`codex exec failed with status ${result.status}:\n${result.stderr || result.stdout}`);
  }
  return {
    output: output.trim(),
    durationMs,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function selectedCases(corpus, args) {
  let cases = corpus.prompts;
  if (args["voice-only"]) cases = cases.filter((testCase) => testCase.mode === "voice");
  if (args.ids) {
    const ids = new Set(String(args.ids).split(",").map((id) => id.trim()).filter(Boolean));
    cases = cases.filter((testCase) => ids.has(testCase.id));
  }
  if (args.limit) {
    const limit = Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
    cases = cases.slice(0, limit);
  }
  return cases;
}

function generate(args) {
  const corpus = loadCorpus();
  const skillBody = stripFrontmatter(readFileSync(skillPath, "utf8"));
  const cases = selectedCases(corpus, args);
  mkdirSync(runsDir, { recursive: true });
  const outFile = args.out ? path.resolve(args.out) : path.join(runsDir, `${timestampSlug()}.json`);
  const model = args.model === true ? undefined : args.model || process.env.MORTIC_EVAL_MODEL || "gpt-5.4";
  const reasoning = args.reasoning === true ? undefined : args.reasoning || process.env.MORTIC_EVAL_REASONING || "medium";
  const timeoutMs = args["timeout-ms"] ? Number(args["timeout-ms"]) : 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive number");
  const runData = {
    version: 1,
    metadata: {
      generatedAt: new Date().toISOString(),
      model: model || "codex-default",
      reasoning: reasoning || "codex-default",
      codexVersion: codexVersion(),
      skillPath,
      corpusPath,
      promptCount: cases.length,
      completed: false
    },
    results: []
  };
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(runData, null, 2)}\n`);

  for (const [index, testCase] of cases.entries()) {
    const prompt = testCase.mode === "text-control" ? buildTextControlPrompt(testCase) : buildVoicePrompt(testCase, skillBody);
    process.stderr.write(`[${index + 1}/${cases.length}] ${testCase.id} (${testCase.mode})\n`);
    try {
      const generated = runCodex(prompt, { model, reasoning, timeoutMs });
      runData.results.push({
        id: testCase.id,
        category: testCase.category,
        mode: testCase.mode,
        prompt: testCase.prompt,
        output: generated.output,
        durationMs: generated.durationMs
      });
    } catch (error) {
      runData.results.push({
        id: testCase.id,
        category: testCase.category,
        mode: testCase.mode,
        prompt: testCase.prompt,
        output: "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    writeFileSync(outFile, `${JSON.stringify(runData, null, 2)}\n`);
  }

  runData.metadata.completed = true;
  runData.metadata.finishedAt = new Date().toISOString();
  writeFileSync(outFile, `${JSON.stringify(runData, null, 2)}\n`);
  console.log(outFile);
}

function score(args) {
  const corpus = loadCorpus();
  const input = args.input ? path.resolve(args.input) : newestRunFile();
  if (!input) {
    throw new Error(`No run file found. Run generate first or pass --input <run.json>.`);
  }
  const runData = readJson(input);
  const normalized = normalizeRun(runData, corpus);
  const scored = normalized.map(({ testCase, output, generationError }) => {
    const scoredCase = testCase.mode === "text-control" ? scoreTextControl(testCase, output) : scoreVoiceOutput(testCase, output);
    return generationError ? { ...scoredCase, generationError } : scoredCase;
  });
  const summary = summarizeScores(scored, corpus);
  const report = {
    input,
    metadata: runData.metadata || {},
    summary,
    cases: scored
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printMarkdownReport(runData, scored, summary);
  }

  process.exitCode = summary.passed ? 0 : 1;
}

function subagentPrompts(args) {
  const corpus = loadCorpus();
  const cases = selectedCases(corpus, args);
  const shards = Number(args.shards || 4);
  if (!Number.isInteger(shards) || shards < 1) throw new Error("--shards must be a positive integer");
  const outDir = args["out-dir"] ? path.resolve(args["out-dir"]) : subagentDir;
  mkdirSync(outDir, { recursive: true });

  for (let shard = 0; shard < shards; shard += 1) {
    const shardCases = cases.filter((_, index) => index % shards === shard);
    const prompt = `You are a Mortic voice-output eval subagent.

Do not edit files. For each test case below, produce one result object with the exact fields:

{
  "id": "<prompt id>",
  "output": "<the model answer exactly as produced>"
}

For voice cases, use $mortic-voice-output and return exactly two NDJSON lines inside the output string:
{"type":"speak","text":"..."}
{"type":"read","markdown":"..."}

For text-control cases, do not use Mortic voice NDJSON; answer normally.

Return only JSON:
{
  "results": [
    { "id": "...", "output": "..." }
  ]
}

Test cases:
${JSON.stringify(shardCases.map(({ id, mode, category, prompt }) => ({ id, mode, category, prompt })), null, 2)}
`;
    const file = path.join(outDir, `shard-${String(shard + 1).padStart(2, "0")}-of-${String(shards).padStart(2, "0")}.md`);
    writeFileSync(file, prompt);
    console.log(file);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || command === "--help") usage(0);

  try {
    if (command === "generate") generate(args);
    else if (command === "score") score(args);
    else if (command === "subagent-prompts") subagentPrompts(args);
    else usage(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
