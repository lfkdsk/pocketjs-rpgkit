// tests/editor-sharded-compact.test.ts — the edit API reads and writes
// rpgkit-map/1 compact shards (the importer's default encoding) keeping the
// on-disk format: a compact shard is re-encoded compact on write, a JSON shard
// stays JSON, and every untouched shard keeps its exact bytes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runFileEdit } from "../editor/api/file.ts";
import type { EditPatch } from "../editor/api/types.ts";
import {
  canonicalMapJson,
  mapManifestHash,
  sha256Text,
} from "../src/engine/map-repository.ts";
import { decodeCompactMap, isCompactMapValue } from "../src/engine/compact-map.ts";
import type { Command, MapDef, Project, ProjectShell } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { encodeCompactMap } from "../tools/lib/compact-map.ts";

const TEMP = join(import.meta.dir, `.editor-sharded-compact-${process.pid}-${randomUUID()}`);

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
      ? [{
          id: "exit",
          x: 0,
          y: 0,
          pages: [{ trigger: "action", commands: [transfer("map-000")] }],
        }]
      : [],
  };
}

function project(count = 4): Project {
  return {
    format: "rpgkit-project/v1",
    title: "compact shard acceptance",
    tileSize: 16,
    start: { map: "map-000", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 1 }],
    items: [],
    maps: Array.from({ length: count }, (_, index) => mapAt(index, count)),
  };
}

/** Write a shell + shards, choosing each map's encoding explicitly. The
 *  shell is the canonical split output with the compact maps' entries,
 *  checksums and manifest re-hashed over their compact bytes. */
