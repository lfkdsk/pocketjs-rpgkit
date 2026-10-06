// editor/api/semantic-diff.ts — compact semantic diffs for inspection and logs.
//
// The reversible patch (rpgkit-edit/patch-v1) stays the structural diff: a
// length change replaces a whole array, and a sparse passage reorder reports
// every shifted slot. That is exact and replayable, but noisy to read and
// expensive to log. This module produces a separate, human-facing summary:
// arrays of id-keyed objects change by insert/remove/move, and a sparse
// upper/passage layer reports only the cells whose dense value changed.
//
// Two rules keep the summary honest:
//
//   - The sparse-layer (dense-cell) rule applies only to a map's own fields:
//     an inline map at /maps/<index>/<key>, or a map shard at
//     /shards/<entry>/<key>. An array of pairs with one of those key names
//     anywhere else (a command's args, a battle's setup) is free JSON and is
//     compared element-wise, so a reorder is reported rather than collapsed.
//   - A move names an item whose relative order actually changed. The common
//     items whose before-indices (read in after order) form a longest
//     increasing subsequence kept their order, even when an insert/remove
//     shifted their indices, so they are not reported as moves.
//
// A semantic diff is not a patch: it carries no document hashes and is not
// accepted by `save`. It describes the same change for envelopes, logs and
// review panels. Entries are descriptive, not a replay recipe: an insert
// names its value at its after-array index, a remove names the removed value
// at its before-array index, and a move names the item's before and after
// indices. A mixed change (an insert or remove together with a reorder)
// reports the reorder as moves as well as the insert/remove, so no real
// movement is silently dropped. The summary plus the reversible patch (the
// default envelope) is what reconstructs either side; the summary alone is
// for reading.

import type { JsonValue } from "../../src/engine/types.ts";
import { semanticEqual } from "../engine/document.ts";
import type { PatchValue } from "./types.ts";

