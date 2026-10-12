/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// editor/studio/host-desktop.ts — the StudioHost of the desktop app
// (studio-desktop/). The page runs sandboxed with no Node; everything native
// goes through window.studioDesktop (desktop-bridge.ts), which the app's
// preload provides and its main process answers:
//
//   open      native file and folder dialogs, recent projects, files the OS
//             hands the app; the main process keeps the real paths and gives
//             the page a token per document
//   save      in place: a file through an atomic replace, a folder through
//             the same staged, rechecked, shell-last write rpgkit-edit uses;
//             documents from no file go to the app's profile folder
//   export    a native save dialog
//   checks    lint in the page (as on the web); engine checks on the computer
//   agent     a local agent process; its edits come back as proposals
//   preview   the bundled preview player in a same-origin iframe, the same
//             connection as the web page (BrowserPreview)
//
// Some StudioHost methods are synchronous (capabilities, restore), so the
// desktop entry builds this host with createDesktopHost(), which asks the
// main process for both once before Studio starts.

import type { BootReply, MenuCommand, OpenReply, StudioDesktopBridge } from "./desktop-bridge.ts";
import { THEME_KEY } from "./host-browser-boot.ts";
import { BrowserPreview } from "./host-browser.ts";
import {
  type AgentOutcome,
  type AgentRequest,
  type CheckOutcome,
  type CheckRequest,
  type HostCapabilities,
  type LocalArt,
  type OpenedProject,
  type RpgMakerImportOutcome,
  type RpgMakerImportProgress,
  type RpgMakerImportRequest,
  type SaveOutcome,
  type SaveTarget,
  type StoredProject,
  type StudioExample,
  type StudioHost,
  type StudioPreferences,
  type ThemeChoice,
  normalizeStudioPreferences,
  STUDIO_PREFERENCES_KEY,
} from "./host.ts";
import { checkProblems } from "./problems.ts";

type OpenListener = (opened: OpenedProject | { error: string }) => void;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The page's view of an opened file or folder: its main-process token. */
function toOpened(reply: OpenReply): OpenedProject | { error: string } {
  if ("error" in reply) return reply;
  return {
    text: reply.text,
    label: reply.label,
    fileName: reply.fileName,
    ...(reply.target ? { target: { kind: reply.target.kind, name: reply.target.name, ref: reply.target.token } } : {}),
    ...(reply.notes?.length ? { notes: reply.notes } : {}),
  };
}

export class DesktopHost implements StudioHost {
  readonly name = "desktop";
  private listeners = new Set<OpenListener>();
  private commandListeners = new Set<(command: MenuCommand) => void>();
  private systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  private systemMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private playTest: BrowserPreview | null = null;
  private lastDirty = false;

  constructor(private readonly bridge: StudioDesktopBridge, private readonly boot: BootReply) {
    bridge.onOpened((reply) => this.emit(toOpened(reply)));
    bridge.onMenu((command) => {
      for (const listener of this.commandListeners) listener(command);
    });
  }

  capabilities(): HostCapabilities {
    return this.boot.capabilities;
  }

  /** Documents the OS handed the app before Studio was listening. */
  initialDocuments(): (OpenedProject | { error: string })[] {
    return this.boot.opened.map(toOpened);
  }

