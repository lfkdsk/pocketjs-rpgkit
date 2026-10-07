// src/engine/chars.ts — P1④ map characters: NPC motion.
//
// Every event with an active page has a CharState, whether or not the page
// has a sprite (sprite-less chars are invisible and non-blocking, but a
// moveRoute command can still move the event). Like movement.ts this is a
// tile-locked grid walk: one step takes stepFrames MOTION_HZ reference
// ticks (8 at 2 px/tick), decisions happen only on tile-boundary ticks,
// and the walk is a pure fold over the per-tick input with no host clock
// and no Math.random. The host folds 60/simulationHz reference ticks per
// host frame, so patrol and autonomous motion advance by virtual time.
//
// Three motion sources, highest priority first:
//   1. forced route   — a moveRoute command running NOW. When `waiter`
//                       names a fiber, that fiber is parked until the route
//                       finishes (interpreter "external" mode); a page
//                       switch aborts the route and releases the waiter.
//   2. patrol route   — the page-authored page.moveRoute loop (the guard's
//                       fixed two-steps-right / two-steps-left beat).
//   3. autonomous     — page.moveType: "random" ambles on the seeded RNG;
//                       "approach" steps toward the player on a timer;
//                       "static" stands.
//
// Collision is decided per tile BEFORE a step and combines the cooked
// PassageTable with character occupancy: a character never enters a tile
// the player occupies (or is stepping into). Only characters whose page
// sets blocks:true have a body: they keep the player AND other characters
// out, while a below-character sign or a sprite-less blocks:false marker
// is walked over by both.
//
// A character whose event owns the running blocking fiber is `locked`:
// it freezes for the interaction (MV Game_Event lock). PARALLEL fibers do
// not lock.

import {
  activeIndexAt,
  effectiveEventAppearance,
  eventKey,
  randInt,
  type ConditionContext,
  type EventAppearanceState,
  type ExtensionScope,
  type KeyedEvent,
  type SwitchState,
} from "./interpreter.ts";
import { keyedRecord } from "./clone.ts";
import { RecentStateMetadata, trackStateMetadata } from "./state-metadata.ts";
import {
  activeStepConfig,
  stepPixels,
  stepFrames,
  type MovementConfig,
} from "./movement.ts";
import {
  canFace,
  DEFAULT_MOVE_SETTINGS,
  frequencyDelay,
  inMapBounds,
  inWanderBounds,
  movementConfigFor,
  type ResolvedMoveSettings,
} from "./move-control.ts";
import type { Dir4, PassageTable } from "./passability.ts";
import { canStepFrom } from "./passability.ts";
import {
  advancePathSearch,
  approachSide,
  approachStand,
  clonePathSearch,
  createPathSearch,
  facingToward,
  type PathSearchState,
} from "./pathfind.ts";
import type {
  Dir,
  Facing,
  GameEvent,
  MapDef,
  MoveControl,
  MoveRoute,
  MoveSpeed,
  MoveStep,
} from "./types.ts";

const DX = [0, -1, 0, 1] as const; // down, left, up, right
const DY = [1, 0, -1, 0] as const;

const DIR4: Record<Dir, Dir4> = { down: 0, left: 1, up: 2, right: 3 };

/** Durable position overrides the interpreter carries across a map visit. */
export interface Placement {
  x: number;
  y: number;
  dir: Dir | null;
}

/** MOTION_HZ reference ticks between autonomous random/approach decisions. */
const THINK_BEATS = 8;
const IDLE_BEATS = 16;
/** Approach pages only walk at the player inside this Manhattan radius. */
export const APPROACH_SIGHT = 6;

/** Boundary ticks a pathTo/approach step waits on a blocked first step
 *  before recomputing the whole BFS (one tile step is stepFrames=8 ticks). */
export const PATH_REPLAN_TICKS = 8;
/** Full replans a path step allows before it completes anyway (Tuxemon's
 *  path controller stops the blocking action when the waypoint never
 *  clears), so a waited route cannot park its fiber forever. */
export const DEFAULT_PATH_RETRIES = 10;
/** Cells one path search dequeues per reference tick when frame-split. Ten
 *  concurrent searches at 60 Hz expand about 10x this per host frame; the
 *  budget leaves headroom below the measured QuickJS 2 ms p95 target. The
 *  BFS result is identical to a synchronous search; only its latency is
 *  spread. */
export const BFS_CELLS_PER_TICK = 250;

/** The expanded plan behind one pathTo/approach route step. */
export interface PathPlan {
  /** Incremental BFS while it is still computing (frame-split), else null
   *  once a result has been moved into `dirs`. */
  search: PathSearchState | null;
  /** Remaining walk directions; the first entry is the next step. Empty
   *  with done=false means a search is computing (or the goal was
   *  unreachable and the blocked-retry wait is running). */
  dirs: Dir4[];
  /** Consecutive boundary ticks the next planned step has been blocked
   *  (or the goal stayed unreachable). */
  blockedTicks: number;
  /** True once the final internal step has been committed and the char is
   *  interpolating to the goal: the landing tick applies the approach
   *  arrival-facing and advances the route pc. Distinguishes an exhausted
   *  plan from a dirs=[] unreachable plan that is waiting to replan. */
  done: boolean;
  /** When set, this is an approach step: on arrival the character faces
   *  the live target; the stand tile is the target cell offset by side. */
  approach: {
    target: "player" | { event: string };
    /** Resolved side (Dir4) to stand on; authored Dir is converted once. */
    side: Dir4;
    distance: number;
  } | null;
}

export type MotionType = "static" | "random" | "approach";

export interface RouteRun {
  steps: readonly MoveStep[];
  pc: number;
  repeat: boolean;
  /** MV "skip if cannot move": a blocked move ends the route instead of
   *  being retried forever. */
  skippable: boolean;
  /** Page patrol loops forever and is rebuilt on every page switch. */
  patrol: boolean;
  /** Fiber key parked until this route finishes; null = fire-and-forget. */
  waiter: string | null;
  /** MOTION_HZ reference ticks left of an in-route wait step. */
  waitLeft: number;
  /** Expansion state for the current pathTo/approach step; null on
   *  ordinary steps and between route steps. A session save records it,
   *  search in flight included, in the snapshot's map runtime. */
  plan: PathPlan | null;
  /** Remaining full BFS replans for the current path step. This lives on
   *  the route, not PathPlan, because replanning deliberately discards and
   *  rebuilds the plan. Null outside a path step. */
  pathRetriesLeft: number | null;
  /** A speed grade latched for THIS route only (a routeSpeed control).
   *  Absent means the route uses the actor's resolved speed. It is set when
   *  the route installs (consuming a pending override) or by a routeSpeed
   *  control while the route runs, and dies with the route, so the next
   *  route and autonomous movement are unaffected. */
  speed?: MoveSpeed;
}

export interface CharState {
  id: string;
  tx: number;
  ty: number;
  px: number;
  py: number;
  facing: Dir4;
  /** 0 at a tile boundary, 1..stepFrames reference ticks while interpolating. */
  phase: number;
  moving: boolean;
  stepDir: Dir4;
  pageIndex: number;
  visible: boolean;
  blocks: boolean;
  thinkIn: number;
  /** The active run: a forced route while one is installed, otherwise the
   *  page patrol. */
  route: RouteRun | null;
  /** The page-authored patrol as a pristine template (pc 0). A forced
   *  route replaces `route` but keeps this; when the forced route ends the
   *  patrol is restored fresh from the character's current cell, the way
   *  MV rebuilds the page move route after a forced route completes. */
  patrol: RouteRun | null;
}

