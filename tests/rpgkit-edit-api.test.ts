import { describe, expect, test } from "bun:test";
import {
  applyEditPatch,
  executeEditOperation,
  semanticHash,
} from "../editor/api/operations.ts";
import type { EditExecution, EditSuccess } from "../editor/api/types.ts";
import { serializeProject } from "../editor/engine/document.ts";
import { defaultCommand } from "../editor/engine/commands.ts";
import type { Command, Project, ProjectShell } from "../src/engine/types.ts";

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Agent fixture",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 2, rows: 2 }],
    items: [],
    maps: [{
      id: "map",
      name: "Map",
      width: 4,
      height: 3,
      sheets: ["s"],
      ground: [
        "s.0", "s.0", "s.1", "s.1",
        "s.0", "s.2", "s.1", "s.1",
        "s.3", "s.2", "s.2", "s.1",
      ],
      upper: [[0, "s.2"]],
      events: [{
        id: "npc",
        name: "Guide",
        x: 1,
        y: 1,
        pages: [
          {
            trigger: "action",
            commands: [
              { op: "text", lines: ["Hello"] },
              { op: "if", if: { kind: "switch", id: "gate" }, then: [{ op: "gold", set: "add", amount: 1 }] },
            ],
          },
          { condition: { selfSwitch: "A" }, trigger: "action", commands: [] },
        ],
      }],
    }],
  };
}

function success(execution: EditExecution): EditSuccess & { output: string } {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  expect(execution.output).toBeDefined();
  return Object.assign(execution.response, { output: execution.output! });
}

function readSuccess(execution: EditExecution): EditSuccess {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  return execution.response;
}

function editedProject(execution: EditExecution): Project {
  return JSON.parse(success(execution).output) as Project;
}

describe("rpgkit edit read operations", () => {
  test("opens and lists maps, events, pages and recursive commands with reusable addresses", () => {
    const source = serializeProject(fixture());
    const opened = readSuccess(executeEditOperation(source, "open"));
    expect(opened.result).toMatchObject({ documentKind: "inline", editable: true, mapCount: 1 });
    expect(opened.project.revision).toMatch(/^[0-9a-f]{64}$/);

    const maps = readSuccess(executeEditOperation(source, "list-maps")).result as any[];
    expect(maps).toEqual([expect.objectContaining({ address: "map:map", id: "map", eventCount: 1 })]);

    const events = readSuccess(executeEditOperation(source, "list-events", { map: "map" })).result as any[];
    expect(events).toEqual([expect.objectContaining({ address: "map:map/event:npc", id: "npc", pageCount: 2 })]);

    const pages = readSuccess(executeEditOperation(source, "list-pages", { map: "map", event: "npc" })).result as any[];
    expect(pages.map((item) => item.address)).toEqual([
      "map:map/event:npc/page:0",
      "map:map/event:npc/page:1",
    ]);

    const commands = readSuccess(executeEditOperation(source, "list-commands", { map: "map", event: "npc", page: 0 })).result as any[];
    expect(commands.map((item) => item.key)).toEqual(["root#0", "root#1", "i1:then#0"]);
    expect(commands[2]).toMatchObject({
      address: "map:map/event:npc/page:0/command:i1:then#0",
      commandAddress: { path: [{ kind: "if", index: 1, branch: "then" }], index: 0 },
      branch: "Then",
      readOnly: false,
    });
  });

  test("validate reports field paths without attempting an edit", () => {
    const valid = readSuccess(executeEditOperation(serializeProject(fixture()), "validate"));
    expect(valid.result).toEqual({ valid: true, errors: [] });

    const scoped = readSuccess(executeEditOperation(serializeProject(fixture()), "validate", { map: "map" }));
    expect(scoped.result).toEqual({ valid: true, errors: [], scopedMap: "map" });
    expect(executeEditOperation(serializeProject(fixture()), "validate", { map: "missing" }).response)
      .toMatchObject({ ok: false, error: { code: "MAP_NOT_FOUND", path: "$.map" } });

    const invalid = readSuccess(executeEditOperation('{"format":"wrong"}', "validate"));
    expect((invalid.result as any).valid).toBe(false);
    expect((invalid.result as any).errors[0]).toHaveProperty("path");
  });

  test("ProjectShell opens and lists its map index but rejects payload operations", () => {
    const base = fixture();
    const { maps: _, ...globals } = base;
    const shell: ProjectShell = {
      ...globals,
      mapIndex: [{ id: "map", width: 4, height: 3, entry: "maps/map.json", sha256: "0".repeat(64) }],
    };
    const source = serializeProject(shell as unknown as Project);
    expect(readSuccess(executeEditOperation(source, "open")).result).toMatchObject({ documentKind: "shell", editable: false });
    expect(readSuccess(executeEditOperation(source, "list-maps")).result).toEqual([
      expect.objectContaining({ address: "map:map", entry: "maps/map.json" }),
    ]);
    const rejected = executeEditOperation(source, "list-events", { map: "map" }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "READ_ONLY_PROJECT_SHELL", path: "$.mapIndex" } });
  });
});

