import type {
  AudioCommandRequest,
  AudioLeasePhase,
  AudioLeaseState,
  ClientPresenceRequest,
  ClientSurface,
  SessionStreamEvent
} from "../shared/types.js";

type ClientRecord = {
  clientId: string;
  surface: ClientSurface;
  focused: boolean;
  visible: boolean;
  lastSeenAt: number;
};

export class SessionCoordinator {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly listeners = new Set<(event: SessionStreamEvent) => void>();
  private lease: AudioLeaseState = { phase: "idle", epoch: 0 };

  constructor(private readonly onLeaseChange: (reason: string) => void) {}

  subscribe(listener: (event: SessionStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state(): AudioLeaseState {
    return { ...this.lease };
  }

  presence(request: ClientPresenceRequest): AudioLeaseState {
    const now = Date.now();
    this.clients.set(request.clientId, {
      clientId: request.clientId,
      surface: request.surface,
      focused: request.focused,
      visible: request.visible,
      lastSeenAt: now
    });

    let changed = false;
    if (request.focused && request.visible) {
      changed = this.requestOwnership(request.clientId, request.surface) || changed;
    }
    if (this.lease.ownerClientId === request.clientId && request.audioPhase) {
      changed = this.lease.phase !== request.audioPhase || changed;
      this.lease = { ...this.lease, phase: request.audioPhase };
    }
    if (!request.visible && this.lease.ownerClientId === request.clientId && this.lease.phase === "idle") {
      this.lease = this.promotePending({ phase: "idle", epoch: this.lease.epoch + 1 });
      changed = true;
    }

    const currentOwner = this.lease.ownerClientId ? this.clients.get(this.lease.ownerClientId) : undefined;
    const currentOwnerCanYield = !this.lease.ownerClientId || !currentOwner || !currentOwner.visible;
    if (this.lease.phase === "idle" && this.lease.pendingClientId && currentOwnerCanYield) {
      this.lease = this.promotePending({ ...this.lease, epoch: this.lease.epoch + 1 });
      changed = true;
    }
    if (changed) this.onLeaseChange("audio-lease");
    return this.state();
  }

  command(request: AudioCommandRequest): AudioLeaseState {
    const ownerClientId = this.lease.ownerClientId;
    if (ownerClientId) {
      this.emit({
        type: "audio-command",
        targetClientId: ownerClientId,
        command: "stop",
        reason: request.command
      });
    }

    const nextEpoch = this.lease.epoch + 1;
    if (request.command === "hide") {
      this.lease = this.promotePending({ phase: "idle", epoch: nextEpoch });
    } else {
      this.lease = {
        ownerClientId: request.clientId,
        ownerSurface: request.surface,
        phase: "idle",
        epoch: nextEpoch
      };
    }
    this.onLeaseChange(`audio-${request.command}`);
    return this.state();
  }

  sweep(maxAgeMs = 15_000): boolean {
    const cutoff = Date.now() - maxAgeMs;
    for (const [clientId, client] of this.clients) {
      if (client.lastSeenAt < cutoff) this.clients.delete(clientId);
    }
    const ownerExpired = this.lease.ownerClientId && !this.clients.has(this.lease.ownerClientId);
    const pendingExpired = this.lease.pendingClientId && !this.clients.has(this.lease.pendingClientId);
    if (!ownerExpired && !pendingExpired) return false;
    if (pendingExpired) {
      this.lease = { ...this.lease, pendingClientId: undefined, pendingSurface: undefined };
    }
    if (ownerExpired) {
      this.lease = this.promotePending({ phase: "idle", epoch: this.lease.epoch + 1 });
    }
    this.onLeaseChange("audio-lease-expired");
    return true;
  }

  private requestOwnership(clientId: string, surface: ClientSurface): boolean {
    const ownerClientId = this.lease.ownerClientId;
    const owner = ownerClientId ? this.clients.get(ownerClientId) : undefined;
    const ownerCanYield = !ownerClientId || !owner || !owner.visible;
    if (!ownerClientId || ownerClientId === clientId || (this.lease.phase === "idle" && ownerCanYield)) {
      const changed = this.lease.ownerClientId !== clientId || this.lease.pendingClientId !== undefined;
      this.lease = {
        ownerClientId: clientId,
        ownerSurface: surface,
        phase: this.lease.ownerClientId === clientId ? this.lease.phase : "idle",
        epoch: changed ? this.lease.epoch + 1 : this.lease.epoch
      };
      return changed;
    }
    const changed = this.lease.pendingClientId !== clientId;
    this.lease = { ...this.lease, pendingClientId: clientId, pendingSurface: surface };
    return changed;
  }

  private promotePending(base: Pick<AudioLeaseState, "phase" | "epoch">): AudioLeaseState {
    if (!this.lease.pendingClientId || !this.lease.pendingSurface) return base;
    return {
      ownerClientId: this.lease.pendingClientId,
      ownerSurface: this.lease.pendingSurface,
      phase: "idle",
      epoch: base.epoch
    };
  }

  private emit(event: SessionStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function isAudioLeasePhase(value: unknown): value is AudioLeasePhase {
  return value === "idle" || value === "listening" || value === "transcribing" || value === "buffering" || value === "speaking";
}
