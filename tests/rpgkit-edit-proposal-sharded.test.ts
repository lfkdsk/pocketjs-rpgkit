import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runFileEdit } from "../editor/api/file.ts";
import { runProposalFileCommand } from "../editor/api/proposals.ts";
import { shardEncodingOf } from "../editor/api/sharded.ts";
import type { Command, MapDef, Project } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const TEMP = join(import.meta.dir, `.proposal-sharded-${process.pid}-${randomUUID()}`);
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
    width: 2,
    height: 1,
    sheets: ["s"],
    ground: ["s.0", "s.0"],
    events: index === count - 1
      ? [{ id: "exit", x: 0, y: 0, pages: [{ trigger: "action", commands: [transfer("map-000")] }] }]
      : [],
  };
}

function syntheticProject(count = 3): Project {
  return {
    format: "rpgkit-project/v1",
    title: `${count} map proposal shard`,
    tileSize: 16,
    start: { map: "map-000", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 1 }],
    items: [],
    sprites: { sheep: { kind: "image", src: "assets/sheep.png" } },
    maps: Array.from({ length: count }, (_, index) => mapAt(index, count)),
  };
}

function materialize(project: Project, root: string, compact = false): string {
  const split = splitProjectMaps(project, {
    mapEntry: (id) => `maps/${id}.${compact ? "rkm" : "json"}`,
    entryEncoding: compact ? "compact" : "json",
  });
  const shellFile = join(root, "project.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(shellFile, split.shellText);
  for (const entry of split.entries) {
    const path = join(root, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.text);
  }
  return shellFile;
}

let counter = 0;
function newShell(count = 3): string {
  counter++;
  const root = join(TEMP, `shell-${counter}`);
  return materialize(syntheticProject(count), root);
}

function propose(file: string, request: unknown) {
  return runProposalFileCommand({ command: "propose", file, args: request });
}

const PAINT_AND_GREET = {
  id: "sh-01",
  title: "Paint and greet",
  rationale: "Touch one shard",
  author: "test",
  createdAt: "2026-10-05T12:00:00.000Z",
  hunks: [{
    id: "h",
    summary: "Paint a tile and add a greeter",
    operations: [
      { command: "paint-tile", args: { map: "map-000", layer: "ground", x: 1, y: 0, tile: "s.1" } },
      { command: "add-event", args: { map: "map-000", event: { id: "greeter", x: 0, y: 0, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Hi"] }] }] } } },
    ],
  }],
};

describe("proposals on sharded ProjectShells", () => {
  test("propose dry-runs through the sharded edit API and attaches QA", () => {
    const shellFile = newShell();
    const created = propose(shellFile, PAINT_AND_GREET);
    expect(created).toMatchObject({
      ok: true,
      written: true,
      result: {
        touchedEntries: ["maps/map-000.json"],
        qa: { errors: 0 },
        proposal: { id: "sh-01" },
      },
    });
    // Only the touched shard was loaded: the other shard files are untouched.
    const listed = runProposalFileCommand({ command: "list-proposals", file: shellFile });
    expect(listed).toMatchObject({
      result: [{ id: "sh-01", assessment: { hasConflicts: false, hunks: [{ state: "clean" }] }, qa: { errors: 0 } }],
    });
    const shown = runProposalFileCommand({ command: "show-proposal", file: shellFile, args: { id: "sh-01" } });
    expect(shown).toMatchObject({ result: { archived: false, assessment: { baseMatches: true } } });
  });

  test("accept publishes shard and shell transactionally and archives the decision", () => {
    const shellFile = newShell();
    expect(propose(shellFile, PAINT_AND_GREET)).toMatchObject({ ok: true });
    const shellBefore = readFileSync(shellFile, "utf8");
    const shardBefore = readFileSync(join(dirname(shellFile), "maps/map-000.json"), "utf8");
    const otherBefore = readFileSync(join(dirname(shellFile), "maps/map-001.json"), "utf8");

    const accepted = runProposalFileCommand({
      command: "accept-proposal",
      file: shellFile,
      args: { id: "sh-01", source: "sharded-cli" },
    });
    expect(accepted).toMatchObject({
      ok: true,
      result: { status: "accepted", projectChanged: true, appliedHunks: ["h"], qa: { errors: 0 } },
    });

    // Both the shard and the shell changed; the untouched shard did not.
    expect(readFileSync(join(dirname(shellFile), "maps/map-000.json"), "utf8")).not.toBe(shardBefore);
    expect(readFileSync(shellFile, "utf8")).not.toBe(shellBefore);
    expect(readFileSync(join(dirname(shellFile), "maps/map-001.json"), "utf8")).toBe(otherBefore);

    // The published project still validates (shell + every shard + checksums).
    const validation = runFileEdit({ command: "validate", file: shellFile });
    expect(validation).toMatchObject({ ok: true, result: { valid: true } });

    // The decision is archived with its source; the queue is empty.
    expect(runProposalFileCommand({ command: "list-proposals", file: shellFile })).toMatchObject({ result: [] });
    expect(runProposalFileCommand({ command: "list-archive", file: shellFile })).toMatchObject({
      result: [{ id: "sh-01", status: "accepted", source: "sharded-cli", summary: { hunks: 1 } }],
    });
  });

  test("a late archive QA failure restores published shards and shell", () => {
    const shellFile = newShell();
    const id = "sh-archive-qa-failure";
    expect(propose(shellFile, { ...PAINT_AND_GREET, id })).toMatchObject({ ok: true });
    const root = dirname(shellFile);
    const shellBefore = readFileSync(shellFile, "utf8");
    const shardBefore = readFileSync(join(root, "maps/map-000.json"), "utf8");
    const pending = join(`${shellFile}.proposals`, `${id}.json`);
    mkdirSync(join(`${shellFile}.proposals`, "archive", "qa", `${id}.json`));

    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id } }))
      .toMatchObject({ ok: false, written: false, error: { code: "PROPOSAL_IO_ERROR" } });
    expect(readFileSync(shellFile, "utf8")).toBe(shellBefore);
    expect(readFileSync(join(root, "maps/map-000.json"), "utf8")).toBe(shardBefore);
    expect(existsSync(pending)).toBe(true);
  });

  test("a proposal touching two shards writes both", () => {
    const shellFile = newShell();
    const request = {
      id: "sh-two",
      title: "Two shards",
      rationale: "One hunk per shard",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [
        { id: "a", summary: "Paint map-000", operations: [{ command: "paint-tile", args: { map: "map-000", layer: "ground", x: 1, y: 0, tile: "s.1" } }] },
        { id: "b", summary: "Paint map-001", operations: [{ command: "paint-tile", args: { map: "map-001", layer: "ground", x: 1, y: 0, tile: "s.1" } }] },
      ],
    };
    expect(propose(shellFile, request)).toMatchObject({ ok: true, result: { touchedEntries: ["maps/map-000.json", "maps/map-001.json"] } });
    const accepted = runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "sh-two" } });
    expect(accepted).toMatchObject({ ok: true, result: { projectChanged: true } });
    expect(runFileEdit({ command: "validate", file: shellFile })).toMatchObject({ ok: true, result: { valid: true } });
  });

  test("reject leaves every file untouched", () => {
    const shellFile = newShell();
    expect(propose(shellFile, PAINT_AND_GREET)).toMatchObject({ ok: true });
    const before = new Map<string, string>();
    for (const name of ["project.json", "maps/map-000.json", "maps/map-001.json", "maps/map-002.json"]) {
      before.set(name, readFileSync(join(dirname(shellFile), name), "utf8"));
    }
    expect(runProposalFileCommand({ command: "reject-proposal", file: shellFile, args: { id: "sh-01", source: "reviewer" } }))
      .toMatchObject({ ok: true, result: { status: "rejected" } });
    for (const [name, text] of before) {
      expect(readFileSync(join(dirname(shellFile), name), "utf8")).toBe(text);
    }
    expect(runProposalFileCommand({ command: "list-archive", file: shellFile })).toMatchObject({
      result: [{ id: "sh-01", status: "rejected", source: "reviewer" }],
    });
  });

  test("a load failure at accept leaves every file untouched", () => {
    const shellFile = newShell();
    expect(propose(shellFile, PAINT_AND_GREET)).toMatchObject({ ok: true });
    // Corrupt the touched shard after the proposal was created.
    writeFileSync(join(dirname(shellFile), "maps/map-000.json"), "{not json");
    const before = new Map<string, string>();
    for (const name of ["project.json", "maps/map-000.json", "maps/map-001.json", "maps/map-002.json"]) {
      before.set(name, readFileSync(join(dirname(shellFile), name), "utf8"));
    }
    const refused = runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "sh-01" } });
    expect(refused).toMatchObject({ ok: false });
    for (const [name, text] of before) {
      expect(readFileSync(join(dirname(shellFile), name), "utf8")).toBe(text);
    }
    // The proposal stays pending (its sidecar is untouched; listing would
    // need the corrupt shard to assess it).
    const queue = join(dirname(shellFile), "project.json.proposals");
    expect(readFileSync(join(queue, "sh-01.json"), "utf8")).toContain('"id": "sh-01"');
  });

  test("a QA failure at accept rolls the applied result back", () => {
    const shellFile = newShell();
    expect(propose(shellFile, PAINT_AND_GREET)).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    // Drift a DIFFERENT shard with a QA error (missing sprite). The proposal's
    // hunk stays clean, so accept applies it, re-runs QA, and must roll back.
    const drift = runFileEdit({
      command: "add-event",
      file: shellFile,
      args: { map: "map-001", event: { id: "ghost", x: 0, y: 0, pages: [{ trigger: "action", sprite: "poltergeist", commands: [{ op: "text", lines: ["boo"] }] }] } },
    });
    expect(drift).toMatchObject({ ok: true, written: true });
    const before = new Map<string, string>();
    for (const name of ["project.json", "maps/map-000.json", "maps/map-001.json", "maps/map-002.json"]) {
      before.set(name, readFileSync(join(dirname(shellFile), name), "utf8"));
    }
    const refused = runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "sh-01" } });
    expect(refused).toMatchObject({ ok: false, error: { code: "PROPOSAL_QA_FAILED" } });
    // No file changed: the paint was rolled back and the drift is intact.
    for (const [name, text] of before) {
      expect(readFileSync(join(dirname(shellFile), name), "utf8")).toBe(text);
    }
    const shard0 = JSON.parse(readFileSync(join(dirname(shellFile), "maps/map-000.json"), "utf8")) as MapDef;
    expect(shard0.ground[1]).toBe("s.0");
    expect(shard0.events?.some((e) => e.id === "greeter") ?? false).toBe(false);
  });

  test("pre-existing QA errors stay visible without freezing unrelated proposals", () => {
    const project = syntheticProject();
    project.maps[1]!.events!.push({
      id: "old-ghost",
      x: 0,
      y: 0,
      pages: [{
        trigger: "action",
        sprite: "unregistered-old-sprite",
        commands: [{ op: "text", lines: ["This imported defect predates the proposal"] }],
      }],
    });
    counter++;
    const shellFile = materialize(project, join(TEMP, `baseline-errors-${counter}`));

    const created = propose(shellFile, { ...PAINT_AND_GREET, id: "baseline-paint" });
    expect(created).toMatchObject({
      ok: true,
      result: { qa: { errors: 1, baseline: { errors: [{ code: "lint/sprite-missing" }] } } },
    });
    const accepted = runProposalFileCommand({
      command: "accept-proposal",
      file: shellFile,
      args: { id: "baseline-paint" },
    });
    expect(accepted).toMatchObject({
      ok: true,
      result: { projectChanged: true, qa: { errors: 1 } },
    });
    expect(runFileEdit({ command: "validate", file: shellFile }))
      .toMatchObject({ ok: true, result: { valid: true } });
  });

  test("duplicating a map cannot spend the original map's QA error allowance", () => {
    const project = syntheticProject();
    project.maps[1]!.events!.push({
      id: "old-ghost",
      x: 0,
      y: 0,
      pages: [{
        trigger: "action",
        sprite: "unregistered-old-sprite",
        commands: [{ op: "text", lines: ["Same finding text, different map"] }],
      }],
    });
    counter++;
    const shellFile = materialize(project, join(TEMP, `duplicate-errors-${counter}`));
    const request = {
      id: "duplicate-bad-map",
      title: "Duplicate imported map",
      rationale: "A copied defect must remain a new defect",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "h",
        summary: "Duplicate the map",
        operations: [{ command: "duplicate-map", args: { map: "map-001" } }],
      }],
    };
    expect(propose(shellFile, request)).toMatchObject({
      ok: true,
      result: { qa: { errors: 2, baseline: { errors: [{ loc: { map: "map-001", event: "old-ghost" } }] } } },
    });
    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "duplicate-bad-map" } }))
      .toMatchObject({ ok: false, error: { code: "PROPOSAL_QA_FAILED", actual: 1 } });
  });

  test("QA errors at creation block accept on shells too", () => {
    const shellFile = newShell();
    const bad = {
      id: "sh-bad",
      title: "Bad sprite",
      rationale: "References an unregistered sprite",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "h",
        summary: "Add a ghost",
        operations: [{
          command: "add-event",
          args: { map: "map-000", event: { id: "ghost", x: 1, y: 0, pages: [{ trigger: "action", sprite: "poltergeist", commands: [{ op: "text", lines: ["boo"] }] }] } },
        }],
      }],
    };
    const created = propose(shellFile, bad);
    expect(created).toMatchObject({ ok: true, result: { qa: { errors: 1 } } });
    const before = readFileSync(shellFile, "utf8");
    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "sh-bad" } }))
      .toMatchObject({ ok: false, error: { code: "PROPOSAL_QA_FAILED" } });
    expect(readFileSync(shellFile, "utf8")).toBe(before);
  });

  test("structural map changes add, duplicate, move and connect shell maps", () => {
    const shellFile = newShell();
    const request = {
      id: "sh-add",
      title: "New map",
      rationale: "Grow and reorder a shell through one reviewed proposal",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "h",
        summary: "Add, duplicate, move and connect maps",
        operations: [
          { command: "add-map", args: { map: "map-999", width: 2, height: 1, sheets: ["s"], fill: "s.0", after: "map-000" } },
          { command: "duplicate-map", args: { map: "map-001" } },
          { command: "move-map", args: { map: "map-002", index: 0 } },
          { command: "connect-maps", args: { map: "map-000", x: 0, y: 0, targetMap: "map-999", targetX: 0, targetY: 0, eventId: "to-new" } },
        ],
      }],
    };
    expect(propose(shellFile, request)).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "sh-add" } }))
      .toMatchObject({ ok: true, result: { projectChanged: true, qa: { errors: 0 } } });

    const shell = JSON.parse(readFileSync(shellFile, "utf8")) as { mapIndex: { id: string; entry: string }[] };
    expect(shell.mapIndex.map((meta) => meta.id)).toEqual([
      "map-002", "map-000", "map-999", "map-001", "map-001-copy",
    ]);
    for (const id of ["map-999", "map-001-copy"]) {
      const meta = shell.mapIndex.find((candidate) => candidate.id === id)!;
      expect(readFileSync(join(dirname(shellFile), meta.entry), "utf8")).toContain(`\"id\":\"${id}\"`);
    }
    const first = shell.mapIndex.find((candidate) => candidate.id === "map-000")!;
    const map = JSON.parse(readFileSync(join(dirname(shellFile), first.entry), "utf8")) as MapDef;
    expect(map.events?.find((event) => event.id === "to-new")?.pages[0]?.commands[0])
      .toMatchObject({ op: "transfer", map: "map-999", x: 0, y: 0 });
  });

  test("deleting a shell map removes its shard file so the name can be re-added", () => {
    const shellFile = newShell();
    const shellDir = dirname(shellFile);
    const before = JSON.parse(readFileSync(shellFile, "utf8")) as { mapIndex: { id: string; entry: string }[] };
    const deletedEntry = before.mapIndex.find((meta) => meta.id === "map-001")!.entry;
    expect(existsSync(join(shellDir, deletedEntry))).toBe(true);
    expect(propose(shellFile, {
      id: "sh-delete",
      title: "Remove a map",
      rationale: "The map is obsolete",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "h",
        summary: "Delete map-001",
        operations: [{ command: "delete-map", args: { map: "map-001" } }],
      }],
    })).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "sh-delete" } }))
      .toMatchObject({ ok: true, result: { projectChanged: true, qa: { errors: 0 } } });
    // The orphan shard file is gone, so a same-named map can be re-added.
    expect(existsSync(join(shellDir, deletedEntry))).toBe(false);
    expect(propose(shellFile, {
      id: "sh-readd",
      title: "Recreate the map",
      rationale: "The map is needed again",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "h",
        summary: "Add map-001 again",
        operations: [{ command: "add-map", args: { map: "map-001", width: 2, height: 1, sheets: ["s"], fill: "s.0" } }],
      }],
    })).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "sh-readd" } }))
      .toMatchObject({ ok: true, result: { projectChanged: true, qa: { errors: 0 } } });
    const after = JSON.parse(readFileSync(shellFile, "utf8")) as { mapIndex: { id: string; entry: string }[] };
    expect(after.mapIndex.some((meta) => meta.id === "map-001")).toBe(true);
    expect(existsSync(join(shellDir, deletedEntry))).toBe(true);
  });

  test("an archive failure after delete-map restores the removed shard file", () => {
    const shellFile = newShell();
    const root = dirname(shellFile);
    const id = "sh-delete-rollback";
    const before = JSON.parse(readFileSync(shellFile, "utf8")) as { mapIndex: { id: string; entry: string }[] };
    const deletedEntry = before.mapIndex.find((meta) => meta.id === "map-001")!.entry;
    const shardPath = join(root, deletedEntry);
    const shardBefore = readFileSync(shardPath, "utf8");
    const shellBefore = readFileSync(shellFile, "utf8");
    expect(propose(shellFile, {
      id,
      title: "Remove a map",
      rationale: "The map is obsolete",
      author: "test",
      createdAt: "2026-10-05T12:00:00.000Z",
      hunks: [{
        id: "h",
        summary: "Delete map-001",
        operations: [{ command: "delete-map", args: { map: "map-001" } }],
      }],
    })).toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    // Make archival fail after the project files publish and the orphan shard
    // is removed: the QA sidecar path is a directory, so its write throws.
    mkdirSync(join(`${shellFile}.proposals`, "archive", "qa", `${id}.json`), { recursive: true });

    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id } }))
      .toMatchObject({ ok: false, written: false, error: { code: "PROPOSAL_IO_ERROR" } });

    // The whole acceptance rolled back: shell bytes, and the removed shard
    // file is back on disk with its original bytes so nothing was lost.
    expect(readFileSync(shellFile, "utf8")).toBe(shellBefore);
    expect(readFileSync(shardPath, "utf8")).toBe(shardBefore);
    expect(existsSync(join(`${shellFile}.proposals`, `${id}.json`))).toBe(true);
  });

  test("compact and JSON shards complete the same proposal lifecycle", () => {
    counter++;
    const root = join(TEMP, `compact-${counter}`);
    const shellFile = materialize(syntheticProject(), root, true);
    const untouched = readFileSync(join(root, "maps/map-001.rkm"), "utf8");
    expect(propose(shellFile, { ...PAINT_AND_GREET, id: "compact-paint" }))
      .toMatchObject({ ok: true, result: { qa: { errors: 0 } } });
    expect(runProposalFileCommand({ command: "accept-proposal", file: shellFile, args: { id: "compact-paint" } }))
      .toMatchObject({ ok: true, result: { qa: { errors: 0 }, projectChanged: true } });
    expect(readFileSync(join(root, "maps/map-001.rkm"), "utf8")).toBe(untouched);
    // The edited shard keeps its compact .rkm encoding, and the shell's
    // mapIndex sha256 matches the compact bytes (validate recomputes it).
    const editedShard = readFileSync(join(root, "maps/map-000.rkm"), "utf8");
    expect(shardEncodingOf(editedShard)).toBe("compact");
    expect(editedShard).toContain("greeter");
    expect(runFileEdit({ command: "validate", file: shellFile })).toMatchObject({ ok: true, result: { valid: true } });
  });
});
