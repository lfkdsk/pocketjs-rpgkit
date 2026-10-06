import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  diffJson,
  executeEditOperation,
  executeEditTransaction,
  semanticHash,
} from "../editor/api/operations.ts";
import { executeShardedEditTransaction } from "../editor/api/sharded.ts";
import { semanticDiffJson, type SemanticChange } from "../editor/api/semantic-diff.ts";
import { runFileEdit } from "../editor/api/file.ts";
import { createProposalFromOperations } from "../editor/api/proposals.ts";
import { dryRunShardedProposal } from "../editor/api/proposal-sharded.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import { serializeProject } from "../editor/engine/document.ts";
import type { Project } from "../src/engine/types.ts";

function fixture(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Batch fixture",
    tileSize: 16,
    start: { map: "map", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "s", pak: "chunks", cols: 4, rows: 4 }],
    items: [],
    maps: [{
      id: "map",
      name: "Map",
      width: 4,
      height: 3,
      sheets: ["s"],
      ground: [
        "s.0", "s.0", "s.1", "s.1",
        "s.0", "s.2", "s.1", "s.1",
        "s.3", "s.2", "s.2", "s.1",
      ],
      passage: [[0, "block"], [1, "block"], [5, "pass"]],
      events: [{
        id: "npc",
        name: "Guide",
        x: 1,
        y: 1,
        pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Hello"] }] }],
      }],
    }],
  };
}

function source(project: Project): string {
  return serializeProject(project);
}

function ok<T extends { response: { ok: boolean; error?: unknown } }>(execution: T): T {
  if (!execution.response.ok) throw new Error(JSON.stringify(execution.response));
  return execution;
}

