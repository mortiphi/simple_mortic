export type BargeInSpeechPhase = "idle" | "buffering" | "speaking";

export type BargeInActivityInput = {
  pending: boolean;
  speechPhase: BargeInSpeechPhase;
  speaking: boolean;
  speechQueueLength: number;
  progressSpeechActive: boolean;
  liveAssistantText?: string;
};

export function hasAssistantOutputForBargeIn(input: BargeInActivityInput): boolean {
  return (
    input.pending ||
    input.speechPhase !== "idle" ||
    input.speaking ||
    input.speechQueueLength > 0 ||
    input.progressSpeechActive ||
    Boolean(input.liveAssistantText?.trim())
  );
}
