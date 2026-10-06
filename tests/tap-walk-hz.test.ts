// tests/tap-walk-hz.test.ts — tap-to-walk must arrive at the tapped tile at
// every host rate the kit supports. GameView plans one BFS route and then
// folds one direction bit per reference tick: the frame-start call picks
// tick 0's bit, and the session's tick-direction resolver advances the route
// after every other tick. A route that held one bit for a whole low-rate
// host frame (15 ticks at 4 Hz) walked past the turn and never recovered.

import { describe, expect, test } from "bun:test";
import { BTN } from "@pocketjs/framework/input";
import {
  createSession,
  isSessionWorldIdle,
  sessionPassageTable,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { startTapWalk, stepTapWalk, TAP_WALK_DIR_BITS, type TapWalkRoute } from "../src/ui/tap-to-walk.ts";
import { MOTION_HZ } from "../src/engine/motion-clock.ts";
import type { MapDef, Project, TileId } from "../src/engine/types.ts";

const TILE: TileId = "tiles.0";
const DIR_BITS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;
const HZ_VALUES = [60, 30, 20, 4] as const;

function map8(events: MapDef["events"] = []): MapDef {
  return {
    id: "a",
    name: "a",
    width: 8,
    height: 8,
    sheets: ["tiles"],
    ground: new Array<TileId>(64).fill(TILE),
    events,
  };
}

function project8(events: MapDef["events"] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "TapWalk",
    tileSize: 16,
    start: { map: "a", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "tiles", pak: "chunks", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map8(events)],
  };
}

const NO_EDGES = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false, leftEdge: false, rightEdge: false };

/** Drive a tap route exactly the way GameView does: one stepTapWalk per
 *  reference tick — the frame-start evaluation for tick 0, then the
 *  tick-direction resolver for every tick that follows in the same host
 *  frame. Returns the final state and whether the route is still alive. */
function driveTapWalk(
  project: Project,
  hz: number,
  targetTx: number,
  targetTy: number,
  frames: number,
  onFrame?: (state: SessionState, frame: number) => void,
): { state: SessionState; alive: boolean; arrived: boolean } {
  const session: Session = createSession(project, hz);
  let state = startSession(project, session);
  let route: TapWalkRoute | null = startTapWalk(
    sessionPassageTable(session, state),
    state.move.tx,
    state.move.ty,
    targetTx,
    targetTy,
    state.mapId,
    state.move.px,
    state.move.py,
  );
  expect(route).not.toBeNull();
  const step = (buttons: number, st: SessionState): number => {
    if (!route) return 0;
    const userDir = buttons & DIR_BITS;
    if (!isSessionWorldIdle(st) || st.playerRoute || st.mapId !== route.mapId || userDir !== 0) {
      route = null;
      return 0;
    }
    const r = stepTapWalk(route, st.move.tx, st.move.ty, st.move.px, st.move.py);
    if (!r.alive || r.dir === null) {
      route = null;
      return 0;
    }
    return TAP_WALK_DIR_BITS[r.dir] ?? 0;
  };
  for (let frame = 0; frame < frames; frame++) {
    onFrame?.(state, frame);
    const bit = step(0, state);
    const hook = route ? (st: SessionState) => step(0, st) : undefined;
    state = stepSession(session, state, { buttons: bit, ...NO_EDGES }, undefined, hook);
  }
  return {
    state,
    alive: route !== null,
    arrived: state.move.tx === targetTx && state.move.ty === targetTy,
  };
}

/** Host frames needed to fold `ticks` reference ticks at this host rate. */
function framesForTicks(hz: number, ticks: number): number {
  return Math.ceil((ticks * hz) / MOTION_HZ);
}

