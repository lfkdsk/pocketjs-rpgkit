// tests/sharded-project-e2e.test.ts — end-to-end flow on a compact-shard
// ProjectShell:
//
// 1. The edit API reads and writes compact rpgkit-map/1 shards directly,
//    without transcoding the whole project to JSON first.
// 2. rpgkit-check lints a ProjectShell directly, and materialize expands it
//    to an inline document.
// 3. lint --map checks one map by loading only its shard, and --incremental
//    re-checks only the shards whose bytes changed.
//
// The fixture is a 263-map compact-shard project like a large game import
// product.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runFileEdit } from "../editor/api/file.ts";
import { runMaterializeCommand } from "../editor/api/materialize.ts";
import { checkTool } from "../tools/rpgkit-check/src/registry.ts";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { encodeCompactMap } from "../tools/lib/compact-map.ts";
import { isCompactMapValue } from "../src/engine/compact-map.ts";
import { mapManifestHash, canonicalMapJson, sha256Text } from "../src/engine/map-repository.ts";
import type { Command, MapDef, Project, ProjectShell } from "../src/engine/types.ts";

const TEMP = join(import.meta.dir, `.edx1-e2e-${process.pid}-${randomUUID()}`);
const MAP_COUNT = 263;

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

const lint = checkTool("lint")!;

function transfer(map: string): Command {
  return { op: "transfer", map, x: 0, y: 0 };
}

function mapAt(index: number, count: number): MapDef {
  const id = `map-${String(index).padStart(3, "0")}`;
  return {
    id,
    name: `Map ${index}`,
    width: 20,
    height: 20,
    sheets: ["s"],
    ground: Array(400).fill("s.0"),
    events: index === count - 1
      ? [{
          id: "exit",
          x: 0,
          y: 0,
          pages: [{ trigger: "action", commands: [transfer("map-000")] }],
        }]
      : index % 50 === 0
        ? [{
            id: "npc",
            x: 1,
            y: 1,
            pages: [{
              trigger: "action",
              commands: [
                { op: "switch", id: `sw-${index}`, value: true },
                { op: "text", lines: ["hi"] },
              ],
            }],
          }]
        : [],
  };
}

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "edx1 e2e",
    tileSize: 16,
    start: { map: "map-000", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 1 }],
    items: [],
    maps: Array.from({ length: MAP_COUNT }, (_, index) => mapAt(index, MAP_COUNT)),
  };
}

/** Write a compact-encoded shell + shards (the importer's default). */
function writeCompactShell(root: string): { shellFile: string; shell: ProjectShell } {
  const split = splitProjectMaps(project(), { entryEncoding: "compact" });
  mkdirSync(root, { recursive: true });
  const shellFile = join(root, "project-shell.json");
  writeFileSync(shellFile, split.shellText);
  for (const entry of split.entries) {
    mkdirSync(dirname(join(root, entry.path)), { recursive: true });
    writeFileSync(join(root, entry.path), entry.text);
  }
  return { shellFile, shell: split.shell };
}

/** Write a shell whose shards mix transports: the named maps ship as JSON
 *  even when compact would be smaller (the importer's oversize-shard
 *  fallback), the rest as compact. Returns the shell file path. */
function writeMixedShell(root: string, jsonMaps: readonly string[]): { shellFile: string } {
  const proj = project();
  const split = splitProjectMaps(proj, { entryEncoding: "compact" });
  mkdirSync(root, { recursive: true });
  const shell: ProjectShell = JSON.parse(split.shellText) as ProjectShell;
  const jsonSet = new Set(jsonMaps);
  for (const entry of split.entries) {
    const map = proj.maps.find((m) => m.id === entry.meta.id)!;
    const useJson = jsonSet.has(entry.meta.id);
    const rel = useJson ? entry.path.replace(/\.rkm$/, ".json") : entry.path;
    const text = useJson ? canonicalMapJson(map) : entry.text;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    const meta = shell.mapIndex.find((item) => item.id === entry.meta.id)!;
    meta.entry = rel;
    meta.sha256 = sha256Text(text);
  }
  delete shell.mapManifestHash;
  shell.mapManifestHash = mapManifestHash(shell);
  const shellFile = join(root, "project-shell.json");
  writeFileSync(shellFile, JSON.stringify(shell));
  return { shellFile };
}

