// A World built in bounded steps (beginWorld/stepWorld) is the World
// createWorld builds in one call, and the sandbox compiles a large
// parsed-only map in several bounded units instead of one.

import { describe, expect, test } from "bun:test";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { beginWorld, createWorld, stepWorld, type World } from "../src/engine/interpreter.ts";
import {
  compileSandboxMap,
  createSandboxSession,
  createSession,
  holdSandboxMap,
  SANDBOX_WORLD_UNIT_INSTRUCTIONS,
  startSession,
  stepSession,
} from "../src/engine/session.ts";
import { sandboxWorldMapPreview } from "../src/engine/world-preview-sandbox.ts";
import type { Command, GameEvent, MapDef, Trigger } from "../src/engine/types.ts";
import { handoffProject } from "./fixtures/seamless-handoff/fixture-data.ts";

const IDLE = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function stepped(build: ReturnType<typeof beginWorld>, budget: number): { world: World; steps: number } {
  for (let steps = 1; steps < 10_000; steps++) {
    const world = stepWorld(build, budget);
    if (world) return { world, steps };
  }
  throw new Error("world build never finished");
}

/** `n` one-cell events on a 4×4 map whose single page runs `length`
 * variable commands. */
function busyEvents(n: number, length: number): GameEvent[] {
  const commands: Command[] = Array.from({ length }, (_, i) => ({ op: "variable", id: `v${i}`, set: { op: "set", value: i } }));
  return Array.from({ length: n }, (_, i) => ({
    id: `busy-${i}`,
    x: i % 4,
    y: Math.floor(i / 4) % 4,
    pages: [{ trigger: "action", commands, sprite: i % 2 === 0 ? `s${i}` : undefined }],
  }));
}

function footprintRows(map: MapDef): number {
  let rows = 0;
  for (const ev of map.events ?? []) {
    const inX = Math.min(map.width, ev.x + (ev.w ?? 1)) > Math.max(0, ev.x);
    if (inX) rows += Math.max(0, Math.min(map.height, ev.y + (ev.h ?? 1)) - Math.max(0, ev.y));
  }
  return rows;
}

describe("stepped World build", () => {
  test("every Sunstone map steps to the World createWorld builds", () => {
    const { project, maps } = buildGame();
    const common = project.commonEvents ?? [];
    for (const map of maps) {
      const whole = createWorld(map, common, 60);
      for (const budget of [1, 7, 64]) {
        const { world, steps } = stepped(beginWorld(map, common, 60), budget);
        expect(world).toEqual(whole);
        // One item per step, then one footprint row per step; the step
        // indexing the last row also finishes.
        if (budget === 1) expect(steps).toBe(common.length + (map.events?.length ?? 0) + footprintRows(map));
      }
    }
  });

  test("a step compiles whole items and stops once its budget is spent", () => {
    const project = handoffProject({ mapEvents: { east: busyEvents(40, 25) } });
    const map = project.maps.find((m) => m.id === "east")!;
    const build = beginWorld(map, [], 60);
    // Each event compiles to 25 instructions plus its end: a budget of 100
    // takes whole events until at least 100 are spent.
    expect(stepWorld(build, 100)).toBeNull();
    expect(build.next).toBe(4);
    expect(build.pagePrograms.size).toBe(4);
    const { world, steps } = stepped(build, 100);
    // The other 36 events, four per step; then 40 cells at 4 units each,
    // 25 per step; the last step also finishes.
    expect(steps).toBe(9 + 2);
    expect(world).toEqual(createWorld(map, [], 60));
  });

  test("a large event footprint is indexed a row at a time and keeps each cell's event order", () => {
    const base = handoffProject({}).maps.find((m) => m.id === "east")!;
    const area = (id: string, x: number, y: number, w: number, h: number, trigger: Trigger = "playerTouch"): GameEvent => ({
      id, x, y, w, h, pages: [{ trigger, commands: [] }],
    });
    // Ids out of authored order, overlapping footprints, one partly off the map.
    const map: MapDef = {
      ...base,
      width: 40,
      height: 40,
      events: [
        area("z", 0, 0, 40, 40, "autorun"),
        area("m", 10, 10, 5, 30, "eventTouch"),
        area("a", -3, 35, 50, 10, "parallel"),
        area("q", 39, 39, 1, 1),
      ],
    };
    const whole = createWorld(map, [], 60);
    // A 40-cell row is 160 units: every row of "z" is its own step.
    const { world, steps } = stepped(beginWorld(map, [], 60), 100);
    expect(world).toEqual(whole);
    expect(steps).toBeGreaterThanOrEqual(40);
    // Resuming inside a footprint does not record its event twice.
    expect(world.alwaysScanEvents!.map((ev) => ev.id)).toEqual(["a", "z"]);
    expect(world.cellEvents!.get(12 * 40 + 12)!.map((ev) => ev.id)).toEqual(["m", "z"]);
    expect(world.cellEvents!.get(39 * 40 + 39)!.map((ev) => ev.id)).toEqual(["a", "q", "z"]);
  });
});