describe("rpgkit edit tile operations", () => {
  test("paints one tile and emits a small reversible diff", () => {
    const project = fixture();
    const edit = success(executeEditOperation(serializeProject(project), "paint-tile", {
      map: "map", layer: "ground", x: 0, y: 0, tile: "s.3",
    }));
    expect(edit.changed).toBe(true);
    expect(edit.addresses).toEqual(["map:map/layer:ground/tile:0,0"]);
    expect(edit.diff).toEqual([expect.objectContaining({ path: "/maps/0/ground/0" })]);
    const after = JSON.parse(edit.output) as Project;
    expect(after.maps[0]!.ground[0]).toBe("s.3");
    expect(applyEditPatch(after, edit.patch!, "reverse")).toEqual(project);
  });

  test("paints a rectangle as one validated operation", () => {
    const after = editedProject(executeEditOperation(serializeProject(fixture()), "paint-rect", {
      map: "map", layer: "ground", x: 2, y: 0, width: 2, height: 2, tile: "s.2",
    }));
    expect([2, 3, 6, 7].map((index) => after.maps[0]!.ground[index])).toEqual(["s.2", "s.2", "s.2", "s.2"]);
  });

  test("paints uniform passage rectangles and a room with border doors", () => {
    const project = fixture();
    const map = project.maps[0]!;
    map.width = 10;
    map.height = 8;
    map.ground = new Array(80).fill("s.0");

    const uniform = success(executeEditOperation(serializeProject(project), "paint-rect", {
      map: "map", layer: "passage", x: 1, y: 1, width: 2, height: 3, value: "block",
    }));
    expect(uniform.result).toEqual({ map: "map", layer: "passage", value: "block", cells: 6 });
    expect(new Map((JSON.parse(uniform.output) as Project).maps[0]!.passage).size).toBe(6);

    const room = success(executeEditOperation(serializeProject(project), "paint-rect", {
      map: "map", layer: "passage", x: 0, y: 0, width: 10, height: 8,
      template: "room", doors: [[4, 7]],
    }));
    expect(room.result).toEqual({
      map: "map", layer: "passage", template: "room", doors: 1,
      blocked: 31, passable: 49, cells: 80,
    });
    expect(room.addresses).toHaveLength(80);
    const passage = new Map((JSON.parse(room.output) as Project).maps[0]!.passage);
    expect([...passage.values()].filter((value) => value === "block")).toHaveLength(31);
    expect([...passage.values()].filter((value) => value === "pass")).toHaveLength(49);
    expect(passage.get(7 * 10 + 4)).toBe("pass");
    expect(applyEditPatch(JSON.parse(room.output), room.patch!, "reverse")).toEqual(project);
  });

  test("rejects mismatched rectangle payloads and doors outside the border", () => {
    const source = serializeProject(fixture());
    expect(executeEditOperation(source, "paint-rect", {
      map: "map", layer: "passage", x: 0, y: 0, width: 3, height: 3, tile: "s.0",
    }).response).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.tile" } });
    expect(executeEditOperation(source, "paint-rect", {
      map: "map", layer: "ground", x: 0, y: 0, width: 3, height: 3, value: "block",
    }).response).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.value" } });
    expect(executeEditOperation(source, "paint-rect", {
      map: "map", layer: "passage", x: 0, y: 0, width: 4, height: 3,
      template: "room", doors: [[1, 1]],
    }).response).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.doors[0]" } });
  });

  test("four-way fills only the connected source region", () => {
    const execution = executeEditOperation(serializeProject(fixture()), "fill-region", {
      map: "map", layer: "ground", x: 0, y: 0, tile: "s.3",
    });
    const result = success(execution);
    const after = JSON.parse(result.output) as Project;
    expect((result.result as any).cells).toBe(3);
    expect([0, 1, 4].map((index) => after.maps[0]!.ground[index])).toEqual(["s.3", "s.3", "s.3"]);
    expect(after.maps[0]!.ground[8]).toBe("s.3");
    expect(after.maps[0]!.ground[5]).toBe("s.2");
  });

  test("rejects unknown tile sheets with an actionable field error", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "paint-tile", {
      map: "map", x: 0, y: 0, tile: "other.0",
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_TILE", path: "$.tile", expected: ["s"] } });
  });

  test("requires an explicit tile so a misspelled field cannot erase a region", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "fill-region", {
      map: "map", x: 0, y: 0, titel: "s.3",
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$" } });
    if (!rejected.ok) expect(rejected.error.message).toContain("titel");
  });

  test("paints sparse upper cells while retaining untouched duplicate authored pairs", () => {
    const project = fixture();
    project.maps[0]!.upper = [[0, "s.1"], [0, "s.2"], [3, "s.3"]];
    const after = editedProject(executeEditOperation(serializeProject(project), "paint-tile", {
      map: "map", layer: "upper", x: 1, y: 0, tile: "s.3",
    }));
    expect(after.maps[0]!.upper).toEqual([[0, "s.1"], [0, "s.2"], [3, "s.3"], [1, "s.3"]]);
  });
});

