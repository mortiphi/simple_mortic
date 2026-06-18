import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";

import { morticHomeDir, startMorticRuntime, type StartedMorticRuntime } from "../cli/runtime.js";
import { listCodexRecentThreads } from "../server/codex.js";
import { parseThreadUri } from "../shared/threadUri.js";

type DesktopPrefs = {
  explicitSourceUri?: string;
  rememberedAt?: string;
  collapsedOverlayScale?: number;
  expandedOverlayScale?: number;
  // Legacy scale from the first fixed-preset pass. Used as a fallback only.
  overlayScale?: number;
  // Legacy key from the first desktop smoke build. It was written on passive
  // session load, so it is intentionally ignored for startup selection.
  lastSourceUri?: string;
};

const OVERLAY_COLLAPSED = { width: 760, height: 82 };
const OVERLAY_EXPANDED = { width: 980, height: 720 };
const OVERLAY_COLLAPSED_MIN_SCALE = 0.4;
const OVERLAY_EXPANDED_MIN_SCALE = 0.4;
const OVERLAY_MAX_SCALE = 1.35;
const SHORTCUT = "CommandOrControl+Shift+M";

let runtime: StartedMorticRuntime | null = null;
let overlayWindow: BrowserWindow | null = null;
let fullWindow: BrowserWindow | null = null;
let overlayExpanded = false;
let applyingOverlayBounds = false;
let applyingOverlayBoundsTimer: ReturnType<typeof setTimeout> | undefined;

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function prefsPath(): string {
  return path.join(morticHomeDir(), "desktop.json");
}

function readPrefs(): DesktopPrefs {
  try {
    const file = prefsPath();
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as DesktopPrefs;
  } catch {
    return {};
  }
}

function writePrefs(prefs: DesktopPrefs): void {
  const file = prefsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
}

function overlayMinScale(): number {
  return overlayExpanded ? OVERLAY_EXPANDED_MIN_SCALE : OVERLAY_COLLAPSED_MIN_SCALE;
}

function clampOverlayScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(OVERLAY_MAX_SCALE, Math.max(overlayMinScale(), value));
}

function overlayScale(): number {
  const prefs = readPrefs();
  const preferred = overlayExpanded ? prefs.expandedOverlayScale : prefs.collapsedOverlayScale;
  return clampOverlayScale(preferred ?? prefs.overlayScale);
}

function currentOverlayBaseSize() {
  return overlayExpanded ? OVERLAY_EXPANDED : OVERLAY_COLLAPSED;
}

function isWithinWorkspace(candidate: string, workspace: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedWorkspace = path.resolve(workspace);
  return resolvedCandidate === resolvedWorkspace || resolvedCandidate.startsWith(`${resolvedWorkspace}${path.sep}`);
}

async function initialThreadRef(): Promise<string | undefined> {
  const prefs = readPrefs();
  const explicitSourceUri = prefs.explicitSourceUri?.trim();
  if (!explicitSourceUri) return undefined;

  let explicitThreadId: string;
  try {
    explicitThreadId = parseThreadUri(explicitSourceUri).threadId;
  } catch {
    return undefined;
  }
  const recentThreads = await listCodexRecentThreads({ limit: 100 }).catch(() => []);
  const recent = recentThreads.find((thread) => thread.sourceUri === explicitSourceUri || thread.threadId === explicitThreadId);
  if (recent?.cwd && !isWithinWorkspace(recent.cwd, process.cwd())) {
    return undefined;
  }

  return explicitSourceUri;
}

function windowSize() {
  const base = currentOverlayBaseSize();
  const scale = overlayScale();
  return {
    width: Math.round(base.width * scale),
    height: Math.round(base.height * scale)
  };
}

function configureOverlayResizeMode(): void {
  if (!overlayWindow) return;
  const base = currentOverlayBaseSize();
  overlayWindow.setResizable(true);
  overlayWindow.setAspectRatio(base.width / base.height);
  overlayWindow.setMinimumSize(
    Math.round(base.width * overlayMinScale()),
    Math.round(base.height * overlayMinScale())
  );
  overlayWindow.setMaximumSize(
    Math.round(base.width * OVERLAY_MAX_SCALE),
    Math.round(base.height * OVERLAY_MAX_SCALE)
  );
}

function positionOverlay(): void {
  if (!overlayWindow) return;
  const display = screen.getDisplayMatching(overlayWindow.getBounds());
  const workArea = display.workArea;
  const size = windowSize();
  configureOverlayResizeMode();
  if (applyingOverlayBoundsTimer) clearTimeout(applyingOverlayBoundsTimer);
  applyingOverlayBounds = true;
  overlayWindow.setSize(size.width, size.height, false);
  overlayWindow.setPosition(
    Math.round(workArea.x + (workArea.width - size.width) / 2),
    Math.round(workArea.y + 24),
    false
  );
  applyingOverlayBoundsTimer = setTimeout(() => {
    applyingOverlayBounds = false;
    applyingOverlayBoundsTimer = undefined;
  }, 250);
}

function fullAppOwnsScreen(): boolean {
  return Boolean(fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible());
}

function hideOverlay(): void {
  overlayWindow?.webContents.send("mortic-desktop:audio-cancel");
  overlayWindow?.hide();
  overlayWindow?.webContents.send("mortic-desktop:state", desktopState());
}

function revealOverlay(): void {
  if (fullAppOwnsScreen()) return;
  if (!overlayWindow) {
    overlayWindow = createOverlayWindow();
    return;
  }
  positionOverlay();
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send("mortic-desktop:state", desktopState());
}