  /** Menu items (File, Edit, View, Help) that Studio carries out. */
  onCommand(listener: (command: MenuCommand) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  /** Called when an agent run reports progress. */
  onAgentState(listener: (state: { status: string; message: string }) => void): () => void {
    return this.bridge.onAgentState(listener);
  }

  private emit(opened: OpenedProject | { error: string }): void {
    for (const listener of this.listeners) listener(opened);
  }

  onOpen(listener: OpenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pickProjectFile(): void {
    void this.bridge.pickFile().then(
      (reply) => { if (reply) this.emit(toOpened(reply)); },
      (error) => this.emit({ error: `Could not open the file: ${message(error)}` }),
    );
  }

  async pickProjectDirectory(): Promise<void> {
    try {
      const reply = await this.bridge.pickDirectory();
      if (reply) this.emit(toOpened(reply));
    } catch (error) {
      this.emit({ error: `Could not open the folder: ${message(error)}` });
    }
  }

  async importRpgMaker(request: RpgMakerImportRequest): Promise<RpgMakerImportOutcome> {
    try {
      const outcome = await this.bridge.importRpgMaker(request);
      if (!outcome.ok) return outcome;
      const opened = toOpened(outcome.opened);
      if ("error" in opened) {
        return { ok: false, token: request.token, code: "IMPORT_FAILED", message: opened.error };
      }
      return { ...outcome, opened };
    } catch (error) {
      return {
        ok: false,
        token: request.token,
        code: "IMPORT_FAILED",
        message: `RPG Maker import could not start / 无法开始 RPG Maker 导入: ${message(error)}`,
      };
    }
  }

  cancelRpgMakerImport(token: string): Promise<void> {
    return this.bridge.cancelRpgMakerImport(token);
  }

  onRpgMakerImportProgress(listener: (progress: RpgMakerImportProgress) => void): () => void {
    return this.bridge.onRpgMakerImportProgress(listener);
  }

  async listExamples(): Promise<StudioExample[]> {
    const response = await fetch("examples.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return ((await response.json()) as { examples: StudioExample[] }).examples;
  }

  async readExample(example: StudioExample): Promise<string> {
    const response = await fetch(example.document);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }

  async save(text: string, meta: { label: string; fileName: string }, target?: SaveTarget): Promise<SaveOutcome> {
    try {
      return await this.bridge.save({
        text,
        label: meta.label,
        fileName: meta.fileName,
        ...(target ? { target: String(target.ref) } : {}),
      });
    } catch (error) {
      return { ok: false, message: `Not saved: ${message(error)}` };
    }
  }

  restore(): StoredProject | null {
    return this.boot.stored;
  }

  async exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }> {
    try {
      return await this.bridge.exportFile(fileName, text);
    } catch (error) {
      return { ok: false, message: `Not exported: ${message(error)}` };
    }
  }

  async pickImage(): Promise<LocalArt | { error: string } | null> {
    const picked = await this.bridge.pickImage();
    if (!picked || "error" in picked) return picked;
    const url = URL.createObjectURL(new Blob([picked.bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    return { name: picked.name, url, release: () => URL.revokeObjectURL(url) };
  }

  async runChecks(request: CheckRequest): Promise<CheckOutcome> {
    if (request.mode === "dynamic") {
      if (!this.boot.capabilities.dynamicChecks.available) return { ok: false, code: "UNAVAILABLE", message: this.boot.capabilities.dynamicChecks.reason };
      try {
        return await this.bridge.check({ project: request.project, mode: "dynamic" });
      } catch (error) {
        return { ok: false, code: "FAILED", message: `Engine checks could not run: ${message(error)}` };
      }
    }
    try {
      return { ok: true, problems: checkProblems(request.project) };
    } catch (error) {
      return { ok: false, code: "FAILED", message: `Checks could not run: ${message(error)}` };
    }
  }

  async runAgent(request: AgentRequest): Promise<AgentOutcome> {
    if (!this.boot.capabilities.agent.available) return { ok: false, code: "FAILED", message: this.boot.capabilities.agent.reason };
    try {
      return await this.bridge.agent({
        prompt: request.prompt,
        projectText: request.projectText,
        ...(request.context ? { context: request.context } : {}),
      });
    } catch (error) {
      return { ok: false, code: "FAILED", message: `The agent could not run: ${message(error)}` };
    }
  }

  /** Stop the running agent request, if any. */
  cancelAgent(): Promise<void> {
    return this.bridge.cancelAgent();
  }

  preview(): BrowserPreview {
    this.playTest ??= new BrowserPreview();
    return this.playTest;
  }

  confirm(text: string): Promise<boolean> {
    return this.bridge.confirm(text);
  }

  /** The main process asks before closing while the document is dirty. It
   * cannot call into the page synchronously, so the page tells it whenever
   * the answer changes. */
  guardClose(isDirty: () => boolean): void {
    const report = () => {
      const now = isDirty();
      if (now === this.lastDirty) return;
      this.lastDirty = now;
      this.bridge.setDirty(now);
    };
    setInterval(report, 300);
  }

  theme(): ThemeChoice {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch { /* storage unavailable: follow the system */ }
    return "system";
  }

  setTheme(choice: ThemeChoice): void {
    try {
      if (choice === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, choice);
    } catch { /* not persisted */ }
  }

  systemPrefersDark(): boolean {
    return this.systemDark.matches;
  }

  onSystemThemeChange(listener: () => void): () => void {
    this.systemDark.addEventListener("change", listener);
    return () => this.systemDark.removeEventListener("change", listener);
  }

  preferences(): StudioPreferences {
    try {
      return normalizeStudioPreferences(JSON.parse(localStorage.getItem(STUDIO_PREFERENCES_KEY) ?? "null"));
    } catch {
      return normalizeStudioPreferences(null);
    }
  }

  setPreferences(preferences: StudioPreferences): void {
    try {
      localStorage.setItem(STUDIO_PREFERENCES_KEY, JSON.stringify(normalizeStudioPreferences(preferences)));
    } catch { /* preferences remain available for this session */ }
  }

  systemPrefersReducedMotion(): boolean {
    return this.systemMotion.matches;
  }

  onSystemMotionChange(listener: () => void): () => void {
    this.systemMotion.addEventListener("change", listener);
    return () => this.systemMotion.removeEventListener("change", listener);
  }
}

/** Ask the main process for capabilities, the stored document and anything
 * the OS opened, then build the host. */
export async function createDesktopHost(bridge: StudioDesktopBridge = (window as unknown as { studioDesktop: StudioDesktopBridge }).studioDesktop): Promise<DesktopHost> {
  if (!bridge) throw new Error("Studio's desktop bridge is missing: this page must run inside the desktop app.");
  return new DesktopHost(bridge, await bridge.boot());
}
