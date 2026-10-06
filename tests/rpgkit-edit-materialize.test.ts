// tests/rpgkit-edit-materialize.test.ts — the materialize command converts
// between an inline rpgkit-project/v1 document and a sharded ProjectShell,
// in both directions, with byte-identical round trips over the kit's
// canonical formats.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runMaterializeCommand } from "../editor/api/materialize.ts";
import { serializeProject } from "../editor/engine/document.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { encodeCompactMap } from "../tools/lib/compact-map.ts";
import { canonicalJson } from "../src/engine/save.ts";
import { canonicalMapJson, mapManifestHash, sha256Text } from "../src/engine/map-repository.ts";
import type { Command, MapDef, Project, ProjectShell } from "../src/engine/types.ts";

const TEMP = join(import.meta.dir, `.rpgkit-edit-materialize-${process.pid}-${randomUUID()}`);

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function transfer(map: string): Command {
  return { op: "transfer", map, x: 0, y: 0 };
}

function mapAt(index: number, count: number): MapDef {
  const id = `map-${String(index).padStart(3, "0")}`;
  return {
    id,
    name: `Map ${index}`,
    width: 4,
    height: 2,
    sheets: ["s"],
    ground: Array(8).fill("s.0"),
    events: index === count - 1
      ? [{ id: "exit", x: 0, y: 0, pages: [{ trigger: "action", commands: [transfer("map-000")] }] }]
      : [],
  };
}

function project(count = 4): Project {
  // Canonicalize up front: splitProjectMaps sorts map keys, so a round trip
  // normalizes an author-ordered document to canonical key order. The
  // byte-identity contract is shell -> inline -> shell (shells are
  // canonical); an inline document in canonical form round-trips exactly.
  const authored: Project = {
    format: "rpgkit-project/v1",
    title: "materialize acceptance",
    tileSize: 16,
    start: { map: "map-000", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 1 }],
    items: [],
    maps: Array.from({ length: count }, (_, index) => mapAt(index, count)),
  };
  return JSON.parse(canonicalJson(authored)) as Project;
}

/** Write a splitProjectMaps shell + shards, optionally compact. */
function writeSplit(root: string, project: Project, compact = false): { shellFile: string; shell: ProjectShell } {
  const split = splitProjectMaps(project, { entryEncoding: compact ? "compact" : "json" });
  mkdirSync(root, { recursive: true });
  const shellFile = join(root, "project.json");
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
function writeMixedShell(root: string, project: Project, jsonMaps: readonly string[]): { shellFile: string } {
  const split = splitProjectMaps(project, { entryEncoding: "compact" });
  mkdirSync(root, { recursive: true });
  const shell: ProjectShell = JSON.parse(split.shellText) as ProjectShell;
  const jsonSet = new Set(jsonMaps);
  for (const entry of split.entries) {
    const map = project.maps.find((m) => m.id === entry.meta.id)!;
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
  const shellFile = join(root, "project.json");
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

describe("materialize: shell -> inline", () => {
  test("expands a shell into the editor's canonical inline bytes", () => {
    const inline = project();
    const root = join(TEMP, "shell-inline");
    const { shellFile } = writeSplit(root, inline);
    const out = join(TEMP, "shell-inline.json");
    const response = runMaterializeCommand({ file: shellFile, direction: "inline", out });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.written).toBe(true);
    expect(response.result.maps).toBe(4);
    expect(readFileSync(out, "utf8")).toBe(serializeProject(inline));
  });

  test("expands compact shards identically", () => {
    const inline = project();
    const root = join(TEMP, "shell-inline-compact");
    const { shellFile } = writeSplit(root, inline, true);
    const out = join(TEMP, "shell-inline-compact.json");
    const response = runMaterializeCommand({ file: shellFile, direction: "inline", out });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(readFileSync(out, "utf8")).toBe(serializeProject(inline));
  });

  test("--map writes one MapDef document", () => {
    const inline = project();
    const root = join(TEMP, "shell-map");
    const { shellFile } = writeSplit(root, inline, true);
    const out = join(TEMP, "shell-map.json");
    const response = runMaterializeCommand({ file: shellFile, direction: "inline", map: "map-003", out });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result.maps).toBe(1);
    expect(response.result.map).toBe("map-003");
    const map = JSON.parse(readFileSync(out, "utf8")) as MapDef;
    expect(map.id).toBe("map-003");
    expect(map.events?.[0]?.id).toBe("exit");
  });

  test("--map without out returns the map text in the result", () => {
    const inline = project();
    const root = join(TEMP, "shell-map-text");
    const { shellFile } = writeSplit(root, inline);
    const response = runMaterializeCommand({ file: shellFile, direction: "inline", map: "map-000" });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.written).toBe(false);
    expect(response.result.text).toBeDefined();
    expect((JSON.parse(response.result.text!) as MapDef).id).toBe("map-000");
  });

  test("a full project without out is a usage error", () => {
    const root = join(TEMP, "shell-noout");
    const { shellFile } = writeSplit(root, project());
    const response = runMaterializeCommand({ file: shellFile, direction: "inline" });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("CLI_USAGE");
  });

  test("an unknown map is MAP_NOT_FOUND", () => {
    const root = join(TEMP, "shell-badmap");
    const { shellFile } = writeSplit(root, project());
    const response = runMaterializeCommand({ file: shellFile, direction: "inline", map: "nope" });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("MAP_NOT_FOUND");
  });
});

