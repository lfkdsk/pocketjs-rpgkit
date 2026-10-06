// editor/api/materialize.ts — convert between an inline rpgkit-project/v1
// document and a sharded ProjectShell on disk.
//
//   direction "inline": shell + shards  -> one inline JSON document
//   direction "pack":   inline document -> shell + per-map shard files
//
// Both directions are deterministic: pack uses splitProjectMaps (canonical
// shell, canonical/encoder shard bytes), inline emits the editor's canonical
// serializeProject form. pack(materialize(shell)) reproduces a shell produced
// by splitProjectMaps byte-for-byte, and materialize(pack(project))
// reproduces serializeProject(project) byte-for-byte. A shell that mixed
// transports (some maps JSON, some compact) round-trips byte-for-byte through
// the default two-step flow: materialize inline records each map's transport
// in a sidecar next to the document it wrote, and a default pack reads that
// sidecar and reproduces every entry path and encoding. `encoding` or
// `fromShell` on pack overrides the recorded transports.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MapDef, Project, ProjectShell } from "../../src/engine/types.ts";
import { canonicalJson } from "../../src/engine/save.ts";
import { loadProject, serializeProject } from "../engine/document.ts";
import { splitProjectMaps, type MapEntryEncoding } from "../../tools/lib/map-project.ts";
import { EditApiError } from "./operations.ts";
import { loadValidatedMapShard, loadValidatedProjectShell, shardEncodingOf } from "./sharded.ts";
import { confinedShardPath, confineWithinRoot } from "./file.ts";

export const MATERIALIZE_COMMAND = "materialize" as const;

export interface MaterializeRequest {
  /** "inline": a shell file. "pack": an inline project file. */
  file: string;
  direction: "inline" | "pack";
  /** inline direction: materialize just this map (a MapDef document). */
  map?: string;
  /** inline: output file (required for a full project). pack: output
   *  directory (required). */
  out?: string;
  /** pack direction: shard encoding. Defaults to "auto" (compact when it
   *  is smaller), which reproduces an importer-built shell. An explicit
   *  value opts out of the transports the inline step recorded. */
  encoding?: MapEntryEncoding;
  /** pack direction: preserve each map's on-disk transport (JSON or
   *  compact) and entry path from this shell — the shell the inline
   *  document was materialized from. Overrides the recorded transports.
   *  Without this or an explicit `encoding`, pack uses the sidecar the
   *  inline step wrote next to the input document, so a shell that mixed
   *  transports (e.g. an importer's oversize-shard JSON fallback)
   *  round-trips byte-for-byte through the default flow. */
  fromShell?: string;
  dryRun?: boolean;
  /** Optional MCP safety boundary. Symlinks are resolved before this
   *  check. */
  root?: string;
}

export interface MaterializeSuccess {
  ok: true;
  command: typeof MATERIALIZE_COMMAND;
  file: string;
  dryRun: boolean;
  written: boolean;
  writtenFiles: string[];
  result: {
    direction: "inline" | "pack";
    maps: number;
    map?: string;
    out?: string;
    bytes: number;
    /** pack direction: the encoding chosen per map id. */
    encodings?: Record<string, "json" | "compact">;
    /** pack direction: where the per-map transports came from: "sidecar"
     *  (the default, recorded by the inline step next to the document) or
     *  "fromShell" (explicit). Absent when no transports were applied and
     *  `encoding` decided every map. */
    transportsSource?: "sidecar" | "fromShell";
    /** inline direction without --out: the materialized text. */
    text?: string;
  };
}

export interface MaterializeFailure {
  ok: false;
  command: typeof MATERIALIZE_COMMAND;
  file: string;
  dryRun: boolean;
  written: false;
  error: {
    code: string;
    message: string;
    path?: string;
    expected?: unknown;
    actual?: unknown;
    details?: unknown;
  };
}

export type MaterializeResponse = MaterializeSuccess | MaterializeFailure;

function failure(request: MaterializeRequest, error: unknown): MaterializeFailure {
  const known = error instanceof EditApiError
    ? error
    : new EditApiError("INVALID_DOCUMENT", error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    command: MATERIALIZE_COMMAND,
    file: request.file,
    dryRun: request.dryRun === true,
    written: false,
    error: {
      code: known.code,
      message: known.message,
      ...(known.path === undefined ? {} : { path: known.path }),
      ...(known.expected === undefined ? {} : { expected: known.expected }),
      ...(known.actual === undefined ? {} : { actual: known.actual }),
      ...(known.details === undefined ? {} : { details: known.details }),
    },
  };
}

