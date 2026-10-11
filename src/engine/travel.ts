// src/engine/travel.ts — optional followers and persistent RPG-style vehicles.
//
// This module is deliberately independent of Session/Interpreter.  It owns
// only JSON-safe reducer data and pure transformations, so session.ts can keep
// the legacy hot path as one absent-state branch.  Derived vehicle passage
// tables are the sole non-JSON value here and belong in Session's map cache,
// never in TravelState or a save.

import {
  initialMovement,
  stepFrames,
  stepPixels,
  type MovementConfig,
  type MovementState,
} from "./movement.ts";
import { cellBlocksExit, isStandable, type Dir4, type PassageTable } from "./passability.ts";
import type {
  Dir,
  FollowersDef,
  MapDef,
  Project,
  VehicleDef,
  VehicleKind,
} from "./types.ts";

const DX: readonly number[] = [0, -1, 0, 1];
const DY: readonly number[] = [1, 0, -1, 0];
const OPPOSITE: readonly Dir4[] = [2, 3, 0, 1];
const DIR_INDEX: Readonly<Record<Dir, Dir4>> = { down: 0, left: 1, up: 2, right: 3 };
const BOARDING_ORDER: readonly VehicleKind[] = ["airship", "ship", "boat"];

/** A tile already occupied by the preceding party member.  Followers consume
 * these in order, so an L-shaped route keeps its corner instead of cutting it
 * diagonally. */
export interface FollowerTrailPoint {
  x: number;
  y: number;
}

export interface FollowerTravelState {
  id: string;
  sprite: string;
  move: MovementState;
  /** Pending predecessor cells, oldest first.  There are no wait samples: a
   * stationary leader therefore leaves the party spaced one tile apart. */
  trail: FollowerTrailPoint[];
}

export interface FollowersTravelState {
  visible: boolean;
  /** Gather discards the ordinary trail and walks each member directly toward
   * its predecessor.  It clears itself once the whole chain overlaps. */
  gathering: boolean;
  /** Interpreter fibers waiting for the current gather.  This queue lives in
   * reducer state so parallel-event waiters survive save/restore and ticks. */
  gatherWaiters: string[];
  members: FollowerTravelState[];
}

export type AirshipPhase = "grounded" | "ascending" | "cruising" | "descending";
export const AIRSHIP_TRANSITION_TICKS = 48;

export interface VehicleTravelState {
  id: string;
  kind: VehicleKind;
  sprite: string;
  mapId: string;
  move: MovementState;
}

export interface VehiclesTravelState {
  /** Project order is retained for deterministic handling of malformed data
   * containing more than one vehicle of a kind. */
  entries: VehicleTravelState[];
  /** Vehicle selected by the boarding action while the player and visible
   * followers converge. It becomes `riding` only after both movement and
   * gathering finish, matching RPG Maker's get-on transition. */
  boarding?: string | null;
  riding: string | null;
  /** Pixel lift for the ridden airship.  Zero for every other state. */
  airshipAltitude: number;
  /** Explicit flight transition; movement is enabled only while cruising. */
  airshipPhase: AirshipPhase;
  /** Completed ticks in the 48-tick ascent/descent range. */
  airshipPhaseTick: number;
}

export interface GatherWaiterDrain {
  state: TravelState | undefined;
  waiters: string[];
}

/** Optional project-wide reducer state.  All fields are plain JSON values;
 * projects with neither followers nor vehicles return undefined instead. */
export interface TravelState {
  followers?: FollowersTravelState;
  vehicles?: VehiclesTravelState;
}

/** Derived, allocation-on-map-load lookup for RPG Maker's special tileset
 * flags.  It is intentionally not part of TravelState or save data. */
export interface VehiclePassageTable {
  width: number;
  height: number;
  boat?: Uint8Array;
  ship?: Uint8Array;
  /** undefined means the additive fallback: ordinary standable ground.  An
   * explicitly empty array means the airship cannot land anywhere. */
  airshipLand?: Uint8Array;
}

