import assert from "node:assert/strict";

import {
  interruptResumeAction,
  isCurrentRecognitionSession,
  isEditableShortcutTarget,
  keyboardIntentForKeyDown,
  keyboardIntentForKeyUp,
  shouldSubmitCapturedTurn
} from "../dist/node/shared/inputControl.js";
import { hasAssistantOutputForBargeIn } from "../dist/node/shared/bargeInControl.js";

assert.equal(
  keyboardIntentForKeyDown({ code: "ShiftLeft", metaKey: true, shiftKey: true }),
  "toggle-live",
  "Cmd+Shift should toggle Live once"
);
assert.equal(
  keyboardIntentForKeyDown({ code: "ShiftLeft", metaKey: true, shiftKey: true, repeat: true }),
  "ignore",
  "holding Cmd+Shift must not repeatedly toggle from key repeat"
);
assert.equal(
  keyboardIntentForKeyDown({ code: "ShiftLeft", metaKey: true, shiftKey: true, liveToggleArmed: true }),
  "ignore",
  "holding the Cmd+Shift chord must stay debounced until keyup"
);
assert.equal(
  keyboardIntentForKeyUp({ code: "MetaLeft" }),
  "reset-live-toggle",
  "releasing Command should re-arm the Live toggle"
);
assert.equal(
  keyboardIntentForKeyUp({ code: "ShiftRight" }),
  "reset-live-toggle",
  "releasing Shift should re-arm the Live toggle"
);

assert.equal(
  keyboardIntentForKeyDown({ code: "KeyM", key: "m", liveModeActive: false }),
  "push-to-talk-down",
  "M starts push-to-talk only when Live is off"
);
assert.equal(
  keyboardIntentForKeyUp({ code: "KeyM", key: "m", liveModeActive: false }),
  "push-to-talk-up",
  "M release stops push-to-talk only when Live is off"
);
assert.equal(
  keyboardIntentForKeyDown({ code: "KeyM", key: "m", liveModeActive: true }),
  "ignore",
  "M must not control Live mode"
);
assert.equal(
  keyboardIntentForKeyUp({ code: "KeyM", key: "m", liveModeActive: true }),
  "ignore",
  "M release is ignored while Live mode owns capture"
);
assert.equal(
  keyboardIntentForKeyDown({ code: "Space", liveModeActive: false }),
  "ignore",
  "Space must not start push-to-talk"
);
assert.equal(
  keyboardIntentForKeyUp({ code: "Space", liveModeActive: false }),
  "ignore",
  "Space release must not stop push-to-talk"
);

for (const target of [
  { tagName: "INPUT" },
  { tagName: "TEXTAREA" },
  { tagName: "SELECT" },
  { tagName: "DIV", isContentEditable: true }
]) {
  assert.equal(isEditableShortcutTarget(target), true);
  assert.equal(
    keyboardIntentForKeyDown({
      code: "KeyM",
      key: "m",
      editableTarget: isEditableShortcutTarget(target),
      liveModeActive: false
    }),
    "ignore",
    "editable targets should receive normal typing"
  );
  assert.equal(
    keyboardIntentForKeyDown({
      code: "ShiftLeft",
      metaKey: true,
      shiftKey: true,
      editableTarget: isEditableShortcutTarget(target)
    }),
    "ignore",
    "editable targets should suppress global Live shortcut"
  );
}

assert.equal(isEditableShortcutTarget({ tagName: "BUTTON" }), false);

assert.equal(isCurrentRecognitionSession(3, 3), true, "current recognition callbacks should be accepted");
assert.equal(isCurrentRecognitionSession(4, 3), false, "stale recognition callbacks should be ignored");

assert.equal(
  shouldSubmitCapturedTurn({ submitRequested: true, speechDetected: true, transcriptText: "hello" }),
  true,
  "speech with text should submit"
);
assert.equal(
  shouldSubmitCapturedTurn({ submitRequested: true, speechDetected: false, transcriptText: "hello" }),
  false,
  "push-to-talk release before speech should discard"
);
assert.equal(
  shouldSubmitCapturedTurn({ submitRequested: true, speechDetected: true, transcriptText: "   " }),
  false,
  "empty transcripts should discard"
);
assert.equal(
  shouldSubmitCapturedTurn({ submitRequested: false, speechDetected: true, transcriptText: "hello" }),
  false,
  "cancel/interrupt should not submit captured speech"
);

assert.equal(
  interruptResumeAction({ liveModeActive: true, pushToTalkHeld: false }),
  "listen-live",
  "interrupt in Live mode returns to listening"
);
assert.equal(
  interruptResumeAction({ liveModeActive: false, pushToTalkHeld: true }),
  "capture-push-to-talk",
  "interrupt in push-to-talk resumes capture only if M is still held"
);
assert.equal(
  interruptResumeAction({ liveModeActive: false, pushToTalkHeld: false }),
  "idle",
  "interrupt in idle push-to-talk stays idle"
);

assert.equal(
  hasAssistantOutputForBargeIn({
    pending: true,
    speechPhase: "idle",
    speaking: false,
    speechQueueLength: 0,
    progressSpeechActive: false,
    liveAssistantText: ""
  }),
  true,
  "barge-in should mute future assistant speech while a turn is still pending"
);
assert.equal(
  hasAssistantOutputForBargeIn({
    pending: false,
    speechPhase: "speaking",
    speaking: false,
    speechQueueLength: 0,
    progressSpeechActive: false,
    liveAssistantText: ""
  }),
  true,
  "barge-in should mute while speech phase is active"
);
assert.equal(
  hasAssistantOutputForBargeIn({
    pending: false,
    speechPhase: "idle",
    speaking: false,
    speechQueueLength: 0,
    progressSpeechActive: false,
    liveAssistantText: "buffered assistant text"
  }),
  true,
  "barge-in should still mute post-completion buffered playback"
);
assert.equal(
  hasAssistantOutputForBargeIn({
    pending: false,
    speechPhase: "idle",
    speaking: false,
    speechQueueLength: 0,
    progressSpeechActive: false,
    liveAssistantText: ""
  }),
  false,
  "idle push-to-talk should not be treated as barge-in"
);

console.log("Input control checks passed");
