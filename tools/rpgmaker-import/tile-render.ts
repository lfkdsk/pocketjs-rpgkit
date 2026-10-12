// tools/rpgmaker-import/tile-render.ts — draws one RPG Maker MV/MZ map tile
// into an RGBA image, a port of the MV Tilemap's _drawTile,
// _drawNormalTile, _drawAutotile, _drawTableEdge and _drawShadow (MZ's
// Tilemap computes the same source rectangles, moving only the A1
// animation offsets into its shader).
//
// Everything is drawn at the project's native tile size (48 in MV, 48 or
// another size from System.tileSize in MZ); `downscale` reduces a finished
// cell to the kit's 16x16 grid. Animated water is drawn one animation step
// at a time: the caller asks for step 0, 1, 2 ... and gets the frame RPG
// Maker shows at animationFrame = step.

import {
  autotileKind,
  autotileShape,
  FLOOR_AUTOTILE_TABLE,
  isAutotile,
  isTileA1,
  isTileA2,
  isTileA3,
  isTileA4,
  TILE_ID_A1,
  TILE_ID_A5,
  TILE_ID_MAX,
  WALL_AUTOTILE_TABLE,
  WATERFALL_AUTOTILE_TABLE,
  type QuarterTable,
} from "./autotile.ts";
import type { RpgMakerImportEnvironment } from "./environment.ts";
import { blankImage, blit, type RgbaImage } from "./image.ts";
import type { RpgMakerMediaEncryption } from "./media-crypto.ts";

/** The nine tileset sheets in RPG Maker order: A1, A2, A3, A4, A5, B, C, D,
 *  E. A null sheet has no image (unset in the tileset or missing on disk). */
export interface TilesetImages {
  tileSize: number;
  sheets: (RgbaImage | null)[];
}

/** Sheet indices into TilesetImages.sheets. */
export const SHEET_A1 = 0;
export const SHEET_A2 = 1;
export const SHEET_A3 = 2;
export const SHEET_A4 = 3;
export const SHEET_A5 = 4;

/** Seconds per animation step: the MV/MZ Tilemap advances animationFrame
 *  every 30 frames at 60 fps. */
export const TILE_ANIM_SECONDS = 0.5;

/** The water surface column offset per animation step (MV:
 *  [0, 1, 2, 1][animationFrame % 4]). */
const WATER_SURFACE = [0, 1, 2, 1] as const;

export async function loadTilesetImages(
  environment: RpgMakerImportEnvironment,
  projectRoot: string,
  tilesetNames: string[],
  tileSize: number,
  encryption?: RpgMakerMediaEncryption,
): Promise<TilesetImages> {
  const sheets: (RgbaImage | null)[] = [];
  for (let i = 0; i < 9; i++) {
    const name = tilesetNames[i] ?? "";
    const path = name === "" ? null : findRpgMakerPng(environment, environment.join(projectRoot, "img", "tilesets", `${name}.png`), encryption);
    sheets.push(path ? await environment.readPng(path, encryption) : null);
  }
  return { tileSize, sheets };
}

function findRpgMakerPng(
  environment: RpgMakerImportEnvironment,
  path: string,
  encryption?: RpgMakerMediaEncryption,
): string | null {
  if (environment.exists(path)) return path;
  if (!encryption?.images || !path.toLowerCase().endsWith(".png")) return null;
  return [`${path}_`, `${path.slice(0, -4)}.rpgmvp`].find((candidate) => environment.exists(candidate)) ?? null;
}

/** MV Tilemap.isVisibleTile. */
export const isVisibleTile = (id: number): boolean => id > 0 && id < TILE_ID_MAX;

/** MV Tilemap.isTileA5 — note MV treats the whole 1536..2047 range as A5
 *  when choosing the sheet (only the first 128 ids land on the image). */
const isNormalA5 = (id: number): boolean => id >= TILE_ID_A5 && id < TILE_ID_A1;

/** Which of the nine sheets draws `id` (9 and above are no sheet: ids
 *  1024..1535 are unused by the editor). */
export function tileSheetIndex(id: number): number {
  if (isTileA1(id)) return SHEET_A1;
  if (isTileA2(id)) return SHEET_A2;
  if (isTileA3(id)) return SHEET_A3;
  if (isTileA4(id)) return SHEET_A4;
  if (isNormalA5(id)) return SHEET_A5;
  return 5 + Math.floor(id / 256);
}

/** Animation cycle length of one tile, in TILE_ANIM_SECONDS steps. A1
 *  kinds 0, 1 and even kinds from 4 are water surfaces (four steps through
 *  the columns 0, 1, 2, 1); odd kinds from 4 are waterfalls (three
 *  vertical frames); kinds 2 and 3 (deep sea, A1 decoration) are static. */
