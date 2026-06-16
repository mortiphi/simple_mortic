import type {
  InputPolicy,
  ReasoningEffort,
  ScratchMode,
  SttProvider,
  TransportProvider,
  TtsProvider
} from "../../shared/types.js";
import { reasoningEfforts, scratchModes, sttProviders, transportProviders, ttsProviders } from "../../shared/types.js";

import { SETTINGS_VERSION } from "./labels.js";
export function apiBase(): string {
  const fromQuery = new URLSearchParams(window.location.search).get("api");
  return fromQuery ?? "http://127.0.0.1:5152";
}

export function storedSetting(key: string): string | null {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredSetting(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Settings persistence is optional in embedded browser contexts.
  }
}

export function readStoredEffort(defaultEffort: ReasoningEffort): ReasoningEffort {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultEffort;
  const stored = storedSetting("mortic.reasoningEffort");
  return reasoningEfforts.includes(stored as ReasoningEffort) ? (stored as ReasoningEffort) : defaultEffort;
}

export function readStoredModel(defaultModel: string): string {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultModel;
  return storedSetting("mortic.codexModel") || defaultModel;
}

export function readStoredScratchMode(defaultMode: ScratchMode): ScratchMode {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultMode;
  const stored = storedSetting("mortic.scratchMode");
  return scratchModes.includes(stored as ScratchMode) ? (stored as ScratchMode) : defaultMode;
}

export function readStoredVoiceCaveman(): boolean {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return false;
  return storedSetting("mortic.voiceCaveman") === "true";
}

export function readStoredTtsProvider(defaultProvider: TtsProvider, availableProviders: TtsProvider[]): TtsProvider {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultProvider;
  const stored = storedSetting("mortic.ttsProvider");
  return ttsProviders.includes(stored as TtsProvider) && availableProviders.includes(stored as TtsProvider)
    ? (stored as TtsProvider)
    : defaultProvider;
}

export function readStoredSttProvider(defaultProvider: SttProvider, availableProviders: SttProvider[]): SttProvider {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultProvider;
  const stored = storedSetting("mortic.sttProvider");
  return sttProviders.includes(stored as SttProvider) && availableProviders.includes(stored as SttProvider)
    ? (stored as SttProvider)
    : defaultProvider;
}

export function readStoredTransportProvider(defaultProvider: TransportProvider, availableProviders: TransportProvider[]): TransportProvider {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return defaultProvider;
  const stored = storedSetting("mortic.transportProvider");
  return transportProviders.includes(stored as TransportProvider) && availableProviders.includes(stored as TransportProvider)
    ? (stored as TransportProvider)
    : defaultProvider;
}

export function readStoredInputPolicy(): InputPolicy {
  if (storedSetting("mortic.settingsVersion") !== SETTINGS_VERSION) return "push_to_talk";
  const stored = storedSetting("mortic.inputPolicy");
  return stored === "live" ? "live" : "push_to_talk";
}
