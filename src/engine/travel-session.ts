// Optional Session integration for followers and vehicles. Keeping these
// orchestration helpers beside the travel reducer means walking-only games
// do not evaluate vehicle collision, boarding, audio, or request handling.

import { audioStateEmpty } from "./audio.ts";
import { continueExternal } from "./interpreter.ts";
import { DEFAULT_MOVE_SETTINGS, type ResolvedMoveSettings } from "./move-control.ts";
import { stepPixels, type MovementConfig } from "./movement.ts";
import { stampBlockedCells, type PassageTable } from "./passability.ts";
import type { SessionState } from "./session.ts";
import { mapForTileset } from "./tiles.ts";
import * as travel from "./travel.ts";
import type {
  MapDimensionsResolver,
  TravelInstruction,
  TravelPublishResult,
  TravelMovementContext,
} from "./travel-contract.ts";
import type { TravelState, VehiclePassageTable } from "./travel-types.ts";
import type { Facing, FollowersDef, MapDef, VehicleBgm } from "./types.ts";

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;

const vehicleMovementTables = new WeakMap<
  VehiclePassageTable,
  { boat?: PassageTable; ship?: PassageTable }
>();

function coordinateValue(
  value: number | string | { readonly variable: string },
  variables: Readonly<Record<string, number | string>>,
): number | string | undefined {
  return typeof value === "object" ? variables[value.variable] : value;
}

/** Compile the one-frame interpreter request inside the opt-in module. */
export function publishTravelRequest(
  instruction: TravelInstruction,
  variables: Readonly<Record<string, number | string>>,
  fiber: string,
): TravelPublishResult {
  switch (instruction.op) {
    case "followers":
      return { request: { op: "followers", visible: instruction.visible }, wait: false };
    case "gatherFollowers":
      return { request: { op: "gatherFollowers", fiber }, wait: true };
    case "vehicle":
      return { request: { op: "vehicle", action: instruction.action }, wait: false };
    case "setVehicleImage":
      return { request: { op: "setVehicleImage", id: instruction.id, sprite: instruction.sprite }, wait: false };
    case "setVehicleBgm":
      return {
        request: {
          op: "setVehicleBgm",
          id: instruction.id,
          bgm: instruction.bgm === null ? null : { ...instruction.bgm },
        },
        wait: false,
      };
    case "setVehicleLocation": {
      const map = coordinateValue(instruction.map, variables);
      const x = coordinateValue(instruction.x, variables);
      const y = coordinateValue(instruction.y, variables);
      if (typeof map !== "string" || map.length === 0) {
        return { error: `vehicle location in ${fiber}: map variable must hold a non-empty string` };
      }
      if (typeof x !== "number" || !Number.isInteger(x) || x < 0 ||
          typeof y !== "number" || !Number.isInteger(y) || y < 0) {
        return { error: `vehicle location in ${fiber}: coordinate variables must hold non-negative integers` };
      }
      return {
        request: { op: "setVehicleLocation", id: instruction.id, map, x, y },
        wait: false,
      };
    }
  }
}
const blockedVehicleTables = new WeakMap<PassageTable, PassageTable>();

function blockedVehicleTable(base: PassageTable): PassageTable {
  const found = blockedVehicleTables.get(base);
  if (found) return found;
  const size = base.width * base.height;
  const table: PassageTable = {
    width: base.width,
    height: base.height,
    overrides: new Int8Array(size),
    solid: new Uint8Array(size).fill(1),
    entryMask: new Uint8Array(size),
    exitMask: new Uint8Array(size),
    ground: base.ground,
    sheets: base.sheets,
  };
  blockedVehicleTables.set(base, table);
  return table;
}

function vehicleMovementTable(
  base: PassageTable,
  special: VehiclePassageTable | undefined,
  kind: "boat" | "ship",
): PassageTable | null {
  const mask = special?.[kind];
  if (!special || !mask) return null;
  let cached = vehicleMovementTables.get(special);
  const existing = cached?.[kind];
  if (existing) return existing;
  const size = base.width * base.height;
  const solid = new Uint8Array(size);
  for (let i = 0; i < size; i++) solid[i] = mask[i] === 1 ? 0 : 1;
  const cooked: PassageTable = {
    width: base.width,
    height: base.height,
    overrides: new Int8Array(size),
    solid,
    entryMask: new Uint8Array(size),
    exitMask: new Uint8Array(size),
    ground: base.ground,
    sheets: base.sheets,
  };
  if (!cached) {
    cached = {};
    vehicleMovementTables.set(special, cached);
  }
  cached[kind] = cooked;
  return cooked;
}

export function activeVehiclePassage(
  cache: Map<string, VehiclePassageTable | undefined> | null,
  state: Readonly<SessionState>,
  map: Readonly<MapDef>,
): VehiclePassageTable | undefined {
  if (!cache) return undefined;
  const variantId = state.interp.tileset;
  if (!variantId) return cache.get(map.id);
  const key = `${map.id}\u0000${variantId}`;
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) return cached;
  const effective = mapForTileset(map, variantId);
  if (!effective) throw new Error(`map ${map.id} has no tileset ${JSON.stringify(variantId)}`);
  const cooked = travel.buildVehiclePassage(effective);
  cache.set(key, cooked);
  return cooked;
}

