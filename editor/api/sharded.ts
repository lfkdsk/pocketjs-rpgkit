// editor/api/sharded.ts — ProjectShell editing as a bounded logical document.
//
// Host adapters decide which entry bytes to read. This module validates those
// bytes and presents the existing inline reducers with either one target map
// or (only for validation and id renames) the complete map set.

import type {
  MapDef,
  MapIndexEntry,
  Project,
  ProjectShell,
  ProjectSource,
} from "../../src/engine/types.ts";
import {
  MAP_SCHEMA_HASH,
  describeMapSchemaRefusal,
  isCompatibleMapSchemaHash,
  canonicalMapJson,
  decodeMapEntryText,
  mapManifestHash,
  resolveMapManifestHash,
  sha256Text,
  validateMapDef,
  validateMapDefStructure,
  validateMapIndex,
} from "../../src/engine/map-repository.ts";
import { decodeCompactMap, isCompactMapValue } from "../../src/engine/compact-map.ts";
import { encodeCompactMap } from "../../tools/lib/compact-map.ts";
import { loadProject, semanticEqual } from "../engine/document.ts";
import { deepClone } from "../../src/engine/clone.ts";
import { canonicalJson } from "../../src/engine/save.ts";
import { eventCountProblem, MAX_SHARD_BYTES, shardProblem, utf8Bytes } from "./limits.ts";
import {
  EditApiError,
  applyEditPatchValue,
  createEditMemo,
  createEditPatch,
  diffJson,
  executeEditOperation,
  executeProjectOperation,
  parseEditPatch,
  semanticHash,
  validateEditOperationInput,
} from "./operations.ts";
import type {
  EditFailure,
  EditResponse,
  EditSuccess,
  ProjectSummary,
  ShardedEditDocument,
  ShardedEditExecution,
} from "./types.ts";
import { catalogCommandSpec } from "./catalogs.ts";

export const SHARDED_DOCUMENT_KIND = "rpgkit-edit/sharded-document-v1" as const;

const NO_SHARD_COMMANDS = new Set(["open", "list-maps"]);
const SHELL_GLOBAL_COMMANDS = new Set(["add-item", "add-sprite"]);

/** Commands that cannot be expressed over a shell in patch-v1. Map
 * add/duplicate/delete/move would add, remove or reorder mapIndex entries,
 * which patch-v1 keeps stable so a reverse patch can reacquire the same
 * physical shards.
 * Sheet dirEdges are project-global shell data, while a single-map edit
 * only writes back its shard and index metadata, so edge strokes fail closed
 * instead of silently dropping the sheet change. */
const SHELL_UNSUPPORTED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["add-map", "adding a map would add a mapIndex entry; patch-v1 keeps ProjectShell mapIndex entries stable"],
  ["duplicate-map", "duplicating a map would add a mapIndex entry; patch-v1 keeps ProjectShell mapIndex entries stable"],
  ["delete-map", "deleting a map would remove a mapIndex entry; patch-v1 keeps ProjectShell mapIndex entries stable"],
  ["move-map", "map order is the mapIndex order; patch-v1 keeps ProjectShell mapIndex entries in place"],
  ["paint-edges", "sheet dirEdges are project-global; edit them in an inline project"],
]);