describe("rpgkit edit map operations", () => {
  test("updates map properties through the editor model and rewrites transfer references", () => {
    const project = fixture();
    project.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "transfer", map: "map", x: 2, y: 1, dir: "left",
    });
    const source = serializeProject(project);
    const updated = success(executeEditOperation(source, "update-map", {
      map: "map",
      changes: { id: "renamed", name: "Renamed map", width: 5, height: 2, sheets: ["s"] },
    }));
    const after = JSON.parse(updated.output) as Project;
    expect(after.start.map).toBe("renamed");
    expect(after.maps[0]).toMatchObject({
      id: "renamed", name: "Renamed map", width: 5, height: 2, sheets: ["s"],
    });
    expect(after.maps[0]!.ground).toHaveLength(10);
    expect(after.maps[0]!.events![0]!.pages[0]!.commands.at(-1)).toMatchObject({
      op: "transfer", map: "renamed", x: 2, y: 1, dir: "left",
    });
    expect(updated.addresses).toEqual(["map:map", "map:renamed"]);
    expect(applyEditPatch(after, updated.patch!, "reverse")).toEqual(project);
  });

  test("paints and clears per-cell passage overrides through the editor model", () => {
    const source = serializeProject(fixture());
    const blocked = success(executeEditOperation(source, "paint-passage", {
      map: "map", x: 2, y: 1, value: "block",
    }));
    const afterBlock = JSON.parse(blocked.output) as Project;
    expect(afterBlock.maps[0]!.passage).toEqual([[6, "block"]]);
    expect(blocked.addresses).toEqual(["map:map/layer:passage/tile:2,1"]);
    expect(applyEditPatch(afterBlock, blocked.patch!, "reverse")).toEqual(fixture());

    const cleared = success(executeEditOperation(blocked.output, "paint-passage", {
      map: "map", x: 2, y: 1, value: null,
    }));
    expect((JSON.parse(cleared.output) as Project).maps[0]!.passage).toEqual([]);
  });

  test("rejects unsupported map fields and passage values with field paths", () => {
    expect(executeEditOperation(serializeProject(fixture()), "update-map", {
      map: "map", changes: { simulationHz: 60 },
    }).response).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.changes" } });
    expect(executeEditOperation(serializeProject(fixture()), "paint-passage", {
      map: "map", x: 0, y: 0, value: "maybe",
    }).response).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.value" } });
  });
});

