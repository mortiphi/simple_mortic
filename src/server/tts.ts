import type {
  ElevenLabsHealthResponse,
  ElevenLabsWsClientMessage,
  ElevenLabsWsServerMessage,
  TtsProvider,
  TtsStatus
} from "../shared/types.js";
import { WebSocket as UpstreamWebSocket } from "ws";

type ElevenLabsStream = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: string;
};

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "mp3_22050_32";
const DEFAULT_ELEVENLABS_WS_OUTPUT_FORMAT = "pcm_16000";
const DEFAULT_ELEVENLABS_TIMEOUT_MS = 3500;
const ELEVENLABS_WS_CHUNK_LENGTH_SCHEDULE = [50, 90, 120];
const INWORLD_WS_URL = "wss://api.inworld.ai/tts/v1/voice:streamBidirectional";
const DEFAULT_INWORLD_VOICE_ID = "Dennis";
const DEFAULT_INWORLD_MODEL_ID = "inworld-tts-1.5-mini";
const DEFAULT_INWORLD_BUFFER_CHARS = 100;
const INWORLD_READY_TIMEOUT_MS = 6000;

type LocalWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

type ElevenLabsInputStreamMessage = {
  audio?: string | null;
  isFinal?: boolean;
  error?: string;
};

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function elevenLabsApiKey(): string | undefined {
  return envValue("ELEVENLABS_API_KEY") ?? envValue("XI_API_KEY");
}

function inworldApiKey(): string | undefined {
  return envValue("INWORLD_API_KEY");
}

function configuredInworldVoiceId(): string {
  return envValue("INWORLD_VOICE_ID") ?? DEFAULT_INWORLD_VOICE_ID;
}

function configuredInworldModelId(): string {
  return envValue("INWORLD_MODEL_ID") ?? DEFAULT_INWORLD_MODEL_ID;
}

function configuredInworldBufferChars(): number {
  const parsed = Number(envValue("INWORLD_BUFFER_CHAR_THRESHOLD"));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_INWORLD_BUFFER_CHARS;
  return Math.max(20, Math.min(1000, Math.floor(parsed)));
}

function configuredElevenLabsVoiceId(): string {
  return envValue("ELEVENLABS_VOICE_ID") ?? DEFAULT_ELEVENLABS_VOICE_ID;
}

function configuredElevenLabsModelId(): string {
  return envValue("ELEVENLABS_MODEL_ID") ?? DEFAULT_ELEVENLABS_MODEL_ID;
}

function configuredElevenLabsOutputFormat(): string {
  return envValue("ELEVENLABS_OUTPUT_FORMAT") ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
}

function configuredElevenLabsWsOutputFormat(): string {
  return envValue("ELEVENLABS_WS_OUTPUT_FORMAT") ?? DEFAULT_ELEVENLABS_WS_OUTPUT_FORMAT;
}

function configuredElevenLabsTimeoutMs(): number {
  const parsed = Number(envValue("ELEVENLABS_TIMEOUT_MS"));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ELEVENLABS_TIMEOUT_MS;
  return Math.max(500, Math.min(15000, Math.floor(parsed)));
}

function configuredDefaultProvider(params: { inworldConfigured: boolean; elevenLabsConfigured: boolean }): TtsProvider {
  const requested = envValue("MORTIC_TTS_PROVIDER");
  if (requested === "browser") return "browser";
  if (requested === "inworld-ws" && params.inworldConfigured) return "inworld-ws";
  if (requested === "elevenlabs-ws" && params.elevenLabsConfigured) return "elevenlabs-ws";
  if (requested === "elevenlabs" && params.elevenLabsConfigured) return "elevenlabs";
  if (params.inworldConfigured) return "inworld-ws";
  return params.elevenLabsConfigured ? "elevenlabs-ws" : "browser";
}

function classifyElevenLabsStatus(status: number): ElevenLabsHealthResponse["status"] {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 402 || status === 429) return "quota_or_rate_limit";
  if (status >= 500) return "server_error";
  return "unknown_error";
}