export function tileFrameCount(id: number): number {
  if (!isTileA1(id)) return 1;
  const kind = autotileKind(id);
  if (kind === 2 || kind === 3) return 1;
  if (kind >= 4 && kind % 2 === 1) return 3;
  return 4;
}

/** The source frame a tile shows at animation `step`: equal values mean
 *  identical pixels (water step 1 and step 3 both show column 1). */
export function tileFrameAt(id: number, step: number): number {
  const n = tileFrameCount(id);
  if (n === 1) return 0;
  if (n === 3) return step % 3;
  return WATER_SURFACE[step % 4]!;
}

/** MV Tilemap._isTableTile: an A2 tile with the counter/table flag. */
export function isTableTile(id: number, flags: readonly number[]): boolean {
  return isTileA2(id) && ((flags[id] ?? 0) & 0x80) !== 0;
}

/** MV Tilemap.isShadowingTile: A3 and A4 tiles (walls and roofs). */
export const isShadowingTile = (id: number): boolean => isTileA3(id) || isTileA4(id);

/** Draw tile `id` with its top-left at (dx, dy), at the sheets' native
 *  size, as RPG Maker shows it at animationFrame = `step`. */
export function drawTile(
  dst: RgbaImage,
  dx: number,
  dy: number,
  id: number,
  step: number,
  images: TilesetImages,
  flags: readonly number[],
): void {
  if (!isVisibleTile(id)) return;
  if (isAutotile(id)) drawAutotile(dst, dx, dy, id, step, images, flags);
  else drawNormalTile(dst, dx, dy, id, images);
}

/** The source of an autotile: sheet, block origin (in tiles), quarter
 *  table and the table-tile flag (MV _drawAutotile's prologue). */
export interface AutotileSource {
  setNumber: number;
  bx: number;
  by: number;
  table: QuarterTable;
  isTable: boolean;
}

export function autotileSource(id: number, step: number, flags: readonly number[]): AutotileSource {
  const kind = autotileKind(id);
  const tx = kind % 8;
  const ty = Math.floor(kind / 8);
  let table: QuarterTable = FLOOR_AUTOTILE_TABLE;
  let bx = 0;
  let by = 0;
  let setNumber = 0;
  let isTable = false;
  if (isTileA1(id)) {
    const wsi = WATER_SURFACE[step % 4]!;
    setNumber = SHEET_A1;
    if (kind === 0) {
      bx = wsi * 2;
      by = 0;
    } else if (kind === 1) {
      bx = wsi * 2;
      by = 3;
    } else if (kind === 2) {
      bx = 6;
      by = 0;
    } else if (kind === 3) {
      bx = 6;
      by = 3;
    } else {
      bx = Math.floor(tx / 4) * 8;
      by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
      if (kind % 2 === 0) {
        bx += wsi * 2;
      } else {
        bx += 6;
        table = WATERFALL_AUTOTILE_TABLE;
        by += step % 3;
      }
    }
  } else if (isTileA2(id)) {
    setNumber = SHEET_A2;
    bx = tx * 2;
    by = (ty - 2) * 3;
    isTable = isTableTile(id, flags);
  } else if (isTileA3(id)) {
    setNumber = SHEET_A3;
    bx = tx * 2;
    by = (ty - 6) * 2;
    table = WALL_AUTOTILE_TABLE;
  } else if (isTileA4(id)) {
    setNumber = SHEET_A4;
    bx = tx * 2;
    by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
    if (ty % 2 === 1) table = WALL_AUTOTILE_TABLE;
  }
  return { setNumber, bx, by, table, isTable };
}

function drawAutotile(
  dst: RgbaImage,
  dx: number,
  dy: number,
  id: number,
  step: number,
  images: TilesetImages,
  flags: readonly number[],
): void {
  const { setNumber, bx, by, table, isTable } = autotileSource(id, step, flags);
  const quarters = table[autotileShape(id)];
  const source = images.sheets[setNumber];
  if (!quarters || !source) return;
  const w1 = images.tileSize / 2;
  const h1 = images.tileSize / 2;
  for (let i = 0; i < 4; i++) {
    const [qsx, qsy] = quarters[i]!;
    const sx1 = (bx * 2 + qsx) * w1;
    const sy1 = (by * 2 + qsy) * h1;
    const dx1 = dx + (i % 2) * w1;
    let dy1 = dy + Math.floor(i / 2) * h1;
    if (isTable && (qsy === 1 || qsy === 5)) {
      // A table's inner-corner and bottom-edge quarters: the full quarter
      // comes from the block's row 3 (its leg side), then the top half of
      // the real quarter is laid over the lower half.
      const qsx2 = qsy === 1 ? [0, 3, 2, 1][qsx]! : qsx;
      const qsy2 = 3;
      blit(dst, dx1, dy1, source, (bx * 2 + qsx2) * w1, (by * 2 + qsy2) * h1, w1, h1);
      dy1 += h1 / 2;
      blit(dst, dx1, dy1, source, sx1, sy1, w1, h1 / 2);
    } else {
      blit(dst, dx1, dy1, source, sx1, sy1, w1, h1);
    }
  }
}

