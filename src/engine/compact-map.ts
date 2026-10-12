// src/engine/compact-map.ts — runtime decoder for rpgkit-map/1 entries.
//
// The format keeps ProjectShell and MapDef unchanged. Only an independently
// addressable map entry is encoded differently, so inline projects, saves,
// the project schema and MAP_SCHEMA_HASH retain their existing meaning.
// Build-side encoding lives in tools/lib/compact-map.ts; this file contains
// only the small, host-neutral decoder that a game opting into compact maps
// pays for.

import type { MapDef, MapTilesetVariant, ParallaxDef, TileId, VehiclePassageDef } from "./types.ts";

export const COMPACT_MAP_MAGIC = "rpgkit-map/1";

function isCompactMapField(key: string): boolean {
  return key === "$" || key === "i" || key === "n" || key === "w" || key === "h" ||
    key === "s" || key === "g" || key === "u" || key === "p" || key === "a" ||
    key === "k" || key === "e" || key === "r" || key === "t" || key === "l" ||
    key === "x" || key === "v" || key === "q";
}

function isCompactTilesetVariantField(key: string): boolean {
  return key === "s" || key === "g" || key === "u" || key === "p" || key === "q" || key === "t";
}

type DenseLayer =
  | ["s", TileId[], number, number[]]
  | ["r", TileId[], number[]]
  | ["j", TileId[]];
type SparseTileLayer =
  | ["d", TileId[], number[]]
  | ["j", [number, TileId][]];
type PassageLayer =
  | ["g", ["pass" | "block", "d" | "r", number[]][]]
  | ["j", [number, "pass" | "block"][]];

interface CompactMapEnvelope {
  $: typeof COMPACT_MAP_MAGIC;
  i: string;
  n: string;
  w: number;
  h: number;
  s?: string[];
  x?: string;
  v?: unknown;
  g: DenseLayer;
  u?: SparseTileLayer;
  p?: PassageLayer;
  q?: unknown;
  a?: unknown;
  k?: string[];
  e?: unknown;
  r?: unknown;
  t?: unknown;
  l?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(detail: string): never {
  throw new Error(`compact map: ${detail}`);
}

function integer(value: unknown, label: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail(`${label} must be an integer >= ${min}`);
  return value as number;
}

function tilePalette(value: unknown, label: string): TileId[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} palette must not be empty`);
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== null && typeof value[i] !== "string") fail(`${label} palette ${i} must be a string or null`);
  }
  return value as TileId[];
}

function numbers(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  for (let i = 0; i < value.length; i++) integer(value[i], `${label} ${i}`);
  return value as number[];
}

function decodeParallax(value: unknown): ParallaxDef {
  if (!isObject(value)) fail("parallax must be an object");
  const allowed = new Set(["image", "loopX", "loopY", "sx", "sy", "zero", "showInEditor"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown parallax field ${JSON.stringify(key)}`);
  }
  if (value.image !== null && typeof value.image !== "string") {
    fail("parallax image must be a string or null");
  }
  if (typeof value.loopX !== "boolean" || typeof value.loopY !== "boolean") {
    fail("parallax loopX and loopY must be booleans");
  }
  if (typeof value.sx !== "number" || !Number.isFinite(value.sx) ||
      typeof value.sy !== "number" || !Number.isFinite(value.sy)) {
    fail("parallax sx and sy must be finite numbers");
  }
  if (value.zero !== undefined && typeof value.zero !== "boolean") {
    fail("parallax zero must be a boolean");
  }
  if (value.showInEditor !== undefined && typeof value.showInEditor !== "boolean") {
    fail("parallax showInEditor must be a boolean");
  }
  return {
    image: value.image,
    loopX: value.loopX,
    loopY: value.loopY,
    sx: value.sx,
    sy: value.sy,
    ...(value.zero === undefined ? {} : { zero: value.zero }),
    ...(value.showInEditor === undefined ? {} : { showInEditor: value.showInEditor }),
  } as ParallaxDef;
}