export interface SeamlessTravelRebase {
  sourceMapId: string;
  targetMapId: string;
  /** Source-map origin expressed in target-map tile coordinates. */
  originX: number;
  originY: number;
  sourcePlayerX: number;
  sourcePlayerY: number;
  tileSize: number;
  /** Player state after atomic target entry. */
  targetPlayer: Readonly<MovementState>;
}

export interface VehicleDisembarkTarget {
  playerX: number;
  playerY: number;
  vehicleX: number;
  vehicleY: number;
}

function cloneMovement(move: Readonly<MovementState>): MovementState {
  return { ...move };
}

function restingCopy(move: Readonly<MovementState>): MovementState {
  const out: MovementState = {
    ...move,
    phase: 0,
    moving: false,
    walking: false,
    stepDir: move.facing,
  };
  delete out.stepTilesPerSecond;
  return out;
}

function cloneFollower(member: Readonly<FollowerTravelState>): FollowerTravelState {
  return {
    id: member.id,
    sprite: member.sprite,
    move: cloneMovement(member.move),
    trail: member.trail.map((point) => ({ ...point })),
  };
}

function cloneVehicle(vehicle: Readonly<VehicleTravelState>): VehicleTravelState {
  return { ...vehicle, move: cloneMovement(vehicle.move) };
}

export function cloneTravelState(state: Readonly<TravelState>): TravelState {
  return {
    ...(state.followers
      ? {
          followers: {
            visible: state.followers.visible,
            gathering: state.followers.gathering,
            gatherWaiters: [...state.followers.gatherWaiters],
            members: state.followers.members.map(cloneFollower),
          },
        }
      : {}),
    ...(state.vehicles
      ? {
          vehicles: {
            entries: state.vehicles.entries.map(cloneVehicle),
            boarding: state.vehicles.boarding ?? null,
            riding: state.vehicles.riding,
            airshipAltitude: state.vehicles.airshipAltitude,
            airshipPhase: state.vehicles.airshipPhase,
            airshipPhaseTick: state.vehicles.airshipPhaseTick,
          },
        }
      : {}),
  };
}

/** activeSwitch reads the same sparse boolean bank as imported party
 * conditions.  Missing switches are false; activeValue defaults to true. */
export function followerDefinitionActive(
  definition: Readonly<FollowersDef["members"][number]>,
  switches: Readonly<Record<string, boolean>>,
): boolean {
  if (definition.activeSwitch === undefined) return true;
  return (switches[definition.activeSwitch] ?? false) === (definition.activeValue ?? true);
}

function createFollowers(
  definition: Readonly<FollowersDef>,
  switches: Readonly<Record<string, boolean>>,
  player: Readonly<MovementState>,
): FollowersTravelState {
  return {
    visible: definition.enabled,
    gathering: false,
    gatherWaiters: [],
    members: definition.members
      .filter((member) => followerDefinitionActive(member, switches))
      .map((member) => ({
        id: member.id,
        sprite: member.sprite,
        move: restingCopy(player),
        trail: [],
      })),
  };
}

function createVehicles(
  definitions: readonly Readonly<VehicleDef>[],
  cfg: Readonly<MovementConfig>,
): VehiclesTravelState {
  return {
    entries: definitions.map((vehicle) => ({
      id: vehicle.id,
      kind: vehicle.kind,
      sprite: vehicle.sprite,
      mapId: vehicle.start.map,
      move: initialMovement(
        vehicle.start.x,
        vehicle.start.y,
        DIR_INDEX[vehicle.start.dir],
        cfg,
      ),
    })),
    boarding: null,
    riding: null,
    airshipAltitude: 0,
    airshipPhase: "grounded",
    airshipPhaseTick: 0,
  };
}

