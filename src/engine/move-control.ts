// src/engine/move-control.ts — durable, page-scoped runtime movement knobs.
//
// Project pages supply defaults. Commands and route control steps write an
// override for the current map visit; an event override is tagged with the
// active page index so page refresh discards it instead of reviving stale
// settings when an older page later becomes active again. The interpreter
// owns this plain-data state, which makes save/load and rewind automatic.

import { keyedRecord } from "./clone.ts";
import { MOTION_HZ } from "./motion-clock.ts";
import { stepFrames, type MovementConfig } from "./movement.ts";
import type {
  FacingMode,
  MoveControl,
  MoveFrequency,
  MoveSpeed,
  Page,
  WanderBounds,
} from "./types.ts";

export const DEFAULT_MOVE_SPEED: MoveSpeed = 5;
export const DEFAULT_MOVE_FREQUENCY: MoveFrequency = 5;

export interface MoveOverride {
  moveType?: "static" | "random" | "approach";
  bounds?: WanderBounds;
  speed?: MoveSpeed;
  frequency?: MoveFrequency;
  /** Exact attempt interval for command-started wander. Absent keeps the
   *  MV frequency-grade cadence. */
  wanderIntervalTicks?: number;
  running?: boolean;
  directionFix?: boolean;
  through?: boolean;
  facingMode?: FacingMode;
  /** A stop control suppresses the page patrol until a new forced route,
   *  a motion control, or a page refresh explicitly resumes movement. */
  routeStopped?: boolean;
  /** Player/runtime-wander decision cooldown in 60 Hz reference ticks. */
  cooldown?: number;
  /** A speed grade pending for the actor's NEXT forced route. It is moved
   *  onto that route when it installs (or latched onto a route already
   *  running), and deleted on consumption, so it never outlives the route
   *  it was meant for. */
  routeSpeed?: MoveSpeed;
  /** Exact velocity paired with routeSpeed. It is pending for the same next
   *  forced route and consumed/deleted with the grade. */
  routeTilesPerSecond?: number;
}

export interface EventMoveOverride extends MoveOverride {
  pageIndex: number;
}

export interface MoveControlState {
  player: MoveOverride;
  events: Record<string, EventMoveOverride>;
}

export interface ResolvedMoveSettings {
  moveType: "static" | "random" | "approach";
  bounds: WanderBounds | null;
  speed: MoveSpeed;
  frequency: MoveFrequency;
  wanderIntervalTicks: number | null;
  running: boolean;
  directionFix: boolean;
  through: boolean;
  facingMode: FacingMode;
  routeStopped: boolean;
  /** Any runtime motion choice overrides the page patrol as well as the
   *  page moveType until `moveType:page` or a page refresh. */
  runtimeMoveType: boolean;
  /** True only when a command, rather than an authored page, selected
   *  random wandering. Runtime wander pauses for global dialog state and
   *  consumes the saveable project RNG; legacy page random remains exact. */
  runtimeWander: boolean;
  /** Sparse speed waiting for the next forced route, also visible to a
   *  command-started wander so its first committed tile matches Tuxemon's
   *  custom moverate-before-wander sequence. */
  pendingRouteSpeed?: MoveSpeed;
  /** Exact authored rate paired with pendingRouteSpeed. */
  pendingRouteTilesPerSecond?: number;
}

/** Shared immutable defaults for paths without an active movement override.
 * Callers must treat this as read-only. Keeping it shared avoids rebuilding
 * the same eleven-field object for every character on every reference tick. */
export const DEFAULT_MOVE_SETTINGS: Readonly<ResolvedMoveSettings> = Object.freeze({
  moveType: "static",
  bounds: null,
  speed: DEFAULT_MOVE_SPEED,
  frequency: DEFAULT_MOVE_FREQUENCY,
  wanderIntervalTicks: null,
  running: false,
  directionFix: false,
  through: false,
  facingMode: "followMovement",
  routeStopped: false,
  runtimeMoveType: false,
  runtimeWander: false,
});

export function createMoveControlState(): MoveControlState {
  return { player: {}, events: keyedRecord() };
}

function cloneBounds(bounds: WanderBounds | undefined): WanderBounds | undefined {
  return bounds ? { ...bounds } : undefined;
}

export function cloneMoveControlState(state: MoveControlState): MoveControlState {
  const events = keyedRecord<EventMoveOverride>();
  for (const id of Object.keys(state.events)) {
    const value = state.events[id]!;
    events[id] = { ...value, bounds: cloneBounds(value.bounds) };
  }
  return {
    player: { ...state.player, bounds: cloneBounds(state.player.bounds) },
    events,
  };
}

