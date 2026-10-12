/** Type-only capability boundary for the optional follower/vehicle reducer. */

import type { MovementConfig, MovementState } from "./movement.ts";
import type { ResolvedMoveSettings } from "./move-control.ts";
import type { Dir4, PassageTable } from "./passability.ts";
import type { SessionState } from "./session.ts";
import type { FollowersDef, MapDef, Project, VehicleBgm } from "./types.ts";
import type {
  GatherWaiterDrain,
  SeamlessTravelRebase,
  TravelState,
  VehicleDisembarkTarget,
  VehiclePassageTable,
  VehicleTravelState,
} from "./travel-types.ts";

export type MapDimensionsResolver = (
  mapId: string,
) => Readonly<{ width: number; height: number }> | null;

type TravelCoordinate = number | { readonly variable: string };
type TravelMap = string | { readonly variable: string };

/** Compiled travel instructions are kept structural here so the ordinary
 * interpreter can delegate their authored-value rules without importing the
 * concrete follower/vehicle reducer. */
export type TravelInstruction =
  | { readonly op: "followers"; readonly visible: boolean }
  | { readonly op: "gatherFollowers" }
  | { readonly op: "vehicle"; readonly action: "toggle" }
  | {
      readonly op: "setVehicleLocation";
      readonly id: string;
      readonly map: TravelMap;
      readonly x: TravelCoordinate;
      readonly y: TravelCoordinate;
    }
  | { readonly op: "setVehicleImage"; readonly id: string; readonly sprite: string }
  | { readonly op: "setVehicleBgm"; readonly id: string; readonly bgm: Readonly<VehicleBgm> | null };

export type PendingTravelRequest =
  | { op: "followers"; visible: boolean }
  | { op: "gatherFollowers"; fiber: string }
  | { op: "vehicle"; action: "toggle" }
  | { op: "setVehicleLocation"; id: string; map: string; x: number; y: number }
  | { op: "setVehicleImage"; id: string; sprite: string }
  | { op: "setVehicleBgm"; id: string; bgm: VehicleBgm | null };

export type TravelPublishResult =
  | { readonly request: PendingTravelRequest; readonly wait: boolean }
  | { readonly error: string };

export interface TravelCommandRuntime {
  publishTravelRequest(
    instruction: TravelInstruction,
    variables: Readonly<Record<string, number | string>>,
    fiber: string,
  ): TravelPublishResult;
}

export interface TravelMovementContext {
  riding: Readonly<VehicleTravelState> | null;
  settings: ResolvedMoveSettings;
  transition: boolean;
  passage: PassageTable;
}

/** Project-bound facade used by Session. Authored definitions and derived
 * vehicle passage tables live in the opt-in module, so walking-only bundles
 * retain only one nullable capability reference. */
export interface TravelSessionRuntime extends TravelCommandRuntime {
  fork(): TravelSessionRuntime;
  mapAcquired(map: Readonly<MapDef>): void;
  mapsAcquired(maps: readonly Readonly<MapDef>[]): void;
  releaseMapsExcept(keep: ReadonlySet<string>): void;
  createTravelState(
    player: Readonly<MovementState>,
    cfg: Readonly<MovementConfig>,
    switches?: Readonly<Record<string, boolean>>,
  ): TravelState | undefined;
  cloneTravelState(state: Readonly<TravelState>): TravelState;
  reconcileFollowers(
    state: Readonly<TravelState>,
    switches: Readonly<Record<string, boolean>>,
    leader: Readonly<MovementState>,
    partyOrder?: readonly number[],
  ): TravelState;
  beginTravelReferenceTick(state: SessionState, cfg: Readonly<MovementConfig>): string | null | undefined;
  passageWithParkedVehicles(
    base: PassageTable,
    state: Readonly<TravelState> | undefined,
    mapId: string,
  ): PassageTable;
  rebaseTravelAfterSeamless(
    state: Readonly<TravelState> | undefined,
    rebase: Readonly<SeamlessTravelRebase>,
  ): TravelState | undefined;
  syncTravelAfterTransfer(
    state: Readonly<TravelState> | undefined,
    mapId: string,
    player: Readonly<MovementState>,
  ): TravelState | undefined;
  travelMovementContext(
    state: Readonly<SessionState>,
    terrainPassage: PassageTable,
    ordinaryPassage: PassageTable,
    map: Readonly<MapDef>,
    authoredSettings: Readonly<ResolvedMoveSettings>,
  ): TravelMovementContext;
  tryToggleVehicle(
    state: SessionState,
    map: Readonly<MapDef>,
    passage: PassageTable,
    cfg: Readonly<MovementConfig>,
  ): boolean;
  finishTravelMovement(
    state: SessionState,
    cfg: Readonly<MovementConfig>,
    origin: Readonly<{ x: number; y: number; moving: boolean }>,
  ): void;
  consumeTravelRequests(
    state: SessionState,
    map: Readonly<MapDef>,
    passage: PassageTable,
    cfg: Readonly<MovementConfig>,
    dimensions: MapDimensionsResolver,
  ): void;
}

