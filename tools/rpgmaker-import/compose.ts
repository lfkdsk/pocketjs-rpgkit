// tools/rpgmaker-import/compose.ts — flattens an RPG Maker map's four tile
// planes into the kit's two layers, one generated 16x16 tile per distinct
// stack.
//
// RPG Maker draws each cell as a stack (z0..z3, the shadow plane after z1,
// a table's legs from the cell above) and splits it the way the MV
// Tilemap's _paintTiles does: star tiles ([*] passage) go to the upper
// layer above characters, everything else to the lower layer. The kit has
// one ground tile and one upper tile per cell, so every distinct lower
// stack becomes one ground cell of a generated atlas sheet and every
// distinct star stack one upper cell. Passage is per ground cell
// (passage.ts), stored on the atlas so it lands in the sheet's dirBlock.
//
// Atlas keys are built from tile ids, shadow bits and the animation frame
// each tile shows, never from pixels: two stacks that look alike but pass
// differently stay distinct cells.

import type { Dir } from "../../src/engine/types.ts";
import {
  autotileKind,
  isTileA1,
  isTileA2,
  isTileA3,
  isTileA4,
  isWaterfallTile,
  TILE_ID_A5,
} from "./autotile.ts";
import type { Coverage, Disposition } from "./coverage.ts";
import { blankImage, type RgbaImage } from "./image.ts";
import { blockedDirs, RM_FLAG, terrainTag } from "./passage.ts";
import type { RmMap, RmTileset } from "./rm-types.ts";
import {
  downscale,
  drawShadow,
  drawTableEdge,
  drawTile,
  isShadowingTile,
  isTableTile,
  TILE_ANIM_SECONDS,
  tileFrameAt,
  tileFrameCount,
  tileSheetIndex,
  type TilesetImages,
} from "./tile-render.ts";

/** Kit cell size in pixels. */
export const CELL = 16;
const MAX_ROWS = 256;

export type TileFeature = "ladder" | "bush" | "counter";

const FEATURE_BIT: Readonly<Record<TileFeature, number>> = {
  ladder: 1,
  bush: 2,
  counter: 4,
};

/** A generated kit tile sheet of 16x16 cells, filled in first-use order. */
export class TileAtlas {
  readonly sheetId: string;
  readonly cols: number;
  private readonly cells: RgbaImage[] = [];
  private readonly passage: Dir[][] = [];
  private readonly features: number[] = [];
  private readonly index = new Map<string, number>();

  constructor(sheetId: string, cols = 32) {
    if (!Number.isInteger(cols) || cols < 1) throw new Error(`TileAtlas: bad column count ${cols}`);
    this.sheetId = sheetId;
    this.cols = cols;
  }

  get count(): number {
    return this.cells.length;
  }

  get rows(): number {
    return Math.max(1, Math.ceil(this.cells.length / this.cols));
  }

  /** The cell for `key`, drawing it (a 16x16 image) on first use. */
  intern(key: string, draw: () => RgbaImage, blocked: Dir[], features = 0): number {
    const hit = this.index.get(key);
    if (hit !== undefined) {
      if (this.features[hit] !== features) {
        throw new Error(`TileAtlas ${this.sheetId}: cell ${key} changed feature mask`);
      }
      return hit;
    }
    if (Math.ceil((this.cells.length + 1) / this.cols) > MAX_ROWS) {
      throw new Error(`TileAtlas ${this.sheetId}: more than ${MAX_ROWS} rows of ${this.cols} cells`);
    }
    const img = draw();
    if (img.width !== CELL || img.height !== CELL) {
      throw new Error(`TileAtlas ${this.sheetId}: cell ${key} is ${img.width}x${img.height}, not ${CELL}x${CELL}`);
    }
    const cell = this.cells.length;
    this.cells.push(img);
    this.passage.push(blocked.slice());
    this.features.push(features);
    this.index.set(key, cell);
    return cell;
  }

  /** Directions the cell blocks (its sheet dirBlock entry). */
  blocked(cell: number): Dir[] {
    return (this.passage[cell] ?? []).slice();
  }

  /** Sparse atlas cells carrying one RPG Maker tile feature. */
  featureCells(feature: TileFeature): number[] {
    const bit = FEATURE_BIT[feature];
    const out: number[] = [];
    for (let cell = 0; cell < this.features.length; cell++) {
      if ((this.features[cell]! & bit) !== 0) out.push(cell);
    }
    return out;
  }

