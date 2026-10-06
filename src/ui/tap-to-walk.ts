// src/ui/tap-to-walk.ts — tap-to-walk for GameView: a host pointer tap on the
// world map becomes a walking route. The view polls the host's pointer
// service lines (the web player sends {t:"mouse",...} for canvas taps and
// the desktop host for clicks), converts a tap to a tile, plans one BFS over
// the session's passage table, and then folds one direction bit per frame
// until the player arrives or gets stuck. The route is view-local state: it
// never enters the reducer, so saves, rewind and attract tapes are untouched.

import { BTN } from "@pocketjs/framework/input";
import { bfsPath } from "../engine/pathfind.ts";
import type { Dir4, PassageTable } from "../engine/passability.ts";

/** Dir4 numeric order (0 down, 1 left, 2 up, 3 right) -> PocketJS button
 *  bit, so a planned step folds through the same mask as a held d-pad. */
export const TAP_WALK_DIR_BITS: readonly number[] = [BTN.DOWN, BTN.LEFT, BTN.UP, BTN.RIGHT];

export interface TapWalkRoute {
  dirs: Dir4[];
  index: number;
  mapId: string;
  targetTx: number;
  targetTy: number;
  /** Tile the current step starts from; advances when the player enters it. */
  stepTx: number;
  stepTy: number;
  /** Reference ticks without sub-pixel progress; a dynamic blocker clears. */
  stuck: number;
  lastPx: number;
  lastPy: number;
}

/** Plan a route to the tapped tile. Null when the tile is the player's own
 *  or unreachable (the caller then simply keeps still). */
export function startTapWalk(
  table: PassageTable,
  fromTx: number,
  fromTy: number,
  toTx: number,
  toTy: number,
  mapId: string,
  px: number,
  py: number,
): TapWalkRoute | null {
  if (fromTx === toTx && fromTy === toTy) return null;
  const dirs = bfsPath(table, fromTx, fromTy, toTx, toTy);
  if (!dirs || dirs.length === 0) return null;
  return {
    dirs,
    index: 0,
    mapId,
    targetTx: toTx,
    targetTy: toTy,
    stepTx: fromTx,
    stepTy: fromTy,
    stuck: 0,
    lastPx: px,
    lastPy: py,
  };
}

export interface TapWalkStep {
  /** Direction to hold this tick; null when the route is finished. */
  dir: Dir4 | null;
  /** False when the route is over (arrived, or stuck long enough). */
  alive: boolean;
}

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
/** 1.5 reference seconds without sub-pixel progress: a moving body blocked
 *  the planned step and the route is not coming back on its own. */
const STUCK_LIMIT = 90;

/** Advance the plan by the player's current tile and report the direction
 *  to hold this tick. Mutates the route's bookkeeping only. */
export function stepTapWalk(
  route: TapWalkRoute,
  tx: number,
  ty: number,
  px: number,
  py: number,
): TapWalkStep {
  if (tx === route.targetTx && ty === route.targetTy) return { dir: null, alive: false };
  // The player entered the next tile: advance the plan.
  while (route.index < route.dirs.length) {
    const dir = route.dirs[route.index]!;
    const nx = route.stepTx + DX[dir];
    const ny = route.stepTy + DY[dir];
    if (tx !== nx || ty !== ny) break;
    route.index++;
    route.stepTx = nx;
    route.stepTy = ny;
    if (route.index >= route.dirs.length) return { dir: null, alive: false };
  }
  // A dynamic body blocking the planned step freezes the mover; give up
  // instead of holding a dead direction forever.
  if (px === route.lastPx && py === route.lastPy) {
    route.stuck++;
    if (route.stuck >= STUCK_LIMIT) return { dir: null, alive: false };
  } else {
    route.stuck = 0;
    route.lastPx = px;
    route.lastPy = py;
  }
  return { dir: route.dirs[route.index]!, alive: true };
}
