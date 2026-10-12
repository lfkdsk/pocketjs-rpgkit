// tools/lib/compact-map.ts — deterministic rpgkit-map/1 encoder.
//
// Dense and sparse tile layers use per-map dictionaries plus the smallest of
// sparse/RLE/raw spellings. Event/page/command objects share one frequency-
// ordered key table; arrays and scalar JSON values stay in their authored
// order. The runtime decoder is src/engine/compact-map.ts.

import { COMPACT_MAP_MAGIC, decodeCompactMap } from "../../src/engine/compact-map.ts";
import { canonicalJson, utf8Encode } from "../../src/engine/save.ts";
import type { MapDef, TileId } from "../../src/engine/types.ts";

export interface EncodedCompactMap {
  value: Readonly<Record<string, unknown>>;
  text: string;
  bytes: Uint8Array;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const escapedAscii = (text: string): string => text.replace(
  /[^\x00-\x7f]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
);
const jsonLength = (value: unknown): number => JSON.stringify(value).length;
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function tileToken(tile: TileId): string {
  return tile === null ? "\x00" : `\x01${tile}`;
}

function tilePalette(values: readonly TileId[]): { palette: TileId[]; indices: number[] } {
  const counts = new Map<string, { value: TileId; count: number }>();
  for (const value of values) {
    const token = tileToken(value);
    const row = counts.get(token);
    if (row) row.count++;
    else counts.set(token, { value, count: 1 });
  }
  const palette = [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || compareText(a[0], b[0]))
    .map((row) => row[1].value);
  const byToken = new Map(palette.map((value, index) => [tileToken(value), index]));
  return { palette, indices: values.map((value) => byToken.get(tileToken(value))!) };
}

function encodeDense(ground: readonly TileId[]): unknown {
  const { palette, indices } = tilePalette(ground);
  const sparse: number[] = [];
  let previous = -1;
  for (let index = 0; index < indices.length; index++) {
    const paletteIndex = indices[index]!;
    if (paletteIndex === 0) continue;
    sparse.push(index - previous, paletteIndex);
    previous = index;
  }
  const runs: number[] = [];
  for (let cursor = 0; cursor < indices.length;) {
    const paletteIndex = indices[cursor]!;
    let end = cursor + 1;
    while (end < indices.length && indices[end] === paletteIndex) end++;
    runs.push(end - cursor, paletteIndex);
    cursor = end;
  }
  const candidates: unknown[] = [
    ["s", palette, 0, sparse],
    ["r", palette, runs],
    ["j", ground],
  ];
  let best = candidates[0]!;
  let bestLength = jsonLength(best);
  for (let i = 1; i < candidates.length; i++) {
    const length = jsonLength(candidates[i]);
    if (length < bestLength) {
      best = candidates[i]!;
      bestLength = length;
    }
  }
  return best;
}

function strictlyIncreasing(entries: readonly [number, unknown][]): boolean {
  for (let i = 1; i < entries.length; i++) if (entries[i]![0] <= entries[i - 1]![0]) return false;
  return true;
}

function encodeUpper(upper: readonly [number, TileId][]): unknown {
  const raw = ["j", upper];
  if (!strictlyIncreasing(upper)) return raw;
  const { palette, indices } = tilePalette(upper.map((entry) => entry[1]));
  const encoded: number[] = [];
  let previous = -1;
  for (let i = 0; i < upper.length; i++) {
    encoded.push(upper[i]![0] - previous, indices[i]!);
    previous = upper[i]![0];
  }
  const compact = ["d", palette, encoded];
  return jsonLength(compact) < jsonLength(raw) ? compact : raw;
}

function deltaEncode(indices: readonly number[]): number[] {
  let previous = 0;
  return indices.map((value, index) => {
    const encoded = index === 0 ? value : value - previous;
    previous = value;
    return encoded;
  });
}

function rangeEncode(indices: readonly number[]): number[] {
  const out: number[] = [];
  for (let cursor = 0; cursor < indices.length;) {
    const start = indices[cursor]!;
    let end = cursor + 1;
    while (end < indices.length && indices[end] === indices[end - 1]! + 1) end++;
    out.push(start, end - cursor);
    cursor = end;
  }
  return out;
}

function encodePassage(passage: readonly [number, "pass" | "block"][]): unknown {
  const raw = ["j", passage];
  if (!strictlyIncreasing(passage)) return raw;
  const groups = (["block", "pass"] as const).flatMap((value) => {
    const indices = passage.filter((entry) => entry[1] === value).map((entry) => entry[0]);
    if (indices.length === 0) return [];
    const deltas = deltaEncode(indices);
    const ranges = rangeEncode(indices);
    return [[value, jsonLength(deltas) <= jsonLength(ranges) ? "d" : "r",
      jsonLength(deltas) <= jsonLength(ranges) ? deltas : ranges]] as const;
  });
  const compact = ["g", groups];
  return jsonLength(compact) < jsonLength(raw) ? compact : raw;
}

/** Sparse [index, small-int] layers (regions 1..255, terrain tags 1..7):
 *  group indices by value and delta/range encode each group, the same shape
 *  as passage. A map whose layer is already the smallest spelling keeps it. */
function encodeSparseInt(entries: readonly [number, number][]): unknown {
  const raw = ["j", entries];
  if (!strictlyIncreasing(entries)) return raw;
  const byValue = new Map<number, number[]>();
  for (const [index, value] of entries) {
    const list = byValue.get(value);
    if (list) list.push(index);
    else byValue.set(value, [index]);
  }
  const groups = [...byValue.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, indices]) => {
      const deltas = deltaEncode(indices);
      const ranges = rangeEncode(indices);
      return [value, jsonLength(deltas) <= jsonLength(ranges) ? "d" : "r",
        jsonLength(deltas) <= jsonLength(ranges) ? deltas : ranges] as const;
    });
  const compact = ["g", groups];
  return jsonLength(compact) < jsonLength(raw) ? compact : raw;
}