  /** The sheet image: cols*16 x rows*16, cells left to right, top to
   *  bottom in intern order; unused cells are transparent. */
  toImage(): RgbaImage {
    const out = blankImage(this.cols * CELL, this.rows * CELL);
    this.cells.forEach((img, cell) => {
      const ox = (cell % this.cols) * CELL;
      const oy = Math.floor(cell / this.cols) * CELL;
      for (let y = 0; y < CELL; y++) {
        const from = y * CELL * 4;
        out.data.set(img.data.subarray(from, from + CELL * 4), ((oy + y) * out.width + ox) * 4);
      }
    });
    return out;
  }
}

export interface AnimatedCell {
  x: number;
  y: number;
  /** True for the upper (star) layer, false for ground. */
  above: boolean;
  /** Atlas cell per animation step; frames[0] is the static cell. */
  frames: number[];
  frameSeconds: number;
}

export interface ComposedMap {
  width: number;
  height: number;
  /** Atlas cell per map cell, row-major; null where no non-star tile is
   *  present (impassable in RPG Maker, a blocking void in the kit). */
  ground: (number | null)[];
  /** Sparse [cell index, atlas cell] of star stacks, drawn above
   *  characters. */
  upper: [number, number][];
  animated: AnimatedCell[];
  /** The z5 region plane, row-major. */
  regions: number[];
  /** Per-cell terrain tag (MV terrainTag: first nonzero tag scanning the
   *  four tile layers top-down), row-major. */
  terrain: number[];
}

/** One drawing step of a lower or upper stack. */
type Layer =
  | { kind: "tile"; id: number }
  | { kind: "shadow"; bits: number }
  | { kind: "edge"; id: number };

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

function stackFrames(layers: readonly Layer[]): number {
  let n = 1;
  for (const l of layers) if (l.kind === "tile") n = lcm(n, tileFrameCount(l.id));
  return n;
}

function stackKey(prefix: string, layers: readonly Layer[], step: number): string {
  const parts = layers.map((l) => {
    if (l.kind === "shadow") return `s${l.bits}`;
    if (l.kind === "edge") return `e${l.id}`;
    return tileFrameCount(l.id) > 1 ? `${l.id}@${tileFrameAt(l.id, step)}` : String(l.id);
  });
  return `${prefix}|${parts.join(",")}`;
}

/** The coverage key for one tile id's drawing construct. */
function tileConstruct(id: number, flags: readonly number[]): string | null {
  if (isTileA1(id)) return isWaterfallTile(id) ? "A1 waterfall" : "A1 water";
  if (isTileA2(id)) return isTableTile(id, flags) ? "A2 table" : "A2 ground";
  if (isTileA3(id)) return autotileKind(id) % 16 < 8 ? "A3 roof" : "A3 wall";
  if (isTileA4(id)) return autotileKind(id) % 16 < 8 ? "A4 wall top" : "A4 wall side";
  if (id >= TILE_ID_A5 && id < TILE_ID_A5 + 128) return "A5";
  if (id > 0 && id < 1024) return "B-E";
  return null;
}

