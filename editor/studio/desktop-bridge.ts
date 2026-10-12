// editor/studio/desktop-bridge.ts — the shape of window.studioDesktop, shared by
// the desktop app's preload (which implements it over IPC), its main process
// (which answers it) and Studio's desktop host (host-desktop.ts, which uses
// it). Types only.

import type { LocalAgentEditorContext } from "../agent/types.ts";
import type {
  AgentOutcome,
  CheckOutcome,
  HostCapabilities,
  HostCommand,
  RpgMakerImportCoverage,
  RpgMakerImportOutcome,
  RpgMakerImportProgress,
  RpgMakerImportRequest,
  SaveOutcome,
  StoredProject,
} from "./host.ts";
import type { Project } from "../../src/engine/types.ts";

/** A document read by the main process. `token` names the file or folder it
 * came from; the page never sees the real path. */
export type OpenReply =
  | { text: string; label: string; fileName: string; target?: { kind: "file" | "directory"; name: string; token: string }; notes?: string[] }
  | { error: string };

type SuccessfulOpenReply = Extract<OpenReply, { text: string }>;

/** The main process still represents an opened directory with a path token;
 * DesktopHost turns that token into the host-private SaveTarget ref. */
export type DesktopRpgMakerImportOutcome =
  | {
      ok: true;
      token: string;
      opened: SuccessfulOpenReply;
      coverage: RpgMakerImportCoverage;
      warnings: string[];
    }
  | Extract<RpgMakerImportOutcome, { ok: false }>;

export interface RecentEntry {
  id: string;
  kind: "file" | "directory";
  name: string;
}

export interface BootReply {
  capabilities: HostCapabilities;
  stored: StoredProject | null;
  recent: RecentEntry[];
  /** Documents given on the command line or by the OS before the page booted. */
  opened: OpenReply[];
  /** "linux", "darwin", "win32": for shortcut labels. */
  platform: string;
  version: string;
}

export interface SaveRequest {
  text: string;
  label: string;
  fileName: string;
  /** The token of an opened file or folder; absent saves to app storage. */
  target?: string;
}

export interface AgentBridgeRequest {
  prompt: string;
  projectText: string;
  context?: LocalAgentEditorContext;
}

export interface AgentStateEvent {
  status: string;
  message: string;
}

/** Menu items the page carries out (it owns the document and its history). */
export type MenuCommand = HostCommand;

export interface StudioDesktopBridge {
  boot(): Promise<BootReply>;
  pickFile(): Promise<OpenReply | null>;
  pickDirectory(): Promise<OpenReply | null>;
  openRecent(id: string): Promise<OpenReply | null>;
  importRpgMaker(request: RpgMakerImportRequest): Promise<DesktopRpgMakerImportOutcome>;
  cancelRpgMakerImport(token: string): Promise<void>;
  pickImage(): Promise<{ name: string; bytes: Uint8Array } | { error: string } | null>;
  save(request: SaveRequest): Promise<SaveOutcome>;
  exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }>;
  check(request: { project: Project; mode: "lint" | "dynamic" }): Promise<CheckOutcome>;
  agent(request: AgentBridgeRequest): Promise<AgentOutcome>;
  cancelAgent(): Promise<void>;
  confirm(message: string): Promise<boolean>;
  setDirty(dirty: boolean): void;
  onOpened(listener: (opened: OpenReply) => void): () => void;
  onMenu(listener: (command: MenuCommand) => void): () => void;
  onAgentState(listener: (state: AgentStateEvent) => void): () => void;
  onRpgMakerImportProgress(listener: (progress: RpgMakerImportProgress) => void): () => void;
}
