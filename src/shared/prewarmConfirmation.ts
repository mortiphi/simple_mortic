import type { ScratchMode } from "./types.js";
import { redactThreadId } from "./threadUri.js";

export function normalizedPrewarmConfirmation(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim()
    .toLowerCase();
}

export function prewarmThreadName(threadId: string): string {
  return `thread ${redactThreadId(threadId)}`;
}

export function prewarmReadyText(threadName: string): string {
  return `I am ready to continue work on ${threadName}`;
}

export function prewarmConfirmationPrompt(params: { threadName: string; scratchMode: ScratchMode }): {
  prompt: string;
  expected: string;
} {
  const expected = prewarmReadyText(params.threadName);
  if (params.scratchMode === "voice") {
    return {
      expected,
      prompt: `Prewarm confirmation only. Do not inspect files and do not use tools.

Return exactly two newline-delimited JSON objects and nothing else.
Line 1 must be exactly {"type":"speak","text":"${expected}"}
Line 2 must be exactly {"type":"read","markdown":""}`
    };
  }

  return {
    expected,
    prompt: `Prewarm confirmation only. Do not inspect files and do not use tools.

Reply with exactly this sentence and nothing else:
${expected}`
  };
}