export function getTtsStatus(): TtsStatus {
  const inworldConfigured = Boolean(inworldApiKey());
  const elevenLabsConfigured = Boolean(elevenLabsApiKey());
  const availableProviders: TtsProvider[] = [];
  if (inworldConfigured) availableProviders.push("inworld-ws");
  if (elevenLabsConfigured) availableProviders.push("elevenlabs-ws", "elevenlabs");
  availableProviders.push("browser");
  return {
    defaultProvider: configuredDefaultProvider({ inworldConfigured, elevenLabsConfigured }),
    availableProviders,
    inworldConfigured,
    inworldVoiceId: inworldConfigured ? configuredInworldVoiceId() : undefined,
    inworldModelId: inworldConfigured ? configuredInworldModelId() : undefined,
    elevenLabsConfigured,
    elevenLabsVoiceId: elevenLabsConfigured ? configuredElevenLabsVoiceId() : undefined,
    elevenLabsModelId: elevenLabsConfigured ? configuredElevenLabsModelId() : undefined
  };
}

function elevenLabsInputStreamUrl(): string {
  const voiceId = configuredElevenLabsVoiceId();
  const url = new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`, "wss://api.elevenlabs.io");
  url.searchParams.set("model_id", configuredElevenLabsModelId());
  url.searchParams.set("output_format", configuredElevenLabsWsOutputFormat());
  return url.toString();
}

function socketIsOpen(socket: { readyState: number }): boolean {
  return socket.readyState === 1;
}

function sendLocal(socket: LocalWebSocket, message: ElevenLabsWsServerMessage): void {
  if (!socketIsOpen(socket)) return;
  socket.send(JSON.stringify(message));
}

function normalizePcmBase64(audio: string): string {
  const buffer = Buffer.from(audio, "base64");
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return audio;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      return buffer.subarray(dataStart, Math.min(dataStart + chunkSize, buffer.length)).toString("base64");
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return audio;
}

function wavPcmData(audio: string): Buffer | null {
  const buffer = Buffer.from(audio, "base64");
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let data: Buffer | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16) {
      channels = buffer.readUInt16LE(dataStart + 2);
      sampleRate = buffer.readUInt32LE(dataStart + 4);
      bitsPerSample = buffer.readUInt16LE(dataStart + 14);
    }
    if (chunkId === "data") {
      data = buffer.subarray(dataStart, Math.min(dataStart + chunkSize, buffer.length));
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  if (!data || sampleRate !== 16000 || bitsPerSample !== 16 || channels !== 1) return null;
  return data;
}

async function messageDataToString(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  return String(data);
}

function parseClientMessage(data: string): ElevenLabsWsClientMessage | null {
  try {
    const parsed = JSON.parse(data) as Partial<ElevenLabsWsClientMessage>;
    if (parsed.type === "start") return { type: "start" };
    if (parsed.type === "flush") return { type: "flush" };
    if (parsed.type === "finish") return { type: "finish" };
    if (parsed.type === "cancel") return { type: "cancel" };
    if (parsed.type === "text" && typeof parsed.text === "string") {
      return {
        type: "text",
        text: parsed.text,
        flush: parsed.flush === true
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function handleElevenLabsWsSession(local: LocalWebSocket): void {
  const startedAt = Date.now();
  const apiKey = elevenLabsApiKey();
  let upstream: WebSocket | null = null;
  let upstreamReady = false;
  let upstreamClosed = false;
  let localClosed = false;
  const pendingUpstreamMessages: string[] = [];

  function elapsedMs(): number {
    return Date.now() - startedAt;
  }

  function sendError(error: string, status?: ElevenLabsHealthResponse["status"], code?: number): void {
    sendLocal(local, {
      type: "error",
      error,
      status,
      code,
      elapsedMs: elapsedMs()
    });
  }

  function closeUpstream(code = 1000, reason = "done"): void {
    if (!upstream || upstreamClosed) return;
    upstreamClosed = true;
    try {
      upstream.close(code, reason);
    } catch {
      // Ignore close races between local interruption and upstream completion.
    }
  }

  function closeLocal(code = 1000, reason = "done"): void {
    if (localClosed) return;
    localClosed = true;
    try {
      if (socketIsOpen(local)) local.close(code, reason);
    } catch {
      // Ignore close races between browser cancellation and upstream completion.
    }
  }

  function closeBoth(code = 1000, reason = "done"): void {
    closeUpstream(code, reason);
    closeLocal(code, reason);
  }

  function sendUpstream(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    if (upstream && upstreamReady && socketIsOpen(upstream)) {
      upstream.send(serialized);
      return;
    }
    pendingUpstreamMessages.push(serialized);
  }

  function drainPendingUpstreamMessages(): void {
    if (!upstream || !upstreamReady || !socketIsOpen(upstream)) return;
    while (pendingUpstreamMessages.length > 0) {
      upstream.send(pendingUpstreamMessages.shift() as string);
    }
  }

  function connectUpstream(): void {
    if (upstream || upstreamClosed) return;
    if (!apiKey) {
      sendError("ElevenLabs is not configured. Set ELEVENLABS_API_KEY to enable it.", "not_configured");
      closeLocal(1011, "not configured");
      return;
    }

    upstream = new WebSocket(elevenLabsInputStreamUrl());
    upstream.addEventListener("open", () => {
      if (!upstream || upstreamClosed) return;
      upstream.send(
        JSON.stringify({
          text: " ",
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.8,
            style: 0,
            use_speaker_boost: true
          },
          generation_config: {
            chunk_length_schedule: ELEVENLABS_WS_CHUNK_LENGTH_SCHEDULE
          },
          xi_api_key: apiKey
        })
      );
      upstreamReady = true;
      sendLocal(local, {
        type: "ready",
        elapsedMs: elapsedMs(),
        format: "pcm_16000"
      });
      drainPendingUpstreamMessages();
    });

    upstream.addEventListener("message", async (event) => {
      let payload: ElevenLabsInputStreamMessage;
      try {
        payload = JSON.parse(await messageDataToString(event.data)) as ElevenLabsInputStreamMessage;
      } catch {
        sendLocal(local, {
          type: "status",
          status: "unparseable_message",
          detail: "ElevenLabs returned a message Mortic could not parse",
          elapsedMs: elapsedMs()
        });
        return;
      }

      if (payload.error) {
        sendError(payload.error, "unknown_error");
        closeBoth(1011, "upstream error");
        return;
      }

      if (payload.audio) {
        sendLocal(local, {
          type: "audio",
          audio: payload.audio,
          elapsedMs: elapsedMs(),
          format: "pcm_16000"
        });
      }

      if (payload.isFinal) {
        sendLocal(local, {
          type: "final",
          elapsedMs: elapsedMs()
        });
        closeBoth(1000, "final");
      }
    });

    upstream.addEventListener("close", (event) => {
      upstreamClosed = true;
      if (!localClosed && event.code !== 1000) {
        const status = event.code === 1008 ? "auth_error" : event.code === 1011 ? "server_error" : "network_error";
        sendError(event.reason || `ElevenLabs WebSocket closed with code ${event.code}`, status, event.code);
        closeLocal(1011, "upstream closed");
      }
    });

    upstream.addEventListener("error", () => {
      if (!localClosed) {
        sendError("ElevenLabs WebSocket connection failed", "network_error");
        closeLocal(1011, "upstream error");
      }
    });
  }

  local.on("message", (data) => {
    void messageDataToString(data).then((text) => {
      const message = parseClientMessage(text);
      if (!message) {
        sendError("Invalid WebSocket TTS message");
        return;
      }

      if (message.type === "cancel") {
        closeBoth(1000, "cancelled");
        return;
      }

      connectUpstream();
      if (message.type === "start") return;
      if (message.type === "flush") {
        sendUpstream({ text: "", flush: true });
        return;
      }
      if (message.type === "finish") {
        sendUpstream({ text: "", flush: true });
        sendUpstream({ text: "" });
        return;
      }
      if (message.type === "text" && message.text.trim()) {
        sendUpstream({
          text: message.text,
          flush: message.flush === true
        });
      }
    });
  });

  local.on("close", (code, reason) => {
    localClosed = true;
    closeUpstream(code || 1000, reason?.toString() || "local closed");
  });

  local.on("error", () => {
    localClosed = true;
    closeUpstream(1011, "local error");
  });
}

export function handleInworldWsSession(local: LocalWebSocket): void {
  const startedAt = Date.now();
  const apiKey = inworldApiKey();
  const contextId = `mortic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let upstream: UpstreamWebSocket | null = null;
  let upstreamReady = false;
  let upstreamClosed = false;
  let localClosed = false;
  let finishing = false;
  let readyTimeout: NodeJS.Timeout | undefined;
  const pendingUpstreamMessages: string[] = [];

  function elapsedMs(): number {
    return Date.now() - startedAt;
  }

  function sendError(error: string, status?: ElevenLabsHealthResponse["status"], code?: number): void {
    sendLocal(local, {
      type: "error",
      error,
      status,
      code,
      elapsedMs: elapsedMs()
    });
  }

  function closeUpstream(code = 1000, reason = "done"): void {
    if (readyTimeout) {
      clearTimeout(readyTimeout);
      readyTimeout = undefined;
    }
    if (!upstream || upstreamClosed) return;
    upstreamClosed = true;
    try {
      upstream.close(code, reason);
    } catch {
      // Ignore close races between local interruption and upstream completion.
    }
  }

  function closeLocal(code = 1000, reason = "done"): void {
    if (localClosed) return;
    localClosed = true;
    try {
      if (socketIsOpen(local)) local.close(code, reason);
    } catch {
      // Ignore close races between browser cancellation and upstream completion.
    }
  }

  function closeBoth(code = 1000, reason = "done"): void {
    closeUpstream(code, reason);
    closeLocal(code, reason);
  }

  function sendUpstream(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    if (upstream && upstreamReady && socketIsOpen(upstream)) {
      upstream.send(serialized);
      return;
    }
    pendingUpstreamMessages.push(serialized);
  }

  function drainPendingUpstreamMessages(): void {
    if (!upstream || !upstreamReady || !socketIsOpen(upstream)) return;
    while (pendingUpstreamMessages.length > 0) {
      upstream.send(pendingUpstreamMessages.shift() as string);
    }
  }

  function sendInworldText(text: string, flush: boolean): void {
    sendUpstream({
      send_text: {
        text,
        ...(flush ? { flush_context: {} } : {})
      },
      contextId
    });
  }

  function connectUpstream(): void {
    if (upstream || upstreamClosed) return;
    if (!apiKey) {
      sendError("Inworld is not configured. Set INWORLD_API_KEY to enable it.", "not_configured");
      closeLocal(1011, "not configured");
      return;
    }

    upstream = new UpstreamWebSocket(INWORLD_WS_URL, {
      headers: {
        Authorization: `Basic ${apiKey}`
      }
    });
    readyTimeout = setTimeout(() => {
      if (upstreamReady || localClosed) return;
      sendError(`Inworld TTS did not become ready after ${INWORLD_READY_TIMEOUT_MS} ms`, "timeout");
      closeBoth(1011, "ready timeout");
    }, INWORLD_READY_TIMEOUT_MS);
    readyTimeout.unref?.();

    upstream.on("open", () => {
      if (!upstream || upstreamClosed) return;
      upstream.send(
        JSON.stringify({
          create: {
            voiceId: configuredInworldVoiceId(),
            modelId: configuredInworldModelId(),
            audioConfig: {
              audioEncoding: "LINEAR16",
              sampleRateHertz: 16000
            },
            bufferCharThreshold: configuredInworldBufferChars(),
            autoMode: true,
            timestampType: "WORD",
            timestampTransportStrategy: "ASYNC"
          },
          contextId
        })
      );
    });

    upstream.on("message", (data) => {
      let payload: any;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        sendLocal(local, {
          type: "status",
          status: "unparseable_message",
          detail: "Inworld returned a message Mortic could not parse",
          elapsedMs: elapsedMs()
        });
        return;
      }

      const result = payload?.result;
      const status = result?.status;
      if (status && typeof status.code === "number" && status.code !== 0) {
        sendError(status.message || "Inworld WebSocket returned an error", "server_error", status.code);
        closeBoth(1011, "upstream error");
        return;
      }

      if (result?.contextCreated) {
        if (readyTimeout) {
          clearTimeout(readyTimeout);
          readyTimeout = undefined;
        }
        upstreamReady = true;
        sendLocal(local, {
          type: "ready",
          elapsedMs: elapsedMs(),
          format: "pcm_16000"
        });
        drainPendingUpstreamMessages();
        return;
      }

      if (result?.audioChunk?.audioContent) {
        const pcm = wavPcmData(String(result.audioChunk.audioContent));
        if (!pcm) {
          sendError("Inworld returned non-LINEAR16 audio; falling back to the next TTS provider.", "unknown_error");
          closeBoth(1011, "unsupported audio format");
          return;
        }
        sendLocal(local, {
          type: "audio",
          audio: pcm.toString("base64"),
          elapsedMs: elapsedMs(),
          format: "pcm_16000"
        });
      }

      if (result?.contextClosed) {
        sendLocal(local, {
          type: "final",
          elapsedMs: elapsedMs()
        });
        closeBoth(1000, "final");
      }
    });

    upstream.on("close", (code, reason) => {
      upstreamClosed = true;
      if (!localClosed && code !== 1000) {
        const status = code === 1008 ? "auth_error" : code === 1011 ? "server_error" : "network_error";
        sendError(reason.toString() || `Inworld WebSocket closed with code ${code}`, status, code);
        closeLocal(1011, "upstream closed");
      }
    });

    upstream.on("error", () => {
      if (!localClosed) {
        sendError("Inworld WebSocket connection failed", "network_error");
        closeLocal(1011, "upstream error");
      }
    });
  }

  local.on("message", (data) => {
    void messageDataToString(data).then((text) => {
      const message = parseClientMessage(text);
      if (!message) {
        sendError("Invalid WebSocket TTS message");
        return;
      }

      if (message.type === "cancel") {
        closeBoth(1000, "cancelled");
        return;
      }

      connectUpstream();
      if (message.type === "start") return;
      if (message.type === "flush") {
        sendUpstream({ flush_context: {}, contextId });
        return;
      }
      if (message.type === "finish") {
        finishing = true;
        sendUpstream({ close_context: {}, contextId });
        return;
      }
      if (message.type === "text" && message.text.trim()) {
        sendInworldText(message.text.slice(0, 1000), message.flush === true);
      }
    });
  });

  local.on("close", (code, reason) => {
    localClosed = true;
    closeUpstream(code || 1000, reason?.toString() || "local closed");
  });

  local.on("error", () => {
    localClosed = true;
    closeUpstream(1011, "local error");
  });
}

