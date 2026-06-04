import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import type {
  CommitSessionResponse,
  ExtractedItem,
  ExtractedItemType,
  HandoffReadiness,
  MorticProject,
  MorticSession,
  ProjectCanonicalStateResponse,
  ProductionChart,
  ProjectStateResponse,
  ScratchSessionNode,
  SourceCheckpointNode,
  SourceThreadNode,
  TranscriptEntry,
  UpdateExtractedItemRequest
} from "../shared/types.js";
import { extractedItemTypes } from "../shared/types.js";
import { extractItemsWithCanonicalStateSkill } from "./canonicalStateSkill.js";

export type ProjectStore = {
  projectDir: string;
  syncSession(session: MorticSession, event?: ProjectEvent): Promise<void>;
  recordEvent(session: MorticSession, event: ProjectEvent): Promise<void>;
  snapshot(session?: MorticSession): Promise<ProjectStateResponse>;
  canonicalState(): Promise<ProjectCanonicalStateResponse>;
  commitSession(session: MorticSession, approveItemIds?: string[]): Promise<CommitSessionResponse>;
  archiveSession(session: MorticSession): Promise<ProjectStateResponse>;
  updateExtractedItem(id: string, patch: UpdateExtractedItemRequest): Promise<ProjectStateResponse>;
  confirmSourceCheckpoint(): Promise<ProjectStateResponse>;
  dismissSourceCheckpoint(): Promise<ProjectStateResponse>;
  createManualSourceCheckpoint(session: MorticSession): Promise<ProjectStateResponse>;
  markHandoffCopied(session: MorticSession): Promise<ProjectStateResponse>;
};

export type ProjectEvent = {
  type: string;
  at?: string;
  detail?: unknown;
};

type ProjectStoreParams = {
  workspacePath: string;
  sourceUri: string;
  threadId: string;
  projectTitle?: string;
};

const extractionLabels: Record<ExtractedItemType, string> = {
  project_state: "Project State Update",
  prioritization: "Prioritisation Update",
  task: "Task Update",
  risk: "Risk Update",
  backlog: "Backlog Update"
};
const canonicalExtractionTypes = new Set<string>(extractedItemTypes);

function nowIso(): string {
  return new Date().toISOString();
}

function hash(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "workspace";
}

function projectIdForWorkspace(workspacePath: string): string {
  return `${slug(path.basename(workspacePath))}-${hash(path.resolve(workspacePath), 10)}`;
}

function sourceThreadId(threadId: string): string {
  return `source-${hash(threadId, 16)}`;
}

function scratchSessionId(session: MorticSession): string {
  return `scratch-${hash(`${session.id}:${session.threadId}:${session.createdAt}`, 16)}`;
}

function initialCheckpointId(sourceId: string): string {
  return `checkpoint-${hash(`${sourceId}:initial`, 16)}`;
}

function childCheckpointId(sourceId: string, parentCheckpointId: string, handoffHash: string): string {
  return `checkpoint-${hash(`${sourceId}:${parentCheckpointId}:${handoffHash}`, 16)}`;
}

function manualCheckpointId(sourceId: string): string {
  return `checkpoint-${hash(`${sourceId}:manual:${randomUUID()}`, 16)}`;
}

function projectBaseDir(): string {
  return path.join(homedir(), ".mortic", "projects");
}

function sessionDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, "sessions", sessionId);
}

function sourcePath(projectDir: string, id: string): string {
  return path.join(projectDir, "source_threads", `${id}.json`);
}

function checkpointPath(projectDir: string, id: string): string {
  return path.join(projectDir, "source_checkpoints", `${id}.json`);
}

function projectPaths(projectDir: string) {
  return {
    project: path.join(projectDir, "project.json"),
    production: path.join(projectDir, "production.json"),
    productionMarkdown: path.join(projectDir, "production.md"),
    extractedItems: path.join(projectDir, "extracted_items.json"),
    extractedItemsMarkdown: path.join(projectDir, "extracted_items.md")
  };
}

async function writeAtomic(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  await writeFile(tempPath, text, "utf8");
  await mkdir(dir, { recursive: true });
  await rename(tempPath, filePath);
}

function serializeOperations() {
  let queue: Promise<unknown> = Promise.resolve();

  return async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return await run;
  };
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function entryToMarkdown(entry: TranscriptEntry): string {
  const mode = entry.scratchMode ? ` · ${entry.scratchMode}` : "";
  const effort = entry.reasoningEffort ? ` · ${entry.reasoningEffort}` : "";
  const failed = entry.failed ? " · failed" : "";
  const parts = [`## ${entry.role} · ${entry.createdAt}${mode}${effort}${failed}`];
  if (entry.spokenText) parts.push(`Spoken:\n${entry.spokenText.trim()}`);
  const mainText = entry.spokenText ? entry.notesText || entry.text : entry.text;
  if (mainText?.trim()) parts.push(`${entry.spokenText ? "Notes" : "Text"}:\n${mainText.trim()}`);
  if (entry.sourcesText?.trim()) parts.push(`Sources:\n${entry.sourcesText.trim()}`);
  return `${parts.join("\n\n")}\n`;
}

