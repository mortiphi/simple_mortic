import { useEffect, useRef } from "react";

import type { TranscriptEntry } from "../../shared/types.js";
import {
  effortLabels,
  entryLabel,
  entryMainText,
  entryNotesLabel,
  entryParserLabel,
  modeLabels
} from "../lib/labels.js";
import { MarkdownContent } from "./Markdown.js";

function useDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>("button, input, textarea, select, [tabindex]:not([tabindex='-1'])");
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) return;
      const firstItem = focusable[0];
      const lastItem = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus();
    };
  }, []);

  return dialogRef;
}

export type TranscriptDrawerProps = {
  sessionId: string | undefined;
  transcript: TranscriptEntry[];
  compactTranscriptLength: number;
  onClose: () => void;
};

export function TranscriptDrawer({ sessionId, transcript, compactTranscriptLength, onClose }: TranscriptDrawerProps) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <section ref={dialogRef} className="transcript-drawer" role="dialog" aria-modal="true" aria-label="Expanded transcript" onClick={(event) => event.stopPropagation()}>
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
                ) : <p>{entry.text}</p>}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export type HandoffReviewModalProps = {
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
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section ref={dialogRef} className="handoff-review-modal handoff-review-focused" role="dialog" aria-modal="true" aria-label="Handoff review" onClick={(event) => event.stopPropagation()}>
        <div className="handoff-review-header">
          <div>
            <span>Thread handoff</span>
            <h2>Review Handoff</h2>
            <p>Edit the short or full prompt before carrying it back to Codex.</p>
          </div>
          <button type="button" onClick={onClose}>Close</button>
        </div>
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
        <footer>
          <button type="button" onClick={() => void generateHandoff()} disabled={handoffPending || transcriptLength === 0}>{handoffPending ? "Generating" : "Regenerate"}</button>
          <button type="button" onClick={() => void copyHandoffText(shortHandoff)} disabled={!shortHandoff}>Copy short</button>
          <button type="button" className="primary-action" onClick={() => void copyHandoffText(fullHandoff || handoff)} disabled={!fullHandoff && !handoff}>Copy full</button>
        </footer>
      </section>
    </div>
  );
}

export function ConfirmDialog({ title, detail, confirmLabel, onConfirm, onClose }: {
  title: string;
  detail: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-detail" onClick={(event) => event.stopPropagation()}>
        <span>Confirm action</span>
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-detail">{detail}</p>
        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="danger-action" onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}

export function ClipboardFallbackDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const dialogRef = useDialogFocus(onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section ref={dialogRef} className="confirm-dialog clipboard-fallback" role="dialog" aria-modal="true" aria-labelledby="clipboard-fallback-title" onClick={(event) => event.stopPropagation()}>
        <span>Clipboard unavailable</span>
        <h2 id="clipboard-fallback-title">Select the handoff text</h2>
        <p>Your browser blocked clipboard access. The text below is ready to select manually.</p>
        <textarea readOnly value={text} onFocus={(event) => event.currentTarget.select()} rows={12} />
        <footer><button type="button" onClick={onClose}>Done</button></footer>
      </section>
    </div>
  );
}
