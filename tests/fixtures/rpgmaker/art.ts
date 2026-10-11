// tests/fixtures/rpgmaker/art.ts — procedural placeholder art for the
// RPG Maker fixture projects (gen-fixtures.ts).
//
// Everything is drawn here from integer rules; no image is read. Only the
// public sheet LAYOUT conventions of MV/MZ are followed so the importer
// finds each piece where the runtime would look for it:
//
//   A1  16x12 tiles  animated water (3 frames side by side) and waterfalls
//                    (3 frames stacked), kinds placed as Tilemap does
//   A2  16x12 tiles  ground autotiles, 2x3-tile blocks
//   A3  16x8 tiles   roofs and building walls, 2x2-tile blocks
//   A4  16x15 tiles  wall tops (2x3) over wall sides (2x2), three bands
//   A5  8x16 tiles   plain tiles
//   B   16x16 tiles  plain tiles, ids 0..127 in the left half
//   characters       12x8 frames (eight characters), 3x4 for `$` sheets
//   Balloon.png      8 frames x 15 balloon rows
//   Window.png       192x192 windowskin with an 8x4 text-colour grid
//
// All art is drawn at 16 px per tile. Textures repeat every 8 px (one
// autotile quarter), so any arrangement of quarters tiles seamlessly. MV
// fixtures scale the finished 16 px canvas by 3 with nearest neighbour, so
// an importer's 48 -> 16 downscale recovers these exact pixels.

import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";

export const TS = 16;

export type Rgba = readonly [number, number, number, number];

export const CLEAR: Rgba = [0, 0, 0, 0];

export function rgb(hex: string, a = 255): Rgba {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

/** f < 1 darkens toward black, f > 1 lightens toward white. */
export function shade(c: Rgba, f: number): Rgba {
  const ch = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(f <= 1 ? v * f : v + (255 - v) * (f - 1))));
  return [ch(c[0]), ch(c[1]), ch(c[2]), c[3]];
}

/** Hue in degrees, saturation and lightness in 0..100. */
export function hsl(h: number, s: number, l: number): Rgba {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number): number =>
    Math.round(255 * (lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4), 255];
}

/** Integer hash of a pixel position and a seed. */
export function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Canvas {
  readonly px: Uint8Array;

  constructor(readonly w: number, readonly h: number) {
    this.px = new Uint8Array(w * h * 4);
  }

  set(x: number, y: number, c: Rgba): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px[i] = c[0];
    this.px[i + 1] = c[1];
    this.px[i + 2] = c[2];
    this.px[i + 3] = c[3];
  }

  rect(x: number, y: number, w: number, h: number, c: Rgba): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
  }

  /** One-pixel outline of a rectangle. */
  frame(x: number, y: number, w: number, h: number, c: Rgba): void {
    this.rect(x, y, w, 1, c);
    this.rect(x, y + h - 1, w, 1, c);
    this.rect(x, y, 1, h, c);
    this.rect(x + w - 1, y, 1, h, c);
  }

  /** Fill a rectangle from a function of absolute pixel coordinates. */
  paint(x: number, y: number, w: number, h: number, fn: (ax: number, ay: number) => Rgba): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, fn(xx, yy));
  }

  /** Draw rows of a bitmap string ("#" set, anything else skipped). */
  bitmap(x: number, y: number, rows: readonly string[], c: Rgba): void {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) if (row[dx] === "#") this.set(x + dx, y + dy, c);
    });
  }

  /** Nearest-neighbour upscale by an integer factor. */
  scaled(k: number): Canvas {
    const out = new Canvas(this.w * k, this.h * k);
    for (let y = 0; y < out.h; y++) {
      for (let x = 0; x < out.w; x++) {
        const s = ((Math.floor(y / k) * this.w) + Math.floor(x / k)) * 4;
        const d = (y * out.w + x) * 4;
        out.px[d] = this.px[s]!;
        out.px[d + 1] = this.px[s + 1]!;
        out.px[d + 2] = this.px[s + 2]!;
        out.px[d + 3] = this.px[s + 3]!;
      }
    }
    return out;
  }

  /** The top-left w x h corner. */
  crop(w: number, h: number): Canvas {
    const out = new Canvas(w, h);
    for (let y = 0; y < h; y++) {
      out.px.set(this.px.subarray(y * this.w * 4, y * this.w * 4 + w * 4), y * w * 4);
    }
    return out;
  }

  png(): Uint8Array {
    return new Uint8Array(encodePNG(this.px, this.w, this.h));
  }
}