describe("tap-to-walk at every host rate", () => {
  test("a route with a turn arrives and stops at 60/30/20/4 Hz", () => {
    // (1,1) -> right to (2,1) -> down to (2,2): the turn the review's probe
    // showed the old code overshooting at 4 Hz (it ended at (3,7)).
    const results = HZ_VALUES.map((hz) => ({ hz, ...driveTapWalk(project8(), hz, 2, 2, framesForTicks(hz, 64)) }));
    for (const { hz, state, alive, arrived } of results) {
      expect(arrived, `${hz} Hz arrived at (2,2)`).toBe(true);
      expect(alive, `${hz} Hz route released on arrival`).toBe(false);
      expect([state.move.tx, state.move.ty], `${hz} Hz final cell`).toEqual([2, 2]);
      expect([state.move.px, state.move.py], `${hz} Hz final pixels`).toEqual([32, 32]);
    }
  });

  test("the same virtual time leaves the player in the same place at every rate", () => {
    const reference = driveTapWalk(project8(), 60, 6, 6, framesForTicks(60, 96));
    for (const hz of [30, 20, 4] as const) {
      const run = driveTapWalk(project8(), hz, 6, 6, framesForTicks(hz, 96));
      expect([run.state.move.tx, run.state.move.ty], `${hz} Hz cell`).toEqual([
        reference.state.move.tx,
        reference.state.move.ty,
      ]);
      expect([run.state.move.px, run.state.move.py], `${hz} Hz pixels`).toEqual([
        reference.state.move.px,
        reference.state.move.py,
      ]);
      expect(run.arrived, `${hz} Hz arrived`).toBe(true);
      expect(run.alive, `${hz} Hz route released`).toBe(false);
    }
  });

  test("a straight route arrives and releases at every rate", () => {
    for (const hz of HZ_VALUES) {
      const run = driveTapWalk(project8(), hz, 1, 5, framesForTicks(hz, 80));
      expect(run.arrived, `${hz} Hz arrived`).toBe(true);
      expect(run.alive, `${hz} Hz route released`).toBe(false);
      expect([run.state.move.tx, run.state.move.ty], `${hz} Hz final cell`).toEqual([1, 5]);
    }
  });

  test("a dynamic blocker on the route makes it give up instead of walking through", () => {
    // The route is planned on the terrain table (no bodies); blocking
    // characters then stand on both intermediate tiles. The mover cannot
    // progress, the stuck budget (1.5 reference seconds) runs out at every
    // rate, and the route releases without passing through a body.
    const blockers: MapDef["events"] = [
      { id: "block-a", x: 1, y: 2, pages: [{ trigger: "action", blocks: true, commands: [] }] },
      { id: "block-b", x: 2, y: 1, pages: [{ trigger: "action", blocks: true, commands: [] }] },
    ];
    for (const hz of HZ_VALUES) {
      const project = project8(blockers);
      const session = createSession(project, hz);
      let state = startSession(project, session);
      let route: TapWalkRoute | null = startTapWalk(
        sessionPassageTable(session, state),
        state.move.tx,
        state.move.ty,
        2,
        2,
        state.mapId,
        state.move.px,
        state.move.py,
      );
      expect(route).not.toBeNull();
      const step = (st: SessionState): number => {
        if (!route) return 0;
        if (!isSessionWorldIdle(st) || st.playerRoute || st.mapId !== route.mapId) {
          route = null;
          return 0;
        }
        const r = stepTapWalk(route, st.move.tx, st.move.ty, st.move.px, st.move.py);
        if (!r.alive || r.dir === null) {
          route = null;
          return 0;
        }
        return TAP_WALK_DIR_BITS[r.dir] ?? 0;
      };
      for (let frame = 0; frame < framesForTicks(hz, 200); frame++) {
        const bit = step(state);
        const hook = route ? (st: SessionState) => step(st) : undefined;
        state = stepSession(session, state, { buttons: bit, ...NO_EDGES }, undefined, hook);
      }
      expect(route, `${hz} Hz route gave up`).toBeNull();
      expect([state.move.tx, state.move.ty], `${hz} Hz stayed before the body`).toEqual([1, 1]);
    }
  });

  test("a held d-pad direction cancels the route before it moves the player", () => {
    // The frame-start evaluation clears a route the moment the player holds
    // a direction; the fold then walks the held mask, not the route.
    for (const hz of HZ_VALUES) {
      const project = project8();
      const session = createSession(project, hz);
      let state = startSession(project, session);
      let route: TapWalkRoute | null = startTapWalk(
        sessionPassageTable(session, state),
        state.move.tx,
        state.move.ty,
        5,
        5,
        state.mapId,
        state.move.px,
        state.move.py,
      );
      expect(route).not.toBeNull();
      // Hold UP from the first frame: the route must clear and the held
      // mask must fold instead.
      const held = BTN.UP;
      const step = (buttons: number, st: SessionState): number => {
        if (!route) return 0;
        if ((buttons & DIR_BITS) !== 0 || !isSessionWorldIdle(st) || st.mapId !== route.mapId) {
          route = null;
          return 0;
        }
        const r = stepTapWalk(route, st.move.tx, st.move.ty, st.move.px, st.move.py);
        if (!r.alive || r.dir === null) {
          route = null;
          return 0;
        }
        return TAP_WALK_DIR_BITS[r.dir] ?? 0;
      };
      const bit = step(held, state);
      expect(route, `${hz} Hz route cleared by the held direction`).toBeNull();
      expect(bit).toBe(0);
      state = stepSession(session, state, { buttons: held, ...NO_EDGES }, undefined, undefined);
      expect(state.move.facing, `${hz} Hz faced the held direction`).toBe(2);
      // The held mask folded: the player moved up (or began to), never
      // toward the cancelled route's target.
      expect(state.move.ty < 1 || state.move.py < 16, `${hz} Hz walked the held direction`).toBe(true);
      expect(state.move.tx, `${hz} Hz did not follow the cancelled route`).toBe(1);
    }
  });
});