/** Build the optional reducer block at session start. */
export function createTravelState(
  project: Pick<Project, "followers" | "vehicles">,
  player: Readonly<MovementState>,
  cfg: Readonly<MovementConfig>,
  switches: Readonly<Record<string, boolean>> = {},
): TravelState | undefined {
  const hasFollowers = project.followers !== undefined;
  const hasVehicles = (project.vehicles?.length ?? 0) > 0;
  if (!hasFollowers && !hasVehicles) return undefined;
  return {
    ...(project.followers
      ? { followers: createFollowers(project.followers, switches, player) }
      : {}),
    ...(hasVehicles ? { vehicles: createVehicles(project.vehicles!, cfg) } : {}),
  };
}

/** Reconcile switch-backed membership in authored order.  Existing members
 * retain their exact motion/trail; a newly active member starts at the last
 * active predecessor (or the leader), avoiding a one-frame map-origin flash. */
export function reconcileFollowers(
  state: Readonly<TravelState>,
  definition: Readonly<FollowersDef>,
  switches: Readonly<Record<string, boolean>>,
  leader: Readonly<MovementState>,
): TravelState {
  const prior = state.followers;
  const byId = new Map(prior?.members.map((member) => [member.id, member]));
  const members: FollowerTravelState[] = [];
  let predecessor = leader;
  let changed = prior === undefined;
  for (const definitionMember of definition.members) {
    if (!followerDefinitionActive(definitionMember, switches)) continue;
    const existing = byId.get(definitionMember.id);
    if (existing) {
      const member = existing.sprite === definitionMember.sprite
        ? existing
        : { ...existing, sprite: definitionMember.sprite };
      if (member !== existing) changed = true;
      members.push(member);
      predecessor = member.move;
    } else {
      changed = true;
      const member: FollowerTravelState = {
        id: definitionMember.id,
        sprite: definitionMember.sprite,
        move: restingCopy(predecessor),
        trail: [],
      };
      members.push(member);
      predecessor = member.move;
    }
  }
  if (prior && (members.length !== prior.members.length || members.some((member, i) => member !== prior.members[i]))) {
    changed = true;
  }
  if (!changed && prior) return state as TravelState;
  return {
    ...state,
    followers: {
      visible: prior?.visible ?? definition.enabled,
      gathering: (prior?.gathering ?? false) && (prior?.visible ?? definition.enabled) && members.length > 0,
      gatherWaiters: prior ? [...prior.gatherWaiters] : [],
      members,
    },
  };
}

export function setFollowersVisible(
  state: Readonly<TravelState> | undefined,
  visible: boolean,
): TravelState | undefined {
  if (!state?.followers || state.followers.visible === visible) return state as TravelState | undefined;
  return {
    ...state,
    followers: {
      ...state.followers,
      visible,
      // A hidden party has nothing visual to converge, so pending gathers are
      // immediately eligible for drain by the Session integration.
      gathering: visible ? state.followers.gathering : false,
    },
  };
}

/** Start deterministic gather.  Ordinary history is intentionally discarded:
 * gather is the explicit recovery operation and all followers are through. */
export function gatherFollowers(
  state: Readonly<TravelState> | undefined,
  waiter?: string,
): TravelState | undefined {
  if (!state?.followers) return state as TravelState | undefined;
  const gatherWaiters = waiter !== undefined && !state.followers.gatherWaiters.includes(waiter)
    ? [...state.followers.gatherWaiters, waiter]
    : [...state.followers.gatherWaiters];
  return {
    ...state,
    followers: {
      ...state.followers,
      gathering: state.followers.visible && state.followers.members.length > 0,
      gatherWaiters,
      members: state.followers.members.map((member) => ({ ...member, trail: [] })),
    },
  };
}

/** Atomically take completed gather waiters.  While convergence is still in
 * progress this is an identity no-op, preventing parallel fibers from being
 * resumed early or lost. */
