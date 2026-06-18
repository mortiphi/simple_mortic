const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("morticDesktop", {
  getDesktopState: () => ipcRenderer.invoke("mortic-desktop:get-state"),
  setOverlayExpanded: (expanded) => ipcRenderer.invoke("mortic-desktop:set-overlay-expanded", Boolean(expanded)),
  hideOverlay: () => ipcRenderer.invoke("mortic-desktop:hide-overlay"),
  openFullApp: () => ipcRenderer.invoke("mortic-desktop:open-full-app"),
  rememberSource: (sourceUri) => ipcRenderer.invoke("mortic-desktop:remember-source", String(sourceUri ?? "")),
  onDesktopState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("mortic-desktop:state", wrapped);
    return () => ipcRenderer.off("mortic-desktop:state", wrapped);
  }
});
