// src/engine/pathfind.ts — deterministic tile search for the `pathTo` and
// `approach` move-route steps.
//
// 4-neighbour BFS over the same PassageTable the mover uses, so a planned
// step honors sheet block/pass, map.passage overrides, blocking bodies and
// BOTH edge guards: the undirected dirBlock and the one-sided dirEdges
// (the cooked solid/entryMask/exitMask arrays). The neighbour order is fixed
// (down, left, up, right) and ties keep the first discovered path, so the
// same map and the same occupancy always produce the same path; the search
// reads no clock and no RNG and is independent of the host frame rate.
//
// The hot search loop is fully inlined and unrolled over the four
// neighbours and reads only cooked typed arrays. This matters under the
// QuickJS desktop guest: a cross-module call per edge made a 10,000-cell
// search ~85x slower than Bun. Parent/queue scratch for the last-used map
// size is reused across calls (the BFS is pure and synchronous), which
// keeps the per-call allocation cost flat.

import type { Dir4, PassageTable } from "./passability.ts";

/** Neighbour expansion order in Dir4 numeric order (down, left, up, right).
 *  Matches the mover's d-pad tie-break and passability's DX/DY tables. */
export const NEIGHBOUR_ORDER: readonly Dir4[] = [0, 1, 2, 3];
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
/** Opposite edge: the direction a walker faces when turning to the target. */
export const OPPOSITE_DIR: readonly Dir4[] = [2, 3, 0, 1];

export interface BfsBlocked {
  /** Cells that may not be ENTERED on top of the cooked table (character
   *  bodies the search must route around). A sparse set: typically a
   *  handful of movers. */
  cells?: ReadonlySet<number>;
}

// Reusable scratch for the last-used cell count. bfsPath is a pure,
// synchronous fold, so sharing these across calls is safe; only the parent
// fill is re-applied per search.
let scratchSize = 0;
let scratchParent: Int32Array | null = null;
let scratchQueue: Int32Array | null = null;

/** Fixed-order BFS from (sx,sy) to (gx,gy). Returns the step directions to
 *  walk FROM THE START, excluding the start cell; an empty list means
 *  "already there". Null means unreachable (or the goal is currently
 *  forbidden by `blocked.cells`); callers then wait and replan.
 *
 *  The path never enters a `blocked.cells` member, including the goal, so a
 *  pathTo aimed at an occupied target reports unreachable and the caller's
 *  retry policy owns the wait, the way Tuxemon's path controller waits for
 *  the waypoint to clear. */
export function bfsPath(
  table: PassageTable,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  blocked: BfsBlocked = {},
): Dir4[] | null {
  const W = table.width;
  const H = table.height;
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
  const N = W * H;
  const start = sy * W + sx;
  const goal = gy * W + gx;
  if (start === goal) return [];
  const blockedCells = blocked.cells;

  if (scratchParent === null || scratchSize !== N) {
    scratchParent = new Int32Array(N);
    scratchQueue = new Int32Array(N);
    scratchSize = N;
  }
  const parent = scratchParent;
  const queue = scratchQueue!;
  parent.fill(-1);
  parent[start] = -2; // visited, no parent
  let qh = 0;
  let qt = 0;
  queue[qt++] = start;

  // Localize the cooked arrays: under QuickJS a const-local read is markedly
  // cheaper than a repeated member/indexed access.
  const solid = table.solid;
  const entry = table.entryMask;
  const exit = table.exitMask;
  const body = table.bodyBlocks;

  // Edge bits: down=1, left=2, up=4, right=8. A dir-d step crosses the
  // source's bit and the target's OPPOSITE bit. Bounds are row-arithmetic:
  // down is cur+W (< N), up is cur-W (>= 0), left needs cx>0, right cx+1<W.
  while (qh < qt) {
    const cur = queue[qh++]!;
    if (cur === goal) break;
    const cx = cur % W;
    let ni: number;

    // down (0): target cur+W entered through its up edge (bit 4).
    ni = cur + W;
    if (ni < N && parent[ni] === -1 &&
        (exit[cur]! & 1) === 0 && solid[ni] === 0 && (entry[ni]! & 4) === 0 &&
        (body === undefined || !body.has(ni)) &&
        (blockedCells === undefined || !blockedCells.has(ni))) {
      parent[ni] = (cur << 2) | 0;
      queue[qt++] = ni;
      if (ni === goal) { qh = qt; break; }
    }
    // left (1): target cur-1 entered through its right edge (bit 8).
    if (cx > 0) {
      ni = cur - 1;
      if (parent[ni] === -1 &&
          (exit[cur]! & 2) === 0 && solid[ni] === 0 && (entry[ni]! & 8) === 0 &&
          (body === undefined || !body.has(ni)) &&
          (blockedCells === undefined || !blockedCells.has(ni))) {
        parent[ni] = (cur << 2) | 1;
        queue[qt++] = ni;
        if (ni === goal) { qh = qt; break; }
      }
    }
    // up (2): target cur-W entered through its down edge (bit 1).
    ni = cur - W;
    if (ni >= 0 && parent[ni] === -1 &&
        (exit[cur]! & 4) === 0 && solid[ni] === 0 && (entry[ni]! & 1) === 0 &&
        (body === undefined || !body.has(ni)) &&
        (blockedCells === undefined || !blockedCells.has(ni))) {
      parent[ni] = (cur << 2) | 2;
      queue[qt++] = ni;
      if (ni === goal) { qh = qt; break; }
    }
    // right (3): target cur+1 entered through its left edge (bit 2).
    if (cx + 1 < W) {
      ni = cur + 1;
      if (parent[ni] === -1 &&
          (exit[cur]! & 8) === 0 && solid[ni] === 0 && (entry[ni]! & 2) === 0 &&
          (body === undefined || !body.has(ni)) &&
          (blockedCells === undefined || !blockedCells.has(ni))) {
        parent[ni] = (cur << 2) | 3;
        queue[qt++] = ni;
        if (ni === goal) { qh = qt; break; }
      }
    }
  }

  if (parent[goal] === -1) return null;
  // Backtrack: each packed word stores the forward dir from its parent, so
  // the collected list is goal-first and reverses into start->goal order.
  const dirs: Dir4[] = [];
  let cur = goal;
  while (cur !== start) {
    const word = parent[cur]!;
    dirs.push((word & 3) as Dir4);
    cur = word >> 2;
  }
  dirs.reverse();
  return dirs;
}

