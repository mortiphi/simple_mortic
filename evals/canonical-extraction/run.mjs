#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Model-backed extraction eval for the mortic-canonical-state skill.
//
// The skill harness (skills/mortic-canonical-state/scripts/run_harness.mjs)
// already scores the deterministic script extractor against the corpus in
// npm test. This eval runs the SAME corpus through the model extractor
// (codex exec, same prompt assembly as Mortic's Compile) and scores the
// outputs with the SAME harness via --results, so the two extractor paths
// are graded by one judge. Corpus fixtures marked modelOnly are skipped by
// the script-mode harness and only graded here.
//
//   node evals/canonical-extraction/run.mjs generate [--limit N] [--filter substr]
//   node evals/canonical-extraction/run.mjs score [--input runs/<file>.json] [--json]
//
// Env: MORTIC_CANONICAL_MODEL (default gpt-5.4-mini),
//      MORTIC_CANONICAL_REASONING (default low).
// generate consumes Codex quota; score is free.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const corpusPath = path.join(repoRoot, "skills", "mortic-canonical-state", "fixtures", "corpus.json");
const harnessPath = path.join(repoRoot, "skills", "mortic-canonical-state", "scripts", "run_harness.mjs");
const runsDir = path.join(here, "runs");

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function loadCorpus() {
  return JSON.parse(await readFile(corpusPath, "utf8"));
}

async function generate() {
  const limit = Number(flagValue("--limit") ?? Infinity);
  const filter = flagValue("--filter");
  const { extractCanonicalDeltaSetWithModel } = await import(
    path.join(repoRoot, "dist", "node", "server", "canonicalStateSkill.js")
  );

  let corpus = await loadCorpus();
  if (filter) corpus = corpus.filter((fixture) => fixture.name.includes(filter));
  corpus = corpus.slice(0, limit);

  const results = {};
  const errors = {};
  for (const fixture of corpus) {
    process.stderr.write(`generate ${fixture.name}...`);
    const startedAt = Date.now();
    try {
      results[fixture.name] = await extractCanonicalDeltaSetWithModel(fixture.input);
      process.stderr.write(` ok (${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
    } catch (error) {
      errors[fixture.name] = error instanceof Error ? error.message : String(error);
      process.stderr.write(` ERROR: ${errors[fixture.name].slice(0, 120)}\n`);
    }
  }

  await mkdir(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = flagValue("--out") ?? path.join(runsDir, `${stamp}.json`);
  await writeFile(
    outPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: process.env.MORTIC_CANONICAL_MODEL || "gpt-5.4-mini",
        reasoning: process.env.MORTIC_CANONICAL_REASONING || "low",
        cases: corpus.length,
        results,
        errors
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(`Run written: ${outPath} (${Object.keys(results).length} ok, ${Object.keys(errors).length} errors)`);
  if (Object.keys(errors).length > 0) process.exitCode = 1;
}

async function latestRunFile() {
  const entries = await readdir(runsDir).catch(() => []);
  const files = entries.filter((name) => name.endsWith(".json")).sort();
  return files.length ? path.join(runsDir, files[files.length - 1]) : undefined;
}

async function score() {
  const inputPath = flagValue("--input") ?? (await latestRunFile());
  if (!inputPath) {
    console.error("No run file found. Run generate first.");
    process.exit(1);
  }
  const run = JSON.parse(await readFile(inputPath, "utf8"));
  const workDir = await mkdtemp(path.join(tmpdir(), "mortic-canonical-score-"));
  const resultsPath = path.join(workDir, "results.json");
  try {
    await writeFile(resultsPath, `${JSON.stringify(run.results ?? {}, null, 2)}\n`, "utf8");
    const harness = spawnSync(process.execPath, [harnessPath, "--json", "--results", resultsPath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    if (harness.status !== 0 && !harness.stdout) {
      console.error(harness.stderr || "harness failed without output");
      process.exit(1);
    }
    const report = JSON.parse(harness.stdout);
    const generationErrors = Object.entries(run.errors ?? {});
    const pass = report.pass && generationErrors.length === 0;

    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ...report, generationErrors: run.errors ?? {}, pass }, null, 2)}\n`);
    } else {
      console.log(`Canonical extraction eval (model ${run.model}, reasoning ${run.reasoning})`);
      console.log(`Run: ${inputPath}`);
      for (const [key, value] of Object.entries(report.metrics)) {
        console.log(`- ${key}: ${typeof value === "number" ? value.toFixed(3) : value}`);
      }
      for (const [name, message] of generationErrors) {
        console.log(`- generation error: ${name}: ${message.slice(0, 160)}`);
      }
      console.log(pass ? "Pass bars met." : `Failures:\n${report.failures.map((f) => `- ${f}`).join("\n")}`);
    }
    if (!pass) process.exit(1);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === "generate") await generate();
else if (command === "score") await score();
else {
  console.error("Usage: run.mjs <generate|score> [--limit N] [--filter substr] [--input file] [--json]");
  process.exit(1);
}
