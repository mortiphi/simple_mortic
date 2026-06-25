import type { ReasoningEffort, ScratchMode } from "./types.js";

// Single source of truth for the scratch settings a fresh client starts with.
// The CLI boot prewarm must warm the exact same scratch-fork cache key the
// first browser prewarm will request, or the boot warm is wasted and the
// first user turn queues behind a second fork.
export const defaultScratchSettings: {
  scratchMode: ScratchMode;
  reasoningEffort: ReasoningEffort;
} = {
  scratchMode: "voice",
  reasoningEffort: "none"
};