describe("materialize: inline -> pack", () => {
  test("packs an inline document into shell + shards", () => {
    const inline = project();
    const file = join(TEMP, "pack-inline.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-out");
    const response = runMaterializeCommand({ file, direction: "pack", out });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result.maps).toBe(4);
    expect(response.writtenFiles.length).toBe(5); // shell + 4 shards
    const shell = JSON.parse(readFileSync(join(out, "project.json"), "utf8")) as ProjectShell;
    expect(shell.mapIndex.length).toBe(4);
    // The packed shell is the canonical split output (default "auto"
    // encoding, which picks compact for these small maps).
    const expected = splitProjectMaps(inline, { entryEncoding: "auto" });
    expect(readFileSync(join(out, "project.json"), "utf8")).toBe(expected.shellText);
    for (const entry of expected.entries) {
      expect(readFileSync(join(out, entry.path), "utf8")).toBe(entry.text);
    }
  });

  test("refuses to overwrite an existing shell", () => {
    const inline = project();
    const file = join(TEMP, "pack-exists.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-exists-out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "project.json"), "{}");
    const response = runMaterializeCommand({ file, direction: "pack", out });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("MATERIALIZE_TARGET_EXISTS");
  });

  test("dry-run writes nothing", () => {
    const inline = project();
    const file = join(TEMP, "pack-dry.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-dry-out");
    const response = runMaterializeCommand({ file, direction: "pack", out, dryRun: true });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.written).toBe(false);
    expect(response.writtenFiles.length).toBe(0);
  });

  test("refuses a semantically invalid project and writes nothing", () => {
    // A start map that does not exist passes schema validation but is not a
    // project the editor would reopen; pack must refuse it before writing.
    const inline = project();
    inline.start = { map: "missing-map", x: 0, y: 0, dir: "down" };
    const file = join(TEMP, "pack-invalid.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-invalid-out");
    const response = runMaterializeCommand({ file, direction: "pack", out });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("INVALID_DOCUMENT");
    expect(response.error.message).toContain("missing-map");
    expect(existsSync(out)).toBe(false);
  });

  test("a failed pack is atomic: no shard or shell is left behind", () => {
    const inline = project();
    const file = join(TEMP, "pack-atomic.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-atomic-out");
    // A directory where a shard would be written: the old implementation
    // published earlier shards first and left them on this failure.
    mkdirSync(join(out, "maps", "map-001.rkm"), { recursive: true });
    const response = runMaterializeCommand({ file, direction: "pack", out, encoding: "compact" });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("MATERIALIZE_TARGET_EXISTS");
    expect(existsSync(join(out, "project.json"))).toBe(false);
    expect(existsSync(join(out, "maps", "map-000.rkm"))).toBe(false);
    expect(existsSync(join(out, "maps", "map-002.rkm"))).toBe(false);
    expect(existsSync(join(out, "maps", "map-003.rkm"))).toBe(false);
  });
});

