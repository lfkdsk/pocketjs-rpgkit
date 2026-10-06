// tools/rpgkit-check/src/incremental.ts — incremental whole-project lint for
// a sharded ProjectShell.
//
// A cache next to the shell keys per-shard findings by two hashes: the
// checksum the shell's mapIndex declares and the SHA-256 of the shard's raw
// bytes on disk. Both must match for a hit, so a shard that drifted without a
// shell refresh (an external edit, a sync/restore, corruption) is re-checked
// and its checksum finding replayed. The byte hash is taken before UTF-8
// decoding on purpose: two byte sequences that decode to the same text (a
// BOM, an illegal byte, a newline difference) must still miss the cache. The document-global checks (usage
// pairing, reachability, common events, start) are recomputed every run from
// the merged digests — they are cheap compared to linting 263 maps. The
// cache is invalidated by the shell bytes, the map schema hash, and this
// module's lint version.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAP_SCHEMA_HASH, sha256Bytes, sha256Text } from "../../../src/engine/map-repository.ts";
import { canonicalJson } from "../../../src/engine/save.ts";
import type { MapDef, Project, ProjectShell } from "../../../src/engine/types.ts";
import {
  createLintContext,
  createUsageSink,
  lintCommonEvents,
  lintGlobal,
  lintMap,
  type LintContext,
  type Usage,
  type UsageSink,
} from "./lint.ts";
import { structuralFindings } from "./structure.ts";
import { loadShard, loadShellHeader, realShardPath, stubMap, type ShellHeader } from "./shell.ts";
import type { CheckReport, Finding, FindingLocation } from "./finding.ts";

/** Bump when lintMap's finding semantics change, so old caches re-lint. */
const LINT_VERSION = 1;

const CACHE_FILE = ".rpgkit-check-lint.json";

interface ShardUsage {
  switchReads: Record<string, FindingLocation>;
  switchWrites: Record<string, FindingLocation>;
  variableReads: Record<string, FindingLocation>;
  variableWrites: Record<string, FindingLocation>;
  sceneUses: Record<string, FindingLocation>;
  /** Direct `common` calls from this map (transitive closure is recomputed
   *  on merge from the shell's common events). */
  commonCalls: string[];
  /** Literal transfer target ids (common programs inlined). */
  edges: string[];
}

interface ShardCacheEntry {
  sha256: string;
  /** SHA-256 of the shard's raw bytes on disk when this entry was written,
   *  hashed before UTF-8 decoding. The index checksum is only the shell's
   *  declaration; an external edit, sync or corruption can drift a file
   *  without refreshing the shell, and two byte sequences can decode to the
   *  same text (a BOM, an illegal byte, a newline difference), so a cache
   *  hit requires both hashes to match. Null when the shard could not be
   *  read (its load finding is cached and replayed). */
  actualSha256: string | null;
  /** structuralFindings output for this map (duplicate event ids). */
  structural: Finding[];
  /** lintMap output for this map. */
  findings: Finding[];
  usage: ShardUsage;
  events: number;
  pages: number;
  commands: number;
}

interface LintCache {
  version: 3;
  lintVersion: number;
  schemaHash: string;
  /** Hash of the shell's globals plus the mapIndex structure (ids,
   *  dimensions, entries). Per-shard checksums are deliberately excluded:
   *  they are the per-entry cache keys, and an edit to one shard must not
   *  invalidate the other shards' cached findings. */
  shellKey: string;
  shards: Record<string, ShardCacheEntry>;
}

/** The cache-invalidation key for a shell: everything that can change a
 *  per-map finding except the shard bytes themselves. */
function shellCacheKey(shell: ProjectShell): string {
  const {
    mapIndex,
    mapManifestHash: _manifest,
    mapSchemaHash: _schema,
    ...globals
  } = shell;
  const structure = mapIndex.map(({ id, width, height, entry }) => ({ id, width, height, entry }));
  return sha256Text(canonicalJson({ globals, structure }));
}

function cachePath(header: ShellHeader): string {
  return join(header.dir, CACHE_FILE);
}