export interface CharsState {
  /** Mulberry32 cursor shared by random wander and turnRandom. Part of the
   *  per-map session state, so NPC motion tape-replays byte-for-byte. */
  rng: number;
  chars: Record<string, CharState>;
}

export function createChars(rng = 0x5151_5151): CharsState {
  return { rng, chars: keyedRecord() };
}

function cloneRoute(route: RouteRun | null): RouteRun | null {
  if (!route) return null;
  return {
    ...route,
    steps: [...route.steps],
    plan: route.plan
      ? {
          ...route.plan,
          dirs: [...route.plan.dirs],
          search: clonePathSearch(route.plan.search),
          approach: route.plan.approach ? { ...route.plan.approach } : null,
        }
      : null,
  };
}

function cloneChar(ch: CharState): CharState {
  return { ...ch, route: cloneRoute(ch.route), patrol: cloneRoute(ch.patrol) };
}

/** Clone mutable character state while retaining prototype-safe id tables. */
export function cloneChars(s0: CharsState): CharsState {
  const chars = keyedRecord<CharState>();
  for (const id of Object.keys(s0.chars)) chars[id] = cloneChar(s0.chars[id]!);
  return { rng: s0.rng, chars };
}

/** Characters and table ownership of a shareChars working copy. A state
 *  absent from this map (cloneChars, createChars) owns both outright. */
interface CharsOwnership {
  ids: Set<string>;
  sharedTable: boolean;
}
const OWNED = new WeakMap<CharsState, CharsOwnership>();

function ownTable(s: CharsState): void {
  const owned = OWNED.get(s);
  if (owned?.sharedTable) {
    owned.sharedTable = false;
    s.chars = keyedRecord(s.chars);
  }
}

const PAGE_REVISION = new RecentStateMetadata<CharsState, object>();
const POSITION_REVISION = new RecentStateMetadata<CharsState, object>();

export function charsPositionRevision(s: CharsState): object {
  let token = POSITION_REVISION.get(s);
  if (!token) {
    token = {};
    POSITION_REVISION.set(s, token);
  }
  return token;
}

export function charsPageRevision(s: CharsState): object {
  let token = PAGE_REVISION.get(s);
  if (!token) {
    token = {};
    PAGE_REVISION.set(s, token);
  }
  return token;
}

/** A working copy that shares each character object with `s0` until the
 *  first write to it (ownChar). stepSession folds one of these per frame:
 *  most characters stand still, so most are never copied. */
export function shareChars(s0: CharsState, immutable = false): CharsState {
  const s: CharsState = { rng: s0.rng, chars: immutable ? s0.chars : keyedRecord(s0.chars) };
  OWNED.set(s, { ids: new Set(), sharedTable: immutable });
  if (immutable) {
    trackStateMetadata(OWNED, s);
    PAGE_REVISION.set(s, charsPageRevision(s0));
    POSITION_REVISION.set(s, charsPositionRevision(s0));
  }
  return s;
}

/** The character `id` of `s`, copied first if it is still shared. Every
 *  write to a character of a working copy goes through here. */
function ownChar(s: CharsState, id: string): CharState {
  const ch = s.chars[id]!;
  const owned = OWNED.get(s);
  if (!owned || owned.ids.has(id)) return ch;
  owned.ids.add(id);
  const copy = cloneChar(ch);
  if (owned.sharedTable) {
    owned.sharedTable = false;
    s.chars = keyedRecord(s.chars);
  }
  s.chars[id] = copy;
  return copy;
}

export interface SyncResult {
  /** Waiter fibers whose forced route was aborted by a page switch or the
   *  event disappearing (the session resumes each so a parked fiber cannot
   *  deadlock). */
  abortedWaiters: string[];
}

/** Reconcile characters with the active pages. Called once per reference
 *  tick before stepChars: creates chars for new active pages, removes chars for
 *  erased events / pages whose condition stopped holding, and rebuilds the
 *  patrol route when the page index changes. */
export function syncPages(
  s0: CharsState,
  map: MapDef,
  sw: SwitchState,
  cfg: MovementConfig,
  erased: ReadonlySet<string>,
  placements: Readonly<Record<string, Placement>> = keyedRecord(),
  facing?: Facing,
  extension?: ExtensionScope,
  conditionContext?: ConditionContext,
  appearances?: Readonly<Record<string, EventAppearanceState>>,
): { state: CharsState; result: SyncResult } {
  const s = cloneChars(s0);
  const events: KeyedEvent[] = [];
  const slotsById = new Map<string, number[]>();
  for (const ev of map.events ?? []) {
    slotsById.set(ev.id, [...(slotsById.get(ev.id) ?? []), events.length]);
    events.push({ ev, key: eventKey(map.id, ev.id), index: events.length });
  }
  const result = syncPagesInPlace(
    s,
    events,
    slotsById,
    sw,
    cfg,
    (key) => erased.has(key),
    placements,
    facing,
    extension,
    undefined,
    true,
    conditionContext,
    appearances,
  );
  return { state: s, result };
}

/** syncPages on a working copy the caller owns. `events` are the map's
 *  events with their keys in authored order and `slotsById` each id's
 *  positions in that list (World.keyedEvents/slotsById). `motion`, when
 *  given, receives the active page's moveType of every event that has an
 *  active page at `facing` (erased or not), as the session's motion table
 *  would. With `detachPatrol` a page switch gives the patrol template its
 *  own copy of the new route, as a copy of the returned state would. The
 *  safe default detaches it; callers may opt out only when they immediately
 *  deep-clone the result before any route can advance. `selectedPages`, when
 *  supplied, records that same active-page decision so a caller need not
 *  evaluate every condition a second time. With `prune` false
 *  only `events` are reconciled: characters of events outside the list are
 *  left alone instead of being removed as no longer live. */
