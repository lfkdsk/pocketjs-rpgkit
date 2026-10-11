import { describe, expect, test } from "bun:test";
import { initialMovement, type MovementConfig, type MovementState } from "../src/engine/movement.ts";
import { buildPassage, stampBlockedCells } from "../src/engine/passability.ts";
import {
  AIRSHIP_TRANSITION_TICKS,
  boardVehicle,
  boardableVehicle,
  buildVehiclePassage,
  canVehicleStep,
  cloneTravelState,
  completeVehicleBoarding,
  createTravelState,
  drainCompletedGatherWaiters,
  gatherFollowers,
  leaveVehicle,
  rebaseTravelAfterSeamless,
  reconcileFollowers,
  relocateVehicle,
  requestAirshipLanding,
  ridingVehicle,
  setFollowersVisible,
  setVehicleBgm,
  setVehicleImage,
  stepAirshipAltitude,
  stepFollowers,
  syncRiddenVehicle,
  syncTravelAfterTransfer,
  vehicleDisembarkTarget,
  type TravelState,
} from "../src/engine/travel.ts";
import type { FollowersDef, MapDef, Project, Sheet, VehicleDef } from "../src/engine/types.ts";

const CFG: MovementConfig = { tile: 16, speed: 8 };

const FOLLOWERS: FollowersDef = {
  enabled: true,
  members: [
    { id: "always", sprite: "hero-a" },
    { id: "joined", sprite: "hero-b", activeSwitch: "party-b" },
    { id: "inverted", sprite: "hero-c", activeSwitch: "party-out-c", activeValue: false },
  ],
};

const VEHICLES: VehicleDef[] = [
  { id: "boat", kind: "boat", sprite: "boat-a", start: { map: "sea", x: 3, y: 2, dir: "left" } },
  { id: "ship", kind: "ship", sprite: "ship-a", start: { map: "sea", x: 3, y: 2, dir: "right" } },
  { id: "airship", kind: "airship", sprite: "air-a", start: { map: "sea", x: 2, y: 2, dir: "up" } },
];

function mover(x: number, y: number, facing: 0 | 1 | 2 | 3 = 0): MovementState {
  return initialMovement(x, y, facing, CFG);
}