function readCache(header: ShellHeader, shellKey: string): LintCache | null {
  let text: string;
  try {
    text = readFileSync(cachePath(header), "utf8");
  } catch {
    return null;
  }
  try {
    const cache = JSON.parse(text) as LintCache;
    if (cache.version !== 3 || cache.lintVersion !== LINT_VERSION ||
      cache.schemaHash !== MAP_SCHEMA_HASH || cache.shellKey !== shellKey ||
      typeof cache.shards !== "object" || cache.shards === null) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function writeCache(header: ShellHeader, cache: LintCache): void {
  try {
    writeFileSync(cachePath(header), JSON.stringify(cache));
  } catch {
    // A read-only directory only disables the speedup; the check stands.
  }
}

function contributeCallers(ctx: LintContext, mapId: string, direct: readonly string[]): void {
  const reachable = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length > 0) {
    for (const called of ctx.commonCalls.get(queue.shift()!) ?? []) {
      if (!reachable.has(called)) {
        reachable.add(called);
        queue.push(called);
      }
    }
  }
  for (const id of reachable) {
    const callers = ctx.commonCallers.get(id) ?? new Set<string>();
    callers.add(mapId);
    ctx.commonCallers.set(id, callers);
  }
}

function mergeUsageEntry(
  map: Map<string, Usage>,
  id: string,
  kind: "reads" | "writes",
  loc: FindingLocation,
): void {
  const entry = map.get(id);
  if (!entry) {
    map.set(id, { reads: kind === "reads" ? [loc] : [], writes: kind === "writes" ? [loc] : [] });
    return;
  }
  // Earlier maps (merged first in index order) own the first location.
  if (entry[kind].length === 0) entry[kind] = [loc];
}

function mergeCachedUsage(ctx: LintContext, mapId: string, usage: ShardUsage): void {
  for (const [id, loc] of Object.entries(usage.switchReads)) mergeUsageEntry(ctx.switches, id, "reads", loc);
  for (const [id, loc] of Object.entries(usage.switchWrites)) mergeUsageEntry(ctx.switches, id, "writes", loc);
  for (const [id, loc] of Object.entries(usage.variableReads)) mergeUsageEntry(ctx.variables, id, "reads", loc);
  for (const [id, loc] of Object.entries(usage.variableWrites)) mergeUsageEntry(ctx.variables, id, "writes", loc);
  for (const [id, loc] of Object.entries(usage.sceneUses)) {
    if (!ctx.sceneIds.has(id)) ctx.sceneIds.set(id, loc);
  }
  contributeCallers(ctx, mapId, usage.commonCalls);
  ctx.edges.set(mapId, new Set(usage.edges));
}

interface Snapshot {
  switches: Set<string>;
  variables: Set<string>;
  scenes: Set<string>;
  pages: number;
  commands: number;
}

function snapshot(ctx: LintContext): Snapshot {
  return {
    switches: new Set(ctx.switches.keys()),
    variables: new Set(ctx.variables.keys()),
    scenes: new Set(ctx.sceneIds.keys()),
    pages: ctx.pageCount,
    commands: ctx.commandCount,
  };
}

/** A map's full usage digest from its sink: every switch/variable the map
 *  reads or writes (first location in the map), scene uses, common calls
 *  and transfer edges. This is what makes a cached map's contribution
 *  survive other maps being re-checked. */
function sinkToUsage(sink: UsageSink): ShardUsage {
  const first = (map: Map<string, Usage>, kind: "reads" | "writes"): Record<string, FindingLocation> => {
    const out: Record<string, FindingLocation> = {};
    for (const [id, entry] of map) {
      if (entry[kind].length > 0) out[id] = entry[kind][0]!;
    }
    return out;
  };
  return {
    switchReads: first(sink.switches, "reads"),
    switchWrites: first(sink.switches, "writes"),
    variableReads: first(sink.variables, "reads"),
    variableWrites: first(sink.variables, "writes"),
    sceneUses: Object.fromEntries(sink.scenes),
    commonCalls: sink.commonCalls,
    edges: [...sink.edges],
  };
}

/** Incremental whole-project lint for a shell project. Returns a report
 *  identical to the full materialized lint, but only changed shards are
 *  re-checked. `root` confines shard resolution (the MCP server passes its
 *  root); `writable: false` computes the cache in memory without persisting
 *  it (the MCP proposal-only mode). */
export async function lintShellIncremental(
  shellFile: string,
  options: { root?: string; writable?: boolean } = {},
): Promise<CheckReport> {
  const header = loadShellHeader(shellFile);
  const shellKey = shellCacheKey(header.shell);
  const previous = readCache(header, shellKey);

  const { shell, findings: shellFindings } = header;
  const {
    mapIndex: _mapIndex,
    mapManifestHash: _mapManifestHash,
    mapSchemaHash: _mapSchemaHash,
    ...globals
  } = shell;
  // The project the per-map walks see: real maps for shards checked this
  // run, dimension stubs for cached maps (catalog lookups stay exact).
  const scopedProject: Project = {
    ...globals,
    maps: shell.mapIndex.map((meta) => stubMap(meta.id, meta.width, meta.height)),
  };

  const ctx = createLintContext(scopedProject);

  const nextCache: LintCache = {
    version: 3,
    lintVersion: LINT_VERSION,
    schemaHash: MAP_SCHEMA_HASH,
    shellKey,
    shards: {},
  };

  let cachedCount = 0;
  let checkedCount = 0;
  let events = 0;
  const decoded = new Map<string, MapDef>();

  // Per-map findings, kept in map order so the report matches the full
  // pass: shell findings, all structural findings, all per-map findings,
  // then common events and the global checks.
  const structuralAll: Finding[] = [];
  const lintAll: Finding[] = [];
  const lateLoadFindings: Finding[] = [];

  ctx.findings.push(...shellFindings);

  for (let index = 0; index < shell.mapIndex.length; index++) {
    const meta = shell.mapIndex[index]!;
    const cached = previous?.shards[meta.entry];
    // Hash the shard's raw bytes on disk before trusting a cache hit: the
    // index checksum is only the shell's declaration, and an external edit,
    // sync or corruption can drift the file without refreshing it. The hash
    // is over bytes, not decoded text, so any byte-level drift still
    // misses — including one that decodes to the same text (an illegal byte
    // replaced by U+FFFD) and ones that decode to different text (a BOM, a
    // newline difference such as CRLF to LF). The decoded text is what the
    // checksum gate and the lint see.
    let actualSha: string | null = null;
    let source: string | undefined;
    const real = realShardPath(header.dir, meta.entry, options.root);
    if (real !== null) {
      try {
        const bytes = readFileSync(real);
        actualSha = sha256Bytes(bytes);
        source = bytes.toString("utf8");
      } catch {
        source = undefined;
      }
    }
    if (cached && cached.sha256 === meta.sha256 && cached.actualSha256 === actualSha) {
      cachedCount++;
      structuralAll.push(...cached.structural);
      lintAll.push(...cached.findings);
      mergeCachedUsage(ctx, meta.id, cached.usage);
      ctx.pageCount += cached.pages;
      ctx.commandCount += cached.commands;
      events += cached.events;
      nextCache.shards[meta.entry] = cached;
      continue;
    }
    checkedCount++;
    const loadFindings: Finding[] = [];
    const map = loadShard(header.dir, meta.entry, meta.sha256, meta, loadFindings, options.root, source);
    decoded.set(meta.id, map);
    scopedProject.maps[index] = map;
    // Shard load problems (checksum, envelope, schema) are this map's
    // structural findings and fail the check like inline doc/schema errors.
    const structural = [...loadFindings, ...structuralFindings({
      ...scopedProject,
      maps: [map],
    }).filter((finding) => finding.loc.map === map.id)];
    structuralAll.push(...structural);
    const before = snapshot(ctx);
    const f0 = ctx.findings.length;
    ctx.usageSink = createUsageSink();
    lintMap(ctx, scopedProject, map);
    const sink = ctx.usageSink;
    ctx.usageSink = null;
    const lintFindings = ctx.findings.slice(f0);
    // lintMap pushes into ctx.findings; the report is rebuilt below in
    // full-pass order (shell, structural, per-map), so drop them here.
    ctx.findings.length = f0;
    lintAll.push(...lintFindings);
    events += map.events?.length ?? 0;
    nextCache.shards[meta.entry] = {
      sha256: meta.sha256,
      actualSha256: actualSha,
      structural,
      findings: lintFindings,
      usage: sinkToUsage(sink),
      events: map.events?.length ?? 0,
      pages: ctx.pageCount - before.pages,
      commands: ctx.commandCount - before.commands,
    };
  }

  ctx.findings.push(...structuralAll, ...lateLoadFindings, ...lintAll);

  // Common events: a single-caller common event is checked against that
  // caller's events. Fresh maps are decoded already; a cached caller is
  // decoded on demand (one shard) without linting it.
  lintCommonEvents(ctx, scopedProject, (callerId) => {
    const fresh = decoded.get(callerId);
    if (fresh) return fresh;
    const meta = shell.mapIndex.find((item) => item.id === callerId);
    if (!meta) return null;
    const map = loadShard(header.dir, meta.entry, meta.sha256, meta, lateLoadFindings, options.root);
    decoded.set(callerId, map);
    return map;
  });
  lintGlobal(ctx, scopedProject);

  if (options.writable !== false) writeCache(header, nextCache);

  const bySeverity = ctx.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  return {
    check: "lint",
    findings: ctx.findings,
    summary: {
      maps: shell.mapIndex.length,
      events,
      pages: ctx.pageCount,
      commands: ctx.commandCount,
      cached: cachedCount,
      checked: checkedCount,
      ...bySeverity,
    },
  };
}
