import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const tempHome = await mkdtemp(path.join(tmpdir(), "mortic-preferences-"));
process.env.HOME = tempHome;

const { createPreferencesStore } = await import("../dist/node/server/preferences.js");

const defaults = {
  initialized: false,
  codexModel: "fixture-model",
  reasoningEffort: "medium",
  serviceTier: null,
  codexAccessPreset: "ask",
  scratchMode: "voice",
  transportProvider: "local-browser",
  sttProvider: "browser",
  ttsProvider: "browser",
  overlayHintDismissed: false
};

try {
  const store = await createPreferencesStore(defaults);
  const [first, second] = await Promise.all([
    store.patch({ initialized: true }),
    store.patch({ scratchMode: "text", overlayHintDismissed: true })
  ]);

  assert.equal(first.initialized, true);
  assert.equal(second.initialized, true, "queued patches must retain prior writes");
  assert.equal(second.scratchMode, "text");
  assert.equal(second.overlayHintDismissed, true);

  const persisted = JSON.parse(await readFile(path.join(tempHome, ".mortic", "preferences.json"), "utf8"));
  assert.deepEqual(persisted, second);

  const reopened = await createPreferencesStore(defaults);
  assert.deepEqual(await reopened.read(), second, "preferences must survive server restart");
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

console.log("Preferences store checks passed");
