// tests/engine.test.ts — unit tests for the pure-TS engine: camera reducer,
// tile ids, tile/chunk constants, session start derivation, deepClone, and
// conformance of the shipped example project to data/schema.json.
// No host/framework imports here: these modules are pure TS and run under
// plain bun.

import { describe, expect, test } from "bun:test";
import {
  clampCamera,
  initialCamera,
  stepCamera,
  VIEW_H,
  VIEW_W,
  BTN_BITS,
  type CameraConfig,
} from "../src/engine/camera.ts";
import {
  cellX,
  cellY,
  groundAt,
  indexAt,
  parseTileId,
  TILE,
  CHUNK_PX,
  CHUNK_TILES,
} from "../src/engine/tiles.ts";
import { facingOfDir, startCamera } from "../src/engine/start.ts";
import { buildMiniProject, buildMiniMap } from "../examples/meadow/mini-project.ts";
import { validateSchema, type VError } from "../src/engine/schema-validate.ts";
import type { Project } from "../src/engine/types.ts";

const CFG: CameraConfig = { worldW: 1024, worldH: 1024, speed: 2 };

describe("camera reducer", () => {
  test("moves 2px per held frame and emits the facing index", () => {
    let s = initialCamera(200, 150, 0, CFG);
    s = stepCamera(s, BTN_BITS.RIGHT, CFG);
    expect(s).toEqual({ x: 202, y: 150, facing: 3 });
    s = stepCamera(s, BTN_BITS.DOWN, CFG);
    expect(s).toEqual({ x: 202, y: 152, facing: 0 });
    s = stepCamera(s, BTN_BITS.LEFT, CFG);
    expect(s.x).toBe(200);
    expect(s.facing).toBe(1);
    s = stepCamera(s, BTN_BITS.UP, CFG);
    expect(s.y).toBe(150);
    expect(s.facing).toBe(2);
  });

  test("holds position and facing with no buttons", () => {
    const s0 = initialCamera(210, 160, 3, CFG);
    const s1 = stepCamera(s0, 0, CFG);
    expect(s1).toEqual(s0);
  });

  test("clamps at all four world edges", () => {
    expect(clampCamera(-10, -10, CFG)).toEqual({ x: 0, y: 0 });
    expect(clampCamera(5000, 5000, CFG)).toEqual({
      x: CFG.worldW - VIEW_W,
      y: CFG.worldH - VIEW_H,
    });
    const corner = stepCamera(
      { x: CFG.worldW - VIEW_W, y: CFG.worldH - VIEW_H, facing: 0 },
      BTN_BITS.RIGHT | BTN_BITS.DOWN,
      CFG,
    );
    expect(corner.x).toBe(CFG.worldW - VIEW_W);
    expect(corner.y).toBe(CFG.worldH - VIEW_H);
  });

  test("opposing directions cancel movement", () => {
    const s = stepCamera({ x: 100, y: 100, facing: 0 }, BTN_BITS.LEFT | BTN_BITS.RIGHT, CFG);
    expect(s.x).toBe(100);
  });

  test("vertical facing wins a diagonal hold (deterministic tie-break)", () => {
    const s = stepCamera({ x: 100, y: 100, facing: 0 }, BTN_BITS.RIGHT | BTN_BITS.DOWN, CFG);
    expect(s.facing).toBe(0);
    const s2 = stepCamera({ x: 100, y: 100, facing: 0 }, BTN_BITS.RIGHT | BTN_BITS.UP, CFG);
    expect(s2.facing).toBe(2);
  });

  test("is a pure fold: the input state is never mutated", () => {
    const s0 = initialCamera(200, 150, 0, CFG);
    const frozen = { ...s0 };
    stepCamera(s0, BTN_BITS.RIGHT, CFG);
    expect(s0).toEqual(frozen);
  });

  test("initialCamera clamps an out-of-range start", () => {
    const s = initialCamera(9000, 9000, 0, CFG);
    expect(s.x).toBe(CFG.worldW - VIEW_W);
    expect(s.y).toBe(CFG.worldH - VIEW_H);
  });
});

describe("tile and chunk constants", () => {
  test("tiles are 16px and one chunk edge holds 32 of them in 512px", () => {
    expect(TILE).toBe(16);
    expect(CHUNK_PX).toBe(512);
    expect(CHUNK_TILES).toBe(32);
  });

  test("parseTileId splits the sheet and cell", () => {
    expect(parseTileId("town.43")).toEqual({ sheet: "town", cell: 43 });
    expect(() => parseTileId("town.x")).toThrow();
    expect(() => parseTileId("nolodash")).toThrow();
  });

  test("cellX/cellY and indexAt map between cell ids and grid positions", () => {
    expect(cellX(15, 12)).toBe(3);
    expect(cellY(15, 12)).toBe(1);
    const m = buildMiniMap();
    expect(indexAt(m, 2, 3)).toBe(3 * m.width + 2);
    expect(groundAt(m, 10, 7)).toBe("town.41"); // the dirt road
  });
});

