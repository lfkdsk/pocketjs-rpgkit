// tests/rpgmaker-tiles.test.ts — the RPG Maker importer's tile side: the
// MV Tilemap port (tile-render.ts), the autotile shape solver, per-cell
// passage (passage.ts) and whole-map composition into kit layers
// (compose.ts).
//
// Every sheet here is synthetic and coordinate-coded, so the source of each
// drawn quarter (or half-quarter) can be read back from its pixel colour.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  FLOOR_AUTOTILE_TABLE,
  floorShape,
  makeAutotileId,
  reshapeAutotiles,
  WALL_AUTOTILE_TABLE,
  WATERFALL_AUTOTILE_TABLE,
  wallShape,
  type Joins,
} from "../tools/rpgmaker-import/autotile.ts";
import { composeMap, TileAtlas } from "../tools/rpgmaker-import/compose.ts";
import { Coverage } from "../tools/rpgmaker-import/coverage.ts";
import { NODE_RPGMAKER_IMPORT_ENVIRONMENT } from "../tools/rpgmaker-import/environment-node.ts";
import { blankImage, blit, readPng, writePngBytes, type RgbaImage } from "../tools/rpgmaker-import/png.ts";
import { blockedDirs, RM_FLAG } from "../tools/rpgmaker-import/passage.ts";
import type { RmMap, RmTileset } from "../tools/rpgmaker-import/rm-types.ts";
import {
  downscale,
  drawShadow,
  drawTableEdge,
  drawTile,
  loadTilesetImages,
  TILE_ANIM_SECONDS,
  tileFrameCount,
  type TilesetImages,
} from "../tools/rpgmaker-import/tile-render.ts";

// --- synthetic sheets ----------------------------------------------------------

/** Quarter-coded sheet: R = quarter column, G = quarter row, B = (row in
 *  quarter) * 16 + (column in quarter). Fully opaque. */
function quarterSheet(wTiles: number, hTiles: number, T: number): RgbaImage {
  const img = blankImage(wTiles * T, hTiles * T);
  const q = T / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = Math.floor(x / q);
      img.data[i + 1] = Math.floor(y / q);
      img.data[i + 2] = (y % q) * 16 + (x % q);
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/** Tile-coded sheet: R = tile column, G = tile row, B = `tag`. */
function tileSheet(wTiles: number, hTiles: number, T: number, tag: number): RgbaImage {
  const img = blankImage(wTiles * T, hTiles * T);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      img.data.set([Math.floor(x / T), Math.floor(y / T), tag, 255], i);
    }
  }
  return img;
}

function px(img: RgbaImage, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [...img.data.subarray(i, i + 4)];
}

/** Source quarter [qx, qy] of dst quarter i of the tile at (0, 0). */
function quarterAt(img: RgbaImage, i: number, T: number): [number, number] {
  const p = px(img, (i % 2) * (T / 2), Math.floor(i / 2) * (T / 2));
  return [p[0]!, p[1]!];
}

function images(T: number, sheets: Partial<Record<number, RgbaImage>>): TilesetImages {
  return { tileSize: T, sheets: Array.from({ length: 9 }, (_, i) => sheets[i] ?? null) };
}

const NO_FLAGS: number[] = new Array(8192).fill(0);

function drawn(T: number, id: number, step: number, imgs: TilesetImages, flags: readonly number[] = NO_FLAGS): RgbaImage {
  const out = blankImage(T, T);
  drawTile(out, 0, 0, id, step, imgs, flags);
  return out;
}

/** Expected quarters for an autotile drawn from block origin (bx, by). */
function expectQuarters(img: RgbaImage, T: number, table: readonly (readonly [number, number])[], bx: number, by: number): void {
  for (let i = 0; i < 4; i++) {
    const [qx, qy] = table[i]!;
    expect(quarterAt(img, i, T)).toEqual([bx * 2 + qx, by * 2 + qy]);
  }
}

const T = 4; // small native size: 2x2-pixel quarters, 1-pixel half-quarters

// --- (a) floor shapes ------------------------------------------------------------

describe("A2 floor autotiles", () => {
  test("every FLOOR shape 0..47 picks the table's quarters", () => {
    const imgs = images(T, { 1: quarterSheet(16, 12, T) });
    // Kind 16 + 8 + 3: tx 3, ty 3 -> block origin bx 6, by 3.
    const kind = 27;
    for (let shape = 0; shape < 48; shape++) {
      const img = drawn(T, makeAutotileId(kind, shape), 0, imgs);
      expectQuarters(img, T, FLOOR_AUTOTILE_TABLE[shape]!, 6, 3);
    }
  });

  test("first A2 kind draws from the sheet origin", () => {
    const imgs = images(T, { 1: quarterSheet(16, 12, T) });
    expectQuarters(drawn(T, makeAutotileId(16, 47), 0, imgs), T, FLOOR_AUTOTILE_TABLE[47]!, 0, 0);
  });
});

// --- (b) shape solver --------------------------------------------------------------