function writeSharded(root: string, encodings: Record<string, "json" | "compact">): string {
  const split = splitProjectMaps(project());
  mkdirSync(root, { recursive: true });
  const shell: ProjectShell = JSON.parse(split.shellText) as ProjectShell;
  for (const entry of split.entries) {
    const map = JSON.parse(entry.text) as MapDef;
    const encoding = encodings[map.id] ?? "json";
    const rel = encoding === "compact" ? entry.path.replace(/\.json$/, ".rkm") : entry.path;
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    const text = encoding === "compact" ? encodeCompactMap(map).text : entry.text;
    writeFileSync(path, text);
    const meta = shell.mapIndex.find((item) => item.id === map.id)!;
    meta.entry = rel;
    meta.sha256 = sha256Text(text);
  }
  delete shell.mapManifestHash;
  shell.mapManifestHash = mapManifestHash(shell);
  const shellFile = join(root, "project.json");
  writeFileSync(shellFile, JSON.stringify(shell));
  return shellFile;
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

const newEvent = (id: string) => ({
  id,
  x: 1,
  y: 1,
  pages: [{ trigger: "action" as const, commands: [{ op: "text", lines: ["hi"] } as Command] }],
});

describe("edit API on compact rpgkit-map/1 shards", () => {
  test("reads events through a compact envelope", () => {
    const root = join(TEMP, "read");
    const shellFile = writeSharded(root, { "map-003": "compact" });
    const response = runFileEdit({
      command: "list-events",
      file: shellFile,
      args: { map: "map-003" },
    });
    expect(response.ok).toBe(true);
    const events = (response as { result: unknown }).result as { id: string }[];
    expect(events.map((event) => event.id)).toContain("exit");
  });

  test("edits a compact shard and writes compact bytes back, leaving every other shard untouched", () => {
    const root = join(TEMP, "write");
    const shellFile = writeSharded(root, { "map-003": "compact" });
    const before = snapshot(root);
    const edited = runFileEdit({
      command: "add-event",
      file: shellFile,
      args: { map: "map-003", event: newEvent("compact_npc") },
    });
    expect(edited.ok).toBe(true);
    expect(edited.written).toBe(true);
    expect((edited as { writtenFiles?: string[] }).writtenFiles?.length).toBe(2); // the shard + the shell
    const after = snapshot(root);
    for (const [path, text] of before) {
      if (path === join("maps", "map-003.rkm") || path === "project.json") continue;
      expect(after.get(path)).toBe(text);
    }
    const shardPath = join(root, "maps", "map-003.rkm");
    const text = readFileSync(shardPath, "utf8");
    expect(isCompactMapValue(JSON.parse(text))).toBe(true);
    const map = decodeCompactMap(JSON.parse(text));
    expect(map.events?.map((event) => event.id)).toContain("compact_npc");
    // The shell checksum hashes the compact bytes that are now on disk.
    const shell = JSON.parse(after.get("project.json")!) as ProjectShell;
    const meta = shell.mapIndex.find((item) => item.id === "map-003")!;
    expect(meta.sha256).toBe(sha256Text(text));
  });

  test("a reverse patch restores the original compact bytes exactly", () => {
    const root = join(TEMP, "reverse");
    const shellFile = writeSharded(root, { "map-003": "compact" });
    const originalShard = readFileSync(join(root, "maps", "map-003.rkm"), "utf8");
    const originalShell = readFileSync(shellFile, "utf8");
    const dry = runFileEdit({
      command: "add-event",
      file: shellFile,
      args: { map: "map-003", event: newEvent("compact_npc") },
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    const patch = (dry as { patch: EditPatch }).patch;
    const applied = runFileEdit({
      command: "save",
      file: shellFile,
      args: { patch, direction: "forward" },
    });
    expect(applied.ok).toBe(true);
    const reversed = runFileEdit({
      command: "save",
      file: shellFile,
      args: { patch, direction: "reverse" },
    });
    expect(reversed.ok).toBe(true);
    expect(readFileSync(join(root, "maps", "map-003.rkm"), "utf8")).toBe(originalShard);
    // The shell is always re-serialized in the API's own format on an
    // effective mutation; reverse restores its logical content, not bytes.
    expect(JSON.parse(readFileSync(shellFile, "utf8"))).toEqual(JSON.parse(originalShell));
  });

  test("mixed encodings keep their format on both sides of an edit", () => {
    const root = join(TEMP, "mixed");
    // map-000 JSON, map-003 compact.
    const shellFile = writeSharded(root, { "map-003": "compact" });
    for (const [map, encoding] of [["map-000", "json"], ["map-003", "compact"]] as const) {
      const edited = runFileEdit({
        command: "add-event",
        file: shellFile,
        args: { map, event: newEvent(`${encoding}_npc`) },
      });
      expect(edited.ok).toBe(true);
      const entry = encoding === "compact" ? "map-003.rkm" : "map-000.json";
      const text = readFileSync(join(root, "maps", entry), "utf8");
      const parsed = JSON.parse(text) as unknown;
      expect(isCompactMapValue(parsed)).toBe(encoding === "compact");
      if (encoding === "json") expect(canonicalMapJson(JSON.parse(text) as MapDef)).toBe(text);
    }
  });

  test("a malformed compact envelope is refused with the envelope error", () => {
    const root = join(TEMP, "bad");
    const shellFile = writeSharded(root, { "map-003": "compact" });
    const shardPath = join(root, "maps", "map-003.rkm");
    const bad = JSON.stringify({ $: "rpgkit-map/1", i: "map-003", n: "x", w: 4, h: 2, g: ["j", []] });
    writeFileSync(shardPath, bad);
    // The checksum gate runs before the envelope decode, so the shell must
    // hash the bad bytes for the decode error to be reachable.
    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as ProjectShell;
    shell.mapIndex.find((item) => item.id === "map-003")!.sha256 = sha256Text(bad);
    delete shell.mapManifestHash;
    shell.mapManifestHash = mapManifestHash(shell);
    writeFileSync(shellFile, JSON.stringify(shell));
    const response = runFileEdit({
      command: "list-events",
      file: shellFile,
      args: { map: "map-003" },
    });
    expect(response.ok).toBe(false);
    expect((response as { error: { code: string; message: string } }).error.code).toBe("INVALID_DOCUMENT");
    expect((response as { error: { message: string } }).error.message).toContain("compact map");
  });

  test("validate loads every compact shard", () => {
    const root = join(TEMP, "validate");
    const shellFile = writeSharded(root, { "map-001": "compact", "map-002": "compact", "map-003": "compact" });
    const response = runFileEdit({ command: "validate", file: shellFile, args: {} });
    expect(response.ok).toBe(true);
    expect((response as { result: { valid: boolean } }).result.valid).toBe(true);
  });
});
