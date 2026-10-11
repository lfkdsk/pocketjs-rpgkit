// tools/rpgkit-check/src/dynamic/explore.ts — headless exploration coverage.
//
// Drives the real engine from the project start with a deterministic
// "explore" strategy: walk to every reachable action/playerTouch/eventTouch
// event on the current map (BFS on the engine's own passage table with live
// character bodies), trigger it (confirm while facing an action event, step
// onto a touch tile, or walk into a blocking eventTouch body from a
// neighbor — a bump), auto-advance dialogs (choices pick option
// 0), and when the map is exhausted, walk into a static transfer to reach
// the next map. Reports which event pages executed and which never did,
// with a reason.
//
// Coverage is observed through the engine's opt-in `onFiberStart` trace:
// the session fires it once for every page fiber that STARTS — including
// instant fibers (switch/item/gold/...) that begin and end inside one
// stepSession call, which a post-step scan of residual fibers cannot see.
// Every start counts, so a page the explorer re-triggers is counted again.
//
// This is a COVERAGE tool, not a player: it does not solve puzzles, and
// events gated on story state the explorer cannot produce are reported as
// never-triggered with the reason, not as failures.

import { BTN_BITS } from "../../../../src/engine/camera.ts";
import { activePage, type ExtensionScope } from "../../../../src/engine/interpreter.ts";
import {
  canStepFrom,
  isStandable,
  stampBlockedCells,
  type PassageTable,
} from "../../../../src/engine/passability.ts";
import {
  createSession,
  isSessionWorldIdle,
  sessionPassageTable,
  startSession,
  stepSession,
  tableWithBodies,
  type Session,
  type SessionState,
  type SessionOptions,
} from "../../../../src/engine/session.ts";
import type { Command, Dir, GameEvent, Project } from "../../../../src/engine/types.ts";
import { makeFinding, type CheckReport, type Finding, type FindingLocation } from "../finding.ts";
import { anyProjectCommand, collectProjectOp } from "../walk.ts";
import { CHECK_HZ, checkConditionContext, checkSessionOptions, pageTouchMode } from "./sim.ts";

// Dir4/Facing order: 0 down, 1 left, 2 up, 3 right.
const DIRS: readonly Dir[] = ["down", "left", "up", "right"];
const DIR_INDEX: Record<Dir, 0 | 1 | 2 | 3> = { down: 0, left: 1, up: 2, right: 3 };
const DX: Record<Dir, number> = { down: 0, left: -1, up: 0, right: 1 };
const DY: Record<Dir, number> = { down: 1, left: 0, up: -1, right: 0 };
const DIR_BUTTON: Record<Dir, number> = {
  down: BTN_BITS.DOWN,
  left: BTN_BITS.LEFT,
  up: BTN_BITS.UP,
  right: BTN_BITS.RIGHT,
};
/** The direction a player on a rect neighbor must face to look at the rect:
 *  the neighbor sits at rect + dir, so the rect is opposite(dir) away. */
const FACE_FROM_NEIGHBOR: Record<Dir, Dir> = {
  down: "up",
  up: "down",
  left: "right",
  right: "left",
};

/** Consecutive idle frames required before the run may report complete. A
 *  delayed autorun/parallel that flips a page condition after a wait must
 *  run out first. */
const IDLE_QUIET_TICKS = 30;

/** Frames a bump target holds the direction toward a blocking eventTouch
 *  body before giving up (the refused step fires on the first tick; the
 *  margin covers a turn and an arriving step). Below the 24-frame blocked
 *  detector, so a bump is never mistaken for a stale path. */
const BUMP_FRAMES = 12;

/** Ops that change page-condition inputs (switches/variables/items/gold/
 *  selfSwitches/tileProperties/appearances) or restructure the world
 *  (transfer/place/erase), plus extension commands whose effects are
 *  unknown. A live parallel running ONLY benign ops (wait/se/text/...)
 *  cannot change which pages are active, so it does not reset the idle
 *  streak — the example projects run ambience parallels (wait+se) that
 *  loop forever and would otherwise make "complete" unreachable. */