export function syncPagesInPlace(
  s: CharsState,
  events: readonly KeyedEvent[],
  slotsById: ReadonlyMap<string, readonly number[]>,
  sw: SwitchState,
  cfg: MovementConfig,
  isErased: (key: string) => boolean,
  placements: Readonly<Record<string, Placement>> = keyedRecord(),
  facing?: Facing,
  extension?: ExtensionScope,
  motion?: Record<string, MotionType>,
  detachPatrol = true,
  conditionContext?: ConditionContext,
  appearances?: Readonly<Record<string, EventAppearanceState>>,
  prune = true,
  selectedPages?: Map<GameEvent, number>,
): SyncResult {
  const abortedWaiters: string[] = [];
  const liveSlot = new Array<boolean>(events.length);
  let changed = false;

  for (const { ev, key, index: slot } of events) {
    const index = activeIndexAt(ev, sw, key, facing, extension, conditionContext);
    selectedPages?.set(ev, index);
    if (motion && index >= 0) motion[ev.id] = ev.pages[index]!.moveType ?? "static";
    liveSlot[slot] = index >= 0 && !isErased(key);
    if (!liveSlot[slot]) continue;
    const page = ev.pages[index]!;

    let existing = s.chars[ev.id];
    if (!existing) {
      changed = true;
      // A `place` command relocates the spawn origin; MV Set Event
      // Location moves a not-yet-loaded event's future start too.
      const placed = placements[ev.id];
      const ox = placed ? placed.x : ev.x;
      const oy = placed ? placed.y : ev.y;
      const initialFacing: Dir4 = placed?.dir ? DIR4[placed.dir] : (page.dir ? DIR4[page.dir] : 0);
      OWNED.get(s)?.ids.add(ev.id);
      ownTable(s);
      const appearance = appearances?.[ev.id];
      s.chars[ev.id] = {
        id: ev.id,
        tx: ox,
        ty: oy,
        px: ox * cfg.tile,
        py: oy * cfg.tile,
        facing: initialFacing,
        phase: 0,
        moving: false,
        stepDir: initialFacing,
        pageIndex: index,
        visible: appearance === undefined
          ? page.sprite != null
          : effectiveEventAppearance(
              { pageIndex: index, sprite: page.sprite ?? null },
              appearance,
            ).visible,
        blocks: page.blocks === true,
        thinkIn: 0,
        route: makePatrol(page.moveRoute),
        patrol: makePatrol(page.moveRoute),
      };
      continue;
    }

    const appearance = appearances?.[ev.id];
    const visible = appearance === undefined
      ? page.sprite != null
      : effectiveEventAppearance(
          { pageIndex: index, sprite: page.sprite ?? null },
          appearance,
        ).visible;
    const blocks = page.blocks === true;
    if (existing.visible === visible && existing.blocks === blocks && existing.pageIndex === index) continue;
    changed = true;
    existing = ownChar(s, ev.id);
    existing.visible = visible;
    existing.blocks = blocks;
    if (index !== existing.pageIndex) {
      // A running fiber compiled from the OLD page keeps running, but its
      // parked route and the visual patrol belong to the page that is gone.
      if (existing.route?.waiter) abortedWaiters.push(existing.route.waiter);
      existing.pageIndex = index;
      existing.route = makePatrol(page.moveRoute);
      existing.patrol = detachPatrol ? cloneRoute(existing.route) : existing.route;
      existing.phase = 0;
      existing.moving = false;
      existing.px = existing.tx * cfg.tile;
      existing.py = existing.ty * cfg.tile;
      existing.thinkIn = 0;
      // MV resets the event's facing to the new page's authored direction
      // on page setup (page.dir).
      if (page.dir) {
        existing.facing = DIR4[page.dir];
        existing.stepDir = existing.facing;
      }
    }
  }

  // A character is live while any event carrying its id is.
  const live = (id: string): boolean => {
    for (const slot of slotsById.get(id) ?? []) if (liveSlot[slot]) return true;
    return false;
  };
  if (prune) for (const id of Object.keys(s.chars)) {
    if (!live(id)) {
      const gone = s.chars[id]!;
      if (gone.route?.waiter) abortedWaiters.push(gone.route.waiter);
      ownTable(s);
      delete s.chars[id];
      changed = true;
    }
  }
  if (changed && PAGE_REVISION.get(s) !== undefined) {
    PAGE_REVISION.set(s, {});
    POSITION_REVISION.set(s, {});
  }
  return { abortedWaiters };
}

function makePatrol(route: MoveRoute | undefined): RouteRun | null {
  if (!route || route.steps.length === 0) return null;
  return {
    steps: route.steps,
    pc: 0,
    repeat: true,
    skippable: route.skippable,
    patrol: true,
    waiter: null,
    waitLeft: 0,
    plan: null,
    pathRetriesLeft: null,
  };
}

/** Relocate an event's character to a tile (MV Set Event
 *  Location), aborting any in-flight step. A character not yet created is a
 *  no-op here: syncPages spawns it from the durable placement record on the
 *  next reconciliation. A forced route in progress is displaced and its
 *  waiter returned so the parking fiber cannot deadlock. */
export function placeChar(
  s0: CharsState,
  eventId: string,
  x: number,
  y: number,
  dir: Dir | null,
  cfg: MovementConfig,
): { state: CharsState; displacedWaiter: string | null } {
  const s = cloneChars(s0);
  const ch = s.chars[eventId];
  const displacedWaiter = ch?.route && !ch.route.patrol && ch.route.waiter ? ch.route.waiter : null;
  if (ch) {
    ch.tx = x;
    ch.ty = y;
    ch.px = x * cfg.tile;
    ch.py = y * cfg.tile;
    ch.phase = 0;
    ch.moving = false;
    if (dir) {
      ch.facing = DIR4[dir];
      ch.stepDir = ch.facing;
    }
    ch.thinkIn = 0;
    ch.route = ch.patrol ? { ...ch.patrol, pc: 0, waitLeft: 0 } : null;
  }
  return { state: s, displacedWaiter };
}

/** Install a forced route published by a moveRoute command. A previous
 *  unfinished forced route is displaced; its waiter (if any) is returned so
 *  the session resumes it instead of leaking a parked fiber. */
export function installRoute(
  s0: CharsState,
  eventId: string,
  route: MoveRoute,
  waiter: string | null,
  cfg: MovementConfig,
  speed?: MoveSpeed,
): { state: CharsState; displacedWaiter: string | null } {
  const s = cloneChars(s0);
  const ch = s.chars[eventId];
  const displacedWaiter = ch?.route && !ch.route.patrol && ch.route.waiter ? ch.route.waiter : null;
  if (ch) {
    ch.route = {
      steps: route.steps,
      pc: 0,
      repeat: route.repeat,
      skippable: route.skippable,
      patrol: false,
      waiter,
      waitLeft: 0,
      plan: null,
      pathRetriesLeft: null,
      ...(speed !== undefined ? { speed } : {}),
    };
    ch.phase = 0;
    ch.moving = false;
    ch.thinkIn = 0;
    ch.px = ch.tx * cfg.tile;
    ch.py = ch.ty * cfg.tile;
  }
  return { state: s, displacedWaiter };
}

/** The per-tick movement config for a route actor: its resolved settings,
 *  except while the route carries a latched routeSpeed grade, which
 *  replaces the speed component for that route only (running still adds
 *  its grade). The routeSpeed field is absent everywhere else, so the
 *  common path is one optional-field read. Event routes pass
 *  `ch.route?.speed`; the player route passes `playerRoute.speed`. */
export function routeSpeedConfig(
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
  speed: MoveSpeed | undefined,
): MovementConfig {
  if (speed === undefined) return movementConfigFor(cfg, settings);
  return movementConfigFor(cfg, { speed, running: settings.running });
}

/** Latch a routeSpeed grade onto a character's ACTIVE forced route. Returns
 *  false when the character has no forced route running (the caller then
 *  keeps the grade pending for the next route install). */
export function latchRouteSpeed(
  s0: CharsState,
  eventId: string,
  speed: MoveSpeed,
): { state: CharsState; latched: boolean } {
  const active = s0.chars[eventId]?.route;
  if (!active || active.patrol) return { state: s0, latched: false };
  const s = cloneChars(s0);
  s.chars[eventId]!.route!.speed = speed;
  return { state: s, latched: true };
}

/** Stop the active route without cutting a committed tile in half. The
 *  character finishes that tile from its already-latched interpolation;
 *  no remaining route command runs. */
export function stopCharRoute(
  s0: CharsState,
  eventId: string,
): { state: CharsState; displacedWaiter: string | null } {
  const s = cloneChars(s0);
  const ch = s.chars[eventId];
  const displacedWaiter = ch?.route?.waiter ?? null;
  if (ch) {
    ch.route = null;
    ch.thinkIn = 0;
  }
  return { state: s, displacedWaiter };
}

const FACE: Record<string, Dir4> = {
  faceDown: 0,
  faceLeft: 1,
  faceUp: 2,
  faceRight: 3,
};
const MOVE: Record<string, Dir4> = {
  moveDown: 0,
  moveLeft: 1,
  moveUp: 2,
  moveRight: 3,
};