/** Mutate an owned override with one authored control. */
export function applyMoveControl(override: MoveOverride, control: MoveControl): void {
  switch (control.kind) {
    case "wander":
      override.moveType = "random";
      override.bounds = cloneBounds(control.bounds);
      if (control.frequency !== undefined) override.frequency = control.frequency;
      if (control.intervalTicks === undefined) delete override.wanderIntervalTicks;
      else override.wanderIntervalTicks = control.intervalTicks;
      override.routeStopped = false;
      override.cooldown = 0;
      return;
    case "moveType":
      if (control.value === "page") delete override.moveType;
      else override.moveType = control.value;
      delete override.bounds;
      delete override.wanderIntervalTicks;
      override.routeStopped = false;
      override.cooldown = 0;
      return;
    case "stop":
      override.routeStopped = true;
      override.cooldown = 0;
      return;
    case "speed":
      override.speed = control.value;
      return;
    case "routeSpeed":
      override.routeSpeed = control.value;
      if (control.tilesPerSecond === undefined) delete override.routeTilesPerSecond;
      else override.routeTilesPerSecond = control.tilesPerSecond;
      return;
    case "run":
      override.running = control.value;
      return;
    case "frequency":
      override.frequency = control.value;
      delete override.wanderIntervalTicks;
      override.cooldown = 0;
      return;
    case "directionFix":
      override.directionFix = control.value;
      return;
    case "through":
      override.through = control.value;
      return;
    case "facingMode":
      override.facingMode = control.value;
      return;
  }
}

export function resumeMoveRoute(override: MoveOverride): void {
  override.routeStopped = false;
}

/** Merge a page's defaults with a matching runtime override. */
export function resolveMoveSettings(
  page: Page | null,
  override: MoveOverride | undefined,
): ResolvedMoveSettings {
  return {
    moveType: override?.moveType ?? page?.moveType ?? "static",
    bounds: override?.bounds ? { ...override.bounds } : null,
    speed: override?.speed ?? page?.moveSpeed ?? DEFAULT_MOVE_SPEED,
    frequency: override?.frequency ?? page?.moveFrequency ?? DEFAULT_MOVE_FREQUENCY,
    wanderIntervalTicks: override?.wanderIntervalTicks ?? null,
    running: override?.running === true,
    directionFix: override?.directionFix ?? page?.directionFix ?? false,
    through: override?.through ?? page?.through ?? false,
    facingMode: override?.facingMode ?? page?.facingMode ?? "followMovement",
    routeStopped: override?.routeStopped === true,
    runtimeMoveType: override?.moveType !== undefined,
    runtimeWander: override?.moveType === "random",
    ...(override?.routeSpeed !== undefined ? { pendingRouteSpeed: override.routeSpeed } : {}),
    ...(override?.routeTilesPerSecond !== undefined
      ? { pendingRouteTilesPerSecond: override.routeTilesPerSecond }
      : {}),
  };
}

/** Convert MV's exponential speed level relative to this session's authored
 *  movement config. Level 5 preserves the pre-KM1 config exactly (normally
 *  8 ticks/tile, but custom runtimes may deliberately use another base);
 *  run adds one level, with one reference tick as the speed ceiling. */
export function movementConfigFor(
  base: MovementConfig,
  settings: Pick<ResolvedMoveSettings, "speed" | "running">,
): MovementConfig {
  const level = Math.min(6, settings.speed + (settings.running ? 1 : 0));
  if (level === DEFAULT_MOVE_SPEED) return base;
  const frames = Math.max(1, Math.round(stepFrames(base) * (2 ** (DEFAULT_MOVE_SPEED - level))));
  return { tile: base.tile, speed: base.tile / frames };
}

/** Convert an exact tiles/second authoring rate to the fixed 60 Hz motion
 * clock. Fractional pixels are retained between ticks; the crossing tick
 * snaps onto the target tile just as a continuously integrated source mover
 * does when it completes a waypoint. */
export function movementConfigForTilesPerSecond(
  base: MovementConfig,
  tilesPerSecond: number,
): MovementConfig {
  return { tile: base.tile, speed: base.tile * tilesPerSecond / MOTION_HZ };
}

/** MV autonomous stop threshold, expressed in fixed 60 Hz reference ticks. */
export function frequencyDelay(frequency: MoveFrequency): number {
  return 30 * (5 - frequency);
}

/** Command-started wander may carry a source-exact attempt interval. */
export function wanderDelay(
  settings: Pick<ResolvedMoveSettings, "frequency" | "wanderIntervalTicks">,
): number {
  return settings.wanderIntervalTicks ?? frequencyDelay(settings.frequency);
}

/** Movement-driven facing obeys both the MV direction-fix bit and
 *  Tuxemon's facing mode. Explicit route turns only obey directionFix:
 *  Tuxemon locked/scripted still allow char_face. */
export function canFace(settings: ResolvedMoveSettings, explicit: boolean): boolean {
  return !settings.directionFix && (explicit || settings.facingMode === "followMovement");
}

/** Through bypasses passage/body rules, never the finite map rectangle. */
export function inMapBounds(
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Bounds are inclusive after converting x/y/width/height to far edges. */
export function inWanderBounds(bounds: WanderBounds | null, x: number, y: number): boolean {
  return bounds === null || (
    x >= bounds.x && y >= bounds.y &&
    x < bounds.x + bounds.width && y < bounds.y + bounds.height
  );
}
