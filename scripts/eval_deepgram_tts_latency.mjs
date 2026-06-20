#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocket } from "ws";

const execFileAsync = promisify(execFile);

const DEFAULT_API = "http://127.0.0.1:5152";
const FIRST_CHUNK_CHARS = 16;
const MIN_CHUNK_CHARS = 90;
const MAX_CHUNK_CHARS = 220;
const AUDIO_LEAD_MS = 80;
const PCM_AUDIO_LEAD_MS = 35;
const PCM_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SAMPLE = 2;
const WS_FIRST_AUDIO_TIMEOUT_MS = 7000;
const WS_FINAL_TIMEOUT_MS = 12000;
const DEFAULT_MAX_FIRST_AUDIO_MS = 4000;
const DEFAULT_MAX_PROJECTED_GAP_MS = 350;
const DEFAULT_SAMPLE = [
  "Here is a quick latency check for Mortic voice mode.",
  "The important behavior is not only when the first audio begins, but whether the next phrase is already buffered before the current phrase ends.",
  "Deepgram should stay primary without falling back to Browser speech in the middle of a response.",
  "This test uses several natural sentence groups so the harness can expose gaps between chunks.",
  "If the projected gap is high, increase phrase grouping or investigate provider response time before blaming model streaming."
].join(" ");

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function numberOption(name, fallback) {
  const raw = optionValue(name, "");
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function findSentenceEnd(text, minChars) {
  const sentencePattern = /[.!?](?=\s|$)|\n{2,}/g;
  let match;
  while ((match = sentencePattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minChars) return end;
  }
  return null;
}

function findClauseEnd(text, minChars) {
  const clausePattern = /[,;:](?=\s|$)|[.!?](?=\s|$)|\n+/g;
  let match;
  while ((match = clausePattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minChars && isSpeakableText(text.slice(0, end))) return end;
  }
  return null;
}

function lastWhitespaceBefore(text, maxChars) {
  const safeMax = Math.min(maxChars, text.length);
  const index = text.slice(0, safeMax).search(/\s+\S*$/);
  return index > 0 ? index : null;
}

function isSpeakableText(text) {
  return /[A-Za-z0-9]/.test(text) && text.trim().length >= 8;
}

function chooseSpeakableEnd(text, start, force) {
  if (start >= text.length) return null;
  const remaining = text.slice(start);
  if (!isSpeakableText(remaining) && !force) return null;

  const minChars = start === 0 ? FIRST_CHUNK_CHARS : MIN_CHUNK_CHARS;
  if (force) {
    if (!isSpeakableText(remaining)) return null;
    if (remaining.length <= MAX_CHUNK_CHARS) return text.length;
    const whitespaceEnd = lastWhitespaceBefore(remaining, MAX_CHUNK_CHARS);
    return start + (whitespaceEnd ?? MAX_CHUNK_CHARS);
  }

  const sentenceEnd = start === 0 ? findClauseEnd(remaining, minChars) : findSentenceEnd(remaining, minChars);
  if (sentenceEnd !== null && sentenceEnd <= MAX_CHUNK_CHARS) return start + sentenceEnd;
  if (remaining.length < MAX_CHUNK_CHARS) return null;
  const whitespaceEnd = lastWhitespaceBefore(remaining, MAX_CHUNK_CHARS);
  return start + (whitespaceEnd ?? MAX_CHUNK_CHARS);
}

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const normalEnd = chooseSpeakableEnd(text, start, false);
    const end = normalEnd ?? chooseSpeakableEnd(text, start, true);
    if (end === null || end <= start) break;
    chunks.push({
      index: chunks.length,
      start,
      end,
      chars: end - start,
      text: text.slice(start, end).trim()
    });
    start = end;
  }
  return chunks;
}

async function audioDurationMs(path) {
  try {
    const { stdout } = await execFileAsync("afinfo", [path], { timeout: 5000 });
    const match = stdout.match(/(?:estimated duration|duration):\s*([0-9.]+)\s*sec/i);
    if (match) return Math.round(Number(match[1]) * 1000);
  } catch {
    // Fall through to ffprobe or duration estimate.
  }

  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path],
      { timeout: 5000 }
    );
    const seconds = Number(stdout.trim());
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  } catch {
    // Fall through.
  }

  return null;
}

async function synthesizeChunk(api, chunk, tempDir) {
  const url = new URL("/api/tts/deepgram/stream", api);
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text: chunk.text })
  });
  const headerMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Deepgram local TTS failed for chunk ${chunk.index}: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ""}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const fullMs = Math.round(performance.now() - startedAt);
  const contentType = response.headers.get("content-type") ?? "unknown";
  const extension = contentType.includes("wav") ? "wav" : contentType.includes("mpeg") || contentType.includes("mp3") ? "mp3" : "audio";
  const path = join(tempDir, `chunk-${chunk.index}.${extension}`);
  await writeFile(path, bytes);
  const durationMs = await audioDurationMs(path);

  return {
    ...chunk,
    headerMs,
    fullMs,
    bytes: bytes.length,
    contentType,
    durationMs
  };
}

