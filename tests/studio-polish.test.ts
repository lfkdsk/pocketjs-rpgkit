import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EDIT_COMMANDS } from "../editor/api/types.ts";
import { EditSession } from "../editor/api/session.ts";
import { fuzzyScore, rankCommands, type StudioCommand } from "../editor/studio/command-palette.ts";
import { StudioApp } from "../editor/studio/app.ts";
import { isStudioMapBlank } from "../editor/studio/canvas.ts";
import { normalizeStudioPreferences } from "../editor/studio/host.ts";
import { hoverCardX, hoverCardPlacement } from "../editor/studio/event-hover-card.ts";
import { mapDropIndex } from "../editor/studio/map-tree.ts";
import { rectangularTileSelection, searchPaletteTiles } from "../editor/studio/palette.ts";
import { SHORTCUT_GROUPS } from "../editor/studio/shortcuts.ts";

describe("Studio polish contracts", () => {
  test("filtered no-op drops do not cross hidden maps", () => {
    const order = ["village", "hidden-forest", "cave", "hidden-end"];
    const shown = ["village", "cave"];

    // Either side of the current visible position remains a true no-op,
    // even though the full order has a hidden map in that gap.
    expect(mapDropIndex(order, shown, "village", 0)).toBeNull();
    expect(mapDropIndex(order, shown, "village", 1)).toBeNull();
    expect(mapDropIndex(order, shown, "cave", 1)).toBeNull();
    expect(mapDropIndex(order, shown, "cave", 2)).toBeNull();

    // A visible-order change still anchors to the visible neighbour.
    expect(mapDropIndex(order, shown, "village", 2)).toBe(2);
    expect(mapDropIndex(order, shown, "cave", 0)).toBe(0);
  });

  test("the shortcuts panel lists keyboard zoom and map-list endpoints", () => {
    const view = SHORTCUT_GROUPS.find((group) => group.title === "View")!;
    const maps = SHORTCUT_GROUPS.find((group) => group.title === "Maps and commands")!;
    expect(view.items).toContainEqual({ keys: [["="], ["+"], ["-"]], action: "Zoom in or out" });
    expect(maps.items).toContainEqual({ keys: [["Home"], ["End"]], action: "First or last map" });
    expect(SHORTCUT_GROUPS.flatMap((group) => group.items)).toContainEqual({ keys: [["Mod", "K"]], action: "Open the command palette" });
  });

  test("the command palette fuzzy-matches ordered characters and ranks recent ties first", () => {
    expect(fuzzyScore("cmd pal", "Command palette")).not.toBeNull();
    expect(fuzzyScore("zzq", "Command palette")).toBeNull();
    const command = (id: string, label: string): StudioCommand => ({ id, label, section: "Actions", run() {} });
    const ranked = rankCommands([command("first", "Alpha"), command("recent", "Alpine"), command("other", "Beta")], "al", ["recent"]);
    expect(ranked.map((item) => item.command.id)).toEqual(["recent", "first"]);
    const empty = rankCommands([command("first", "Alpha"), command("recent", "Alpine")], "", ["recent"]);
    expect(empty.map((item) => item.command.id)).toEqual(["recent", "first"]);
  });

  test("Studio preferences are bounded and reject corrupt persisted values", () => {
    const normalized = normalizeStudioPreferences({
      motion: "reduced",
      favoriteTiles: ["town.1", "town.1", 4, "town.2"],
      recentCommands: Array.from({ length: 30 }, (_, index) => `command:${index}`),
    });
    expect(normalized.motion).toBe("reduced");
    expect(normalized.favoriteTiles).toEqual(["town.1", "town.2"]);
    expect(normalized.recentCommands).toHaveLength(24);
    expect(normalizeStudioPreferences({ motion: "turbo" })).toEqual({ motion: "system", favoriteTiles: [], recentCommands: [] });
  });

  test("tile search matches sheet names, full ids and exact numeric cells", () => {
    const sheets = [{ id: "town", cols: 4, rows: 2 }, { id: "dungeon", cols: 2, rows: 2 }];
    expect(searchPaletteTiles(sheets, "#3").matches.map((item) => item.tile)).toEqual(["town.3", "dungeon.3"]);
    expect(searchPaletteTiles(sheets, "town.6").matches.map((item) => item.tile)).toEqual(["town.6"]);
    expect(searchPaletteTiles(sheets, "DUNG").total).toBe(4);
    expect(searchPaletteTiles(sheets, "town", 3)).toMatchObject({ total: 8, matches: [{ tile: "town.0" }, { tile: "town.1" }, { tile: "town.2" }] });
    expect(searchPaletteTiles(sheets, "missing")).toEqual({ matches: [], total: 0 });
  });

  test("reverse atlas drags create a row-major pattern with stable recent order", () => {
    const sheet = { id: "town", cols: 4, rows: 3 };
    const selection = rectangularTileSelection(sheet, { x: 2, y: 2 }, { x: 1, y: 0 });
    expect(selection).toEqual({
      sheet: "town", x: 1, y: 0, width: 2, height: 3,
      tiles: ["town.1", "town.2", "town.5", "town.6", "town.9", "town.10"],
    });
    const app = new StudioApp();
    app.recentTiles = ["town.20", "town.2"];
    app.setTileSelection(selection);
    expect(app.brush).toBe("town.1");
    expect(app.recentTiles).toEqual(["town.1", "town.2", "town.5", "town.6", "town.9", "town.10", "town.20"]);
    expect(app.tileAtBrushOffset(0, 0)).toBe("town.1");
    expect(app.tileAtBrushOffset(3, 4)).toBe("town.6");
    expect(app.tileAtBrushOffset(-1, -1)).toBe("town.10");
  });

  test("passage overrides count as authored map content", () => {
    const empty = { ground: [null, null, null, null], upper: [], events: [], passage: [] };
    expect(isStudioMapBlank(empty)).toBe(true);
    expect(isStudioMapBlank({ ...empty, passage: [[2, "block"]] })).toBe(false);
    expect(isStudioMapBlank({ ...empty, ground: [null, "town.1", null, null] })).toBe(false);
  });

  test("hover cards choose the roomier side and clamp symmetrically", () => {
    expect(hoverCardX(1_000, 300, 20, 200)).toBe(332);
    expect(hoverCardX(1_000, 700, 20, 200)).toBe(468);
    expect(hoverCardX(1_000, 500, 20, 200)).toBe(532);
    expect(hoverCardX(300, 150, 8, 400)).toBe(8);
  });

  test("hover card placement reports the chosen side and whether it clamped", () => {
    // Event left of centre: the right side is roomier.
    expect(hoverCardPlacement(1_000, 300, 20, 200)).toMatchObject({ x: 332, side: "right", clamped: false });
    // Event right of centre: the left side is roomier.
    expect(hoverCardPlacement(1_000, 700, 20, 200)).toMatchObject({ x: 468, side: "left", clamped: false });
    // A tie (equal rooms) opens on the right, deterministically.
    const tied = hoverCardPlacement(1_000, 500, 20, 200);
    expect(tied.side).toBe("right");
    // Card wider than the host clamps to the 8 px inset and reports clamped.
    const clamped = hoverCardPlacement(300, 150, 8, 400);
    expect(clamped.x).toBe(8);
    expect(clamped.clamped).toBe(true);
    // A wide card whose roomier (left) side still runs off the host clamps to
    // the inset and keeps reporting the side it chose, so data-side stays
    // trustworthy even when the card is pinned to the edge.
    const pinned = hoverCardPlacement(400, 350, 20, 350);
    expect(pinned.side).toBe("left");
    expect(pinned.x).toBe(8);
    expect(pinned.clamped).toBe(true);
  });

  test("a pattern that is not declared by the next map is cleared", () => {
    const source = readFileSync(join(import.meta.dir, "..", "examples", "sunstone", "data", "sunstone.json"), "utf8");
    const app = new StudioApp();
    app.load(EditSession.open(source), { label: "test", savesTo: "storage" });
    app.setTileSelection(rectangularTileSelection({ id: "town", cols: 12, rows: 11 }, { x: 0, y: 0 }, { x: 1, y: 1 }));
    expect(app.tileSelection?.sheet).toBe("town");
    app.openMap("cave");
    expect(app.tileSelection).toBeNull();
    expect(app.brush?.startsWith("dun.")).toBe(true);
  });

  test("the protocol operation total and names stay in sync", () => {
    const docs = readFileSync(join(import.meta.dir, "..", "docs", "protocols.md"), "utf8");
    const match = docs.match(/- \*\*Operations\*\* \((\d+)\):([\s\S]*?)\n- \*\*Addresses/);
    expect(match).not.toBeNull();
    const documented = [...match![2]!.matchAll(/`([^`]+)`/g)]
      .map((item) => item[1])
      .filter((name): name is (typeof EDIT_COMMANDS)[number] => EDIT_COMMANDS.includes(name as (typeof EDIT_COMMANDS)[number]));
    expect(Number(match![1])).toBe(EDIT_COMMANDS.length);
    expect([...documented].sort()).toEqual([...EDIT_COMMANDS].sort());
  });
});
