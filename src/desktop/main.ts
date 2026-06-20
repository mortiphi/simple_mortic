import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from "electron";

import { morticHomeDir, startMorticRuntime, type StartedMorticRuntime } from "../cli/runtime.js";
import { parseThreadUri } from "../shared/threadUri.js";

type DesktopPrefs = {
  explicitSourceUri?: string;
  rememberedAt?: string;
  validatedExplicitSource?: boolean;
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
let shortcutRegistered = false;
let shortcutError: string | undefined;
let captureScaleOverride: number | undefined;
let captureSweepStarted = false;

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
  if (captureScaleOverride !== undefined) return captureScaleOverride;
  const prefs = readPrefs();
  const preferred = overlayExpanded ? prefs.expandedOverlayScale : prefs.collapsedOverlayScale;
  return clampOverlayScale(preferred ?? prefs.overlayScale);
}

function currentOverlayBaseSize() {
  return overlayExpanded ? OVERLAY_EXPANDED : OVERLAY_COLLAPSED;
}

async function initialThreadRef(): Promise<string | undefined> {
  const captureSourceUri = process.env.MORTIC_DESKTOP_CAPTURE_SOURCE_URI?.trim();
  if (captureSourceUri) {
    try {
      parseThreadUri(captureSourceUri);
      return captureSourceUri;
    } catch {
      throw new Error("MORTIC_DESKTOP_CAPTURE_SOURCE_URI is not a valid Codex thread URI");
    }
  }
  const prefs = readPrefs();
  const explicitSourceUri = prefs.explicitSourceUri?.trim();
  if (!explicitSourceUri || prefs.validatedExplicitSource !== true) return undefined;

  try {
    parseThreadUri(explicitSourceUri);
  } catch {
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

function hideOverlay(cancelAudio = true): void {
  if (cancelAudio) overlayWindow?.webContents.send("mortic-desktop:audio-cancel");
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
      sandbox: true
    }
  });
  secureWindow(win);
  win.setAlwaysOnTop(true, "floating");
  overlayWindow = win;
  configureOverlayResizeMode();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(overlayUrl());
  win.once("ready-to-show", () => {
    positionOverlay();
    if (!fullAppOwnsScreen()) win.show();
  });
  win.webContents.once("did-finish-load", () => {
    if (process.env.MORTIC_DESKTOP_CAPTURE_DIR && !captureSweepStarted) {
      captureSweepStarted = true;
      void runVisualCaptureSweep(win, process.env.MORTIC_DESKTOP_CAPTURE_DIR).catch((error) => {
        console.error(`Desktop capture sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        app.quit();
      });
    }
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

async function runVisualCaptureSweep(win: BrowserWindow, outputDir: string): Promise<void> {
  mkdirSync(outputDir, { recursive: true });
  await waitForCaptureState(win, `Boolean(document.querySelector('[data-session-ready="true"]'))`);
  const originalExpanded = overlayExpanded;
  for (const expanded of [false, true]) {
    overlayExpanded = expanded;
    for (const scale of [1, 0.75, 0.55, 0.4]) {
      captureScaleOverride = scale;
      positionOverlay();
      win.webContents.send("mortic-desktop:state", desktopState());
      await waitForCaptureState(win, `(() => {
        const shell = document.querySelector(".desktop-overlay-shell");
        if (!shell) return false;
        const modeReady = shell.classList.contains(${JSON.stringify(expanded ? "desktop-overlay-expanded" : "desktop-overlay-collapsed")});
        const renderedScale = Number.parseFloat(shell.style.getPropertyValue("--desktop-overlay-scale"));
        return modeReady && Math.abs(renderedScale - ${scale}) < 0.01;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 180));
      const image = await win.webContents.capturePage();
      const mode = expanded ? "expanded" : "collapsed";
      const stem = `${mode}-${Math.round(scale * 100)}`;
      writeFileSync(path.join(outputDir, `${stem}.png`), image.toPNG());
      writeFileSync(
        path.join(outputDir, `${stem}.json`),
        `${JSON.stringify(await captureLayoutMetrics(win, mode, scale), null, 2)}\n`,
        "utf8"
      );
    }
  }
  const appWindow = createFullWindow();
  await waitForCaptureState(appWindow, `Boolean(document.querySelector('.app-shell[data-session-ready="true"]'))`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  writeFileSync(path.join(outputDir, "full-app.png"), (await appWindow.webContents.capturePage()).toPNG());
  writeFileSync(
    path.join(outputDir, "full-app.json"),
    `${JSON.stringify(await captureFullAppMetrics(appWindow), null, 2)}\n`,
    "utf8"
  );
  appWindow.destroy();
  captureScaleOverride = undefined;
  overlayExpanded = originalExpanded;
  app.quit();
}

async function captureFullAppMetrics(win: BrowserWindow): Promise<unknown> {
  return win.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector(".app-shell");
    const selectors = [".command-topbar", ".command-main", ".handoff-panel", ".bottom-voice-dock", ".studio-settings"];
    const elements = selectors.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => {
      const rect = element.getBoundingClientRect();
      return { selector, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } };
    }));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      sessionReady: shell?.dataset.sessionReady === "true",
      documentOverflow: { x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight },
      elements
    };
  })()`);
}

async function waitForCaptureState(win: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression, true)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Renderer did not reach a stable capture state");
}

async function captureLayoutMetrics(win: BrowserWindow, mode: string, scale: number): Promise<unknown> {
  return win.webContents.executeJavaScript(`(() => {
    const selectors = [
      ".desktop-hud",
      ".desktop-hud-identity",
      ".desktop-hud-state",
      ".desktop-hud-actions",
      ".desktop-command-panel",
      ".desktop-panel-header",
      ".desktop-overlay-transcript",
      ".desktop-overlay-transcript > .live-card-header",
      ".desktop-overlay-transcript > .compact-turn",
      ".codex-working-buffer",
      ".desktop-overlay-controls",
      ".desktop-overlay-composer",
      ".desktop-handoff-card",
      ".desktop-overlay-hint",
      ".desktop-provider-notices",
      ".desktop-overlay-config"
    ];
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const rectFor = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: Math.round(rect.left * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        bottom: Math.round(rect.bottom * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100
      };
    };
    const elements = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((element, index) => ({ selector, index, element, rect: rectFor(element) })));
    const outside = elements.filter(({ rect }) => rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1)
      .map(({ selector, index, rect }) => ({ selector, index, rect }));
    const parentClipping = elements.filter(({ element, rect }) => {
      if (!element.matches(".desktop-overlay-transcript > .live-card-header, .desktop-overlay-transcript > .compact-turn")) return false;
      const parent = element.parentElement?.getBoundingClientRect();
      return Boolean(parent && (rect.left < parent.left - 1 || rect.top < parent.top - 1 || rect.right > parent.right + 1 || rect.bottom > parent.bottom + 1));
    }).map(({ selector, index, rect }) => ({ selector, index, rect }));
    const major = elements.filter(({ element }) => element.parentElement?.classList.contains("desktop-command-panel") || element.parentElement?.classList.contains("desktop-hud"));
    const overlaps = [];
    for (let left = 0; left < major.length; left += 1) {
      for (let right = left + 1; right < major.length; right += 1) {
        const a = major[left];
        const b = major[right];
        const width = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const height = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (width > 1 && height > 1) overlaps.push({ left: a.selector, right: b.selector, width, height });
      }
    }
    const shell = document.querySelector(".desktop-overlay-shell");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      density: shell ? [...shell.classList].find((name) => name.startsWith("desktop-density-")) : null,
      sessionReady: shell?.dataset.sessionReady === "true",
      threadRequired: shell?.classList.contains("desktop-thread-required") ?? false,
      documentOverflow: { x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight },
      outside,
      parentClipping,
      overlaps,
      elements: elements.map(({ selector, index, rect }) => ({ selector, index, rect }))
    };
  })()`);
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
      sandbox: true
    }
  });
  secureWindow(win);
  win.loadURL(fullAppUrl());
  win.once("ready-to-show", () => {
    hideOverlay(false);
    win.show();
  });
  win.on("show", () => hideOverlay(false));
  win.on("focus", () => hideOverlay(false));
  win.on("maximize", () => hideOverlay(false));
  win.on("enter-full-screen", () => hideOverlay(false));
  win.on("restore", () => hideOverlay(false));
  win.on("closed", () => {
    fullWindow = null;
    if (runtime) {
      setTimeout(() => revealOverlay(), 0);
    }
  });
  return win;
}

function showFullApp(): void {
  hideOverlay(false);
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
    hideOverlay(false);
    fullWindow?.focus();
    return;
  }
  if (!overlayWindow) {
    overlayWindow = createOverlayWindow();
    return;
  }
  if (overlayWindow.isVisible()) {
    hideOverlay(true);
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
    overlayScale: overlayScale(),
    shortcutRegistered,
    shortcutError
  };
}

function approvedExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function secureWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, target) => {
    const allowedOrigin = runtime ? new URL(runtime.url).origin : null;
    try {
      if (allowedOrigin && new URL(target).origin === allowedOrigin) return;
    } catch {
      // Invalid renderer navigation targets are denied below.
    }
    event.preventDefault();
  });
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
        rememberedAt: new Date().toISOString(),
        validatedExplicitSource: true
      });
    }
    return desktopState();
  });
  ipcMain.handle("mortic-desktop:open-external", async (_event, value: unknown) => {
    const url = approvedExternalUrl(value);
    if (!url) return false;
    await shell.openExternal(url);
    return true;
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
  shortcutRegistered = globalShortcut.register(SHORTCUT, toggleOverlay);
  shortcutError = shortcutRegistered ? undefined : `${SHORTCUT} is already in use by another application.`;
  overlayWindow.webContents.send("mortic-desktop:state", desktopState());
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