describe("optional travel state", () => {
  test("is absent for a legacy project and initializes only active followers", () => {
    const player = mover(4, 5, 3);
    expect(createTravelState({}, player, CFG)).toBeUndefined();

    const project: Pick<Project, "followers" | "vehicles"> = { followers: FOLLOWERS, vehicles: VEHICLES };
    const state = createTravelState(project, player, CFG, { "party-b": false })!;
    expect(state.followers?.members.map((member) => member.id)).toEqual(["always", "inverted"]);
    expect(state.followers?.members.map((member) => [member.move.tx, member.move.ty])).toEqual([[4, 5], [4, 5]]);
    expect(state.vehicles?.entries.map((vehicle) => [vehicle.id, vehicle.mapId, vehicle.move.tx, vehicle.move.facing])).toEqual([
      ["boat", "sea", 3, 1],
      ["ship", "sea", 3, 3],
      ["airship", "sea", 2, 2],
    ]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  test("clone detaches every movement and trail record", () => {
    const state = createTravelState({ followers: FOLLOWERS, vehicles: VEHICLES }, mover(1, 1), CFG)!;
    state.followers!.members[0]!.trail.push({ x: 2, y: 1 });
    const copy = cloneTravelState(state);
    copy.followers!.members[0]!.move.tx = 9;
    copy.followers!.members[0]!.trail[0]!.x = 8;
    copy.vehicles!.entries[0]!.move.ty = 7;
    expect(state.followers!.members[0]!.move.tx).toBe(1);
    expect(state.followers!.members[0]!.trail[0]!.x).toBe(2);
    expect(state.vehicles!.entries[0]!.move.ty).toBe(2);
  });

  test("switch reconciliation preserves survivors and spawns a new member at its predecessor", () => {
    const initial = createTravelState({ followers: FOLLOWERS }, mover(5, 4), CFG, { "party-b": false })!;
    const first = initial.followers!.members[0]!;
    first.move = mover(3, 4, 3);
    first.trail.push({ x: 4, y: 4 });
    const before = structuredClone(initial);

    const next = reconcileFollowers(initial, FOLLOWERS, { "party-b": true, "party-out-c": true }, mover(5, 4));
    expect(initial).toEqual(before);
    expect(next.followers?.members.map((member) => member.id)).toEqual(["always", "joined"]);
    expect(next.followers?.members[0]).toBe(first);
    expect(next.followers?.members[1]).toMatchObject({
      id: "joined",
      move: { tx: 3, ty: 4, phase: 0, moving: false },
      trail: [],
    });
  });

  test("visibility is stateful without discarding the trail", () => {
    const initial = createTravelState({ followers: FOLLOWERS }, mover(1, 1), CFG)!;
    initial.followers!.members[0]!.trail.push({ x: 2, y: 1 });
    const hidden = setFollowersVisible(initial, false)!;
    expect(hidden.followers?.visible).toBe(false);
    expect(hidden.followers?.members[0]?.trail).toEqual([{ x: 2, y: 1 }]);
    expect(initial.followers?.visible).toBe(true);
  });
});

describe("follower historical trail and gather", () => {
  test("starts the whole spaced chain in the leader's phase without cutting a corner", () => {
    const initial: TravelState = {
      followers: {
        visible: true,
        gathering: false,
        gatherWaiters: [],
        members: [
          { id: "one", sprite: "one", move: mover(0, 1, 3), trail: [] },
          { id: "two", sprite: "two", move: mover(0, 2, 2), trail: [] },
        ],
      },
    };
    const untouched = structuredClone(initial);
    const leader = mover(1, 0, 2);

    const started = stepFollowers(initial, leader, CFG, { x: 1, y: 1 })!;
    expect(initial).toEqual(untouched);
    expect(started.followers?.members[0]?.move).toMatchObject({ tx: 0, ty: 1, stepDir: 3, phase: 1, moving: true });
    expect(started.followers?.members[1]?.move).toMatchObject({ tx: 0, ty: 2, stepDir: 2, phase: 1, moving: true });

    const landed = stepFollowers(started, leader, CFG)!;
    expect(landed.followers?.members[0]?.move).toMatchObject({ tx: 1, ty: 1, moving: false });
    // The second follower receives the first follower's old cell (0,1), not
    // the leader's diagonal position (1,0), and lands on the same tick.
    expect(landed.followers?.members[1]?.move).toMatchObject({ tx: 0, ty: 1, stepDir: 2, moving: false });
  });

  test("retains a non-adjacent historical waypoint until the follower reaches it", () => {
    let state: TravelState | undefined = {
      followers: {
        visible: true,
        gathering: false,
        gatherWaiters: [],
        members: [{
          id: "one",
          sprite: "one",
          move: mover(0, 0, 3),
          trail: [{ x: 2, y: 0 }, { x: 2, y: 1 }],
        }],
      },
    };
    state = stepFollowers(state, mover(3, 1), CFG);
    state = stepFollowers(state, mover(3, 1), CFG);
    expect(state?.followers?.members[0]).toMatchObject({
      move: { tx: 1, ty: 0 },
      trail: [{ x: 2, y: 0 }, { x: 2, y: 1 }],
    });
    state = stepFollowers(state, mover(3, 1), CFG);
    state = stepFollowers(state, mover(3, 1), CFG);
    expect(state?.followers?.members[0]).toMatchObject({
      move: { tx: 2, ty: 0 },
      trail: [{ x: 2, y: 1 }],
    });
  });

  test("gather ignores trail history and converges every member on a stationary leader", () => {
    let state: TravelState | undefined = {
      followers: {
        visible: true,
        gathering: false,
        gatherWaiters: [],
        members: [
          { id: "one", sprite: "one", move: mover(0, 2), trail: [{ x: 9, y: 9 }] },
          { id: "two", sprite: "two", move: mover(0, 3), trail: [{ x: 8, y: 8 }] },
        ],
      },
    };
    const leader = mover(2, 0);
    state = gatherFollowers(state, "map:1");
    state = gatherFollowers(state, "parallel:2");
    expect(drainCompletedGatherWaiters(state).waiters).toEqual([]);
    for (let tick = 0; tick < 32; tick++) state = stepFollowers(state, leader, CFG);
    expect(state?.followers?.gathering).toBe(false);
    expect(state?.followers?.members.map((member) => [member.move.tx, member.move.ty, member.move.moving])).toEqual([
      [2, 0, false],
      [2, 0, false],
    ]);
    expect(state?.followers?.members.every((member) => member.trail.length === 0)).toBe(true);
    const drained = drainCompletedGatherWaiters(state);
    expect(drained.waiters).toEqual(["map:1", "parallel:2"]);
    expect(drained.state?.followers?.gatherWaiters).toEqual([]);
  });

  test("hidden followers complete gather immediately and retain its waiter until drained", () => {
    let state = createTravelState({ followers: FOLLOWERS }, mover(1, 1), CFG)!;
    state = setFollowersVisible(state, false)!;
    state = gatherFollowers(state, "hidden:1")!;
    expect(state.followers?.gathering).toBe(false);
    const drained = drainCompletedGatherWaiters(state);
    expect(drained.waiters).toEqual(["hidden:1"]);
    expect(drained.state?.followers?.gatherWaiters).toEqual([]);
  });
});

describe("transfer and seamless coordinate changes", () => {
  test("ordinary transfer synchronizes followers and only the ridden vehicle", () => {
    let state = createTravelState({ followers: FOLLOWERS, vehicles: VEHICLES }, mover(1, 1), CFG)!;
    state = boardVehicle(state, "boat")!;
    state = stepFollowers(state, mover(1, 1), CFG)!;
    state = completeVehicleBoarding(state)!;
    const player = mover(7, 6, 3);
    const next = syncTravelAfterTransfer(state, "island", player)!;
    expect(next.followers?.members.every((member) =>
      member.move.tx === 7 && member.move.ty === 6 && member.trail.length === 0
    )).toBe(true);
    expect(vehicleBy(next, "boat")).toMatchObject({ mapId: "island", move: { tx: 7, ty: 6 } });
    expect(vehicleBy(next, "ship")).toMatchObject({ mapId: "sea", move: { tx: 3, ty: 2 } });
  });

  test("seamless commit rebases followers and history while the ridden vehicle lands with the player", () => {
    let state = createTravelState({ followers: FOLLOWERS, vehicles: VEHICLES }, mover(7, 2, 3), CFG)!;
    state.followers!.members[0]!.move = mover(6, 2, 3);
    state.followers!.members[0]!.trail = [{ x: 7, y: 2 }];
    state = boardVehicle(state, "boat")!;
    for (let tick = 0; tick < 32 && state.followers?.gathering; tick++) {
      state = stepFollowers(state, mover(7, 2, 3), CFG)!;
    }
    state = completeVehicleBoarding(state)!;
    // Boarding intentionally gathered; restore ordinary trailing state for
    // this direct rebase contract test.
    state.followers!.gathering = false;
    state.followers!.members[0]!.move = mover(6, 2, 3);
    state.followers!.members[0]!.trail = [{ x: 7, y: 2 }];
    const targetPlayer = mover(0, 2, 3);
    const next = rebaseTravelAfterSeamless(state, {
      sourceMapId: "west",
      targetMapId: "east",
      originX: -8,
      originY: 0,
      sourcePlayerX: 7,
      sourcePlayerY: 2,
      tileSize: 16,
      targetPlayer,
    })!;
    expect(next.followers?.members[0]?.move).toMatchObject({ tx: -2, ty: 2, px: -32 });
    expect(next.followers?.members[0]?.trail).toEqual([{ x: -1, y: 2 }]);
    expect(ridingVehicle(next)).toMatchObject({ mapId: "east", move: { tx: 0, ty: 2 } });
  });
});

describe("persistent vehicle operations", () => {
  test("boarding priority is airship on-cell, then ship and boat in front", () => {
    const state = createTravelState({ vehicles: VEHICLES }, mover(2, 2, 3), CFG)!;
    expect(boardableVehicle(state, "sea", mover(2, 2, 3))?.id).toBe("airship");
    const noAirship = relocateVehicle(state, "airship", "hangar", 0, 0, CFG)!;
    expect(boardableVehicle(noAirship, "sea", mover(2, 2, 3))?.id).toBe("ship");
    const boarded = completeVehicleBoarding(boardVehicle(noAirship, "ship"))!;
    expect(leaveVehicle(boarded)?.vehicles?.riding).toBeNull();
  });

  test("ride, synchronize, image, BGM and relocation are pure", () => {
    const initial = createTravelState({ vehicles: VEHICLES }, mover(2, 2, 3), CFG)!;
    const before = structuredClone(initial);
    const bgm = { id: "airship-theme", volume: 80, pitch: 95 };
    let state = boardVehicle(initial, "airship")!;
    expect(state.vehicles).toMatchObject({ boarding: "airship", riding: null, airshipPhase: "grounded" });
    state = completeVehicleBoarding(state)!;
    state = syncRiddenVehicle(state, "sky", mover(8, 4, 2))!;
    state = setVehicleImage(state, "airship", "air-b")!;
    state = setVehicleBgm(state, "airship", bgm)!;
    state = relocateVehicle(state, "boat", "lake", 1, 2, CFG, 0)!;
    expect(initial).toEqual(before);
    expect(ridingVehicle(state)).toMatchObject({
      id: "airship",
      sprite: "air-b",
      bgm,
      mapId: "sky",
      move: { tx: 8, ty: 4 },
    });
    expect(ridingVehicle(state)?.bgm).not.toBe(bgm);
    bgm.volume = 1;
    expect(ridingVehicle(state)?.bgm).toEqual({ id: "airship-theme", volume: 80, pitch: 95 });
    expect(state.vehicles).toMatchObject({ airshipAltitude: 0, airshipPhase: "ascending", airshipPhaseTick: 0 });
    expect(vehicleBy(state, "boat")).toMatchObject({ mapId: "lake", move: { tx: 1, ty: 2, facing: 0 } });
    expect(leaveVehicle(state)).toBe(state); // ascent cannot be interrupted
  });

  test("airship ascent and requested descent each take exactly 48 ticks", () => {
    let state = completeVehicleBoarding(
      boardVehicle(createTravelState({ vehicles: VEHICLES }, mover(2, 2), CFG), "airship"),
    )!;
    for (let tick = 1; tick < AIRSHIP_TRANSITION_TICKS; tick++) {
      state = stepAirshipAltitude(state, 16)!;
    }
    expect(state.vehicles).toMatchObject({
      riding: "airship",
      airshipPhase: "ascending",
      airshipPhaseTick: 47,
    });
    expect(state.vehicles!.airshipAltitude).toBeCloseTo(16 * 47 / 48);
    state = stepAirshipAltitude(state, 16)!;
    expect(state.vehicles).toMatchObject({ airshipPhase: "cruising", airshipPhaseTick: 48, airshipAltitude: 16 });

    state = requestAirshipLanding(state)!;
    expect(state.vehicles).toMatchObject({ riding: "airship", airshipPhase: "descending" });
    for (let tick = 1; tick < AIRSHIP_TRANSITION_TICKS; tick++) {
      state = stepAirshipAltitude(state, 16)!;
    }
    expect(state.vehicles).toMatchObject({ riding: "airship", airshipPhase: "descending", airshipPhaseTick: 1 });
    state = stepAirshipAltitude(state, 16)!;
    expect(state.vehicles).toMatchObject({ riding: null, airshipPhase: "grounded", airshipPhaseTick: 0, airshipAltitude: 0 });
  });

  test("vehicle relocation and airship height reject non-finite coordinates", () => {
    const state = createTravelState({ vehicles: VEHICLES }, mover(2, 2), CFG)!;
    expect(() => relocateVehicle(state, "boat", "lake", Number.NaN, 2, CFG)).toThrow("integer x/y required");
    const boarded = completeVehicleBoarding(boardVehicle(state, "airship"))!;
    expect(() => stepAirshipAltitude(boarded, Number.POSITIVE_INFINITY)).toThrow("finite non-negative");
  });
});

describe("vehicle passage and landing", () => {
  const sheet: Sheet = { id: "ground", pak: "ground", cols: 1, rows: 1, defaultPassage: "pass" };
  const map: MapDef = {
    id: "sea",
    name: "Sea",
    width: 4,
    height: 3,
    sheets: [sheet.id],
    ground: new Array(12).fill("ground.0"),
    vehiclePassage: { boat: [5], ship: [6], airshipLand: [9] },
    events: [],
  };
  const base = buildPassage(map, new Map([[sheet.id, sheet]]));
  const special = buildVehiclePassage(map)!;

  test("boat and ship use destination special flags; airship ignores terrain and bodies but not bounds", () => {
    expect(canVehicleStep("boat", base, special, 0, 1, 3)).toBe(true); // -> 5
    expect(canVehicleStep("ship", base, special, 0, 1, 3)).toBe(false);
    expect(canVehicleStep("ship", base, special, 1, 1, 3)).toBe(true); // -> 6
    const occupied = stampBlockedCells(base, [5]);
    expect(canVehicleStep("boat", occupied, special, 0, 1, 3)).toBe(false);
    expect(canVehicleStep("airship", occupied, special, 0, 1, 3)).toBe(true);
    expect(canVehicleStep("airship", base, special, 3, 1, 3)).toBe(false);
  });

  test("boat/ship leave the vehicle behind; airship landing uses its explicit flag and body rule", () => {
    expect(vehicleDisembarkTarget("boat", base, special, 1, 1, 2)).toEqual({
      playerX: 1,
      playerY: 0,
      vehicleX: 1,
      vehicleY: 1,
    });
    expect(vehicleDisembarkTarget("airship", base, special, 1, 2, 0)).toEqual({
      playerX: 1,
      playerY: 2,
      vehicleX: 1,
      vehicleY: 2,
    });
    expect(vehicleDisembarkTarget("airship", base, special, 0, 2, 0)).toBeNull();
    expect(vehicleDisembarkTarget("airship", stampBlockedCells(base, [9]), special, 1, 2, 0)).toBeNull();
  });

  test("boat/ship disembark respects the land cell's reverse exit edge", () => {
    const edgeSheet: Sheet = {
      ...sheet,
      dirEdges: { "0": { exit: ["down"] } },
    };
    const reverseBlocked = buildPassage(map, new Map([[edgeSheet.id, edgeSheet]]));
    expect(vehicleDisembarkTarget("boat", reverseBlocked, special, 1, 1, 2)).toBeNull();
  });

  test("airship landing falls back to ordinary standability only when the explicit list is absent", () => {
    const fallback = buildVehiclePassage({ ...map, vehiclePassage: { boat: [5] } })!;
    expect(vehicleDisembarkTarget("airship", base, fallback, 0, 0, 0)).not.toBeNull();
    const nowhere = buildVehiclePassage({ ...map, vehiclePassage: { airshipLand: [] } })!;
    expect(vehicleDisembarkTarget("airship", base, nowhere, 0, 0, 0)).toBeNull();
  });

  test("invalid special-passage indices fail when the derived table is built", () => {
    expect(() => buildVehiclePassage({ ...map, vehiclePassage: { boat: [12] } })).toThrow("outside 0..11");
  });
});

function vehicleBy(state: TravelState, id: string) {
  return state.vehicles?.entries.find((vehicle) => vehicle.id === id);
}
