// tools/rpgkit-check/src/dynamic/reach-driver.ts — the headless macro driver
// for the reach search.
//
// The driver runs the REAL engine in BLOCKS of 60 Hz ticks: every decision
// covers six ticks with one constant mask (see reach-witness.ts). A macro is:
//
//   1. walk a BFS path on the engine's own passage table (authored terrain
//      plus runtime tileProperty overrides, stamped with live character
//      bodies), routing around OTHER transfer tiles so the searcher is not
//      teleported away mid-walk;
//   2. trigger the target event (action: face + confirm; bump — an
//      eventTouch page that blocks — : hold the direction toward the body
//      for one block so the refused step fires it; playerTouch or a
//      non-blocking eventTouch: the
//      entry already fired it);
//   3. ride out until the world is idle: text boxes confirm themselves,
//      shops are dismissed, battles step under the registered rules, and a
//      choices box BRANCHES — every option (plus cancel, when allowed) is
//      its own leaf with its own tape suffix.
//
// Every leaf is a real engine state the recorded tape really reaches. The
// search (reach.ts) turns leaves into graph nodes; this module never decides
// reachability on its own.
//
// Movement is tile-locked (src/engine/movement.ts): a d-pad press commits
// one tile and the step interpolates over the next 8 ticks, reading input
// again only at the tile boundary. So a direction held for one 6-tick block
// commits exactly one step (it arrives two ticks into the following block),
// and the block after holds nothing so the player arrives at the expected
// tile without a chained step stealing the next direction.
//
// Directions are numeric Facing/Dir4 (0 down, 1 left, 2 up, 3 right), the
// engine's own convention.

import { deepClone } from "../../../../src/engine/clone.ts";
import { activePage, type ExtensionScope } from "../../../../src/engine/interpreter.ts";
import {
  canStepFrom,
  isStandable,
  stampBlockedCells,
  type PassageTable,
} from "../../../../src/engine/passability.ts";
import {
  isSessionWorldIdle,
  sessionPassageTable,
  stepSession,
  tableWithBodies,
  type Session,
  type SessionState,
} from "../../../../src/engine/session.ts";
import type { BattleInput } from "../../../../src/engine/battle.ts";
import type { Dir4 } from "../../../../src/engine/passability.ts";
import type { Facing, GameEvent, JsonValue, Project } from "../../../../src/engine/types.ts";
import { collectProjectOp } from "../walk.ts";
import { checkConditionContext, pageTouchMode } from "./sim.ts";
import { BTN_CIRCLE, BTN_CROSS, BTN_DOWN, BTN_LEFT, BTN_RIGHT, BTN_UP, stateHash } from "./reach-witness.ts";

// 0 down, 1 left, 2 up, 3 right (Facing/Dir4 order).
const DIRS = [0, 1, 2, 3] as const;
const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const DIR_BUTTON = [BTN_DOWN, BTN_LEFT, BTN_UP, BTN_RIGHT] as const;
/** The facing a player on a rect neighbor must show to look at the rect. */
const FACE_FROM_NEIGHBOR = [2, 3, 0, 1] as const;

/** Reference ticks per recorded block: the tape holds one constant mask
 *  per block, with every pressed edge on the block's first tick. */
const BLOCK_TICKS = 6;
/** Max blocks a ride-out branch may run before it is parked as a dead end
 *  (60 s at 60 Hz). An infinite autorun loop lands here. */
const RIDE_BUDGET = 600;
/** Max blocks a battle scene may be stepped before it is parked as a
 *  dead end (the registered rules never reported done). */
const BATTLE_BUDGET = 600;
/** Choices nesting depth per macro: a dialog loop that re-opens the same
 *  choices box would otherwise recurse forever. */
const MAX_CHOICE_DEPTH = 6;
/** Blocks a wait macro stands still sampling active pages (10 s). */
const WAIT_BUDGET = 100;
/** Blocks without a new page observation before a wait macro ends early. */
const WAIT_QUIET = 20;
/** Blocks a walk spends on one path step: one block holds the dir (commits
 *  one 8-tick step, which arrives two ticks into the next block) and the
 *  rest wait for the arrival; a step that has not arrived by then is
 *  blocked. */
const WALK_BLOCKED = 3;

export interface PairInput {
  /** Direction bits held for the pair (0 or one dir). */
  hold: number;
  confirm?: boolean;
  cancel?: boolean;
  up?: boolean;
  down?: boolean;
}