/** RPG Maker treats parked boats and ships as character bodies, but not an
 * airship (the player must be able to enter its cell to board). */
export function passageWithParkedVehicles(
  base: PassageTable,
  state: Readonly<TravelState> | undefined,
  mapId: string,
): PassageTable {
  const vehicles = state?.vehicles;
  if (!vehicles) return base;
  let cells: number[] | undefined;
  for (const vehicle of vehicles.entries) {
    if (vehicle.id === vehicles.riding || vehicle.mapId !== mapId || vehicle.kind === "airship") continue;
    const { tx, ty } = vehicle.move;
    if (tx < 0 || ty < 0 || tx >= base.width || ty >= base.height) continue;
    (cells ??= []).push(ty * base.width + tx);
  }
  return cells ? stampBlockedCells(base, cells) : base;
}

function passageWithCharacterBodies(base: PassageTable, state: Readonly<SessionState>): PassageTable {
  const cells: number[] = [];
  const add = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < base.width && y < base.height) cells.push(y * base.width + x);
  };
  for (const ch of Object.values(state.chars.chars)) {
    if (!ch.blocks) continue;
    add(ch.tx, ch.ty);
    if (ch.moving) add(ch.tx + DX[ch.stepDir]!, ch.ty + DY[ch.stepDir]!);
  }
  return stampBlockedCells(base, cells);
}

export function travelMovementContext(
  state: Readonly<SessionState>,
  terrainPassage: PassageTable,
  ordinaryPassage: PassageTable,
  map: Readonly<MapDef>,
  cache: Map<string, VehiclePassageTable | undefined> | null,
  authoredSettings: Readonly<ResolvedMoveSettings>,
): TravelMovementContext {
  const current = state.travel;
  const ridden = travel.ridingVehicle(current);
  const settings: ResolvedMoveSettings = ridden
    ? {
        ...DEFAULT_MOVE_SETTINGS,
        speed: ridden.kind === "boat" ? 4 : ridden.kind === "ship" ? 5 : 6,
        through: ridden.kind === "airship",
      }
    : authoredSettings as ResolvedMoveSettings;
  const transition = (current?.vehicles?.boarding != null && !state.move.moving) ||
    (ridden?.kind === "airship" && current?.vehicles?.airshipPhase !== "cruising");
  const passage = ridden && ridden.kind !== "airship"
    ? passageWithParkedVehicles(
        vehicleMovementTable(
          terrainPassage,
          activeVehiclePassage(cache, state, map),
          ridden.kind,
        ) ?? blockedVehicleTable(terrainPassage),
        current,
        state.mapId,
      )
    : ordinaryPassage;
  return { riding: ridden, settings, transition, passage };
}

function startVehicleBgm(state: SessionState, bgm: Readonly<VehicleBgm> | null | undefined): void {
  if (bgm === undefined) return;
  const audio = (state.interp.audio ??= {});
  audio.walkingBgm = audio.bgm
    ? {
        id: audio.bgm.id,
        volume: audio.bgm.volume,
        pitch: audio.bgm.pitch,
        ...(audio.bgm.pan !== undefined ? { pan: audio.bgm.pan } : {}),
        positionTicks: audio.bgm.positionTicks,
      }
    : null;
  if (bgm === null) {
    delete audio.bgm;
  } else {
    audio.bgm = {
      id: bgm.id,
      volume: bgm.volume ?? 100,
      pitch: bgm.pitch ?? 100,
      ...(bgm.pan !== undefined && bgm.pan !== 0 ? { pan: bgm.pan } : {}),
      positionTicks: 0,
    };
  }
}

function finishVehicleBoarding(state: SessionState, current: Readonly<TravelState>): TravelState {
  const id = current.vehicles?.boarding;
  const vehicle = id == null ? undefined : current.vehicles?.entries.find((entry) => entry.id === id);
  const next = travel.completeVehicleBoarding(current)!;
  if (id != null && next.vehicles?.riding === id && next.vehicles.boarding == null) {
    startVehicleBgm(state, vehicle?.bgm);
  }
  return next;
}

function restoreWalkingBgm(state: SessionState): void {
  const audio = state.interp.audio;
  if (!audio || !Object.prototype.hasOwnProperty.call(audio, "walkingBgm")) return;
  if (audio.walkingBgm === null) delete audio.bgm;
  else if (audio.walkingBgm !== undefined) audio.bgm = { ...audio.walkingBgm };
  delete audio.walkingBgm;
  if (audioStateEmpty(audio)) delete state.interp.audio;
}

function beginTravelStep(state: SessionState, dir: Facing, cfg: Readonly<MovementConfig>): void {
  if (state.move.moving) return;
  const pixels = stepPixels(state.move.tx * cfg.tile, state.move.ty * cfg.tile, dir, 1, cfg);
  state.move = {
    ...state.move,
    facing: dir,
    phase: 1,
    moving: true,
    walking: true,
    stepDir: dir,
    ...pixels,
  };
}

