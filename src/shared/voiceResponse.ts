export type VoiceParserMode = "ndjson" | "invalid";

export type VoiceResponseParts = {
  displayText: string;
  spokenText: string;
  notesText?: string;
  parserMode: VoiceParserMode;
  parserError?: string;
};

export type VoiceParseResult =
  | {
      ok: true;
      parts: VoiceResponseParts;
    }
  | {
      ok: false;
      parserMode: "invalid";
      error: string;
      rawText: string;
    };

type JsonVoiceRecord = {
  type?: unknown;
  text?: unknown;
  markdown?: unknown;
};

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function physicalLines(rawText: string): string[] {
  return rawText.replace(/\r\n/g, "\n").split("\n");
}

function nonEmptyLines(rawText: string): string[] {
  return physicalLines(rawText)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseJsonVoiceRecord(line: string): { record?: JsonVoiceRecord; error?: string } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "line is not a JSON object" };
    }
    return { record: parsed as JsonVoiceRecord };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parserWarningMarkdown(message: string, raw?: string): string {
  const rawBlock = raw ? `\n\nRaw payload:\n\n\`\`\`text\n${raw.trim()}\n\`\`\`` : "";
  return `Mortic parser warning: ${message}${rawBlock}`;
}

export function parseMorticVoice(rawText: string): VoiceParseResult {
  const raw = rawText.trim();
  if (!raw) {
    return {
      ok: false,
      parserMode: "invalid",
      error: "empty voice response",
      rawText
    };
  }

  const lines = nonEmptyLines(raw);
  if (lines.length === 0) {
    return {
      ok: false,
      parserMode: "invalid",
      error: "voice response did not contain NDJSON lines",
      rawText
    };
  }

  const speakParse = parseJsonVoiceRecord(lines[0]);
  const speak = speakParse.record;
  if (!speak || speak.type !== "speak" || typeof speak.text !== "string") {
    return {
      ok: false,
      parserMode: "invalid",
      error: speakParse.error ?? 'line 1 must be {"type":"speak","text":string}',
      rawText
    };
  }

  const spokenText = cleanText(speak.text);
  if (!spokenText) {
    return {
      ok: false,
      parserMode: "invalid",
      error: "line 1 speak.text is empty",
      rawText
    };
  }

  let notesText: string | undefined;
  let parserError: string | undefined;

  if (!lines[1]) {
    parserError = 'missing line 2 read record';
    notesText = parserWarningMarkdown(parserError);
  } else {
    const readParse = parseJsonVoiceRecord(lines[1]);
    const read = readParse.record;
    if (read?.type === "read" && typeof read.markdown === "string") {
      notesText = cleanText(read.markdown) || undefined;
    } else {
      parserError = readParse.error ?? 'line 2 must be {"type":"read","markdown":string}';
      notesText = parserWarningMarkdown(parserError, lines.slice(1).join("\n"));
    }
  }

  if (lines.length > 2) {
    const extraWarning = `ignored ${lines.length - 2} extra NDJSON line${lines.length === 3 ? "" : "s"}`;
    parserError = parserError ? `${parserError}; ${extraWarning}` : extraWarning;
    const warning = parserWarningMarkdown(extraWarning, lines.slice(2).join("\n"));
    notesText = notesText ? `${notesText}\n\n${warning}` : warning;
  }

  return {
    ok: true,
    parts: {
      displayText: spokenText,
      spokenText,
      notesText,
      parserMode: "ndjson",
      parserError
    }
  };
}

export function partialSpokenText(rawText: string): string {
  const raw = rawText.trimStart();
  if (!raw) return "";

  const firstLineEnd = raw.search(/\r?\n/);
  if (firstLineEnd < 0) return "";

  const firstLine = raw.slice(0, firstLineEnd).trim();
  if (!firstLine) return "";

  const speakParse = parseJsonVoiceRecord(firstLine);
  const speak = speakParse.record;
  if (speak?.type !== "speak" || typeof speak.text !== "string") return "";
  return cleanText(speak.text);
}
