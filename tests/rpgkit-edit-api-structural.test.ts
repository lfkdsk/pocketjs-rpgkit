import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  executeEditOperation,
  semanticHash,
} from "../editor/api/operations.ts";
import {
  executeShardedEditOperation,
  shardEntriesForOperation,
  loadValidatedProjectShell,
} from "../editor/api/sharded.ts";
import { runFileEdit } from "../editor/api/file.ts";
import { EDIT_TOOL_BY_NAME } from "../editor/api/tools.ts";
import type { EditExecution, EditSuccess } from "../editor/api/types.ts";
import { semanticEqual } from "../editor/engine/document.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { MapDef, Project } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = readFileSync(join(ROOT, "examples/sunstone/data/sunstone.json"), "utf8");
const ORIGINAL = JSON.parse(SOURCE) as Project;
const TEMP = join(import.meta.dir, `.rpgkit-edit-structural-${process.pid}-${randomUUID()}`);

beforeAll(() => mkdirSync(TEMP, { recursive: true }));
afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function success(execution: EditExecution): EditSuccess & { output: string } {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  expect(execution.output).toBeDefined();
  return Object.assign(execution.response, { output: execution.output! });
}

function failure(execution: EditExecution): { code: string; path?: string; details?: unknown } {
  if (execution.response.ok) throw new Error(`expected failure: ${JSON.stringify(execution.response.result)}`);
  expect(execution.output).toBeUndefined();
  return execution.response.error;
}

/** Edit, then prove the patch reverses to the original and replays forward. */
function roundTrip(command: string, args: unknown): { edited: EditSuccess & { output: string }; project: Project } {
  const edited = success(executeEditOperation(SOURCE, command, args));
  expect(edited.changed).toBe(true);
  expect(edited.patch).toBeDefined();
  expect(edited.patch!.changes.length).toBeGreaterThan(0);
  const project = JSON.parse(edited.output) as Project;
  expect(semanticEqual(project, ORIGINAL)).toBe(false);

  const reversed = success(executeEditOperation(edited.output, "save", { patch: edited.patch, direction: "reverse" }));
  expect(semanticEqual(JSON.parse(reversed.output), ORIGINAL)).toBe(true);
  expect(semanticHash(JSON.parse(reversed.output))).toBe(edited.patch!.beforeHash);

  const replayed = success(executeEditOperation(reversed.output, "save", { patch: edited.patch, direction: "forward" }));
  expect(semanticEqual(JSON.parse(replayed.output), project)).toBe(true);
  return { edited, project };
}

/** Sparse layers compact edited pairs after untouched ones, so a single
 * stroke and several one-cell strokes can order pairs differently while
 * painting the same cells. Compare the effective (last pair wins) layers. */
function effectiveLayers(project: Project): Project {
  const effective = <T,>(pairs: [number, T][] | undefined): [number, T][] =>
    [...new Map(pairs ?? []).entries()].sort((a, b) => a[0] - b[0]);
  return {
    ...project,
    maps: project.maps.map((map) => ({
      ...map,
      upper: effective(map.upper),
      passage: effective(map.passage),
    })) as MapDef[],
  };
}

function mapOf(project: Project, id: string): MapDef {
  const map = project.maps.find((candidate) => candidate.id === id);
  if (!map) throw new Error(`missing map ${id}`);
  return map;
}

