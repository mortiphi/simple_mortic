import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { MorticPreferences, MorticPreferencesPatch } from "../shared/types.js";

export type PreferencesStore = {
  read(): Promise<MorticPreferences>;
  patch(patch: MorticPreferencesPatch): Promise<MorticPreferences>;
};

export function createMemoryPreferencesStore(defaults: MorticPreferences): PreferencesStore {
  let value = defaults;
  return {
    async read() {
      return value;
    },
    async patch(patchValue) {
      value = { ...value, ...patchValue };
      return value;
    }
  };
}

function preferencesPath(): string {
  return path.join(homedir(), ".mortic", "preferences.json");
}

export async function createPreferencesStore(defaults: MorticPreferences): Promise<PreferencesStore> {
  const filePath = preferencesPath();
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<MorticPreferences> {
    await queue;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MorticPreferences>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  async function write(preferences: MorticPreferences): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    await rename(tempPath, filePath);
  }

  async function patch(patchValue: MorticPreferencesPatch): Promise<MorticPreferences> {
    let result = defaults;
    const operation = queue.then(async () => {
      const current = await readDirect();
      result = { ...current, ...patchValue };
      await write(result);
    });
    queue = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  async function readDirect(): Promise<MorticPreferences> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MorticPreferences>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  return { read, patch };
}