// --- materials ---------------------------------------------------------------

export type Texture =
  | "plain"
  | "speckle"
  | "grass"
  | "planks"
  | "bricks"
  | "shingles"
  | "waves"
  | "streaks"
  | "checker"
  | "rock"
  | "weave";

export interface Material {
  base: Rgba;
  dark: Rgba;
  light: Rgba;
  /** Autotile border colour. */
  edge: Rgba;
  texture: Texture;
  seed: number;
}

export function material(base: Rgba, texture: Texture, seed: number): Material {
  return { base, dark: shade(base, 0.72), light: shade(base, 1.3), edge: shade(base, 0.45), texture, seed };
}

/** A material in a hue derived from a number (used to fill unused slots). */
export function hueMaterial(n: number, texture: Texture): Material {
  return material(hsl((n * 47) % 360, 35, 48), texture, n);
}

/** Texel at absolute pixel (x, y); every texture repeats every 8 px.
 *  `frame` animates waves and streaks. */
export function texel(m: Material, x: number, y: number, frame = 0): Rgba {
  const qx = x & 7;
  const qy = y & 7;
  const h = hash(qx, qy, m.seed);
  switch (m.texture) {
    case "plain":
      return m.base;
    case "speckle":
      return h % 16 === 0 ? m.light : h % 16 === 1 ? m.dark : m.base;
    case "grass":
      return h % 9 === 0 ? m.light : h % 7 === 0 ? m.dark : m.base;
    case "planks": {
      if ((qy & 3) === 3) return m.dark;
      if (((qx + ((qy >> 2) & 1) * 4) & 7) === 7) return m.dark;
      return h % 13 === 0 ? m.light : m.base;
    }
    case "bricks": {
      if ((qy & 3) === 3) return m.dark;
      if (((qx + ((qy >> 2) & 1) * 4) & 7) === 0) return m.dark;
      return m.base;
    }
    case "shingles": {
      if ((qy & 3) === 3) return m.dark;
      if ((qy & 3) === 0) return m.light;
      return ((qx + ((qy >> 2) & 1) * 2) & 3) === 0 ? m.dark : m.base;
    }
    case "waves": {
      if ((qy & 3) === 1 && ((qx + frame * 2) & 7) < 3) return m.light;
      if ((qy & 3) === 3 && ((qx + 4 + frame * 2) & 7) < 2) return m.dark;
      return m.base;
    }
    case "streaks": {
      if ((qx & 3) === 1) return ((qy - frame * 3) & 7) < 3 ? m.light : m.base;
      return ((qy + qx - frame * 3) & 7) === 0 ? m.dark : m.base;
    }
    case "checker":
      return (((qx >> 2) + (qy >> 2)) & 1) === 1 ? m.light : m.base;
    case "rock":
      if (h % 7 === 0 || ((qx * 3 + qy * 5) & 7) === 0) return m.dark;
      return h % 11 === 0 ? m.light : m.base;
    case "weave":
      if (((qx + qy) & 3) === 0) return m.dark;
      return ((qx - qy) & 3) === 0 ? m.light : m.base;
  }
}

// --- autotile blocks ----------------------------------------------------------

/** A FLOOR-table block (2x3 tiles) at tile (bx, by): the isolated preview
 *  tile, the inner-corner tile, and the 2x2 body with its outer border. */
export function floorBlock(c: Canvas, bx: number, by: number, m: Material, frame = 0): void {
  const x0 = bx * TS;
  const y0 = by * TS;
  c.paint(x0, y0, TS * 2, TS * 3, (x, y) => texel(m, x, y, frame));
  c.frame(x0, y0, TS, TS, m.edge);
  const ix = x0 + TS;
  for (const [cx, cy] of [[ix, y0], [ix + TS - 2, y0], [ix, y0 + TS - 2], [ix + TS - 2, y0 + TS - 2]] as const) {
    c.rect(cx, cy, 2, 2, m.edge);
  }
  c.frame(x0, y0 + TS, TS * 2, TS * 2, m.edge);
  c.rect(x0 + 1, y0 + TS + 1, TS * 2 - 2, 1, m.light);
}

