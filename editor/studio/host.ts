// editor/studio/host.ts — everything Studio needs from the place it runs.
//
// Studio's UI never touches storage, files, downloads, processes or the
// network itself; it asks a StudioHost. The web page uses the browser host
// (host-browser.ts). A desktop shell implements the same interface with
// native files and processes, and tests use the in-memory host
// (host-memory.ts). tests/studio-host.test.ts keeps browser APIs out of the
// rest of editor/studio/.
//
// The interface is plain data in, plain data out: no DOM types, so a host
// can sit on the far side of an IPC bridge.

import type { Project } from "../../src/engine/types.ts";
import type { LocalAgentEditorContext } from "../agent/types.ts";
import type { PreviewChapter, StudioPreview } from "./preview.ts";
import type { StudioProblem } from "./problems.ts";

// ---- capabilities ----------------------------------------------------------------

export type HostFeature =
  /** Open a project file (inline JSON or a sharded pack). */
  | "openFile"
  /** Open a directory holding a ProjectShell and its loose shard files. */
  | "openDirectory"
  /** Import an RPG Maker MV/MZ source folder into a Studio document. */
  | "rpgMakerImport"
  /** Save back to the file or directory a project was opened from. */
  | "saveInPlace"
  /** Keep one document in host storage and restore it on the next start. */
  | "storage"
  /** Hand the export bytes to the user as a file. */
  | "export"
  /** Pick local PNGs for tile sheets and characters. */
  | "localArt"
  /** Schema validation and rpgkit-check's static lint. */
  | "checks"
  /** rpgkit-check's dynamic checks, which run the game engine. */
  | "dynamicChecks"
  /** Start a local agent process that proposes edits. */
  | "agent"
  /** Play the open document in the real game engine (rpgkit-preview/v1). */
  | "preview";

export interface FeatureStatus {
  available: boolean;
  /** One sentence for tooltips and notices: what it does here, or why not. */
  reason: string;
}

export type HostCapabilities = Record<HostFeature, FeatureStatus>;

// ---- documents ---------------------------------------------------------------------

/** Where a document can be saved back to. Opaque outside its host. */
export interface SaveTarget {
  kind: "file" | "directory";
  /** Shown to the user, e.g. "sunstone/" or "village.json". */
  name: string;
  /** Host-private reference (handle, path); never inspected by the UI. */
  ref: unknown;
}

/** A document the user opened through the host. */
export interface OpenedProject {
  /** Inline project JSON or a sharded pack. */
  text: string;
  /** Shown in notices and the window title. */
  label: string;
  /** Suggested export file name. */
  fileName: string;
  /** Set when the host can save the document where it came from. */
  target?: SaveTarget;
  /** Short remarks about the open worth showing the user, such as how much
   * of a folder's art was found. */
  notes?: string[];
}

export interface StoredProject {
  label: string;
  fileName: string;
  text: string;
  savedAt: string;
}

export type SaveOutcome =
  | { ok: true; where: "storage" | "file" | "directory"; written: string[]; savedAt: string }
  | { ok: false; message: string };

export interface StudioExample {
  id: string;
  title: string;
  document: string;
  kind?: "inline" | "pack";
  sheets: Record<string, string>;
  sprites: Record<string, string>;
  player?: string;
  /** Save points a play-test can start from, for documents with this
   * example's title. */
  chapters?: PreviewChapter[];
}

// ---- RPG Maker import --------------------------------------------------------------

/** Importer vocabulary is kept in its original title case so coverage from
 * tools/rpgmaker-import can cross browser and desktop host boundaries without
 * translation or loss. */
export type RpgMakerImportDisposition = "Native" | "Degraded" | "Placeholder" | "Dropped";

export interface RpgMakerImportCounts extends Record<RpgMakerImportDisposition, number> {
  total: number;
}

/** One source construct from the importer's coverage report. `section` and
 * `key` are intentionally strings: adding an importer section must not break
 * an older Studio host. */
export interface RpgMakerImportCoverageRow {
  section: string;
  key: string;
  counts: Record<RpgMakerImportDisposition, number>;
  /** Distinct importer explanations, in stable first-seen order. */
  reasons: string[];
}