/** A tick result: the state after the tick and the tape length at that
 *  point (so a map entered mid-block gets a witness truncated to that tick).
 *  `blockEnd` marks the last tick of a 6-tick block — the ticks at which
 *  entry witnesses are aligned to the block end and transient snapshots are
 *  recorded. */
export interface TickResult {
  state: SessionState;
  mark: number;
  blockEnd: boolean;
}

/** Records a block-constant mask tape while stepping the real engine. The
 *  driver starts AFTER `prevMask` (the mask the previous macro ended with):
 *  a key still held across the macro boundary must not be re-observed as a
 *  fresh pressed edge, or the recorded tape would not match a replay that
 *  carries `prev` across the whole tape. */
export class Driver {
  state: SessionState;
  private prevMask: number;
  private tape: number[] = [];

  constructor(readonly session: Session, state: SessionState, prevMask = 0) {
    this.state = state;
    this.prevMask = prevMask >>> 0;
  }

  mark(): number {
    return this.tape.length;
  }

  since(mark: number): number[] {
    return this.tape.slice(mark);
  }

  /** Tape slice between two marks (for a block-aligned map-entry witness). */
  range(startMark: number, endMark: number): number[] {
    return this.tape.slice(startMark, endMark);
  }

  /** Restore a branch snapshot: state and tape truncate to the mark; the
   *  previous mask is the last recorded one (edges derive against it). */
  restore(state: SessionState, tapeMark: number): void {
    this.state = state;
    this.tape.length = tapeMark;
    this.prevMask = tapeMark > 0 ? this.tape[tapeMark - 1]! : 0;
  }

  /** Step one 6-tick block. If edge bits are requested while still held from
   *  the previous block, a release block (same hold, no edges) is emitted
   *  first so the edge really fires; the caller re-requests on its next
   *  iteration. `park` (when supplied) is consulted between the release and
   *  the edge block: when it trips, only the release block runs and the
   *  caller parks the macro, so a budget stops the macro at most one block
   *  past the limit even when an edge needs a release first. Returns one
   *  TickResult per tick (six per block), so a map entered and left inside
   *  one block is still observed (entry witnesses are recorded at block ends
   *  only). */
  act(input: PairInput, park?: () => boolean): TickResult[] {
    const edgeBits =
      (input.confirm ? BTN_CIRCLE : 0) |
      (input.cancel ? BTN_CROSS : 0) |
      (input.up ? BTN_UP : 0) |
      (input.down ? BTN_DOWN : 0);
    const out: TickResult[] = [];
    if ((edgeBits & this.prevMask) !== 0) {
      out.push(...this.stepBlock(input.hold));
      if (park?.()) return out;
    }
    out.push(...this.stepBlock(input.hold | edgeBits));
    return out;
  }

  private stepBlock(mask: number): TickResult[] {
    const m = mask >>> 0;
    const pressed = (m & ~this.prevMask) >>> 0;
    const out: TickResult[] = [];
    for (let t = 0; t < BLOCK_TICKS; t++) {
      // Edges on the first tick of the block only; the remaining ticks hold
      // the same mask with no edges, so the block is one constant mask.
      const edge = t === 0;
      this.state = stepSession(this.session, this.state, {
        buttons: m,
        confirmEdge: edge && !!(pressed & BTN_CIRCLE),
        cancelEdge: edge && !!(pressed & BTN_CROSS),
        upEdge: edge && !!(pressed & BTN_UP),
        downEdge: edge && !!(pressed & BTN_DOWN),
      });
      this.tape.push(m);
      out.push({ state: this.state, mark: this.tape.length, blockEnd: t === BLOCK_TICKS - 1 });
    }
    this.prevMask = m;
    return out;
  }
}

// --- pathfinding --------------------------------------------------------------

/** One BFS from (sx,sy): the parent dir for every reached cell. */
function bfsParent(table: PassageTable, sx: number, sy: number): Map<number, Dir4> {
  const key = (x: number, y: number) => y * table.width + x;
  const prev = new Map<number, Dir4>();
  const queue: [number, number][] = [[sx, sy]];
  const seen = new Set<number>([key(sx, sy)]);
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const dir of DIRS) {
      if (!canStepFrom(table, cx, cy, dir)) continue;
      const nx = cx + DX[dir]!;
      const ny = cy + DY[dir]!;
      if (!isStandable(table, nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, dir);
      queue.push([nx, ny]);
    }
  }
  return prev;
}

