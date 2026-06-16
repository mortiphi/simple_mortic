import type { ElevenLabsWsServerMessage, TtsProvider } from "../shared/types.js";

const ELEVENLABS_CLIENT_TIMEOUT_MS = 6000;
const DEEPGRAM_CLIENT_TIMEOUT_MS = 15000;
const DEEPGRAM_AUDIO_LEAD_SECONDS = 0.08;
const DEEPGRAM_GAP_REPORT_THRESHOLD_MS = 40;
const ELEVENLABS_FAILURE_COOLDOWN_MS = 30000;
const ELEVENLABS_WS_CONNECT_TIMEOUT_MS = 6000;
const PCM_WS_FIRST_AUDIO_TIMEOUT_MS = 7000;
const PCM_WS_FINISH_DEBOUNCE_MS = 70;
const ELEVENLABS_WS_SAMPLE_RATE = 16000;
type TtsAudioFormat = Extract<ElevenLabsWsServerMessage, { type: "audio" }>["format"];

export type RuntimeTtsProvider = {
  id: TtsProvider;
  beginTurn?(callbacks?: TtsSpeakCallbacks): void;
  finishTurn?(): void;
  speak(text: string, callbacks?: TtsSpeakCallbacks): Promise<TtsSpeakResult>;
  cancel(): void;
};

export type TtsSpeakCallbacks = {
  onStart?: () => void;
  onConnect?: () => void;
  onAudioChunk?: () => void;
  onAudioPlay?: () => void;
  onBufferUnderrun?: () => void;
  onClose?: (code?: number, reason?: string) => void;
  onStatus?: (status: string) => void;
};

