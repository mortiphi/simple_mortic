export type MorticDesktopState = {
  platform: string;
  shortcutLabel: string;
  expanded: boolean;
  visible: boolean;
  overlayScale: number;
  shortcutRegistered: boolean;
  shortcutError?: string;
};

export type MorticDesktopBridge = {
  getDesktopState: () => Promise<MorticDesktopState>;
  setOverlayExpanded: (expanded: boolean) => Promise<MorticDesktopState>;
  hideOverlay: () => Promise<MorticDesktopState>;
  openFullApp: () => Promise<MorticDesktopState>;
  rememberSource: (sourceUri: string) => Promise<MorticDesktopState>;
  openExternal: (url: string) => Promise<boolean>;
  onDesktopState?: (listener: (state: MorticDesktopState) => void) => () => void;
  onAudioCancel?: (listener: () => void) => () => void;
};

declare global {
  interface Window {
    morticDesktop?: MorticDesktopBridge;
  }
}

export function desktopBridge(): MorticDesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.morticDesktop;
}
