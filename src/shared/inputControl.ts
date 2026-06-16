export type KeyboardIntent =
  | "toggle-live"
  | "push-to-talk-down"
  | "push-to-talk-up"
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
  if (isPushToTalkKey(input) && !input.repeat && !input.liveModeActive) return "push-to-talk-down";
  return "ignore";
}

export function keyboardIntentForKeyUp(input: KeyboardIntentInput): KeyboardIntent {
  if (input.code === "MetaLeft" || input.code === "MetaRight" || input.code === "ShiftLeft" || input.code === "ShiftRight") {
    return "reset-live-toggle";
  }
  if (input.editableTarget) return "ignore";
  if (isPushToTalkKey(input) && !input.liveModeActive) return "push-to-talk-up";
  return "ignore";
}

function isPushToTalkKey(input: KeyboardIntentInput): boolean {
  return input.code === "KeyM" || input.key?.toLowerCase() === "m";
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

export function interruptResumeAction(input: { liveModeActive: boolean; pushToTalkHeld: boolean }): InterruptResumeAction {
  if (input.liveModeActive) return "listen-live";
  if (input.pushToTalkHeld) return "capture-push-to-talk";
  return "idle";
}
