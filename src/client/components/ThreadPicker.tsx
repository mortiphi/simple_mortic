import { useEffect, useState } from "react";

import type { ProviderThreadSummary } from "../../shared/types.js";
import { chartDateLabel } from "../lib/labels.js";

export type ThreadPickerProps = {
  api: string;
  currentThreadId: string | undefined;
  disabled: boolean;
  onSelect: (sourceUri: string) => void;
};

function workspaceLabel(cwd: string | undefined): string {
  if (!cwd) return "unknown workspace";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function threadTitle(thread: ProviderThreadSummary): string {
  return thread.threadName?.trim() || workspaceLabel(thread.cwd);
}

// Recent-conversation picker over GET /api/provider/threads so switching
// projects does not require pasting a codex://threads/... URI by hand.
export function ThreadPicker({ api, currentThreadId, disabled, onSelect }: ThreadPickerProps) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<ProviderThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setThreads(null);
    setError(null);
    fetch(`${api}/api/provider/threads?limit=20`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not list conversations");
        if (!cancelled) setThreads(payload.threads ?? []);
      })
      .catch((fetchError) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      });
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  return (
    <div className="thread-picker">
      <button type="button" disabled={disabled} onClick={() => setOpen((current) => !current)} title="Pick a recent Codex conversation">
        {open ? "Close" : "Finder"}
      </button>
      {open && (
        <div className="thread-picker-list" role="listbox" aria-label="Recent Codex conversations">
          {!threads && !error && <p className="empty-inline">Loading conversations.</p>}
          {error && <p className="empty-inline">{error}</p>}
          {threads && threads.length === 0 && <p className="empty-inline">No local Codex conversations found.</p>}
          {threads?.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              className={thread.threadId === currentThreadId ? "selected-thread" : ""}
              title={`${threadTitle(thread)} · ${thread.sourceUri}`}
              onClick={() => {
                setOpen(false);
                onSelect(thread.sourceUri);
              }}
            >
              <strong>{threadTitle(thread)}</strong>
              <span>{workspaceLabel(thread.cwd)} · {chartDateLabel(thread.updatedAt)}</span>
              {thread.cwd && <small>{thread.cwd}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