/** Dir path from (sx,sy) to (tx,ty) given a BFS parent map, or null. */
function reconstruct(
  prev: Map<number, Dir4>,
  table: PassageTable,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): Dir4[] | null {
  const key = (x: number, y: number) => y * table.width + x;
  const start = key(sx, sy);
  let ck = key(tx, ty);
  if (ck === start) return [];
  if (!prev.has(ck)) return null;
  const path: Dir4[] = [];
  while (ck !== start) {
    const dir = prev.get(ck);
    if (dir === undefined) return null;
    path.unshift(dir);
    const x = ck % table.width;
    const y = Math.floor(ck / table.width);
    ck = key(x - DX[dir]!, y - DY[dir]!);
  }
  return path;
}

// --- targets ------------------------------------------------------------------

export interface MacroTarget {
  eventKey: string;
  /** action: face + confirm; playerTouch: step onto (also a non-blocking
   *  eventTouch); bump: from a neighbor, walk into a blocking eventTouch
   *  body (`face` is the direction toward it). */
  kind: "action" | "playerTouch" | "bump";
  /** Tile to stand on. */
  x: number;
  y: number;
  /** For action targets: the facing to hold before confirming (when the
   *  active page is facing-conditioned). */
  face?: Facing;
  activePage: number;
  /** Literal transfer target map of the active page, when it exits. */
  transferTo?: string;
  /** Dir path from the player to the trigger tile. */
  path: Dir4[];
}

function eventOrigin(ev: GameEvent, chars: SessionState["chars"]): { x: number; y: number } {
  const ch = chars.chars[ev.id];
  return ch ? { x: ch.tx, y: ch.ty } : { x: ev.x, y: ev.y };
}

function liveTable(session: Session, state: SessionState): PassageTable {
  return tableWithBodies(sessionPassageTable(session, state), state.chars);
}

/** Every event on the current map whose active page the player can trigger,
 *  with a walkable path to a trigger tile. One target per event (the nearest
 *  reachable tile). Facing-conditioned pages carry the facing they need. */