function decodeDense(value: unknown, cells: number, label = "ground"): TileId[] {
  if (!Array.isArray(value) || typeof value[0] !== "string") fail(`${label} encoding is malformed`);
  if (value[0] === "j") {
    if (value.length !== 2) fail(`raw ${label} encoding must have two fields`);
    const raw = value[1];
    if (!Array.isArray(raw) || raw.length !== cells) fail(`raw ${label} has ${Array.isArray(raw) ? raw.length : "invalid"} cells, expected ${cells}`);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== null && typeof raw[i] !== "string") fail(`raw ${label} cell ${i} must be a string or null`);
    }
    return raw as TileId[];
  }
  const palette = tilePalette(value[1], label);
  if (value[0] === "s") {
    if (value.length !== 4) fail(`sparse ${label} encoding must have four fields`);
    const fallback = integer(value[2], `${label} default palette index`);
    if (fallback >= palette.length) fail(`${label} default palette index is out of range`);
    const encoded = numbers(value[3], `${label} exceptions`);
    if (encoded.length % 2 !== 0) fail(`${label} exceptions must be delta/index pairs`);
    const out = new Array<TileId>(cells).fill(palette[fallback]!);
    let index = -1;
    for (let cursor = 0; cursor < encoded.length; cursor += 2) {
      const delta = encoded[cursor]!;
      const paletteIndex = encoded[cursor + 1]!;
      if (delta < 1) fail(`${label} exception deltas must be positive`);
      index += delta;
      if (index >= cells) fail(`${label} exception index is out of range`);
      if (paletteIndex >= palette.length) fail(`${label} exception palette index is out of range`);
      out[index] = palette[paletteIndex]!;
    }
    return out;
  }
  if (value[0] === "r") {
    if (value.length !== 3) fail(`RLE ${label} encoding must have three fields`);
    const encoded = numbers(value[2], `${label} runs`);
    if (encoded.length % 2 !== 0) fail(`${label} runs must be length/index pairs`);
    const out = new Array<TileId>(cells);
    let cursor = 0;
    for (let i = 0; i < encoded.length; i += 2) {
      const length = encoded[i]!;
      const paletteIndex = encoded[i + 1]!;
      if (length < 1) fail(`${label} run lengths must be positive`);
      if (paletteIndex >= palette.length) fail(`${label} run palette index is out of range`);
      if (cursor + length > cells) fail(`${label} runs exceed map dimensions`);
      out.fill(palette[paletteIndex]!, cursor, cursor + length);
      cursor += length;
    }
    if (cursor !== cells) fail(`${label} runs produced ${cursor} cells, expected ${cells}`);
    return out;
  }
  return fail(`unsupported ${label} encoding ${JSON.stringify(value[0])}`);
}

function decodeSparseTiles(value: unknown, cells: number, label = "upper"): [number, TileId][] {
  if (!Array.isArray(value) || typeof value[0] !== "string") fail(`${label} encoding is malformed`);
  if (value[0] === "j") {
    if (value.length !== 2 || !Array.isArray(value[1])) fail(`raw ${label} layer must be an array`);
    const out: [number, TileId][] = [];
    for (let cursor = 0; cursor < value[1].length; cursor++) {
      const pair = value[1][cursor];
      if (!Array.isArray(pair) || pair.length !== 2) fail(`raw ${label} entry ${cursor} must be a pair`);
      const index = integer(pair[0], `raw ${label} entry ${cursor} index`);
      if (index >= cells) fail(`${label} index is out of range`);
      if (pair[1] !== null && typeof pair[1] !== "string") {
        fail(`raw ${label} entry ${cursor} tile must be a string or null`);
      }
      out.push([index, pair[1] as TileId]);
    }
    return out;
  }
  if (value[0] !== "d" || value.length !== 3) fail(`unsupported ${label} encoding ${JSON.stringify(value[0])}`);
  const palette = tilePalette(value[1], label);
  const encoded = numbers(value[2], `${label} entries`);
  if (encoded.length % 2 !== 0) fail(`${label} entries must be delta/index pairs`);
  const out: [number, TileId][] = [];
  let index = -1;
  for (let cursor = 0; cursor < encoded.length; cursor += 2) {
    const delta = encoded[cursor]!;
    const paletteIndex = encoded[cursor + 1]!;
    if (delta < 1) fail(`${label} deltas must be positive`);
    index += delta;
    if (index >= cells) fail(`${label} index is out of range`);
    if (paletteIndex >= palette.length) fail(`${label} palette index is out of range`);
    out.push([index, palette[paletteIndex]!]);
  }
  return out;
}