describe("batch transaction (inline)", () => {
  test("runs several operations as one patch and one output", () => {
    const project = fixture();
    const execution = executeEditTransaction(source(project), {
      operations: [
        { command: "add-item", args: { item: { id: "key", name: "Key", sprite: "s.0", type: "key" } } },
        { command: "add-event", args: { map: "map", event: { id: "sign", x: 2, y: 2, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Sign"] }] }] } } },
        { command: "paint-passage", args: { map: "map", x: 3, y: 0, value: "block" } },
      ],
    });
    ok(execution);
    const response = execution.response as Extract<typeof execution.response, { ok: true }>;
    expect(response.changed).toBe(true);
    expect(response.command).toBe("batch");
    // One reversible patch covers the whole transaction.
    expect(response.patch).toBeDefined();
    expect(response.patch!.changes.length).toBeGreaterThan(0);
    // The output is the final document; applying the patch forward from the
    // original reaches it and reverse returns to the original.
    const forward = executeEditOperation(source(project), "save", { patch: response.patch, direction: "forward" });
    ok(forward);
    expect(semanticHash(JSON.parse((forward as { output: string }).output))).toBe(response.patch!.afterHash);
    const reverse = executeEditOperation((forward as { output: string }).output, "save", { patch: response.patch, direction: "reverse" });
    ok(reverse);
    expect(semanticHash(JSON.parse((reverse as { output: string }).output))).toBe(response.patch!.beforeHash);
    // Per-operation results are reported in order.
    const results = (response.result as { operations: { command: string }[] }).operations;
    expect(results.map((r) => r.command)).toEqual(["add-item", "add-event", "paint-passage"]);
  });

  test("a failing operation publishes nothing (all-or-nothing)", () => {
    const project = fixture();
    const original = source(project);
    const execution = executeEditTransaction(original, {
      operations: [
        { command: "add-item", args: { item: { id: "key", name: "Key", sprite: "s.0", type: "key" } } },
        // This op fails: the event id is taken.
        { command: "add-event", args: { map: "map", event: { id: "npc", x: 2, y: 2, pages: [{ trigger: "action", commands: [] }] } } },
      ],
    });
    expect(execution.response.ok).toBe(false);
    if (!execution.response.ok) {
      expect(execution.response.error.code).toBe("DUPLICATE_EVENT");
      // The failure names the 0-based step that errored (the second op).
      expect(execution.response.error.operationIndex).toBe(1);
    }
    // No output: the caller writes nothing.
    expect(execution.output).toBeUndefined();
  });

  test("refuses save and nested batch", () => {
    const project = fixture();
    for (const bad of [{ command: "save" }, { command: "batch", args: { operations: [] } }]) {
      const execution = executeEditTransaction(source(project), { operations: [bad] });
      expect(execution.response.ok).toBe(false);
      if (!execution.response.ok) expect(execution.response.error.code).toBe("INVALID_ARGUMENT");
    }
  });

  test("an empty operation list is an EMPTY_TRANSACTION failure", () => {
    const project = fixture();
    const execution = executeEditTransaction(source(project), { operations: [] });
    expect(execution.response.ok).toBe(false);
    if (!execution.response.ok) expect(execution.response.error.code).toBe("INVALID_ARGUMENT");
  });

  test("a batch of only no-op reads reports changed:false and no output", () => {
    const project = fixture();
    const execution = executeEditTransaction(source(project), {
      operations: [
        { command: "list-maps" },
        { command: "list-events", args: { map: "map" } },
      ],
    });
    ok(execution);
    const response = execution.response as Extract<typeof execution.response, { ok: true }>;
    expect(response.changed).toBe(false);
    expect(execution.output).toBeUndefined();
  });
});

describe("compact envelope and semantic diff", () => {
  test("compact envelope omits the patch and empties the structural diff", () => {
    const project = fixture();
    const execution = executeEditOperation(source(project), "add-event", {
      map: "map",
      event: { id: "sign", x: 2, y: 2, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Sign"] }] }] },
      envelope: "compact",
    });
    ok(execution);
    const response = execution.response as Extract<typeof execution.response, { ok: true }>;
    expect(response.diff).toEqual([]);
    expect(response.patch).toBeUndefined();
    expect(response.semanticDiff).toBeDefined();
    // One insert into the events array, not a whole-array replacement.
    const inserts = response.semanticDiff!.filter((c) => c.kind === "insert");
    expect(inserts.length).toBe(1);
    expect(inserts[0]!.path).toBe("/maps/0/events");
  });

  test("default envelope keeps the structural diff and patch", () => {
    const project = fixture();
    const execution = executeEditOperation(source(project), "add-event", {
      map: "map",
      event: { id: "sign", x: 2, y: 2, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Sign"] }] }] },
    });
    ok(execution);
    const response = execution.response as Extract<typeof execution.response, { ok: true }>;
    expect(response.diff.length).toBeGreaterThan(0);
    expect(response.patch).toBeDefined();
    expect(response.semanticDiff).toBeUndefined();
  });

  test("one passage cell change reports only that cell semantically", () => {
    const project = fixture();
    // Cell (0,0) already has a block override; changing it to pass reorders the
    // sparse array (the edited pair moves to the end), which the structural
    // diff reports as many slot changes.
    const structural = executeEditOperation(source(project), "paint-passage", { map: "map", x: 0, y: 0, value: "pass" });
    ok(structural);
    const sResponse = structural.response as Extract<typeof structural.response, { ok: true }>;
    expect(sResponse.diff.length).toBeGreaterThan(1);

    const compact = executeEditOperation(source(project), "paint-passage", { map: "map", x: 0, y: 0, value: "pass", envelope: "compact" });
    ok(compact);
    const cResponse = compact.response as Extract<typeof compact.response, { ok: true }>;
    expect(cResponse.semanticDiff).toEqual([
      { kind: "set", path: "/maps/0/passage/0", before: { exists: true, value: "block" }, after: { exists: true, value: "pass" } },
    ]);
  });

  test("an invalid envelope value fails a single inline edit", () => {
    const project = fixture();
    const execution = executeEditOperation(source(project), "add-item", {
      item: { id: "key", name: "Key", sprite: "s.0", type: "key" },
      envelope: "bogus",
    });
    expect(execution.response.ok).toBe(false);
    if (execution.response.ok) throw new Error("expected failure");
    expect(execution.response.error.code).toBe("INVALID_ARGUMENT");
    expect(execution.output).toBeUndefined();
  });

  test("semantic diff: id-array insert, remove and move", () => {
    const before = { maps: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    // insert
    expect(semanticDiffJson(before, { maps: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] })).toEqual([
      { kind: "insert", path: "/maps", index: 3, after: { exists: true, value: { id: "d" } } },
    ]);
    // remove: the survivor kept its relative order, so the index shift is
    // not reported as a move
    expect(semanticDiffJson(before, { maps: [{ id: "a" }, { id: "c" }] })).toEqual([
      { kind: "remove", path: "/maps", index: 1, before: { exists: true, value: { id: "b" } } },
    ]);
    // pure reorder -> moves only
    const moved = semanticDiffJson(before, { maps: [{ id: "c" }, { id: "a" }, { id: "b" }] });
    expect(moved.every((c) => c.kind === "move")).toBe(true);
    expect(moved.length).toBeGreaterThan(0);
  });

  test("semantic diff: sparse layer reports only changed cells", () => {
    const before = { maps: [{ id: "map", passage: [[0, "block"], [1, "block"], [5, "pass"]] }] };
    // Edit cell 0 (reorders the sparse array) and add cell 2.
    const after = { maps: [{ id: "map", passage: [[1, "block"], [5, "pass"], [0, "pass"], [2, "block"]] }] };
    expect(semanticDiffJson(before, after)).toEqual([
      { kind: "set", path: "/maps/0/passage/0", before: { exists: true, value: "block" }, after: { exists: true, value: "pass" } },
      { kind: "set", path: "/maps/0/passage/2", before: { exists: false }, after: { exists: true, value: "block" } },
    ]);
  });

  test("semantic diff: a sparse layer under a map shard keeps the dense-cell rule", () => {
    const before = { shards: { "maps/map.rkm": { passage: [[0, "block"], [1, "block"], [5, "pass"]] } } };
    const after = { shards: { "maps/map.rkm": { passage: [[1, "block"], [5, "pass"], [0, "pass"], [2, "block"]] } } };
    expect(semanticDiffJson(before, after)).toEqual([
      { kind: "set", path: "/shards/maps~1map.rkm/passage/0", before: { exists: true, value: "block" }, after: { exists: true, value: "pass" } },
      { kind: "set", path: "/shards/maps~1map.rkm/passage/2", before: { exists: false }, after: { exists: true, value: "block" } },
    ]);
  });

  test("semantic diff: a pair array that is not a map layer reports its reorder", () => {
    // Event command arguments are free JSON; a pair array there must not be
    // collapsed by the sparse-layer (dense-cell) rule.
    const before = { args: { route: [[2, 7], [0, 3]] } };
    const after = { args: { route: [[0, 3], [2, 7]] } };
    const changes = semanticDiffJson(before, after);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((c) => c.path.startsWith("/args/route/"))).toBe(true);
  });

  test("semantic diff: an empty pair array growing reports the array, not a bogus cell", () => {
    const before = { args: { route: [] as [number, number][] } };
    const after = { args: { route: [[3, 4]] } };
    expect(semanticDiffJson(before, after)).toEqual([
      { kind: "set", path: "/args/route", before: { exists: true, value: [] }, after: { exists: true, value: [[3, 4]] } },
    ]);
  });

  test("semantic diff: pair arrays named like map layers outside maps stay element-wise", () => {
    // Regression: the sparse-layer (dense-cell) rule used to key on the last
    // path segment, so free JSON with a same-named key was silently collapsed.
    // Battle `setup` and command `args` are free JSON in the schema.
    const setup = semanticDiffJson(
      { setup: { terrain: [[0, 1], [0, 2]] } },
      { setup: { terrain: [[0, 2]] } },
    );
    expect(setup).toEqual([
      { kind: "set", path: "/setup/terrain", before: { exists: true, value: [[0, 1], [0, 2]] }, after: { exists: true, value: [[0, 2]] } },
    ]);

    const passage = semanticDiffJson(
      { args: { passage: [] as [number, number][] } },
      { args: { passage: [[3, 4]] } },
    );
    expect(passage).toEqual([
      { kind: "set", path: "/args/passage", before: { exists: true, value: [] }, after: { exists: true, value: [[3, 4]] } },
    ]);

    const tiles = semanticDiffJson(
      { args: { tiles: [[2, 7], [0, 3]] } },
      { args: { tiles: [[0, 3], [2, 7]] } },
    );
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((c) => c.path.startsWith("/args/tiles/"))).toBe(true);
  });

  test("semantic diff: an insert together with a reorder reports the move too", () => {
    // The add-map then move-map case: village moves from index 0 to index 2
    // while cove is appended. The reorder must not be silently dropped.
    const before = { maps: [{ id: "village" }, { id: "forest" }, { id: "cave" }] };
    const after = { maps: [{ id: "forest" }, { id: "cave" }, { id: "village" }, { id: "cove" }] };
    const changes = semanticDiffJson(before, after);
    expect(changes).toContainEqual({ kind: "insert", path: "/maps", index: 3, after: { exists: true, value: { id: "cove" } } });
    expect(changes).toContainEqual({ kind: "move", path: "/maps", from: 0, to: 2 });
  });

  test("semantic diff: deleting the first items reports no shift moves", () => {
    // The survivors kept their relative order; the index shift alone is not
    // a move. On a real event list this used to report one move per survivor.
    const events = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}` }));
    const changes = semanticDiffJson(
      { maps: [{ id: "map", events }] },
      { maps: [{ id: "map", events: events.slice(1) }] },
    );
    expect(changes).toEqual([
      { kind: "remove", path: "/maps/0/events", index: 0, before: { exists: true, value: { id: "e0" } } },
    ]);
  });

  test("semantic diff: a reversal reports every item that moved, including one whose index is unchanged", () => {
    const before = { maps: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    const after = { maps: [{ id: "c" }, { id: "b" }, { id: "a" }] };
    const moves = semanticDiffJson(before, after).filter((c) => c.kind === "move");
    expect(moves).toHaveLength(2);
    const reversed5 = { maps: ["e", "d", "c", "b", "a"].map((id) => ({ id })) };
    const moves5 = semanticDiffJson({ maps: ["a", "b", "c", "d", "e"].map((id) => ({ id })) }, reversed5)
      .filter((c) => c.kind === "move");
    expect(moves5).toHaveLength(4);
  });

  test("semantic diff: deleting the first of 263 maps reports one remove, no shift moves", () => {
    // The 263-map shell case: removing map 0 used to report 262 moves.
    const maps = Array.from({ length: 263 }, (_, i) => ({ id: `map-${i}` }));
    const changes = semanticDiffJson({ maps }, { maps: maps.slice(1) });
    expect(changes).toEqual([
      { kind: "remove", path: "/maps", index: 0, before: { exists: true, value: { id: "map-0" } } },
    ]);
  });

  test("a compact batch reports a reorder of ext command args named like a map layer", () => {
    // End-to-end regression for the sparse-layer keying bug: an ext command's
    // args are free JSON, so reordering a `tiles` pair array there must show
    // up in the compact summary instead of an empty semanticDiff.
    const project = fixture();
    const inserted = ok(executeEditOperation(source(project), "insert-command", {
      map: "map",
      event: "npc",
      page: 0,
      address: { path: [], index: 0 },
      command: { op: "ext", call: "game.path", args: { tiles: [[2, 7], [0, 3]] } },
    }));
    const execution = executeEditTransaction(inserted.output!, {
      envelope: "compact",
      operations: [{
        command: "update-command",
        args: {
          map: "map",
          event: "npc",
          page: 0,
          address: { path: [], index: 0 },
          field: "args",
          value: JSON.stringify({ tiles: [[0, 3], [2, 7]] }),
        },
      }],
    });
    ok(execution);
    const response = execution.response as Extract<typeof execution.response, { ok: true }>;
    const semantic = response.semanticDiff!;
    expect(semantic.length).toBeGreaterThan(0);
    expect(semantic.every((c) => c.path.includes("/commands/0/args/tiles/"))).toBe(true);
  });

  test("property: the semantic summary covers every structural change path", () => {
    // Seeded PRNG so a failure is reproducible.
    let state = 0x9e3779b9;
    const rand = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

    const KEYS = ["name", "value", "route", "points", "data", "config", "label", "meta", "v"];
    // The sparse-layer key names appear bare on random objects. The dense-cell
    // rule applies only under a map document (/maps/<n>/<key> or
    // /shards/<entry>/<key>); these trees never take that shape, so an array
    // with one of these names here is free JSON that must stay element-wise.
    const SPARSE_KEYS = ["upper", "passage", "regions", "terrain", "tiles"];
    const LEAVES = ["x", "y", 1, 2, 3, true, false, null];

    function genValue(depth: number): unknown {
      if (depth <= 0 || rand() < 0.4) return pick(LEAVES);
      const kind = int(3);
      if (kind === 0) {
        // Array of id-keyed objects.
        const count = 1 + int(4);
        const used = new Set<string>();
        const items: Record<string, unknown>[] = [];
        for (let i = 0; i < count; i++) {
          let id = `${pick(KEYS)}${int(100000)}`;
          while (used.has(id)) id = `${pick(KEYS)}${int(100000)}`;
          used.add(id);
          items.push({ id, v: genValue(depth - 1) });
        }
        return items;
      }
      if (kind === 1) {
        // Generic array, sometimes of [number, number] pairs.
        const count = 1 + int(4);
        const arr: unknown[] = [];
        for (let i = 0; i < count; i++) arr.push(rand() < 0.5 ? [int(8), int(8)] : genValue(depth - 1));
        return arr;
      }
      // Object. A bare sparse-layer key name may hold a pair array; it must
      // not get the dense-cell treatment away from a map document.
      const count = 1 + int(4);
      const obj: Record<string, unknown> = {};
      const used = new Set<string>();
      for (let i = 0; i < count; i++) {
        let key = rand() < 0.3 ? pick(SPARSE_KEYS) : `${pick(KEYS)}${i}`;
        while (used.has(key)) key = `${pick(KEYS)}${i}_${int(1000)}`;
        used.add(key);
        obj[key] = genValue(depth - 1);
      }
      return obj;
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function isIdArrayValue(value: unknown): value is { id: string }[] {
      if (!Array.isArray(value) || value.length === 0) return false;
      const ids = new Set<string>();
      for (const item of value) {
        if (!isRecord(item) || typeof item.id !== "string") return false;
        ids.add(item.id);
      }
      return ids.size === value.length;
    }

    /** Apply one real mutation to a deep clone, never touching an `id` field
     * or an id array's order (those have their own tracked mutations). */
    function mutate(value: unknown): unknown {
      const copy: unknown = JSON.parse(JSON.stringify(value));
      const applyAt = (v: unknown): boolean => {
        if (Array.isArray(v) && v.length > 0) {
          if (isIdArrayValue(v)) {
            // Change an item's payload, keeping the array an id array.
            const item = v[int(v.length)]! as { id: string; v: unknown };
            item.v = genValue(2);
            return true;
          }
          const r = rand();
          if (r < 0.34 && v.length > 1) {
            const i = int(v.length);
            let j = int(v.length);
            while (j === i) j = int(v.length);
            const tmp = v[i]; v[i] = v[j]; v[j] = tmp;
            return true;
          }
          if (r < 0.67) {
            v[int(v.length)] = genValue(1);
            return true;
          }
          v.splice(int(v.length), 1);
          return true;
        }
        if (isRecord(v) && Object.keys(v).length > 0) {
          const keys = Object.keys(v).filter((key) => key !== "id");
          if (keys.length === 0) return false;
          const key = pick(keys);
          if (rand() < 0.5) {
            v[key] = genValue(1);
            return true;
          }
          return applyAt(v[key]);
        }
        return false;
      };
      if (!applyAt(copy)) {
        if (Array.isArray(copy)) copy.push(genValue(1));
        else if (isRecord(copy)) copy.__changed = true;
        else return { old: copy, changed: true };
      }
      return copy;
    }

    // Tracked id-array mutations: the test knows exactly which ids the
    // summary must name, so a collapse to a whole-array set (or a dropped
    // move) is caught, not hidden behind a loose coverage check.
    type TrackedMutation =
      | { kind: "id-insert"; path: string; id: string; index: number }
      | { kind: "id-remove"; path: string; id: string; index: number }
      | { kind: "id-swap"; path: string; ids: [string, string] }
      | {
        kind: "id-combined";
        path: string;
        inserted: { id: string; index: number };
        removed: { id: string; index: number };
        swapped: [string, string];
      }
      | { kind: "other" };

    function collectIdArrays(value: unknown, path: string, out: { path: string; array: { id: string }[] }[]): void {
      if (Array.isArray(value)) {
        if (isIdArrayValue(value)) out.push({ path, array: value });
        value.forEach((item, index) => collectIdArrays(item, `${path}/${index}`, out));
        return;
      }
      if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) collectIdArrays(item, `${path}/${key}`, out);
      }
    }

    function atPath(value: unknown, path: string): unknown {
      let cur = value;
      for (const part of path.split("/").slice(1)) {
        if (Array.isArray(cur)) cur = cur[Number(part)];
        else cur = (cur as Record<string, unknown>)[part];
      }
      return cur;
    }

    function newId(arr: { id: string }[]): string {
      let id = `n${int(1000000)}`;
      while (arr.some((item) => item.id === id)) id = `n${int(1000000)}`;
      return id;
    }

    /** Mutate `arr` in place: an insert, a remove, a swap, or a remove +
     * swap + insert on the same array. */
    function applyIdMutation(arr: { id: string }[], path: string): TrackedMutation {
      const strategies = arr.length >= 3
        ? ["insert", "remove", "swap", "combined"]
        : arr.length === 2
        ? ["insert", "remove", "swap"]
        : ["insert", "remove"];
      const strategy = pick(strategies);
      if (strategy === "insert") {
        const item = { id: newId(arr), v: genValue(2) };
        const index = int(arr.length + 1);
        arr.splice(index, 0, item);
        return { kind: "id-insert", path, id: item.id, index };
      }
      if (strategy === "remove") {
        const index = int(arr.length);
        const id = arr[index]!.id;
        arr.splice(index, 1);
        return { kind: "id-remove", path, id, index };
      }
      if (strategy === "swap") {
        const i = int(arr.length);
        let j = int(arr.length);
        while (j === i) j = int(arr.length);
        const ids: [string, string] = [arr[i]!.id, arr[j]!.id];
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
        return { kind: "id-swap", path, ids };
      }
      const r = int(arr.length);
      const removed = { id: arr[r]!.id, index: r };
      arr.splice(r, 1);
      const i = int(arr.length);
      let j = int(arr.length);
      while (j === i) j = int(arr.length);
      const swapped: [string, string] = [arr[i]!.id, arr[j]!.id];
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
      const item = { id: newId(arr), v: genValue(2) };
      const index = int(arr.length + 1);
      arr.splice(index, 0, item);
      return { kind: "id-combined", path, inserted: { id: item.id, index }, removed, swapped };
    }

    // A structural path is covered when the summary names the same path, or
    // names the array itself with an insert/remove/move (their defined
    // semantics: the array's elements changed). A summary `set` at an
    // ancestor never covers descendants — collapsing a subtree to one
    // whole-array or root set must not pass as a summary.
    const covers = (structural: { path: string }[], semantic: SemanticChange[]): boolean => {
      for (const s of structural) {
        const ok = semantic.some((c) => {
          if (c.path === s.path) return true;
          if (c.kind === "set") return false;
          return s.path.startsWith(`${c.path}/`);
        });
        if (!ok) return false;
      }
      return true;
    };

    const compatible = (p: string, q: string): boolean =>
      p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);

    const expectIdMutation = (
      i: number,
      mutation: Exclude<TrackedMutation, { kind: "other" }>,
      semantic: SemanticChange[],
      before: unknown,
      after: unknown,
    ): void => {
      const atPathChanges = semantic.filter((c) => c.path === mutation.path);
      const moves = atPathChanges.filter((c): c is Extract<SemanticChange, { kind: "move" }> => c.kind === "move");
      const beforeArr = atPath(before, mutation.path) as { id: string }[];
      const afterArr = atPath(after, mutation.path) as { id: string }[];
      const beforeIndex = new Map(beforeArr.map((item, index) => [item.id, index]));
      const afterIndex = new Map(afterArr.map((item, index) => [item.id, index]));
      const commonIds = afterArr.map((item) => item.id).filter((id) => beforeIndex.has(id));
      const insertEntry = (id: string, index: number): boolean =>
        atPathChanges.some((c) =>
          c.kind === "insert" && c.index === index &&
          c.after.exists && (c.after.value as { id?: unknown }).id === id);
      const removeEntry = (id: string, index: number): boolean =>
        atPathChanges.some((c) =>
          c.kind === "remove" && c.index === index &&
          c.before.exists && (c.before.value as { id?: unknown }).id === id);
      if (mutation.kind === "id-insert") {
        if (!insertEntry(mutation.id, mutation.index)) {
          throw new Error(`case ${i}: expected an insert of ${mutation.id} at ${mutation.path} index ${mutation.index}\n${JSON.stringify(atPathChanges)}`);
        }
        if (moves.length !== 0) throw new Error(`case ${i}: an insert reported shift moves: ${JSON.stringify(moves)}`);
      } else if (mutation.kind === "id-remove") {
        if (!removeEntry(mutation.id, mutation.index)) {
          throw new Error(`case ${i}: expected a remove of ${mutation.id} at ${mutation.path} index ${mutation.index}\n${JSON.stringify(atPathChanges)}`);
        }
        if (moves.length !== 0) throw new Error(`case ${i}: a remove reported shift moves: ${JSON.stringify(moves)}`);
      } else {
        if (moves.length < 1) {
          throw new Error(`case ${i}: a reorder reported no move\n${JSON.stringify({ mutation, atPathChanges })}`);
        }
        // Every reported move must be an item whose relative order genuinely
        // changed: some other common item's before/after relation with it
        // flipped. An item that an insert/remove merely shifted has no such
        // flip and must not be reported.
        for (const move of moves) {
          const id = afterArr[move.to]!.id;
          const bx = beforeIndex.get(id)!;
          const ax = afterIndex.get(id)!;
          const flipped = commonIds.some((other) => {
            if (other === id) return false;
            const by = beforeIndex.get(other)!;
            const ay = afterIndex.get(other)!;
            return (bx < by) !== (ax < ay);
          });
          if (!flipped) {
            throw new Error(`case ${i}: move of ${id} (${move.from}->${move.to}) did not change relative order\n${JSON.stringify({ mutation, moves })}`);
          }
        }
        // Completeness: once the moved items are set aside, every other
        // common item must keep its relative order. A reorder the summary
        // hides (an unreported item that did move) breaks this.
        const movedIds = new Set(moves.map((move) => afterArr[move.to]!.id));
        const quiet = commonIds.filter((id) => !movedIds.has(id)).map((id) => beforeIndex.get(id)!);
        if (quiet.some((value, k) => k > 0 && value < quiet[k - 1]!)) {
          throw new Error(`case ${i}: a reorder is hidden: unreported items changed order\n${JSON.stringify({ mutation, moves, quiet })}`);
        }
        if (mutation.kind === "id-combined") {
          if (!insertEntry(mutation.inserted.id, mutation.inserted.index)) {
            throw new Error(`case ${i}: expected an insert of ${mutation.inserted.id}\n${JSON.stringify(atPathChanges)}`);
          }
          if (!removeEntry(mutation.removed.id, mutation.removed.index)) {
            throw new Error(`case ${i}: expected a remove of ${mutation.removed.id}\n${JSON.stringify(atPathChanges)}`);
          }
        }
      }
    };

    for (let i = 0; i < 300; i++) {
      const before = genValue(4);
      const locations: { path: string; array: { id: string }[] }[] = [];
      collectIdArrays(before, "", locations);
      let mutation: TrackedMutation = { kind: "other" };
      let after: unknown;
      if (locations.length > 0 && rand() < 0.7) {
        const loc = pick(locations);
        const clone = JSON.parse(JSON.stringify(before));
        const arr = atPath(clone, loc.path) as { id: string }[];
        mutation = applyIdMutation(arr, loc.path);
        after = clone;
      } else {
        after = mutate(before);
      }
      const structural = diffJson(before, after);
      if (structural.length === 0) continue; // no real change; nothing to cover
      const semantic = semanticDiffJson(before, after);
      if (semantic.length === 0) {
        throw new Error(`case ${i}: a real change produced an empty summary\n${JSON.stringify({ before, after, structural }, null, 2)}`);
      }
      if (!covers(structural, semantic)) {
        throw new Error(`case ${i}: structural paths not covered by the summary\n${JSON.stringify({ before, after, structural, semantic }, null, 2)}`);
      }
      // The summary invents no locations: every `set` lands on a structural
      // path or inside a structural subtree.
      for (const c of semantic) {
        if (c.kind !== "set") continue;
        if (!structural.some((s) => compatible(c.path, s.path))) {
          throw new Error(`case ${i}: summary set at ${c.path} matches no structural path\n${JSON.stringify({ before, after, structural, semantic }, null, 2)}`);
        }
      }
      if (mutation.kind !== "other") expectIdMutation(i, mutation, semantic, before, after);
    }
  });

  test("batch with compact envelope returns one semantic summary", () => {
    const project = fixture();
    const execution = executeEditTransaction(source(project), {
      envelope: "compact",
      operations: [
        { command: "add-item", args: { item: { id: "key", name: "Key", sprite: "s.0", type: "key" } } },
        { command: "paint-passage", args: { map: "map", x: 0, y: 0, value: "pass" } },
      ],
    });
    ok(execution);
    const response = execution.response as Extract<typeof execution.response, { ok: true }>;
    expect(response.diff).toEqual([]);
    expect(response.patch).toBeUndefined();
    const kinds = response.semanticDiff!.map((c) => `${c.kind}:${c.path}`);
    expect(kinds).toContain("insert:/items");
    expect(kinds).toContain("set:/maps/0/passage/0");
  });
});

describe("batch on sharded projects", () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function shardedFixture() {
    const root = mkdtempSync(join(import.meta.dir, ".rpgkit-batch-"));
    temporary.push(root);
    const split = splitProjectMaps(fixture());
    writeFileSync(join(root, "project.json"), split.shellText);
    for (const entry of split.entries) {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true });
      writeFileSync(join(root, entry.path), entry.text);
    }
    return { root, shell: join(root, "project.json") };
  }

  /** Two maps so a batch can load one shard and change another. */
  function multiMapFixture() {
    const project: Project = {
      format: "rpgkit-project/v1",
      title: "Multi-map fixture",
      tileSize: 16,
      start: { map: "a", x: 0, y: 0, dir: "down" },
      sheets: [{ id: "s", pak: "chunks", cols: 4, rows: 4 }],
      items: [],
      maps: [
        {
          id: "a",
          name: "A",
          width: 4,
          height: 3,
          sheets: ["s"],
          ground: [
            "s.0", "s.0", "s.1", "s.1",
            "s.0", "s.2", "s.1", "s.1",
            "s.3", "s.2", "s.2", "s.1",
          ],
          passage: [[0, "block"], [1, "block"], [5, "pass"]],
          events: [{
            id: "npc-a",
            name: "Guide A",
            x: 1,
            y: 1,
            pages: [{ trigger: "action", commands: [{ op: "text", lines: ["A"] }] }],
          }],
        },
        {
          id: "b",
          name: "B",
          width: 4,
          height: 3,
          sheets: ["s"],
          ground: [
            "s.1", "s.1", "s.0", "s.0",
            "s.1", "s.2", "s.0", "s.0",
            "s.3", "s.2", "s.2", "s.1",
          ],
          passage: [[2, "pass"]],
          events: [{
            id: "npc-b",
            name: "Guide B",
            x: 2,
            y: 2,
            pages: [{ trigger: "action", commands: [{ op: "text", lines: ["B"] }] }],
          }],
        },
      ],
    };
    const root = mkdtempSync(join(import.meta.dir, ".rpgkit-batch-multi-"));
    temporary.push(root);
    const split = splitProjectMaps(project);
    writeFileSync(join(root, "project.json"), split.shellText);
    for (const entry of split.entries) {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true });
      writeFileSync(join(root, entry.path), entry.text);
    }
    return { root, shell: join(root, "project.json") };
  }

  test("writes only the affected shard and the shell", () => {
    const { shell } = shardedFixture();
    const response = runFileEdit({
      command: "batch",
      file: shell,
      args: {
        operations: [
          { command: "paint-passage", args: { map: "map", x: 3, y: 0, value: "block" } },
          { command: "add-event", args: { map: "map", event: { id: "sign", x: 2, y: 2, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Sign"] }] }] } } },
        ],
      },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    expect(response.written).toBe(true);
    // Only the one map shard plus the shell were replaced.
    expect(response.writtenFiles?.length).toBe(2);
    expect(response.writtenFiles?.some((f) => f.endsWith("project.json"))).toBe(true);
  });

  test("a failing sharded batch writes nothing", () => {
    const { shell } = shardedFixture();
    const before = readFileSync(shell, "utf8");
    const response = runFileEdit({
      command: "batch",
      file: shell,
      args: {
        operations: [
          { command: "paint-passage", args: { map: "map", x: 3, y: 0, value: "block" } },
          { command: "add-event", args: { map: "map", event: { id: "npc", x: 2, y: 2, pages: [] } } },
        ],
      },
    });
    expect(response.ok).toBe(false);
    expect(response.written).toBe(false);
    // The shell is untouched.
    expect(readFileSync(shell, "utf8")).toBe(before);
    if (!response.ok) {
      // The failure names the 0-based step that errored (the second op).
      expect(response.error.operationIndex).toBe(1);
    }
  });

  test("a sharded batch failing on its first op reports operationIndex 0", () => {
    const { shell } = shardedFixture();
    const response = runFileEdit({
      command: "batch",
      file: shell,
      args: {
        operations: [
          { command: "paint-passage", args: { map: "nope", x: 0, y: 0, value: "pass" } },
          { command: "add-event", args: { map: "map", event: { id: "sign", x: 2, y: 2, pages: [] } } },
        ],
      },
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.operationIndex).toBe(0);
  });

  test("sharded batch compact semantic diff drops derived shell metadata", () => {
    const { shell } = shardedFixture();
    const response = runFileEdit({
      command: "batch",
      file: shell,
      args: {
        envelope: "compact",
        operations: [
          { command: "paint-passage", args: { map: "map", x: 3, y: 0, value: "block" } },
        ],
      },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    const semantic = (response as { semanticDiff?: { path: string }[] }).semanticDiff ?? [];
    // No derived shell checksum/manifest noise.
    expect(semantic.some((c) => c.path.includes("sha256") || c.path.includes("mapManifestHash"))).toBe(false);
    // The passage cell change is reported.
    expect(semantic.some((c) => c.path.includes("/passage/"))).toBe(true);
  });

  test("executeShardedEditTransaction loads shards lazily through the loader", () => {
    const { shell } = shardedFixture();
    const shellSource = readFileSync(shell, "utf8");
    const loaded: string[] = [];
    const execution = executeShardedEditTransaction(shellSource, (entry) => {
      loaded.push(entry);
      return readFileSync(join(dirname(shell), entry), "utf8");
    }, {
      operations: [
        { command: "paint-passage", args: { map: "map", x: 3, y: 0, value: "block" } },
      ],
    });
    ok(execution);
    // Only the addressed map's shard was loaded.
    expect(loaded.length).toBe(1);
    expect(execution.output).toBeDefined();
    expect(execution.output!.shards[loaded[0]!]).toBeDefined();
  });

  test("a batch that loads two shards writes only the one it changed", () => {
    const { root, shell } = multiMapFixture();
    const bPath = join(root, "maps", "b.json");
    const bBefore = readFileSync(bPath, "utf8");
    // The read loads b's shard; the edit loads and changes a's. A batch that
    // published every loaded shard would rewrite b even though it is unchanged.
    const response = runFileEdit({
      command: "batch",
      file: shell,
      args: {
        operations: [
          { command: "list-events", args: { map: "b" } },
          { command: "paint-passage", args: { map: "a", x: 0, y: 0, value: "pass" } },
        ],
      },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    expect(response.written).toBe(true);
    const written = response.writtenFiles ?? [];
    expect(written.length).toBe(2);
    expect(written.some((f) => f.endsWith("project.json"))).toBe(true);
    expect(written.some((f) => f.endsWith(join("maps", "a.json")))).toBe(true);
    expect(written.some((f) => f.endsWith(join("maps", "b.json")))).toBe(false);
    // The untouched shard is byte-identical on disk.
    expect(readFileSync(bPath, "utf8")).toBe(bBefore);
  });
});

describe("compact envelope on sharded projects", () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function shardedFixture() {
    const root = mkdtempSync(join(import.meta.dir, ".rpgkit-batch-compact-"));
    temporary.push(root);
    const split = splitProjectMaps(fixture());
    writeFileSync(join(root, "project.json"), split.shellText);
    for (const entry of split.entries) {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true });
      writeFileSync(join(root, entry.path), entry.text);
    }
    return { root, shell: join(root, "project.json") };
  }

  test("single compact edit reports one passage cell in shard coordinates", () => {
    const { shell } = shardedFixture();
    // Cell (0,0) already has a block override, so the edit reorders the sparse
    // array; the structural diff would report every shifted slot.
    const response = runFileEdit({
      command: "paint-passage",
      file: shell,
      dryRun: true,
      args: { map: "map", x: 0, y: 0, value: "pass", envelope: "compact" },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    const compact = response as typeof response & {
      diff: unknown[];
      patch?: unknown;
      semanticDiff?: { kind: string; path: string }[];
    };
    expect(compact.diff).toEqual([]);
    expect(compact.patch).toBeUndefined();
    expect(compact.semanticDiff).toEqual([
      {
        kind: "set",
        path: "/shards/maps~1map.json/passage/0",
        before: { exists: true, value: "block" },
        after: { exists: true, value: "pass" },
      },
    ]);
  });

  test("single compact edit matches the same edit inside a compact batch", () => {
    const { shell: shellA } = shardedFixture();
    const { shell: shellB } = shardedFixture();
    const args = { map: "map", x: 0, y: 0, value: "pass" };
    const single = runFileEdit({ command: "paint-passage", file: shellA, dryRun: true, args: { ...args, envelope: "compact" } });
    const batch = runFileEdit({
      command: "batch",
      file: shellB,
      dryRun: true,
      args: { envelope: "compact", operations: [{ command: "paint-passage", args }] },
    });
    expect(single.ok).toBe(true);
    expect(batch.ok).toBe(true);
    if (!single.ok || !batch.ok) throw new Error(JSON.stringify([single, batch]));
    const s = single as typeof single & { semanticDiff?: unknown };
    const b = batch as typeof batch & { semanticDiff?: unknown };
    // Same coordinate system, same entries: a single op is a one-op batch.
    expect(s.semanticDiff).toEqual(b.semanticDiff);
    expect(s.diff).toEqual([]);
    expect(b.diff).toEqual([]);
  });

  test("single compact add-event reports one insert, not the whole array", () => {
    const { shell: shellA } = shardedFixture();
    const { shell: shellB } = shardedFixture();
    const event = { id: "sign", x: 2, y: 2, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Sign"] }] }] };
    const compact = runFileEdit({ command: "add-event", file: shellA, dryRun: true, args: { map: "map", event, envelope: "compact" } });
    const full = runFileEdit({ command: "add-event", file: shellB, dryRun: true, args: { map: "map", event } });
    expect(compact.ok).toBe(true);
    expect(full.ok).toBe(true);
    if (!compact.ok || !full.ok) throw new Error(JSON.stringify([compact, full]));
    const c = compact as typeof compact & { semanticDiff?: { kind: string; path: string }[] };
    expect(c.semanticDiff).toEqual([
      { kind: "insert", path: "/shards/maps~1map.json/events", index: 1, after: { exists: true, value: event } },
    ]);
    // The compact response is in the same size class as the batch form: both
    // carry the one-event summary, not the full events array.
    const batch = runFileEdit({
      command: "batch",
      file: shellB,
      dryRun: true,
      args: { envelope: "compact", operations: [{ command: "add-event", args: { map: "map", event } }] },
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) throw new Error(JSON.stringify(batch));
    const bSemantic = (batch as typeof batch & { semanticDiff?: unknown }).semanticDiff;
    expect(c.semanticDiff).toEqual(bSemantic);
    // And it is dramatically smaller than the default envelope's structural diff.
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length / 2);
  });

  test("single compact edit drops derived shell metadata", () => {
    const { shell } = shardedFixture();
    const response = runFileEdit({
      command: "add-switch",
      file: shell,
      dryRun: true,
      args: { switch: { id: "flag", name: "Flag" }, envelope: "compact" },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    const semantic = (response as { semanticDiff?: { path: string }[] }).semanticDiff ?? [];
    expect(semantic.some((c) => c.path.includes("sha256") || c.path.includes("mapManifestHash") || c.path.includes("mapSchemaHash"))).toBe(false);
    // The switch itself is reported under /shell, in the batch coordinate system.
    expect(semantic.some((c) => c.path.startsWith("/shell/switches"))).toBe(true);
  });

  test("single compact add-item reports one shell insert", () => {
    // The shell-global path (executeShellGlobalOperation) must honor the
    // compact envelope for a single edit, not only inside a batch.
    const { shell } = shardedFixture();
    const item = { id: "key", name: "Key", sprite: "s.0", type: "key" };
    const response = runFileEdit({
      command: "add-item",
      file: shell,
      dryRun: true,
      args: { item, envelope: "compact" },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    const compact = response as typeof response & {
      diff: unknown[];
      patch?: unknown;
      semanticDiff?: unknown;
    };
    expect(compact.diff).toEqual([]);
    expect(compact.patch).toBeUndefined();
    expect(compact.semanticDiff).toEqual([
      { kind: "insert", path: "/shell/items", index: 0, after: { exists: true, value: item } },
    ]);
  });

  test("single compact add-sprite reports one shell key", () => {
    const { shell } = shardedFixture();
    // A first add creates the catalog; the compact second add reports just
    // the new key, not the whole record.
    const first = runFileEdit({
      command: "add-sprite",
      file: shell,
      args: { sprite: "existing", value: { kind: "image", src: "existing.png" } },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first));
    const value = { kind: "image", src: "npc/key.png" };
    const response = runFileEdit({
      command: "add-sprite",
      file: shell,
      dryRun: true,
      args: { sprite: "key-sprite", value, envelope: "compact" },
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(JSON.stringify(response));
    const compact = response as typeof response & {
      diff: unknown[];
      patch?: unknown;
      semanticDiff?: unknown;
    };
    expect(compact.diff).toEqual([]);
    expect(compact.patch).toBeUndefined();
    expect(compact.semanticDiff).toEqual([
      { kind: "set", path: "/shell/sprites/key-sprite", before: { exists: false }, after: { exists: true, value } },
    ]);
  });

  test("an invalid envelope value fails a single sharded edit", () => {
    const { shell } = shardedFixture();
    const response = runFileEdit({
      command: "paint-passage",
      file: shell,
      dryRun: true,
      args: { map: "map", x: 0, y: 0, value: "pass", envelope: "bogus" },
    });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected failure");
    expect(response.error.code).toBe("INVALID_ARGUMENT");
  });

  test("an invalid envelope value fails a sharded batch", () => {
    const { shell } = shardedFixture();
    const response = runFileEdit({
      command: "batch",
      file: shell,
      dryRun: true,
      args: {
        envelope: "bogus",
        operations: [{ command: "paint-passage", args: { map: "map", x: 0, y: 0, value: "pass" } }],
      },
    });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("expected failure");
    expect(response.error.code).toBe("INVALID_ARGUMENT");
  });
});

describe("batch inside proposals", () => {
  const temporary: string[] = [];
  afterEach(() => {
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test("an inline proposal hunk can contain a batch", () => {
    const project = fixture();
    const proposal = createProposalFromOperations(source(project), {
      id: "batch-prop",
      title: "Batch proposal",
      rationale: "Demonstrate a batch in a proposal hunk.",
      author: "test",
      hunks: [{
        id: "h1",
        summary: "Add a key and an event in one batch",
        operations: [{
          command: "batch",
          args: {
            operations: [
              { command: "add-item", args: { item: { id: "key", name: "Key", sprite: "s.0", type: "key" } } },
              { command: "add-event", args: { map: "map", event: { id: "sign", x: 2, y: 2, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Sign"] }] }] } } },
            ],
          },
        }],
      }],
    });
    expect(proposal.hunks).toHaveLength(1);
    // The hunk's changes cover both the item and the event.
    const paths = proposal.hunks[0]!.changes.map((c) => c.path);
    expect(paths.some((p) => p.startsWith("/items"))).toBe(true);
    expect(paths.some((p) => p.startsWith("/maps/0/events"))).toBe(true);
  });

  test("a sharded proposal hunk can contain a batch", () => {
    const root = mkdtempSync(join(import.meta.dir, ".rpgkit-batch-prop-"));
    temporary.push(root);
    const split = splitProjectMaps(fixture());
    writeFileSync(join(root, "project.json"), split.shellText);
    for (const entry of split.entries) {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true });
      writeFileSync(join(root, entry.path), entry.text);
    }
    const shellSource = readFileSync(join(root, "project.json"), "utf8");
    const dryRun = dryRunShardedProposal(
      shellSource,
      (entry) => readFileSync(join(root, entry), "utf8"),
      {
        id: "batch-shard",
        title: "Sharded batch",
        rationale: "Demonstrate a batch on a shell.",
        author: "test",
        createdAt: "2026-10-06T00:00:00.000Z",
        hunks: [{
          id: "h1",
          summary: "Paint a passage cell and add an event",
          operations: [{
            command: "batch",
            args: {
              operations: [
                { command: "paint-passage", args: { map: "map", x: 3, y: 0, value: "block" } },
                { command: "add-event", args: { map: "map", event: { id: "sign", x: 2, y: 2, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Sign"] }] }] } } },
              ],
            },
          }],
        }],
      },
    );
    expect(dryRun.proposal.hunks).toHaveLength(1);
    // The batch touched only the one map shard.
    expect(dryRun.touchedEntries).toEqual(["maps/map.json"]);
    // The after shell reflects both changes.
    const afterShard = dryRun.afterShards["maps/map.json"]!;
    expect(afterShard.events?.some((e) => e.id === "sign")).toBe(true);
  });

  test("a sharded proposal batch can add a map", () => {
    const root = mkdtempSync(join(import.meta.dir, ".rpgkit-batch-prop-addmap-"));
    temporary.push(root);
    const split = splitProjectMaps(fixture());
    writeFileSync(join(root, "project.json"), split.shellText);
    for (const entry of split.entries) {
      mkdirSync(dirname(join(root, entry.path)), { recursive: true });
      writeFileSync(join(root, entry.path), entry.text);
    }
    const shellSource = readFileSync(join(root, "project.json"), "utf8");
    const dryRun = dryRunShardedProposal(
      shellSource,
      (entry) => readFileSync(join(root, entry), "utf8"),
      {
        id: "batch-add-map",
        title: "Add a map in a batch",
        rationale: "A structural command inside a proposal batch.",
        author: "test",
        createdAt: "2026-10-06T00:00:00.000Z",
        hunks: [{
          id: "h1",
          summary: "Add cove, then an event on it",
          operations: [{
            command: "batch",
            args: {
              operations: [
                { command: "add-map", args: { map: "cove", name: "Cove", width: 4, height: 3, sheets: ["s"], fill: "s.0" } },
                { command: "add-event", args: { map: "cove", event: { id: "sign", x: 1, y: 1, pages: [{ trigger: "action", commands: [{ op: "text", lines: ["Cove"] }] }] } } },
              ],
            },
          }],
        }],
      },
    );
    expect(dryRun.proposal.hunks).toHaveLength(1);
    // The new map is indexed and its shard carries the event.
    expect(dryRun.afterShell.mapIndex.some((m) => m.id === "cove")).toBe(true);
    const cove = dryRun.afterShards["maps/cove.json"]!;
    expect(cove).toBeDefined();
    expect(cove.events?.some((e) => e.id === "sign")).toBe(true);
  });
});