export interface PlayerPlace {
  tx: number;
  ty: number;
  /** Tile the player is stepping INTO this tick (same as tx,ty at rest). */
  destX: number;
  destY: number;
  /** A through player is not an obstacle to NPC motion. */
  through?: boolean;
  /** eventTouch out-list: when present, every character whose attempted
   *  step this tick is refused by the PLAYER's body (and by nothing the
   *  terrain says) appends its id. The session passes it only on maps with
   *  an eventTouch page. */
  contacts?: string[];
}

export interface CharStepOptions {
  /** Fully resolved page defaults + runtime overrides, keyed by event id. */
  settings?: Readonly<Record<string, ResolvedMoveSettings>>;
  /** Called by a {control} route step at its tile boundary. */
  applyControl?: (eventId: string, control: MoveControl) => void;
  /** Saveable project RNG used only by command-started random wandering. */
  runtimeRng?: { rng: number };
  /** Tuxemon runtime wander pauses while any dialog/choice/shop is open. */
  modalOpen?: boolean;
}

const LEGACY_SETTINGS: Record<MotionType, ResolvedMoveSettings> = {
  static: DEFAULT_MOVE_SETTINGS as ResolvedMoveSettings,
  random: { ...DEFAULT_MOVE_SETTINGS, moveType: "random" },
  approach: { ...DEFAULT_MOVE_SETTINGS, moveType: "approach" },
};

const LEGACY_TICK_IDS = new WeakMap<object, WeakMap<object, readonly string[]>>();
const CONTROLLED_TICK_IDS = new WeakMap<object, WeakMap<object, readonly string[]>>();

function cachedTickIds(
  cache: WeakMap<object, WeakMap<object, readonly string[]>>,
  s: CharsState,
  key: object,
  active: (id: string, ch: CharState) => boolean,
): readonly string[] {
  const revision = charsPageRevision(s);
  let byKey = cache.get(revision);
  if (!byKey) {
    byKey = new WeakMap();
    cache.set(revision, byKey);
  }
  let ids = byKey.get(key);
  if (!ids) {
    ids = Object.keys(s.chars).sort().filter((id) => active(id, s.chars[id]!));
    byKey.set(key, ids);
  }
  return ids;
}

function legacyTickIds(
  s: CharsState,
  motion: Readonly<Record<string, MotionType>>,
): readonly string[] {
  return cachedTickIds(LEGACY_TICK_IDS, s, motion, (id, ch) =>
    ch.moving || ch.route !== null || ch.thinkIn > 0 || (motion[id] ?? "static") !== "static");
}

function controlledTickIds(
  s: CharsState,
  motion: Readonly<Record<string, MotionType>>,
  resolved: Readonly<Record<string, ResolvedMoveSettings>> | undefined,
): readonly string[] {
  const key = resolved ?? motion;
  return cachedTickIds(CONTROLLED_TICK_IDS, s, key, (id, ch) => {
    const settings = resolved?.[id] ?? LEGACY_SETTINGS[motion[id] ?? "static"];
    const pageRouteNeedsSync =
      (ch.route?.patrol === true && (settings.runtimeMoveType || settings.routeStopped)) ||
      (ch.route === null && ch.patrol !== null && !settings.runtimeMoveType && !settings.routeStopped);
    return ch.moving || ch.route !== null || ch.thinkIn > 0 ||
      settings.moveType !== "static" || settings.routeStopped || pageRouteNeedsSync;
  });
}

function occupantBlocks(
  ch: CharState,
  tx: number,
  ty: number,
  exit: Dir4,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  settings: ResolvedMoveSettings,
  allSettings?: Readonly<Record<string, ResolvedMoveSettings>>,
): boolean {
  // The exit direction is the direction of THIS candidate step; the
  // character's current facing is its pre-turn orientation and must not be
  // used to look up the target cell's directional block. canStepFrom checks
  // BOTH edges of the crossing: the source cell's exit mask and the target
  // cell's reverse-entry mask (task-1206 dual-edge contract).
  if (settings.through) return !inMapBounds(table.width, table.height, tx, ty);
  if (!canStepFrom(table, ch.tx, ch.ty, exit)) return true;
  if (!player.through && tx === player.tx && ty === player.ty) return true;
  if (!player.through && tx === player.destX && ty === player.destY) return true;
  for (const [id, o] of others) {
    // Only a body stops a character, the rule the player mover follows
    // (tableWithBodies): a blocks:false page — a sprite-less trigger
    // marker, a sign drawn below characters — is walked over.
    if (id === ch.id || !o.blocks || allSettings?.[id]?.through === true) continue;
    if (tx === o.tx && ty === o.ty) return true;
    if (o.moving && tx === o.tx + DX[o.stepDir] && ty === o.ty + DY[o.stepDir]) return true;
  }
  return false;
}

/** After occupantBlocks refused ch's step into (tx,ty): record an eventTouch
 *  contact when the player's body is the reason. The terrain must allow the
 *  crossing (the same edge test occupantBlocks applies first), so a wall
 *  beside the player never counts. No-op without a contacts list. */
function noteContact(
  ch: CharState,
  tx: number,
  ty: number,
  exit: Dir4,
  table: PassageTable,
  player: PlayerPlace,
  through: boolean,
): void {
  const out = player.contacts;
  if (out === undefined || through || player.through) return;
  if ((tx !== player.tx || ty !== player.ty) && (tx !== player.destX || ty !== player.destY)) return;
  if (canStepFrom(table, ch.tx, ch.ty, exit)) out.push(ch.id);
}

/** True when a character's body keeps the PLAYER out of (tx,ty): the
 *  active page must opt in with blocks:true. */
export function charBlocksPlayer(ch: CharState, tx: number, ty: number, through = false): boolean {
  if (!ch.blocks || through) return false;
  if (tx === ch.tx && ty === ch.ty) return true;
  if (ch.moving && tx === ch.tx + DX[ch.stepDir] && ty === ch.ty + DY[ch.stepDir]) return true;
  return false;
}

/** Build the per-tick collision predicate the player mover consults
 *  alongside its PassageTable. */
export function playerBlockedBy(
  s: CharsState,
  settings?: Readonly<Record<string, ResolvedMoveSettings>>,
): (tx: number, ty: number) => boolean {
  const chars = Object.values(s.chars);
  return (tx, ty) => chars.some((ch) => charBlocksPlayer(ch, tx, ty, settings?.[ch.id]?.through));
}

function commitStep(
  ch: CharState,
  dir: Dir4,
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
): void {
  if (canFace(settings, false)) ch.facing = dir;
  ch.stepDir = dir;
  ch.moving = true;
  ch.phase = 1;
  const { px, py } = stepPixels(ch.tx * cfg.tile, ch.ty * cfg.tile, dir, 1, cfg);
  ch.px = px;
  ch.py = py;
}

function releaseRoute(ch: CharState, finishedWaiters: string[]): void {
  if (ch.route?.waiter) finishedWaiters.push(ch.route.waiter);
  if (ch.route?.patrol) {
    ch.route.pc = 0;
    ch.route.waitLeft = 0;
    ch.route.plan = null;
    ch.route.pathRetriesLeft = null;
  } else if (ch.patrol) {
    // The forced route ended (landed, skipped, or was aborted via a page
    // switch elsewhere): restore the page patrol fresh from this cell.
    ch.route = { ...ch.patrol, pc: 0, waitLeft: 0 };
  } else {
    ch.route = null;
  }
}