/** A WALL-table block (2x2 tiles): body with its outer border. */
export function wallBlock(c: Canvas, bx: number, by: number, m: Material): void {
  const x0 = bx * TS;
  const y0 = by * TS;
  c.paint(x0, y0, TS * 2, TS * 2, (x, y) => texel(m, x, y));
  c.frame(x0, y0, TS * 2, TS * 2, m.edge);
  c.rect(x0 + 1, y0 + 1, TS * 2 - 2, 1, m.light);
}

/** One WATERFALL-table frame (2x1 tiles): streaks with left/right edges. */
export function waterfallBlock(c: Canvas, bx: number, by: number, m: Material, frame: number): void {
  const x0 = bx * TS;
  const y0 = by * TS;
  c.paint(x0, y0, TS * 2, TS, (x, y) => texel(m, x, y, frame));
  c.rect(x0, y0, 1, TS, m.edge);
  c.rect(x0 + TS * 2 - 1, y0, 1, TS, m.edge);
}

// --- tile sheets ----------------------------------------------------------------

/** A1 (kinds 0..15). Even kinds 4.. and kinds 0, 1 animate over three
 *  horizontal frames; odd kinds 5.. are waterfalls (three stacked frames);
 *  kinds 2, 3 are static. Block positions follow Tilemap._drawAutotile. */
export function sheetA1(mat: (kind: number) => Material): Canvas {
  const c = new Canvas(16 * TS, 12 * TS);
  for (let kind = 0; kind < 16; kind++) {
    const m = mat(kind);
    if (kind < 4) {
      const by = kind % 2 === 0 ? 0 : 3;
      if (kind < 2) for (let f = 0; f < 3; f++) floorBlock(c, f * 2, by, m, f);
      else floorBlock(c, 6, by, m);
      continue;
    }
    const tx = kind % 8;
    const ty = Math.floor(kind / 8);
    const bx = Math.floor(tx / 4) * 8;
    const by = ty * 6 + (Math.floor(tx / 2) % 2) * 3;
    if (kind % 2 === 0) for (let f = 0; f < 3; f++) floorBlock(c, bx + f * 2, by, m, f);
    else for (let f = 0; f < 3; f++) waterfallBlock(c, bx + 6, by + f, m, f);
  }
  return c;
}

/** A2 (kinds 16..47): eight 2x3 floor blocks per band, four bands. */
export function sheetA2(mat: (kind: number) => Material): Canvas {
  const c = new Canvas(16 * TS, 12 * TS);
  for (let kind = 16; kind < 48; kind++) {
    floorBlock(c, (kind % 8) * 2, (Math.floor(kind / 8) - 2) * 3, mat(kind));
  }
  return c;
}

/** A3 (kinds 48..79): roofs in bands 0, 2 and walls in bands 1, 3, all
 *  2x2 wall blocks. */
export function sheetA3(mat: (kind: number) => Material): Canvas {
  const c = new Canvas(16 * TS, 8 * TS);
  for (let kind = 48; kind < 80; kind++) {
    wallBlock(c, (kind % 8) * 2, (Math.floor(kind / 8) - 6) * 2, mat(kind));
  }
  return c;
}

/** A4 (kinds 80..127): wall tops (2x3 floor blocks) over wall sides (2x2
 *  wall blocks), three bands of each. */
export function sheetA4(mat: (kind: number) => Material): Canvas {
  const c = new Canvas(16 * TS, 15 * TS);
  for (let kind = 80; kind < 128; kind++) {
    const ty = Math.floor(kind / 8);
    const by = Math.floor((ty - 10) * 2.5 + (ty % 2 === 1 ? 0.5 : 0));
    if ((ty - 10) % 2 === 0) floorBlock(c, (kind % 8) * 2, by, mat(kind));
    else wallBlock(c, (kind % 8) * 2, by, mat(kind));
  }
  return c;
}

export type TileDraw = (c: Canvas, x0: number, y0: number) => void;

