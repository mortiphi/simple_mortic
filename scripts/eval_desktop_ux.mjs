#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join("/tmp", "simple-mortic-desktop-ux-eval", `${timestamp}-${process.pid}`);
const capturesArg = process.argv.find((value) => value.startsWith("--captures="));
const capturesDir = capturesArg?.slice("--captures=".length)
  || process.env.MORTIC_DESKTOP_CAPTURE_DIR
  || "/tmp/simple-mortic-electron-qa";

const files = {
  app: "src/client/App.tsx",
  picker: "src/client/components/ThreadPicker.tsx",
  modals: "src/client/components/SessionModals.tsx",
  voice: "src/client/voice/useVoiceEngine.ts",
  voiceLib: "src/client/lib/voice.ts",
  tts: "src/client/tts.ts",
  bargeIn: "src/shared/bargeInControl.ts",
  server: "src/server/app.ts",
  coordinator: "src/server/sessionCoordinator.ts",
  runtime: "src/cli/runtime.ts",
  desktop: "src/desktop/main.ts",
  preload: "src/desktop/preload.cjs",
  styles: "src/client/styles.css"
};

const source = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, file]) => [
  key,
  await readFile(path.join(root, file), "utf8")
])));

function sourceCheck(id, label, pass, evidence, severity = "high") {
  return { id, label, verdict: pass ? "pass" : "fail", severity, evidence };
}