export function planTargets(
  project: Project,
  session: Session,
  state: SessionState,
): MacroTarget[] {
  const map = session.maps.get(state.mapId);
  if (!map) return [];
  const t = liveTable(session, state);
  const ctx = checkConditionContext(state, map);
  const ext = (): ExtensionScope => ({ runtime: session.extensions, ext: state.ext });
  const px = state.move.tx;
  const py = state.move.ty;

  // Tiles that would teleport the player away (active playerTouch pages with
  // a literal transfer). Paths to normal events route AROUND them; a path to
  // the exit tile itself may stand on it.
  const transferTiles = new Set<number>();
  for (const ev of map.events ?? []) {
    const active = activePage(ev, state.sw, map.id, state.move.facing, ext(), ctx);
    if (!active || pageTouchMode(active.page) !== "playerTouch") continue;
    if (!collectProjectOp(project, active.page.commands, "transfer").some((c) => typeof c.map === "string")) continue;
    const origin = eventOrigin(ev, state.chars);
    const w = ev.w ?? 1;
    const h = ev.h ?? 1;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = origin.x + dx;
        const cy = origin.y + dy;
        if (cx >= 0 && cy >= 0 && cx < map.width && cy < map.height) {
          transferTiles.add(cy * map.width + cx);
        }
      }
    }
  }
  const safeTable = transferTiles.size > 0 ? stampBlockedCells(t, transferTiles) : t;
  const parent = bfsParent(safeTable, px, py);

  const targets: MacroTarget[] = [];
  for (const ev of map.events ?? []) {
    const active = activePage(ev, state.sw, map.id, state.move.facing, ext(), ctx);
    if (!active) continue;
    const trig = pageTouchMode(active.page);
    if (trig === null) continue;
    const key = `${map.id}/${ev.id}`;
    // Whether the same page is active under EVERY facing: a page that is not
    // must be triggered with the facing that activated it.
    const facingBound = !DIRS.every((d) => {
      const a = activePage(ev, state.sw, map.id, d, ext(), ctx);
      return a !== null && a.index === active.index;
    });
    const transferTo = collectProjectOp(project, active.page.commands, "transfer")
      .map((c) => c.map)
      .find((m): m is string => typeof m === "string");
    const origin = eventOrigin(ev, state.chars);
    const w = ev.w ?? 1;
    const h = ev.h ?? 1;

    // Candidate trigger tiles with their path. Pick the nearest.
    let best: MacroTarget | null = null;
    const consider = (x: number, y: number, face: Facing | undefined, path: Dir4[] | null): void => {
      if (!path) return;
      if (!best || path.length < best.path.length) {
        best = {
          eventKey: key,
          kind: trig,
          x,
          y,
          ...(face !== undefined ? { face } : {}),
          activePage: active.index,
          ...(transferTo !== undefined ? { transferTo } : {}),
          path,
        };
      }
    };

    /** Path onto a playerTouch tile: the touch fires on ENTRY, so path to a
     *  neighbor on the safe table (routing around other transfer tiles) and
     *  step onto the tile on the real table (the exit tile itself is blocked
     *  in safeTable). When `enter` is set, the entry must step in that
     *  facing; otherwise the shortest neighbor wins. */
    const pathOnto = (x: number, y: number, enter: Facing | undefined): Dir4[] | null => {
      const dirs = enter !== undefined ? [enter] : DIRS;
      let bestPath: Dir4[] | null = null;
      for (const d of dirs) {
        const nx = x - DX[d]!;
        const ny = y - DY[d]!;
        // The neighbor must be in bounds: an off-map cell collides with an
        // in-map cell under the y*width+x key, so reconstruct would return a
        // bogus path for it.
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const head = reconstruct(parent, safeTable, px, py, nx, ny);
        if (!head) continue;
        if (!canStepFrom(t, nx, ny, d)) continue;
        const path = [...head, d];
        if (!bestPath || path.length < bestPath.length) bestPath = path;
      }
      return bestPath;
    };

    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const cx = origin.x + dx;
        const cy = origin.y + dy;
        if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) continue;
        if (trig === "bump") {
          // A blocking eventTouch fires when the player's step is refused by
          // the body: stand on a neighbor and walk into the rect. The bump
          // turns the player toward the event, so a facing-bound page only
          // takes neighbors whose bump facing keeps the same page active.
          for (const dir of DIRS) {
            const nx = cx + DX[dir]!;
            const ny = cy + DY[dir]!;
            const face = FACE_FROM_NEIGHBOR[dir]! as Facing;
            if (facingBound && activePage(ev, state.sw, map.id, face, ext(), ctx)?.index !== active.index) continue;
            if (isStandable(t, nx, ny)) consider(nx, ny, face, reconstruct(parent, safeTable, px, py, nx, ny));
          }
          continue;
        }
        if (trig === "playerTouch") {
          // The touch latch fires on entry only; the tile the player stands
          // on cannot re-trigger it.
          if (isStandable(t, cx, cy) && !(cx === px && cy === py)) {
            const enter = facingBound ? state.move.facing : undefined;
            consider(cx, cy, undefined, pathOnto(cx, cy, enter));
          }
          continue;
        }
        // action: stand in the rect (any facing) or on a neighbor facing it.
        if (isStandable(t, cx, cy)) {
          consider(cx, cy, facingBound ? state.move.facing : undefined, reconstruct(parent, safeTable, px, py, cx, cy));
        }
        for (const dir of DIRS) {
          const nx = cx + DX[dir]!;
          const ny = cy + DY[dir]!;
          if (isStandable(t, nx, ny)) {
            consider(nx, ny, facingBound ? state.move.facing : FACE_FROM_NEIGHBOR[dir], reconstruct(parent, safeTable, px, py, nx, ny));
          }
        }
      }
    }
    if (best) targets.push(best);
  }
  return targets;
}

// --- macro execution -----------------------------------------------------------

export interface MacroLeaf {
  state: SessionState;
  tapeSuffix: number[];
  /** Maps visited during the macro, in first-visit order. */
  maps: string[];
  /** First-entry record for every map the macro entered (including maps
   *  passed through mid-ride-out without going idle): the tape suffix from
   *  the macro start to the entry pair, and the arrival state hash. */
  mapEntries: { map: string; suffix: number[]; stateHash: string }[];
  /** `${map}/${eventId}#${pageIndex}` observed active during the macro. */
  pagesObserved: string[];
  /** Interpreter error the macro parked on (runaway, ...). */
  error?: string;
  /** The battle scene never completed under the registered rules. */
  battleTimeout?: boolean;
  /** The ride-out budget expired before the world went idle. */
  rideBudget?: boolean;
  /** The search's frame or wall-clock budget ran out mid-macro: the leaf
   *  is a dead end (the search stops with the matching endedReason). */
  budget?: "frame" | "time";
}