export type TtsSpeakResult = {
  spokenBy: TtsProvider;
  fallbackReason?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallbackChain(reason: string | undefined, fallbackReason: string | undefined): string | undefined {
  const parts = [reason, fallbackReason].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join(" -> ") : undefined;
}

function localWebSocketUrl(apiBase: string, path: string): string {
  const url = new URL(path, apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function decodePcm16Base64(audio: string, context: AudioContext): AudioBuffer {
  const binary = atob(audio);
  const sampleCount = Math.floor(binary.length / 2);
  const buffer = context.createBuffer(1, sampleCount, ELEVENLABS_WS_SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < sampleCount; index += 1) {
    const offset = index * 2;
    let sample = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
    if (sample >= 0x8000) sample -= 0x10000;
    channel[index] = Math.max(-1, Math.min(1, sample / 0x8000));
  }
  return buffer;
}

function base64ToArrayBuffer(audio: string): ArrayBuffer {
  const binary = atob(audio);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function decodeAudioBase64(
  audio: string,
  format: TtsAudioFormat,
  context: AudioContext
): Promise<AudioBuffer> {
  if (format === "wav") {
    return await context.decodeAudioData(base64ToArrayBuffer(audio));
  }
  return decodePcm16Base64(audio, context);
}

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  const candidate = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}

export function createBrowserTtsProvider(): RuntimeTtsProvider {
  let cancelGeneration = 0;

  return {
    id: "browser",
    speak(text: string, callbacks?: TtsSpeakCallbacks): Promise<TtsSpeakResult> {
      return new Promise((resolve, reject) => {
        if (!("speechSynthesis" in window)) {
          reject(new Error("Browser text-to-speech is unavailable"));
          return;
        }

        const generation = cancelGeneration;
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.onstart = () => callbacks?.onStart?.();
        utterance.onend = () => resolve({ spokenBy: "browser" });
        utterance.onerror = (event) => {
          if (generation !== cancelGeneration) {
            resolve({ spokenBy: "browser" });
            return;
          }
          reject(new Error(event.error || "browser speech synthesis error"));
        };
        window.speechSynthesis.speak(utterance);
      });
    },
    cancel(): void {
      cancelGeneration += 1;
      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    }
  };
}

function createHttpAudioTtsProvider(params: {
  apiBase: string;
  disableFallbackAfterAudioStarted?: boolean;
  fallback: RuntimeTtsProvider;
  id: TtsProvider;
  label: string;
  path: string;
  retryAttempts?: number;
  timeoutMs: number;
}): RuntimeTtsProvider {
  let cancelGeneration = 0;
  let controller: AbortController | null = null;
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let disabledUntil = 0;
  let lastFailure = "";
  let bypassCurrentTurn = false;
  let playedAudioThisTurn = false;

  function cleanup(): void {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    audio = null;
    controller = null;
  }

  async function playAudioBlob(blob: Blob, generation: number, callbacks?: TtsSpeakCallbacks): Promise<TtsSpeakResult> {
    if (generation !== cancelGeneration) return { spokenBy: params.id };
    objectUrl = URL.createObjectURL(blob);
    audio = new Audio(objectUrl);
    await new Promise<void>((resolve, reject) => {
      if (!audio) {
        resolve();
        return;
      }

      audio.onplay = () => {
        playedAudioThisTurn = true;
        callbacks?.onStart?.();
      };
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error(`${params.label} audio playback failed`));
      const playPromise = audio.play();
      if (playPromise) {
        playPromise.catch((error) => reject(new Error(`${params.label} audio playback failed: ${errorMessage(error)}`)));
      }
    });
    return { spokenBy: params.id };
  }

  return {
    id: params.id,
    beginTurn(): void {
      bypassCurrentTurn = false;
      playedAudioThisTurn = false;
    },
    async speak(text: string, callbacks?: TtsSpeakCallbacks): Promise<TtsSpeakResult> {
      const generation = cancelGeneration;
      if (bypassCurrentTurn || Date.now() < disabledUntil) {
        const reason = bypassCurrentTurn
          ? `${params.label} unavailable this turn after ${lastFailure || "a recent failure"}`
          : `${params.label} cooling down after ${lastFailure || "a recent failure"}`;
        if (params.disableFallbackAfterAudioStarted && playedAudioThisTurn) {
          throw new Error(reason);
        }
        const fallbackResult = await params.fallback.speak(text, callbacks);
        return {
          spokenBy: fallbackResult.spokenBy,
          fallbackReason: fallbackChain(reason, fallbackResult.fallbackReason)
        };
      }

      const maxAttempts = Math.max(1, 1 + (params.retryAttempts ?? 0));
      let lastError: unknown;
      let lastTimedOut = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let timedOut = false;
        let timeoutId: number | undefined;
        try {
        controller = new AbortController();
        timeoutId = window.setTimeout(() => {
          timedOut = true;
          controller?.abort();
        }, params.timeoutMs);
        const response = await fetch(`${params.apiBase}${params.path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ text }),
          signal: controller.signal
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? `${params.label} TTS failed: ${response.status}`);
        }

        const blob = await response.blob();
        const result = await playAudioBlob(blob, generation, callbacks);
        disabledUntil = 0;
        lastFailure = "";
        return result;
      } catch (error) {
        if (generation !== cancelGeneration || (error instanceof DOMException && error.name === "AbortError" && !timedOut)) {
          return { spokenBy: params.id };
        }
        lastError = error;
        lastTimedOut = timedOut;
        if (attempt < maxAttempts) {
          callbacks?.onStatus?.(`${params.label} retrying chunk after ${timedOut ? `timed out after ${params.timeoutMs} ms` : errorMessage(error)}`);
          continue;
        }
      } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId);
        cleanup();
      }
      }

      const fallbackReason = lastTimedOut ? `timed out after ${params.timeoutMs} ms` : errorMessage(lastError);
      disabledUntil = Date.now() + ELEVENLABS_FAILURE_COOLDOWN_MS;
      lastFailure = fallbackReason;
      bypassCurrentTurn = true;
      if (params.disableFallbackAfterAudioStarted && playedAudioThisTurn) {
        throw new Error(`${params.label} stopped after audio started: ${fallbackReason}`);
      }
      const fallbackResult = await params.fallback.speak(text, callbacks);
      return {
        spokenBy: fallbackResult.spokenBy,
        fallbackReason: fallbackChain(`${params.label} failed: ${fallbackReason}`, fallbackResult.fallbackReason)
      };
    },
    cancel(): void {
      cancelGeneration += 1;
      controller?.abort();
      if (audio) {
        audio.muted = true;
        audio.pause();
        audio.currentTime = 0;
        audio.src = "";
        audio.load();
      }
      cleanup();
      params.fallback.cancel();
    }
  };
}

function createDeepgramRestTtsProvider(apiBase: string, fallback: RuntimeTtsProvider): RuntimeTtsProvider {
  let cancelGeneration = 0;
  let audioContext: AudioContext | null = null;
  let outputGain: GainNode | null = null;
  let nextPlaybackTime = 0;
  let disabledUntil = 0;
  let lastFailure = "";
  let bypassCurrentTurn = false;
  let playedAudioThisTurn = false;
  let firstAudioResponseReported = false;
  let firstAudioChunkReported = false;
  let firstAudioPlayReported = false;
  let scheduledChunks = 0;
  let maxGapMs = 0;
  let turnCallbacks: TtsSpeakCallbacks | undefined;
  const controllers = new Set<AbortController>();
  const sources = new Set<AudioBufferSourceNode>();

  function updateCallbacks(callbacks?: TtsSpeakCallbacks): void {
    if (callbacks) turnCallbacks = callbacks;
  }

  function reportStatus(status: string): void {
    turnCallbacks?.onStatus?.(status);
  }

  async function ensureAudioContext(): Promise<AudioContext> {
    if (!audioContext) {
      const Constructor = audioContextConstructor();
      if (!Constructor) throw new Error("Web Audio is unavailable in this browser");
      audioContext = new Constructor();
      outputGain = audioContext.createGain();
      outputGain.gain.value = 1;
      outputGain.connect(audioContext.destination);
      nextPlaybackTime = audioContext.currentTime;
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  }

  async function fetchAudioBuffer(text: string, generation: number, callbacks?: TtsSpeakCallbacks): Promise<AudioBuffer> {
    updateCallbacks(callbacks);
    const context = await ensureAudioContext();
    let lastError: unknown;
    let lastTimedOut = false;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      controllers.add(controller);
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, DEEPGRAM_CLIENT_TIMEOUT_MS);

      try {
        const response = await fetch(`${apiBase}/api/tts/deepgram/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ text }),
          signal: controller.signal
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(payload?.error ?? `Deepgram TTS failed: ${response.status}`);
        }

        if (!firstAudioResponseReported) {
          firstAudioResponseReported = true;
          turnCallbacks?.onConnect?.();
        }
        const audioBytes = await response.arrayBuffer();
        if (generation !== cancelGeneration) throw new Error("Deepgram synthesis cancelled");
        if (!firstAudioChunkReported) {
          firstAudioChunkReported = true;
          turnCallbacks?.onAudioChunk?.();
        }
        return await context.decodeAudioData(audioBytes.slice(0));
      } catch (error) {
        if (generation !== cancelGeneration || (error instanceof DOMException && error.name === "AbortError" && !timedOut)) {
          throw error;
        }
        lastError = error;
        lastTimedOut = timedOut;
        if (attempt < 2) {
          reportStatus(`Deepgram retrying chunk after ${timedOut ? `timed out after ${DEEPGRAM_CLIENT_TIMEOUT_MS} ms` : errorMessage(error)}`);
        }
      } finally {
        window.clearTimeout(timeoutId);
        controllers.delete(controller);
      }
    }

    throw new Error(lastTimedOut ? `timed out after ${DEEPGRAM_CLIENT_TIMEOUT_MS} ms` : errorMessage(lastError));
  }

  async function scheduleAudioBuffer(buffer: AudioBuffer, generation: number, callbacks?: TtsSpeakCallbacks): Promise<void> {
    updateCallbacks(callbacks);
    if (generation !== cancelGeneration) return;
    const context = await ensureAudioContext();
    if (generation !== cancelGeneration) return;

    const now = context.currentTime;
    if (firstAudioPlayReported && nextPlaybackTime < now) {
      const gapMs = Math.round((now - nextPlaybackTime) * 1000);
      if (gapMs >= DEEPGRAM_GAP_REPORT_THRESHOLD_MS) {
        maxGapMs = Math.max(maxGapMs, gapMs);
        turnCallbacks?.onBufferUnderrun?.();
        reportStatus(`Deepgram buffer gap ${gapMs} ms`);
      }
    }
    if (nextPlaybackTime < now + DEEPGRAM_AUDIO_LEAD_SECONDS) {
      nextPlaybackTime = now + DEEPGRAM_AUDIO_LEAD_SECONDS;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(outputGain ?? context.destination);
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
    };

    const startAt = nextPlaybackTime;
    const delayMs = Math.max(0, Math.round((startAt - context.currentTime) * 1000));
    source.start(startAt);
    nextPlaybackTime = startAt + buffer.duration;
    scheduledChunks += 1;

    if (!firstAudioPlayReported) {
      firstAudioPlayReported = true;
      window.setTimeout(() => {
        if (generation !== cancelGeneration) return;
        playedAudioThisTurn = true;
        turnCallbacks?.onAudioPlay?.();
        turnCallbacks?.onStart?.();
      }, delayMs);
    }
  }

  function stopAudio(): void {
    for (const controller of controllers) controller.abort();
    controllers.clear();
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
    }
    sources.clear();
    const context = audioContext;
    const gain = outputGain;
    audioContext = null;
    outputGain = null;
    nextPlaybackTime = 0;
    if (context && gain) {
      try {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.disconnect();
      } catch {
        // Context may already be closing.
      }
    }
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  async function fallbackSpeak(text: string, reason: string, callbacks?: TtsSpeakCallbacks): Promise<TtsSpeakResult> {
    if (playedAudioThisTurn) {
      throw new Error(`Deepgram stopped after audio started: ${reason}`);
    }
    const fallbackResult = await fallback.speak(text, callbacks);
    return {
      spokenBy: fallbackResult.spokenBy,
      fallbackReason: fallbackChain(`Deepgram failed: ${reason}`, fallbackResult.fallbackReason)
    };
  }

  return {
    id: "deepgram",
    beginTurn(callbacks?: TtsSpeakCallbacks): void {
      cancelGeneration += 1;
      updateCallbacks(callbacks);
      bypassCurrentTurn = false;
      playedAudioThisTurn = false;
      firstAudioResponseReported = false;
      firstAudioChunkReported = false;
      firstAudioPlayReported = false;
      scheduledChunks = 0;
      maxGapMs = 0;
      stopAudio();
    },
    finishTurn(): void {
      const generation = cancelGeneration;
      const remainingMs = audioContext ? Math.max(0, Math.round((nextPlaybackTime - audioContext.currentTime) * 1000)) : 0;
      window.setTimeout(() => {
        if (generation !== cancelGeneration) return;
        if (scheduledChunks > 0) {
          const gapSummary = maxGapMs > 0 ? `; max buffer gap ${maxGapMs} ms` : "; max buffer gap 0 ms";
          reportStatus(`Deepgram buffered ${scheduledChunks} chunks${gapSummary}`);
        }
      }, remainingMs);
    },
    async speak(text: string, callbacks?: TtsSpeakCallbacks): Promise<TtsSpeakResult> {
      updateCallbacks(callbacks);
      const generation = cancelGeneration;
      if (bypassCurrentTurn || Date.now() < disabledUntil) {
        const reason = bypassCurrentTurn
          ? `Deepgram unavailable this turn after ${lastFailure || "a recent failure"}`
          : `Deepgram cooling down after ${lastFailure || "a recent failure"}`;
        return await fallbackSpeak(text, reason, callbacks);
      }

      try {
        const buffer = await fetchAudioBuffer(text, generation, callbacks);
        await scheduleAudioBuffer(buffer, generation, callbacks);
        disabledUntil = 0;
        lastFailure = "";
        return { spokenBy: "deepgram" };
      } catch (error) {
        if (generation !== cancelGeneration) return { spokenBy: "deepgram" };
        const reason = errorMessage(error);
        disabledUntil = Date.now() + ELEVENLABS_FAILURE_COOLDOWN_MS;
        lastFailure = reason;
        bypassCurrentTurn = true;
        return await fallbackSpeak(text, reason, callbacks);
      }
    },
    cancel(): void {
      cancelGeneration += 1;
      stopAudio();
      fallback.cancel();
    }
  };
}