function encodeTilesetVariants(variants: NonNullable<MapDef["tilesetVariants"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(variants)) {
    const variant = variants[id]!;
    const encoded: Record<string, unknown> = { g: encodeDense(variant.ground) };
    if (hasOwn(variant, "sheets")) encoded.s = variant.sheets;
    if (hasOwn(variant, "upper")) encoded.u = encodeUpper(variant.upper ?? []);
    if (hasOwn(variant, "passage")) encoded.p = encodePassage(variant.passage ?? []);
    if (hasOwn(variant, "vehiclePassage")) encoded.q = variant.vehiclePassage;
    if (hasOwn(variant, "terrain")) encoded.t = encodeSparseInt(variant.terrain ?? []);
    Object.defineProperty(out, id, {
      value: encoded,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

/** Sparse [index, [z0,z1,z2,z3]] raw-tile layer: a per-map palette of the
 *  four-tuples plus delta/palette-index pairs, the same shape as the upper
 *  layer's "d" spelling. */
function encodeTiles(entries: readonly [number, [number, number, number, number]][]): unknown {
  const raw = ["j", entries];
  if (!strictlyIncreasing(entries)) return raw;
  const token = (value: readonly number[]): string => value.join(",");
  const counts = new Map<string, { value: [number, number, number, number]; count: number }>();
  for (const [, value] of entries) {
    const tk = token(value);
    const row = counts.get(tk);
    if (row) row.count++;
    else counts.set(tk, { value: [...value] as [number, number, number, number], count: 1 });
  }
  const palette = [...counts.values()]
    .sort((a, b) => b.count - a.count || compareText(token(a.value), token(b.value)))
    .map((row) => row.value);
  const byToken = new Map(palette.map((value, index) => [token(value), index]));
  const encoded: number[] = [];
  let previous = -1;
  for (const [index, value] of entries) {
    encoded.push(index - previous, byToken.get(token(value))!);
    previous = index;
  }
  const compact = ["d", palette, encoded];
  return jsonLength(compact) < jsonLength(raw) ? compact : raw;
}

function collectKeys(value: unknown, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, counts);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    collectKeys((value as Record<string, unknown>)[key], counts);
  }
}

function encodeKeyed(value: unknown, keyIndex: ReadonlyMap<string, number>): unknown {
  if (Array.isArray(value)) return value.map((item) => encodeKeyed(item, keyIndex));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort((a, b) => keyIndex.get(a)! - keyIndex.get(b)!);
  const pairs: unknown[] = [];
  for (const key of keys) pairs.push(keyIndex.get(key)!, encodeKeyed(object[key], keyIndex));
  return { "": pairs };
}

function encodeEvents(events: NonNullable<MapDef["events"]>): { keys: string[]; value: unknown } {
  const counts = new Map<string, number>();
  collectKeys(events, counts);
  const keys = [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([key]) => key);
  const keyIndex = new Map(keys.map((key, index) => [key, index]));
  return { keys, value: encodeKeyed(events, keyIndex) };
}

/** Encode one validated MapDef into deterministic, ASCII rpgkit-map/1 JSON. */
export function encodeCompactMap(map: MapDef): EncodedCompactMap {
  const value: Record<string, unknown> = {
    $: COMPACT_MAP_MAGIC,
    i: map.id,
    n: map.name,
    w: map.width,
    h: map.height,
    g: encodeDense(map.ground),
  };
  if (hasOwn(map, "sheets")) value.s = map.sheets;
  if (hasOwn(map, "tileset")) value.x = map.tileset;
  if (hasOwn(map, "tilesetVariants")) value.v = encodeTilesetVariants(map.tilesetVariants ?? {});
  if (hasOwn(map, "upper")) value.u = encodeUpper(map.upper ?? []);
  if (hasOwn(map, "passage")) value.p = encodePassage(map.passage ?? []);
  if (hasOwn(map, "vehiclePassage")) value.q = map.vehiclePassage;
  if (hasOwn(map, "regions")) value.r = encodeSparseInt(map.regions ?? []);
  if (hasOwn(map, "terrain")) value.t = encodeSparseInt(map.terrain ?? []);
  if (hasOwn(map, "tiles")) value.l = encodeTiles(map.tiles ?? []);
  if (hasOwn(map, "parallax")) value.a = map.parallax;
  if (hasOwn(map, "events")) {
    const encoded = encodeEvents(map.events ?? []);
    value.k = encoded.keys;
    value.e = encoded.value;
  }
  const text = escapedAscii(canonicalJson(value));
  return { value, text, bytes: utf8Encode(text) };
}

/** Build-time self-check used by cookers/tests without duplicating decoding. */
export function roundTripCompactMap(map: MapDef): MapDef {
  return decodeCompactMap(JSON.parse(encodeCompactMap(map).text));
}
