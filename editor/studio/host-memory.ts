// editor/studio/host-memory.ts — a StudioHost with no browser underneath:
// files, folders, storage and exports are maps in memory. Tests drive Studio's
// document flow through it, and it shows what a host must provide.

import {
  available,
  NEEDS_DESKTOP,
  unavailable,
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
} from "./host.ts";
import { MAX_PACK_BYTES, openFileProblem, PNG_HEADER_BYTES, pngProblem, utf8Bytes } from "../api/limits.ts";
import { checkProblems } from "./problems.ts";
import { isStagingPath, openDirectoryProject, saveDirectoryTarget, type ProjectDirectory } from "./project-directory.ts";
import type {
  PreviewArtImage,
  PreviewArtMessage,
  PreviewArtResult,
  PreviewChapter,
  PreviewLoadResult,
  PreviewOutcome,
  PreviewStartResult,
  PreviewStateResult,
  PreviewTarget,
  StudioPreview,
} from "./preview.ts";
import type { Project } from "../../src/engine/types.ts";
import { parsePreviewArt, PreviewArtStage, PreviewError } from "../../tools/preview/protocol.ts";

type OpenListener = (opened: OpenedProject | { error: string }) => void;

/** A fault MemoryDirectory injects: the matching call throws instead of
 * touching the file. */
export interface DirectoryFault {
  op: "write" | "rename" | "remove";
  /** The path to fail (for rename, the target `to`), or a test on it;
   * omitted = any path. */
  path?: string | ((path: string) => boolean);
  /** Fail only the nth matching call, counting from 1; omitted = every one. */
  nth?: number;
  /** The thrown error's message (default "injected <op> failure"). */
  message?: string;
}

/** A stand-in game for play-test tests: records every request and answers
 * like the preview host, without an engine. */
export class MemoryPreview implements StudioPreview {
  /** Requests in order, e.g. "connect:playtest-screen", "start:village:9:7:up". */
  calls: string[] = [];
  /** Document texts handed to load(). */
  loaded: string[] = [];
  chapters: (readonly PreviewChapter[])[] = [];
  /** Make the next request of this type fail with this code and message. */
  failNext: { type: string; code: string; message: string } | null = null;
  connected = false;
  /** What the page's ready event lists in `features` (set ["art"] to take
   * project art). */
  pageFeatures: string[] = [];
  /** The complete images each `load` with art used. */
  loadedArt: PreviewArtImage[][] = [];
  /** Staged like the preview host stages `art` requests. */
  private staging = new PreviewArtStage();
  private position: PreviewStartResult | null = null;
  private frame = 0;
  private releaseListeners = new Set<() => void>();

  private failure(type: string): PreviewOutcome<never> | null {
    const fail = this.failNext;
    if (!fail || fail.type !== type) return null;
    this.failNext = null;
    return { ok: false, code: fail.code, message: fail.message };
  }

  async connect(slotId: string): Promise<PreviewOutcome<void>> {
    this.calls.push(`connect:${slotId}`);
    const failed = this.failure("connect");
    if (failed) return failed;
    this.connected = true;
    return { ok: true, value: undefined };
  }

  features(): readonly string[] {
    return this.connected ? this.pageFeatures : [];
  }