export interface RpgMakerImportCoverage {
  /** Event-command headline counts, matching the importer's CLI summary. */
  totals: RpgMakerImportCounts;
  /** Exact rows used by the Placeholder / Dropped reason list in Studio.
   * Hosts must include every row with either of those dispositions and may
   * include Native/Degraded-only rows when payload size is not a concern. */
  rows: RpgMakerImportCoverageRow[];
}

export interface RpgMakerImportRequest {
  /** Chosen by Studio. Progress and cancellation carry the same token so a
   * late IPC event from an abandoned run cannot update a newer dialog. */
  token: string;
  /** Visible placeholders make unsupported script/plugin commands apparent
   * in play; silent placeholders omit their text but retain coverage. */
  placeholders: "visible" | "silent";
}

export type RpgMakerImportPhase =
  | "selecting"
  | "reading"
  | "converting"
  | "packing"
  | "writing"
  | "complete";

export interface RpgMakerImportProgress {
  token: string;
  phase: RpgMakerImportPhase;
  /** Host detail such as the file or output folder currently handled. */
  message?: string;
  /** Optional determinate progress. Omit both for a busy indicator. */
  completed?: number;
  total?: number;
}

export type RpgMakerImportOutcome =
  | {
      ok: true;
      token: string;
      /** The result is staged until the user explicitly chooses Open result.
       * Browser hosts normally return an in-memory pack without a target;
       * desktop hosts return a directory-backed document. */
      opened: OpenedProject;
      coverage: RpgMakerImportCoverage;
      warnings: string[];
    }
  | {
      ok: false;
      token: string;
      code: "CANCELLED" | "BUSY" | "INVALID_SOURCE" | "IMPORT_FAILED";
      /** A readable, host-specific explanation. Studio shows it verbatim. */
      message: string;
    };

// ---- art, checks, agent ------------------------------------------------------------

/** A local image the user picked. `url` is drawable until release(); `bytes`
 * contain the original PNG so Studio can import it through the edit API. */
export interface LocalArt {
  name: string;
  url: string;
  bytes: Uint8Array;
  release(): void;
}

export interface CheckRequest {
  /** Inline project to check; packs are checked shard by shard elsewhere. */
  project: Project;
  /** "lint" runs the static checks; "dynamic" also runs the engine. */
  mode: "lint" | "dynamic";
}

export type CheckOutcome =
  | { ok: true; problems: StudioProblem[] }
  | { ok: false; code: "UNAVAILABLE" | "FAILED"; message: string };

export interface AgentRequest {
  /** What the user asked for, in their words. */
  prompt: string;
  /** Current export bytes the agent should work from. */
  projectText: string;
  /** The open map and what is selected on it, so "here" and "this NPC" in
   * the prompt have a meaning. */
  context?: LocalAgentEditorContext;
}

export type AgentOutcome =
  | { ok: true; proposals: string[] }
  | { ok: false; code: "NEEDS_DESKTOP" | "FAILED"; message: string };

// ---- preferences -------------------------------------------------------------------

export type ThemeChoice = "system" | "light" | "dark";
export type MotionChoice = "system" | "full" | "reduced";

/** Small, project-independent UI preferences. Project bytes and edit history
 * never contain these values. Hosts may persist them, but must tolerate an
 * unavailable or corrupt preference store. */
export interface StudioPreferences {
  motion: MotionChoice;
  favoriteTiles: string[];
  recentCommands: string[];
}

export const DEFAULT_STUDIO_PREFERENCES: Readonly<StudioPreferences> = {
  motion: "system",
  favoriteTiles: [],
  recentCommands: [],
};

export const STUDIO_PREFERENCES_KEY = "pocket-rpgkit:studio:preferences:v1";

/** Keep persisted preferences small and turn arbitrary storage bytes into a
 * complete value. */
export function normalizeStudioPreferences(value: unknown): StudioPreferences {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const strings = (item: unknown, limit: number): string[] => Array.isArray(item)
    ? [...new Set(item.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 160))].slice(0, limit)
    : [];
  const motion = raw.motion === "full" || raw.motion === "reduced" ? raw.motion : "system";
  return { motion, favoriteTiles: strings(raw.favoriteTiles, 48), recentCommands: strings(raw.recentCommands, 24) };
}

