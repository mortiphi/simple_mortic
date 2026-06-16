import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const updateTypes = [
  "project_state_update",
  "prioritisation_update",
  "task_update",
  "risk_update",
  "backlog_update"
];

export const targetPaths = {
  project_state_update: "/projectState",
  prioritisation_update: "/priorities",
  task_update: "/tasks",
  risk_update: "/risks",
  backlog_update: "/backlog"
};

export const lifecycleActions = [
  "create",
  "update",
  "append_evidence",
  "resolve",
  "drop",
  "supersede",
  "reopen",
  "no_op"
];

export const lifecycleStatuses = [
  "open",
  "in_progress",
  "resolved",
  "dropped",
  "superseded",
  "stale"
];

const productionBuckets = [
  { key: "projectStateUpdates", type: "project_state_update" },
  { key: "prioritizationUpdates", type: "prioritisation_update" },
  { key: "taskUpdates", type: "task_update" },
  { key: "riskUpdates", type: "risk_update" },
  { key: "backlogUpdates", type: "backlog_update" }
];

const bucketKeyForType = Object.fromEntries(productionBuckets.map((bucket) => [bucket.type, bucket.key]));

const extractedTypeMap = {
  project_state: "project_state_update",
  prioritization: "prioritisation_update",
  prioritisation: "prioritisation_update",
  task: "task_update",
  risk: "risk_update",
  backlog: "backlog_update"
};

const labelRules = [
  {
    pattern: /^(project state|state update|objective|decision|constraint|architecture fact|architecture|operating rule|current summary|glossary)\s*[:.-]\s*(.+)$/i,
    type: "project_state_update",
    subtype: (label) => {
      const clean = label.toLowerCase().replace(/\s+/g, "_");
      if (clean === "architecture") return "architecture_fact";
      return clean;
    }
  },
  {
    pattern: /^(priority|prioritization|prioritisation|now|next|blocked until|dependency|deprioritised|deprioritized)\s*[:.-]\s*(.+)$/i,
    type: "prioritisation_update",
    subtype: (label) => label.toLowerCase().replace(/\s+/g, "_").replace("prioritization", "now").replace("prioritisation", "now")
  },
  {
    pattern: /^(task|todo|next step|fix|implement|add|write|test|run|verify|complete|split|drop|unblock|block)\s*[:.-]\s*(.+)$/i,
    type: "task_update",
    subtype: (label) => {
      const clean = label.toLowerCase();
      if (clean === "complete") return "complete";
      if (clean === "test" || clean === "run" || clean === "verify") return "test";
      if (clean === "split") return "split";
      if (clean === "drop") return "drop";
      if (clean === "block") return "block";
      if (clean === "unblock") return "unblock";
      return "create";
    }
  },
  {
    pattern: /^(risk|blocker|uncertainty|warning|failure|issue|problem)\s*[:.-]\s*(.+)$/i,
    type: "risk_update",
    subtype: (label, body) => {
      const lower = `${label} ${body}`.toLowerCase();
      if (lower.includes("source")) return "source_thread_pollution";
      if (lower.includes("secret") || lower.includes("key")) return "security";
      if (lower.includes("latency") || lower.includes("delay")) return "latency";
      if (lower.includes("cost")) return "cost";
      if (lower.includes("confus")) return "ux_confusion";
      if (lower.includes("ephemeral") || lower.includes("loss")) return "data_loss";
      return "architecture";
    }
  },
  {
    pattern: /^(backlog|future|idea|research|nice-to-have|deferred|later)\s*[:.-]\s*(.+)$/i,
    type: "backlog_update",
    subtype: (label) => {
      const clean = label.toLowerCase();
      if (clean === "research") return "research_item";
      if (clean === "deferred" || clean === "later") return "deferred_task";
      if (clean === "idea") return "feature_idea";
      return "future_enhancement";
    }
  }
];

const falsePositiveFragments = [
  "commit is a local checkpoint",
  "commit again later",
  "point of no return",
  "generate handoff",
  "missing short handoff",
  "missing full handoff",
  "if you want to chat more",
  "approve all",
  "handoff readiness",
  "archive session"
];

const promptInjectionFragments = [
  "ignore previous instructions",
  "mutate the source thread",
  "write directly to the codex source",
  "send scratch turns to the source thread",
  "store api key",
  "store provider key"
];

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function stableSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 72) || "item";
}

