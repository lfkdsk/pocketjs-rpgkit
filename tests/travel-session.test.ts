// Followers and vehicles through the complete Session reducer.  The pure
// travel helpers have their own contract suite; these cases exercise the
// interpreter, live page selection, collision tables, transfers and saves as
// one timeline at every supported host rate.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import { createSessionSnapshot, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { AIRSHIP_TRANSITION_TICKS, travelRuntime } from "../src/travel.ts";
import type {
  Command,
  Dir,
  GameEvent,
  MapDef,
  Page,
  Project,
  VehicleDef,
} from "../src/engine/types.ts";

const SHEET = { id: "terrain", cols: 1, rows: 1, defaultPassage: "pass" as const };
const TILE = "terrain.0" as const;

function page(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, commands, sprite: null, ...extra };
}

function event(id: string, x: number, y: number, pages: Page[]): GameEvent {
  return { id, x, y, pages };
}

function map(
  id: string,
  extra: Partial<MapDef> = {},
): MapDef {
  return {
    id,
    name: id,
    width: 8,
    height: 6,
    sheets: [SHEET.id],
    ground: new Array(48).fill(TILE),
    events: [],
    ...extra,
  };
}

function vehicle(
  id: string,
  kind: VehicleDef["kind"],
  x: number,
  y: number,
  mapId = "harbor",
  extra: Partial<VehicleDef> = {},
): VehicleDef {
  return { id, kind, sprite: `${id}-sprite`, start: { map: mapId, x, y, dir: "down" }, ...extra };
}

function project(
  maps: MapDef[],
  extra: Partial<Project> = {},
  start: { map: string; x: number; y: number; dir: Dir } = {
    map: maps[0]!.id,
    x: 1,
    y: 1,
    dir: "right",
  },
): Project {
  return {
    format: "rpgkit-project/v1",
    title: "travel session fixture",
    tileSize: 16,
    start,
    sheets: [SHEET],
    items: [],
    maps,
    ...extra,
  };
}

function idle(session: Session, state: SessionState, frames = 1): SessionState {
  let out = state;
  for (let i = 0; i < frames; i++) out = stepSession(session, out, { buttons: 0 });
  return out;
}

function settle(session: Session, state: SessionState, ceiling = 200): SessionState {
  let out = state;
  for (let i = 0; i < ceiling && out.move.moving; i++) out = stepSession(session, out, { buttons: 0 });
  if (out.move.moving) throw new Error("player did not settle");
  return out;
}

function stepCell(session: Session, state: SessionState, buttons: number): SessionState {
  return settle(session, stepSession(session, state, { buttons }));
}

function confirm(session: Session, state: SessionState): SessionState {
  return stepSession(session, state, { buttons: 0, confirmEdge: true });
}

function vehicleState(state: SessionState, id: string) {
  return state.travel?.vehicles?.entries.find((entry) => entry.id === id);
}

function travelDigest(state: SessionState) {
  return {
    map: state.mapId,
    player: {
      tx: state.move.tx,
      ty: state.move.ty,
      facing: state.move.facing,
      moving: state.move.moving,
    },
    followers: state.travel?.followers?.members.map((member) => ({
      id: member.id,
      tx: member.move.tx,
      ty: member.move.ty,
      facing: member.move.facing,
      moving: member.move.moving,
      trail: member.trail,
    })),
    vehicles: state.travel?.vehicles,
    switches: state.sw.switches,
  };
}

function createTravelSession(source: Project, hz = 60): Session {
  return createSession(source, hz, { travel: travelRuntime });
}