describe("autotile shape solver", () => {
  const all: Joins = () => true;
  const except = (...offs: [number, number][]): Joins => (dx, dy) => !offs.some(([x, y]) => x === dx && y === dy);

  test("interior and isolated", () => {
    expect(floorShape(all)).toBe(0);
    expect(floorShape(() => false)).toBe(46);
  });

  test("single inner corners: 1 TL, 2 TR, 4 BR, 8 BL", () => {
    expect(floorShape(except([-1, -1]))).toBe(1);
    expect(floorShape(except([1, -1]))).toBe(2);
    expect(floorShape(except([1, 1]))).toBe(4);
    expect(floorShape(except([-1, 1]))).toBe(8);
  });

  test("single open edges", () => {
    expect(floorShape(except([-1, 0], [-1, -1], [-1, 1]))).toBe(16);
    expect(floorShape(except([0, -1], [-1, -1], [1, -1]))).toBe(20);
    expect(floorShape(except([1, 0], [1, -1], [1, 1]))).toBe(24);
    expect(floorShape(except([0, 1], [-1, 1], [1, 1]))).toBe(28);
    // An open edge hides its diagonals: the shape ignores them.
    expect(floorShape(except([-1, 0]))).toBe(16);
  });

  test("wall shape bits", () => {
    expect(wallShape(all)).toBe(0);
    expect(wallShape(except([-1, 0]))).toBe(1);
    expect(wallShape(except([0, -1]))).toBe(2);
    expect(wallShape(except([1, 0]))).toBe(4);
    expect(wallShape(except([0, 1]))).toBe(8);
  });

  test("reshapeAutotiles on a blob map; map edges join", () => {
    const W = 5;
    const H = 5;
    const A = 16;
    const B = 17;
    const z0 = new Array(W * H).fill(makeAutotileId(A, 47));
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) z0[y * W + x] = makeAutotileId(B, 47);
    const data = [...z0, ...new Array(W * H * 5).fill(0)];
    const out = reshapeAutotiles(data, W, H);
    const shapeAt = (x: number, y: number): number => (out[y * W + x]! - 2048) % 48;
    const kindAt = (x: number, y: number): number => Math.floor((out[y * W + x]! - 2048) / 48);
    expect(kindAt(2, 2)).toBe(B);
    expect(shapeAt(2, 2)).toBe(0); // blob centre
    expect(shapeAt(1, 1)).toBe(34); // blob top-left: outer corner
    expect(shapeAt(2, 1)).toBe(20); // blob top edge
    expect(shapeAt(3, 2)).toBe(24); // blob right edge
    expect(shapeAt(2, 3)).toBe(28); // blob bottom edge
    expect(shapeAt(1, 2)).toBe(16); // blob left edge
    // Surrounding field: the map corner sees only the blob's diagonal.
    expect(kindAt(0, 0)).toBe(A);
    expect(shapeAt(0, 0)).toBe(4);
    expect(shapeAt(2, 0)).toBe(28);
    expect(shapeAt(4, 4)).toBe(1);
    // A lone autotile on a 1x1 map is fully joined by the edges.
    expect((reshapeAutotiles([makeAutotileId(A, 47), 0, 0, 0, 0, 0], 1, 1)[0]! - 2048) % 48).toBe(0);
    // Planes 4 and 5 are untouched.
    expect(out.slice(W * H)).toEqual(new Array(W * H * 5).fill(0));
  });
});

// --- (c) A1 ------------------------------------------------------------------------

