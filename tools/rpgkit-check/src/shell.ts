// tools/rpgkit-check/src/shell.ts — load a sharded ProjectShell for checking.
//
// The editor exports inline Projects (maps in the document); a ProjectShell
// keeps the maps in the files named by mapIndex[].entry (JSON or rpgkit-map/1
// compact). A check materializes the shell into the same inline Project the
// checks consume: a full pass loads every shard, a --map pass loads only the
// addressed shard and stands the other maps up as dimension stubs so catalog
// lookups (transfer targets, start bounds, reachability ids) stay exact.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateSchema } from "../../../src/engine/schema-validate.ts";
import { sha256Text, validateMapDef } from "../../../src/engine/map-repository.ts";
import { decodeCompactMap, isCompactMapValue } from "../../../src/engine/compact-map.ts";
import type { MapDef, Project, ProjectShell } from "../../../src/engine/types.ts";
import { loadValidatedProjectShell } from "../../../editor/api/sharded.ts";
import { PROJECT_SCHEMA } from "./doc.ts";
import { makeFinding, type Finding } from "./finding.ts";
import { CheckLoadError } from "./errors.ts";

export interface LoadedShell {
  /** Inline view: every map for a full pass, or the target map plus stubs. */
  project: Project;
  /** Shell and shard load/schema findings (error severity). */
  schemaErrors: Finding[];
  shell: ProjectShell;
  /** The map id a --map pass scoped to, if any. */
  scopedMap: string | null;
  /** Entries whose shards were actually loaded (all, or just the target). */
  loadedEntries: string[];
}

function shellFinding(code: string, message: string, pointer?: string): Finding {
  return makeFinding(
    code,
    "error",
    message,
    "pass the editor's inline export, or fix the shell/shard",
    pointer === undefined ? {} : { pointer },
  );
}

/** Is a realpath'ed shard inside its boundary (the shell's directory, or an
 *  explicit root)? The boundary is realpath'ed too, so a symlinked ancestor
 *  on either side is accounted for. */
function confinedToBoundary(real: string, boundary: string): boolean {
  let boundaryReal: string;
  try {
    boundaryReal = realpathSync(boundary);
  } catch {
    return false;
  }
  const fromBoundary = relative(boundaryReal, real);
  return fromBoundary !== ".." &&
    !fromBoundary.startsWith(`..${sep}`) &&
    !isAbsolute(fromBoundary);
}

/** Realpath of a shard entry confined to the root (the shell's directory by
 *  default), or null when the entry traverses, escapes through a symlink,
 *  or does not exist. The incremental pass uses this before hashing the
 *  bytes on disk for a cache hit. */
export function realShardPath(shellDir: string, entry: string, root?: string): string | null {
  if (isAbsolute(entry) || entry.split(/[\\/]+/).some((part) => part === "..")) return null;
  let real: string;
  try {
    real = realpathSync(resolve(shellDir, entry));
  } catch {
    return null;
  }
  return confinedToBoundary(real, root ?? shellDir) ? real : null;
}

/** A map-shaped stub carrying only what catalog lookups need: id and real
 *  dimensions from the index. It has no events and a void ground, so the
 *  per-map lint walks produce nothing for it. */
export function stubMap(id: string, width: number, height: number): MapDef {
  return { id, name: "", width, height, ground: new Array<string | null>(width * height).fill(null) };
}

/** One mapIndex entry in the shape loadShard wants. */
export interface ShardMeta {
  entry: string;
  sha256: string;
  id: string;
  width: number;
  height: number;
}

/** Read and decode one shard file, verifying its checksum and validating its
 *  content. Problems become error findings; a shard that cannot be decoded
 *  or validated contributes a stub so the rest of the pass still runs.
 *  `root` confines where a shard may resolve (the shell's directory by
 *  default): a mapIndex entry is a package-style relative path, but a
 *  symlink inside the project can still point outside it, and the resolved
 *  target is checked before any byte is read. `source` skips the read when
 *  the caller already has the bytes (the incremental pass hashes every
 *  shard before deciding what to re-check). */
export function loadShard(
  shellDir: string,
  entry: string,
  expectedSha: string,
  meta: { id: string; width: number; height: number },
  findings: Finding[],
  root?: string,
  source?: string,
): MapDef {
  const stub = stubMap(meta.id, meta.width, meta.height);
  if (isAbsolute(entry) || entry.split(/[\\/]+/).some((part) => part === "..")) {
    findings.push(shellFinding("doc/shell", `shard entry ${JSON.stringify(entry)} is not a confined relative path`, entry));
    return stub;
  }
  let real: string;
  try {
    real = realpathSync(resolve(shellDir, entry));
  } catch (error) {
    findings.push(shellFinding("doc/shell", `cannot read shard ${JSON.stringify(entry)}: ${String(error)}`, entry));
    return stub;
  }
  if (!confinedToBoundary(real, root ?? shellDir)) {
    findings.push(shellFinding("doc/shell", `shard entry ${JSON.stringify(entry)} resolves outside the project root`, entry));
    return stub;
  }
  let text: string;
  if (source !== undefined) {
    text = source;
  } else {
    try {
      text = readFileSync(real, "utf8");
    } catch (error) {
      findings.push(shellFinding("doc/shell", `cannot read shard ${JSON.stringify(entry)}: ${String(error)}`, entry));
      return stub;
    }
  }
  if (sha256Text(text) !== expectedSha) {
    findings.push(shellFinding("doc/shard-checksum", `checksum mismatch for shard ${JSON.stringify(entry)} (map ${meta.id})`, entry));
    return stub;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    findings.push(shellFinding("doc/schema", `shard ${JSON.stringify(entry)} is not valid JSON: ${String(error)}`, entry));
    return stub;
  }
  let map: MapDef;
  if (isCompactMapValue(parsed)) {
    try {
      map = decodeCompactMap(parsed);
    } catch (error) {
      findings.push(shellFinding("doc/schema", `shard ${JSON.stringify(entry)} compact envelope: ${String(error)}`, entry));
      return stub;
    }
  } else {
    map = parsed as MapDef;
  }
  try {
    validateMapDef(map);
  } catch (error) {
    findings.push(shellFinding("doc/schema", `shard ${JSON.stringify(entry)}: ${error instanceof Error ? error.message : String(error)}`, entry));
    return stub;
  }
  if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
    findings.push(shellFinding(
      "doc/shell",
      `shard ${JSON.stringify(entry)} metadata mismatch: index has ${meta.id} ${meta.width}x${meta.height}, shard has ${map.id} ${map.width}x${map.height}`,
      entry,
    ));
    return stub;
  }
  return map;
}