function deltaDecode(values: number[], label: string): number[] {
  const out = new Array<number>(values.length);
  let previous = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (i > 0 && value < 1) fail(`${label} deltas after the first must be positive`);
    previous = i === 0 ? value : previous + value;
    out[i] = previous;
  }
  return out;
}

function rangeDecode(values: number[], label: string, cells: number): number[] {
  if (values.length % 2 !== 0) fail(`${label} ranges must be start/count pairs`);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 2) {
    const start = values[i]!;
    const count = values[i + 1]!;
    if (count < 1) fail(`${label} range counts must be positive`);
    if (start >= cells || count > cells - start) fail(`${label} range is out of bounds`);
    for (let offset = 0; offset < count; offset++) out.push(start + offset);
  }
  return out;
}

function decodePassage(value: unknown, cells: number, label = "passage"): [number, "pass" | "block"][] {
  if (!Array.isArray(value) || typeof value[0] !== "string") fail(`${label} encoding is malformed`);
  if (value[0] === "j") {
    if (value.length !== 2 || !Array.isArray(value[1])) fail(`raw ${label} must be an array`);
    const out: [number, "pass" | "block"][] = [];
    for (let cursor = 0; cursor < value[1].length; cursor++) {
      const pair = value[1][cursor];
      if (!Array.isArray(pair) || pair.length !== 2) fail(`raw ${label} entry ${cursor} must be a pair`);
      const index = integer(pair[0], `raw ${label} entry ${cursor} index`);
      if (index >= cells) fail(`${label} index is out of range`);
      if (pair[1] !== "pass" && pair[1] !== "block") {
        fail(`raw ${label} entry ${cursor} value must be pass or block`);
      }
      out.push([index, pair[1]]);
    }
    return out;
  }
  if (value[0] !== "g" || value.length !== 2 || !Array.isArray(value[1])) {
    fail(`unsupported ${label} encoding ${JSON.stringify(value[0])}`);
  }
  const out: [number, "pass" | "block"][] = [];
  const seen = new Set<number>();
  for (let groupIndex = 0; groupIndex < value[1].length; groupIndex++) {
    const group = value[1][groupIndex];
    if (!Array.isArray(group) || group.length !== 3 ||
      (group[0] !== "pass" && group[0] !== "block") ||
      (group[1] !== "d" && group[1] !== "r")) {
      fail(`${label} group ${groupIndex} is malformed`);
    }
    const encoded = numbers(group[2], `${label} group ${groupIndex}`);
    const indices = group[1] === "d"
      ? deltaDecode(encoded, `${label} group ${groupIndex}`)
      : rangeDecode(encoded, `${label} group ${groupIndex}`, cells);
    for (const index of indices) {
      if (index >= cells) fail(`${label} index is out of range`);
      if (seen.has(index)) fail(`${label} index is duplicated`);
      seen.add(index);
      out.push([index, group[0]]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Decode a sparse [index, small-int] layer (regions 1..255, terrain tags
 *  1..7): the same raw/grouped shapes as passage, with the value validated
 *  against `min`..`max`. */
function decodeSparseInt(value: unknown, cells: number, label: string, min: number, max: number): [number, number][] {
  if (!Array.isArray(value) || typeof value[0] !== "string") fail(`${label} encoding is malformed`);
  if (value[0] === "j") {
    if (value.length !== 2 || !Array.isArray(value[1])) fail(`raw ${label} must be an array`);
    const out: [number, number][] = [];
    for (let cursor = 0; cursor < value[1].length; cursor++) {
      const pair = value[1][cursor];
      if (!Array.isArray(pair) || pair.length !== 2) fail(`raw ${label} entry ${cursor} must be a pair`);
      const index = integer(pair[0], `raw ${label} entry ${cursor} index`);
      if (index >= cells) fail(`${label} index is out of range`);
      const tag = pair[1];
      if (typeof tag !== "number" || !Number.isSafeInteger(tag) || tag < min || tag > max) {
        fail(`${label} entry ${cursor} value must be an integer in ${min}..${max}`);
      }
      out.push([index, tag]);
    }
    return out;
  }
  if (value[0] !== "g" || value.length !== 2 || !Array.isArray(value[1])) {
    fail(`unsupported ${label} encoding ${JSON.stringify(value[0])}`);
  }
  const out: [number, number][] = [];
  const seen = new Set<number>();
  for (let groupIndex = 0; groupIndex < value[1].length; groupIndex++) {
    const group = value[1][groupIndex];
    if (!Array.isArray(group) || group.length !== 3 ||
      typeof group[0] !== "number" || !Number.isSafeInteger(group[0]) || group[0] < min || group[0] > max ||
      (group[1] !== "d" && group[1] !== "r")) {
      fail(`${label} group ${groupIndex} is malformed`);
    }
    const encoded = numbers(group[2], `${label} group ${groupIndex}`);
    const indices = group[1] === "d"
      ? deltaDecode(encoded, `${label} group ${groupIndex}`)
      : rangeDecode(encoded, `${label} group ${groupIndex}`, cells);
    for (const index of indices) {
      if (index >= cells) fail(`${label} index is out of range`);
      if (seen.has(index)) fail(`${label} index is duplicated`);
      seen.add(index);
      out.push([index, group[0]]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function decodeSheets(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  return value;
}

function decodeVehiclePassage(value: unknown, cells: number, label: string): VehiclePassageDef {
  if (!isObject(value)) fail(`${label} must be an object`);
  const allowed = new Set(["boat", "ship", "airshipLand"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown ${label} field ${JSON.stringify(key)}`);
  }
  const out: VehiclePassageDef = {};
  for (const kind of ["boat", "ship", "airshipLand"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, kind)) continue;
    const indices = numbers(value[kind], `${label} ${kind}`);
    for (const index of indices) {
      if (index >= cells) fail(`${label} ${kind} index is out of range`);
    }
    out[kind] = indices;
  }
  return out;
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function decodeTilesetVariants(value: unknown, cells: number): Record<string, MapTilesetVariant> {
  if (!isObject(value)) fail("tileset variants must be an object");
  const out: Record<string, MapTilesetVariant> = {};
  for (const id of Object.keys(value)) {
    if (id.length === 0) fail("tileset variant id must not be empty");
    const raw = value[id];
    if (!isObject(raw)) fail(`tileset variant ${JSON.stringify(id)} must be an object`);
    for (const key of Object.keys(raw)) {
      if (!isCompactTilesetVariantField(key)) {
        fail(`unknown tileset variant ${JSON.stringify(id)} field ${JSON.stringify(key)}`);
      }
    }
    const label = `tileset variant ${JSON.stringify(id)}`;
    const variant: MapTilesetVariant = {
      ground: decodeDense(raw.g, cells, `${label} ground`),
    };
    if (raw.s !== undefined) variant.sheets = decodeSheets(raw.s, `${label} sheets`);
    if (raw.u !== undefined) variant.upper = decodeSparseTiles(raw.u, cells, `${label} upper`);
    if (raw.p !== undefined) variant.passage = decodePassage(raw.p, cells, `${label} passage`);
    if (raw.q !== undefined) variant.vehiclePassage = decodeVehiclePassage(raw.q, cells, `${label} vehicle passage`);
    if (raw.t !== undefined) variant.terrain = decodeSparseInt(raw.t, cells, `${label} terrain`, 1, 7);
    defineOwn(out as unknown as Record<string, unknown>, id, variant);
  }
  return out;
}

/** Decode the sparse raw-tile layer [index, [z0,z1,z2,z3]]: the raw "j"
 *  spelling or the palette "d" spelling (per-map tuple dictionary plus
 *  delta/palette-index pairs), the same shapes as the upper layer. */
function decodeTiles(value: unknown, cells: number): [number, [number, number, number, number]][] {
  if (!Array.isArray(value) || typeof value[0] !== "string") fail("tiles encoding is malformed");
  if (value[0] === "j") {
    if (value.length !== 2 || !Array.isArray(value[1])) fail("raw tiles must be an array");
    const out: [number, [number, number, number, number]][] = [];
    for (let cursor = 0; cursor < value[1].length; cursor++) {
      const pair = value[1][cursor];
      if (!Array.isArray(pair) || pair.length !== 2) fail(`raw tiles entry ${cursor} must be a pair`);
      const index = integer(pair[0], `raw tiles entry ${cursor} index`);
      if (index >= cells) fail("tiles index is out of range");
      out.push([index, tileQuad(pair[1], `raw tiles entry ${cursor}`)]);
    }
    return out;
  }
  if (value[0] !== "d" || value.length !== 3) fail(`unsupported tiles encoding ${JSON.stringify(value[0])}`);
  if (!Array.isArray(value[1]) || value[1].length === 0) fail("tiles palette must not be empty");
  const palette: [number, number, number, number][] = [];
  for (let i = 0; i < value[1].length; i++) {
    palette.push(tileQuad(value[1][i], `tiles palette ${i}`));
  }
  const encoded = numbers(value[2], "tiles entries");
  if (encoded.length % 2 !== 0) fail("tiles entries must be delta/index pairs");
  const out: [number, [number, number, number, number]][] = [];
  let index = -1;
  for (let cursor = 0; cursor < encoded.length; cursor += 2) {
    const delta = encoded[cursor]!;
    const paletteIndex = encoded[cursor + 1]!;
    if (delta < 1) fail("tiles deltas must be positive");
    index += delta;
    if (index >= cells) fail("tiles index is out of range");
    if (paletteIndex >= palette.length) fail("tiles palette index is out of range");
    out.push([index, palette[paletteIndex]!]);
  }
  return out;
}

function tileQuad(value: unknown, label: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) fail(`${label} must be a four-tuple`);
  const out = new Array<number>(4);
  for (let i = 0; i < 4; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      fail(`${label}[${i}] must be a non-negative integer`);
    }
    out[i] = v;
  }
  return out as [number, number, number, number];
}

interface DecodeTask {
  input: unknown;
  parent: unknown[] | Record<string, unknown>;
  key: string | number;
  dataProperty: boolean;
}

function assignDecoded(task: DecodeTask, value: unknown): void {
  if (!task.dataProperty) {
    (task.parent as unknown[])[task.key as number] = value;
    return;
  }
  Object.defineProperty(task.parent, task.key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Decode without using the JS call stack. Real imported command trees reach
 *  more than 1,000 nested if/then levels, and schema-valid content has no
 *  artificial nesting limit. */
function decodeKeyed(value: unknown, keys: readonly string[]): unknown {
  const root: unknown[] = [undefined];
  const stack: DecodeTask[] = [{ input: value, parent: root, key: 0, dataProperty: false }];
  while (stack.length > 0) {
    const task = stack.pop()!;
    const input = task.input;
    if (Array.isArray(input)) {
      const out = new Array<unknown>(input.length);
      assignDecoded(task, out);
      for (let index = input.length - 1; index >= 0; index--) {
        stack.push({ input: input[index], parent: out, key: index, dataProperty: false });
      }
      continue;
    }
    if (!isObject(input)) {
      assignDecoded(task, input);
      continue;
    }
    const names = Object.keys(input);
    if (names.length !== 1 || names[0] !== "" || !Array.isArray(input[""])) {
      fail("event object marker is malformed");
    }
    const pairs = input[""] as unknown[];
    if (pairs.length % 2 !== 0) fail("event object key/value list has odd length");
    const out: Record<string, unknown> = {};
    assignDecoded(task, out);
    const decodedKeys = new Array<string>(pairs.length / 2);
    const seen = new Set<string>();
    for (let index = 0; index < pairs.length; index += 2) {
      const keyIndex = integer(pairs[index], "event key index");
      const key = keys[keyIndex];
      if (key === undefined) fail("event key index is out of range");
      if (seen.has(key)) fail(`event key ${JSON.stringify(key)} is duplicated`);
      seen.add(key);
      decodedKeys[index / 2] = key;
    }
    for (let index = pairs.length - 2; index >= 0; index -= 2) {
      stack.push({
        input: pairs[index + 1],
        parent: out,
        key: decodedKeys[index / 2]!,
        dataProperty: true,
      });
    }
  }
  return root[0];
}

/** Fast marker check performed after JSON.parse. */
export function isCompactMapValue(value: unknown): value is CompactMapEnvelope {
  return isObject(value) && value.$ === COMPACT_MAP_MAGIC;
}

/** Decode one parsed rpgkit-map/1 envelope into the ordinary MapDef shape. */
export function decodeCompactMap(value: unknown): MapDef {
  if (!isCompactMapValue(value)) fail("missing rpgkit-map/1 marker");
  for (const key of Object.keys(value)) {
    if (!isCompactMapField(key)) fail(`unknown envelope field ${JSON.stringify(key)}`);
  }
  if (typeof value.i !== "string" || typeof value.n !== "string") fail("id and name must be strings");
  const width = integer(value.w, "width", 1);
  const height = integer(value.h, "height", 1);
  if (width > 256 || height > 256) fail("map dimensions exceed the v1 256x256 limit");
  const cells = width * height;
  if (!Number.isSafeInteger(cells)) fail("map dimensions are too large");
  if (value.x !== undefined && (typeof value.x !== "string" || value.x.length === 0)) {
    fail("tileset id must be a non-empty string");
  }
  const out: MapDef = {
    id: value.i,
    name: value.n,
    width,
    height,
    ground: decodeDense(value.g, cells),
  };
  if (value.s !== undefined) out.sheets = decodeSheets(value.s, "sheets");
  if (value.x !== undefined) out.tileset = value.x;
  if (value.v !== undefined) out.tilesetVariants = decodeTilesetVariants(value.v, cells);
  if (value.u !== undefined) out.upper = decodeSparseTiles(value.u, cells);
  if (value.p !== undefined) out.passage = decodePassage(value.p, cells);
  if (value.q !== undefined) out.vehiclePassage = decodeVehiclePassage(value.q, cells, "vehicle passage");
  if (value.r !== undefined) out.regions = decodeSparseInt(value.r, cells, "regions", 1, 255);
  if (value.t !== undefined) out.terrain = decodeSparseInt(value.t, cells, "terrain", 1, 7);
  if (value.l !== undefined) out.tiles = decodeTiles(value.l, cells);
  if (value.a !== undefined) out.parallax = decodeParallax(value.a);
  if (value.e !== undefined) {
    if (!Array.isArray(value.k) || value.k.some((key) => typeof key !== "string") || new Set(value.k).size !== value.k.length) {
      fail("event key table must contain unique strings");
    }
    const events = decodeKeyed(value.e, value.k);
    if (!Array.isArray(events)) fail("decoded events must be an array");
    out.events = events as MapDef["events"];
  } else if (value.k !== undefined) {
    fail("event key table is present without events");
  }
  return out;
}
