// tests/ka1-map-anim.test.ts — KA1: state-driven map animations.
//
// mapAnim/stopAnim over the pure interpreter fold: instances are state keyed
// by id with the saved frame clock as their origin, so the same virtual
// instant selects the same frame at 60/30/20/4 Hz and after a save/load.
// Rendering pixel tests live in ka1-render-sim.test.ts.

import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import { AttractController } from "../src/engine/attract.ts";
import { createExtensionRuntime } from "../src/engine/extensions.ts";
import {
  animFrameIndex,
  compileAnim,
  createInterpState,
  createWorld,
  isWorldIdle,
  stepInterp,
  stepInterpWithExtensionsInPlace,
  type InterpInput,
  type MapAnimInstance,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  encodeSaveCode,
  decodeSaveCode,
  fnv1aText,
  SaveError,
} from "../src/engine/save.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import type { AnimationDef, Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";
import { toyBattleRules } from "./fixtures/toy-battle.ts";
import { KA1_PROJECT } from "./fixtures/ka1-anim/fixture-data.ts";

const MAP_ID = "anim-map";

const PULSE: AnimationDef = {
  id: "pulse",
  sheet: "pulse.png",
  count: 4,
  frameDuration: 0.1,
  loop: false,
};

function map(events: GameEvent[] = []): MapDef {
  return {
    id: MAP_ID,
    name: "Anim fixture",
    width: 8,
    height: 8,
    sheets: ["plain"],
    ground: new Array(64).fill("plain.0"),
    events,
  };
}

function project(maps: MapDef[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Anim fixture",
    tileSize: 16,
    start: { map: maps[0]!.id, x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    animations: [PULSE],
    maps,
  };
}

function page(
  trigger: GameEvent["pages"][number]["trigger"],
  commands: Command[],
  condition?: GameEvent["pages"][number]["condition"],
): GameEvent["pages"][number] {
  return { trigger, commands, ...(condition ? { condition } : {}) };
}

function event(id: string, x: number, y: number, pages: GameEvent["pages"]): GameEvent {
  return { id, x, y, pages };
}

const input = (
  facing: 0 | 1 | 2 | 3 = 0,
  extra: Partial<InterpInput> = {},
): InterpInput => ({
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  playerCell: { x: 2, y: 2 },
  prevCell: { x: 2, y: 2 },
  facing,
  ...extra,
});

const confirm = (facing: 0 | 1 | 2 | 3 = 0): InterpInput =>
  input(facing, { confirmEdge: true });

/** Fold n ticks with the same held input. */
function fold(
  w: ReturnType<typeof createWorld>,
  s0: ReturnType<typeof createInterpState>,
  n: number,
  inp: InterpInput = input(),
): ReturnType<typeof createInterpState> {
  let s = s0;
  for (let i = 0; i < n; i++) s = stepInterp(w, s, inp);
  return s;
}

const animIds = (s: ReturnType<typeof createInterpState>): string[] =>
  (s.anims ?? []).map((a) => a.id);

describe("mapAnim instance lifecycle", () => {
  test("a one-shot instance starts on the run tick and leaves state when its playthrough completes", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx1", anim: "pulse", x: 3, y: 3 },
        { op: "mapAnim", id: "fx2", anim: "pulse", x: 4, y: 4 },
        { op: "mapAnim", id: "fx3", anim: "pulse", x: 5, y: 5 },
      ])]),
      event("again", 3, 2, [page("action", [
        { op: "mapAnim", id: "fx4", anim: "pulse", x: 6, y: 6 },
      ])]),
    ]), [], 60, { animations: [PULSE] });

    let s = stepInterp(w, createInterpState(), confirm());
    expect(animIds(s)).toEqual(["fx1", "fx2", "fx3"]);
    const first = s.anims![0]!;
    expect(first.start).toBe(s.frame);
    expect(first.x).toBe(3);
    expect(first.y).toBe(3);
    expect(first.target).toBeNull();
    expect(first.layer).toBe("above"); // Tuxemon layer 4 default
    expect(first.loop).toBe(false);

    // 0.1s/frame * 4 frames = 24 ticks at 60 Hz.
    s = fold(w, s, 23); // one tick short of the playthrough: still live
    expect(animIds(s)).toEqual(["fx1", "fx2", "fx3"]);
    s = fold(w, s, 1); // the playthrough completes; the instances leave state
    expect(animIds(s), "finished one-shots leave state on the completion tick").toEqual([]);

    s = stepInterp(w, s, confirm(3)); // face the event to the east and confirm
    expect(animIds(s)).toEqual(["fx4"]);
  });

  test("a same-id replay replaces the live instance with a fresh start tick", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3 },
      ])]),
    ]), [], 60, { animations: [PULSE] });

    let s = stepInterp(w, createInterpState(), confirm());
    expect(s.anims ?? []).toHaveLength(1);
    const start1 = s.anims![0]!.start;
    s = fold(w, s, 10);
    s = stepInterp(w, s, confirm());
    expect(s.anims ?? []).toHaveLength(1);
    expect(s.anims![0]!.start).toBe(s.frame);
    expect(s.anims![0]!.start).toBeGreaterThan(start1);
  });

  test("an unknown animation name is a content error, not a silent no-op", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "missing", x: 3, y: 3 },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), confirm());
    expect(s.error?.kind).toBe("content");
    expect(s.error?.message).toContain("missing");
  });

  test("x/y without a target must be non-negative integers", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse" },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), confirm());
    expect(s.error?.kind).toBe("content");
  });

  test("mapAnim never mutates the previous frame's anims list or instances", () => {
    // copyInterp shares the anims array; writableAnims must copy before a
    // write. Retain the predecessor state and assert a later start leaves
    // its array and instance objects byte-identical.
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3 },
        { op: "mapAnim", id: "fy", anim: "pulse", x: 4, y: 4 },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    let s = stepInterp(w, createInterpState(), confirm());
    expect(animIds(s)).toEqual(["fx", "fy"]);
    const before = s.anims!;
    const beforeFx = before[0]!;
    const beforeStart = beforeFx.start;
    expect(beforeStart).toBe(s.frame);
    // Re-trigger the same event: both same-id replays replace the instances.
    s = stepInterp(w, s, confirm());
    expect(animIds(s)).toEqual(["fx", "fy"]);
    // The retained predecessor array and its instance objects are untouched.
    expect(before).toHaveLength(2);
    expect(before[0]).toBe(beforeFx);
    expect(before[1]).toBe(before[1]);
    expect(beforeFx.start).toBe(beforeStart);
    expect((before[1] as MapAnimInstance).start).toBe(beforeStart);
    // The new state has fresh instances with later start ticks.
    expect(s.anims![0]!.start).toBeGreaterThan(beforeStart);
  });

  test("stopAnim never mutates the previous frame's anims list", () => {
    const w = createWorld(map([
      event("start", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true },
        { op: "mapAnim", id: "fy", anim: "pulse", x: 4, y: 4, loop: true },
      ])]),
      event("stop", 3, 2, [page("action", [
        { op: "stopAnim", id: "fy" },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    let s = stepInterp(w, createInterpState(), confirm());
    expect(animIds(s)).toEqual(["fx", "fy"]);
    const before = s.anims!;
    const beforeFy = before[1]!;
    // Face east and confirm into the stop event.
    s = stepInterp(w, s, confirm(3));
    expect(animIds(s)).toEqual(["fx"]);
    // The retained predecessor array still holds both original instances.
    expect(before).toHaveLength(2);
    expect(before[1]).toBe(beforeFy);
    expect(beforeFy.id).toBe("fy");
  });
});

describe("mapAnim wait", () => {
  test("wait parks the blocking fiber until one playthrough completes", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("autorun", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, wait: true },
        { op: "switch", id: "played", value: true },
      ])]),
    ]), [], 60, { animations: [PULSE] });

    let s = stepInterp(w, createInterpState(), input());
    expect(s.main).not.toBeNull();
    expect(s.main!.mode).toBe("animWait");
    expect(isWorldIdle(s)).toBe(false);
    expect(s.sw.switches["played"]).toBeUndefined();

    s = fold(w, s, 23); // one tick short of the 24-tick playthrough
    expect(s.main!.mode).toBe("animWait");
    expect(s.sw.switches["played"]).toBeUndefined();

    s = fold(w, s, 1);
    expect(s.sw.switches["played"]).toBe(true);
    expect(isWorldIdle(s), "the fiber finished and restarted; no wait is parked").toBe(true);
  });

  test("loop + wait stays parked until stopAnim stops the instance", () => {
    const loop = { ...PULSE, loop: true };
    const w = createWorld(map([
      event("burst", 2, 3, [page("autorun", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true, wait: true },
        { op: "switch", id: "played", value: true },
      ])]),
      event("killer", 2, 3, [page("parallel", [
        { op: "wait", seconds: 1 },
        { op: "stopAnim", id: "fx" },
      ])]),
    ]), [], 60, { animations: [loop] });

    let s = stepInterp(w, createInterpState(), input());
    expect(s.main!.mode).toBe("animWait");
    // One playthrough (24 ticks) is NOT enough: a looping animation has not
    // "completed" until it is stopped (MV Wait for Completion parity).
    s = fold(w, s, 24);
    expect(s.main!.mode).toBe("animWait");
    expect(s.sw.switches["played"]).toBeUndefined();
    expect(s.anims ?? []).toHaveLength(1);
    // The instance is mid-second-cycle, still looping.
    const compiled = w.anims.get("pulse")!;
    expect(animFrameIndex(compiled, s.anims![0]!, s.frame)).toBeGreaterThanOrEqual(0);
    // The parallel stop lands at 1 s (tick 61); the wait ends that tick.
    // Assert on the stop tick itself: the autorun would restart and replay
    // the same-id instance on the next tick.
    s = fold(w, s, 36);
    expect(s.sw.switches["played"]).toBe(true);
    expect(animIds(s)).toEqual([]);
    expect(isWorldIdle(s)).toBe(true);
  });

  test("a non-waited animation never blocks worldIdle", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("parallel", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true },
        { op: "wait", seconds: 10 },
      ])]),
    ]), [], 60, { animations: [{ ...PULSE, loop: true }] });
    const s = stepInterp(w, createInterpState(), input());
    expect(s.anims ?? []).toHaveLength(1);
    expect(isWorldIdle(s)).toBe(true);
  });
});

