#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function usage() {
  return [
    "Usage: node scripts/push_draft_compilation.mjs <draft-pack.json|-> [--api http://127.0.0.1:5152] [--print-json]",
    "",
    "Posts a Mortic canonical-state draft pack to the running Mortic app.",
    "The app stores reviewable draft cards only; approval still happens in Mortic."
  ].join("\n");
}

function actionFromOperation(operation) {
  if (!operation || typeof operation !== "string") return undefined;
  if (/resolve|mark_resolved|complete|close/.test(operation)) return "resolve";
  if (/drop|discard|remove/.test(operation)) return "drop";
  if (/supersede|replace/.test(operation)) return "supersede";
  if (/reopen/.test(operation)) return "reopen";
  if (/append|evidence/.test(operation)) return "append_evidence";
  if (/update|edit|change|promote|demote/.test(operation)) return "update";
  if (/no[_-]?op|unchanged/.test(operation)) return "no_op";
  return "create";
}

function normaliseType(type) {
  if (type === "project_state" || type === "project_state_update") return "project_state_update";
  if (type === "prioritization" || type === "prioritisation" || type === "prioritization_update" || type === "prioritisation_update") return "prioritisation_update";
  if (type === "task" || type === "task_update") return "task_update";
  if (type === "risk" || type === "risk_update") return "risk_update";
  if (type === "backlog" || type === "backlog_update") return "backlog_update";
  return type;
}

function normaliseCandidate(candidate, index) {
  const operation = candidate.operation || candidate.canonicalOperation;
  const type = normaliseType(candidate.type || candidate.bucket || candidate.updateType);
  if (!type) {
    throw new Error(`Candidate ${index + 1} is missing type/bucket/updateType.`);
  }
  const title = candidate.title || candidate.summary || operation || `Imported delta ${index + 1}`;
  const body = candidate.body || candidate.description || candidate.details || candidate.evidenceQuote || title;
  return {
    id: candidate.id || candidate.deltaId,
    type,
    title,
    body,
    confidence: candidate.confidence,
    delta: candidate.delta,
    canonicalItemId: candidate.canonicalItemId,
    targetCanonicalItemId: candidate.targetCanonicalItemId,
    lifecycleAction: candidate.lifecycleAction || actionFromOperation(operation),
    lifecycleStatusBefore: candidate.lifecycleStatusBefore || candidate.statusBefore,
    lifecycleStatusAfter: candidate.lifecycleStatusAfter || candidate.statusAfter,
    canonicalOperation: operation,
    mergeStrategy: candidate.mergeStrategy,
    reconcilesWith: candidate.reconcilesWith,
    reconciliationReason: candidate.reconciliationReason,
    conflicts: candidate.conflicts,
    evidenceQuote: candidate.evidenceQuote,
    selectionReason: candidate.selectionReason
  };
}

function normalisePack(input) {
  const candidateDeltas = Array.isArray(input.candidateDeltas)
    ? input.candidateDeltas.map(normaliseCandidate)
    : [];
  if (candidateDeltas.length === 0) {
    throw new Error("Draft pack must include candidateDeltas.");
  }
  return {
    schemaVersion: "1.0",
    importId: input.importId || input.id,
    title: input.title,
    summary: input.summary,
    provider: input.provider || "codex",
    providerRefId: input.providerRefId,
    conversationId: input.conversationId,
    threadId: input.threadId || input.sourceThreadId,
    sourceUri: input.sourceUri,
    baseCheckpointId: input.baseCheckpointId,
    basisCompilationId: input.basisCompilationId,
    priorImportId: input.priorImportId,
    priorBoundaryReceiptId: input.priorBoundaryReceiptId,
    compilePlan: input.compilePlan,
    sourceWindows: input.sourceWindows,
    coveredFrom: input.coveredFrom,
    coveredTo: input.coveredTo,
    boundaryStatus: input.boundaryStatus,
    boundaryReason: input.boundaryReason,
    transcriptExcerpt: input.transcriptExcerpt,
    transcriptHash: input.transcriptHash,
    createdAt: input.createdAt,
    candidateDeltas
  };
}

async function fillPriorReceiptFromMortic(api, pack) {
  if (pack.priorBoundaryReceiptId) return pack;
  if (!pack.providerRefId && !pack.threadId && !pack.conversationId) return pack;
  const url = new URL("/api/project/coverage/latest", api.replace(/\/$/, ""));
  url.searchParams.set("provider", pack.provider || "codex");
  if (pack.providerRefId) url.searchParams.set("providerRefId", pack.providerRefId);
  if (pack.conversationId) url.searchParams.set("conversationId", pack.conversationId);
  if (pack.threadId) url.searchParams.set("threadId", pack.threadId);
  try {
    const response = await fetch(url);
    if (!response.ok) return pack;
    const payload = await response.json();
    const receipt = payload.receipt;
    if (!receipt || receipt.importId === pack.importId) return pack;
    const primaryWindow = Array.isArray(receipt.sourceWindows)
      ? receipt.sourceWindows.find((window) => window.windowKind === "primary")
      : undefined;
    return {
      ...pack,
      priorBoundaryReceiptId: receipt.id,
      priorImportId: pack.priorImportId || receipt.importId,
      basisCompilationId: pack.basisCompilationId || receipt.compilationId,
      coveredFrom: pack.coveredFrom || primaryWindow?.coveredTo
    };
  } catch {
    return pack;
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const file = args.find((arg) => !arg.startsWith("--"));
if (!file) {
  console.error(usage());
  process.exit(2);
}

const apiFlagIndex = args.indexOf("--api");
const api = apiFlagIndex >= 0
  ? args[apiFlagIndex + 1]
  : process.env.MORTIC_API_URL || "http://127.0.0.1:5152";
if (!api || api.startsWith("--")) {
  console.error("--api requires a URL.");
  process.exit(2);
}

const text = file === "-"
  ? await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    })
  : await readFile(file, "utf8");

const pack = await fillPriorReceiptFromMortic(api, normalisePack(JSON.parse(text)));
const response = await fetch(`${api.replace(/\/$/, "")}/api/project/draft-compilations/import`, {
  method: "POST",
  headers: {
    "content-type": "application/json"
  },
  body: JSON.stringify(pack)
});
const responseText = await response.text();
let payload;
try {
  payload = JSON.parse(responseText);
} catch {
  payload = { raw: responseText };
}
if (!response.ok) {
  console.error(`Mortic import failed (${response.status}): ${payload.error || responseText}`);
  process.exit(1);
}

if (args.includes("--print-json")) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const artifact = payload.artifact ? ` artifact=${payload.artifact.id}` : "";
  console.log(`Imported draft compilation ${payload.compilation.id} with ${payload.createdItems.length} new review card(s).${artifact}`);
  console.log(`Open Mortic and review Project updates before approval: ${api}`);
}
