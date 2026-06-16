import type {
  ExtractedItem,
  ExtractedItemType,
  MorticSession,
  TranscriptEntry
} from "../../shared/types.js";

import { hash, nowIso } from "./common.js";
export type ExtractionCandidate = {
  type: ExtractedItemType;
  title?: string;
  body: string;
  entryId: string;
  role: TranscriptEntry["role"];
  createdAt: string;
  confidence: number;
  evidenceSource: NonNullable<ExtractedItem["evidenceSource"]>;
  selectionReason: string;
};

export function cleanExtractionLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+|\d+[.)]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lineCandidates(entry: TranscriptEntry): string[] {
  if (entry.role !== "assistant") return [];
  const text = [entry.notesText, entry.spokenText]
    .filter(Boolean)
    .join("\n")
    .replace(/\r/g, "");
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .map(cleanExtractionLine)
    .filter((line) => line.length >= 24)
    .filter((line) => !/^(yes|no|yep|right|you asked|the answer is)\b/i.test(line))
    .filter((line) => !line.endsWith("?"))
    .filter((line) => !line.endsWith(":"))
    .slice(0, 18);
}

export function handoffEvidenceSource(sourceId: string): NonNullable<ExtractedItem["evidenceSource"]> {
  if (sourceId === "handoff_short") return "handoff_short";
  if (sourceId === "handoff_full") return "handoff_full";
  return "handoff";
}

export function handoffSelectionReason(sourceId: string): string {
  if (sourceId === "handoff_short") {
    return "Picked from the short handoff prompt because it states the highest-order continuation action.";
  }
  if (sourceId === "handoff_full") {
    return "Picked from the full handoff prompt because it is the curated, action-oriented summary of this scratch session.";
  }
  return "Picked from the handoff prompt because it is already condensed for the next Codex step.";
}

export function isHandoffSectionHeading(line: string): boolean {
  return line.endsWith(":") && line.length <= 130 && !line.endsWith("?:");
}

export function summarizeHandoffSection(heading: string, lines: string[]): string | null {
  const cleaned = lines
    .map(cleanExtractionLine)
    .filter((line) => line.length >= 8)
    .filter((line) => !isWorkflowGuidance(line));
  if (cleaned.length === 0) return null;
  const preview = cleaned.slice(0, 6).join("; ");
  const suffix = cleaned.length > 6 ? `; plus ${cleaned.length - 6} more.` : "";
  return `${heading.replace(/:$/, "")}: ${preview}${suffix}`;
}

export function handoffTextCandidates(session: MorticSession): Array<{
  sourceId: "handoff_short" | "handoff_full" | "handoff";
  body: string;
}> {
  const sources: Array<{ sourceId: "handoff_short" | "handoff_full" | "handoff"; text?: string }> = [];
  if (session.handoffFull?.trim()) {
    sources.push({ sourceId: "handoff_full", text: session.handoffFull });
  } else if (session.handoffShort?.trim()) {
    sources.push({ sourceId: "handoff_short", text: session.handoffShort });
  } else if (session.handoff?.trim()) {
    sources.push({ sourceId: "handoff", text: session.handoff });
  }

  const candidates: Array<{ sourceId: "handoff_short" | "handoff_full" | "handoff"; body: string }> = [];
  for (const source of sources) {
    const lines = (source.text ?? "").replace(/\r/g, "").split("\n");
    let activeHeading: string | null = null;
    let activeLines: string[] = [];
    const flushSection = () => {
      if (!activeHeading) return;
      const section = summarizeHandoffSection(activeHeading, activeLines);
      if (section) candidates.push({ sourceId: source.sourceId, body: section });
      activeHeading = null;
      activeLines = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^#{1,6}\s+/.test(line)) continue;
      const cleaned = cleanExtractionLine(line);
      if (!cleaned || isWorkflowGuidance(cleaned)) continue;
      if (isHandoffSectionHeading(cleaned)) {
        flushSection();
        activeHeading = cleaned;
        activeLines = [];
        continue;
      }
      if (activeHeading) {
        activeLines.push(cleaned);
        continue;
      }
      if (cleaned.length >= 28 && !cleaned.endsWith("?")) {
        candidates.push({ sourceId: source.sourceId, body: cleaned });
      }
    }
    flushSection();
  }

  return candidates;
}