describe("session travel opt-in", () => {
  test("a project without travel fields retains the legacy reducer shape", () => {
    const p = project([map("plain")]);
    const session = createSession(p);
    const start = startSession(p, session);
    expect(start.travel).toBeUndefined();
    expect("travel" in start).toBe(false);
    expect(session.travelRuntime).toBeNull();
    expect("travel" in idle(session, start)).toBe(false);
  });

  test("a declared follower or vehicle fails fast until travel is registered", () => {
    const p = project([map("field")], {
      followers: { enabled: true, members: [{ id: "friend", sprite: "friend" }] },
    });
    expect(() => createSession(p)).toThrow(
      "project followers/vehicles require the optional travel runtime",
    );
  });

  test("followers replay corners, can hide, and a waited gather resumes only after convergence", () => {
    const controls = event("controls", 2, 3, [page("action", [
      { op: "followers", visible: true },
      { op: "gatherFollowers" },
      { op: "switch", id: "gathered", value: true },
    ])]);
    const hide = event("hide", 0, 0, [
      page("autorun", [
        { op: "followers", visible: false },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const p = project([map("field", { events: [hide, controls] })], {
      followers: {
        enabled: true,
        members: [
          { id: "second", sprite: "hero-2" },
          { id: "third", sprite: "hero-3" },
        ],
      },
    });
    const session = createTravelSession(p, 60);
    let state = idle(session, startSession(p, session), 8);
    expect(state.travel?.followers?.visible).toBe(false);

    state = stepCell(session, state, BTN.RIGHT);
    state = stepCell(session, state, BTN.DOWN);
    state = idle(session, state, 40);
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([2, 2, 0]);
    expect(state.travel?.followers?.members.map((member) => [member.move.tx, member.move.ty])).toEqual([
      [2, 1],
      [1, 1],
    ]);

    state = confirm(session, state);
    expect(state.travel?.followers).toMatchObject({ visible: true, gathering: true });
    expect(state.sw.switches.gathered).toBeUndefined();
    for (let i = 0; i < 100 && state.sw.switches.gathered !== true; i++) state = idle(session, state);
    expect(state.sw.switches.gathered).toBe(true);
    expect(state.travel?.followers).toMatchObject({ gathering: false, gatherWaiters: [] });
    expect(state.travel?.followers?.members.map((member) => [member.move.tx, member.move.ty])).toEqual([
      [2, 2],
      [2, 2],
    ]);
  });

  test("a spaced follower chain starts and lands in the leader's step phase", () => {
    const p = project([map("field")], {
      followers: {
        enabled: true,
        members: [
          { id: "second", sprite: "hero-2" },
          { id: "third", sprite: "hero-3" },
        ],
      },
    });
    const session = createTravelSession(p, 60);
    let state = startSession(p, session);
    state = stepCell(session, state, BTN.RIGHT);
    state = stepCell(session, state, BTN.RIGHT);
    state = idle(session, state);
    expect(state.travel?.followers?.members.map((member) => [member.move.tx, member.move.ty])).toEqual([
      [2, 1],
      [1, 1],
    ]);

    state = stepSession(session, state, { buttons: BTN.DOWN });
    expect(state.move).toMatchObject({ moving: true, phase: 1 });
    expect(state.travel?.followers?.members.map((member) => [member.move.moving, member.move.phase])).toEqual([
      [true, 1],
      [true, 1],
    ]);
    while (state.move.moving) state = idle(session, state);
    expect(state.travel?.followers?.members.map((member) => [member.move.tx, member.move.ty, member.move.moving])).toEqual([
      [3, 1, false],
      [2, 1, false],
    ]);
  });
});

describe("session boat and ship traversal", () => {
  test("vehicle music starts after boarding, survives command 140, and restores walking BGM", () => {
    const music = event("music", 0, 0, [
      page("autorun", [
        { op: "playBgm", id: "field", volume: 72, pitch: 95 },
        { op: "saveBgm" },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const changer = event("changer", 0, 0, [
      page("parallel", []),
      page("parallel", [
        { op: "setVehicleBgm", id: "boat", bgm: { id: "boat-next", volume: 55, pitch: 110 } },
        { op: "selfSwitch", key: "A", value: true },
      ], { condition: { all: [{ kind: "vehicle", id: "boat" }] } }),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const water = [1 * 8 + 2];
    const harbor = map("harbor", {
      passage: water.map((index) => [index, "block"]),
      vehiclePassage: { boat: water },
      events: [music, changer],
    });
    const p = project([harbor], {
      vehicles: [vehicle("boat", "boat", 2, 1, "harbor", {
        bgm: { id: "boat-first", volume: 80, pitch: 105 },
      })],
    });
    const session = createTravelSession(p, 60);
    let state = idle(session, startSession(p, session), 4);
    expect(state.interp.audio?.bgm).toMatchObject({ id: "field", volume: 72, pitch: 95 });
    expect(state.interp.audio?.savedBgm?.id).toBe("field");

    state = confirm(session, state);
    expect(state.travel?.vehicles?.boarding).toBe("boat");
    expect(state.interp.audio?.bgm?.id).toBe("field");
    state = settle(session, state);
    expect(state.travel?.vehicles?.riding).toBe("boat");
    expect(state.interp.audio?.bgm).toMatchObject({ id: "boat-first", volume: 80, pitch: 105 });
    expect(state.interp.audio?.savedBgm?.id).toBe("field");
    const captured = state.interp.audio?.walkingBgm;
    expect(captured).toMatchObject({ id: "field", volume: 72, pitch: 95 });

    // The parallel mirrors RPG Maker command 140: it changes only the next
    // boarding track and leaves this ride uninterrupted.
    state = idle(session, state, 3);
    expect(vehicleState(state, "boat")?.bgm).toEqual({ id: "boat-next", volume: 55, pitch: 110 });
    expect(state.interp.audio?.bgm?.id).toBe("boat-first");

    state = restoreSessionEnvelope(
      session,
      encodeEnvelope(createSessionSnapshot(session, state, 0), session.content),
    );
    expect(state.interp.audio?.walkingBgm).toEqual(captured);
    expect(vehicleState(state, "boat")?.bgm?.id).toBe("boat-next");

    state = confirm(session, state);
    expect(state.travel?.vehicles?.riding).toBeNull();
    expect(state.interp.audio?.bgm).toMatchObject({ id: "field", volume: 72, pitch: 95 });
    expect(state.interp.audio!.bgm!.positionTicks).toBe((captured?.positionTicks ?? -1) + 1);
    expect(state.interp.audio?.walkingBgm).toBeUndefined();
    expect(state.interp.audio?.savedBgm?.id).toBe("field");

    state = settle(session, state);
    state = stepCell(session, state, BTN.LEFT);
    state = settle(session, confirm(session, state));
    expect(state.travel?.vehicles?.riding).toBe("boat");
    expect(state.interp.audio?.bgm).toMatchObject({ id: "boat-next", volume: 55, pitch: 110 });
  });

  test("legacy, silent-ride and silent-walking vehicle BGM states stay distinct", () => {
    const water = [1 * 8 + 2];
    const harbor = map("harbor", {
      passage: water.map((index) => [index, "block"]),
      vehiclePassage: { boat: water },
    });
    const run = (definition: VehicleDef, walking = true): SessionState => {
      const p = project([harbor], { vehicles: [definition] });
      const session = createTravelSession(p);
      let state = startSession(p, session);
      if (walking) {
        state.interp.audio = { bgm: { id: "field", volume: 100, pitch: 100, positionTicks: 7 } };
      }
      return settle(session, confirm(session, state));
    };

    const legacy = run(vehicle("boat", "boat", 2, 1));
    expect(legacy.interp.audio?.bgm?.id).toBe("field");
    expect(Object.prototype.hasOwnProperty.call(legacy.interp.audio ?? {}, "walkingBgm")).toBe(false);

    const silentRide = run(vehicle("boat", "boat", 2, 1, "harbor", { bgm: null }));
    expect(silentRide.interp.audio?.bgm).toBeUndefined();
    expect(silentRide.interp.audio?.walkingBgm).toMatchObject({ id: "field" });
    expect(silentRide.interp.audio?.walkingBgm && silentRide.interp.audio.walkingBgm.positionTicks).toBeGreaterThan(7);

    const silentWalking = run(vehicle("boat", "boat", 2, 1, "harbor", { bgm: { id: "boat" } }), false);
    expect(silentWalking.interp.audio?.bgm).toMatchObject({ id: "boat", volume: 100, pitch: 100 });
    expect(silentWalking.interp.audio?.walkingBgm).toBeNull();
  });

  test("parked boats and ships block movement while a parked airship remains enterable", () => {
    const run = (kind: VehicleDef["kind"]): SessionState => {
      const p = project([map("harbor")], { vehicles: [vehicle(kind, kind, 2, 1)] });
      const session = createTravelSession(p);
      return stepCell(session, startSession(p, session), BTN.RIGHT);
    };
    expect(run("boat").move.tx).toBe(1);
    expect(run("ship").move.tx).toBe(1);
    expect(run("airship").move.tx).toBe(2);

    const water = [1 * 8 + 2, 1 * 8 + 3];
    const harbor = map("harbor", {
      passage: water.map((index) => [index, "block"]),
      vehiclePassage: { boat: water, ship: water },
    });
    const p = project([harbor], {
      vehicles: [vehicle("boat", "boat", 2, 1), vehicle("ship", "ship", 3, 1)],
    });
    const session = createTravelSession(p);
    let state = settle(session, confirm(session, startSession(p, session)));
    state = stepCell(session, state, BTN.RIGHT);
    expect(state.travel?.vehicles?.riding).toBe("boat");
    expect(state.move.tx).toBe(2);
  });

  test("the event command toggles a reachable vehicle without parking its fiber", () => {
    const captain = event("captain", 0, 0, [
      page("autorun", [
        { op: "vehicle", action: "toggle" },
        { op: "switch", id: "toggle-returned", value: true },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const water = 1 * 8 + 2;
    const harbor = map("harbor", {
      passage: [[water, "block"]],
      vehiclePassage: { boat: [water] },
      events: [captain],
    });
    const p = project([harbor], { vehicles: [vehicle("boat", "boat", 2, 1)] });
    const session = createTravelSession(p);
    let state = idle(session, startSession(p, session), 4);
    state = settle(session, state);
    expect(state.sw.switches["toggle-returned"]).toBe(true);
    expect(state.travel?.vehicles?.riding).toBe("boat");
    expect([state.move.tx, state.move.ty]).toEqual([2, 1]);
  });

  test("the action key boards a boat, special passage constrains it, and disembark leaves it on water", () => {
    const water = [1 * 8 + 2, 1 * 8 + 3, 1 * 8 + 4];
    const watcher = event("watcher", 0, 0, [
      page("parallel", []),
      page("parallel", [{ op: "switch", id: "boat-page", value: true }], {
        condition: { all: [{ kind: "vehicle", id: "boat" }] },
      }),
    ]);
    const harbor = map("harbor", {
      passage: water.map((index) => [index, "block"]),
      vehiclePassage: { boat: water, ship: [] },
      events: [watcher],
    });
    const p = project([harbor], { vehicles: [vehicle("boat", "boat", 2, 1)] });
    const session = createTravelSession(p, 60);
    let state = startSession(p, session);

    state = settle(session, confirm(session, state));
    expect(state.travel?.vehicles?.riding).toBe("boat");
    expect([state.move.tx, state.move.ty]).toEqual([2, 1]);
    state = idle(session, state, 2);
    expect(state.sw.switches["boat-page"]).toBe(true);

    // No boat flag above: the attempted turn changes facing but not cell.
    state = stepCell(session, state, BTN.UP);
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([2, 1, 2]);
    state = stepCell(session, state, BTN.RIGHT);
    state = stepCell(session, state, BTN.RIGHT);
    expect([state.move.tx, state.move.ty]).toEqual([4, 1]);

    state = settle(session, confirm(session, state));
    expect(state.travel?.vehicles?.riding).toBeNull();
    expect([state.move.tx, state.move.ty]).toEqual([5, 1]);
    expect(vehicleState(state, "boat")).toMatchObject({ mapId: "harbor", move: { tx: 4, ty: 1 } });
  });

  test("ship-only water refuses a boat and accepts a ship", () => {
    const shipCell = 1 * 8 + 3;
    const harbor = map("harbor", {
      passage: [[shipCell, "block"]],
      vehiclePassage: { boat: [1 * 8 + 2], ship: [1 * 8 + 2, shipCell] },
    });
    const run = (kind: "boat" | "ship") => {
      const p = project([harbor], { vehicles: [vehicle(kind, kind, 2, 1)] });
      const session = createTravelSession(p);
      let state = settle(session, confirm(session, startSession(p, session)));
      state = stepCell(session, state, BTN.RIGHT);
      return state;
    };
    expect(run("boat").move.tx).toBe(2);
    expect(run("ship").move.tx).toBe(3);
  });
});

describe("session airship lifecycle", () => {
  test("restores walking BGM as soon as an airship descent is accepted", () => {
    const p = project([map("harbor")], {
      vehicles: [vehicle("airship", "airship", 1, 1, "harbor", { bgm: { id: "airship" } })],
    });
    const session = createTravelSession(p);
    let state = startSession(p, session);
    state.interp.audio = { bgm: { id: "field", volume: 70, pitch: 90, positionTicks: 12 } };
    state = confirm(session, state);
    expect(state.interp.audio?.bgm?.id).toBe("airship");
    const walking = state.interp.audio?.walkingBgm;
    expect(walking).toMatchObject({ id: "field" });
    state = idle(session, state, AIRSHIP_TRANSITION_TICKS);
    expect(state.travel?.vehicles?.airshipPhase).toBe("cruising");
    state = confirm(session, state);
    expect(state.travel?.vehicles).toMatchObject({ riding: "airship", airshipPhase: "descending" });
    expect(state.interp.audio?.bgm).toMatchObject({ id: "field", volume: 70, pitch: 90 });
    expect(state.interp.audio!.bgm!.positionTicks).toBe((walking?.positionTicks ?? -1) + 1);
    expect(state.interp.audio?.walkingBgm).toBeUndefined();
  });

  test("keeps an airship grounded and followers visible until gathering completes", () => {
    const p = project([map("harbor")], {
      followers: {
        enabled: true,
        members: [
          { id: "second", sprite: "hero-2" },
          { id: "third", sprite: "hero-3" },
        ],
      },
      vehicles: [vehicle("airship", "airship", 3, 1)],
    });
    const session = createTravelSession(p, 60);
    let state = startSession(p, session);
    state = stepCell(session, state, BTN.RIGHT);
    state = stepCell(session, state, BTN.RIGHT);
    state = confirm(session, state);
    expect(state.travel?.vehicles).toMatchObject({
      boarding: "airship",
      riding: null,
      airshipPhase: "grounded",
      airshipPhaseTick: 0,
      airshipAltitude: 0,
    });
    expect(state.travel?.followers).toMatchObject({ visible: true, gathering: true });

    for (let tick = 0; tick < 200 && state.travel?.followers?.gathering; tick++) {
      state = idle(session, state);
      expect(state.travel?.vehicles?.airshipAltitude).toBe(0);
    }
    expect(state.travel?.followers?.gathering).toBe(false);
    expect(state.travel?.vehicles).toMatchObject({
      boarding: null,
      riding: "airship",
      airshipPhase: "ascending",
      airshipPhaseTick: 0,
    });
    state = idle(session, state);
    expect(state.travel?.vehicles).toMatchObject({ airshipPhaseTick: 1 });
  });

  test("ascent gates movement, cruising crosses terrain and bodies, and landing takes 48 ticks", () => {
    const body = event("body", 2, 1, [page("action", [], { sprite: "npc", blocks: true })]);
    const harbor = map("harbor", {
      passage: [[1 * 8 + 2, "block"], [1 * 8 + 3, "block"]],
      vehiclePassage: { airshipLand: [1 * 8 + 3] },
      events: [body],
    });
    const p = project([harbor], { vehicles: [vehicle("airship", "airship", 1, 1)] });
    const session = createTravelSession(p, 60);
    let state = confirm(session, startSession(p, session));
    expect(state.travel?.vehicles).toMatchObject({
      riding: "airship",
      airshipPhase: "ascending",
      airshipPhaseTick: 0,
    });

    state = stepSession(session, state, { buttons: BTN.RIGHT });
    expect([state.move.tx, state.move.ty, state.move.moving]).toEqual([1, 1, false]);
    state = idle(session, state, AIRSHIP_TRANSITION_TICKS - 2);
    expect(state.travel?.vehicles).toMatchObject({ airshipPhase: "ascending", airshipPhaseTick: 47 });
    state = idle(session, state);
    expect(state.travel?.vehicles).toMatchObject({
      airshipPhase: "cruising",
      airshipPhaseTick: AIRSHIP_TRANSITION_TICKS,
      airshipAltitude: 16,
    });

    // `through` ignores both the blocked terrain and the blocking event.
    state = stepCell(session, state, BTN.RIGHT);
    expect(state.move.tx).toBe(2);
    state = stepCell(session, state, BTN.RIGHT);
    expect(state.move.tx).toBe(3);

    state = confirm(session, state);
    expect(state.travel?.vehicles).toMatchObject({ riding: "airship", airshipPhase: "descending" });
    state = idle(session, state, AIRSHIP_TRANSITION_TICKS - 1);
    expect(state.travel?.vehicles).toMatchObject({
      riding: "airship",
      airshipPhase: "descending",
      airshipPhaseTick: 1,
    });
    state = idle(session, state);
    expect(state.travel?.vehicles).toMatchObject({
      riding: null,
      airshipPhase: "grounded",
      airshipPhaseTick: 0,
      airshipAltitude: 0,
    });
    expect(vehicleState(state, "airship")).toMatchObject({ move: { tx: 3, ty: 1 } });
  });

  test("a refused airship landing leaves the action available to the faced event", () => {
    const sign = event("sign", 2, 1, [page("action", [{ op: "switch", id: "sign-used", value: true }])]);
    const harbor = map("harbor", { vehiclePassage: { airshipLand: [] }, events: [sign] });
    const p = project([harbor], { vehicles: [vehicle("airship", "airship", 1, 1)] });
    const session = createTravelSession(p);
    let state = confirm(session, startSession(p, session));
    state = idle(session, state, AIRSHIP_TRANSITION_TICKS);
    state = confirm(session, state);
    expect(state.travel?.vehicles).toMatchObject({ riding: "airship", airshipPhase: "cruising" });
    expect(state.sw.switches["sign-used"]).toBe(true);
  });
});

describe("session travel persistence and clocks", () => {
  test("ordinary transfer brings followers and the ridden vehicle while parked vehicles retain their maps", () => {
    const portal = event("portal", 0, 0, [
      page("parallel", []),
      page("parallel", [{ op: "transfer", map: "island", x: 3, y: 2, dir: "down", fade: 0 }], {
        condition: { all: [{ kind: "vehicle", id: "boat" }] },
      }),
    ]);
    const harbor = map("harbor", {
      passage: [[1 * 8 + 2, "block"]],
      vehiclePassage: { boat: [1 * 8 + 2] },
      events: [portal],
    });
    const island = map("island");
    const p = project([harbor, island], {
      followers: { enabled: true, members: [{ id: "friend", sprite: "friend" }] },
      vehicles: [
        vehicle("boat", "boat", 2, 1),
        vehicle("airship", "airship", 6, 4),
      ],
    });
    const session = createTravelSession(p);
    let state = settle(session, confirm(session, startSession(p, session)));
    for (let i = 0; i < 10 && state.mapId !== "island"; i++) state = idle(session, state);
    expect(state.mapId).toBe("island");
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([3, 2, 0]);
    expect(state.travel?.followers?.members[0]).toMatchObject({ move: { tx: 3, ty: 2 }, trail: [] });
    expect(vehicleState(state, "boat")).toMatchObject({ mapId: "island", move: { tx: 3, ty: 2 } });
    expect(vehicleState(state, "airship")).toMatchObject({ mapId: "harbor", move: { tx: 6, ty: 4 } });
  });

  test("vehicle location/image commands resolve variables and persist in a save envelope", () => {
    const director = event("director", 0, 0, [
      page("autorun", [
        { op: "variable", id: "target-x", set: { op: "set", value: 4 } },
        { op: "variable", id: "target-y", set: { op: "set", value: 3 } },
        {
          op: "setVehicleLocation",
          id: "boat",
          map: { variable: "target-map" },
          x: { variable: "target-x" },
          y: { variable: "target-y" },
        },
        { op: "setVehicleImage", id: "boat", sprite: "boat-upgraded" },
        { op: "selfSwitch", key: "A", value: true },
      ]),
      page("parallel", [], { condition: { selfSwitch: "A" } }),
    ]);
    const harbor = map("harbor", { events: [director] });
    const island = map("island");
    const p = project([harbor, island], { vehicles: [vehicle("boat", "boat", 2, 1)] });
    const session = createTravelSession(p);
    const state = idle(session, startSession(p, session, createSwitchState({
      variables: { "target-map": "island" },
    })), 10);
    expect(state.sw.variables).toMatchObject({ "target-map": "island", "target-x": 4, "target-y": 3 });
    expect(vehicleState(state, "boat")).toMatchObject({
      sprite: "boat-upgraded",
      mapId: "island",
      move: { tx: 4, ty: 3 },
    });

    const restored = restoreSessionEnvelope(
      session,
      encodeEnvelope(createSessionSnapshot(session, state, 0), session.content),
    );
    expect(restored.travel).toEqual(state.travel);
    expect(restored.travel).not.toBe(state.travel);
  });

  test("the same follower/boat journey settles identically at 60, 30 and 20 Hz", () => {
    const water = [1 * 8 + 2, 1 * 8 + 3];
    const harbor = map("harbor", {
      passage: water.map((index) => [index, "block"]),
      vehiclePassage: { boat: water },
    });
    const p = project([harbor], {
      followers: { enabled: true, members: [{ id: "friend", sprite: "friend" }] },
      vehicles: [vehicle("boat", "boat", 2, 1)],
    });
    const outcomes = ([60, 30, 20] as const).map((hz) => {
      const session = createTravelSession(p, hz);
      let state = settle(session, confirm(session, startSession(p, session)));
      state = stepCell(session, state, BTN.RIGHT);
      state = settle(session, confirm(session, state));
      state = idle(session, state, Math.ceil(hz / 2));
      return travelDigest(state);
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
  });

  test("attract rewind restores follower and vehicle positions from reducer history", () => {
    const water = [1 * 8 + 2, 1 * 8 + 3];
    const harbor = map("harbor", {
      passage: water.map((index) => [index, "block"]),
      vehiclePassage: { boat: water },
    });
    const p = project([harbor], {
      followers: { enabled: true, members: [{ id: "friend", sprite: "friend" }] },
      vehicles: [vehicle("boat", "boat", 2, 1)],
    });
    const controller = new AttractController(p, [], {
      hz: 60,
      travel: travelRuntime,
      attractEnabled: false,
      idleFrames: 60_000,
      rewindSeconds: 1,
    });
    const inputs = [BTN.CIRCLE, 0, 0, 0, 0, 0, 0, 0, BTN.RIGHT];
    for (const buttons of inputs) controller.step(buttons);
    for (let i = 0; i < 40; i++) controller.step(0);
    expect(controller.state.travel?.vehicles?.riding).toBe("boat");
    expect(controller.state.move.tx).toBe(3);

    controller.step(BTN.LTRIGGER);
    expect(controller.rewound).toBe(true);
    expect(controller.state.travel?.vehicles?.riding).toBeNull();
    expect(controller.state.move.tx).toBe(1);
    expect(controller.state.travel?.followers?.members[0]?.move.tx).toBe(1);
  });
});
