// Studio's document layer: every edit kind goes through editor/api, lands as
// one reversible patch-v1 history step, and undo/redo replay that patch
// through the protocol's own `save` operation. The export matches the
// PocketJS editor's save path byte-for-byte on a shared scenario, and
// sharded packs only rewrite the shards an edit touched. The pack group runs
// through StudioFiles on the in-memory host.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseShardedPack, serializeShardedPack, SHARDED_PACK_KIND } from "../editor/api/pack.ts";
import { EditSession } from "../editor/api/session.ts";
import { executeEditOperation } from "../editor/api/operations.ts";
import { loadProject, serializeProjectPreservingSource } from "../editor/engine/document.ts";
import {
  createEditorState,
  createEventAt,
  exportProject,
  paintCell,
  selectLayer,
  selectMap,
  selectTile,
  strokeEnd,
  strokeStart,
  updateSelectedPage,
} from "../editor/engine/model.ts";
import { StudioApp } from "../editor/studio/app.ts";
import { ArtRegistry } from "../editor/studio/art.ts";
import { StudioFiles } from "../editor/studio/files.ts";
import { MemoryHost } from "../editor/studio/host-memory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = join(import.meta.dir, "..");
const SUNSTONE = readFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), "utf8");

function sunstonePack(): string {
  const split = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
  return serializeShardedPack(split.shellText, split.shell.mapIndex, new Map(split.entries.map((entry) => [entry.path, entry.text])));
}

/** One representative call per modifying operation Studio issues. */
const EDITS: { name: string; command: Parameters<EditSession["run"]>[0]; args: Record<string, unknown> }[] = [
  { name: "brush stroke", command: "paint-cells", args: { map: "village", layer: "ground", cells: [[1, 1], [2, 1], [3, 2]], value: "town.37" } },
  { name: "pattern brush stroke", command: "paint-cells", args: { map: "village", layer: "ground", cells: [[1, 1], [2, 1], [1, 2], [2, 2]], values: ["town.1", "town.2", "town.3", "town.4"] } },
  { name: "upper stroke", command: "paint-cells", args: { map: "village", layer: "upper", cells: [[4, 4]], value: "town.12" } },
  { name: "eraser", command: "paint-cells", args: { map: "village", layer: "upper", cells: [[0, 0], [1, 0]], value: null } },
  { name: "passage stroke", command: "paint-cells", args: { map: "village", layer: "passage", cells: [[2, 2], [3, 3]], value: "block" } },
  { name: "region stroke", command: "paint-cells", args: { map: "village", layer: "regions", cells: [[2, 2], [3, 3]], value: 17 } },
  { name: "region rectangle", command: "paint-rect", args: { map: "village", layer: "regions", x: 2, y: 2, width: 2, height: 2, value: 255 } },
  { name: "rectangle", command: "paint-rect", args: { map: "village", layer: "ground", x: 2, y: 2, width: 3, height: 2, tile: "town.40" } },
  { name: "fill", command: "fill-region", args: { map: "village", layer: "ground", x: 1, y: 1, tile: "town.41" } },
  { name: "one-way edge", command: "paint-edges", args: { map: "village", cells: [[5, 5]], brush: { kind: "enter", dir: "left" } } },
  { name: "map properties", command: "update-map", args: { map: "village", changes: { name: "Bramble Hollow (edited)", width: 22 } } },
  { name: "new map", command: "add-map", args: { map: "meadowlands", width: 12, height: 9 } },
  { name: "duplicate map", command: "duplicate-map", args: { map: "forest" } },
  { name: "delete map", command: "delete-map", args: { map: "cave" } },
  { name: "reorder maps", command: "move-map", args: { map: "cave", index: 0 } },
  { name: "new event", command: "add-event", args: { map: "village", event: { id: "studio-npc", x: 5, y: 5, pages: [{ trigger: "action", commands: [] }] } } },
  { name: "move event", command: "update-event", args: { map: "village", event: "elder", changes: { x: 8, y: 4, name: "Elder (moved)" } } },
  { name: "delete event", command: "delete-event", args: { map: "village", event: "sign" } },
  { name: "new page", command: "add-page", args: { map: "village", event: "elder", page: { trigger: "playerTouch", commands: [] }, index: 0 } },
  { name: "page fields", command: "update-page", args: { map: "village", event: "boy", page: 0, value: { trigger: "autorun", commands: [] } } },
  { name: "insert command", command: "insert-command", args: { map: "village", event: "elder", page: 0, address: { path: [], index: 0 }, command: { op: "text", lines: ["Hi"] } } },
  { name: "command field", command: "update-command", args: { map: "village", event: "sign", page: 0, address: { path: [], index: 0 }, field: "lines", value: "Edited sign" } },
];