describe("A1 water and waterfalls", () => {
  const imgs = images(T, { 0: quarterSheet(16, 12, T) });

  test("frame counts", () => {
    expect(TILE_ANIM_SECONDS).toBe(0.5);
    expect(tileFrameCount(makeAutotileId(0, 0))).toBe(4);
    expect(tileFrameCount(makeAutotileId(1, 0))).toBe(4);
    expect(tileFrameCount(makeAutotileId(2, 0))).toBe(1);
    expect(tileFrameCount(makeAutotileId(3, 0))).toBe(1);
    expect(tileFrameCount(makeAutotileId(4, 0))).toBe(4);
    expect(tileFrameCount(makeAutotileId(5, 0))).toBe(3);
    expect(tileFrameCount(makeAutotileId(15, 0))).toBe(3);
    expect(tileFrameCount(makeAutotileId(16, 0))).toBe(1);
    expect(tileFrameCount(1)).toBe(1);
  });

  test("kind 0 water steps 0..3 use bx 0, 2, 4, 2", () => {
    const id = makeAutotileId(0, 5);
    [0, 2, 4, 2].forEach((bx, step) => {
      expectQuarters(drawn(T, id, step, imgs), T, FLOOR_AUTOTILE_TABLE[5]!, bx, 0);
    });
    // The cycle repeats every four steps.
    expect(drawn(T, id, 5, imgs).data).toEqual(drawn(T, id, 1, imgs).data);
  });

  test("kind 1 water sits at by 3", () => {
    [0, 2, 4, 2].forEach((bx, step) => {
      expectQuarters(drawn(T, makeAutotileId(1, 0), step, imgs), T, FLOOR_AUTOTILE_TABLE[0]!, bx, 3);
    });
  });

  test("kinds 2 and 3 are static at bx 6", () => {
    for (let step = 0; step < 4; step++) {
      expectQuarters(drawn(T, makeAutotileId(2, 7), step, imgs), T, FLOOR_AUTOTILE_TABLE[7]!, 6, 0);
      expectQuarters(drawn(T, makeAutotileId(3, 7), step, imgs), T, FLOOR_AUTOTILE_TABLE[7]!, 6, 3);
    }
  });

  test("even kinds from 4 animate their surface; odd kinds are waterfalls", () => {
    // Kind 4: tx 4 -> bx 8, by 0.
    [0, 2, 4, 2].forEach((off, step) => {
      expectQuarters(drawn(T, makeAutotileId(4, 0), step, imgs), T, FLOOR_AUTOTILE_TABLE[0]!, 8 + off, 0);
    });
    // Kind 6: tx 6 -> bx 8, by 3.
    expectQuarters(drawn(T, makeAutotileId(6, 0), 2, imgs), T, FLOOR_AUTOTILE_TABLE[0]!, 12, 3);
    // Kind 8: tx 0, ty 1 -> bx 0, by 6.
    expectQuarters(drawn(T, makeAutotileId(8, 0), 0, imgs), T, FLOOR_AUTOTILE_TABLE[0]!, 0, 6);
    // Kind 5 waterfall: bx 8 + 6, by 0 + step % 3, WATERFALL table.
    for (let step = 0; step < 6; step++) {
      for (let shape = 0; shape < 4; shape++) {
        expectQuarters(drawn(T, makeAutotileId(5, shape), step, imgs), T, WATERFALL_AUTOTILE_TABLE[shape]!, 14, step % 3);
      }
    }
    // Kind 7 waterfall: by 3 + step % 3. Kind 9: tx 1 -> bx 6, by 6.
    expectQuarters(drawn(T, makeAutotileId(7, 1), 2, imgs), T, WATERFALL_AUTOTILE_TABLE[1]!, 14, 5);
    expectQuarters(drawn(T, makeAutotileId(9, 3), 1, imgs), T, WATERFALL_AUTOTILE_TABLE[3]!, 6, 7);
  });
});

// --- (d) A3, A4 --------------------------------------------------------------------

describe("A3 and A4", () => {
  test("A3 roofs and walls use the WALL table at by = (ty - 6) * 2", () => {
    const imgs = images(T, { 2: quarterSheet(16, 8, T) });
    for (let shape = 0; shape < 16; shape++) {
      expectQuarters(drawn(T, makeAutotileId(48, shape), 0, imgs), T, WALL_AUTOTILE_TABLE[shape]!, 0, 0);
      // Kind 59: tx 3, ty 7 (a wall row) -> bx 6, by 2.
      expectQuarters(drawn(T, makeAutotileId(59, shape), 0, imgs), T, WALL_AUTOTILE_TABLE[shape]!, 6, 2);
      // Kind 69: tx 5, ty 8 (second roof row) -> bx 10, by 4.
      expectQuarters(drawn(T, makeAutotileId(69, shape), 0, imgs), T, WALL_AUTOTILE_TABLE[shape]!, 10, 4);
    }
  });

  test("A4 tops use FLOOR, sides WALL, at the 2.5-tile row pitch", () => {
    const imgs = images(T, { 3: quarterSheet(16, 15, T) });
    const rows: [number, number, boolean][] = [
      [10, 0, false],
      [11, 3, true],
      [12, 5, false],
      [13, 8, true],
      [14, 10, false],
      [15, 13, true],
    ];
    for (const [ty, by, wall] of rows) {
      const kind = ty * 8 + 2; // tx 2 -> bx 4
      const shapes = wall ? 16 : 48;
      for (let shape = 0; shape < shapes; shape++) {
        const table = wall ? WALL_AUTOTILE_TABLE : FLOOR_AUTOTILE_TABLE;
        expectQuarters(drawn(T, makeAutotileId(kind, shape), 0, imgs), T, table[shape]!, 4, by);
      }
    }
  });
});

// --- (e) table tiles ---------------------------------------------------------------