function projectedPlayback(results) {
  let requestStartMs = 0;
  let nextPlaybackEndMs = 0;
  let firstAudioPlayMs = null;
  const schedule = [];

  for (const result of results) {
    const requestEndMs = requestStartMs + result.fullMs;
    const startAtMs = Math.max(requestEndMs + AUDIO_LEAD_MS, nextPlaybackEndMs);
    const durationMs = result.durationMs ?? Math.max(800, Math.round(result.chars * 45));
    const endAtMs = startAtMs + durationMs;
    const gapMs = schedule.length === 0 ? 0 : Math.max(0, startAtMs - nextPlaybackEndMs);
    if (firstAudioPlayMs === null) firstAudioPlayMs = startAtMs;
    schedule.push({
      index: result.index,
      requestStartMs,
      requestEndMs,
      startAtMs,
      endAtMs,
      durationMs,
      gapMs
    });
    requestStartMs = requestEndMs;
    nextPlaybackEndMs = endAtMs;
  }

  const gaps = schedule.map((item) => item.gapMs);
  return {
    firstAudioPlayMs,
    maxGapMs: Math.max(0, ...gaps),
    totalGapMs: gaps.reduce((sum, gap) => sum + gap, 0),
    schedule
  };
}

function localWebSocketUrl(api, path) {
  const url = new URL(path, api);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function projectedPcmPlayback(audioEvents) {
  let nextPlaybackEndMs = 0;
  let firstAudioPlayMs = null;
  const schedule = [];

  for (const event of audioEvents) {
    const startAtMs = Math.max(event.atMs + PCM_AUDIO_LEAD_MS, nextPlaybackEndMs);
    const endAtMs = startAtMs + event.durationMs;
    const gapMs = schedule.length === 0 ? 0 : Math.max(0, startAtMs - nextPlaybackEndMs);
    if (firstAudioPlayMs === null) firstAudioPlayMs = startAtMs;
    schedule.push({
      index: event.index,
      atMs: event.atMs,
      bytes: event.bytes,
      startAtMs,
      endAtMs,
      durationMs: event.durationMs,
      gapMs
    });
    nextPlaybackEndMs = endAtMs;
  }

  const gaps = schedule.map((item) => item.gapMs);
  return {
    firstAudioPlayMs,
    maxGapMs: Math.max(0, ...gaps),
    totalGapMs: gaps.reduce((sum, gap) => sum + gap, 0),
    audioEventCount: audioEvents.length,
    schedule
  };
}

function boundedList(items, count = 5) {
  if (items.length <= count * 2) return items;
  return {
    count: items.length,
    first: items.slice(0, count),
    last: items.slice(-count)
  };
}

function compactRun(run) {
  return {
    ...run,
    audioEvents: Array.isArray(run.audioEvents) ? boundedList(run.audioEvents) : run.audioEvents,
    playback: run.playback
      ? {
          ...run.playback,
          schedule: Array.isArray(run.playback.schedule) ? boundedList(run.playback.schedule) : run.playback.schedule
        }
      : run.playback
  };
}

async function synthesizeWsRun(api, chunks, run) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(localWebSocketUrl(api, "/api/tts/deepgram/ws"));
    const openedAt = performance.now();
    let readyAt = 0;
    let firstTextAt = 0;
    let pendingFirstAudio = null;
    let finalSettled = false;
    const statuses = [];
    const audioEvents = [];
    const chunkResults = [];

    function elapsedFromFirstText() {
      return firstTextAt ? Math.round(performance.now() - firstTextAt) : 0;
    }

    function settle(error) {
      if (finalSettled) return;
      finalSettled = true;
      try {
        socket.close(1000, "done");
      } catch {
        // Ignore close races during harness cleanup.
      }
      if (error) {
        reject(error);
        return;
      }
      const playback = projectedPcmPlayback(audioEvents);
      resolve({
        run,
        mode: "ws",
        connectMs: Math.round(readyAt - openedAt),
        chunks: chunkResults,
        audioEvents,
        statuses,
        playback,
        pass: playback.firstAudioPlayMs <= numberOption("--max-first-audio-ms", Number(process.env.MORTIC_DEEPGRAM_TTS_MAX_FIRST_AUDIO_MS) || DEFAULT_MAX_FIRST_AUDIO_MS) &&
          playback.maxGapMs <= numberOption("--max-gap-ms", Number(process.env.MORTIC_DEEPGRAM_TTS_MAX_GAP_MS) || DEFAULT_MAX_PROJECTED_GAP_MS)
      });
    }

    async function sendChunks() {
      firstTextAt = performance.now();
      for (const chunk of chunks) {
        const sendAtMs = elapsedFromFirstText();
        const firstAudioPromise = new Promise((resolveFirstAudio, rejectFirstAudio) => {
          pendingFirstAudio = {
            resolve: resolveFirstAudio,
            reject: rejectFirstAudio,
            sendAtMs
          };
        });
        socket.send(
          JSON.stringify({
            type: "text",
            text: chunk.text,
            flush: true
          })
        );
        const firstAudioAtMs = await withTimeout(firstAudioPromise, WS_FIRST_AUDIO_TIMEOUT_MS, `first audio for chunk ${chunk.index}`);
        chunkResults.push({
          ...chunk,
          sendAtMs,
          firstAudioMs: firstAudioAtMs - sendAtMs
        });
      }
      socket.send(JSON.stringify({ type: "finish" }));
      await withTimeout(
        new Promise((resolveFinal) => {
          const check = () => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolveFinal();
              return;
            }
            setTimeout(check, 50);
          };
          check();
        }),
        WS_FINAL_TIMEOUT_MS,
        "Deepgram WS final"
      ).catch(() => undefined);
      settle();
    }

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "start" }));
    });

    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        statuses.push({ atMs: elapsedFromFirstText(), status: "unparseable_local_message" });
        return;
      }

      if (message.type === "ready") {
        readyAt = performance.now();
        void sendChunks().catch(settle);
        return;
      }

      if (message.type === "audio") {
        const atMs = elapsedFromFirstText();
        const bytes = Buffer.from(String(message.audio), "base64").length;
        const durationMs = Math.max(1, Math.round((bytes / PCM_BYTES_PER_SAMPLE / PCM_SAMPLE_RATE) * 1000));
        audioEvents.push({
          index: audioEvents.length,
          atMs,
          bytes,
          durationMs
        });
        if (pendingFirstAudio) {
          const waiter = pendingFirstAudio;
          pendingFirstAudio = null;
          waiter.resolve(atMs);
        }
        return;
      }

      if (message.type === "status") {
        statuses.push({
          atMs: elapsedFromFirstText(),
          status: message.status,
          detail: message.detail
        });
        return;
      }

      if (message.type === "error") {
        settle(new Error(message.error ?? "Deepgram WS returned an error"));
      }
    });

    socket.on("close", () => {
      if (!finalSettled && chunkResults.length === chunks.length) settle();
    });

    socket.on("error", () => {
      settle(new Error("Local Deepgram WS connection failed"));
    });
  });
}

