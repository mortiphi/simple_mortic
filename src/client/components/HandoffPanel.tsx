type HandoffPanelProps = {
  pending: boolean;
  transcriptLength: number;
  shortHandoff: string;
  fullHandoff: string;
  handoff: string;
  onGenerate: () => void;
  onPreview: () => void;
  onCopy: (text: string, kind: "short" | "full") => void;
  copied: "short" | "full" | null;
};

export function HandoffPanel({
  pending,
  transcriptLength,
  shortHandoff,
  fullHandoff,
  handoff,
  onGenerate,
  onPreview,
  onCopy,
  copied
}: HandoffPanelProps) {
  const full = fullHandoff || handoff;
  const hasHandoff = Boolean(shortHandoff || full);
  return (
    <section className="handoff-panel" aria-labelledby="handoff-panel-title">
      <header>
        <div>
          <span>Handoff</span>
          <h2 id="handoff-panel-title">Carry the thread forward</h2>
        </div>
        <strong>{pending ? "Generating" : hasHandoff ? "Ready" : `${transcriptLength} turns`}</strong>
      </header>
      <p>{hasHandoff ? (shortHandoff || full).slice(0, 240) : "Generate a concise or complete prompt from this scratch conversation."}</p>
      <div className="handoff-panel-actions">
        <button type="button" className="primary-action" onClick={onGenerate} disabled={pending || transcriptLength === 0}>
          {pending ? "Generating" : hasHandoff ? "Regenerate" : "Generate"}
        </button>
        <button type="button" onClick={onPreview} disabled={!hasHandoff}>Preview</button>
        <button type="button" onClick={() => onCopy(shortHandoff, "short")} disabled={!shortHandoff}>{copied === "short" ? "Copied" : "Copy short"}</button>
        <button type="button" onClick={() => onCopy(full, "full")} disabled={!full}>{copied === "full" ? "Copied" : "Copy full"}</button>
      </div>
    </section>
  );
}