export function composeMap(
  map: RmMap,
  tileset: RmTileset,
  images: TilesetImages,
  atlas: TileAtlas,
  cov: Coverage,
  recordCoverage = true,
): ComposedMap {
  const { width, height, data } = map;
  const flags = tileset.flags;
  const ts = images.tileSize;
  const factor = ts / CELL;
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`composeMap: tile size ${ts} is not a multiple of ${CELL}`);
  }
  const plane = width * height;
  const at = (x: number, y: number, z: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (data[z * plane + y * width + x] ?? 0);
  const flagOf = (id: number): number => flags[id] ?? 0;
  const isStar = (id: number): boolean => (flagOf(id) & RM_FLAG.STAR) !== 0;
  const featuresOf = (layers: readonly Layer[]): number => {
    let mask = 0;
    for (const layer of layers) {
      if (layer.kind !== "tile") continue;
      const flag = flagOf(layer.id);
      if ((flag & RM_FLAG.LADDER) !== 0) mask |= FEATURE_BIT.ladder;
      if ((flag & RM_FLAG.BUSH) !== 0) mask |= FEATURE_BIT.bush;
      if ((flag & RM_FLAG.COUNTER) !== 0) mask |= FEATURE_BIT.counter;
    }
    return mask;
  };
  const prefix = `t${tileset.id}`;

  const render = (layers: readonly Layer[], step: number) => (): RgbaImage => {
    const img = blankImage(ts, ts);
    for (const l of layers) {
      if (l.kind === "tile") drawTile(img, 0, 0, l.id, step, images, flags);
      else if (l.kind === "shadow") drawShadow(img, 0, 0, l.bits, ts);
      else drawTableEdge(img, 0, 0, l.id, images);
    }
    return downscale(img, factor);
  };

  const out: ComposedMap = { width, height, ground: [], upper: [], animated: [], regions: [], terrain: [] };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x;
      const stack = [0, 1, 2, 3].map((z) => at(x, y, z));
      const shadowBits = at(x, y, 4) & 0x0f;
      const region = at(x, y, 5);
      out.regions.push(region);
      // MV terrainTag: scan the four tile layers top-down (z3..z0) and take
      // the first nonzero tag (flags >> 12).
      let terrain = 0;
      for (let z = 3; z >= 0; z--) {
        const tag = terrainTag(flagOf(at(x, y, z)));
        if (tag !== 0) { terrain = tag; break; }
      }
      out.terrain.push(terrain);

      // MV _paintTiles order: z0, z1, shadow, table edge, z2, z3; star
      // tiles are pulled out into the upper stack in the same order.
      const lower: Layer[] = [];
      const upper: Layer[] = [];
      const place = (id: number): void => {
        if (id === 0) return;
        (isStar(id) ? upper : lower).push({ kind: "tile", id });
      };
      place(stack[0]!);
      place(stack[1]!);
      if (shadowBits !== 0) lower.push({ kind: "shadow", bits: shadowBits });
      const above1 = at(x, y - 1, 1);
      if (isTableTile(above1, flags) && !isTableTile(stack[1]!, flags) && !isShadowingTile(stack[0]!)) {
        lower.push({ kind: "edge", id: above1 });
      }
      place(stack[2]!);
      place(stack[3]!);

      // Decide after every lower layer is in: a shadow or a table's hanging
      // edge paints on its own even where no ordinary tile occupies the cell.
      if (lower.length > 0) {
        const blocked = blockedDirs(stack, flags);
        const features = featuresOf(lower);
        const n = stackFrames(lower);
        const frames: number[] = [];
        for (let s = 0; s < n; s++) frames.push(atlas.intern(stackKey(`${prefix}|g`, lower, s), render(lower, s), blocked, features));
        out.ground.push(frames[0]!);
        if (n > 1) out.animated.push({ x, y, above: false, frames, frameSeconds: TILE_ANIM_SECONDS });
      } else {
        out.ground.push(null);
      }

      if (upper.length > 0) {
        const features = featuresOf(upper);
        const n = stackFrames(upper);
        const frames: number[] = [];
        for (let s = 0; s < n; s++) frames.push(atlas.intern(stackKey(`${prefix}|u`, upper, s), render(upper, s), [], features));
        out.upper.push([cell, frames[0]!]);
        if (n > 1) out.animated.push({ x, y, above: true, frames, frameSeconds: TILE_ANIM_SECONDS });
      }

      if (recordCoverage) recordCell(cov, stack, shadowBits, region, flags, images);
    }
  }
  return out;
}

/** Coverage for one map cell: each construct present is recorded once. */
function recordCell(
  cov: Coverage,
  stack: readonly number[],
  shadowBits: number,
  region: number,
  flags: readonly number[],
  images: TilesetImages,
): void {
  const flagOf = (id: number): number => flags[id] ?? 0;
  const seen = new Set<string>();
  const rec = (key: string, d: Disposition, reason?: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    cov.record("tile", key, d, reason);
  };
  const ids = stack.filter((id) => id !== 0);
  for (const id of ids) {
    const construct = tileConstruct(id, flags);
    if (construct === null) {
      rec("invalid tile id", "Dropped", "the editor never writes this id; nothing is drawn");
      continue;
    }
    if (!images.sheets[tileSheetIndex(id)]) {
      rec("missing sheet", "Degraded", "tileset image missing; the tile is not drawn");
    } else {
      rec(construct, "Native");
    }
    if ((flagOf(id) & RM_FLAG.STAR) !== 0) rec("star (upper layer)", "Native");
  }
  if (shadowBits !== 0) rec("shadow", "Native");
  const any = (bit: number): boolean => ids.some((id) => (flagOf(id) & bit) !== 0);
  if (any(RM_FLAG.LADDER)) rec("ladder", "Native");
  if (any(RM_FLAG.BUSH)) rec("bush", "Native");
  if (any(RM_FLAG.COUNTER)) rec("counter", "Native");
  if (any(RM_FLAG.DAMAGE)) rec("damage floor", "Dropped", "damage floors are not modelled");
  if (ids.some((id) => terrainTag(flagOf(id)) !== 0)) rec("terrain tag", "Native");
  if (region !== 0) rec("region id", "Native");
}