describe("A2 table tiles", () => {
  const imgs = images(T, { 1: quarterSheet(16, 12, T) });
  const kind = 16; // bx 0, by 0
  const flags = NO_FLAGS.slice();
  flags[makeAutotileId(kind, 4)] = 0x80;
  flags[makeAutotileId(kind, 28)] = 0x80;
  flags[makeAutotileId(kind, 0)] = 0x80;

  /** [qx, qy, row-in-quarter] of the pixel at (x, y). */
  const src = (img: RgbaImage, x: number, y: number): number[] => {
    const p = px(img, x, y);
    return [p[0]!, p[1]!, p[2]! >> 4];
  };

  test("inner-corner quarter (qsy 1): row-3 leg piece, then the real top half", () => {
    const img = drawn(T, makeAutotileId(kind, 4), 0, imgs, flags);
    // Shape 4 BR is [3, 1] -> qsx2 = [0, 3, 2, 1][3] = 1, qsy2 = 3.
    expect(src(img, 2, 2)).toEqual([1, 3, 0]);
    expect(src(img, 2, 3)).toEqual([3, 1, 0]);
    // The other quarters draw normally.
    expect(quarterAt(img, 0, T)).toEqual([2, 4]);
    expect(src(img, 0, 3)).toEqual([2, 3, 1]);
  });

  test("bottom-edge quarters (qsy 5): same column at row 3", () => {
    const img = drawn(T, makeAutotileId(kind, 28), 0, imgs, flags);
    // Shape 28 BL [2, 5], BR [1, 5].
    expect(src(img, 0, 2)).toEqual([2, 3, 0]);
    expect(src(img, 0, 3)).toEqual([2, 5, 0]);
    expect(src(img, 2, 2)).toEqual([1, 3, 0]);
    expect(src(img, 2, 3)).toEqual([1, 5, 0]);
  });

  test("without the 0x80 flag the same id draws as a plain floor", () => {
    const img = drawn(T, makeAutotileId(kind, 28), 0, imgs, NO_FLAGS);
    expect(src(img, 0, 3)).toEqual([2, 5, 1]);
    // Shape 0 has no qsy 1/5 quarter, so the flag changes nothing.
    expect(drawn(T, makeAutotileId(kind, 0), 0, imgs, flags).data).toEqual(drawn(T, makeAutotileId(kind, 0), 0, imgs).data);
  });

  test("table edge: lower halves of the two bottom quarters in the top half", () => {
    const out = blankImage(T, T);
    drawTableEdge(out, 0, 0, makeAutotileId(kind, 28), imgs);
    expect(src(out, 0, 0)).toEqual([2, 5, 1]);
    expect(src(out, 2, 0)).toEqual([1, 5, 1]);
    expect(px(out, 0, 1)[3]).toBe(0);
    expect(px(out, 0, 2)[3]).toBe(0);
  });
});

// --- (f) A5, B..E -------------------------------------------------------------------

describe("normal tiles", () => {
  const sheets: Partial<Record<number, RgbaImage>> = { 4: tileSheet(8, 16, T, 4) };
  for (let s = 5; s < 9; s++) sheets[s] = tileSheet(16, 16, T, s);
  const imgs = images(T, sheets);
  const tileOf = (id: number): number[] => px(drawn(T, id, 0, imgs), 1, 1).slice(0, 3);

  test("A5 source rects", () => {
    expect(tileOf(1536)).toEqual([0, 0, 4]);
    expect(tileOf(1536 + 13)).toEqual([5, 1, 4]);
    expect(tileOf(1536 + 127)).toEqual([7, 15, 4]);
  });

  test("B..E source rects: two 8-column halves per sheet", () => {
    expect(tileOf(5)).toEqual([5, 0, 5]);
    expect(tileOf(130)).toEqual([10, 0, 5]);
    expect(tileOf(255)).toEqual([15, 15, 5]);
    expect(tileOf(256 + 9)).toEqual([1, 1, 6]);
    expect(tileOf(512 + 127)).toEqual([7, 15, 7]);
    expect(tileOf(768 + 200)).toEqual([8, 9, 8]);
  });

  test("id 0 and a missing sheet draw nothing", () => {
    expect(px(drawn(T, 0, 0, imgs), 1, 1)[3]).toBe(0);
    expect(px(drawn(T, 5, 0, images(T, {})), 1, 1)[3]).toBe(0);
    expect(px(drawn(T, makeAutotileId(16, 0), 0, images(T, {})), 1, 1)[3]).toBe(0);
  });

  test("tiles composite with source-over alpha", () => {
    const dst = blankImage(1, 1);
    dst.data.set([200, 100, 0, 255]);
    const src = blankImage(1, 1);
    src.data.set([0, 0, 200, 128]);
    blit(dst, 0, 0, src, 0, 0, 1, 1);
    expect(px(dst, 0, 0)).toEqual([100, 50, 100, 255]);
  });
});

// --- (g) shadow ----------------------------------------------------------------------

describe("shadow", () => {
  test("each bit darkens one quarter by half", () => {
    const img = blankImage(T, T);
    img.data.fill(255);
    drawShadow(img, 0, 0, 1 | 8, T);
    expect(px(img, 0, 0)).toEqual([128, 128, 128, 255]);
    expect(px(img, 2, 0)).toEqual([255, 255, 255, 255]);
    expect(px(img, 0, 2)).toEqual([255, 255, 255, 255]);
    expect(px(img, 3, 3)).toEqual([128, 128, 128, 255]);
    const bare = blankImage(T, T);
    drawShadow(bare, 0, 0, 2 | 4, T);
    expect(px(bare, 2, 0)).toEqual([0, 0, 0, 128]);
    expect(px(bare, 0, 2)).toEqual([0, 0, 0, 128]);
    expect(px(bare, 0, 0)).toEqual([0, 0, 0, 0]);
    // High bits are ignored.
    const none = blankImage(T, T);
    drawShadow(none, 0, 0, 0x30, T);
    expect(none.data.every((v) => v === 0)).toBe(true);
  });
});

// --- (h) passage ----------------------------------------------------------------------