/** One MOTION_HZ reference tick for every character, in ascending event-id
 *  order so the fold is deterministic. `locked` names events whose blocking
 *  fiber owns the session (they freeze). `motion` is the active page
 *  moveType per event. Returns waiters whose forced routes FINISHED (or were
 *  skipped) on or before this tick. */
export function stepChars(
  s0: CharsState,
  table: PassageTable,
  player: PlayerPlace,
  cfg: MovementConfig,
  locked: ReadonlySet<string>,
  motion: Readonly<Record<string, MotionType>>,
  options?: CharStepOptions,
): { state: CharsState; finishedWaiters: string[] } {
  const s = cloneChars(s0);
  return {
    state: s,
    finishedWaiters: options === undefined
      ? stepCharsInPlaceLegacy(s, table, player, cfg, locked, motion)
      : stepCharsInPlace(s, table, player, cfg, locked, motion, options),
  };
}

/** stepChars on a working copy the caller owns; returns finishedWaiters. */
export function stepCharsInPlace(
  s: CharsState,
  table: PassageTable,
  player: PlayerPlace,
  cfg: MovementConfig,
  locked: ReadonlySet<string>,
  motion: Readonly<Record<string, MotionType>>,
  options: CharStepOptions,
  immutable = false,
): string[] {
  const finishedWaiters: string[] = [];
  let others: Map<string, CharState> | undefined;
  const otherChars = () => others ??= new Map(Object.entries(s.chars));

  for (const id of immutable
    ? controlledTickIds(s, motion, options.settings)
    : Object.keys(s.chars).sort()) {
    const shared = s.chars[id]!;
    const settings = options.settings?.[id] ?? LEGACY_SETTINGS[motion[id] ?? "static"];
    const pageRouteNeedsSync =
      (shared.route?.patrol === true && (settings.runtimeMoveType || settings.routeStopped)) ||
      (shared.route === null && shared.patrol !== null && !settings.runtimeMoveType && !settings.routeStopped);
    // Characters the branches below leave untouched stay shared: a locked
    // one, and an idle one with no route, no pause and a static page.
    if (!shared.moving) {
      if (locked.has(shared.id) && !(shared.route && !shared.route.patrol) && !pageRouteNeedsSync) continue;
      if (
        !shared.route && shared.thinkIn === 0 &&
        settings.moveType === "static" && !settings.routeStopped && !pageRouteNeedsSync
      ) continue;
    }
    const ch = ownChar(s, id);
    others?.set(id, ch);

    // A stop command lets an already-committed tile finish, then suppresses
    // the remaining forced/page route. A waiter is released exactly once.
    if (!ch.moving && settings.routeStopped && ch.route) {
      if (ch.route.waiter) finishedWaiters.push(ch.route.waiter);
      ch.route = null;
      ch.thinkIn = 0;
      continue;
    }
    if (!ch.moving && ch.route?.patrol && settings.runtimeMoveType) ch.route = null;
    if (
      !ch.moving && ch.route === null && ch.patrol !== null &&
      !settings.runtimeMoveType && !settings.routeStopped
    ) {
      ch.route = cloneRoute(ch.patrol);
    }

    const desiredCfg = routeSpeedConfig(cfg, settings, ch.route?.speed);

    // Mid-step: interpolate. Nothing interrupts a step once committed
    // (locks and page changes snap at boundaries via syncPages).
    if (ch.moving) {
      const stepCfg = activeStepConfig(ch, desiredCfg);
      const frames = stepFrames(stepCfg);
      const phase = ch.phase + 1;
      if (phase < frames) {
        const { px, py } = stepPixels(ch.tx * cfg.tile, ch.ty * cfg.tile, ch.stepDir, phase, stepCfg);
        ch.phase = phase;
        ch.px = px;
        ch.py = py;
        continue;
      }
      ch.tx += DX[ch.stepDir];
      ch.ty += DY[ch.stepDir];
      if (immutable) POSITION_REVISION.set(s, {});
      ch.px = ch.tx * cfg.tile;
      ch.py = ch.ty * cfg.tile;
      ch.phase = 0;
      ch.moving = false;
      // A pathTo/approach step whose final internal step just
      // landed finishes on THIS tick — apply the approach arrival-facing
      // and advance the route pc (releasing a waiting fiber immediately).
      if (ch.route?.plan?.done) {
        const ap = ch.route.plan.approach;
        if (ap) {
          const tc = resolveTargetCell(ap.target, player, otherChars());
          if (tc) {
            const f = facingToward(ch.tx, ch.ty, tc.x, tc.y);
            if (f !== null && canFace(settings, true)) { ch.facing = f; ch.stepDir = f; }
          }
        }
        advanceRouteStep(ch, finishedWaiters);
      } else if (ch.route && ch.route.pc >= ch.route.steps.length && !ch.route.repeat) {
        // A non-repeating route ends exactly on the landing tick, so a
        // waiting fiber resumes as soon as the NPC reaches the last tile.
        releaseRoute(ch, finishedWaiters);
      }
      continue;
    }

    if (locked.has(ch.id) && !(ch.route && !ch.route.patrol)) continue;
    if (ch.route && ch.route.waitLeft > 0) {
      ch.route.waitLeft--;
      // The tick the wait expires also takes the next command, so an
      // N-tick wait plus the following step occupies exactly N+8 ticks.
      if (ch.route.waitLeft > 0) continue;
    }

    if (ch.route) {
      stepRoute(s, ch, table, player, otherChars(), desiredCfg, settings, options, finishedWaiters);
      continue;
    }

    if (ch.thinkIn > 0) {
      ch.thinkIn--;
      if (ch.thinkIn > 0) continue; // decide on the tick the pause ends
    }
    if (settings.runtimeWander && options.modalOpen) continue;
    if (settings.moveType === "random") {
      randomStep(s, ch, table, player, otherChars(), desiredCfg, settings, options);
    } else if (settings.moveType === "approach") {
      approachStep(ch, table, player, otherChars(), desiredCfg, settings, options.settings);
    }
  }

  return finishedWaiters;
}

/** Advance one authored route step, clearing any path plan. Handles the
 *  repeat wrap / non-repeat finish exactly as the instant branches did. */
function advanceRouteStep(ch: CharState, finishedWaiters: string[]): void {
  const route = ch.route!;
  route.plan = null;
  route.pathRetriesLeft = null;
  route.pc++;
  if (route.pc >= route.steps.length && !route.repeat) releaseRoute(ch, finishedWaiters);
  else if (route.pc >= route.steps.length) route.pc = 0;
}

/** Resolve a turn/path target character to its live cell, or null. */
function resolveTargetCell(
  target: "player" | { event: string },
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
): { x: number; y: number } | null {
  if (target === "player") return { x: player.tx, y: player.ty };
  const o = others.get(target.event);
  return o ? { x: o.tx, y: o.ty } : null;
}

/** Occupancy the BFS must route around is built in stepPath from the live
 *  player/others, so it always reflects stepping-into cells. */

/** Resolve the approach target to a goal stand tile + approach record, or
 *  signal "finish now" (already on the stand cell / standing on target) /
 *  "no target" (end the route). */