const checks = [
  sourceCheck("shared-sse", "All surfaces subscribe to the authoritative session snapshot stream.", source.app.includes("/api/session/stream") && source.server.includes("/api/session/stream"), files.app),
  sourceCheck("revision-order", "Renderers ignore stale session revisions.", source.app.includes("latestSessionRevisionRef") && source.app.includes("payload.revision <= latestSessionRevisionRef.current"), files.app),
  sourceCheck("fallback-poll", "Polling is a disconnected fallback rather than the primary sync path.", source.app.includes("fallbackTimer") && source.app.includes("polling is only a quiet fallback") && !source.app.includes("1_200"), files.app),
  sourceCheck("composer-sync", "Composer drafts are persisted and synchronized through the session API.", source.app.includes("/api/session/ui") && source.server.includes("composer-updated"), files.app),
  sourceCheck("preference-sync", "Preferences are server-owned and capability validated.", source.app.includes("/api/preferences") && source.server.includes("Model is not available from Codex app-server") && source.server.includes("provider is not configured"), files.server),
  sourceCheck("project-memory-removed", "Project-memory APIs are not present in the active app.", !source.runtime.includes("MORTIC_CANONICAL_MEMORY") && !source.server.includes("/api/project/") && !source.server.includes("/api/project"), files.server),
  sourceCheck("audio-lease", "Recording and TTS are protected by a shared audio lease.", source.coordinator.includes("class SessionCoordinator") && source.voice.includes("isAudioOwner") && source.voice.includes("requestAudioOwnership"), files.coordinator),
  sourceCheck("audio-hide-semantics", "Explicit hide and full-app conceal use different audio semantics.", source.desktop.includes("hideOverlay(false)") && source.desktop.includes("hideOverlay(true)"), files.desktop),
  sourceCheck("audio-transfer-preserves-stream", "Audio ownership transfer stops playback without clearing the live answer stream.", /event\.type === "audio-command"[\s\S]{0,180}interruptLocalAudio\(\)/.test(source.app) && !/event\.type === "audio-command"[\s\S]{0,180}resetSpeechPlayback\(\)/.test(source.app), files.app),
  sourceCheck("server-owned-queue", "Busy turns store a shared queued follow-up instead of renderer-only state.", source.server.includes("queued-turn-updated") && source.server.includes("drainQueuedTurn") && source.voice.includes("/api/turn") && !source.voice.includes("queuedTurnRef.current = { text"), files.server),
  sourceCheck("stop-audio-label", "Primary interruption copy is honest: Stop audio, not cancel model.", source.app.includes("Stop audio") && !source.app.includes(">Interrupt<"), files.app),
  sourceCheck("stale-text-no-barge", "Finished visible assistant text alone does not trigger barge-in.", !source.bargeIn.includes("liveAssistantText"), files.bargeIn),
  sourceCheck("scoped-audio-cancel", "Audio cancel is scoped to Mortic-owned TTS media.", source.voice.includes('[data-mortic-audio=\"tts\"]') && !source.voice.includes('querySelectorAll<HTMLMediaElement>(\"audio,video\")'), files.voice),
  sourceCheck("active-turn-reaper", "Stale running turns are recovered instead of locking the app.", source.server.includes("ACTIVE_TURN_STALE_MS") && source.server.includes("Recovered stale running turn"), files.server),
  sourceCheck("stt-allsettled", "Multi-segment STT preserves successful segments and retries failures.", source.voice.includes("Promise.allSettled") && source.voice.includes("transcribeSegmentWithRetry"), files.voice),
  sourceCheck("first-clause-tts", "First TTS chunk can start on a safe clause, not only full sentence end.", source.voiceLib.includes("findClauseEnd") && source.voiceLib.includes("start === 0 ? findClauseEnd"), files.voiceLib),
  sourceCheck("tts-lifecycle-propagates", "TTS fallback providers receive turn lifecycle/cancel.", source.tts.includes("params.fallback.beginTurn") && source.tts.includes("params.fallback.finishTurn") && source.tts.includes("fallback.beginTurn") && source.tts.includes("fallback.finishTurn"), files.tts),
  sourceCheck("full-app-conceal-preserves-audio", "The global shortcut does not cancel full-app-owned audio.", /if \(fullAppOwnsScreen\(\)\) \{\s*hideOverlay\(false\)/.test(source.desktop), files.desktop),
  sourceCheck("clear-server-authoritative", "Clear scratch waits for server success before erasing local state.", /const response = await fetch\(`\$\{api\}\/api\/session\/clear`[\s\S]{0,500}if \(!response\.ok\)[\s\S]{0,500}resetSpeechPlayback\(\)/.test(source.app), files.app),
  sourceCheck("finder-keyboard", "Finder supports preview, arrows, Enter, Escape, and focus restoration.", ["ArrowDown", "ArrowUp", "Enter", "Escape", "triggerRef.current?.focus"].every((token) => source.picker.includes(token)), files.picker),
  sourceCheck("clear-confirm", "Destructive scratch clearing uses a custom confirmation dialog.", source.app.includes("clearConfirmOpen") && source.app.includes("Clear this scratch?") && source.modals.includes("ConfirmDialog"), files.app),
  sourceCheck("thread-gate", "Placeholder sessions visibly block turns and direct the user to Finder.", source.app.includes("desktopThreadBlocked") && source.app.includes("Choose a conversation in Finder to begin"), files.app),
  sourceCheck("single-interaction-state", "HUD and orb share one interaction-state vocabulary.", source.app.includes("function deriveInteractionState") && source.app.includes("const desktopHudStatus = interactionState") && source.app.includes("<span>{interactionState}</span>"), files.app),
  sourceCheck("renderer-sandbox", "Electron renderers run sandboxed with context isolation.", source.desktop.includes("sandbox: true") && source.desktop.includes("contextIsolation: true") && source.desktop.includes("nodeIntegration: false"), files.desktop),
  sourceCheck("navigation-deny", "Unapproved navigation and child windows are denied.", source.desktop.includes("setWindowOpenHandler") && source.desktop.includes('webContents.on("will-navigate"'), files.desktop),
  sourceCheck("narrow-preload", "The preload bridge exposes explicit shell actions only.", !/require\(["'](?:fs|child_process|net|http)/.test(source.preload) && source.preload.includes("contextBridge.exposeInMainWorld"), files.preload),
  sourceCheck("shortcut-failure", "Global shortcut registration failure is surfaced to the renderer.", source.desktop.includes("shortcutRegistered = globalShortcut.register") && source.app.includes("desktopState?.shortcutError"), files.desktop),
  sourceCheck("reduced-motion", "Reduced-motion mode fully disables animation and transitions.", source.styles.includes("animation: none !important") && source.styles.includes("transition: none !important"), files.styles)
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const captureChecks = [];
const scales = [100, 75, 55, 40];
for (const mode of ["collapsed", "expanded"]) {
  for (const percent of scales) {
    const stem = `${mode}-${percent}`;
    const imagePath = path.join(capturesDir, `${stem}.png`);
    const metricsPath = path.join(capturesDir, `${stem}.json`);
    if (!(await exists(imagePath)) || !(await exists(metricsPath))) {
      captureChecks.push({
        id: `capture-${stem}`,
        label: `${stem} capture and metrics exist.`,
        verdict: "fail",
        severity: "high",
        evidence: metricsPath
      });
      continue;
    }

    const metrics = JSON.parse(await readFile(metricsPath, "utf8"));
    const imageBytes = (await stat(imagePath)).size;
    const expectedDensity = percent < 62 ? "desktop-density-micro" : percent < 86 ? "desktop-density-compact" : "desktop-density-normal";
    const hiddenMicroGate = mode !== "expanded" || percent >= 62 || !metrics.threadRequired
      || !metrics.elements.some((entry) => [
        ".desktop-overlay-controls",
        ".desktop-overlay-composer",
        ".desktop-handoff-card",
        ".desktop-provider-notices",
        ".desktop-overlay-config"
      ].includes(entry.selector));
    const pass = metrics.sessionReady
      && metrics.density === expectedDensity
      && Math.abs(metrics.documentOverflow.x) <= 1
      && Math.abs(metrics.documentOverflow.y) <= 1
      && metrics.outside.length === 0
      && metrics.parentClipping.length === 0
      && metrics.overlaps.length === 0
      && hiddenMicroGate
      && imageBytes > 4_000;
    captureChecks.push({
      id: `capture-${stem}`,
      label: `${stem} is stable, in-bounds, non-overlapping, and appropriately reduced.`,
      verdict: pass ? "pass" : "fail",
      severity: "high",
      evidence: metricsPath,
      detail: {
        viewport: metrics.viewport,
        density: metrics.density,
        sessionReady: metrics.sessionReady,
        documentOverflow: metrics.documentOverflow,
        outside: metrics.outside,
        parentClipping: metrics.parentClipping,
        overlaps: metrics.overlaps,
        hiddenMicroGate,
        imageBytes
      }
    });
  }
}

const fullAppImage = path.join(capturesDir, "full-app.png");
const fullAppMetrics = path.join(capturesDir, "full-app.json");
if ((await exists(fullAppImage)) && (await exists(fullAppMetrics))) {
  const metrics = JSON.parse(await readFile(fullAppMetrics, "utf8"));
  const imageBytes = (await stat(fullAppImage)).size;
  captureChecks.push({
    id: "capture-full-app",
    label: "The full app is session-ready, horizontally contained, and visibly rendered.",
    verdict: metrics.sessionReady && metrics.documentOverflow.x <= 1 && imageBytes > 20_000 ? "pass" : "fail",
    severity: "high",
    evidence: fullAppMetrics,
    detail: { ...metrics, imageBytes }
  });
} else {
  captureChecks.push({
    id: "capture-full-app",
    label: "The full-app capture and metrics exist.",
    verdict: "fail",
    severity: "high",
    evidence: fullAppMetrics
  });
}

checks.push(...captureChecks);
const counts = checks.reduce((summary, check) => {
  summary[check.verdict] += 1;
  return summary;
}, { pass: 0, warn: 0, fail: 0 });
const report = {
  generatedAt: new Date().toISOString(),
  root,
  capturesDir,
  summary: { checks: checks.length, ...counts },
  checks
};

const failures = checks.filter((check) => check.verdict === "fail");
const markdown = [
  "# Simple Mortic Desktop UX Eval",
  "",
  `Generated: ${report.generatedAt}`,
  `Captures: ${capturesDir}`,
  `Checks: ${checks.length} · Pass: ${counts.pass} · Fail: ${counts.fail}`,
  "",
  ...(failures.length === 0
    ? ["## Verdict", "", "PASS — architecture and captured layouts satisfy the current cohesion contract."]
    : [
      "## Failures",
      "",
      ...failures.flatMap((failure, index) => [
        `### ${index + 1}. ${failure.label}`,
        "",
        `Evidence: ${failure.evidence}`,
        failure.detail ? `\n\`\`\`json\n${JSON.stringify(failure.detail, null, 2)}\n\`\`\`` : ""
      ])
    ])
].join("\n");

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "desktop-ux-eval.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, "desktop-ux-eval.md"), `${markdown}\n`, "utf8");

console.log(`Desktop UX eval: ${counts.fail === 0 ? "PASS" : "FAIL"} (${counts.pass}/${checks.length})`);
console.log(path.join(outDir, "desktop-ux-eval.md"));
if (counts.fail > 0) process.exitCode = 1;