export function drainCompletedGatherWaiters(
  state: Readonly<TravelState> | undefined,
): GatherWaiterDrain {
  const followers = state?.followers;
  if (!followers || followers.gathering || followers.gatherWaiters.length === 0) {
    return { state: state as TravelState | undefined, waiters: [] };
  }
  return {
    state: { ...state, followers: { ...followers, gatherWaiters: [] } },
    waiters: [...followers.gatherWaiters],
  };
}

function sameCell(move: Readonly<MovementState>, point: Readonly<FollowerTrailPoint>): boolean {
  return move.tx === point.x && move.ty === point.y;
}

function pushTrail(member: FollowerTravelState, point: Readonly<FollowerTrailPoint>): void {
  const last = member.trail[member.trail.length - 1];
  if ((last && last.x === point.x && last.y === point.y) ||
      (!member.move.moving && member.trail.length === 0 && sameCell(member.move, point))) return;
  member.trail.push({ x: point.x, y: point.y });
}

function directionToward(move: Readonly<MovementState>, target: Readonly<FollowerTrailPoint>): Dir4 | null {
  const dx = target.x - move.tx;
  const dy = target.y - move.ty;
  if (dx === 0 && dy === 0) return null;
  // Historical waypoints are adjacent.  Gather can start farther away; use a
  // deterministic dominant-axis choice, with vertical winning a tie just as
  // the player's d-pad resolver does.
  if (Math.abs(dy) >= Math.abs(dx) && dy !== 0) return dy > 0 ? 0 : 2;
  return dx > 0 ? 3 : 1;
}

interface FollowerAdvance {
  move: MovementState;
  /** Tile vacated by a landing this tick, to feed the next chain member. */
  vacated?: FollowerTrailPoint;
}

function advanceFollower(
  move: Readonly<MovementState>,
  target: Readonly<FollowerTrailPoint> | undefined,
  cfg: Readonly<MovementConfig>,
): FollowerAdvance {
  const frames = stepFrames(cfg);
  if (move.moving) {
    const phase = move.phase + 1;
    if (phase < frames) {
      const pixel = stepPixels(move.tx * cfg.tile, move.ty * cfg.tile, move.stepDir, phase, cfg);
      return { move: { ...move, phase, ...pixel } };
    }
    const tx = move.tx + DX[move.stepDir]!;
    const ty = move.ty + DY[move.stepDir]!;
    const landed: MovementState = {
      ...move,
      tx,
      ty,
      px: tx * cfg.tile,
      py: ty * cfg.tile,
      phase: 0,
      moving: false,
      walking: false,
    };
    delete landed.stepTilesPerSecond;
    return { move: landed, vacated: { x: move.tx, y: move.ty } };
  }
  if (!target) return { move: move.walking ? { ...move, walking: false } : move as MovementState };
  const dir = directionToward(move, target);
  if (dir === null) return { move: move.walking ? { ...move, walking: false } : move as MovementState };
  const pixel = stepPixels(move.tx * cfg.tile, move.ty * cfg.tile, dir, 1, cfg);
  return {
    move: {
      ...move,
      facing: dir,
      phase: 1,
      moving: true,
      walking: true,
      stepDir: dir,
      ...pixel,
    },
  };
}

function gathered(members: readonly Readonly<FollowerTravelState>[], leader: Readonly<MovementState>): boolean {
  let predecessor: Readonly<MovementState> = leader;
  for (const member of members) {
    if (member.move.moving || member.move.tx !== predecessor.tx || member.move.ty !== predecessor.ty) return false;
    predecessor = member.move;
  }
  return true;
}

/** Advance every follower by one fixed reference tick. `leaderStepOrigin` is
 * supplied on the tick a successful player step STARTS. Every party member
 * snapshots its predecessor's current cell on that same tick, so the whole
 * spaced chain begins interpolation in phase with the leader as RPG Maker's
 * reverse-order chase does. Followers replay those proven cells without
 * consulting passage or body collision. */
