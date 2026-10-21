/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// editor/studio/host-browser.ts — the StudioHost for a web page. With its
// page boot snippet (host-browser-boot.ts), the only code in editor/studio/
// that talks to browser storage, pickers, downloads and fetch
// (tests/studio-host.test.ts checks this).
//
//   save      localStorage, one document per origin; a document opened from
//             a directory saves back into it instead
//   open      <input type=file>; Chromium's directory picker (File System
//             Access) for loose sharded projects
//   export    a Blob behind a download link
//   checks    schema + rpgkit-check static lint, in the page
//   agent     not here: it needs a local process
//   preview   the site's `preview` player page in an iframe, driven over
//             postMessage (rpgkit-preview/v1); replies are accepted only from
//             that iframe's window and the site's own origin

import { THEME_KEY } from "./host-browser-boot.ts";
import { checkProblems } from "./problems.ts";
import { openFileProblem, PNG_HEADER_BYTES, pngProblem } from "../api/limits.ts";
import {
  available,
  NEEDS_DESKTOP,
  unavailable,
  type AgentOutcome,
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
import { openDirectoryProject, saveDirectoryTarget, type ProjectDirectory } from "./project-directory.ts";
import {
  PREVIEW_PROTOCOL,
  type PreviewArtMessage,
  type PreviewArtResult,
  type PreviewChapter,
  type PreviewLoadResult,
  type PreviewOutcome,
  type PreviewStartResult,
  type PreviewStateResult,
  type PreviewTarget,
  type StudioPreview,
} from "./preview.ts";
import { PREVIEW_VERSION } from "../../tools/preview/protocol.ts";
import { BrowserRpgMakerImporter } from "./rpgmaker-import-browser.ts";

export const STORAGE_KEY = "pocket-rpgkit:studio:document:v1";
export { THEME_KEY };

interface StoredDocument extends StoredProject {
  v: 1;
}

type OpenListener = (opened: OpenedProject | { error: string }) => void;

/** The parts of the File System Access API this host uses (not in every
 * TypeScript DOM lib yet). */
interface DirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<FileHandle | DirectoryHandle>;
  getDirectoryHandle(name: string): Promise<DirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
}

interface FileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  /** Rename within the same directory; newer Chromium only. */
  move?(newName: string): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A ProjectDirectory over a File System Access directory handle. */
export function handleDirectory(root: DirectoryHandle): ProjectDirectory {
  const walk = async (path: string): Promise<{ parent: DirectoryHandle; name: string }> => {
    const parts = path.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
    return { parent, name: parts.at(-1)! };
  };
  return {
    name: `${root.name}/`,
    async listRoot() {
      const names: string[] = [];
      for await (const item of root.values()) if (item.kind === "file") names.push(item.name);
      return names;
    },
    async read(path) {
      const { parent, name } = await walk(path);
      return (await (await parent.getFileHandle(name)).getFile()).text();
    },
    async readBytes(path) {
      const { parent, name } = await walk(path);
      return new Uint8Array(await (await (await parent.getFileHandle(name)).getFile()).arrayBuffer());
    },
    async size(path) {
      const { parent, name } = await walk(path);
      return (await (await parent.getFileHandle(name)).getFile()).size;
    },
    async write(path, text) {
      const { parent, name } = await walk(path);
      await writeHandle(await parent.getFileHandle(name, { create: true }), text);
    },
    async remove(path) {
      const { parent, name } = await walk(path);
      await parent.removeEntry(name);
    },
    // Replace `to` with the staged file `from` (a sibling). FileSystemFileHandle
    // .move() renames in place, but not every Chromium has it, and some
    // versions refuse to move onto an existing name. So the staged bytes are
    // read first, move() is tried when present, and if it is missing or throws
    // the bytes are written into `to` instead. That write is still all or
    // nothing per file: Chromium's createWritable() writes a swap file and
    // swaps it in on close(), so `to` keeps its old bytes if it fails.
    async rename(from, to) {
      const source = await walk(from);
      const target = await walk(to);
      const handle = await source.parent.getFileHandle(source.name);
      const text = await (await handle.getFile()).text();
      const sameFolder = from.slice(0, from.lastIndexOf("/") + 1) === to.slice(0, to.lastIndexOf("/") + 1);
      if (sameFolder && typeof handle.move === "function") {
        try {
          await handle.move(target.name);
          return;
        } catch {
          // Fall through to the copy below.
        }
      }
      await writeHandle(await target.parent.getFileHandle(target.name, { create: true }), text);
      await source.parent.removeEntry(source.name).catch(() => undefined);
    },
  };
}

