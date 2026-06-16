import type {
  CanonicalCheckpoint,
  CanonicalDelta,
  ConversationArtifact,
  ExtractedItem,
  ProjectArtifactPreviewResponse,
  ProjectChartResponse,
  ProviderAdapterStatus,
  ProviderReference
} from "../../shared/types.js";
import {
  artifactTitle,
  chartDateLabel,
  deltaLifecycleLabel,
  extractionTypeLabels,
  extractionTypeOrder,
  extractionTypeShortLabels,
  providerActionText,
  providerRefTitle
} from "../lib/labels.js";
import { ChartTranscriptPreview, MarkdownContent, TaskPlanDetails } from "./Markdown.js";

export type ChartModalProps = {
  chartState: ProjectChartResponse;
  chartPending: boolean;
  chartSearch: string;
  setChartSearch: (value: string) => void;
  chartTypeFilter: ExtractedItem["type"] | "all";
  setChartTypeFilter: (value: ExtractedItem["type"] | "all") => void;
  chartCodexStatus: ProviderAdapterStatus | null | undefined;
  chartCheckpoints: CanonicalCheckpoint[];
  chartTimelineCheckpoints: CanonicalCheckpoint[];
  chartDeltas: CanonicalDelta[];
  visibleChartDeltas: CanonicalDelta[];
  chartDeltaCounts: Array<{ type: ExtractedItem["type"]; total: number }>;
  chartArtifacts: ConversationArtifact[];
  selectedChartCheckpoint: CanonicalCheckpoint | null | undefined;
  selectedChartDelta: CanonicalDelta | null | undefined;
  selectedChartArtifact: ConversationArtifact | null | undefined;
  selectedProviderRefs: ProviderReference[];
  artifactPreview: ProjectArtifactPreviewResponse | null | undefined;
  artifactPending: boolean;
  setSelectedChartCheckpointId: (id: string) => void;
  setSelectedChartDeltaId: (id: string) => void;
  refreshProjectChart: (options?: { preserveSelection?: boolean }) => unknown;
  copyText: (text: string) => unknown;
  onClose: () => void;
};