describe("session start derives the camera placement", () => {
  const world = { worldW: 1024, worldH: 1024 };

  test("the example start tile (10,7) derives camera px (160,112) facing up", () => {
    const project = buildMiniProject();
    expect(startCamera(project.start, world)).toEqual({ x: 160, y: 112, facing: 2 });
  });

  test("every project dir maps to its reducer facing index", () => {
    expect(facingOfDir("down")).toBe(0);
    expect(facingOfDir("left")).toBe(1);
    expect(facingOfDir("up")).toBe(2);
    expect(facingOfDir("right")).toBe(3);
  });

  test("a start tile past the world edge clamps to the max camera position", () => {
    const cam = startCamera({ map: "m", x: 9000, y: 9000, dir: "up" }, world);
    expect(cam).toEqual({ x: 1024 - 480, y: 1024 - 272, facing: 2 });
  });
});

describe("the example map", () => {
  test("is deterministic: two builds are structurally identical", () => {
    expect(buildMiniMap()).toEqual(buildMiniMap());
  });

  test("has the expected 20x12 shape with both layers populated", () => {
    const m = buildMiniMap();
    expect(m.width).toBe(20);
    expect(m.height).toBe(12);
    expect(m.ground).toHaveLength(240);
    expect((m.upper ?? []).length).toBeGreaterThan(40);
  });

  test("every tile ref names the town sheet and a cell inside the 12x11 grid", () => {
    const m = buildMiniMap();
    const check = (ref: string | null) => {
      if (ref === null) return;
      const { sheet, cell } = parseTileId(ref);
      expect(sheet).toBe("town");
      expect(cellX(cell, 12)).toBeLessThan(12);
      expect(cellY(cell, 12)).toBeLessThan(11);
    };
    for (const t of m.ground) check(t);
    for (const [, t] of m.upper ?? []) check(t);
  });

  test("the perimeter carries upper-layer trees with matching block passage", () => {
    const m = buildMiniMap();
    const upperIdx = new Set((m.upper ?? []).map(([i]) => i));
    expect(upperIdx.has(indexAt(m, 5, 0))).toBe(true);
    expect(upperIdx.has(indexAt(m, 0, 5))).toBe(true);
    expect(upperIdx.has(indexAt(m, 19, 8))).toBe(true);
    const blocks = new Set((m.passage ?? []).filter(([, f]) => f === "block").map(([i]) => i));
    expect(blocks.has(indexAt(m, 5, 0))).toBe(true);
    expect(blocks.has(indexAt(m, 0, 5))).toBe(true);
    // below-character event markers stay walkable (the star layer never
    // collides by itself)
    expect(blocks.has(indexAt(m, 10, 6))).toBe(false);
    expect(blocks.has(indexAt(m, 15, 3))).toBe(false);
  });

  test("carries the four events at their authored cells", () => {
    const m = buildMiniMap();
    const byId = new Map((m.events ?? []).map((e) => [e.id, e]));
    expect(byId.get("signpost")!.x).toBe(10);
    expect(byId.get("signpost")!.y).toBe(6);
    expect(byId.get("flowerbed")!.pages[0]!.trigger).toBe("playerTouch");
    expect(byId.get("brook")!.pages[0]!.trigger).toBe("parallel");
  });
});

describe("the example project conforms to data/schema.json", () => {
  test("the generated v1 document passes the schema validator", async () => {
    const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();
    const errors: VError[] = validateSchema(schema, buildMiniProject() as unknown as Project);
    expect(errors).toEqual([]);
  });

  test("the validator has teeth: a bad tile id and missing field fail", async () => {
    const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();
    const project = buildMiniProject();
    const badTile = structuredClone(project) as Project;
    (badTile.maps[0]!.ground as unknown[])[0] = "town.x";
    expect(validateSchema(schema, badTile).length).toBeGreaterThan(0);
    const noStart = structuredClone(project) as Partial<Project>;
    delete noStart.start;
    expect(validateSchema(schema, noStart).length).toBeGreaterThan(0);
  });

  test("accepts source-sheet walkers without invalidating legacy atlas walkers", async () => {
    const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();
    const sourceSheet = structuredClone(buildMiniProject()) as Project;
    sourceSheet.sprites = {
      hero: { kind: "walker", sheet: "hero-source", h: 32, cols: 3, rows: 4 },
    };
    expect(validateSchema(schema, sourceSheet)).toEqual([]);

    const legacy = structuredClone(buildMiniProject()) as Project;
    legacy.sprites = {
      hero: {
        kind: "walker",
        atlases: { down: "d.png", left: "l.png", right: "r.png", up: "u.png" },
        frames: 3,
        step: 8,
      },
    };
    expect(validateSchema(schema, legacy)).toEqual([]);
  });

  test("validates values governed by schema-valued additionalProperties", async () => {
    const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();
    const invalidDirections = structuredClone(buildMiniProject()) as Project;
    invalidDirections.sheets[0]!.dirBlock = { "0": {} as never };
    expect(validateSchema(schema, invalidDirections)).toContainEqual({
      path: "$.sheets[0].dirBlock.0",
      msg: 'expected "array"',
    });

    const invalidSprite = structuredClone(buildMiniProject()) as Project;
    invalidSprite.sprites = { hero: { kind: "walker" } as never };
    expect(validateSchema(schema, invalidSprite).some((error) =>
      error.path === "$.sprites.hero" && error.msg.startsWith("oneOf:"),
    )).toBe(true);
  });
});

