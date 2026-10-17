import { TILE } from "../engine/tiles.ts";

/** Actor coordinates and depth normalization for one paint plane. Positions
 * are map-local before offset; min/width describe the containing world. */
export interface ActorRenderSpace {
  offsetX: number;
  offsetY: number;
  minX: number;
  minY: number;
  width: number;
}

function depthStride(worldWidth: number): number {
  return Math.max(1, Math.floor(worldWidth) + 1);
}

/** Paint order for one actor, lexicographically sorted by (y, x). */
export function actorDepth(px: number, py: number, worldWidth: number): number {
  return Math.floor(py) * depthStride(worldWidth) + Math.floor(px);
}

/** Paint order for one upper row under the two-pixel foot-damage model.
 * It falls strictly after every actor at rowY + 1 and strictly before every
 * actor at rowY + 2. */
export function upperRowDepth(tileY: number, worldWidth: number): number {
  return (tileY * TILE + 2) * depthStride(worldWidth) - 1;
}

/** Project a map-local actor into a normalized world depth space. */
export function actorDepthInSpace(px: number, py: number, space: ActorRenderSpace): number {
  return actorDepth(
    space.offsetX + px - space.minX,
    space.offsetY + py - space.minY,
    space.width,
  );
}