  async sendArt(message: PreviewArtMessage): Promise<PreviewOutcome<PreviewArtResult>> {
    this.calls.push(`art:${message.kind}:${message.id}:${message.offset}`);
    if (!this.connected) return { ok: false, code: "disconnected", message: "not connected" };
    const failed = this.failure("art");
    if (failed) return failed;
    try {
      return { ok: true, value: this.staging.add(parsePreviewArt({ ...message })) };
    } catch (error) {
      return { ok: false, code: error instanceof PreviewError ? error.code : "internal", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async load(documentText: string, chapters: readonly PreviewChapter[], options?: { art?: boolean }): Promise<PreviewOutcome<PreviewLoadResult>> {
    this.calls.push(options?.art ? "load:art" : "load");
    if (!this.connected) return { ok: false, code: "disconnected", message: "not connected" };
    const images = options?.art ? this.staging.take() : [];
    this.staging.clear();
    const failed = this.failure("load");
    if (failed) return failed;
    this.loaded.push(documentText);
    this.chapters.push(chapters);
    if (options?.art) this.loadedArt.push(images);
    const project = JSON.parse(documentText) as Project;
    return {
      ok: true,
      value: {
        title: project.title,
        maps: project.maps.map((map) => ({ id: map.id, name: map.name ?? map.id, width: map.width, height: map.height })),
        start: { map: project.start.map, x: project.start.x, y: project.start.y, dir: project.start.dir },
        ...(options?.art ? { art: { used: images.length, skipped: [] } } : {}),
      },
    };
  }

  async start(target: PreviewTarget): Promise<PreviewOutcome<PreviewStartResult>> {
    this.calls.push(target.kind === "chapter" ? `start:chapter:${target.chapter}` : `start:${target.map}:${target.x}:${target.y}:${target.dir ?? "-"}`);
    const failed = this.failure("start");
    if (failed) return failed;
    this.frame = 0;
    this.position = target.kind === "chapter" ? { map: target.chapter, x: 0, y: 0, dir: "down" } : { map: target.map, x: target.x, y: target.y, dir: target.dir ?? "down" };
    return { ok: true, value: this.position };
  }

  async state(): Promise<PreviewOutcome<PreviewStateResult>> {
    this.calls.push("state");
    const failed = this.failure("state");
    if (failed) return failed;
    const at = this.position;
    if (!at) return { ok: false, code: "not-loaded", message: "no project is loaded" };
    this.frame += 15;
    return {
      ok: true,
      value: {
        status: "running", map: at.map, x: at.x, y: at.y, px: at.x * 16, py: at.y * 16, dir: at.dir, moving: false,
        frame: this.frame, running: 0, event: null, message: null, switches: {}, variables: {}, gold: 0, items: {},
      },
    };
  }

  async stop(): Promise<PreviewOutcome<void>> {
    this.calls.push("stop");
    const failed = this.failure("stop");
    if (failed) return failed;
    this.staging.clear();
    this.position = null;
    return { ok: true, value: undefined };
  }

  focusGame(): void {
    this.calls.push("focus");
  }

  onRelease(listener: () => void): () => void {
    this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  /** The user pressed Esc in the game. */
  release(): void {
    for (const listener of this.releaseListeners) listener();
  }

  disconnect(): void {
    this.calls.push("disconnect");
    this.connected = false;
    this.position = null;
  }
}

/** A ProjectDirectory over a Map of POSIX paths to text, plus binary files
 * (art) in `binary`. */
export class MemoryDirectory implements ProjectDirectory {
  readonly files: Map<string, string>;
  /** Binary files by path; readBytes also reads text files as UTF-8. */
  readonly binary = new Map<string, Uint8Array>();
  /** Paths whose bytes a write or rename replaced or created, in order.
   * Temporary files staged by a save (isStagingPath) are left out. */
  writes: string[] = [];
  /** Faults to inject; tests push to and clear this. */
  faults: DirectoryFault[] = [];
  /** Paths read, in order (tests check oversized files are never read). */
  reads: string[] = [];
  /** Sizes to report instead of a file's UTF-8 bytes, so tests can model
   * huge files without allocating them. */
  sizes = new Map<string, number>();
  /** Every read, write, rename (logged by its target) and remove, in
   * order, as "op path", including staged temporaries. */
  log: string[] = [];
  /** Called before each logged operation touches anything; a test returns a
   * promise to hold the call there until it chooses to let it go on. */
  gate: ((op: "read" | "write" | "rename" | "remove", path: string) => Promise<void> | void) | null = null;
  readonly rename?: (from: string, to: string) => Promise<void>;
  private seen = new Map<DirectoryFault, number>();

  /** `rename: false` models a host that cannot move files. */
  constructor(readonly name: string, files: Record<string, string> | Map<string, string>, options: { rename?: boolean } = {}) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
    if (options.rename !== false) this.rename = (from, to) => this.move(from, to);
  }

  private inject(op: DirectoryFault["op"], path: string): void {
    for (const fault of this.faults) {
      if (fault.op !== op) continue;
      if (fault.path !== undefined && (typeof fault.path === "string" ? fault.path !== path : !fault.path(path))) continue;
      const count = (this.seen.get(fault) ?? 0) + 1;
      this.seen.set(fault, count);
      if (fault.nth === undefined || fault.nth === count) throw new Error(fault.message ?? `injected ${op} failure`);
    }
  }

  async listRoot(): Promise<string[]> {
    return [...this.files.keys(), ...this.binary.keys()].filter((path) => !path.includes("/"));
  }

  private async pass(op: "read" | "write" | "rename" | "remove", path: string): Promise<void> {
    this.log.push(`${op} ${path}`);
    await this.gate?.(op, path);
  }

  async read(path: string): Promise<string> {
    await this.pass("read", path);
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`no file ${path}`);
    this.reads.push(path);
    return text;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    await this.pass("read", path);
    const bytes = this.binary.get(path) ?? (this.files.has(path) ? new TextEncoder().encode(this.files.get(path)!) : undefined);
    if (bytes === undefined) throw new Error(`no file ${path}`);
    this.reads.push(path);
    return bytes.slice();
  }

  async size(path: string): Promise<number> {
    const bytes = this.binary.get(path);
    const text = this.files.get(path);
    if (bytes === undefined && text === undefined) throw new Error(`no file ${path}`);
    return this.sizes.get(path) ?? bytes?.length ?? utf8Bytes(text!);
  }

  async write(path: string, text: string): Promise<void> {
    await this.pass("write", path);
    this.inject("write", path);
    this.files.set(path, text);
    if (!isStagingPath(path)) this.writes.push(path);
  }

  async remove(path: string): Promise<void> {
    await this.pass("remove", path);
    this.inject("remove", path);
    if (!this.files.delete(path)) throw new Error(`no file ${path}`);
  }

  private async move(from: string, to: string): Promise<void> {
    await this.pass("rename", to);
    this.inject("rename", to);
    const text = this.files.get(from);
    if (text === undefined) throw new Error(`no file ${from}`);
    this.files.set(to, text);
    this.files.delete(from);
    if (!isStagingPath(to)) this.writes.push(to);
  }
}

export class MemoryHost implements StudioHost {
  readonly name = "memory";
  /** Files the next pickProjectFile() call "chooses", in order. `size`
   * stands in for the file's byte size (default: the text's UTF-8 bytes), so
   * tests can pick an oversized file without building one. */
  filePicks: { name: string; text: string; size?: number }[] = [];
  /** Directories the next pickProjectDirectory() call "chooses". */
  directoryPicks: MemoryDirectory[] = [];
  /** Images the next pickImage() call "chooses": the file's bytes (at least
   * its PNG header) and, optionally, a byte size standing in for the file's. */
  imagePicks: { name: string; bytes: Uint8Array; size?: number }[] = [];
  examples: StudioExample[] = [];
  exampleTexts = new Map<string, string>();
  stored: StoredProject | null = null;
  exports: { fileName: string; text: string }[] = [];
  /** Answer for confirm(); every question is recorded. */
  confirmAnswer = true;
  questions: string[] = [];
  themeChoice: ThemeChoice = "system";
  studioPreferences: StudioPreferences = normalizeStudioPreferences(null);
  dark = false;
  reducedMotion = false;
  storageFails = false;
  /** Answers agent runs when set (and makes the "agent" feature available);
   * unset, runs answer NEEDS_DESKTOP like the browser host. */
  agentReply: ((request: AgentRequest) => Promise<AgentOutcome>) | null = null;
  /** Every agent request received, in order. */
  agentRequests: AgentRequest[] = [];
  /** Answers RPG Maker imports when set (and makes the feature available).
   * Tests use `progress` to drive the same tokenized events as browser and
   * desktop hosts. */
  rpgMakerImportReply: ((request: RpgMakerImportRequest, progress: (event: RpgMakerImportProgress) => void) => Promise<RpgMakerImportOutcome>) | null = null;
  rpgMakerImportRequests: RpgMakerImportRequest[] = [];
  rpgMakerImportCancels: string[] = [];
  private listeners = new Set<OpenListener>();
  private rpgMakerImportListeners = new Set<(progress: RpgMakerImportProgress) => void>();
  private themeListeners = new Set<() => void>();
  private motionListeners = new Set<() => void>();

  capabilities(): HostCapabilities {
    return {
      openFile: available("Files come from MemoryHost.filePicks."),
      openDirectory: available("Folders come from MemoryHost.directoryPicks."),
      rpgMakerImport: this.rpgMakerImportReply
        ? available("RPG Maker imports are answered by MemoryHost.rpgMakerImportReply.")
        : unavailable("No RPG Maker import reply is configured in this memory host."),
      saveInPlace: available("Folders save back into their MemoryDirectory."),
      storage: this.storageFails ? unavailable("Storage is switched off.") : available("One document in MemoryHost.stored."),
      export: available("Exports collect in MemoryHost.exports."),
      localArt: available("Images come from MemoryHost.imagePicks."),
      checks: available("rpgkit-check's static lint, in-process."),
      dynamicChecks: unavailable("Not run in tests."),
      agent: this.agentReply ? available("Agent runs are answered by MemoryHost.agentReply.") : unavailable(NEEDS_DESKTOP),
      preview: this.playTest ? available("Play-tests run on MemoryHost.playTest.") : unavailable("This host has no game to play-test in."),
    };
  }

  /** The stand-in game; set to null to model a host without play-testing. */
  playTest: MemoryPreview | null = new MemoryPreview();

  preview(): MemoryPreview | null {
    return this.playTest;
  }

  onOpen(listener: OpenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(opened: OpenedProject | { error: string }): void {
    for (const listener of this.listeners) listener(opened);
  }

  pickProjectFile(): void {
    const file = this.filePicks.shift();
    if (!file) return;
    // Like a browser File: the size is known before the text is read.
    const problem = openFileProblem(file.size ?? utf8Bytes(file.text, MAX_PACK_BYTES), file.name);
    if (problem !== null) this.emit({ error: problem });
    else this.emit({ text: file.text, label: file.name, fileName: file.name });
  }

  async pickProjectDirectory(): Promise<void> {
    const dir = this.directoryPicks.shift();
    if (dir) this.emit(await openDirectoryProject(dir));
  }

  async importRpgMaker(request: RpgMakerImportRequest): Promise<RpgMakerImportOutcome> {
    this.rpgMakerImportRequests.push({ ...request });
    if (!this.rpgMakerImportReply) {
      return { ok: false, token: request.token, code: "IMPORT_FAILED", message: "RPG Maker import is not configured in this memory host." };
    }
    return this.rpgMakerImportReply(request, (progress) => {
      for (const listener of this.rpgMakerImportListeners) listener(progress);
    });
  }

  async cancelRpgMakerImport(token: string): Promise<void> {
    this.rpgMakerImportCancels.push(token);
  }

  onRpgMakerImportProgress(listener: (progress: RpgMakerImportProgress) => void): () => void {
    this.rpgMakerImportListeners.add(listener);
    return () => this.rpgMakerImportListeners.delete(listener);
  }

  async listExamples(): Promise<StudioExample[]> {
    return this.examples;
  }

  async readExample(example: StudioExample): Promise<string> {
    const text = this.exampleTexts.get(example.id);
    if (text === undefined) throw new Error(`no text for example ${example.id}`);
    return text;
  }

  async save(text: string, meta: { label: string; fileName: string }, target?: SaveTarget): Promise<SaveOutcome> {
    const savedAt = new Date(0).toISOString();
    if (target?.kind === "directory") return saveDirectoryTarget(target, text, savedAt);
    if (this.storageFails) return { ok: false, message: "Not saved: storage is switched off." };
    this.stored = { label: meta.label, fileName: meta.fileName, text, savedAt };
    return { ok: true, where: "storage", written: ["memory"], savedAt };
  }

  restore(): StoredProject | null {
    return this.stored;
  }

  async exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }> {
    this.exports.push({ fileName, text });
    return { ok: true, message: `Exported ${fileName}.` };
  }

  async pickImage(): Promise<LocalArt | { error: string } | null> {
    const image = this.imagePicks.shift();
    if (!image) return null;
    const problem = pngProblem(image.name, image.size ?? image.bytes.length, image.bytes.subarray(0, PNG_HEADER_BYTES));
    if (problem !== null) return { error: problem };
    return { name: image.name, url: `memory:${image.name}`, bytes: image.bytes, release: () => {} };
  }

  async runChecks(request: CheckRequest): Promise<CheckOutcome> {
    if (request.mode === "dynamic") return { ok: false, code: "UNAVAILABLE", message: "Not run in tests." };
    return { ok: true, problems: checkProblems(request.project) };
  }

  async runAgent(request?: AgentRequest): Promise<AgentOutcome> {
    if (request) this.agentRequests.push(request);
    if (!this.agentReply || !request) return { ok: false, code: "NEEDS_DESKTOP", message: NEEDS_DESKTOP };
    return this.agentReply(request);
  }

  /** Cancel requests received (the Agent panel's Cancel button). */
  agentCancels = 0;

  async cancelAgent(): Promise<void> {
    this.agentCancels++;
  }

  async confirm(text: string): Promise<boolean> {
    this.questions.push(text);
    return this.confirmAnswer;
  }

  guardClose(): void {}

  theme(): ThemeChoice {
    return this.themeChoice;
  }

  setTheme(choice: ThemeChoice): void {
    this.themeChoice = choice;
  }

  systemPrefersDark(): boolean {
    return this.dark;
  }

  /** Flip the "system" theme as an OS would. */
  setSystemDark(dark: boolean): void {
    this.dark = dark;
    for (const listener of this.themeListeners) listener();
  }

  onSystemThemeChange(listener: () => void): () => void {
    this.themeListeners.add(listener);
    return () => this.themeListeners.delete(listener);
  }

  preferences(): StudioPreferences {
    return normalizeStudioPreferences(this.studioPreferences);
  }

  setPreferences(preferences: StudioPreferences): void {
    this.studioPreferences = normalizeStudioPreferences(preferences);
  }

  systemPrefersReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /** Flip the reduced-motion media preference as an OS would. */
  setSystemReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    for (const listener of this.motionListeners) listener();
  }

  onSystemMotionChange(listener: () => void): () => void {
    this.motionListeners.add(listener);
    return () => this.motionListeners.delete(listener);
  }
}
