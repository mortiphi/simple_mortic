import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { ExtractedItem } from "../../shared/types.js";

export function MarkdownContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
      {markdown}
    </ReactMarkdown>
  );
}

export type ChartTranscriptSection = {
  label: string;
  markdown: string;
};

export type ChartTranscriptTurn = {
  role: string;
  timestamp?: string;
  mode?: string;
  reasoningEffort?: string;
  failed: boolean;
  sections: ChartTranscriptSection[];
};

export type ChartTranscriptProjection = {
  title: string;
  sourceThread?: string;
  turns: ChartTranscriptTurn[];
};

export function parseChartTranscriptSections(body: string): ChartTranscriptSection[] {
  const sections: ChartTranscriptSection[] = [];
  let currentLabel: string | null = null;
  let currentLines: string[] = [];

  const commitSection = () => {
    if (!currentLabel) return;
    const markdown = currentLines.join("\n").trim();
    if (markdown) sections.push({ label: currentLabel, markdown });
  };

  for (const line of body.split("\n")) {
    const labelMatch = line.match(/^(Text|Spoken|Notes|Sources):\s*(.*)$/);
    if (labelMatch) {
      commitSection();
      currentLabel = labelMatch[1] ?? "Text";
      currentLines = [];
      const inlineValue = labelMatch[2] ?? "";
      if (inlineValue.trim()) currentLines.push(inlineValue);
      continue;
    }

    if (!currentLabel && line.trim()) currentLabel = "Text";
    if (currentLabel) currentLines.push(line);
  }

  commitSection();
  return sections;
}

export function parseChartTranscriptMarkdown(markdown: string): ChartTranscriptProjection {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const title = normalized.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Mortic Transcript";
  const sourceThread = normalized.match(/^Source thread:\s*(.+)$/im)?.[1]?.trim();
  const headings: Array<{ index: number; line: string; heading: string }> = [];
  const headingPattern = /^##\s+((?:user|assistant)\s+·\s+.+)$/gim;
  let headingMatch: RegExpExecArray | null;

  while ((headingMatch = headingPattern.exec(normalized)) !== null) {
    headings.push({
      index: headingMatch.index,
      line: headingMatch[0],
      heading: (headingMatch[1] ?? "").trim()
    });
  }

  const turns = headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const bodyStart = heading.index + heading.line.length;
    const bodyEnd = nextHeading?.index ?? normalized.length;
    const headingParts = heading.heading
      .split("·")
      .map((part) => part.trim())
      .filter(Boolean);
    const failed = headingParts.some((part) => part.toLowerCase() === "failed");

    return {
      role: headingParts[0] ?? "turn",
      timestamp: headingParts[1],
      mode: headingParts[2],
      reasoningEffort: headingParts[3],
      failed,
      sections: parseChartTranscriptSections(normalized.slice(bodyStart, bodyEnd))
    };
  });

  return { title, sourceThread: sourceThread || undefined, turns };
}

export function chartTranscriptRoleLabel(role: string): string {
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "user") return "User";
  if (normalizedRole === "assistant") return "Assistant";
  if (!role.trim()) return "Turn";
  return role.trim().slice(0, 1).toUpperCase() + role.trim().slice(1);
}

export function chartTranscriptRoleClass(role: string): string {
  return role.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-") || "turn";
}

export function chartTranscriptSectionLabel(sectionLabel: string, role: string): string {
  const normalizedSection = sectionLabel.trim().toLowerCase();
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedSection === "text" && normalizedRole === "user") return "User Speech";
  if (normalizedSection === "text" && normalizedRole === "assistant") return "Spoken";
  if (normalizedSection === "spoken") return "Spoken";
  if (normalizedSection === "notes") return "Notes";
  if (normalizedSection === "sources") return "Sources";
  return sectionLabel.trim() || "Text";
}

export function isExpandableChartTranscriptSection(sectionLabel: string): boolean {
  return sectionLabel.trim().toLowerCase() === "notes";
}

export function ChartTranscriptPreview({ markdown }: { markdown: string }) {
  const transcript = useMemo(() => parseChartTranscriptMarkdown(markdown), [markdown]);

  return (
    <div className="chart-transcript">
      <header className="chart-transcript-meta">
        <strong>{transcript.title}</strong>
        {transcript.sourceThread && (
          <span>
            Source thread <code>{transcript.sourceThread}</code>
          </span>
        )}
      </header>
      {transcript.turns.length === 0 ? (
        <div className="markdown-body chart-transcript-fallback">
          <MarkdownContent markdown={markdown} />
        </div>
      ) : (
        <div className="chart-transcript-turns">
          {transcript.turns.map((turn, turnIndex) => (
            <article
              key={`${turn.role}-${turn.timestamp ?? turnIndex}-${turnIndex}`}
              className={`chart-transcript-turn transcript-role-${chartTranscriptRoleClass(turn.role)}`}
            >
              <header className="chart-transcript-turn-header">
                <strong>{chartTranscriptRoleLabel(turn.role)}</strong>
                {turn.timestamp && <span>{turn.timestamp}</span>}
                {turn.mode && <span>{turn.mode}</span>}
                {turn.reasoningEffort && <span>{turn.reasoningEffort}</span>}
                {turn.failed && <span>failed</span>}
              </header>
              <div className="chart-transcript-sections">
                {turn.sections.length === 0 ? (
                  <p className="empty-inline">No transcript content.</p>
                ) : (
                  turn.sections.map((section, sectionIndex) => {
                    const label = chartTranscriptSectionLabel(section.label, turn.role);
                    const expandable = isExpandableChartTranscriptSection(section.label);
                    const sectionKey = `${section.label}-${sectionIndex}`;
                    const body = (
                      <div className="markdown-body chart-transcript-section-body">
                        <MarkdownContent markdown={section.markdown} />
                      </div>
                    );

                    return expandable ? (
                      <details key={sectionKey} className="chart-transcript-section chart-transcript-section-disclosure">
                        <summary>
                          <span className="chart-transcript-section-label">{label}</span>
                        </summary>
                        {body}
                      </details>
                    ) : (
                      <section key={sectionKey} className="chart-transcript-section">
                        <span className="chart-transcript-section-label">{label}</span>
                        {body}
                      </section>
                    );
                  })
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskPlanDetails({ markdown }: { markdown?: string }) {
  const clean = markdown?.trim();
  if (!clean) return null;

  return (
    <details className="task-plan-details">
      <summary>Task Details | Plan</summary>
      <div className="markdown-body task-plan-markdown">
        <MarkdownContent markdown={clean} />
      </div>
    </details>
  );
}

export function normalizeExtractionText(value: string): string {
  return value
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/^#+\s+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeExtractionItems(items: ExtractedItem[]): ExtractedItem[] {
  const byKey = new Map<string, ExtractedItem>();
  for (const item of items) {
    const key = `${item.type}:${normalizeExtractionText(item.title || item.body)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const currentRank = item.status === "approved" ? 2 : item.status === "draft" ? 1 : 0;
    const existingRank = existing.status === "approved" ? 2 : existing.status === "draft" ? 1 : 0;
    if (currentRank > existingRank || item.updatedAt > existing.updatedAt) byKey.set(key, item);
  }
  return [...byKey.values()];
}
