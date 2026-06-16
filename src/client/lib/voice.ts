import type { TtsProvider } from "../../shared/types.js";
import { isSttCreditError } from "../../shared/sttFailure.js";

import { AudioContextConstructor, SpeechLedgerItem } from "./clientTypes.js";
export const MIN_SPEAKABLE_CHARS = 8;
export const BROWSER_FIRST_CHUNK_CHARS = MIN_SPEAKABLE_CHARS;
export const BROWSER_MIN_CHUNK_CHARS = 32;
export const BROWSER_MAX_CHUNK_CHARS = 180;
export const ELEVENLABS_FIRST_CHUNK_CHARS = 16;
export const ELEVENLABS_MIN_CHUNK_CHARS = 80;
export const ELEVENLABS_MAX_CHUNK_CHARS = 260;
export const DEEPGRAM_FIRST_CHUNK_CHARS = 16;
export const DEEPGRAM_MIN_CHUNK_CHARS = 90;
export const DEEPGRAM_MAX_CHUNK_CHARS = 220;
export const REMOTE_STT_SAMPLE_RATE = 16000;
export const SOFT_STT_SEGMENT_MS = 10_000;
export const HARD_STT_SEGMENT_MS = 18_000;
export const MAX_LOCAL_SEGMENT_BYTES = 5 * 1024 * 1024;
export const LIVE_MODE_RUNTIME_ENABLED = false;

export function isRemoteTtsProvider(provider: TtsProvider): boolean {
  return provider === "deepgram" || provider === "elevenlabs" || provider === "elevenlabs-ws" || provider === "inworld-ws";
}

export function isStreamingWsProvider(provider: TtsProvider): boolean {
  return provider === "elevenlabs-ws" || provider === "inworld-ws";
}

export function isBufferedTtsProvider(provider: TtsProvider): boolean {
  return provider === "deepgram" || isStreamingWsProvider(provider);
}

export function isSpeakableText(text: string): boolean {
  return /[A-Za-z0-9]/.test(text) && text.trim().length >= MIN_SPEAKABLE_CHARS;
}

export function findSentenceEnd(text: string, minChars: number): number | null {
  const sentencePattern = /[.!?](?=\s|$)|\n{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = sentencePattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minChars) return end;
  }
  return null;
}

export function lastWhitespaceBefore(text: string, maxChars: number): number | null {
  const safeMax = Math.min(maxChars, text.length);
  const index = text.slice(0, safeMax).search(/\s+\S*$/);
  if (index <= 0) return null;
  return index;
}

export function chooseSpeakableEnd(text: string, start: number, force: boolean, provider: TtsProvider): number | null {
  if (start >= text.length) return null;
  const remaining = text.slice(start);
  if (!isSpeakableText(remaining) && !force) return null;

  const firstChunkChars =
    provider === "deepgram"
      ? DEEPGRAM_FIRST_CHUNK_CHARS
      : isRemoteTtsProvider(provider)
        ? ELEVENLABS_FIRST_CHUNK_CHARS
        : BROWSER_FIRST_CHUNK_CHARS;
  const laterChunkChars =
    provider === "deepgram"
      ? DEEPGRAM_MIN_CHUNK_CHARS
      : isRemoteTtsProvider(provider)
        ? ELEVENLABS_MIN_CHUNK_CHARS
        : BROWSER_MIN_CHUNK_CHARS;
  const minChars = start === 0 ? firstChunkChars : laterChunkChars;
  const maxChars =
    provider === "deepgram"
      ? DEEPGRAM_MAX_CHUNK_CHARS
      : isRemoteTtsProvider(provider)
        ? ELEVENLABS_MAX_CHUNK_CHARS
        : BROWSER_MAX_CHUNK_CHARS;

  if (force) {
    if (!isSpeakableText(remaining)) return null;
    if (remaining.length <= maxChars) return text.length;
    const whitespaceEnd = lastWhitespaceBefore(remaining, maxChars);
    return start + (whitespaceEnd ?? maxChars);
  }

  const sentenceEnd = findSentenceEnd(remaining, minChars);
  if (sentenceEnd !== null && sentenceEnd <= maxChars) return start + sentenceEnd;

  if (remaining.length < maxChars) return null;
  const whitespaceEnd = lastWhitespaceBefore(remaining, maxChars);
  return start + (whitespaceEnd ?? maxChars);
}

export function rangeSummary(items: SpeechLedgerItem[], statuses: SpeechLedgerItem["status"][]): string {
  return items
    .filter((item) => statuses.includes(item.status))
    .map((item) => `${item.start}-${item.end}`)
    .join(",");
}

export function friendlySpeechError(error: string): string {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone or browser speech recognition is not allowed in this browser. Allow microphone access for this localhost page, or use the text box.";
  }

  if (error === "no-speech") {
    return "I did not catch speech. Try again or use the text box.";
  }

  if (error === "network") {
    return "Browser speech recognition hit a network error. Use the text box if it keeps failing.";
  }

  return `Speech recognition failed: ${error}`;
}

// Kept as a thin alias over the shared phrase list; attribution decisions
// (which provider to blame, whether to auto-switch) live in
// shared/sttFailure.ts so the server checks can exercise the same logic.
export function shouldSwitchRemoteSttToBrowser(error: string): boolean {
  return isSttCreditError(error);
}

export function mergeFloat32(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function downsampleFloat32(buffer: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (outputRate === inputRate) return buffer;
  if (outputRate > inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accumulator = 0;
    let count = 0;
    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accumulator += buffer[index];
      count += 1;
    }
    result[offsetResult] = count > 0 ? accumulator / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function audioContextConstructor(): AudioContextConstructor | null {
  const candidate = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}
