export type SpeechProjectionKind =
  | "speakable_text"
  | "code_block"
  | "json_block"
  | "table"
  | "image"
  | "diff"
  | "log"
  | "identifier"
  | "file_path"
  | "link"
  | "redacted";

export type SpeechProjectionSegment = {
  kind: SpeechProjectionKind;
  screenText: string;
  speechText: string;
  start: number;
  end: number;
  confidence: number;
  reason?: string;
};

export type SpeechProjectionResult = {
  speechText: string;
  segments: SpeechProjectionSegment[];
  suppressedChars: number;
  warnings: string[];
};

export type SpeechProjectionOptions = {
  exact?: boolean;
};

const codeCue = "I added a code snippet.";
const jsonCue = "I included a JSON object.";
const tableCue = "I showed a table.";
const imageCue = "I showed an image.";
const diffCue = "I showed a code diff.";
const logCue = "I included a log excerpt.";
const linkCue = "I included a link.";
const pathCue = "I referenced a local path.";

function appendSegment(
  segments: SpeechProjectionSegment[],
  kind: SpeechProjectionKind,
  screenText: string,
  speechText: string,
  start: number,
  end: number,
  reason?: string,
  confidence = 1
): void {
  segments.push({
    kind,
    screenText,
    speechText,
    start,
    end,
    confidence,
    reason
  });
}

function normalizeSpeechWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function stripCueDuplicate(output: string[], cue: string): void {
  if (output.at(-1) !== cue) output.push(cue);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  return Boolean(lines[index]?.includes("|") && lines[index + 1] && isTableSeparator(lines[index + 1]));
}

function tableEnd(lines: string[], start: number): number {
  let index = start;
  while (index < lines.length && lines[index]?.includes("|") && lines[index]?.trim()) index += 1;
  return index;
}

function likelyJsonBlock(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  const startsJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const endsJson = trimmed.endsWith("}") || trimmed.endsWith("]");
  const jsonish = /"[^"]+"\s*:/.test(trimmed) || /^\s*[\[{]\s*[\r\n]/.test(text);
  if (startsJson && endsJson && jsonish) return true;
  const punctuation = (trimmed.match(/[{}\[\]",:]/g) ?? []).length;
  return startsJson && jsonish && punctuation / Math.max(trimmed.length, 1) > 0.08;
}

function likelyDiffStart(line: string): boolean {
  return /^\s*(diff --git|@@\s|[+-]{3}\s)/.test(line);
}

function likelyDiffContinuation(line: string): boolean {
  return /^\s*(diff --git|@@\s|[+-]{3}\s|[+-](?![+-])| )/.test(line);
}

function likelyLogBlock(lines: string[], start: number): boolean {
  const current = lines[start] ?? "";
  return /\b(Error|Exception|Traceback|Stack trace|at\s+\S+:\d+:\d+)\b/.test(current);
}

function blockEndByPredicate(lines: string[], start: number, predicate: (line: string) => boolean): number {
  let index = start;
  while (index < lines.length && (predicate(lines[index] ?? "") || lines[index]?.trim() === "")) index += 1;
  return index;
}

function cueForFence(language: string): { kind: SpeechProjectionKind; cue: string; reason: string } {
  const normalized = language.trim().toLowerCase();
  if (normalized === "json" || normalized === "jsonc") return { kind: "json_block", cue: jsonCue, reason: "fenced JSON" };
  if (normalized === "diff" || normalized === "patch") return { kind: "diff", cue: diffCue, reason: "fenced diff" };
  if (["log", "text", "stderr", "stdout"].includes(normalized)) return { kind: "log", cue: logCue, reason: "fenced log" };
  return { kind: "code_block", cue: codeCue, reason: normalized ? `fenced ${normalized}` : "fenced code" };
}

function replaceOpaqueIdentifiers(text: string): string {
  return text
    .replace(/codex:\/\/threads\/[A-Za-z0-9-]+/g, "a Codex thread link")
    .replace(/\b(?:scratch|thread|turn|artifact|checkpoint)-[A-Za-z0-9_-]{10,}\b/gi, "that session reference")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "that ID")
    .replace(/\b[0-9a-f]{24,}\b/gi, "that ID")
    .replace(/\b[A-Za-z0-9+/]{48,}={0,2}\b/g, "encoded data");
}

function speakInlineCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[\w.-]+\.(tsx?|jsx?|mjs|cjs|json|md|css|html|py|go|rs|java|rb|sh|yml|yaml)$/i.test(trimmed)) {
    return trimmed.replace(/\./g, " dot ");
  }
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed) && trimmed.length <= 32) return trimmed;
  if (trimmed.length <= 24 && !/[{}[\];=<>]/.test(trimmed)) return trimmed;
  return "inline code";
}

