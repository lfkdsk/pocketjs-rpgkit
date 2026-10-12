// studio-desktop/src/preload.ts — the only bridge between Studio's page and
// the main process. It runs sandboxed with context isolation: the page gets
// window.studioDesktop, a fixed set of functions that each send one IPC
// message, and never ipcRenderer itself. The main process checks every
// message's sender and arguments again (main.ts).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { StudioDesktopBridge } from "../../editor/studio/desktop-bridge.ts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: StudioDesktopBridge = {
  boot: () => ipcRenderer.invoke("studio:boot"),
  pickFile: () => ipcRenderer.invoke("studio:pick-file"),
  pickDirectory: () => ipcRenderer.invoke("studio:pick-directory"),
  openRecent: (id) => ipcRenderer.invoke("studio:open-recent", id),
  importRpgMaker: (request) => ipcRenderer.invoke("studio:rpgmaker-import", request),
  cancelRpgMakerImport: (token) => ipcRenderer.invoke("studio:rpgmaker-import-cancel", token),
  pickImage: () => ipcRenderer.invoke("studio:pick-image"),
  save: (request) => ipcRenderer.invoke("studio:save", request),
  exportFile: (fileName, text) => ipcRenderer.invoke("studio:export", fileName, text),
  check: (request) => ipcRenderer.invoke("studio:check", request),
  agent: (request) => ipcRenderer.invoke("studio:agent", request),
  cancelAgent: () => ipcRenderer.invoke("studio:agent-cancel"),
  confirm: (message) => ipcRenderer.invoke("studio:confirm", message),
  setDirty: (dirty) => ipcRenderer.send("studio:dirty", dirty === true),
  onOpened: (listener) => subscribe("studio:opened", listener),
  onMenu: (listener) => subscribe("studio:menu", listener),
  onAgentState: (listener) => subscribe("studio:agent-state", listener),
  onRpgMakerImportProgress: (listener) => subscribe("studio:rpgmaker-import-progress", listener),
};

contextBridge.exposeInMainWorld("studioDesktop", bridge);