describe("rpgkit edit event and page operations", () => {
  test("adds, updates and deletes events through editor transactions", () => {
    const source = serializeProject(fixture());
    const added = success(executeEditOperation(source, "add-event", {
      map: "map",
      event: { id: "greeter", name: "Greeter", x: 3, y: 2, pages: [{ trigger: "action", commands: [] }] },
    }));
    const afterAdd = JSON.parse(added.output) as Project;
    expect(afterAdd.maps[0]!.events!.map((event) => event.id)).toEqual(["npc", "greeter"]);
    expect(applyEditPatch(afterAdd, added.patch!, "reverse")).toEqual(fixture());
    expect(applyEditPatch(fixture(), added.patch!, "forward")).toEqual(afterAdd);

    const updated = success(executeEditOperation(added.output, "update-event", {
      map: "map", event: "greeter", changes: { id: "gate-greeter", name: "Gate Greeter", x: 2 },
    }));
    expect((JSON.parse(updated.output) as Project).maps[0]!.events![1]).toMatchObject({ id: "gate-greeter", name: "Gate Greeter", x: 2 });

    const deleted = success(executeEditOperation(updated.output, "delete-event", { map: "map", event: "gate-greeter" }));
    expect((JSON.parse(deleted.output) as Project).maps[0]!.events!.map((event) => event.id)).toEqual(["npc"]);
    expect(deleted.result).toMatchObject({ deleted: { id: "gate-greeter" } });
  });

  test("adds an event at an index in the map's event list", () => {
    const source = serializeProject(fixture());
    const event = { id: "first", x: 0, y: 0, pages: [{ trigger: "action", commands: [] }] };
    const added = success(executeEditOperation(source, "add-event", { map: "map", event, index: 0 }));
    const afterAdd = JSON.parse(added.output) as Project;
    expect(afterAdd.maps[0]!.events!.map((item) => item.id)).toEqual(["first", "npc"]);
    expect(applyEditPatch(afterAdd, added.patch!, "reverse")).toEqual(fixture());
    expect(executeEditOperation(source, "add-event", { map: "map", event, index: 2 }).response)
      .toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.index" } });
  });

  test("rejects invalid event ids instead of silently normalizing response addresses", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "add-event", {
      map: "map",
      event: { id: "bad id", x: 0, y: 0, pages: [{ trigger: "action", commands: [] }] },
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT", path: "$.event.id" } });
  });

  test("adds at an index, replaces, and deletes pages without allowing an empty page list", () => {
    const source = serializeProject(fixture());
    const added = success(executeEditOperation(source, "add-page", {
      map: "map", event: "npc", index: 1,
      page: { condition: { switch: "middle" }, trigger: "autorun", commands: [{ op: "exit" }] },
    }));
    let pages = (JSON.parse(added.output) as Project).maps[0]!.events![0]!.pages;
    expect(pages.map((page) => page.trigger)).toEqual(["action", "autorun", "action"]);

    const updated = success(executeEditOperation(added.output, "update-page", {
      map: "map", event: "npc", page: 1,
      value: { condition: { switch: "middle" }, trigger: "parallel", commands: [{ op: "wait", seconds: 1 }] },
    }));
    pages = (JSON.parse(updated.output) as Project).maps[0]!.events![0]!.pages;
    expect(pages[1]).toMatchObject({ trigger: "parallel", commands: [{ op: "wait", seconds: 1 }] });

    const deleted = success(executeEditOperation(updated.output, "delete-page", { map: "map", event: "npc", page: 1 }));
    pages = (JSON.parse(deleted.output) as Project).maps[0]!.events![0]!.pages;
    expect(pages).toHaveLength(2);

    const single = fixture();
    single.maps[0]!.events![0]!.pages.splice(1);
    expect(executeEditOperation(serializeProject(single), "delete-page", { map: "map", event: "npc", page: 0 }).response)
      .toMatchObject({ ok: false, error: { code: "LAST_PAGE" } });
  });
});

