export type KeyboardIntent =
  | "toggle-live"
  | "space-down"
  | "space-up"
  | "reset-live-toggle"
  | "ignore";

export type KeyboardIntentInput = {
  code: string;
  key?: string;
  repeat?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  editableTarget?: boolean;
  liveToggleArmed?: boolean;
  liveModeActive?: boolean;
};

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element) return false;
  const tagName = element.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || Boolean(element.isContentEditable);
}

export function keyboardIntentForKeyDown(input: KeyboardIntentInput): KeyboardIntent {
  if (input.editableTarget) return "ignore";
  if (input.metaKey && input.shiftKey && !input.liveToggleArmed && !input.repeat) return "toggle-live";
  if (input.code === "Space" && !input.repeat && !input.liveModeActive) return "space-down";
  return "ignore";
}

export function keyboardIntentForKeyUp(input: KeyboardIntentInput): KeyboardIntent {
  if (input.code === "MetaLeft" || input.code === "MetaRight" || input.code === "ShiftLeft" || input.code === "ShiftRight") {
    return "reset-live-toggle";
  }
  if (input.editableTarget) return "ignore";
  if (input.code === "Space" && !input.liveModeActive) return "space-up";
  return "ignore";
}

export function isCurrentRecognitionSession(activeSessionId: number, callbackSessionId: number): boolean {
  return activeSessionId === callbackSessionId;
}

export function shouldSubmitCapturedTurn(input: {
  submitRequested: boolean;
  speechDetected: boolean;
  transcriptText?: string;
}): boolean {
  return input.submitRequested && input.speechDetected && Boolean(input.transcriptText?.trim());
}

export type InterruptResumeAction = "listen-live" | "capture-push-to-talk" | "idle";

export function interruptResumeAction(input: { liveModeActive: boolean; spaceHeld: boolean }): InterruptResumeAction {
  if (input.liveModeActive) return "listen-live";
  if (input.spaceHeld) return "capture-push-to-talk";
  return "idle";
}