function usageError(message: string, expected?: unknown): never {
  throw new EditApiError("CLI_USAGE", message, "$.args", expected);
}

/** Suffix of the transport sidecar a full-project materialize writes next
 *  to its inline document, so a default pack can reproduce the shell's
 *  per-map transports without a second input. */
const TRANSPORTS_SIDECAR = ".rpgkit-transports";
const TRANSPORTS_KIND = "rpgkit-materialize-transports/1";

interface TransportEntry {
  entry: string;
  encoding: "json" | "compact";
}

type TransportMap = Map<string, TransportEntry>;

function transportsSidecarPath(file: string): string {
  return `${file}${TRANSPORTS_SIDECAR}`;
}

/** A transport entry must be a canonical relative path under `maps/`: the
 *  splitter only ever emits `maps/<id>.<ext>`, and an entry with an absolute
 *  root, `..`/`.` segments, backslashes or empty segments could publish a
 *  shard outside the output directory. Rejected as INVALID_DOCUMENT when
 *  reading a recorded sidecar or a fromShell reference. */
function assertCanonicalMapsEntry(entry: string, where: string): void {
  const reason =
    entry.length === 0 ? "is empty"
    : isAbsolute(entry) ? "must not be absolute"
    : entry.includes("\\") ? "must not contain backslashes"
    : !entry.startsWith("maps/") ? "must be a relative path under maps/"
    : entry.split("/").some((part) => part === "" || part === "." || part === "..")
      ? "must not contain empty, '.' or '..' segments"
    : null;
  if (reason !== null) {
    throw new EditApiError(
      "INVALID_DOCUMENT",
      `${where}: transport entry ${JSON.stringify(entry)} ${reason}`,
      "$.file",
      "a canonical relative path under maps/",
      entry,
    );
  }
}

/** Each map's on-disk transport in a loaded shell: its entry path plus the
 *  JSON/compact encoding (sniffed from the shard for other extensions). */
function collectShellTransports(
  shell: ProjectShell,
  shellFile: string,
  root: string | undefined,
): TransportMap {
  const boundary = root ?? dirname(shellFile);
  const transports = new Map<string, TransportEntry>();
  for (const meta of shell.mapIndex) {
    assertCanonicalMapsEntry(meta.entry, `shell ${shellFile} map ${meta.id}`);
    let encoding: "json" | "compact";
    if (meta.entry.endsWith(".rkm")) encoding = "compact";
    else if (meta.entry.endsWith(".json")) encoding = "json";
    else {
      const path = confinedShardPath(shellFile, boundary, meta.entry);
      encoding = shardEncodingOf(readFileSync(path, "utf8"));
    }
    transports.set(meta.id, { entry: meta.entry, encoding });
  }
  return transports;
}

function serializeTransportsSidecar(transports: TransportMap): string {
  const out: Record<string, TransportEntry> = {};
  for (const [id, entry] of transports) out[id] = entry;
  return JSON.stringify({ version: 1, kind: TRANSPORTS_KIND, transports: out });
}

/** The transports recorded next to an inline document by a materialize
 *  inline run, or undefined when no sidecar is present. A malformed sidecar
 *  is a hard failure: silently falling back to `encoding` could publish a
 *  shell that does not round-trip. */
