import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import type {
  ExtractedItem,
  ExtractedItemType,
  MorticSession,
  ProductionChart,
  ReasoningEffort,
  TranscriptRole
} from "../shared/types.js";
import { runCodexIsolatedTurn } from "./codex.js";

type CanonicalEvidence = {
  source: "transcript" | "session" | "production_json" | "production_md";
  turnId?: string;
  quote: string;
};

type CanonicalDelta = {
  id: string;
  type: "project_state_update" | "prioritisation_update" | "task_update" | "risk_update" | "backlog_update";
  subtype: string;
  operation: string;
  targetPath: string;
  targetId: string | null;
  title: string;
  body: string;
  rationale: string;
  evidence: CanonicalEvidence[];
  confidence: number;
  reviewStatus: "candidate";
  mergeStrategy: string;
  conflicts: string[];
};

type CanonicalDeltaSet = {
  schemaVersion: "1.0";
  projectId: string;
  sourceThreadId: string;
  scratchSessionId: string;
  summary: string;
  candidateDeltas: CanonicalDelta[];
  rejectedCandidates: Array<{ title: string; reason: string; evidence?: CanonicalEvidence[] }>;
  warnings: string[];
  requiresHumanReview: true;
};

type CanonicalSkillInput = {
  projectId: string;
  sourceThreadId: string;
  scratchSessionId: string;
  session: Pick<MorticSession, "id" | "threadId" | "sourceUri" | "forkCheckpoint" | "createdAt" | "updatedAt">;
  production?: ProductionChart;
  extractedItems: ExtractedItem[];
  transcript: MorticSession["transcript"];
};

type CanonicalExtractionParams = {
  projectId: string;
  sourceThreadId: string;
  scratchSessionId: string;
  session: MorticSession;
  production?: ProductionChart;
  existing: ExtractedItem[];
  approveItemIds?: Set<string>;
  hash: (value: string, length?: number) => string;
  nowIso: () => string;
};

export type CanonicalExtractionResult = {
  items: ExtractedItem[];
  summary: string;
};

const typeMap: Record<CanonicalDelta["type"], ExtractedItemType> = {
  project_state_update: "project_state",
  prioritisation_update: "prioritization",
  task_update: "task",
  risk_update: "risk",
  backlog_update: "backlog"
};

function skillDir(): string {
  return path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "skills", "mortic-canonical-state");
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractionFingerprint(type: ExtractedItemType, title: string, body: string): string {
  return `${type}:${normalize(`${title} ${body}`).slice(0, 180)}`;
}

function existingByFingerprint(existing: ExtractedItem[]): Map<string, ExtractedItem> {
  return new Map(existing.map((item) => [extractionFingerprint(item.type, item.title, item.body), item]));
}

function buildCanonicalSkillInput(params: CanonicalExtractionParams): CanonicalSkillInput {
  return {
    projectId: params.projectId,
    sourceThreadId: params.sourceThreadId,
    scratchSessionId: params.scratchSessionId,
    session: {
      id: params.session.id,
      threadId: params.session.threadId,
      sourceUri: params.session.sourceUri,
      forkCheckpoint: params.session.forkCheckpoint,
      createdAt: params.session.createdAt,
      updatedAt: params.session.updatedAt
    },
    production: params.production,
    extractedItems: params.existing,
    transcript: params.session.transcript
  };
}