function stableId(type, subtype, title) {
  const base = `${type}_${subtype}_${stableSlug(title)}`;
  const suffix = createHash("sha256").update(base).digest("hex").slice(0, 8);
  return `${base.slice(0, 80)}_${suffix}`;
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transcriptTurns(input) {
  return input.transcript ?? input.session?.transcript ?? [];
}

export function inputText(input) {
  return transcriptTurns(input)
    .map((turn) => [turn.text, turn.spokenText, turn.notesText, turn.sourcesText].filter(Boolean).join("\n"))
    .join("\n");
}

function splitLines(turn) {
  return [turn.text, turn.spokenText, turn.notesText]
    .filter(Boolean)
    .join("\n")
    .replace(/\r/g, "")
    .split(/\n+/)
    .flatMap((line) => line.split(/;\s+/))
    .map((line) => line.replace(/^[-*]\s+|\d+[.)]\s+/, "").trim())
    .filter(Boolean);
}

function deltaTypeForItem(item, fallbackType) {
  if (updateTypes.includes(item?.type)) return item.type;
  return extractedTypeMap[item?.type] ?? fallbackType;
}

function lifecycleStatus(value) {
  const status = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (lifecycleStatuses.includes(status)) return status;
  if (status === "approved" || status === "candidate" || status === "draft" || status === "") return "open";
  if (status === "complete" || status === "completed" || status === "done" || status === "fixed") return "resolved";
  if (status === "dismissed" || status === "rejected" || status === "discarded") return "dropped";
  return "open";
}

function canonicalItemId(item, type) {
  return String(item?.canonicalItemId ?? item?.id ?? stableSlug(item?.title ?? `${type}_item`));
}

function existingItems(input) {
  const production = input.production ?? {};
  const items = [];
  for (const bucket of productionBuckets) {
    for (const item of production[bucket.key] ?? []) {
      const type = deltaTypeForItem(item, bucket.type);
      items.push({
        id: canonicalItemId(item, type),
        type,
        bucket: bucket.key,
        title: String(item.title ?? ""),
        body: String(item.body ?? ""),
        status: lifecycleStatus(item.status),
        rawStatus: item.status
      });
    }
  }
  for (const item of input.extractedItems ?? []) {
    const type = deltaTypeForItem(item, undefined);
    if (!type) continue;
    items.push({
      id: canonicalItemId(item, type),
      type,
      bucket: "extractedItems",
      title: String(item.title ?? ""),
      body: String(item.body ?? ""),
      status: lifecycleStatus(item.status),
      rawStatus: item.status
    });
  }

  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.type}:${item.id}:${normalize(item.title)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return item.title || item.body;
  });
}

function existingTitles(input) {
  return existingItems(input).map((item) => normalize(item.title));
}

const similarityStopWords = new Set([
  "mortic",
  "should",
  "would",
  "could",
  "with",
  "from",
  "that",
  "this",
  "into",
  "using",
  "under",
  "state",
  "update",
  "updates"
]);

function tokenSet(value) {
  return new Set(
    normalize(value)
      .split(" ")
      .map((token) => token.replace(/^evaluation$/, "eval").replace(/^evaluate$/, "eval"))
      .filter((token) => token.length >= 4 && !similarityStopWords.has(token))
  );
}

function overlapScore(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / Math.min(a.size, b.size);
}

function itemMatchScore(item, title, body) {
  const normalizedTitle = normalize(title);
  const itemTitle = normalize(item.title);
  if (!normalizedTitle || !itemTitle) return 0;
  if (itemTitle === normalizedTitle) return 1;
  if (normalizedTitle.includes(itemTitle) || itemTitle.includes(normalizedTitle)) return 0.92;
  return Math.max(
    overlapScore(title, item.title),
    overlapScore(`${title} ${body}`, `${item.title} ${item.body}`)
  );
}

function candidateTargetTypes(type, body) {
  const lower = body.toLowerCase();
  if (type === "task_update" && /\b(promote|move|convert|turn)\b/.test(lower) && lower.includes("backlog")) return ["backlog_update", "task_update"];
  if (type === "backlog_update" && lower.includes("defer") && lower.includes("task")) return ["task_update", "backlog_update"];
  return [type];
}

function bestExistingMatch(existing, type, title, body) {
  const targetTypes = new Set(candidateTargetTypes(type, `${title} ${body}`));
  let best;
  for (const item of existing) {
    if (!targetTypes.has(item.type)) continue;
    const score = itemMatchScore(item, title, body);
    if (score < 0.45) continue;
    if (!best || score > best.score) {
      best = { item, score };
    }
  }
  return best;
}

function parseLabeledLine(line) {
  const lower = line.toLowerCase();
  if (falsePositiveFragments.some((fragment) => lower.includes(fragment))) {
    return {
      rejected: {
        title: line.slice(0, 120),
        reason: "workflow guidance, not canonical state"
      }
    };
  }
  if (promptInjectionFragments.some((fragment) => lower.includes(fragment))) {
    return {
      rejected: {
        title: line.slice(0, 120),
        reason: "unsafe instruction or prompt injection"
      }
    };
  }
  for (const rule of labelRules) {
    const match = line.match(rule.pattern);
    if (!match) continue;
    const label = match[1];
    const body = match[2].trim();
    return {
      type: rule.type,
      subtype: rule.subtype(label, body),
      title: body.replace(/\s+/g, " ").slice(0, 96),
      body
    };
  }
  return null;
}