export interface TransientSnapshot {
  state: SessionState;
  tapeSuffix: number[];
  pageKey: string;
}

export interface MacroContext {
  /** Input fed to a live battle scene each pair (default: no input). */
  battleInput?: (state: JsonValue) => BattleInput;
  /** Pages the search already knows about; only pages NOT in this set can
   *  produce transient snapshots. */
  knownPages: ReadonlySet<string>;
  onTransient: (snap: TransientSnapshot) => void;
  /** State-goal hook: called for EVERY observed tick state (so a goal a
   *  state only passes through mid-ride — a tile crossed on the way to a
   *  transfer, a switch set between dialogs — is still witnessed). Return
   *  true to park the macro: the search's goals are met and the recorded
   *  suffix is the witness. Absent when the search has no goals (zero
   *  per-tick cost). */
  onGoalHit?: (state: SessionState, suffix: number[]) => boolean;
  /** Remaining reference ticks before the search's frame budget is spent
   *  (live: the search updates its frame counter between macros). A macro
   *  parks (budget leaf) once its own spend reaches this. */
  framesLeft: () => number;
  /** Wall-clock deadline (Date.now() ms) for the whole search; a macro
   *  parks once the clock is past it. */
  deadline: number;
}

interface MacroRun {
  driver: Driver;
  ctx: MacroContext;
  startMark: number;
  maps: string[];
  mapEntries: { map: string; suffix: number[]; stateHash: string }[];
  pagesObserved: Set<string>;
  leaves: MacroLeaf[];
  transient: TransientSnapshot[];
  /** Reference ticks this macro has stepped (its frame-budget spend). */
  framesSpent: number;
  /** Set by onGoalHit when the search's goals are met: every loop bails
   *  out so the macro stops at the witnessing tick. */
  parked: boolean;
}

function makeLeaf(run: MacroRun, extra: Partial<MacroLeaf> = {}): MacroLeaf {
  return {
    state: deepClone(run.driver.state),
    tapeSuffix: run.driver.since(run.startMark),
    maps: [...run.maps],
    mapEntries: run.mapEntries.map((e) => ({ map: e.map, suffix: [...e.suffix], stateHash: e.stateHash })),
    pagesObserved: [...run.pagesObserved],
    ...extra,
  };
}

/** Which budget (if any) the macro has exhausted. `pending` counts ticks
 *  the driver already executed inside this act() call but has not yet
 *  charged to framesSpent — the release block of a held edge, when the
 *  park callback is consulted between it and the edge block. Without it
 *  the callback compares a stale spend and lets the edge block run too,
 *  so one act() executes twelve ticks and the search overshoots the
 *  frame budget by nearly two blocks. */
function budgetExceeded(run: MacroRun, pending = 0): "frame" | "time" | null {
  if (run.framesSpent + pending >= run.ctx.framesLeft()) return "frame";
  if (Date.now() > run.ctx.deadline) return "time";
  return null;
}

/** Step one block, charging it to the macro's frame spend. Parks the macro
 *  as a budget dead end and returns "budget" when the search's frame or
 *  wall-clock budget is exhausted (checked before the block, between a
 *  release block and its edge block, and after the block, so a macro stops
 *  at most one block past the limit), so a long ride-out, battle or wait
 *  cannot run a full macro past the budget. The block-constant tape means
 *  one block (6 ticks) is the minimum unit of work, so `maxFrames=1` runs
 *  one block. */
function step(run: MacroRun, input: PairInput): TickResult[] | "budget" {
  const before = budgetExceeded(run);
  if (before) {
    run.leaves.push(makeLeaf(run, { budget: before }));
    return "budget";
  }
  // The park callback runs between a held edge's release block and its
  // edge block: the release block's BLOCK_TICKS ticks are executed but not
  // yet charged to framesSpent, so they are passed as pending.
  const states = run.driver.act(input, () => budgetExceeded(run, BLOCK_TICKS) !== null);
  run.framesSpent += states.length;
  const after = budgetExceeded(run);
  if (after) {
    run.leaves.push(makeLeaf(run, { budget: after }));
    return "budget";
  }
  return states;
}

/** Observe a post-tick state: map visits, active pages, and transient
 *  triggerable pages while the world is idle.
 *
 *  Map entries are recorded per tick (so a map passed through within one
 *  block still gets a witness), and replaced with a block-aligned entry at
 *  each block end on the map. */
