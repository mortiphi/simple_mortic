import type {
  CanonicalCheckpoint,
  CanonicalDelta,
  ConversationArtifact,
  ExtractedItem,
  MorticSession,
  ProviderReference,
  ScratchSessionNode,
  SourceThreadNode
} from "../../shared/types.js";
import { chartDateLabel, extractionTypeShortLabels } from "../lib/labels.js";
import { formatCount } from "../lib/format.js";

export type SideRailProps = {
  projectTitle: string | undefined;
  refreshProject: () => unknown;
  projectPending: boolean;
  openProjectChart: () => unknown;
  chartPending: boolean;
  openCanonicalState: () => unknown;
  canonicalStatePending: boolean;
  scaffoldStats: Array<{ label: string; value: string | number }>;
  activeForkStatus: string;
  activeForkTitle: string;
  activeForkPersistence: string;
  activeForkAccess: string;
  activeProviderReference: ProviderReference | null | undefined;
  activeProjectSession: ScratchSessionNode | null | undefined;
  activeProjectSource: SourceThreadNode | null | undefined;
  session: MorticSession | null | undefined;
  scaffoldTrace: Array<{ label: string; value: string }>;
  scratchSessionsCount: number;
  recentForkSessions: ScratchSessionNode[];
  onSelectFork: (scratch: ScratchSessionNode) => void;
  canonicalChartSummary: string;
  latestChartCheckpoint: CanonicalCheckpoint | null | undefined;
  latestChartDelta: CanonicalDelta | null | undefined;
  latestChartArtifact: ConversationArtifact | null | undefined;
  approvedExtractions: ExtractedItem[];
  commitCurrentSession: () => unknown;
  pending: boolean;
  transcriptLength: number;
};