// --- incremental BFS (frame-split for a per-frame compute budget) ----------
//
// Ten NPCs pathfinding at once can exceed the frame budget when each runs a
// full search synchronously. createPathSearch builds a
// plain-data search (typed arrays, no closure) whose advance() expands at
// most `cellBudget` dequeued cells per call, so the caller (a character
// route) runs one slice per reference tick until done. The result is
// identical to bfsPath (same expansion, same order); only the latency is
// spread. The per-tick cloner copies typed arrays to keep the fold pure and
// also revives the numeric-keyed objects produced by JSON round-trips.
// Occupancy is baked into blockedMask at creation, so a search spread across
// ticks is deterministic even though characters move meanwhile (a blocked
// first step replans).

export interface PathSearchState {
  W: number;
  N: number;
  start: number;
  goal: number;
  parent: Int32Array;
  queue: Int32Array;
  qh: number;
  qt: number;
  /** 1 on cells the search may not enter (bodies baked at creation), else 0;
   *  null when the only blockers are the table's own solid/edge opinions. */
  blockedMask: Uint8Array | null;
  /** KM1 through routes ignore cooked passage/body masks while preserving
   *  the same rectangular map bounds and deterministic neighbour order. */
  through?: true;
}

function copyInt32FromCheckpoint(value: Int32Array, length: number): Int32Array {
  if (value instanceof Int32Array) return new Int32Array(value);
  const source = value as unknown as Record<string, number>;
  const copy = new Int32Array(length);
  for (let i = 0; i < length; i++) copy[i] = source[String(i)]!;
  return copy;
}

function copyUint8FromCheckpoint(value: Uint8Array, length: number): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  const source = value as unknown as Record<string, number>;
  const copy = new Uint8Array(length);
  for (let i = 0; i < length; i++) copy[i] = source[String(i)]!;
  return copy;
}

/** Clone an incremental search while normalizing a raw JSON checkpoint.
 *
 * JSON.stringify emits typed arrays as objects with numeric keys and
 * JSON.parse cannot infer the original array class. A SessionState is cloned
 * before every reducer step, so this single boundary revives either form and
 * keeps the hot search representation compact. */
export function clonePathSearch(s: PathSearchState | null): PathSearchState | null {
  if (!s) return null;
  return {
    ...s,
    parent: copyInt32FromCheckpoint(s.parent, s.N),
    queue: copyInt32FromCheckpoint(s.queue, s.N),
    blockedMask: s.blockedMask ? copyUint8FromCheckpoint(s.blockedMask, s.N) : null,
  };
}

/** Begin an incremental search. `blockedCells` is baked into a per-map mask
 *  once so later ticks need no Set. Returns null for out-of-range endpoints;
 *  start===goal returns a state whose first advance immediately yields an
 *  empty path without scanning the map. */
export function createPathSearch(
  table: PassageTable,
  sx: number,
  sy: number,
  gx: number,
  gy: number,
  blockedCells?: ReadonlySet<number>,
  through = false,
): PathSearchState | null {
  const W = table.width;
  const H = table.height;
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return null;
  const N = W * H;
  const parent = new Int32Array(N).fill(-1);
  const start = sy * W + sx;
  const goal = gy * W + gx;
  parent[start] = -2;
  const queue = new Int32Array(N);
  let qt = 0;
  queue[qt++] = start;
  let blockedMask: Uint8Array | null = null;
  if (blockedCells && blockedCells.size > 0) {
    blockedMask = new Uint8Array(N);
    for (const idx of blockedCells) {
      if (idx >= 0 && idx < N) blockedMask[idx] = 1;
    }
  }
  return {
    W, N, start, goal, parent, queue, qh: 0, qt, blockedMask,
    ...(through ? { through: true as const } : {}),
  };
}