/** A5: 8 x 16 plain tiles; index i sits at column i % 8, row i / 8. */
export function sheetA5(draw: (index: number) => TileDraw): Canvas {
  const c = new Canvas(8 * TS, 16 * TS);
  for (let i = 0; i < 128; i++) draw(i)(c, (i % 8) * TS, Math.floor(i / 8) * TS);
  return c;
}

/** B..E: 256 tiles; id n sits at column n % 8 (+ 8 for ids 128..255), row
 *  (n % 128) / 8. Id 0 stays empty, as the editor expects. */
export function sheetB(tiles: ReadonlyMap<number, TileDraw>): Canvas {
  const c = new Canvas(16 * TS, 16 * TS);
  for (const [n, draw] of tiles) {
    if (n === 0) continue;
    const col = (n % 8) + (Math.floor(n / 128) % 2) * 8;
    const row = Math.floor((n % 128) / 8);
    draw(c, col * TS, row * TS);
  }
  return c;
}

/** A plain tile from a material. */
export const plainTile = (m: Material): TileDraw => (c, x0, y0) =>
  c.paint(x0, y0, TS, TS, (x, y) => texel(m, x, y));

// --- characters -----------------------------------------------------------------

/** Draws one 16x16 frame. `dir` 0 down, 1 left, 2 right, 3 up (the sheet's
 *  row order); `pattern` 0..2 with 1 the idle stance. */
export type FrameDraw = (c: Canvas, ox: number, oy: number, dir: number, pattern: number) => void;

/** An eight-character sheet: 4 x 2 characters of 3 x 4 frames. */
export function characterSheet(chars: readonly (FrameDraw | null)[]): Canvas {
  const c = new Canvas(12 * TS, 8 * TS);
  chars.forEach((draw, i) => {
    if (!draw) return;
    for (let dir = 0; dir < 4; dir++) {
      for (let p = 0; p < 3; p++) {
        draw(c, ((i % 4) * 3 + p) * TS, (Math.floor(i / 4) * 4 + dir) * TS, dir, p);
      }
    }
  });
  return c;
}

/** A `$` single-character sheet: 3 x 4 frames. */
export function singleSheet(draw: FrameDraw): Canvas {
  return characterSheet([draw]).crop(3 * TS, 4 * TS);
}

export interface Look {
  skin: Rgba;
  hair: Rgba;
  top: Rgba;
  bottom: Rgba;
}

/** A small walking person. */
export function person(look: Look): FrameDraw {
  return (c, ox, oy, dir, p) => {
    const outline = shade(look.top, 0.35);
    const legs = shade(look.bottom, 1);
    // Legs: the walking frames lengthen one leg and shorten the other.
    const left = p === 0 ? 4 : p === 2 ? 2 : 3;
    const right = p === 2 ? 4 : p === 0 ? 2 : 3;
    if (dir === 1 || dir === 2) {
      c.rect(ox + 6, oy + 12, 2, left, legs);
      c.rect(ox + 8, oy + 12, 2, right, shade(legs, 0.8));
    } else {
      c.rect(ox + 5, oy + 12, 2, left, legs);
      c.rect(ox + 9, oy + 12, 2, right, legs);
    }
    // Body.
    c.rect(ox + 4, oy + 6, 8, 7, outline);
    c.rect(ox + 5, oy + 7, 6, 5, look.top);
    if (dir === 0 || dir === 3) {
      c.rect(ox + 3, oy + 7, 1, 4, shade(look.top, 0.75));
      c.rect(ox + 12, oy + 7, 1, 4, shade(look.top, 0.75));
    } else {
      c.rect(ox + 7, oy + 8, 2, 3, shade(look.top, 0.75));
    }
    // Head.
    c.rect(ox + 4, oy, 8, 8, outline);
    c.rect(ox + 5, oy + 1, 6, 6, look.skin);
    if (dir === 3) {
      c.rect(ox + 5, oy + 1, 6, 6, look.hair);
    } else {
      c.rect(ox + 5, oy + 1, 6, 2, look.hair);
      if (dir === 1) c.rect(ox + 9, oy + 3, 2, 3, look.hair);
      if (dir === 2) c.rect(ox + 5, oy + 3, 2, 3, look.hair);
      const eye = outline;
      if (dir === 0) {
        c.set(ox + 6, oy + 4, eye);
        c.set(ox + 9, oy + 4, eye);
      } else if (dir === 1) {
        c.set(ox + 5, oy + 4, eye);
        c.set(ox + 7, oy + 4, eye);
      } else {
        c.set(ox + 8, oy + 4, eye);
        c.set(ox + 10, oy + 4, eye);
      }
    }
  };
}