function runCommand(command: string, args: string[], stdin?: string, timeoutMs = 10 * 60 * 1000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function runSkillScript(scriptName: string, input: CanonicalSkillInput): Promise<CanonicalDeltaSet> {
  const dir = skillDir();
  const scriptPath = path.join(dir, "scripts", scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Mortic canonical-state skill script missing: ${scriptPath}`);
  }
  const workDir = await mkdtemp(path.join(tmpdir(), "mortic-canonical-"));
  const inputPath = path.join(workDir, "input.json");
  try {
    await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    const result = await runCommand(process.execPath, [scriptPath, inputPath]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `${scriptName} exited with ${result.code}`);
    }
    return JSON.parse(result.stdout) as CanonicalDeltaSet;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function validateWithSkill(deltaSet: CanonicalDeltaSet, input: CanonicalSkillInput): Promise<void> {
  const dir = skillDir();
  const validatePath = path.join(dir, "scripts", "validate_delta.mjs");
  if (!existsSync(validatePath)) return;
  const workDir = await mkdtemp(path.join(tmpdir(), "mortic-canonical-validate-"));
  const inputPath = path.join(workDir, "input.json");
  const deltaPath = path.join(workDir, "delta.json");
  try {
    await writeFile(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
    await writeFile(deltaPath, `${JSON.stringify(deltaSet, null, 2)}\n`, "utf8");
    const result = await runCommand(process.execPath, [validatePath, deltaPath, inputPath]);
    if (result.code !== 0) {
      throw new Error(result.stdout.trim() || result.stderr.trim() || "Canonical delta validation failed");
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function extractWithCodex(input: CanonicalSkillInput): Promise<CanonicalDeltaSet> {
  const dir = skillDir();
  const [skill, schema, guide, mergeRules] = await Promise.all([
    readFile(path.join(dir, "SKILL.md"), "utf8"),
    readFile(path.join(dir, "references", "canonical_delta_schema.json"), "utf8"),
    readFile(path.join(dir, "references", "update_type_guide.md"), "utf8"),
    readFile(path.join(dir, "references", "merge_rules.md"), "utf8")
  ]);
  const prompt = [
    "Use the Mortic canonical-state skill below to extract project-state deltas.",
    "Return ONLY valid JSON matching the CanonicalStateDeltaSet schema. Do not wrap it in Markdown.",
    "Important: do semantic extraction from the transcript. Do not require explicit Task:/Risk: labels.",
    "Important: user questions are not canonical state unless they contain an explicit instruction or decision.",
    "Important: every rationale must explain why the item matters to the Mortic project/work, not why the extractor picked it.",
    "Important: never cite handoff provenance as a rationale. Use project-native reasons like latency measurement, source-thread safety, TTS fallback correctness, or canonical-state consistency.",
    "Important: compare against existing production and extracted items. If a candidate is semantically the same as existing state, use append_evidence or merge_duplicate instead of creating a duplicate.",
    "Important: workflow copy such as archive/commit/generate handoff controls is not backlog. Put it in rejectedCandidates when it is not project state.",
    "Important: provider pricing/source answers are not canonical state unless the scratch session settles a Mortic decision, task, risk, priority, or explicit future work.",
    "Important: if one sentence has both a sequencing choice and concrete work, prefer the project-relevant delta rather than a generic summary. Keep rationales specific and non-repeated.",
    "Important: each title must be a compact card label, not a full sentence. Use 3-8 words, 72 characters or fewer, no Markdown, no raw paths, no code, and no leading filler like 'Yes' or 'The answer is'. Put detail in body.",
    "Important: do not extract assistant explanations of current UI location, button behavior, or generic capability descriptions unless they create a durable project rule, task, risk, priority, or explicit future work.",
    "Important: summary must be a compact session summary for the Scratch Session card. Use one project-native sentence, 180 characters or fewer. Do not say transcript, session, handoff, recap, summary, or extracted candidates.",
    "",
    "## Skill",
    skill,
    "",
    "## Update Guide",
    guide,
    "",
    "## Merge Rules",
    mergeRules,
    "",
    "## JSON Schema",
    schema,
    "",
    "## Input Packet",
    JSON.stringify(input, null, 2)
  ].join("\n");

  const response = await runCodexIsolatedTurn({
    prompt,
    reasoningEffort: (process.env.MORTIC_CANONICAL_REASONING as ReasoningEffort) || "low",
    codexModel: process.env.MORTIC_CANONICAL_MODEL || "gpt-5.4-mini"
  });
  const deltaSet = JSON.parse(stripJsonFence(response)) as CanonicalDeltaSet;
  await validateWithSkill(deltaSet, input);
  return deltaSet;
}

async function extractCanonicalDeltaSet(input: CanonicalSkillInput): Promise<CanonicalDeltaSet> {
  const extractor = process.env.MORTIC_CANONICAL_EXTRACTOR ?? "codex";
  if (extractor === "script") return runSkillScript("extract_state_delta.mjs", input);
  if (extractor === "codex") {
    try {
      return await extractWithCodex(input);
    } catch (error) {
      if (process.env.MORTIC_CANONICAL_REQUIRE_MODEL === "1") throw error;
      return runSkillScript("extract_state_delta.mjs", input);
    }
  }
  return runSkillScript("extract_state_delta.mjs", input);
}

function evidenceSourceForItem(evidence: CanonicalEvidence | undefined): NonNullable<ExtractedItem["evidenceSource"]> {
  if (!evidence) return "transcript";
  if (evidence.source === "session") return "session";
  if (evidence.source === "production_json") return "production_json";
  if (evidence.source === "production_md") return "production_md";
  return "transcript";
}

function roleForEvidence(evidence: CanonicalEvidence | undefined, session: MorticSession): TranscriptRole {
  if (!evidence?.turnId) return "system";
  return session.transcript.find((entry) => entry.id === evidence.turnId)?.role ?? "assistant";
}

function compactCardTitle(value: string): string {
  const cleaned = value
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(project state|state update|objective|decision|constraint|architecture fact|architecture|operating rule|current summary|glossary|priority|prioritization|prioritisation|now|next|task|todo|risk|blocker|uncertainty|warning|failure|issue|problem|backlog|future|idea|research|nice-to-have|deferred|later|future work)\s*[:.-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstClause = cleaned.split(/\s+[.;]\s+|:\s+/)[0]?.trim() || cleaned;
  if (firstClause.length <= 72) return firstClause.replace(/[.:;]\s*$/, "");
  const words = firstClause.split(/\s+/);
  let next = "";
  for (const word of words) {
    const candidate = next ? `${next} ${word}` : word;
    if (candidate.length > 72) break;
    next = candidate;
  }
  return (next || firstClause.slice(0, 72)).replace(/[,:;.-]\s*$/, "");
}

function compactSummarySentence(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .split(/\n+/)
    .map((line) => line.replace(/^[-*]\s+|\d+[.)]\s+|#{1,6}\s+/, "").trim())
    .filter(Boolean)
    .find((line) => line.length >= 24) ?? value.replace(/\s+/g, " ").trim();
}

function canonicalSessionSummary(deltaSet: CanonicalDeltaSet): string {
  const direct = compactSummarySentence(deltaSet.summary || "");
  if (
    direct &&
    !/^Extracted \d+ canonical-state candidate/i.test(direct) &&
    !/^No canonical-state changes detected/i.test(direct)
  ) {
    return direct.slice(0, 220).replace(/\s+\S*$/, "").trim();
  }

  const typeRank: Record<CanonicalDelta["type"], number> = {
    prioritisation_update: 0,
    project_state_update: 1,
    task_update: 2,
    risk_update: 3,
    backlog_update: 4
  };
  const titles = [...deltaSet.candidateDeltas]
    .sort((left, right) => typeRank[left.type] - typeRank[right.type])
    .slice(0, 3)
    .map((delta) => compactCardTitle(delta.title).replace(/\.$/, ""))
    .filter(Boolean);

  if (titles.length === 0) return "No canonical project-state changes were found.";
  const summary = titles.length === 1
    ? `Captured ${titles[0]}.`
    : `Captured ${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}.`;
  return summary.slice(0, 220).replace(/\s+\S*$/, "").trim();
}

export async function extractItemsWithCanonicalStateSkill(params: CanonicalExtractionParams): Promise<CanonicalExtractionResult> {
  const input = buildCanonicalSkillInput(params);
  const deltaSet = await extractCanonicalDeltaSet(input);
  const previousById = new Map(params.existing.map((item) => [item.id, item]));
  const previousByFingerprint = existingByFingerprint(params.existing);
  const createdAt = params.nowIso();

  const items = deltaSet.candidateDeltas.slice(0, 12).map((delta) => {
    const type = typeMap[delta.type];
    const evidence = delta.evidence[0];
    const id = `item-${params.hash(`${params.scratchSessionId}:${delta.id}`, 18)}`;
    const fingerprint = extractionFingerprint(type, delta.title, delta.body);
    const previous = previousById.get(id) ?? previousByFingerprint.get(fingerprint);
    return {
      id,
      projectId: params.projectId,
      sourceThreadId: params.sourceThreadId,
      scratchSessionId: params.scratchSessionId,
      sourceTurnId: evidence?.turnId ?? delta.id,
      type,
      title: compactCardTitle(delta.title),
      body: delta.body,
      confidence: delta.confidence,
      status: params.approveItemIds?.has(id) ? "approved" : previous?.status ?? "draft",
      delta: previous ? (normalize(previous.body) === normalize(delta.body) ? "unchanged" : "changed") : "new",
      evidenceSource: evidenceSourceForItem(evidence),
      selectionReason: delta.rationale,
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: createdAt,
      transcriptAnchor: {
        entryId: evidence?.turnId ?? delta.id,
        role: roleForEvidence(evidence, params.session),
        createdAt: params.session.transcript.find((entry) => entry.id === evidence?.turnId)?.createdAt ?? params.session.updatedAt,
        quote: evidence?.quote?.slice(0, 240) ?? delta.body.slice(0, 240)
      },
      mergedIntoId: previous?.mergedIntoId
    } satisfies ExtractedItem;
  });

  return {
    items,
    summary: canonicalSessionSummary(deltaSet)
  };
}