function observe(run: MacroRun, s: SessionState, idle: boolean, mark: number, blockEnd: boolean): void {
  if (!run.maps.includes(s.mapId)) {
    run.maps.push(s.mapId);
    run.mapEntries.push({
      map: s.mapId,
      suffix: run.driver.range(run.startMark, mark),
      stateHash: stateHash(s),
    });
  } else if (blockEnd) {
    // Block boundary on this map: align the entry to the block end.
    // Idempotent for an entry already recorded at a block end (same mark,
    // same state).
    const entry = run.mapEntries.find((e) => e.map === s.mapId);
    if (entry) {
      entry.suffix = run.driver.range(run.startMark, mark);
      entry.stateHash = stateHash(s);
    }
  }
  const map = run.driver.session.maps.get(s.mapId);
  if (!map) return;
  const ctx = checkConditionContext(s, map);
  const ext: ExtensionScope = { runtime: run.driver.session.extensions, ext: s.ext };
  for (const ev of map.events ?? []) {
    const active = activePage(ev, s.sw, s.mapId, s.move.facing, ext, ctx);
    if (!active) continue;
    const key = `${s.mapId}/${ev.id}#${active.index}`;
    run.pagesObserved.add(key);
    if (
      blockEnd &&
      idle &&
      !run.ctx.knownPages.has(key) &&
      pageTouchMode(active.page) !== null
    ) {
      const snap: TransientSnapshot = {
        state: deepClone(s),
        tapeSuffix: run.driver.range(run.startMark, mark),
        pageKey: key,
      };
      run.transient.push(snap);
      run.ctx.onTransient(snap);
    }
  }
  // State goals are evaluated per tick (not just at block ends): a tile the
  // player crosses mid-block or a switch a dialog sets between blocks is
  // only observable at its tick. A true return parks the macro at the
  // witnessing tick.
  if (!run.parked && run.ctx.onGoalHit?.(s, run.driver.range(run.startMark, mark)) === true) {
    run.parked = true;
  }
}

function stepBattle(run: MacroRun): "done" | "timeout" | "budget" | "parked" {
  let b = 0;
  while (run.driver.state.scene?.kind === "battle") {
    if (b++ >= BATTLE_BUDGET) return "timeout";
    const input = run.ctx.battleInput ? run.ctx.battleInput(run.driver.state.scene.state) : { buttons: 0 };
    const states = step(run, {
      hold: (input.buttons ?? 0) & (BTN_UP | BTN_DOWN | BTN_LEFT | BTN_RIGHT),
      confirm: input.confirmEdge === true,
      cancel: input.cancelEdge === true,
      up: input.upEdge === true,
      down: input.downEdge === true,
    });
    if (states === "budget") return "budget";
    for (const { state: s, mark, blockEnd } of states) observe(run, s, false, mark, blockEnd);
    if (run.parked) return "parked";
  }
  return "done";
}

function rideOut(run: MacroRun, depth: number): void {
  let guard = 0;
  while (guard++ < RIDE_BUDGET) {
    const s = run.driver.state;
    if (s.interp.error) {
      run.leaves.push(makeLeaf(run, { error: s.interp.error.message }));
      return;
    }
    if (s.scene?.kind === "battle") {
      const battleResult = stepBattle(run);
      if (battleResult === "timeout") {
        run.leaves.push(makeLeaf(run, { battleTimeout: true }));
        return;
      }
      if (battleResult === "budget") return; // stepBattle parked a budget leaf
      if (battleResult === "parked") return;
      continue;
    }
    const modal = s.interp.modal;
    if (modal?.kind === "text") {
      const states = step(run, { hold: 0, confirm: true });
      if (states === "budget") return;
      for (const { state: st, mark, blockEnd } of states) observe(run, st, false, mark, blockEnd);
      if (run.parked) return;
      continue;
    }
    if (modal?.kind === "shop") {
      const states = step(run, { hold: 0, cancel: true });
      if (states === "budget") return;
      for (const { state: st, mark, blockEnd } of states) observe(run, st, false, mark, blockEnd);
      if (run.parked) return;
      continue;
    }
    if (modal?.kind === "choices") {
      if (depth >= MAX_CHOICE_DEPTH) {
        // Too many nested branches: park as a dead end rather than recurse
        // forever on a dialog loop.
        run.leaves.push(makeLeaf(run, { rideBudget: true }));
        return;
      }
      branchChoices(run, depth + 1);
      return;
    }
    if (isSessionWorldIdle(s)) {
      // The caller may have bailed out mid-block (a walk that triggered a
      // transfer), skipping the block-end observation; act() always completes
      // whole blocks, so driver.state sits on a block end. Observe it as one
      // to align the current map's entry witness (idempotent if the caller
      // already did), then leaf.
      observe(run, s, true, run.driver.mark(), true);
      run.leaves.push(makeLeaf(run));
      return;
    }
    // Busy (autorun fiber, input lock, fade, pending transfer): wait.
    const states = step(run, { hold: 0 });
    if (states === "budget") return;
    for (const { state: st, mark, blockEnd } of states) observe(run, st, false, mark, blockEnd);
    if (run.parked) return;
  }
  run.leaves.push(makeLeaf(run, { rideBudget: true }));
}

