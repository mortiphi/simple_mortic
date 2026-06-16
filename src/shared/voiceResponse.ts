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

function parseJsonStringPrefix(source: string, quoteIndex: number): { value: string; closed: boolean; nextIndex: number } | null {
  if (source[quoteIndex] !== "\"") return null;
  let value = "";
  let index = quoteIndex + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === "\"") {
      return { value, closed: true, nextIndex: index + 1 };
    }
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) return { value, closed: false, nextIndex: index };
    switch (escaped) {
      case "\"":
      case "\\":
      case "/":
        value += escaped;
        index += 2;
        break;
      case "b":
        value += "\b";
        index += 2;
        break;
      case "f":
        value += "\f";
        index += 2;
        break;
      case "n":
        value += "\n";
        index += 2;
        break;
      case "r":
        value += "\r";
        index += 2;
        break;
      case "t":
        value += "\t";
        index += 2;
        break;
      case "u": {
        const hex = source.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, closed: false, nextIndex: index };
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        break;
      }
      default:
        return { value, closed: false, nextIndex: index };
    }
  }

  return { value, closed: false, nextIndex: index };
}

function skipJsonWhitespace(source: string, index: number): number {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

function skipJsonPrimitive(source: string, index: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      if (depth === 0) return index;
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) return index;
  }
  return index;
}

function partialSpeakTextFromOpenJson(rawText: string): string {
  const raw = rawText.trimStart();
  if (!raw.startsWith("{")) return "";

  let index = 1;
  let typeValue: string | undefined;

  while (index < raw.length) {
    index = skipJsonWhitespace(raw, index);
    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    if (raw[index] === "}") return "";
    const key = parseJsonStringPrefix(raw, index);
    if (!key?.closed) return "";
    index = skipJsonWhitespace(raw, key.nextIndex);
    if (raw[index] !== ":") return "";
    index = skipJsonWhitespace(raw, index + 1);

    if (raw[index] === "\"") {
      const value = parseJsonStringPrefix(raw, index);
      if (!value) return "";
      if (key.value === "type") {
        if (!value.closed) return "";
        typeValue = value.value;
      }
      if (key.value === "text") {
        return typeValue === "speak" ? cleanText(value.value) : "";
      }
      index = value.closed ? value.nextIndex : raw.length;
      continue;
    }

    index = skipJsonPrimitive(raw, index);
  }

  return "";
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

  if (!lines[1]) {
    return {
      ok: false,
      parserMode: "invalid",
      error: 'missing line 2 read record',
      rawText
    };
  }

  if (lines.length > 2) {
    return {
      ok: false,
      parserMode: "invalid",
      error: `voice response must contain exactly 2 NDJSON records; got ${lines.length}`,
      rawText
    };
  }

  const readParse = parseJsonVoiceRecord(lines[1]);
  const read = readParse.record;
  if (read?.type !== "read" || typeof read.markdown !== "string") {
    return {
      ok: false,
      parserMode: "invalid",
      error: readParse.error ?? 'line 2 must be {"type":"read","markdown":string}',
      rawText
    };
  }
  const notesText = cleanText(read.markdown) || undefined;

  return {
    ok: true,
    parts: {
      displayText: spokenText,
      spokenText,
      notesText,
      parserMode: "ndjson"
    }
  };
}

export function partialSpokenText(rawText: string): string {
  const raw = rawText.trimStart();
  if (!raw) return "";

  const firstLineEnd = raw.search(/\r?\n/);
  if (firstLineEnd < 0) return partialSpeakTextFromOpenJson(raw);

  const firstLine = raw.slice(0, firstLineEnd).trim();
  if (!firstLine) return "";

  const speakParse = parseJsonVoiceRecord(firstLine);
  const speak = speakParse.record;
  if (speak?.type !== "speak" || typeof speak.text !== "string") return "";
  return cleanText(speak.text);
}