describe("stopAnim", () => {
  test("stops one instance by id, all instances of a name, or every animation", () => {
    const start = (ids: string[]): Command[] =>
      ids.map((id, i) => ({ op: "mapAnim" as const, id, anim: "pulse", x: 3 + i, y: 3, loop: true }));
    const world = (stop: Command): ReturnType<typeof createWorld> =>
      createWorld(map([
        event("start", 2, 3, [page("action", start(["fx1", "fx2", "fx3"]))]),
        event("stop", 3, 2, [page("action", [stop])]),
      ]), [], 60, { animations: [PULSE] });

    // by id
    const w1 = world({ op: "stopAnim", id: "fx2" });
    let s = stepInterp(w1, createInterpState(), confirm());
    expect(animIds(s)).toEqual(["fx1", "fx2", "fx3"]);
    s = stepInterp(w1, s, confirm(3));
    expect(animIds(s)).toEqual(["fx1", "fx3"]);

    // by animation name
    const w2 = world({ op: "stopAnim", anim: "pulse" });
    s = stepInterp(w2, createInterpState(), confirm());
    expect(animIds(s)).toEqual(["fx1", "fx2", "fx3"]);
    s = stepInterp(w2, s, confirm(3));
    expect(animIds(s)).toEqual([]);

    // bare stopAnim: everything
    const w3 = world({ op: "stopAnim" });
    s = stepInterp(w3, createInterpState(), confirm());
    expect(animIds(s)).toEqual(["fx1", "fx2", "fx3"]);
    s = stepInterp(w3, s, confirm(3));
    expect(animIds(s)).toEqual([]);
  });

  test("stopping a waited instance resumes its fiber early", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("autorun", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true, wait: true },
        { op: "switch", id: "played", value: true },
      ])]),
      event("killer", 2, 3, [page("parallel", [
        { op: "wait", seconds: 0.1 },
        { op: "stopAnim", id: "fx" },
      ])]),
    ]), [], 60, { animations: [PULSE] });

    let s = stepInterp(w, createInterpState(), input());
    expect(s.main!.mode).toBe("animWait");
    s = fold(w, s, 6); // 0.1s at 60 Hz: the parallel stop lands, wait ends early
    expect(s.sw.switches["played"]).toBe(true);
    expect(animIds(s)).toEqual([]);
  });
});

