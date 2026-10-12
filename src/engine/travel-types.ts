/** JSON state and derived-table types shared with the optional travel reducer. */

import type { MovementState } from "./movement.ts";
import type { VehicleBgm, VehicleKind } from "./types.ts";

export interface FollowerTrailPoint {
  x: number;
  y: number;
}

export interface FollowerTravelState {
  id: string;
  sprite: string;
  move: MovementState;
  trail: FollowerTrailPoint[];
}

export interface FollowersTravelState {
  visible: boolean;
  gathering: boolean;
  gatherWaiters: string[];
  members: FollowerTravelState[];
}

export type AirshipPhase = "grounded" | "ascending" | "cruising" | "descending";

export interface VehicleTravelState {
  id: string;
  kind: VehicleKind;
  sprite: string;
  bgm?: VehicleBgm | null;
  mapId: string;
  move: MovementState;
}

export interface VehiclesTravelState {
  entries: VehicleTravelState[];
  boarding?: string | null;
  riding: string | null;
  airshipAltitude: number;
  airshipPhase: AirshipPhase;
  airshipPhaseTick: number;
}

export interface GatherWaiterDrain {
  state: TravelState | undefined;
  waiters: string[];
}

export interface TravelState {
  followers?: FollowersTravelState;
  vehicles?: VehiclesTravelState;
}

export interface VehiclePassageTable {
  width: number;
  height: number;
  boat?: Uint8Array;
  ship?: Uint8Array;
  airshipLand?: Uint8Array;
}

export interface SeamlessTravelRebase {
  sourceMapId: string;
  targetMapId: string;
  originX: number;
  originY: number;
  sourcePlayerX: number;
  sourcePlayerY: number;
  tileSize: number;
  targetPlayer: Readonly<MovementState>;
}

export interface VehicleDisembarkTarget {
  playerX: number;
  playerY: number;
  vehicleX: number;
  vehicleY: number;
}