function drawNormalTile(dst: RgbaImage, dx: number, dy: number, id: number, images: TilesetImages): void {
  const setNumber = isNormalA5(id) ? SHEET_A5 : 5 + Math.floor(id / 256);
  const w = images.tileSize;
  const h = images.tileSize;
  const sx = ((Math.floor(id / 128) % 2) * 8 + (id % 8)) * w;
  const sy = (Math.floor((id % 256) / 8) % 16) * h;
  const source = images.sheets[setNumber];
  if (source) blit(dst, dx, dy, source, sx, sy, w, h);
}

/** MV Tilemap._drawTableEdge: the cell below an A2 table tile shows the
 *  lower half of the table's two bottom quarters (its legs) in its top
 *  half. `id` is the table tile above. */
export function drawTableEdge(dst: RgbaImage, dx: number, dy: number, id: number, images: TilesetImages): void {
  if (!isTileA2(id)) return;
  const kind = autotileKind(id);
  const tx = kind % 8;
  const ty = Math.floor(kind / 8);
  const bx = tx * 2;
  const by = (ty - 2) * 3;
  const quarters = FLOOR_AUTOTILE_TABLE[autotileShape(id)];
  const source = images.sheets[SHEET_A2];
  if (!quarters || !source) return;
  const w1 = images.tileSize / 2;
  const h1 = images.tileSize / 2;
  for (let i = 0; i < 2; i++) {
    const [qsx, qsy] = quarters[2 + i]!;
    const sx1 = (bx * 2 + qsx) * w1;
    const sy1 = (by * 2 + qsy) * h1 + h1 / 2;
    const dx1 = dx + (i % 2) * w1;
    const dy1 = dy + Math.floor(i / 2) * h1;
    blit(dst, dx1, dy1, source, sx1, sy1, w1, h1 / 2);
  }
}

/** MV Tilemap._drawShadow: each set bit (1 TL, 2 TR, 4 BL, 8 BR) fills
 *  that quarter with rgba(0, 0, 0, 0.5), source-over. */
export function drawShadow(dst: RgbaImage, dx: number, dy: number, bits: number, tileSize: number): void {
  if ((bits & 0x0f) === 0) return;
  const w1 = tileSize / 2;
  const h1 = tileSize / 2;
  for (let i = 0; i < 4; i++) {
    if ((bits & (1 << i)) === 0) continue;
    const qx = dx + (i % 2) * w1;
    const qy = dy + Math.floor(i / 2) * h1;
    for (let y = qy; y < qy + h1; y++) {
      if (y < 0 || y >= dst.height) continue;
      for (let x = qx; x < qx + w1; x++) {
        if (x < 0 || x >= dst.width) continue;
        const p = (y * dst.width + x) * 4;
        const da = dst.data[p + 3]! / 255;
        const oa = 0.5 + da * 0.5;
        const keep = (da * 0.5) / oa;
        dst.data[p] = Math.round(dst.data[p]! * keep);
        dst.data[p + 1] = Math.round(dst.data[p + 1]! * keep);
        dst.data[p + 2] = Math.round(dst.data[p + 2]! * keep);
        dst.data[p + 3] = Math.round(oa * 255);
      }
    }
  }
}

/** Reduce an image by an integer `factor` (48 -> 16 is 3), each output
 *  pixel the area average of its factor x factor block. Colours are
 *  averaged weighted by alpha so transparent pixels do not darken edges. */
export function downscale(img: RgbaImage, factor: number): RgbaImage {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`tile-render: downscale factor must be a positive integer (got ${factor})`);
  }
  if (factor === 1) return { width: img.width, height: img.height, data: img.data.slice() };
  if (img.width % factor !== 0 || img.height % factor !== 0) {
    throw new Error(`tile-render: ${img.width}x${img.height} is not divisible by ${factor}`);
  }
  const out = blankImage(img.width / factor, img.height / factor);
  const n = factor * factor;
  for (let oy = 0; oy < out.height; oy++) {
    for (let ox = 0; ox < out.width; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = 0; y < factor; y++) {
        for (let x = 0; x < factor; x++) {
          const p = ((oy * factor + y) * img.width + ox * factor + x) * 4;
          const pa = img.data[p + 3]!;
          r += img.data[p]! * pa;
          g += img.data[p + 1]! * pa;
          b += img.data[p + 2]! * pa;
          a += pa;
        }
      }
      const o = (oy * out.width + ox) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}
