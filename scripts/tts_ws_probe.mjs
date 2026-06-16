import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { WebSocket } from "ws";

const DEFAULT_TEXT = "Hello from Mortic. This is a short test of the voice pipeline.";
const SAMPLE_RATE = 16000;

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function wsUrl(apiBase, provider) {
  const route = provider === "inworld-ws" ? "/api/tts/inworld/ws" : "/api/tts/elevenlabs/ws";
  const url = new URL(route, apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);
    if (id === "fmt " && size >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    }
    if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }

  if (!fmt || !data) return null;
  return { ...fmt, data, bytes: buffer.length };
}

function wavHeader(dataBytes, sampleRate = SAMPLE_RATE, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function pcmStats(buffer, bitsPerSample = 16) {
  if (bitsPerSample !== 16 || buffer.length < 2) return null;
  let peak = 0;
  let sumSquares = 0;
  let zeroCrossings = 0;
  let previous = 0;
  const samples = Math.floor(buffer.length / 2);
  for (let index = 0; index < samples; index += 1) {
    const value = buffer.readInt16LE(index * 2);
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    sumSquares += value * value;
    if (index > 0 && ((value >= 0 && previous < 0) || (value < 0 && previous >= 0))) zeroCrossings += 1;
    previous = value;
  }
  return {
    samples,
    durationMs: Math.round((samples / SAMPLE_RATE) * 1000),
    peak,
    rms: Math.round(Math.sqrt(sumSquares / samples)),
    zeroCrossings
  };
}

async function probeProvider({ provider, apiBase, text, outputDir }) {
  const startedAt = Date.now();
  const events = [];
  const chunks = [];
  const url = wsUrl(apiBase, provider);

  await mkdir(outputDir, { recursive: true });

  return await new Promise((resolve) => {
    const socket = new WebSocket(url);
    let settled = false;
    let finishTimer = null;
    const timeout = setTimeout(() => finish("timeout"), 20000);

    function elapsedMs() {
      return Date.now() - startedAt;
    }

    async function finish(reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (finishTimer) clearTimeout(finishTimer);
      try {
        socket.close(1000, reason);
      } catch {
        // Ignore close races.
      }

      const pcmParts = [];
      let firstFormat = null;
      let firstWav = null;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        await writeFile(path.join(outputDir, `${provider}-chunk-${index + 1}.${chunk.ext}`), chunk.bytes);
        if (chunk.wav) {
          firstWav ??= chunk.wav;
          pcmParts.push(chunk.wav.data);
        } else {
          pcmParts.push(chunk.bytes);
        }
        firstFormat ??= chunk.format;
      }

      const pcm = Buffer.concat(pcmParts);
      const combinedPath = path.join(outputDir, `${provider}-combined.wav`);
      if (pcm.length > 0) {
        const sampleRate = firstWav?.sampleRate ?? SAMPLE_RATE;
        const channels = firstWav?.channels ?? 1;
        const bits = firstWav?.bitsPerSample ?? 16;
        await writeFile(combinedPath, Buffer.concat([wavHeader(pcm.length, sampleRate, channels, bits), pcm]));
      }

      resolve({
        provider,
        reason,
        url,
        events,
        chunks: chunks.map((chunk) => ({
          format: chunk.format,
          ext: chunk.ext,
          bytes: chunk.bytes.length,
          wav: chunk.wav
            ? {
                audioFormat: chunk.wav.audioFormat,
                channels: chunk.wav.channels,
                sampleRate: chunk.wav.sampleRate,
                bitsPerSample: chunk.wav.bitsPerSample,
                dataBytes: chunk.wav.data.length
              }
            : null,
          pcmStats: chunk.wav ? pcmStats(chunk.wav.data, chunk.wav.bitsPerSample) : pcmStats(chunk.bytes)
        })),
        combined: pcm.length > 0
          ? {
              path: combinedPath,
              bytes: pcm.length,
              stats: pcmStats(pcm, firstWav?.bitsPerSample ?? 16)
            }
          : null
      });
    }

    socket.on("open", () => {
      events.push({ type: "open", elapsedMs: elapsedMs() });
      socket.send(JSON.stringify({ type: "start" }));
      socket.send(JSON.stringify({ type: "text", text, flush: true }));
      finishTimer = setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "finish" }));
      }, 250);
    });

    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        events.push({ type: "unparseable", elapsedMs: elapsedMs(), bytes: data.length });
        return;
      }

      if (message.type !== "audio") {
        events.push({
          type: message.type,
          elapsedMs: elapsedMs(),
          status: message.status,
          error: message.error,
          detail: message.detail,
          format: message.format
        });
      }

      if (message.type === "audio") {
        const bytes = Buffer.from(message.audio, "base64");
        const wav = parseWav(bytes);
        const ext = wav ? "wav" : "bin";
        chunks.push({
          format: message.format,
          bytes,
          wav,
          ext
        });
        events.push({
          type: "audio",
          elapsedMs: elapsedMs(),
          format: message.format,
          bytes: bytes.length,
          magic: bytes.subarray(0, 12).toString("ascii").replace(/[^\x20-\x7E]/g, "."),
          wav: Boolean(wav)
        });
      }

      if (message.type === "final" || message.type === "error") {
        void finish(message.type);
      }
    });

    socket.on("close", (code, reason) => {
      events.push({ type: "close", elapsedMs: elapsedMs(), code, reason: reason.toString() });
      void finish("close");
    });

    socket.on("error", (error) => {
      events.push({ type: "socket_error", elapsedMs: elapsedMs(), error: error.message });
      void finish("socket_error");
    });
  });
}

async function main() {
  const apiBase = argValue("api", "http://127.0.0.1:5152");
  const providerArg = argValue("provider", "inworld-ws");
  const text = argValue("text", DEFAULT_TEXT);
  const outputDir = argValue("out", path.join("artifacts", "tts-probe", new Date().toISOString().replace(/[:.]/g, "-")));
  const providers = providerArg === "all" ? ["inworld-ws", "elevenlabs-ws"] : [providerArg];
  const results = [];

  for (const provider of providers) {
    results.push(await probeProvider({ provider, apiBase, text, outputDir }));
  }

  const report = { apiBase, outputDir, text, results };
  await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, hasArg("compact") ? 0 : 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
