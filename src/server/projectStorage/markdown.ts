import type {
  ExtractedItem,
  ExtractedItemType,
  MorticProject,
  MorticSession,
  ProductionChart,
  ScratchSessionNode,
  SourceThreadNode,
  TranscriptEntry
} from "../../shared/types.js";

import { extractionLabels, hash, nowIso } from "./common.js";
import { currentApprovedItems, inactiveLifecycleStatuses, lifecycleStatusForItem } from "./lifecycle.js";
export function entryToMarkdown(entry: TranscriptEntry): string {
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

export function transcriptMarkdown(session: MorticSession): string {
  const body = session.transcript.map(entryToMarkdown).join("\n");
  return `# Mortic Transcript\n\nSource thread: ${session.sourceUri}\n\n${body}`.trim() + "\n";
}

export function sessionTitle(session: MorticSession, sourceName?: string): string {
  const firstUser = session.transcript.find((entry) => entry.role === "user")?.text.trim();
  if (firstUser) return firstUser.replace(/\s+/g, " ").slice(0, 78);
  if (sourceName?.trim()) return `${sourceName.trim()} scratch`;
  return `Scratch ${session.threadId.slice(0, 8)}`;
}

export function sourceTitle(threadId: string, threadName?: string): string {
  return threadName?.trim() || `Codex ${threadId.slice(0, 8)}`;
}

export function sourceCheckpointTitle(source: SourceThreadNode, index = 1): string {
  return index <= 1 ? "Initial checkpoint" : `Checkpoint ${index}`;
}

export function handoffHashForSession(session: MorticSession): string | null {
  const text = [session.handoffShort, session.handoffFull, session.handoff].filter(Boolean).join("\n\n").trim();
  return text ? hash(text, 18) : null;
}

export function renderExtractedMarkdown(items: ExtractedItem[]): string {
  const rows = items
    .map((item) => {
      const details = [
        `  - ${item.body}`,
        item.taskPlanMarkdown ? `  - Task plan:\n${item.taskPlanMarkdown.split("\n").map((line) => `    ${line}`).join("\n")}` : undefined,
        item.lifecycleStatusAfter ? `  - Lifecycle: ${item.lifecycleAction ?? "create"} -> ${item.lifecycleStatusAfter}` : undefined,
        item.targetCanonicalItemId ? `  - Target: ${item.targetCanonicalItemId}` : undefined,
        item.selectionReason ? `  - Why picked: ${item.selectionReason}` : undefined,
        item.transcriptAnchor?.quote ? `  - Evidence: ${item.transcriptAnchor.quote}` : undefined
      ].filter(Boolean);
      return `- **${extractionLabels[item.type]}** [${item.status}${item.delta ? `, ${item.delta}` : ""}] ${item.title}\n${details.join("\n")}`;
    })
    .join("\n");
  return `# Mortic Extracted Items\n\n${rows || "No extracted items yet."}\n`;
}

export function productionFrom(params: {
  project: MorticProject;
  sources: SourceThreadNode[];
  sessions: ScratchSessionNode[];
  items: ExtractedItem[];
  previous?: ProductionChart;
}): ProductionChart {
  const approved = currentApprovedItems(params.items);
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

export function renderProductionMarkdown(production: ProductionChart): string {
  const renderItems = (items: ExtractedItem[]) => items.map((item) => {
    const lifecycleStatus = lifecycleStatusForItem(item);
    const lifecycleLabel = lifecycleStatus === "open" ? "" : ` _${lifecycleStatus}_`;
    const lines = [
      `- **${item.title}**${lifecycleLabel}`,
      `  - ${item.body}`,
      item.taskPlanMarkdown ? `  - Task plan:\n${item.taskPlanMarkdown.split("\n").map((line) => `    ${line}`).join("\n")}` : undefined,
      item.lifecycleAction ? `  - Lifecycle: ${item.lifecycleAction}${item.lifecycleStatusBefore ? ` (${item.lifecycleStatusBefore} -> ${lifecycleStatus})` : ` -> ${lifecycleStatus}`}` : undefined,
      item.targetCanonicalItemId ? `  - Reconciles: ${item.targetCanonicalItemId}` : undefined,
      `  - Session: ${item.scratchSessionId}`
    ].filter(Boolean);
    return lines.join("\n");
  }).join("\n");
  const section = (title: string, items: ExtractedItem[]) => {
    const active = items.filter((item) => !inactiveLifecycleStatuses.has(lifecycleStatusForItem(item)));
    const historical = items.filter((item) => inactiveLifecycleStatuses.has(lifecycleStatusForItem(item)));
    return [
      `## ${title}`,
      "",
      active.length ? renderItems(active) : "None.",
      historical.length ? `\n### Historical\n\n${renderItems(historical)}` : "",
      ""
    ].join("\n");
  };

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
