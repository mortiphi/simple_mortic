import type { ExtractedItem, TranscriptEntry } from "../../shared/types.js";
import {
  effortLabels,
  entryLabel,
  entryMainText,
  entryNotesLabel,
  entryParserLabel,
  extractionActionLabel,
  extractionEvidenceLabel,
  extractionReasons,
  extractionStatusLabels,
  extractionTypeLabels,
  extractionTypeOrder,
  modeLabels
} from "../lib/labels.js";
import { MarkdownContent, TaskPlanDetails } from "./Markdown.js";

export type TranscriptDrawerProps = {
  sessionId: string | undefined;
  transcript: TranscriptEntry[];
  compactTranscriptLength: number;
  onClose: () => void;
};

export function TranscriptDrawer({ sessionId, transcript, compactTranscriptLength, onClose }: TranscriptDrawerProps) {
  return (
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <section className="transcript-drawer" role="dialog" aria-modal="true" aria-label="Expanded transcript" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <span>ID: {sessionId ?? "no-session"}</span>
            <h2>Expanded Transcript</h2>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="transcript drawer-transcript">
          {compactTranscriptLength === 0 && <div className="empty">No scratch turns yet</div>}
          {transcript.map((entry) => {
            const parserLabel = entryParserLabel(entry);
            return (
              <article key={entry.id} className={`entry entry-${entry.role} ${entry.failed ? "entry-failed" : ""} ${entry.parserMode === "invalid" ? "entry-parser-invalid" : ""}`}>
                <div className="entry-meta">
                  <span>{entryLabel(entry)}</span>
                  <div className="entry-meta-right">
                    {parserLabel && <span className="entry-parser-status">{parserLabel}</span>}
                    <span>{entry.scratchMode ? `${modeLabels[entry.scratchMode]} · ` : ""}{entry.reasoningEffort ? effortLabels[entry.reasoningEffort] : ""}</span>
                  </div>
                </div>
                {entry.notesText || entry.sourcesText ? (
                  <div className="entry-body">
                    <p>{entryMainText(entry)}</p>
                    {entry.notesText && (
                      <details className="entry-notes entry-read-disclosure" open>
                        <summary>{entryNotesLabel(entry)}</summary>
                        <div className="entry-notes-content"><MarkdownContent markdown={entry.notesText} /></div>
                      </details>
                    )}
                    {entry.sourcesText && (
                      <div className="entry-sources">
                        <span>Sources</span>
                        <div className="entry-notes-content"><MarkdownContent markdown={entry.sourcesText} /></div>
                      </div>
                    )}
                  </div>
                ) : (
                  <p>{entry.text}</p>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export type ExtractionReviewModalProps = {
  extractionReviewTab: "pending" | "approved";
  setExtractionReviewTab: (tab: "pending" | "approved") => void;
  approvedExtractions: ExtractedItem[];
  draftExtractions: ExtractedItem[];
  reviewExtractions: ExtractedItem[];
  reviewExtractionCounts: Array<{ type: ExtractedItem["type"]; total: number }>;
  editingExtractionId: string | null;
  editingExtractionType: ExtractedItem["type"];
  setEditingExtractionType: (type: ExtractedItem["type"]) => void;
  editingExtractionTitle: string;
  setEditingExtractionTitle: (value: string) => void;
  editingExtractionBody: string;
  setEditingExtractionBody: (value: string) => void;
  editingExtractionTaskPlan: string;
  setEditingExtractionTaskPlan: (value: string) => void;
  beginEditExtraction: (item: ExtractedItem) => void;
  cancelEditExtraction: () => void;
  saveExtractionEdit: (id: string) => unknown;
  retireExtraction: (id: string) => unknown;
  updateExtraction: (id: string, status: "approved" | "dismissed") => unknown;
  openProjectChart: () => unknown;
  openCanonicalState: () => unknown;
  chartPending: boolean;
  canonicalStatePending: boolean;
  projectPending: boolean;
  onClose: () => void;
};

export function ExtractionReviewModal({
  extractionReviewTab,
  setExtractionReviewTab,
  approvedExtractions,
  draftExtractions,
  reviewExtractions,
  reviewExtractionCounts,
  editingExtractionId,
  editingExtractionType,
  setEditingExtractionType,
  editingExtractionTitle,
  setEditingExtractionTitle,
  editingExtractionBody,
  setEditingExtractionBody,
  editingExtractionTaskPlan,
  setEditingExtractionTaskPlan,
  beginEditExtraction,
  cancelEditExtraction,
  saveExtractionEdit,
  retireExtraction,
  updateExtraction,
  openProjectChart,
  openCanonicalState,
  chartPending,
  canonicalStatePending,
  projectPending,
  onClose
}: ExtractionReviewModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="extraction-review-modal" role="dialog" aria-modal="true" aria-label="Project update review" onClick={(event) => event.stopPropagation()}>
        <div className="extraction-review-header">
          <div>
            <span>Project updates</span>
            <h2>{extractionReviewTab === "approved" ? `${approvedExtractions.length} approved cards` : `${draftExtractions.length} waiting for review`}</h2>
            <p>{extractionReviewTab === "approved" ? "Edit approved canonical cards or retire cards that should leave active state." : "Approve only the updates that should enter Mortic canonical state."}</p>
          </div>
          <div className="project-header-actions">
            <button type="button" onClick={() => void openProjectChart()} disabled={chartPending}>Chart</button>
            <button type="button" onClick={() => void openCanonicalState()} disabled={canonicalStatePending}>Open State</button>
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="extraction-chip-row extraction-modal-chips">
          {reviewExtractionCounts.length === 0 ? (
            <span className="extraction-chip extraction-chip-empty">No updates found</span>
          ) : (
            reviewExtractionCounts.map((item) => (
              <span key={item.type} className={`extraction-chip extraction-chip-${item.type}`}>
                <strong>{item.total}</strong> {extractionTypeLabels[item.type]}
              </span>
            ))
          )}
        </div>
        <div className="extraction-review-tabs" role="tablist" aria-label="Project update review tabs">
          <button
            type="button"
            className={extractionReviewTab === "pending" ? "selected" : ""}
            onClick={() => {
              cancelEditExtraction();
              setExtractionReviewTab("pending");
            }}
          >
            Pending <strong>{draftExtractions.length}</strong>
          </button>
          <button
            type="button"
            className={extractionReviewTab === "approved" ? "selected" : ""}
            onClick={() => {
              cancelEditExtraction();
              setExtractionReviewTab("approved");
            }}
          >
            Approved <strong>{approvedExtractions.length}</strong>
          </button>
        </div>
        <div className="extraction-review-list">
          {reviewExtractions.length === 0 && (
            <p className="empty-inline">
              {extractionReviewTab === "approved"
                ? "No approved canonical cards yet."
                : "Compile a session after real decisions, tasks, risks, priorities, constraints, or deferred work appear in the scratch transcript."}
            </p>
          )}
          {reviewExtractions.map((item) => {
            const actionLabel = extractionActionLabel(item);
            const editing = editingExtractionId === item.id;
            const retired = item.lifecycleStatusAfter === "dropped";
            return (
              <article key={item.id} className={`extraction-item extraction-${item.type} extraction-status-${item.status}`}>
                <div className="extraction-topline">
                  <span>{extractionTypeLabels[item.type]}</span>
                  <em>{retired ? "Retired" : actionLabel ? `${extractionStatusLabels[item.status]} · ${actionLabel}` : extractionStatusLabels[item.status]}</em>
                </div>
                {editing ? (
                  <div className="extraction-edit-form">
                    <label>
                      <span>Kind</span>
                      <select value={editingExtractionType} onChange={(event) => setEditingExtractionType(event.target.value as ExtractedItem["type"])}>
                        {extractionTypeOrder.map((type) => (
                          <option key={type} value={type}>{extractionTypeLabels[type]}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Title</span>
                      <input value={editingExtractionTitle} onChange={(event) => setEditingExtractionTitle(event.target.value)} />
                    </label>
                    <label>
                      <span>Body</span>
                      <textarea value={editingExtractionBody} onChange={(event) => setEditingExtractionBody(event.target.value)} rows={5} />
                    </label>
                    <label>
                      <span>Task Details | Plan</span>
                      <textarea value={editingExtractionTaskPlan} onChange={(event) => setEditingExtractionTaskPlan(event.target.value)} rows={8} placeholder="Optional Markdown plan, subtasks, acceptance criteria, and implementation notes." />
                    </label>
                  </div>
                ) : (
                  <>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                    <TaskPlanDetails markdown={item.taskPlanMarkdown} />
                  </>
                )}
                <div className="extraction-why">
                  <strong>Why picked</strong>
                  <span>{item.selectionReason ?? extractionReasons[item.type]}</span>
                  {item.transcriptAnchor?.quote && (
                    <>
                      <small>{extractionEvidenceLabel(item)}</small>
                      <q>{item.transcriptAnchor.quote}</q>
                    </>
                  )}
                  <em>{actionLabel ? `Action: ${actionLabel}. ` : item.delta ? `Delta: ${item.delta}. ` : ""}Confidence {Math.round(item.confidence * 100)}%</em>
                </div>
                <div className="extraction-actions">
                  {editing ? (
                    <>
                      <button type="button" onClick={() => void saveExtractionEdit(item.id)} disabled={projectPending || !editingExtractionTitle.trim() || !editingExtractionBody.trim()}>Save</button>
                      <button type="button" onClick={cancelEditExtraction} disabled={projectPending}>Cancel</button>
                    </>
                  ) : extractionReviewTab === "approved" ? (
                    <>
                      <button type="button" onClick={() => beginEditExtraction(item)} disabled={projectPending || retired}>Edit</button>
                      <button type="button" onClick={() => void retireExtraction(item.id)} disabled={projectPending || retired}>{retired ? "Retired" : "Retire"}</button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => beginEditExtraction(item)} disabled={projectPending}>Edit</button>
                      <button type="button" onClick={() => void updateExtraction(item.id, "approved")} disabled={projectPending}>Approve</button>
                      <button type="button" onClick={() => void updateExtraction(item.id, "dismissed")} disabled={projectPending}>Dismiss</button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export type HandoffReviewModalProps = {
  draftExtractions: ExtractedItem[];
  shortHandoff: string;
  setShortHandoff: (value: string) => void;
  fullHandoff: string;
  setFullHandoff: (value: string) => void;
  setHandoff: (value: string) => void;
  fullPromptValue: string;
  handoff: string;
  generateHandoff: () => unknown;
  copyHandoffText: (text: string) => unknown;
  handoffPending: boolean;
  transcriptLength: number;
  onClose: () => void;
};

export function HandoffReviewModal({
  draftExtractions,
  shortHandoff,
  setShortHandoff,
  fullHandoff,
  setFullHandoff,
  setHandoff,
  fullPromptValue,
  handoff,
  generateHandoff,
  copyHandoffText,
  handoffPending,
  transcriptLength,
  onClose
}: HandoffReviewModalProps) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="handoff-review-modal" role="dialog" aria-modal="true" aria-label="Handoff review" onClick={(event) => event.stopPropagation()}>
        <div className="handoff-review-header">
          <div>
            <span>{draftExtractions.length} candidates pending</span>
            <h2>Handoff Review</h2>
            <p>Review the scratch handoff before carrying it back to the source thread.</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="handoff-review-body">
          <aside>
            {draftExtractions.length === 0 && <p className="empty-inline">No extraction candidates yet.</p>}
            {draftExtractions.slice(0, 5).map((item) => (
              <article key={item.id} className={item.status === "approved" ? "active" : ""}>
                <span>{extractionTypeLabels[item.type]}</span>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </article>
            ))}
          </aside>
          <section className="handoff-editor-split">
            <label>
              <span>Short prompt</span>
              <textarea
                className="handoff-editor"
                value={shortHandoff}
                onChange={(event) => {
                  setShortHandoff(event.target.value);
                  setHandoff(`# Short Prompt\n\n${event.target.value}\n\n# Full Prompt\n\n${fullHandoff}`);
                }}
                placeholder="Generate a concise next instruction"
              />
            </label>
            <label>
              <span>Full prompt</span>
              <textarea
                className="handoff-editor"
                value={fullPromptValue}
                onChange={(event) => {
                  setFullHandoff(event.target.value);
                  setHandoff(`# Short Prompt\n\n${shortHandoff}\n\n# Full Prompt\n\n${event.target.value}`);
                }}
                placeholder="Generate a fuller actionable instruction"
              />
            </label>
          </section>
        </div>
        <footer>
          <button type="button" onClick={() => void generateHandoff()} disabled={handoffPending || transcriptLength === 0}>{handoffPending ? "Generating" : "Regenerate"}</button>
          <button type="button" onClick={() => void copyHandoffText(shortHandoff)} disabled={!shortHandoff}>Copy Short</button>
          <button type="button" className="primary-action" onClick={() => void copyHandoffText(fullHandoff || handoff)} disabled={!fullHandoff && !handoff}>Copy Full</button>
        </footer>
      </section>
    </div>
  );
}
