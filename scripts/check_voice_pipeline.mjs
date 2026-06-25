import assert from "node:assert/strict";

import { modelProfile } from "../dist/node/shared/modelProfiles.js";
import { parseMorticVoice, partialSpokenText } from "../dist/node/shared/voiceResponse.js";
import { codexTurnPrompt, createHandoffPrompt } from "../dist/node/server/codex.js";
import { getLiveKitStatus } from "../dist/node/server/livekit.js";
import { configuredMaxSttPayloadBytes, getSttStatus, transcribeAudioWithFallback } from "../dist/node/server/stt.js";
import { VOICE_DEVELOPER_INSTRUCTIONS, voicePrompt } from "../dist/node/server/voiceContract.js";

const validVoice = [
  JSON.stringify({ type: "speak", text: "Deepgram Nova-2 should be the first STT path, with Inworld, Whisper, and Browser available as fallbacks." }),
  JSON.stringify({ type: "read", markdown: "- Primary STT: Deepgram Nova-2\n- Fallback STT: Inworld, then Whisper\n- Free fallback: Browser SpeechRecognition" })
].join("\n");

const parsed = parseMorticVoice(validVoice);
assert.equal(parsed.ok, true);
assert.equal(parsed.ok ? parsed.parts.spokenText.includes("Deepgram") : false, true);
assert.equal(parsed.ok ? parsed.parts.notesText.includes("Primary STT") : false, true);

const validSchemaVoice = JSON.stringify({
  speak: {
    text: "The voice schema is working, and the listener can understand the answer without the screen."
  },
  read: {
    markdown: "- File: `/Users/aeroknight/Downloads/as/Codex Voice/src/server/codex.ts`\n- Command: `npm run typecheck`"
  }
});
const parsedSchema = parseMorticVoice(validSchemaVoice);
assert.equal(parsedSchema.ok, true);
assert.equal(parsedSchema.ok ? parsedSchema.parts.parserMode : undefined, "schema");
assert.equal(
  parsedSchema.ok ? parsedSchema.parts.spokenText : "",
  "The voice schema is working, and the listener can understand the answer without the screen."
);
assert.match(parsedSchema.ok ? parsedSchema.parts.notesText ?? "" : "", /src\/server\/codex\.ts/);
assert.match(parsedSchema.ok ? parsedSchema.parts.notesText ?? "" : "", /npm run typecheck/);

assert.equal(parseMorticVoice(validVoice.split("\n")[0]).ok, false, "final voice output must include read record");
assert.equal(parseMorticVoice(`${validVoice}\n${JSON.stringify({ type: "read", markdown: "extra" })}`).ok, false, "final voice output must contain exactly two records");
assert.equal(parseMorticVoice(JSON.stringify({ speak: { text: "" }, read: { markdown: "missing spoken text" } })).ok, false, "schema output must require speak.text");
assert.equal(parseMorticVoice("plain malformed assistant text").ok, false, "malformed voice output must fail safely");
assert.equal(partialSpokenText(`${validVoice.split("\n")[0]}\n`), "Deepgram Nova-2 should be the first STT path, with Inworld, Whisper, and Browser available as fallbacks.");
assert.equal(partialSpokenText('{"type":"speak","text":"Deepgram can start speaking before the JSON line closes.'), "Deepgram can start speaking before the JSON line closes.");
assert.equal(partialSpokenText('{"type":"speak","text":"Escaped newline:\\nnext phrase'), "Escaped newline:\nnext phrase");
assert.equal(partialSpokenText('{"type":"read","text":"This must not be spoken.'), "");
assert.equal(partialSpokenText('{"type":"speak","text":"Do not include a half escape: \\'), "Do not include a half escape:");

const userText = "Please inspect src/server/codex.ts and explain the result.";
assert.equal(codexTurnPrompt(userText, "voice"), userText, "voice mode must send the raw user text");
assert.equal(codexTurnPrompt(userText, "text"), userText, "text mode must send the raw user text");
assert.equal(voicePrompt(userText), userText, "voice prompt helper must not prepend a per-turn wrapper");
assert.equal(
  VOICE_DEVELOPER_INSTRUCTIONS,
  "Use speak.text for the complete spoken answer and read.markdown for the readable screen version."
);

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


