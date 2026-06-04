import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { CodexStatus, ForkCheckpoint, MorticSession, RuntimeContextRestore, TranscriptEntry, TurnRun } from "../shared/types.js";

export type SessionStorage = {
  sessionDir: string;
  read(): Promise<MorticSession>;
  write(session: MorticSession): Promise<void>;
  resetSource(params: { sourceUri: string; threadId: string; codex: CodexStatus; runtimeContext?: RuntimeContextRestore }): Promise<MorticSession>;
  clear(): Promise<MorticSession>;
  setActiveTurn(turn: TurnRun | undefined): Promise<MorticSession>;
  updateActiveTurn(updater: (turn: TurnRun | undefined, session: MorticSession) => TurnRun | undefined): Promise<MorticSession>;
  append(entry: TranscriptEntry): Promise<MorticSession>;
  setHandoff(params: { handoff: string; shortPrompt?: string; fullPrompt?: string }): Promise<MorticSession>;
  setForkCheckpoint(checkpoint: ForkCheckpoint | undefined): Promise<MorticSession>;
  transcriptMarkdown(session?: MorticSession): Promise<string>;
};

function baseDir(): string {
  return path.join(homedir(), ".mortic", "sessions");
}

function entryToMarkdown(entry: TranscriptEntry): string {
  const effort = entry.reasoningEffort ? ` · reasoning: ${entry.reasoningEffort}` : "";
  const mode = entry.scratchMode ? ` · mode: ${entry.scratchMode}` : "";
  const failed = entry.failed ? " · failed" : "";
  const text = entry.failed ? entry.text.trim().split("\n").slice(0, 8).join("\n") : entry.text.trim();
  const spoken = entry.spokenText ? `\n\nSpoken:\n${entry.spokenText.trim()}` : "";
  const readable =
    entry.spokenText && !entry.notesText && text && text !== entry.spokenText.trim()
      ? `\n\nNotes:\n${text}`
      : "";
  const notes = entry.notesText ? `\n\nNotes:\n${entry.notesText.trim()}` : "";
  const sources = entry.sourcesText ? `\n\nSources:\n${entry.sourcesText.trim()}` : "";
  if (spoken || notes || sources) {
    return `## ${entry.role} · ${entry.createdAt}${mode}${effort}${failed}${spoken}${readable}${notes}${sources}\n`;
  }
  return `## ${entry.role} · ${entry.createdAt}${mode}${effort}${failed}\n\n${text}\n`;
}

async function latestSessionForSource(params: {
  sourceUri: string;
  threadId: string;
  codex: CodexStatus;
}): Promise<{ sessionDir: string; session: MorticSession } | null> {
  let entries;
  try {
    entries = await readdir(baseDir(), { withFileTypes: true });
  } catch {
    return null;
  }

  let latest: { sessionDir: string; session: MorticSession; updatedAtMs: number } | null = null;
  let latestNonEmpty: { sessionDir: string; session: MorticSession; updatedAtMs: number } | null = null;
  let latestNonEmptyCompleted: { sessionDir: string; session: MorticSession; updatedAtMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidateDir = path.join(baseDir(), entry.name);
    try {
      const candidate = JSON.parse(await readFile(path.join(candidateDir, "session.json"), "utf8")) as MorticSession;
      if (candidate.sourceUri !== params.sourceUri && candidate.threadId !== params.threadId) continue;
      const updatedAtMs = Date.parse(candidate.updatedAt);
      if (!Number.isFinite(updatedAtMs)) continue;
      const normalized = {
        sessionDir: candidateDir,
        session: {
          ...candidate,
          codex: params.codex,
          activeTurn: candidate.activeTurn?.status === "running" ? undefined : candidate.activeTurn
        },
        updatedAtMs
      };
      if (!latest || updatedAtMs > latest.updatedAtMs) latest = normalized;
      if ((candidate.transcript?.length ?? 0) > 0) {
        if (!latestNonEmpty || updatedAtMs > latestNonEmpty.updatedAtMs) latestNonEmpty = normalized;
        if (candidate.activeTurn?.status !== "running" && (!latestNonEmptyCompleted || updatedAtMs > latestNonEmptyCompleted.updatedAtMs)) {
          latestNonEmptyCompleted = normalized;
        }
      }
    } catch {
      // Ignore corrupt or partial sessions from interrupted writes.
    }
  }

  if (!latest) return null;
  if ((latest.session.transcript?.length ?? 0) === 0 && latest.session.clearedAt) {
    return { sessionDir: latest.sessionDir, session: latest.session };
  }
  const selected = latestNonEmptyCompleted ?? latestNonEmpty ?? latest;
  return { sessionDir: selected.sessionDir, session: selected.session };
}