describe("mapAnim target binding", () => {
  test("target player binds to the player's live cell", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: "player" },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), confirm());
    expect(s.anims![0]!.target).toBe("player");
    expect([s.anims![0]!.x, s.anims![0]!.y]).toEqual([2, 2]);
  });

  test("target event binds to that event's cell", () => {
    const w = createWorld(map([
      event("npc", 5, 6, [page("parallel", [{ op: "wait", seconds: 10 }])]),
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" } },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    // The session builds liveEventCells from the live character set; a pure
    // interpreter test supplies it directly (the NPC is live at 5,6).
    const s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: { npc: { x: 5, y: 6 } },
    }));
    expect(s.anims![0]!.target).toEqual({ event: "npc" });
    expect([s.anims![0]!.x, s.anims![0]!.y]).toEqual([5, 6]);
  });

  test("target this resolves to the issuing event before entering saved state", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: "this" },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: { burst: { x: 2, y: 3 } },
    }));
    expect(s.anims![0]!.target).toEqual({ event: "burst" });
    expect([s.anims![0]!.x, s.anims![0]!.y]).toEqual([2, 3]);
  });

  test("target this inside a called common event binds to the calling map event", () => {
    // The common op pushes the common program onto the calling fiber's own
    // stack, so the fiber key (and thus `this`) stays the map event's. A
    // regression that re-keys the fiber for common calls would resolve
    // `this` to the common event id ("fx-common"), which has no live
    // character, and surface as a content error instead of an instance.
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "common", id: "fx-common" },
      ])]),
    ]), [{
      id: "fx-common",
      trigger: "none",
      commands: [{ op: "mapAnim", id: "fx", anim: "pulse", target: "this" }],
    }], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: { burst: { x: 2, y: 3 } },
    }));
    expect(s.error).toBeUndefined();
    expect(s.anims).toHaveLength(1);
    expect(s.anims![0]!.target).toEqual({ event: "burst" });
    expect([s.anims![0]!.x, s.anims![0]!.y]).toEqual([2, 3]);
  });

  test("a missing target event is a content error", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "ghost" } },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), confirm());
    expect(s.error?.kind).toBe("content");
    expect(s.error?.message).toContain("ghost");
  });

  test("follow:false snapshots the character's tile at execution and pins the instance", () => {
    // Tuxemon play_map_animation reads character.tile_pos once and stores the
    // coordinates; the animation does not follow the character afterwards.
    const w = createWorld(map([
      event("npc", 5, 6, [page("parallel", [{ op: "wait", seconds: 10 }])]),
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" }, follow: false },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: { npc: { x: 5, y: 6 } },
    }));
    const inst = s.anims![0]!;
    // The instance is pinned to the NPC's tile at execution, with no target.
    expect(inst.target).toBeNull();
    expect([inst.x, inst.y]).toEqual([5, 6]);
  });

  test("follow:false on the player snapshots the player's tile", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: "player", follow: false },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), confirm());
    const inst = s.anims![0]!;
    expect(inst.target).toBeNull();
    expect([inst.x, inst.y]).toEqual([2, 2]); // input.playerCell
  });

  test("follow defaults to true: a target instance keeps following", () => {
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: "player" },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), confirm());
    expect(s.anims![0]!.target).toBe("player");
  });

  test("a target event with no live character is a content error and creates no instance", () => {
    // Tuxemon get_npc looks up the live _on_map set: an erased event, an
    // inactive page, or a never-spawned event has no live character, so
    // play_map_animation logs and stops without playing. The authored x/y
    // must not become a ghost animation position.
    const w = createWorld(map([
      event("npc", 5, 6, [page("parallel", [{ op: "wait", seconds: 10 }])]),
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" } },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    // liveEventCells omits "npc": it is erased / on an inactive page.
    const s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: {},
    }));
    expect(s.error?.kind).toBe("content");
    expect(s.error?.message).toContain("npc");
    expect(s.anims ?? []).toHaveLength(0);
  });

  test("follow:false on a target with no live character also creates no instance", () => {
    const w = createWorld(map([
      event("npc", 5, 6, [page("parallel", [{ op: "wait", seconds: 10 }])]),
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" }, follow: false },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    const s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: {},
    }));
    expect(s.error?.kind).toBe("content");
    expect(s.anims ?? []).toHaveLength(0);
  });

  test("a following instance whose target leaves the map mid-playback pins to its last live cell", () => {
    // follow:true binds to the live character; when the character leaves the
    // map (erased / page off) the instance keeps playing at the cell it
    // last knew — the live snapshot, never the authored x/y.
    const w = createWorld(map([
      event("npc", 5, 6, [page("parallel", [{ op: "wait", seconds: 10 }])]),
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" }, loop: true },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    // The NPC is live, but displaced from its authored (5,6) to (7,1).
    let s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: { npc: { x: 7, y: 1 } },
    }));
    const inst = s.anims![0]!;
    expect(inst.target).toEqual({ event: "npc" });
    expect([inst.x, inst.y]).toEqual([7, 1]); // the live cell, not authored (5,6)
    // The NPC leaves the map: the instance survives, still pinned to (7,1).
    s = stepInterp(w, s, input(0, { liveEventCells: {} }));
    const after = s.anims![0]!;
    expect(after.target).toEqual({ event: "npc" });
    expect([after.x, after.y]).toEqual([7, 1]);
  });

  test("a following instance tracks a target that moves after binding, then pins to the last live cell", () => {
    // The anchor must follow the live character, not freeze at the creation
    // cell. Bind at (5,6); the NPC then walks to (7,1) and only afterwards
    // leaves the map. The instance must end at (7,1) — the cell it last
    // knew — never the (5,6) it was created on.
    const w = createWorld(map([
      event("npc", 5, 6, [page("parallel", [{ op: "wait", seconds: 10 }])]),
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" }, loop: true },
      ])]),
    ]), [], 60, { animations: [PULSE] });
    // Bind while the NPC is live at its authored (5,6).
    let s = stepInterp(w, createInterpState(), input(0, {
      confirmEdge: true,
      liveEventCells: { npc: { x: 5, y: 6 } },
    }));
    expect([s.anims![0]!.x, s.anims![0]!.y]).toEqual([5, 6]);
    // The NPC walks to (7,1): the anchor refreshes to the new live cell.
    s = stepInterp(w, s, input(0, { liveEventCells: { npc: { x: 7, y: 1 } } }));
    expect([s.anims![0]!.x, s.anims![0]!.y]).toEqual([7, 1]);
    // The NPC leaves the map: the instance survives, pinned to (7,1),
    // not the (5,6) creation cell.
    s = stepInterp(w, s, input(0, { liveEventCells: {} }));
    const after = s.anims![0]!;
    expect(after.target).toEqual({ event: "npc" });
    expect([after.x, after.y]).toEqual([7, 1]);
  });

  test("an immutable idle-scan hit still refreshes a following target anchor", () => {
    const extensions = createExtensionRuntime({
      immutableConditions: true,
      deterministicConditions: true,
    });
    const w = createWorld(map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" }, loop: true },
      ])]),
    ]), [], 60, { animations: [PULSE], extensions });
    const s = createInterpState();
    s.anims = [{
      id: "fx",
      anim: "pulse",
      start: 0,
      x: 5,
      y: 6,
      target: { event: "npc" },
      layer: "above",
      loop: true,
    }];
    const eventCells = Object.create(null) as Record<string, { x: number; y: number }>;
    stepInterpWithExtensionsInPlace(w, s, input(0, {
      eventCells,
      liveEventCells: { npc: { x: 5, y: 6 } },
    }), null, undefined, true);
    const retained = s.anims![0]!;

    stepInterpWithExtensionsInPlace(w, s, input(0, {
      eventCells,
      liveEventCells: { npc: { x: 7, y: 1 } },
    }), null, undefined, true);
    expect([s.anims![0]!.x, s.anims![0]!.y]).toEqual([7, 1]);
    expect([retained.x, retained.y]).toEqual([5, 6]);
  });
});