/** A rock creature filling most of its frame. */
export function golem(body: Rgba, eyes: Rgba): FrameDraw {
  const m = material(body, "rock", 7);
  return (c, ox, oy, dir, p) => {
    const arm = p - 1;
    c.rect(ox, oy + 6 + arm, 3, 5, shade(body, 0.6));
    c.rect(ox + 13, oy + 6 - arm, 3, 5, shade(body, 0.6));
    c.rect(ox + 2, oy + 1, 12, 15, m.edge);
    c.paint(ox + 3, oy + 2, 10, 13, (x, y) => texel(m, x, y));
    if (dir === 0) {
      c.rect(ox + 5, oy + 6, 2, 1, eyes);
      c.rect(ox + 9, oy + 6, 2, 1, eyes);
    } else if (dir === 1) {
      c.rect(ox + 4, oy + 6, 2, 1, eyes);
      c.rect(ox + 7, oy + 6, 2, 1, eyes);
    } else if (dir === 2) {
      c.rect(ox + 7, oy + 6, 2, 1, eyes);
      c.rect(ox + 10, oy + 6, 2, 1, eyes);
    }
  };
}

/** A fluttering moth; the pattern opens and closes the wings. */
export function moth(wing: Rgba, body: Rgba): FrameDraw {
  return (c, ox, oy, dir, p) => {
    const span = p === 1 ? 5 : p === 0 ? 3 : 4;
    c.rect(ox + 7 - span, oy + 4, span, 6, wing);
    c.rect(ox + 9, oy + 4, span, 6, wing);
    c.rect(ox + 7, oy + 3, 2, 8, body);
    if (dir !== 3) {
      c.set(ox + 7, oy + 3, shade(wing, 1.5));
      c.set(ox + 8, oy + 3, shade(wing, 1.5));
    }
  };
}

/** A chest; the four direction rows are the opening stages (closed in the
 *  "down" row, open in the "up" row), as RPG Maker object sheets lay out. */
export function chest(wood: Rgba, metal: Rgba): FrameDraw {
  return (c, ox, oy, dir) => {
    c.rect(ox + 2, oy + 7, 12, 8, shade(wood, 0.5));
    c.rect(ox + 3, oy + 8, 10, 6, wood);
    c.rect(ox + 7, oy + 9, 2, 2, metal);
    const lid = [4, 3, 2, 1][dir]!;
    if (dir === 0) {
      c.rect(ox + 2, oy + 4, 12, 4, shade(wood, 0.5));
      c.rect(ox + 3, oy + 5, 10, 2, shade(wood, 1.15));
    } else {
      c.rect(ox + 3, oy + 7, 10, 2, rgb("#1c1410"));
      c.rect(ox + 2, oy + 7 - lid - 1, 12, lid + 1, shade(wood, 0.5));
      c.rect(ox + 3, oy + 7 - lid, 10, lid, shade(wood, 1.15));
    }
  };
}

/** A door; the direction rows go from closed (down) to open (up). */
export function door(wood: Rgba): FrameDraw {
  return (c, ox, oy, dir) => {
    c.rect(ox + 1, oy, 14, 16, rgb("#141010"));
    const w = [12, 8, 4, 0][dir]!;
    if (w === 0) return;
    c.rect(ox + 2, oy + 1, w, 15, shade(wood, 0.6));
    c.paint(ox + 3, oy + 2, w - 2, 13, (x, y) => texel(material(wood, "planks", 3), x, y));
    c.set(ox + 2 + w - 3, oy + 9, rgb("#e0c060"));
  };
}

// --- balloons -----------------------------------------------------------------------

