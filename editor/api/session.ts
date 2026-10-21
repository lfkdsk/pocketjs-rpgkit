// editor/api/session.ts — an interactive editing session over the headless
// protocol. Front-ends (the browser Studio, tests, future hosts) keep their
// document here and change it only through executeEditOperation /
// executeShardedEditOperation. Every history step is a patch-v1 value; undo
// and redo replay that patch through the protocol's own `save` operation in
// reverse or forward direction, so the session never edits JSON itself.
//
// Inline documents keep the source text, which the protocol re-serializes
// preserving untouched bytes. Sharded packs keep the shell text and every
// shard text; an operation receives only the shards it names, and a shard is
// parsed (and checksum-validated) only when a caller first reads that map.

import type { MapDef, Project, ProjectShell, Sheet, SpriteDef } from "../../src/engine/types.ts";
import {
  createEditPatch,
  EditApiError,
  executeEditOperation,
  parseEditPatch,
} from "./operations.ts";
import {
  eventCountProblem,
  mapCountProblem,
  MAX_PACK_BYTES,
  MAX_PROJECT_FILE_BYTES,
  openFileProblem,
  projectFileProblem,
  utf8Bytes,
} from "./limits.ts";
import {
  executeShardedEditOperation,
  loadValidatedMapShard,
  loadValidatedProjectShell,
  shardEntriesForOperation,
  sourceDeclaresProjectShell,
  SHARDED_DOCUMENT_KIND,
} from "./sharded.ts";
import { semanticEqual } from "../engine/document.ts";
import { parseShardedPack, serializeShardedPack, SHARDED_PACK_KIND, sourceDeclaresShardedPack, type PackAsset } from "./pack.ts";
import { validatePngAssetRecord } from "./assets.ts";
import { splitProjectMaps } from "../../tools/lib/map-project.ts";
import type {
  EditCommandName,
  EditFailure,
  EditPatch,
  EditResponse,
  EditSuccess,
} from "./types.ts";

export const SESSION_HISTORY_LIMIT = 200;
const TEXT_CACHE_CHARS = 48 * 1024 * 1024;

export interface SessionHistoryEntry {
  label: string;
  patch: EditPatch;
  /** Commands that produced the step, in order (for history panels). */
  commands: string[];
  /** PNG art travels with the same undo/redo step as its catalog edit. */
  assetChange?: { path: string; before?: PackAsset; after: PackAsset };
}

export interface SessionMapSummary {
  id: string;
  name?: string;
  width: number;
  height: number;
  /** Shard entry key for sharded packs. */
  entry?: string;
  eventCount?: number;
}

export interface SessionProblem {
  path: string;
  msg: string;
}

export type SessionDocumentKind = "inline" | "pack";

export interface SessionOperation {
  command: EditCommandName;
  args?: Record<string, unknown>;
}

interface InlineState {
  kind: "inline";
  source: string;
}

interface PackState {
  kind: "pack";
  shellText: string;
  shards: Map<string, string>;
}

type DocState = InlineState | PackState;

function cloneState(state: DocState): DocState {
  return state.kind === "inline"
    ? { kind: "inline", source: state.source }
    : { kind: "pack", shellText: state.shellText, shards: new Map(state.shards) };
}

function failure(command: string, code: string, message: string): EditFailure {
  return { ok: false, command, error: { code, message } };
}

/** One open document plus its undo/redo history. */
export class EditSession {
  private state: DocState;
  private saved: DocState;
  private undoStack: SessionHistoryEntry[] = [];
  private redoStack: SessionHistoryEntry[] = [];
  private projectCache: { source: string; project: Project } | null = null;
  private shellCache: { text: string; shell: ProjectShell } | null = null;
  private mapCache = new Map<string, { text: string; map: MapDef }>();
  private listeners = new Set<() => void>();
  /** Inline only: exact source text per semantic hash seen in a history
   * patch. Replaying a patch restores the right content but a property the
   * patch re-adds lands at the end of its object; serving the remembered
   * text keeps undo/redo byte-identical. Bounded by TEXT_CACHE_CHARS. */
  private textsByHash = new Map<string, string>();
  private textCacheChars = 0;
  /** Bumped on every document change; cheap change detection for views. */
  revision = 0;
  /** Imported PNGs follow catalog edits through history and pack export. */
  private readonly packAssets: Map<string, PackAsset>;
  private savedAssets: Map<string, PackAsset>;