const STATE_MUTATING_OPS: ReadonlySet<Command["op"]> = new Set<Command["op"]>([
  "switch",
  "variable",
  "selfSwitch",
  "item",
  "gold",
  "tileProperty",
  "appearance",
  "followers",
  "gatherFollowers",
  "vehicle",
  "setVehicleLocation",
  "setVehicleImage",
  "setVehicleBgm",
  "place",
  "erase",
  "transfer",
  "ext",
  "extChoice",
  "shop",
  "playBgm",
  "fadeoutBgm",
  "stopBgm",
  "pauseBgm",
  "resumeBgm",
  "playMe",
  "replayBgm",
  // Scenes that write a variable (the chosen item id / a cell fact) can
  // change which pages are active once the modal resolves.
  "selectItem",
  "locationInfo",
]);

export interface ExploreOptions {
  /** Total frame budget (default 6000). */
  frames?: number;
  hz?: number;
  /** Frames without progress (new trigger / new tile / map change) before
   *  the run gives up (default 600). */
  stuckFrames?: number;
  /** Game-owned registrations loaded by the CLI's --session module. */
  sessionOptions?: SessionOptions;
}

export interface ExploreEventStat {
  map: string;
  event: string;
  name: string;
  /** Times a fiber for this event started (each onFiberStart trace counts). */
  triggers: number;
  /** Per-page trigger counts (index = page index). */
  pages: number[];
  /** The explorer reached a trigger tile and confirmed/entered but no fiber
   *  started (erased, empty page, or facing miss). */
  attemptedOnly: boolean;
}

export interface NeverTriggered {
  map: string;
  event: string;
  name: string;
  /** Page index that never started a fiber. */
  page: number;
  reason: "no-active-page" | "map-unvisited" | "unreachable" | "budget" | "stuck" | "attempted-no-fiber";
}

export interface ExploreReport extends CheckReport {
  check: "explore";
  events: ExploreEventStat[];
  neverTriggered: NeverTriggered[];
  mapsVisited: string[];
  framesRun: number;
  endedReason: "budget" | "complete" | "stuck" | "error";
}

interface Target {
  eventKey: string;
  map: string;
  event: GameEvent;
  /** action: face + confirm; playerTouch: step onto (also a non-blocking
   *  eventTouch); bump: press `face` toward a blocking eventTouch body. */
  kind: "action" | "playerTouch" | "bump";
  /** Tile to stand on. */
  x: number;
  y: number;
  /** For action neighbors: the direction to face before confirming. For a
   *  bump: the direction to walk into the body. */
  face?: Dir;
  /** Static transfer target in the active page (map-exit targets). */
  transferTo?: string;
  /** Index of the page that was active when this target was planned. */
  activePage?: number;
}

function eventOrigin(ev: GameEvent, chars: SessionState["chars"]): { x: number; y: number } {
  const ch = chars.chars[ev.id];
  return ch ? { x: ch.tx, y: ch.ty } : { x: ev.x, y: ev.y };
}

/** BFS shortest path (list of dirs) from (sx,sy) to (tx,ty) on the table. */
function bfsPath(table: PassageTable, sx: number, sy: number, tx: number, ty: number): Dir[] | null {
  if (sx === tx && sy === ty) return [];
  const key = (x: number, y: number) => y * table.width + x;
  const prev = new Map<number, Dir>();
  const queue: [number, number][] = [[sx, sy]];
  const seen = new Set<number>([key(sx, sy)]);
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    for (const dir of DIRS) {
      const d = DIR_INDEX[dir];
      if (!canStepFrom(table, cx, cy, d)) continue;
      const nx = cx + DX[dir]!;
      const ny = cy + DY[dir]!;
      if (!isStandable(table, nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, dir);
      if (nx === tx && ny === ty) {
        const path: Dir[] = [];
        let cx = nx;
        let cy = ny;
        let ck = key(cx, cy);
        while (ck !== key(sx, sy)) {
          const pd = prev.get(ck)!;
          path.unshift(pd);
          cx -= DX[pd]!;
          cy -= DY[pd]!;
          ck = key(cx, cy);
        }
        return path;
      }
      queue.push([nx, ny]);
    }
  }
  return null;
}