/** A validated shell without any shard loaded: what a full materialization
 *  and an incremental pass share before they diverge on shard loading. */
export interface ShellHeader {
  abs: string;
  text: string;
  shell: ProjectShell;
  /** Shell-level schema/structural findings (error severity). */
  findings: Finding[];
  dir: string;
}

/** Read and validate the shell file itself (schema + index + manifest +
 *  start metadata), without touching a shard. */
export function loadShellHeader(shellFile: string): ShellHeader {
  const abs = resolve(shellFile);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (error) {
    throw new CheckLoadError(`rpgkit-check: cannot read ${abs}: ${String(error)}`, [
      shellFinding("doc/unreadable", `cannot read ${abs}: ${String(error)}`),
    ]);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new CheckLoadError(`rpgkit-check: ${abs} is not valid JSON`, [
      shellFinding("doc/invalid-json", `${abs} is not valid JSON: ${String(error)}`),
    ]);
  }

  const findings: Finding[] = validateSchema(PROJECT_SCHEMA, doc).map((ve) =>
    shellFinding("doc/schema", `schema violation at ${ve.path}: ${ve.msg}`, ve.path),
  );

  let shell: ProjectShell;
  try {
    shell = loadValidatedProjectShell(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CheckLoadError(`rpgkit-check: ${message}`, [
      ...findings,
      shellFinding("doc/shell", message),
    ]);
  }
  return { abs, text, shell, findings, dir: dirname(abs) };
}

/** Materialize a shell file into an inline Project for the checks.
 *  With `map`, only that map's shard is loaded; the other maps are stubs.
 *  `root` confines shard resolution (the shell's directory by default; the
 *  MCP server passes its own root). */
export function loadShellProject(shellFile: string, map?: string, root?: string): LoadedShell {
  const header = loadShellHeader(shellFile);
  const { shell, findings } = header;

  let target: string | null = null;
  let entries: ShardMeta[];
  if (map !== undefined) {
    const meta = shell.mapIndex.find((item) => item.id === map);
    if (!meta) {
      throw new CheckLoadError(
        `rpgkit-check: map ${JSON.stringify(map)} is not in the shell's mapIndex`,
        [shellFinding("doc/shell", `unknown map ${JSON.stringify(map)}`)],
      );
    }
    target = map;
    entries = [{ entry: meta.entry, sha256: meta.sha256, id: meta.id, width: meta.width, height: meta.height }];
  } else {
    entries = shell.mapIndex.map((meta) => ({
      entry: meta.entry,
      sha256: meta.sha256,
      id: meta.id,
      width: meta.width,
      height: meta.height,
    }));
  }

  const byId = new Map<string, MapDef>();
  const loadedEntries: string[] = [];
  for (const item of entries) {
    byId.set(item.id, loadShard(header.dir, item.entry, item.sha256, item, findings, root));
    loadedEntries.push(item.entry);
  }
  const maps = shell.mapIndex.map((meta) => byId.get(meta.id) ?? stubMap(meta.id, meta.width, meta.height));

  const {
    mapIndex: _mapIndex,
    mapManifestHash: _mapManifestHash,
    mapSchemaHash: _mapSchemaHash,
    ...globals
  } = shell;
  const project: Project = { ...globals, maps };
  return { project, schemaErrors: findings, shell, scopedMap: target, loadedEntries };
}

/** Scope an inline project to one map: the target map keeps its content;
 *  every other map becomes a dimension stub so catalog lookups (transfer
 *  targets, start bounds, map ids) stay exact. The scoped lint's findings
 *  for the target map are identical to the full pass's findings for it. */
export function scopeProjectToMap(project: Project, mapId: string): Project {
  const target = project.maps.find((m) => m.id === mapId);
  if (!target) {
    throw new CheckLoadError(
      `rpgkit-check: map ${JSON.stringify(mapId)} is not in the document`,
      [shellFinding("doc/shell", `unknown map ${JSON.stringify(mapId)}`)],
    );
  }
  const maps = project.maps.map((m) => (m === target ? m : stubMap(m.id, m.width, m.height)));
  const { maps: _maps, ...globals } = project;
  return { ...globals, maps };
}