async function main() {
  const api = optionValue("--api", process.env.MORTIC_API ?? DEFAULT_API);
  const mode = optionValue("--mode", process.env.MORTIC_DEEPGRAM_TTS_EVAL_MODE ?? "ws");
  const text = optionValue("--text", process.env.MORTIC_DEEPGRAM_TTS_EVAL_TEXT ?? DEFAULT_SAMPLE);
  const repeat = numberOption("--repeat", 1);
  const maxFirstAudioMs = numberOption("--max-first-audio-ms", Number(process.env.MORTIC_DEEPGRAM_TTS_MAX_FIRST_AUDIO_MS) || DEFAULT_MAX_FIRST_AUDIO_MS);
  const maxProjectedGapMs = numberOption("--max-gap-ms", Number(process.env.MORTIC_DEEPGRAM_TTS_MAX_GAP_MS) || DEFAULT_MAX_PROJECTED_GAP_MS);

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    throw new Error("No speakable chunks produced for eval text.");
  }

  const runs = [];
  if (mode === "ws") {
    for (let runIndex = 0; runIndex < repeat; runIndex += 1) {
      runs.push(await synthesizeWsRun(api, chunks, runIndex + 1));
    }
  } else if (mode === "rest") {
    const tempDir = await mkdtemp(join(tmpdir(), "mortic-deepgram-tts-"));
    try {
      for (let runIndex = 0; runIndex < repeat; runIndex += 1) {
        const results = [];
        for (const chunk of chunks) {
          results.push(await synthesizeChunk(api, chunk, tempDir));
        }
        const playback = projectedPlayback(results);
        runs.push({
          run: runIndex + 1,
          mode: "rest",
          chunks: results,
          playback,
          pass: playback.firstAudioPlayMs <= maxFirstAudioMs && playback.maxGapMs <= maxProjectedGapMs
        });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } else {
    throw new Error(`Unknown mode "${mode}". Use --mode ws or --mode rest.`);
  }

  const firstAudioValues = runs.map((run) => run.playback.firstAudioPlayMs ?? 0);
  const maxGapValues = runs.map((run) => run.playback.maxGapMs);
  const summary = {
    api,
    mode,
    chunkPolicy: {
      firstChunkChars: FIRST_CHUNK_CHARS,
      minChunkChars: MIN_CHUNK_CHARS,
      maxChunkChars: MAX_CHUNK_CHARS,
      audioLeadMs: mode === "ws" ? PCM_AUDIO_LEAD_MS : AUDIO_LEAD_MS
    },
    thresholds: {
      maxFirstAudioMs,
      maxProjectedGapMs
    },
    textChars: text.length,
    chunkCount: chunks.length,
    repeat,
    bestFirstAudioMs: Math.min(...firstAudioValues),
    worstFirstAudioMs: Math.max(...firstAudioValues),
    worstProjectedGapMs: Math.max(...maxGapValues),
    pass: runs.every((run) => run.pass)
  };

  console.log(JSON.stringify({ summary, runs: runs.map(compactRun) }, null, 2));
  if (!summary.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