describe("materialize: byte-identical round trips", () => {
  test("pack then materialize reproduces the inline bytes", () => {
    const inline = project();
    const file = join(TEMP, "rt-inline.json");
    writeFileSync(file, serializeProject(inline));
    const packed = join(TEMP, "rt-packed");
    const packResponse = runMaterializeCommand({ file, direction: "pack", out: packed });
    expect(packResponse.ok).toBe(true);
    const back = join(TEMP, "rt-back.json");
    const matResponse = runMaterializeCommand({ file: join(packed, "project.json"), direction: "inline", out: back });
    expect(matResponse.ok).toBe(true);
    expect(readFileSync(back, "utf8")).toBe(serializeProject(inline));
    expect(readFileSync(back, "utf8")).toBe(readFileSync(file, "utf8"));
  });

  test("materialize then pack reproduces the shell and shard bytes", () => {
    const inline = project();
    const root = join(TEMP, "rt-shell");
    const { shellFile } = writeSplit(root, inline, true);
    const before = snapshot(root);
    const inlineOut = join(TEMP, "rt-shell-inline.json");
    const matResponse = runMaterializeCommand({ file: shellFile, direction: "inline", out: inlineOut });
    expect(matResponse.ok).toBe(true);
    const packed = join(TEMP, "rt-shell-repacked");
    const packResponse = runMaterializeCommand({ file: inlineOut, direction: "pack", out: packed, encoding: "compact" });
    expect(packResponse.ok).toBe(true);
    const after = snapshot(packed);
    // The repacked shell and every shard reproduce the original bytes.
    for (const [path, text] of before) {
      expect(after.get(path)).toBe(text);
    }
  });

  test("pack with fromShell preserves each map's transport and entry path", () => {
    const inline = project();
    // map-001 ships as JSON even though auto would pick compact for it,
    // like the importer's oversize-shard fallback.
    const root = join(TEMP, "mixed-shell");
    const { shellFile } = writeMixedShell(root, inline, ["map-001"]);
    const inlineOut = join(TEMP, "mixed-inline.json");
    const mat = runMaterializeCommand({ file: shellFile, direction: "inline", out: inlineOut });
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;

    // The default pack recognizes the transports the inline step recorded
    // next to the document: map-001 keeps its JSON transport and entry path
    // with no flags at all.
    const defaultOut = join(TEMP, "mixed-default");
    const defaultPack = runMaterializeCommand({ file: inlineOut, direction: "pack", out: defaultOut });
    expect(defaultPack.ok).toBe(true);
    if (!defaultPack.ok) return;
    expect(defaultPack.result.transportsSource).toBe("sidecar");
    expect(existsSync(join(defaultOut, "maps", "map-001.json"))).toBe(true);
    expect(existsSync(join(defaultOut, "maps", "map-001.rkm"))).toBe(false);

    // An explicit encoding opts out of the recorded transports and
    // re-decides, so auto makes map-001 compact again.
    const autoOut = join(TEMP, "mixed-auto");
    const autoPack = runMaterializeCommand({ file: inlineOut, direction: "pack", out: autoOut, encoding: "auto" });
    expect(autoPack.ok).toBe(true);
    if (!autoPack.ok) return;
    expect(existsSync(join(autoOut, "maps", "map-001.rkm"))).toBe(true);
    expect(existsSync(join(autoOut, "maps", "map-001.json"))).toBe(false);

    // With fromShell, every shard reproduces at its original path and bytes.
    const repacked = join(TEMP, "mixed-repacked");
    const pack = runMaterializeCommand({ file: inlineOut, direction: "pack", out: repacked, fromShell: shellFile });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    const before = snapshot(root);
    const after = snapshot(repacked);
    for (const [path, text] of before) {
      if (path === "project.json") continue; // pack always writes project.json
      expect(after.get(path)).toBe(text);
    }
    expect(after.get(join("maps", "map-001.json"))).toBeDefined();
    // The shell content is identical too (only the file name differs).
    expect(JSON.parse(after.get("project.json")!)).toEqual(JSON.parse(before.get("project.json")!));
  });

  test("default pack after materialize preserves a mixed-transport shell byte-for-byte", () => {
    const inline = project();
    // Two maps ship as JSON even though auto would pick compact for them,
    // like the importer's oversize-shard fallback.
    const root = join(TEMP, "mixed-default-shell");
    const { shellFile } = writeMixedShell(root, inline, ["map-001", "map-003"]);
    const inlineOut = join(TEMP, "mixed-default-inline.json");
    const mat = runMaterializeCommand({ file: shellFile, direction: "inline", out: inlineOut });
    expect(mat.ok).toBe(true);
    if (!mat.ok) return;

    // No encoding, no fromShell: the default pack must recognize the
    // transports the inline step recorded and reproduce every shard at its
    // original path and bytes.
    const repacked = join(TEMP, "mixed-default-repacked");
    const pack = runMaterializeCommand({ file: inlineOut, direction: "pack", out: repacked });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    expect(pack.result.transportsSource).toBe("sidecar");
    const before = snapshot(root);
    const after = snapshot(repacked);
    for (const [path, text] of before) {
      if (path === "project.json") continue; // pack always writes project.json
      expect(after.get(path)).toBe(text);
    }
    expect(after.get(join("maps", "map-001.json"))).toBeDefined();
    expect(after.get(join("maps", "map-003.json"))).toBeDefined();
    expect(JSON.parse(after.get("project.json")!)).toEqual(JSON.parse(before.get("project.json")!));
  });

  test("a document without recorded transports falls back to auto encoding", () => {
    // A hand-written inline document has no sidecar next to it, so the
    // default pack is the size-based auto selection, same as before.
    const inline = project();
    const file = join(TEMP, "pack-nosidecar.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-nosidecar-out");
    const response = runMaterializeCommand({ file, direction: "pack", out });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.result.transportsSource).toBeUndefined();
    const expected = splitProjectMaps(inline, { entryEncoding: "auto" });
    for (const entry of expected.entries) {
      expect(readFileSync(join(out, entry.path), "utf8")).toBe(entry.text);
    }
  });

  test("pack with fromShell rejects a shell entry that escapes maps/", () => {
    // A fromShell entry must be a canonical maps/-relative path. Tampering a
    // shell's mapIndex with a ".." entry and refreshing its manifest hash
    // must fail the pack before anything is written.
    const inline = project();
    const root = join(TEMP, "fromshell-escape");
    const { shellFile } = writeSplit(root, inline);
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const meta = shell.mapIndex.find((item) => item.id === "map-001")!;
    meta.entry = "../../escaped2.rkm";
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));

    const inlineOut = join(TEMP, "fromshell-escape-inline.json");
    writeFileSync(inlineOut, serializeProject(inline));
    const out = join(TEMP, "fromshell-escape-out");
    const escaped = resolve(out, "../../escaped2.rkm");
    rmSync(escaped, { force: true });
    const response = runMaterializeCommand({ file: inlineOut, direction: "pack", out, fromShell: shellFile });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("INVALID_DOCUMENT");
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(out)).toBe(false);
    rmSync(escaped, { force: true });
  });

  test("pack with fromShell rejects a maps/-prefixed entry that escapes maps/", () => {
    // A ".." segment must be refused at read time even when preceded by a
    // valid "maps/" segment; this pins assertCanonicalMapsEntry separately
    // from the publish-time confinement, which would also catch the escape
    // but with a different error code.
    const inline = project();
    const root = join(TEMP, "fromshell-maps-escape");
    const { shellFile } = writeSplit(root, inline);
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    const meta = shell.mapIndex.find((item) => item.id === "map-001")!;
    meta.entry = "maps/../../escaped3.rkm";
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));

    const inlineOut = join(TEMP, "fromshell-maps-escape-inline.json");
    writeFileSync(inlineOut, serializeProject(inline));
    const out = join(TEMP, "fromshell-maps-escape-out");
    const escaped = resolve(out, "../escaped3.rkm");
    rmSync(escaped, { force: true });
    const response = runMaterializeCommand({ file: inlineOut, direction: "pack", out, fromShell: shellFile });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("INVALID_DOCUMENT");
    expect(existsSync(escaped)).toBe(false);
    expect(existsSync(out)).toBe(false);
    rmSync(escaped, { force: true });
  });

  test("a dry-run pack refuses the same symlink escape as a real pack", () => {
    // The publish-target confinement runs before the dry-run branch, so a
    // dry run and a real pack fail identically on a maps/ symlink that
    // escapes the output directory.
    const inline = project();
    const file = join(TEMP, "pack-symlink-dry.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-symlink-dry-out");
    const outside = join(TEMP, "pack-symlink-dry-outside");
    mkdirSync(out, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(out, "maps"));
    const response = runMaterializeCommand({ file, direction: "pack", out, root: TEMP, dryRun: true });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("PATH_OUTSIDE_ROOT");
    expect(existsSync(join(out, "project.json"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  test("pack refuses to publish through a symlink that escapes the output directory", () => {
    // Every publish target is confined to the output directory (symlinks
    // resolved) before anything is staged: a maps/ symlink pointing outside
    // out must fail PATH_OUTSIDE_ROOT with no file written on either side.
    const inline = project();
    const file = join(TEMP, "pack-symlink.json");
    writeFileSync(file, serializeProject(inline));
    const out = join(TEMP, "pack-symlink-out");
    const outside = join(TEMP, "pack-symlink-outside");
    mkdirSync(out, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(out, "maps"));
    const response = runMaterializeCommand({ file, direction: "pack", out, root: TEMP });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("PATH_OUTSIDE_ROOT");
    expect(existsSync(join(out, "project.json"))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });
});