describe("mapAnim target liveness (session)", () => {
  test("an erased event target plays nothing through the real session path", () => {
    // The session builds liveEventCells from the live character set, so an
    // event that erased itself before the mapAnim runs has no entry: the
    // command content-errors and creates no instance (Tuxemon get_npc
    // parity), and the fiber stops before the trailing switch.
    const p = project([map([
      event("npc", 5, 6, [page("parallel", [
        { op: "wait", seconds: 0.1 },
        { op: "erase" },
      ])]),
      event("burst", 2, 3, [page("autorun", [
        { op: "wait", seconds: 0.3 },
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" } },
        { op: "switch", id: "played", value: true },
      ])]),
    ])]);
    const session = createSession(p);
    let state = startSession(p, session);
    // 0.5 s at 60 Hz: the NPC erased at 0.1 s, the burst fired at 0.3 s.
    for (let i = 0; i < 30; i++) state = stepSession(session, state, { buttons: 0, confirmEdge: false });
    expect(state.interp.anims ?? []).toHaveLength(0);
    expect(state.interp.error?.kind).toBe("content");
    expect(state.interp.error?.message).toContain("npc");
    expect(state.interp.sw.switches["played"]).toBeUndefined();
  });

  test("a world without the target capability builds no liveEventCells, so an event target cannot resolve", () => {
    // needsMapAnimTarget gates the session's per-tick liveEventCells build.
    // A fixed-coordinate project compiles the flag false; clearing it here
    // simulates that gate on an event-target world. With no live-event
    // record the command content-errors — proving the session skipped the
    // build (and its per-event scan) rather than silently resolving.
    const p = project([map([
      event("npc", 5, 6, [page("parallel", [{ op: "wait", seconds: 10 }])]),
      event("burst", 2, 3, [page("autorun", [
        { op: "wait", seconds: 0.2 },
        { op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" } },
      ])]),
    ])]);
    const session = createSession(p);
    let state = startSession(p, session);
    session.worlds.get(state.mapId)!.needsMapAnimTarget = false;
    for (let i = 0; i < 30; i++) state = stepSession(session, state, { buttons: 0, confirmEdge: false });
    expect(state.interp.error?.kind).toBe("content");
    expect(state.interp.error?.message).toContain("npc");
    expect(state.interp.anims ?? []).toHaveLength(0);
  });
});

describe("mapAnim target capability", () => {
  const worldWith = (anim: Command): ReturnType<typeof createWorld> =>
    createWorld(map([
      event("burst", 2, 3, [page("action", [anim])]),
    ]), [], 60, { animations: [PULSE] });

  test("a fixed-coordinate mapAnim does not require the live-event-target capability", () => {
    // Fixed x/y compiles to target:null. typeof null === "object" once
    // flagged every mapAnim as event-targeted, so the session allocated
    // liveEventCells and scanned every map event per tick for projects
    // that never used a target. Only a `{event}` target sets the flag.
    const w = worldWith({ op: "mapAnim", id: "fx", anim: "pulse", x: 2, y: 3 });
    expect(w.needsMapAnimTarget).toBe(false);
  });

  test("a player-target mapAnim does not require the live-event-target capability", () => {
    const w = worldWith({ op: "mapAnim", id: "fx", anim: "pulse", target: "player" });
    expect(w.needsMapAnimTarget).toBe(false);
  });

  test("an event-target mapAnim requires the live-event-target capability", () => {
    const w = worldWith({ op: "mapAnim", id: "fx", anim: "pulse", target: { event: "npc" } });
    expect(w.needsMapAnimTarget).toBe(true);
  });
});

describe("mapAnim timing", () => {
  test("the same virtual instant selects the same frame at 60/30/20/4 Hz", () => {
    const def: AnimationDef = { id: "pulse", sheet: "pulse.png", count: 4, frameDuration: 0.5, loop: true };
    const seen: number[][] = [];
    for (const hz of [60, 30, 20, 4] as const) {
      const w = createWorld(map([]), [], hz, { animations: [def] });
      const compiled = w.anims.get("pulse")!;
      expect(compiled.total).toBe(2 * hz); // 4 frames * 0.5s
      const inst: MapAnimInstance = {
        id: "fx", anim: "pulse", start: 0, x: 0, y: 0, target: null, layer: "above", loop: true,
      };
      seen.push([0.5, 1.0, 1.5, 2.0].map((t) => animFrameIndex(compiled, inst, Math.round(t * hz))));
    }
    expect(seen).toEqual([[1, 2, 3, 0], [1, 2, 3, 0], [1, 2, 3, 0], [1, 2, 3, 0]]);
  });

  test("a finished one-shot reports frame -1 and a looping one wraps", () => {
    const w = createWorld(map([]), [], 60, { animations: [PULSE] });
    const compiled = w.anims.get("pulse")!;
    const once: MapAnimInstance = {
      id: "fx", anim: "pulse", start: 0, x: 0, y: 0, target: null, layer: "above", loop: false,
    };
    expect(animFrameIndex(compiled, once, 0)).toBe(0);
    expect(animFrameIndex(compiled, once, 23)).toBe(3);
    expect(animFrameIndex(compiled, once, 24)).toBe(-1);
    const loop = { ...once, loop: true };
    expect(animFrameIndex(compiled, loop, 24)).toBe(0);
    expect(animFrameIndex(compiled, loop, 30)).toBe(1);
  });

  test("a frame duration shorter than one tick uses cumulative quantization", () => {
    const def: AnimationDef = { id: "pulse", sheet: "pulse.png", count: 4, frameDuration: 0.1 };
    const compiled = compileAnim(def, 4);
    expect(compiled.total).toBe(2);
    expect(compiled.steps).toEqual([0, 1, 1, 2]);
  });
});

describe("mapAnim and map transfer", () => {
  test("live animations retain their phase across a transfer and save", () => {
    const mapA: MapDef = {
      ...map([
        event("fx", 3, 3, [page("parallel", [
          { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true },
          { op: "mapAnim", id: "player-fx", anim: "pulse", target: "player", loop: true },
          { op: "mapAnim", id: "event-fx", anim: "pulse", target: "this", loop: true },
          { op: "wait", seconds: 30 },
        ])]),
        event("go", 2, 3, [page("action", [
          { op: "transfer", map: "map-b", x: 2, y: 2 },
        ])]),
      ]),
      id: "map-a",
    };
    const mapB: MapDef = {
      id: "map-b",
      name: "B",
      width: 8,
      height: 8,
      sheets: ["plain"],
      ground: new Array(64).fill("plain.0"),
      events: [],
    };
    const p = project([mapA, mapB]);
    p.system = { transferPresentation: "retain" };
    const session: Session = createSession(p);
    let state: SessionState = startSession(p, session);
    const step = (s: SessionState, confirmEdge = false): SessionState =>
      stepSession(session, s, { buttons: 0, confirmEdge });

    state = step(state);
    expect(state.interp.anims).toHaveLength(3);
    const sourceStart = state.interp.anims!.find((animation) => animation.id === "fx")!.start;
    state = step(state, true); // confirm facing the transfer event
    for (let i = 0; i < 10 && state.mapId !== "map-b"; i++) state = step(state);
    expect(state.mapId).toBe("map-b");
    expect(state.interp.anims).toHaveLength(3);
    const retained = state.interp.anims!.find((animation) => animation.id === "fx")!;
    expect(retained.id).toBe("fx");
    expect(retained.start).toBeLessThanOrEqual(0);
    expect(retained.start).toBeLessThan(sourceStart);
    expect(state.interp.anims!.find((animation) => animation.id === "player-fx")!.target).toBe("player");
    expect(state.interp.anims!.find((animation) => animation.id === "event-fx")).toMatchObject({
      target: null,
      x: 3,
      y: 3,
    });
    const compiled = session.worlds.get("map-b")!.anims.get("pulse")!;
    const landedFrame = animFrameIndex(compiled, retained, state.interp.frame);
    expect(landedFrame).toBeGreaterThanOrEqual(0);

    const encoded = encodeEnvelope(createSessionSnapshot(session, state, 0));
    const restored = restoreSessionEnvelope(session, encoded);
    expect(restored.interp.anims).toEqual(state.interp.anims);
    expect(animFrameIndex(
      compiled,
      restored.interp.anims!.find((animation) => animation.id === "fx")!,
      restored.interp.frame,
    )).toBe(landedFrame);
  });
});

describe("mapAnim and battle freeze", () => {
  const CIRCLE = 0x2000;
  // 0.25 s/frame = 15 ticks/frame at 60 Hz, so a ~17-tick toy battle would
  // advance the animation a full frame if the freeze shift were missing.
  const SLOW: AnimationDef = { id: "pulse", sheet: "pulse.png", count: 4, frameDuration: 0.25, loop: true };

  /** A parallel fiber that starts a battle once. After the battle it parks
   *  on a long wait so the fiber never finishes and the parallel trigger
   *  never restarts it (a looping parallel would re-issue the battle). */
  const fightOnce = (delaySeconds: number): Command[] => [
    { op: "wait", seconds: delaySeconds },
    { op: "battle", setup: { enemyHp: 1 } },
    { op: "wait", seconds: 30 },
  ];

  function clockProject(): Project {
    return {
      format: "rpgkit-project/v1",
      title: "Anim battle freeze",
      tileSize: 16,
      start: { map: MAP_ID, x: 2, y: 2, dir: "down" },
      sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
      items: [],
      animations: [SLOW],
      maps: [map([
        event("fx", 3, 3, [page("parallel", [
          { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true },
          ...fightOnce(0.1),
        ])]),
      ])],
    };
  }

  function animWaitProject(): Project {
    return {
      format: "rpgkit-project/v1",
      title: "Anim battle freeze",
      tileSize: 16,
      start: { map: MAP_ID, x: 2, y: 2, dir: "down" },
      sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
      items: [],
      animations: [SLOW],
      maps: [map([
        // A one-shot whose wait parks the main fiber across the battle.
        // loop:false overrides the SLOW def's loop:true so the wait ends
        // after one playthrough (a looping wait blocks until stopAnim).
        event("waited", 4, 4, [page("autorun", [
          { op: "mapAnim", id: "waited", anim: "pulse", x: 4, y: 4, loop: false, wait: true },
          { op: "switch", id: "waited-done", value: true },
        ])]),
        event("fight", 5, 5, [page("parallel", fightOnce(0.1))]),
      ])],
    };
  }

  test("a default-frozen battle pauses map animation clocks", () => {
    const p = clockProject();
    const session = createSession(p, 60, { battle: toyBattleRules });
    let state = startSession(p, session);
    const step = (buttons = 0, confirmEdge = false): SessionState =>
      (state = stepSession(session, state, { buttons, confirmEdge }));
    const compiled = session.worlds.get(state.mapId)!.anims.get("pulse")!;
    const fxFrame = (): number => {
      const inst = (state.interp.anims ?? []).find((a) => a.id === "fx")!;
      return animFrameIndex(compiled, inst, state.interp.frame);
    };
    const fxStart = (): number =>
      (state.interp.anims ?? []).find((a) => a.id === "fx")!.start;

    // Run until the battle starts (the fight fiber waits 0.1 s first).
    for (let i = 0; i < 60 && !state.scene; i++) step();
    expect(state.scene, "the battle started").not.toBeNull();
    const beforeFrame = fxFrame();
    const beforeStart = fxStart();
    expect(beforeFrame).toBe(0); // 6 ticks < 15 ticks/frame

    // Fight the toy battle to its win.
    step(CIRCLE, true);
    for (let i = 0; i < 60 && state.scene; i++) step();
    expect(state.scene, "the battle completed").toBeNull();
    expect(state.sw.switches["toy.result.win"]).toBe(true);

    // The animation clock froze: same frame index, start shifted forward by
    // the paused duration. Without the shift the hidden animation would have
    // advanced a full frame behind the battle.
    expect(fxFrame()).toBe(beforeFrame);
    expect(fxStart()).toBeGreaterThan(beforeStart);

    // After the battle the clock runs again: the animation advances and the
    // start tick is stable (no shift outside a scene).
    const afterStart = fxStart();
    for (let i = 0; i < 20; i++) step();
    expect(fxFrame()).not.toBe(beforeFrame);
    expect(fxStart()).toBe(afterStart);
  });

  test("a default-frozen battle pauses animWait", () => {
    const p = animWaitProject();
    const session = createSession(p, 60, { battle: toyBattleRules });
    let state = startSession(p, session);
    const step = (buttons = 0, confirmEdge = false): SessionState =>
      (state = stepSession(session, state, { buttons, confirmEdge }));

    // The autorun parked the main fiber in animWait before the battle.
    for (let i = 0; i < 60 && !state.scene; i++) step();
    expect(state.scene).not.toBeNull();
    expect(state.interp.main?.mode).toBe("animWait");
    expect(state.sw.switches["waited-done"]).toBeUndefined();
    const sinceAtBattle = state.interp.main!.since!;

    step(CIRCLE, true);
    for (let i = 0; i < 60 && state.scene; i++) step();
    expect(state.scene).toBeNull();
    // The animWait fiber is still parked with its since shifted forward by
    // the paused duration (the frozen ticks did not count against it).
    expect(state.interp.main?.mode).toBe("animWait");
    expect(state.interp.main!.since!).toBeGreaterThan(sinceAtBattle);
    expect(state.sw.switches["waited-done"]).toBeUndefined();

    // After the battle the wait runs its remaining course and completes.
    for (let i = 0; i < 120; i++) step();
    expect(state.sw.switches["waited-done"]).toBe(true);
  });

  test("a worldContinues battle keeps map animations running", () => {
    const p = clockProject();
    const session = createSession(p, 60, {
      battle: toyBattleRules,
      scene: { worldContinues: true },
    });
    let state = startSession(p, session);
    const step = (buttons = 0, confirmEdge = false): SessionState =>
      (state = stepSession(session, state, { buttons, confirmEdge }));
    const compiled = session.worlds.get(state.mapId)!.anims.get("pulse")!;
    const fxFrame = (): number => {
      const inst = (state.interp.anims ?? []).find((a) => a.id === "fx")!;
      return animFrameIndex(compiled, inst, state.interp.frame);
    };
    const fxStart = (): number =>
      (state.interp.anims ?? []).find((a) => a.id === "fx")!.start;

    for (let i = 0; i < 60 && !state.scene; i++) step();
    expect(state.scene).not.toBeNull();
    const beforeFrame = fxFrame();
    const beforeStart = fxStart();
    step(CIRCLE, true);
    for (let i = 0; i < 60 && state.scene; i++) step();
    expect(state.scene).toBeNull();
    // The world kept folding, so the animation advanced and its start did
    // not shift (no freeze to hide).
    expect(fxFrame()).not.toBe(beforeFrame);
    expect(fxStart()).toBe(beforeStart);
  });
});

describe("mapAnim save/load", () => {
  function animProject(): { p: Project; session: Session; state: SessionState } {
    const p = project([map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true },
      ])]),
    ])]);
    const session = createSession(p);
    let state = startSession(p, session);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(state.interp.anims).toHaveLength(1);
    return { p, session, state };
  }

  test("a live animation round-trips a save byte-identically", () => {
    const { session, state } = animProject();
    const snapshot = createSessionSnapshot(session, state, 0);
    const decoded = decodeSaveCode(encodeSaveCode(snapshot));
    expect(decoded).toEqual(snapshot);
    expect(decoded.interp.anims).toEqual(state.interp.anims);
  });

  test("an older checksum-valid save without anims loads with the field absent", () => {
    const { session, state } = animProject();
    const snapshot = createSessionSnapshot(session, state, 0);
    const envelope = JSON.parse(encodeEnvelope(snapshot)) as { state: unknown; checksum: string };
    const interp = (envelope.state as { interp: Record<string, unknown> }).interp;
    expect(Array.isArray(interp.anims)).toBe(true);
    delete interp.anims;
    envelope.checksum = fnv1aText(canonicalJson(envelope.state));
    const decoded = decodeEnvelopeText(JSON.stringify(envelope));
    expect(decoded.interp.anims).toBeUndefined();
  });

  test("a save with a malformed anim entry is refused despite a valid checksum", () => {
    const { session, state } = animProject();
    const snapshot = createSessionSnapshot(session, state, 0);
    const envelope = JSON.parse(encodeEnvelope(snapshot)) as { state: unknown; checksum: string };
    const anims = (envelope.state as { interp: { anims: unknown[] } }).interp.anims;
    (anims[0] as Record<string, unknown>).layer = "side";
    envelope.checksum = fnv1aText(canonicalJson(envelope.state));
    let error: unknown;
    try {
      decodeEnvelopeText(JSON.stringify(envelope));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe("shape");
    expect((error as SaveError).message).toMatch(/anims\[0\].layer/);
  });

  test("a save carrying a mapAnim instruction without follow is refused", () => {
    // The compiled instruction always carries follow (c.follow ?? true); a
    // save that drops it is refused at the same granularity as the other
    // mapAnim fields. A parallel fiber parks in animWait on the waited
    // instruction, and parallel fibers serialize in their running state.
    const snapshot = createSnapshot(
      MAP_ID,
      initialMovement(2, 2, 0, { tile: 16, speed: 2 }),
      createInterpState(),
      0,
    );
    snapshot.interp.parallels[`${MAP_ID}/burst`] = {
      key: `${MAP_ID}/burst`, pageIndex: 0, parallel: true,
      stack: [{ prog: [{
        op: "mapAnim", id: "fx", anim: "pulse", x: 1, y: 1, target: null,
        layer: "above", loop: null, wait: true,
        // follow omitted on purpose
      }], pc: 0 }],
      mode: "animWait", since: 0, erase: false,
    } as never;
    const envelope = JSON.parse(encodeEnvelope(snapshot)) as { state: unknown; checksum: string };
    envelope.checksum = fnv1aText(canonicalJson(envelope.state));
    let error: unknown;
    try {
      decodeEnvelopeText(JSON.stringify(envelope));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe("shape");
    expect((error as SaveError).message).toMatch(/follow/);
  });

  test("a save with duplicate instance ids is refused", () => {
    const { session, state } = animProject();
    const snapshot = createSessionSnapshot(session, state, 0);
    const envelope = JSON.parse(encodeEnvelope(snapshot)) as { state: unknown; checksum: string };
    const interp = (envelope.state as { interp: { anims: unknown[] } }).interp;
    interp.anims.push(structuredClone(interp.anims[0]));
    envelope.checksum = fnv1aText(canonicalJson(envelope.state));
    let error: unknown;
    try {
      decodeEnvelopeText(JSON.stringify(envelope));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).message).toMatch(/duplicate/);
  });

  test("a real restore mid-animation resumes playback from the same frame", () => {
    // The codec round-trip alone does not prove the restored state keeps
    // playing: restore through the real envelope path and step on, asserting
    // the frame index is continuous across the save boundary.
    const p = project([map([
      event("burst", 2, 3, [page("parallel", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true },
        { op: "wait", seconds: 30 },
      ])]),
    ])]);
    const session = createSession(p);
    let state = startSession(p, session);
    // 10 ticks in: the instance is mid-first-frame (frameDuration 0.1 s =
    // 6 ticks/frame at 60 Hz).
    for (let i = 0; i < 10; i++) state = stepSession(session, state, { buttons: 0 });
    const compiled = session.worlds.get(state.mapId)!.anims.get("pulse")!;
    const before = state.interp.anims![0]!;
    const beforeIdx = animFrameIndex(compiled, before, state.interp.frame);
    expect(beforeIdx).toBe(1); // 10 ticks / 6 = frame 1

    const envelope = encodeEnvelope(createSessionSnapshot(session, state, 0));
    const restored = restoreSessionEnvelope(session, envelope);
    const after = restored.interp.anims![0]!;
    expect(after).toEqual(before); // same instance, same start tick
    expect(animFrameIndex(compiled, after, restored.interp.frame)).toBe(beforeIdx);

    // Playback resumes: the frame index advances past the save point.
    let advanced = restored;
    for (let i = 0; i < 30; i++) advanced = stepSession(session, advanced, { buttons: 0 });
    expect(animFrameIndex(compiled, advanced.interp.anims![0]!, advanced.interp.frame)).not.toBe(beforeIdx);
  });
});