function branchChoices(run: MacroRun, depth: number): void {
  const s = run.driver.state;
  const modal = s.interp.modal;
  if (!modal || modal.kind !== "choices") return;
  const snapshot = deepClone(s);
  const snapMark = run.driver.mark();
  const optionCount = modal.options.length;
  for (let i = 0; i < optionCount; i++) {
    run.driver.restore(deepClone(snapshot), snapMark);
    // Cursor starts at 0: move down i times (step inserts release blocks so
    // every DOWN edge really fires).
    for (let k = 0; k < i; k++) {
      const down = step(run, { hold: 0, down: true });
      if (down === "budget") return;
      for (const { state: st, mark, blockEnd } of down) observe(run, st, false, mark, blockEnd);
      if (run.parked) return;
    }
    const confirm = step(run, { hold: 0, confirm: true });
    if (confirm === "budget") return;
    for (const { state: st, mark, blockEnd } of confirm) observe(run, st, false, mark, blockEnd);
    if (run.parked) return;
    rideOut(run, depth);
    if (run.parked) return;
  }
  if (modal.cancellable) {
    run.driver.restore(deepClone(snapshot), snapMark);
    const cancel = step(run, { hold: 0, cancel: true });
    if (cancel === "budget") return;
    for (const { state: st, mark, blockEnd } of cancel) observe(run, st, false, mark, blockEnd);
    if (run.parked) return;
    rideOut(run, depth);
  }
}

/** Walk the path and trigger the target, riding out every branch.
 *  `initialMask` is the button mask the previous macro ended with, so edges
 *  across the macro boundary match a continuous replay. Returns the leaves,
 *  the transient snapshots, and the REAL number of reference ticks this
 *  macro executed (branches restore snapshots and re-run, so the spend is
 *  measured once per executed block, never reconstructed from leaf tape
 *  lengths — a choices fan-out's shared prefix is charged once, not once
 *  per leaf). */