describe("sandbox compile units", () => {
  test("a large parsed-only map compiles over several bounded units and previews the same", () => {
    // About 3.5 units of World instructions.
    const length = 50;
    const n = Math.ceil((SANDBOX_WORLD_UNIT_INSTRUCTIONS * 3.5) / (length + 1));
    const project = handoffProject({ mapEvents: { east: busyEvents(n, length) } });
    const session = createSession(project, 60, { immutableState: true });
    const state = stepSession(session, startSession(project, session), IDLE);
    const map = session.maps.get("east")!;
    const live = createSandboxSession(session);
    expect(holdSandboxMap(live, session, map)).toBe(false);
    const expected = sandboxWorldMapPreview(live, state, "east");

    const liveWorld = session.worlds.get("east")!;
    const liveTable = session.tables.get("east")!;
    session.worlds.delete("east");
    session.tables.delete("east");
    try {
      const sandbox = createSandboxSession(session);
      expect(holdSandboxMap(sandbox, session, map)).toBe(true);
      let units = 1;
      while (!compileSandboxMap(sandbox, "east")) units++;
      // Four World units, then the passage table.
      expect(units).toBe(5);
      expect(sandbox.worlds.get("east")).toEqual(liveWorld);
      expect(sandbox.worlds.get("east")).not.toBe(liveWorld);
      expect(sandboxWorldMapPreview(sandbox, state, "east")).toEqual(expected);
      expect(session.worlds.has("east")).toBe(false);
    } finally {
      session.worlds.set("east", liveWorld);
      session.tables.set("east", liveTable);
    }
  });

  test("a build restarts when the held MapDef changes and is dropped when trimmed or adopted", () => {
    const project = handoffProject({ mapEvents: { east: busyEvents(200, 50) } });
    const session = createSession(project, 60, { immutableState: true });
    const map = session.maps.get("east")!;
    const liveWorld = session.worlds.get("east")!;
    const liveTable = session.tables.get("east")!;
    session.worlds.delete("east");
    session.tables.delete("east");
    try {
      const sandbox = createSandboxSession(session);
      holdSandboxMap(sandbox, session, map);
      expect(compileSandboxMap(sandbox, "east")).toBe(false);
      // A new MapDef for the same id: the half-built World is not reused.
      const edited = { ...map, events: map.events!.slice(1) };
      holdSandboxMap(sandbox, session, edited);
      let units = 1;
      while (!compileSandboxMap(sandbox, "east")) units++;
      expect(sandbox.worlds.get("east")!.map).toBe(edited);
      expect(sandbox.worlds.get("east")).toEqual(createWorld(edited, session.commonEvents, 60, session.worldOptions));
      // Live compilation finishing mid-build is adopted instead.
      const other = createSandboxSession(session);
      holdSandboxMap(other, session, map);
      expect(compileSandboxMap(other, "east")).toBe(false);
      session.worlds.set("east", liveWorld);
      session.tables.set("east", liveTable);
      expect(holdSandboxMap(other, session, map)).toBe(false);
      expect(other.worlds.get("east")).toBe(liveWorld);
    } finally {
      session.worlds.set("east", liveWorld);
      session.tables.set("east", liveTable);
    }
  });
});