// --- STT failure attribution and empty-transcript regression -------------
// Bug history: a silent recording made Deepgram return an empty transcript,
// which was treated as an error, cascaded into Inworld (genuinely out of
// credits), and the UI blamed Deepgram and force-switched to browser STT.
const { attributeSttFailure, isSttCreditError } = await import("../dist/node/shared/sttFailure.js");

assert.equal(isSttCreditError("You have no credits remaining. Please add credits to continue."), true);
assert.equal(isSttCreditError("Project does not have enough credits"), true, "Deepgram 402 wording must count as a credit error");
assert.equal(isSttCreditError("STT request timed out after 12000 ms."), false);

const sttEnv = { DEEPGRAM_API_KEY: "test-dg", INWORLD_API_KEY: "test-iw" };
const sttRequest = { provider: "deepgram-stt", audioBase64: Buffer.from("fixture-audio").toString("base64"), mimeType: "audio/wav" };
const realFetch = globalThis.fetch;
const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

try {
  // 1. Empty transcript is a SUCCESS with empty text; no fallback request.
  let fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return jsonResponse(200, { results: { channels: [{ alternatives: [{ transcript: "   " }] }] } });
  };
  const silent = await transcribeAudioWithFallback(sttRequest, sttEnv);
  assert.equal(silent.text, "", "empty transcript should resolve as success with empty text");
  assert.equal(silent.provider, "deepgram-stt");
  assert.equal(silent.failures, undefined, "a clean empty result should carry no failures");
  assert.equal(fetchCalls.length, 1, "empty transcript must not trigger fallback providers");
  assert.match(fetchCalls[0], /deepgram/);

  // 2. Requested provider fails (non-billing), fallback provider is out of
  //    credits: failures must be structured per provider, and attribution
  //    must blame the fallback, not the requested provider, with no switch.
  globalThis.fetch = async (url) => {
    if (String(url).includes("deepgram")) return jsonResponse(500, { err_msg: "Deepgram STT failed with status 500" });
    return jsonResponse(402, { message: "You have no credits remaining. Please add credits at inworld.ai/billing." });
  };
  let thrown;
  try {
    await transcribeAudioWithFallback(sttRequest, sttEnv);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "all-provider failure should throw");
  assert.ok(Array.isArray(thrown.failures), "fallback error should carry structured per-provider failures");
  assert.equal(thrown.failures[0].provider, "deepgram-stt");
  assert.match(thrown.failures[0].message, /500/);
  assert.equal(thrown.failures[1].provider, "inworld-stt");
  assert.match(thrown.failures[1].message, /no credits remaining/);

  const misattribution = attributeSttFailure("deepgram-stt", thrown.failures, thrown.message);
  assert.equal(misattribution.creditProvider, "inworld-stt", "credit error must be attributed to the provider that produced it");
  assert.equal(misattribution.switchToBrowser, false, "must not auto-switch when only a fallback provider has billing trouble");
  assert.match(misattribution.requestedMessage, /500/);

  // 3. Requested provider itself is out of credits: switch is justified.
  globalThis.fetch = async (url) => {
    if (String(url).includes("deepgram")) return jsonResponse(402, { err_msg: "Project does not have enough credits" });
    return jsonResponse(500, { message: "Inworld STT failed with status 500" });
  };
  let creditThrown;
  try {
    await transcribeAudioWithFallback(sttRequest, sttEnv);
  } catch (error) {
    creditThrown = error;
  }
  const requestedCredit = attributeSttFailure("deepgram-stt", creditThrown.failures, creditThrown.message);
  assert.equal(requestedCredit.switchToBrowser, true, "requested-provider billing failure should switch to browser STT");
  assert.equal(requestedCredit.creditProvider, "deepgram-stt");

  // 4. Successful fallback still reports what failed before it.
  globalThis.fetch = async (url) => {
    if (String(url).includes("deepgram")) return jsonResponse(500, { err_msg: "Deepgram STT failed with status 500" });
    return jsonResponse(200, { transcription: { transcript: "hello world" } });
  };
  const fellBack = await transcribeAudioWithFallback(sttRequest, sttEnv);
  assert.equal(fellBack.text, "hello world");
  assert.equal(fellBack.provider, "inworld-stt");
  assert.equal(fellBack.failures?.[0]?.provider, "deepgram-stt");
  assert.match(fellBack.fallbackReason ?? "", /deepgram-stt: /);
} finally {
  globalThis.fetch = realFetch;
}

console.log("Voice pipeline checks passed");
