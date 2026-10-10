// src/engine/passability.ts — walkable/blocked lookup for P1②.
//
// Precedence, high to low:
//   1. map edge        — outside the width/height rectangle blocks
//   2. map.passage     — sparse [index, "pass"|"block"] overrides (fences
//                        painted on grass; a gate re-opening a fence cell)
//   3. ground void     — a null ground tile is a blocking void
//   4. sheet flags     — sheet.defaultPassage plus block[]/pass[] cell lists
//                        and dirBlock masks (data/schema.json sheet def)
//
// A dirBlock entry is authored on ONE tile but guards TWO edges of a step:
// the mask on the SOURCE tile forbids LEAVING through the named edge, and
// the same mask on the TARGET tile forbids ENTERING through that edge from
// outside. A step east crosses the source tile's "right" edge and the
// target tile's "left" edge, so both are checked (task-1206 contract).
//
// A sheet.dirEdges entry is ONE-SIDED: its "exit" list guards
// only leaving the cell it is authored on, its "enter" list only entering
// it, so an asymmetric edge (a ledge you may jump down but never climb, a
// one-way door) is expressible. dirBlock stays undirected; a crossing that
// either half forbids is blocked. Tuxemon data contains 1,161 relaxed reverse
// directions across 25 maps (G5 collision report).
//
// The upper star layer NEVER blocks (schema: "always walkable"); trees and
// fences collide through a ground/passage entry, not by being drawn.
//
// Pure TS: the sheet table is injected as a Map so this module has no
// project/schema dependency and runs under plain bun.

import type { Dir, MapDef, Sheet, TileId, TilePropertyOverride } from "./types.ts";
import { parseTileId } from "./tiles.ts";

export type Dir4 = 0 | 1 | 2 | 3; // 0 down, 1 left, 2 up, 3 right (Facing order)

/** Per-cell edge bit: 1<<Dir4 (1 down, 2 left, 4 up, 8 right). */
export type EdgeMask = number;
export const EDGE_BITS = [1, 2, 4, 8] as const;

/** Pre-cooked, allocation-free lookup for one map. The static terrain
 *  opinions (void, sheet block/pass/default, passage overrides and the
 *  directional edge masks) are resolved ONCE in buildPassage into flat
 *  typed arrays, so the per-tick mover and the per-cell BFS never parse a
 *  tile id or consult a Map on a hot edge: canStepFrom is a handful of
 *  array reads (keeping a 10,000-cell BFS inside a bounded frame budget). */
export interface PassageTable {
  width: number;
  height: number;
  /** Resolved per-cell override; 0 = no opinion (ground/sheet rule decides).
   *  Indexed row-major. Runtime authors must mutate it through
   *  setPassageOverride so the cooked terrain and edge arrays stay in sync. */
  overrides: Int8Array; // -1 block, 0 unset, 1 pass
  /** Direction-agnostic terrain opinion per cell: 1 = the cell cannot be
   *  entered/stood on (void, sheet block/default-block, a "block"
   *  override); a "pass" override or a sheet pass cell stays 0. */
  solid: Uint8Array;
  /** Per-cell edge bits that forbid ENTERING the cell through that edge
   *  (target-side guard): one-sided dirEdges.enter plus legacy dirBlock when
   *  target-side passage precedence does not explicitly reopen the cell. */
  entryMask: Uint8Array;
  /** Per-cell edge bits that forbid LEAVING the cell through that edge
   *  (source-side guard): undirected dirBlock plus one-sided dirEdges.exit;
   *  source edges remain active across terrain passage overrides. */
  exitMask: Uint8Array;
  /** Transient blockers such as event bodies. Kept sparse so adding a small
   *  number of characters never copies or scans the whole map. */
  bodyBlocks?: ReadonlySet<number>;
  ground: readonly TileId[];
  sheets: ReadonlyMap<string, Sheet>;
}

export const BLOCK = -1;
export const PASS = 1;
export type PassageOverride = typeof BLOCK | 0 | typeof PASS;

const DIR_NAMES = ["down", "left", "up", "right"] as const;