export function stepFollowers(
  state: Readonly<TravelState> | undefined,
  leader: Readonly<MovementState>,
  cfg: Readonly<MovementConfig>,
  leaderStepOrigin?: Readonly<FollowerTrailPoint>,
): TravelState | undefined {
  const followers = state?.followers;
  if (!followers) return state as TravelState | undefined;
  if (followers.members.length === 0) {
    if (!followers.gathering) return state as TravelState;
    return { ...state, followers: { ...followers, gathering: false } };
  }

  const members = followers.members.map(cloneFollower);
  if (!followers.gathering && leaderStepOrigin) {
    let predecessor = leaderStepOrigin;
    for (const member of members) {
      const current = { x: member.move.tx, y: member.move.ty };
      pushTrail(member, predecessor);
      predecessor = current;
    }
  }

  let predecessor: Readonly<MovementState> = leader;
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    if (followers.gathering) member.trail.length = 0;
    while (!member.move.moving && member.trail[0] && sameCell(member.move, member.trail[0]!)) {
      member.trail.shift();
    }
    const target = followers.gathering
      ? { x: predecessor.tx, y: predecessor.ty }
      : member.trail[0];
    const advanced = advanceFollower(member.move, target, cfg);
    member.move = advanced.move;
    if (advanced.vacated && !followers.gathering && member.trail[0] && sameCell(member.move, member.trail[0]!)) {
      member.trail.shift();
    }
    predecessor = member.move;
  }

  return {
    ...state,
    followers: {
      visible: followers.visible,
      gathering: followers.gathering && !gathered(members, leader),
      gatherWaiters: [...followers.gatherWaiters],
      members,
    },
  };
}

/** Ordinary transfer semantics: the whole party arrives on the player, trail
 * history is reset, and a ridden vehicle follows.  Parked vehicles stay put. */
export function syncTravelAfterTransfer(
  state: Readonly<TravelState> | undefined,
  mapId: string,
  player: Readonly<MovementState>,
): TravelState | undefined {
  if (!state) return undefined;
  let next: TravelState = state as TravelState;
  if (state.followers) {
    next = {
      ...next,
      followers: {
        visible: state.followers.visible,
        gathering: false,
        gatherWaiters: [...state.followers.gatherWaiters],
        members: state.followers.members.map((member) => ({
          ...member,
          move: restingCopy(player),
          trail: [],
        })),
      },
    };
  }
  return syncRiddenVehicle(next, mapId, player);
}

function rebaseMovement(
  move: Readonly<MovementState>,
  dx: number,
  dy: number,
  tileSize: number,
): MovementState {
  return {
    ...move,
    tx: move.tx + dx,
    ty: move.ty + dy,
    px: move.px + dx * tileSize,
    py: move.py + dy * tileSize,
  };
}

/** Atomic seamless entry changes the coordinate frame, not the party's world
 * position.  Rebase follower motion and queued cells, enqueue the source edge
 * as the leader's latest breadcrumb, and place the ridden vehicle with the
 * already-entered player. */
export function rebaseTravelAfterSeamless(
  state: Readonly<TravelState> | undefined,
  rebase: Readonly<SeamlessTravelRebase>,
): TravelState | undefined {
  if (!state) return undefined;
  let next: TravelState = state as TravelState;
  if (state.followers) {
    const members = state.followers.members.map((member) => ({
      ...member,
      move: rebaseMovement(member.move, rebase.originX, rebase.originY, rebase.tileSize),
      trail: member.trail.map((point) => ({
        x: point.x + rebase.originX,
        y: point.y + rebase.originY,
      })),
    }));
    if (!state.followers.gathering && members[0]) {
      pushTrail(members[0], {
        x: rebase.sourcePlayerX + rebase.originX,
        y: rebase.sourcePlayerY + rebase.originY,
      });
    }
    next = { ...next, followers: { ...state.followers, members } };
  }
  return syncRiddenVehicle(next, rebase.targetMapId, rebase.targetPlayer);
}