function assertShellSupported(command: string): void {
  const reason = SHELL_UNSUPPORTED_COMMANDS.get(command);
  if (reason === undefined) return;
  throw new EditApiError(
    "UNSUPPORTED_FOR_SHELL",
    `${command} is not supported for a sharded ProjectShell: ${reason}`,
    "$.command",
    "an inline project with $.maps",
    command,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cloneJson<T>(value: T): T {
  return deepClone(value);
}

function failure(command: string | undefined, error: unknown): ShardedEditExecution {
  const known = error instanceof EditApiError
    ? error
    : new EditApiError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
  const response: EditFailure = {
    ok: false,
    ...(command === undefined ? {} : { command }),
    error: {
      code: known.code,
      message: known.message,
      ...(known.path === undefined ? {} : { path: known.path }),
      ...(known.expected === undefined ? {} : { expected: known.expected }),
      ...(known.actual === undefined ? {} : { actual: known.actual }),
      ...(known.details === undefined ? {} : { details: known.details }),
    },
  };
  return { response };
}

function invalidDocument(path: string, message: string, details?: unknown): never {
  throw new EditApiError("INVALID_DOCUMENT", `${path}: ${message}`, path, message, undefined, details);
}

/** Cheap routing predicate. Validation remains the responsibility of
 * loadValidatedProjectShell, so malformed shells still get useful errors. */
export function sourceDeclaresProjectShell(source: string): boolean {
  try {
    const parsed = JSON.parse(source) as unknown;
    return isRecord(parsed) && own(parsed, "mapIndex") && !own(parsed, "maps");
  } catch {
    return false;
  }
}

/** Validate the shell schema, index uniqueness/content identity, schema
 * identity and start-map metadata without touching a shard. */
export function loadValidatedProjectShell(source: string): ProjectShell {
  const loaded = loadProject(source);
  if (loaded.errors.length > 0) {
    const first = loaded.errors[0]!;
    invalidDocument(first.path, first.msg, loaded.errors);
  }
  const value = loaded.project as unknown as ProjectSource;
  if (!("mapIndex" in value) || "maps" in value) {
    invalidDocument("$", "expected a ProjectShell with mapIndex and without maps");
  }
  const shell = value as ProjectShell;
  let index: Map<string, MapIndexEntry>;
  try {
    index = validateMapIndex(shell.mapIndex);
  } catch (error) {
    invalidDocument("$.mapIndex", error instanceof Error ? error.message : String(error));
  }
  if (shell.mapSchemaHash !== undefined && !isCompatibleMapSchemaHash(shell.mapSchemaHash)) {
    invalidDocument("$.mapSchemaHash", `map schema hash does not match this RPG Kit build: ${describeMapSchemaRefusal(shell.mapSchemaHash)}`);
  }
  try {
    // Missing hashes retain the ProjectShell runtime's documented computed
    // fallback. A declared hash is always recomputed and checked here.
    resolveMapManifestHash(shell, shell.mapManifestHash !== undefined);
  } catch (error) {
    invalidDocument("$.mapManifestHash", error instanceof Error ? error.message : String(error));
  }
  const start = index.get(shell.start.map);
  if (!start) invalidDocument("$.start.map", `unknown start map ${JSON.stringify(shell.start.map)}`);
  if (shell.start.x >= start.width || shell.start.y >= start.height) {
    invalidDocument(
      "$.start",
      `start (${shell.start.x},${shell.start.y}) is outside map ${start.id} ${start.width}x${start.height}`,
    );
  }
  return shell;
}

function pointerTokens(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new EditApiError("INVALID_PATCH", "sharded patch paths must start with /shell or /shards", "$.patch.changes[].path");
  }
  return path.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/.test(part)) {
      throw new EditApiError("INVALID_PATCH", `invalid JSON Pointer escape in ${JSON.stringify(path)}`, "$.patch.changes[].path");
    }
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

/** Determine the exact shard set a file adapter must load. Ordinary map
 * operations return one entry; open/list return zero; validate and a real id
 * rename return all. save derives its set solely from logical patch paths. */
export function shardEntriesForOperation(
  shell: ProjectShell,
  command: string,
  rawArgs: unknown = {},
): string[] {
  const { args } = validateEditOperationInput(command, rawArgs);
  // Refuse before any shard selection: add-map has no map argument at all.
  assertShellSupported(command);
  if (NO_SHARD_COMMANDS.has(command)) return [];
  if (SHELL_GLOBAL_COMMANDS.has(command)) return [];
  const catalog = catalogCommandSpec(command);
  if (catalog) {
    if (catalog.action === "add" || catalog.action === "update") {
      const start = shell.mapIndex.find((meta) => meta.id === shell.start.map);
      if (!start) throw new EditApiError("INVALID_DOCUMENT", `unknown start map ${JSON.stringify(shell.start.map)}`, "$.start.map");
      return [start.entry];
    }
    // Reads include reference counts/details and switch/variable reads merge
    // undeclared ids found in event content. Removal must prove there are no
    // references, so these operations deliberately inspect every shard.
    return shell.mapIndex.map((meta) => meta.entry);
  }
  if (command === "validate") return shell.mapIndex.map((meta) => meta.entry);
  if (command === "save") {
    const patch = parseEditPatch(args.patch);
    const entries = new Set<string>();
    const available = new Set(shell.mapIndex.map((meta) => meta.entry));
    for (const change of patch.changes) {
      const tokens = pointerTokens(change.path);
      if (tokens[0] === "shell" && tokens.length >= 2) continue;
      if (tokens[0] !== "shards" || tokens.length < 3) {
        throw new EditApiError(
          "INVALID_PATCH",
          "ProjectShell patches may change only /shell/... and /shards/<entry>/...",
          change.path || "$",
        );
      }
      const entry = tokens[1]!;
      if (!available.has(entry)) {
        throw new EditApiError("INVALID_PATCH", `patch refers to unknown shard entry ${JSON.stringify(entry)}`, change.path);
      }
      entries.add(entry);
    }
    return [...entries];
  }
  if (typeof args.map !== "string" || args.map.length === 0) {
    throw new EditApiError("INVALID_ARGUMENT", "map must be a non-empty string", "$.map", "non-empty string", args.map);
  }
  const meta = shell.mapIndex.find((item) => item.id === args.map);
  if (!meta) {
    throw new EditApiError(
      "MAP_NOT_FOUND",
      `map ${JSON.stringify(args.map)} does not exist; choose one of: ${shell.mapIndex.map((item) => item.id).join(", ")}`,
      "$.map",
      shell.mapIndex.map((item) => item.id),
      args.map,
    );
  }
  if (command === "update-map" && isRecord(args.changes) &&
    typeof args.changes.id === "string" && args.changes.id !== meta.id) {
    return shell.mapIndex.map((item) => item.entry);
  }
  return [meta.entry];
}

/** How a shard file is encoded on disk. Invalid JSON reports "json" so the
 *  normal validation path produces the useful parse error. */
export type ShardEncoding = "json" | "compact";

export function shardEncodingOf(source: string): ShardEncoding {
  try {
    return isCompactMapValue(JSON.parse(source) as unknown) ? "compact" : "json";
  } catch {
    return "json";
  }
}

/** The bytes a shard with this encoding is written back as. Compact shards
 *  stay compact across an edit, so an unchanged project keeps its on-disk
 *  format and only changed shards change bytes. */
export function serializeShard(map: MapDef, encoding: ShardEncoding): string {
  return encoding === "compact" ? encodeCompactMap(map).text : canonicalMapJson(map);
}

function shardError(entry: string, message: string): never {
  invalidDocument(`$.shards[${JSON.stringify(entry)}]`, message);
}

function validateMapSemantics(map: MapDef, fail: (message: string) => never): void {
  const eventIds = new Set<string>();
  for (const [eventIndex, event] of (map.events ?? []).entries()) {
    if (eventIds.has(event.id)) fail(`duplicate event id ${JSON.stringify(event.id)}`);
    eventIds.add(event.id);
    const width = event.w ?? 1;
    const height = event.h ?? 1;
    if (event.x + width > map.width || event.y + height > map.height) {
      fail(`event ${eventIndex} footprint is outside ${map.id} ${map.width}x${map.height}`);
    }
  }
}

/** Full-schema, raw-checksum and metadata validation for one entry. */
export function loadValidatedMapShard(shell: ProjectShell, entry: string, source: string): MapDef {
  const meta = shell.mapIndex.find((item) => item.entry === entry);
  if (!meta) shardError(entry, "entry is absent from mapIndex");
  const path = `$.shards[${JSON.stringify(entry)}]`;
  const tooBig = shardProblem(entry, utf8Bytes(source, MAX_SHARD_BYTES));
  if (tooBig !== null) throw new EditApiError("TOO_LARGE", tooBig, path);
  if (sha256Text(source) !== meta.sha256) shardError(entry, `checksum mismatch for ${meta.id}`);
  let parsed: unknown;
  try {
    parsed = decodeMapEntryText(source);
  } catch (error) {
    shardError(entry, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Importers default to rpgkit-map/1 compact envelopes; the runtime
  // repository has always decoded them (map-repository.ts). Decode before
  // validation so the edit API accepts the same bytes the game ships.
  let decoded: unknown;
  if (isCompactMapValue(parsed)) {
    try {
      decoded = decodeCompactMap(parsed);
    } catch (error) {
      shardError(entry, error instanceof Error ? error.message : String(error));
    }
  } else {
    decoded = parsed;
  }
  if (isRecord(decoded) && Array.isArray(decoded.events)) {
    const tooMany = eventCountProblem(meta.id, decoded.events.length);
    if (tooMany !== null) throw new EditApiError("TOO_LARGE", tooMany, `${path}.events`);
  }
  try {
    validateMapDef(decoded);
  } catch (error) {
    shardError(entry, error instanceof Error ? error.message : String(error));
  }
  const map = decoded as MapDef;
  if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
    shardError(
      entry,
      `metadata mismatch: index has ${meta.id} ${meta.width}x${meta.height}, shard has ${map.id} ${map.width}x${map.height}`,
    );
  }
  validateMapSemantics(map, (message) => shardError(entry, message));
  return map;
}

function loadedMaps(
  shell: ProjectShell,
  sources: Readonly<Record<string, string>>,
  entries: readonly string[],
  checksumsVerified = false,
  encodings?: Map<string, ShardEncoding>,
): Map<string, MapDef> {
  const maps = new Map<string, MapDef>();
  for (const entry of entries) {
    if (!own(sources, entry)) shardError(entry, "required shard source was not loaded");
    if (encodings !== undefined) encodings.set(entry, shardEncodingOf(sources[entry]!));
    if (!checksumsVerified) {
      maps.set(entry, loadValidatedMapShard(shell, entry, sources[entry]!));
      continue;
    }
    const meta = shell.mapIndex.find((item) => item.entry === entry);
    if (!meta) shardError(entry, "entry is absent from mapIndex");
    let parsed: unknown;
    try {
      parsed = decodeMapEntryText(sources[entry]!);
      // The host already verified the raw checksum. Keep the normative schema
      // gate here; besides authoring safety it seeds the validator's hot path
      // before the in-memory delta validation below.
      validateMapDef(parsed);
    } catch (error) {
      shardError(entry, error instanceof Error ? error.message : String(error));
    }
    const map = parsed as MapDef;
    if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      shardError(entry, `metadata mismatch: index has ${meta.id} ${meta.width}x${meta.height}, shard has ${map.id} ${map.width}x${map.height}`);
    }
    validateMapSemantics(map, (message) => shardError(entry, message));
    maps.set(entry, map);
  }
  return maps;
}

function projectFromMaps(shell: ProjectShell, maps: readonly MapDef[], exactStart: boolean): Project {
  const {
    mapIndex: _index,
    mapManifestHash: _manifest,
    mapSchemaHash: _schema,
    ...globals
  } = shell;
  let start = globals.start;
  if (!exactStart && !maps.some((map) => map.id === start.map)) {
    const map = maps[0]!;
    start = { ...start, map: map.id, x: 0, y: 0 };
  }
  return { ...cloneJson(globals), start: cloneJson(start), maps: maps.map(cloneJson) };
}

function shardedView(shell: ProjectShell, maps: ReadonlyMap<string, MapDef>): ShardedEditDocument {
  const shards = Object.create(null) as Record<string, MapDef>;
  for (const [entry, map] of maps) shards[entry] = cloneJson(map);
  return { kind: SHARDED_DOCUMENT_KIND, shell: cloneJson(shell), shards };
}

function summary(shell: ProjectShell, view: ShardedEditDocument, manifestRevision = false): ProjectSummary {
  return {
    format: shell.format,
    title: shell.title,
    documentKind: "shell",
    editable: true,
    mapCount: shell.mapIndex.length,
    // Proposal dry-runs already bind their own sparse-document baseHash and do
    // not expose this response summary. Reusing the verified shell content
    // identity avoids canonicalizing a large shell once more on that path.
    revision: manifestRevision ? resolveMapManifestHash(shell) : semanticHash(view),
  };
}

function executeValidatedShardedEditOperation(
  shell: ProjectShell,
  shardSources: Readonly<Record<string, string>>,
  commandValue: string,
  rawArgs: unknown,
  manifestRevision: boolean,
  checksumsVerified: boolean,
  hashText: (text: string) => string,
  encodings?: Map<string, ShardEncoding>,
): ShardedEditExecution {
  const entries = shardEntriesForOperation(shell, commandValue, rawArgs);
  if (commandValue === "open" || commandValue === "list-maps") {
    return shellRead(shell, commandValue);
  }
  if (SHELL_GLOBAL_COMMANDS.has(commandValue)) {
    return executeShellGlobalOperation(shell, commandValue, rawArgs, manifestRevision);
  }
  const maps = loadedMaps(shell, shardSources, entries, checksumsVerified, encodings);
  if (commandValue === "validate") {
    const project = projectFromMaps(shell, shell.mapIndex.map((meta) => maps.get(meta.entry)!), true);
    const inline = executeEditOperation(JSON.stringify(project), "validate");
    const view = shardedView(shell, maps);
    return { response: withProject(inline.response, summary(shell, view, manifestRevision)) };
  }
  if (commandValue === "save") return executeSave(shell, maps, rawArgs, encodings ?? new Map());

  const orderedMaps = entries.map((entry) => maps.get(entry)!);
  // Only a real id rename asks for all maps. This exact project lets the
  // model rewrite start/common-event/all-shard literal transfer refs.
  const allMapsLoaded = entries.length === shell.mapIndex.length;
  const project = projectFromMaps(shell, orderedMaps, allMapsLoaded);
  let inlineResponse: EditSuccess;
  let edited: Project;
  if (manifestRevision) {
    const memory = executeProjectOperation(project, commandValue, rawArgs, createEditMemo());
    if (!memory.ok) return { response: memory };
    edited = memory.project;
    inlineResponse = {
      ok: true,
      command: memory.command,
      project: summary(shell, shardedView(shell, maps), true),
      changed: memory.changed,
      addresses: memory.addresses,
      diff: [...memory.edit.changes],
      result: memory.result,
    };
  } else {
    const inline = executeEditOperation(JSON.stringify(project), commandValue, rawArgs);
    if (!inline.response.ok) return { response: inline.response };
    if (inline.output === undefined) {
      const beforeView = shardedView(shell, maps);
      return { response: withProject(inline.response, summary(shell, beforeView, manifestRevision)) };
    }
    edited = JSON.parse(inline.output) as Project;
    inlineResponse = inline.response;
  }
  const derived = updateShell(shell, project, edited, maps, hashText, encodings);
  const changedBefore = new Map<string, MapDef>();
  for (const entry of derived.changed.keys()) changedBefore.set(entry, maps.get(entry)!);
  const before = shardedView(shell, changedBefore);
  const after = shardedView(derived.shell, derived.changed);
  const patch = manifestRevision
    ? {
        format: "rpgkit-edit/patch-v1" as const,
        beforeHash: hashText(canonicalJson(before)),
        afterHash: hashText(canonicalJson(after)),
        changes: diffJson(before, after),
      }
    : createEditPatch(before, after);
  const changed = patch.changes.length > 0;
  const response: EditSuccess = {
    ...inlineResponse,
    project: summary(derived.shell, after, manifestRevision),
    changed,
    diff: patch.changes,
    patch,
  };
  return {
    response,
    ...(changed ? { output: { shell: serializeShell(derived.shell), shards: derived.texts } } : {}),
  };
}

/** Run a global catalog mutation without loading any map payload. A tiny
 * schema-valid placeholder lets the normative inline operation/validator own
 * argument and item/sprite shape checks; only global fields are copied back
 * to the shell, whose real start and map index stay byte-bound. */
function executeShellGlobalOperation(
  shell: ProjectShell,
  command: string,
  rawArgs: unknown,
  manifestRevision: boolean,
): ShardedEditExecution {
  const placeholderId = "shell-edit-placeholder";
  const { mapIndex: _index, mapManifestHash: _manifest, mapSchemaHash: _schema, ...globals } = shell;
  const project: Project = {
    ...cloneJson(globals),
    start: { map: placeholderId, x: 0, y: 0, dir: shell.start.dir },
    maps: [{
      id: placeholderId,
      name: "Shell edit placeholder",
      width: 1,
      height: 1,
      sheets: [shell.sheets[0]!.id],
      ground: [null],
      events: [],
    }],
  };
  const inline = executeEditOperation(JSON.stringify(project), command, rawArgs);
  if (!inline.response.ok) return { response: inline.response };
  if (inline.output === undefined) {
    const view = shardedView(shell, new Map());
    return { response: withProject(inline.response, summary(shell, view, manifestRevision)) };
  }
  const edited = JSON.parse(inline.output) as Project;
  const { maps: _maps, start: _start, ...editedGlobals } = edited;
  const next: ProjectShell = {
    ...editedGlobals,
    start: cloneJson(shell.start),
    mapIndex: shell.mapIndex.map((entry) => ({ ...entry })),
    ...(shell.mapSchemaHash === undefined ? {} : { mapSchemaHash: shell.mapSchemaHash }),
  };
  if (shell.mapManifestHash !== undefined) next.mapManifestHash = mapManifestHash(next);
  loadValidatedProjectShell(`${JSON.stringify(next)}\n`);
  const before = shardedView(shell, new Map());
  const after = shardedView(next, new Map());
  const patch = createEditPatch(before, after);
  const response: EditSuccess = {
    ...inline.response,
    project: summary(next, after, manifestRevision),
    changed: patch.changes.length > 0,
    diff: patch.changes,
    patch,
  };
  return {
    response,
    ...(response.changed ? { output: { shell: serializeShell(next), shards: {} } } : {}),
  };
}

/** Internal proposal fast path. `shell` must come from
 * loadValidatedProjectShell; normal file/API callers use the source-text
 * wrapper below and retain the traditional sparse-document revision hash. */
export function executeShardedEditOperationOnValidatedShell(
  shell: ProjectShell,
  shardSources: Readonly<Record<string, string>>,
  commandValue: string,
  rawArgs: unknown = {},
  hashText: (text: string) => string = sha256Text,
): ShardedEditExecution {
  try {
    // The proposal adapter verifies exact source bytes with the host's native
    // SHA-256 before entering this pure operation path. Track each shard's
    // on-disk encoding so a compact shard is written back compact.
    const encodings = new Map<string, ShardEncoding>();
    return executeValidatedShardedEditOperation(shell, shardSources, commandValue, rawArgs, true, true, hashText, encodings);
  } catch (error) {
    return failure(commandValue || undefined, error);
  }
}

function shellRead(
  shell: ProjectShell,
  command: "open" | "list-maps",
): ShardedEditExecution {
  const view = shardedView(shell, new Map());
  const project = summary(shell, view);
  const result = command === "open"
    ? {
        ...project,
        start: cloneJson(shell.start),
        sheets: shell.sheets.map((sheet) => ({ id: sheet.id, cols: sheet.cols, rows: sheet.rows })),
      }
    : shell.mapIndex.map((map) => ({
        address: `map:${map.id}`,
        id: map.id,
        width: map.width,
        height: map.height,
        entry: map.entry,
        sha256: map.sha256,
      }));
  return {
    response: {
      ok: true,
      command,
      project,
      changed: false,
      addresses: [],
      diff: [],
      result,
    },
  };
}

function withProject(response: EditResponse, project: ProjectSummary): EditResponse {
  return response.ok ? { ...response, project } : response;
}

function updateShell(
  shell: ProjectShell,
  beforeProject: Project,
  edited: Project,
  beforeByEntry: ReadonlyMap<string, MapDef>,
  hashText: (text: string) => string = sha256Text,
  encodings?: ReadonlyMap<string, ShardEncoding>,
): { shell: ProjectShell; changed: Map<string, MapDef>; texts: Record<string, string> } {
  const changed = new Map<string, MapDef>();
  const texts = Object.create(null) as Record<string, string>;
  const oldEntries = shell.mapIndex;
  const editedByOldEntry = new Map<string, MapDef>();
  const loadedEntries = [...beforeByEntry.keys()];
  edited.maps.forEach((map, index) => editedByOldEntry.set(loadedEntries[index]!, map));
  for (const entry of loadedEntries) {
    const before = beforeByEntry.get(entry)!;
    const after = editedByOldEntry.get(entry)!;
    if (!semanticEqual(before, after)) {
      changed.set(entry, after);
      texts[entry] = serializeShard(after, encodings?.get(entry) ?? "json");
    }
  }
  // Global catalog fields (items, sprites, audio, sheets, switches, variables)
  // can change without any map shard changing. Diff them against the project
  // we sent into the operation so a global-only edit still publishes. This is
  // safe on a partial load: projectFromMaps rewrites `start` only when the
  // shell's start map is not among the loaded shards, and that rewrite is
  // present in both beforeProject and the edited result, so it cancels here.
  // No partially-loaded direct edit mutates global catalog fields — catalog
  // add/update load the start shard and touch only their own catalog array,
  // while structural and sheet-edge commands are refused on shells.
  const { maps: _beforeMaps, ...beforeGlobals } = beforeProject;
  const { maps: _afterMaps, ...afterGlobals } = edited;
  const globalKeys = new Set([...Object.keys(beforeGlobals), ...Object.keys(afterGlobals)]);
  const globalsChanged = [...globalKeys].some((key) => !semanticEqual(
    (beforeGlobals as Record<string, unknown>)[key],
    (afterGlobals as Record<string, unknown>)[key],
  ));
  if (changed.size === 0 && !globalsChanged) return { shell, changed, texts };

  const next = { ...cloneJson(shell), mapIndex: oldEntries.map((meta) => ({ ...meta })) } as ProjectShell;
  if (globalsChanged) {
    for (const key of globalKeys) {
      if (semanticEqual(
        (beforeGlobals as Record<string, unknown>)[key],
        (afterGlobals as Record<string, unknown>)[key],
      )) continue;
      if (!Object.prototype.hasOwnProperty.call(afterGlobals, key)) {
        delete (next as unknown as Record<string, unknown>)[key];
      } else {
        (next as unknown as Record<string, unknown>)[key] = cloneJson((afterGlobals as Record<string, unknown>)[key]);
      }
    }
  }
  next.mapIndex = next.mapIndex.map((meta) => {
    const map = changed.get(meta.entry);
    return map === undefined
      ? meta
      : {
          id: map.id,
          width: map.width,
          height: map.height,
          entry: meta.entry,
          sha256: hashText(texts[meta.entry]!),
        };
  });
  next.mapSchemaHash = MAP_SCHEMA_HASH;
  delete next.mapManifestHash;
  next.mapManifestHash = mapManifestHash(next);
  return { shell: next, changed, texts };
}

function serializeShell(shell: ProjectShell): string {
  return `${JSON.stringify(shell, null, 2)}\n`;
}

function assertLogicalResult(
  current: ShardedEditDocument,
  value: unknown,
): ShardedEditDocument {
  if (!isRecord(value) || value.kind !== SHARDED_DOCUMENT_KIND || !isRecord(value.shell) || !isRecord(value.shards)) {
    throw new EditApiError(
      "INVALID_PATCH",
      `sharded patch result must be exactly {kind:${JSON.stringify(SHARDED_DOCUMENT_KIND)},shell,shards}`,
      "$.patch",
    );
  }
  const keys = Object.keys(value).sort();
  if (!semanticEqual(keys, ["kind", "shards", "shell"])) {
    throw new EditApiError("INVALID_PATCH", "sharded patch cannot add logical-document fields", "$.patch");
  }
  const shards = value.shards as Record<string, unknown>;
  if (!semanticEqual(Object.keys(shards).sort(), Object.keys(current.shards).sort())) {
    throw new EditApiError("INVALID_PATCH", "sharded patch cannot add, remove, or rename shard entry keys", "$.patch");
  }
  return value as unknown as ShardedEditDocument;
}

function validateLogicalResult(
  current: ShardedEditDocument,
  next: ShardedEditDocument,
  encodings: ReadonlyMap<string, ShardEncoding>,
): void {
  // Validate shell through the same strict gate, including its recomputed
  // manifest. Entry strings are immutable in patch-v1 so reverse patches can
  // always reacquire the same physical shards.
  const shell = loadValidatedProjectShell(JSON.stringify(next.shell));
  const beforeEntries = current.shell.mapIndex.map((meta) => meta.entry);
  const afterEntries = shell.mapIndex.map((meta) => meta.entry);
  if (!semanticEqual(beforeEntries, afterEntries)) {
    throw new EditApiError("INVALID_PATCH", "sharded patches must keep every mapIndex entry key stable", "/shell/mapIndex");
  }
  for (let index = 0; index < shell.mapIndex.length; index++) {
    const before = current.shell.mapIndex[index]!;
    const after = shell.mapIndex[index]!;
    if (!semanticEqual(before, after) && !own(current.shards, before.entry)) {
      throw new EditApiError(
        "INVALID_PATCH",
        `mapIndex metadata changed without loading its shard ${JSON.stringify(before.entry)}`,
        `/shell/mapIndex/${index}`,
      );
    }
  }
  for (const [entry, map] of Object.entries(next.shards)) {
    const meta = shell.mapIndex.find((item) => item.entry === entry);
    if (!meta) throw new EditApiError("INVALID_PATCH", `result shell no longer indexes ${JSON.stringify(entry)}`, `/shards/${entry}`);
    try {
      validateMapDef(map);
    } catch (error) {
      throw new EditApiError("INVALID_PATCH", error instanceof Error ? error.message : String(error), `/shards/${entry}`);
    }
    validateMapSemantics(map, (message) => {
      throw new EditApiError("INVALID_PATCH", message, `/shards/${entry}`);
    });
    // The index checksum hashes the shard's on-disk encoding, so a compact
    // shard must be re-encoded compact before the hash compares.
    const text = serializeShard(map, encodings.get(entry) ?? "json");
    if (sha256Text(text) !== meta.sha256 || map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      throw new EditApiError("INVALID_PATCH", `result shard metadata/checksum mismatch for ${JSON.stringify(entry)}`, `/shards/${entry}`);
    }
  }
}

function executeSave(
  shell: ProjectShell,
  maps: ReadonlyMap<string, MapDef>,
  args: unknown,
  encodings: ReadonlyMap<string, ShardEncoding>,
): ShardedEditExecution {
  const record = isRecord(args) ? args : {};
  const direction = record.direction === undefined ? "forward" : record.direction;
  if (direction !== "forward" && direction !== "reverse") {
    throw new EditApiError("INVALID_ARGUMENT", "direction must be one of forward, reverse", "$.direction", ["forward", "reverse"], direction);
  }
  const supplied = parseEditPatch(record.patch);
  // shardEntriesForOperation already enforces the sharded path namespace;
  // repeat it for direct callers that bypass the file adapter.
  const expectedEntries = shardEntriesForOperation(shell, "save", record);
  if (!semanticEqual([...maps.keys()].sort(), [...expectedEntries].sort())) {
    throw new EditApiError("INVALID_PATCH", "loaded shards do not match the entries inferred from patch paths", "$.patch");
  }
  const before = shardedView(shell, maps);
  const applied = applyEditPatchValue(before, supplied, direction);
  const after = assertLogicalResult(before, applied);
  validateLogicalResult(before, after, encodings);
  const patch = createEditPatch(before, after);
  const changed = patch.changes.length > 0;
  const shardOutputs = Object.create(null) as Record<string, string>;
  if (changed) {
    for (const [entry, map] of Object.entries(after.shards)) {
      if (!semanticEqual(before.shards[entry], map)) {
        shardOutputs[entry] = serializeShard(map, encodings.get(entry) ?? "json");
      }
    }
  }
  const response: EditSuccess = {
    ok: true,
    command: "save",
    project: summary(after.shell, after),
    changed,
    addresses: supplied.changes.map((change) => change.path || "$"),
    diff: patch.changes,
    patch,
    result: {
      direction,
      beforeHash: semanticHash(before),
      afterHash: semanticHash(after),
    },
  };
  return {
    response,
    ...(changed ? { output: { shell: serializeShell(after.shell), shards: shardOutputs } } : {}),
  };
}

function validationErrors(error: unknown): { path: string; msg: string }[] {
  if (error instanceof EditApiError) {
    if (Array.isArray(error.details)) return error.details as { path: string; msg: string }[];
    return [{ path: error.path ?? "$", msg: error.message }];
  }
  return [{ path: "$", msg: error instanceof Error ? error.message : String(error) }];
}

/** Execute a ProjectShell operation over exactly the shard sources selected
 * by shardEntriesForOperation. Pure inline executeEditOperation remains
 * unchanged and continues to reject shells without a host shard source. */
export function executeShardedEditOperation(
  shellSource: string,
  shardSources: Readonly<Record<string, string>>,
  commandValue: string,
  rawArgs: unknown = {},
): ShardedEditExecution {
  try {
    const shell = loadValidatedProjectShell(shellSource);
    const encodings = new Map<string, ShardEncoding>();
    return executeValidatedShardedEditOperation(shell, shardSources, commandValue, rawArgs, false, false, sha256Text, encodings);
  } catch (error) {
    if (commandValue === "validate") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(shellSource);
      } catch {
        parsed = {};
      }
      const record = isRecord(parsed) ? parsed : {};
      const project: ProjectSummary = {
        format: typeof record.format === "string" ? record.format : "unknown",
        title: typeof record.title === "string" ? record.title : "unknown",
        documentKind: "shell",
        editable: true,
        mapCount: Array.isArray(record.mapIndex) ? record.mapIndex.length : 0,
        revision: semanticHash(parsed),
      };
      return {
        response: {
          ok: true,
          command: "validate",
          project,
          changed: false,
          addresses: [],
          diff: [],
          result: { valid: false, errors: validationErrors(error) },
        },
      };
    }
    return failure(commandValue || undefined, error);
  }
}