export async function streamElevenLabsTts(text: string): Promise<ElevenLabsStream> {
  const apiKey = elevenLabsApiKey();
  if (!apiKey) {
    throw new Error("ElevenLabs is not configured. Set ELEVENLABS_API_KEY to enable it.");
  }

  const cleanText = text.trim();
  if (!cleanText) {
    throw new Error("TTS text is required");
  }

  const voiceId = configuredElevenLabsVoiceId();
  const url = new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`, ELEVENLABS_BASE_URL);
  url.searchParams.set("output_format", configuredElevenLabsOutputFormat());
  const timeoutMs = configuredElevenLabsTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": apiKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        text: cleanText,
        model_id: configuredElevenLabsModelId(),
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.8,
          style: 0,
          use_speaker_boost: true
        }
      })
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`ElevenLabs TTS timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS failed: ${response.status}${detail ? ` ${detail.slice(0, 240)}` : ""}`);
  }

  return {
    body: response.body,
    contentType: response.headers.get("content-type") ?? "audio/mpeg",
    contentLength: response.headers.get("content-length") ?? undefined
  };
}

export async function probeElevenLabsTts(): Promise<ElevenLabsHealthResponse> {
  const startedAt = Date.now();
  const apiKey = elevenLabsApiKey();
  if (!apiKey) {
    return {
      available: false,
      status: "not_configured",
      detail: "ELEVENLABS_API_KEY is not set",
      elapsedMs: Date.now() - startedAt
    };
  }

  try {
    const stream = await streamElevenLabsTts("Probe.");
    await stream.body.cancel().catch(() => undefined);
    return {
      available: true,
      status: "ok",
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusMatch = message.match(/ElevenLabs TTS failed: (\d+)/);
    const status = statusMatch ? Number(statusMatch[1]) : undefined;
    const classified = status ? classifyElevenLabsStatus(status) : message.toLowerCase().includes("timed out") ? "timeout" : "network_error";
    return {
      available: false,
      status: classified,
      detail: message.slice(0, 240),
      elapsedMs: Date.now() - startedAt
    };
  }
}