function edgeMaskOf(dirs: readonly Dir[]): EdgeMask {
  let mask: EdgeMask = 0;
  for (const name of dirs) mask |= EDGE_BITS[DIR_NAMES.indexOf(name) as Dir4]!;
  return mask;
}

/** Direction-agnostic "may this tile be stood on" sheet opinion. */
function sheetCellSolid(sheet: Sheet | undefined, cell: number): boolean {
  if (!sheet) return false; // unknown sheet: ground is walkable
  if (sheet.pass?.includes(cell)) return false;
  if (sheet.block?.includes(cell)) return true;
  return sheet.defaultPassage === "block";
}

// Static opinions packed into one small integer so buildPassage can cache a
// tile id without allocating an object per distinct tile. Bit 0 is solid,
// bits 1..4 are target-side entry edges, and bits 5..8 are source-side exit
// edges. The sheet.pass exception is already folded into the entry mask.
const OPINION_ENTRY_SHIFT = 1;
const OPINION_EXIT_SHIFT = 5;
const OPINION_MASK = 0b1111;

function tileOpinion(tile: string, sheets: ReadonlyMap<string, Sheet>): number {
  const { sheet: sheetId, cell } = parseTileId(tile);
  const sheet = sheets.get(sheetId);
  const named = sheet?.dirBlock?.[String(cell)];
  const edged = sheet?.dirEdges?.[String(cell)];
  let undirected: EdgeMask = 0;
  let directedEntry: EdgeMask = 0;
  let directedExit: EdgeMask = 0;
  if (named) for (const name of named) undirected |= EDGE_BITS[DIR_NAMES.indexOf(name) as Dir4]!;
  if (edged?.enter) for (const name of edged.enter) directedEntry |= EDGE_BITS[DIR_NAMES.indexOf(name) as Dir4]!;
  if (edged?.exit) for (const name of edged.exit) directedExit |= EDGE_BITS[DIR_NAMES.indexOf(name) as Dir4]!;
  const entry = directedEntry | (sheet?.pass?.includes(cell) ? 0 : undirected);
  const exit = undirected | directedExit;
  return (sheetCellSolid(sheet, cell) ? 1 : 0) |
    (entry << OPINION_ENTRY_SHIFT) |
    (exit << OPINION_EXIT_SHIFT);
}

/** Re-cook one cell after its override changes. Source-side edges are kept
 *  even on solid/overridden cells, matching the legacy dirBlock contract;
 *  a PASS override suppresses only target-side entry opinions. */
function cookPassageCell(table: PassageTable, idx: number): void {
  table.solid[idx] = 0;
  table.entryMask[idx] = 0;
  table.exitMask[idx] = 0;

  const tile = table.ground[idx] ?? null;
  if (tile === null) {
    if (table.overrides[idx] !== PASS) table.solid[idx] = 1;
    return;
  }

  const opinion = tileOpinion(tile, table.sheets);
  table.exitMask[idx] = (opinion >> OPINION_EXIT_SHIFT) & OPINION_MASK;

  const over = table.overrides[idx];
  if (over === PASS) return; // reopen target terrain/entry, retain source exit
  if (over === BLOCK || (opinion & 1) !== 0) {
    table.solid[idx] = 1;
    return;
  }

  table.entryMask[idx] = (opinion >> OPINION_ENTRY_SHIFT) & OPINION_MASK;
}

