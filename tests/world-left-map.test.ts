// The frozen display snapshot of the map a seamless handoff just left: what
// the reducer records on the commit tick, when it drops it (ring, re-entry,
// any other map entry), and that saves, loads and every rate agree.

import { describe, expect, test } from "bun:test";
import { encodeSaveCode } from "../src/engine/save.ts";
import { loadSession, saveSession } from "../src/engine/save-restore.ts";
import {
  createSession,
  LEFT_MAP_RING_TILES,
  startSession,
  stepSession,
  type LeftMapSnapshot,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { GameEvent, MapDef, Project, WorldLayout } from "../src/engine/types.ts";
import { createWorldHandoffResolver } from "../src/engine/world-handoff.ts";

const WEST_W = 8;
const EAST_W = 80;
const H = 6;
const TO_EAST = "west:east:row-2";
const TO_WEST = "east:west:row-3";

const LAYOUT: WorldLayout = {
  topologyHash: "7".repeat(64),
  components: [{
    worldId: "left-map",
    componentId: "row",
    bounds: { minTileX: 0, minTileY: 0, maxTileX: WEST_W + EAST_W, maxTileY: H },
    placements: [
      { mapId: "east", originTileX: WEST_W, originTileY: 0, width: EAST_W, height: H },
      { mapId: "west", originTileX: 0, originTileY: 0, width: WEST_W, height: H },
    ],
    seams: [{
      mapA: "west", sideA: "east", spanA: { start: 0, end: H },
      mapB: "east", sideB: "west", spanB: { start: 0, end: H },
      axis: "y", offsetAtoB: 0, openingIds: [TO_WEST, TO_EAST],
    }],
    openings: [
      {
        portalId: TO_WEST,
        source: { mapId: "east", side: "west", span: { start: 3, end: 4 } },
        target: { mapId: "west", side: "east", span: { start: 3, end: 4 } },
        axis: "y", offset: 0, compatibility: "coordinate-preserving",
      },
      {
        portalId: TO_EAST,
        source: { mapId: "west", side: "east", span: { start: 2, end: 3 } },
        target: { mapId: "east", side: "west", span: { start: 2, end: 3 } },
        axis: "y", offset: 0, compatibility: "coordinate-preserving",
      },
    ],
  }],
};

const WEST_EVENTS: GameEvent[] = [
  {
    id: "to-east", x: WEST_W - 1, y: 2,
    pages: [{ trigger: "playerTouch", commands: [{ op: "transfer", map: "east", x: 0, y: 2, dir: "right", handoff: { mode: "seamless-v1", portalId: TO_EAST } }] }],
  },
  // Walked two cells left once by the parallel below; then stands there.
  { id: "w-walker", x: 4, y: 4, pages: [{ trigger: "action", sprite: "walker", commands: [] }] },
  { id: "w-wander", x: 2, y: 1, pages: [{ trigger: "action", sprite: "wander", moveType: "random", commands: [] }] },
  // Re-skinned and half transparent by the parallel below.
  { id: "w-skin", x: 1, y: 5, pages: [{ trigger: "action", sprite: "plain", dir: "up", commands: [] }] },
  // Erases itself: no character, nothing frozen.
  { id: "w-gone", x: 5, y: 5, pages: [{ trigger: "parallel", sprite: "gone", commands: [{ op: "erase" }] }] },
  // A page without a sprite paints nothing.
  { id: "w-blank", x: 6, y: 5, pages: [{ trigger: "action", commands: [] }] },
  {
    id: "w-script", x: 0, y: 0,
    pages: [
      {
        trigger: "parallel",
        commands: [
          { op: "appearance", target: { event: "w-skin" }, sprite: "alt", opacity: 128 },
          {
            op: "moveRoute",
            target: { event: "w-walker" },
            route: { steps: ["moveLeft", "moveLeft"], repeat: false, skippable: true },
          },
          { op: "selfSwitch", key: "A", value: true },
        ],
      },
      { condition: { selfSwitch: "A" }, trigger: "action", commands: [] },
    ],
  },
];

const EAST_EVENTS: GameEvent[] = [
  {
    id: "to-west", x: 0, y: 3,
    pages: [{ trigger: "playerTouch", commands: [{ op: "transfer", map: "west", x: WEST_W - 1, y: 3, dir: "left", handoff: { mode: "seamless-v1", portalId: TO_WEST } }] }],
  },
  // An ordinary (legacy) transfer back to west.
  {
    id: "door", x: 1, y: 1,
    pages: [{ trigger: "playerTouch", commands: [{ op: "transfer", map: "west", x: 3, y: 3, dir: "down" }] }],
  },
  { id: "e-npc", x: 5, y: 5, pages: [{ trigger: "action", sprite: "plain", commands: [] }] },
];

function map(id: string, width: number, events: GameEvent[]): MapDef {
  return {
    id, name: id, width, height: H, sheets: ["plain"],
    ground: new Array(width * H).fill("plain.0"), events,
  };
}

function project(traversal: Project["worldTraversal"] = "seamless-v1"): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Left map snapshot",
    tileSize: 16,
    start: { map: "west", x: WEST_W - 2, y: 2, dir: "right" },
    worldTraversal: traversal,
    worldLayout: LAYOUT,
    sheets: [{ id: "plain", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map("east", EAST_W, EAST_EVENTS), map("west", WEST_W, WEST_EVENTS)],
  };
}

