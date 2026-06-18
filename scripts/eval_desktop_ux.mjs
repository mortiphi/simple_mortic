#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join("/tmp", "simple-mortic-desktop-ux-eval", new Date().toISOString().replace(/[:.]/g, "-"));

const files = {
  app: "src/client/App.tsx",
  styles: "src/client/styles.css",
  desktop: "src/desktop/main.ts",
  preload: "src/desktop/preload.cjs",
  bridge: "src/client/desktopBridge.ts",
  picker: "src/client/components/ThreadPicker.tsx",
  voice: "src/client/voice/useVoiceEngine.ts",
  server: "src/server/app.ts",
  events: "src/server/appServerEvents.ts",
  codex: "src/server/codex.ts",
  packageJson: "package.json"
};

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, file]) => [key, await readFile(path.join(root, file), "utf8")])
  )
);

function evidence(file, pattern, note) {
  const lines = source[file].split("\n");
  const index = lines.findIndex((line) => typeof pattern === "string" ? line.includes(pattern) : pattern.test(line));
  return {
    file: files[file],
    line: index >= 0 ? index + 1 : null,
    note
  };
}

function has(file, pattern) {
  return typeof pattern === "string" ? source[file].includes(pattern) : pattern.test(source[file]);
}

function count(file, pattern) {
  return [...source[file].matchAll(pattern)].length;
}