/** Result of one incremental slice: still searching (call again next tick)
 *  or finished, with the path (empty for start===goal) or null when
 *  unreachable. */
export type PathSearchResult =
  | { done: false }
  | { done: true; path: Dir4[] | null };

/** Expand up to `cellBudget` dequeued cells this slice. */
export function advancePathSearch(st: PathSearchState, table: PassageTable, cellBudget: number): PathSearchResult {
  if (st.start === st.goal) return { done: true, path: [] };
  const { W, N, parent, queue, blockedMask } = st;
  const solid = table.solid;
  const entry = table.entryMask;
  const exit = table.exitMask;
  const body = table.bodyBlocks;
  const through = st.through === true;
  let budget = cellBudget;

  while (st.qh < st.qt && budget > 0) {
    const cur = queue[st.qh++]!;
    budget--;
    const cx = cur % W;
    let ni: number;

    ni = cur + W;
    if (ni < N && parent[ni] === -1 && (through || (
        (exit[cur]! & 1) === 0 && solid[ni] === 0 && (entry[ni]! & 4) === 0 &&
        (body === undefined || !body.has(ni)) && (blockedMask === null || blockedMask[ni] === 0)))) {
      parent[ni] = (cur << 2) | 0; queue[st.qt++] = ni;
      if (ni === st.goal) return { done: true, path: backtrack(st) };
    }
    if (cx > 0) {
      ni = cur - 1;
      if (parent[ni] === -1 && (through || (
          (exit[cur]! & 2) === 0 && solid[ni] === 0 && (entry[ni]! & 8) === 0 &&
          (body === undefined || !body.has(ni)) && (blockedMask === null || blockedMask[ni] === 0)))) {
        parent[ni] = (cur << 2) | 1; queue[st.qt++] = ni;
        if (ni === st.goal) return { done: true, path: backtrack(st) };
      }
    }
    ni = cur - W;
    if (ni >= 0 && parent[ni] === -1 && (through || (
        (exit[cur]! & 4) === 0 && solid[ni] === 0 && (entry[ni]! & 1) === 0 &&
        (body === undefined || !body.has(ni)) && (blockedMask === null || blockedMask[ni] === 0)))) {
      parent[ni] = (cur << 2) | 2; queue[st.qt++] = ni;
      if (ni === st.goal) return { done: true, path: backtrack(st) };
    }
    if (cx + 1 < W) {
      ni = cur + 1;
      if (parent[ni] === -1 && (through || (
          (exit[cur]! & 8) === 0 && solid[ni] === 0 && (entry[ni]! & 2) === 0 &&
          (body === undefined || !body.has(ni)) && (blockedMask === null || blockedMask[ni] === 0)))) {
        parent[ni] = (cur << 2) | 3; queue[st.qt++] = ni;
        if (ni === st.goal) return { done: true, path: backtrack(st) };
      }
    }
  }
  if (st.qh >= st.qt) {
    // Queue drained: reach the goal iff it was ever parented.
    return { done: true, path: parent[st.goal] === -1 ? null : backtrack(st) };
  }
  return { done: false };
}

function backtrack(st: PathSearchState): Dir4[] {
  const { parent, start, goal } = st;
  const dirs: Dir4[] = [];
  let cur = goal;
  while (cur !== start) {
    const word = parent[cur]!;
    dirs.push((word & 3) as Dir4);
    cur = word >> 2;
  }
  dirs.reverse();
  return dirs;
}

/** The tile `distance` away on `side` of a character cell: the stand tile an
 *  `approach` aims for. `side` is a direction D from the TARGET toward the
 *  stand tile (Tuxemon: approach_direction = pairs(direction toward target),
 *  then get_coord_direction(target, approach_direction)). A mover there
 *  faces back TOWARD the target (the opposite direction). */
export function approachStand(
  tx: number,
  ty: number,
  side: Dir4,
  distance: number,
): { x: number; y: number } {
  return { x: tx + DX[side] * distance, y: ty + DY[side] * distance };
}

/** Facing a mover on (mx,my) shows when looking at a character on
 *  (tx,ty): the dominant axis (vertical wins a tie, matching the mover's
 *  diagonal priority), or null when they share a cell. */
export function facingToward(
  mx: number,
  my: number,
  tx: number,
  ty: number,
): Dir4 | null {
  const dx = tx - mx;
  const dy = ty - my;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 0 : 2;
  return dx > 0 ? 3 : 1;
}

/** Default side for an approach without an authored one: the side of the
 *  target the mover currently stands on (the direction toward the target,
 *  reversed to the target's side), or null when on the same cell. */
export function approachSide(mx: number, my: number, tx: number, ty: number): Dir4 | null {
  const f = facingToward(mx, my, tx, ty);
  return f === null ? null : OPPOSITE_DIR[f]!;
}