describe("mapAnim rewind", () => {
  test("rewind to mid-animation refolds byte-identical state", () => {
    const p = project([map([
      event("burst", 2, 3, [page("parallel", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true },
        { op: "wait", seconds: 30 },
      ])]),
    ])]);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 3 / 60,
    });
    controller.startPlay();
    const states = [structuredClone(controller.state)];
    for (let frame = 0; frame < 12; frame++) {
      controller.step(0);
      states.push(structuredClone(controller.state));
    }
    // Mid-animation: the instance exists with its start tick.
    expect(states[6]!.interp.anims ?? []).toHaveLength(1);
    expect(states[6]!.interp.anims![0]!.start).toBeLessThan(states[6]!.interp.frame);
    // The frame selected at each forward tick is the render-relevant value;
    // rewind must reproduce it exactly (the framebuffer is a pure function
    // of this selection plus the instance position).
    const compiled = controller.getSession().worlds.get(states[6]!.mapId)!.anims.get("pulse")!;
    const forwardFrames = states.map((st) => {
      const inst = (st.interp.anims ?? [])[0];
      return inst ? animFrameIndex(compiled, inst, st.interp.frame) : -1;
    });
    const final = structuredClone(controller.state);
    const length = controller.length;

    controller.step(0x0100); // L: transport only, no world frame folded.
    expect(controller.length).toBe(length - 3);
    expect(controller.state).toEqual(states[length - 3]);
    // The refolded state selects the same frame the forward play did.
    const rewoundInst = controller.state.interp.anims![0]!;
    expect(animFrameIndex(compiled, rewoundInst, controller.state.interp.frame)).toBe(forwardFrames[length - 3]);
    for (let frame = 0; frame < 3; frame++) controller.step(0);
    expect(controller.state).toEqual(final);
    // The resumed play lands on the same frame the forward run did.
    const resumedInst = controller.state.interp.anims![0]!;
    expect(animFrameIndex(compiled, resumedInst, controller.state.interp.frame)).toBe(forwardFrames[length]);
  });
});