describe("Studio edit session (inline)", () => {
  for (const edit of EDITS) {
    test(`${edit.name}: one reversible ${edit.command} step`, () => {
      const session = EditSession.open(SUNSTONE);
      const response = session.run(edit.command, edit.args, edit.name);
      if (!response.ok) throw new Error(`${edit.command}: ${response.error.message}`);
      expect(response.changed).toBe(true);
      expect(response.patch?.format).toBe("rpgkit-edit/patch-v1");
      expect(session.history().map((entry) => entry.commands)).toEqual([[edit.command]]);
      const edited = session.exportText();
      // The same operation through the plain protocol yields the same bytes.
      expect(executeEditOperation(SUNSTONE, edit.command, edit.args).output).toBe(edited);
      expect(loadProject(edited).errors).toEqual([]);
      expect(session.undo()?.ok).toBe(true);
      expect(session.exportText()).toBe(SUNSTONE);
      expect(session.isDirty()).toBe(false);
      expect(session.redo()?.ok).toBe(true);
      expect(session.exportText()).toBe(edited);
    });
  }

  test("a failed operation leaves document and history untouched", () => {
    const session = EditSession.open(SUNSTONE);
    const response = session.run("paint-cells", { map: "village", layer: "ground", cells: [[99, 0]], value: "town.1" });
    expect(response.ok).toBe(false);
    expect(session.history()).toHaveLength(0);
    expect(session.exportText()).toBe(SUNSTONE);
  });

  test("region values round-trip sparsely and 0/null erase", () => {
    const session = EditSession.open(SUNSTONE);
    expect(session.run("paint-cells", { map: "village", layer: "regions", cells: [[1, 1], [2, 1], [3, 1]], values: [1, 255, 0] }).ok).toBe(true);
    expect(session.map("village")!.regions).toEqual([[21, 1], [22, 255]]);
    expect(session.run("paint-rect", { map: "village", layer: "regions", x: 1, y: 1, width: 1, height: 1, value: null }).ok).toBe(true);
    expect(session.map("village")!.regions).toEqual([[22, 255]]);
    const edited = session.exportText();
    expect(loadProject(edited).project.maps.find((map) => map.id === "village")?.regions).toEqual([[22, 255]]);
    session.undo();
    expect(session.map("village")!.regions).toEqual([[21, 1], [22, 255]]);
    session.redo();
    expect(session.map("village")!.regions).toEqual([[22, 255]]);

    const invalid = session.run("paint-cells", { map: "village", layer: "regions", cells: [[0, 0]], value: 256 });
    expect(invalid.ok).toBe(false);
  });

  test("editing a region keeps untouched authored duplicate pairs verbatim", () => {
    const project = JSON.parse(SUNSTONE) as Project;
    project.maps.find((map) => map.id === "village")!.regions = [[21, 3], [21, 4], [22, 5]];
    const session = EditSession.open(JSON.stringify(project));
    expect(session.run("paint-cells", { map: "village", layer: "regions", cells: [[2, 1]], value: 9 }).ok).toBe(true);
    expect(session.map("village")!.regions).toEqual([[21, 3], [21, 4], [22, 9]]);
  });

  test("text-field edits preserve RPG Maker escape source through undo and redo", () => {
    const session = EditSession.open(SUNSTONE);
    const raw = String.raw`\C[2]Danger\C[0] \\ path`;
    expect(session.run("update-command", {
      map: "village", event: "sign", page: 0,
      address: { path: [], index: 0 }, field: "lines", value: raw,
    }).ok).toBe(true);
    const line = () => (session.map("village")!.events!.find((event) => event.id === "sign")!.pages[0]!.commands[0] as { lines: string[] }).lines[0];
    expect(line()).toBe(raw);
    session.undo();
    expect(line()).not.toBe(raw);
    session.redo();
    expect(line()).toBe(raw);
  });

  test("a transaction is one step whose patch replays through save", () => {
    const session = EditSession.open(SUNSTONE);
    const response = session.transaction("Move page", [
      { command: "add-page", args: { map: "village", event: "elder", page: { trigger: "action", commands: [] }, index: 1 } },
      { command: "insert-command", args: { map: "village", event: "elder", page: 1, address: { path: [], index: 0 }, command: { op: "text", lines: ["two"] } } },
    ]);
    expect(response.ok).toBe(true);
    expect(session.history()).toHaveLength(1);
    const edited = session.exportText();
    session.undo();
    expect(session.exportText()).toBe(SUNSTONE);
    session.redo();
    expect(session.exportText()).toBe(edited);
    // All or nothing: a failing step rolls the whole transaction back.
    const failed = session.transaction("broken", [
      { command: "paint-tile", args: { map: "village", layer: "ground", x: 0, y: 0, tile: "town.1" } },
      { command: "delete-event", args: { map: "village", event: "no-such-event" } },
    ]);
    expect(failed.ok).toBe(false);
    expect(session.exportText()).toBe(edited);
    expect(session.history()).toHaveLength(1);
  });

  test("history jumps walk undo/redo to any depth", () => {
    const session = EditSession.open(SUNSTONE);
    for (const x of [1, 2, 3]) session.run("paint-tile", { map: "village", layer: "ground", x, y: 1, tile: "town.5" });
    const three = session.exportText();
    session.jumpTo(0);
    expect(session.exportText()).toBe(SUNSTONE);
    expect(session.future()).toHaveLength(3);
    session.jumpTo(3);
    expect(session.exportText()).toBe(three);
  });

  test("export matches the PocketJS editor's save bytes for the same edits", () => {
    // PocketJS editor: model reducers, then app.tsx's save serialization.
    const original = JSON.parse(SUNSTONE) as Project;
    let state = createEditorState(original);
    state = selectMap(state, 1);
    state = selectLayer(state, "ground");
    state = selectTile(state, "town.37");
    state = strokeStart(state);
    for (const index of [18 * 2 + 2, 18 * 2 + 3, 18 * 3 + 3]) state = paintCell(state, index);
    state = strokeEnd(state);
    state = createEventAt(state, 6, 6);
    state = updateSelectedPage(state, (page) => ({ ...page, commands: [{ op: "text", lines: ["Hello from both editors"] }] }));
    const pocketjs = serializeProjectPreservingSource(SUNSTONE, original, exportProject(state));

    // Studio: the same edits as protocol operations.
    const session = EditSession.open(SUNSTONE);
    expect(session.run("paint-cells", { map: "forest", layer: "ground", cells: [[2, 2], [3, 2], [3, 3]], value: "town.37" }).ok).toBe(true);
    expect(session.run("add-event", { map: "forest", event: { id: "event", x: 6, y: 6, pages: [{ trigger: "action", commands: [] }] } }).ok).toBe(true);
    expect(session.run("insert-command", { map: "forest", event: "event", page: 0, address: { path: [], index: 0 }, command: { op: "text", lines: ["Hello from both editors"] } }).ok).toBe(true);
    expect(session.exportText()).toBe(pocketjs);
  });
});

