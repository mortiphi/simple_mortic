import assert from "node:assert/strict";

import { modelProfile } from "../dist/node/shared/modelProfiles.js";
import { parseMorticVoice, partialSpokenText } from "../dist/node/shared/voiceResponse.js";
import { getLiveKitStatus } from "../dist/node/server/livekit.js";
import { configuredMaxSttPayloadBytes, getSttStatus, transcribeAudioWithFallback } from "../dist/node/server/stt.js";
import { createHandoffPrompt } from "../dist/node/server/codex.js";

const validVoice = [
  JSON.stringify({ type: "speak", text: "Deepgram Nova-2 should be the first STT path, with Inworld, Whisper, and Browser available as fallbacks." }),
  JSON.stringify({ type: "read", markdown: "- Primary STT: Deepgram Nova-2\n- Fallback STT: Inworld, then Whisper\n- Free fallback: Browser SpeechRecognition" })
].join("\n");

const parsed = parseMorticVoice(validVoice);
assert.equal(parsed.ok, true);
assert.equal(parsed.ok ? parsed.parts.spokenText.includes("Deepgram") : false, true);
assert.equal(partialSpokenText(`${validVoice.split("\n")[0]}\n`), "Deepgram Nova-2 should be the first STT path, with Inworld, Whisper, and Browser available as fallbacks.");

const browserOnly = getSttStatus({});
assert.equal(browserOnly.defaultProvider, "browser");
assert.deepEqual(browserOnly.availableProviders, ["browser"]);

const whisperOnly = getSttStatus({ OPENAI_API_KEY: "test-openai" });
assert.equal(whisperOnly.defaultProvider, "whisper");
assert.deepEqual(whisperOnly.availableProviders, ["whisper", "browser"]);

const deepgramOnly = getSttStatus({ DEEPGRAM_API_KEY: "test-deepgram" });
assert.equal(deepgramOnly.defaultProvider, "deepgram-stt");
assert.deepEqual(deepgramOnly.availableProviders, ["deepgram-stt", "browser"]);
assert.equal(deepgramOnly.deepgramModel, "nova-2");

const inworldOnly = getSttStatus({ INWORLD_API_KEY: "test-inworld" });
assert.equal(inworldOnly.defaultProvider, "inworld-stt");
assert.deepEqual(inworldOnly.availableProviders, ["inworld-stt", "browser"]);

const bothRemote = getSttStatus({ INWORLD_API_KEY: "test-inworld", OPENAI_API_KEY: "test-openai" });
assert.equal(bothRemote.defaultProvider, "inworld-stt");
assert.deepEqual(bothRemote.availableProviders, ["inworld-stt", "whisper", "browser"]);
assert.equal(typeof bothRemote.maxPayloadBytes, "number");

const allRemote = getSttStatus({ DEEPGRAM_API_KEY: "test-deepgram", INWORLD_API_KEY: "test-inworld", OPENAI_API_KEY: "test-openai" });
assert.equal(allRemote.defaultProvider, "deepgram-stt");
assert.deepEqual(allRemote.availableProviders, ["deepgram-stt", "inworld-stt", "whisper", "browser"]);

const forcedWhisper = getSttStatus({
  DEEPGRAM_API_KEY: "test-deepgram",
  INWORLD_API_KEY: "test-inworld",
  OPENAI_API_KEY: "test-openai",
  MORTIC_STT_PROVIDER: "whisper"
});
assert.equal(forcedWhisper.defaultProvider, "whisper");

const forcedDeepgram = getSttStatus({
  DEEPGRAM_API_KEY: "test-deepgram",
  INWORLD_API_KEY: "test-inworld",
  MORTIC_STT_PROVIDER: "deepgram-stt",
  DEEPGRAM_STT_MODEL: "nova-2"
});
assert.equal(forcedDeepgram.defaultProvider, "deepgram-stt");
assert.equal(forcedDeepgram.deepgramModel, "nova-2");

await assert.rejects(
  () => transcribeAudioWithFallback({ provider: "inworld-stt", audioBase64: "AA==" }, {}),
  /not configured|No remote STT/
);

assert.equal(modelProfile("gpt-5.5").contextWindowTokens, 256000);
assert.equal(modelProfile("gpt-5.3-codex-spark").contextWindowTokens, 127000);

assert.equal(configuredMaxSttPayloadBytes({}), 8 * 1024 * 1024);
assert.equal(configuredMaxSttPayloadBytes({ MORTIC_MAX_STT_PAYLOAD_MB: "2" }), 2 * 1024 * 1024);

const noLiveKit = getLiveKitStatus({});
assert.equal(noLiveKit.configured, false);
assert.deepEqual(noLiveKit.availableTransports, ["local-browser"]);

const liveKitReady = getLiveKitStatus({
  LIVEKIT_URL: "wss://fixture.livekit.cloud",
  LIVEKIT_API_KEY: "key",
  LIVEKIT_API_SECRET: "secret"
});
assert.equal(liveKitReady.configured, true);
assert.equal(liveKitReady.defaultTransport, "livekit-webrtc");
assert.deepEqual(liveKitReady.availableTransports, ["livekit-webrtc", "local-browser"]);

const prompt = createHandoffPrompt({
  sourceUri: "codex://threads/source",
  transcriptMarkdown: "## user\nPlease fix the voice transport.",
  checkpoint: {
    sourceThreadId: "source",
    scratchThreadId: "scratch",
    forkedAt: "2026-05-02T00:00:00.000Z",
    checkpointInstruction: "Prioritize post-checkpoint work."
  }
});
assert.match(prompt, /Prioritize decisions, actionables, risks, tests, conclusions/);
assert.match(prompt, /must not mention the checkpoint, scratch fork, thread IDs/);

console.log("Voice pipeline checks passed");
