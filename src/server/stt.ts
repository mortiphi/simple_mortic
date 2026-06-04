import type { SttProvider, SttStatus, SttTranscriptionRequest, SttTranscriptionResponse } from "../shared/types.js";

const INWORLD_STT_URL = "https://api.inworld.ai/stt/v1/transcribe";
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_INWORLD_STT_MODEL = "inworld/inworld-stt-1";
const DEFAULT_WHISPER_MODEL = "whisper-1";
const DEFAULT_STT_TIMEOUT_MS = 12000;
const DEFAULT_MAX_STT_PAYLOAD_MB = 8;

type WavInfo = {
  data: Buffer;
  sampleRate: number;
  bitsPerSample: number;
  channels: number;
};

function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function inworldApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("INWORLD_API_KEY", env);
}

function openAIKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("OPENAI_API_KEY", env);
}

function configuredInworldModel(env: NodeJS.ProcessEnv = process.env): string {
  return envValue("MORTIC_STT_INWORLD_MODEL", env) ?? DEFAULT_INWORLD_STT_MODEL;
}

function configuredWhisperModel(env: NodeJS.ProcessEnv = process.env): string {
  return envValue("MORTIC_STT_WHISPER_MODEL", env) ?? DEFAULT_WHISPER_MODEL;
}

function configuredDefaultProvider(env: NodeJS.ProcessEnv = process.env): SttProvider {
  const requested = envValue("MORTIC_STT_PROVIDER", env);
  if (requested === "browser") return "browser";
  if (requested === "whisper" && openAIKey(env)) return "whisper";
  if (requested === "inworld-stt" && inworldApiKey(env)) return "inworld-stt";
  if (inworldApiKey(env)) return "inworld-stt";
  return openAIKey(env) ? "whisper" : "browser";
}

function configuredTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(envValue("MORTIC_STT_TIMEOUT_MS", env));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STT_TIMEOUT_MS;
  return Math.max(2000, Math.min(60000, Math.floor(parsed)));
}

export function configuredMaxSttPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(envValue("MORTIC_MAX_STT_PAYLOAD_MB", env));
  const megabytes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STT_PAYLOAD_MB;
  return Math.floor(Math.max(1, Math.min(64, megabytes)) * 1024 * 1024);
}

function defaultLanguage(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("MORTIC_STT_LANGUAGE", env) ?? "en-US";
}

function defaultPrompt(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue("MORTIC_STT_PROMPT", env);
}

