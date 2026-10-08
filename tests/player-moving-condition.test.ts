import { describe, expect, test } from "bun:test";
import { BTN_BITS } from "../src/engine/camera.ts";
import {
  activePage,
  createInterpState,
  createSwitchState,
  createWorld,
  evalCondition,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type SessionState,
} from "../src/engine/session.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { GameEvent, MapDef, Project, TileId } from "../src/engine/types.ts";
import schema from "../src/data/schema.json" with { type: "json" };

const TILE: TileId = "tiles.0";

function movementMap(): MapDef {
  const watcher: GameEvent = {
    id: "watcher",
    x: 0,
    y: 0,
    pages: [{
      trigger: "parallel",
      commands: [{
        op: "if",
        if: { kind: "playerMoving" },
        then: [{ op: "variable", id: "movingTicks", set: { op: "add", value: 1 } }],
        else: [{ op: "variable", id: "restingTicks", set: { op: "add", value: 1 } }],
      }],
    }],
  };
  return {
    id: "map",
    name: "Movement",
    width: 8,
    height: 6,
    sheets: ["tiles"],
    ground: new Array<TileId>(48).fill(TILE),
    events: [watcher],
  };
}

function movementProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "playerMoving",
    tileSize: 16,
    start: { map: "map", x: 2, y: 2, dir: "right" },
    sheets: [{ id: "tiles", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [movementMap()],
  };
}

function input(playerMoving?: boolean): InterpInput {
  return {
    playerCell: { x: 2, y: 2 },
    prevCell: { x: 2, y: 2 },
    facing: 3,
    ...(playerMoving === undefined ? {} : { playerMoving }),
  };
}

function runAt(hz: 60 | 30 | 20): SessionState {
  const project = movementProject();
  const session = createSession(project, hz, { immutableState: true });
  let state = startSession(project, session);
  // Six reference ticks held, then six released. The first tick commits the
  // step but is not yet moving to event conditions; ticks 2..8 observe the
  // live interpolation, including the tick on which the step lands.
  for (let reference = 0; reference < 12; reference += session.ticksPerFrame) {
    const buttons = reference < 6 ? BTN_BITS.RIGHT : 0;
    state = stepSession(session, state, { buttons });
  }
  return state;
}

describe("playerMoving condition", () => {
  test("is false without live context and supports negation", () => {
    const switches = createSwitchState();
    expect(evalCondition({ kind: "playerMoving" }, switches, "map/watcher")).toBe(false);
    expect(evalCondition(
      { kind: "playerMoving" },
      switches,
      "map/watcher",
      undefined,
      undefined,
      { worldIdle: true, playerMoving: true },
    )).toBe(true);
    expect(evalCondition(
      { kind: "playerMoving", negate: true },
      switches,
      "map/watcher",
      undefined,
      undefined,
      { worldIdle: true, playerMoving: true },
    )).toBe(false);
  });

  test("drives page selection and parallel evaluation", () => {
    const event: GameEvent = {
      id: "page",
      x: 1,
      y: 1,
      pages: [
        { trigger: "parallel", sprite: "rest", commands: [] },
        {
          trigger: "parallel",
          sprite: "walk",
          condition: { all: [{ kind: "playerMoving" }] },
          commands: [],
        },
      ],
    };
    const world = createWorld({ ...movementMap(), events: [event] });
    const switches = createSwitchState();
    expect(world.needsPlayerMovingContext).toBe(true);
    expect(activePage(event, switches, "map", 3, undefined, {
      worldIdle: true,
      playerMoving: false,
    })?.index).toBe(0);
    expect(activePage(event, switches, "map", 3, undefined, {
      worldIdle: true,
      playerMoving: true,
    })?.index).toBe(1);

    const programWorld = createWorld(movementMap());
    let state = createInterpState();
    state = stepInterp(programWorld, state, input(false));
    expect(state.sw.variables.movingTicks ?? 0).toBe(0);
    state = stepInterp(programWorld, state, input(true));
    expect(state.sw.variables.movingTicks).toBe(1);
  });

  test("samples tick-start interpolation identically at 60/30/20 Hz", () => {
    const project = movementProject();
    expect(validateSchema(schema, project)).toEqual([]);
    const states = ([60, 30, 20] as const).map(runAt);
    const projection = (state: SessionState) => ({
      tx: state.move.tx,
      ty: state.move.ty,
      phase: state.move.phase,
      moving: state.move.moving,
      walking: state.move.walking,
      movingTicks: state.sw.variables.movingTicks,
      restingTicks: state.sw.variables.restingTicks,
      interpFrame: state.interp.frame,
    });
    expect(states.map(projection)).toEqual([
      projection(states[0]!),
      projection(states[0]!),
      projection(states[0]!),
    ]);
    expect(projection(states[0]!)).toEqual({
      tx: 3,
      ty: 2,
      phase: 0,
      moving: false,
      walking: false,
      movingTicks: 7,
      restingTicks: 5,
      interpFrame: 12,
    });
  });
});