export function buildPassage(map: MapDef, sheets: ReadonlyMap<string, Sheet>): PassageTable {
  const n = map.width * map.height;
  const table: PassageTable = {
    width: map.width,
    height: map.height,
    overrides: new Int8Array(n),
    solid: new Uint8Array(n),
    entryMask: new Uint8Array(n),
    exitMask: new Uint8Array(n),
    ground: map.ground,
    sheets,
  };
  const overrides = table.overrides;
  for (const [idx, flag] of map.passage ?? []) {
    if (idx < 0 || idx >= n) {
      throw new Error(`passage index ${idx} outside ${map.id} (${map.width}x${map.height})`);
    }
    overrides[idx] = flag === "block" ? BLOCK : PASS;
  }

  // Maps reuse a small set of tile ids across many cells. Resolve each tile's
  // sheet lists and directional masks once, then keep the per-cell loop to
  // override precedence plus flat typed-array writes.
  const solid = table.solid;
  const entryMask = table.entryMask;
  const exitMask = table.exitMask;
  const ground = map.ground;
  const opinions = new Map<string, number>();
  let previousTile: string | null = null;
  let previousOpinion = 0;
  for (let idx = 0; idx < n; idx++) {
    const tile = ground[idx] ?? null;
    const over = overrides[idx];
    if (tile === null) {
      if (over !== PASS) solid[idx] = 1;
      continue;
    }

    let opinion = previousOpinion;
    if (tile !== previousTile) {
      const cached = opinions.get(tile);
      opinion = cached === undefined ? tileOpinion(tile, sheets) : cached;
      if (cached === undefined) opinions.set(tile, opinion);
      previousTile = tile;
      previousOpinion = opinion;
    }
    exitMask[idx] = (opinion >> OPINION_EXIT_SHIFT) & OPINION_MASK;
    if (over === PASS) continue;
    if (over === BLOCK || (opinion & 1) !== 0) {
      solid[idx] = 1;
      continue;
    }
    entryMask[idx] = (opinion >> OPINION_ENTRY_SHIFT) & OPINION_MASK;
  }
  return table;
}

/** Change one live map-passage override and immediately synchronize every
 *  cooked lookup used by movement and pathfinding. `0` clears the override
 *  and restores the cell's sheet terrain and directional edge opinions. */
export function setPassageOverride(
  table: PassageTable,
  idx: number,
  flag: PassageOverride,
): void {
  if (!Number.isInteger(idx) || idx < 0 || idx >= table.overrides.length) {
    throw new Error(`passage index ${idx} outside ${table.width}x${table.height}`);
  }
  if (flag !== BLOCK && flag !== 0 && flag !== PASS) {
    throw new Error(`invalid passage override ${flag}`);
  }
  table.overrides[idx] = flag;
  cookPassageCell(table, idx);
}

/** Immutable runtime view of an authored passage table. Only maps that have
 * live tile-property changes pay for the typed-array copies; absent/empty
 * overrides return `base` by identity. Runtime enter/exit lists replace the
 * corresponding cooked static edge mask, while a passage `pass` keeps the
 * existing rule of reopening target terrain/entry but retaining source
 * exits unless an explicit runtime exit list replaces them. */
export function withTilePropertyOverrides(
  base: PassageTable,
  overrides: Readonly<Record<string, TilePropertyOverride>> | undefined,
): PassageTable {
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const table: PassageTable = {
    ...base,
    overrides: base.overrides.slice(),
    solid: base.solid.slice(),
    entryMask: base.entryMask.slice(),
    exitMask: base.exitMask.slice(),
  };
  for (const key of Object.keys(overrides)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= table.overrides.length || String(idx) !== key) {
      throw new Error(`runtime tile-property index ${JSON.stringify(key)} outside ${table.width}x${table.height}`);
    }
    const patch = overrides[key]!;
    if (patch.passage !== undefined) {
      setPassageOverride(table, idx, patch.passage === "pass" ? PASS : BLOCK);
    }
    if (patch.enter !== undefined) table.entryMask[idx] = edgeMaskOf(patch.enter);
    if (patch.exit !== undefined) table.exitMask[idx] = edgeMaskOf(patch.exit);
  }
  return table;
}

const OPPOSITE: readonly Dir4[] = [2, 3, 0, 1]; // down<->up, left<->right
const DX4 = [0, -1, 0, 1] as const; // down, left, up, right
const DY4 = [1, 0, -1, 0] as const;

/** Does the cell at (tx, ty) forbid LEAVING through `exit`? Reads the cooked
 *  source-side mask (undirected dirBlock + one-sided dirEdges.exit). Out of
 *  range is not the source's own edge, so it reports false; canStepFrom's
 *  destination bounds check then refuses the step. */
export function cellBlocksExit(table: PassageTable, tx: number, ty: number, exit: Dir4): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  return (table.exitMask[ty * table.width + tx]! & EDGE_BITS[exit]) !== 0;
}