function readTransportsSidecar(file: string, root: string | undefined): TransportMap | undefined {
  const path = transportsSidecarPath(file);
  if (!existsSync(path)) return undefined;
  if (root !== undefined) {
    const confined = confineWithinRoot(root, path);
    if (confined === null) {
      throw new EditApiError(
        "PATH_OUTSIDE_ROOT",
        "transport sidecar resolves outside the configured project root",
        "$.file",
        root,
        path,
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EditApiError(
      "MATERIALIZE_TRANSPORTS_INVALID",
      `cannot parse transport sidecar ${path}: ${error instanceof Error ? error.message : String(error)}`,
      "$.file",
    );
  }
  const invalid = (detail: string): never => {
    throw new EditApiError("MATERIALIZE_TRANSPORTS_INVALID", `${path}: ${detail}`, "$.file");
  };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("sidecar is not an object");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) invalid("unsupported sidecar version");
  if (record.kind !== TRANSPORTS_KIND) invalid("unexpected sidecar kind");
  if (typeof record.transports !== "object" || record.transports === null || Array.isArray(record.transports)) {
    invalid("transports is not an object");
  }
  const transports = new Map<string, TransportEntry>();
  for (const [id, value] of Object.entries(record.transports as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EditApiError("MATERIALIZE_TRANSPORTS_INVALID", `${path}: transport ${id} is not an object`, "$.file");
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.entry !== "string" || entry.entry.length === 0) {
      throw new EditApiError("MATERIALIZE_TRANSPORTS_INVALID", `${path}: transport ${id} has no entry path`, "$.file");
    }
    assertCanonicalMapsEntry(entry.entry, `${path}: transport ${id}`);
    if (entry.encoding !== "json" && entry.encoding !== "compact") {
      throw new EditApiError("MATERIALIZE_TRANSPORTS_INVALID", `${path}: transport ${id} has a bad encoding`, "$.file");
    }
    transports.set(id, { entry: entry.entry, encoding: entry.encoding });
  }
  return transports;
}

function assertWithinRoot(root: string | undefined, path: string, label: string): string {
  const abs = resolve(path);
  if (root === undefined) return abs;
  // Symlink-safe: an output leaf may not exist yet, so resolve the deepest
  // existing ancestor and confirm it stays inside the root.
  const confined = confineWithinRoot(root, abs);
  if (confined === null) {
    throw new EditApiError("PATH_OUTSIDE_ROOT", `${label} resolves outside the configured project root`, "$.out", root, abs);
  }
  return confined;
}

/** Resolve the input file, enforcing the MCP root boundary when set. */
function resolveInputFile(request: MaterializeRequest): string {
  const abs = resolve(request.file);
  if (request.root === undefined) return abs;
  const confined = confineWithinRoot(request.root, abs);
  if (confined === null) {
    throw new EditApiError("PATH_OUTSIDE_ROOT", "input file resolves outside the configured project root", "$.file", request.root, abs);
  }
  return confined;
}

/** Strip the shell-only fields and assemble the inline project. The result
 *  is re-canonicalized: the shell's keys are sorted but `maps` would
 *  otherwise append last, so serializeProject could not reproduce a
 *  canonical inline document byte-for-byte. */
function assembleInline(shell: ProjectShell, maps: readonly MapDef[]): Project {
  const {
    mapIndex: _mapIndex,
    mapManifestHash: _mapManifestHash,
    mapSchemaHash: _mapSchemaHash,
    ...globals
  } = shell;
  return JSON.parse(canonicalJson({ ...globals, maps })) as Project;
}

function materializeInline(request: MaterializeRequest): MaterializeResponse {
  const file = resolveInputFile(request);
  const source = readFileSync(file, "utf8");
  const shell = loadValidatedProjectShell(source);
  const root = request.root ?? dirname(file);
  const dryRun = request.dryRun === true;

  if (request.map !== undefined) {
    const meta = shell.mapIndex.find((item) => item.id === request.map);
    if (!meta) {
      throw new EditApiError(
        "MAP_NOT_FOUND",
        `map ${JSON.stringify(request.map)} does not exist; choose one of: ${shell.mapIndex.map((item) => item.id).join(", ")}`,
        "$.map",
        shell.mapIndex.map((item) => item.id),
        request.map,
      );
    }
    const path = confinedShardPath(file, root, meta.entry);
    const map = loadValidatedMapShard(shell, meta.entry, readFileSync(path, "utf8"));
    const text = serializeProject(map as unknown as Project);
    const out = request.out === undefined ? undefined : assertWithinRoot(request.root, request.out, "output file");
    const writtenFiles: string[] = [];
    if (out !== undefined && !dryRun) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, text);
      writtenFiles.push(out);
    }
    return {
      ok: true,
      command: MATERIALIZE_COMMAND,
      file,
      dryRun,
      written: writtenFiles.length > 0,
      writtenFiles,
      result: {
        direction: "inline",
        maps: 1,
        map: request.map,
        ...(out === undefined ? {} : { out }),
        bytes: Buffer.byteLength(text, "utf8"),
        ...(out === undefined ? { text } : {}),
      },
    };
  }

  if (request.out === undefined) {
    usageError("materialize of a full project requires --out <file> (use --map for a single map without a file)");
  }
  const out = assertWithinRoot(request.root, request.out, "output file");
  const maps = shell.mapIndex.map((meta) => {
    const path = confinedShardPath(file, root, meta.entry);
    return loadValidatedMapShard(shell, meta.entry, readFileSync(path, "utf8"));
  });
  const project = assembleInline(shell, maps);
  const text = serializeProject(project);
  const writtenFiles: string[] = [];
  if (!dryRun) {
    mkdirSync(dirname(out), { recursive: true });
    // Record the shell's per-map transports next to the document so a
    // default pack reproduces a mixed-transport shell byte-for-byte. The
    // sidecar is staged first: if it cannot be written, the document is
    // not left behind without it.
    const sidecar = assertWithinRoot(request.root, transportsSidecarPath(out), "transport sidecar");
    writeFileSync(sidecar, serializeTransportsSidecar(collectShellTransports(shell, file, request.root)));
    writtenFiles.push(sidecar);
    writeFileSync(out, text);
    writtenFiles.push(out);
  }
  return {
    ok: true,
    command: MATERIALIZE_COMMAND,
    file,
    dryRun,
    written: writtenFiles.length > 0,
    writtenFiles,
    result: { direction: "inline", maps: maps.length, out, bytes: Buffer.byteLength(text, "utf8") },
  };
}