export function getSttStatus(env: NodeJS.ProcessEnv = process.env): SttStatus {
  const inworldConfigured = Boolean(inworldApiKey(env));
  const openAIConfigured = Boolean(openAIKey(env));
  const availableProviders: SttProvider[] = [];
  if (inworldConfigured) availableProviders.push("inworld-stt");
  if (openAIConfigured) availableProviders.push("whisper");
  availableProviders.push("browser");

  return {
    defaultProvider: configuredDefaultProvider(env),
    availableProviders,
    inworldConfigured,
    inworldModel: inworldConfigured ? configuredInworldModel(env) : undefined,
    openAIConfigured,
    whisperModel: openAIConfigured ? configuredWhisperModel(env) : undefined,
    maxPayloadBytes: configuredMaxSttPayloadBytes(env)
  };
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stripDataUrlPrefix(audioBase64: string): string {
  const commaIndex = audioBase64.indexOf(",");
  if (commaIndex > 0 && audioBase64.slice(0, commaIndex).includes("base64")) {
    return audioBase64.slice(commaIndex + 1);
  }
  return audioBase64;
}

function audioBufferFromBase64(audioBase64: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const cleanAudio = safeText(audioBase64);
  if (!cleanAudio) throw new Error("Audio payload is required for transcription.");
  const audio = Buffer.from(stripDataUrlPrefix(cleanAudio), "base64");
  if (audio.length === 0) throw new Error("Audio payload was empty.");
  const maxAudioBytes = configuredMaxSttPayloadBytes(env);
  if (audio.length > maxAudioBytes) {
    throw new Error(`Audio payload is too large: ${audio.length} bytes. Limit is ${maxAudioBytes} bytes; raise MORTIC_MAX_STT_PAYLOAD_MB or use segmented capture.`);
  }
  return audio;
}

function extensionForMime(mimeType: string | undefined): string {
  const clean = mimeType?.toLowerCase() ?? "";
  if (clean.includes("wav")) return "wav";
  if (clean.includes("mp4") || clean.includes("m4a")) return "m4a";
  if (clean.includes("mpeg") || clean.includes("mp3")) return "mp3";
  if (clean.includes("ogg")) return "ogg";
  return "webm";
}

function parseWav(buffer: Buffer): WavInfo | null {
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

  if (!data || !sampleRate || !bitsPerSample || !channels) return null;
  return { data, sampleRate, bitsPerSample, channels };
}

async function fetchWithTimeout(url: string, init: RequestInit, env: NodeJS.ProcessEnv): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), configuredTimeoutMs(env));
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`STT request timed out after ${configuredTimeoutMs(env)} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribeInworldAudio(
  request: SttTranscriptionRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<SttTranscriptionResponse> {
  const startedAt = Date.now();
  const apiKey = inworldApiKey(env);
  if (!apiKey) throw new Error("Inworld STT is not configured. Set INWORLD_API_KEY to enable it.");

  const audio = audioBufferFromBase64(request.audioBase64, env);
  const wav = parseWav(audio);
  const pcm =
    wav && wav.bitsPerSample === 16 && wav.channels === 1
      ? {
          content: audio.toString("base64"),
          sampleRateHertz: wav.sampleRate,
          audioEncoding: "LINEAR16"
        }
      : {
          content: audio.toString("base64"),
          sampleRateHertz: undefined,
          audioEncoding: "AUTO_DETECT"
        };

  const response = await fetchWithTimeout(
    INWORLD_STT_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        transcribeConfig: {
          modelId: configuredInworldModel(env),
          audioEncoding: pcm.audioEncoding,
          language: safeText(request.language) || defaultLanguage(env),
          ...(pcm.sampleRateHertz ? { sampleRateHertz: pcm.sampleRateHertz } : {}),
          numberOfChannels: wav?.channels ?? 1
        },
        audioData: {
          content: pcm.content
        }
      })
    },
    env
  );

  const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => "") })) as {
    transcription?: { transcript?: unknown };
    code?: unknown;
    message?: unknown;
    error?: unknown;
  };

  if (!response.ok) {
    const detail =
      typeof payload.message === "string"
        ? payload.message
        : typeof payload.error === "string"
          ? payload.error
          : `Inworld STT failed with status ${response.status}`;
    throw new Error(detail.slice(0, 300));
  }

  const text = safeText(payload.transcription?.transcript);
  if (!text) throw new Error("Inworld STT returned empty text.");

  return {
    text,
    provider: "inworld-stt",
    model: configuredInworldModel(env),
    elapsedMs: Date.now() - startedAt
  };
}

export async function transcribeWhisperAudio(
  request: SttTranscriptionRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<SttTranscriptionResponse> {
  const startedAt = Date.now();
  const apiKey = openAIKey(env);
  if (!apiKey) throw new Error("Whisper STT is not configured. Set OPENAI_API_KEY to enable it.");

  const audio = audioBufferFromBase64(request.audioBase64, env);
  const mimeType = safeText(request.mimeType) || "audio/wav";
  const extension = extensionForMime(mimeType);
  const form = new FormData();
  form.append("model", configuredWhisperModel(env));
  form.append("response_format", "json");
  const language = safeText(request.language) || defaultLanguage(env);
  if (language) form.append("language", language.replace(/-.+$/, ""));
  const prompt = safeText(request.prompt) || defaultPrompt(env);
  if (prompt) form.append("prompt", prompt);
  form.append("file", new Blob([audio], { type: mimeType }), `mortic-recording.${extension}`);

  const response = await fetchWithTimeout(
    OPENAI_TRANSCRIPTION_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    },
    env
  );
  const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => "") })) as {
    text?: unknown;
    error?: unknown;
  };

  if (!response.ok) {
    const detail =
      typeof payload.error === "object" && payload.error && "message" in payload.error
        ? String((payload.error as { message?: unknown }).message)
        : typeof payload.error === "string"
          ? payload.error
          : `Whisper STT failed with status ${response.status}`;
    throw new Error(detail.slice(0, 300));
  }

  const text = safeText(payload.text);
  if (!text) throw new Error("Whisper STT returned empty text.");

  return {
    text,
    provider: "whisper",
    model: configuredWhisperModel(env),
    elapsedMs: Date.now() - startedAt
  };
}

export async function transcribeAudioWithFallback(
  request: SttTranscriptionRequest,
  env: NodeJS.ProcessEnv = process.env
): Promise<SttTranscriptionResponse & { fallbackReason?: string }> {
  const requested = request.provider ?? getSttStatus(env).defaultProvider;
  const failures: string[] = [];
  const order: SttProvider[] =
    requested === "inworld-stt"
      ? ["inworld-stt", "whisper"]
      : requested === "whisper"
        ? ["whisper", "inworld-stt"]
        : ["browser"];

  for (const provider of order) {
    try {
      if (provider === "inworld-stt" && inworldApiKey(env)) {
        const result = await transcribeInworldAudio(request, env);
        return failures.length > 0 ? { ...result, fallbackReason: failures.join(" | ") } : result;
      }
      if (provider === "whisper" && openAIKey(env)) {
        const result = await transcribeWhisperAudio(request, env);
        return failures.length > 0 ? { ...result, fallbackReason: failures.join(" | ") } : result;
      }
      if (provider !== "browser") failures.push(`${provider} is not configured`);
    } catch (error) {
      failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(failures.length > 0 ? failures.join(" | ") : "No remote STT provider is configured.");
}