function projectInline(text: string): string {
  let output = text;

  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string) => {
    const cleanAlt = normalizeSpeechWhitespace(alt ?? "");
    return cleanAlt ? `I showed an image: ${cleanAlt}.` : imageCue;
  });

  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_match, label: string) => {
    const cleanLabel = normalizeSpeechWhitespace(label ?? "");
    return cleanLabel ? `${cleanLabel}, linked on screen` : linkCue;
  });

  output = output.replace(/https?:\/\/\S+/g, linkCue);
  output = output.replace(/(?:\/Users|\/home|\/tmp|\.\/|\.\.\/)[^\s)]+/g, pathCue);
  output = output.replace(/`([^`]+)`/g, (_match, code: string) => speakInlineCode(code));
  output = replaceOpaqueIdentifiers(output);

  return normalizeSpeechWhitespace(output);
}

function sourceOffsetForLine(lineStarts: number[], index: number, totalLength: number): number {
  return index >= lineStarts.length ? totalLength : lineStarts[index] ?? totalLength;
}

export function projectSpeech(input: string, options: SpeechProjectionOptions = {}): SpeechProjectionResult {
  if (options.exact) {
    const speechText = normalizeSpeechWhitespace(input);
    return {
      speechText,
      segments: speechText
        ? [{
            kind: "speakable_text",
            screenText: input,
            speechText,
            start: 0,
            end: input.length,
            confidence: 1,
            reason: "exact read requested"
          }]
        : [],
      suppressedChars: 0,
      warnings: []
    };
  }

  const normalized = input.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  const output: string[] = [];
  const segments: SpeechProjectionSegment[] = [];
  const warnings: string[] = [];
  let suppressedChars = 0;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const start = sourceOffsetForLine(lineStarts, index, normalized.length);
    const fence = line.match(/^\s*```([A-Za-z0-9_-]*)/);

    if (fence) {
      const language = fence[1] ?? "";
      let endIndex = index + 1;
      while (endIndex < lines.length && !/^\s*```/.test(lines[endIndex] ?? "")) endIndex += 1;
      if (endIndex < lines.length) endIndex += 1;
      const end = sourceOffsetForLine(lineStarts, endIndex, normalized.length);
      const screenText = normalized.slice(start, end);
      const cue = cueForFence(language);
      stripCueDuplicate(output, cue.cue);
      suppressedChars += screenText.length;
      appendSegment(segments, cue.kind, screenText, cue.cue, start, end, cue.reason);
      index = endIndex;
      continue;
    }

    if (isTableStart(lines, index)) {
      const endIndex = tableEnd(lines, index);
      const end = sourceOffsetForLine(lineStarts, endIndex, normalized.length);
      const screenText = normalized.slice(start, end);
      stripCueDuplicate(output, tableCue);
      suppressedChars += screenText.length;
      appendSegment(segments, "table", screenText, tableCue, start, end, "markdown table");
      index = endIndex;
      continue;
    }

    const jsonEnd = blockEndByPredicate(lines, index, (candidate) => candidate.trim() !== "");
    const jsonCandidate = lines.slice(index, Math.min(jsonEnd, index + 20)).join("\n");
    if (likelyJsonBlock(jsonCandidate)) {
      const endIndex = jsonEnd;
      const end = sourceOffsetForLine(lineStarts, endIndex, normalized.length);
      const screenText = normalized.slice(start, end);
      stripCueDuplicate(output, jsonCue);
      suppressedChars += screenText.length;
      appendSegment(segments, "json_block", screenText, jsonCue, start, end, "json-like block", 0.88);
      index = endIndex;
      continue;
    }

    if (likelyDiffStart(line)) {
      const endIndex = blockEndByPredicate(lines, index, likelyDiffContinuation);
      const end = sourceOffsetForLine(lineStarts, endIndex, normalized.length);
      const screenText = normalized.slice(start, end);
      stripCueDuplicate(output, diffCue);
      suppressedChars += screenText.length;
      appendSegment(segments, "diff", screenText, diffCue, start, end, "diff-like lines", 0.86);
      index = endIndex;
      continue;
    }

    if (likelyLogBlock(lines, index)) {
      const endIndex = blockEndByPredicate(lines, index, (candidate) =>
        candidate.trim() === "" || /\b(Error|Exception|Traceback|at\s+\S+:\d+:\d+|\[[A-Z]+\])\b/.test(candidate)
      );
      const end = sourceOffsetForLine(lineStarts, endIndex, normalized.length);
      const screenText = normalized.slice(start, end);
      stripCueDuplicate(output, logCue);
      suppressedChars += screenText.length;
      appendSegment(segments, "log", screenText, logCue, start, end, "log-like lines", 0.82);
      index = endIndex;
      continue;
    }

    const projected = projectInline(line);
    if (projected) {
      output.push(projected);
      appendSegment(segments, "speakable_text", line, projected, start, start + line.length);
    }
    index += 1;
  }

  const speechText = normalizeSpeechWhitespace(output.join("\n"));
  if (!speechText && input.trim()) warnings.push("All input was suppressed by speech projection.");
  return {
    speechText,
    segments,
    suppressedChars,
    warnings
  };
}

export function shouldUseExactSpeechProjection(userText: string): boolean {
  const normalized = userText.toLowerCase();
  return (
    /\bread\b[^.?!\n]{0,80}\b(code|snippet|json|diff|table|log|output)\b[^.?!\n]{0,80}\b(exactly|verbatim|literally|aloud)\b/.test(normalized) ||
    /\b(exactly|verbatim|literally)\b[^.?!\n]{0,80}\bread\b/.test(normalized) ||
    /\bread this\b[^.?!\n]{0,80}\b(exactly|verbatim|literally)\b/.test(normalized)
  );
}
