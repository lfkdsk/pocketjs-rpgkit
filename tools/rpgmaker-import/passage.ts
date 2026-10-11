// tools/rpgmaker-import/passage.ts — RPG Maker MV/MZ tile passage flags and
// the per-cell blocked directions the kit's sheet `dirBlock` takes.
//
// Tilesets.json stores one bit field per tile id. The low four bits block
// a direction (set = impassable that way); 0x10 is the star ("[*]": drawn
// above characters and ignored by passage); the rest are attributes. The
// terrain tag lives in bits 12..15.

import type { Dir } from "../../src/engine/types.ts";

export const RM_FLAG = {
  DOWN: 0x1,
  LEFT: 0x2,
  RIGHT: 0x4,
  UP: 0x8,
  STAR: 0x10,
  LADDER: 0x20,
  BUSH: 0x40,
  COUNTER: 0x80,
  DAMAGE: 0x100,
  BOAT: 0x200,
  SHIP: 0x400,
  AIRSHIP: 0x800,
} as const;

/** Terrain tag 0..7 of a flag word (MV Game_Map.terrainTag reads
 *  flags >> 12). */
export const terrainTag = (flag: number): number => flag >> 12;

const DIR_BITS: readonly (readonly [Dir, number])[] = [
  ["down", RM_FLAG.DOWN],
  ["left", RM_FLAG.LEFT],
  ["right", RM_FLAG.RIGHT],
  ["up", RM_FLAG.UP],
];

/** MV Game_Map.checkPassage for one bit over a cell's tiles, given bottom
 *  to top (z0..z3): the topmost tile that is neither empty nor a star
 *  decides (all queried bits clear = pass, all queried bits set = block).
 *  A partial match continues to the next tile, which matters for MV's
 *  combined 0x0f airship-landing query. A cell with no deciding tile is
 *  impassable.
 *
 *  MV skips nothing but stars; tile id 0 is skipped here because the
 *  editor pins B's first tile (id 0, the empty cell) as a star, so both
 *  readings agree on real data and a hand-written flags array without
 *  that entry still behaves like the editor. */
export function passes(stackBottomToTop: readonly number[], flags: readonly number[], bit: number): boolean {
  for (let i = stackBottomToTop.length - 1; i >= 0; i--) {
    const id = stackBottomToTop[i]!;
    if (id === 0) continue;
    const flag = flags[id] ?? 0;
    if ((flag & RM_FLAG.STAR) !== 0) continue;
    const masked = flag & bit;
    if (masked === 0) return true;
    if (masked === bit) return false;
  }
  return false;
}

/** Directions a cell blocks, in the order down, left, right, up.
 *
 *  MV moves a character from A to B in direction d only when A passes the
 *  bit for d and B passes the bit for the reverse of d
 *  (Game_CharacterBase.isMapPassable). The kit's sheet `dirBlock` has the
 *  same undirected meaning: a cell's entry forbids leaving through the
 *  named edge and entering through that edge from outside. So a cell's
 *  blocked list here is its dirBlock entry as is. */
export function blockedDirs(stackBottomToTop: readonly number[], flags: readonly number[]): Dir[] {
  const out: Dir[] = [];
  for (const [dir, bit] of DIR_BITS) {
    if (!passes(stackBottomToTop, flags, bit)) out.push(dir);
  }
  return out;
}