export function vehicleById(
  state: Readonly<TravelState> | undefined,
  id: string,
): Readonly<VehicleTravelState> | undefined {
  return state?.vehicles?.entries.find((vehicle) => vehicle.id === id);
}

export function ridingVehicle(
  state: Readonly<TravelState> | undefined,
): Readonly<VehicleTravelState> | null {
  const id = state?.vehicles?.riding;
  return id ? vehicleById(state, id) ?? null : null;
}

/** RPG Maker boards an airship on the player's cell, otherwise the ship and
 * then boat in the faced cell. */
export function boardableVehicle(
  state: Readonly<TravelState> | undefined,
  mapId: string,
  player: Readonly<MovementState>,
): Readonly<VehicleTravelState> | null {
  if (!state?.vehicles || state.vehicles.riding !== null || state.vehicles.boarding != null) return null;
  for (const kind of BOARDING_ORDER) {
    const x = kind === "airship" ? player.tx : player.tx + DX[player.facing]!;
    const y = kind === "airship" ? player.ty : player.ty + DY[player.facing]!;
    const found = state.vehicles.entries.find((vehicle) =>
      vehicle.kind === kind && vehicle.mapId === mapId && !vehicle.move.moving &&
      vehicle.move.tx === x && vehicle.move.ty === y
    );
    if (found) return found;
  }
  return null;
}

/** Begin get-on after boardableVehicle has selected the target. The vehicle
 * remains parked and followers remain visible until Session observes that the
 * player's boarding step and follower gathering have both completed. */
export function boardVehicle(
  state: Readonly<TravelState> | undefined,
  id: string,
): TravelState | undefined {
  if (!state?.vehicles || state.vehicles.riding !== null || state.vehicles.boarding != null) {
    return state as TravelState | undefined;
  }
  const vehicle = vehicleById(state, id);
  if (!vehicle) return state as TravelState;
  const next: TravelState = {
    ...state,
    vehicles: {
      ...state.vehicles,
      boarding: id,
      airshipAltitude: 0,
      airshipPhase: "grounded",
      airshipPhaseTick: 0,
    },
  };
  return gatherFollowers(next);
}

/** Finish a pending get-on after Session has established that the player and
 * followers are at rest. Kept separate from boardVehicle so an airship cannot
 * rise (or hide the party) while gathering is still in progress. */
export function completeVehicleBoarding(
  state: Readonly<TravelState> | undefined,
): TravelState | undefined {
  const id = state?.vehicles?.boarding;
  if (!id || state.followers?.gathering) return state as TravelState | undefined;
  const vehicle = vehicleById(state, id);
  if (!vehicle) return state as TravelState;
  return {
    ...state,
    vehicles: {
      ...state.vehicles!,
      boarding: null,
      riding: id,
      airshipPhase: vehicle.kind === "airship" ? "ascending" : "grounded",
    },
  };
}

/** Keep a ridden vehicle's durable location and interpolation identical to the
 * player.  A parked vehicle is untouched. */
export function syncRiddenVehicle(
  state: Readonly<TravelState> | undefined,
  mapId: string,
  player: Readonly<MovementState>,
): TravelState | undefined {
  if (!state?.vehicles?.riding) return state as TravelState | undefined;
  const id = state.vehicles.riding;
  const index = state.vehicles.entries.findIndex((vehicle) => vehicle.id === id);
  if (index < 0) return state as TravelState;
  const entries = state.vehicles.entries.slice();
  entries[index] = { ...entries[index]!, mapId, move: cloneMovement(player) };
  return { ...state, vehicles: { ...state.vehicles, entries } };
}

/** Request an airship landing after Session has accepted the current cell.
 * The ride remains active throughout descent and is released by the 48th
 * stepAirshipAltitude tick. */