export function checkExplore(project: Project, options: ExploreOptions = {}): ExploreReport {
  const frames = options.frames ?? 6000;
  const stuckFrames = options.stuckFrames ?? 600;

  const mapsById = new Map(project.maps.map((m) => [m.id, m]));
  const eventsByKey = new Map<string, { map: string; event: GameEvent }>();
  for (const map of project.maps) {
    for (const ev of map.events ?? []) eventsByKey.set(`${map.id}/${ev.id}`, { map: map.id, event: ev });
  }

  const attempted = new Set<string>(); // "map/event"
  /** Every `${map}/${eventId}#${pageIndex}` plan() ever observed as the
   *  active page. A page never observed active cannot be triggered (its
   *  condition never held in a reached state) and is accounted for; a page
   *  observed active but never fired blocks completion. */
  const activePagesObserved = new Set<string>();
  /** Cached result of "can this event page mutate story state?" for live
   *  parallel fibers (key = `${map}/${eventId}#${pageIndex}`). */
  const parallelMutates = new Map<string, boolean>();
  const stats = new Map<string, ExploreEventStat>();
  const statFor = (map: string, ev: GameEvent): ExploreEventStat => {
    const key = `${map}/${ev.id}`;
    let s = stats.get(key);
    if (!s) {
      s = { map, event: ev.id, name: ev.name ?? "", triggers: 0, pages: [], attemptedOnly: false };
      stats.set(key, s);
    }
    return s;
  };

  // Fiber-start trace. The engine fires this for EVERY page fiber that
  // starts — including instant fibers (switch/item/gold/selfSwitch/...) that
  // begin and end inside one stepSession call, which a post-step scan of
  // residual fibers cannot see. Each start counts, so a page the explorer
  // re-triggers is counted again; this is the coverage signal.
  let fiberStarts = 0;
  const onFiberStart = (key: string, pageIndex: number): void => {
    const known = eventsByKey.get(key);
    if (!known) return;
    const s = statFor(known.map, known.event);
    s.triggers++;
    s.pages[pageIndex] = (s.pages[pageIndex] ?? 0) + 1;
    fiberStarts++;
  };

  const sessionDefaults = checkSessionOptions(project, options.sessionOptions);
  const externalFiberStart = sessionDefaults.onFiberStart;
  const session: Session = createSession(project, options.hz ?? CHECK_HZ, {
    ...sessionDefaults,
    onFiberStart: (key, pageIndex, parallel) => {
      externalFiberStart?.(key, pageIndex, parallel);
      onFiberStart(key, pageIndex);
    },
  });
  let state: SessionState = startSession(project, session);

  const mapsVisited = new Set<string>([state.mapId]);
  const visitedTiles = new Set<string>([`${state.mapId}@${state.move.tx},${state.move.ty}`]);
  let autoChoices = 0;
  const errors: string[] = [];
  let endedReason: ExploreReport["endedReason"] = "budget";
  /** First frame of the current idle streak (reset to the current frame on
   *  any non-idle frame). */
  let idleSince = 0;

  let path: Dir[] = [];
  let target: Target | null = null;
  let lastProgress = 0;
  let replanIn = 0;
  let confirmCooldown = 0;
  let turnDir: Dir | null = null; // one-frame turn-in-place before confirming
  let randomWalk = false;
  let heldSince = -1; // frame when the current held direction started moving us
  let pendingTouch: Target | null = null; // playerTouch target entered this frame
  let bumpHeld = 0; // frames the current bump target has pushed into the body

  const ext = (): ExtensionScope => ({ runtime: session.extensions, ext: state.ext });
  // Live passage: the authored table plus this visit's runtime tileProperty
  // overrides, then blocking-character bodies stamped on top.
  const table = (): PassageTable =>
    tableWithBodies(sessionPassageTable(session, state), state.chars);

  interface Plan {
    target: Target | null;
    path: Dir[];
    randomWalk: boolean;
  }

  /** Priority: untriggered non-exit (0) < untriggered exit (1) < triggered
   *  non-exit (2) < triggered exit (3). Exits (transfer-bearing pages) are
   *  only walked into once the map's events are exercised. "Triggered" is
   *  page-level: the page that is active RIGHT NOW must have fired, so a
   *  multi-page event whose next page just activated is re-prioritized. */
  const priority = (cand: Target): number => {
    const s = stats.get(cand.eventKey);
    const pageTriggered = cand.activePage !== undefined && (s?.pages[cand.activePage] ?? 0) > 0;
    return (pageTriggered ? 2 : 0) + (cand.transferTo !== undefined ? 1 : 0);
  };

  /** Whether a live parallel fiber's page can mutate story state (and thus
   *  could still change page conditions). Benign parallels (wait/se/...)
   *  loop forever in the example projects and must not block completion. */
  const parallelCanMutate = (key: string, pageIndex: number): boolean => {
    const cacheKey = `${key}#${pageIndex}`;
    const cached = parallelMutates.get(cacheKey);
    if (cached !== undefined) return cached;
    const known = eventsByKey.get(key);
    const page = known?.event.pages[pageIndex];
    const mutates = page !== undefined
      ? anyProjectCommand(project, page.commands, (c) => STATE_MUTATING_OPS.has(c.op))
      : false;
    parallelMutates.set(cacheKey, mutates);
    return mutates;
  };

  /** The world is idle when nothing could still change page conditions:
   *  no main fiber, modal, input lock, pending transfer/battle, scene,
   *  fade or player route (isSessionWorldIdle), and no live parallel
   *  fiber whose page can mutate story state (parallels are NOT covered
   *  by isWorldIdle and can set switches at any time). A live BGM fade or ME
   *  can also flip bgmPlaying later without a fiber remaining. */
  const worldIsIdle = (): boolean => {
    if (!isSessionWorldIdle(state)) return false;
    if (state.interp.audio?.bgm?.fade || state.interp.audio?.me) return false;
    for (const key of Object.keys(state.interp.parallels)) {
      if (parallelCanMutate(key, state.interp.parallels[key]!.pageIndex)) return false;
    }
    return true;
  };

  /** Completion gate, page-level: for EVERY event in the document, EVERY
   *  page index is accounted for — it either started a fiber at least once
   *  (`pages[i] > 0`) or was never observed active (its condition never
   *  held in a reached state, so it is honestly reported as
   *  never-triggered rather than blocking completion). A page with no
   *  commands can never start a fiber (the engine skips empty pages), so
   *  once the event fired some page, an empty secondary page is a no-op,
   *  not a coverage gap. */
  const allAccountedFor = (): boolean => {
    for (const [key, val] of eventsByKey) {
      const s = stats.get(key);
      const eventFired = (s?.triggers ?? 0) > 0;
      for (let i = 0; i < val.event.pages.length; i++) {
        if ((s?.pages[i] ?? 0) > 0) continue;
        if (!activePagesObserved.has(`${key}#${i}`)) continue;
        if (eventFired && val.event.pages[i]!.commands.length === 0) continue;
        return false; // observed active but never fired
      }
    }
    return true;
  };

  /** Pages already noticed as "active but never fired": each one forces at
   *  most ONE prompt replan, so a moving NPC (whose trigger origin shifts
   *  every frame) does not thrash the planner into re-targeting forever. */
  const noticedUnfired = new Set<string>();

  /** Sample the active page of every event on the CURRENT map, every
   *  reducer frame. plan() only samples at planning time (every ~120
   *  frames), so a page a parallel makes active for a few frames — then
   *  inactive again — could fall entirely between two samples: the old
   *  code never observed it, still reported `complete`, and wrote the page
   *  off as `no-active-page` ("its condition never held"), the opposite of
   *  the per-frame truth. Per-frame sampling makes those brief pages count
   *  toward coverage: the first time an observed-active action/playerTouch
   *  page is seen unfired, a prompt replan is forced so the planner targets
   *  it while it is still triggerable. Returns whether a NEW such page was
   *  seen this frame. */
  const sampleActivePages = (): boolean => {
    const map = mapsById.get(state.mapId);
    if (!map) return false;
    const ctx = checkConditionContext(state, map);
    let newUnfiredTriggerable = false;
    for (const ev of map.events ?? []) {
      const active = activePage(ev, state.sw, map.id, state.move.facing, ext(), ctx);
      if (!active) continue;
      const key = `${map.id}/${ev.id}`;
      const pageKey = `${key}#${active.index}`;
      activePagesObserved.add(pageKey);
      const s = stats.get(key);
      if ((s?.pages[active.index] ?? 0) === 0 &&
        pageTouchMode(active.page) !== null &&
        !noticedUnfired.has(pageKey)) {
        noticedUnfired.add(pageKey);
        newUnfiredTriggerable = true;
      }
    }
    return newUnfiredTriggerable;
  };

  const plan = (onlyUntriggered = false): Plan => {
    const map = mapsById.get(state.mapId);
    if (!map) return { target: null, path: [], randomWalk: false };
    const t = table();
    // The same ConditionContext the engine derives, so activePage sees
    // live tileProperty overrides and event appearances (KV1 conditions).
    const ctx = checkConditionContext(state, map);
    const px = state.move.tx;
    const py = state.move.ty;

    // Tiles that would teleport the player away (active playerTouch or
    // non-blocking eventTouch pages with a transfer — both fire on entry).
    // Pathing to a normal event routes AROUND them, so
    // the explorer does not bounce between a map and its return transfer;
    // pathing to a transfer target itself still walks onto the tile.
    const transferTiles = new Set<number>();
    for (const ev of map.events ?? []) {
      const active = activePage(ev, state.sw, map.id, state.move.facing, ext(), ctx);
      if (active) activePagesObserved.add(`${map.id}/${ev.id}#${active.index}`);
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

    const found: { cand: Target; path: Dir[] }[] = [];
    for (const ev of map.events ?? []) {
      const key = `${map.id}/${ev.id}`;
      const active = activePage(ev, state.sw, map.id, state.move.facing, ext(), ctx);
      if (!active) continue;
      activePagesObserved.add(`${key}#${active.index}`);
      const mode = pageTouchMode(active.page);
      if (mode === null) continue;
      const origin = eventOrigin(ev, state.chars);
      const w = ev.w ?? 1;
      const h = ev.h ?? 1;
      const transferTo = collectProjectOp(project, active.page.commands, "transfer")
        .map((c) => c.map)
        .find((m): m is string => typeof m === "string");
      const consider = (cand: Target): void => {
        if (cand.activePage !== undefined) {
          const s = stats.get(cand.eventKey);
          if ((s?.pages[cand.activePage] ?? 0) > 0) {
            // This page already fired. While waiting out the idle quiet
            // period, skip everything fired. In normal exploration, keep
            // fired EXITS (the explorer may need to ride a transfer to
            // reach a map with an untriggered page) but never re-confirm a
            // fired non-exit: re-opening its modal would reset the idle
            // streak and burn the budget in a re-confirm loop.
            if (onlyUntriggered || cand.transferTo === undefined) return;
          }
        }
        // Route around every transfer tile for pathing, except the
        // candidate's own tile (a playerTouch exit is triggered by
        // standing on it): pathing on the unblocked table would cross
        // OTHER transfer tiles and bounce the explorer away.
        let pathTable = safeTable;
        if (cand.kind === "playerTouch" && cand.transferTo !== undefined) {
          const own = cand.y * map.width + cand.x;
          if (transferTiles.has(own)) {
            const rest = new Set(transferTiles);
            rest.delete(own);
            pathTable = rest.size > 0 ? stampBlockedCells(t, rest) : t;
          }
        }
        const p = bfsPath(pathTable, px, py, cand.x, cand.y);
        if (p) found.push({ cand, path: p });
      };
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const cx = origin.x + dx;
          const cy = origin.y + dy;
          if (mode === "bump") {
            // A blocking eventTouch fires when the player's step is refused
            // by the body: stand on a neighbor and walk into the rect.
            for (const dir of DIRS) {
              const nx = cx + DX[dir]!;
              const ny = cy + DY[dir]!;
              if (isStandable(t, nx, ny)) {
                consider({ eventKey: key, map: map.id, event: ev, kind: "bump", x: nx, y: ny, face: FACE_FROM_NEIGHBOR[dir], transferTo, activePage: active.index });
              }
            }
            continue;
          }
          if (mode === "playerTouch") {
            // Do not target the tile the player is already standing on:
            // the engine's touch latch only fires on entry, so standing on
            // the same cell cannot re-trigger it (it would self-loop).
            if (isStandable(t, cx, cy) && !(cx === px && cy === py)) {
              consider({ eventKey: key, map: map.id, event: ev, kind: "playerTouch", x: cx, y: cy, transferTo, activePage: active.index });
            }
            continue;
          }
          // action: stand in the rect (any facing) or on a neighbor facing it.
          if (isStandable(t, cx, cy)) {
            consider({ eventKey: key, map: map.id, event: ev, kind: "action", x: cx, y: cy, transferTo, activePage: active.index });
          }
          for (const dir of DIRS) {
            const nx = cx + DX[dir]!;
            const ny = cy + DY[dir]!;
            if (isStandable(t, nx, ny)) {
              // The neighbor at (nx,ny) faces the rect cell from opposite(dir).
              consider({ eventKey: key, map: map.id, event: ev, kind: "action", x: nx, y: ny, face: FACE_FROM_NEIGHBOR[dir], transferTo, activePage: active.index });
            }
          }
        }
      }
    }
    // Prefer untriggered non-exit targets, then nearest.
    let best: { cand: Target; path: Dir[] } | null = null;
    for (const f of found) {
      const pri = priority(f.cand);
      if (!best || pri < priority(best.cand) || (pri === priority(best.cand) && f.path.length < best.path.length)) {
        best = f;
      }
    }
    if (best) return { target: best.cand, path: best.path, randomWalk: false };
    // Nothing reachable: random walk to shake loose moving NPCs. While
    // onlyUntriggered (idle quiet period), stand still instead — random
    // walking could cross a playerTouch tile and reset the streak.
    return { target: null, path: [], randomWalk: !onlyUntriggered };
  };

  let frame = 0;
  for (; frame < frames; frame++) {
    const prevMap = state.mapId;
    const prevTx = state.move.tx;
    const prevTy = state.move.ty;
    const prevFiberStarts = fiberStarts;
    const modal = state.interp.modal;
    let buttons = 0;
    let confirmEdge = false;
    let cancelEdge = false;

    if (state.interp.error) {
      errors.push(state.interp.error.message);
      endedReason = "error";
      break;
    }

    if (modal) {
      if (modal.kind === "text") {
        confirmEdge = frame % 2 === 0;
      } else if (modal.kind === "choices") {
        // Option 0 is the cursor default; confirm picks it. An empty,
        // non-cancellable choices box is a softlock the lint check flags.
        if (modal.options.length > 0) {
          confirmEdge = true;
          autoChoices++;
        } else if (!modal.cancellable) {
          endedReason = "stuck";
          break;
        } else {
          cancelEdge = true;
        }
      } else if (modal.kind === "shop") {
        cancelEdge = frame % 2 === 0;
      }
    } else if (state.interp.inputLocked) {
      // Autorun/parallel pages keep folding; the explorer waits.
    } else if (turnDir !== null) {
      // Turn in place on the action target's neighbor, then confirm next frame.
      buttons = DIR_BUTTON[turnDir]!;
      turnDir = null;
      confirmCooldown = 1;
    } else if (target && confirmCooldown === 0) {
      const onTarget = state.move.tx === target.x && state.move.ty === target.y;
      if (onTarget) {
        if (target.kind === "bump") {
          // Walk into the body: the refused step fires the page. Hold for a
          // bounded number of frames, then let the planner move on (a fiber
          // start clears it sooner, below).
          buttons = DIR_BUTTON[target.face ?? "down"]!;
          if (bumpHeld === 0) attempted.add(target.eventKey);
          bumpHeld++;
          if (bumpHeld >= BUMP_FRAMES) {
            target = null;
            bumpHeld = 0;
            replanIn = 1;
          }
        } else if (target.kind === "action") {
          if (target.face !== undefined && state.move.facing !== DIR_INDEX[target.face]) {
            turnDir = target.face;
          } else {
            confirmEdge = true;
            attempted.add(target.eventKey);
            confirmCooldown = 5;
            // Re-plan next frame: the event is now triggered (deprioritized)
            // or the transfer consumed it (the map-change handler clears it).
            replanIn = 1;
          }
        } else {
          // playerTouch: the entry fired it. The post-step handler clears the
          // target when the map did not change (and marks it attempted).
          pendingTouch = target;
        }
      } else if (path.length > 0) {
        buttons = DIR_BUTTON[path[0]!]!;
      }
    } else if (randomWalk) {
      // Hold each direction ~half a second so the walk actually covers tiles.
      buttons = DIR_BUTTON[DIRS[Math.floor(frame / 30) % 4]!]!;
    }

    state = stepSession(session, state, {
      buttons,
      confirmEdge,
      cancelEdge,
      upEdge: false,
      downEdge: false,
    });
    if (process.env.EXPLORE_DEBUG) {
      console.log(`f${frame} pos=${state.mapId}@${state.move.tx},${state.move.ty} btn=${buttons} confirm=${confirmEdge} modal=${state.interp.modal?.kind ?? "-"} main=${state.interp.main?.key ?? "-"}:${state.interp.main?.pageIndex ?? "-"} target=${target?.eventKey ?? "-"}@${target?.x},${target?.y} path=${path.length}`);
    }

    if (confirmCooldown > 0) confirmCooldown--;

    // Progress bookkeeping. The map-change handler runs BEFORE path
    // advancement: a transfer moves the player off the expected tile, and
    // the path handler would otherwise clear the target mid-transfer.
    const tileKey = `${state.mapId}@${state.move.tx},${state.move.ty}`;
    let progress = false;
    if (state.mapId !== prevMap) {
      mapsVisited.add(state.mapId);
      progress = true;
      // The transfer fiber's start was already counted by onFiberStart
      // before the map swap consumed it; only clear bookkeeping here.
      target = null;
      path = [];
      replanIn = 0;
      heldSince = -1;
      pendingTouch = null;
    } else if (pendingTouch) {
      // A playerTouch target that did not transfer: the entry fired (or the
      // page is empty). Clear it so the planner moves on; the touch latch
      // prevents re-firing until the explorer leaves the rect.
      attempted.add(pendingTouch.eventKey);
      target = null;
      replanIn = 0;
      pendingTouch = null;
    }

    // Path advancement: a held direction completes when the player's tile
    // changes. If the step landed where the path expected, drop it; anything
    // else (a route, a knock) invalidates the path.
    if (target && path.length > 0 && !modal && !state.interp.inputLocked) {
      const movedTile = state.move.tx !== prevTx || state.move.ty !== prevTy;
      if (movedTile) {
        const held = path[0]!;
        const expectedX = prevTx + DX[held]!;
        const expectedY = prevTy + DY[held]!;
        if (state.move.tx === expectedX && state.move.ty === expectedY) {
          path.shift();
        } else {
          target = null;
          path = [];
          replanIn = 0;
        }
      }
    }

    if (!visitedTiles.has(tileKey)) {
      visitedTiles.add(tileKey);
      progress = true;
    }
    if (fiberStarts > prevFiberStarts) {
      progress = true;
      // The bump fired the page (or something else started): stop pushing.
      if (target?.kind === "bump" && bumpHeld > 0) {
        target = null;
        bumpHeld = 0;
        replanIn = 1;
      }
    }
    if (progress) lastProgress = frame;

    // Blocked detector: holding a direction but the tile has not changed
    // for ~3 tiles of frames means a moving NPC stepped into the path —
    // drop the stale path and replan around the new bodies.
    if (buttons !== 0 && !modal && !state.interp.inputLocked) {
      if (state.move.tx === prevTx && state.move.ty === prevTy) {
        if (heldSince < 0) heldSince = frame;
        else if (frame - heldSince >= 24) {
          target = null;
          path = [];
          replanIn = 0;
          heldSince = -1;
        }
      } else {
        heldSince = -1;
      }
    } else {
      heldSince = -1;
    }

    // Per-frame active-page sampling: a parallel can switch a page on for a
    // few frames and off again, entirely between two plan() samples. The
    // sample records the observation (the page counts toward coverage) and
    // forces a prompt replan so a brief action/playerTouch page is targeted
    // while it is still triggerable.
    if (sampleActivePages()) replanIn = Math.min(replanIn, 1);

    replanIn--;
    if (frame - lastProgress >= stuckFrames) {
      endedReason = "stuck";
      break;
    }

    // Idle streak for the completion gate. Any non-idle frame (a fiber
    // that could still change page conditions is live) restarts it.
    const idle = worldIsIdle();
    if (!idle) idleSince = frame;

    // While the gate is armed — every observed-active page has fired, but
    // the idle streak has not run its course — re-plan every frame so a
    // fiber that just ended (e.g. a delayed autorun setting a switch) is
    // observed as a newly active page before we declare complete. Only
    // untriggered pages are targeted, so the explorer stands still instead
    // of re-confirming fired pages and resetting the streak.
    const armed = allAccountedFor() && idle && frame - idleSince < IDLE_QUIET_TICKS;
    if (armed || replanIn <= 0 || (!target && path.length === 0 && !randomWalk)) {
      const planned = plan(armed);
      bumpHeld = 0;
      target = planned.target;
      path = planned.path;
      randomWalk = planned.randomWalk;
      replanIn = 120;
    } else if (target && path.length === 0 && !modal && !state.interp.inputLocked) {
      // Target set but the player is not on it and has no path: replan soon
      // (a moving NPC may have opened or closed the route).
      const onTarget = state.move.tx === target.x && state.move.ty === target.y;
      if (!onTarget) replanIn = Math.min(replanIn, 2);
    }

    // Completion gate. Report "complete" only when BOTH hold, within the
    // observation window:
    //  1. allAccountedFor — every event page that was ever observed active
    //     (per-frame sampling, so brief parallel-driven page switches count)
    //     has started a fiber (pages never observed active are honestly
    //     reported as never-triggered, not blockers); AND
    //  2. the world has been idle for IDLE_QUIET_TICKS consecutive frames —
    //     no main fiber, modal, input lock, pending transfer/battle, scene,
    //     fade or player route (isSessionWorldIdle), and no live parallel
    //     fiber whose page can mutate story state. A delayed autorun that
    //     flips a page condition after a wait must run out first.
    if (allAccountedFor() && idle && frame - idleSince >= IDLE_QUIET_TICKS) {
      endedReason = "complete";
      break;
    }
  }

  // ---- report -------------------------------------------------------------

  const events: ExploreEventStat[] = [];
  const neverTriggered: NeverTriggered[] = [];
  for (const map of project.maps) {
    for (const ev of map.events ?? []) {
      const key = `${map.id}/${ev.id}`;
      const s = stats.get(key);
      const triggered = (s?.triggers ?? 0) > 0;
      const wasAttempted = attempted.has(key);
      const stat: ExploreEventStat = s ?? {
        map: map.id,
        event: ev.id,
        name: ev.name ?? "",
        triggers: 0,
        pages: [],
        attemptedOnly: false,
      };
      stat.attemptedOnly = wasAttempted && !triggered;
      events.push(stat);
      // Page-level coverage: every page that never started a fiber is
      // reported individually, with the reason it stayed untriggered.
      // An empty page on an event that already fired some page is a no-op
      // secondary page (the engine starts no fiber for it), not a gap.
      for (let page = 0; page < ev.pages.length; page++) {
        if ((s?.pages[page] ?? 0) > 0) continue;
        if (triggered && ev.pages[page]!.commands.length === 0) continue;
        const reason: NeverTriggered["reason"] = !mapsVisited.has(map.id)
          ? "map-unvisited"
          : !activePagesObserved.has(`${key}#${page}`)
            ? "no-active-page"
            : wasAttempted
              ? "attempted-no-fiber"
              : endedReason === "budget"
                ? "budget"
                : endedReason === "stuck"
                  ? "stuck"
                  : "unreachable";
        neverTriggered.push({ map: map.id, event: ev.id, name: ev.name ?? "", page, reason });
      }
    }
  }

  const findings: Finding[] = [];
  for (const nt of neverTriggered) {
    const loc: FindingLocation = { map: nt.map, event: nt.event };
    findings.push(makeFinding(
      "explore/never-triggered",
      "info",
      `event ${JSON.stringify(nt.event)}${nt.name ? ` (${nt.name})` : ""} on ${JSON.stringify(nt.map)} page ${nt.page} never ran within the ${frame}-frame observation window (${nt.reason})`,
      nt.reason === "attempted-no-fiber"
        ? "the explorer reached it but no fiber started — check erasure, an empty page, or a facing condition"
        : nt.reason === "no-active-page"
          ? "its page condition never held in any observed state — expected for story-gated events"
          : nt.reason === "unreachable"
            ? "no path from any visited tile — check blocking characters or closed corridors"
            : "expected if the event is gated on story state the explorer cannot produce",
      loc,
    ));
  }
  for (const message of errors) {
    findings.push(makeFinding(
      "explore/error",
      "error",
      `interpreter error during exploration: ${message}`,
      "fix the event that errored",
    ));
  }

  const eventsTriggered = events.filter((e) => e.triggers > 0).length;
  return {
    check: "explore",
    findings,
    summary: {
      frames,
      framesRun: frame,
      mapsVisited: mapsVisited.size,
      mapsTotal: project.maps.length,
      eventsTotal: events.length,
      eventsTriggered,
      eventsNeverTriggered: neverTriggered.length,
      triggersTotal: fiberStarts,
      autoChoices,
      errors: errors.length,
      endedReason,
    },
    events,
    neverTriggered,
    mapsVisited: [...mapsVisited],
    framesRun: frame,
    endedReason,
  };
}