function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) visit(next);
      else files.set(next, readFileSync(join(root, next), "utf8"));
    }
  };
  visit(".");
  return files;
}

describe("sharded project end-to-end: direct compact edits, shell checks, materialize", () => {
  test("edit compact shards, check the shell, scope to one map, and go incremental", async () => {
    const root = join(TEMP, "proj");
    const { shellFile } = writeCompactShell(root);
    const before = snapshot(root);

    // (1) Edit a compact shard directly: no transcoding step.
    const edited = runFileEdit({
      command: "add-event",
      file: shellFile,
      args: {
        map: "map-000",
        event: {
          id: "edx1_npc",
          x: 2,
          y: 2,
          pages: [{ trigger: "action", commands: [{ op: "text", lines: ["edx1"] }] }],
        },
      },
    });
    expect(edited.ok).toBe(true);
    expect(edited.written).toBe(true);
    // The edited shard is still a compact envelope; every other shard and
    // the shell's catalog keep their exact bytes (the shell content changes
    // for the checksum refresh, so compare shards only).
    const after = snapshot(root);
    for (const [path, text] of before) {
      if (path.includes("map-000.rkm") || path.endsWith("project-shell.json")) continue;
      expect(after.get(path)).toBe(text);
    }
    const editedShard = after.get(join("maps", "map-000.rkm"))!;
    expect(isCompactMapValue(JSON.parse(editedShard))).toBe(true);
    const decoded = JSON.parse(editedShard) as { e?: unknown[] };
    expect(decoded.e).toBeDefined(); // events survived the compact re-encode

    // (2) rpgkit-check lints the shell directly — no materialize workaround.
    // The added event is clean, so the shell lint matches the unedited
    // inline oracle finding-for-finding.
    const full = (await lint.run({ file: shellFile })) as { summary: Record<string, unknown>; findings: { check: string; loc: { map?: string } }[] };
    expect(full.summary.maps).toBe(MAP_COUNT);
    const inline = lintProject(project());
    const codes = (list: { check: string; loc: { map?: string } }[]) =>
      list.map((f) => `${f.check}@${f.loc.map ?? ""}`).sort();
    expect(codes(full.findings)).toEqual(codes(inline.findings));
    // A second run is deterministic.
    const full2 = (await lint.run({ file: shellFile })) as { findings: unknown[] };
    expect(full2.findings).toEqual(full.findings);

    // materialize expands the shell to an inline document.
    const inlineOut = join(TEMP, "materialized.json");
    const mat = runMaterializeCommand({ file: shellFile, direction: "inline", out: inlineOut });
    expect(mat.ok).toBe(true);
    if (mat.ok) expect(mat.result.maps).toBe(MAP_COUNT);

    // (3) --map checks one map, loading only its shard.
    const scoped = (await lint.run({ file: shellFile, map: "map-000" })) as {
      summary: Record<string, unknown>;
      findings: unknown[];
    };
    expect(scoped.summary.scopedMap).toBe("map-000");
    expect(scoped.summary.maps).toBe(1);
    const t0 = Date.now();
    await lint.run({ file: shellFile, map: "map-050" });
    const scopedMs = Date.now() - t0;
    // Generous CI bound; the real Tuxemon project measures ~0.24s.
    expect(scopedMs).toBeLessThan(5000);

    // Incremental: prime, then a no-op re-run checks nothing.
    const prime = (await lint.run({ file: shellFile, incremental: true })) as { summary: Record<string, unknown> };
    expect(prime.summary.checked).toBe(MAP_COUNT);
    expect(prime.summary.cached).toBe(0);
    const again = (await lint.run({ file: shellFile, incremental: true })) as { summary: Record<string, unknown> };
    expect(again.summary.checked).toBe(0);
    expect(again.summary.cached).toBe(MAP_COUNT);

    // Edit one more shard; only it is re-checked.
    const edited2 = runFileEdit({
      command: "add-event",
      file: shellFile,
      args: {
        map: "map-050",
        event: {
          id: "edx1_npc2",
          x: 3,
          y: 3,
          pages: [{ trigger: "action", commands: [{ op: "text", lines: ["edx1-2"] }] }],
        },
      },
    });
    expect(edited2.ok).toBe(true);
    const partial = (await lint.run({ file: shellFile, incremental: true })) as { summary: Record<string, unknown> };
    expect(partial.summary.checked).toBe(1);
    expect(partial.summary.cached).toBe(MAP_COUNT - 1);
  });

  test("materialize then pack reproduces every shard byte-for-byte", () => {
    const root = join(TEMP, "rt");
    const { shellFile } = writeCompactShell(root);
    const inlineOut = join(TEMP, "rt-inline.json");
    const mat = runMaterializeCommand({ file: shellFile, direction: "inline", out: inlineOut });
    expect(mat.ok).toBe(true);
    const repacked = join(TEMP, "rt-repacked");
    const pack = runMaterializeCommand({ file: inlineOut, direction: "pack", out: repacked, encoding: "compact" });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    const original = snapshot(root);
    const redone = snapshot(repacked);
    // Every shard reproduces byte-for-byte (pack writes the shell as
    // project.json while the fixture names it project-shell.json, so the
    // shell is compared by content).
    for (const [path, text] of original) {
      if (path.endsWith(".rkm")) expect(redone.get(path)).toBe(text);
    }
    const originalShell = JSON.parse(original.get(join(".", "project-shell.json"))!) as unknown;
    const repackedShell = JSON.parse(redone.get(join(".", "project.json"))!) as unknown;
    expect(repackedShell).toEqual(originalShell);
  });

  test("default materialize round-trip preserves a mixed-transport 263-map shell", () => {
    // The importer ships most maps as compact .rkm but falls back to JSON
    // for a few oversize shards. The default two-step flow (materialize
    // inline, then materialize pack with no flags) must reproduce every
    // shard at its original path and bytes — 263/263, not 260/263.
    const root = join(TEMP, "mixed-rt");
    const { shellFile } = writeMixedShell(root, ["map-007", "map-130", "map-262"]);
    const inlineOut = join(TEMP, "mixed-rt-inline.json");
    const mat = runMaterializeCommand({ file: shellFile, direction: "inline", out: inlineOut });
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;

    const repacked = join(TEMP, "mixed-rt-repacked");
    const pack = runMaterializeCommand({ file: inlineOut, direction: "pack", out: repacked });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    expect(pack.result.transportsSource).toBe("sidecar");

    const original = snapshot(root);
    const redone = snapshot(repacked);
    let matched = 0;
    for (const [path, text] of original) {
      if (!path.startsWith(join("maps", "/"))) continue;
      expect(redone.get(path)).toBe(text);
      matched++;
    }
    expect(matched).toBe(MAP_COUNT);
    // The three JSON fallbacks kept their original paths and bytes.
    for (const id of ["map-007", "map-130", "map-262"]) {
      expect(redone.get(join("maps", `${id}.json`))).toBe(original.get(join("maps", `${id}.json`)));
      expect(redone.get(join("maps", `${id}.rkm`))).toBeUndefined();
    }
    const originalShell = JSON.parse(original.get(join(".", "project-shell.json"))!) as unknown;
    const repackedShell = JSON.parse(redone.get(join(".", "project.json"))!) as unknown;
    expect(repackedShell).toEqual(originalShell);
  });
});
