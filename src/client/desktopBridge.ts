export type MorticDesktopState = {
  platform: string;
  shortcutLabel: string;
  expanded: boolean;
  visible: boolean;
  overlayScale: number;
};

export type MorticDesktopBridge = {
  getDesktopState: () => Promise<MorticDesktopState>;
  setOverlayExpanded: (expanded: boolean) => Promise<MorticDesktopState>;
  hideOverlay: () => Promise<MorticDesktopState>;
  openFullApp: () => Promise<MorticDesktopState>;
  rememberSource: (sourceUri: string) => Promise<MorticDesktopState>;
  onDesktopState?: (listener: (state: MorticDesktopState) => void) => () => void;
};

declare global {
  interface Window {
    morticDesktop?: MorticDesktopBridge;
  }
}

export function desktopBridge(): MorticDesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.morticDesktop;
}