describe("blockedDirs", () => {
  const flags = NO_FLAGS.slice();
  flags[0] = RM_FLAG.STAR;
  flags[1] = 0x0f; // wall
  flags[2] = 0; // open
  flags[3] = RM_FLAG.STAR | 0x0f; // star: never decides
  flags[4] = RM_FLAG.DOWN | RM_FLAG.RIGHT; // fence
  flags[5] = RM_FLAG.UP | RM_FLAG.LADDER;

  test("the topmost non-star tile decides", () => {
    expect(blockedDirs([2, 1, 0, 0], flags)).toEqual(["down", "left", "right", "up"]);
    expect(blockedDirs([1, 2, 0, 0], flags)).toEqual([]);
    expect(blockedDirs([1, 0, 0, 2], flags)).toEqual([]);
  });

  test("stars and id 0 are skipped", () => {
    expect(blockedDirs([2, 0, 3, 0], flags)).toEqual([]);
    expect(blockedDirs([1, 3, 3, 0], flags)).toEqual(["down", "left", "right", "up"]);
    const noZero = flags.slice();
    noZero[0] = 0; // id 0 skipped even without the editor's star flag
    expect(blockedDirs([1, 0, 0, 0], noZero)).toEqual(["down", "left", "right", "up"]);
  });

  test("no deciding tile blocks every direction", () => {
    expect(blockedDirs([3, 3, 0, 0], flags)).toEqual(["down", "left", "right", "up"]);
    expect(blockedDirs([0, 0, 0, 0], flags)).toEqual(["down", "left", "right", "up"]);
  });

  test("per-direction bits", () => {
    expect(blockedDirs([2, 4, 0, 0], flags)).toEqual(["down", "right"]);
    expect(blockedDirs([2, 5, 3, 0], flags)).toEqual(["up"]);
    expect(blockedDirs([1, 0, 0, 0], [0, RM_FLAG.LEFT])).toEqual(["left"]);
  });
});

// --- (i) composeMap ---------------------------------------------------------------------

/** A B sheet whose tile n is solid (n * 10, 100, 200), except tile 3 whose
 *  right half is transparent. */
function solidB(T: number): RgbaImage {
  const img = blankImage(16 * T, 16 * T);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const n = Math.floor(y / T) * 8 + Math.floor(x / T) + (x >= 8 * T ? 120 : 0);
      const transparent = n === 3 && x % T >= T / 2;
      img.data.set([n * 10 % 256, 100, 200, transparent ? 0 : 255], (y * img.width + x) * 4);
    }
  }
  return img;
}

function rmMap(width: number, height: number, planes: number[][]): RmMap {
  const data: number[] = [];
  for (let z = 0; z < 6; z++) data.push(...(planes[z] ?? new Array(width * height).fill(0)));
  return {
    autoplayBgm: false,
    autoplayBgs: false,
    bgm: { name: "", volume: 90, pitch: 100, pan: 0 },
    bgs: { name: "", volume: 90, pitch: 100, pan: 0 },
    displayName: "",
    encounterList: [],
    encounterStep: 30,
    width,
    height,
    note: "",
    parallaxName: "",
    parallaxLoopX: false,
    parallaxLoopY: false,
    parallaxSx: 0,
    parallaxSy: 0,
    parallaxShow: false,
    scrollType: 0,
    specifyBattleback: false,
    tilesetId: 1,
    data,
    events: [null],
  };
}

function rmTileset(flags: number[]): RmTileset {
  return { id: 1, name: "test", mode: 1, tilesetNames: [], flags, note: "" };
}

const cellPx = (atlas: RgbaImage, cols: number, cell: number, x: number, y: number): number[] =>
  px(atlas, (cell % cols) * 16 + x, Math.floor(cell / cols) * 16 + y);

