// editor/studio/files.ts — opening, saving and exporting documents through
// the StudioHost. The host decides where bytes go (browser storage, a folder,
// a download); this file decides when, validates first, and reports the
// outcome. It has no DOM dependency, so tests run it on the memory host.

import { EditSession } from "../api/session.ts";
import type { StudioApp } from "./app.ts";
import type { ArtRegistry } from "./art.ts";
import type {
  OpenedProject,
  RpgMakerImportOutcome,
  RpgMakerImportProgress,
  SaveTarget,
  StudioExample,
  StudioHost,
} from "./host.ts";
import { projectArtRefs, resolveProjectArt } from "./project-art.ts";
import { flattenCommands } from "../engine/commands.ts";

export type { StudioExample } from "./host.ts";

/** What one save writes, fixed when Save is pressed. */
interface SaveJob {
  session: EditSession;
  target: SaveTarget | null;
  fileName: string;
  label: string;
}

export class StudioFiles {
  examples: StudioExample[] = [];
  /** Download file name for the open document. */
  fileName = "project.json";
  lastSavedAt: string | null = null;
  /** Where the last save went: "storage", "file" or "directory". */
  lastSavedWhere: "storage" | "file" | "directory" | null = null;
  /** Set when the open document saves back where it came from. */
  target: SaveTarget | null = null;
  /** Saves started and not yet finished (running or queued). The UI shows
   * "Saving…" and disables Save while this is above zero. */
  saving = 0;
  /** The folder the running save writes into: the document's when Save was
   * pressed, which need not be the one open now. Null for storage saves. */
  savingTo: string | null = null;
  private saveQueue: Promise<unknown> = Promise.resolve();
  private importSequence = 0;
  private activeImportToken: string | null = null;
  private stopImportProgress: (() => void) | null = null;
  /** Resource ids drawn with the open document's own art. */
  projectArt = 0;

  constructor(private app: StudioApp, private art: ArtRegistry, readonly host: StudioHost) {
    host.onOpen((opened) => void this.opened(opened));
    // A pack parses its next shard while Studio switches maps. Refresh that
    // map's local art afterward without forcing any unopened shard.
    app.on((reason) => {
      if (reason === "map" || reason === "edit" || reason === "history") this.projectArt = this.attachArt();
    });
  }