function resolveApproach(
  ch: CharState,
  step: Extract<MoveStep, { approach: unknown }>,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
): { kind: "goal"; x: number; y: number; approach: PathPlan["approach"] }
  | { kind: "finish"; turn: Dir4 | null }
  | { kind: "noTarget" } {
  const target = step.approach.target;
  const tc = resolveTargetCell(target, player, others);
  if (!tc) return { kind: "noTarget" };
  let side: Dir4;
  if (step.approach.side) {
    side = DIR4[step.approach.side];
  } else {
    const resolved = approachSide(ch.tx, ch.ty, tc.x, tc.y);
    if (resolved === null) {
      // Standing on the target: turn toward it (Tuxemon already-there
      // branch) and finish the step.
      return { kind: "finish", turn: facingToward(ch.tx, ch.ty, tc.x, tc.y) };
    }
    side = resolved;
  }
  const distance = step.approach.distance ?? 1;
  const stand = approachStand(tc.x, tc.y, side, distance);
  return { kind: "goal", x: stand.x, y: stand.y, approach: { target, side, distance } };
}

/** Expand the pathTo/approach plan for the boundary tick and, when the
 *  first planned tile step is open, commit it. The BFS itself is split
 *  across reference ticks (advancePathSearch, BFS_CELLS_PER_TICK per tick)
 *  so many concurrent pathfinders stay inside the per-frame compute
 *  budget; the path is identical to a synchronous search. */
function stepPath(
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
  allSettings: Readonly<Record<string, ResolvedMoveSettings>> | undefined,
  step: Extract<MoveStep, { pathTo: unknown }> | Extract<MoveStep, { approach: unknown }>,
  finishedWaiters: string[],
): void {
  const route = ch.route!;
  const W = table.width;

  // First encounter, or a full replan after being blocked: resolve the goal
  // and START a (frame-split) BFS. Bodies are baked into the search mask at
  // this instant; a later-cleared waypoint is caught by the walk-time
  // occupant check and triggers a recompute.
  if (route.plan === null) {
    let gx: number;
    let gy: number;
    let approach: PathPlan["approach"] = null;
    if (route.pathRetriesLeft === null) {
      route.pathRetriesLeft =
        ("pathTo" in step ? step.pathTo.retries : step.approach.retries) ?? DEFAULT_PATH_RETRIES;
    }
    if ("pathTo" in step) {
      gx = step.pathTo.x;
      gy = step.pathTo.y;
    } else {
      const resolved = resolveApproach(ch, step, player, others);
      if (resolved.kind === "noTarget") { releaseRoute(ch, finishedWaiters); return; }
      if (resolved.kind === "finish") {
        if (resolved.turn !== null && canFace(settings, true)) {
          ch.facing = resolved.turn;
          ch.stepDir = resolved.turn;
        }
        advanceRouteStep(ch, finishedWaiters);
        return;
      }
      gx = resolved.x;
      gy = resolved.y;
      approach = resolved.approach;
    }

    const blocked = new Set<number>();
    if (!settings.through) {
      if (!player.through) {
        blocked.add(player.tx + player.ty * W);
        blocked.add(player.destX + player.destY * W);
      }
      for (const [id, o] of others) {
        if (id === ch.id || !o.blocks || allSettings?.[id]?.through === true) continue;
        blocked.add(o.tx + o.ty * W);
        if (o.moving) blocked.add(o.tx + DX[o.stepDir] + (o.ty + DY[o.stepDir]) * W);
      }
    }
    const search = createPathSearch(table, ch.tx, ch.ty, gx, gy, blocked, settings.through);
    if (search === null) {
      releaseRoute(ch, finishedWaiters);
      return;
    }
    route.plan = {
      search, dirs: [], blockedTicks: 0, done: false, approach,
    };
  }

  const plan = route.plan!;

  // Drive the frame-split BFS one slice per boundary tick until it finishes.
  if (plan.search) {
    const res = advancePathSearch(plan.search, table, BFS_CELLS_PER_TICK);
    if (!res.done) return; // still computing; no walk this tick
    plan.search = null;
    if (res.path === null) {
      // Unreachable right now: fall into the blocked-retry wait below.
      plan.dirs = [];
      plan.blockedTicks = 1;
    } else if (res.path.length === 0) {
      // Goal is the current cell: an approach finishes with a turn; a bare
      // pathTo simply completes.
      if (plan.approach) {
        const tc = resolveTargetCell(plan.approach.target, player, others);
        if (tc) {
          const f = facingToward(ch.tx, ch.ty, tc.x, tc.y);
          if (f !== null && canFace(settings, true)) { ch.facing = f; ch.stepDir = f; }
        }
      }
      advanceRouteStep(ch, finishedWaiters);
      return;
    } else {
      plan.dirs = res.path;
      plan.blockedTicks = 0;
    }
  }

  if (plan.done) return; // the landing tick advances the pc (moving branch)
  const dir = plan.dirs[0];
  if (dir === undefined) {
    // Goal unreachable / next step blocked: wait a replan interval, then
    // recompute from the live cell against live bodies.
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return;
    if (route.pathRetriesLeft! <= 0) {
      // The way never cleared: Tuxemon stops the blocking action here.
      releaseRoute(ch, finishedWaiters);
      return;
    }
    route.pathRetriesLeft = route.pathRetriesLeft! - 1;
    route.plan = null; // re-expand (new BFS) next boundary tick
    return;
  }
  const tx = ch.tx + DX[dir];
  const ty = ch.ty + DY[dir];
  if (occupantBlocks(ch, tx, ty, dir, table, player, others, settings, allSettings)) {
    noteContact(ch, tx, ty, dir, table, player, settings.through);
    if (canFace(settings, false)) ch.facing = dir;
    ch.stepDir = dir;
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return; // wait, keep the plan
    if (route.pathRetriesLeft! <= 0) {
      releaseRoute(ch, finishedWaiters);
      return;
    }
    route.pathRetriesLeft = route.pathRetriesLeft! - 1;
    route.plan = null; // recompute against live bodies next boundary tick
    return;
  }
  // Commit the next planned tile step; the SAME authored route step stays
  // current until the whole plan is consumed.
  commitStep(ch, dir, cfg, settings);
  plan.dirs.shift();
  if (plan.dirs.length === 0) {
    // Last internal step is now interpolating; the landing boundary tick
    // sees plan.done, applies the approach arrival-facing and advances pc.
    plan.done = true;
    plan.blockedTicks = 0;
  }
}

/** Consume exactly ONE route command on this boundary tick (MV advances
 *  its move list at most once per stop tick). */
