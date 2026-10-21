import { describe, expect, test } from "bun:test";
import { createSessionSnapshot } from "../src/engine/save.ts";
import { loadSession } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, GameEvent, MapDef, Project, TileId } from "../src/engine/types.ts";

const RIGHT = 0x0020;
const UP = 0x0010;
const FLOOR: TileId = "floor.0";

function event(
  id: string,
  trigger: "action" | "regionEnter" | "regionLeave",
  commands: Command[],
  region?: number,
  condition?: GameEvent["pages"][number]["condition"],
): GameEvent {
  return {
    id,
    x: 0,
    y: 0,
    pages: [{
      trigger,
      ...(region === undefined ? {} : { region }),
      ...(condition === undefined ? {} : { condition }),
      sprite: null,
      commands,
    }],
  };
}

function project(events: GameEvent[], enabled = true): Project {
  const map: MapDef = {
    id: "field",
    name: "Field",
    width: 3,
    height: 1,
    sheets: ["floor"],
    ground: [FLOOR, FLOOR, FLOOR],
    regions: [[1, 1], [2, 2]],
    events,
  };
  return {
    format: "rpgkit-project/v1",
    title: "Steps and regions",
    tileSize: 16,
    start: { map: "field", x: 1, y: 0, dir: "right" },
    sheets: [{ id: "floor", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    ...(enabled ? { system: { stepCounter: true } } : {}),
    maps: [map],
  };
}

function run(session: Session, state: SessionState, frames: number, buttons = 0): SessionState {
  let next = state;
  for (let frame = 0; frame < frames; frame++) {
    next = stepSession(session, next, { buttons });
  }
  return next;
}

describe("RPG Maker Steps", () => {
  test("counts only committed player landings and exposes the new value to commands and page conditions", () => {
    const gate = event(
      "gate",
      "regionEnter",
      [
        { op: "variable", id: "observed-steps", set: { op: "steps" } },
        {
          op: "if",
          if: { kind: "steps", op: ">=", value: 1 },
          then: [{ op: "switch", id: "threshold", value: true }],
        },
      ],
      2,
      { all: [{ kind: "steps", op: ">=", value: 1 }] },
    );
    const source = project([gate]);
    const session = createSession(source, 60, { immutableState: true });
    let state = run(session, startSession(source, session), 8, RIGHT);

    expect([state.move.tx, state.move.ty]).toEqual([2, 0]);
    expect(state.sw.steps).toBe(1);
    expect(state.sw.variables["observed-steps"]).toBe(1);
    expect(state.sw.switches.threshold).toBe(true);

    // Turning into and then holding against the map edge never lands.
    state = run(session, state, 4, UP);
    state = run(session, state, 12, RIGHT);
    expect([state.move.tx, state.move.ty]).toEqual([2, 0]);
    expect(state.sw.steps).toBe(1);
  });

  test("transfer placement does not count as a walking step", () => {
    const porter = event("porter", "action", [
      { op: "transfer", map: "arrival", x: 2, y: 0, dir: "left" },
    ]);
    porter.x = 2;
    const source = project([porter]);
    source.maps.push({ id: "arrival", name: "Arrival", width: 3, height: 1,
      sheets: ["floor"], ground: [FLOOR, FLOOR, FLOOR], events: [] });
    const session = createSession(source);
    let state = startSession(source, session);
    expect(state.sw.steps ?? 0).toBe(0);
    for (let frame = 0; frame < 45 && state.mapId !== "arrival"; frame++) {
      state = stepSession(session, state, { buttons: 0, confirmEdge: frame === 0 });
    }
    expect(state.mapId).toBe("arrival");
    expect([state.move.tx, state.move.ty]).toEqual([2, 0]);
    expect(state.sw.steps ?? 0).toBe(0);
    state = run(session, state, 8, 0x0080);
    expect([state.move.tx, state.move.ty]).toEqual([1, 0]);
    expect(state.sw.steps).toBe(1);
  });

  test("forced player routes count their successful landings", () => {
    const route = event("route", "action", [{
      op: "moveRoute",
      target: "player",
      wait: false,
      route: { steps: ["moveRight"], repeat: false, skippable: false },
    }]);
    const source = project([route]);
    source.start = { map: "field", x: 0, y: 0, dir: "down" };
    const session = createSession(source);
    let state = startSession(source, session);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    state = run(session, state, 8);
    expect([state.move.tx, state.move.ty]).toEqual([1, 0]);
    expect(state.sw.steps).toBe(1);
  });

  test("documents without the opt-in retain the sparse legacy switch-bank shape", () => {
    const source = project([], false);
    const session = createSession(source);
    const state = run(session, startSession(source, session), 8, RIGHT);
    expect(state.move.tx).toBe(2);
    expect(state.sw.steps).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(state.sw, "steps")).toBe(false);
  });
});

describe("region boundary triggers", () => {
  const commands = (id: string): Command[] => [{ op: "switch", id, value: true }];
  const regionEvents = (): GameEvent[] => [
    // Deliberately authored out of order. Runtime order is leave group,
    // enter group, then UTF-16 event id within each group.
    event("z-enter", "regionEnter", commands("z-enter"), 2),
    event("b-leave", "regionLeave", commands("b-leave"), 1),
    event("a-enter", "regionEnter", commands("a-enter"), 2,
      { all: [{ kind: "steps", op: ">=", value: 1 }] }),
    event("a-leave", "regionLeave", commands("a-leave"), 1),
  ];

  test("a crossing queues every leave before every enter in event-id order", () => {
    const starts: string[] = [];
    const source = project(regionEvents());
    const session = createSession(source, 60, {
      immutableState: true,
      onFiberStart: (key) => starts.push(key),
    });
    let state = run(session, startSession(source, session), 8, RIGHT);
    expect(starts).toEqual(["field/a-leave"]);
    expect(state.interp.pendingRegionTriggers?.map((request) => request.key)).toEqual([
      "field/b-leave",
      "field/a-enter",
      "field/z-enter",
    ]);

    state = run(session, state, 3);
    expect(starts).toEqual([
      "field/a-leave",
      "field/b-leave",
      "field/a-enter",
      "field/z-enter",
    ]);
    expect(state.interp.pendingRegionTriggers).toBeUndefined();
  });

  test("the queued edge sequence and step counter survive save/load", () => {
    const source = project(regionEvents());
    const firstStarts: string[] = [];
    const firstSession = createSession(source, 60, {
      onFiberStart: (key) => firstStarts.push(key),
    });
    const crossed = run(firstSession, startSession(source, firstSession), 8, RIGHT);
    expect(firstStarts).toEqual(["field/a-leave"]);
    const snapshot = createSessionSnapshot(firstSession, crossed, RIGHT);

    const resumedStarts: string[] = [];
    const resumedSession = createSession(source, 60, {
      onFiberStart: (key) => resumedStarts.push(key),
    });
    const loaded = loadSession(resumedSession, snapshot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.sw.steps).toBe(1);
    const finished = run(resumedSession, loaded.state, 3);
    expect(resumedStarts).toEqual([
      "field/b-leave",
      "field/a-enter",
      "field/z-enter",
    ]);
    expect(finished.interp.pendingRegionTriggers).toBeUndefined();

    snapshot.interp.pendingRegionTriggers![0]!.key = "other/b-leave";
    const rejected = loadSession(createSession(source), snapshot);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.message).toContain("is not on field");
  });
});
