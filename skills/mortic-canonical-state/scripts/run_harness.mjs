#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyApprovedDeltas, extractDeltaSet, readJson, validateDeltaSet } from "./canonical_state_lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, "..", "fixtures", "corpus.json");
const fullCorpus = await readJson(corpusPath);
const jsonMode = process.argv.includes("--json");

// --results <file>: score precomputed delta sets (e.g. from the model-backed
// extractor in evals/canonical-extraction) instead of running the
// deterministic script extractor. The file maps fixture name -> deltaSet.
// Without --results, fixtures marked modelOnly are skipped: they exist to
// grade the model path and are not expected to pass the script extractor.
const resultsFlagIndex = process.argv.indexOf("--results");
const resultsPath = resultsFlagIndex >= 0 ? process.argv[resultsFlagIndex + 1] : undefined;
const precomputed = resultsPath ? await readJson(resultsPath) : null;
const corpus = precomputed
  ? fullCorpus.filter((fixture) => Object.prototype.hasOwnProperty.call(precomputed, fixture.name))
  : fullCorpus.filter((fixture) => !fixture.modelOnly);
if (precomputed && corpus.length === 0) {
  process.stderr.write("No corpus fixtures matched the provided results file\n");
  process.exit(1);
}

const rows = [];
let valid = 0;
let evidenceValid = 0;
let classificationValid = 0;
let noQuestionNoise = 0;
let promptInjectionSafe = 0;
let rationaleQualityValid = 0;
let duplicateFree = 0;
let operationValid = 0;
let strictFieldValid = 0;
let rejectionValid = 0;
let summaryQualityValid = 0;
let lifecycleValid = 0;
let targetResolutionValid = 0;
let applyLifecycleValid = 0;
let totalCandidates = 0;
let totalSpokenLength = 0;
const candidateBodyLengths = [];
const genericRationaleFragments = [
  "concrete mortic implementation work with an observable build or test outcome",
  "changes durable mortic project state that future commits and project reviews should treat as background truth",
  "identifies a mortic failure mode that should affect review, testing, or release readiness"
];

function rationaleQualityPass(delta) {
  const text = String(delta.rationale ?? "").trim();
  const lower = text.toLowerCase();
  if (text.length < 40) return false;
  if (lower.includes("extracted from")) return false;
  if (lower.includes("because the extractor") || lower.includes("because the rule")) return false;
  if (lower.includes("handoff") || lower.includes("prompt provenance")) return false;
  if (genericRationaleFragments.some((fragment) => lower.includes(fragment))) return false;
  return /Mortic|voice|source|project|implementation|latency|canonical|provider|scratch|TTS|Codex|production|thread|state|review|testing|archive|fork|transcript|UI/i.test(text);
}