  private constructor(state: DocState, assets: ReadonlyMap<string, PackAsset> = new Map()) {
    this.state = state;
    this.saved = cloneState(state);
    this.packAssets = new Map(assets);
    this.savedAssets = new Map(assets);
  }

  /** Open inline project JSON or a sharded pack. Throws EditApiError (with
   * `details` listing schema problems) when the document is not editable. */
  static open(text: string): EditSession {
    // Resource limits (limits.ts) come before any JSON.parse. Only a text
    // that names the pack kind may be larger than one project file.
    const bytes = utf8Bytes(text, MAX_PACK_BYTES);
    tooLarge(openFileProblem(bytes, "the document"), "$");
    if (bytes <= MAX_PROJECT_FILE_BYTES || text.includes(SHARDED_PACK_KIND)) {
      if (sourceDeclaresShardedPack(text)) {
        const pack = parseShardedPack(text);
        return new EditSession({ kind: "pack", shellText: pack.shellText, shards: pack.shards }, pack.assets);
      }
    }
    tooLarge(projectFileProblem(bytes), "$");
    if (sourceDeclaresProjectShell(text)) {
      throw failureError("SHELL_WITHOUT_SHARDS", "a bare ProjectShell has no map payloads; open a sharded pack instead");
    }
    // Count maps and events before the schema walks them all.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined; // the open operation reports the syntax error
    }
    inlineCountLimits(parsed);
    const opened = executeEditOperation(text, "open");
    if (!opened.response.ok) {
      const error = new Error(opened.response.error.message) as Error & { code: string; details?: unknown };
      error.code = opened.response.error.code;
      error.details = opened.response.error.details;
      throw error;
    }
    const session = new EditSession({ kind: "inline", source: text });
    session.projectCache = { source: text, project: parsed as Project };
    return session;
  }

  get kind(): SessionDocumentKind {
    return this.state.kind;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  // ---- reading ---------------------------------------------------------------

  /** Inline documents only: the parsed current project. */
  project(): Project {
    if (this.state.kind !== "inline") throw new Error("project() needs an inline document");
    if (this.projectCache?.source !== this.state.source) {
      this.projectCache = { source: this.state.source, project: JSON.parse(this.state.source) as Project };
    }
    return this.projectCache.project;
  }

  /** Sharded packs only: the validated current shell. */
  shell(): ProjectShell {
    if (this.state.kind !== "pack") throw new Error("shell() needs a sharded pack");
    if (this.shellCache?.text !== this.state.shellText) {
      this.shellCache = { text: this.state.shellText, shell: loadValidatedProjectShell(this.state.shellText) };
    }
    return this.shellCache.shell;
  }

  /** Project-global data shared by both document kinds. */
  globals(): Omit<Project, "maps"> {
    return this.state.kind === "inline" ? this.project() : this.shell();
  }

  title(): string {
    return this.globals().title;
  }

  sheets(): readonly Sheet[] {
    return this.globals().sheets;
  }

  sprites(): Readonly<Record<string, SpriteDef>> {
    return this.globals().sprites ?? {};
  }

  maps(): SessionMapSummary[] {
    if (this.state.kind === "inline") {
      return this.project().maps.map((map) => ({
        id: map.id,
        ...(map.name === undefined ? {} : { name: map.name }),
        width: map.width,
        height: map.height,
        eventCount: map.events?.length ?? 0,
      }));
    }
    return this.shell().mapIndex.map((meta) => ({ id: meta.id, width: meta.width, height: meta.height, entry: meta.entry }));
  }

  /** The map payload, parsing a shard on first use (lazy). Returns undefined
   * for an unknown id; throws when a shard fails validation. */
  map(id: string): MapDef | undefined {
    if (this.state.kind === "inline") return this.project().maps.find((map) => map.id === id);
    const meta = this.shell().mapIndex.find((item) => item.id === id);
    if (!meta) return undefined;
    const text = this.state.shards.get(meta.entry)!;
    const cached = this.mapCache.get(meta.entry);
    if (cached?.text === text) return cached.map;
    const map = loadValidatedMapShard(this.shell(), meta.entry, text);
    this.mapCache.set(meta.entry, { text, map });
    return map;
  }

  /** Shard entries whose payload has been parsed so far (sharded packs). */
  loadedEntries(): string[] {
    return [...this.mapCache.keys()];
  }

  /** Entries whose text differs from the last markSaved() baseline. */
  dirtyEntries(): string[] {
    if (this.state.kind !== "pack" || this.saved.kind !== "pack") return [];
    const saved = this.saved;
    return [...this.state.shards].filter(([entry, text]) => saved.shards.get(entry) !== text).map(([entry]) => entry);
  }

  isDirty(): boolean {
    if (this.packAssets.size !== this.savedAssets.size ||
        [...this.packAssets].some(([path, asset]) => {
          const saved = this.savedAssets.get(path);
          return saved?.type !== asset.type || saved.data !== asset.data;
        })) return true;
    if (this.state.kind === "inline") return this.saved.kind === "inline" && this.saved.source !== this.state.source;
    return this.saved.kind === "pack" && (this.saved.shellText !== this.state.shellText || this.dirtyEntries().length > 0);
  }

  markSaved(): void {
    this.saved = cloneState(this.state);
    this.savedAssets = new Map(this.packAssets);
    this.changed();
  }

  /** The images a sharded pack carries (path -> PNG), in pack order; empty
   * for inline documents and packs without art. */
  assets(): ReadonlyMap<string, PackAsset> {
    return this.packAssets;
  }

  /** Export an inline project unchanged until it acquires PNG art; thereafter
   * emit a self-contained pack so imported images survive save and download. */
  exportText(): string {
    if (this.state.kind === "inline") {
      if (this.packAssets.size === 0) return this.state.source;
      const split = splitProjectMaps(this.project());
      return serializeShardedPack(split.shellText, split.shell.mapIndex,
        new Map(split.entries.map((entry) => [entry.path, entry.text])), this.packAssets);
    }
    return serializeShardedPack(this.state.shellText, this.shell().mapIndex, this.state.shards, this.packAssets);
  }

  // ---- protocol execution ---------------------------------------------------

  /** Read-only operations (open, list-*, validate). */
  read(command: EditCommandName, args: Record<string, unknown> = {}): EditResponse {
    return this.execute(this.state, command, args).response;
  }

  /** Schema + structural problems, as reported by the `validate` operation. */
  validate(): SessionProblem[] {
    const response = this.read("validate");
    if (!response.ok) return [{ path: response.error.path ?? "$", msg: response.error.message }];
    return ((response.result as { errors?: SessionProblem[] }).errors ?? []).map((error) => ({ path: error.path, msg: error.msg }));
  }

  private execute(
    state: DocState,
    command: string,
    args: Record<string, unknown>,
  ): { response: EditResponse; next?: DocState } {
    if (state.kind === "inline") {
      const result = executeEditOperation(state.source, command, args);
      return {
        response: result.response,
        ...(result.output === undefined ? {} : { next: { kind: "inline", source: result.output } }),
      };
    }
    let entries: string[];
    try {
      entries = shardEntriesForOperation(loadValidatedProjectShell(state.shellText), command, args);
    } catch {
      // Let the protocol report its own error shape.
      entries = [];
    }
    const sources = Object.create(null) as Record<string, string>;
    for (const entry of entries) {
      const text = state.shards.get(entry);
      if (text !== undefined) sources[entry] = text;
    }
    const result = executeShardedEditOperation(state.shellText, sources, command, args);
    if (!result.output) return { response: result.response };
    const shards = new Map(state.shards);
    for (const [entry, text] of Object.entries(result.output.shards)) shards.set(entry, text);
    // The protocol re-serializes the shell; when an edit (typically an undo)
    // returns it to the saved content, keep the saved bytes so an unchanged
    // shell is never rewritten. Shard texts are canonical, so equal content
    // already means equal bytes and equal checksums.
    let shellText = result.output.shell;
    if (this.saved.kind === "pack" && shellText !== this.saved.shellText && semanticEqual(JSON.parse(shellText), JSON.parse(this.saved.shellText))) {
      shellText = this.saved.shellText;
    }
    return { response: result.response, next: { kind: "pack", shellText, shards } };
  }

  /** Run one modifying operation as one history step. A failed or no-op
   * operation leaves document and history untouched. */
  run(command: EditCommandName, args: Record<string, unknown> = {}, label: string = command): EditResponse {
    const { response, next } = this.execute(this.state, command, args);
    if (!response.ok || !next || !response.changed || !response.patch) return response;
    this.commit(next, { label, patch: response.patch, commands: [command] });
    return response;
  }

  /** Commit a catalog operation and its PNG together, or change neither. */
  importPngAsset(operations: readonly SessionOperation[], path: string, asset: PackAsset, label: string): { ok: boolean; message: string } {
    const supplied = Object.fromEntries(this.packAssets);
    supplied[path] = asset;
    const validated = validatePngAssetRecord(supplied);
    if (!validated.ok) return { ok: false, message: validated.issue.message };
    let state = this.state;
    const commands: string[] = [];
    for (const operation of operations) {
      const { response, next } = this.execute(state, operation.command, operation.args ?? {});
      if (!response.ok) return { ok: false, message: response.error.message };
      commands.push(operation.command);
      if (next && response.changed) state = next;
    }
    if (state === this.state && this.packAssets.get(path)?.data === asset.data) return { ok: false, message: "Import did not change the project." };
    const patch = this.patchBetween(this.state, state);
    const before = this.packAssets.get(path);
    this.packAssets.set(path, asset);
    this.commit(state, { label, patch, commands, assetChange: { path, before, after: asset } });
    return { ok: true, message: label };
  }

  /** Run several operations as one history step: all apply or none does.
   * The step's patch is computed between the documents before and after, so
   * it is an ordinary patch-v1 value the `save` operation replays. */
  transaction(label: string, operations: readonly SessionOperation[]): EditResponse {
    let state = this.state;
    let last: EditSuccess | undefined;
    const commands: string[] = [];
    for (const operation of operations) {
      const { response, next } = this.execute(state, operation.command, operation.args ?? {});
      if (!response.ok) return response;
      last = response;
      commands.push(operation.command);
      if (next && response.changed) state = next;
    }
    if (!last) return failure("transaction", "EMPTY_TRANSACTION", "a transaction needs at least one operation");
    if (state === this.state) return { ...last, changed: false, diff: [] };
    const patch = this.patchBetween(this.state, state);
    this.commit(state, { label, patch, commands });
    return { ...last, changed: true, diff: patch.changes, patch };
  }

  /** Inline documents only: replace the whole project with `project` (for
   * example an accepted agent proposal) as one history step. The change runs
   * through the protocol's `save` operation as a patch from the current
   * project, so it is validated, serialized preserving untouched bytes and
   * undone like any other step. An identical project changes nothing. */
  replaceInline(label: string, project: Project): EditResponse {
    if (this.state.kind !== "inline") {
      return failure("replace", "INLINE_ONLY", "a whole-project replacement needs an inline document; sharded packs change map by map");
    }
    let patch: EditPatch;
    try {
      patch = createEditPatch(this.project(), project);
    } catch (error) {
      return failure("replace", "INVALID_PROJECT", error instanceof Error ? error.message : String(error));
    }
    return this.run("save", { patch, direction: "forward" }, label);
  }

  private patchBetween(before: DocState, after: DocState): EditPatch {
    if (before.kind === "inline" && after.kind === "inline") {
      return createEditPatch(JSON.parse(before.source), JSON.parse(after.source));
    }
    if (before.kind !== "pack" || after.kind !== "pack") throw new Error("document kind changed inside a transaction");
    const touched = [...after.shards.keys()].filter((entry) => before.shards.get(entry) !== after.shards.get(entry));
    const view = (state: PackState) => {
      const shards = Object.create(null) as Record<string, unknown>;
      for (const entry of touched) shards[entry] = JSON.parse(state.shards.get(entry)!);
      return { kind: SHARDED_DOCUMENT_KIND, shell: JSON.parse(state.shellText), shards };
    };
    return createEditPatch(view(before), view(after));
  }

  private remember(hash: string, state: DocState): void {
    if (state.kind !== "inline" || this.textsByHash.has(hash)) return;
    this.textsByHash.set(hash, state.source);
    this.textCacheChars += state.source.length;
    for (const [key, text] of this.textsByHash) {
      if (this.textCacheChars <= TEXT_CACHE_CHARS) break;
      this.textsByHash.delete(key);
      this.textCacheChars -= text.length;
    }
  }

  private commit(next: DocState, entry: SessionHistoryEntry): void {
    this.remember(entry.patch.beforeHash, this.state);
    this.remember(entry.patch.afterHash, next);
    this.state = next;
    this.undoStack.push(entry);
    if (this.undoStack.length > SESSION_HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.changed();
  }

  // ---- history --------------------------------------------------------------

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Oldest first. */
  history(): readonly SessionHistoryEntry[] {
    return this.undoStack;
  }

  /** Most recently undone last. */
  future(): readonly SessionHistoryEntry[] {
    return this.redoStack;
  }

  private replay(entry: SessionHistoryEntry, direction: "forward" | "reverse"): EditResponse {
    const { response, next } = this.execute(this.state, "save", { patch: parseEditPatch(entry.patch), direction });
    if (response.ok && next) {
      // The protocol verified the result against the patch's hash, so the
      // remembered text for that hash is the same document, byte-exact.
      const hash = direction === "reverse" ? entry.patch.beforeHash : entry.patch.afterHash;
      const exact = next.kind === "inline" ? this.textsByHash.get(hash) : undefined;
      this.state = exact === undefined ? next : { kind: "inline", source: exact };
      if (entry.assetChange) {
        const { path, before, after } = entry.assetChange;
        const asset = direction === "reverse" ? before : after;
        if (asset) this.packAssets.set(path, asset);
        else this.packAssets.delete(path);
      }
    }
    return response;
  }

  undo(): EditResponse | undefined {
    const entry = this.undoStack.at(-1);
    if (!entry) return undefined;
    const response = this.replay(entry, "reverse");
    if (response.ok) {
      this.undoStack.pop();
      this.redoStack.push(entry);
      this.changed();
    }
    return response;
  }

  redo(): EditResponse | undefined {
    const entry = this.redoStack.at(-1);
    if (!entry) return undefined;
    const response = this.replay(entry, "forward");
    if (response.ok) {
      this.redoStack.pop();
      this.undoStack.push(entry);
      this.changed();
    }
    return response;
  }

  /** Undo or redo until `depth` steps remain applied (history panel jumps). */
  jumpTo(depth: number): void {
    while (this.undoStack.length > depth && this.undo()?.ok) { /* step back */ }
    while (this.undoStack.length < depth && this.redo()?.ok) { /* step forward */ }
  }
}

function tooLarge(problem: string | null, path: string): void {
  if (problem !== null) throw new EditApiError("TOO_LARGE", problem, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Map and event counts of an inline project, checked before validation. */
function inlineCountLimits(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.maps)) return;
  tooLarge(mapCountProblem(value.maps.length), "$.maps");
  for (const [index, map] of value.maps.entries()) {
    if (!isRecord(map) || !Array.isArray(map.events)) continue;
    const name = typeof map.id === "string" ? map.id : `#${index}`;
    tooLarge(eventCountProblem(name, map.events.length), `$.maps[${index}].events`);
  }
}

function failureError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