describe("paint-cells", () => {
  const cells = [[2, 2], [3, 2], [3, 3], [2, 2], [10, 7]];

  test("one ground stroke equals the same cells painted with paint-tile", () => {
    const { edited, project } = roundTrip("paint-cells", { map: "village", cells, value: "town.1" });
    expect(edited.result).toEqual({ map: "village", layer: "ground", value: "town.1", cells: 4 });
    expect(edited.addresses).toEqual([
      "map:village/layer:ground/tile:2,2",
      "map:village/layer:ground/tile:3,2",
      "map:village/layer:ground/tile:3,3",
      "map:village/layer:ground/tile:10,7",
    ]);
    let sequential = SOURCE;
    for (const [x, y] of cells) {
      const step = executeEditOperation(sequential, "paint-tile", { map: "village", x, y, tile: "town.1" });
      if (!step.response.ok) throw new Error(JSON.stringify(step.response));
      sequential = step.output ?? sequential;
    }
    expect(semanticEqual(JSON.parse(sequential), project)).toBe(true);
  });

  test("upper erase and paint go through the same stroke", () => {
    const { project } = roundTrip("paint-cells", { map: "forest", layer: "upper", cells: [[0, 0], [1, 0]], value: null });
    const upper = new Map(mapOf(project, "forest").upper ?? []);
    expect(upper.has(0)).toBe(false);
    expect(upper.has(1)).toBe(false);
    roundTrip("paint-cells", { map: "village", layer: "upper", cells: [[4, 4], [5, 4]], value: "town.3" });
  });

  test("parallel values paint a pattern in one reversible operation", () => {
    const patternCells = [[2, 2], [3, 2], [2, 3], [3, 3], [2, 2]];
    const values = ["town.1", "town.2", "town.3", null, "town.4"];
    const { edited, project } = roundTrip("paint-cells", {
      map: "village", layer: "ground", cells: patternCells, values,
    });
    const village = mapOf(project, "village");
    expect(village.ground[2 * village.width + 2]).toBe("town.4");
    expect(village.ground[2 * village.width + 3]).toBe("town.2");
    expect(village.ground[3 * village.width + 2]).toBe("town.3");
    expect(village.ground[3 * village.width + 3]).toBeNull();
    expect(edited.result).toEqual({ map: "village", layer: "ground", values: 5, cells: 4 });
    expect(edited.addresses).toEqual([
      "map:village/layer:ground/tile:2,2",
      "map:village/layer:ground/tile:3,2",
      "map:village/layer:ground/tile:2,3",
      "map:village/layer:ground/tile:3,3",
    ]);
    expect(edited.patch?.changes.every((change) => change.path.startsWith("/maps/0/ground/"))).toBe(true);
  });

  test("parallel values support sparse upper and passage layers", () => {
    const upper = roundTrip("paint-cells", {
      map: "village", layer: "upper", cells: [[1, 1], [2, 1], [3, 1]], values: ["town.1", null, "town.3"],
    }).project;
    const upperValues = new Map(mapOf(upper, "village").upper ?? []);
    expect(upperValues.get(1 * 20 + 1)).toBe("town.1");
    expect(upperValues.has(1 * 20 + 2)).toBe(false);
    expect(upperValues.get(1 * 20 + 3)).toBe("town.3");

    const passage = roundTrip("paint-cells", {
      map: "village", layer: "passage", cells: [[1, 1], [2, 1], [3, 1]], values: ["block", "pass", null],
    }).project;
    const passageValues = new Map(mapOf(passage, "village").passage ?? []);
    expect(passageValues.get(1 * 20 + 1)).toBe("block");
    expect(passageValues.get(1 * 20 + 2)).toBe("pass");
    expect(passageValues.has(1 * 20 + 3)).toBe(false);
  });

  test("passage strokes equal sequential paint-passage, including clear", () => {
    const passageCells = [[4, 4], [5, 4], [5, 5]];
    for (const value of ["block", "pass"] as const) {
      const { edited, project } = roundTrip("paint-cells", { map: "village", layer: "passage", cells: passageCells, value });
      expect(edited.result).toEqual({ map: "village", layer: "passage", value, cells: 3 });
      let sequential = SOURCE;
      for (const [x, y] of passageCells) {
        sequential = success(executeEditOperation(sequential, "paint-passage", { map: "village", x, y, value })).output;
      }
      expect(semanticEqual(effectiveLayers(JSON.parse(sequential)), effectiveLayers(project))).toBe(true);

      const cleared = success(executeEditOperation(edited.output, "paint-cells", {
        map: "village", layer: "passage", cells: passageCells, value: null,
      }));
      let clearedSequential = edited.output;
      for (const [x, y] of passageCells) {
        clearedSequential = success(executeEditOperation(clearedSequential, "paint-passage", { map: "village", x, y, value: null })).output;
      }
      expect(semanticEqual(effectiveLayers(JSON.parse(cleared.output)), effectiveLayers(JSON.parse(clearedSequential)))).toBe(true);
    }
  });

  test("rejects bad tiles, bad values, malformed and out-of-bounds cells", () => {
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, 0]], value: "dun.5" })))
      .toMatchObject({ code: "INVALID_TILE", path: "$.value" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", layer: "passage", cells: [[0, 0]], value: "town.1" })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.value" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, 0]] })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.value" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, 0]], value: "town.1", values: ["town.2"] })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, 0], [1, 0]], values: ["town.1"] })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.values" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, 0]], values: ["dun.5"] })))
      .toMatchObject({ code: "INVALID_TILE", path: "$.values[0]" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", layer: "passage", cells: [[0, 0]], values: ["town.1"] })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.values[0]" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, 0], [20, 0]], value: "town.1" })))
      .toMatchObject({ code: "OUT_OF_BOUNDS", path: "$.cells[1]" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, -1]], value: "town.1" })))
      .toMatchObject({ code: "OUT_OF_BOUNDS", path: "$.cells[0]" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [[0, 0.5]], value: "town.1" })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.cells[0]" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: [], value: "town.1" })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.cells" });
    const village = mapOf(ORIGINAL, "village");
    const tooMany = Array.from({ length: village.width * village.height + 1 }, () => [0, 0]);
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", cells: tooMany, value: "town.1" })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.cells" });
    expect(failure(executeEditOperation(SOURCE, "paint-cells", { map: "village", layer: "sky", cells: [[0, 0]], value: null })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.layer" });
  });
});

