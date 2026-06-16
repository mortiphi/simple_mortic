export type ParsedThreadUri = {
  sourceUri: string;
  threadId: string;
};

const THREAD_URI_PATTERN = /^codex:\/\/threads\/([^/?#]+)(?:[/?#].*)?$/i;
const UUID_LIKE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseThreadUri(input: string | undefined): ParsedThreadUri {
  const raw = input?.trim();

  if (!raw) {
    throw new Error("Pass a Codex thread URI, for example: npx mortic codex://threads/<thread-id>");
  }

  const uriMatch = raw.match(THREAD_URI_PATTERN);
  if (uriMatch?.[1]) {
    const threadId = decodeURIComponent(uriMatch[1]);
    return {
      sourceUri: `codex://threads/${threadId}`,
      threadId
    };
  }

  if (UUID_LIKE_PATTERN.test(raw)) {
    return {
      sourceUri: `codex://threads/${raw}`,
      threadId: raw
    };
  }

  throw new Error(`Unsupported Codex thread reference: ${raw}`);
}

export function redactThreadId(threadId: string): string {
  if (threadId.length <= 12) {
    return threadId;
  }

  return `${threadId.slice(0, 8)}...${threadId.slice(-6)}`;
}