  async loadExamples(): Promise<void> {
    try {
      this.examples = await this.host.listExamples();
    } catch (error) {
      this.app.notify("error", `Bundled examples are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Load art for every sheet, sprite, animation and parallax id the document uses: the
   * project's own PNGs when it carries them (a folder, or a pack with
   * assets; see project-art.ts), else what a bundled example provides for
   * that id (art is keyed by id, as in the PocketJS editor). Returns how
   * many ids got project art. */
  private attachArt(): number {
    const session = this.app.session;
    if (!session) return 0;
    this.art.clear();
    const assets = session.assets();
    const project = {
      sheets: new Set<string>(),
      sprites: new Set<string>(),
      animations: new Set<string>(),
      parallaxes: new Set<string>(),
    };
    const globals = session.globals();
    const animations = new Map((globals.animations ?? []).map((animation) => [animation.id, animation]));
    const parallaxIds = new Set<string>();
    const collectParallaxCommands = (commands: Parameters<typeof flattenCommands>[0]): void => {
      for (const { command } of flattenCommands(commands)) {
        if (command.op === "changeParallax" && command.image) parallaxIds.add(command.image);
      }
    };
    const loaded = session.kind === "pack" ? new Set(session.loadedEntries()) : null;
    for (const { id, entry } of session.maps()) {
      // A sharded shell contains no map-local parallax or event commands.
      // Reading an unopened map here would defeat Studio's lazy contract.
      if (loaded && entry && !loaded.has(entry)) continue;
      const map = session.map(id);
      if (map?.parallax?.image) parallaxIds.add(map.parallax.image);
      for (const event of map?.events ?? []) for (const page of event.pages) collectParallaxCommands(page.commands);
    }
    for (const common of globals.commonEvents ?? []) collectParallaxCommands(common.commands);
    const parallaxes = [...parallaxIds];
    if (assets.size > 0) {
      const refs = projectArtRefs({
        sheets: session.sheets(),
        sprites: session.sprites(),
        animations: globals.animations,
        parallaxes,
      });
      for (const { ref, path } of resolveProjectArt(refs, (candidate) => assets.has(candidate))) {
        const url = `data:image/png;base64,${assets.get(path)!.data}`;
        if (ref.kind === "sheet") {
          project.sheets.add(ref.id);
          void this.art.loadProjectSheet(ref.id, path, url);
        } else if (ref.kind === "sprite") {
          project.sprites.add(ref.id);
          void this.art.loadProjectSprite(ref.id, path, url);
        } else if (ref.kind === "animation") {
          project.animations.add(ref.id);
          // Placement is render-only metadata in cooked asset producers.
          // Accept it when present without making it part of the project
          // schema; ordinary AnimationDef values simply omit it.
          const def = animations.get(ref.id) as ({ offsetX?: number; offsetY?: number } | undefined);
          void this.art.loadProjectAnimation(ref.id, path, url, {
            ...(def?.offsetX === undefined ? {} : { offsetX: def.offsetX }),
            ...(def?.offsetY === undefined ? {} : { offsetY: def.offsetY }),
          });
        } else {
          project.parallaxes.add(ref.id);
          void this.art.loadProjectParallax(ref.id, path, url);
        }
      }
    }
    const sheets = new Map<string, string>();
    const sprites = new Map<string, string>();
    for (const example of this.examples) {
      for (const [id, url] of Object.entries(example.sheets)) if (!sheets.has(id)) sheets.set(id, url);
      for (const [id, url] of Object.entries(example.sprites)) if (!sprites.has(id)) sprites.set(id, url);
    }
    for (const sheet of session.sheets()) {
      const url = sheets.get(sheet.id);
      if (url && !project.sheets.has(sheet.id)) void this.art.loadBundledSheet(sheet.id, url);
    }
    for (const id of Object.keys(session.sprites())) {
      const url = sprites.get(id);
      if (url && !project.sprites.has(id)) void this.art.loadBundledSprite(id, url);
    }
    return project.sheets.size + project.sprites.size + project.animations.size + project.parallaxes.size;
  }

  /** Open document text; returns false (with a visible error) if invalid. */
  openText(text: string, label: string, fileName: string, target: SaveTarget | null = null): boolean {
    let session: EditSession;
    try {
      session = EditSession.open(text);
    } catch (error) {
      const details = (error as { details?: { path: string; msg: string }[] }).details;
      const first = Array.isArray(details) && details[0] ? ` (${details[0].path}: ${details[0].msg})` : "";
      this.app.notify("error", `Could not open ${label}: ${error instanceof Error ? error.message : String(error)}${first}`);
      return false;
    }
    this.fileName = fileName;
    this.target = target;
    this.lastSavedAt = null;
    this.lastSavedWhere = null;
    this.app.load(session, { label, savesTo: target ? target.name : "storage" });
    this.projectArt = this.attachArt();
    return true;
  }

  /** A document picked through the host (file, folder, drop…). */
  async opened(opened: OpenedProject | { error: string }): Promise<boolean> {
    if ("error" in opened) {
      this.app.notify("error", opened.error);
      return false;
    }
    if (!(await this.confirmDiscard())) return false;
    return this.openPickedProject(opened);
  }

  /** Open a host result after discard has already been confirmed. This is
   * shared by ordinary picks and the explicit second step of RPG Maker
   * import, so completing an expensive import never triggers a second
   * confirmation prompt. */
  private openPickedProject(opened: OpenedProject): boolean {
    const ok = this.openText(opened.text, opened.label, opened.fileName, opened.target ?? null);
    if (ok) {
      const kind = this.app.session?.kind === "pack" ? "sharded pack" : "project";
      const where = opened.target ? ` Save writes back into ${opened.target.name}.` : "";
      const art = this.projectArt > 0 ? ` Using the project's own art for ${this.projectArt} resource id${this.projectArt === 1 ? "" : "s"}.` : "";
      this.app.notify("info", `Opened ${kind} ${opened.label}.${where}${art}`);
      for (const note of opened.notes ?? []) this.app.notify("info", note);
    }
    return ok;
  }

  openFile(): void {
    this.host.pickProjectFile();
  }

  async openDirectory(): Promise<void> {
    const status = this.host.capabilities().openDirectory;
    if (!status.available) {
      this.app.notify("error", status.reason);
      return;
    }
    await this.host.pickProjectDirectory();
  }

  /** Pick and convert an RPG Maker MV/MZ folder without opening the result.
   * The caller shows progress/coverage, then calls openRpgMakerResult only
   * after the user chooses the explicit Open result action. */
  async importRpgMaker(
    placeholders: "visible" | "silent",
    onProgress: (progress: RpgMakerImportProgress) => void,
    discardMessage = "The open document has unsaved changes. Discard them?",
  ): Promise<RpgMakerImportOutcome | null> {
    const status = this.host.capabilities().rpgMakerImport;
    if (!status.available) {
      this.app.notify("error", status.reason);
      return null;
    }
    if (this.activeImportToken) {
      return { ok: false, token: this.activeImportToken, code: "BUSY", message: "An RPG Maker import is already running." };
    }
    if (!(await this.confirmDiscard(discardMessage))) return null;

    const token = `studio-rpgmaker-${++this.importSequence}`;
    this.activeImportToken = token;
    const stopProgress = this.host.onRpgMakerImportProgress((progress) => {
      if (progress.token === token && this.activeImportToken === token) onProgress(progress);
    });
    this.stopImportProgress = stopProgress;
    let outcome: RpgMakerImportOutcome;
    try {
      outcome = await this.host.importRpgMaker({ token, placeholders });
    } catch (error) {
      outcome = {
        ok: false,
        token,
        code: "IMPORT_FAILED",
        message: `The host could not import this RPG Maker project: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      stopProgress();
      if (this.stopImportProgress === stopProgress) this.stopImportProgress = null;
    }

    // cancelRpgMakerImport invalidates first; a host may finish before it
    // reaches its next cooperative cancellation checkpoint.
    if (this.activeImportToken !== token) {
      return { ok: false, token, code: "CANCELLED", message: "RPG Maker import cancelled." };
    }
    this.activeImportToken = null;
    if (outcome.token !== token) {
      return { ok: false, token, code: "IMPORT_FAILED", message: "The host returned an RPG Maker import result for the wrong request." };
    }
    return outcome;
  }

  /** Immediately detach the UI from a running import, then ask the host to
   * stop it. Late events/results carry the invalidated token and are ignored. */
  async cancelRpgMakerImport(): Promise<void> {
    const token = this.activeImportToken;
    if (!token) return;
    this.activeImportToken = null;
    this.stopImportProgress?.();
    this.stopImportProgress = null;
    try {
      await this.host.cancelRpgMakerImport(token);
    } catch (error) {
      this.app.notify("error", `Could not cancel RPG Maker import: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The deliberate second half of import: coverage has been reviewed and
   * the user chose to replace the current document with the staged result. */
  openRpgMakerResult(outcome: RpgMakerImportOutcome): boolean {
    return outcome.ok ? this.openPickedProject(outcome.opened) : false;
  }

  async openExample(id: string): Promise<boolean> {
    const example = this.examples.find((item) => item.id === id);
    if (!example) {
      this.app.notify("error", `Unknown example ${id}`);
      return false;
    }
    if (!(await this.confirmDiscard())) return false;
    try {
      const text = await this.host.readExample(example);
      const ok = this.openText(text, example.title, example.document.split("/").pop() ?? `${id}.json`);
      if (ok) this.app.notify("info", `Opened ${example.title}. Edits stay here until you save or download.`);
      return ok;
    } catch (error) {
      this.app.notify("error", `Could not load ${example.title}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async confirmDiscard(message = "The open document has unsaved changes. Discard them?"): Promise<boolean> {
    if (!this.app.session?.isDirty()) return true;
    return this.host.confirm(message);
  }

  /** Validate, then save: into the folder it came from, else host storage.
   * A save started while another is running waits for it, then saves the
   * document as it is by then (Ctrl/Cmd+S pressed twice saves twice, in
   * order, never at the same time). A save belongs to the document open
   * when it was started: if another document is opened meanwhile, the save
   * still writes the first one and reports it by name, and the newly open
   * document's saved state is left alone. */
  save(): Promise<boolean> {
    const session = this.app.session;
    const job: SaveJob | null = session
      ? { session, target: this.target, fileName: this.fileName, label: this.app.origin?.label ?? session.title() }
      : null;
    this.saving += 1;
    if (this.saving === 1) this.app.emit("saving");
    const run = this.saveQueue.then(() => (job ? this.saveNow(job) : false));
    this.saveQueue = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.saving -= 1;
      if (this.saving === 0) {
        this.savingTo = null;
        this.app.emit("saving");
      }
    });
  }

  /** Whether `job`'s document is still the one open. Reopening the same
   * folder makes a new session and target, so it does not count. */
  private isOpen(job: SaveJob): boolean {
    return this.app.session === job.session && this.target === job.target;
  }

  private async saveNow(job: SaveJob): Promise<boolean> {
    const { session, target } = job;
    const name = target?.name ?? null;
    this.savingTo = name;
    const problems = session.validate();
    if (problems.length > 0) {
      if (this.isOpen(job)) {
        this.app.problems = problems;
        this.app.emit("problems");
      }
      this.app.notify("error", `Not saved${name ? ` to ${name}` : ""}: the document has ${problems.length} validation problem${problems.length === 1 ? "" : "s"}.`);
      return false;
    }
    // Directory saves currently write the shell and shards, but not pack assets.
    // Never acknowledge an imported PNG as saved when its bytes would be lost.
    if (target?.kind === "directory" && session.assetsDirty()) {
      this.app.notify("error", "Not saved: folder saves cannot write imported PNG art. Export a self-contained project pack instead.");
      return false;
    }
    const text = session.exportText();
    const outcome = await this.host.save(text, { label: job.label, fileName: job.fileName }, target ?? undefined);
    if (!outcome.ok) {
      this.app.notify("error", outcome.message);
      return false;
    }
    // Edits made while an asynchronous save was writing stay unsaved.
    if (session.exportText() === text) session.markSaved();
    const open = this.isOpen(job);
    if (open) {
      this.lastSavedAt = outcome.savedAt;
      this.lastSavedWhere = outcome.where;
    }
    this.app.notify("ok", outcome.where === "storage"
      ? `Saved in ${this.host.name === "browser" ? "this browser" : "local storage"}.`
      : `Saved to ${name ?? "disk"}: ${outcome.written.length === 0 ? "nothing changed" : `${outcome.written.length} file${outcome.written.length === 1 ? "" : "s"} written`}.`);
    if (open) this.app.emit("saved");
    return true;
  }

  /** Reopen the document saved in host storage, if any. */
  restore(): boolean {
    const stored = this.host.restore();
    if (!stored) return false;
    if (!this.openText(stored.text, stored.label, stored.fileName)) return false;
    this.lastSavedAt = stored.savedAt;
    this.lastSavedWhere = "storage";
    this.app.notify("info", `Restored “${stored.label}” saved ${this.host.name === "browser" ? "in this browser" : "earlier"}.`);
    return true;
  }

  async download(): Promise<void> {
    const session = this.app.session;
    if (!session) return;
    const fileName = this.fileName.endsWith(".json") ? this.fileName : `${this.fileName}.json`;
    const outcome = await this.host.exportFile(fileName, session.exportText());
    this.app.notify(outcome.ok ? "ok" : "error", outcome.message);
  }
}