export function beginTravelReferenceTick(
  state: SessionState,
  followers: Readonly<FollowersDef> | undefined,
  cfg: Readonly<MovementConfig>,
): string | null | undefined {
  let current = state.travel;
  if (current === undefined) return undefined;
  if (followers) {
    current = travel.reconcileFollowers(
      current,
      followers,
      state.sw.switches,
      state.move,
      state.sw.partyOrder,
    );
  }
  if (current.vehicles?.boarding && !current.followers?.gathering && !state.move.moving) {
    current = finishVehicleBoarding(state, current);
  }
  if (current.vehicles?.riding) current = travel.stepAirshipAltitude(current, cfg.tile)!;
  state.travel = current;
  return current.vehicles?.riding ?? null;
}

/** RPG Maker action priority: airship on the current cell, then ship/boat on
 * the faced cell. A refused landing leaves the action available to events. */
export function tryToggleVehicle(
  state: SessionState,
  map: Readonly<MapDef>,
  passage: PassageTable,
  cfg: Readonly<MovementConfig>,
  cache: Map<string, VehiclePassageTable | undefined> | null,
): boolean {
  if (!state.travel?.vehicles || state.move.moving) return false;
  if (state.travel.vehicles.boarding != null) return true;
  const ridden = travel.ridingVehicle(state.travel);
  if (!ridden) {
    const boardable = travel.boardableVehicle(state.travel, map.id, state.move);
    if (!boardable) return false;
    state.travel = travel.boardVehicle(state.travel, boardable.id)!;
    if (boardable.kind !== "airship") beginTravelStep(state, state.move.facing, cfg);
    return true;
  }

  const target = travel.vehicleDisembarkTarget(
    ridden.kind,
    passageWithCharacterBodies(passage, state),
    activeVehiclePassage(cache, state, map),
    state.move.tx,
    state.move.ty,
    state.move.facing,
  );
  if (!target) return false;
  if (ridden.kind === "airship" && state.travel.vehicles.airshipPhase !== "cruising") return false;
  state.travel = travel.syncRiddenVehicle(state.travel, map.id, state.move)!;
  state.travel = travel.leaveVehicle(state.travel)!;
  restoreWalkingBgm(state);
  if (ridden.kind !== "airship") beginTravelStep(state, state.move.facing, cfg);
  return true;
}

export function finishTravelMovement(
  state: SessionState,
  cfg: Readonly<MovementConfig>,
  origin: Readonly<{ x: number; y: number; moving: boolean }>,
): void {
  let current = state.travel;
  if (current === undefined) return;
  current = travel.stepFollowers(
    current,
    state.move,
    cfg,
    !origin.moving && state.move.moving ? { x: origin.x, y: origin.y } : undefined,
  )!;
  if (current.vehicles?.boarding && !current.followers?.gathering && !state.move.moving) {
    current = finishVehicleBoarding(state, current);
  }
  current = travel.syncRiddenVehicle(current, state.mapId, state.move)!;
  const drained = travel.drainCompletedGatherWaiters(current);
  if (drained.state) current = drained.state;
  state.travel = current;
  for (const waiter of drained.waiters) state.interp = continueExternal(state.interp, waiter);
  state.sw = state.interp.sw;
}

export function consumeTravelRequests(
  state: SessionState,
  map: Readonly<MapDef>,
  passage: PassageTable,
  cfg: Readonly<MovementConfig>,
  dimensions: MapDimensionsResolver,
  cache: Map<string, VehiclePassageTable | undefined> | null,
): void {
  const requests = state.interp.pendingTravel;
  if (!requests || requests.length === 0) return;
  for (const request of requests) {
    switch (request.op) {
      case "followers":
        state.travel = travel.setFollowersVisible(state.travel, request.visible);
        break;
      case "gatherFollowers":
        if (!state.travel?.followers) state.interp = continueExternal(state.interp, request.fiber);
        else state.travel = travel.gatherFollowers(state.travel, request.fiber)!;
        break;
      case "vehicle":
        tryToggleVehicle(state, map, passage, cfg, cache);
        break;
      case "setVehicleLocation": {
        const size = dimensions(request.map);
        if (!size || request.x >= size.width || request.y >= size.height) {
          state.interp.error = {
            kind: "content",
            message: `vehicle ${JSON.stringify(request.id)} location is outside map ${JSON.stringify(request.map)}`,
          };
          break;
        }
        state.travel = travel.relocateVehicle(
          state.travel,
          request.id,
          request.map,
          request.x,
          request.y,
          cfg,
        );
        break;
      }
      case "setVehicleImage":
        state.travel = travel.setVehicleImage(state.travel, request.id, request.sprite);
        break;
      case "setVehicleBgm":
        state.travel = travel.setVehicleBgm(state.travel, request.id, request.bgm);
        break;
    }
  }
  delete state.interp.pendingTravel;
  if (state.travel) {
    const drained = travel.drainCompletedGatherWaiters(state.travel);
    if (drained.state) state.travel = drained.state;
    for (const waiter of drained.waiters) state.interp = continueExternal(state.interp, waiter);
  }
}