const DOWN = 0x0040;
const LEFT = 0x0080;
const UP = 0x0010;
const RIGHT = 0x0020;

interface Run {
  session: Session;
  state: SessionState;
  /** Reference ticks folded so far. */
  tick: number;
  /** Characters of the active map on the last frame before each commit. */
  beforeCommit?: SessionState;
}

function boot(hz = 60, traversal: Project["worldTraversal"] = "seamless-v1"): Run {
  const p = project(traversal);
  const session = createSession(p, hz, { handoff: createWorldHandoffResolver(LAYOUT) });
  return { session, state: startSession(p, session), tick: 0 };
}

function frame(run: Run, buttons = 0): void {
  const before = run.state;
  run.state = stepSession(run.session, run.state, { buttons });
  run.tick += run.session.ticksPerFrame;
  if (run.state.mapId !== before.mapId) run.beforeCommit = before;
}

/** Hold `buttons` until the player stands still on (x, y) of `mapId`. */
function walkTo(run: Run, buttons: number, mapId: string, x: number, y: number, limit = 2000): void {
  for (let i = 0; i < limit; i++) {
    const m = run.state.move;
    if (run.state.mapId === mapId && m.tx === x && m.ty === y && !m.moving && run.state.handoff === undefined) return;
    frame(run, buttons);
  }
  throw new Error(`did not reach ${mapId} (${x}, ${y}); at ${run.state.mapId} (${run.state.move.tx}, ${run.state.move.ty})`);
}

function idle(run: Run, frames: number): void {
  for (let i = 0; i < frames; i++) frame(run);
}

/** Idle on west until the scripted walker has finished and the wanderer
 * has left its authored cell, then cross to east. */
function crossToEast(run: Run): void {
  idle(run, Math.round(run.session.hz * 2));
  const wander = run.state.chars.chars["w-wander"]!;
  expect(wander.tx !== 2 || wander.ty !== 1, "the wanderer left its authored cell").toBe(true);
  walkTo(run, RIGHT, "east", 0, 2);
}