function transcriptMarkdown(session: MorticSession): string {
  const body = session.transcript.map(entryToMarkdown).join("\n");
  return `# Mortic Transcript\n\nSource thread: ${session.sourceUri}\n\n${body}`.trim() + "\n";
}

function sessionTitle(session: MorticSession): string {
  const firstUser = session.transcript.find((entry) => entry.role === "user")?.text.trim();
  if (firstUser) return firstUser.replace(/\s+/g, " ").slice(0, 78);
  return `Scratch ${session.threadId.slice(0, 8)}`;
}

function sourceTitle(threadId: string): string {
  return `Codex ${threadId.slice(0, 8)}`;
}

function sourceCheckpointTitle(source: SourceThreadNode, index = 1): string {
  return index <= 1 ? "Initial checkpoint" : `Checkpoint ${index}`;
}

function handoffHashForSession(session: MorticSession): string | null {
  const text = [session.handoffShort, session.handoffFull, session.handoff].filter(Boolean).join("\n\n").trim();
  return text ? hash(text, 18) : null;
}

type ExtractionCandidate = {
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

function cleanExtractionLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+|\d+[.)]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lineCandidates(entry: TranscriptEntry): string[] {
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

function handoffEvidenceSource(sourceId: string): NonNullable<ExtractedItem["evidenceSource"]> {
  if (sourceId === "handoff_short") return "handoff_short";
  if (sourceId === "handoff_full") return "handoff_full";
  return "handoff";
}

function handoffSelectionReason(sourceId: string): string {
  if (sourceId === "handoff_short") {
    return "Picked from the short handoff prompt because it states the highest-order continuation action.";
  }
  if (sourceId === "handoff_full") {
    return "Picked from the full handoff prompt because it is the curated, action-oriented summary of this scratch session.";
  }
  return "Picked from the handoff prompt because it is already condensed for the next Codex step.";
}

function isHandoffSectionHeading(line: string): boolean {
  return line.endsWith(":") && line.length <= 130 && !line.endsWith("?:");
}

function summarizeHandoffSection(heading: string, lines: string[]): string | null {
  const cleaned = lines
    .map(cleanExtractionLine)
    .filter((line) => line.length >= 8)
    .filter((line) => !isWorkflowGuidance(line));
  if (cleaned.length === 0) return null;
  const preview = cleaned.slice(0, 6).join("; ");
  const suffix = cleaned.length > 6 ? `; plus ${cleaned.length - 6} more.` : "";
  return `${heading.replace(/:$/, "")}: ${preview}${suffix}`;
}

function handoffTextCandidates(session: MorticSession): Array<{
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

function classifyLine(line: string): ExtractedItemType | null {
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

function classifyHandoffCandidate(line: string): ExtractedItemType | null {
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

function isWorkflowGuidance(value: string): boolean {
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
    lower.includes("the first tree is there")
  );
}

function isWorkflowGuidanceItem(item: ExtractedItem): boolean {
  return isWorkflowGuidance(`${item.title}\n${item.body}`);
}

function isWeakExtractionItem(item: ExtractedItem): boolean {
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

function itemTitle(type: ExtractedItemType, line: string): string {
  const clean = line.replace(/^#{1,6}\s+/, "").replace(/\s+/g, " ").trim();
  const withoutLead = clean.replace(/^(project state|state update|decision|constraint|architecture|objective|current summary|fact|priority|prioritization|prioritisation|most important|now|task|todo|next step|fix|implement|add|write|test|run|verify|risk|blocker|uncertainty|warning|failure|issue|problem|backlog|later|future|idea|nice-to-have|defer|deferred)\s*[:.-]\s*/i, "");
  return withoutLead.slice(0, 96);
}

function handoffCandidateTitle(type: ExtractedItemType, body: string): string {
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

function normalizeBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function extractionFingerprint(type: ExtractedItemType, title: string, body: string): string {
  return `${type}:${normalizeBody(`${title} ${body}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180)}`;
}

function extractionDelta(previous: ExtractedItem | undefined, body: string): ExtractedItem["delta"] {
  if (!previous) return "new";
  return normalizeBody(previous.body) === normalizeBody(body) ? "unchanged" : "changed";
}

function handoffExtractionCandidates(session: MorticSession): ExtractionCandidate[] {
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

function transcriptExtractionCandidates(session: MorticSession): ExtractionCandidate[] {
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

function extractItems(params: {
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

function renderExtractedMarkdown(items: ExtractedItem[]): string {
  const rows = items
    .map((item) => {
      const details = [
        `  - ${item.body}`,
        item.selectionReason ? `  - Why picked: ${item.selectionReason}` : undefined,
        item.transcriptAnchor?.quote ? `  - Evidence: ${item.transcriptAnchor.quote}` : undefined
      ].filter(Boolean);
      return `- **${extractionLabels[item.type]}** [${item.status}${item.delta ? `, ${item.delta}` : ""}] ${item.title}\n${details.join("\n")}`;
    })
    .join("\n");
  return `# Mortic Extracted Items\n\n${rows || "No extracted items yet."}\n`;
}

function productionFrom(params: {
  project: MorticProject;
  sources: SourceThreadNode[];
  sessions: ScratchSessionNode[];
  items: ExtractedItem[];
  previous?: ProductionChart;
}): ProductionChart {
  const approved = params.items.filter((item) => item.status === "approved");
  const byType = (type: ExtractedItemType) => approved.filter((item) => item.type === type);
  return {
    projectId: params.project.id,
    projectTitle: params.project.title,
    workspacePath: params.project.workspacePath,
    currentProjectSummary:
      params.previous?.currentProjectSummary ||
      `Local Mortic production chart for ${params.project.title}. Approved items are promoted here from scratch sessions only.`,
    canonicalSourceThreads: params.sources.map((source) => ({
      id: source.id,
      title: source.title,
      sourceUri: source.sourceUri
    })),
    projectStateUpdates: byType("project_state"),
    prioritizationUpdates: byType("prioritization"),
    taskUpdates: byType("task"),
    riskUpdates: byType("risk"),
    backlogUpdates: byType("backlog"),
    linkedScratchSessions: params.sessions
      .filter((session) => session.status === "committed" || session.status === "archived")
      .map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status
      })),
    linkedSourceThreads: params.sources.map((source) => source.id),
    lastApprovedHandoff: params.previous?.lastApprovedHandoff,
    updatedAt: nowIso()
  };
}

function renderProductionMarkdown(production: ProductionChart): string {
  const section = (title: string, items: ExtractedItem[]) =>
    `## ${title}\n\n${items.map((item) => `- **${item.title}**\n  - ${item.body}\n  - Session: ${item.scratchSessionId}`).join("\n") || "None."}\n`;

  return [
    `# ${production.projectTitle} Production Chart`,
    `Workspace: ${production.workspacePath}`,
    "",
    `Updated: ${production.updatedAt}`,
    "",
    "## Summary",
    "",
    production.currentProjectSummary,
    "",
    section("Project State Updates", production.projectStateUpdates),
    section("Prioritisation Updates", production.prioritizationUpdates),
    section("Task Updates", production.taskUpdates),
    section("Risk Updates", production.riskUpdates),
    section("Backlog Updates", production.backlogUpdates),
    "## Source Threads",
    "",
    production.canonicalSourceThreads.map((source) => `- ${source.title}: ${source.sourceUri}`).join("\n") || "None.",
    "",
    "## Scratch Sessions",
    "",
    production.linkedScratchSessions.map((session) => `- ${session.title} (${session.status})`).join("\n") || "None.",
    ""
  ].join("\n");
}

function computeReadiness(session: MorticSession, scratch: ScratchSessionNode, items: ExtractedItem[]): HandoffReadiness {
  const missing: string[] = [];
  const risksOrQuestions = items.some((item) => item.type === "risk") || items.some((item) => item.type === "project_state");
  const signals = {
    hasUserGoal: session.transcript.some((entry) => entry.role === "user" && entry.text.trim().length > 12),
    hasSourceThreadId: Boolean(session.threadId),
    hasSessionTitle: Boolean(scratch.title.trim()),
    hasSessionDescription: Boolean(scratch.description?.trim() || scratch.summary?.trim()),
    hasUsefulSummary: Boolean(scratch.summary?.trim()),
    hasExtraction: items.some((item) => item.status !== "dismissed"),
    hasShortHandoff: Boolean(session.handoffShort?.trim()),
    hasFullHandoff: Boolean(session.handoffFull?.trim() || session.handoff?.trim()),
    hasRiskOrQuestionState: risksOrQuestions,
    transcriptNotEmpty: session.transcript.length > 0,
    noActiveTurnRunning: session.activeTurn?.status !== "running",
    noForkSafetyWarning: !session.forkCheckpoint || session.forkCheckpoint.scratchThreadId !== session.forkCheckpoint.sourceThreadId
  };
  const labels: Record<keyof typeof signals, string> = {
    hasUserGoal: "user goal",
    hasSourceThreadId: "source thread",
    hasSessionTitle: "session title",
    hasSessionDescription: "session description",
    hasUsefulSummary: "session summary",
    hasExtraction: "draft or approved extraction",
    hasShortHandoff: "short handoff",
    hasFullHandoff: "full handoff",
    hasRiskOrQuestionState: "risks/project state reviewed",
    transcriptNotEmpty: "transcript",
    noActiveTurnRunning: "no active turn",
    noForkSafetyWarning: "scratch fork safety"
  };
  for (const [key, value] of Object.entries(signals) as Array<[keyof typeof signals, boolean]>) {
    if (!value) missing.push(labels[key]);
  }
  const passed = Object.values(signals).filter(Boolean).length;
  const percentage = Math.round((passed / Object.keys(signals).length) * 100);
  const status = !signals.noForkSafetyWarning || !signals.hasSourceThreadId
    ? "unsafe"
    : percentage >= 82 && signals.noActiveTurnRunning
      ? "ready-to-commit"
      : "needs-review";
  return { percentage, status, missing, signals };
}

export async function createProjectStore(params: ProjectStoreParams): Promise<ProjectStore> {
  const workspacePath = path.resolve(params.workspacePath);
  const projectId = projectIdForWorkspace(workspacePath);
  const projectDir = path.join(projectBaseDir(), projectId);
  const paths = projectPaths(projectDir);
  const now = nowIso();
  const enqueue = serializeOperations();

  await mkdir(path.join(projectDir, "source_threads"), { recursive: true });
  await mkdir(path.join(projectDir, "source_checkpoints"), { recursive: true });
  await mkdir(path.join(projectDir, "sessions"), { recursive: true });

  async function readProject(): Promise<MorticProject> {
    const fallback: MorticProject = {
      id: projectId,
      title: params.projectTitle ?? (path.basename(workspacePath) || "Mortic Project"),
      workspacePath,
      createdAt: now,
      updatedAt: now,
      canonicalSourceThreadIds: []
    };
    return readJson(paths.project, fallback);
  }

  async function writeProject(project: MorticProject): Promise<void> {
    await writeAtomic(paths.project, `${JSON.stringify({ ...project, updatedAt: nowIso() }, null, 2)}\n`);
  }

  async function readSources(): Promise<SourceThreadNode[]> {
    let entries;
    try {
      entries = await readdir(path.join(projectDir, "source_threads"), { withFileTypes: true });
    } catch {
      return [];
    }
    const sources: SourceThreadNode[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const source = await readJson(path.join(projectDir, "source_threads", entry.name), undefined as unknown as SourceThreadNode);
      if (source) {
        sources.push({
          ...source,
          tags: source.tags ?? [],
          childrenCheckpointIds: source.childrenCheckpointIds ?? [],
          childrenScratchSessionIds: source.childrenScratchSessionIds ?? []
        });
      }
    }
    return sources.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function readCheckpoints(): Promise<SourceCheckpointNode[]> {
    let entries;
    try {
      entries = await readdir(path.join(projectDir, "source_checkpoints"), { withFileTypes: true });
    } catch {
      return [];
    }
    const checkpoints: SourceCheckpointNode[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const checkpoint = await readJson(path.join(projectDir, "source_checkpoints", entry.name), undefined as unknown as SourceCheckpointNode);
      if (checkpoint) {
        checkpoints.push({
          ...checkpoint,
          childrenScratchSessionIds: checkpoint.childrenScratchSessionIds ?? []
        });
      }
    }
    return checkpoints.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function readSessions(): Promise<ScratchSessionNode[]> {
    let entries;
    try {
      entries = await readdir(path.join(projectDir, "sessions"), { withFileTypes: true });
    } catch {
      return [];
    }
    const sessions: ScratchSessionNode[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(projectDir, "sessions", entry.name, "session.json");
      if (!existsSync(filePath)) continue;
      const session = await readJson(filePath, undefined as unknown as ScratchSessionNode);
      if (session) sessions.push({ ...session, tags: session.tags ?? [] });
    }
    return sessions.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function readItems(): Promise<ExtractedItem[]> {
    const items = await readJson(paths.extractedItems, [] as ExtractedItem[]);
    return items.filter((item) => canonicalExtractionTypes.has(item.type) && item.delta && !isWorkflowGuidanceItem(item) && !isWeakExtractionItem(item));
  }

  async function writeItems(items: ExtractedItem[]): Promise<void> {
    const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await writeAtomic(paths.extractedItems, `${JSON.stringify(sorted, null, 2)}\n`);
    await writeAtomic(paths.extractedItemsMarkdown, renderExtractedMarkdown(sorted));
  }

  async function writeProduction(production: ProductionChart): Promise<void> {
    await writeAtomic(paths.production, `${JSON.stringify(production, null, 2)}\n`);
    await writeAtomic(paths.productionMarkdown, renderProductionMarkdown(production));
  }

  async function writeSourceNode(source: SourceThreadNode): Promise<void> {
    await writeAtomic(sourcePath(projectDir, source.id), `${JSON.stringify(source, null, 2)}\n`);
  }

  async function readCheckpoint(id: string): Promise<SourceCheckpointNode | null> {
    return readJson<SourceCheckpointNode | null>(checkpointPath(projectDir, id), null);
  }

  async function writeCheckpointNode(checkpoint: SourceCheckpointNode): Promise<void> {
    await writeAtomic(checkpointPath(projectDir, checkpoint.id), `${JSON.stringify(checkpoint, null, 2)}\n`);
  }

  async function ensureInitialCheckpoint(source: SourceThreadNode): Promise<SourceCheckpointNode> {
    const id = initialCheckpointId(source.id);
    const existing = await readCheckpoint(id);
    const current = nowIso();
    const checkpoint: SourceCheckpointNode = {
      id,
      projectId,
      sourceThreadId: source.id,
      codexThreadId: source.codexThreadId,
      sourceUri: source.sourceUri,
      title: existing?.title ?? sourceCheckpointTitle(source),
      createdAt: existing?.createdAt ?? source.firstSeenAt ?? current,
      observedAt: existing?.observedAt ?? source.firstSeenAt ?? current,
      lastSeenAt: current,
      detectionSource: existing?.detectionSource ?? "initial",
      contextFingerprint: existing?.contextFingerprint,
      childrenScratchSessionIds: existing?.childrenScratchSessionIds ?? []
    };
    await writeCheckpointNode(checkpoint);
    await writeSourceNode({
      ...source,
      childrenCheckpointIds: Array.from(new Set([...(source.childrenCheckpointIds ?? []), id])),
      childrenScratchSessionIds: source.childrenScratchSessionIds ?? []
    });
    return checkpoint;
  }

  async function checkpointForScratch(source: SourceThreadNode, existing?: ScratchSessionNode | null): Promise<SourceCheckpointNode> {
    if (existing?.sourceCheckpointId) {
      const checkpoint = await readCheckpoint(existing.sourceCheckpointId);
      if (checkpoint && checkpoint.sourceThreadId === source.id) return checkpoint;
    }

    const project = await readProject();
    if (project.activeSourceCheckpointId) {
      const checkpoint = await readCheckpoint(project.activeSourceCheckpointId);
      if (checkpoint && checkpoint.sourceThreadId === source.id) return checkpoint;
    }

    const checkpoints = (await readCheckpoints()).filter((checkpoint) => checkpoint.sourceThreadId === source.id);
    const latest = checkpoints.at(-1);
    return latest ?? ensureInitialCheckpoint(source);
  }

  async function attachScratchToCheckpoint(source: SourceThreadNode, checkpoint: SourceCheckpointNode, scratchId: string): Promise<void> {
    const current = nowIso();
    await writeCheckpointNode({
      ...checkpoint,
      lastSeenAt: current,
      childrenScratchSessionIds: Array.from(new Set([...(checkpoint.childrenScratchSessionIds ?? []), scratchId]))
    });
    const latestSource = await readJson<SourceThreadNode | null>(sourcePath(projectDir, source.id), null);
    await writeSourceNode({
      ...(latestSource ?? source),
      childrenCheckpointIds: Array.from(new Set([...(latestSource?.childrenCheckpointIds ?? source.childrenCheckpointIds ?? []), checkpoint.id])),
      childrenScratchSessionIds: Array.from(new Set([...(latestSource?.childrenScratchSessionIds ?? source.childrenScratchSessionIds ?? []), scratchId]))
    });
  }

  async function ensureCheckpointCoverage(): Promise<void> {
    const sources = await readSources();
    const sessions = await readSessions();
    for (const source of sources) {
      const initial = await ensureInitialCheckpoint(source);
      const checkpointIds = new Set((await readCheckpoints()).map((checkpoint) => checkpoint.id));
      for (const session of sessions.filter((candidate) => candidate.sourceThreadId === source.id)) {
        const assignedCheckpointId = session.sourceCheckpointId && checkpointIds.has(session.sourceCheckpointId)
          ? session.sourceCheckpointId
          : initial.id;
        const checkpoint = await readCheckpoint(assignedCheckpointId) ?? initial;
        if (session.sourceCheckpointId !== assignedCheckpointId) {
          await writeAtomic(
            path.join(sessionDir(projectDir, session.id), "session.json"),
            `${JSON.stringify({ ...session, sourceCheckpointId: assignedCheckpointId }, null, 2)}\n`
          );
        }
        await attachScratchToCheckpoint(source, checkpoint, session.id);
      }
    }
  }

  async function setPendingContinuationFromHandoff(session: MorticSession, scratch: ScratchSessionNode): Promise<void> {
    const handoffHash = handoffHashForSession(session);
    if (!handoffHash || !scratch.sourceCheckpointId) return;
    const project = await readProject();
    if (
      project.pendingSourceCheckpoint?.sourceCheckpointId === scratch.sourceCheckpointId &&
      project.pendingSourceCheckpoint.derivedFromHandoffHash === handoffHash
    ) {
      return;
    }
    const existingChild = (await readCheckpoints()).find((checkpoint) =>
      checkpoint.parentCheckpointId === scratch.sourceCheckpointId &&
      checkpoint.derivedFromHandoffHash === handoffHash
    );
    if (existingChild) {
      await writeProject({
        ...project,
        activeSourceThreadId: scratch.sourceThreadId,
        activeSourceCheckpointId: existingChild.id,
        pendingSourceCheckpoint: undefined
      });
      return;
    }
    const current = nowIso();
    await writeProject({
      ...project,
      pendingSourceCheckpoint: {
        sourceThreadId: scratch.sourceThreadId,
        sourceCheckpointId: scratch.sourceCheckpointId,
        derivedFromScratchSessionId: scratch.id,
        derivedFromHandoffHash: handoffHash,
        title: `After handoff from ${scratch.title}`,
        createdAt: current,
        updatedAt: current,
        reason: "A handoff was generated from this checkpoint. If you paste it back into the same Codex thread and continue there, create a child checkpoint before the next Mortic scratch."
      }
    });
  }

  async function upsertSource(session: MorticSession): Promise<SourceThreadNode> {
    const id = sourceThreadId(session.threadId);
    const existing = await readJson<SourceThreadNode | null>(sourcePath(projectDir, id), null);
    const current = nowIso();
    const next: SourceThreadNode = {
      id,
      projectId,
      codexThreadId: session.threadId,
      title: existing?.title ?? sourceTitle(session.threadId),
      description: existing?.description,
      workspacePath,
      sourceUri: session.sourceUri,
      createdAt: existing?.createdAt ?? current,
      firstSeenAt: existing?.firstSeenAt ?? current,
      lastSeenAt: current,
      knownTextPreview: existing?.knownTextPreview,
      knownSummary: existing?.knownSummary,
      tags: existing?.tags ?? [],
      childrenCheckpointIds: existing?.childrenCheckpointIds ?? [],
      childrenScratchSessionIds: Array.from(new Set([...(existing?.childrenScratchSessionIds ?? []), scratchSessionId(session)]))
    };
    await writeSourceNode(next);

    const project = await readProject();
    await writeProject({
      ...project,
      activeSourceThreadId: id,
      canonicalSourceThreadIds: Array.from(new Set([...project.canonicalSourceThreadIds, id]))
    });
    return next;
  }

  async function upsertScratch(session: MorticSession): Promise<ScratchSessionNode> {
    const source = await upsertSource(session);
    const id = scratchSessionId(session);
    const dir = sessionDir(projectDir, id);
    const filePath = path.join(dir, "session.json");
    const existing = await readJson<ScratchSessionNode | null>(filePath, null);
    const checkpoint = await checkpointForScratch(source, existing);
    const current = nowIso();
    const codexScratchThreadId = session.forkCheckpoint?.scratchThreadId ?? existing?.codexScratchThreadId;
    const next: ScratchSessionNode = {
      id,
      projectId,
      sourceThreadId: source.id,
      sourceCheckpointId: existing?.sourceCheckpointId ?? checkpoint.id,
      parentScratchSessionId: existing?.parentScratchSessionId,
      codexScratchThreadId,
      forkedFromId: session.forkCheckpoint?.sourceThreadId ?? existing?.forkedFromId,
      ephemeral: Boolean(codexScratchThreadId) || existing?.ephemeral === true,
      title: existing?.title ?? sessionTitle(session),
      description: existing?.description,
      summary: existing?.summary,
      mode: existing?.mode ?? "scratch",
      status: existing?.status === "committed" || existing?.status === "archived" || existing?.status === "discarded" ? existing.status : "active",
      workspacePath,
      model: session.activeTurn?.codexModel ?? existing?.model,
      provider: existing?.provider,
      transport: session.activeTurn?.metrics.transportProvider ?? existing?.transport,
      sttProvider: session.activeTurn?.metrics.sttProvider ?? existing?.sttProvider,
      ttsProvider: session.activeTurn?.metrics.ttsProvider ?? existing?.ttsProvider,
      createdAt: existing?.createdAt ?? session.createdAt,
      updatedAt: current,
      archivedAt: existing?.archivedAt,
      committedAt: existing?.committedAt,
      transcriptPath: path.join(dir, "transcript.md"),
      eventLogPath: path.join(dir, "events.jsonl"),
      handoffPath: path.join(dir, "handoff.md"),
      handoffShortPath: path.join(dir, "handoff.short.md"),
      handoffFullPath: path.join(dir, "handoff.full.md"),
      extractedItemsPath: path.join(dir, "extracted_items.json"),
      tags: existing?.tags ?? []
    };
    await mkdir(dir, { recursive: true });
    await writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
    await writeAtomic(next.transcriptPath, transcriptMarkdown(session));
    await writeAtomic(next.handoffPath, session.handoff ?? "");
    await writeAtomic(next.handoffShortPath, session.handoffShort ?? "");
    await writeAtomic(next.handoffFullPath, session.handoffFull ?? "");
    await attachScratchToCheckpoint(source, checkpoint, id);

    const project = await readProject();
    await writeProject({
      ...project,
      activeSourceThreadId: source.id,
      activeSourceCheckpointId: checkpoint.id,
      activeScratchSessionId: id
    });
    return next;
  }

  async function recordEvent(session: MorticSession, event: ProjectEvent): Promise<void> {
    const scratch = await upsertScratch(session);
    const line = JSON.stringify({
      at: event.at ?? nowIso(),
      type: event.type,
      detail: event.detail
    });
    await mkdir(path.dirname(scratch.eventLogPath), { recursive: true });
    await appendFile(scratch.eventLogPath, `${line}\n`, "utf8");
    if (event.type === "handoff.generated" || event.type === "handoff.copied") {
      await setPendingContinuationFromHandoff(session, scratch);
    }
  }

  async function syncSession(session: MorticSession, event?: ProjectEvent): Promise<void> {
    await upsertScratch(session);
    if (event) await recordEvent(session, event);
  }

  async function rebuildProduction(currentSession?: MorticSession): Promise<{ production: ProductionChart; scratch?: ScratchSessionNode }> {
    await ensureCheckpointCoverage();
    const project = await readProject();
    const sources = await readSources();
    const sessions = await readSessions();
    const previous = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const items = await readItems();
    const production = productionFrom({ project, sources, sessions, items, previous });
    await writeProduction(production);
    const scratch = currentSession ? await upsertScratch(currentSession) : undefined;
    return { production, scratch };
  }

  async function snapshot(session?: MorticSession): Promise<ProjectStateResponse> {
    if (session) await upsertScratch(session);
    await ensureCheckpointCoverage();
    const project = await readProject();
    const sources = await readSources();
    const checkpoints = await readCheckpoints();
    const sessions = await readSessions();
    const items = await readItems();
    const previous = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const production = productionFrom({ project, sources, sessions, items, previous });
    await writeProduction(production);
    const activeScratch =
      session ? await upsertScratch(session) : sessions.find((candidate) => candidate.id === project.activeScratchSessionId) ?? sessions[0];
    const readiness = activeScratch && session
      ? computeReadiness(session, activeScratch, items.filter((item) => item.scratchSessionId === activeScratch.id))
      : {
          percentage: 0,
          status: "needs-review" as const,
          missing: ["active scratch session"],
          signals: {
            hasUserGoal: false,
            hasSourceThreadId: false,
            hasSessionTitle: false,
            hasSessionDescription: false,
            hasUsefulSummary: false,
            hasExtraction: false,
            hasShortHandoff: false,
            hasFullHandoff: false,
            hasRiskOrQuestionState: false,
            transcriptNotEmpty: false,
            noActiveTurnRunning: true,
            noForkSafetyWarning: true
          }
        };
    return {
      project: await readProject(),
      sourceThreads: await readSources(),
      sourceCheckpoints: checkpoints,
      scratchSessions: await readSessions(),
      extractedItems: await readItems(),
      production,
      readiness
    };
  }

  async function canonicalState(): Promise<ProjectCanonicalStateResponse> {
    await ensureCheckpointCoverage();
    const project = await readProject();
    const sources = await readSources();
    const checkpoints = await readCheckpoints();
    const sessions = await readSessions();
    const items = await readItems();
    const previous = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const production = productionFrom({ project, sources, sessions, items, previous });
    await writeProduction(production);
    await writeItems(items);
    return {
      projectDir,
      productionPath: paths.production,
      productionMarkdownPath: paths.productionMarkdown,
      extractedItemsPath: paths.extractedItems,
      extractedItemsMarkdownPath: paths.extractedItemsMarkdown,
      project: await readProject(),
      sourceThreads: await readSources(),
      sourceCheckpoints: checkpoints,
      scratchSessions: await readSessions(),
      extractedItems: await readItems(),
      production,
      productionMarkdown: await readFile(paths.productionMarkdown, "utf8"),
      extractedItemsMarkdown: await readFile(paths.extractedItemsMarkdown, "utf8")
    };
  }

  async function commitSession(session: MorticSession, approveItemIds?: string[]): Promise<CommitSessionResponse> {
    const source = await upsertSource(session);
    const scratch = await upsertScratch(session);
    const approveSet = new Set(approveItemIds ?? []);
    const existingItems = await readItems();
    const project = await readProject();
    const sources = await readSources();
    const sessions = await readSessions();
    const previousProduction = await readJson<ProductionChart | undefined>(paths.production, undefined);
    const production = productionFrom({ project, sources, sessions, items: existingItems, previous: previousProduction });
    const extraction = await extractItemsWithCanonicalStateSkill({
      projectId,
      sourceThreadId: source.id,
      scratchSessionId: scratch.id,
      session,
      production,
      existing: existingItems,
      approveItemIds: approveSet,
      hash,
      nowIso
    });
    const generated = extraction.items;
    const otherItems = existingItems.filter((item) => item.scratchSessionId !== scratch.id);
    const items = [...otherItems, ...generated];
    await writeItems(items);
    await writeAtomic(scratch.extractedItemsPath, `${JSON.stringify(generated, null, 2)}\n`);

    const committedAt = nowIso();
    const committedSession: ScratchSessionNode = {
      ...scratch,
      status: "committed",
      summary: extraction.summary,
      committedAt,
      updatedAt: committedAt
    };
    await writeAtomic(path.join(sessionDir(projectDir, scratch.id), "session.json"), `${JSON.stringify(committedSession, null, 2)}\n`);
    await recordEvent(session, {
      type: "session.committed",
      detail: {
        scratchSessionId: scratch.id,
        createdItems: generated.length,
        approvedItems: generated.filter((item) => item.status === "approved").length
      }
    });
    await rebuildProduction(session);
    return {
      ...(await snapshot(session)),
      committedSession,
      createdItems: generated
    };
  }

  async function archiveSession(session: MorticSession): Promise<ProjectStateResponse> {
    const scratch = await upsertScratch(session);
    const archivedAt = nowIso();
    await writeAtomic(
      path.join(sessionDir(projectDir, scratch.id), "session.json"),
      `${JSON.stringify({ ...scratch, status: "archived", archivedAt, updatedAt: archivedAt }, null, 2)}\n`
    );
    await recordEvent(session, { type: "session.archived", detail: { scratchSessionId: scratch.id } });
    await rebuildProduction(session);
    return snapshot(session);
  }

  async function updateExtractedItem(id: string, patch: UpdateExtractedItemRequest): Promise<ProjectStateResponse> {
    const items = await readItems();
    const nextItems = items.map((item) => {
      if (item.id !== id) return item;
      return {
        ...item,
        title: patch.title?.trim() || item.title,
        body: patch.body?.trim() || item.body,
        status: patch.status ?? item.status,
        mergedIntoId: patch.mergeIntoId ?? item.mergedIntoId,
        updatedAt: nowIso()
      };
    });
    await writeItems(nextItems);
    await rebuildProduction();
    return snapshot();
  }

  async function confirmSourceCheckpoint(): Promise<ProjectStateResponse> {
    const project = await readProject();
    const pending = project.pendingSourceCheckpoint;
    if (!pending) return snapshot();
    const source = (await readSources()).find((candidate) => candidate.id === pending.sourceThreadId);
    const parent = await readCheckpoint(pending.sourceCheckpointId);
    if (!source || !parent) {
      await writeProject({ ...project, pendingSourceCheckpoint: undefined });
      return snapshot();
    }
    const id = childCheckpointId(source.id, parent.id, pending.derivedFromHandoffHash);
    const existing = await readCheckpoint(id);
    const current = nowIso();
    const checkpoint: SourceCheckpointNode = existing ?? {
      id,
      projectId,
      sourceThreadId: source.id,
      codexThreadId: source.codexThreadId,
      sourceUri: source.sourceUri,
      parentCheckpointId: parent.id,
      derivedFromScratchSessionId: pending.derivedFromScratchSessionId,
      derivedFromHandoffHash: pending.derivedFromHandoffHash,
      title: pending.title,
      createdAt: current,
      observedAt: current,
      lastSeenAt: current,
      detectionSource: "handoff-marker",
      childrenScratchSessionIds: []
    };
    await writeCheckpointNode({ ...checkpoint, lastSeenAt: current });
    await writeSourceNode({
      ...source,
      childrenCheckpointIds: Array.from(new Set([...(source.childrenCheckpointIds ?? []), id]))
    });
    await writeProject({
      ...project,
      activeSourceThreadId: source.id,
      activeSourceCheckpointId: id,
      pendingSourceCheckpoint: undefined
    });
    return snapshot();
  }

  async function dismissSourceCheckpoint(): Promise<ProjectStateResponse> {
    const project = await readProject();
    if (!project.pendingSourceCheckpoint) return snapshot();
    await writeProject({
      ...project,
      pendingSourceCheckpoint: undefined
    });
    return snapshot();
  }

  async function createManualSourceCheckpoint(session: MorticSession): Promise<ProjectStateResponse> {
    const source = await upsertSource(session);
    const parent = await checkpointForScratch(source, null);
    const checkpoints = (await readCheckpoints()).filter((checkpoint) => checkpoint.sourceThreadId === source.id);
    const id = manualCheckpointId(source.id);
    const current = nowIso();
    const checkpoint: SourceCheckpointNode = {
      id,
      projectId,
      sourceThreadId: source.id,
      codexThreadId: source.codexThreadId,
      sourceUri: source.sourceUri,
      parentCheckpointId: parent.id,
      title: sourceCheckpointTitle(source, checkpoints.length + 1),
      createdAt: current,
      observedAt: current,
      lastSeenAt: current,
      detectionSource: "manual",
      childrenScratchSessionIds: []
    };
    await writeCheckpointNode(checkpoint);
    await writeSourceNode({
      ...source,
      childrenCheckpointIds: Array.from(new Set([...(source.childrenCheckpointIds ?? []), id]))
    });
    const project = await readProject();
    await writeProject({
      ...project,
      activeSourceThreadId: source.id,
      activeSourceCheckpointId: id,
      pendingSourceCheckpoint: undefined
    });
    return snapshot();
  }

  async function markHandoffCopied(session: MorticSession): Promise<ProjectStateResponse> {
    const scratch = await upsertScratch(session);
    await recordEvent(session, { type: "handoff.copied", detail: { scratchSessionId: scratch.id } });
    return snapshot(session);
  }

  const initialProject = await readProject();
  await writeProject(initialProject);

  return {
    projectDir,
    syncSession: (session, event) => enqueue(() => syncSession(session, event)),
    recordEvent: (session, event) => enqueue(() => recordEvent(session, event)),
    snapshot: (session) => enqueue(() => snapshot(session)),
    canonicalState: () => enqueue(() => canonicalState()),
    commitSession: (session, approveItemIds) => enqueue(() => commitSession(session, approveItemIds)),
    archiveSession: (session) => enqueue(() => archiveSession(session)),
    updateExtractedItem: (id, patch) => enqueue(() => updateExtractedItem(id, patch)),
    confirmSourceCheckpoint: () => enqueue(() => confirmSourceCheckpoint()),
    dismissSourceCheckpoint: () => enqueue(() => dismissSourceCheckpoint()),
    createManualSourceCheckpoint: (session) => enqueue(() => createManualSourceCheckpoint(session)),
    markHandoffCopied: (session) => enqueue(() => markHandoffCopied(session))
  };
}
