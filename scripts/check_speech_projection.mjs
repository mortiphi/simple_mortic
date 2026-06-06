import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectSpeech, shouldUseExactSpeechProjection } from "../dist/node/shared/speechProjection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "fixtures", "speech_projection_cases.json");
const cases = JSON.parse(await readFile(fixturePath, "utf8"));

for (const testCase of cases) {
  const result = projectSpeech(testCase.input, { exact: testCase.exact === true });
  for (const expected of testCase.mustIncludeSpeech ?? []) {
    assert.match(
      result.speechText,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `${testCase.name}: expected speech to include ${expected}\nSpeech: ${result.speechText}`
    );
  }
  for (const forbidden of testCase.mustNotIncludeSpeech ?? []) {
    assert.doesNotMatch(
      result.speechText,
      new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      `${testCase.name}: expected speech not to include ${forbidden}\nSpeech: ${result.speechText}`
    );
  }
  assert.equal(typeof result.suppressedChars, "number", `${testCase.name}: suppressedChars should be numeric`);
  assert.equal(Array.isArray(result.segments), true, `${testCase.name}: segments should be present`);
}

assert.equal(shouldUseExactSpeechProjection("Read this code exactly aloud."), true);
assert.equal(shouldUseExactSpeechProjection("Please read the JSON verbatim."), true);
assert.equal(shouldUseExactSpeechProjection("Summarize this code."), false);

console.log("Speech projection checks passed");