export interface TravelRuntime extends TravelCommandRuntime {
  bind(project: Pick<Project, "followers" | "vehicles">): TravelSessionRuntime;
  activeVehiclePassage(
    cache: Map<string, VehiclePassageTable | undefined> | null,
    state: Readonly<SessionState>,
    map: Readonly<MapDef>,
  ): VehiclePassageTable | undefined;
  beginTravelReferenceTick(
    state: SessionState,
    followers: Readonly<FollowersDef> | undefined,
    cfg: Readonly<MovementConfig>,
  ): string | null | undefined;
  boardableVehicle(
    state: Readonly<TravelState> | undefined,
    mapId: string,
    player: Readonly<MovementState>,
  ): Readonly<VehicleTravelState> | null;
  boardVehicle(state: Readonly<TravelState> | undefined, id: string): TravelState | undefined;
  buildVehiclePassage(map: Readonly<MapDef>): VehiclePassageTable | undefined;
  cloneTravelState(state: Readonly<TravelState>): TravelState;
  completeVehicleBoarding(state: Readonly<TravelState> | undefined): TravelState | undefined;
  createTravelState(
    project: Pick<Project, "followers" | "vehicles">,
    player: Readonly<MovementState>,
    cfg: Readonly<MovementConfig>,
    switches?: Readonly<Record<string, boolean>>,
  ): TravelState | undefined;
  drainCompletedGatherWaiters(state: Readonly<TravelState> | undefined): GatherWaiterDrain;
  finishTravelMovement(
    state: SessionState,
    cfg: Readonly<MovementConfig>,
    origin: Readonly<{ x: number; y: number; moving: boolean }>,
  ): void;
  gatherFollowers(state: Readonly<TravelState> | undefined, waiter?: string): TravelState | undefined;
  leaveVehicle(state: Readonly<TravelState> | undefined): TravelState | undefined;
  passageWithParkedVehicles(
    base: PassageTable,
    state: Readonly<TravelState> | undefined,
    mapId: string,
  ): PassageTable;
  rebaseTravelAfterSeamless(
    state: Readonly<TravelState> | undefined,
    rebase: Readonly<SeamlessTravelRebase>,
  ): TravelState | undefined;
  reconcileFollowers(
    state: Readonly<TravelState>,
    definition: Readonly<FollowersDef>,
    switches: Readonly<Record<string, boolean>>,
    leader: Readonly<MovementState>,
    partyOrder?: readonly number[],
  ): TravelState;
  relocateVehicle(
    state: Readonly<TravelState> | undefined,
    id: string,
    mapId: string,
    x: number,
    y: number,
    cfg: Readonly<MovementConfig>,
    facing?: Dir4,
  ): TravelState | undefined;
  ridingVehicle(state: Readonly<TravelState> | undefined): Readonly<VehicleTravelState> | null;
  setFollowersVisible(state: Readonly<TravelState> | undefined, visible: boolean): TravelState | undefined;
  setVehicleBgm(
    state: Readonly<TravelState> | undefined,
    id: string,
    bgm: Readonly<VehicleBgm> | null,
  ): TravelState | undefined;
  setVehicleImage(
    state: Readonly<TravelState> | undefined,
    id: string,
    sprite: string,
  ): TravelState | undefined;
  stepAirshipAltitude(
    state: Readonly<TravelState> | undefined,
    cruiseAltitude: number,
  ): TravelState | undefined;
  stepFollowers(
    state: Readonly<TravelState> | undefined,
    leader: Readonly<MovementState>,
    cfg: Readonly<MovementConfig>,
    leaderStepOrigin?: Readonly<{ x: number; y: number }>,
  ): TravelState | undefined;
  syncRiddenVehicle(
    state: Readonly<TravelState> | undefined,
    mapId: string,
    player: Readonly<MovementState>,
  ): TravelState | undefined;
  syncTravelAfterTransfer(
    state: Readonly<TravelState> | undefined,
    mapId: string,
    player: Readonly<MovementState>,
  ): TravelState | undefined;
  travelMovementContext(
    state: Readonly<SessionState>,
    terrainPassage: PassageTable,
    ordinaryPassage: PassageTable,
    map: Readonly<MapDef>,
    cache: Map<string, VehiclePassageTable | undefined> | null,
    authoredSettings: Readonly<ResolvedMoveSettings>,
  ): TravelMovementContext;
  tryToggleVehicle(
    state: SessionState,
    map: Readonly<MapDef>,
    passage: PassageTable,
    cfg: Readonly<MovementConfig>,
    cache: Map<string, VehiclePassageTable | undefined> | null,
  ): boolean;
  consumeTravelRequests(
    state: SessionState,
    map: Readonly<MapDef>,
    passage: PassageTable,
    cfg: Readonly<MovementConfig>,
    dimensions: MapDimensionsResolver,
    cache: Map<string, VehiclePassageTable | undefined> | null,
  ): void;
  vehicleDisembarkTarget(
    kind: VehicleTravelState["kind"],
    passage: Readonly<PassageTable>,
    vehiclePassage: Readonly<VehiclePassageTable> | undefined,
    x: number,
    y: number,
    direction: Dir4,
  ): VehicleDisembarkTarget | null;
}