export function requestAirshipLanding(
  state: Readonly<TravelState> | undefined,
): TravelState | undefined {
  if (!state?.vehicles?.riding || state.vehicles.airshipPhase !== "cruising") {
    return state as TravelState | undefined;
  }
  const vehicle = ridingVehicle(state);
  if (vehicle?.kind !== "airship") return state as TravelState;
  return {
    ...state,
    vehicles: { ...state.vehicles, airshipPhase: "descending" },
  };
}

/** End an ordinary ride immediately.  For a cruising airship this requests
 * descent instead; ascent cannot be interrupted, and descent finishes only
 * when stepAirshipAltitude reaches tick zero. */
export function leaveVehicle(state: Readonly<TravelState> | undefined): TravelState | undefined {
  if (!state?.vehicles?.riding) return state as TravelState | undefined;
  const vehicle = ridingVehicle(state);
  if (vehicle?.kind === "airship") {
    return state.vehicles.airshipPhase === "cruising"
      ? requestAirshipLanding(state)
      : state as TravelState;
  }
  return {
    ...state,
    vehicles: {
      ...state.vehicles,
      boarding: null,
      riding: null,
      airshipAltitude: 0,
      airshipPhase: "grounded",
      airshipPhaseTick: 0,
    },
  };
}

export function relocateVehicle(
  state: Readonly<TravelState> | undefined,
  id: string,
  mapId: string,
  x: number,
  y: number,
  cfg: Readonly<MovementConfig>,
  facing?: Dir4,
): TravelState | undefined {
  const entries = state?.vehicles?.entries;
  if (!entries) return state as TravelState | undefined;
  const index = entries.findIndex((vehicle) => vehicle.id === id);
  if (index < 0) return state as TravelState;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error(`vehicle location: integer x/y required, got (${x},${y})`);
  }
  const next = entries.slice();
  const vehicle = entries[index]!;
  next[index] = {
    ...vehicle,
    mapId,
    move: initialMovement(x, y, facing ?? vehicle.move.facing, cfg),
  };
  return { ...state, vehicles: { ...state.vehicles!, entries: next } };
}

export function setVehicleImage(
  state: Readonly<TravelState> | undefined,
  id: string,
  sprite: string,
): TravelState | undefined {
  const entries = state?.vehicles?.entries;
  if (!entries) return state as TravelState | undefined;
  const index = entries.findIndex((vehicle) => vehicle.id === id);
  if (index < 0 || entries[index]!.sprite === sprite) return state as TravelState;
  const next = entries.slice();
  next[index] = { ...entries[index]!, sprite };
  return { ...state, vehicles: { ...state.vehicles!, entries: next } };
}

/** Advance one tick of the explicit airship lift transition.  Both ascent and
 * descent take exactly AIRSHIP_TRANSITION_TICKS calls.  Descent atomically
 * releases the ride at zero, so Session never resumes walking mid-air. */
export function stepAirshipAltitude(
  state: Readonly<TravelState> | undefined,
  cruiseAltitude: number,
): TravelState | undefined {
  if (!state?.vehicles?.riding) return state as TravelState | undefined;
  const vehicle = ridingVehicle(state);
  if (vehicle?.kind !== "airship") return state as TravelState;
  if (!Number.isFinite(cruiseAltitude) || cruiseAltitude < 0) {
    throw new Error(`airship altitude: finite non-negative cruise height required, got ${cruiseAltitude}`);
  }

  const phase = state.vehicles.airshipPhase;
  if (phase === "grounded" || phase === "cruising") return state as TravelState;
  const delta = phase === "ascending" ? 1 : -1;
  const airshipPhaseTick = Math.max(
    0,
    Math.min(AIRSHIP_TRANSITION_TICKS, state.vehicles.airshipPhaseTick + delta),
  );
  const airshipAltitude = cruiseAltitude * airshipPhaseTick / AIRSHIP_TRANSITION_TICKS;
  if (phase === "ascending") {
    return {
      ...state,
      vehicles: {
        ...state.vehicles,
        airshipAltitude,
        airshipPhase: airshipPhaseTick === AIRSHIP_TRANSITION_TICKS ? "cruising" : "ascending",
        airshipPhaseTick,
      },
    };
  }
  const landed = airshipPhaseTick === 0;
  return {
    ...state,
    vehicles: {
      ...state.vehicles,
      riding: landed ? null : state.vehicles.riding,
      airshipAltitude,
      airshipPhase: landed ? "grounded" : "descending",
      airshipPhaseTick,
    },
  };
}