export function createElevenLabsTtsProvider(apiBase: string, fallback: RuntimeTtsProvider): RuntimeTtsProvider {
  return createHttpAudioTtsProvider({
    apiBase,
    fallback,
    id: "elevenlabs",
    label: "ElevenLabs",
    path: "/api/tts/elevenlabs/stream",
    timeoutMs: ELEVENLABS_CLIENT_TIMEOUT_MS
  });
}

function createPcmWsTtsProvider(params: {
  id: TtsProvider;
  label: string;
  apiBase: string;
  path: string;
  fallback: RuntimeTtsProvider;
  disableFallbackAfterAudioStarted?: boolean;
}): RuntimeTtsProvider {
  let cancelGeneration = 0;
  let ws: WebSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  let disabledUntil = 0;
  let lastFailure = "";
  let bypassCurrentTurn = false;
  let turnCallbacks: TtsSpeakCallbacks | undefined;
  let sendChain: Promise<void> = Promise.resolve();
  let audioContext: AudioContext | null = null;
  let outputGain: GainNode | null = null;
  let nextPlaybackTime = 0;
  let firstAudioPlayReported = false;
  let firstAudioChunkReported = false;
  let closeExpected = false;
  let sentTextThisTurn = false;
  const sources = new Set<AudioBufferSourceNode>();
  const pendingAudioWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: number;
  }> = [];

  function updateCallbacks(callbacks?: TtsSpeakCallbacks): void {
    if (callbacks) turnCallbacks = callbacks;
  }

  function reportStatus(status: string): void {
    turnCallbacks?.onStatus?.(status);
  }

  function browserCloseCode(code: number): number {
    return code === 1000 || (code >= 3000 && code <= 4999) ? code : 4000;
  }

  function resolveAudioWaiter(): void {
    const waiter = pendingAudioWaiters.shift();
    if (!waiter) return;
    window.clearTimeout(waiter.timeout);
    waiter.resolve();
  }

  function rejectAudioWaiters(reason: string): void {
    const waiters = pendingAudioWaiters.splice(0);
    for (const waiter of waiters) {
      window.clearTimeout(waiter.timeout);
      waiter.reject(new Error(reason));
    }
  }

  function waitForFirstAudio(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const waiterIndex = pendingAudioWaiters.findIndex((waiter) => waiter.resolve === resolve);
        if (waiterIndex >= 0) pendingAudioWaiters.splice(waiterIndex, 1);
        reject(new Error(`${params.label} produced no audio for ${Math.min(text.length, 80)} chars`));
      }, PCM_WS_FIRST_AUDIO_TIMEOUT_MS);
      pendingAudioWaiters.push({ resolve, reject, timeout });
    });
  }

  function closeSocket(code = 1000, reason = "done"): void {
    closeExpected = true;
    const safeCode = browserCloseCode(code);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "cancel" }));
      ws.close(safeCode, reason);
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.close(safeCode, reason);
    }
    ws = null;
    connectPromise = null;
  }

  function stopAudio(): void {
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // Source may already have ended.
      }
    }
    sources.clear();
    const context = audioContext;
    const gain = outputGain;
    audioContext = null;
    outputGain = null;
    nextPlaybackTime = 0;
    firstAudioPlayReported = false;
    firstAudioChunkReported = false;
    if (context && gain) {
      try {
        gain.gain.cancelScheduledValues(context.currentTime);
        gain.gain.setValueAtTime(0, context.currentTime);
        gain.disconnect();
      } catch {
        // Context may already be closing.
      }
    }
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
  }

  function markUnavailable(reason: string, callbacks?: TtsSpeakCallbacks): void {
    updateCallbacks(callbacks);
    disabledUntil = Date.now() + ELEVENLABS_FAILURE_COOLDOWN_MS;
    lastFailure = reason;
    bypassCurrentTurn = true;
    reportStatus(`${params.label} unavailable, using fallback: ${reason}`);
    rejectAudioWaiters(reason);
    closeSocket(1011, "unavailable");
  }

  async function ensureAudioContext(): Promise<AudioContext> {
    if (!audioContext) {
      const Constructor = audioContextConstructor();
      if (!Constructor) throw new Error("Web Audio is unavailable in this browser");
      audioContext = new Constructor();
      outputGain = audioContext.createGain();
      outputGain.gain.value = 1;
      outputGain.connect(audioContext.destination);
      nextPlaybackTime = audioContext.currentTime;
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  }

  async function scheduleAudio(audio: string, format: TtsAudioFormat, generation: number): Promise<void> {
    if (generation !== cancelGeneration) return;
    const context = await ensureAudioContext();
    if (generation !== cancelGeneration) return;
    if (!firstAudioChunkReported) {
      firstAudioChunkReported = true;
      turnCallbacks?.onAudioChunk?.();
    }

    const buffer = await decodeAudioBase64(audio, format, context);
    if (generation !== cancelGeneration) return;
    const now = context.currentTime;
    const leadSeconds = 0.035;
    if (firstAudioPlayReported && nextPlaybackTime < now - 0.05) {
      turnCallbacks?.onBufferUnderrun?.();
    }
    if (nextPlaybackTime < now + leadSeconds) {
      nextPlaybackTime = now + leadSeconds;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(outputGain ?? context.destination);
    sources.add(source);
    source.onended = () => {
      sources.delete(source);
    };

    const startAt = nextPlaybackTime;
    const delayMs = Math.max(0, Math.round((startAt - context.currentTime) * 1000));
    source.start(startAt);
    nextPlaybackTime = startAt + buffer.duration;

    if (!firstAudioPlayReported) {
      firstAudioPlayReported = true;
      window.setTimeout(() => {
        if (generation !== cancelGeneration) return;
        turnCallbacks?.onAudioPlay?.();
        turnCallbacks?.onStart?.();
      }, delayMs);
    }
  }

  function handleServerMessage(message: ElevenLabsWsServerMessage, generation: number): void {
    if (generation !== cancelGeneration) return;
    if (message.type === "ready") {
      turnCallbacks?.onConnect?.();
      reportStatus(`${params.label} ready`);
      return;
    }
    if (message.type === "audio") {
      resolveAudioWaiter();
      void scheduleAudio(message.audio, message.format, generation)
        .catch((error) => {
          markUnavailable(errorMessage(error));
        });
      return;
    }
    if (message.type === "final") {
      rejectAudioWaiters(`${params.label} finished without audio`);
      return;
    }
    if (message.type === "status") {
      reportStatus(message.detail ? `${message.status}: ${message.detail}` : message.status);
      return;
    }
    if (message.type === "error") {
      markUnavailable(message.error);
    }
  }

  function ensureSocket(callbacks?: TtsSpeakCallbacks): Promise<void> {
    updateCallbacks(callbacks);
    if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (connectPromise) return connectPromise;

    const generation = cancelGeneration;
    closeExpected = false;
    ws = new WebSocket(localWebSocketUrl(params.apiBase, params.path));
    connectPromise = new Promise<void>((resolve, reject) => {
      const socket = ws;
      if (!socket) {
        reject(new Error(`${params.label} could not be opened`));
        return;
      }

      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${params.label} timed out after ${ELEVENLABS_WS_CONNECT_TIMEOUT_MS} ms`));
        closeSocket(1011, "connect timeout");
      }, ELEVENLABS_WS_CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (generation !== cancelGeneration) return;
        socket.send(JSON.stringify({ type: "start" }));
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          resolve();
        }
      };
      socket.onmessage = (event) => {
        let message: ElevenLabsWsServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ElevenLabsWsServerMessage;
        } catch {
          reportStatus(`${params.label} returned an unparseable message`);
          return;
        }

        handleServerMessage(message, generation);
      };
      socket.onerror = () => {
        if (generation !== cancelGeneration) return;
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error(`${params.label} connection failed`));
        } else {
          markUnavailable(`${params.label} connection failed`);
        }
      };
      socket.onclose = (event) => {
        if (generation !== cancelGeneration) return;
        turnCallbacks?.onClose?.(event.code, event.reason);
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error(event.reason || `${params.label} closed with code ${event.code}`));
          return;
        }
        connectPromise = null;
        ws = null;
        if (!closeExpected && event.code !== 1000) {
          markUnavailable(event.reason || `${params.label} closed with code ${event.code}`);
        } else {
          rejectAudioWaiters(event.reason || `${params.label} closed before audio was received`);
        }
      };
    });
    return connectPromise;
  }

  function queueSend(task: () => Promise<void>): Promise<void> {
    const next = sendChain.catch(() => undefined).then(task);
    sendChain = next.catch(() => undefined);
    return next;
  }

  async function fallbackSpeak(text: string, callbacks?: TtsSpeakCallbacks, reason?: string): Promise<TtsSpeakResult> {
    if (params.disableFallbackAfterAudioStarted && firstAudioPlayReported) {
      throw new Error(`${params.label} stopped after audio started: ${reason ?? lastFailure}`);
    }
    const fallbackResult = await params.fallback.speak(text, callbacks);
    return {
      spokenBy: fallbackResult.spokenBy,
      fallbackReason: fallbackChain(`${params.label} failed: ${reason ?? lastFailure}`, fallbackResult.fallbackReason)
    };
  }

  return {
    id: params.id,
    beginTurn(callbacks?: TtsSpeakCallbacks): void {
      cancelGeneration += 1;
      updateCallbacks(callbacks);
      bypassCurrentTurn = false;
      sentTextThisTurn = false;
      sendChain = Promise.resolve();
      rejectAudioWaiters(`${params.label} turn reset`);
      stopAudio();
      closeSocket(1000, "new turn");
      closeExpected = false;
      const generation = cancelGeneration;
      void ensureSocket(callbacks).catch((error) => {
        if (generation !== cancelGeneration) return;
        markUnavailable(errorMessage(error), callbacks);
      });
    },
    finishTurn(): void {
      if (bypassCurrentTurn || Date.now() < disabledUntil || !sentTextThisTurn) return;
      const generation = cancelGeneration;
      window.setTimeout(() => {
        if (generation !== cancelGeneration) return;
        void queueSend(async () => {
          await ensureSocket(turnCallbacks);
          if (generation !== cancelGeneration) return;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "finish" }));
          }
        }).catch((error) => {
          markUnavailable(errorMessage(error));
        });
      }, PCM_WS_FINISH_DEBOUNCE_MS);
    },
    async speak(text: string, callbacks?: TtsSpeakCallbacks): Promise<TtsSpeakResult> {
      updateCallbacks(callbacks);
      const generation = cancelGeneration;
      if (bypassCurrentTurn || Date.now() < disabledUntil) {
        return await fallbackSpeak(
          text,
          callbacks,
          bypassCurrentTurn
            ? `${params.label} unavailable this turn after ${lastFailure || "a recent failure"}`
            : `${params.label} cooling down after ${lastFailure || "a recent failure"}`
        );
      }

      const firstAudioPromise = waitForFirstAudio(text);
      try {
        await queueSend(async () => {
          await ensureSocket(callbacks);
          if (generation !== cancelGeneration) return;
          if (ws?.readyState !== WebSocket.OPEN) throw new Error(`${params.label} is not open`);
          sentTextThisTurn = true;
          ws.send(
            JSON.stringify({
              type: "text",
              text,
              flush: true
            })
          );
        });
        await firstAudioPromise;
        return { spokenBy: params.id };
      } catch (error) {
        if (generation !== cancelGeneration) return { spokenBy: params.id };
        firstAudioPromise.catch(() => undefined);
        const reason = errorMessage(error);
        markUnavailable(reason, callbacks);
        return await fallbackSpeak(text, callbacks, reason);
      }
    },
    cancel(): void {
      cancelGeneration += 1;
      sentTextThisTurn = false;
      rejectAudioWaiters(`${params.label} cancelled`);
      stopAudio();
      closeSocket(1000, "cancel");
      params.fallback.cancel();
    }
  };
}

export function createDeepgramTtsProvider(apiBase: string, fallback: RuntimeTtsProvider): RuntimeTtsProvider {
  const restFallback = createDeepgramRestTtsProvider(apiBase, fallback);
  return createPcmWsTtsProvider({
    id: "deepgram",
    label: "Deepgram WS",
    apiBase,
    path: "/api/tts/deepgram/ws",
    fallback: restFallback,
    disableFallbackAfterAudioStarted: true
  });
}

export function createElevenLabsWsTtsProvider(apiBase: string, fallback: RuntimeTtsProvider): RuntimeTtsProvider {
  return createPcmWsTtsProvider({
    id: "elevenlabs-ws",
    label: "ElevenLabs WS",
    apiBase,
    path: "/api/tts/elevenlabs/ws",
    fallback
  });
}

export function createInworldWsTtsProvider(apiBase: string, fallback: RuntimeTtsProvider): RuntimeTtsProvider {
  return createPcmWsTtsProvider({
    id: "inworld-ws",
    label: "Inworld WS",
    apiBase,
    path: "/api/tts/inworld/ws",
    fallback
  });
}