export function classifyLine(line: string): ExtractedItemType | null {
  const lower = line.toLowerCase();
  if (isWorkflowGuidance(lower)) return null;
  if (/^(risk|blocker|uncertainty|warning|failure|issue|problem)\s*[:.-]/i.test(line)) return "risk";
  if (/^(task|todo|next step|fix|implement|add|write|test|run|verify)\s*[:.-]/i.test(line)) return "task";
  if (/^(backlog|later|future|idea|nice-to-have|defer|deferred)\s*[:.-]/i.test(line)) return "backlog";
  if (/^(priority|prioritization|prioritisation|most important|now|deferred because)\s*[:.-]/i.test(line)) return "prioritization";
  if (/^(project state|state update|decision|constraint|architecture|objective|current summary|fact)\s*[:.-]/i.test(line)) return "project_state";

  if (lower.includes("permission denied") || lower.includes("failed") || lower.includes("unsafe") || lower.includes("blocked")) return "risk";
  if (lower.includes("should implement") || lower.includes("needs to implement") || lower.includes("add a ") || lower.includes("fix ")) return "task";
  if (lower.includes("defer") || lower.includes("future work") || lower.includes("nice-to-have") || lower.includes("later")) return "backlog";
  if (lower.includes("priority") || lower.includes("most important") || lower.includes("secondary") || lower.includes("deferred because")) return "prioritization";
  if (lower.includes("source thread must") || lower.includes("do not mutate") || lower.includes("we decided") || lower.includes("objective")) return "project_state";
  return null;
}

export function classifyHandoffCandidate(line: string): ExtractedItemType | null {
  const lower = line.toLowerCase();
  if (isWorkflowGuidance(lower)) return null;
  if (/^(acceptance criteria|failure gates|risk gates|risks?|blockers?|known issues?)\s*:/i.test(line)) return "risk";
  if (/^(requirements?|please build|please implement|please capture|please add|please iterate|test plan|validation)\s*[:.-]?/i.test(line)) return "task";
  if (/^(priority|prioriti[sz]ation|focus|recommended next|treat this as|do not add|keep one)\s*[:.-]?/i.test(line)) return "prioritization";
  if (/^(project state|contract|constraints?|architecture|source safety|product rule)\s*[:.-]?/i.test(line)) return "project_state";
  if (/^(backlog|later|future|deferred|nice-to-have)\s*[:.-]/i.test(line)) return "backlog";

  if (lower.includes("treat this as") || lower.includes("not a provider-switching task") || lower.includes("do not add more")) return "prioritization";
  if (lower.includes("source thread must") || lower.includes("do not mutate") || lower.includes("output contract") || lower.includes("tts reads only")) return "project_state";
  if (lower.includes("fails if") || lower.includes("failure") || lower.includes("unsupported/static-risk") || lower.includes("fallback cannot hide")) return "risk";
  if (lower.includes("please implement") || lower.includes("please build") || lower.includes("add a ") || lower.includes("capture per-turn") || lower.includes("record requested provider")) return "task";
  if (lower.includes("future work") || lower.includes("nice-to-have") || lower.includes("deferred feature")) return "backlog";
  return classifyLine(line);
}

export function isWorkflowGuidance(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("commit is a local checkpoint") ||
    lower.includes("commit again later") ||
    lower.includes("point of no return") ||
    lower.includes("generate handoff") ||
    lower.includes("missing short handoff") ||
    lower.includes("missing full handoff") ||
    lower.includes("if you want to chat more") ||
    lower.includes("approve all") ||
    lower.includes("handoff readiness") ||
    lower.includes("later commits can add or refine") ||
    lower.includes("extract items such as decisions") ||
    lower.includes("look for the project card") ||
    lower.includes("the first tree is there") ||
    lower.includes("acknowledged. the intended canonical instruction") ||
    lower.includes("not guaranteed. based on the current canonical state") ||
    lower.includes("safe acceptance check") ||
    lower.includes("desired behavior:") ||
    lower.includes("expected result after approval") ||
    lower.includes("old backlog record remains") ||
    lower.includes("previous backlog record") ||
    lower.includes("tasks includes") ||
    lower.includes("backlog no longer shows") ||
    lower.includes("you say:")
  );
}

export function isWorkflowGuidanceItem(item: ExtractedItem): boolean {
  return isWorkflowGuidance(`${item.title}\n${item.body}`);
}