function fillMask(indices: readonly number[] | undefined, size: number, name: string): Uint8Array | undefined {
  if (indices === undefined) return undefined;
  const mask = new Uint8Array(size);
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      throw new Error(`vehicle passage: ${name} index ${index} outside 0..${size - 1}`);
    }
    mask[index] = 1;
  }
  return mask;
}

export function buildVehiclePassage(map: Readonly<MapDef>): VehiclePassageTable | undefined {
  const definition = map.vehiclePassage;
  if (!definition) return undefined;
  const size = map.width * map.height;
  return {
    width: map.width,
    height: map.height,
    ...(definition.boat !== undefined ? { boat: fillMask(definition.boat, size, "boat") } : {}),
    ...(definition.ship !== undefined ? { ship: fillMask(definition.ship, size, "ship") } : {}),
    ...(definition.airshipLand !== undefined
      ? { airshipLand: fillMask(definition.airshipLand, size, "airshipLand") }
      : {}),
  };
}

function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Per-step traversal.  Boats/ships use their destination-only special flag
 * and still collide with event/vehicle bodies; airships ignore both ordinary
 * terrain and bodies but never leave the map rectangle. */
export function canVehicleStep(
  kind: VehicleKind,
  passage: Readonly<PassageTable>,
  vehiclePassage: Readonly<VehiclePassageTable> | undefined,
  fromX: number,
  fromY: number,
  direction: Dir4,
): boolean {
  if (!inBounds(passage.width, passage.height, fromX, fromY)) return false;
  const x = fromX + DX[direction]!;
  const y = fromY + DY[direction]!;
  if (!inBounds(passage.width, passage.height, x, y)) return false;
  if (kind === "airship") return true;
  if (!vehiclePassage || vehiclePassage.width !== passage.width || vehiclePassage.height !== passage.height) {
    return false;
  }
  const index = y * passage.width + x;
  const mask = kind === "boat" ? vehiclePassage.boat : vehiclePassage.ship;
  return mask?.[index] === 1 && passage.bodyBlocks?.has(index) !== true;
}

/** Return the legal player/vehicle cells after disembark, or null when the
 * landing rule refuses it.  Boats and ships stay on the water cell while the
 * player steps forward onto ordinary land.  Airships land in place. */
export function vehicleDisembarkTarget(
  kind: VehicleKind,
  passage: Readonly<PassageTable>,
  vehiclePassage: Readonly<VehiclePassageTable> | undefined,
  x: number,
  y: number,
  direction: Dir4,
): VehicleDisembarkTarget | null {
  if (!inBounds(passage.width, passage.height, x, y)) return null;
  if (kind === "airship") {
    const index = y * passage.width + x;
    const explicit = vehiclePassage?.airshipLand;
    const allowed = explicit
      ? explicit[index] === 1 && passage.bodyBlocks?.has(index) !== true
      : isStandable(passage, x, y);
    return allowed ? { playerX: x, playerY: y, vehicleX: x, vehicleY: y } : null;
  }
  const playerX = x + DX[direction]!;
  const playerY = y + DY[direction]!;
  if (!isStandable(passage, playerX, playerY) ||
      cellBlocksExit(passage, playerX, playerY, OPPOSITE[direction])) return null;
  return { playerX, playerY, vehicleX: x, vehicleY: y };
}