async function writeHandle(handle: FileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/** The site's preview player page, relative to Studio (both live on the
 * same site: <site>/studio/ and <site>/preview/). ?embed shows only the game
 * screen. */
export const PREVIEW_PAGE = "../preview/?embed";
/** How long the embedded page may take to boot and announce itself. */
const READY_TIMEOUT_MS = 20_000;
/** Loading validates the whole document in the game page. */
const LOAD_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;

interface Pending {
  resolve(outcome: PreviewOutcome<unknown>): void;
  timer: ReturnType<typeof setTimeout>;
}

/** rpgkit-preview/v1 over postMessage to an iframe of the site's preview
 * page. Studio only embeds a page of its own origin, and only messages whose
 * source is that iframe's window and whose origin is the site's are read;
 * anything else is counted in `ignored` and dropped. */
export class BrowserPreview implements StudioPreview {
  private frame: HTMLIFrameElement | null = null;
  private origin = "";
  private ready = false;
  /** What the page's ready event listed in `features`. */
  private pageFeatures: string[] = [];
  /** Set when the embedded page speaks another protocol version. */
  private versionError: string | null = null;
  private waiting: Pending | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private releaseListeners = new Set<() => void>();
  /** Messages dropped by the source, origin and protocol checks. */
  ignored = 0;
  /** Requests posted to the game page. */
  sent = 0;

  constructor(private readonly page: string = PREVIEW_PAGE) {
    window.addEventListener("message", (event) => this.receive(event));
  }

  async connect(slotId: string): Promise<PreviewOutcome<void>> {
    this.disconnect();
    const slot = document.getElementById(slotId);
    if (!slot) return { ok: false, code: "unavailable", message: `Studio has no #${slotId} to show the game in.` };
    const url = new URL(this.page, location.href);
    if (url.origin !== location.origin) {
      return { ok: false, code: "unavailable", message: `The preview page must be on this site (${location.origin}), not ${url.origin}.` };
    }
    const frame = document.createElement("iframe");
    frame.className = "playtest-frame";
    frame.title = "Game preview";
    frame.src = url.href;
    frame.addEventListener("load", () => this.hookKeys(frame));
    this.frame = frame;
    this.origin = url.origin;
    const outcome = new Promise<PreviewOutcome<unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        resolve({ ok: false, code: "timeout", message: `The game page (${url.pathname}) did not start within ${READY_TIMEOUT_MS / 1000} s. Is the site's preview page built?` });
      }, READY_TIMEOUT_MS);
      this.waiting = { resolve, timer };
    });
    slot.replaceChildren(frame);
    return (await outcome) as PreviewOutcome<void>;
  }

  features(): readonly string[] {
    return this.ready ? this.pageFeatures : [];
  }

  load(documentText: string, chapters: readonly PreviewChapter[], options?: { art?: boolean }): Promise<PreviewOutcome<PreviewLoadResult>> {
    return this.request("load", { document: documentText, ...(chapters.length ? { chapters } : {}), ...(options?.art ? { art: true } : {}) }, LOAD_TIMEOUT_MS);
  }

  sendArt(message: PreviewArtMessage): Promise<PreviewOutcome<PreviewArtResult>> {
    // A slice carries up to a few MiB of base64 for the page to decode.
    return this.request("art", { ...message }, LOAD_TIMEOUT_MS);
  }

  start(target: PreviewTarget): Promise<PreviewOutcome<PreviewStartResult>> {
    const { kind: _kind, ...fields } = target;
    return this.request("start", fields);
  }

  state(): Promise<PreviewOutcome<PreviewStateResult>> {
    return this.request("state", {});
  }

  stop(): Promise<PreviewOutcome<void>> {
    return this.request("stop", {});
  }

  focusGame(): void {
    const frame = this.frame;
    if (!frame) return;
    frame.focus();
    try {
      // The player page reads keys on its game screen element.
      frame.contentDocument?.getElementById("stage")?.focus({ preventScroll: true });
    } catch { /* not readable: the iframe keeps the focus */ }
  }

  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  disconnect(): void {
    for (const [id, pending] of this.pending) this.settle(this.pending, id, pending, { ok: false, code: "disconnected", message: "The game was closed." });
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.resolve({ ok: false, code: "disconnected", message: "The game was closed." });
      this.waiting = null;
    }
    this.frame?.remove();
    this.frame = null;
    this.ready = false;
    this.pageFeatures = [];
    this.versionError = null;
  }

  /** Test hook: requests awaiting a reply, requests sent, and the drop count. */
  debug(): { pending: string[]; ignored: number; sent: number; origin: string; ready: boolean } {
    return { pending: [...this.pending.keys()], ignored: this.ignored, sent: this.sent, origin: this.origin, ready: this.ready };
  }

  private settle(map: Map<string, Pending>, id: string, pending: Pending, outcome: PreviewOutcome<unknown>): void {
    clearTimeout(pending.timer);
    map.delete(id);
    pending.resolve(outcome);
  }

  private request<T>(type: string, fields: Record<string, unknown>, timeout = REQUEST_TIMEOUT_MS): Promise<PreviewOutcome<T>> {
    const target = this.frame?.contentWindow;
    if (this.versionError) return Promise.resolve({ ok: false, code: "bad-version", message: this.versionError });
    if (!target || !this.ready) return Promise.resolve({ ok: false, code: "disconnected", message: "The game is not running." });
    const requestId = `studio-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, code: "timeout", message: `The game did not answer ${type} within ${timeout / 1000} s.` });
      }, timeout);
      this.pending.set(requestId, { resolve: resolve as (outcome: PreviewOutcome<unknown>) => void, timer });
      this.sent++;
      try {
        target.postMessage({ protocol: PREVIEW_PROTOCOL, type, requestId, ...fields }, this.origin);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ ok: false, code: "disconnected", message: `Could not reach the game: ${message(error)}` });
      }
    });
  }

  private receive(event: MessageEvent): void {
    const frame = this.frame;
    // Only the iframe Studio embedded, on the site's own origin: a message
    // from any other window or origin (even a same-origin one) is dropped.
    if (!frame || event.source !== frame.contentWindow || event.origin !== this.origin) {
      this.ignored++;
      return;
    }
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      this.ignored++;
      return;
    }
    // Other traffic from the page (not this protocol family) is not ours to
    // judge; only a preview host on another version is an error.
    const otherVersion = typeof data.protocol === "string" && data.protocol !== PREVIEW_PROTOCOL && data.protocol.startsWith("rpgkit-preview/");
    if (data.protocol !== PREVIEW_PROTOCOL && !otherVersion) {
      this.ignored++;
      return;
    }
    if (otherVersion || (data.type === "event" && data.event === "ready" && data.version !== PREVIEW_VERSION)) {
      const version = `${String(data.protocol)}${data.version === undefined ? "" : ` version ${String(data.version)}`}`;
      this.versionMismatch(`The game page speaks ${version}; this Studio needs ${PREVIEW_PROTOCOL} version ${PREVIEW_VERSION}. Reload Studio and the site together.`);
      this.ignored++;
      return;
    }
    if (data.type === "event" && data.event === "ready") {
      this.ready = true;
      // Optional within v1: an older page lists none.
      this.pageFeatures = Array.isArray(data.features) ? data.features.filter((feature): feature is string => typeof feature === "string") : [];
      const waiting = this.waiting;
      this.waiting = null;
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.resolve({ ok: true, value: undefined });
      }
      return;
    }
    if (data.type === "reply" && typeof data.requestId === "string") {
      const pending = this.pending.get(data.requestId);
      if (!pending) {
        this.ignored++;
        return;
      }
      const error = data.error as { code?: unknown; message?: unknown } | undefined;
      this.settle(this.pending, data.requestId, pending, data.ok === true
        ? { ok: true, value: data.result }
        : { ok: false, code: String(error?.code ?? "internal"), message: String(error?.message ?? "the game reported an error") });
      return;
    }
    this.ignored++;
  }

  /** A host on another protocol version: fail whatever is waiting, visibly. */
  private versionMismatch(message: string): void {
    const outcome: PreviewOutcome<unknown> = { ok: false, code: "bad-version", message };
    this.ready = false;
    this.versionError = message;
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.resolve(outcome);
      this.waiting = null;
    }
    for (const [id, pending] of this.pending) this.settle(this.pending, id, pending, outcome);
  }

  /** Esc inside the game hands the keyboard back to Studio. The player page
   * maps Esc to cancel too; Studio takes it first, and B / Backspace still
   * cancel in the game. */
  private hookKeys(frame: HTMLIFrameElement): void {
    let inner: Window | null = null;
    try {
      inner = frame.contentWindow;
      inner?.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        frame.blur();
        window.focus();
        for (const listener of this.releaseListeners) listener();
      }, true);
    } catch { /* another origin: never embedded (connect checks) */ }
  }
}

export class BrowserHost implements StudioHost {
  readonly name = "browser";
  private listeners = new Set<OpenListener>();
  private fileInput: HTMLInputElement;
  private systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  private systemMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private rpgMakerImporter = new BrowserRpgMakerImporter(() => this.directoryPicker());

  constructor() {
    // A persistent input: the toolbar opens it, and automation can set its
    // files directly.
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "application/json,.json";
    this.fileInput.hidden = true;
    this.fileInput.id = "studio-open-input";
    document.body.appendChild(this.fileInput);
    this.fileInput.addEventListener("change", async () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (!file) return;
      // Refuse an oversized file before reading it into memory.
      const tooBig = openFileProblem(file.size, file.name);
      if (tooBig !== null) {
        this.emit({ error: tooBig });
        return;
      }
      try {
        this.emit({ text: await file.text(), label: file.name, fileName: file.name });
      } catch (error) {
        this.emit({ error: `Could not read ${file.name}: ${message(error)}` });
      }
    });
  }

  private storageWorks(): boolean {
    try {
      return typeof localStorage !== "undefined" && localStorage !== null;
    } catch {
      return false;
    }
  }

  private directoryPicker(): ((options: { mode: "read" | "readwrite" }) => Promise<DirectoryHandle>) | null {
    const picker = (window as unknown as { showDirectoryPicker?: (options: { mode: "read" | "readwrite" }) => Promise<DirectoryHandle> }).showDirectoryPicker;
    return typeof picker === "function" ? picker.bind(window) : null;
  }

  capabilities(): HostCapabilities {
    const directories = this.directoryPicker() !== null;
    const noDirectories = "This browser has no directory picker (File System Access); open a sharded pack file instead, or use Chrome or Edge.";
    return {
      openFile: available("Open a project JSON or a sharded pack from your computer."),
      openDirectory: directories ? available("Open a folder holding project.json and its map files; Save writes back into it.") : unavailable(noDirectories),
      rpgMakerImport: directories
        ? available("Import an RPG Maker MV/MZ folder in this browser; maps and PNG art are embedded in the staged result, while source audio is reported as unavailable.")
        : unavailable(noDirectories),
      saveInPlace: directories
        ? available("Projects opened from a folder save back into that folder. A failed write puts back the files already replaced; the save is not crash-proof, so a crash or closed tab mid-save can leave a mix of old and new files.")
        : unavailable(`Single files cannot be saved in place by a web page. ${noDirectories}`),
      storage: this.storageWorks()
        ? available("Save keeps one document in this browser and restores it next time.")
        : unavailable("This browser blocks local storage for this page; use Download."),
      export: available("Download hands the exact export bytes to the browser."),
      localArt: available("Chosen PNGs are used in this page only; they are not uploaded or saved."),
      checks: available("Schema validation and rpgkit-check's static lint run in this page."),
      dynamicChecks: unavailable("rpgkit-check's engine checks (reachability, locks) are not wired into the web page; run rpgkit-check locally or use the desktop app."),
      agent: unavailable(NEEDS_DESKTOP),
      preview: available("Plays the open document in the real game engine, embedded from this site's preview page."),
    };
  }

  private playTest: BrowserPreview | null = null;

  preview(): BrowserPreview {
    this.playTest ??= new BrowserPreview();
    return this.playTest;
  }

  private emit(opened: OpenedProject | { error: string }): void {
    for (const listener of this.listeners) listener(opened);
  }

  onOpen(listener: OpenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  pickProjectFile(): void {
    this.fileInput.click();
  }

  async pickProjectDirectory(): Promise<void> {
    const picker = this.directoryPicker();
    if (!picker) {
      this.emit({ error: this.capabilities().openDirectory.reason });
      return;
    }
    let handle: DirectoryHandle;
    try {
      handle = await picker({ mode: "readwrite" });
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") this.emit({ error: `Could not open the folder: ${message(error)}` });
      return;
    }
    await this.openDirectoryHandle(handle);
  }

  /** Open a directory handle from the picker (or, in tests, from the
   * origin-private file system). */
  async openDirectoryHandle(handle: DirectoryHandle): Promise<void> {
    this.emit(await openDirectoryProject(handleDirectory(handle)));
  }

  importRpgMaker(request: RpgMakerImportRequest): Promise<RpgMakerImportOutcome> {
    return this.rpgMakerImporter.import(request);
  }

  async cancelRpgMakerImport(token: string): Promise<void> {
    this.rpgMakerImporter.cancel(token);
  }

  onRpgMakerImportProgress(listener: (progress: RpgMakerImportProgress) => void): () => void {
    return this.rpgMakerImporter.onProgress(listener);
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
    const savedAt = new Date().toISOString();
    if (target?.kind === "directory") return saveDirectoryTarget(target, text, savedAt);
    if (target) return { ok: false, message: `This browser cannot save to ${target.name} in place.` };
    const stored: StoredDocument = { v: 1, label: meta.label, fileName: meta.fileName, text, savedAt };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch (error) {
      return { ok: false, message: `Not saved: browser storage refused the document (${error instanceof Error ? error.name : String(error)}). Download keeps working.` };
    }
    return { ok: true, where: "storage", written: [STORAGE_KEY], savedAt };
  }

  restore(): StoredProject | null {
    let raw: string | null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as StoredDocument;
      if (stored.v !== 1 || typeof stored.text !== "string") return null;
      return { label: stored.label, fileName: stored.fileName, text: stored.text, savedAt: stored.savedAt };
    } catch {
      return null;
    }
  }

  async exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }> {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, message: `Downloaded ${fileName}.` };
  }

  pickImage(): Promise<LocalArt | { error: string } | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png";
      input.hidden = true;
      document.body.appendChild(input);
      const done = (art: LocalArt | { error: string } | null) => {
        input.remove();
        resolve(art);
      };
      input.addEventListener("cancel", () => done(null));
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return done(null);
        // Size first, then only the 24-byte header (signature, width,
        // height) before the image is ever decoded.
        let problem = pngProblem(file.name, file.size);
        if (problem === null) {
          try {
            problem = pngProblem(file.name, file.size, new Uint8Array(await file.slice(0, PNG_HEADER_BYTES).arrayBuffer()));
          } catch (error) {
            problem = `Could not read ${file.name}: ${message(error)}`;
          }
        }
        if (problem !== null) return done({ error: problem });
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const url = URL.createObjectURL(file);
          done({ name: file.name, url, bytes, release: () => URL.revokeObjectURL(url) });
        } catch (error) {
          done({ error: `Could not read ${file.name}: ${message(error)}` });
        }
      });
      input.click();
    });
  }

  async runChecks(request: CheckRequest): Promise<CheckOutcome> {
    if (request.mode === "dynamic") return { ok: false, code: "UNAVAILABLE", message: this.capabilities().dynamicChecks.reason };
    try {
      return { ok: true, problems: checkProblems(request.project) };
    } catch (error) {
      return { ok: false, code: "FAILED", message: `Checks could not run: ${message(error)}` };
    }
  }

  async runAgent(): Promise<AgentOutcome> {
    return { ok: false, code: "NEEDS_DESKTOP", message: NEEDS_DESKTOP };
  }

  async confirm(text: string): Promise<boolean> {
    return window.confirm(text);
  }

  guardClose(isDirty: () => boolean): void {
    window.addEventListener("beforeunload", (event) => {
      if (isDirty()) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
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