export type SemanticChange =
  | { kind: "set"; path: string; before: PatchValue; after: PatchValue }
  | { kind: "insert"; path: string; index: number; after: PatchValue }
  | { kind: "remove"; path: string; index: number; before: PatchValue }
  | { kind: "move"; path: string; from: number; to: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function pointerEscape(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function assertJsonValue(value: unknown, path: string, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} contains a non-finite number`);
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestors));
  else for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, ancestors);
  ancestors.delete(value);
}

function present(value: unknown): PatchValue {
  assertJsonValue(value, "semantic value");
  return { exists: true, value: structuredCloneLike(value) };
}

const ABSENT: PatchValue = Object.freeze({ exists: false });

/** structuredClone is absent in the QuickJS guest; clone JSON values the
 * same way operations.ts does so the editor guest can use this module. */
function structuredCloneLike<T>(value: T): T {
  if (Array.isArray(value)) return value.map(structuredCloneLike) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      copy[key] = structuredCloneLike((value as Record<string, unknown>)[key]);
    }
    return copy as T;
  }
  return value;
}

/** The map fields that are sparse [index, value] layers. Only an array at one
 * of these keys, directly under a map document, gets the dense-cell
 * treatment; any other array of pairs (for example an event command's
 * arguments) is compared element-wise so a reorder is reported rather than
 * silently collapsed. */
const SPARSE_LAYER_KEYS: ReadonlySet<string> = new Set(["upper", "passage", "regions", "terrain", "tiles"]);

/** Whether `path` is a map's own sparse-layer field: an inline map at
 * `/maps/<index>/<key>` or a map shard at `/shards/<entry>/<key>`. The key
 * name alone is not enough — `args`, battle `setup` and other free JSON can
 * contain arrays with the same names, and those must stay element-wise. */
function isMapLayerPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.length !== 4 || segments[0] !== "") return false;
  const [, head, id, key] = segments;
  if (!SPARSE_LAYER_KEYS.has(key)) return false;
  if (head === "maps") return /^(0|[1-9][0-9]*)$/.test(id);
  if (head === "shards") return id.length > 0;
  return false;
}

/** A sparse tile/passage layer: an array of [index, value] pairs. The
 * runtime's dense rule is "the last pair at an index wins". */
function isSparseLayer(value: unknown[]): value is [number, unknown][] {
  return value.every((item) =>
    Array.isArray(item) && item.length === 2 &&
    Number.isInteger(item[0]) && (item[0] as number) >= 0);
}

function denseOf(pairs: [number, unknown][], length: number): (unknown | null)[] {
  const dense: (unknown | null)[] = new Array(length).fill(null);
  for (const [index, value] of pairs) {
    if (index >= 0 && index < length) dense[index] = value;
  }
  return dense;
}

/** Diff two sparse layers by their dense view, so a reorder that keeps every
 * authored cell reports nothing and a one-cell edit reports one cell. */
function sparseLayerDiff(
  before: [number, unknown][],
  after: [number, unknown][],
  path: string,
  changes: SemanticChange[],
): void {
  let maxIndex = -1;
  for (const [index] of before) if (index > maxIndex) maxIndex = index;
  for (const [index] of after) if (index > maxIndex) maxIndex = index;
  if (maxIndex < 0) return;
  const length = maxIndex + 1;
  const beforeDense = denseOf(before, length);
  const afterDense = denseOf(after, length);
  for (let index = 0; index < length; index++) {
    const a = beforeDense[index];
    const b = afterDense[index];
    if (a === b) continue;
    if (semanticEqual(a, b)) continue;
    changes.push({
      kind: "set",
      path: `${path}/${index}`,
      before: a === null || a === undefined ? ABSENT : present(a),
      after: b === null || b === undefined ? ABSENT : present(b),
    });
  }
}

/** Arrays of objects with unique string ids. An empty array counts as one:
 * an empty catalog growing its first entry is an insert, not a replacement. */
function isIdArray(value: unknown[]): value is { id: string }[] {
  if (value.length === 0) return true;
  const ids = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string") return false;
    ids.add(item.id);
  }
  return ids.size === value.length;
}

/** Positions in `seq` of one longest strictly increasing subsequence. The
 * subsequence members are the items that kept their relative order;
 * everything else moved. `seq` holds distinct values (each common item's
 * before-index), so the run is strictly increasing. */
function lisPositions(seq: readonly number[]): number[] {
  // tails[k] is the position in seq of the smallest tail of an increasing
  // run of length k + 1; prev[] reconstructs the chosen run.
  const tails: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < seq[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const positions: number[] = [];
  let cur = tails.length > 0 ? tails[tails.length - 1]! : -1;
  while (cur >= 0) {
    positions.push(cur);
    cur = prev[cur]!;
  }
  return positions.reverse();
}

/** Diff two id-keyed arrays as inserts, removes, moves and per-item field
 * changes. A pure reorder (the same ids, same content) reports only moves.
 * A move is reported only for an item whose relative order changed: the
 * common items whose before-indices form a longest increasing subsequence
 * kept their order (an insert/remove may have shifted their indices), so
 * deleting the first event reports the remove, not a move per survivor. */
function idArrayDiff(
  before: { id: string }[],
  after: { id: string }[],
  path: string,
  changes: SemanticChange[],
): void {
  const beforeIds = before.map((item) => item.id);
  const afterIds = after.map((item) => item.id);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);
  const added = afterIds.filter((id) => !beforeSet.has(id));
  const removed = beforeIds.filter((id) => !afterSet.has(id));
  for (const id of added) {
    const index = afterIds.indexOf(id);
    changes.push({ kind: "insert", path, index, after: present(after[index]) });
  }
  for (const id of removed) {
    const index = beforeIds.indexOf(id);
    changes.push({ kind: "remove", path, index, before: present(before[index]) });
  }
  // Common items in after order. The ones whose before-indices form a longest
  // increasing subsequence kept their relative order and stay quiet even when
  // their index shifted; every other common item genuinely moved and is
  // reported, even when its index happens to be the same on both sides (the
  // middle item of a reversed triple). `from` is the before-array index, `to`
  // the after-array index; each is meaningful on its own side.
  const common = afterIds
    .map((id, index) => ({ id, index, beforeIndex: beforeIds.indexOf(id) }))
    .filter((entry) => entry.beforeIndex >= 0);
  const kept = new Set(
    lisPositions(common.map((entry) => entry.beforeIndex))
      .map((position) => common[position]!.index),
  );
  for (const { id, index, beforeIndex } of common) {
    if (!kept.has(index)) {
      changes.push({ kind: "move", path, from: beforeIndex, to: index });
    }
    walk(before[beforeIndex], after[index], `${path}/${index}`, changes);
  }
}

function walk(before: unknown, after: unknown, path: string, changes: SemanticChange[]): void {
  if (before === after) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    if (isMapLayerPath(path) && isSparseLayer(before) && isSparseLayer(after)) {
      sparseLayerDiff(before, after, path, changes);
      return;
    }
    if (before.length === after.length) {
      if (isIdArray(before) && isIdArray(after)) {
        idArrayDiff(before, after, path, changes);
        return;
      }
      for (let index = 0; index < before.length; index++) {
        walk(before[index], after[index], `${path}/${index}`, changes);
      }
      return;
    }
    if (isIdArray(before) && isIdArray(after)) {
      idArrayDiff(before, after, path, changes);
      return;
    }
    // A length change on a non-id array (for example a command list): keep
    // the structural whole-array replacement; the patch is the precise form.
    changes.push({ kind: "set", path, before: present(before), after: present(after) });
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const child = `${path}/${pointerEscape(key)}`;
      if (!own(before, key)) changes.push({ kind: "set", path: child, before: ABSENT, after: present(after[key]) });
      else if (!own(after, key)) changes.push({ kind: "set", path: child, before: present(before[key]), after: ABSENT });
      else walk(before[key], after[key], child, changes);
    }
    return;
  }
  if (semanticEqual(before, after)) return;
  changes.push({ kind: "set", path, before: present(before), after: present(after) });
}

/** Compact semantic changes between two JSON values (an inline project, or a
 * sharded {kind, shell, shards} logical document). Deterministic: object keys
 * sort, array order is the authored order. `excludePath` drops matching
 * changes (for example a sharded shell's derived checksums, which a reader
 * can rebuild from the shards). */
export function semanticDiffJson(
  before: unknown,
  after: unknown,
  options: { excludePath?: (path: string) => boolean } = {},
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  walk(before, after, "", changes);
  const exclude = options.excludePath;
  if (exclude) return changes.filter((change) => !exclude(change.path));
  return changes;
}