function titleFromBody(body) {
  return body
    .replace(/^please\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}

function semanticSubtype(type, body) {
  const lower = body.toLowerCase();
  if (type === "project_state_update") {
    if (lower.includes("disjoint children") || lower.includes("forked from the same codex thread")) return "architecture_fact";
    if (lower.includes("source")) return "source_safety";
    if (lower.includes("contract") || lower.includes("tts reads only") || lower.includes("ui renders")) return "contract";
    if (lower.includes("architecture")) return "architecture_fact";
    return "operating_rule";
  }
  if (type === "prioritisation_update") {
    if (lower.includes("before") || lower.includes("after")) return "sequence";
    if (lower.includes("defer") || lower.includes("not") && lower.includes("yet")) return "deprioritised";
    if (lower.includes("block")) return "blocked_until";
    return "now";
  }
  if (type === "task_update") {
    if (lower.includes("canonical") || lower.includes("extraction")) return "create";
    if (lower.includes("test") || lower.includes("harness") || lower.includes("eval") || lower.includes("benchmark") || lower.includes("compare")) return "test";
    if (lower.includes("fix")) return "fix";
    if (lower.includes("replace")) return "replace";
    return "create";
  }
  if (type === "risk_update") {
    if (lower.includes("source")) return "source_thread_pollution";
    if (lower.includes("latency") || lower.includes("delay")) return "latency";
    if (lower.includes("fallback") || lower.includes("confus") || lower.includes("mismatch")) return "ux_confusion";
    if (lower.includes("static") || lower.includes("audio") || lower.includes("tts")) return "voice_quality";
    return "architecture";
  }
  if (type === "backlog_update") {
    if (lower.includes("research")) return "research_item";
    return "future_enhancement";
  }
  return "update";
}

function projectRationale(type, body) {
  const lower = body.toLowerCase();
  if (type === "project_state_update") {
    if (lower.includes("disjoint children") || lower.includes("forked from the same codex thread")) return "This clarifies Mortic's fork tree model so separate scratch sessions remain distinct children of their source Codex thread.";
    if (lower.includes("canonical chart") || lower.includes("source of truth")) return "This keeps Mortic project truth anchored in the canonical chart rather than stale parallel project views.";
    if (/\bsource[- ]thread\b|\bsource codex thread\b/i.test(lower)) return "This is a durable source-thread safety rule that protects the main Codex thread from scratch-session pollution.";
    if (lower.includes("tts reads only") || lower.includes("output contract")) return "This preserves Mortic's voice contract, keeping spoken output and readable notes separated for reliable TTS.";
    if (lower.includes("archive") || lower.includes("transcript")) return "This defines how Mortic preserves scratch-session transcript history locally when Codex forks are temporary.";
    if (lower.includes("scratch sessions") || lower.includes("children")) return "This clarifies Mortic's fork tree model so separate scratch sessions remain distinct children of their source Codex thread.";
    return `This records durable Mortic project state from the scratch session: ${body.slice(0, 120)}`;
  }
  if (type === "prioritisation_update") {
    if (lower.includes("before switching providers")) return "This keeps Mortic focused on latency measurement before making another provider-switching decision.";
    if (lower.includes("not") && lower.includes("yet")) return "This captures a current Mortic sequencing decision so deferred work does not become active implementation prematurely.";
    return `This changes current Mortic sequencing or focus: ${body.slice(0, 120)}`;
  }
  if (type === "task_update") {
    if (lower.includes("latency") || lower.includes("eval") || lower.includes("harness") || lower.includes("benchmark")) return "This is concrete implementation work needed to measure and reduce Mortic voice latency instead of guessing.";
    if (lower.includes("viewer")) return "This gives the user a direct way to inspect canonical Mortic state from the extraction panel.";
    if (lower.includes("production.md")) return "This adds test coverage for the readable Production Chart artifact that users review after commits.";
    if (lower.includes("canonical") || lower.includes("extraction")) return "This is concrete Mortic extraction work that makes committed project state more reliable and reviewable.";
    if (lower.includes("livekit")) return "This turns deferred LiveKit transport telemetry into active Mortic implementation work.";
    return `This is concrete Mortic implementation work with a reviewable outcome: ${body.slice(0, 120)}`;
  }
  if (type === "risk_update") {
    if (lower.includes("fallback")) return "This can hide provider failure and make Mortic look healthy while the requested voice path is broken.";
    if (lower.includes("static") || lower.includes("audio")) return "This can make the voice loop unusable even when Codex and transport are otherwise working.";
    if (lower.includes("workflow") || lower.includes("backlog")) return "This protects Mortic canonical state from noisy workflow text becoming fake backlog or project state.";
    if (lower.includes("source")) return "This identifies a source-thread pollution risk that can damage the user's production Codex context.";
    return `This identifies a Mortic risk that should affect review or release readiness: ${body.slice(0, 120)}`;
  }
  if (lower.includes("migration")) return "This keeps old-session migration as future Mortic work unless it remains cheap enough to justify now.";
  if (lower.includes("livekit")) return "This preserves LiveKit Cloud experiments as future Mortic work after local voice provider stability improves.";
  return `The user explicitly preserved this as future Mortic work rather than current implementation: ${body.replace(/handoff/gi, "handover").slice(0, 120)}`;
}

function parseSemanticLine(line, role) {
  const body = line.replace(/\s+/g, " ").trim();
  const lower = body.toLowerCase();
  if (body.length < 30 || body.endsWith(":") || /^#{1,6}\s+/.test(body)) return null;
  if (role === "assistant" && isAssistantExplanationLine(body)) {
    return {
      rejected: {
        title: body.slice(0, 120),
        reason: "assistant explanation or review checklist, not canonical state"
      }
    };
  }
  if (falsePositiveFragments.some((fragment) => lower.includes(fragment))) {
    return {
      rejected: {
        title: body.slice(0, 120),
        reason: "workflow guidance, not canonical state"
      }
    };
  }
  if (promptInjectionFragments.some((fragment) => lower.includes(fragment))) {
    return {
      rejected: {
        title: body.slice(0, 120),
        reason: "unsafe instruction or prompt injection"
      }
    };
  }
  if (role === "user" && body.endsWith("?")) return null;

  let type = null;
  if (/\b(risk|issue|bug|delay|latency|static|fallback|mismatch|pollut|unsafe|timeout|payload too large|failure|failed|blocker)\b/i.test(body)) {
    type = "risk_update";
  }
  if (/\b(implement|build|add|wire|create|run|verify|test|fix|replace|move|strengthen|compare|extract|benchmark|iterate|instrument)\b/i.test(body)) {
    type = "task_update";
  }
  if (
    type !== "risk_update" &&
    (!type || /^next\b/i.test(body) || /\b(do not replace|not .* yet|defer|deferred|priority|prioritise|prioritize|focus|measurement problem|provider-switching)\b/i.test(body)) &&
    /\b(priority|prioritise|prioritize|focus|before|after|defer|deferred|not .* yet|do not replace|measurement problem|provider-switching)\b/i.test(body)
  ) {
    type = "prioritisation_update";
  }
  if (/\b(must|never|contract|source thread clean|source-thread safety|tts reads only|ui renders)\b/i.test(body)) {
    type = "project_state_update";
  }
  const promotionIntent =
    /\b(move|promote|convert|turn)\b.{0,80}\bbacklog\b.{0,80}\b(task|tasks)\b/i.test(body) ||
    /\b(move|promote|convert|turn)\b.{0,80}\b(task|tasks)\b.{0,80}\bbacklog\b/i.test(body) ||
    /\bout of backlog\b.{0,80}\b(task|tasks)\b/i.test(body);
  if (!promotionIntent && /\b(backlog|future work|later enhancement|nice-to-have|research item)\b/i.test(body)) {
    type = "backlog_update";
  }

  if (!type) return null;
  return {
    type,
    subtype: semanticSubtype(type, body),
    title: titleFromBody(body),
    body,
    rationale: projectRationale(type, body)
  };
}

function isAssistantExplanationLine(body) {
  const text = normalize(body);
  if (!text) return false;
  if (/^(acknowledged|not guaranteed|based on the current canonical state|desired behavior|correct behavior|expected result|safe acceptance check|practical implication|current canonical state says|until approval|you say)\b/.test(text)) {
    return true;
  }
  if (/^(tasks|backlog|risks?)\b.{0,80}\b(includes|no longer shows|should include|should no longer)\b/.test(text)) {
    return true;
  }
  if (/\bold backlog record remains\b/.test(text)) return true;
  if (/\bprevious backlog record\b.{0,80}\b(provenance|historical state)\b/.test(text)) return true;
  if (/^current (tasks|risks|backlog)\b/.test(text)) return true;
  return false;
}

// Lifecycle transitions need directive or stateful phrasing, not bare trigger
// words: "the complete onboarding checklist" is new work, not a completion;
// "drop-down" is not a drop; "replace the stacked prompt rules" is a create,
// not a supersede. Anchors: sentence-leading verbs on the label-stripped body,
// "is/was <state>" forms, or past participles.
function lifecycleActionFor(type, subtype, body, title, match) {
  const lower = `${subtype} ${body}`.toLowerCase();
  const bodyLower = String(body).toLowerCase();
  if (/\b(reopen|regressed|came back|still failing|still broken|still reproduces|still reproducing)\b/i.test(lower)) return "reopen";
  const resolveDirective =
    /\b(is|are|was|were|has been|have been|now|got)\s+(resolved|fixed|complete|completed|done|verified)\b/.test(lower) ||
    /\bpasses now\b|\bno longer applies\b|\bno longer reproduces\b/.test(lower) ||
    /^(resolve|mark)\b/.test(bodyLower) ||
    /^(complete|completed|resolved|fixed|done|verified)$/.test(subtype);
  if (resolveDirective) {
    return match?.item.status === "resolved" ? "no_op" : "resolve";
  }
  const dropDirective =
    /^(drop|discard|deprecate)\b/.test(bodyLower) ||
    /^(drop|discard)$/.test(subtype) ||
    /\b(dropped|discarded|deprecated)\b/.test(lower) ||
    /\bwill not pursue\b|\bnot pursuing\b|\bno longer pursue\b|\bno longer pursuing\b|\bremove from project truth\b/.test(lower);
  if (dropDirective) {
    return match?.item.status === "dropped" ? "no_op" : "drop";
  }
  const supersedeDirective =
    /\b(is|are|was|were|has been|have been|now)\s+superseded\b/.test(lower) ||
    /\b(replaced|superseded)\s+by\b/.test(lower) ||
    /^(supersede|replace|deprecate)\s+(the\s+)?(existing|old|older|current|previous|prior|canonical)\b/.test(bodyLower);
  if (supersedeDirective) {
    return match?.item.status === "superseded" ? "no_op" : "supersede";
  }
  if (match) return "append_evidence";
  return "create";
}

function deltaOperation(type, subtype, body, title, match) {
  const lower = `${subtype} ${body}`.toLowerCase();
  const mentionsBacklogToTask =
    /\b(move|promote|convert|turn)\b.{0,80}\bbacklog\b.{0,80}\b(task|tasks)\b/.test(lower) ||
    /\b(move|promote|convert|turn)\b.{0,80}\b(task|tasks)\b.{0,80}\bbacklog\b/.test(lower) ||
    /\bout of backlog\b.{0,80}\b(task|tasks)\b/.test(lower);
  const mentionsTaskToBacklog =
    /\b(move|demote|defer|convert|turn)\b.{0,80}\b(task|tasks)\b.{0,80}\bbacklog\b/.test(lower) ||
    /\bbacklog\b.{0,80}\b(task|tasks)\b.{0,80}\b(defer|demote)\b/.test(lower);
  if (type === "task_update" && (mentionsBacklogToTask || (lower.includes("promote") && lower.includes("backlog")))) return "promote_backlog_to_task";
  if (type === "backlog_update" && (mentionsTaskToBacklog || (match?.item.type === "task_update" && lower.includes("deferred")))) return "demote_task_to_backlog";
  if (lower.includes("deferred") && type === "backlog_update" && !lower.includes("future work")) return "demote_task_to_backlog";
  const lifecycleAction = lifecycleActionFor(type, subtype, body, title, match);
  if (lifecycleAction === "no_op") return "no_op";
  if (lifecycleAction === "resolve") return subtype === "complete" ? "set_status" : "mark_resolved";
  if (lifecycleAction === "drop" || lifecycleAction === "supersede") return "deprecate";
  if (lifecycleAction === "reopen") return "set_status";
  if (lifecycleAction === "append_evidence") return "append_evidence";
  return "add";
}

function mergeStrategy(operation) {
  if (operation === "no_op") return "no_op";
  if (operation === "append_evidence") return "update_existing";
  if (operation === "mark_resolved" || operation === "set_status") return "update_existing";
  if (operation === "promote_backlog_to_task" || operation === "demote_task_to_backlog") return "update_existing";
  if (operation === "deprecate") return "update_existing";
  return "append_unique";
}

function lifecycleActionAfterOperation(operation, type, subtype, title, body, match) {
  if (operation === "promote_backlog_to_task" || operation === "demote_task_to_backlog") return "update";
  return lifecycleActionFor(type, subtype, body, title, match);
}

function statusAfter(operation, lifecycleAction, type, match) {
  if (lifecycleAction === "no_op") return match?.item.status ?? "open";
  if (lifecycleAction === "resolve") return "resolved";
  if (lifecycleAction === "drop") return "dropped";
  if (lifecycleAction === "supersede") return "superseded";
  if (lifecycleAction === "reopen") return "open";
  if (operation === "promote_backlog_to_task") return "in_progress";
  if (operation === "demote_task_to_backlog") return "open";
  if (lifecycleAction === "append_evidence") return match?.item.status ?? "open";
  if (type === "prioritisation_update") return "open";
  return "open";
}

function defaultRationale(parsed, turn) {
  return parsed.rationale || projectRationale(parsed.type, parsed.body || parsed.title) || `Extracted from ${turn.id ?? "a transcript turn"} as a ${parsed.type.replace(/_/g, " ")}.`;
}

function compactCardTitle(value) {
  return String(value ?? "")
    .replace(/`+/g, "")
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(project state|state update|objective|decision|constraint|architecture fact|architecture|operating rule|current summary|glossary|priority|prioritization|prioritisation|now|next|task|todo|risk|blocker|uncertainty|warning|failure|issue|problem|backlog|future|idea|research|nice-to-have|deferred|later|future work)\s*[:.-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;]\s*$/, "")
    .slice(0, 72);
}

function sessionSummaryFromDeltas(candidateDeltas) {
  if (!candidateDeltas.length) return "No canonical project-state changes were found.";
  const typeRank = {
    prioritisation_update: 0,
    project_state_update: 1,
    task_update: 2,
    risk_update: 3,
    backlog_update: 4
  };
  const titles = [...candidateDeltas]
    .sort((left, right) => (typeRank[left.type] ?? 9) - (typeRank[right.type] ?? 9))
    .slice(0, 3)
    .map((delta) => compactCardTitle(delta.title))
    .filter(Boolean);
  if (titles.length === 1) return `Captured ${titles[0]}.`;
  return `Captured ${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}.`;
}

export function extractDeltaSet(input) {
  const turns = transcriptTurns(input);
  const existingCatalog = existingItems(input);
  const candidateDeltas = [];
  const rejectedCandidates = [];
  const seen = new Set();

  for (const turn of turns) {
    const role = turn.role ?? "assistant";
    for (const line of splitLines(turn)) {
      if (role === "user" && line.endsWith("?")) continue;
      const parsed = parseLabeledLine(line);
      const semanticParsed = parsed || parseSemanticLine(line, role);
      if (!semanticParsed) continue;
      if (semanticParsed.rejected) {
        rejectedCandidates.push({
          ...semanticParsed.rejected,
          evidence: [{ source: "transcript", turnId: turn.id, quote: line.slice(0, 240) }]
        });
        continue;
      }
      const key = `${semanticParsed.type}:${normalize(semanticParsed.title)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const match = bestExistingMatch(existingCatalog, semanticParsed.type, semanticParsed.title, semanticParsed.body);
      const operation = deltaOperation(semanticParsed.type, semanticParsed.subtype, semanticParsed.body, semanticParsed.title, match);
      const lifecycleAction = lifecycleActionAfterOperation(
        operation,
        semanticParsed.type,
        semanticParsed.subtype,
        semanticParsed.title,
        semanticParsed.body,
        match
      );
      const nextStatus = statusAfter(operation, lifecycleAction, semanticParsed.type, match);
      const targetCanonicalItemId = match?.item.id ?? null;
      candidateDeltas.push({
        id: stableId(semanticParsed.type, semanticParsed.subtype, semanticParsed.title),
        type: semanticParsed.type,
        subtype: semanticParsed.subtype,
        operation,
        targetPath: targetPaths[semanticParsed.type],
        targetId: targetCanonicalItemId,
        targetCanonicalItemId,
        lifecycleAction,
        statusBefore: match?.item.status ?? null,
        statusAfter: nextStatus,
        title: semanticParsed.title,
        body: semanticParsed.body,
        rationale: defaultRationale(semanticParsed, turn),
        evidence: [{ source: "transcript", turnId: turn.id, quote: line.slice(0, 240) }],
        confidence: role === "user" ? 0.82 : 0.74,
        reviewStatus: "candidate",
        mergeStrategy: mergeStrategy(operation),
        reconcilesWith: match ? [{
          id: match.item.id,
          type: match.item.type,
          title: match.item.title,
          status: match.item.status,
          score: Number(match.score.toFixed(3))
        }] : [],
        reconciliationReason: match
          ? `Matched existing ${match.item.type.replace(/_update$/, "")} item "${match.item.title}" at score ${match.score.toFixed(3)}.`
          : "No existing canonical item matched strongly enough; candidate creates new project truth.",
        conflicts: []
      });
    }
  }

  const first = turns[0]?.id;
  const last = turns[turns.length - 1]?.id;
  return {
    schemaVersion: "1.0",
    projectId: input.projectId ?? input.project?.id ?? input.production?.projectId ?? "mortic",
    sourceThreadId: input.sourceThreadId ?? input.session?.threadId ?? input.session?.sourceThreadId ?? "unknown-source",
    scratchSessionId: input.scratchSessionId ?? input.session?.id ?? "unknown-scratch",
    transcriptRange: first || last ? { fromTurnId: first, toTurnId: last } : undefined,
    summary: sessionSummaryFromDeltas(candidateDeltas),
    candidateDeltas,
    rejectedCandidates,
    warnings: [],
    requiresHumanReview: true
  };
}

export function validateDeltaSet(deltaSet, input = {}) {
  const errors = [];
  const warnings = [];
  const transcript = normalize(inputText(input));

  if (deltaSet?.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0");
  if (!deltaSet?.projectId) errors.push("projectId is required");
  if (!deltaSet?.sourceThreadId) errors.push("sourceThreadId is required");
  if (!deltaSet?.scratchSessionId) errors.push("scratchSessionId is required");
  if (deltaSet?.sourceThreadId && deltaSet?.scratchSessionId && deltaSet.sourceThreadId === deltaSet.scratchSessionId) {
    errors.push("scratchSessionId must differ from sourceThreadId");
  }
  if (!Array.isArray(deltaSet?.candidateDeltas)) errors.push("candidateDeltas must be an array");
  if (!Array.isArray(deltaSet?.rejectedCandidates)) errors.push("rejectedCandidates must be an array");
  if (!Array.isArray(deltaSet?.warnings)) errors.push("warnings must be an array");
  if (deltaSet?.requiresHumanReview !== true) errors.push("requiresHumanReview must be true");

  for (const delta of deltaSet?.candidateDeltas ?? []) {
    if (!updateTypes.includes(delta.type)) errors.push(`${delta.id ?? "delta"} has invalid type ${delta.type}`);
    if (!delta.id || !delta.title || !delta.body || !delta.rationale) errors.push(`${delta.id ?? "delta"} is missing required text fields`);
    if (!Array.isArray(delta.evidence) || delta.evidence.length === 0) errors.push(`${delta.id ?? "delta"} has no evidence`);
    if (!lifecycleActions.includes(delta.lifecycleAction)) {
      errors.push(`${delta.id ?? "delta"} has invalid lifecycleAction ${delta.lifecycleAction}`);
    }
    if (!lifecycleStatuses.includes(delta.statusAfter)) {
      errors.push(`${delta.id ?? "delta"} has invalid statusAfter ${delta.statusAfter}`);
    }
    if (delta.statusBefore !== null && delta.statusBefore !== undefined && !lifecycleStatuses.includes(delta.statusBefore)) {
      errors.push(`${delta.id ?? "delta"} has invalid statusBefore ${delta.statusBefore}`);
    }
    if (delta.lifecycleAction !== "create" && delta.operation !== "add" && !("targetCanonicalItemId" in delta)) {
      errors.push(`${delta.id ?? "delta"} must include targetCanonicalItemId for reconciliation operations`);
    }
    if (!Array.isArray(delta.reconcilesWith)) errors.push(`${delta.id ?? "delta"} reconcilesWith must be an array`);
    if (delta.reviewStatus !== "candidate") errors.push(`${delta.id ?? "delta"} reviewStatus must be candidate`);
    if (typeof delta.confidence !== "number" || delta.confidence < 0 || delta.confidence > 1) {
      errors.push(`${delta.id ?? "delta"} confidence must be 0..1`);
    }
    for (const evidence of delta.evidence ?? []) {
      if (!evidence.quote) errors.push(`${delta.id ?? "delta"} has evidence without quote`);
      if (evidence.source === "transcript" && transcript && !transcript.includes(normalize(evidence.quote))) {
        errors.push(`${delta.id ?? "delta"} evidence quote not found in transcript`);
      }
    }
    const lowerBody = normalize(`${delta.title} ${delta.body}`);
    if (falsePositiveFragments.some((fragment) => lowerBody.includes(fragment))) {
      errors.push(`${delta.id ?? "delta"} contains workflow guidance that should be rejected`);
    }
    if (promptInjectionFragments.some((fragment) => lowerBody.includes(fragment)) && delta.type !== "risk_update") {
      errors.push(`${delta.id ?? "delta"} contains unsafe prompt-injection text outside risk handling`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function applyApprovedDeltas(production, deltaSet, approvedIds) {
  const approved = new Set(approvedIds);
  const next = structuredClone(production ?? {});
  for (const bucket of productionBuckets) {
    next[bucket.key] ??= [];
  }

  const bucketForType = (type) => next[bucketKeyForType[type]];
  const now = () => new Date().toISOString();
  const sourceKey = (source) => `${source.source ?? ""}:${source.turnId ?? ""}:${source.quote ?? ""}`;
  const mergeSources = (existing = [], incoming = []) => {
    const merged = [...existing];
    const seen = new Set(merged.map(sourceKey));
    for (const source of incoming) {
      const key = sourceKey(source);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(source);
    }
    return merged;
  };
  const matchesDelta = (item, delta) => {
    const ids = [delta.targetCanonicalItemId, delta.targetId].filter(Boolean).map(String);
    if (ids.includes(String(item.id ?? item.canonicalItemId ?? ""))) return true;
    return normalize(item.title) === normalize(delta.title);
  };
  const findInType = (type, delta) => {
    const bucket = bucketForType(type) ?? [];
    const item = bucket.find((candidate) => matchesDelta(candidate, delta));
    return item ? { type, bucket, item } : null;
  };
  const findExisting = (types, delta) => {
    for (const type of types) {
      const found = findInType(type, delta);
      if (found) return found;
    }
    return null;
  };
  const itemFromDelta = (delta, status, id = delta.id) => ({
    id,
    type: delta.type,
    subtype: delta.subtype,
    title: delta.title,
    body: delta.body,
    status,
    confidence: delta.confidence,
    sources: delta.evidence,
    lifecycleAction: delta.lifecycleAction,
    targetCanonicalItemId: delta.targetCanonicalItemId,
    updatedAt: now()
  });
  const upsert = (type, delta, status = delta.statusAfter, id = delta.targetCanonicalItemId || delta.targetId || delta.id) => {
    const bucket = bucketForType(type);
    const existing = findInType(type, { ...delta, targetCanonicalItemId: id, targetId: id })?.item
      ?? bucket.find((item) => normalize(item.title) === normalize(delta.title));
    const item = itemFromDelta(delta, status, id);
    if (existing) {
      Object.assign(existing, {
        ...item,
        id: existing.id ?? item.id,
        sources: mergeSources(existing.sources, delta.evidence),
        createdAt: existing.createdAt ?? item.updatedAt
      });
      return existing;
    }
    const created = { ...item, createdAt: item.updatedAt };
    bucket.push(created);
    return created;
  };

  for (const delta of deltaSet.candidateDeltas ?? []) {
    if (!approved.has(delta.id)) continue;

    if (delta.operation === "promote_backlog_to_task") {
      const existing = findExisting(["backlog_update", "task_update"], delta);
      if (existing?.type === "backlog_update") {
        Object.assign(existing.item, {
          status: "superseded",
          supersededBy: delta.id,
          sources: mergeSources(existing.item.sources, delta.evidence),
          updatedAt: now()
        });
      }
      upsert("task_update", delta, "in_progress", delta.id);
      continue;
    }

    if (delta.operation === "demote_task_to_backlog") {
      const existing = findExisting(["task_update", "backlog_update"], delta);
      if (existing?.type === "task_update") {
        Object.assign(existing.item, {
          status: "superseded",
          supersededBy: delta.id,
          sources: mergeSources(existing.item.sources, delta.evidence),
          updatedAt: now()
        });
      }
      upsert("backlog_update", delta, "open", delta.id);
      continue;
    }

    if (delta.lifecycleAction === "no_op") continue;

    const existing = findExisting([delta.type], delta);
    if (existing) {
      Object.assign(existing.item, {
        title: delta.title,
        body: delta.body,
        subtype: delta.subtype,
        status: delta.statusAfter,
        confidence: delta.confidence,
        sources: mergeSources(existing.item.sources, delta.evidence),
        lifecycleAction: delta.lifecycleAction,
        updatedAt: now()
      });
    } else {
      upsert(delta.type, delta, delta.statusAfter, delta.targetCanonicalItemId || delta.targetId || delta.id);
    }
  }
  next.updatedAt = now();
  return next;
}

export function renderProductionMarkdown(production) {
  const section = (title, items = []) => {
    const renderItems = (list) => list.map((item) => {
      const status = lifecycleStatus(item.status);
      const statusLabel = status === "open" ? "" : ` _${status}_`;
      return `- **${item.title}**${statusLabel}\n  - ${item.body}`;
    }).join("\n");
    const active = items.filter((item) => !["resolved", "dropped", "superseded", "stale"].includes(lifecycleStatus(item.status)));
    const inactive = items.filter((item) => ["resolved", "dropped", "superseded", "stale"].includes(lifecycleStatus(item.status)));
    const body = [
      active.length ? renderItems(active) : "None.",
      inactive.length ? `\n### Historical\n\n${renderItems(inactive)}` : ""
    ].filter(Boolean).join("\n");
    return `## ${title}\n\n${body}`;
  };
  return [
    `# ${production.projectTitle ?? "Mortic Production Chart"}`,
    production.workspacePath ? `Workspace: ${production.workspacePath}` : "",
    production.updatedAt ? `Updated: ${production.updatedAt}` : "",
    "",
    "## Summary",
    "",
    production.currentProjectSummary ?? "No summary yet.",
    "",
    section("Project State Updates", production.projectStateUpdates),
    "",
    section("Prioritisation Updates", production.prioritizationUpdates),
    "",
    section("Task Updates", production.taskUpdates),
    "",
    section("Risk Updates", production.riskUpdates),
    "",
    section("Backlog Updates", production.backlogUpdates),
    ""
  ].filter((line) => line !== "").join("\n");
}
