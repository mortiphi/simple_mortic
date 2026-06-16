import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalAudioTrack
} from "livekit-client";

import type { LiveKitTokenResponse, TransportState } from "../shared/types.js";

const LIVEKIT_CONNECT_TIMEOUT_MS = 8000;

export type LiveKitTransportStats = {
  packetLoss?: number;
  jitterMs?: number;
  rttMs?: number;
  reconnects: number;
  trackState: string;
  muted: boolean;
  audioLevel: number;
};

export type LiveKitTransportCallbacks = {
  onState?: (state: TransportState) => void;
  onStats?: (stats: LiveKitTransportStats) => void;
  onError?: (error: string) => void;
};

function mapConnectionState(state: ConnectionState): TransportState {
  if (state === ConnectionState.Connecting) return "connecting";
  if (state === ConnectionState.Connected) return "connected";
  if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) return "reconnecting";
  return "disconnected";
}

function audioPublicationTrack(room: Room): LocalAudioTrack | undefined {
  const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = publication?.track;
  return track?.kind === Track.Kind.Audio ? (track as LocalAudioTrack) : undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

export class MorticLiveKitTransport {
  private room?: Room;
  private statsTimer?: number;
  private reconnects = 0;

  constructor(
    private readonly api: string,
    private readonly callbacks: LiveKitTransportCallbacks = {}
  ) {}

  async connect(roomName: string): Promise<void> {
    await this.disconnect();
    const response = await fetch(`${this.api}/api/livekit/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        roomName,
        identity: `mortic-browser-${Math.random().toString(36).slice(2, 8)}`
      })
    });
    const token = (await response.json()) as LiveKitTokenResponse;
    if (!response.ok || !token.configured || !token.url || !token.token) {
      throw new Error(token.error ?? "LiveKit is not configured.");
    }

    const room = new Room({
      adaptiveStream: false,
      dynacast: false
    });
    this.room = room;
    this.reconnects = 0;
    this.callbacks.onState?.("connecting");

    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      const mapped = mapConnectionState(state);
      if (mapped === "reconnecting") this.reconnects += 1;
      this.callbacks.onState?.(mapped);
    });
    room.on(RoomEvent.Disconnected, () => {
      this.callbacks.onState?.("disconnected");
      this.stopStats();
    });
    room.on(RoomEvent.MediaDevicesError, (error) => {
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    });

    try {
      await withTimeout(
        room.connect(token.url, token.token, {
          autoSubscribe: true
        }),
        LIVEKIT_CONNECT_TIMEOUT_MS,
        "LiveKit WebRTC connection"
      );
    } catch (error) {
      room.disconnect();
      this.room = undefined;
      throw error;
    }
    // Keep the WebRTC room warm without requesting microphone permission on page load.
    // LiveKit prompts for browser mic access when setMicrophoneEnabled(true) runs,
    // so Mortic only publishes the mic during explicit PTT or Live capture.
    this.startStats();
  }

  async setMuted(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(!muted, {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    });
    this.emitStats();
  }

  async disconnect(): Promise<void> {
    this.stopStats();
    const room = this.room;
    this.room = undefined;
    if (room) {
      await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      room.disconnect();
    }
    this.callbacks.onState?.("disconnected");
  }

  private startStats(): void {
    this.stopStats();
    this.emitStats();
    this.statsTimer = window.setInterval(() => {
      this.emitStats();
    }, 1000);
  }

  private stopStats(): void {
    if (this.statsTimer !== undefined) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }
  }

  private async emitStats(): Promise<void> {
    const room = this.room;
    const track = room ? audioPublicationTrack(room) : undefined;
    const stats = track ? await track.getSenderStats().catch(() => undefined) : undefined;
    this.callbacks.onStats?.({
      packetLoss: stats?.packetsLost,
      jitterMs: typeof stats?.jitter === "number" ? Math.round(stats.jitter * 1000) : undefined,
      rttMs: typeof stats?.roundTripTime === "number" ? Math.round(stats.roundTripTime * 1000) : undefined,
      reconnects: this.reconnects,
      trackState: track?.mediaStreamTrack.readyState ?? (room ? "not-published" : "none"),
      muted: track?.isMuted ?? true,
      audioLevel: room?.localParticipant.audioLevel ?? 0
    });
  }
}