// This group drives the pack through Studio's own document layer
// (StudioFiles) on the in-memory host, so it also shows that the UI's file
// flow runs without a browser underneath.
function studioOnMemoryHost(): { host: MemoryHost; app: StudioApp; files: StudioFiles } {
  const host = new MemoryHost();
  const app = new StudioApp();
  const files = new StudioFiles(app, new ArtRegistry(), host);
  return { host, app, files };
}

function openPick(host: MemoryHost, name: string, text: string): void {
  host.filePicks.push({ name, text });
  host.pickProjectFile();
}

describe("Studio edit session (sharded pack, through StudioFiles on the memory host)", () => {
  test("opens lazily, edits one shard, exports a pack that differs only there", async () => {
    const source = sunstonePack();
    const { host, app, files } = studioOnMemoryHost();
    openPick(host, "sunstone-pack.json", source);
    await Bun.sleep(0);
    const session = app.session!;
    expect(session.kind).toBe("pack");
    expect(app.notices.at(-1)?.text).toBe("Opened sharded pack sunstone-pack.json.");
    // StudioApp opens the start map, so exactly its shard is parsed.
    expect(app.mapId).toBe("village");
    expect(session.loadedEntries()).toEqual(["maps/village.json"]);
    expect(session.maps().map((map) => map.id)).toEqual(["cave", "forest", "village"]);
    app.openMap("forest");
    expect(app.currentMap()?.id).toBe("forest");
    expect(session.loadedEntries()).toEqual(["maps/village.json", "maps/forest.json"]);

    const response = app.run("paint-cells", { map: "forest", layer: "ground", cells: [[1, 1], [2, 1]], value: "town.37" });
    expect(response?.ok).toBe(true);
    expect(session.dirtyEntries()).toEqual(["maps/forest.json"]);
    await files.download();
    expect(host.exports.map((item) => item.fileName)).toEqual(["sunstone-pack.json"]);
    const exported = parseShardedPack(host.exports[0]!.text);
    const original = parseShardedPack(source);
    const changed = [...original.shards.keys()].filter((entry) => original.shards.get(entry) !== exported.shards.get(entry));
    expect(changed).toEqual(["maps/forest.json"]);
    expect(JSON.parse(host.exports[0]!.text).kind).toBe(SHARDED_PACK_KIND);

    app.undo();
    expect(session.exportText()).toBe(source);
    expect(session.dirtyEntries()).toEqual([]);
  });

  test("catalog-changing operations are refused for packs", async () => {
    const { host, app } = studioOnMemoryHost();
    openPick(host, "pack.json", sunstonePack());
    await Bun.sleep(0);
    for (const [command, args] of [
      ["add-map", {}],
      ["duplicate-map", { map: "forest" }],
      ["delete-map", { map: "forest" }],
      ["move-map", { map: "forest", index: 0 }],
      ["paint-edges", { map: "forest", cells: [[1, 1]], brush: { kind: "clear" } }],
    ] as const) {
      const response = app.run(command, args);
      expect(response?.ok).toBe(false);
      if (response && !response.ok) expect(response.error.code).toBe("UNSUPPORTED_FOR_SHELL");
      // StudioApp surfaces the refusal to the user.
      expect(app.notices.at(-1)?.level).toBe("error");
    }
    expect(app.session!.history()).toHaveLength(0);
  });

  test("a sharded transaction spanning two maps undoes as one step", async () => {
    const source = sunstonePack();
    const { host, app } = studioOnMemoryHost();
    openPick(host, "pack.json", source);
    await Bun.sleep(0);
    const response = app.transaction("two maps", [
      { command: "paint-tile", args: { map: "forest", layer: "ground", x: 1, y: 1, tile: "town.37" } },
      { command: "paint-tile", args: { map: "cave", layer: "ground", x: 1, y: 1, tile: "dun.24" } },
    ]);
    expect(response?.ok).toBe(true);
    expect(app.session!.dirtyEntries().sort()).toEqual(["maps/cave.json", "maps/forest.json"]);
    app.undo();
    expect(app.session!.exportText()).toBe(source);
  });

  test("a bare ProjectShell and invalid JSON are rejected with a reason", async () => {
    const shell = parseShardedPack(sunstonePack()).shellText;
    const { host, app } = studioOnMemoryHost();
    openPick(host, "shell.json", shell);
    await Bun.sleep(0);
    expect(app.session).toBeNull();
    expect(app.notices.at(-1)?.text).toMatch(/^Could not open shell\.json: .*sharded pack/);
    openPick(host, "broken.json", "{");
    await Bun.sleep(0);
    expect(app.session).toBeNull();
    expect(app.notices.at(-1)?.text).toMatch(/^Could not open broken\.json: /);
    // The same refusals at the session level.
    expect(() => EditSession.open(shell)).toThrow(/sharded pack/);
    expect(() => EditSession.open("{")).toThrow();
  });
});