/** The per-map transport (entry path + JSON/compact encoding) of a reference
 *  shell, so a pack can reproduce a mixed-transport shell byte-for-byte. The
 *  encoding follows the entry extension; an unrecognized extension is
 *  detected from the shard content. */
function transportsFromShell(request: MaterializeRequest): TransportMap {
  const abs = resolve(request.fromShell!);
  if (request.root !== undefined) {
    const confined = confineWithinRoot(request.root, abs);
    if (confined === null) {
      throw new EditApiError("PATH_OUTSIDE_ROOT", "fromShell resolves outside the configured project root", "$.fromShell", request.root, abs);
    }
  }
  const shell = loadValidatedProjectShell(readFileSync(abs, "utf8"));
  return collectShellTransports(shell, abs, undefined);
}

function materializePack(request: MaterializeRequest): MaterializeResponse {
  const file = resolveInputFile(request);
  const source = readFileSync(file, "utf8");
  const loaded = loadProject(source);
  if (loaded.errors.length > 0) {
    const first = loaded.errors[0]!;
    throw new EditApiError("INVALID_DOCUMENT", `${first.path}: ${first.msg}`, first.path, undefined, undefined, loaded.errors);
  }
  const project = loaded.project;
  if (request.out === undefined) {
    usageError("pack direction requires --out <directory>");
  }
  const out = assertWithinRoot(request.root, request.out, "output directory");
  const encoding: MapEntryEncoding = request.encoding ?? "auto";
  if (encoding !== "json" && encoding !== "compact" && encoding !== "auto") {
    usageError(`encoding must be one of json, compact, auto`, ["json", "compact", "auto"]);
  }
  // An explicit fromShell or encoding opts out of the recorded transports.
  // With neither, a default pack reads the sidecar the inline step wrote
  // next to the document, so a mixed-transport shell round-trips with no
  // flags; a document without a sidecar falls back to `encoding`.
  let transports: TransportMap | undefined;
  let transportsSource: "sidecar" | "fromShell" | undefined;
  if (request.fromShell !== undefined) {
    transports = transportsFromShell(request);
    transportsSource = "fromShell";
  } else if (request.encoding === undefined) {
    transports = readTransportsSidecar(file, request.root);
    if (transports !== undefined) transportsSource = "sidecar";
  }
  const split = splitProjectMaps(project, {
    entryEncoding: encoding,
    ...(transports === undefined ? {} : { transports }),
  });
  // The packed output must reopen through the editor's own validation gates,
  // so a pack can never publish a project the editor would refuse (an
  // unknown start map, a stale manifest, a checksum mismatch).
  const packedShell = loadValidatedProjectShell(split.shellText);
  for (const entry of split.entries) {
    loadValidatedMapShard(packedShell, entry.path, entry.text);
  }
  const shellOut = join(out, "project.json");
  if (existsSync(shellOut)) {
    throw new EditApiError(
      "MATERIALIZE_TARGET_EXISTS",
      `refusing to overwrite an existing shell at ${shellOut}; remove it or choose a fresh --out`,
      "$.out",
      "a directory without project.json",
      shellOut,
    );
  }
  // Pack publishes a fresh tree: refuse every existing target, not just the
  // shell, so a non-file target (a directory) cannot fail the publish halfway
  // through and leave earlier shards on disk.
  const targets = [
    ...split.entries.map((entry) => ({ path: join(out, entry.path), text: entry.text })),
    { path: shellOut, text: split.shellText },
  ];
  for (const target of targets) {
    if (existsSync(target.path)) {
      throw new EditApiError(
        "MATERIALIZE_TARGET_EXISTS",
        `refusing to overwrite an existing file at ${target.path}; choose a fresh --out`,
        "$.out",
        "a directory without project files",
        target.path,
      );
    }
  }
  const dryRun = request.dryRun === true;
  // Confine every publish target before staging the first file. Entry paths
  // are validated when the transports are read, but a symlinked ancestor
  // under out (e.g. a maps/ link) could still redirect the publish outside
  // the output directory; with an MCP root, confine to the root too. This
  // runs before the dry-run branch so a dry run refuses the same targets a
  // real pack would; a not-yet-created out has no symlinks to police, and a
  // refused pack leaves no trace because nothing was created yet.
  if (existsSync(out)) {
    for (const target of targets) {
      if (confineWithinRoot(out, target.path) === null ||
        (request.root !== undefined && confineWithinRoot(request.root, target.path) === null)) {
        throw new EditApiError(
          "PATH_OUTSIDE_ROOT",
          `publish target ${target.path} resolves outside the output directory${request.root !== undefined ? " or the configured project root" : ""}`,
          "$.out",
          request.root ?? out,
          target.path,
        );
      }
    }
  }
  const writtenFiles: string[] = [];
  if (!dryRun) {
    // Stage every output next to its target, then publish shards first and
    // the shell last (the shell is the commit marker). A failure removes
    // everything this pack created, so a failed pack never leaves a partial
    // project behind.
    const createdOut = !existsSync(out);
    mkdirSync(out, { recursive: true });
    const staged: { path: string; temporary: string }[] = [];
    const published: string[] = [];
    try {
      for (const target of targets) {
        mkdirSync(dirname(target.path), { recursive: true });
        const temporary = `${target.path}.rpgkit-materialize-${process.pid}-${randomUUID()}.tmp`;
        writeFileSync(temporary, target.text, { encoding: "utf8", flag: "wx" });
        staged.push({ path: target.path, temporary });
      }
      for (const item of staged) {
        renameSync(item.temporary, item.path);
        published.push(item.path);
      }
    } catch (error) {
      for (const path of published) rmSync(path, { force: true });
      for (const item of staged) rmSync(item.temporary, { force: true });
      if (createdOut) rmSync(out, { recursive: true, force: true });
      throw new EditApiError(
        "WRITE_FAILED",
        `could not publish the packed project under ${out}: ${error instanceof Error ? error.message : String(error)}`,
        "$.out",
      );
    }
    writtenFiles.push(...targets.map((target) => target.path));
  }
  const encodings: Record<string, "json" | "compact"> = {};
  for (const entry of split.entries) encodings[entry.meta.id] = entry.encoding;
  return {
    ok: true,
    command: MATERIALIZE_COMMAND,
    file,
    dryRun,
    written: writtenFiles.length > 0,
    writtenFiles,
    result: {
      direction: "pack",
      maps: split.entries.length,
      out,
      bytes: Buffer.byteLength(split.shellText, "utf8") +
        split.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, "utf8"), 0),
      encodings,
      ...(transportsSource === undefined ? {} : { transportsSource }),
    },
  };
}

/** Convert between an inline project and a sharded ProjectShell. See the
 *  module comment for the byte-identity contract. */
export function runMaterializeCommand(request: MaterializeRequest): MaterializeResponse {
  try {
    if (request.direction !== "inline" && request.direction !== "pack") {
      usageError("direction must be one of inline, pack", ["inline", "pack"]);
    }
    return request.direction === "inline" ? materializeInline(request) : materializePack(request);
  } catch (error) {
    return failure(request, error);
  }
}