function stepRoute(
  s: CharsState,
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
  options: CharStepOptions,
  finishedWaiters: string[],
): void {
  const route = ch.route!;
  const step: MoveStep | undefined = route.steps[route.pc];
  if (step === undefined) {
    releaseRoute(ch, finishedWaiters);
    return;
  }

  // Path steps carry expansion state across boundary ticks.
  if (typeof step === "object") {
    if ("pathTo" in step || "approach" in step) {
      // The final internal step lands in the moving branch (plan.done);
      // here we only expand/walk the plan at a boundary.
      stepPath(ch, table, player, others, cfg, settings, options.settings, step, finishedWaiters);
      return;
    }
    if ("control" in step) {
      if (step.control.kind === "routeSpeed") {
        // A route step scopes the grade to THIS route: latch it directly
        // instead of writing the persistent override.
        route.speed = step.control.value;
        advanceRouteStep(ch, finishedWaiters);
        return;
      }
      if (step.control.kind === "stop") {
        options.applyControl?.(ch.id, step.control);
        releaseRoute(ch, finishedWaiters);
        return;
      }
      options.applyControl?.(ch.id, step.control);
      advanceRouteStep(ch, finishedWaiters);
      return;
    }
    if ("turnToward" in step) {
      const tc = resolveTargetCell(
        step.turnToward === "player" ? "player" : step.turnToward,
        player,
        others,
      );
      if (tc) {
        const f = facingToward(ch.tx, ch.ty, tc.x, tc.y);
        if (f !== null && canFace(settings, true)) { ch.facing = f; ch.stepDir = f; }
      }
      advanceRouteStep(ch, finishedWaiters);
      return;
    }
    // Unknown object step: skip defensively.
    advanceRouteStep(ch, finishedWaiters);
    return;
  }

  if (step === "turnTowardPlayer") {
    const f = facingToward(ch.tx, ch.ty, player.tx, player.ty);
    if (f !== null && canFace(settings, true)) { ch.facing = f; ch.stepDir = f; }
    advanceRouteStep(ch, finishedWaiters);
    return;
  }

  const faceDir = FACE[step];
  if (faceDir !== undefined) {
    if (canFace(settings, true)) {
      ch.facing = faceDir;
      ch.stepDir = faceDir;
    }
    route.pc++;
    if (route.pc >= route.steps.length && !route.repeat) releaseRoute(ch, finishedWaiters);
    else if (route.pc >= route.steps.length) route.pc = 0;
    return;
  }
  if (step === "turnRandom") {
    const r = randInt(s.rng, 0, 3);
    s.rng = r.next;
    if (canFace(settings, true)) {
      ch.facing = r.value as Dir4;
      ch.stepDir = ch.facing;
    }
    route.pc++;
    if (route.pc >= route.steps.length && !route.repeat) releaseRoute(ch, finishedWaiters);
    else if (route.pc >= route.steps.length) route.pc = 0;
    return;
  }
  if (step === "wait") {
    route.waitLeft = stepFrames(cfg);
    route.pc++;
    if (route.pc >= route.steps.length && route.repeat) route.pc = 0;
    // Non-repeat: pc stays at length; when the wait expires the next call
    // hits the undefined branch above and releases the waiter.
    return;
  }

  const dir = step === "stepForward" ? ch.facing : MOVE[step];
  if (dir === undefined) {
    route.pc++;
    return;
  }
  const tx = ch.tx + DX[dir];
  const ty = ch.ty + DY[dir];
  if (occupantBlocks(ch, tx, ty, dir, table, player, others, settings, options.settings)) {
    noteContact(ch, tx, ty, dir, table, player, settings.through);
    if (canFace(settings, false)) ch.facing = dir;
    ch.stepDir = dir;
    if (route.skippable) releaseRoute(ch, finishedWaiters);
    return; // retry on the next boundary tick
  }
  commitStep(ch, dir, cfg, settings);
  route.pc++;
  if (route.pc >= route.steps.length && route.repeat) route.pc = 0;
}

function randomStep(
  s: CharsState,
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
  options: CharStepOptions,
): void {
  const delay = frequencyDelay(settings.frequency);
  if (settings.runtimeWander) {
    // Tuxemon chooses uniformly from the currently valid exits. It neither
    // consumes RNG nor invents an idle result when no exit exists.
    const exits: Dir4[] = [];
    for (const dir of [0, 1, 2, 3] as const) {
      const tx = ch.tx + DX[dir];
      const ty = ch.ty + DY[dir];
      if (!inWanderBounds(settings.bounds, tx, ty)) continue;
      if (!occupantBlocks(ch, tx, ty, dir, table, player, others, settings, options.settings)) {
        exits.push(dir);
      }
    }
    ch.thinkIn = delay;
    if (exits.length === 0) return;
    const cursor = options.runtimeRng ?? s;
    const r = randInt(cursor.rng, 0, exits.length - 1);
    cursor.rng = r.next;
    commitStep(ch, exits[r.value]!, cfg, settings);
    return;
  }

  const r = randInt(s.rng, 0, 4);
  s.rng = r.next;
  if (r.value === 4) {
    ch.thinkIn = Math.max(IDLE_BEATS, delay); // one-in-five amble pauses
    return;
  }
  const dir = r.value as Dir4;
  if (canFace(settings, false)) ch.facing = dir;
  ch.stepDir = dir;
  const tx = ch.tx + DX[dir];
  const ty = ch.ty + DY[dir];
  if (!occupantBlocks(ch, tx, ty, dir, table, player, others, settings, options.settings)) {
    commitStep(ch, dir, cfg, settings);
    ch.thinkIn = delay;
    // The 8-tick step is its own pacing; no extra think delay on a move.
    return;
  }
  noteContact(ch, tx, ty, dir, table, player, settings.through);
  ch.thinkIn = Math.max(THINK_BEATS, delay); // blocked: re-roll later
}

function approachStep(
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
  allSettings?: Readonly<Record<string, ResolvedMoveSettings>>,
): void {
  const dx = player.tx - ch.tx;
  const dy = player.ty - ch.ty;
  if (dx === 0 && dy === 0) return;
  if (Math.abs(dx) + Math.abs(dy) > APPROACH_SIGHT) return;
  // Larger gap first; ties go vertical, matching the mover's d-pad priority.
  const order: Dir4[] = Math.abs(dy) >= Math.abs(dx)
    ? [dy > 0 ? 0 : 2, dx > 0 ? 3 : 1]
    : [dx > 0 ? 3 : 1, dy > 0 ? 0 : 2];
  for (const dir of order) {
    const tx = ch.tx + DX[dir];
    const ty = ch.ty + DY[dir];
    if (!occupantBlocks(ch, tx, ty, dir, table, player, others, settings, allSettings)) {
      commitStep(ch, dir, cfg, settings); // chained approach steps at the step cadence
      ch.thinkIn = frequencyDelay(settings.frequency);
      return;
    }
    // MV moveTowardCharacter: each refused attempt checks Event Touch.
    noteContact(ch, tx, ty, dir, table, player, settings.through);
  }
  if (order[0] !== undefined) {
    if (canFace(settings, false)) ch.facing = order[0];
    ch.stepDir = order[0];
  }
  ch.thinkIn = Math.max(THINK_BEATS, frequencyDelay(settings.frequency));
}

/** Pre-KM1 character fold used when the compiled world has no page movement
 * defaults and no route control steps. This deliberately keeps the original
 * loop separate: the common case performs no settings lookup, allocation, or
 * control-specific branch for each character. */
export function stepCharsInPlaceLegacy(
  s: CharsState,
  table: PassageTable,
  player: PlayerPlace,
  cfg: MovementConfig,
  locked: ReadonlySet<string>,
  motion: Readonly<Record<string, MotionType>>,
  immutable = false,
): string[] {
  const frames = stepFrames(cfg);
  const finishedWaiters: string[] = [];
  let others: Map<string, CharState> | undefined;
  const otherChars = () => others ??= new Map(Object.entries(s.chars));

  for (const id of immutable ? legacyTickIds(s, motion) : Object.keys(s.chars).sort()) {
    const shared = s.chars[id]!;
    if (!shared.moving) {
      if (locked.has(shared.id) && !(shared.route && !shared.route.patrol)) continue;
      if (!shared.route && shared.thinkIn === 0 && (motion[id] ?? "static") === "static") continue;
    }
    const ch = ownChar(s, id);
    others?.set(id, ch);

    if (ch.moving) {
      const phase = ch.phase + 1;
      if (phase < frames) {
        const { px, py } = stepPixels(ch.tx * cfg.tile, ch.ty * cfg.tile, ch.stepDir, phase, cfg);
        ch.phase = phase;
        ch.px = px;
        ch.py = py;
        continue;
      }
      ch.tx += DX[ch.stepDir];
      ch.ty += DY[ch.stepDir];
      if (immutable) POSITION_REVISION.set(s, {});
      ch.px = ch.tx * cfg.tile;
      ch.py = ch.ty * cfg.tile;
      ch.phase = 0;
      ch.moving = false;
      if (ch.route?.plan?.done) {
        const ap = ch.route.plan.approach;
        if (ap) {
          const tc = resolveTargetCell(ap.target, player, otherChars());
          if (tc) {
            const f = facingToward(ch.tx, ch.ty, tc.x, tc.y);
            if (f !== null) { ch.facing = f; ch.stepDir = f; }
          }
        }
        advanceRouteStep(ch, finishedWaiters);
      } else if (ch.route && ch.route.pc >= ch.route.steps.length && !ch.route.repeat) {
        releaseRoute(ch, finishedWaiters);
      }
      continue;
    }

    if (locked.has(ch.id) && !(ch.route && !ch.route.patrol)) continue;
    if (ch.route && ch.route.waitLeft > 0) {
      ch.route.waitLeft--;
      if (ch.route.waitLeft > 0) continue;
    }
    if (ch.route) {
      stepRouteLegacy(s, ch, table, player, otherChars(), cfg, finishedWaiters);
      continue;
    }
    if (ch.thinkIn > 0) {
      ch.thinkIn--;
      if (ch.thinkIn > 0) continue;
    }
    const kind = motion[id] ?? "static";
    if (kind === "random") randomStepLegacy(s, ch, table, player, otherChars(), cfg);
    else if (kind === "approach") approachStepLegacy(ch, table, player, otherChars(), cfg);
  }
  return finishedWaiters;
}