describe("composeMap", () => {
  const C = 16;
  const GRASS = makeAutotileId(16, 0);
  const WATER = makeAutotileId(0, 0);
  const flags = NO_FLAGS.slice();
  flags[0] = RM_FLAG.STAR;
  flags[1] = 0x0f;
  flags[2] = RM_FLAG.STAR;
  flags[WATER] = 0x0f;
  const imgs = images(C, { 0: quarterSheet(16, 12, C), 1: quarterSheet(16, 12, C), 5: solidB(C) });
  // (0,0) grass + wall B1 | (1,0) grass + star B2 | (2,0) star B2 only
  // (0,1) water          | (1,1) grass, B4 on z1, shadow TL+TR, B3 on z2
  // (2,1) grass + region 5
  const map = rmMap(3, 2, [
    [GRASS, GRASS, 0, WATER, GRASS, GRASS],
    [0, 0, 0, 0, 4, 0],
    [1, 2, 2, 0, 3, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1 | 2, 0],
    [0, 0, 0, 0, 0, 5],
  ]);

  test("ground/upper split, passage, dedupe, animation, coverage", () => {
    const atlas = new TileAtlas("rm_tiles", 8);
    const cov = new Coverage();
    const out = composeMap(map, rmTileset(flags), imgs, atlas, cov);
    expect(out.width).toBe(3);
    expect(out.height).toBe(2);
    const g = out.ground;
    expect(g[2]).toBeNull(); // only a star tile
    for (const i of [0, 1, 3, 4, 5]) expect(g[i]).not.toBeNull();
    // Grass with the star split off == plain grass.
    expect(g[1]).toBe(g[5]);
    expect(new Set([g[0], g[1], g[3], g[4]]).size).toBe(4);
    // Upper: sparse, deduped star stacks.
    expect(out.upper).toEqual([
      [1, out.upper[0]![1]],
      [2, out.upper[0]![1]],
    ]);
    const u = out.upper[0]![1];
    expect(atlas.blocked(u)).toEqual([]);
    // Passage lives on the atlas cell.
    expect(atlas.blocked(g[0]!)).toEqual(["down", "left", "right", "up"]);
    expect(atlas.blocked(g[1]!)).toEqual([]);
    expect(atlas.blocked(g[3]!)).toEqual(["down", "left", "right", "up"]);
    expect(out.regions).toEqual([0, 0, 0, 0, 0, 5]);

    // Water: four frames, step 1 and step 3 share a cell.
    expect(out.animated).toHaveLength(1);
    const anim = out.animated[0]!;
    expect(anim).toMatchObject({ x: 0, y: 1, above: false, frameSeconds: 0.5 });
    expect(anim.frames).toHaveLength(4);
    expect(anim.frames[0]).toBe(g[3]!);
    expect(anim.frames[1]).toBe(anim.frames[3]!);
    expect(new Set(anim.frames).size).toBe(3);

    // Every cell: grass, B1 stack, B4+shadow+B3 stack, star, water x3.
    expect(atlas.count).toBe(7);
    expect(atlas.rows).toBe(1);
    const sheet = atlas.toImage();
    expect(sheet.width).toBe(8 * 16);
    expect(sheet.height).toBe(16);
    // Water frames sample columns bx 0, 2, 4: TL quarter is [bx*2+2, 4].
    expect(cellPx(sheet, 8, anim.frames[0]!, 0, 0).slice(0, 2)).toEqual([2, 4]);
    expect(cellPx(sheet, 8, anim.frames[1]!, 0, 0).slice(0, 2)).toEqual([6, 4]);
    expect(cellPx(sheet, 8, anim.frames[2]!, 0, 0).slice(0, 2)).toEqual([10, 4]);
    // Star cell is B tile 2, drawn alone.
    expect(cellPx(sheet, 8, u, 5, 5)).toEqual([20, 100, 200, 255]);

    // Shadow between z1 and z2: TL is B3 (on top, undarkened); TR is B4
    // under the shadow; BR is B4 without shadow.
    const s = g[4]!;
    expect(cellPx(sheet, 8, s, 2, 2)).toEqual([30, 100, 200, 255]);
    expect(cellPx(sheet, 8, s, 12, 2)).toEqual([20, 50, 100, 255]);
    expect(cellPx(sheet, 8, s, 12, 12)).toEqual([40, 100, 200, 255]);

    const rows = new Map(cov.list("tile").map((r) => [r.key, r.counts]));
    expect(rows.get("A2 ground")!.Native).toBe(4);
    expect(rows.get("B-E")!.Native).toBe(4); // (1,1)'s two B tiles count once
    expect(rows.get("A1 water")!.Native).toBe(1);
    expect(rows.get("star (upper layer)")!.Native).toBe(2);
    expect(rows.get("shadow")!.Native).toBe(1);
    expect(rows.get("region id")!.Native).toBe(1);
    expect(cov.list("tile").find((r) => r.key === "region id")!.reasons).toEqual([]);
  });

  test("identical pixels with different passage stay distinct; keys reuse across maps", () => {
    const f = flags.slice();
    f[10] = 0;
    f[11] = 0x0f;
    const B = blankImage(16 * C, 16 * C);
    B.data.fill(255); // every B tile identical white
    const im = images(C, { 5: B });
    const atlas = new TileAtlas("rm_tiles");
    const cov = new Coverage();
    const a = composeMap(rmMap(2, 1, [[10, 11]]), rmTileset(f), im, atlas, cov);
    expect(a.ground[0]).not.toBe(a.ground[1]);
    expect(atlas.blocked(a.ground[0]!)).toEqual([]);
    expect(atlas.blocked(a.ground[1]!)).toEqual(["down", "left", "right", "up"]);
    const b = composeMap(rmMap(1, 1, [[11]]), rmTileset(f), im, atlas, cov);
    expect(b.ground[0]).toBe(a.ground[1]);
    expect(atlas.count).toBe(2);
  });

  test("water under a waterfall animates over 12 steps; star animation is above", () => {
    const FALL = makeAutotileId(5, 0);
    const f = flags.slice();
    f[FALL] = RM_FLAG.STAR;
    const atlas = new TileAtlas("rm_tiles");
    const out = composeMap(rmMap(2, 1, [[WATER, WATER], [0, FALL]]), rmTileset(f), imgs, atlas, new Coverage());
    expect(out.animated.map((a) => [a.x, a.above, a.frames.length])).toEqual([
      [0, false, 4],
      [1, false, 4],
      [1, true, 3],
    ]);
    const g = rmMap(1, 1, [[WATER], [makeAutotileId(5, 0)]]);
    const both = composeMap(g, rmTileset(flags), imgs, atlas, new Coverage());
    expect(both.animated[0]!.frames).toHaveLength(12);
    expect(new Set(both.animated[0]!.frames).size).toBe(9); // 3 surfaces x 3 falls
  });

  test("a shadow paints on a cell with no ordinary tile", () => {
    const atlas = new TileAtlas("rm_tiles");
    const out = composeMap(rmMap(1, 1, [[0], [0], [0], [0], [1 | 2], [0]]), rmTileset(flags), imgs, atlas, new Coverage());
    expect(out.ground[0]).not.toBeNull();
  });

  test("a table's hanging edge paints over an otherwise empty cell", () => {
    const TABLE = makeAutotileId(17, 28);
    const f = flags.slice();
    f[TABLE] = RM_FLAG.COUNTER;
    const atlas = new TileAtlas("rm_tiles");
    const out = composeMap(rmMap(1, 2, [[GRASS, 0], [TABLE, 0]]), rmTileset(f), imgs, atlas, new Coverage());
    expect(out.ground[1]).not.toBeNull();
  });

  test("tile traits combine across layers without leaking through table legs", () => {
    const TABLE = makeAutotileId(17, 28);
    const f = flags.slice();
    f[TABLE] = RM_FLAG.COUNTER;
    f[20] = RM_FLAG.LADDER;
    f[21] = RM_FLAG.BUSH | RM_FLAG.DAMAGE | (3 << 12);
    f[22] = RM_FLAG.STAR | RM_FLAG.COUNTER;
    const cov = new Coverage();
    const atlas = new TileAtlas("rm_tiles");
    const out = composeMap(
      rmMap(1, 3, [[GRASS, GRASS, GRASS], [TABLE, 0, 20], [0, 0, 21], [0, 0, 22]]),
      rmTileset(f),
      imgs,
      atlas,
      cov,
    );
    // The cell under the table is grass plus the table's legs, a different
    // cell from plain grass.
    const plain = composeMap(rmMap(1, 1, [[GRASS]]), rmTileset(f), imgs, atlas, new Coverage());
    expect(out.ground[1]).not.toBe(plain.ground[0]);
    const sheet = atlas.toImage();
    // Kind 17: bx 2. Legs = lower half of shape 28's BL quarter [2, 5].
    expect(cellPx(sheet, 32, out.ground[1]!, 0, 0).slice(0, 2)).toEqual([2 * 2 + 2, 5]);
    expect(cellPx(sheet, 32, out.ground[1]!, 0, 0)[2]! >> 4).toBe(4);
    // Below the legs the grass shows.
    expect(cellPx(sheet, 32, out.ground[1]!, 0, 4).slice(0, 2)).toEqual(cellPx(sheet, 32, plain.ground[0]!, 0, 4).slice(0, 2));
    const upper = out.upper.find(([cell]) => cell === 2)![1];
    expect(atlas.featureCells("ladder")).toEqual([out.ground[2]!]);
    expect(atlas.featureCells("bush")).toEqual([out.ground[2]!]);
    expect(atlas.featureCells("counter")).toEqual([out.ground[0]!, upper]);
    expect(atlas.featureCells("counter")).not.toContain(out.ground[1]!);
    const rows = new Map(cov.list("tile").map((r) => [r.key, r.counts]));
    expect(rows.get("A2 table")!.Native).toBe(1);
    expect(rows.get("counter")!.Native).toBe(2);
    expect(rows.get("ladder")!.Native).toBe(1);
    expect(rows.get("bush")!.Native).toBe(1);
    expect(rows.get("damage floor")!.Dropped).toBe(1);
    expect(rows.get("terrain tag")!.Native).toBe(1);
  });

  test("a missing sheet draws nothing and records Degraded", () => {
    const cov = new Coverage();
    const atlas = new TileAtlas("rm_tiles");
    const out = composeMap(rmMap(1, 1, [[600]]), rmTileset(flags), imgs, atlas, cov);
    expect(out.ground[0]).not.toBeNull();
    expect(atlas.toImage().data.every((v) => v === 0)).toBe(true);
    expect(cov.list("tile").map((r) => [r.key, r.counts.Degraded])).toEqual([["missing sheet", 1]]);
  });
});

