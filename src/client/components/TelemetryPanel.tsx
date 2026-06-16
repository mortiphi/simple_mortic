import type { TurnRun } from "../../shared/types.js";
import type { AudioHealthState } from "../lib/clientTypes.js";
import { effortLabels, modeLabels, sttProviderLabels, transportLabels, ttsProviderLabels } from "../lib/labels.js";
import { formatBytes, formatMs, formatSignedMs } from "../lib/format.js";
import { isBufferedTtsProvider, isStreamingWsProvider } from "../lib/voice.js";

export type TelemetryPanelProps = {
  activeTurn: TurnRun;
  uiDispatchMs: number | null | undefined;
  pending: boolean;
  speechPhase: string;
  visibleAudioHealth: AudioHealthState | null | undefined;
};

export function TelemetryPanel({ activeTurn, uiDispatchMs, pending, speechPhase, visibleAudioHealth }: TelemetryPanelProps) {
  const serverToClientMs =
    activeTurn.metrics.firstDeltaMs !== undefined && visibleAudioHealth?.firstClientDeltaMs !== undefined
      ? Math.max(0, visibleAudioHealth.firstClientDeltaMs - activeTurn.metrics.firstDeltaMs)
      : undefined;
  const clientToQueuedMs =
    visibleAudioHealth?.firstClientDeltaMs !== undefined && visibleAudioHealth.firstSpeechQueuedMs !== undefined
      ? Math.max(0, visibleAudioHealth.firstSpeechQueuedMs - visibleAudioHealth.firstClientDeltaMs)
      : undefined;
  const queuedToSpeechMs =
    visibleAudioHealth?.firstSpeechQueuedMs !== undefined && visibleAudioHealth.firstSpeechStartMs !== undefined
      ? Math.max(0, visibleAudioHealth.firstSpeechStartMs - visibleAudioHealth.firstSpeechQueuedMs)
      : undefined;
  const queuedToTtsRequestMs =
    visibleAudioHealth?.firstSpeechQueuedMs !== undefined && visibleAudioHealth.firstTtsRequestMs !== undefined
      ? Math.max(0, visibleAudioHealth.firstTtsRequestMs - visibleAudioHealth.firstSpeechQueuedMs)
      : undefined;
  const ttsRequestToResolvedMs =
    visibleAudioHealth?.firstTtsRequestMs !== undefined && visibleAudioHealth.firstTtsResolvedMs !== undefined
      ? Math.max(0, visibleAudioHealth.firstTtsResolvedMs - visibleAudioHealth.firstTtsRequestMs)
      : undefined;

  return (
    <section className={`progress-panel progress-${activeTurn.status}`}>
      <div className="progress-header">
        <div>
          <h2>
            {activeTurn.status === "running"
              ? "Thinking"
              : activeTurn.status === "completed"
                ? "Turn Complete"
                : activeTurn.status === "interrupted"
                  ? "Turn Interrupted"
                  : "Turn Failed"}
          </h2>
          <p>
            UI dispatch {formatMs(uiDispatchMs ?? activeTurn.metrics.serverAcceptMs)} · Codex{" "}
            {formatMs(activeTurn.metrics.codexLatencyMs)} · total {formatMs(activeTurn.metrics.totalMs)}
          </p>
          {(activeTurn.metrics.appTurnStartMs !== undefined || activeTurn.metrics.firstDeltaMs !== undefined) && (
            <p>
              Startup {formatMs(activeTurn.metrics.appTurnStartMs)} · model wait{" "}
              {formatMs(activeTurn.metrics.modelWaitMs)} · output {formatMs(activeTurn.metrics.outputMs)}
            </p>
          )}
          {pending && <p>Voice {speechPhase === "speaking" ? "speaking" : speechPhase === "buffering" ? "buffering" : "idle"}</p>}
        </div>
        <div className="progress-badge">
          {modeLabels[activeTurn.scratchMode ?? "text"]} · {activeTurn.codexModel} · {effortLabels[activeTurn.reasoningEffort]}
          {activeTurn.scratchMode === "voice" ? ` · Caveman ${activeTurn.voiceCaveman ? "on" : "off"}` : ""}
        </div>
      </div>
      <div className="metrics-row">
        <span>Transcript {activeTurn.metrics.transcriptBytes ?? "-"} bytes</span>
        <span>Prompt {activeTurn.metrics.promptBytes ?? "-"} bytes</span>
        <span>Est. {activeTurn.metrics.promptTokensEstimate ?? "-"} tokens</span>
        {activeTurn.metrics.sttProvider && (
          <span>
            STT {sttProviderLabels[activeTurn.metrics.sttProvider]} · {activeTurn.metrics.sttSegmentCount ?? 1} segments ·{" "}
            {formatBytes(activeTurn.metrics.sttPayloadBytes)}
          </span>
        )}
        {activeTurn.metrics.transportProvider && (
          <span>
            Transport {transportLabels[activeTurn.metrics.transportProvider]} · {activeTurn.metrics.transportState ?? "-"} · RTT{" "}
            {formatMs(activeTurn.metrics.transportRttMs)}
          </span>
        )}
      </div>
      {(activeTurn.metrics.recordingDurationMs !== undefined || activeTurn.metrics.transportProvider) && (
        <div className="audio-timing">
          recording {formatMs(activeTurn.metrics.recordingDurationMs)} · first speech{" "}
          {formatMs(activeTurn.metrics.firstSpeechDetectedMs)} · STT ready {formatMs(activeTurn.metrics.finalSttReadyMs)} · send after
          speech {formatMs(activeTurn.metrics.sendAfterSpeechMs)} · segments {activeTurn.metrics.sttSegmentCount ?? "-"} · payload{" "}
          {formatBytes(activeTurn.metrics.sttPayloadBytes)}
          {activeTurn.metrics.transportProvider && (
            <>
              {" "}
              · packet loss {activeTurn.metrics.transportPacketLoss ?? "-"} · jitter {formatMs(activeTurn.metrics.transportJitterMs)} · reconnects{" "}
              {activeTurn.metrics.transportReconnects ?? 0} · track {activeTurn.metrics.transportTrackState ?? "-"} · muted{" "}
              {activeTurn.metrics.transportMuted ? "yes" : "no"}
            </>
          )}
        </div>
      )}
      {visibleAudioHealth && (
        <>
          <div className="audio-timing">
            text first {formatMs(activeTurn.metrics.firstDeltaMs)} · visible {formatMs(visibleAudioHealth.firstVisibleTextMs)} ·
            speakable {formatMs(visibleAudioHealth.firstSpeakableTextMs)} · queued {formatMs(visibleAudioHealth.firstSpeechQueuedMs)} ·
            speech start {formatMs(visibleAudioHealth.firstSpeechStartMs)} · client delta {formatMs(visibleAudioHealth.firstClientDeltaMs)} ·
            server to client {formatMs(serverToClientMs)} · client to queued {formatMs(clientToQueuedMs)} · queued to speech{" "}
            {formatMs(queuedToSpeechMs)} · queued to TTS {formatMs(queuedToTtsRequestMs)} · TTS resolve{" "}
            {formatMs(ttsRequestToResolvedMs)}
            {isBufferedTtsProvider(visibleAudioHealth.provider) && (
              <>
                {" "}
                · {isStreamingWsProvider(visibleAudioHealth.provider) ? "ws connect" : "tts response"}{" "}
                {formatMs(visibleAudioHealth.ttsConnectMs)}
                · audio bytes {formatMs(visibleAudioHealth.firstAudioChunkMs)} ·
                audio play {formatMs(visibleAudioHealth.firstAudioPlayMs)}
              </>
            )}{" "}
            · final {formatMs(visibleAudioHealth.finalTextMs)} ·
            speech after final {formatSignedMs(visibleAudioHealth.speechAfterFinalMs)}
          </div>
          {visibleAudioHealth.ttsProviderStatus && <div className="tts-status-line">{visibleAudioHealth.ttsProviderStatus}</div>}
          <div className={`audio-health${visibleAudioHealth.ttsError ? " audio-health-error" : ""}`}>
            <span>{ttsProviderLabels[visibleAudioHealth.provider]}</span>
            <span>Streamed {visibleAudioHealth.streamedChars} chars</span>
            <span>Final {visibleAudioHealth.finalChars ?? "-"} chars</span>
            <span>Queued {visibleAudioHealth.queuedChars ?? 0} chars</span>
            <span>Spoken {visibleAudioHealth.spokenChars ?? 0} chars</span>
            <span>Chunks {visibleAudioHealth.spokenChunks}</span>
            {isBufferedTtsProvider(visibleAudioHealth.provider) && <span>Underruns {visibleAudioHealth.audioBufferUnderruns ?? 0}</span>}
            {(visibleAudioHealth.provider === "elevenlabs-ws" || visibleAudioHealth.provider === "inworld-ws") && (
              <span>
                Close {visibleAudioHealth.ttsCloseCode ?? "-"}
                {visibleAudioHealth.ttsCloseReason ? ` ${visibleAudioHealth.ttsCloseReason}` : ""}
              </span>
            )}
            <span>Queued ranges {visibleAudioHealth.queuedRanges || "-"}</span>
            <span>Spoken ranges {visibleAudioHealth.spokenRanges || "-"}</span>
            <span>{visibleAudioHealth.ttsError ? `TTS error: ${visibleAudioHealth.ttsError}` : "TTS ok"}</span>
          </div>
        </>
      )}
      <ol className="turn-log">
        {activeTurn.logs.map((log) => (
          <li key={log.id}>
            <span>{formatMs(log.elapsedMs)}</span>
            <strong>{log.label}</strong>
            {log.detail && <em>{log.detail}</em>}
          </li>
        ))}
      </ol>
    </section>
  );
}