// --- host-portable snapshot clone (desktop QuickJS has no structuredClone) -

import { deepClone } from "../src/engine/clone.ts";

describe("deepClone — reducer snapshot without structuredClone", () => {
  test("detaches nested arrays/objects while preserving values", () => {
    const src = { a: 1, b: [1, 2, { c: 3 }], d: { e: true } };
    const out = deepClone(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
    expect(out.b).not.toBe(src.b);
    (out.b![2] as { c: number }).c = 99;
    expect((src.b![2] as { c: number }).c).toBe(3);
  });

  test("preserves undefined-valued keys (a cleared self switch), like structuredClone", () => {
    const src: Record<string, unknown> = { held: "A", cleared: undefined };
    const out = deepClone(src);
    expect(Object.prototype.hasOwnProperty.call(out, "cleared")).toBe(true);
    expect(out.cleared).toBeUndefined();
    expect(out.held).toBe("A");
  });

  test("keeps an own __proto__ key as data without changing the output prototype", () => {
    const src = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
    const out = deepClone(src);

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(out.__proto__).toEqual({ polluted: true });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  test("passes through null and primitives", () => {
    expect(deepClone(null)).toBeNull();
    expect(deepClone(7)).toBe(7);
    expect(deepClone("x")).toBe("x");
  });
});

// --- opt-in fiber-start trace (QA coverage tools observe instant pages) ---

import { createSession, startSession, stepSession } from "../src/engine/session.ts";

function fiberTraceProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Fiber trace",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: {},
    maps: [
      {
        id: "m",
        name: "M",
        width: 5,
        height: 5,
        sheets: ["grass"],
        ground: new Array<string>(25).fill("grass.0"),
        events: [
          // An action page whose only command is instant: the fiber starts
          // and ends inside one tick, leaving no residual fiber to inspect.
          {
            id: "instant",
            x: 1,
            y: 2,
            pages: [{ trigger: "action", commands: [{ op: "switch", id: "did-run", value: true }] }],
          },
          // A parallel page that parks on a wait: its fiber spans ticks.
          {
            id: "loop",
            x: 3,
            y: 3,
            pages: [{ trigger: "parallel", commands: [{ op: "wait", seconds: 1 }] }],
          },
        ],
      },
    ],
  };
}

describe("onFiberStart trace", () => {
  test("fires for an instant action fiber that ends inside the same tick", () => {
    const project = fiberTraceProject();
    const starts: { key: string; pageIndex: number; parallel: boolean }[] = [];
    const session = createSession(project, 60, { onFiberStart: (key, pageIndex, parallel) => starts.push({ key, pageIndex, parallel }) });
    let state = startSession(project, session);
    // Player at (1,1) facing down: the instant event sits at (1,2), in front.
    state = stepSession(session, state, { buttons: 0, confirmEdge: true, cancelEdge: false, upEdge: false, downEdge: false });
    // The fiber really ran: the switch it set is in the bank.
    expect(state.sw.switches["did-run"]).toBe(true);
    // And the trace saw it start, even though no fiber is left to observe.
    expect(starts.some((s) => s.key === "m/instant" && s.pageIndex === 0 && s.parallel === false)).toBe(true);
    // No residual main fiber: the page completed inside the tick.
    expect(state.interp.main).toBeNull();
  });

  test("fires once per parallel fiber start, not per frame", () => {
    const project = fiberTraceProject();
    const starts: { key: string; pageIndex: number; parallel: boolean }[] = [];
    const session = createSession(project, 60, { onFiberStart: (key, pageIndex, parallel) => starts.push({ key, pageIndex, parallel }) });
    let state = startSession(project, session);
    for (let frame = 0; frame < 30; frame++) {
      state = stepSession(session, state, { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false });
    }
    const loopStarts = starts.filter((s) => s.key === "m/loop");
    expect(loopStarts.length).toBeGreaterThan(0);
    // The parallel fiber parks on a 1 s wait; it cannot restart every frame.
    expect(loopStarts.length).toBeLessThan(30);
    expect(loopStarts.every((s) => s.pageIndex === 0 && s.parallel === true)).toBe(true);
  });

  test("immutable scan caching never suppresses observable instant starts", () => {
    const project = fiberTraceProject();
    project.maps[0]!.events = [{
      id: "pulse",
      x: 3,
      y: 3,
      pages: [{
        trigger: "parallel",
        commands: [{
          op: "if",
          if: { kind: "switch", id: "never", value: true },
          then: [{ op: "switch", id: "unreachable", value: true }],
        }],
      }],
    }];
    const starts: string[] = [];
    const session = createSession(project, 60, {
      immutableState: true,
      extensions: { immutableConditions: true, deterministicConditions: true },
      onFiberStart: (key) => starts.push(key),
    });
    let state = startSession(project, session);
    for (let frame = 0; frame < 5; frame++) {
      state = stepSession(session, state, { buttons: 0 });
    }
    expect(starts).toEqual(new Array(5).fill("m/pulse"));
  });

  test("costs nothing when not installed", () => {
    const project = fiberTraceProject();
    const session = createSession(project, 60);
    let state = startSession(project, session);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true, cancelEdge: false, upEdge: false, downEdge: false });
    expect(state.sw.switches["did-run"]).toBe(true);
  });
});

function instructionTraceProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Instruction trace",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: {},
    maps: [
      {
        id: "m",
        name: "M",
        width: 5,
        height: 5,
        sheets: ["grass"],
        ground: new Array<string>(25).fill("grass.0"),
        events: [
          // An autorun page whose `if` takes the else branch (switch A is
          // off): the transfer in the never-taken branch must not appear
          // in the trace, while the commands that did run must.
          {
            id: "auto",
            x: 1,
            y: 1,
            pages: [{
              trigger: "autorun",
              commands: [
                { op: "switch", id: "ran", value: true },
                {
                  op: "if",
                  if: { kind: "switch", id: "A" },
                  then: [{ op: "transfer", map: "cave", x: 1, y: 1 }],
                  else: [{ op: "switch", id: "B", value: true }],
                },
                { op: "erase" },
              ],
            }],
          },
        ],
      },
      { id: "cave", name: "Cave", width: 5, height: 5, sheets: ["grass"], ground: new Array<string>(25).fill("grass.0"), events: [] },
    ],
  };
}

describe("onInstruction trace", () => {
  test("fires for executed commands but not for commands in a branch never taken", () => {
    const project = instructionTraceProject();
    const seen: { key: string; pageIndex: number; op: string }[] = [];
    const session = createSession(project, 60, {
      onInstruction: (key, pageIndex, ins) => seen.push({ key, pageIndex, op: ins.op }),
    });
    let state = startSession(project, session);
    state = stepSession(session, state, { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false });
    // The page really ran: A stays off, so the else branch set B.
    expect(state.sw.switches["ran"]).toBe(true);
    expect(state.sw.switches["B"]).toBe(true);
    // The trace saw the commands that executed on the page's own fiber.
    const ops = seen.filter((s) => s.key === "m/auto" && s.pageIndex === 0).map((s) => s.op);
    expect(ops).toContain("switch");
    expect(ops).toContain("if");
    expect(ops).toContain("erase");
    // The transfer sits in the never-taken branch: the trace never saw it.
    expect(ops).not.toContain("transfer");
  });

  test("attributes a common event's commands to the calling page's fiber", () => {
    const project = instructionTraceProject();
    project.commonEvents = [{
      id: "heal",
      trigger: "none",
      commands: [{ op: "switch", id: "healed", value: true }],
    }];
    // The page calls the common event, then erases itself: the common
    // event's switch runs as a stacked frame on the page's own fiber.
    project.maps[0]!.events![0]!.pages[0]!.commands = [
      { op: "common", id: "heal" },
      { op: "erase" },
    ];
    const seen: { key: string; pageIndex: number; op: string }[] = [];
    const session = createSession(project, 60, {
      onInstruction: (key, pageIndex, ins) => seen.push({ key, pageIndex, op: ins.op }),
    });
    let state = startSession(project, session);
    state = stepSession(session, state, { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false });
    expect(state.sw.switches["healed"]).toBe(true);
    // The common event's switch is attributed to the calling page's fiber.
    expect(seen.some((s) => s.key === "m/auto" && s.pageIndex === 0 && s.op === "switch")).toBe(true);
  });

  test("costs nothing when not installed", () => {
    const project = instructionTraceProject();
    const session = createSession(project, 60);
    let state = startSession(project, session);
    state = stepSession(session, state, { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false });
    expect(state.sw.switches["ran"]).toBe(true);
    expect(state.sw.switches["B"]).toBe(true);
  });
});