const stories = [
  {
    id: "surface-state-sync",
    userStory: "As a user, I can move between pill, overlay, and full app without seeing different scratch state.",
    checks: [
      {
        verdict: has("app", "refreshDesktopSession") && has("app", "window.setInterval(refreshDesktopSession") ? "pass" : "fail",
        issue: "No live session-state subscription exists outside the active turn stream, so two renderer surfaces can drift until reloaded.",
        fix: "Add a server-owned session event stream, polling sync, or desktop IPC broadcast for session snapshots after clear/source/turn/handoff/config changes.",
        evidence: evidence("app", "refreshDesktopSession", "Desktop surfaces refresh session state after mount.")
      },
      {
        verdict: has("desktop", "webContents.send(\"mortic-desktop:state\"") && !has("desktop", "session") ? "warn" : "pass",
        issue: "Desktop IPC broadcasts window state, not Mortic session state; it cannot reconcile stale transcript or selected-thread UI.",
        fix: "Extend IPC to broadcast source/session invalidation, or prefer a server SSE snapshot stream shared by browser and desktop.",
        evidence: evidence("desktop", "mortic-desktop:state", "Only desktop shell state is emitted.")
      }
    ]
  },
  {
    id: "clear-scratch-parity",
    userStory: "If I clear scratch in one surface, every other surface immediately reflects the clear.",
    checks: [
      {
        verdict: /refreshDesktopSession[\s\S]*fetch\(`\$\{api\}\/api\/session`/.test(source.app) ? "pass" : "fail",
        issue: "Clear updates only the current renderer; overlay/full app can keep showing stale transcript, draft, or handoff.",
        fix: "After `/api/session/clear`, ensure all mounted desktop surfaces reload the session snapshot.",
        evidence: evidence("app", "refreshDesktopSession", "Desktop sync loop reloads authoritative session.")
      },
      {
        verdict: /async function clearScratch\(\)[\s\S]*resetQueuedTurn/.test(source.app) ? "pass" : "warn",
        issue: "Clear does not visibly clear queued voice-turn state from the voice engine contract exposed to App.",
        fix: "Expose and call a `clearQueuedTurn()`/`resetVoiceTurnState()` method when scratch is cleared or source switches.",
        evidence: evidence("app", "resetQueuedTurn", "App clears queued voice state on clear/source/audio cancel paths.")
      }
    ]
  },
  {
    id: "thread-selection-truth",
    userStory: "If I select a thread in Finder, the pill, overlay, and app all agree on project and thread.",
    checks: [
      {
        verdict: has("picker", "limit=20") ? "fail" : "pass",
        issue: "Finder hard-limits to 20 recent threads with no search, pagination, or project filter in the UI.",
        fix: "Add searchTerm, pagination, and cwd/project filters; keep recent only as a default view.",
        evidence: evidence("picker", "limit=20", "ThreadPicker requests only the first 20 threads.")
      },
      {
        verdict: has("server", "app.get<{ Querystring: { limit?: string } }>") && !has("server", "searchTerm") ? "fail" : "pass",
        issue: "The provider threads API ignores app-server search/cwd controls, so the desktop Finder remains noisy across projects.",
        fix: "Expose `cwd`, `searchTerm`, and `sourceKinds` through `/api/provider/threads`, defaulting to the current workspace.",
        evidence: evidence("server", "/api/provider/threads", "Endpoint only accepts limit.")
      },
      {
        verdict: has("codex", "indexed?.threadName ?? thread.threadName") ? "warn" : "pass",
        issue: "Thread naming can prefer stale local session-index names over app-server names.",
        fix: "Prefer app-server `thread.name` when present, use session index only as missing-name fallback.",
        evidence: evidence("codex", "indexed?.threadName ?? thread.threadName", "Merge order gives indexed names priority.")
      },
      {
        verdict: has("picker", "onSelect(thread.sourceUri)") && !has("picker", "preview") ? "warn" : "pass",
        issue: "Finder selection is a blind commit; there is no preview of cwd, last message, or whether this thread belongs to Simple Mortic.",
        fix: "Add a preview row/side panel before switching, or show cwd + last user prompt + provider source in the row.",
        evidence: evidence("picker", "onSelect(thread.sourceUri)", "Selecting a row immediately switches.")
      }
    ]
  },
  {
    id: "placeholder-gating",
    userStory: "Before selecting a real thread, Mortic should block every agent action and make the recovery path obvious.",
    checks: [
      {
        verdict: has("app", "const threadRequired = isPlaceholderSession(session)") && count("app", /disabled=\{threadRequired/g) >= 4 ? "pass" : "warn",
        issue: "Placeholder gating is overlay-only; the full app path can still render normal send/clear/config affordances for a placeholder session.",
        fix: "Promote `threadRequired` to a shared app-level state and apply it to full app composer, prewarm, handoff, transcript, and voice controls.",
        evidence: evidence("app", "const threadRequired", "Shared placeholder gate exists.")
      },
      {
        verdict: /if \(!session \|\| threadRequired[\s\S]*session\/prewarm/.test(source.app) ? "pass" : "fail",
        issue: "Prewarm can run for the placeholder thread, creating confusing 'ready' state before a real thread exists.",
        fix: "Skip prewarm and ready announcements while the current thread is the placeholder thread.",
        evidence: evidence("app", "threadRequired || state.loading", "Prewarm effect skips placeholder sessions.")
      },
      {
        verdict: has("app", "desktopThreadBlocked ? \"Codex\"") ? "warn" : "pass",
        issue: "No-thread pill uses 'Codex' as the secondary label, which reads like a selected provider/thread rather than a recovery hint.",
        fix: "Use `No thread selected` or `Choose a Codex thread` in the status region; keep the left identity as the only Select Thread CTA.",
        evidence: evidence("app", "desktopThreadBlocked ? \"Codex\"", "Placeholder thread label.")
      }
    ]
  },
  {
    id: "voice-control-language",
    userStory: "I always understand the one primary voice action.",
    checks: [
      {
        verdict: /Mute \+ talk|M to mute and talk|M ready|Click M/.test(source.app) ? "fail" : "pass",
        issue: "The same PTT action has too many labels: Hold M, M ready, Mute + talk, M to mute and talk, Click M to send.",
        fix: "Use one primary label (`Hold M`) and one explicit interrupt state (`Hold M to queue next`) across pill, overlay, and full app.",
        evidence: evidence("app", "dockTalkLabel", "PTT copy is derived from one label function.")
      },
      {
        verdict: has("app", "Mute + talk") ? "fail" : "pass",
        issue: "`Mute + talk` is mechanically accurate but ugly and unclear; it reads like two actions smashed together.",
        fix: "Rename to `Hold M to queue` or `Speak next` during assistant audio, with a tiny muted-audio indicator if needed.",
        evidence: evidence("app", "Mute + talk", "Current pending/speaking label.")
      },
      {
        verdict: has("app", "title={desktopThreadBlocked ? \"Select a Codex thread first.\"") ? "pass" : "warn",
        issue: "Disabled voice controls need visible reasons, not just tooltip reasons; tooltips are weak in a fast voice UI.",
        fix: "Show a compact inline reason near the primary button when blocked: `Select a thread first`.",
        evidence: evidence("app", "Select a Codex thread first.", "Reason is title/placeholder, not always visible.")
      }
    ]
  },
  {
    id: "audio-turn-continuity",
    userStory: "If I barge in while Mortic is speaking, audio stops, my words are captured, and my next turn sends when safe.",
    checks: [
      {
        verdict: has("voice", "mutedSpeechTurnIdRef") && has("voice", "bargeInStateRef") ? "warn" : "fail",
        issue: "Barge-in state is complex and renderer-local; surface switching during speech can orphan capture/audio state.",
        fix: "Model barge-in as an explicit state machine with debug-visible phases and reset on source/clear/window surface change.",
        evidence: evidence("voice", "bargeInStateRef", "Barge-in state is hook-local.")
      },
      {
        verdict: /clearScratch\(\)[\s\S]*resetSpeechPlayback/.test(source.app) ? "pass" : "warn",
        issue: "Clear cancels playback, but source switch and full-app open should also guarantee no orphaned TTS audio from hidden surfaces.",
        fix: "Send a desktop-wide `audio:cancel` event whenever a surface is hidden, source changes, or full app takes ownership.",
        evidence: evidence("app", "resetSpeechPlayback();", "Only the active renderer cancels its own playback.")
      },
      {
        verdict: has("desktop", "hideOverlay();") && !has("desktop", "audio") ? "fail" : "pass",
        issue: "Hiding overlay when opening the full app does not cancel overlay TTS; hidden renderer audio can keep playing.",
        fix: "Before hiding overlay for full app ownership, send an IPC cancel-audio event and have the overlay voice hook stop playback.",
        evidence: evidence("desktop", "function hideOverlay()", "Hide only hides the window.")
      }
    ]
  },
  {
    id: "window-ownership",
    userStory: "There is one Mortic desktop experience, never competing windows or hidden owners.",
    checks: [
      {
        verdict: has("desktop", "app.requestSingleInstanceLock()") ? "pass" : "fail",
        issue: "Single instance lock is missing.",
        fix: "Use Electron's single-instance lock.",
        evidence: evidence("desktop", "app.requestSingleInstanceLock()", "Single instance guard exists.")
      },
      {
        verdict: /fullWindow = null;[\s\S]*revealOverlay/.test(source.desktop) ? "pass" : "warn",
        issue: "Closing the full app does not restore the overlay, leaving the user with no visible Mortic surface unless they remember the shortcut.",
        fix: "On full-window close, reveal the overlay unless the user explicitly hid it.",
        evidence: evidence("desktop", "fullWindow = null", "Full-window close only clears the reference.")
      },
      {
        verdict: /function fullAppOwnsScreen\(\)[\s\S]*isVisible/.test(source.desktop) ? "warn" : "pass",
        issue: "Any visible full app owns the screen, even if it is behind other apps; the global shortcut may refuse to show the overlay when the user expects it.",
        fix: "Use focus/maximize/fullscreen ownership, not raw visibility, or track explicit user intent.",
        evidence: evidence("desktop", "function fullAppOwnsScreen()", "Ownership is based on visibility.")
      },
      {
        verdict: has("desktop", "setVisibleOnAllWorkspaces(true") ? "warn" : "pass",
        issue: "Overlay appears on all workspaces/fullscreen by default, which can be jarring when the full app or another task owns attention.",
        fix: "Make all-workspaces behavior opt-in, or disable it when full app is visible.",
        evidence: evidence("desktop", "setVisibleOnAllWorkspaces", "Overlay is pinned globally.")
      }
    ]
  },
  {
    id: "resize-survival",
    userStory: "When I resize the pill or overlay, it remains legible and elegant at every allowed size.",
    checks: [
      {
        verdict: has("desktop", "OVERLAY_COLLAPSED_MIN_SCALE = 0.4") ? "warn" : "pass",
        issue: "40% collapsed allows a 304x33 window; that is barely enough for wordmark + primary action and makes borders/text fragile.",
        fix: "Audit actual pixels at 40/50/62/75/100%, or raise collapsed min scale if micro cannot remain tasteful.",
        evidence: evidence("desktop", "OVERLAY_COLLAPSED_MIN_SCALE", "Collapsed min scale.")
      },
      {
        verdict: has("styles", ".desktop-density-micro .desktop-overlay-config") && has("styles", "display: none") && !has("app", "desktop-panel-window-actions") ? "warn" : "pass",
        issue: "Micro expanded mode hides handoff/config/working buffer entirely, so resize changes available product functionality.",
        fix: "At micro size, show a single `Open app`/`More` affordance and a clear compact summary instead of silently dropping functions.",
        evidence: evidence("styles", ".desktop-density-micro .codex-working-buffer", "Micro mode hides whole sections.")
      },
      {
        verdict: has("styles", "height: calc(100vh - 14px)") && has("styles", "box-sizing: border-box") ? "pass" : "warn",
        issue: "Inner shell sizes are manually coupled to margins; small rounding changes cause inner/outer edge collisions.",
        fix: "Use one inset variable, `box-sizing: border-box`, and `inset` layout, or remove the visual outer frame entirely.",
        evidence: evidence("styles", "width: calc(100vw - 14px)", "Manual width/margin coupling.")
      },
      {
        verdict: count("styles", /font-size:\s*\d+px/g) > 40 ? "warn" : "pass",
        issue: "Desktop overlay typography uses many fixed pixel sizes, so scale changes are piecewise and can jump rather than fluidly adapt.",
        fix: "Move overlay typography to clamp variables keyed by density and scale.",
        evidence: evidence("styles", "font-size: 21px", "Fixed desktop typography.")
      }
    ]
  },
  {
    id: "visual-hierarchy",
    userStory: "At a glance I know the current project/thread, current state, and one next action.",
    checks: [
      {
        verdict: has("app", "desktop-panel-window-actions") ? "pass" : "warn",
        issue: "Header controls compete with identity; Finder, open app, collapse, hide all sit at the same visual priority.",
        fix: "Use identity + Finder as primary, then group window controls as small icon utilities.",
        evidence: evidence("app", "desktop-panel-window-actions", "Panel window controls are grouped away from Finder.")
      },
      {
        verdict: has("styles", ".desktop-density-micro .desktop-hud-app-button") && !has("styles", ".desktop-density-micro .desktop-hud-actions button:not(.desktop-overlay-mic)") ? "pass" : "warn",
        issue: "Micro collapsed mode hides App/Interrupt but keeps the mic; there is no visible window utility except clicking identity.",
        fix: "Keep one tiny utility icon visible in micro mode, or make identity visibly tappable/expandable.",
        evidence: evidence("styles", ".desktop-density-micro .desktop-hud-app-button", "Micro mode keeps a tiny app affordance.")
      },
      {
        verdict: has("styles", ".desktop-panel-actions > button span {\n  display: none;") ? "warn" : "pass",
        issue: "Compact mode turns controls icon-only, but the Finder button remains text-heavy and can dominate the header.",
        fix: "Make Finder the first-class labeled control and make window controls consistently icon-only.",
        evidence: evidence("styles", ".desktop-density-compact .desktop-panel-actions > button span", "Compact hides some labels.")
      }
    ]
  },
  {
    id: "full-app-polish",
    userStory: "The full desktop app feels like the same product as the pill/overlay, not a raw browser page.",
    checks: [
      {
        verdict: has("styles", ".agent-canvas .live-transcript-card") && has("styles", "border: 0;") ? "pass" : "warn",
        issue: "The full app still has a heavy external panel border/boxed canvas while the desktop overlay moved to glass without outer borders.",
        fix: "Remove or soften outer borders on the main app canvas and use internal alignment/rhythm for structure.",
        evidence: evidence("styles", ".agent-canvas .live-transcript-card", "Full app live card softens the frame.")
      },
      {
        verdict: has("app", "<InsightsPanel") ? "warn" : "pass",
        issue: "Full app and overlay present different task surfaces; project memory/insights disappear from the overlay except handoff.",
        fix: "Decide what is desktop-critical: last two turns, handoff, Finder, access summary, current project memory alert. Everything else belongs in full app.",
        evidence: evidence("app", "<InsightsPanel", "Full app has a separate insights rail.")
      },
      {
        verdict: /desktopBridge\(\)\?\.openFullApp\(\)\} disabled=\{desktopThreadBlocked\}>Open transcript/.test(source.app) ? "warn" : "pass",
        issue: "Transcript affordance opens a drawer in full app but opens the full app from overlay; same label, different behavior.",
        fix: "Rename overlay action to `Open app transcript` or make it open the same transcript drawer in overlay.",
        evidence: evidence("app", "Open transcript", "Label reused across surfaces.")
      }
    ]
  },
  {
    id: "turn-lifecycle",
    userStory: "Long turns, compaction, finalization, and failures leave obvious state, not ghosts.",
    checks: [
      {
        verdict: has("app", "Final transcript pending") ? "pass" : "warn",
        issue: "No final transcript pending state.",
        fix: "Keep provisional assistant draft visible until final transcript lands.",
        evidence: evidence("app", "Final transcript pending", "Finalization state exists.")
      },
      {
        verdict: has("events", "Compacting context") || has("events", "Context compacted") ? "pass" : "warn",
        issue: "Compaction telemetry is not elevated into a user-level state for the desktop overlay.",
        fix: "Show `Compacting context` in the working buffer and preserve it in the trace drawer.",
        evidence: evidence("events", "Context compacted", "App-server compaction maps into visible activity.")
      },
      {
        verdict: has("app", "sparkBlocked") && !has("app", "desktopThreadBlocked || sparkBlocked") ? "warn" : "pass",
        issue: "Spark/context blocking and no-thread blocking are separate, so controls can produce mixed disabled states and unclear reasons.",
        fix: "Create one `actionGate` object with reason, severity, and affected controls.",
        evidence: evidence("app", "const sparkBlocked", "Gate logic is spread across state variables.")
      }
    ]
  },
  {
    id: "test-coverage",
    userStory: "Regressions in the desktop shell are caught before I see them.",
    checks: [
      {
        verdict: has("packageJson", "desktop:dev") && !has("packageJson", "eval:desktop") ? "fail" : "pass",
        issue: "There is no desktop UX/e2e test command; desktop QA is manual and easy to regress.",
        fix: "Add an Electron smoke/eval command that snapshots collapsed/expanded/no-thread/selected-thread states.",
        evidence: evidence("packageJson", "\"desktop:dev\"", "Desktop scripts exist, but no UX eval script is registered.")
      },
      {
        verdict: has("packageJson", "build:desktop") ? "pass" : "fail",
        issue: "Desktop build is not part of normal checks.",
        fix: "Include desktop build/typecheck in tests.",
        evidence: evidence("packageJson", "build:desktop", "Desktop build script exists.")
      }
    ]
  }
];

const issues = [];
let pass = 0;
let warn = 0;
let fail = 0;

for (const story of stories) {
  for (const check of story.checks) {
    if (check.verdict === "pass") {
      pass += 1;
      continue;
    }
    if (check.verdict === "warn") warn += 1;
    if (check.verdict === "fail") fail += 1;
    issues.push({
      id: `${story.id}-${issues.length + 1}`,
      story: story.userStory,
      severity: check.verdict === "fail" ? "high" : "medium",
      verdict: check.verdict,
      issue: check.issue,
      fix: check.fix,
      evidence: check.evidence
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  root,
  summary: {
    stories: stories.length,
    checks: pass + warn + fail,
    pass,
    warn,
    fail,
    issues: issues.length
  },
  stories: stories.map((story) => ({
    id: story.id,
    userStory: story.userStory,
    checks: story.checks.map((check) => ({
      verdict: check.verdict,
      issue: check.issue,
      fix: check.fix,
      evidence: check.evidence
    }))
  })),
  issues
};

function markdownIssue(issue, index) {
  const evidenceText = issue.evidence?.line
    ? `${issue.evidence.file}:${issue.evidence.line}`
    : issue.evidence?.file ?? "source unavailable";
  return [
    `### ${index + 1}. [${issue.severity.toUpperCase()}] ${issue.issue}`,
    ``,
    `- Story: ${issue.story}`,
    `- Evidence: ${evidenceText} — ${issue.evidence?.note ?? ""}`,
    `- Fix: ${issue.fix}`
  ].join("\n");
}

const markdown = [
  "# Simple Mortic Desktop UX Eval",
  "",
  `Generated: ${report.generatedAt}`,
  `Root: ${root}`,
  "",
  `Checks: ${report.summary.checks} · Pass: ${pass} · Warn: ${warn} · Fail: ${fail} · Issues: ${issues.length}`,
  "",
  "## Issues",
  "",
  ...issues.map(markdownIssue)
].join("\n\n");

await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, "desktop-ux-eval.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(path.join(outDir, "desktop-ux-eval.md"), `${markdown}\n`, "utf8");

console.log(`Desktop UX eval: ${issues.length} issues (${fail} fail, ${warn} warn, ${pass} pass)`);
console.log(path.join(outDir, "desktop-ux-eval.md"));