export function ChartModal({
  chartState,
  chartPending,
  chartSearch,
  setChartSearch,
  chartTypeFilter,
  setChartTypeFilter,
  chartCodexStatus,
  chartCheckpoints,
  chartTimelineCheckpoints,
  chartDeltas,
  visibleChartDeltas,
  chartDeltaCounts,
  chartArtifacts,
  selectedChartCheckpoint,
  selectedChartDelta,
  selectedChartArtifact,
  selectedProviderRefs,
  artifactPreview,
  artifactPending,
  setSelectedChartCheckpointId,
  setSelectedChartDeltaId,
  refreshProjectChart,
  copyText,
  onClose
}: ChartModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="chart-modal" role="dialog" aria-modal="true" aria-label="Canonical delta chart" onClick={(event) => event.stopPropagation()}>
        <div className="chart-modal-header">
          <div>
            <span>Canonical Chart</span>
            <h2>{chartState.project.title}</h2>
            <p>{chartState.chartPath}</p>
          </div>
          <div className="project-header-actions">
            <button type="button" onClick={() => void refreshProjectChart({ preserveSelection: true })} disabled={chartPending}>Refresh</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="chart-toolbar">
          <label>
            <span>Search</span>
            <input value={chartSearch} onChange={(event) => setChartSearch(event.target.value)} placeholder="Delta or artifact" />
          </label>
          <label>
            <span>Type</span>
            <select value={chartTypeFilter} onChange={(event) => setChartTypeFilter(event.target.value as ExtractedItem["type"] | "all")}>
              <option value="all">All</option>
              {extractionTypeOrder.map((type) => (
                <option key={type} value={type}>{extractionTypeShortLabels[type]}</option>
              ))}
            </select>
          </label>
          <div className="chart-adapter-status">
            <span>Codex</span>
            <strong>{chartCodexStatus?.loginStatus ?? "unknown"}</strong>
            {chartCodexStatus?.loginCommand && <code>{chartCodexStatus.loginCommand}</code>}
          </div>
        </div>
        <div className="chart-body">
          <aside className="chart-checkpoints">
            <div className="chart-pane-heading">
              <span>Timeline</span>
              <strong>{chartCheckpoints.length}</strong>
            </div>
            {chartCheckpoints.length === 0 && <p className="empty-inline">No approved checkpoints yet.</p>}
            <div className="chart-timeline">
              {chartTimelineCheckpoints.map((checkpoint) => {
                const checkpointDeltas = chartDeltas.filter((delta) => checkpoint.approvedDeltaIds.includes(delta.id));
                return (
                  <article key={checkpoint.id} className={checkpoint.id === selectedChartCheckpoint?.id ? "selected-chart-timeline" : ""}>
                    <button
                      type="button"
                      className="chart-timeline-checkpoint"
                      onClick={() => {
                        setSelectedChartCheckpointId(checkpoint.id);
                        const firstDelta = checkpointDeltas[0];
                        setSelectedChartDeltaId(firstDelta?.id ?? "");
                      }}
                    >
                      <span>{chartDateLabel(checkpoint.approvedAt)}</span>
                      <strong>{checkpoint.title}</strong>
                      <em>{checkpoint.approvedDeltaIds.length} delta{checkpoint.approvedDeltaIds.length === 1 ? "" : "s"}{checkpoint.imported ? " · imported" : ""}</em>
                    </button>
                    <div className="chart-timeline-events">
                      {checkpointDeltas.slice(0, 5).map((delta) => (
                        <button
                          key={delta.id}
                          type="button"
                          className={delta.id === selectedChartDelta?.id ? "selected-chart-node" : ""}
                          onClick={() => {
                            setSelectedChartCheckpointId(checkpoint.id);
                            setSelectedChartDeltaId(delta.id);
                          }}
                        >
                          <span>{deltaLifecycleLabel(delta)} · v{delta.version}</span>
                          <strong>{delta.title}</strong>
                        </button>
                      ))}
                      {checkpointDeltas.length > 5 && <em>{checkpointDeltas.length - 5} more deltas</em>}
                    </div>
                  </article>
                );
              })}
            </div>
          </aside>
          <section className="chart-deltas">
            <div className="chart-pane-heading">
              <span>Deltas</span>
              <strong>{visibleChartDeltas.length}</strong>
            </div>
            <div className="chart-type-row">
              {chartDeltaCounts.map((item) => (
                <span key={item.type} className={`extraction-chip extraction-chip-${item.type}`}>
                  <strong>{item.total}</strong> {extractionTypeShortLabels[item.type]}
                </span>
              ))}
            </div>
            <div className="chart-delta-list">
              {visibleChartDeltas.length === 0 && <p className="empty-inline">No approved deltas match.</p>}
              {visibleChartDeltas.map((delta) => (
                <button
                  key={delta.id}
                  type="button"
                  className={`chart-delta-card extraction-${delta.type} ${delta.id === selectedChartDelta?.id ? "selected-chart-node" : ""}`}
                  onClick={() => setSelectedChartDeltaId(delta.id)}
                >
                  <span>{extractionTypeLabels[delta.type]} · v{delta.version} · {delta.status} · {deltaLifecycleLabel(delta)}</span>
                  <strong>{delta.title}</strong>
                  <em>{artifactTitle(chartArtifacts.find((artifact) => artifact.id === delta.conversationArtifactId))}</em>
                </button>
              ))}
            </div>
          </section>
          <section className="chart-provenance">
            <div className="chart-pane-heading">
              <span>Provenance</span>
              <strong>{selectedChartDelta ? `v${selectedChartDelta.version}` : "-"}</strong>
            </div>
            {!selectedChartDelta && <p className="empty-inline">Select a delta.</p>}
            {selectedChartDelta && (
              <>
                <article className="chart-detail-card">
                  <span>{extractionTypeLabels[selectedChartDelta.type]}</span>
                  <h3>{selectedChartDelta.title}</h3>
                  <p>{selectedChartDelta.body}</p>
                  <TaskPlanDetails markdown={selectedChartDelta.taskPlanMarkdown} />
                  <div className="chart-meta-grid">
                    <span>Checkpoint</span>
                    <strong>{selectedChartCheckpoint?.title ?? selectedChartDelta.checkpointId}</strong>
                    <span>Stable key</span>
                    <code>{selectedChartDelta.stableKey}</code>
                    <span>Lifecycle</span>
                    <strong>{deltaLifecycleLabel(selectedChartDelta)}</strong>
                    <span>Canonical item</span>
                    <code>{selectedChartDelta.canonicalItemId}</code>
                    <span>Target</span>
                    <code>{selectedChartDelta.targetCanonicalItemId ?? "new item"}</code>
                    <span>Operation</span>
                    <strong>{selectedChartDelta.canonicalOperation ?? "add"}</strong>
                    <span>Artifact</span>
                    <strong>{artifactTitle(selectedChartArtifact ?? undefined)}</strong>
                    <span>Evidence</span>
                    <strong>{selectedChartDelta.evidenceSource ?? "unknown"} {selectedChartDelta.evidenceEntryId ? `· ${selectedChartDelta.evidenceEntryId}` : ""}</strong>
                  </div>
                  {selectedChartDelta.reconciliationReason && <p>{selectedChartDelta.reconciliationReason}</p>}
                  {selectedChartDelta.reconcilesWith && selectedChartDelta.reconcilesWith.length > 0 && (
                    <div className="chart-reconcile-list">
                      {selectedChartDelta.reconcilesWith.map((item) => (
                        <span key={item.id}>{item.title} · {item.status} · {Math.round(item.score * 100)}%</span>
                      ))}
                    </div>
                  )}
                  {selectedChartDelta.evidenceQuote && <q>{selectedChartDelta.evidenceQuote}</q>}
                </article>
                <article className="chart-detail-card">
                  <span>Local Artifact</span>
                  <h3>{artifactTitle(selectedChartArtifact ?? undefined)}</h3>
                  <div className="chart-path-list">
                    {artifactPreview?.paths.transcript && <code>{artifactPreview.paths.transcript}</code>}
                    {artifactPreview?.paths.handoff && <code>{artifactPreview.paths.handoff}</code>}
                    {artifactPreview?.paths.eventLog && <code>{artifactPreview.paths.eventLog}</code>}
                  </div>
                  {artifactPending && <p className="empty-inline">Loading artifact.</p>}
                  {artifactPreview?.transcriptPreview && (
                    <details className="chart-preview" open>
                      <summary>Transcript</summary>
                      <ChartTranscriptPreview markdown={artifactPreview.transcriptPreview} />
                    </details>
                  )}
                  {artifactPreview?.handoffPreview && (
                    <details className="chart-preview">
                      <summary>Handoff</summary>
                      <pre>{artifactPreview.handoffPreview}</pre>
                    </details>
                  )}
                  {artifactPreview?.eventPreview && (
                    <details className="chart-preview">
                      <summary>Events</summary>
                      <pre>{artifactPreview.eventPreview}</pre>
                    </details>
                  )}
                </article>
                <article className="chart-detail-card">
                  <span>Provider References</span>
                  {selectedProviderRefs.length === 0 && <p className="empty-inline">No provider reference.</p>}
                  {selectedProviderRefs.map((ref) => (
                    <section key={ref.id} className="provider-ref-card">
                      <div>
                        <strong>{providerRefTitle(ref)}</strong>
                        <code>{ref.providerRefId}</code>
                      </div>
                      <div className="chart-meta-grid">
                        <span>Thread</span>
                        <strong>{ref.threadId ?? "-"}</strong>
                        <span>Access</span>
                        <strong>{ref.accessPreset ?? "-"}</strong>
                        <span>Resume</span>
                        <strong>{providerActionText(ref.actions.resume, "resume")}</strong>
                        <span>Fork</span>
                        <strong>{providerActionText(ref.actions.fork, "fork")}</strong>
                        <span>Archive</span>
                        <strong>{providerActionText(ref.actions.archive, "archive")}</strong>
                      </div>
                      <div className="provider-ref-actions">
                        <button type="button" onClick={() => void copyText(ref.openTarget ?? ref.providerRefId)} disabled={!ref.openTarget && !ref.providerRefId}>Copy</button>
                        <button type="button" onClick={() => ref.openTarget && window.open(ref.openTarget, "_blank", "noopener,noreferrer")} disabled={!ref.openTarget}>Open</button>
                      </div>
                    </section>
                  ))}
                </article>
              </>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}

export type CanonicalStateModalProps = {
  canonicalState: {
    project: { title: string };
    projectDir: string;
    productionMarkdown: string;
    productionMarkdownPath: string;
    extractedItemsMarkdown: string;
    extractedItemsMarkdownPath: string;
  };
  copyText: (text: string) => unknown;
  onClose: () => void;
};

export function CanonicalStateModal({ canonicalState, copyText, onClose }: CanonicalStateModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="canonical-modal" role="dialog" aria-modal="true" aria-label="Project canonical state" onClick={(event) => event.stopPropagation()}>
        <div className="canonical-modal-header">
          <div>
            <span>Canonical state</span>
            <h2>{canonicalState.project.title}</h2>
            <p>{canonicalState.projectDir}</p>
          </div>
          <div className="project-header-actions">
            <button type="button" onClick={() => void copyText(canonicalState.productionMarkdown)}>Copy Markdown</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="canonical-modal-body">
          <section className="canonical-pane">
            <div className="canonical-pane-header">
              <span>Production chart</span>
              <small>{canonicalState.productionMarkdownPath}</small>
            </div>
            <div className="markdown-body canonical-markdown"><MarkdownContent markdown={canonicalState.productionMarkdown} /></div>
          </section>
          <section className="canonical-pane">
            <div className="canonical-pane-header">
              <span>Extracted items</span>
              <small>{canonicalState.extractedItemsMarkdownPath}</small>
            </div>
            <div className="markdown-body canonical-markdown"><MarkdownContent markdown={canonicalState.extractedItemsMarkdown} /></div>
          </section>
        </div>
      </section>
    </div>
  );
}