describe("rpgkit edit command operations and patches", () => {
  test("inserts, field-updates and deletes commands at structured addresses", () => {
    const source = serializeProject(fixture());
    const selection = { map: "map", event: "npc", page: 0, address: { path: [], index: 1 } };
    const inserted = success(executeEditOperation(source, "insert-command", {
      ...selection, command: { op: "gold", set: "add", amount: 0 },
    }));
    let commands = (JSON.parse(inserted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands[1]).toEqual({ op: "gold", set: "add", amount: 0 });

    const updated = success(executeEditOperation(inserted.output, "update-command", {
      ...selection, field: "amount", value: "10",
    }));
    commands = (JSON.parse(updated.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands[1]).toEqual({ op: "gold", set: "add", amount: 10 });

    const deleted = success(executeEditOperation(updated.output, "delete-command", selection));
    commands = (JSON.parse(deleted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands.map((command) => command.op)).toEqual(["text", "if"]);
  });

  test("inserts and field-edits extension and movement-control commands", () => {
    const source = serializeProject(fixture());
    const selection = { map: "map", event: "npc", page: 0, address: { path: [], index: 0 } };
    const opaque: Command = { op: "ext", call: "game.agent", args: { nested: [1, { exact: true }] } };
    const inserted = success(executeEditOperation(source, "insert-command", { ...selection, command: opaque }));
    const commands = (JSON.parse(inserted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands;
    expect(commands[0]).toEqual(opaque);
    const editedExtension = success(executeEditOperation(inserted.output, "update-command", {
      ...selection, field: "call", value: "other.command",
    }));
    expect((JSON.parse(editedExtension.output) as Project).maps[0]!.events![0]!.pages[0]!.commands[0])
      .toEqual({ ...opaque, call: "other.command" });

    const movement: Command = {
      op: "moveControl",
      target: { event: "npc" },
      control: { kind: "wander", bounds: { x: 1, y: 2, width: 3, height: 4 }, frequency: 2 },
    };
    const moved = success(executeEditOperation(source, "insert-command", {
      ...selection,
      command: movement,
    }));
    expect((JSON.parse(moved.output) as Project).maps[0]!.events![0]!.pages[0]!.commands[0]).toEqual(movement);
    const editedMovement = success(executeEditOperation(moved.output, "update-command", {
      ...selection,
      field: "control.frequency",
      value: "5",
    }));
    expect((JSON.parse(editedMovement.output) as Project).maps[0]!.events![0]!.pages[0]!.commands[0])
      .toMatchObject({ control: { kind: "wander", frequency: 5 } });
  });

  test("lists and edits commands inside scene onDone/onCancel branches", () => {
    // B6: scene result branches are command containers for the AI edit API,
    // addressable exactly like battle result branches.
    const project = fixture();
    project.maps[0]!.events![0]!.pages[0]!.commands = [
      { op: "scene", id: "game.pc", onDone: [{ op: "switch", id: "pc.done", value: true }] },
    ];
    const source = serializeProject(project);
    const listed = readSuccess(executeEditOperation(source, "list-commands", { map: "map", event: "npc", page: 0 })).result as any[];
    expect(listed.map((item) => item.key)).toEqual(["root#0", "s0:done#0"]);
    expect(listed[1]).toMatchObject({
      address: "map:map/event:npc/page:0/command:s0:done#0",
      commandAddress: { path: [{ kind: "scene", index: 0, branch: "done" }], index: 0 },
      branch: "Done",
      readOnly: false,
    });
    // Insert into the onCancel branch via a scene-branch address.
    const inserted = success(executeEditOperation(source, "insert-command", {
      map: "map",
      event: "npc",
      page: 0,
      address: { path: [{ kind: "scene", index: 0, branch: "cancel" }], index: 0 },
      command: { op: "switch", id: "pc.cancelled", value: true },
    }));
    const scene = (JSON.parse(inserted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands[0] as
      Extract<Command, { op: "scene" }>;
    expect(scene.onCancel).toEqual([{ op: "switch", id: "pc.cancelled", value: true }]);
    // A malformed scene-branch path segment is rejected by the path parser
    // itself (insert-command consumes address.path, unlike list-commands,
    // which would fail earlier at the argument whitelist).
    const bad = executeEditOperation(source, "insert-command", {
      map: "map",
      event: "npc",
      page: 0,
      address: { path: [{ kind: "scene", index: 0, branch: "win" }], index: 0 },
      command: { op: "switch", id: "pc.bad", value: true },
    });
    expect(bad.response.ok).toBe(false);
    expect(bad.response).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });

  test("AI read and validation operations expose screen and KRM2 commands for field editing", () => {
    const project = fixture();
    const screen: Command[] = [
      { op: "screenFade", direction: "out", duration: 0.5, wait: true },
      { op: "screenTint", layer: "night", color: { r: 4, g: 8, b: 16, a: 96 }, duration: 1 },
      { op: "screenFlash", color: { r: 255, g: 255, b: 255, a: 255 }, intensity: 160, duration: 0.2 },
      { op: "screenShake", strength: 5, speed: 3, duration: 0.4 },
      { op: "camera", target: { event: "npc" }, duration: 1 },
      { op: "scrollMap", direction: "right", distance: 2, speed: 4, wait: true },
      { op: "balloon", target: "player" },
      { op: "screenBackdrop", layer: "cutscene", variant: "blue" },
      { op: "showPicture", id: 1, layer: "pictures", variant: "portrait", x: 0, y: 0 },
      { op: "movePicture", id: 1, x: 10, y: 20, scaleX: 100, scaleY: 100, opacity: 255, duration: 0.5 },
      { op: "rotatePicture", id: 1, speed: -1 },
      { op: "tintPicture", id: 1, tone: { r: -32, g: 0, b: 16, gray: 8 }, duration: 0.5 },
      { op: "erasePicture", id: 1 },
      { op: "timer", action: "start", seconds: 60 },
      { op: "inputNumber", variable: "answer", digits: 4 },
      { op: "openMenu" },
      { op: "openSave" },
      { op: "gameOver" },
      { op: "returnTitle" },
      { op: "changeName", name: "Terra" },
      { op: "mapNameDisplay", visible: true },
    ];
    project.maps[0]!.events![0]!.pages[0]!.commands = screen;
    const source = serializeProject(project);

    expect(readSuccess(executeEditOperation(source, "validate")).result).toEqual({ valid: true, errors: [] });
    const listed = readSuccess(executeEditOperation(source, "list-commands", {
      map: "map", event: "npc", page: 0,
    })).result as Array<{ readOnly: boolean; command: Command }>;
    expect(listed.map((row) => row.readOnly)).toEqual(new Array(screen.length).fill(false));
    expect(listed.map((row) => row.command)).toEqual(screen);

    const updated = success(executeEditOperation(source, "update-command", {
      map: "map", event: "npc", page: 0,
      address: { path: [], index: 0 }, field: "duration", value: "2",
    }));
    expect((JSON.parse(updated.output) as Project).maps[0]!.events![0]!.pages[0]!.commands[0])
      .toEqual({ op: "screenFade", direction: "out", duration: 2, wait: true });
  });

  test("AI inserts, validates, lists and field-edits audio commands", () => {
    const project = fixture();
    project.audio = {
      field: "audio:wav.field",
      rain: "audio:wav.rain",
      victory: "audio:wav.victory",
      door: "audio:wav.door",
    };
    project.maps[0]!.events![0]!.pages[0] = {
      condition: { all: [{ kind: "bgmPlaying", id: "field", negate: true }] },
      trigger: "action",
      commands: [],
    };
    const audio: Command[] = [
      { op: "playBgm", id: "field", volume: 80, pitch: 90 },
      { op: "fadeoutBgm", duration: 1.5 },
      { op: "stopBgm" },
      { op: "pauseBgm" },
      { op: "resumeBgm" },
      { op: "playBgs", id: "rain" },
      { op: "fadeoutBgs", duration: 0 },
      { op: "playMe", id: "victory", duration: 4, volume: 75 },
      { op: "playSe", id: "door", pitch: 120 },
      { op: "saveBgm" },
      { op: "replayBgm" },
    ];

    let source = serializeProject(project);
    for (let index = 0; index < audio.length; index++) {
      const inserted = success(executeEditOperation(source, "insert-command", {
        map: "map",
        event: "npc",
        page: 0,
        address: { path: [], index },
        command: audio[index],
      }));
      expect(inserted.result).toEqual(audio[index]);
      source = inserted.output;
    }

    expect(readSuccess(executeEditOperation(source, "validate")).result).toEqual({ valid: true, errors: [] });
    const pages = readSuccess(executeEditOperation(source, "list-pages", { map: "map", event: "npc" })).result as any[];
    expect(pages[0]!.condition).toEqual({ all: [{ kind: "bgmPlaying", id: "field", negate: true }] });

    const listed = readSuccess(executeEditOperation(source, "list-commands", {
      map: "map", event: "npc", page: 0,
    })).result as Array<{ readOnly: boolean; command: Command }>;
    expect(listed.map((row) => row.command)).toEqual(audio);
    expect(listed.map((row) => row.readOnly)).toEqual(new Array(audio.length).fill(false));

    const updated = success(executeEditOperation(source, "update-command", {
      map: "map", event: "npc", page: 0,
      address: { path: [], index: 0 }, field: "volume", value: "50",
    }));
    expect((JSON.parse(updated.output) as Project).maps[0]!.events![0]!.pages[0]!.commands[0])
      .toEqual({ op: "playBgm", id: "field", volume: 50, pitch: 90 });
  });

  test("sets, poses and clears a choice option icon with exact reversible patches", () => {
    const project = fixture();
    project.sprites = { hero: { kind: "image", src: "sprite:hero" } };
    project.maps[0]!.events![0]!.pages[0]!.commands = [{
      op: "choices",
      prompt: "Who?",
      options: [
        { text: "Me", commands: [] },
        { text: "You", commands: [{ op: "text", lines: ["Hi"] }] },
      ],
    }];
    const source = serializeProject(project);
    const selection = { map: "map", event: "npc", page: 0, address: { path: [], index: 0 } };
    const optionPath = "/maps/0/events/0/pages/0/commands/0/options/1";

    const set = success(executeEditOperation(source, "update-command", { ...selection, field: "option:1.icon", value: "hero" }));
    expect(set.patch!.changes).toEqual([
      { path: `${optionPath}/icon`, before: { exists: false }, after: { exists: true, value: { sprite: "hero" } } },
    ]);
    const withIcon = JSON.parse(set.output) as Project;
    expect(withIcon.maps[0]!.events![0]!.pages[0]!.commands[0]).toMatchObject({
      options: [{ text: "Me", commands: [] }, { text: "You", icon: { sprite: "hero" }, commands: [{ op: "text", lines: ["Hi"] }] }],
    });
    expect(Object.keys((withIcon.maps[0]!.events![0]!.pages[0]!.commands[0] as any).options[0])).toEqual(["text", "commands"]);
    expect(applyEditPatch(withIcon, set.patch!, "reverse")).toEqual(project);
    expect(JSON.parse(success(executeEditOperation(source, "save", { patch: set.patch })).output)).toEqual(withIcon);

    const posed = success(executeEditOperation(set.output, "update-command", { ...selection, field: "option:1.icon.frame", value: "2" }));
    expect(posed.patch!.changes).toEqual([
      { path: `${optionPath}/icon/frame`, before: { exists: false }, after: { exists: true, value: 2 } },
    ]);

    const cleared = success(executeEditOperation(posed.output, "update-command", { ...selection, field: "option:1.icon", value: "(unset)" }));
    expect(cleared.patch!.changes).toEqual([
      { path: `${optionPath}/icon`, before: { exists: true, value: { sprite: "hero", frame: 2 } }, after: { exists: false } },
    ]);
    expect(JSON.parse(cleared.output)).toEqual(project);
  });

  test("rejects schema-invalid choice option icons from field edits and inserted commands", () => {
    const project = fixture();
    project.sprites = { hero: { kind: "image", src: "sprite:hero" } };
    const source = serializeProject(project);
    const selection = { map: "map", event: "npc", page: 0, address: { path: [], index: 0 } };
    const choices = (icon: unknown): Record<string, unknown> => ({
      op: "choices",
      prompt: "",
      options: [{ text: "A", icon, commands: [] }, { text: "B", commands: [] }],
    });

    const accepted = success(executeEditOperation(source, "insert-command", { ...selection, command: choices({ sprite: "hero", dir: "up", frame: 1 }) }));
    expect((JSON.parse(accepted.output) as Project).maps[0]!.events![0]!.pages[0]!.commands[0])
      .toMatchObject({ options: [{ icon: { sprite: "hero", dir: "up", frame: 1 } }, { text: "B" }] });

    for (const icon of [{ sprite: "hero", frame: 5 }, { sprite: "hero", tint: "red" }, { sprite: "" }, { dir: "up" }]) {
      expect(executeEditOperation(source, "insert-command", { ...selection, command: choices(icon) }).response, JSON.stringify(icon))
        .toMatchObject({ ok: false, error: { code: "INVALID_EDIT" } });
    }

    const badFrame = executeEditOperation(accepted.output, "update-command", { ...selection, field: "option:0.icon.frame", value: "5" }).response;
    expect(badFrame).toMatchObject({ ok: false, error: { code: "INVALID_COMMAND_FIELD", path: "$.command.option:0.icon.frame" } });
    if (!badFrame.ok) expect(badFrame.error.expected).toEqual(expect.arrayContaining(["option:0.icon", "option:0.icon.dir", "option:0.icon.frame", "option:1.icon"]));
    const plain = success(executeEditOperation(source, "insert-command", { ...selection, command: defaultCommand("choices") }));
    const orphanDir = executeEditOperation(plain.output, "update-command", { ...selection, field: "option:0.icon.dir", value: "up" }).response;
    expect(orphanDir).toMatchObject({ ok: false, error: { code: "INVALID_COMMAND_FIELD" } });
    if (!orphanDir.ok) expect(orphanDir.error.message).toContain("choose an icon sprite");
  });

  test("command field errors identify the field and legal alternatives", () => {
    const rejected = executeEditOperation(serializeProject(fixture()), "update-command", {
      map: "map", event: "npc", page: 0, address: { path: [], index: 0 }, field: "cps", value: "0",
    }).response;
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_COMMAND_FIELD", path: "$.command.cps" } });
    if (!rejected.ok) expect(rejected.error.message).toContain("cps");
  });

  test("save applies a dry-run patch forward and reverse and refuses a stale base", () => {
    const project = fixture();
    const source = serializeProject(project);
    const preview = success(executeEditOperation(source, "paint-tile", { map: "map", x: 0, y: 0, tile: "s.3" }));

    const forward = success(executeEditOperation(source, "save", { patch: preview.patch }));
    expect((JSON.parse(forward.output) as Project).maps[0]!.ground[0]).toBe("s.3");
    const reverse = success(executeEditOperation(forward.output, "save", { patch: preview.patch, direction: "reverse" }));
    expect(JSON.parse(reverse.output)).toEqual(project);

    const stale = fixture();
    stale.title = "Drifted";
    expect(executeEditOperation(serializeProject(stale), "save", { patch: preview.patch }).response)
      .toMatchObject({ ok: false, error: { code: "PATCH_BASE_MISMATCH", path: "$.patch" } });
  });

  test("patch traversal cannot reach Object.prototype and malformed escapes fail closed", () => {
    const project = fixture();
    const hash = semanticHash(project);
    const pollutionKey = "rpgkitEditPolluted";
    delete (Object.prototype as Record<string, unknown>)[pollutionKey];
    const malicious = {
      format: "rpgkit-edit/patch-v1",
      beforeHash: hash,
      afterHash: hash,
      changes: [{
        path: `/start/__proto__/${pollutionKey}`,
        before: { exists: false },
        after: { exists: true, value: true },
      }],
    };
    expect(() => applyEditPatch(project, malicious)).toThrow("missing object property");
    expect(({} as Record<string, unknown>)[pollutionKey]).toBeUndefined();

    const malformed = { ...malicious, changes: [{ ...malicious.changes[0], path: "/start/~2bad" }] };
    expect(() => applyEditPatch(project, malformed)).toThrow("invalid JSON Pointer escape");
  });

  test("the public patch helper refuses a self-consistent schema-invalid result", () => {
    const project = fixture();
    const patch = {
      format: "rpgkit-edit/patch-v1",
      beforeHash: semanticHash(project),
      afterHash: semanticHash(1),
      changes: [{ path: "", before: { exists: true, value: project }, after: { exists: true, value: 1 } }],
    };
    expect(() => applyEditPatch(project, patch)).toThrow("edit would make the project invalid");
  });

  test("schema-valid but structurally invalid maps and duplicate stable ids are rejected", () => {
    const short = fixture();
    short.maps[0]!.ground.pop();
    const invalidMap = readSuccess(executeEditOperation(serializeProject(short), "validate"));
    expect(invalidMap.result).toMatchObject({ valid: false, errors: [expect.objectContaining({ path: "$.maps[0]" })] });
    expect(executeEditOperation(serializeProject(short), "open").response).toMatchObject({ ok: false, error: { code: "INVALID_DOCUMENT" } });

    const duplicate = fixture();
    duplicate.maps[0]!.events!.push(structuredClone(duplicate.maps[0]!.events![0]!));
    expect(executeEditOperation(serializeProject(duplicate), "open").response)
      .toMatchObject({ ok: false, error: { code: "INVALID_DOCUMENT", path: "$.maps[0].events[1].id" } });
  });
});