export function executeMacro(
  session: Session,
  start: SessionState,
  target: MacroTarget,
  ctx: MacroContext,
  initialMask = 0,
): { leaves: MacroLeaf[]; transient: TransientSnapshot[]; framesSpent: number } {
  const run: MacroRun = {
    driver: new Driver(session, deepClone(start), initialMask),
    ctx,
    startMark: 0,
    maps: [],
    mapEntries: [],
    pagesObserved: new Set(),
    leaves: [],
    transient: [],
    framesSpent: 0,
    parked: false,
  };
  run.startMark = run.driver.mark();

  const finishEarly = (): { leaves: MacroLeaf[]; transient: TransientSnapshot[]; framesSpent: number } => ({
    leaves: run.leaves,
    transient: run.transient,
    framesSpent: run.framesSpent,
  });

  // 1. Walk the path. A dir held for one 6-tick block commits one tile-locked
  //    step (the engine reads input at tile boundaries, so the 8-tick step
  //    arrives two ticks into the following block); the blocks after hold
  //    nothing, so the player reaches the expected tile and no chained step
  //    steals the next dir.
  let tx = start.move.tx;
  let ty = start.move.ty;
  for (const dir of target.path) {
    const expectX = tx + DX[dir]!;
    const expectY = ty + DY[dir]!;
    let arrived = false;
    let blocks = 0;
    while (!arrived) {
      const states = step(run, { hold: blocks === 0 ? DIR_BUTTON[dir]! : 0 });
      if (states === "budget") return finishEarly();
      blocks++;
      for (const { state: s, mark, blockEnd } of states) {
        observe(run, s, isSessionWorldIdle(s), mark, blockEnd);
        if (run.parked) return finishEarly();
        if (s.interp.error) {
          run.leaves.push(makeLeaf(run, { error: s.interp.error.message }));
          return finishEarly();
        }
        if (s.mapId !== start.mapId || s.interp.modal || s.interp.main) {
          // The walk triggered something (a touch transfer, a page that
          // opened a dialog): ride it out from here.
          rideOut(run, 0);
          return finishEarly();
        }
        if (s.move.tx === expectX && s.move.ty === expectY) {
          arrived = true;
          tx = expectX;
          ty = expectY;
        } else if (s.move.tx !== tx || s.move.ty !== ty) {
          // Knocked off course: the macro aborts (the search may retry from
          // another state).
          return finishEarly();
        }
      }
      if (!arrived && blocks >= WALK_BLOCKED) return finishEarly(); // blocked
    }
  }

  // 2. Trigger.
  if (target.kind === "action") {
    if (target.face !== undefined && run.driver.state.move.facing !== target.face) {
      const face = step(run, { hold: DIR_BUTTON[target.face]! });
      if (face === "budget") return finishEarly();
      for (const { state: st, mark, blockEnd } of face) observe(run, st, false, mark, blockEnd);
      if (run.parked) return finishEarly();
    }
    const confirm = step(run, { hold: 0, confirm: true });
    if (confirm === "budget") return finishEarly();
    for (const { state: st, mark, blockEnd } of confirm) observe(run, st, false, mark, blockEnd);
    if (run.parked) return finishEarly();
  } else if (target.kind === "bump") {
    // Walk into the blocking body for one block: the step is refused and
    // the eventTouch page fires (the ride-out below picks it up).
    const bump = step(run, { hold: DIR_BUTTON[target.face ?? 0]! });
    if (bump === "budget") return finishEarly();
    for (const { state: st, mark, blockEnd } of bump) observe(run, st, false, mark, blockEnd);
    if (run.parked) return finishEarly();
  }
  // playerTouch: the entry fired during the walk.

  // 3. Ride out (branches at choices).
  rideOut(run, 0);
  return finishEarly();
}

/** Stand still sampling active pages. Catches pages a parallel activates on
 *  a timer while the player idles, and rides out entry autoruns. New
 *  triggerable pages become transient snapshots; if the world goes busy (an
 *  autorun fired) the ride-out produces leaves. A map without parallel
 *  pages cannot change the world while idle, so it takes one pair (just
 *  enough to ride out an entry autorun). */
export function executeWait(
  session: Session,
  start: SessionState,
  ctx: MacroContext,
  initialMask = 0,
): { leaves: MacroLeaf[]; transient: TransientSnapshot[]; framesSpent: number } {
  const run: MacroRun = {
    driver: new Driver(session, deepClone(start), initialMask),
    ctx,
    startMark: 0,
    maps: [],
    mapEntries: [],
    pagesObserved: new Set(),
    leaves: [],
    transient: [],
    framesSpent: 0,
    parked: false,
  };
  run.startMark = run.driver.mark();
  const startMap = run.driver.session.maps.get(run.driver.state.mapId);
  const hasParallel =
    startMap?.events?.some((ev) => ev.pages.some((p) => p.trigger === "parallel")) ?? false;
  const budget = hasParallel ? WAIT_BUDGET : 1;
  let quiet = 0;
  for (let pair = 0; pair < budget; pair++) {
    const before = run.pagesObserved.size;
    const transientBefore = run.transient.length;
    const states = step(run, { hold: 0 });
    if (states === "budget") return { leaves: run.leaves, transient: run.transient, framesSpent: run.framesSpent };
    for (const { state: s, mark, blockEnd } of states) {
      const idle = isSessionWorldIdle(s);
      observe(run, s, idle, mark, blockEnd);
      if (run.parked) {
        run.leaves.push(makeLeaf(run));
        return { leaves: run.leaves, transient: run.transient, framesSpent: run.framesSpent };
      }
      if (!idle) {
        // An autorun/parallel took the world busy: ride out to idle.
        rideOut(run, 0);
        return { leaves: run.leaves, transient: run.transient, framesSpent: run.framesSpent };
      }
    }
    const newObservation =
      run.pagesObserved.size > before || run.transient.length > transientBefore;
    quiet = newObservation ? 0 : quiet + 1;
    if (quiet >= WAIT_QUIET) break;
  }
  // One leaf for the end state (dedup merges it when nothing changed).
  run.leaves.push(makeLeaf(run));
  return { leaves: run.leaves, transient: run.transient, framesSpent: run.framesSpent };
}