describe("mapAnim schema", () => {
  function schemaProject(): Project {
    return project([map([
      event("burst", 2, 3, [page("action", [
        { op: "mapAnim", id: "fx", anim: "pulse", x: 3, y: 3, loop: true, wait: true },
        { op: "mapAnim", id: "on-player", anim: "pulse", target: "player", layer: "below" },
        { op: "mapAnim", id: "snap", anim: "pulse", target: { event: "npc" }, follow: false },
        { op: "stopAnim", id: "fx" },
        { op: "stopAnim", anim: "pulse" },
        { op: "stopAnim" },
      ])]),
    ])]);
  }

  test("accepts the animation catalog and every command spelling", () => {
    expect(validateSchema(schema, schemaProject())).toEqual([]);
  });

  const reject = (mutate: (p: Project) => void, fragment: string): void => {
    const p = structuredClone(schemaProject());
    mutate(p);
    const errors = validateSchema(schema, p);
    expect(errors.length, `expected a rejection for ${fragment}`).toBeGreaterThan(0);
    expect(errors.some((e) => e.path.includes(fragment) || e.msg.includes(fragment))).toBe(true);
  };

  test("rejects a mapAnim with neither tile nor target, and with both", () => {
    reject((p) => {
      const c = p.maps[0]!.events![0]!.pages[0]!.commands[0] as Extract<Command, { op: "mapAnim" }>;
      delete (c as { x?: number }).x;
      delete (c as { y?: number }).y;
    }, "commands[0]");
    reject((p) => {
      const c = p.maps[0]!.events![0]!.pages[0]!.commands[0] as Extract<Command, { op: "mapAnim" }>;
      (c as { target?: unknown }).target = "player";
    }, "commands[0]");
  });

  test("rejects a mapAnim mixing target with a tile coordinate", () => {
    // target + x (no y) used to pass the oneOf and silently ignore x.
    reject((p) => {
      const c = p.maps[0]!.events![0]!.pages[0]!.commands[1] as Extract<Command, { op: "mapAnim" }>;
      (c as { x?: number }).x = 3;
    }, "commands[1]");
  });

  test("rejects a stopAnim with both id and anim", () => {
    reject((p) => {
      const c = p.maps[0]!.events![0]!.pages[0]!.commands[3] as Extract<Command, { op: "stopAnim" }>;
      (c as { anim?: string }).anim = "pulse";
    }, "commands[3]");
  });

  test("rejects a bad layer, a bad target, and a non-string instance id", () => {
    reject((p) => {
      const c = p.maps[0]!.events![0]!.pages[0]!.commands[1] as Extract<Command, { op: "mapAnim" }>;
      (c as { layer?: unknown }).layer = "side";
    }, "commands[1]");
    reject((p) => {
      const c = p.maps[0]!.events![0]!.pages[0]!.commands[1] as Extract<Command, { op: "mapAnim" }>;
      (c as { target?: unknown }).target = "ship";
    }, "commands[1]");
    reject((p) => {
      const c = p.maps[0]!.events![0]!.pages[0]!.commands[0] as Extract<Command, { op: "mapAnim" }>;
      (c as { id?: unknown }).id = 42;
    }, "commands[0]");
  });

  test("rejects an animation def without frames/count, with both, or with a zero duration", () => {
    reject((p) => {
      delete (p.animations![0] as { count?: number }).count;
    }, "oneOf");
    reject((p) => {
      p.animations!.push({ ...p.animations![0]!, id: "pulse2", frames: [0, 1] });
    }, "oneOf");
    reject((p) => {
      p.animations![0]!.frameDuration = 0;
    }, "frameDuration");
  });

  test("guards the wait seconds upper bound (30) and accepts the boundary", () => {
    // The KA1 fixture used wait:100, which the schema caps at 30; the
    // build/sim path consumed the TS object directly and bypassed the gate.
    const waitProject = (seconds: number): Project => project([map([
      event("w", 2, 3, [page("parallel", [{ op: "wait", seconds }])]),
    ])]);
    expect(validateSchema(schema, waitProject(30))).toEqual([]);
    // 31 exceeds the schema's maximum:30, so the wait branch of the command
    // oneOf no longer matches and the command is rejected.
    expect(validateSchema(schema, waitProject(31)).length).toBeGreaterThan(0);
  });

  test("the KA1 render fixture validates against the schema", () => {
    // B6 regression: the fixture's wait:100 made KA1_PROJECT unloadable
    // through the normal schema-gated project entry.
    expect(validateSchema(schema, KA1_PROJECT)).toEqual([]);
  });
});
