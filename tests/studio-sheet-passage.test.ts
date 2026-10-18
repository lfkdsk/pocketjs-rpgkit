import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseShardedPack, serializeShardedPack } from "../editor/api/pack.ts";
import { EditSession } from "../editor/api/session.ts";
import {
  clearSheetCellsDirBlock,
  normalizeSheetDirBlock,
  resolveSheetCellPassage,
  setSheetCellsDirBlocked,
  setSheetCellsPassage,
  setSheetDefaultPassage,
  sheetDirBlockLine,
  sheetDirBlockMask,
  updateSheetPassageOperation,
} from "../editor/studio/sheet-passage.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Dir, Project, Sheet } from "../src/engine/types.ts";

describe("Studio tile-sheet passage", () => {
  test("resolution matches runtime pass > block > default precedence", () => {
    const sheet: Sheet = {
      id: "walls", pak: "chunks", cols: 4, rows: 1,
      defaultPassage: "block",
      block: [1, 2],
      pass: [1],
    };
    expect(resolveSheetCellPassage(sheet, 0)).toMatchObject({ value: "block", source: "default", blocked: true });
    expect(resolveSheetCellPassage(sheet, 1)).toMatchObject({ value: "pass", source: "pass", blocked: false });
    expect(resolveSheetCellPassage(sheet, 2)).toMatchObject({ value: "block", source: "block", blocked: true });
    expect(resolveSheetCellPassage({ ...sheet, defaultPassage: undefined }, 3))
      .toMatchObject({ authoredDefault: null, defaultPassage: "pass", value: "pass", source: "default" });
    expect(setSheetDefaultPassage(null)).toEqual({ defaultPassage: null });
  });

  test("batch passage changes remove the opposite exception and empty fields", () => {
    const sheet = { pass: [3, 1, 2, 2], block: [2, 4] };
    expect(setSheetCellsPassage(sheet, [2, 4, 4], "default")).toEqual({ pass: [1, 3], block: null });
    expect(setSheetCellsPassage(sheet, [1, 2], "block")).toEqual({ pass: [3], block: [1, 2, 4] });
    expect(setSheetCellsPassage({ pass: [1], block: [1] }, 1, "pass")).toEqual({ pass: [1], block: null });
  });

  test("dirBlock normalization and masks retain the runtime direction bits", () => {
    const normalized = normalizeSheetDirBlock({
      "01": ["right", "down", "right"],
      "1": ["left"],
      "2": [],
    });
    expect(normalized).toEqual({ "1": ["down", "left", "right"] });
    expect(normalizeSheetDirBlock({ "2": [] })).toBeUndefined();

    const expected: Record<Dir, number> = { down: 1, left: 2, up: 4, right: 8 };
    for (const [direction, bit] of Object.entries(expected) as [Dir, number][]) {
      expect(sheetDirBlockMask({ dirBlock: { "7": [direction] } }, 7), direction).toBe(bit);
    }
  });

  test("batch symmetric walls deduplicate targets and clean the last empty entry", () => {
    const added = setSheetCellsDirBlocked({ dirBlock: { "8": ["left"] } }, [3, 3, 8], "up", true);
    expect(added).toEqual({ dirBlock: { "3": ["up"], "8": ["left", "up"] } });
    expect(setSheetCellsDirBlocked({ dirBlock: added.dirBlock ?? undefined }, [3], "up", false))
      .toEqual({ dirBlock: { "8": ["left", "up"] } });
    expect(clearSheetCellsDirBlock({ dirBlock: { "3": ["up"], "8": ["left"] } }, [3, 8]))
      .toEqual({ dirBlock: null });
  });

  test("solid dirBlock overlay geometry maps every direction to its named edge", () => {
    expect(sheetDirBlockLine("up", 10, 20, 16)).toEqual({ x1: 10, y1: 20, x2: 26, y2: 20 });
    expect(sheetDirBlockLine("down", 10, 20, 16)).toEqual({ x1: 10, y1: 36, x2: 26, y2: 36 });
    expect(sheetDirBlockLine("left", 10, 20, 16)).toEqual({ x1: 10, y1: 20, x2: 10, y2: 36 });
    expect(sheetDirBlockLine("right", 10, 20, 16)).toEqual({ x1: 26, y1: 20, x2: 26, y2: 36 });
  });

  test("sheet passage controls use pack-safe update-sheet and touch no shard", () => {
    const root = join(import.meta.dir, "..");
    const source = readFileSync(join(root, "examples", "sunstone", "data", "sunstone.json"), "utf8");
    const split = splitProjectMaps(JSON.parse(source) as Project);
    const pack = serializeShardedPack(
      split.shellText,
      split.shell.mapIndex,
      new Map(split.entries.map((entry) => [entry.path, entry.text])),
    );
    const before = parseShardedPack(pack);
    const session = EditSession.open(pack);
    const operation = updateSheetPassageOperation("town", {
      defaultPassage: "block",
      dirBlock: { "1": ["left"] },
    });
    const response = session.run(operation.command, operation.args, "Sheet passage");
    expect(response).toMatchObject({ ok: true, changed: true });
    expect(session.history().map((entry) => entry.commands)).toEqual([["update-sheet"]]);
    const after = parseShardedPack(session.exportText());
    expect(after.shards).toEqual(before.shards);
    expect(JSON.parse(after.shellText).sheets.find((sheet: Sheet) => sheet.id === "town"))
      .toMatchObject({ defaultPassage: "block", dirBlock: { "1": ["left"] } });
    expect(session.undo()).toMatchObject({ ok: true });
    expect(session.exportText()).toBe(pack);
  });
});