describe("paint-edges", () => {
  test("toggles a sheet-level edge for the painted cell's ground tile", () => {
    const village = mapOf(ORIGINAL, "village");
    const tile = village.ground[2 * village.width + 2] as string;
    const [sheet, rawCell] = tile.split(".");
    const cell = String(Number(rawCell));
    // Two cells with the same tile still toggle the sheet entry only once.
    const sameTile = village.ground.findIndex((value, index) => value === tile && index !== 2 * village.width + 2);
    const cells = [[2, 2], [sameTile % village.width, Math.floor(sameTile / village.width)]];
    const { edited, project } = roundTrip("paint-edges", { map: "village", cells, brush: { kind: "exit", dir: "left" } });
    expect(project.sheets.find((item) => item.id === sheet)!.dirEdges?.[cell]).toEqual({ exit: ["left"] });
    expect(edited.addresses).toEqual([`sheet:${sheet}/cell:${cell}`]);
    expect(edited.result).toMatchObject({ map: "village", cells: 2, changed: [{ sheet, cell, edges: { exit: ["left"] } }] });

    const toggledOff = success(executeEditOperation(edited.output, "paint-edges", {
      map: "village", cells: [[2, 2]], brush: { kind: "exit", dir: "left" },
    }));
    expect(semanticEqual(JSON.parse(toggledOff.output), ORIGINAL)).toBe(true);

    const cleared = success(executeEditOperation(edited.output, "paint-edges", {
      map: "village", cells: [[2, 2]], brush: { kind: "clear" },
    }));
    expect(semanticEqual(JSON.parse(cleared.output), ORIGINAL)).toBe(true);
    expect(cleared.result).toMatchObject({ changed: [{ sheet, cell, edges: null }] });
  });

  test("validates the brush shape", () => {
    expect(failure(executeEditOperation(SOURCE, "paint-edges", { map: "village", cells: [[0, 0]], brush: { kind: "enter" } })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.brush.dir" });
    expect(failure(executeEditOperation(SOURCE, "paint-edges", { map: "village", cells: [[0, 0]], brush: { kind: "clear", dir: "up" } })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.brush" });
    expect(failure(executeEditOperation(SOURCE, "paint-edges", { map: "village", cells: [[0, 0]], brush: { kind: "wall" } })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.brush.kind" });
    expect(failure(executeEditOperation(SOURCE, "paint-edges", { map: "village", cells: [[99, 0]], brush: { kind: "clear" } })))
      .toMatchObject({ code: "OUT_OF_BOUNDS", path: "$.cells[0]" });
  });
});

describe("map structure", () => {
  test("add-map inserts after the anchor through newMap", () => {
    const { edited, project } = roundTrip("add-map", {
      map: "market", name: "Market", width: 6, height: 5, fill: "town.0", after: "village",
    });
    expect(project.maps.map((map) => map.id)).toEqual(["village", "market", "forest", "cave"]);
    expect(edited.addresses).toEqual(["map:market"]);
    expect(edited.result).toMatchObject({ id: "market", name: "Market", width: 6, height: 5, sheets: ["town"], events: [] });
    expect((edited.result as MapDef).ground).toEqual(new Array(30).fill("town.0"));
  });

  test("add-map defaults to the end, inherits the last map's sheets and uniquifies ids", () => {
    const { edited, project } = roundTrip("add-map", { map: "forest" });
    expect(project.maps.map((map) => map.id)).toEqual(["village", "forest", "cave", "forest-2"]);
    expect(edited.result).toMatchObject({ id: "forest-2", width: 20, height: 14, sheets: ["dun"] });
    expect(failure(executeEditOperation(SOURCE, "add-map", { sheets: ["nope"] })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.sheets" });
    expect(failure(executeEditOperation(SOURCE, "add-map", { fill: "dun.0", sheets: ["town"] })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.fill" });
    expect(failure(executeEditOperation(SOURCE, "add-map", { width: 0 })))
      .toMatchObject({ code: "INVALID_ARGUMENT", path: "$.width" });
    expect(failure(executeEditOperation(SOURCE, "add-map", { after: "nowhere" })))
      .toMatchObject({ code: "MAP_NOT_FOUND" });
  });

  test("duplicate-map copies the map after itself with a unique -copy id", () => {
    const { edited, project } = roundTrip("duplicate-map", { map: "forest" });
    expect(project.maps.map((map) => map.id)).toEqual(["village", "forest", "forest-copy", "cave"]);
    expect(edited.addresses).toEqual(["map:forest-copy"]);
    expect({ ...(edited.result as MapDef), id: "forest" }).toEqual(mapOf(ORIGINAL, "forest"));
    const again = success(executeEditOperation(edited.output, "duplicate-map", { map: "forest" }));
    expect((again.result as MapDef).id).toBe("forest-copy-2");
  });

  test("delete-map removes a map and reports the transfers that targeted it", () => {
    const { edited, project } = roundTrip("delete-map", { map: "forest" });
    expect(project.maps.map((map) => map.id)).toEqual(["village", "cave"]);
    expect(edited.addresses).toEqual(["map:forest"]);
    const result = edited.result as { deleted: MapDef; references: { mapId: string }[] };
    expect(result.deleted).toEqual(mapOf(ORIGINAL, "forest"));
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.references.map((ref) => ref.mapId).sort()).toEqual(["cave", "village"]);
  });

  test("delete-map refuses the start map and the only map", () => {
    const start = failure(executeEditOperation(SOURCE, "delete-map", { map: "village" }));
    expect(start).toMatchObject({ code: "MAP_DELETE_REFUSED", path: "$.map", details: { references: [] } });

    let only = SOURCE;
    for (const id of ["forest", "cave"]) only = success(executeEditOperation(only, "delete-map", { map: id })).output;
    expect((JSON.parse(only) as Project).maps.map((map) => map.id)).toEqual(["village"]);
    expect(failure(executeEditOperation(only, "delete-map", { map: "village" })))
      .toMatchObject({ code: "MAP_DELETE_REFUSED", path: "$.map" });
    expect(failure(executeEditOperation(SOURCE, "delete-map", { map: "nowhere" })))
      .toMatchObject({ code: "MAP_NOT_FOUND" });
  });
});

describe("MCP schemas", () => {
  test("accept the documented argument shapes and reject malformed ones", () => {
    const schema = (name: string) => EDIT_TOOL_BY_NAME.get(name)!.inputSchema;
    expect(validateSchema(schema("rpgkit_tile_rect"), { file: "p.json", map: "village", x: 0, y: 0, width: 2, height: 2, tile: "town.1" })).toEqual([]);
    expect(validateSchema(schema("rpgkit_tile_rect"), { file: "p.json", map: "village", layer: "passage", x: 0, y: 0, width: 2, height: 2, value: "block" })).toEqual([]);
    expect(validateSchema(schema("rpgkit_tile_rect"), { file: "p.json", map: "village", layer: "passage", x: 0, y: 0, width: 10, height: 8, template: "room", doors: [[4, 7]] })).toEqual([]);
    expect(validateSchema(schema("rpgkit_tile_rect"), { file: "p.json", map: "village", layer: "passage", x: 0, y: 0, width: 2, height: 2, tile: "block" })).not.toEqual([]);
    expect(validateSchema(schema("rpgkit_tile_rect"), { file: "p.json", map: "village", x: 0, y: 0, width: 2, height: 2, value: "block" })).not.toEqual([]);
    expect(validateSchema(schema("rpgkit_tile_rect"), { file: "p.json", map: "village", layer: "passage", x: 0, y: 0, width: 2, height: 2, value: "block", template: "room" })).not.toEqual([]);
    expect(validateSchema(schema("rpgkit_cells_paint"), { file: "p.json", map: "village", layer: "passage", cells: [[0, 1]], value: null })).toEqual([]);
    expect(validateSchema(schema("rpgkit_cells_paint"), { file: "p.json", map: "village", cells: [[0, 1], [1, 1]], values: ["town.1", "town.2"] })).toEqual([]);
    expect(validateSchema(schema("rpgkit_cells_paint"), { file: "p.json", map: "village", cells: [[0, 1]], value: "town.1", values: ["town.2"] })).not.toEqual([]);
    expect(validateSchema(schema("rpgkit_cells_paint"), { file: "p.json", map: "village", cells: [[0, 1]] })).not.toEqual([]);
    expect(validateSchema(schema("rpgkit_cells_paint"), { file: "p.json", map: "village", cells: [[0]], value: "town.1" })).not.toEqual([]);
    expect(validateSchema(schema("rpgkit_edges_paint"), { file: "p.json", map: "village", cells: [[0, 1]], brush: { kind: "enter", dir: "up" } })).toEqual([]);
    expect(validateSchema(schema("rpgkit_edges_paint"), { file: "p.json", map: "village", cells: [[0, 1]], brush: { kind: "clear" } })).toEqual([]);
    expect(validateSchema(schema("rpgkit_edges_paint"), { file: "p.json", map: "village", cells: [[0, 1]], brush: { kind: "clear", dir: "up" } })).not.toEqual([]);
    expect(validateSchema(schema("rpgkit_map_add"), { file: "p.json" })).toEqual([]);
    expect(validateSchema(schema("rpgkit_map_add"), { file: "p.json", map: "m", name: "M", width: 4, height: 4, sheets: ["town"], fill: null, after: "village" })).toEqual([]);
    expect(validateSchema(schema("rpgkit_project_validate"), { file: "p.json", map: "village" })).toEqual([]);
    expect(validateSchema(schema("rpgkit_project_validate"), { file: "p.json", map: 1 })).not.toEqual([]);
  });
});

describe("validate map scope", () => {
  test("validates one inline map without reporting an invalid sibling", () => {
    const project = structuredClone(ORIGINAL);
    const forestIndex = project.maps.findIndex((map) => map.id === "forest");
    project.maps[forestIndex]!.ground.pop();
    const source = JSON.stringify(project);

    const full = executeEditOperation(source, "validate").response;
    expect(full).toMatchObject({ ok: true, result: { valid: false } });
    const village = executeEditOperation(source, "validate", { map: "village" }).response;
    expect(village).toMatchObject({
      ok: true,
      result: { valid: true, errors: [], scopedMap: "village" },
    });
    const forest = executeEditOperation(source, "validate", { map: "forest" }).response;
    expect(forest).toMatchObject({ ok: true, result: { valid: false, scopedMap: "forest" } });
    if (forest.ok) {
      expect((forest.result as { errors: { path: string }[] }).errors[0]!.path)
        .toStartWith(`$.maps[${forestIndex}]`);
    }
  });
});

describe("sharded ProjectShell", () => {
  const split = splitProjectMaps(ORIGINAL);
  const sources = Object.fromEntries(split.entries.map((entry) => [entry.path, entry.text]));
  const villageEntry = split.shell.mapIndex.find((meta) => meta.id === "village")!.entry;

  test("paint-cells edits exactly one shard and reverses through save", () => {
    const shell = loadValidatedProjectShell(split.shellText);
    const args = { map: "village", cells: [[2, 2], [3, 2]], value: "town.1" };
    expect(shardEntriesForOperation(shell, "paint-cells", args)).toEqual([villageEntry]);
    const execution = executeShardedEditOperation(split.shellText, { [villageEntry]: sources[villageEntry]! }, "paint-cells", args);
    if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
    expect(execution.response.changed).toBe(true);
    expect(execution.response.result).toEqual({ map: "village", layer: "ground", value: "town.1", cells: 2 });
    expect(Object.keys(execution.output!.shards)).toEqual([villageEntry]);
    const editedMap = JSON.parse(execution.output!.shards[villageEntry]!) as MapDef;
    const inline = JSON.parse(success(executeEditOperation(SOURCE, "paint-cells", args)).output) as Project;
    expect(semanticEqual(editedMap, mapOf(inline, "village"))).toBe(true);

    const reversed = executeShardedEditOperation(
      execution.output!.shell,
      { [villageEntry]: execution.output!.shards[villageEntry]! },
      "save",
      { patch: execution.response.patch, direction: "reverse" },
    );
    if (!reversed.response.ok) throw new Error(JSON.stringify(reversed.response));
    expect(semanticEqual(JSON.parse(reversed.output!.shards[villageEntry]!), mapOf(ORIGINAL, "village"))).toBe(true);
    expect(semanticEqual(JSON.parse(reversed.output!.shell), split.shell)).toBe(true);
  });

  test("a room template edits exactly one shell shard as one reversible patch", () => {
    const shell = loadValidatedProjectShell(split.shellText);
    const args = {
      map: "village", layer: "passage", x: 0, y: 0, width: 10, height: 8,
      template: "room", doors: [[4, 7]],
    };
    expect(shardEntriesForOperation(shell, "paint-rect", args)).toEqual([villageEntry]);
    const execution = executeShardedEditOperation(
      split.shellText,
      { [villageEntry]: sources[villageEntry]! },
      "paint-rect",
      args,
    );
    if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
    expect(execution.response.result).toMatchObject({ blocked: 31, passable: 49, cells: 80 });
    expect(Object.keys(execution.output!.shards)).toEqual([villageEntry]);

    const reversed = executeShardedEditOperation(
      execution.output!.shell,
      { [villageEntry]: execution.output!.shards[villageEntry]! },
      "save",
      { patch: execution.response.patch, direction: "reverse" },
    );
    if (!reversed.response.ok) throw new Error(JSON.stringify(reversed.response));
    expect(semanticEqual(JSON.parse(reversed.output!.shards[villageEntry]!), mapOf(ORIGINAL, "village"))).toBe(true);
  });

  test("scoped validation selects exactly one shell shard", () => {
    const shell = loadValidatedProjectShell(split.shellText);
    expect(shardEntriesForOperation(shell, "validate", {})).toEqual(split.entries.map((entry) => entry.path));
    expect(shardEntriesForOperation(shell, "validate", { map: "village" })).toEqual([villageEntry]);
    const execution = executeShardedEditOperation(
      split.shellText,
      { [villageEntry]: sources[villageEntry]! },
      "validate",
      { map: "village" },
    );
    expect(execution.response).toMatchObject({
      ok: true,
      result: { valid: true, errors: [], scopedMap: "village" },
    });
    expect(executeShardedEditOperation(split.shellText, {}, "validate", { map: "missing" }).response)
      .toMatchObject({ ok: false, error: { code: "MAP_NOT_FOUND", path: "$.map" } });
  });

  const refused: [string, Record<string, unknown>][] = [
    ["add-map", {}],
    ["duplicate-map", { map: "forest" }],
    ["delete-map", { map: "forest" }],
    ["move-map", { map: "forest", index: 0 }],
    ["paint-edges", { map: "village", cells: [[0, 0]], brush: { kind: "clear" } }],
  ];

  for (const [command, args] of refused) {
    test(`${command} fails closed before any shard is selected`, () => {
      const shell = loadValidatedProjectShell(split.shellText);
      expect(() => shardEntriesForOperation(shell, command, args)).toThrow(/Use a reviewed proposal/);
      const execution = executeShardedEditOperation(split.shellText, {}, command, args);
      expect(execution.output).toBeUndefined();
      expect(execution.response).toMatchObject({ ok: false, command, error: { code: "UNSUPPORTED_FOR_SHELL" } });
      if (!execution.response.ok) expect(execution.response.error.message).toContain("propose, then accept-proposal");
      // Supplying every shard does not change the answer.
      expect(executeShardedEditOperation(split.shellText, sources, command, args).response)
        .toMatchObject({ ok: false, error: { code: "UNSUPPORTED_FOR_SHELL" } });
    });
  }

  test("the file adapter refuses structural commands without writing", () => {
    const root = join(TEMP, "shell");
    const shellFile = join(root, "project.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(shellFile, split.shellText);
    for (const entry of split.entries) {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true });
      writeFileSync(join(root, entry.path), entry.text);
    }
    for (const [command, args] of refused) {
      expect(runFileEdit({ command, file: shellFile, args })).toMatchObject({
        ok: false, written: false, error: { code: "UNSUPPORTED_FOR_SHELL" },
      });
    }
    expect(readFileSync(shellFile, "utf8")).toBe(split.shellText);
  });
});
