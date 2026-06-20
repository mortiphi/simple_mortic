import { useEffect, useRef, useState } from "react";

import type { ProviderThreadSummary } from "../../shared/types.js";
import { chartDateLabel } from "../lib/labels.js";

export type ThreadPickerProps = {
  api: string;
  currentThreadId: string | undefined;
  disabled: boolean;
  workspacePath?: string;
  onSelect: (sourceUri: string) => void;
  openRequest?: number;
};

function workspaceLabel(cwd: string | undefined): string {
  if (!cwd) return "unknown workspace";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function threadTitle(thread: ProviderThreadSummary): string {
  return thread.threadName?.trim() || `Thread ${thread.threadId.slice(0, 8)}`;
}

// Recent-conversation picker over GET /api/provider/threads so switching
// projects does not require pasting a codex://threads/... URI by hand.
export function ThreadPicker({ api, currentThreadId, disabled, workspacePath, onSelect, openRequest = 0 }: ThreadPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [scopeAllProjects, setScopeAllProjects] = useState(false);
  const [threads, setThreads] = useState<ProviderThreadSummary[] | null>(null);
  const [previewThreadId, setPreviewThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const previewThread = threads?.find((thread) => thread.threadId === previewThreadId) ?? null;
  const scopedToWorkspace = Boolean(workspacePath && !scopeAllProjects);

  function commitThread(thread: ProviderThreadSummary) {
    closePicker();
    onSelect(thread.sourceUri);
  }

  function closePicker(): void {
    setOpen(false);
    setPreviewThreadId(null);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (openRequest > 0) setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(-1);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: "40" });
      if (scopedToWorkspace && workspacePath) params.set("cwd", workspacePath);
      if (query.trim()) params.set("searchTerm", query.trim());

      setThreads(null);
      setError(null);
      fetch(`${api}/api/provider/threads?${params.toString()}`)
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? "Could not list conversations");
          if (!cancelled) setThreads(payload.threads ?? []);
        })
        .catch((fetchError) => {
          if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        });
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, api, query, scopedToWorkspace, workspacePath]);

  return (
    <div className="thread-picker">
      <button ref={triggerRef} type="button" disabled={disabled} onClick={() => open ? closePicker() : setOpen(true)} title="Pick a recent Codex conversation" aria-expanded={open} aria-haspopup="listbox">
        {open ? "Close" : "Finder"}
      </button>
      {open && (
        <div
          className="thread-picker-list"
          role="listbox"
          aria-label="Recent Codex conversations"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closePicker();
              return;
            }
            if (!threads?.length) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              const next = activeIndex < 0 ? (delta > 0 ? 0 : threads.length - 1) : (activeIndex + delta + threads.length) % threads.length;
              setActiveIndex(next);
              setPreviewThreadId(threads[next].threadId);
              document.getElementById(`thread-option-${threads[next].threadId}`)?.focus();
            }
            if (event.key === "Enter" && previewThread) {
              event.preventDefault();
              commitThread(previewThread);
            }
          }}
        >
          <label className="thread-picker-search">
            <span>Find thread</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by thread or project"
              autoFocus
            />
          </label>
          {workspacePath && (
            <div className="thread-picker-scope">
              <span>{scopeAllProjects ? "All Codex projects" : `Filtered to ${workspaceLabel(workspacePath)}`}</span>
              <button type="button" onClick={() => setScopeAllProjects((current) => !current)}>
                {scopeAllProjects ? "This project" : "All projects"}
              </button>
            </div>
          )}
          {!threads && !error && <p className="empty-inline">Loading conversations.</p>}
          {error && <p className="empty-inline">{error}</p>}
          {threads && threads.length === 0 && (
            <section className="thread-picker-empty">
              <p>{scopedToWorkspace ? `No Codex conversations found for ${workspaceLabel(workspacePath)}.` : "No local Codex conversations found."}</p>
              {scopedToWorkspace && (
                <button type="button" onClick={() => setScopeAllProjects(true)}>
                  Search all projects
                </button>
              )}
            </section>
          )}
          {threads?.map((thread, index) => (
            <button
              id={`thread-option-${thread.threadId}`}
              key={thread.threadId}
              type="button"
              className={[
                thread.threadId === currentThreadId ? "selected-thread" : "",
                thread.threadId === previewThreadId ? "preview-thread" : ""
              ].filter(Boolean).join(" ")}
              title={`${workspaceLabel(thread.cwd)} · ${threadTitle(thread)} · ${thread.sourceUri}`}
              onClick={() => setPreviewThreadId(thread.threadId)}
              onFocus={() => {
                setActiveIndex(index);
                setPreviewThreadId(thread.threadId);
              }}
              onDoubleClick={() => commitThread(thread)}
            >
              <span className="thread-picker-cell">
                <small>Project</small>
                <strong>{workspaceLabel(thread.cwd)}</strong>
              </span>
              <span className="thread-picker-cell thread-picker-thread-cell">
                <small>Thread</small>
                <strong>{threadTitle(thread)}</strong>
              </span>
              <span className="thread-picker-date">{chartDateLabel(thread.updatedAt)}</span>
            </button>
          ))}
          {previewThread && (
            <section className="thread-picker-preview" aria-label="Thread preview">
              <small>Preview</small>
              <strong>{threadTitle(previewThread)}</strong>
              <span>{workspaceLabel(previewThread.cwd)} · {chartDateLabel(previewThread.updatedAt)}</span>
              <code>{previewThread.sourceUri}</code>
              <button type="button" onClick={() => commitThread(previewThread)}>
                {previewThread.threadId === currentThreadId ? "Current thread" : "Open this thread"}
              </button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