describe("left-map snapshot", () => {
  test("a seamless commit freezes the source characters exactly as painted", () => {
    const run = boot();
    crossToEast(run);
    const before = run.beforeCommit!;
    expect(before.mapId).toBe("west");
    // The commit frame itself.
    let state = run.state;
    const left = state.leftMap!;
    expect(left).toMatchObject({ mapId: "west", originX: -WEST_W, originY: 0, width: WEST_W, height: H });
    expect(left.actors.map((actor) => actor.eventId)).toEqual(["w-walker", "w-wander", "w-skin"]);
    const actor = (id: string) => left.actors.find((entry) => entry.eventId === id)!;
    // The walker finished its route two cells left, facing left.
    expect(actor("w-walker")).toEqual({ eventId: "w-walker", px: 2 * 16, py: 4 * 16, facing: 1, pose: 0, sprite: "walker", opacity: 255 });
    // The re-skin and opacity override are what the pool painted.
    expect(actor("w-skin")).toEqual({ eventId: "w-skin", px: 16, py: 5 * 16, facing: 2, pose: 0, sprite: "alt", opacity: 128 });
    // The wanderer is frozen where it was, off its authored cell; at most
    // one reference tick of motion separates it from the last source frame.
    const wander = actor("w-wander");
    const live = before.chars.chars["w-wander"]!;
    expect(Math.abs(wander.px - live.px) + Math.abs(wander.py - live.py)).toBeLessThanOrEqual(2);
    expect(wander.px !== 2 * 16 || wander.py !== 16).toBe(true);
    // Entry discarded the source characters; the snapshot is all that is left.
    expect(Object.keys(state.chars.chars)).toHaveLength(0);
    // It is immutable and shared by later folds until something drops it.
    frame(run);
    state = run.state;
    expect(state.leftMap).toBe(left);
  });

  test("the snapshot is dropped on the reference tick the player leaves the ring", () => {
    const run = boot();
    crossToEast(run);
    // West spans east-local x -8..-1, so the ring ends at x = RING - 1.
    walkTo(run, RIGHT, "east", LEFT_MAP_RING_TILES - 1, 2);
    expect(run.state.leftMap?.mapId).toBe("west");
    let dropTick = -1;
    for (let i = 0; i < 40 && dropTick < 0; i++) {
      const before = run.state.move.tx;
      frame(run, RIGHT);
      if (run.state.leftMap === undefined) {
        dropTick = run.tick;
        // Dropped on the first tick that starts with the player's tile
        // 65 tiles (x = 64) from west's last column, not earlier or later.
        expect(before).toBe(LEFT_MAP_RING_TILES);
      } else {
        expect(before).toBeLessThanOrEqual(LEFT_MAP_RING_TILES);
      }
    }
    expect(dropTick).toBeGreaterThan(0);
    // Walking back does not bring it back: west shows its entry preview.
    walkTo(run, LEFT, "east", 2, 2);
    expect(run.state.leftMap).toBeUndefined();
  });

  test("re-entering the frozen map hands it to its entry characters in one frame", () => {
    const run = boot();
    crossToEast(run);
    // East (0,2) → (1,2) → (1,3) → step left onto the east→west opening.
    walkTo(run, RIGHT, "east", 1, 2);
    walkTo(run, DOWN, "east", 1, 3);
    walkTo(run, LEFT, "west", WEST_W - 1, 3);
    // East is frozen now and west is live again; west's own snapshot is gone.
    const commit = run.state;
    expect(commit.leftMap?.mapId).toBe("east");
    expect(commit.leftMap?.originX).toBe(WEST_W);
    expect(commit.leftMap?.actors.map((actor) => actor.eventId)).toEqual(["e-npc"]);
    // West re-entered: page sync rebuilds its characters from entry, so the
    // walker starts again from its authored cell.
    expect(Object.keys(commit.chars.chars)).toHaveLength(0);
    frame(run);
    expect(run.state.chars.chars["w-walker"]).toMatchObject({ tx: 4, ty: 4, px: 64, py: 64 });
    idle(run, 30);
    expect(run.state.chars.chars["w-walker"]).toMatchObject({ tx: 4, ty: 4 });
  });

  test("any other map entry drops the snapshot", () => {
    const run = boot();
    crossToEast(run);
    walkTo(run, RIGHT, "east", 1, 2);
    expect(run.state.leftMap?.mapId).toBe("west");
    // Up onto the ordinary door: a legacy transfer back to west.
    walkTo(run, UP, "west", 3, 3);
    expect(run.state.leftMap).toBeUndefined();
  });

  test("a legacy-traversal project never records a snapshot", () => {
    const run = boot(60, "legacy-transfer");
    idle(run, 30);
    walkTo(run, RIGHT, "east", 0, 2);
    expect(run.state.leftMap).toBeUndefined();
    expect("leftMap" in run.state).toBe(false);
    idle(run, 2);
    const saved = saveSession(run.session, run.state, 0);
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(JSON.stringify(saved.snapshot)).not.toContain("leftMap");
  });

  test("saves and loads carry the snapshot; an older save falls back without error", () => {
    const run = boot();
    crossToEast(run);
    idle(run, 2);
    const left = run.state.leftMap!;
    const saved = saveSession(run.session, run.state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.snapshot.mapRuntime?.leftMap).toEqual(left);
    for (const input of [saved.snapshot, encodeSaveCode(saved.snapshot)]) {
      const fresh = boot();
      const loaded = loadSession(fresh.session, input);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.state.leftMap).toEqual(left);
      // The restored state folds on exactly like the original.
      const a = stepSession(run.session, run.state, { buttons: RIGHT });
      const b = stepSession(fresh.session, loaded.state, { buttons: RIGHT });
      expect(b.leftMap).toEqual(a.leftMap);
    }
    // A save written before the snapshot existed.
    const older = structuredClone(saved.snapshot);
    delete older.mapRuntime!.leftMap;
    const fresh = boot();
    const loaded = loadSession(fresh.session, older);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.state.leftMap).toBeUndefined();
  });

  test("a malformed snapshot in a save is refused", () => {
    const run = boot();
    crossToEast(run);
    idle(run, 2);
    const saved = saveSession(run.session, run.state, 0);
    if (!saved.ok) throw new Error(saved.error.message);
    const cases: [string, (left: LeftMapSnapshot & Record<string, unknown>) => void][] = [
      ["facing", (left) => { (left.actors[0] as unknown as Record<string, unknown>).facing = 4; }],
      ["pose", (left) => { (left.actors[0] as unknown as Record<string, unknown>).pose = 3; }],
      ["opacity", (left) => { (left.actors[0] as unknown as Record<string, unknown>).opacity = 256; }],
      ["width", (left) => { left.width = 0; }],
      ["current map", (left) => { left.mapId = "east"; }],
    ];
    for (const [label, corrupt] of cases) {
      const bad = structuredClone(saved.snapshot);
      corrupt(bad.mapRuntime!.leftMap as LeftMapSnapshot & Record<string, unknown>);
      const loaded = loadSession(boot().session, bad);
      expect(loaded.ok, label).toBe(false);
      if (!loaded.ok) expect(loaded.error.code, label).toBe("shape");
    }
  });

  test("20, 30 and 60 Hz record and drop the same snapshot at the same reference ticks", () => {
    const runs = ([20, 30, 60] as const).map((hz) => {
      const run = boot(hz);
      const samples = new Map<number, LeftMapSnapshot | null>();
      // Idle, cross, then walk far enough east to leave the ring.
      const plan = (tick: number): number => tick < 120 ? 0 : RIGHT;
      while (run.tick < 120 + 8 * (LEFT_MAP_RING_TILES + 12)) {
        frame(run, plan(run.tick));
        if (run.tick % 6 === 0) samples.set(run.tick, run.state.leftMap ?? null);
      }
      return { hz, samples };
    });
    const reference = runs[2]!.samples;
    const present = [...reference.values()].filter((value) => value !== null);
    expect(present.length).toBeGreaterThan(0);
    expect([...reference.values()].at(-1)).toBeNull();
    for (const run of runs) {
      for (const [tick, value] of reference) {
        expect(run.samples.get(tick), `${run.hz} Hz tick ${tick}`).toEqual(value);
      }
    }
  });
});
