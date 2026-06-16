import type { TranscriptEntry } from "./types.js";

const textEncoder = new TextEncoder();

function entryBody(entry: TranscriptEntry): string {
  if (entry.spokenText || entry.notesText || entry.sourcesText) {
    return [entry.spokenText, entry.notesText ? `Notes:\n${entry.notesText}` : "", entry.sourcesText ? `Sources:\n${entry.sourcesText}` : ""]
      .filter((part) => part?.trim())
      .join("\n\n");
  }

  return entry.text;
}

export function estimateTextTokens(text: string): number {
  const clean = text.trim();
  if (!clean) return 0;

  const bytes = textEncoder.encode(clean).length;
  const words = clean.match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(bytes / 4, words * 1.25)));
}

export function estimateTranscriptTokens(transcript: TranscriptEntry[]): number {
  const text = transcript
    .map((entry) => `${entry.role === "assistant" ? "Mortic" : "You"}:\n${entryBody(entry)}`)
    .join("\n\n");
  return estimateTextTokens(text);
}

export function percentReduction(baselineTokens: number, candidateTokens: number): number {
  if (baselineTokens <= 0) return 0;
  return Math.max(0, Math.round((1 - candidateTokens / baselineTokens) * 100));
}

export function contextWorkReduction(baselineTokens: number, candidateTokens: number): number {
  if (baselineTokens <= 0) return 0;
  const baseline = baselineTokens * baselineTokens;
  const candidate = candidateTokens * candidateTokens;
  return Math.max(0, Math.round((1 - candidate / baseline) * 100));
}