function occupantBlocksLegacy(
  ch: CharState,
  tx: number,
  ty: number,
  exit: Dir4,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
): boolean {
  if (!canStepFrom(table, ch.tx, ch.ty, exit)) return true;
  if (tx === player.tx && ty === player.ty) return true;
  if (tx === player.destX && ty === player.destY) return true;
  for (const [id, other] of others) {
    if (id === ch.id || !other.blocks) continue;
    if (tx === other.tx && ty === other.ty) return true;
    if (other.moving && tx === other.tx + DX[other.stepDir] && ty === other.ty + DY[other.stepDir]) return true;
  }
  return false;
}

function commitStepLegacy(ch: CharState, dir: Dir4, cfg: MovementConfig): void {
  ch.facing = dir;
  ch.stepDir = dir;
  ch.moving = true;
  ch.phase = 1;
  const { px, py } = stepPixels(ch.tx * cfg.tile, ch.ty * cfg.tile, dir, 1, cfg);
  ch.px = px;
  ch.py = py;
}

function stepRouteLegacy(
  s: CharsState,
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
  finishedWaiters: string[],
): void {
  const route = ch.route!;
  const step: MoveStep | undefined = route.steps[route.pc];
  if (step === undefined) {
    releaseRoute(ch, finishedWaiters);
    return;
  }
  if (typeof step === "object") {
    if ("pathTo" in step || "approach" in step) {
      stepPath(ch, table, player, others, cfg, LEGACY_SETTINGS.static, undefined, step, finishedWaiters);
      return;
    }
    if ("turnToward" in step) {
      const tc = resolveTargetCell(step.turnToward === "player" ? "player" : step.turnToward, player, others);
      if (tc) {
        const f = facingToward(ch.tx, ch.ty, tc.x, tc.y);
        if (f !== null) { ch.facing = f; ch.stepDir = f; }
      }
      advanceRouteStep(ch, finishedWaiters);
      return;
    }
    advanceRouteStep(ch, finishedWaiters);
    return;
  }
  if (step === "turnTowardPlayer") {
    const f = facingToward(ch.tx, ch.ty, player.tx, player.ty);
    if (f !== null) { ch.facing = f; ch.stepDir = f; }
    advanceRouteStep(ch, finishedWaiters);
    return;
  }
  const faceDir = FACE[step];
  if (faceDir !== undefined) {
    ch.facing = faceDir;
    ch.stepDir = faceDir;
    route.pc++;
    if (route.pc >= route.steps.length && !route.repeat) releaseRoute(ch, finishedWaiters);
    else if (route.pc >= route.steps.length) route.pc = 0;
    return;
  }
  if (step === "turnRandom") {
    const random = randInt(s.rng, 0, 3);
    s.rng = random.next;
    ch.facing = random.value as Dir4;
    ch.stepDir = ch.facing;
    route.pc++;
    if (route.pc >= route.steps.length && !route.repeat) releaseRoute(ch, finishedWaiters);
    else if (route.pc >= route.steps.length) route.pc = 0;
    return;
  }
  if (step === "wait") {
    route.waitLeft = stepFrames(cfg);
    route.pc++;
    if (route.pc >= route.steps.length && route.repeat) route.pc = 0;
    return;
  }
  const dir = step === "stepForward" ? ch.facing : MOVE[step];
  if (dir === undefined) {
    route.pc++;
    return;
  }
  const tx = ch.tx + DX[dir];
  const ty = ch.ty + DY[dir];
  if (occupantBlocksLegacy(ch, tx, ty, dir, table, player, others)) {
    noteContact(ch, tx, ty, dir, table, player, false);
    ch.facing = dir;
    ch.stepDir = dir;
    if (route.skippable) releaseRoute(ch, finishedWaiters);
    return;
  }
  commitStepLegacy(ch, dir, cfg);
  route.pc++;
  if (route.pc >= route.steps.length && route.repeat) route.pc = 0;
}

function randomStepLegacy(
  s: CharsState,
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
): void {
  const random = randInt(s.rng, 0, 4);
  s.rng = random.next;
  if (random.value === 4) {
    ch.thinkIn = IDLE_BEATS;
    return;
  }
  const dir = random.value as Dir4;
  ch.facing = dir;
  ch.stepDir = dir;
  const tx = ch.tx + DX[dir];
  const ty = ch.ty + DY[dir];
  if (!occupantBlocksLegacy(ch, tx, ty, dir, table, player, others)) {
    commitStepLegacy(ch, dir, cfg);
    return;
  }
  noteContact(ch, tx, ty, dir, table, player, false);
  ch.thinkIn = THINK_BEATS;
}

function approachStepLegacy(
  ch: CharState,
  table: PassageTable,
  player: PlayerPlace,
  others: ReadonlyMap<string, CharState>,
  cfg: MovementConfig,
): void {
  const dx = player.tx - ch.tx;
  const dy = player.ty - ch.ty;
  if (dx === 0 && dy === 0) return;
  if (Math.abs(dx) + Math.abs(dy) > APPROACH_SIGHT) return;
  const order: Dir4[] = Math.abs(dy) >= Math.abs(dx)
    ? [dy > 0 ? 0 : 2, dx > 0 ? 3 : 1]
    : [dx > 0 ? 3 : 1, dy > 0 ? 0 : 2];
  for (const dir of order) {
    const tx = ch.tx + DX[dir];
    const ty = ch.ty + DY[dir];
    if (!occupantBlocksLegacy(ch, tx, ty, dir, table, player, others)) {
      commitStepLegacy(ch, dir, cfg);
      return;
    }
    noteContact(ch, tx, ty, dir, table, player, false);
  }
  if (order[0] !== undefined) {
    ch.facing = order[0];
    ch.stepDir = order[0];
  }
  ch.thinkIn = THINK_BEATS;
}

/** Resolve a character's current cell (authored position if it has no
 *  CharState yet). Used by the session to build interpreter eventCells. */
export function charCell(s: CharsState, ev: GameEvent): { x: number; y: number } {
  const ch = s.chars[ev.id];
  return ch ? { x: ch.tx, y: ch.ty } : { x: ev.x, y: ev.y };
}