/** Does the cell at (tx, ty) forbid ENTERING through its `entry` edge?
 *  Reads the cooked target-side mask (undirected dirBlock + one-sided
 *  dirEdges.enter). A tile authored with dirBlock ["left"] keeps every mover
 *  OUT from the west even when its terrain is otherwise open; a
 *  dirEdges.enter ["left"] does the same one-sidedly. */
export function cellBlocksEntry(table: PassageTable, tx: number, ty: number, entry: Dir4): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  return (table.entryMask[ty * table.width + tx]! & EDGE_BITS[entry]) !== 0;
}

/** Is the cell at (tx, ty) walkable when entering it through its optional
 *  `entry` edge (the target-cell side of the crossing; omit it for a
 *  direction-agnostic terrain lookup)? Out-of-range coordinates block
 *  rather than throw: a tape must never crash because a mover reached the
 *  edge. All reads are pre-cooked typed arrays (the hot BFS path). */
export function canEnter(table: PassageTable, tx: number, ty: number, entry?: Dir4): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  const idx = ty * table.width + tx;
  if (table.bodyBlocks?.has(idx)) return false;
  if (table.solid[idx]) return false;
  if (entry !== undefined && (table.entryMask[idx]! & EDGE_BITS[entry]) !== 0) return false;
  return true;
}

/** Capability-gated target check for a trusted seamless opening. This is
 * deliberately narrower than a passage override: it ignores only the
 * cooked solid-terrain opinion. Bounds, blocking character bodies and the
 * target-side entry edge remain authoritative. */
export function canEnterIgnoringTerrainSolid(
  table: PassageTable,
  tx: number,
  ty: number,
  entry?: Dir4,
): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  const idx = ty * table.width + tx;
  if (table.bodyBlocks?.has(idx)) return false;
  if (entry !== undefined && (table.entryMask[idx]! & EDGE_BITS[entry]) !== 0) return false;
  return true;
}

/** Full step decision for a character STANDING on (fx, fy): it may move to
 *  the adjacent cell in `dir` only when BOTH directional edges of the
 *  crossing are open — the source cell does not forbid the exit (cooked
 *  exitMask: dirBlock + dirEdges.exit) AND the target cell does not forbid
 *  entering through its opposite edge (cooked entryMask) — and the
 *  destination is in bounds, unoccupied and not solid (the existing
 *  dual-edge contract, extended by one-sided edges). */
export function canStepFrom(table: PassageTable, fx: number, fy: number, dir: Dir4): boolean {
  if ((table.exitMask[fy * table.width + fx]! & EDGE_BITS[dir]) !== 0) return false;
  // The target is entered through its OPPOSITE edge: a step east crosses the
  // target's left edge, so canEnter must receive the target-side edge.
  return canEnter(table, fx + DX4[dir], fy + DY4[dir], OPPOSITE[dir]);
}

/** Return a table whose given row-major cells are forced BLOCK on top of the
 *  base opinions (a blocking event body standing on otherwise-passable
 *  ground). A map.passage "pass" override reopens terrain but never lets the
 *  mover walk through such a character. The base table is not mutated. */
export function stampBlockedCells(base: PassageTable, cells: Iterable<number>): PassageTable {
  const bodyBlocks = new Set(base.bodyBlocks);
  for (const idx of cells) {
    if (idx >= 0 && idx < base.overrides.length) bodyBlocks.add(idx);
  }
  return { ...base, bodyBlocks };
}

/** Direction-agnostic standability: bounds and the cooked solid opinion
 *  (void, sheet block/default-block, a "block" override, a stamped body),
 *  but NOT the directional edge masks. A character that legally entered a
 *  cell may stand on it facing any direction; the save-restore gate must
 *  accept that snapshot even when the current facing is one the cell
 *  forbids ENTRY from. */
export function isStandable(table: PassageTable, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= table.width || ty >= table.height) return false;
  const idx = ty * table.width + tx;
  if (table.bodyBlocks?.has(idx)) return false;
  return table.solid[idx] === 0;
}