// --- atlas ------------------------------------------------------------------------------

describe("TileAtlas", () => {
  test("rows, layout and the 256-row cap", () => {
    const atlas = new TileAtlas("s", 2);
    expect(atlas.rows).toBe(1);
    expect(atlas.toImage().width).toBe(32);
    const solid = (v: number) => () => {
      const img = blankImage(16, 16);
      img.data.fill(v);
      return img;
    };
    expect(atlas.intern("a", solid(10), ["up"])).toBe(0);
    expect(atlas.intern("b", solid(20), [])).toBe(1);
    expect(atlas.intern("c", solid(30), [])).toBe(2);
    expect(atlas.intern("a", solid(99), [])).toBe(0);
    expect(atlas.count).toBe(3);
    expect(atlas.rows).toBe(2);
    expect(atlas.blocked(0)).toEqual(["up"]);
    expect(atlas.featureCells("ladder")).toEqual([]);
    const img = atlas.toImage();
    expect([img.width, img.height]).toEqual([32, 32]);
    expect(px(img, 0, 0)[0]).toBe(10);
    expect(px(img, 16, 0)[0]).toBe(20);
    expect(px(img, 0, 16)[0]).toBe(30);
    expect(px(img, 16, 16)[3]).toBe(0);
    expect(() => atlas.intern("bad", () => blankImage(8, 8), [])).toThrow();
    expect(() => atlas.intern("a", solid(10), ["up"], 1)).toThrow("changed feature mask");

    const tall = new TileAtlas("t", 1);
    for (let i = 0; i < 256; i++) tall.intern(String(i), solid(1), []);
    expect(() => tall.intern("over", solid(1), [])).toThrow();
  });
});