export async function createSessionStorage(params: {
  sourceUri: string;
  threadId: string;
  codex: CodexStatus;
  runtimeContext?: RuntimeContextRestore;
}): Promise<SessionStorage> {
  const now = new Date().toISOString();
  await mkdir(baseDir(), { recursive: true });
  const existing = await latestSessionForSource(params);
  const session: MorticSession = existing?.session ?? {
    id: randomUUID(),
    sourceUri: params.sourceUri,
    threadId: params.threadId,
    createdAt: now,
    updatedAt: now,
    transcript: [],
    codex: params.codex,
    runtimeContext: params.runtimeContext
  };
  session.codex = params.codex;
  if (params.runtimeContext) session.runtimeContext = params.runtimeContext;

  const sessionDir = existing?.sessionDir ?? path.join(baseDir(), session.id);
  const sessionPath = path.join(sessionDir, "session.json");
  const transcriptPath = path.join(sessionDir, "transcript.md");
  const handoffPath = path.join(sessionDir, "handoff.md");
  let ioQueue: Promise<void> = Promise.resolve();

  await mkdir(sessionDir, { recursive: true });

  async function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = ioQueue.then(operation, operation);
    ioQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function writeTextAtomic(filePath: string, text: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(tempPath), { recursive: true });
    await writeFile(tempPath, text, "utf8");
    await mkdir(path.dirname(filePath), { recursive: true });
    await rename(tempPath, filePath);
  }

  async function writeRaw(sessionToWrite: MorticSession): Promise<void> {
    const updated = {
      ...sessionToWrite,
      updatedAt: new Date().toISOString()
    };
    await writeTextAtomic(sessionPath, `${JSON.stringify(updated, null, 2)}\n`);
    await writeTextAtomic(transcriptPath, await transcriptMarkdown(updated));
    await writeTextAtomic(handoffPath, updated.handoff ?? "");
  }

  async function readRaw(): Promise<MorticSession> {
    return JSON.parse(await readFile(sessionPath, "utf8")) as MorticSession;
  }

  async function write(sessionToWrite: MorticSession): Promise<void> {
    await enqueue(() => writeRaw(sessionToWrite));
  }

  async function read(): Promise<MorticSession> {
    await ioQueue;
    return readRaw();
  }

  async function append(entry: TranscriptEntry): Promise<MorticSession> {
    return enqueue(async () => {
      const current = await readRaw();
      const next: MorticSession = {
        ...current,
        transcript: [...current.transcript, entry]
      };
      await writeRaw(next);
      return readRaw();
    });
  }

  async function resetSource(params: {
    sourceUri: string;
    threadId: string;
    codex: CodexStatus;
    runtimeContext?: RuntimeContextRestore;
  }): Promise<MorticSession> {
    return enqueue(async () => {
      const current = await readRaw();
      const next: MorticSession = {
        ...current,
        sourceUri: params.sourceUri,
        threadId: params.threadId,
        transcript: [],
        activeTurn: undefined,
        handoff: undefined,
        handoffShort: undefined,
        handoffFull: undefined,
        forkCheckpoint: undefined,
        codex: params.codex,
        runtimeContext: params.runtimeContext
      };
      await writeRaw(next);
      return readRaw();
    });
  }

  async function clear(): Promise<MorticSession> {
    return enqueue(async () => {
      const current = await readRaw();
      const now = new Date().toISOString();
      const next: MorticSession = {
        ...current,
        transcript: [],
        handoff: undefined,
        handoffShort: undefined,
        handoffFull: undefined,
        forkCheckpoint: undefined,
        activeTurn: undefined,
        clearedAt: now
      };
      await writeRaw(next);
      return readRaw();
    });
  }

  async function setActiveTurn(turn: TurnRun | undefined): Promise<MorticSession> {
    return enqueue(async () => {
      const current = await readRaw();
      const next: MorticSession = {
        ...current,
        activeTurn: turn
      };
      await writeRaw(next);
      return readRaw();
    });
  }

  async function updateActiveTurn(updater: (turn: TurnRun | undefined, session: MorticSession) => TurnRun | undefined): Promise<MorticSession> {
    return enqueue(async () => {
      const current = await readRaw();
      const next: MorticSession = {
        ...current,
        activeTurn: updater(current.activeTurn, current)
      };
      await writeRaw(next);
      return readRaw();
    });
  }

  async function setHandoff(params: { handoff: string; shortPrompt?: string; fullPrompt?: string }): Promise<MorticSession> {
    return enqueue(async () => {
      const current = await readRaw();
      const next: MorticSession = {
        ...current,
        handoff: params.handoff,
        handoffShort: params.shortPrompt,
        handoffFull: params.fullPrompt
      };
      await writeRaw(next);
      return readRaw();
    });
  }

  async function setForkCheckpoint(checkpoint: ForkCheckpoint | undefined): Promise<MorticSession> {
    return enqueue(async () => {
      const current = await readRaw();
      const next: MorticSession = {
        ...current,
        forkCheckpoint: checkpoint
      };
      await writeRaw(next);
      return readRaw();
    });
  }

  async function transcriptMarkdown(sessionToRender?: MorticSession): Promise<string> {
    const current = sessionToRender ?? (await read());
    const entries = current.transcript.map(entryToMarkdown).join("\n");
    return `# Mortic Transcript\n\nSource thread: ${current.sourceUri}\n\n${entries}`.trim() + "\n";
  }

  const storage: SessionStorage = {
    sessionDir,
    read,
    write,
    resetSource,
    clear,
    setActiveTurn,
    updateActiveTurn,
    append,
    setHandoff,
    setForkCheckpoint,
    transcriptMarkdown
  };

  await write(session);
  return storage;
}