export function isWeakExtractionItem(item: ExtractedItem): boolean {
  const title = item.title.trim();
  const body = item.body.trim();
  return (
    /^#{1,6}\s+/.test(title) ||
    /^#{1,6}\s+/.test(body) ||
    /\*\*|`/.test(title) ||
    /^(yes|no|yep|right)\b/i.test(title) ||
    title.length > 84 ||
    title.endsWith(":") ||
    body.endsWith(":")
  );
}

export function itemTitle(type: ExtractedItemType, line: string): string {
  const clean = line.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
  const withoutLead = clean.replace(/^(project state|state update|decision|constraint|architecture|objective|current summary|fact|priority|prioritization|prioritisation|most important|now|task|todo|next step|fix|implement|add|write|test|run|verify|risk|blocker|uncertainty|warning|failure|issue|problem|backlog|later|future|idea|nice-to-have|defer|deferred)\s*[:.-]\s*/i, "");
  return withoutLead.slice(0, 96);
}

export function handoffCandidateTitle(type: ExtractedItemType, body: string): string {
  const lower = body.toLowerCase();
  if (lower.includes("voice latency eval harness")) return "Implement Mortic voice latency eval harness";
  if (lower.startsWith("requirements:")) return "Add conversation-level provider benchmark requirements";
  if (lower.startsWith("please capture per-turn timestamps")) return "Capture turn-level latency timings";
  if (lower.startsWith("please add provider-side event logging")) return "Log provider WebSocket timing events";
  if (lower.startsWith("acceptance criteria:")) return "Add strict provider and playback failure gates";
  if (lower.startsWith("please iterate based on the measurements")) return "Iterate based on measured latency bottlenecks";
  if (lower.includes("output contract")) return "Preserve the Mortic voice output contract";
  if (lower.includes("source thread") && lower.includes("do not mutate")) return "Preserve source-thread safety";
  if (type === "prioritization" && lower.includes("not a provider-switching task")) return "Prioritize measurement before provider switching";
  return itemTitle(type, body);
}

export function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

export function extractionFingerprint(type: ExtractedItemType, title: string, body: string): string {
  return `${type}:${normalizeBody(`${title} ${body}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180)}`;
}

export function extractionDelta(previous: ExtractedItem | undefined, body: string): ExtractedItem["delta"] {
  if (!previous) return "new";
  return normalizeBody(previous.body) === normalizeBody(body) ? "unchanged" : "changed";
}

export function handoffExtractionCandidates(session: MorticSession): ExtractionCandidate[] {
  const candidates: ExtractionCandidate[] = [];
  const createdAt = session.updatedAt || nowIso();
  for (const source of handoffTextCandidates(session)) {
    const type = classifyHandoffCandidate(source.body);
    if (!type) continue;
    candidates.push({
      type,
      title: handoffCandidateTitle(type, source.body),
      body: source.body,
      entryId: source.sourceId,
      role: "assistant",
      createdAt,
      confidence: source.sourceId === "handoff_full" ? 0.86 : 0.82,
      evidenceSource: handoffEvidenceSource(source.sourceId),
      selectionReason: handoffSelectionReason(source.sourceId)
    });
  }
  return candidates;
}

export function transcriptExtractionCandidates(session: MorticSession): ExtractionCandidate[] {
  const candidates: ExtractionCandidate[] = [];
  for (const entry of session.transcript) {
    for (const line of lineCandidates(entry)) {
      const type = classifyLine(line);
      if (!type) continue;
      candidates.push({
        type,
        body: line,
        entryId: entry.id,
        role: entry.role,
        createdAt: entry.createdAt,
        confidence: type === "project_state" || type === "risk" ? 0.78 : 0.7,
        evidenceSource: "transcript",
        selectionReason: "Picked from the transcript because no handoff-derived item covered this concrete update."
      });
    }
  }
  return candidates;
}

export function extractItems(params: {
  projectId: string;
  sourceThreadId: string;
  scratchSessionId: string;
  session: MorticSession;
  existing: ExtractedItem[];
  approveItemIds?: Set<string>;
}): ExtractedItem[] {
  const createdAt = nowIso();
  const existingById = new Map(params.existing.map((item) => [item.id, item]));
  const existingByFingerprint = new Map(
    params.existing.map((item) => [extractionFingerprint(item.type, item.title, item.body), item])
  );
  const handoffCandidates = handoffExtractionCandidates(params.session);
  const candidatePool = handoffCandidates.length > 0
    ? handoffCandidates
    : transcriptExtractionCandidates(params.session);
  const extracted: ExtractedItem[] = [];
  const seen = new Set<string>();

  for (const candidate of candidatePool) {
    if (extracted.filter((item) => item.type === candidate.type).length >= 3) continue;
    const title = candidate.title ?? itemTitle(candidate.type, candidate.body);
    const fingerprint = extractionFingerprint(candidate.type, title, candidate.body);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const id = `item-${hash(`${params.scratchSessionId}:${candidate.entryId}:${candidate.type}:${title}`, 18)}`;
    const previous = existingById.get(id) ?? existingByFingerprint.get(fingerprint);
    extracted.push({
      id,
      projectId: params.projectId,
      sourceThreadId: params.sourceThreadId,
      scratchSessionId: params.scratchSessionId,
      sourceTurnId: candidate.entryId,
      type: candidate.type,
      title,
      body: candidate.body,
      confidence: candidate.confidence,
      status: params.approveItemIds?.has(id) ? "approved" : previous?.status ?? "draft",
      delta: extractionDelta(previous, candidate.body),
      evidenceSource: candidate.evidenceSource,
      selectionReason: candidate.selectionReason,
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: createdAt,
      transcriptAnchor: {
        entryId: candidate.entryId,
        role: candidate.role,
        createdAt: candidate.createdAt,
        quote: candidate.body.slice(0, 240)
      },
      mergedIntoId: previous?.mergedIntoId
    });
  }

  return extracted.slice(0, 10);
}