// --- (j) downscale ------------------------------------------------------------------------

describe("downscale and native tile sizes", () => {
  test("area average, alpha weighted", () => {
    const img = blankImage(6, 3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) {
        const i = (y * 6 + x) * 4;
        // Left block: 0..8 grey ramp, opaque. Right block: one opaque red
        // pixel among transparent black.
        if (x < 3) img.data.set([y * 3 + x, 0, 0, 255], i);
        else if (x === 4 && y === 1) img.data.set([255, 0, 0, 255], i);
      }
    }
    const out = downscale(img, 3);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(px(out, 0, 0)).toEqual([4, 0, 0, 255]);
    expect(px(out, 1, 0)).toEqual([255, 0, 0, 28]);
    expect(() => downscale(img, 1.5)).toThrow();
    expect(downscale(img, 1).data).toEqual(img.data);
  });

  test("composeMap at tile size 48 yields 16x16 cells with the right quarters", () => {
    const N = 48;
    // Solid quarter code (B = 0) so each downscaled quarter stays uniform.
    const sheet = quarterSheet(16, 12, N);
    for (let i = 2; i < sheet.data.length; i += 4) sheet.data[i] = 0;
    const im = images(N, { 1: sheet });
    const atlas = new TileAtlas("rm_tiles");
    const id = makeAutotileId(18, 5); // tx 2 -> bx 4
    const out = composeMap(rmMap(1, 1, [[id]]), rmTileset(NO_FLAGS), im, atlas, new Coverage());
    const img = atlas.toImage();
    const table = FLOOR_AUTOTILE_TABLE[5]!;
    for (let i = 0; i < 4; i++) {
      for (const [ox, oy] of [[0, 0], [7, 7]]) {
        const p = cellPx(img, 32, out.ground[0]!, (i % 2) * 8 + ox!, Math.floor(i / 2) * 8 + oy!);
        expect(p).toEqual([8 + table[i]![0], table[i]![1], 0, 255]);
      }
    }
    expect(() => composeMap(rmMap(1, 1, [[id]]), rmTileset(NO_FLAGS), images(24, { 1: sheet }), atlas, new Coverage())).toThrow();
  });
});

// --- files ----------------------------------------------------------------------------------

/** A minimal palette PNG writer, to exercise the palette decode path. */
function palettePng(w: number, h: number, idx: number[], plte: number[], trns: number[]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8);
  const raw: number[] = [];
  for (let y = 0; y < h; y++) raw.push(0, ...idx.slice(y * w, y * w + w));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("PLTE", new Uint8Array(plte)),
    chunk("tRNS", new Uint8Array(trns)),
    chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("tileset images on disk", () => {
  test("loadTilesetImages reads RGBA and palette PNGs; unset or missing names are null", async () => {
    const root = mkdtempSync(join(tmpdir(), "rpgmaker-tiles-"));
    try {
      mkdirSync(join(root, "img", "tilesets"), { recursive: true });
      const a2 = quarterSheet(16, 12, 4);
      writeFileSync(join(root, "img", "tilesets", "Outside_A2.png"), writePngBytes(a2));
      writeFileSync(
        join(root, "img", "tilesets", "Outside_B.png"),
        palettePng(2, 1, [0, 1], [0, 0, 0, 10, 20, 30], [0]),
      );
      const imgs = await loadTilesetImages(NODE_RPGMAKER_IMPORT_ENVIRONMENT, root, ["", "Outside_A2", "Gone_A3", "", "", "Outside_B"], 4);
      expect(imgs.tileSize).toBe(4);
      expect(imgs.sheets).toHaveLength(9);
      expect(imgs.sheets.map((s) => s !== null)).toEqual([false, true, false, false, false, true, false, false, false]);
      expect(imgs.sheets[1]!.data).toEqual(a2.data);
      expect(px(imgs.sheets[5]!, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(px(imgs.sheets[5]!, 1, 0)).toEqual([10, 20, 30, 255]);
      const back = await readPng(join(root, "img", "tilesets", "Outside_A2.png"));
      expect([back.width, back.height]).toEqual([64, 48]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