const BALLOON_SYMBOLS: readonly (readonly string[])[] = [
  ["..#..", "..#..", "..#..", "..#..", ".....", "..#.."], // 1 exclamation
  [".###.", "#...#", "...#.", "..#..", ".....", "..#.."], // 2 question
  ["..##.", "..#.#", "..#..", ".##..", "###..", ".#..."], // 3 music note
  [".#.#.", "#####", "#####", ".###.", "..#..", "....."], // 4 heart
  ["#.#.#", ".###.", "##.##", ".###.", "#.#.#", "....."], // 5 anger
  ["..#..", ".###.", "#####", "#####", ".###.", "....."], // 6 sweat
  ["#####", "#...#", "#.#.#", "#.###", "#....", "#####"], // 7 frustration
  [".....", ".....", ".....", "#.#.#", ".....", "....."], // 8 silence
  [".###.", "#####", "#####", ".###.", ".###.", "..#.."], // 9 light bulb
  ["####.", "..#..", ".#...", "####.", "...##", "...##"], // 10 zzz
  ["..#..", ".##..", "..#..", "..#..", "..#..", ".###."], // 11 user 1
  [".##..", "#..#.", "..#..", ".#...", "#....", "####."], // 12 user 2
  ["###..", "...#.", ".##..", "...#.", "...#.", "###.."], // 13 user 3
  ["#..#.", "#..#.", "####.", "...#.", "...#.", "...#."], // 14 user 4
  ["####.", "#....", "###..", "...#.", "...#.", "###.."], // 15 user 5
];

const BALLOON_INK: readonly string[] = [
  "#d02020", "#2050d0", "#208040", "#e03070", "#d04010", "#3090e0", "#505050", "#303030",
  "#d0a000", "#4040a0", "#6030a0", "#6030a0", "#6030a0", "#6030a0", "#6030a0",
];

/** Balloon.png: 8 frames per row, rows are balloon ids 1..15. The first
 *  two frames pop the bubble open; the rest bob the symbol. */
export function balloonSheet(): Canvas {
  const c = new Canvas(8 * TS, 15 * TS);
  const white = rgb("#ffffff");
  const line = rgb("#303030");
  for (let row = 0; row < 15; row++) {
    for (let f = 0; f < 8; f++) {
      const ox = f * TS;
      const oy = row * TS;
      if (f < 2) {
        const s = f === 0 ? 3 : 5;
        c.rect(ox + 8 - s, oy + 7 - s, s * 2, s * 2 - 1, line);
        c.rect(ox + 9 - s, oy + 8 - s, s * 2 - 2, s * 2 - 3, white);
        continue;
      }
      c.rect(ox + 2, oy, 12, 13, line);
      c.rect(ox + 1, oy + 1, 14, 11, line);
      c.rect(ox + 2, oy + 1, 12, 11, white);
      c.rect(ox + 7, oy + 13, 2, 2, line);
      c.set(ox + 7, oy + 12, white);
      c.set(ox + 8, oy + 12, white);
      const bob = f % 2;
      c.bitmap(ox + 5, oy + 3 + bob, BALLOON_SYMBOLS[row]!, rgb(BALLOON_INK[row]!));
    }
  }
  return c;
}

/** Deliberately non-stock Window.png palette. Each 12 px cell has a decoy
 * colour around one authored centre pixel, so tests pin RPG Maker's exact
 * ColorManager.textColor sampling coordinates rather than merely the grid. */
export function windowSkin(): Canvas {
  const colours = [
    "#102030", "#214365", "#32659a", "#4387cf", "#54a904", "#65cb39", "#76ed6e", "#870fa3",
    "#9831d8", "#a9530d", "#ba7542", "#cb9777", "#dcb9ac", "#eddbe1", "#fefd16", "#0f1f4b",
    "#204180", "#3163b5", "#4285ea", "#53a71f", "#64c954", "#75eb89", "#860dbe", "#972ff3",
    "#a85128", "#b9735d", "#ca9592", "#dbb7c7", "#ecd9fc", "#fdfb31", "#0e1d66", "#1f3f9b",
  ] as const;
  const canvas = new Canvas(192, 192);
  canvas.rect(0, 0, canvas.w, canvas.h, rgb("#17212b"));
  for (let index = 0; index < colours.length; index++) {
    const x = 96 + (index % 8) * 12;
    const y = 144 + Math.floor(index / 8) * 12;
    canvas.rect(x, y, 12, 12, rgb("#030507"));
    canvas.set(x + 6, y + 6, rgb(colours[index]!));
  }
  return canvas;
}
