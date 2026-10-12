// Small browser-safe RPG Maker project semantics shared by all loaders.

import type { RmProject } from "./rm-types.ts";

/** MV is always 48 px; MZ stores the tile size in System.json. */
export function rmTileSize(rm: RmProject): number {
  return rm.system.tileSize ?? 48;
}

/** Convert RPG Maker's source-pixel parallax rate to the kit's 16 px grid. */
export function rmParallaxSpeed(rm: RmProject, speed: number): number {
  return speed * 16 / rmTileSize(rm);
}