export function SideRail({
  projectTitle,
  refreshProject,
  projectPending,
  openProjectChart,
  chartPending,
  openCanonicalState,
  canonicalStatePending,
  scaffoldStats,
  activeForkStatus,
  activeForkTitle,
  activeForkPersistence,
  activeForkAccess,
  activeProviderReference,
  activeProjectSession,
  activeProjectSource,
  session,
  scaffoldTrace,
  scratchSessionsCount,
  recentForkSessions,
  onSelectFork,
  canonicalChartSummary,
  latestChartCheckpoint,
  latestChartDelta,
  latestChartArtifact,
  approvedExtractions,
  commitCurrentSession,
  pending,
  transcriptLength
}: SideRailProps) {
  return (
    <aside className="side-rail">
      <section className="rail-tree" aria-label="Project sessions">
        <div className="rail-heading">
          <div>
            <span>Project</span>
            <h2>{projectTitle ?? "Mortic project"}</h2>
          </div>
          <button type="button" onClick={() => void refreshProject()} disabled={projectPending} title="Sync Mortic's local project archive from disk">
            Sync
          </button>
        </div>
        <div className="rail-actions">
          <button type="button" onClick={() => void openProjectChart()} disabled={chartPending}>
            Chart
          </button>
          <button type="button" onClick={() => void openCanonicalState()} disabled={canonicalStatePending}>
            State
          </button>
        </div>
        <div className="fork-chart-scaffold">
          <div className="scaffold-stats" aria-label="Project truth counters">
            {scaffoldStats.map((stat) => (
              <div key={stat.label} className="scaffold-stat">
                <strong>{stat.value}</strong>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>

          <article className="active-fork-card" aria-label="Active provider fork">
            <div className="active-fork-topline">
              <span>Active fork</span>
              <strong>{activeForkStatus}</strong>
            </div>
            <h3>{activeForkTitle}</h3>
            <div className="fork-meta-row">
              <span>{activeForkPersistence}</span>
              <span>{activeForkAccess}</span>
              <span>{activeProviderReference?.provider ?? "codex"}</span>
            </div>
            <code title={activeProjectSession?.codexScratchThreadId ?? activeProjectSource?.sourceUri ?? session?.sourceUri}>
              {activeProjectSession || activeProjectSource ? activeForkTitle : "No source thread"}
            </code>
          </article>

          <div className="scaffold-trace" aria-label="Canonical trace path">
            {scaffoldTrace.map((step) => (
              <div key={step.label} className="trace-step">
                <span>{step.label}</span>
                <strong>{step.value}</strong>
              </div>
            ))}
          </div>

          <details className="scaffold-details">
            <summary>
              <span>Fork tree</span>
              <strong>{scratchSessionsCount} forks</strong>
            </summary>
            <div className="fork-list">
              {recentForkSessions.length === 0 && <p className="empty-inline">No scratch forks yet.</p>}
              {recentForkSessions.map((scratch) => (
                <button
                  key={scratch.id}
                  type="button"
                  className={`fork-list-item ${scratch.id === activeProjectSession?.id ? "selected-session" : ""}`}
                  onClick={() => onSelectFork(scratch)}
                  title="Open fork actions"
                >
                  <div>
                    <strong>{scratch.title}</strong>
                    <span>{scratch.status}</span>
                  </div>
                  <p>{scratch.summary || "Transcript captured. Compile to propose deltas."}</p>
                  <small>
                    {scratch.ephemeral ? "ephemeral" : "local"} · {scratch.mode} · {chartDateLabel(scratch.updatedAt)}
                  </small>
                </button>
              ))}
            </div>
          </details>

          <details className="scaffold-details">
            <summary>
              <span>Canonical chart</span>
              <strong>{canonicalChartSummary}</strong>
            </summary>
            <div className="chart-mini-list">
              <article>
                <span>Checkpoint</span>
                <strong>{latestChartCheckpoint?.title ?? "No checkpoint loaded"}</strong>
              </article>
              <article>
                <span>Delta</span>
                <strong>{latestChartDelta?.title ?? approvedExtractions[0]?.title ?? "No approved delta yet"}</strong>
              </article>
              <article>
                <span>Artifact</span>
                <strong>{latestChartArtifact?.title ?? "Transcript and handoff previews"}</strong>
              </article>
            </div>
          </details>
        </div>
      </section>
      <button className="rail-commit" type="button" onClick={() => void commitCurrentSession()} disabled={projectPending || pending || transcriptLength === 0}>
        {projectPending ? "Compiling" : "Compile active scratch"}
      </button>
    </aside>
  );
}

export type InsightsPanelProps = {
  draftExtractions: ExtractedItem[];
  openProjectChart: () => unknown;
  chartPending: boolean;
  openCanonicalState: () => unknown;
  canonicalStatePending: boolean;
  approveAllDrafts: () => unknown;
  projectPending: boolean;
  pending: boolean;
  pendingExtractionCounts: Array<{ type: ExtractedItem["type"]; total: number }>;
  extractionPreview: string;
  onOpenReview: () => void;
  handoffStateLabel: string;
  generateHandoff: () => unknown;
  handoffPending: boolean;
  transcriptLength: number;
  handoffPreview: string;
  tokenBudget: {
    transcriptTokens: number;
    short: { hasPrompt: boolean; tokens: number; savedTokens: number };
    full: { hasPrompt: boolean; tokens: number; savedTokens: number };
  };
  futureSavingsLine: string | null | undefined;
  copyHandoffText: (text: string) => unknown;
  shortHandoff: string;
  fullHandoff: string;
  handoff: string;
  onOpenHandoffReview: () => void;
};

export function InsightsPanel({
  draftExtractions,
  openProjectChart,
  chartPending,
  openCanonicalState,
  canonicalStatePending,
  approveAllDrafts,
  projectPending,
  pending,
  pendingExtractionCounts,
  extractionPreview,
  onOpenReview,
  handoffStateLabel,
  generateHandoff,
  handoffPending,
  transcriptLength,
  handoffPreview,
  tokenBudget,
  futureSavingsLine,
  copyHandoffText,
  shortHandoff,
  fullHandoff,
  handoff,
  onOpenHandoffReview
}: InsightsPanelProps) {
  return (
    <aside className="insights-panel">
      <section className="project-card extraction-card">
        <div className="project-card-header">
          <div>
            <span>Project updates</span>
            <h2>{draftExtractions.length} to review</h2>
          </div>
          <div className="project-header-actions">
            <button type="button" onClick={() => void openProjectChart()} disabled={chartPending}>Chart</button>
            <button type="button" onClick={() => void openCanonicalState()} disabled={canonicalStatePending}>Open State</button>
            <button type="button" onClick={() => void approveAllDrafts()} disabled={projectPending || pending || draftExtractions.length === 0}>Approve all</button>
          </div>
        </div>
        <div className="extraction-chip-row" aria-label="Project update counts">
          {pendingExtractionCounts.length === 0 ? (
            <span className="extraction-chip extraction-chip-empty">No updates</span>
          ) : (
            pendingExtractionCounts.map((item) => (
              <span key={item.type} className={`extraction-chip extraction-chip-${item.type}`}>
                <strong>{item.total}</strong> {extractionTypeShortLabels[item.type]}
              </span>
            ))
          )}
        </div>
        <p className="compact-card-line">{extractionPreview}</p>
        <button className="card-open-button" type="button" onClick={onOpenReview}>
          Review updates
        </button>
      </section>

      <section className="project-card handoff-card">
        <div className="project-card-header">
          <div>
            <span>Handoff</span>
            <h2>{handoffStateLabel}</h2>
          </div>
          <button type="button" onClick={() => void generateHandoff()} disabled={handoffPending || transcriptLength === 0}>{handoffPending ? "Generating" : "Generate"}</button>
        </div>
        <p className="compact-card-line">{handoffPreview}</p>
        <details className="card-disclosure">
          <summary>Open handoff tools</summary>
          <div className="token-budget">
            <div className="token-budget-header">
              <span>Token budget</span>
              <strong>{formatCount(tokenBudget.transcriptTokens)} transcript</strong>
            </div>
            <div className="token-budget-grid">
              <div>
                <span>Short</span>
                <strong>{tokenBudget.short.hasPrompt ? formatCount(tokenBudget.short.tokens) : "-"}</strong>
                <em>{tokenBudget.short.hasPrompt ? `${formatCount(tokenBudget.short.savedTokens)} fewer` : "Generate to compare"}</em>
              </div>
              <div>
                <span>Full</span>
                <strong>{tokenBudget.full.hasPrompt ? formatCount(tokenBudget.full.tokens) : "-"}</strong>
                <em>{tokenBudget.full.hasPrompt ? `${formatCount(tokenBudget.full.savedTokens)} fewer` : "Generate to compare"}</em>
              </div>
            </div>
            {futureSavingsLine && <p>{futureSavingsLine}</p>}
          </div>
          <div className="handoff-actions">
            <button type="button" onClick={() => void copyHandoffText(shortHandoff)} disabled={!shortHandoff}>Copy Short</button>
            <button type="button" onClick={() => void copyHandoffText(fullHandoff || handoff)} disabled={!fullHandoff && !handoff}>Copy Full</button>
            <button type="button" onClick={onOpenHandoffReview} disabled={!shortHandoff && !fullHandoff && !handoff}>Open</button>
          </div>
        </details>
      </section>
    </aside>
  );
}