/** Commands from a host's own menus (the desktop app's menu bar). Studio
 * carries them out, since it owns the document and its history. */
export type HostCommand =
  | "open-file" | "open-folder" | "save" | "export"
  | "undo" | "redo"
  | "problems" | "engine-checks" | "agent" | "playtest" | "theme" | "shortcuts";

// ---- the host ----------------------------------------------------------------------

export interface StudioHost {
  /** "browser", "memory", "desktop"… for diagnostics. */
  readonly name: string;
  capabilities(): HostCapabilities;

  /** Show the host's file picker. The pick arrives through onOpen(). */
  pickProjectFile(): void;
  /** Show the host's directory picker. The pick arrives through onOpen(). */
  pickProjectDirectory(): Promise<void>;
  /** Documents opened by a picker, a drop, an OS "open with"… Errors (an
   * unreadable file, a directory without a shell) arrive as `error`. */
  onOpen(listener: (opened: OpenedProject | { error: string }) => void): () => void;

  /** Pick an RPG Maker MV/MZ source folder and import it. Unlike ordinary
   * open pickers, the result is returned and remains staged until Studio
   * explicitly opens it. Desktop hosts may ask for a destination after the
   * source and must not overwrite an existing output directory. */
  importRpgMaker(request: RpgMakerImportRequest): Promise<RpgMakerImportOutcome>;
  /** Ask the host to stop a run. Cancellation may be cooperative; Studio
   * invalidates the token immediately and ignores late progress or results. */
  cancelRpgMakerImport(token: string): Promise<void>;
  /** Progress for all runs on this host. Consumers must match `token`. */
  onRpgMakerImportProgress(listener: (progress: RpgMakerImportProgress) => void): () => void;

  /** Bundled examples, then one example's document text. */
  listExamples(): Promise<StudioExample[]>;
  readExample(example: StudioExample): Promise<string>;

  /** Save the export bytes: in place when `target` is given, else in storage. */
  save(text: string, meta: { label: string; fileName: string }, target?: SaveTarget): Promise<SaveOutcome>;
  /** The document last saved in storage, if any. */
  restore(): StoredProject | null;
  /** Hand the export bytes to the user as a file. */
  exportFile(fileName: string, text: string): Promise<{ ok: boolean; message: string }>;

  /** Pick a local PNG; null when cancelled, `error` (shown to the user) when
   * the file is not a PNG or exceeds the limits in editor/api/limits.ts. */
  pickImage(): Promise<LocalArt | { error: string } | null>;

  runChecks(request: CheckRequest): Promise<CheckOutcome>;
  runAgent(request: AgentRequest): Promise<AgentOutcome>;

  /** The play-test connection (preview.ts), or null when the "preview"
   * capability is unavailable. One per host; the UI shows it in a panel. */
  preview(): StudioPreview | null;

  /** Ask before a destructive step (discarding edits). */
  confirm(message: string): Promise<boolean>;
  /** Called with a probe; the host warns before closing while it is true. */
  guardClose(isDirty: () => boolean): void;

  /** Optional: commands from the host's menus. */
  onCommand?(listener: (command: HostCommand) => void): () => void;
  /** Optional: documents the OS handed over before Studio started (command
   * line, "Open With"); Studio opens them instead of the stored document. */
  initialDocuments?(): (OpenedProject | { error: string })[];
  /** Optional: stop the running agent request. */
  cancelAgent?(): Promise<void>;

  theme(): ThemeChoice;
  setTheme(choice: ThemeChoice): void;
  systemPrefersDark(): boolean;
  onSystemThemeChange(listener: () => void): () => void;

  preferences(): StudioPreferences;
  setPreferences(preferences: StudioPreferences): void;
  systemPrefersReducedMotion(): boolean;
  onSystemMotionChange(listener: () => void): () => void;
}

/** Shared by hosts that run rpgkit-check in-process. */
export function unavailable(reason: string): FeatureStatus {
  return { available: false, reason };
}

export function available(reason: string): FeatureStatus {
  return { available: true, reason };
}

export const NEEDS_DESKTOP = "Local agents run as processes on your computer; this needs the desktop app.";