function duplicateTitlesPass(deltaSet) {
  const seen = new Set();
  for (const delta of deltaSet.candidateDeltas) {
    const key = `${delta.type}:${String(delta.title ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function summaryQualityPass(deltaSet) {
  const summary = String(deltaSet.summary ?? "").trim();
  const lower = summary.toLowerCase();
  if (deltaSet.candidateDeltas.length === 0) return lower.includes("no canonical project-state changes");
  if (summary.length < 24 || summary.length > 220) return false;
  if (/^extracted \d+ canonical-state candidate/.test(lower)) return false;
  if (lower.includes("from the transcript") || lower.includes("handoff prompt") || lower.includes("recap")) return false;
  return true;
}

function includesAll(actual, expected = []) {
  return expected.every((item, index) => String(actual[index] ?? "").toLowerCase().includes(String(item).toLowerCase()));
}

function strictFieldPass(deltaSet, fixture) {
  const deltas = deltaSet.candidateDeltas;
  if (fixture.expectedSubtypes && JSON.stringify(deltas.map((delta) => delta.subtype)) !== JSON.stringify(fixture.expectedSubtypes)) return false;
  if (fixture.expectedTitleContains && !includesAll(deltas.map((delta) => delta.title), fixture.expectedTitleContains)) return false;
  if (fixture.expectedBodyContains && !includesAll(deltas.map((delta) => delta.body), fixture.expectedBodyContains)) return false;
  if (fixture.expectedRationaleContains && !includesAll(deltas.map((delta) => delta.rationale), fixture.expectedRationaleContains)) return false;
  if (fixture.expectedTargetIds && JSON.stringify(deltas.map((delta) => delta.targetId)) !== JSON.stringify(fixture.expectedTargetIds)) return false;
  if (fixture.expectedTargetCanonicalItemIds && JSON.stringify(deltas.map((delta) => delta.targetCanonicalItemId)) !== JSON.stringify(fixture.expectedTargetCanonicalItemIds)) return false;
  if (fixture.expectedLifecycleActions && JSON.stringify(deltas.map((delta) => delta.lifecycleAction)) !== JSON.stringify(fixture.expectedLifecycleActions)) return false;
  if (fixture.expectedStatusBefore && JSON.stringify(deltas.map((delta) => delta.statusBefore)) !== JSON.stringify(fixture.expectedStatusBefore)) return false;
  if (fixture.expectedStatusAfter && JSON.stringify(deltas.map((delta) => delta.statusAfter)) !== JSON.stringify(fixture.expectedStatusAfter)) return false;
  return true;
}

function lifecyclePass(deltaSet, fixture) {
  const deltas = deltaSet.candidateDeltas;
  if (!deltas.every((delta) => delta.lifecycleAction && delta.statusAfter && Array.isArray(delta.reconcilesWith))) return false;
  if (fixture.expectedLifecycleActions && JSON.stringify(deltas.map((delta) => delta.lifecycleAction)) !== JSON.stringify(fixture.expectedLifecycleActions)) return false;
  if (fixture.expectedStatusAfter && JSON.stringify(deltas.map((delta) => delta.statusAfter)) !== JSON.stringify(fixture.expectedStatusAfter)) return false;
  return true;
}

function targetResolutionPass(deltaSet, fixture) {
  if (!fixture.expectedTargetCanonicalItemIds) return true;
  return JSON.stringify(deltaSet.candidateDeltas.map((delta) => delta.targetCanonicalItemId)) === JSON.stringify(fixture.expectedTargetCanonicalItemIds);
}

function getBucket(production, bucket) {
  if (bucket === "projectStateUpdates") return production.projectStateUpdates ?? [];
  if (bucket === "prioritizationUpdates") return production.prioritizationUpdates ?? [];
  if (bucket === "taskUpdates") return production.taskUpdates ?? [];
  if (bucket === "riskUpdates") return production.riskUpdates ?? [];
  if (bucket === "backlogUpdates") return production.backlogUpdates ?? [];
  return [];
}

function applyLifecyclePass(deltaSet, fixture) {
  if (!fixture.expectedApply) return true;
  const approvedIds = deltaSet.candidateDeltas.map((delta) => delta.id);
  const next = applyApprovedDeltas(fixture.input.production ?? {}, deltaSet, approvedIds);
  return fixture.expectedApply.every((expected) => {
    const item = getBucket(next, expected.bucket).find((candidate) =>
      candidate.id === expected.id ||
      candidate.title === expected.title ||
      (expected.titleContains && String(candidate.title ?? "").toLowerCase().includes(String(expected.titleContains).toLowerCase()))
    );
    if (!item) return false;
    if (expected.status && item.status !== expected.status) return false;
    if (expected.supersededBy && item.supersededBy !== expected.supersededBy && !item.supersededBy) return false;
    if (expected.titleContains && !String(item.title ?? "").toLowerCase().includes(String(expected.titleContains).toLowerCase())) return false;
    return true;
  });
}

function ensureDeltaSetShape(raw) {
  const deltaSet = raw && typeof raw === "object" ? raw : {};
  return {
    ...deltaSet,
    summary: typeof deltaSet.summary === "string" ? deltaSet.summary : "",
    candidateDeltas: (Array.isArray(deltaSet.candidateDeltas) ? deltaSet.candidateDeltas : []).map((delta) => ({
      ...delta,
      title: typeof delta?.title === "string" ? delta.title : "",
      body: typeof delta?.body === "string" ? delta.body : "",
      rationale: typeof delta?.rationale === "string" ? delta.rationale : "",
      evidence: Array.isArray(delta?.evidence) ? delta.evidence : []
    })),
    rejectedCandidates: Array.isArray(deltaSet.rejectedCandidates) ? deltaSet.rejectedCandidates : []
  };
}

for (const fixture of corpus) {
  const deltaSet = ensureDeltaSetShape(precomputed ? precomputed[fixture.name] : extractDeltaSet(fixture.input));
  const validation = validateDeltaSet(deltaSet, fixture.input);
  const actualTypes = deltaSet.candidateDeltas.map((delta) => delta.type);
  const actualOperations = deltaSet.candidateDeltas.map((delta) => delta.operation);
  const actualSubtypes = deltaSet.candidateDeltas.map((delta) => delta.subtype);
  // expectedTypesUnordered exists for model-graded fixtures: model output
  // ordering is nondeterministic, so only the multiset of types is golden.
  const typePass = fixture.expectedTypesUnordered
    ? JSON.stringify([...actualTypes].sort()) === JSON.stringify([...fixture.expectedTypesUnordered].sort())
    : JSON.stringify(actualTypes) === JSON.stringify(fixture.expectedTypes ?? []);
  const operationPass = !fixture.expectedOperations || JSON.stringify(actualOperations) === JSON.stringify(fixture.expectedOperations);
  const rejectedText = deltaSet.rejectedCandidates.map((candidate) => candidate.reason).join("\n");
  const rejectedPass = !fixture.expectedRejectedContains || fixture.expectedRejectedContains.every((needle) => rejectedText.includes(needle));
  const questionNoisePass = fixture.input.transcript
    .filter((turn) => turn.role === "user" && String(turn.text ?? "").trim().endsWith("?"))
    .every((turn) => !deltaSet.candidateDeltas.some((delta) => delta.evidence.some((evidence) => evidence.turnId === turn.id)));
  const injectionPass = !fixture.name.includes("prompt_injection") || deltaSet.candidateDeltas.length === 0;
  const evidencePass = validation.errors.every((error) => !error.includes("evidence"));
  const completePass = deltaSet.candidateDeltas.every((delta) => delta.title.length > 8 && delta.body.length >= delta.title.length);
  const rationalePass = deltaSet.candidateDeltas.every(rationaleQualityPass);
  const duplicatePass = duplicateTitlesPass(deltaSet);
  const strictPass = strictFieldPass(deltaSet, fixture);
  const summaryPass = summaryQualityPass(deltaSet);
  const lifecycleFieldPass = lifecyclePass(deltaSet, fixture);
  const targetPass = targetResolutionPass(deltaSet, fixture);
  const applyPass = applyLifecyclePass(deltaSet, fixture);

  totalCandidates += deltaSet.candidateDeltas.length;
  for (const delta of deltaSet.candidateDeltas) {
    totalSpokenLength += delta.body.length;
    candidateBodyLengths.push(delta.body.length);
  }

  if (validation.valid) valid += 1;
  if (evidencePass) evidenceValid += 1;
  if (typePass && operationPass && rejectedPass && completePass) classificationValid += 1;
  if (operationPass) operationValid += 1;
  if (strictPass) strictFieldValid += 1;
  if (rejectedPass) rejectionValid += 1;
  if (lifecycleFieldPass) lifecycleValid += 1;
  if (targetPass) targetResolutionValid += 1;
  if (applyPass) applyLifecycleValid += 1;
  if (questionNoisePass) noQuestionNoise += 1;
  if (injectionPass) promptInjectionSafe += 1;
  if (rationalePass) rationaleQualityValid += 1;
  if (duplicatePass) duplicateFree += 1;
  if (summaryPass) summaryQualityValid += 1;

  rows.push({
    name: fixture.name,
    valid: validation.valid,
    typePass,
    operationPass,
    rejectedPass,
    questionNoisePass,
    injectionPass,
    rationalePass,
    duplicatePass,
    summaryPass,
    lifecyclePass: lifecycleFieldPass,
    targetPass,
    applyPass,
    strictPass,
    summary: deltaSet.summary,
    candidateCount: deltaSet.candidateDeltas.length,
    types: actualTypes,
    subtypes: actualSubtypes,
    operations: actualOperations,
    lifecycleActions: deltaSet.candidateDeltas.map((delta) => delta.lifecycleAction),
    statusBefore: deltaSet.candidateDeltas.map((delta) => delta.statusBefore),
    statusAfter: deltaSet.candidateDeltas.map((delta) => delta.statusAfter),
    rationales: deltaSet.candidateDeltas.map((delta) => delta.rationale),
    titles: deltaSet.candidateDeltas.map((delta) => delta.title),
    targetIds: deltaSet.candidateDeltas.map((delta) => delta.targetId),
    targetCanonicalItemIds: deltaSet.candidateDeltas.map((delta) => delta.targetCanonicalItemId),
    errors: validation.errors
  });
}

const rate = (count) => count / corpus.length;
const sortedLengths = [...candidateBodyLengths].sort((a, b) => a - b);
const percentile = (values, p) => {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * p) - 1);
  return values[index];
};
const metrics = {
  cases: corpus.length,
  firstPassValidRate: rate(valid),
  evidencePassRate: rate(evidenceValid),
  classificationAccuracy: rate(classificationValid),
  operationAccuracy: rate(operationValid),
  strictFieldAccuracy: rate(strictFieldValid),
  rejectionAccuracy: rate(rejectionValid),
  lifecycleAccuracy: rate(lifecycleValid),
  targetResolutionAccuracy: rate(targetResolutionValid),
  applyLifecycleAccuracy: rate(applyLifecycleValid),
  noQuestionExtractionRate: rate(noQuestionNoise),
  promptInjectionSafeRate: rate(promptInjectionSafe),
  rationaleQualityRate: rate(rationaleQualityValid),
  duplicateFreeRate: rate(duplicateFree),
  summaryQualityRate: rate(summaryQualityValid),
  averageCandidateBodyLength: totalCandidates ? totalSpokenLength / totalCandidates : 0,
  p95CandidateBodyLength: percentile(sortedLengths, 0.95)
};

const passBars = {
  firstPassValidRate: 1,
  evidencePassRate: 1,
  classificationAccuracy: 1,
  operationAccuracy: 1,
  strictFieldAccuracy: 1,
  rejectionAccuracy: 1,
  lifecycleAccuracy: 1,
  targetResolutionAccuracy: 1,
  applyLifecycleAccuracy: 1,
  noQuestionExtractionRate: 1,
  promptInjectionSafeRate: 1,
  rationaleQualityRate: 1,
  duplicateFreeRate: 1,
  summaryQualityRate: 1
};

const failures = Object.entries(passBars)
  .filter(([key, threshold]) => metrics[key] < threshold)
  .map(([key, threshold]) => `${key} ${metrics[key].toFixed(3)} < ${threshold}`);

const report = { metrics, passBars, pass: failures.length === 0, failures, rows };

if (jsonMode) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write("Mortic canonical-state skill harness\n");
  for (const [key, value] of Object.entries(metrics)) {
    process.stdout.write(`- ${key}: ${typeof value === "number" ? value.toFixed(3) : value}\n`);
  }
  if (failures.length) {
    process.stdout.write(`Failures:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  } else {
    process.stdout.write("Pass bars met.\n");
  }
}

if (failures.length) process.exit(1);