function overlayUrl(): string {
  if (!runtime) throw new Error("Mortic runtime is not ready");
  const url = new URL(runtime.url);
  url.searchParams.set("api", runtime.apiBase);
  url.searchParams.set("surface", "overlay");
  return url.toString();
}

function fullAppUrl(): string {
  if (!runtime) throw new Error("Mortic runtime is not ready");
  const url = new URL(runtime.url);
  url.searchParams.set("api", runtime.apiBase);
  url.searchParams.delete("surface");
  return url.toString();
}

function createOverlayWindow(): BrowserWindow {
  const size = windowSize();
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Mortic",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(runtime?.projectRoot ?? process.cwd(), "dist", "desktop", "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.setAlwaysOnTop(true, "floating");
  overlayWindow = win;
  configureOverlayResizeMode();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(overlayUrl());
  win.once("ready-to-show", () => {
    positionOverlay();
    if (!fullAppOwnsScreen()) win.show();
  });
  win.on("closed", () => {
    overlayWindow = null;
  });
  win.on("resize", () => {
    if (applyingOverlayBounds) return;
    const base = currentOverlayBaseSize();
    const [width] = win.getSize();
    const scale = clampOverlayScale(width / base.width);
    writePrefs({
      ...readPrefs(),
      [overlayExpanded ? "expandedOverlayScale" : "collapsedOverlayScale"]: scale
    });
    win.webContents.send("mortic-desktop:state", desktopState());
  });
  win.on("show", () => win.webContents.send("mortic-desktop:state", desktopState()));
  win.on("hide", () => win.webContents.send("mortic-desktop:state", desktopState()));
  return win;
}

function createFullWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 920,
    show: false,
    title: "Simple Mortic",
    backgroundColor: "#050706",
    webPreferences: {
      preload: path.join(runtime?.projectRoot ?? process.cwd(), "dist", "desktop", "desktop", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadURL(fullAppUrl());
  win.once("ready-to-show", () => {
    hideOverlay();
    win.show();
  });
  win.on("show", hideOverlay);
  win.on("focus", hideOverlay);
  win.on("maximize", hideOverlay);
  win.on("enter-full-screen", hideOverlay);
  win.on("restore", hideOverlay);
  win.on("closed", () => {
    fullWindow = null;
    if (runtime) {
      setTimeout(() => revealOverlay(), 0);
    }
  });
  return win;
}

function showFullApp(): void {
  hideOverlay();
  if (!fullWindow) {
    fullWindow = createFullWindow();
    return;
  }
  if (fullWindow.isMinimized()) fullWindow.restore();
  fullWindow.show();
  fullWindow.focus();
}

function toggleOverlay(): void {
  if (fullAppOwnsScreen()) {
    hideOverlay();
    fullWindow?.focus();
    return;
  }
  if (!overlayWindow) {
    overlayWindow = createOverlayWindow();
    return;
  }
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    revealOverlay();
  }
}

function setOverlayExpanded(next: boolean): void {
  overlayExpanded = next;
  positionOverlay();
  overlayWindow?.webContents.send("mortic-desktop:state", desktopState());
}

function desktopState() {
  return {
    platform: process.platform,
    shortcutLabel: process.platform === "darwin" ? "Cmd+Shift+M" : "Ctrl+Shift+M",
    expanded: overlayExpanded,
    visible: overlayWindow?.isVisible() ?? false,
    overlayScale: overlayScale()
  };
}

function registerIpc(): void {
  ipcMain.handle("mortic-desktop:get-state", () => desktopState());
  ipcMain.handle("mortic-desktop:set-overlay-expanded", (_event, expanded: boolean) => {
    setOverlayExpanded(Boolean(expanded));
    return desktopState();
  });
  ipcMain.handle("mortic-desktop:hide-overlay", () => {
    hideOverlay();
    return desktopState();
  });
  ipcMain.handle("mortic-desktop:open-full-app", () => {
    showFullApp();
    return desktopState();
  });
  ipcMain.handle("mortic-desktop:remember-source", (_event, sourceUri: string) => {
    if (typeof sourceUri === "string" && sourceUri.trim()) {
      writePrefs({
        ...readPrefs(),
        explicitSourceUri: sourceUri.trim(),
        rememberedAt: new Date().toISOString()
      });
    }
    return desktopState();
  });
}

async function boot(): Promise<void> {
  registerIpc();
  runtime = await startMorticRuntime({
    threadRef: await initialThreadRef(),
    noOpen: true,
    preferDevServer: process.argv.includes("--dev"),
    allowRecentThreadFallback: false,
    allowPlaceholderThread: true,
    launchCwd: process.cwd(),
    onLog: (line) => console.log(line),
    onWarn: (line) => console.warn(line)
  });

  overlayWindow = createOverlayWindow();
  globalShortcut.register(SHORTCUT, toggleOverlay);
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return;
  void boot().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    app.quit();
  });
});

app.on("second-instance", () => {
  if (runtime) {
    if (fullAppOwnsScreen()) {
      fullWindow?.focus();
    } else {
      revealOverlay();
    }
  }
});

app.on("activate", () => {
  if (fullAppOwnsScreen()) {
    fullWindow?.focus();
    return;
  }
  revealOverlay();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", (event) => {
  if (!runtime) return;
  event.preventDefault();
  const closing = runtime;
  runtime = null;
  void closing.close().finally(() => app.exit(0));
});
