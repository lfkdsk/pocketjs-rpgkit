// src/engine/session.ts — P1④ multi-map session.
//
// One pure fold over the whole project on the fixed MOTION_HZ reference
// (motion-clock.ts, 60 ticks per virtual second):
//
//   mover (movement.ts) ─▶ characters (chars.ts) ─▶ interpreter
//
// stepSession is called once per HOST virtual frame but advances
// MOTION_HZ/simulationHz reference ticks per call (two at 30 Hz, three at
// 20 Hz, fifteen at 4 Hz). Motion, waits, the typewriter and fades are then
// functions of virtual time and agree at every host rate. Input edges are
// one host frame wide and reach only the first reference tick of a batch.
//
// plus the two P1④ mechanics:
//
//   transfer    — swap the current map. Matches MV map-load semantics:
//                 the map interpreter is rebuilt fresh and every map
//                 character returns to its authored cell, while the
//                 project values (switches, items, variables, gold, RNG
//                 cursor) survive. Same-map transfers reset the same way;
//                 the parking fiber ends at the transfer (every authored
//                 transfer is the terminal command of its page). With
//                 fade>0 the swap happens behind a black overlay:
//                 fade-out half, swap on the first fully-black reference
//                 tick, fade-in half.
//   moveRoute   — a command-published route installs on its character
//                 (chars.ts). A wait:true fiber parks in the interpreter's
//                 "external" mode until the route lands, then the session
//                 resumes it with continueExternal. Page switches abort
//                 the route and resume the waiter on the same tick.
//
// No host imports, no wall clock, no Math.random (docs/SIMULATION.md).

import { deepClone, keyedRecord } from "./clone.ts";
import {
  canAutosaveSessionSnapshot,
  createAutosaveSessionSnapshot,
  type SaveSnapshot,
} from "./save.ts";
import { beginStateMetadata, endStateMetadata, RecentStateMetadata } from "./state-metadata.ts";
import { startupProfileMark } from "../startup-profile.ts";
import { cloneAudioState, type AudioState } from "./audio.ts";

import {
  activeIndexAt,
  activePage,
  advanceTimer,
  advanceInterpAudioInPlace,
  clearStaleEventAppearances,
  clampFiniteVar,
  continueBattle,
  continueExternal,
  createInterpState,
  eventPageAt,
  beginWorld,
  createWorld,
  stepWorld,
  type WorldBuild,
  effectiveEventAppearance,
  fiberIsExternal,
  isBusy,
  isWorldIdle,
  keyedEventsOf,
  messageHoldsPlayer,
  ownRecord,
  recordRevision,
  pruneStaleQueuedRequests,
  randInt,
  replaceItemCounts,
  rngNext,
  runExtensionHookInPlace,
  secondsToFrames,
  shareInterp,
  stepInterpWithExtensionsInPlace,
  timerSeconds,
  type ExtensionScope,
  type ConditionContext,
  type EventPageAppearance,
  type InterpInput,
  type Instr,
  type InterpState,
  type MapAnimInstance,
  type HostAction,
  type SoundCue,
  type PendingBattle,
  type PendingMoveOperation,
  type PendingPlacement,
  type PendingScene,
  type PendingTransfer,
  type SwitchState,
  type WorldIdleBlockers,
  type TextPaginator,
  type TextTokenResolver,
  type WorldOptions,
  type World,
  continueScene,
} from "./interpreter.ts";
import {
  assertImmutableJsonValue,
  assertJsonValue,
  cloneExtension,
  createExtensionRuntime,
  extensionConditionCacheKey,
  extensionCallNameValid,
  type ExtensionOptions,
  type ExtensionRuntime,
} from "./extensions.ts";
import {
  cloneScene,
  type BattleInput,
  type BattleRules,
  type SceneSlot,
} from "./battle.ts";
import type { SceneInput, SceneRules } from "./scene.ts";
import {
  charBlocksPlayer,
  charsPageRevision,
  charsPositionRevision,
  createChars,
  installRoute,
  latchRouteSpeed,
  placeChar,
  resetCharThinkInPlace,
  routeSpeedConfig,
  shareChars,
  stopCharRoute,
  stepCharsInPlace,
  stepCharsInPlaceLegacy,
  syncPagesInPlace,
  BFS_CELLS_PER_TICK,
  DEFAULT_PATH_RETRIES,
  PATH_REPLAN_TICKS,
  type CharsState,
  type MotionType,
  type PathPlan,
} from "./chars.ts";
import {
  approachSide,
  approachStand,
  advancePathSearch,
  clonePathSearch,
  createPathSearch,
  facingToward,
} from "./pathfind.ts";
import {
  activeStepConfig,
  dirFromButtons,
  initialMovement,
  stepFrames,
  stepMovement,
  stepMovementLegacy,
  stepPixels,
  walkPose,
  type MovementConfig,
  type MovementState,
  type WalkPose,
} from "./movement.ts";
import {
  applyMoveControl,
  canFace,
  createMoveControlState,
  DEFAULT_MOVE_SETTINGS,
  wanderDelay,
  inMapBounds,
  inWanderBounds,
  movementConfigFor,
  resolveMoveSettings,
  resumeMoveRoute,
  type EventMoveOverride,
  type MoveOverride,
  type MoveControlState,
  type ResolvedMoveSettings,
} from "./move-control.ts";
import { MOTION_HZ, motionTicksPerFrame } from "./motion-clock.ts";
import {
  advanceScreenEffects,
  screenEffectsAfterTransfer,
  startMapNameBanner,
} from "./screen.ts";
import { BTN_BITS } from "./camera.ts";
import type { Dir4, PassageTable } from "./passability.ts";
import {
  buildPassage,
  canEnter,
  canEnterIgnoringTerrainSolid,
  canStepFrom,
  cellBlocksExit,
  stampBlockedCells,
  withTilePropertyOverrides,
} from "./passability.ts";
import type { WorldHandoffResolver } from "./world-handoff-contract.ts";
import {
  MAP_SCHEMA_HASH,
  describeMapSchemaRefusal,
  isCompatibleMapSchemaHash,
  isProjectShell,
  resolveMapManifestHash,
  validateMapIndex,
  type MapContentIdentity,
  type MapContentVersion,
} from "./map-repository.ts";
import type {
  CommonEvent,
  Dir,
  Facing,
  GameEvent,
  MapDef,
  MapIndexEntry,
  MapRepository,
  MoveControl,
  MoveSpeed,
  MoveStep,
  ProjectSource,
  Command,
  Condition,
  JsonValue,
  Sheet,
  WorldTraversalMode,
} from "./types.ts";

const DX = [0, -1, 0, 1] as const;
const DY = [1, 0, -1, 0] as const;
const OPPOSITE_DIR: readonly Facing[] = [2, 3, 0, 1];
const DIR_INDEX: Record<Dir, Facing> = { down: 0, left: 1, up: 2, right: 3 };

export interface FadeState {
  phase: "out" | "in";
  /** Frames until the next fade boundary (swap at end of out; clear at
   *  end of in). */
  left: number;
  /** Frames for one half-ramp. */
  half: number;
}

/** A forced move route running on the player (a `moveRoute` targeting the
 *  player). Saved with the map runtime so a restored route resumes. */
export interface PlayerRoute {
  steps: readonly MoveStep[];
  pc: number;
  repeat: boolean;
  skippable: boolean;
  waiter: string | null;
  /** 0 idle at boundary; 1..stepFrames while stepping; negative counts a
   *  pending wait (-ticks..-1), all in MOTION_HZ reference ticks. */
  phase: number;
  dir: Dir4;
  /** The route installed while the mover was mid-step. It takes over on
   *  the next reference tick: the inherited interpolation snaps back to its
   *  origin boundary before the first route command, so a command face
   *  cannot redirect the committed step into an unchecked cell. */
  takeOver: boolean;
  /** Expansion state for the current pathTo/approach step. */
  plan: PathPlan | null;
  /** Remaining replans for the current path step; survives plan rebuilds. */
  pathRetriesLeft: number | null;
  /** A speed grade latched for this route only (routeSpeed control);
   *  absent = the player's resolved speed. Dies with the route. */
  speed?: MoveSpeed;
  /** Optional exact fixed-clock velocity paired with speed. */
  tilesPerSecond?: number;
}

/** One source-owned tile crossing. It exists only between a proven opening's
 * transfer tick and the atomic target-map entry; final state returns to the
 * ordinary map-local representation. */
export interface SeamlessHandoffState {
  mode: "seamless-v1";
  portalId: string;
  sourceMapId: string;
  targetMapId: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  direction: Facing;
  phase: number;
  totalTicks: number;
}

/** One character of the map the player just left through a seamless
 * handoff, exactly as the active-map actor pool painted it on the commit
 * tick. Presentation only: it never collides, interacts or runs. */
export interface LeftMapActor {
  eventId: string;
  /** Pixels in the left map's own local space (CharState.px/py). */
  px: number;
  py: number;
  facing: Facing;
  pose: WalkPose;
  /** Effective appearance sprite key (page sprite or appearance override). */
  sprite: string;
  /** 0..255. */
  opacity: number;
}

/** Frozen display snapshot of the map left by the latest seamless handoff,
 * so its characters stay where they were instead of snapping back to their
 * map-entry cells. Immutable once created; at most one exists. */
export interface LeftMapSnapshot {
  mapId: string;
  /** The left map's top-left tile in the active map's tile space. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Painted characters in authored event order. */
  actors: readonly LeftMapActor[];
}

/** How far (Chebyshev distance in tiles from the player's tile to the left
 * map's rectangle) the player may move before the frozen snapshot of the
 * map just left is dropped. A fixed reducer constant, so the drop happens on
 * the same reference tick at every rate, viewport and after any load. It
 * covers the visible ring of a 960×544 viewport with up to 3 tiles of
 * stream margin even when the camera is clamped against a world edge, so
 * the switch back to the map-entry preview happens off screen. */
export const LEFT_MAP_RING_TILES = 64;

export interface SessionState {
  frame: number;
  mapId: string;
  sw: SwitchState;
  move: MovementState;
  chars: CharsState;
  interp: InterpState;
  fade: FadeState | null;
  playerRoute: PlayerRoute | null;
  /** Opaque game-owned JSON. Every fold clones and validates it through the
   * registered extension runtime; saves/checksums include it. */
  ext: JsonValue;
  /** Active full-screen scene. null is the backwards-compatible default. */
  scene: SceneSlot | null;
  /** Sparse in-flight world crossing. Absent in legacy projects and after
   * the atomic target entry, preserving the legacy serialized state shape. */
  handoff?: SeamlessHandoffState;
  /** Sparse frozen snapshot of the map left by the latest seamless commit.
   * Every other map entry removes it, as does moving more than
   * LEFT_MAP_RING_TILES away from that map. Legacy projects never set it. */
  leftMap?: LeftMapSnapshot;
  /** A host autosave request waiting for the first reference tick whose
   * complete reducer state is representable by rpgkit-save/v1. Multiple
   * requests coalesce into this one bit. It is host scheduling state, not
   * save data: manual snapshots reject it, and an automatic snapshot clears
   * it atomically when that snapshot is published. */
  pendingAutosave?: true;
}

function sessionWorldIdleBlockers(
  state: SessionState,
  menuOpen = false,
): WorldIdleBlockers {
  const blockers: WorldIdleBlockers = {
    sceneActive: state.scene !== null,
    fadeActive: state.fade !== null,
    playerRouteActive: state.playerRoute !== null,
    menuOpen,
  };
  // `stop` is route-only: a still-configured runtime wander remains an
  // idle blocker until a motion-mode control changes it to static/page.
  // Keep the legacy object shape when no player wander override exists.
  if (state.interp.moveControls?.player.moveType === "random") {
    blockers.playerWanderActive = true;
  }
  return blockers;
}

/** Public session-level view of the derived `worldIdle` condition. Save-menu
 * state is host-owned rather than serialized, so a host querying while its
 * menu is open supplies `menuOpen=true`; a normal reducer tick omits it. */
export function isSessionWorldIdle(state: SessionState, menuOpen = false): boolean {
  return state.handoff === undefined &&
    isWorldIdle(state.interp, sessionWorldIdleBlockers(state, menuOpen));
}

export interface SessionInput extends BattleInput {
  /** Direct entry selected by the active game-scene view (for example a
   *  tapped name-input cell). Ignored outside a scene. */
  selectIndex?: number;
}

/** A host lifecycle request observed at the reference tick that emitted it.
 * Autosave alone carries data: a fully normalized SaveSnapshot detached from
 * the working reducer state. */
export type SessionHostEffect =
  | { action: Exclude<HostAction, "autosave"> }
  | { action: "autosave"; snapshot: SaveSnapshot };

/** Optional, synchronous collector for host effects. Callers must buffer
 * effects until the surrounding fold commits: a streamed-map miss may roll
 * back the attempted frame and retry it later. Omit the sink for the normal
 * zero-allocation reducer path. */
export interface SessionEffectSink {
  publish(effect: SessionHostEffect): void;
}

interface SessionMapPreparation {
  id: string;
  map?: MapDef;
  world?: ReturnType<typeof createWorld>;
  table?: PassageTable;
}

export interface Session {
  cfg: MovementConfig;
  /** Host virtual frames per second. */
  hz: number;
  /** Fixed-rate reference ticks folded per host frame (MOTION_HZ / hz). */
  ticksPerFrame: number;
  /** Projects with an audio table opt into preserving every reference-tick
   * cue across a low-Hz host frame. Absent tables retain the v1 cue fold. */
  audioCues: boolean;
  /** Derived, mutable compile cache. It is deliberately outside
   * SessionState, snapshots and reducer hashes. Inline projects retain all
   * maps; sharded projects retain only the deterministic keep set. */
  maps: Map<string, MapDef>;
  worlds: Map<string, ReturnType<typeof createWorld>>;
  tables: Map<string, PassageTable>;
  /** Derived runtime views, keyed by the immutable tile override record.
   * Never serialized; a rewind/restore with another record identity recooks
   * before collision or pathfinding reads it. */
  runtimeTables: Map<string, {
    base: PassageTable;
    overrides: NonNullable<InterpState["tileProperties"]>;
    table: PassageTable;
  }>;
  /** Metadata for every sharded map without retaining any MapDef payload. */
  mapIndex: ReadonlyMap<string, MapIndexEntry> | null;
  /** Content identity copied into save envelopes for sharded projects. */
  content: MapContentIdentity | null;
  /** Explicit project opt-in for world-owned animation/camera/balloon state. */
  transferPresentation: boolean;
  repository: MapRepository | null;
  /** Partially prepared maps (transfer targets and seamless-world imminent
   *  targets), keyed by map id. Derived only: never serialized or exposed
   *  to event logic. Each entry stays unpublished until its map is acquired. */
  preparingMaps: Map<string, SessionMapPreparation>;
  sheets: ReadonlyMap<string, Sheet>;
  commonEvents: CommonEvent[];
  /** Project.system options, the item catalog/inventory caps (T2-10/B1)
   * and the extension registry every compiled world (eager, on demand or
   * staged) is built with. */
  worldOptions: WorldOptions;
  /** Function registry/codec lives outside reducer state. */
  extensions: ExtensionRuntime;
  battle: BattleRules | null;
  /** KG1: game-registered scene reducers keyed by scene id. */
  scenes: Record<string, SceneRules>;
  /** Scene policy is immutable host configuration, never reducer state. */
  sceneOptions: Required<SceneOptions>;
  /** Published snapshots and their banks must not be mutated by the caller. */
  immutableState: boolean;
  /** Effective build/session traversal identity. */
  worldTraversal: WorldTraversalMode;
  /** Optional immutable-layout resolver. Null keeps every transfer legacy. */
  handoffResolver: WorldHandoffResolver | null;
  /** Pure game policy for optional movement capabilities named by trusted
   * WorldOpening data. Null retains ordinary terrain checks. */
  handoffCapability: HandoffCapabilityResolver | null;
}

export type HandoffCapabilityResolver = (
  capability: string,
  state: Readonly<SessionState>,
) => boolean;

export interface SceneOptions {
  /** Advance map pages, characters and interpreter fibers while a full-screen
   * scene is active. Defaults to false, matching RPG Maker/Tuxemon battles. */
  worldContinues?: boolean;
}

export interface SessionOptions {
  /** Opt into identity-based dependency checks. Callers must treat every
   * published snapshot, including restored snapshots, as immutable. */
  immutableState?: boolean;
  maps?: MapRepository;
  /** Recompute and verify a ProjectShell's declared mapManifestHash. Splitter
   * output in a trusted app package uses the declared build identity directly
   * by default; shells without one are always hashed. */
  verifyMapManifest?: boolean;
  /** Exact older content identities this application has tested as safe to
   * load into the current maps. This never weakens arbitrary manifest/schema
   * mismatches and is never copied into newly written save envelopes. */
  compatibleSaveContent?: readonly MapContentVersion[];
  extensions?: ExtensionOptions;
  battle?: BattleRules;
  /** KG1: scene reducers keyed by namespaced id ("game.pc",
   *  "rpgkit.nameInput", …). Every scene id referenced by project content
   *  must be registered or createSession throws. */
  scenes?: Record<string, SceneRules>;
  scene?: SceneOptions;
  /** Opt-in fiber-start trace forwarded to every world (see
   *  WorldOptions.onFiberStart). Coverage/QA tools use it to observe pages
   *  whose fibers begin and end inside one tick. */
  onFiberStart?: (key: string, pageIndex: number, parallel: boolean) => void;
  /** Opt-in instruction trace forwarded to every world (see
   *  WorldOptions.onInstruction). Coverage/QA tools use it to observe the
   *  commands a simulation actually reached. */
  onInstruction?: (key: string, pageIndex: number, ins: Instr) => void;
  /** Where a message too long for one box breaks into pages, forwarded to
   *  every world (see WorldOptions.paginateText). GameView passes the
   *  dialog box's paginator; without one every message is one page. */
  paginateText?: TextPaginator;
  /** Resolver for `{x:<key>}` text tokens, forwarded to every world. Called
   *  once per token when a text or choices box opens; it must be a pure
   *  function of the view (no clock, randomness or mutation), so the
   *  expanded text replays identically. An unanswered token shows ???. */
  textTokens?: TextTokenResolver;
  /** Override used by a replay tape. A missing tape identity is supplied as
   * legacy-transfer by the attract controller. Live sessions omit this. */
  worldTraversal?: WorldTraversalMode;
  /** Type-only opt-in seam; concrete layout indexing lives outside the base
   * session bundle. */
  handoff?: WorldHandoffResolver;
  /** Pure game policy for a capability named by trusted WorldOpening data.
   * Returning true may relax only the target tile's solid-terrain opinion;
   * bounds, event bodies and directional edge masks still block. */
  handoffCapability?: HandoffCapabilityResolver;
}

function visitCondition(c: Condition, found: Set<string>): void {
  if (c.kind === "ext") found.add(`condition ${c.call}`);
}

function visitCommands(commands: readonly Command[], found: Set<string>): void {
  for (const command of commands) {
    if (command.op === "ext") found.add(`command ${command.call}`);
    if (command.op === "extChoice") found.add(`choice ${command.call}`);
    if (command.op === "if") {
      visitCondition(command.if, found);
      visitCommands(command.then, found);
      if (command.else) visitCommands(command.else, found);
    } else if (command.op === "loop") {
      visitCommands(command.commands, found);
    } else if (command.op === "choices") {
      for (const option of command.options) visitCommands(option.commands, found);
      if (command.cancel) visitCommands(command.cancel.commands, found);
    } else if (command.op === "battle") {
      if (command.onWin) visitCommands(command.onWin, found);
      if (command.onLose) visitCommands(command.onLose, found);
      if (command.onEscape) visitCommands(command.onEscape, found);
    } else if (command.op === "scene") {
      if (command.onDone) visitCommands(command.onDone, found);
      if (command.onCancel) visitCommands(command.onCancel, found);
    }
  }
}

function commandsUseBattle(commands: readonly Command[]): boolean {
  for (const command of commands) {
    if (command.op === "battle") return true;
    if (command.op === "if" && (
      commandsUseBattle(command.then) || commandsUseBattle(command.else ?? [])
    )) return true;
    if (command.op === "loop" && commandsUseBattle(command.commands)) return true;
    if (command.op === "choices" && (
      command.options.some((option) => commandsUseBattle(option.commands)) ||
      commandsUseBattle(command.cancel?.commands ?? [])
    )) return true;
    if (command.op === "scene" && (
      commandsUseBattle(command.onDone ?? []) || commandsUseBattle(command.onCancel ?? [])
    )) return true;
  }
  return false;
}

function mapUsesBattle(map: MapDef): boolean {
  return (map.events ?? []).some((event) =>
    event.pages.some((page) => commandsUseBattle(page.commands))
  );
}

function assertBattleRegistered(rules: BattleRules | null, used: boolean): void {
  if (used && rules === null) {
    throw new Error("createSession: project uses battle commands but no BattleRules were registered");
  }
}

/** KG1: every scene id referenced by project content (map events, common
 *  events, nested branches) must have a registered SceneRules. */
function sceneIdsInCommands(commands: readonly Command[], found: Set<string>): void {
  for (const command of commands) {
    if (command.op === "scene") found.add(command.id);
    if (command.op === "if") {
      sceneIdsInCommands(command.then, found);
      if (command.else) sceneIdsInCommands(command.else, found);
    } else if (command.op === "loop") {
      sceneIdsInCommands(command.commands, found);
    } else if (command.op === "choices") {
      for (const option of command.options) sceneIdsInCommands(option.commands, found);
      if (command.cancel) sceneIdsInCommands(command.cancel.commands, found);
    } else if (command.op === "battle") {
      if (command.onWin) sceneIdsInCommands(command.onWin, found);
      if (command.onLose) sceneIdsInCommands(command.onLose, found);
      if (command.onEscape) sceneIdsInCommands(command.onEscape, found);
    } else if (command.op === "scene") {
      if (command.onDone) sceneIdsInCommands(command.onDone, found);
      if (command.onCancel) sceneIdsInCommands(command.onCancel, found);
    }
  }
}

function mapSceneIds(map: MapDef): Set<string> {
  const found = new Set<string>();
  for (const event of map.events ?? []) {
    for (const page of event.pages) sceneIdsInCommands(page.commands, found);
  }
  return found;
}

function assertScenesRegistered(
  scenes: Record<string, SceneRules>,
  used: ReadonlySet<string>,
): void {
  const missing: string[] = [];
  for (const id of used) {
    if (!extensionCallNameValid(id)) {
      missing.push(`${id} (invalid namespaced scene id)`);
    } else if (!scenes[id]) {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    missing.sort();
    throw new Error(`createSession: unregistered scene ids: ${missing.join(", ")}`);
  }
}

function mapExtensionCalls(map: MapDef): Set<string> {
  const found = new Set<string>();
  for (const event of map.events ?? []) {
    for (const page of event.pages) {
      for (const condition of page.condition?.all ?? []) visitCondition(condition, found);
      visitCommands(page.commands, found);
    }
  }
  return found;
}

function commonExtensionCalls(events: readonly CommonEvent[]): Set<string> {
  const found = new Set<string>();
  for (const event of events) visitCommands(event.commands, found);
  return found;
}

function assertRegisteredExtensions(runtime: ExtensionRuntime, found: ReadonlySet<string>): void {
  if (runtime.allowUnknown) return;
  const missing: string[] = [];
  for (const entry of found) {
    const space = entry.indexOf(" ");
    const kind = entry.slice(0, space);
    const call = entry.slice(space + 1);
    if (!extensionCallNameValid(call)) {
      missing.push(`${kind} ${call} (invalid namespaced call)`);
    } else if (
      kind === "command" ? !runtime.commands[call]
      : kind === "choice" ? !runtime.choices[call]
      : !runtime.conditions[call]
    ) {
      missing.push(entry);
    }
  }
  if (missing.length > 0) {
    missing.sort();
    throw new Error(`createSession: unregistered extension calls: ${missing.join(", ")}`);
  }
}

/** Acquire, validate and compile one map into the derived session cache. */
export function acquireSessionMap(sess: Session, id: string): MapDef {
  const hit = sess.maps.get(id);
  if (hit) {
    // A layered release (releaseSessionMapLayers) may have kept the parsed
    // MapDef while dropping the compiled World/PassageTable — a map that
    // stayed visible but left the imminent set. Rebuild the missing layers
    // before the caller enters the map, adopting staged compilation when the
    // prefetcher finished it, so a revisit never observes a half-cached map.
    const staged = sess.preparingMaps.get(id);
    if (!sess.worlds.has(id)) {
      sess.worlds.set(
        id,
        staged?.world ?? createWorld(hit, sess.commonEvents, MOTION_HZ, sess.worldOptions),
      );
    }
    if (!sess.tables.has(id)) {
      sess.tables.set(id, staged?.table ?? buildPassage(hit, sess.sheets));
    }
    // The mutable layer is map-entry owned: it left with the compiled
    // layers, so a rebuilt map starts from a fresh runtime view.
    sess.runtimeTables.delete(id);
    sess.preparingMaps.delete(id);
    return hit;
  }
  startupProfileMark("map-acquire:start");
  const expected = sess.mapIndex?.get(id);
  const repository = sess.repository;
  if (!expected || !repository) throw new Error(`session: unknown map ${id}`);
  const actual = repository.meta(id);
  if (!actual || actual.id !== expected.id || actual.width !== expected.width ||
    actual.height !== expected.height || actual.entry !== expected.entry ||
    actual.sha256 !== expected.sha256) {
    throw new Error(`map repository: manifest metadata mismatch for ${id}`);
  }
  const prepared = sess.preparingMaps.get(id);
  if (prepared?.map && prepared.world && prepared.table) {
    sess.maps.set(id, prepared.map);
    sess.worlds.set(id, prepared.world);
    sess.tables.set(id, prepared.table);
    sess.runtimeTables.delete(id);
    sess.preparingMaps.delete(id);
    return prepared.map;
  }
  const map = repository.acquire(id);
  startupProfileMark("map-acquire:decoded");
  if (map.id !== expected.id || map.width !== expected.width || map.height !== expected.height) {
    throw new Error(`map repository: payload metadata mismatch for ${id}`);
  }
  assertRegisteredExtensions(sess.extensions, mapExtensionCalls(map));
  assertBattleRegistered(sess.battle, mapUsesBattle(map));
  assertScenesRegistered(sess.scenes, mapSceneIds(map));
  startupProfileMark("map-acquire:validated");
  // Compile into locals first. A throw leaves the live cache and simulation
  // untouched, which is what an async caller needs before retrying a frame.
  const world = createWorld(map, sess.commonEvents, MOTION_HZ, sess.worldOptions);
  startupProfileMark("map-acquire:world");
  const table = buildPassage(map, sess.sheets);
  startupProfileMark("map-acquire:passage");
  sess.maps.set(id, map);
  sess.worlds.set(id, world);
  sess.tables.set(id, table);
  sess.runtimeTables.delete(id);
  sess.preparingMaps.delete(id);
  startupProfileMark("map-acquire:end");
  return map;
}

/** Perform at most one fixed preparation unit for a synchronous repository:
 * repository parse, repository validation, world compilation, then passage
 * compilation.
 * Completed data remains derived and unpublished until acquireSessionMap at
 * the original transfer boundary. A map whose parsed MapDef survived a
 * layered release reuses it and only re-runs the compiled stages. */
export function prepareSessionMapStep(sess: Session, id: string): boolean {
  if (sess.maps.has(id) && sess.worlds.has(id) && sess.tables.has(id)) return true;
  const expected = sess.mapIndex?.get(id);
  const repository = sess.repository;
  if (!expected || !repository) throw new Error(`session: unknown map ${id}`);
  const actual = repository.meta(id);
  if (!actual || actual.id !== expected.id || actual.width !== expected.width ||
    actual.height !== expected.height || actual.entry !== expected.entry ||
    actual.sha256 !== expected.sha256) {
    throw new Error(`map repository: manifest metadata mismatch for ${id}`);
  }
  let preparation = sess.preparingMaps.get(id);
  if (!preparation) {
    preparation = { id };
    sess.preparingMaps.set(id, preparation);
  }
  if (!preparation.map) {
    // The parsed layer survived a layered release: reuse the resident
    // MapDef instead of re-reading the repository.
    const resident = sess.maps.get(id);
    if (resident) {
      preparation.map = resident;
    } else {
      if (!repository.acquireStep) return false;
      const map = repository.acquireStep(id);
      if (map) {
        if (map.id !== expected.id || map.width !== expected.width || map.height !== expected.height) {
          throw new Error(`map repository: payload metadata mismatch for ${id}`);
        }
        assertRegisteredExtensions(sess.extensions, mapExtensionCalls(map));
        assertBattleRegistered(sess.battle, mapUsesBattle(map));
        assertScenesRegistered(sess.scenes, mapSceneIds(map));
        preparation.map = map;
      }
      return false;
    }
  }
  if (!preparation.world) {
    preparation.world = createWorld(
      preparation.map,
      sess.commonEvents,
      MOTION_HZ,
      sess.worldOptions,
    );
    return false;
  }
  if (!preparation.table) {
    preparation.table = buildPassage(preparation.map, sess.sheets);
  }
  return true;
}

/** Prepare web-backed bytes (when supported) and compile them outside the
 * reducer. The caller then retries the exact state/input pair that met a
 * MapNotReadyError; no logical tick is consumed while this promise waits. */
export async function prepareSessionMap(sess: Session, id: string): Promise<void> {
  if (sess.maps.has(id) && sess.worlds.has(id) && sess.tables.has(id)) return;
  if (!sess.repository || !sess.mapIndex?.has(id)) {
    throw new Error(`session: unknown map ${id}`);
  }
  await sess.repository.prepare?.(id);
  acquireSessionMap(sess, id);
}

/** Deterministic cache policy for sharded projects: retain exactly the given
 * ids, in caller-provided order. Inline projects keep their eager cache. */
export function releaseSessionMapsExcept(sess: Session, ids: readonly string[]): void {
  if (!sess.repository) return;
  const keep = new Set(ids);
  for (const id of [...sess.maps.keys()]) if (!keep.has(id)) sess.maps.delete(id);
  for (const id of [...sess.worlds.keys()]) if (!keep.has(id)) sess.worlds.delete(id);
  for (const id of [...sess.tables.keys()]) if (!keep.has(id)) sess.tables.delete(id);
  for (const id of [...sess.runtimeTables.keys()]) if (!keep.has(id)) sess.runtimeTables.delete(id);
  for (const id of [...sess.preparingMaps.keys()]) {
    if (!keep.has(id)) sess.preparingMaps.delete(id);
  }
  sess.repository.releaseExcept(ids);
}

/** Layered cache policy for seamless worlds (plan 3.6). The parsed/source
 * layer (MapDefs and repository bytes) follows `parsed` — active, visible and
 * one-hop prefetch maps. The compiled layer (World and PassageTable) follows
 * the smaller `compiled` set — active plus imminent targets. The mutable
 * layer (runtime passage overrides) is retained for the active map only,
 * matching map-entry ownership. Unpublished staged preparation for a map
 * outside `parsed` is dropped; one inside `parsed` but outside `compiled`
 * keeps only its parsed stage, so the compiled stages re-run if the map
 * becomes imminent again. Inline projects keep their eager cache. */
export function releaseSessionMapLayers(
  sess: Session,
  parsed: readonly string[],
  compiled: readonly string[],
  active: string,
): void {
  if (!sess.repository) return;
  const parsedKeep = new Set(parsed);
  const compiledKeep = new Set(compiled);
  for (const id of [...sess.maps.keys()]) if (!parsedKeep.has(id)) sess.maps.delete(id);
  for (const id of [...sess.worlds.keys()]) if (!compiledKeep.has(id)) sess.worlds.delete(id);
  for (const id of [...sess.tables.keys()]) if (!compiledKeep.has(id)) sess.tables.delete(id);
  for (const id of [...sess.runtimeTables.keys()]) if (id !== active) sess.runtimeTables.delete(id);
  for (const id of [...sess.preparingMaps.keys()]) {
    if (!parsedKeep.has(id)) {
      sess.preparingMaps.delete(id);
    } else if (!compiledKeep.has(id)) {
      // Visible but not imminent: retain the parsed stage, drop the compiled
      // stages (they are cheap to re-run when the map returns to the set).
      const preparation = sess.preparingMaps.get(id)!;
      preparation.world = undefined;
      preparation.table = undefined;
    }
  }
  sess.repository.releaseExcept(parsed);
}

export function createSession(
  project: ProjectSource,
  hz: number = MOTION_HZ,
  optionsOrMaps?: SessionOptions | MapRepository,
): Session {
  startupProfileMark("session-create:start");
  // v1.3 compatibility: the original third parameter was a bare repository.
  const options: SessionOptions = optionsOrMaps &&
    typeof (optionsOrMaps as MapRepository).acquire === "function" &&
    typeof (optionsOrMaps as MapRepository).meta === "function"
    ? { maps: optionsOrMaps as MapRepository }
    : (optionsOrMaps as SessionOptions | undefined) ?? {};
  const requestedTraversal = options.worldTraversal ?? project.worldTraversal ?? "legacy-transfer";
  const worldTraversal: WorldTraversalMode =
    project.worldTraversal === "seamless-v1" &&
      requestedTraversal === "seamless-v1" &&
      project.worldLayout !== undefined &&
      options.handoff?.topologyHash === project.worldLayout.topologyHash
      ? "seamless-v1"
      : "legacy-transfer";
  const handoffResolver = worldTraversal === "seamless-v1" ? options.handoff! : null;
  const maps = options.maps;
  const extensions = createExtensionRuntime(options.extensions);
  const sheets = new Map<string, Sheet>(project.sheets.map((s) => [s.id, s]));
  const commonEvents = [...(project.commonEvents ?? [])];
  const worldOptions: WorldOptions = {
    messageBlocksPlayer: project.system?.messageBlocksPlayer === true,
    textVariables: project.system?.textVariables === true,
    characterNames: project.system?.characterNames === true,
    // Declaring system.textTokens (the key allowlist) is the explicit {x:}
    // opt-in: a document without it keeps the pre-{x:} literal behavior.
    textTokensEnabled: Array.isArray(project.system?.textTokens),
    extensions,
    items: project.items,
    inventory: project.system?.inventory,
    onFiberStart: options.onFiberStart,
    onInstruction: options.onInstruction,
    animations: project.animations,
    textTokens: options.textTokens,
  };
  if (options.paginateText) worldOptions.paginateText = options.paginateText;
  assertRegisteredExtensions(extensions, commonExtensionCalls(commonEvents));
  assertBattleRegistered(options.battle ?? null, commonEvents.some((event) => commandsUseBattle(event.commands)));
  assertScenesRegistered(options.scenes ?? {}, (() => {
    const found = new Set<string>();
    for (const event of commonEvents) sceneIdsInCommands(event.commands, found);
    return found;
  })());
  startupProfileMark("session-create:registrations");
  if (isProjectShell(project)) {
    if (!maps) throw new Error("map repository: ProjectShell requires a MapRepository");
    const index = validateMapIndex(project.mapIndex);
    startupProfileMark("session-create:index-validated");
    const manifest = resolveMapManifestHash(project, options.verifyMapManifest === true);
    startupProfileMark("session-create:manifest-resolved");
    if (project.mapSchemaHash !== undefined && !isCompatibleMapSchemaHash(project.mapSchemaHash)) {
      throw new Error(`map repository: shell schema hash mismatch: ${describeMapSchemaRefusal(project.mapSchemaHash)}`);
    }
    if (!index.has(project.start.map)) {
      throw new Error(`map repository: start map ${project.start.map} is absent from mapIndex`);
    }
    const session: Session = {
      cfg: { tile: project.tileSize, speed: 2 },
      hz,
      ticksPerFrame: motionTicksPerFrame(hz),
      audioCues: project.audio !== undefined,
      maps: new Map(),
      worlds: new Map(),
      tables: new Map(),
      runtimeTables: new Map(),
      mapIndex: index,
      content: {
        manifest,
        schema: MAP_SCHEMA_HASH,
        ...(options.compatibleSaveContent?.length
          ? { compatible: options.compatibleSaveContent.map((identity) => ({ ...identity })) }
          : {}),
      },
      transferPresentation: project.system?.transferPresentation === "retain",
      repository: maps,
      preparingMaps: new Map(),
      sheets,
      commonEvents,
      worldOptions,
      extensions,
      battle: options.battle ?? null,
      scenes: options.scenes ?? {},
      sceneOptions: { worldContinues: options.scene?.worldContinues === true },
      immutableState: options.immutableState === true,
      worldTraversal,
      handoffResolver,
      handoffCapability: options.handoffCapability ?? null,
    };
    acquireSessionMap(session, project.start.map);
    releaseSessionMapsExcept(session, [project.start.map]);
    startupProfileMark("session-create:end");
    return session;
  }
  for (const map of project.maps) {
    assertRegisteredExtensions(extensions, mapExtensionCalls(map));
    assertBattleRegistered(options.battle ?? null, mapUsesBattle(map));
    assertScenesRegistered(options.scenes ?? {}, mapSceneIds(map));
  }
  const inlineMaps = new Map<string, MapDef>(project.maps.map((m) => [m.id, m]));
  // Interpreter worlds compile at the FIXED motion reference: waits, text
  // reveal and fade frames are counted in reference ticks, and stepSession
  // folds MOTION_HZ/hz of them per host frame. Authored time then means the
  // same virtual time at every host rate.
  const worlds = new Map(
    project.maps.map((m) => [m.id, createWorld(m, commonEvents, MOTION_HZ, worldOptions)]),
  );
  const tables = new Map(project.maps.map((m) => [m.id, buildPassage(m, sheets)]));
  startupProfileMark("session-create:end");
  return {
    cfg: { tile: project.tileSize, speed: 2 },
    hz,
    ticksPerFrame: motionTicksPerFrame(hz),
    audioCues: project.audio !== undefined,
    maps: inlineMaps,
    worlds,
    tables,
    runtimeTables: new Map(),
    mapIndex: null,
    content: null,
    transferPresentation: project.system?.transferPresentation === "retain",
    repository: null,
    preparingMaps: new Map(),
    sheets,
    commonEvents,
    worldOptions,
    extensions,
    battle: options.battle ?? null,
    scenes: options.scenes ?? {},
    sceneOptions: { worldContinues: options.scene?.worldContinues === true },
    immutableState: options.immutableState === true,
    worldTraversal,
    handoffResolver,
    handoffCapability: options.handoffCapability ?? null,
  };
}

export function startSession(
  project: ProjectSource,
  session: Session,
  sw0?: SwitchState,
  ext0?: JsonValue,
): SessionState {
  startupProfileMark("session-start:start");
  const start = project.start;
  acquireSessionMap(session, start.map);
  releaseSessionMapsExcept(session, [start.map]);
  if (sw0) {
    const interp = createInterpState(sw0, session.maps.get(start.map)!.parallax);
    clearLocalBank(interp.sw);
    const state: SessionState = {
      frame: 0,
      mapId: start.map,
      sw: interp.sw,
      move: initialMovement(start.x, start.y, DIR_INDEX[start.dir], session.cfg),
      chars: createChars(),
      interp,
      fade: null,
      playerRoute: null,
      ext: cloneExtension(session.extensions, ext0 === undefined ? session.extensions.initial : ext0),
      scene: null,
    };
    showMapNameBanner(state, session.maps.get(start.map)!);
    startupProfileMark("session-start:end");
    return state;
  }
  // Fresh playthrough: seed the project's starting gold (the remaining
  // switch/item/variable banks begin empty) and the configurable default
  // player name (substituted for the {name} text token).
  const interp = createInterpState(undefined, session.maps.get(start.map)!.parallax);
  interp.sw.gold = clampFiniteVar(project.initialGold ?? 0);
  if (project.playerName) interp.sw.playerName = project.playerName;
  if (project.system?.mapNameDisplay === true) interp.sw.mapNameDisplay = true;
  const state: SessionState = {
    frame: 0,
    mapId: start.map,
    sw: interp.sw,
    move: initialMovement(start.x, start.y, DIR_INDEX[start.dir], session.cfg),
    chars: createChars(),
    interp,
    fade: null,
    playerRoute: null,
    ext: cloneExtension(session.extensions, ext0 === undefined ? session.extensions.initial : ext0),
    scene: null,
  };
  showMapNameBanner(state, session.maps.get(start.map)!);
  startupProfileMark("session-start:end");
  return state;
}

/** Start the automatic entry banner only when the persistent project flag
 * is enabled. The sparse screen object remains absent in legacy projects. */
function showMapNameBanner(s: SessionState, map: Readonly<MapDef>): void {
  if (s.sw.mapNameDisplay !== true || map.name.length === 0) return;
  const screen = s.interp.screen ?? (s.interp.screen = {});
  startMapNameBanner(screen, map.name);
}

/** Drop per-visit switch/variable ids. Any switch or variable
 *  whose id starts with `local.` lives for one map visit: it is cleared on
 *  every map entry, so a guard like `local.npc.guard == 0` re-runs after a
 *  transfer away and back. Mutates the shared project-wide bank in place
 *  (the map interpreter rebuild shares this object). */
function clearLocalBank(sw: SwitchState): void {
  for (const id of Object.keys(sw.switches)) {
    if (id.startsWith("local.")) delete ownRecord(sw, "switches")[id];
  }
  for (const id of Object.keys(sw.variables)) {
    if (id.startsWith("local.")) delete ownRecord(sw, "variables")[id];
  }
}

/** Spawn per-entry state for a map: fresh interpreter (MV rebuilds the map
 *  interpreter on load) and characters at their authored cells, with the
 *  project-wide switch bank shared (minus the per-visit `local.` ids). */
function enterMap(
  s: SessionState,
  map: Readonly<MapDef>,
  x: number,
  y: number,
  facing: Facing,
  cfg: MovementConfig,
  retainPresentation: boolean,
): void {
  const screen = screenEffectsAfterTransfer(s.interp.screen, retainPresentation);
  const audio = s.interp.audio;
  const anims = retainPresentation
    ? mapAnimsAfterTransfer(s.interp.anims, s.interp.frame)
    : undefined;
  clearLocalBank(s.sw);
  s.mapId = map.id;
  s.move = initialMovement(x, y, facing, cfg);
  s.chars = createChars();
  s.interp = createInterpState(s.sw, map.parallax);
  if (screen) s.interp.screen = screen;
  if (audio) s.interp.audio = audio;
  if (anims) s.interp.anims = anims;
  s.sw = s.interp.sw;
  s.playerRoute = null;
  delete s.handoff;
  delete s.leftMap;
}

/** An opted-in Tuxemon-style world owns map effects on its persistent
 * MapRenderer rather than on a map object. Rebase immutable instances onto
 * the fresh interpreter's zero clock so their visible phase survives both
 * ordinary transfers and seamless handoffs. Event-following instances pin
 * to their last source-map cell; only the player identity crosses maps. */
function mapAnimsAfterTransfer(
  source: readonly MapAnimInstance[] | undefined,
  sourceFrame: number,
): MapAnimInstance[] | undefined {
  if (!source || source.length === 0) return undefined;
  return source.map((instance) => ({
    ...instance,
    start: instance.start - sourceFrame,
    target: instance.target === "player" ? "player" : null,
  }));
}

/** Neighbour preview sandbox (world-preview-sandbox.ts): a private working
 * state that has just entered `mapId` with the player at (x, y, facing),
 * built from `s0`'s durable banks through the same `enterMap` a transfer or
 * seamless commit uses. Nothing is copied up front: the interpreter state is
 * taken through the per-frame copy-on-write path (shared switch records are
 * copied on their first write, so only a bank that holds `local.*` ids is
 * copied by the entry reset), and `s0` and everything it shares stay
 * untouched. `sess` must be a sandbox session (createSandboxSession) holding
 * `mapId`; entry compiles the map into that session's private caches. */
export function enterSessionMapIsolated(
  sess: Session,
  s0: Readonly<SessionState>,
  mapId: string,
  x: number,
  y: number,
  facing: Facing,
): SessionState {
  const map = acquireSessionMap(sess, mapId);
  const metadata = sess.immutableState ? beginStateMetadata() : undefined;
  try {
    const interp = shareInterp(s0.interp as InterpState, sess.immutableState);
    const s: SessionState = {
      frame: s0.frame,
      mapId: s0.mapId,
      sw: interp.sw,
      move: { ...s0.move },
      chars: createChars(),
      interp,
      fade: null,
      playerRoute: null,
      ext: cloneExtension(sess.extensions, s0.ext),
      scene: null,
    };
    enterMap(s, map, x, y, facing, sess.cfg, sess.transferPresentation);
    showMapNameBanner(s, map);
    return s;
  } finally {
    if (metadata) endStateMetadata(metadata);
  }
}

/** Thrown inside a sandbox session when its entry reaches for a map the
 * sandbox does not hold (an instant transfer away). The sandbox reports the
 * entry as transferring; the live repository is never touched. */
export class SandboxMapUnavailable extends Error {
  constructor(readonly mapId: string) {
    super(`sandbox: map ${mapId} is not held by the sandbox`);
  }
}

const SANDBOX_REPOSITORY: MapRepository = {
  meta: (id) => {
    throw new SandboxMapUnavailable(id);
  },
  acquire: (id) => {
    throw new SandboxMapUnavailable(id);
  },
  releaseExcept: () => {},
};

/** A session for sandboxed map entry. It shares `sess`'s compiled rules,
 * extension handlers and options, runs one reference tick per fold, and owns
 * private derived caches that start empty: the caller hands it each map with
 * holdSandboxMap. Its repository refuses every load and release, so neither
 * an entry that transfers away nor a cache trim can change what the live
 * session or its repository holds. */
export function createSandboxSession(sess: Session): Session {
  return {
    ...sess,
    hz: MOTION_HZ,
    ticksPerFrame: 1,
    maps: new Map(),
    worlds: new Map(),
    tables: new Map(),
    runtimeTables: new Map(),
    preparingMaps: new Map(),
    repository: SANDBOX_REPOSITORY,
    // Known ids stay known (a transfer to one is a transfer, not a content
    // error); an inline project indexes its resident maps by dimensions.
    mapIndex: sess.mapIndex ?? new Map(
      [...sess.maps.values()].map((map) => [map.id, { id: map.id, width: map.width, height: map.height }] as const),
    ) as unknown as ReadonlyMap<string, MapIndexEntry>,
  };
}

/** Hand a resident MapDef to a sandbox session, adopting the live session's
 * compiled (or prefetch-staged) World and passage table for that MapDef.
 * Returns whether the map still needs compiling (compileSandboxMap). */
export function holdSandboxMap(sandbox: Session, live: Session, map: Readonly<MapDef>): boolean {
  const id = map.id;
  if (sandbox.maps.get(id) !== map) {
    sandbox.maps.set(id, map as MapDef);
    sandbox.worlds.delete(id);
    sandbox.tables.delete(id);
  }
  const staged = live.preparingMaps.get(id);
  const liveMap = live.maps.get(id) ?? staged?.map;
  if (liveMap === map) {
    // Compiled or staged by the live session (its world prefetcher).
    const world = live.worlds.get(id) ?? staged?.world;
    const table = live.tables.get(id) ?? staged?.table;
    if (world && !sandbox.worlds.has(id)) sandbox.worlds.set(id, world);
    if (table && !sandbox.tables.has(id)) sandbox.tables.set(id, table);
  }
  if (sandbox.worlds.has(id)) sandboxWorldBuilds.get(sandbox)?.delete(id);
  return !sandbox.worlds.has(id) || !sandbox.tables.has(id);
}

/** Compiled instructions per sandbox World unit (stepWorld's budget). */
export const SANDBOX_WORLD_UNIT_INSTRUCTIONS = 1500;

/** In-progress World builds per sandbox session, by map id. */
const sandboxWorldBuilds = /* @__PURE__ */ new WeakMap<Session, Map<string, WorldBuild>>();

/** One compilation unit for a map held by the sandbox: a bounded slice of
 * its World (whole events, about SANDBOX_WORLD_UNIT_INSTRUCTIONS compiled
 * instructions; a small map's World is one unit), then its passage table,
 * so no single unit compiles a whole large map. Returns true once both are
 * present. */
export function compileSandboxMap(sandbox: Session, mapId: string): boolean {
  const map = sandbox.maps.get(mapId);
  if (!map) throw new Error(`sandbox: map ${mapId} is not held by the sandbox`);
  if (!sandbox.worlds.has(mapId)) {
    let builds = sandboxWorldBuilds.get(sandbox);
    if (!builds) {
      builds = new Map();
      sandboxWorldBuilds.set(sandbox, builds);
    }
    let build = builds.get(mapId);
    if (!build || build.map !== map) {
      build = beginWorld(map, sandbox.commonEvents, MOTION_HZ, sandbox.worldOptions);
      builds.set(mapId, build);
    }
    const world = stepWorld(build, SANDBOX_WORLD_UNIT_INSTRUCTIONS);
    if (!world) return false;
    builds.delete(mapId);
    sandbox.worlds.set(mapId, world);
    return sandbox.tables.has(mapId);
  }
  if (!sandbox.tables.has(mapId)) sandbox.tables.set(mapId, buildPassage(map, sandbox.sheets));
  return true;
}

/** Drop every sandbox-held map outside `keep`. */
export function trimSandboxMaps(sandbox: Session, keep: ReadonlySet<string>): void {
  const builds = sandboxWorldBuilds.get(sandbox);
  for (const cache of [sandbox.maps, sandbox.worlds, sandbox.tables, sandbox.runtimeTables, builds]) {
    if (!cache) continue;
    for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
  }
}

/** The effective terrain for this exact reducer branch. The authored table
 * remains immutable; a changed/rewound override record gets its own derived
 * typed arrays, while ordinary projects return the base table by identity. */
export function sessionPassageTable(sess: Session, s: SessionState): PassageTable {
  const base = sess.tables.get(s.mapId)!;
  const overrides = s.interp.tileProperties;
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const cached = sess.runtimeTables.get(s.mapId);
  if (cached?.base === base && cached.overrides === overrides) return cached.table;
  const table = withTilePropertyOverrides(base, overrides);
  sess.runtimeTables.set(s.mapId, { base, overrides, table });
  return table;
}

function eventPagesOf(map: MapDef, chars: CharsState): Record<string, EventPageAppearance> {
  const out = keyedRecord<EventPageAppearance>();
  for (const ev of map.events ?? []) {
    const pageIndex = chars.chars[ev.id]?.pageIndex;
    if (pageIndex === undefined || !ev.pages[pageIndex]) continue;
    out[ev.id] = { pageIndex, sprite: ev.pages[pageIndex]!.sprite ?? null };
  }
  return out;
}

function sessionConditionContext(
  world: ReturnType<typeof createWorld>,
  s: SessionState,
  eventPages: Readonly<Record<string, EventPageAppearance>> | undefined,
  playerMoving = world.needsPlayerMovingContext ? s.move.moving : undefined,
): ConditionContext {
  const context: ConditionContext = { worldIdle: isSessionWorldIdle(s) };
  if (playerMoving !== undefined) context.playerMoving = playerMoving;
  if (s.interp.audio) context.audio = s.interp.audio;
  if (eventPages) {
    context.eventPages = eventPages;
    context.eventAppearances = s.interp.eventAppearances;
  }
  if (world.needsTilePropertyContext) {
    context.tileProperties = s.interp.tileProperties;
    context.mapWidth = world.map.width;
    context.mapHeight = world.map.height;
  }
  return context;
}

/** B2: before consuming a battle/scene queue, drop requests whose parallel
 *  fiber's page went stale since the last fold (a completion on the previous
 *  frame, or a command earlier in this tick). The guard at the call sites
 *  means a scene-free project (empty queues) never reaches here, so the
 *  condition-context build below costs nothing on the hot path. */
function pruneStaleQueuedScenes(
  sess: Session,
  s: SessionState,
  playerMoving?: boolean,
): void {
  const world = sess.worlds.get(s.mapId);
  const map = sess.maps.get(s.mapId);
  if (!world || !map) return;
  const extension: ExtensionScope = { runtime: sess.extensions, ext: s.ext };
  const eventPages = world.needsEventPages === true || s.interp.eventAppearances !== undefined
    ? eventPagesOf(map, s.chars)
    : undefined;
  pruneStaleQueuedRequests(
    s.interp,
    world,
    s.move.facing,
    extension,
    sessionConditionContext(world, s, eventPages, playerMoving),
  );
}

/** The baked map table plus blocking-character bodies, held as a sparse
 *  set of occupied row-major cells. A body
 *  blocks regardless of the terrain opinion under it: a map.passage
 *  "pass" override reopens terrain (a gate through a fence), it never
 *  lets the mover walk through a blocks:true character standing there. */
export function tableWithBodies(
  base: PassageTable,
  chars: CharsState,
  settings?: Readonly<Record<string, ResolvedMoveSettings>>,
): PassageTable {
  if (settings === undefined) return tableWithBodiesLegacy(base, chars);
  const cells: number[] = [];
  const add = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < base.width && y < base.height) {
      cells.push(y * base.width + x);
    }
  };
  for (const ch of Object.values(chars.chars)) {
    if (!ch.blocks || settings?.[ch.id]?.through === true) continue;
    add(ch.tx, ch.ty);
    if (ch.moving) add(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]);
  }
  return stampBlockedCells(base, cells);
}

/** Original body-overlay loop for worlds without KM1 settings. */
function tableWithBodiesLegacy(base: PassageTable, chars: CharsState): PassageTable {
  const cells: number[] = [];
  const add = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < base.width && y < base.height) {
      cells.push(y * base.width + x);
    }
  };
  for (const ch of Object.values(chars.chars)) {
    if (!ch.blocks) continue;
    add(ch.tx, ch.ty);
    if (ch.moving) add(ch.tx + DX[ch.stepDir], ch.ty + DY[ch.stepDir]);
  }
  return stampBlockedCells(base, cells);
}

/** eventTouch scratch list: ids of events in contact with the player during
 *  the current reference tick. Cleared at the start of each tick on a map
 *  with an eventTouch page and lent to the interpreter for that tick only,
 *  so detection allocates nothing. Transient: never saved or snapshotted. */
const TOUCH_CONTACTS: string[] = [];

/** The player's step from (x,y) toward `dir` was refused this tick: record
 *  every character whose blocking body holds the target cell, provided the
 *  terrain itself allows the crossing (the body, not a wall, refused it).
 *  Callers reach this only on a refused step of a non-through player. */
function notePlayerBump(
  base: PassageTable,
  chars: CharsState,
  x: number,
  y: number,
  dir: Dir4,
  settings: Readonly<Record<string, ResolvedMoveSettings>> | undefined,
  out: string[],
): void {
  if (!canStepFrom(base, x, y, dir)) return;
  const tx = x + DX[dir];
  const ty = y + DY[dir];
  for (const id in chars.chars) {
    const ch = chars.chars[id]!;
    if (charBlocksPlayer(ch, tx, ty, settings?.[ch.id]?.through === true)) out.push(ch.id);
  }
}

function motionOf(
  map: MapDef,
  sw: SwitchState,
  facing: Facing,
  extension: ExtensionScope,
  conditionContext?: ConditionContext,
): Record<string, MotionType> {
  const out = keyedRecord<MotionType>();
  for (const ev of map.events ?? []) {
    const active = activePage(ev, sw, map.id, facing, extension, conditionContext);
    if (active) out[ev.id] = active.page.moveType ?? "static";
  }
  return out;
}

function moveSettingsOf(
  map: MapDef,
  sw: SwitchState,
  facing: Facing,
  extension: ExtensionScope,
  overrides: Readonly<Record<string, EventMoveOverride>> | undefined,
  conditionContext?: ConditionContext,
): Record<string, ResolvedMoveSettings> {
  const out = keyedRecord<ResolvedMoveSettings>();
  for (const ev of map.events ?? []) {
    const active = activePage(ev, sw, map.id, facing, extension, conditionContext);
    if (!active) continue;
    const override = overrides?.[ev.id];
    out[ev.id] = resolveMoveSettings(
      active.page,
      override?.pageIndex === active.index ? override : undefined,
    );
  }
  return out;
}

/** Resolve settings from the page indexes syncPagesInPlace just committed,
 * avoiding a second activePage evaluation over the whole map. */
function moveSettingsFromSyncedChars(
  map: MapDef,
  chars: CharsState,
  overrides: Readonly<Record<string, EventMoveOverride>> | undefined,
): Record<string, ResolvedMoveSettings> {
  const out = keyedRecord<ResolvedMoveSettings>();
  for (const ev of map.events ?? []) {
    const pageIndex = chars.chars[ev.id]?.pageIndex;
    if (pageIndex === undefined) continue;
    const page = ev.pages[pageIndex];
    if (!page) continue;
    const override = overrides?.[ev.id];
    out[ev.id] = resolveMoveSettings(
      page,
      override?.pageIndex === pageIndex ? override : undefined,
    );
  }
  return out;
}

/** Drop stale overrides only after page sync has materialized the active
 *  page. A restored save begins with no CharState; its matching page-tagged
 *  override therefore survives the first reconciliation. */
function pruneEventMoveControls(s: SessionState): void {
  const controls = s.interp.moveControls;
  if (!controls) return;
  for (const id of Object.keys(controls.events)) {
    const ch = s.chars.chars[id];
    if (!ch || ch.pageIndex !== controls.events[id]!.pageIndex) {
      delete controls.events[id];
    }
  }
}

function ensureMoveControls(s: SessionState): MoveControlState {
  if (!s.interp.moveControls) s.interp.moveControls = createMoveControlState();
  return s.interp.moveControls;
}

const BUTTON_FOR_DIR = [BTN_BITS.DOWN, BTN_BITS.LEFT, BTN_BITS.UP, BTN_BITS.RIGHT] as const;
/** The d-pad portion of a button mask; a tick-direction resolver replaces
 *  only these bits on ticks 1..N-1 of a multi-tick frame. */
const TICK_DIR_MASK = BTN_BITS.UP | BTN_BITS.DOWN | BTN_BITS.LEFT | BTN_BITS.RIGHT;

function stepPlayerWander(
  s: SessionState,
  base: PassageTable,
  cfg: MovementConfig,
  settings: ResolvedMoveSettings,
  eventSettings: Readonly<Record<string, ResolvedMoveSettings>>,
): void {
  const override = ensureMoveControls(s).player;
  const pendingSpeed = settings.pendingRouteSpeed;
  const pendingRate = pendingSpeed === undefined
    ? undefined
    : settings.pendingRouteTilesPerSecond;
  const moveCfg = routeSpeedConfig(cfg, settings, pendingSpeed, pendingRate);
  const table = tableWithBodies(base, s.chars, eventSettings);
  if (s.move.moving) {
    Object.assign(s.move, stepMovement(s.move, 0, table, moveCfg, {
      through: settings.through,
      faceMovement: canFace(settings, false),
      exactTilesPerSecond: pendingRate,
    }));
    return;
  }
  if ((override.cooldown ?? 0) > 0) {
    override.cooldown = override.cooldown! - 1;
    return;
  }
  const exits: Dir4[] = [];
  for (const dir of [0, 1, 2, 3] as const) {
    const tx = s.move.tx + DX[dir];
    const ty = s.move.ty + DY[dir];
    if (!inWanderBounds(settings.bounds, tx, ty)) continue;
    const open = settings.through
      ? inMapBounds(base.width, base.height, tx, ty)
      : canStepFrom(table, s.move.tx, s.move.ty, dir);
    if (open) exits.push(dir);
  }
  override.cooldown = wanderDelay(settings);
  if (exits.length === 0) return;
  const roll = randInt(s.sw.rng, 0, exits.length - 1);
  s.sw.rng = roll.next;
  Object.assign(s.move, stepMovement(s.move, BUTTON_FOR_DIR[exits[roll.value]!]!, table, moveCfg, {
    through: settings.through,
    faceMovement: canFace(settings, false),
    exactTilesPerSecond: pendingRate,
  }));
  if (s.move.moving && pendingSpeed !== undefined) {
    delete override.routeSpeed;
    delete override.routeTilesPerSecond;
  }
}

function eventIdOf(key: string, mapId: string): string {
  const prefix = `${mapId}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function eventMoveOverride(s: SessionState, eventId: string): EventMoveOverride | null {
  const ch = s.chars.chars[eventId];
  if (!ch) return null;
  const controls = ensureMoveControls(s);
  let override = controls.events[eventId];
  if (!override || override.pageIndex !== ch.pageIndex) {
    override = { pageIndex: ch.pageIndex };
    controls.events[eventId] = override;
  }
  return override;
}

function stopPlayerRoute(s: SessionState): void {
  const route = s.playerRoute;
  if (route && route.phase > 0) {
    // Player routes keep interpolation phase on the route. Hand the
    // committed step back to the ordinary mover so stop finishes this tile
    // without a pixel jump, just like the NPC route path.
    s.move.phase = route.phase;
    s.move.stepDir = route.dir;
    s.move.moving = true;
  }
  if (route?.waiter) s.interp = continueExternal(s.interp, route.waiter);
  s.playerRoute = null;
  s.move.walking = false;
}

/** Apply one command/route control at the session boundary. Missing map
 *  events are a no-op, matching moveRoute target resolution. */
function applyTargetMoveControl(
  s: SessionState,
  target: "player" | { event: string },
  control: MoveControl,
): void {
  if (target === "player") {
    applyMoveControl(ensureMoveControls(s).player, control);
    if (control.kind === "stop") stopPlayerRoute(s);
    else if (control.kind === "routeSpeed" && s.playerRoute) {
      // Latch onto the running route; nothing stays pending for later routes.
      s.playerRoute.speed = control.value;
      if (control.tilesPerSecond === undefined) delete s.playerRoute.tilesPerSecond;
      else s.playerRoute.tilesPerSecond = control.tilesPerSecond;
      delete ensureMoveControls(s).player.routeSpeed;
      delete ensureMoveControls(s).player.routeTilesPerSecond;
    }
    return;
  }
  const override = eventMoveOverride(s, target.event);
  if (!override) return;
  applyMoveControl(override, control);
  if (control.kind === "wander") resetCharThinkInPlace(s.chars, target.event);
  if (control.kind === "stop") {
    const stopped = stopCharRoute(s.chars, target.event);
    s.chars = stopped.state;
    if (stopped.displacedWaiter) {
      s.interp = continueExternal(s.interp, stopped.displacedWaiter);
    }
    return;
  }
  if (control.kind === "routeSpeed") {
    // Latch onto a running forced route; otherwise the grade stays pending
    // (in the override) for the next route install to consume.
    const latched = latchRouteSpeed(s.chars, target.event, control.value, control.tilesPerSecond);
    s.chars = latched.state;
    if (latched.latched) {
      delete override.routeSpeed;
      delete override.routeTilesPerSecond;
    }
  }
}

/** Opacity the UI overlay shows on the current fade frame: 1 fully black. */
export function fadeOpacity(fade: FadeState | null): number {
  if (!fade) return 0;
  return fade.phase === "out" ? 1 - fade.left / fade.half : fade.left / fade.half;
}

const NO_MAP_INPUT: SessionInput = {
  buttons: 0,
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  leftEdge: false,
  rightEdge: false,
};

function battleInput(input: SessionInput): Readonly<BattleInput> {
  return {
    buttons: input.buttons >>> 0,
    confirmEdge: input.confirmEdge === true,
    cancelEdge: input.cancelEdge === true,
    upEdge: input.upEdge === true,
    downEdge: input.downEdge === true,
  };
}

/** KG1: scene input adds the horizontal edges name-input grids navigate
 *  with; battle scenes receive the battleInput subset instead. */
function sceneInput(input: SessionInput): Readonly<SceneInput> {
  const out: SceneInput = {
    ...battleInput(input),
    leftEdge: input.leftEdge === true,
    rightEdge: input.rightEdge === true,
  };
  // Avoid allocating an empty conditional-spread object on every active
  // scene frame in projects that never use direct pointer selection.
  if (input.selectIndex !== undefined) out.selectIndex = input.selectIndex;
  return out;
}

/** Validate and compile the game-owned BattleStart.audio contract. undefined
 * preserves the current audio state; null requests battle silence. */
function battleAudioState(value: unknown): AudioState | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("battle start audio: object with bgm required");
  }
  const audio = value as Record<string, unknown>;
  if (!("bgm" in audio)) {
    throw new Error("battle start audio: bgm required");
  }
  if (audio.bgm === null) return null;
  if (typeof audio.bgm !== "object" || Array.isArray(audio.bgm)) {
    throw new Error("battle start audio.bgm: track object or null required");
  }
  const bgm = audio.bgm as Record<string, unknown>;
  if (typeof bgm.id !== "string" || bgm.id.length === 0) {
    throw new Error("battle start audio.bgm.id: non-empty string required");
  }
  const volume = bgm.volume ?? 100;
  if (!Number.isInteger(volume) || (volume as number) < 0 || (volume as number) > 100) {
    throw new Error("battle start audio.bgm.volume: integer 0..100 required");
  }
  const pitch = bgm.pitch ?? 100;
  if (!Number.isInteger(pitch) || (pitch as number) < 50 || (pitch as number) > 150) {
    throw new Error("battle start audio.bgm.pitch: integer 50..150 required");
  }
  return {
    bgm: {
      id: bgm.id,
      volume: volume as number,
      pitch: pitch as number,
      positionTicks: 0,
    },
  };
}

/** Consume one queued Battle Processing request. One draw
 * from the session cursor derives an isolated u32 seed even when start()
 * declines the encounter; no game rule may read wall time or global RNG.
 * The caller guarantees there is no active scene; violating that invariant
 * is an engine programming error, never a project-content path. A malformed
 * BattleRules.start return is likewise a registered game-code contract
 * violation and intentionally throws. */
function startBattleScene(sess: Session, s: SessionState, request: PendingBattle): boolean {
  if (s.scene !== null) {
    throw new Error("battle queue invariant: cannot start while a scene is active");
  }
  const rules = sess.battle;
  if (!rules) throw new Error("battle queue invariant: no BattleRules registered");
  const draw = rngNext(s.interp.sw.rng);
  s.interp.sw.rng = draw.next;
  s.sw = s.interp.sw;
  const seed = Math.floor(draw.value * 4294967296) >>> 0;
  const startExt = cloneExtension(sess.extensions, s.ext);
  const started = rules.start(
    startExt,
    deepClone(request.setup),
    seed,
    {
      ext: cloneExtension(sess.extensions, s.ext),
      switches: keyedRecord(s.interp.sw.switches),
      variables: keyedRecord(s.interp.sw.variables),
      items: keyedRecord(s.interp.sw.items),
      gold: s.interp.sw.gold,
      playerName: s.interp.sw.playerName,
      ...(s.interp.sw.playerAppearance
        ? { playerAppearance: s.interp.sw.playerAppearance }
        : {}),
    },
  );
  if (started === null) {
    s.interp = continueExternal(s.interp, request.fiber);
    s.sw = s.interp.sw;
    return false;
  }
  if (typeof started !== "object" || Array.isArray(started)) {
    throw new Error("battle start: BattleStart object or null required");
  }
  if (rules.immutableState) assertImmutableJsonValue(started.state, "battle start state");
  else assertJsonValue(started.state, "battle start state");
  const battleAudio = battleAudioState(started.audio);
  const returnAudio = battleAudio === undefined
    ? undefined
    : s.interp.audio
      ? cloneAudioState(s.interp.audio)
      : null;
  s.ext = cloneExtension(sess.extensions, started.ext, "battle start extension state");
  if (battleAudio !== undefined) {
    if (battleAudio === null) delete s.interp.audio;
    else s.interp.audio = battleAudio;
  }
  s.scene = {
    kind: "battle",
    fiber: request.fiber,
    state: rules.immutableState ? started.state : deepClone(started.state),
    pausedTicks: 0,
    ...(returnAudio !== undefined ? { returnAudio } : {}),
  };
  return true;
}

/** Start queued requests only while the scene slot is free. Null encounters
 * resume immediately and do not delay the next request; a real scene leaves
 * the remaining FIFO intact for a later reference tick. A canceled parallel
 * has no fiber to resume, so its stale request is discarded as content data
 * rather than ever reaching the rules callback. */
function startNextBattleScene(sess: Session, s: SessionState): void {
  while (s.scene === null && s.interp.pendingBattles.length > 0) {
    const request = s.interp.pendingBattles.shift()!;
    if (!fiberIsExternal(s.interp, request.fiber)) continue;
    if (startBattleScene(sess, s, request)) return;
  }
}

/** KG1: consume one queued game-scene request. Same lifecycle as a battle
 *  scene: one RNG draw seeds start(), a null result resumes the fiber
 *  without consuming the slot, and stale requests from canceled parallel
 *  fibers are discarded as content data. */
function startGameScene(sess: Session, s: SessionState, request: PendingScene): boolean {
  if (s.scene !== null) {
    throw new Error("scene queue invariant: cannot start while a scene is active");
  }
  const rules = sess.scenes[request.id];
  if (!rules) {
    throw new Error(`scene queue invariant: no SceneRules registered for ${JSON.stringify(request.id)}`);
  }
  const draw = rngNext(s.interp.sw.rng);
  s.interp.sw.rng = draw.next;
  s.sw = s.interp.sw;
  const seed = Math.floor(draw.value * 4294967296) >>> 0;
  const startExt = cloneExtension(sess.extensions, s.ext);
  const started = rules.start(
    startExt,
    deepClone(request.args),
    seed,
    {
      ext: cloneExtension(sess.extensions, s.ext),
      switches: keyedRecord(s.interp.sw.switches),
      variables: keyedRecord(s.interp.sw.variables),
      items: keyedRecord(s.interp.sw.items),
      gold: s.interp.sw.gold,
      playerName: s.interp.sw.playerName,
      itemCatalog: sess.worldOptions.items,
    },
  );
  if (started === null) {
    s.interp = continueExternal(s.interp, request.fiber);
    s.sw = s.interp.sw;
    return false;
  }
  if (typeof started !== "object" || Array.isArray(started)) {
    throw new Error("scene start: SceneStart object or null required");
  }
  assertJsonValue(started.state, "scene start state");
  s.ext = cloneExtension(sess.extensions, started.ext, "scene start extension state");
  s.scene = {
    kind: "scene",
    id: request.id,
    fiber: request.fiber,
    state: deepClone(started.state),
    pausedTicks: 0,
  };
  return true;
}

function startNextGameScene(sess: Session, s: SessionState): void {
  while (s.scene === null && (s.interp.pendingScenes?.length ?? 0) > 0) {
    const request = s.interp.pendingScenes!.shift()!;
    if (!fiberIsExternal(s.interp, request.fiber)) continue;
    if (startGameScene(sess, s, request)) return;
  }
}

/** KG1: advance the game-owned scene reducer once for this host frame, then
 *  atomically commit a terminal result. The commit body mirrors
 *  advanceBattleScene (ext/writes/switches/items/gold/transfer plus the
 *  pausedTicks clock shift) with playerName added; cancelled completions
 *  commit nothing and run onCancel. Invalid return shapes are registered
 *  SceneRules programming errors and intentionally throw. */
function advanceGameScene(
  sess: Session,
  s: SessionState,
  input: Readonly<SceneInput>,
  ticks: number,
  frozenShared = false,
): void {
  const scene = s.scene;
  if (!scene || scene.kind !== "scene") return;
  const rules = sess.scenes[scene.id];
  if (!rules) return;
  if (ticks > 0) {
    const stepped = rules.step(deepClone(scene.state), input, ticks);
    assertJsonValue(stepped, "scene step state");
    scene.state = deepClone(stepped);
  }
  const completion = rules.done(deepClone(scene.state));
  if (completion === null) return;
  if (typeof completion !== "object" || Array.isArray(completion)) {
    throw new Error("scene done: SceneCompletion object or null required");
  }
  const cancelled = completion.cancelled === true;
  let nextExt = s.ext;
  if (!cancelled && completion.ext !== undefined) {
    nextExt = cloneExtension(sess.extensions, completion.ext, "scene completion extension state");
  }
  const writes: [string, string | number][] = [];
  const switches: [string, boolean][] = [];
  if (!cancelled && completion.writes !== undefined) {
    if (completion.writes === null || typeof completion.writes !== "object" || Array.isArray(completion.writes)) {
      throw new Error("scene completion writes must be a record");
    }
    for (const id of Object.keys(completion.writes)) {
      const value = completion.writes[id];
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`scene completion write ${JSON.stringify(id)} must be a string or finite number`);
      }
      writes.push([id, value]);
    }
  }
  if (!cancelled && completion.switches !== undefined) {
    if (completion.switches === null || typeof completion.switches !== "object" || Array.isArray(completion.switches)) {
      throw new Error("scene completion switches must be a record");
    }
    for (const id of Object.keys(completion.switches)) {
      const value = completion.switches[id];
      if (typeof value !== "boolean") {
        throw new Error(`scene completion switch ${JSON.stringify(id)} must be a boolean`);
      }
      switches.push([id, value]);
    }
  }
  let itemReplacements: Record<string, number> | undefined;
  if (!cancelled && completion.items !== undefined) {
    if (completion.items === null || typeof completion.items !== "object" || Array.isArray(completion.items)) {
      throw new Error("scene completion items must be a record");
    }
    itemReplacements = keyedRecord();
    for (const id of Object.keys(completion.items)) {
      const value = completion.items[id];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`scene completion item ${JSON.stringify(id)} must be a finite number`);
      }
      itemReplacements[id] = value;
    }
  }
  let gold: number | undefined;
  if (!cancelled && completion.gold !== undefined) {
    if (typeof completion.gold !== "number" || !Number.isFinite(completion.gold)) {
      throw new Error("scene completion gold must be a finite number");
    }
    gold = Math.max(0, clampFiniteVar(completion.gold));
  }
  let playerName: string | undefined;
  if (!cancelled && completion.playerName !== undefined) {
    if (
      typeof completion.playerName !== "string" ||
      completion.playerName.length === 0 ||
      completion.playerName.length > 24
    ) {
      throw new Error("scene completion playerName must be a string of length 1..24");
    }
    playerName = completion.playerName;
  }
  const transfer = cancelled ? null : completionTransfer(completion.transfer);
  const items = itemReplacements === undefined
    ? undefined
    : replaceItemCounts(s.interp.sw.items, itemReplacements, sess.worldOptions.inventory);

  // A frozen scene frame starts from a shallow interpreter shell so ticking
  // the scene can avoid cloning a world it cannot advance. Completion is the
  // first point that writes banks or resumes/shifts parked fibers, so detach
  // the shell here before committing anything. This mirrors battle scenes
  // and preserves every previously returned immutable snapshot.
  if (frozenShared) {
    s.interp = shareInterp(s.interp, sess.immutableState);
    s.sw = s.interp.sw;
  }
  s.ext = nextExt;
  const variables = writes.length > 0 ? ownRecord(s.interp.sw, "variables") : null;
  for (const [id, value] of writes) {
    variables![id] = typeof value === "number" ? clampFiniteVar(value) : value;
  }
  const switchBank = switches.length > 0 ? ownRecord(s.interp.sw, "switches") : null;
  for (const [id, value] of switches) switchBank![id] = value;
  if (items !== undefined) s.interp.sw.items = items;
  if (gold !== undefined) s.interp.sw.gold = gold;
  if (playerName !== undefined) s.interp.sw.playerName = playerName;
  if (scene.pausedTicks > 0) {
    const shift = (fiber: SessionState["interp"]["main"]): void => {
      if (
        fiber?.mode === "wait" ||
        fiber?.mode === "text" ||
        fiber?.mode === "animWait"
      ) {
        fiber.since += scene.pausedTicks;
      }
    };
    shift(s.interp.main);
    for (const fiber of Object.values(s.interp.parallels)) shift(fiber);
    // Same clock-shift rationale as advanceBattleScene: absolute map
    // animation starts move by the paused duration so playback resumes from
    // the same visual frame.
    const anims = s.interp.anims;
    if (anims !== undefined) {
      s.interp.anims = anims.map((a) => ({ ...a, start: a.start + scene.pausedTicks }));
    }
  }
  s.interp = continueScene(s.interp, scene.fiber, cancelled, transfer);
  s.sw = s.interp.sw;
  s.scene = null;
}

/** Advance only the interpreter's absolute reference clock. The elapsed
 * pause is retained on the scene and applied to relative fiber clocks on
 * completion, leaving the fibers themselves byte-stable while frozen. */
function tickFrozenWorld(s: SessionState): void {
  advanceInterpAudioInPlace(s.interp);
  s.interp.frame++;
  if (s.scene) s.scene.pausedTicks++;
  s.interp.cues = [];
  s.interp.pendingMoveRoutes = [];
  s.interp.pendingPlacements = [];
  s.interp.abortedRoutes = [];
}

function completionTransfer(value: unknown): Omit<import("./interpreter.ts").PendingTransfer, "fiber"> | null {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("battle completion transfer must be an object");
  }
  const transfer = value as Record<string, unknown>;
  if (typeof transfer.map !== "string" || transfer.map.length === 0) {
    throw new Error("battle completion transfer.map must be a non-empty string");
  }
  if (!Number.isInteger(transfer.x) || (transfer.x as number) < 0 ||
    !Number.isInteger(transfer.y) || (transfer.y as number) < 0) {
    throw new Error("battle completion transfer coordinates must be non-negative integers");
  }
  const dir = transfer.dir ?? "keep";
  if (dir !== "keep" && dir !== "down" && dir !== "left" && dir !== "up" && dir !== "right") {
    throw new Error("battle completion transfer.dir is invalid");
  }
  const fade = transfer.fade ?? 0;
  if (typeof fade !== "number" || !Number.isFinite(fade) || fade < 0) {
    throw new Error("battle completion transfer.fade must be a non-negative finite number");
  }
  return {
    map: transfer.map,
    x: transfer.x as number,
    y: transfer.y as number,
    dir,
    fadeFrames: secondsToFrames(fade, MOTION_HZ),
  };
}

/** Advance the game-owned battle reducer once for this host frame, then
 * atomically commit a terminal result. Result commands run before an optional
 * completion transfer; continueBattle installs both on the parked fiber.
 * Invalid step/done return shapes are registered BattleRules programming
 * errors and intentionally throw; authored event operands never reach these
 * assertions. */
function advanceBattleScene(
  sess: Session,
  s: SessionState,
  input: Readonly<BattleInput>,
  ticks: number,
  frozenShared = false,
): void {
  const scene = s.scene;
  const rules = sess.battle;
  if (!scene || scene.kind !== "battle" || !rules) return;
  if (ticks > 0) {
    // stepSession already cloned the scene for this frame, so the rules own
    // an isolated working value even if an implementation mutates its input
    // despite the pure-reducer contract. Cloning again before and after the
    // call only traversed large battle payloads without adding isolation.
    const stepped = rules.step(scene.state, input, ticks);
    if (rules.immutableState) assertImmutableJsonValue(stepped, "battle step state");
    else assertJsonValue(stepped, "battle step state");
    scene.state = stepped;
  }
  const completion = rules.done(scene.state);
  if (completion === null) return;
  if (typeof completion !== "object" || Array.isArray(completion)) {
    throw new Error("battle done: BattleCompletion object or null required");
  }
  if (
    completion.result !== "win" && completion.result !== "lose" &&
    completion.result !== "escape" && completion.result !== "draw"
  ) {
    throw new Error("battle done: result must be win, lose, escape, or draw");
  }
  const nextExt = cloneExtension(sess.extensions, completion.ext, "battle completion extension state");
  const writes: [string, string | number][] = [];
  const switches: [string, boolean][] = [];
  if (completion.writes !== undefined) {
    if (completion.writes === null || typeof completion.writes !== "object" || Array.isArray(completion.writes)) {
      throw new Error("battle completion writes must be a record");
    }
    for (const id of Object.keys(completion.writes)) {
      const value = completion.writes[id];
      if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) {
        throw new Error(`battle completion write ${JSON.stringify(id)} must be a string or finite number`);
      }
      writes.push([id, value]);
    }
  }
  if (completion.switches !== undefined) {
    if (completion.switches === null || typeof completion.switches !== "object" || Array.isArray(completion.switches)) {
      throw new Error("battle completion switches must be a record");
    }
    for (const id of Object.keys(completion.switches)) {
      const value = completion.switches[id];
      if (typeof value !== "boolean") {
        throw new Error(`battle completion switch ${JSON.stringify(id)} must be a boolean`);
      }
      switches.push([id, value]);
    }
  }
  let itemReplacements: Record<string, number> | undefined;
  if (completion.items !== undefined) {
    if (completion.items === null || typeof completion.items !== "object" || Array.isArray(completion.items)) {
      throw new Error("battle completion items must be a record");
    }
    itemReplacements = keyedRecord();
    for (const id of Object.keys(completion.items)) {
      const value = completion.items[id];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`battle completion item ${JSON.stringify(id)} must be a finite number`);
      }
      itemReplacements[id] = value;
    }
  }
  let gold: number | undefined;
  if (completion.gold !== undefined) {
    if (typeof completion.gold !== "number" || !Number.isFinite(completion.gold)) {
      throw new Error("battle completion gold must be a finite number");
    }
    gold = Math.max(0, clampFiniteVar(completion.gold));
  }
  const transfer = completionTransfer(completion.transfer);
  const items = itemReplacements === undefined
    ? undefined
    : replaceItemCounts(s.interp.sw.items, itemReplacements, sess.worldOptions.inventory);

  if (frozenShared) {
    s.interp = shareInterp(s.interp, sess.immutableState);
    s.sw = s.interp.sw;
  }
  s.ext = nextExt;
  // B1 (fix 3): a battle completion's numeric write shares
  // the interpreter's finite-safe-integer normalizer, same as an ext
  // command's writes and every authored variable/gold/item command.
  const variables = writes.length > 0 ? ownRecord(s.interp.sw, "variables") : null;
  for (const [id, value] of writes) {
    variables![id] = typeof value === "number" ? clampFiniteVar(value) : value;
  }
  const switchBank = switches.length > 0 ? ownRecord(s.interp.sw, "switches") : null;
  for (const [id, value] of switches) switchBank![id] = value;
  if (items !== undefined) s.interp.sw.items = items;
  if (gold !== undefined) s.interp.sw.gold = gold;
  if (scene.pausedTicks > 0) {
    const shift = (fiber: SessionState["interp"]["main"]): void => {
      if (
        fiber?.mode === "wait" ||
        fiber?.mode === "text" ||
        fiber?.mode === "animWait" ||
        fiber?.mode === "screenWait"
      ) {
        fiber.since += scene.pausedTicks;
      }
    };
    shift(s.interp.main);
    for (const fiber of Object.values(s.interp.parallels)) shift(fiber);
    // Map animation clocks are absolute (instance.start against interp.frame).
    // A default-frozen scene advances the reference clock but not the world,
    // so without this shift a hidden animation would burn frames (and a
    // looping one could finish) behind the battle. Shift every live start by
    // the paused duration so playback resumes from the same visual frame.
    // The array is copy-on-write (shared with the previous state), so the
    // shift writes a fresh array of fresh instances. An explicit
    // worldContinues scene never freezes the world and needs no shift.
    const anims = s.interp.anims;
    if (anims !== undefined) {
      s.interp.anims = anims.map((a) => ({ ...a, start: a.start + scene.pausedTicks }));
    }
  }
  // Battle-owned audio is a presentation scene resource, but its intent is
  // reducer state. Restore it before resuming the parked branch so the
  // completion is one atomic state transition (including instant battles).
  if (scene.returnAudio !== undefined) {
    if (scene.returnAudio === null) delete s.interp.audio;
    else s.interp.audio = cloneAudioState(scene.returnAudio);
  }
  s.interp = continueBattle(s.interp, scene.fiber, completion.result, transfer);
  s.sw = s.interp.sw;
  s.scene = null;
}

/** Per-reference-tick direction resolver for a view-local walking route
 *  (GameView tap-to-walk). Called after a tick with the post-tick state,
 *  returns the d-pad bit to hold on the NEXT reference tick (0 to stop).
 *  The route itself stays view-local: the reducer only calls the resolver
 *  and folds its bit, so saves, rewind and attract tapes never see it. */
export type SessionTickDirection = (state: SessionState) => number;

/** One host virtual frame. The fold runs on the fixed MOTION_HZ reference:
 *  every host frame folds MOTION_HZ/hz reference ticks — two at 30 Hz,
 *  three at 20 Hz, fifteen at 4 Hz. Motion, waits, text and fades are
 *  therefore functions of virtual time and agree at every host rate. Input
 *  edges are one host frame wide and are delivered only on the FIRST
 *  reference tick of a batch; the remaining ticks reuse the held button
 *  mask with no edges. Pure: returns a NEW SessionState.
 *
 *  `tickDirection` advances a view-local walking route at reference-tick
 *  boundaries: it is called after every tick but the frame's last with the
 *  post-tick state, and its bit REPLACES the d-pad portion of the next
 *  tick's buttons (the frame input already carries the first tick's bit).
 *  On a 60 Hz host the batch is one tick, so the resolver is never called
 *  and the path is byte-identical to a session without one. */
export function stepSession(
  sess: Session,
  s0: SessionState,
  input: SessionInput,
  effects?: SessionEffectSink,
  tickDirection?: SessionTickDirection,
): SessionState {
  if (!sess.immutableState) return foldSession(sess, s0, input, effects, tickDirection);
  const metadata = beginStateMetadata();
  try {
    return foldSession(sess, s0, input, effects, tickDirection);
  } finally {
    endStateMetadata(metadata);
  }
}

function foldSession(
  sess: Session,
  s0: SessionState,
  input: SessionInput,
  effects?: SessionEffectSink,
  tickDirection?: SessionTickDirection,
): SessionState {
  // One working copy per frame. The reference ticks below advance it in
  // place; characters and switch records stay shared with s0 until written.
  const frozen = s0.scene !== null && !sess.sceneOptions.worldContinues;
  const interp = frozen
    ? {
        ...s0.interp,
        // Frozen scenes still advance the global timer. Give that sparse
        // top-level field a private bank shell while retaining the large
        // immutable records by identity.
        sw: { ...s0.interp.sw },
        ...(s0.interp.audio ? { audio: cloneAudioState(s0.interp.audio) } : {}),
      }
    : shareInterp(s0.interp, sess.immutableState);
  // Host requests are one-frame outputs. A frozen scene or transfer fade
  // may not enter the interpreter path that normally clears them.
  delete interp.hostActions;
  const s: SessionState = {
    frame: s0.frame,
    mapId: s0.mapId,
    sw: interp.sw,
    move: { ...s0.move },
    chars: frozen ? s0.chars : shareChars(s0.chars, sess.immutableState),
    interp,
    fade: s0.fade ? { ...s0.fade } : null,
    playerRoute: s0.playerRoute
      ? {
          ...s0.playerRoute,
          steps: [...s0.playerRoute.steps],
          plan: s0.playerRoute.plan
            ? {
                ...s0.playerRoute.plan,
                dirs: [...s0.playerRoute.plan.dirs],
                search: clonePathSearch(s0.playerRoute.plan.search),
                approach: s0.playerRoute.plan.approach
                  ? { ...s0.playerRoute.plan.approach }
                  : null,
              }
            : null,
        }
      : null,
    ext: frozen ? s0.ext : cloneExtension(sess.extensions, s0.ext),
    scene: cloneScene(s0.scene, sess.battle?.immutableState),
  };
  if (s0.handoff !== undefined) s.handoff = { ...s0.handoff };
  // Immutable once created: shared by reference across folds.
  if (s0.leftMap !== undefined) s.leftMap = s0.leftMap;
  // Sparse: projects that never defer an autosave retain their historical
  // SessionState shape. Rewind keyframes keep the bit with the reducer state.
  if (s0.pendingAutosave === true) s.pendingAutosave = true;
  s.frame++;
  const ticks = sess.ticksPerFrame;
  const sceneAtFrameStart = s.scene !== null;
  let sceneStartedAt = sceneAtFrameStart ? 0 : -1;
  let frameCues: SoundCue[] | undefined;
  let frameHostActions: HostAction[] | undefined;

  let prevCell = { x: s.move.tx, y: s.move.ty };
  // The d-pad bit a view-local walking route resolved for this tick. Tick 0
  // folds the frame input unchanged; ticks 1..N-1 replace ONLY the d-pad
  // portion, so a turn resolved mid-frame takes effect at the next tile.
  let nextDir = 0;
  for (let tick = 0; tick < ticks; tick++) {
    const tickInput: SessionInput = s.scene
      ? NO_MAP_INPUT
      : tick === 0
        ? input
        : tickDirection
          ? { buttons: (input.buttons & ~TICK_DIR_MASK) | nextDir, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false }
          : { buttons: input.buttons, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };
    const hadScene = s.scene !== null;
    const tickResult = stepReferenceTick(sess, s, tickInput, prevCell);
    prevCell = tickResult;
    if (sess.audioCues && tickResult.cues) {
      if (frameCues === undefined) frameCues = tickResult.cues;
      else frameCues.push(...tickResult.cues);
    }
    const pendingBeforeTick = s.pendingAutosave === true;
    const tickHostActions = tickResult.hostActions;
    const requestedAutosave = tickHostActions?.includes("autosave") === true;
    if (requestedAutosave) s.pendingAutosave = true;
    let autosaveSnapshot: SaveSnapshot | null = null;
    if (s.pendingAutosave === true) {
      if (effects === undefined) {
        // A hostless fold (including attract rewind/refold) performs no I/O.
        // Drop the request only when this reference tick could have fulfilled
        // it, so the reducer timeline remains independent of host rate.
        if (canAutosaveSessionSnapshot(s)) delete s.pendingAutosave;
      } else {
        autosaveSnapshot = createAutosaveSessionSnapshot(sess, s, tickInput.buttons);
        if (autosaveSnapshot !== null) delete s.pendingAutosave;
      }
    }
    if (tickHostActions) {
      if (frameHostActions === undefined) frameHostActions = tickHostActions;
      else frameHostActions.push(...tickHostActions);
    }
    if (effects) {
      let autosavePublished = false;
      // A request from an earlier tick precedes this tick's authored effects.
      if (pendingBeforeTick && autosaveSnapshot !== null) {
        effects.publish({ action: "autosave", snapshot: autosaveSnapshot });
        autosavePublished = true;
      }
      for (const action of tickHostActions ?? []) {
        if (action === "autosave") {
          // A delayed request and every request encountered while it waited
          // coalesce into one host write at the first resumable tick.
          if (!autosavePublished && autosaveSnapshot !== null) {
            effects.publish({ action, snapshot: autosaveSnapshot });
            autosavePublished = true;
          }
        } else {
          effects.publish({ action });
        }
      }
    }
    if (!hadScene && s.scene !== null && sceneStartedAt < 0) sceneStartedAt = tick + 1;
    // A fatalized interpreter freezes the playfield for the rest of the
    // batch (review 1274 B1): reference clock keeps advancing, the fold
    // does not.
    if (s.interp.error) break;
    // The route resolver advances at the reference-tick boundary; its bit
    // replaces the d-pad on the next tick. Skipped after the frame's last
    // tick: the next frame's fold carries its own first-tick bit.
    if (tickDirection && tick + 1 < ticks) nextDir = tickDirection(s) | 0;
  }
  if (s.scene) {
    const sceneTicks = sceneAtFrameStart ? ticks : Math.max(0, ticks - sceneStartedAt);
    if (s.scene.kind === "battle") {
      advanceBattleScene(
        sess,
        s,
        sceneAtFrameStart ? battleInput(input) : battleInput(NO_MAP_INPUT),
        sceneTicks,
        frozen,
      );
    } else {
      advanceGameScene(
        sess,
        s,
        sceneAtFrameStart ? sceneInput(input) : sceneInput(NO_MAP_INPUT),
        sceneTicks,
        frozen,
      );
    }
  }
  if (sess.audioCues && frameCues !== undefined) s.interp.cues = frameCues;
  if (frameHostActions !== undefined) s.interp.hostActions = frameHostActions;
  else delete s.interp.hostActions;
  return s;
}

interface PageSyncMemo {
  signature: readonly unknown[];
  motion: Record<string, MotionType>;
  pages: Map<GameEvent, number>;
  runtime: ExtensionRuntime;
}

interface EntryPageMemo {
  dependencies: EntryPageDependencies;
  signature: readonly unknown[];
  chars: CharsState;
  motion: Record<string, MotionType>;
  pages: readonly number[];
  runtime: ExtensionRuntime;
}

interface EntryPageDependencies {
  switches: readonly string[];
  self: readonly string[];
  variables: readonly string[];
  items: readonly string[];
  gold: boolean;
  facing: boolean;
  playerAppearance: boolean;
  worldIdle: boolean;
  playerMoving: boolean;
  bgm: boolean;
  timer: boolean;
  extension: readonly { call: string; args: JsonValue }[];
}

const pageSyncMemo = new WeakMap<World, PageSyncMemo>();
const pageCacheability = new WeakMap<World, boolean>();
const ENTRY_PAGE_MEMO_LIMIT = 16;
// Layered and legacy releases may both discard the parsed MapDef. Scope a
// small map-id cache to the Session instead: project/runtime identity cannot
// leak across sessions, and the weak outer key lets the whole cache die with
// its owner. Values are validated against freshly selected page indices
// before reuse, so extension handlers retain their complete live context.
const entryPageMemos = new WeakMap<Session, Map<string, EntryPageMemo>>();

function entryPageMemoFor(sess: Session, mapId: string): EntryPageMemo | undefined {
  const cache = entryPageMemos.get(sess);
  const memo = cache?.get(mapId);
  if (memo !== undefined) {
    // Refresh insertion order for deterministic LRU eviction.
    cache!.delete(mapId);
    cache!.set(mapId, memo);
  }
  return memo;
}

function rememberEntryPages(sess: Session, mapId: string, memo: EntryPageMemo): void {
  let cache = entryPageMemos.get(sess);
  if (cache === undefined) {
    cache = new Map();
    entryPageMemos.set(sess, cache);
  }
  cache.delete(mapId);
  cache.set(mapId, memo);
  if (cache.size > ENTRY_PAGE_MEMO_LIMIT) cache.delete(cache.keys().next().value!);
}

function entryPageDependencies(world: World): EntryPageDependencies {
  const switches = new Set<string>();
  const self = new Set<string>();
  const variables = new Set<string>();
  const items = new Set<string>();
  let gold = false;
  let facing = false;
  let playerAppearance = false;
  let worldIdle = false;
  let playerMoving = false;
  let bgm = false;
  let timer = false;
  const extension: { call: string; args: JsonValue }[] = [];
  for (const { ev, key } of keyedEventsOf(world).events) {
    for (const page of ev.pages) {
      const condition = page.condition;
      if (!condition) continue;
      if (condition.switch !== undefined) switches.add(condition.switch);
      if (condition.selfSwitch !== undefined) self.add(key);
      if (condition.variable !== undefined) variables.add(condition.variable.id);
      if (condition.item !== undefined) items.add(condition.item);
      for (const clause of condition.all ?? []) {
        switch (clause.kind) {
          case "switch": switches.add(clause.id); break;
          case "selfSwitch": self.add(key); break;
          case "variable": variables.add(clause.id); break;
          case "item": items.add(clause.id); break;
          case "gold": gold = true; break;
          case "facing": facing = true; break;
          case "appearance":
            if (clause.target === "player") playerAppearance = true;
            break;
          case "worldIdle": worldIdle = true; break;
          case "playerMoving": playerMoving = true; break;
          case "bgmPlaying": bgm = true; break;
          case "timer": timer = true; break;
          case "ext": extension.push({ call: clause.call, args: clause.args }); break;
          case "tileProperty": break;
        }
      }
    }
  }
  return {
    switches: [...switches], self: [...self], variables: [...variables], items: [...items],
    gold, facing, playerAppearance, worldIdle, playerMoving, bgm, timer, extension,
  };
}

function entryPageSignature(
  s: SessionState,
  worldIdle: boolean,
  runtime: ExtensionRuntime,
  dependencies: EntryPageDependencies,
): readonly unknown[] | undefined {
  if (dependencies.extension.length > 0 && runtime.entryConditionCacheKey === null) return undefined;
  const signature: unknown[] = [];
  for (const id of dependencies.switches) signature.push(s.sw.switches[id] ?? false);
  for (const key of dependencies.self) signature.push(s.sw.self[key]);
  for (const id of dependencies.variables) signature.push(s.sw.variables[id] ?? 0);
  for (const id of dependencies.items) signature.push(s.sw.items[id] ?? 0);
  if (dependencies.gold) signature.push(s.sw.gold);
  if (dependencies.facing) signature.push(s.move.facing);
  // The effective sprite (effectivePlayerAppearance) without allocating.
  if (dependencies.playerAppearance) {
    signature.push(s.sw.playerAppearance?.sprite ?? s.sw.playerAppearance?.defaultSprite ?? null);
  }
  if (dependencies.worldIdle) signature.push(worldIdle);
  if (dependencies.playerMoving) signature.push(s.move.moving);
  if (dependencies.bgm) {
    signature.push(s.interp.audio?.bgm?.id, s.interp.audio?.bgm?.paused === true,
      s.interp.audio?.me !== undefined);
  }
  if (dependencies.timer) {
    signature.push(s.sw.timer === undefined ? undefined : timerSeconds(s.sw.timer));
  }
  if (dependencies.extension.length > 0) {
    const context = {
      ext: s.ext,
      switches: s.sw.switches,
      variables: s.sw.variables,
      items: s.sw.items,
      gold: s.sw.gold,
      playerName: s.sw.playerName,
    };
    for (const condition of dependencies.extension) {
      signature.push(runtime.entryConditionCacheKey!(context, condition.call, condition.args));
    }
  }
  return signature;
}

/** Page reconciliation is cacheable when every extension condition accepts
 * the immutable/deterministic contract. Contextual built-ins are represented
 * explicitly in pageSyncSignature below. */
function canCachePages(world: World): boolean {
  const previous = pageCacheability.get(world);
  if (previous !== undefined) return previous;
  let cacheable = true;
  for (const event of world.map.events ?? []) {
    for (const page of event.pages) {
      for (const clause of page.condition?.all ?? []) {
        if (clause.kind === "ext" &&
            (!world.extensions.immutableConditions || !world.extensions.deterministicConditions)) {
          cacheable = false;
          break;
        }
      }
      if (!cacheable) break;
    }
    if (!cacheable) break;
  }
  pageCacheability.set(world, cacheable);
  return cacheable;
}

function pageSyncSignature(
  s: SessionState,
  worldIdle: boolean,
  extensions: ExtensionRuntime,
  playerMoving?: boolean,
): readonly unknown[] {
  const signature: unknown[] = [
    recordRevision(s.sw.switches),
    recordRevision(s.sw.self),
    recordRevision(s.sw.variables),
    recordRevision(s.sw.items),
    s.sw.gold,
    s.sw.playerName,
    s.sw.timer === undefined ? undefined : timerSeconds(s.sw.timer),
    extensionConditionCacheKey(extensions, s.ext),
    recordRevision(s.interp.erased),
    recordRevision(s.interp.placements),
    s.move.facing,
    worldIdle,
    charsPageRevision(s.chars),
    s.interp.eventAppearances === undefined
      ? undefined
      : JSON.stringify(s.interp.eventAppearances),
    s.sw.playerAppearance?.sprite ?? s.sw.playerAppearance?.defaultSprite ?? null,
    s.interp.tileProperties === undefined
      ? undefined
      : JSON.stringify(s.interp.tileProperties),
    s.interp.audio?.bgm?.id,
    s.interp.audio?.bgm?.paused === true,
    s.interp.audio?.me !== undefined,
  ];
  // Keep this outside the fixed signature: ordinary projects retain the
  // pre-feature memo shape and avoid a movement dependency altogether.
  if (playerMoving !== undefined) signature.push(playerMoving);
  return signature;
}

function sameSignature(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const displacedCellMemo = new WeakMap<
  MapDef,
  RecentStateMetadata<object, Record<string, { x: number; y: number }>>
>();

/** The cells of event characters that moved off their authored cell this
 *  tick, keyed by event id. The interpreter resolves an event's live
 *  position from this record over its authored (x,y): a character that
 *  walked back onto its authored cell drops out of the record, and
 *  eventOrigin then reads the authored cell — which IS its live cell —
 *  instead of a stale durable placement. Memoized per position revision in
 *  immutable mode, so a static map allocates nothing per tick. */
function displacedCells(
  map: MapDef,
  chars: CharsState,
  immutable: boolean,
): Record<string, { x: number; y: number }> {
  let byPosition = immutable ? displacedCellMemo.get(map) : undefined;
  const revision = immutable ? charsPositionRevision(chars) : undefined;
  const previous = revision ? byPosition?.get(revision) : undefined;
  if (previous) return previous;
  const cells = keyedRecord<{ x: number; y: number }>();
  for (const ev of map.events ?? []) {
    const ch = chars.chars[ev.id];
    if (ch && (ch.tx !== ev.x || ch.ty !== ev.y)) cells[ev.id] = { x: ch.tx, y: ch.ty };
  }
  if (revision) {
    if (!byPosition) {
      byPosition = new RecentStateMetadata();
      displacedCellMemo.set(map, byPosition);
    }
    byPosition.set(revision, cells);
  }
  return cells;
}

function mapDimensions(sess: Session, mapId: string): { width: number; height: number } | null {
  const resident = sess.maps.get(mapId);
  if (resident) return resident;
  return sess.mapIndex?.get(mapId) ?? null;
}

/** Validate every runtime-owned part of a marked opening before publishing
 * reducer state. An accepted crossing replaces even an authored transfer
 * fade; a failed proof leaves the request intact so its complete legacy
 * timeline, including fade, remains observable. */
function tryStartSeamlessHandoff(
  sess: Session,
  s: SessionState,
  transfer: Readonly<PendingTransfer>,
): boolean {
  if (
    sess.worldTraversal !== "seamless-v1" ||
    sess.handoffResolver === null ||
    transfer.handoff?.mode !== "seamless-v1" ||
    transfer.playerTouch !== true ||
    s.handoff !== undefined ||
    s.scene !== null ||
    s.fade !== null ||
    s.move.moving ||
    s.move.phase !== 0
  ) return false;

  const source = sess.maps.get(s.mapId);
  const targetSize = mapDimensions(sess, transfer.map);
  if (!source || !targetSize) return false;
  const resolved = sess.handoffResolver.resolve({
    portalId: transfer.handoff.portalId,
    sourceMapId: s.mapId,
    targetMapId: transfer.map,
    sourceX: s.move.tx,
    sourceY: s.move.ty,
    targetX: transfer.x,
    targetY: transfer.y,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth: targetSize.width,
    targetHeight: targetSize.height,
    facing: s.move.facing,
    transferDirection: transfer.dir,
  });
  if (!resolved) return false;

  // This publishes prepared immutable data, or throws MapNotReadyError so
  // the host retries the same logical tick after repository preparation.
  acquireSessionMap(sess, transfer.map);
  // Opening eligibility is authored against immutable terrain. Runtime
  // tile-property changes belong to the current map visit and must neither
  // mint nor revoke importer-proven world topology.
  const sourcePassage = sess.tables.get(s.mapId)!;
  const targetPassage = sess.tables.get(transfer.map)!;
  if (cellBlocksExit(sourcePassage, s.move.tx, s.move.ty, resolved.direction)) return false;
  const entry = OPPOSITE_DIR[resolved.direction];
  if (resolved.movementCapability !== undefined) {
    // A capability-bearing opening is gated even when the underlying terrain
    // happens to be ordinarily passable. This keeps the optional opening field
    // authoritative: importing a Surf lane cannot make it usable on foot.
    if (sess.handoffCapability?.(resolved.movementCapability, s) !== true) return false;
    if (!canEnterIgnoringTerrainSolid(targetPassage, transfer.x, transfer.y, entry)) return false;
  } else if (!canEnter(targetPassage, transfer.x, transfer.y, entry)) return false;

  const totalTicks = stepFrames(sess.cfg);
  s.handoff = {
    mode: "seamless-v1",
    portalId: transfer.handoff.portalId,
    sourceMapId: s.mapId,
    targetMapId: transfer.map,
    sourceX: s.move.tx,
    sourceY: s.move.ty,
    targetX: transfer.x,
    targetY: transfer.y,
    direction: resolved.direction,
    phase: 0,
    totalTicks,
  };
  s.interp.pendingTransfer = null;
  s.move = {
    ...s.move,
    facing: resolved.direction,
    phase: 0,
    moving: true,
    walking: true,
    stepDir: resolved.direction,
  };
  return true;
}

/** Advance the mover's world-space interpolation before the ordinary source
 * map tick. The caller commits only after that source tick finishes, so the
 * target never becomes active early. */
function advanceSeamlessHandoffMotion(sess: Session, s: SessionState): boolean {
  const handoff = s.handoff!;
  const phase = handoff.phase + 1;
  const pixels = stepPixels(
    handoff.sourceX * sess.cfg.tile,
    handoff.sourceY * sess.cfg.tile,
    handoff.direction,
    phase,
    sess.cfg,
  );
  s.move.px = pixels.px;
  s.move.py = pixels.py;
  s.move.phase = phase;
  if (phase < handoff.totalTicks) {
    handoff.phase = phase;
    return false;
  }
  handoff.phase = phase;
  return true;
}

/** A fatal source-map error owns the result just as it does on the legacy
 * path. Discard only the synthetic crossing and restore its source boundary;
 * the source interpreter, characters and error remain frozen in place. */
function abortSeamlessHandoff(sess: Session, s: SessionState): void {
  const handoff = s.handoff;
  if (handoff === undefined) return;
  s.move = initialMovement(handoff.sourceX, handoff.sourceY, handoff.direction, sess.cfg);
  delete s.handoff;
}

const STEP_DX: readonly number[] = [0, -1, 0, 1];
const STEP_DY: readonly number[] = [1, 0, -1, 0];

/** Freeze the source map's painted characters on the commit tick, before
 * entry discards them. Mirrors the actor pool's choice of position, facing,
 * walk pose and effective appearance for a spawned character. */
function freezeLeftMap(
  s: Readonly<SessionState>,
  source: Readonly<MapDef>,
  handoff: Readonly<SeamlessHandoffState>,
): LeftMapSnapshot {
  const actors: LeftMapActor[] = [];
  for (const ev of source.events ?? []) {
    const ch = s.chars.chars[ev.id];
    if (!ch) continue;
    const appearance = effectiveEventAppearance(
      { pageIndex: ch.pageIndex, sprite: ev.pages[ch.pageIndex]?.sprite ?? null },
      s.interp.eventAppearances?.[ev.id],
    );
    if (!appearance.visible || appearance.sprite === null) continue;
    actors.push({
      eventId: ev.id,
      px: ch.px,
      py: ch.py,
      facing: ch.facing,
      pose: walkPose(ch.phase),
      sprite: appearance.sprite,
      opacity: appearance.opacity,
    });
  }
  // The crossing step joins the source edge cell to the target edge cell,
  // which places the source origin in target-local tiles.
  return {
    mapId: source.id,
    originX: handoff.targetX - STEP_DX[handoff.direction]! - handoff.sourceX,
    originY: handoff.targetY - STEP_DY[handoff.direction]! - handoff.sourceY,
    width: source.width,
    height: source.height,
    actors,
  };
}

function outsideLeftMapRing(left: Readonly<LeftMapSnapshot>, x: number, y: number): boolean {
  const dx = Math.max(left.originX - x, 0, x - (left.originX + left.width - 1));
  const dy = Math.max(left.originY - y, 0, y - (left.originY + left.height - 1));
  return Math.max(dx, dy) > LEFT_MAP_RING_TILES;
}

function commitSeamlessHandoff(sess: Session, s: SessionState): { x: number; y: number } {
  const handoff = s.handoff!;
  const left = freezeLeftMap(s, sess.maps.get(handoff.sourceMapId)!, handoff);
  // Re-acquire on the commit tick: rewind keyframes retain reducer state,
  // not derived cache residency. The already-prepared fast path is one map
  // lookup; an async miss rolls this entire host frame back for retry.
  const target = acquireSessionMap(sess, handoff.targetMapId);
  enterMap(
    s,
    target,
    handoff.targetX,
    handoff.targetY,
    handoff.direction,
    sess.cfg,
    sess.transferPresentation,
  );
  runPlayerStepHook(
    sess,
    s,
    sess.worlds.get(handoff.targetMapId)!,
    handoff.targetX - handoff.sourceX,
    handoff.targetY - handoff.sourceY,
    "relocation",
  );
  showMapNameBanner(s, target);
  // Entry dropped any older snapshot (including the target's own, when the
  // player walks back into the map it froze).
  s.leftMap = left;
  // Do not run the legacy single-map eviction here. A connected-world cache
  // driver owns the active/visible/imminent keep-sets and converges them on
  // this presented frame; flattening the cache first would discard warm
  // visible maps and create a one-frame release/reload hole. Headless users
  // can apply releaseSessionMapLayers with their own derived working set.
  return { x: handoff.targetX, y: handoff.targetY };
}

/** Advance the session one MOTION_HZ reference tick, mutating the working
 *  clone `s`. Returns the player cell the next tick sees as prevCell. */
function stepReferenceTick(
  sess: Session,
  s: SessionState,
  input: SessionInput,
  prevCellIn: { x: number; y: number },
): { x: number; y: number; cues?: SoundCue[]; hostActions?: HostAction[] } {
  const map = sess.maps.get(s.mapId)!;

  // RPG Maker's game timer is global: map fades, full-screen scenes and a
  // fatalized map interpreter do not pause it. Omitted state keeps the
  // unused hot path to one predictable branch.
  if (s.sw.timer !== undefined) advanceTimer(s.sw);
  if (s.leftMap !== undefined && outsideLeftMapRing(s.leftMap, s.move.tx, s.move.ty)) delete s.leftMap;

  // A handoff owns the source map through its final interpolation tick. Move
  // the player first, like an ordinary step, then let only that source map's
  // pages, NPCs and effects advance. Atomic target entry happens at the end.
  const handoffAtStart = s.handoff !== undefined;
  const handoffCompletes = handoffAtStart
    ? advanceSeamlessHandoffMotion(sess, s)
    : false;

  // A completion is observed after the previous host frame's reference-tick
  // batch. Its successor therefore starts on this next reference tick, never
  // recursively on the completion frame.
  if (
    !handoffAtStart &&
    s.scene === null &&
    (s.interp.pendingBattles.length > 0 || (s.interp.pendingScenes?.length ?? 0) > 0)
  ) {
    // B2: a completion on the previous frame may have invalidated a queued
    // parallel's page; cancel it before it can grab the scene slot.
    pruneStaleQueuedScenes(sess, s);
  }
  if (!handoffAtStart && s.scene === null && s.interp.pendingBattles.length > 0) {
    startNextBattleScene(sess, s);
  }
  if (!handoffAtStart && s.scene === null && (s.interp.pendingScenes?.length ?? 0) > 0) {
    startNextGameScene(sess, s);
  }

  // Full-screen scenes own the reference clock by default. Games that need
  // background simulation must opt in explicitly; their newly published
  // battle requests remain queued until the active scene completes.
  if (s.scene !== null && !sess.sceneOptions.worldContinues) {
    tickFrozenWorld(s);
    return { x: s.move.tx, y: s.move.ty };
  }

  // -- fade: gameplay and input freeze while the overlay moves -----------
  if (s.fade) {
    advanceInterpAudioInPlace(s.interp);
    if (s.fade.phase === "out") {
      const transfer = s.interp.pendingTransfer;
      if (transfer) prepareSessionMapStep(sess, transfer.map);
    }
    s.fade.left--;
    if (s.fade.left > 0) return { x: s.move.tx, y: s.move.ty };
    if (s.fade.phase === "out") {
      const t = s.interp.pendingTransfer;
      if (t) applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
      s.fade = { phase: "in", left: s.fade.half, half: s.fade.half };
      return { x: s.move.tx, y: s.move.ty };
    }
    s.fade = null;
    return { x: s.move.tx, y: s.move.ty };
  }

  // A fatal interpreter error freezes the playfield (review 1274 B1): the
  // clock advances but no mover, character, or interpreter fold runs, so a
  // cyclic program cannot consume steps or keep throwing tick after tick.
  if (s.interp.error) {
    abortSeamlessHandoff(sess, s);
    advanceInterpAudioInPlace(s.interp);
    return { x: s.move.tx, y: s.move.ty };
  }

  // Presentation descriptors advance on the same fixed reference clock as
  // movement and event waits. Transfer fades and default-frozen scenes take
  // the early-return paths above, so hidden map presentation pauses with the
  // map; worldContinues scenes deliberately reach this path.
  if (s.interp.screen) s.interp.screen = advanceScreenEffects(s.interp.screen);

  // 1. Reconcile NPC pages. A page switch (or an event that went away)
  //    aborts any forced route parked on it; resume the waiter so the
  //    external fiber cannot deadlock.
  const erased = s.interp.erased;
  const world = sess.worlds.get(s.mapId)!;
  // Tuxemon-style live movement conditions run before world physics. Keep
  // this tick-start sample through the later interpreter fold: a newly
  // pressed step is not moving yet, while a step that lands this tick still
  // reports the velocity it had on entry.
  const playerMovingAtTickStart = world.needsPlayerMovingContext
    ? s.move.moving
    : undefined;
  const needsMovementControlPath =
    world.needsMovementControlPath === true || s.interp.moveControls !== undefined;
  const extension: ExtensionScope = { runtime: sess.extensions, ext: s.ext };
  const needsEventPages = world.needsEventPages === true || s.interp.eventAppearances !== undefined;
  const previousEventPages = needsEventPages ? eventPagesOf(map, s.chars) : undefined;
  let conditionContext = sessionConditionContext(
    world,
    s,
    previousEventPages,
    playerMovingAtTickStart,
  );
  const syncFacing = s.move.facing;
  let syncMotion = keyedRecord<MotionType>();
  const keyed = keyedEventsOf(world);
  const cacheablePages = sess.immutableState && canCachePages(world);
  const freshEntry = cacheablePages && s.interp.frame === 0 &&
    Object.keys(s.chars.chars).length === 0 &&
    Object.keys(s.interp.erased).length === 0 &&
    Object.keys(s.interp.placements).length === 0 &&
    s.interp.eventAppearances === undefined &&
    s.interp.tileProperties === undefined;
  const entryMemo = freshEntry ? entryPageMemoFor(sess, s.mapId) : undefined;
  const entryDependencies = freshEntry
    ? entryMemo?.dependencies ?? entryPageDependencies(world)
    : undefined;
  const entrySignature = entryDependencies === undefined
    ? undefined
    : entryPageSignature(
      s,
      conditionContext.worldIdle ?? false,
      sess.extensions,
      entryDependencies,
    );
  const reusableEntry = entryMemo !== undefined && entryMemo.runtime === sess.extensions &&
    entrySignature !== undefined && sameSignature(entryMemo.signature, entrySignature)
    ? entryMemo
    : undefined;
  const reuseEntry = reusableEntry !== undefined;
  const signature = cacheablePages
    ? pageSyncSignature(
        s,
        conditionContext.worldIdle ?? false,
        sess.extensions,
        conditionContext.playerMoving,
      )
    : undefined;
  const memo = cacheablePages ? pageSyncMemo.get(world) : undefined;
  const reusePages = !reuseEntry && memo !== undefined && memo.runtime === sess.extensions &&
    signature !== undefined && sameSignature(memo.signature, signature);
  if (reusableEntry !== undefined) {
    const rng = s.chars.rng;
    s.chars = shareChars(reusableEntry.chars, true);
    // A restored state may deliberately carry a non-default character RNG
    // even with an empty table. Reusing authored placements must not rewind
    // that saved cursor.
    s.chars.rng = rng;
    syncMotion = reusableEntry.motion;
  } else if (reusePages) {
    syncMotion = memo.motion;
  }
  const selectedPages = reuseEntry
    ? new Map(keyed.events.map(({ ev, index }) => [ev, reusableEntry.pages[index]!] as const))
    : reusePages
      ? memo!.pages
    : cacheablePages
      ? new Map<GameEvent, number>()
      : undefined;
  const synced = reuseEntry || reusePages ? { abortedWaiters: [] as string[] } : syncPagesInPlace(
    s.chars,
    keyed.events,
    keyed.slotsById,
    s.sw,
    sess.cfg,
    (key) => Object.prototype.hasOwnProperty.call(erased, key),
    s.interp.placements,
    syncFacing,
    extension,
    syncMotion,
    true,
    conditionContext,
    s.interp.eventAppearances,
    true,
    selectedPages,
  );
  if (freshEntry && !reuseEntry && entrySignature !== undefined) {
    const entryChars = s.chars;
    s.chars = shareChars(entryChars, true);
    rememberEntryPages(sess, s.mapId, {
      dependencies: entryDependencies!,
      signature: entrySignature,
      chars: entryChars,
      motion: syncMotion,
      pages: keyed.events.map(({ ev }) => selectedPages!.get(ev)!),
      runtime: sess.extensions,
    });
  }
  if (cacheablePages && !reusePages) {
    pageSyncMemo.set(world, {
      signature: pageSyncSignature(
        s,
        conditionContext.worldIdle ?? false,
        sess.extensions,
        conditionContext.playerMoving,
      ),
      motion: syncMotion,
      pages: selectedPages!,
      runtime: sess.extensions,
    });
  }
  const eventPages = needsEventPages ? eventPagesOf(map, s.chars) : undefined;
  if (eventPages && s.interp.eventAppearances) clearStaleEventAppearances(s.interp, eventPages);
  conditionContext = sessionConditionContext(world, s, eventPages, playerMovingAtTickStart);
  for (const waiter of synced.abortedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }
  const passage = sessionPassageTable(sess, s);
  // eventTouch contacts gathered by this tick's movement phase (mover,
  // characters, player route) and read by this tick's trigger scan. Maps
  // without an eventTouch page skip detection entirely.
  let contacts: string[] | undefined;
  if (world.hasEventTouch === true) {
    contacts = TOUCH_CONTACTS;
    contacts.length = 0;
  }

  // 2. Mover — frozen while a blocking fiber runs, the player's own forced
  //    route is driving, a choices box (including one owned by a PARALLEL
  //    page) is open capturing the d-pad, or the cross-event input lock is
  //    held. A parallel TEXT line does not freeze the world
  //    (review C10) unless the project opts in with
  //    system.messageBlocksPlayer: then any open box holds the player.
  const prevFacing = s.move.facing;
  const playerCellBeforeMovementX = s.move.tx;
  const playerCellBeforeMovementY = s.move.ty;
  const busy = isBusy(s.interp);
  const capturesDpad = s.interp.modal?.kind === "choices" || s.interp.modal?.kind === "shop";
  const held = messageHoldsPlayer(world, s.interp);
  let finishedWaiters: string[];
  let playerRouteSettings = DEFAULT_MOVE_SETTINGS as ResolvedMoveSettings;
  let playerRouteEventSettings: Readonly<Record<string, ResolvedMoveSettings>> | undefined;
  if (!needsMovementControlPath) {
    if (!handoffAtStart && !busy && !capturesDpad && !held && s.playerRoute === null &&
        !s.interp.inputLocked && s.interp.screen?.backdrop === undefined) {
      // stepMovement consults the table only for a held direction.
      const table = dirFromButtons(input.buttons) === null
        ? passage
        : tableWithBodiesLegacy(passage, s.chars);
      Object.assign(s.move, stepMovementLegacy(s.move, input.buttons, table, sess.cfg));
      // A held direction that left the mover resting and disengaged is a
      // refused step (blocked at rest, or no continuation on arrival).
      const dir = contacts && !s.move.moving && !s.move.walking ? dirFromButtons(input.buttons) : null;
      if (dir !== null) notePlayerBump(passage, s.chars, s.move.tx, s.move.ty, dir, undefined, contacts!);
    }
    const playerPlace = {
      tx: s.move.tx,
      ty: s.move.ty,
      facing: s.move.facing,
      destX: s.move.moving ? s.move.tx + DX[s.move.stepDir] : s.move.tx,
      destY: s.move.moving ? s.move.ty + DY[s.move.stepDir] : s.move.ty,
      contacts,
    };
    const locked = new Set<string>();
    if (s.interp.main) locked.add(eventIdOf(s.interp.main.key, s.mapId));
    finishedWaiters = stepCharsInPlaceLegacy(
      s.chars,
      passage,
      playerPlace,
      sess.cfg,
      locked,
      s.move.facing === syncFacing
        ? syncMotion
        : motionOf(map, s.sw, s.move.facing, extension, conditionContext),
      sess.immutableState,
    );
  } else {
    // continueExternal may have replaced the interpreter clone. Refresh the
    // aliases before movement reads/writes runtime overrides and saved RNG.
    s.sw = s.interp.sw;
    pruneEventMoveControls(s);
    let eventSettings = moveSettingsFromSyncedChars(
      map,
      s.chars,
      s.interp.moveControls?.events,
    );
    const playerSettings = s.interp.moveControls?.player
      ? resolveMoveSettings(null, s.interp.moveControls.player)
      : DEFAULT_MOVE_SETTINGS as ResolvedMoveSettings;
    playerRouteSettings = playerSettings;

    if (!handoffAtStart && !busy && !capturesDpad && !held && s.playerRoute === null &&
        !s.interp.inputLocked && s.interp.screen?.backdrop === undefined) {
      if (playerSettings.runtimeWander) {
        if (s.interp.modal === null) {
          stepPlayerWander(s, passage, sess.cfg, playerSettings, eventSettings);
        }
      } else {
        const table = dirFromButtons(input.buttons) === null
          ? passage
          : tableWithBodies(passage, s.chars, eventSettings);
        Object.assign(s.move, stepMovement(
          s.move,
          input.buttons,
          table,
          movementConfigFor(sess.cfg, playerSettings),
          {
            through: playerSettings.through,
            faceMovement: canFace(playerSettings, false),
          },
        ));
        const dir = contacts && !playerSettings.through && !s.move.moving && !s.move.walking
          ? dirFromButtons(input.buttons)
          : null;
        if (dir !== null) notePlayerBump(passage, s.chars, s.move.tx, s.move.ty, dir, eventSettings, contacts!);
      }
    }

    const playerPlace = {
      tx: s.move.tx,
      ty: s.move.ty,
      facing: s.move.facing,
      destX: s.move.moving ? s.move.tx + DX[s.move.stepDir] : s.move.tx,
      destY: s.move.moving ? s.move.ty + DY[s.move.stepDir] : s.move.ty,
      through: playerSettings.through,
      contacts,
    };
    const locked = new Set<string>();
    if (s.interp.main) locked.add(eventIdOf(s.interp.main.key, s.mapId));
    if (s.move.facing !== syncFacing) {
      eventSettings = moveSettingsOf(
        map,
        s.sw,
        s.move.facing,
        extension,
        s.interp.moveControls?.events,
        conditionContext,
      );
    }
    finishedWaiters = stepCharsInPlace(
      s.chars,
      passage,
      playerPlace,
      sess.cfg,
      locked,
      s.move.facing === syncFacing
        ? syncMotion
        : motionOf(map, s.sw, s.move.facing, extension, conditionContext),
      {
        settings: eventSettings,
        applyControl: (eventId, control) => {
          const override = eventMoveOverride(s, eventId);
          if (override) {
            applyMoveControl(override, control);
            if (control.kind === "wander") resetCharThinkInPlace(s.chars, eventId);
          }
        },
        consumePendingRouteSpeed: (eventId) => {
          const override = s.interp.moveControls?.events[eventId];
          if (!override) return;
          delete override.routeSpeed;
          delete override.routeTilesPerSecond;
        },
        runtimeRng: s.sw,
        modalOpen: s.interp.modal !== null,
      },
      sess.immutableState,
    );
    playerRouteEventSettings = eventSettings;
    s.sw = s.interp.sw;
  }
  for (const waiter of finishedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }
  s.sw = s.interp.sw;
  if (s.playerRoute && !handoffAtStart) {
    stepPlayerRoute(s, sess, playerRouteSettings, playerRouteEventSettings, contacts);
  }
  const playerStep = sess.extensions.playerStep;
  if (playerStep !== null &&
      (s.move.tx !== playerCellBeforeMovementX || s.move.ty !== playerCellBeforeMovementY)) {
    runPlayerStepHook(
      sess,
      s,
      world,
      s.move.tx - playerCellBeforeMovementX,
      s.move.ty - playerCellBeforeMovementY,
      "step",
    );
  }

  // 4. Interpreter — the displaced-character record supplements the world's
  // authored spatial index: eventOrigin reads it over the authored (x,y), so
  // a moved event is found on its current cell, and a character that walked
  // back onto its authored cell reads the authored cell (its live cell)
  // instead of a stale durable placement. A world with event-targeted
  // mapAnim additionally gets every live character's cell so the command
  // resolves the target without an authored fallback.
  const eventCells = displacedCells(map, s.chars, sess.immutableState);
  const liveEventCells = world.needsMapAnimTarget ? keyedRecord<{ x: number; y: number }>() : undefined;
  for (const ev of map.events ?? []) {
    const ch = s.chars.chars[ev.id];
    if (liveEventCells && ch) liveEventCells[ev.id] = { x: ch.tx, y: ch.ty };
  }
  const interpInput: InterpInput = {
    confirmEdge: handoffAtStart ? false : input.confirmEdge,
    cancelEdge: handoffAtStart ? false : input.cancelEdge,
    upEdge: handoffAtStart ? false : input.upEdge,
    downEdge: handoffAtStart ? false : input.downEdge,
    playerCell: { x: s.move.tx, y: s.move.ty },
    prevCell: prevCellIn,
    facing: s.move.facing,
    prevFacing,
    ...(playerMovingAtTickStart === undefined
      ? {}
      : { playerMoving: playerMovingAtTickStart }),
    eventCells,
    ...(liveEventCells ? { liveEventCells } : {}),
    eventPages,
    worldIdleBlockers: sessionWorldIdleBlockers(s),
    liveChars: s.chars.chars,
  };
  if (contacts !== undefined && contacts.length > 0) interpInput.touchContacts = contacts;
  s.ext = stepInterpWithExtensionsInPlace(
    world,
    s.interp,
    interpInput,
    s.ext,
    cacheablePages
      ? {
          indices: selectedPages!,
          facing: syncFacing,
          worldIdle: conditionContext.worldIdle ?? false,
          ...(conditionContext.playerMoving === undefined
            ? {}
            : { playerMoving: conditionContext.playerMoving }),
        }
      : undefined,
    sess.immutableState,
  );
  // Capture before an immediate transfer rebuilds the interpreter. A host
  // frame may fold several reference ticks, so stepSession aggregates every
  // non-empty list in command order instead of exposing only the final tick.
  const tickCues = sess.audioCues && s.interp.cues.length > 0 ? s.interp.cues : undefined;
  const tickHostActions = s.interp.hostActions && s.interp.hostActions.length > 0
    ? s.interp.hostActions
    : undefined;
  // continueExternal above may have replaced s.interp with a copy whose
  // switch bank is a new object; re-alias the session's top-level bank to it
  // so the values chars/motion read next tick are the ones commands just
  // wrote.
  s.sw = s.interp.sw;
  if (handoffAtStart && s.interp.error) abortSeamlessHandoff(sess, s);
  const transfer = s.interp.pendingTransfer;
  if (transfer && !transferMapKnown(sess, transfer.map)) {
    s.interp.pendingTransfer = null;
    s.interp.error = {
      kind: "content",
      message: `transfer in ${transfer.fiber}: unknown map ${JSON.stringify(transfer.map)}`,
    };
    if (handoffAtStart) abortSeamlessHandoff(sess, s);
    const result: {
      x: number;
      y: number;
      cues?: SoundCue[];
      hostActions?: HostAction[];
    } = { x: s.move.tx, y: s.move.ty };
    if (tickCues) result.cues = tickCues;
    if (tickHostActions) result.hostActions = tickHostActions;
    return result;
  }

  // A page-scoped parallel canceled this tick may have owned a waited
  // player route: drop it without resuming the dead waiter. The event-side
  // half is torn down by syncPages (the character's page went away).
  if (s.playerRoute && s.playerRoute.waiter && s.interp.abortedRoutes.includes(s.playerRoute.waiter)) {
    s.playerRoute = null;
    s.move.walking = false;
  }

  // 5. Consume published external requests in command order. Routes drain
  //    in publish order so the fire-and-forget player turn installs before
  //    the waited self-route parks the fiber; each `place` applies at its
  //    own position in that order, so it cancels the routes queued before
  //    it and never the ones a fiber queued after it.
  const routes = s.interp.pendingMoveRoutes;
  const placements = s.interp.pendingPlacements;
  if (routes.length > 0 || placements.length > 0) {
    let next = 0;
    for (let i = 0; i <= routes.length; i++) {
      while (next < placements.length && (i === routes.length || (placements[next]!.afterRoutes ?? 0) <= i)) {
        const p = placements[next++]!;
        syncRequestedPage(sess, s, keyed, syncFacing, p, playerMovingAtTickStart);
        applyPlacement(sess, s, map, p);
      }
      if (i === routes.length) break;
      syncRequestedPage(sess, s, keyed, syncFacing, routes[i]!, playerMovingAtTickStart);
      applyMoveRequest(sess, s, routes[i]!);
    }
  }
  s.sw = s.interp.sw;
  if (
    !handoffAtStart &&
    s.scene === null &&
    (s.interp.pendingBattles.length > 0 || (s.interp.pendingScenes?.length ?? 0) > 0)
  ) {
    // B2: a command earlier in this tick's fold may have invalidated a
    // queued parallel's page after cancelStaleParallels ran; re-check
    // against the post-fold switch bank before the end-of-tick consumption.
    pruneStaleQueuedScenes(sess, s, playerMovingAtTickStart);
  }
  if (!handoffAtStart && s.scene === null && s.interp.pendingBattles.length > 0) {
    startNextBattleScene(sess, s);
  }
  if (!handoffAtStart && s.scene === null && (s.interp.pendingScenes?.length ?? 0) > 0) {
    startNextGameScene(sess, s);
  }
  if (handoffCompletes && s.handoff !== undefined) {
    const landed = commitSeamlessHandoff(sess, s);
    const result: {
      x: number;
      y: number;
      cues?: SoundCue[];
      hostActions?: HostAction[];
    } = landed;
    if (tickCues) result.cues = tickCues;
    if (tickHostActions) result.hostActions = tickHostActions;
    return result;
  }
  if (!handoffAtStart && s.interp.pendingTransfer) {
    const t = s.interp.pendingTransfer;
    if (tryStartSeamlessHandoff(sess, s, t)) {
      // The source map remains authoritative until the crossing completes.
    } else if (t.fadeFrames > 0) {
      const half = Math.max(1, Math.round(t.fadeFrames / 2));
      s.fade = { phase: "out", left: half, half };
    } else {
      applyTransfer(sess, s, t.map, t.x, t.y, t.dir);
    }
  }
  const result: {
    x: number;
    y: number;
    cues?: SoundCue[];
    hostActions?: HostAction[];
  } = { x: s.move.tx, y: s.move.ty };
  if (tickCues) result.cues = tickCues;
  if (tickHostActions) result.hostActions = tickHostActions;
  return result;
}

/** Before a place/route/control request applies, move its target onto the
 *  page it was published for when the fold itself just switched that page
 *  on. Without it a fiber that turns an NPC's page on, places it and routes
 *  it would see the route installed now and torn down by the next tick's
 *  page sync. A request published while the old page was still active (its
 *  fiber flips the page afterwards) is left alone: the next sync resets it
 *  with the page it belonged to, as before. */
function syncRequestedPage(
  sess: Session,
  s: SessionState,
  keyed: ReturnType<typeof keyedEventsOf>,
  facing: Facing,
  req: PendingMoveOperation | PendingPlacement,
  playerMoving?: boolean,
): void {
  if (!("eventId" in req) || req.page === undefined || req.page < 0) return;
  const { eventId: id, page } = req;
  if (s.chars.chars[id]?.pageIndex === page) return;
  const world = sess.worlds.get(s.mapId)!;
  const map = sess.maps.get(s.mapId)!;
  const extension: ExtensionScope = { runtime: sess.extensions, ext: s.ext };
  const eventPages = world.needsEventPages === true || s.interp.eventAppearances !== undefined
    ? eventPagesOf(map, s.chars)
    : undefined;
  const context = sessionConditionContext(world, s, eventPages, playerMoving);
  if (eventPageAt(world, s.sw, id, facing, extension, context) !== page) return;
  const erased = s.interp.erased;
  const synced = syncPagesInPlace(
    s.chars,
    keyed.events.filter(({ ev }) => ev.id === id),
    keyed.slotsById,
    s.sw,
    sess.cfg,
    (key) => Object.prototype.hasOwnProperty.call(erased, key),
    s.interp.placements,
    facing,
    extension,
    undefined,
    true,
    context,
    s.interp.eventAppearances,
    false,
  );
  for (const waiter of synced.abortedWaiters) {
    s.interp = continueExternal(s.interp, waiter);
  }
}

function applyMoveRequest(sess: Session, s: SessionState, req: PendingMoveOperation): void {
  if ("control" in req) {
    applyTargetMoveControl(s, req.target, req.control);
    return;
  }
  if (req.target === "player") {
    // A route replacing one still running releases the parked waiter
    // instead of orphaning it, and takes over at a tile boundary: a
    // command face must not inherit the mover's committed interpolation
    // and redirect it into a cell the new direction never checked.
    if (s.playerRoute?.waiter) {
      s.interp = continueExternal(s.interp, s.playerRoute.waiter);
    }
    if (s.interp.moveControls) resumeMoveRoute(s.interp.moveControls.player);
    // A pending routeSpeed is consumed by the route it was waiting for.
    const playerSpeed = s.interp.moveControls?.player.routeSpeed;
    const playerTilesPerSecond = s.interp.moveControls?.player.routeTilesPerSecond;
    s.playerRoute = {
      steps: req.route.steps,
      pc: 0,
      repeat: req.route.repeat,
      skippable: req.route.skippable,
      waiter: req.wait ? req.fiber : null,
      phase: 0,
      dir: s.move.facing,
      takeOver: s.move.moving,
      plan: null,
      pathRetriesLeft: null,
      ...(playerSpeed !== undefined ? { speed: playerSpeed } : {}),
      ...(playerTilesPerSecond !== undefined ? { tilesPerSecond: playerTilesPerSecond } : {}),
    };
    if (playerSpeed !== undefined && s.interp.moveControls) {
      delete s.interp.moveControls.player.routeSpeed;
      delete s.interp.moveControls.player.routeTilesPerSecond;
    }
    return;
  }
  // A route to an event with no live character (no active page, or it
  // was erased) cannot run: resume a waiting caller immediately rather
  // than park its external fiber forever (MV: a Set Movement Route on
  // an absent map event is a no-op).
  if (!s.chars.chars[req.eventId]) {
    if (req.wait) s.interp = continueExternal(s.interp, req.fiber);
    return;
  }
  const override = s.interp.moveControls?.events[req.eventId];
  if (override) resumeMoveRoute(override);
  // A pending routeSpeed is consumed by the route it was waiting for.
  const routeSpeed = override?.routeSpeed;
  const routeTilesPerSecond = override?.routeTilesPerSecond;
  const installed = installRoute(
    s.chars,
    req.eventId,
    req.route,
    req.wait ? req.fiber : null,
    sess.cfg,
    routeSpeed,
    routeTilesPerSecond,
  );
  s.chars = installed.state;
  if (routeSpeed !== undefined && override) {
    delete override.routeSpeed;
    delete override.routeTilesPerSecond;
  }
  if (installed.displacedWaiter) {
    s.interp = continueExternal(s.interp, installed.displacedWaiter);
  }
}

/** A `place` request: relocate the live character now; the durable
 *  placement record the interpreter already holds makes a later-created
 *  character spawn at the new tile on the next sync. */
function applyPlacement(sess: Session, s: SessionState, map: MapDef, p: PendingPlacement): void {
  if (!inMapBounds(map.width, map.height, p.x, p.y)) return;
  if ("target" in p) {
    const oldX = s.move.tx;
    const oldY = s.move.ty;
    stopPlayerRoute(s);
    const facing = p.dir === null ? s.move.facing : DIR_INDEX[p.dir];
    s.move = initialMovement(p.x, p.y, facing, sess.cfg);
    runPlayerStepHook(sess, s, sess.worlds.get(s.mapId)!, p.x - oldX, p.y - oldY, "relocation");
    return;
  }
  const placed = placeChar(s.chars, p.eventId, p.x, p.y, p.dir, sess.cfg);
  s.chars = placed.state;
  if (placed.displacedWaiter) {
    s.interp = continueExternal(s.interp, placed.displacedWaiter);
  }
}

function applyTransfer(
  sess: Session,
  s: SessionState,
  mapId: string,
  x: number,
  y: number,
  dir: Dir | "keep",
): void {
  const oldX = s.move.tx;
  const oldY = s.move.ty;
  const map = acquireSessionMap(sess, mapId);
  const facing: Facing = dir === "keep" ? s.move.facing : DIR_INDEX[dir];
  enterMap(s, map, x, y, facing, sess.cfg, sess.transferPresentation);
  runPlayerStepHook(sess, s, sess.worlds.get(mapId)!, x - oldX, y - oldY, "relocation");
  showMapNameBanner(s, map);
  // A seamless project has an external layered cache owner (the same owner
  // that is required for seamless handoffs). Let it choose and evict the
  // parsed/compiled keep-sets after presentation instead of recursively
  // releasing the source map inside this transfer fold. Legacy projects
  // retain the historical single-map policy.
  if (sess.worldTraversal === "legacy-transfer") releaseSessionMapsExcept(sess, [mapId]);
}

/** Dispatch the optional post-movement command without charging projects
 * that omit it. Relocations are an additive opt-in so existing games retain
 * the historical ordinary-landings-only contract. A zero coordinate delta
 * is not a movement event, even when it crosses a map boundary. */
function runPlayerStepHook(
  sess: Session,
  s: SessionState,
  world: World,
  dx: number,
  dy: number,
  kind: "step" | "relocation",
): void {
  const hook = sess.extensions.playerStep;
  if (hook === null || (kind === "relocation" && !hook.displacement) || (dx === 0 && dy === 0)) return;
  s.ext = runExtensionHookInPlace(
    world,
    s.interp,
    s.ext,
    hook.call,
    hook.args,
    hook.displacement ? { dx, dy, kind } : undefined,
  );
  s.sw = s.interp.sw;
}

/** A transfer destination authored as a live variable cannot be checked at
 * project-load time. Treat a missing id as a content error on the reducer
 * state; repository integrity/load failures for a known id still throw at
 * acquireSessionMap because they are deployment/configuration failures. */
function transferMapKnown(sess: Session, mapId: string): boolean {
  return sess.maps.has(mapId) || (sess.mapIndex?.has(mapId) ?? false);
}

// ---------------------------------------------------------------------------
// Player forced route (moveRoute target:"player")
//
// Reuses the mover's interpolation (stepPixels, stepFrames): a route step
// commits one 8-reference-tick tile step. Faces apply on the boundary tick;
// waits park for one step's worth of ticks; a blocked non-skippable move is
// retried on the next tick. A repeat:false route resumes its waiter on the
// landing tick of the last step.
// ---------------------------------------------------------------------------

/** The string-verb move steps the FACE/MOVE lookup tables cover; object
 *  path steps are handled separately. */
type VerbMoveStep = Extract<MoveStep, string>;
const FACE: Partial<Record<VerbMoveStep, Dir4>> = {
  faceDown: 0,
  faceLeft: 1,
  faceUp: 2,
  faceRight: 3,
};
const MOVE: Partial<Record<VerbMoveStep, Dir4>> = {
  moveDown: 0,
  moveLeft: 1,
  moveUp: 2,
  moveRight: 3,
};

function endPlayerRoute(s: SessionState): void {
  if (s.playerRoute!.waiter) s.interp = continueExternal(s.interp, s.playerRoute!.waiter);
  s.playerRoute = null;
  s.move.walking = false;
}

/** Snap a half-walked tile step back to its origin boundary. A route
 *  installed mid-step takes over on the boundary: the committed
 *  interpolation belonged to the mover's (or the old route's) direction,
 *  and carrying it onto the route's facing would enter a cell the new
 *  direction never checked. */
function cancelCommittedStep(m: MovementState, cfg: MovementConfig): void {
  if (!m.moving) return;
  m.phase = 0;
  m.moving = false;
  m.walking = false;
  m.px = m.tx * cfg.tile;
  m.py = m.ty * cfg.tile;
  delete m.stepTilesPerSecond;
}

function stepPlayerRoute(
  s: SessionState,
  sess: Session,
  settings: ResolvedMoveSettings,
  eventSettings: Readonly<Record<string, ResolvedMoveSettings>> | undefined,
  contacts?: string[],
): void {
  const r = s.playerRoute!;
  const cfg = sess.cfg;
  const m = s.move;
  const desiredCfg = routeSpeedConfig(cfg, settings, r.speed, r.tilesPerSecond);
  const stepCfg = r.phase > 0
    ? activeStepConfig({
        tx: m.tx,
        ty: m.ty,
        px: m.px,
        py: m.py,
        phase: r.phase,
        stepTilesPerSecond: m.stepTilesPerSecond,
      }, desiredCfg)
    : desiredCfg;
  const frames = stepFrames(stepCfg);

  // First tick owning a route installed mid-step: cancel the inherited
  // interpolation and resume from its origin boundary.
  if (r.takeOver) {
    r.takeOver = false;
    cancelCommittedStep(m, cfg);
  }

  if (r.phase < 0) {
    r.phase++;
    return;
  }
  if (r.phase > 0) {
    r.phase++;
    if (r.phase < frames) {
      const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, r.dir, r.phase, stepCfg);
      m.px = px;
      m.py = py;
      m.moving = true;
      return;
    }
    m.tx += DX[r.dir];
    m.ty += DY[r.dir];
    m.px = m.tx * cfg.tile;
    m.py = m.ty * cfg.tile;
    if (canFace(settings, false)) m.facing = r.dir;
    m.stepDir = r.dir;
    m.moving = false;
    delete m.stepTilesPerSecond;
    r.phase = 0;
    // The final internal step of a pathTo/approach plan lands here.
    // Apply the approach arrival-facing and advance the route pc once.
    if (r.plan?.done) {
      const ap = r.plan.approach;
      if (ap) {
        const tc = resolvePlayerTarget(ap.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null && canFace(settings, true)) { m.facing = f; m.stepDir = f; r.dir = f; }
        }
      }
      advance();
      return;
    }
    // fall through to the next command on this landing tick
  }

  const table = tableWithBodies(sessionPassageTable(sess, s), s.chars, eventSettings);
  // MV advances a move list at most once per stop tick: consume exactly
  // ONE route command on this reference tick (matching chars.stepRoute).
  // Instant-only routes (a repeat face route) therefore take one command
  // per reference tick and never spin the runaway guard.
  const step = r.steps[r.pc];
  if (step === undefined) {
    endPlayerRoute(s);
    return;
  }
  function advance(): boolean {
    r.plan = null;
    r.pathRetriesLeft = null;
    r.pc++;
    if (r.pc < r.steps.length) return false;
    if (r.repeat) r.pc = 0;
    else {
      endPlayerRoute(s);
      return true;
    }
    return false;
  }

  // --- turn / path steps ---------------------------------------------------
  if (typeof step === "object") {
    if ("control" in step) {
      if (step.control.kind === "routeSpeed") {
        // Scoped to this route: latch the grade, skip the persistent override.
        r.speed = step.control.value;
        if (step.control.tilesPerSecond === undefined) delete r.tilesPerSecond;
        else r.tilesPerSecond = step.control.tilesPerSecond;
        advance();
        return;
      }
      applyMoveControl(ensureMoveControls(s).player, step.control);
      if (step.control.kind === "stop") endPlayerRoute(s);
      else advance();
      return;
    }
    if ("turnToward" in step) {
      const tc = resolvePlayerTarget(step.turnToward, s);
      if (tc) {
        const f = facingToward(m.tx, m.ty, tc.x, tc.y);
        if (f !== null && canFace(settings, true)) { r.dir = f; m.facing = f; m.stepDir = f; }
      }
      advance();
      return;
    }
    if ("pathTo" in step || "approach" in step) {
      stepPlayerPath(s, sess, table, settings, step, advance, eventSettings, contacts);
      return;
    }
    advance(); // unknown object step: skip defensively
    return;
  }
  if (step === "turnTowardPlayer") {
    // The player turning toward the player is a no-op turn; keep facing.
    advance();
    return;
  }

  const faceDir = FACE[step];
  if (faceDir !== undefined) {
    if (canFace(settings, true)) {
      r.dir = faceDir;
      m.facing = faceDir;
      m.stepDir = faceDir;
    }
    advance();
    return;
  }
  if (step === "turnRandom") {
    // The project RNG bank owns randomness, keeping the route
    // deterministic and saveable.
    const roll = randInt(s.sw.rng, 0, 3);
    s.sw.rng = roll.next;
    const dir = roll.value as Dir4;
    if (canFace(settings, true)) {
      r.dir = dir;
      m.facing = dir;
      m.stepDir = dir;
    }
    advance();
    return;
  }
  if (step === "wait") {
    r.phase = -frames;
    r.pc++;
    if (r.repeat && r.pc >= r.steps.length) r.pc = 0;
    // Non-repeat: pc rests at length; the reference tick after the wait
    // hits the undefined branch above and releases the waiter.
    return;
  }
  const dir = step === "stepForward" ? r.dir : MOVE[step];
  if (dir === undefined) {
    advance();
    return;
  }
  r.dir = dir;
  if (canFace(settings, false)) m.facing = dir;
  m.stepDir = dir;
  const tx = m.tx + DX[dir];
  const ty = m.ty + DY[dir];
  const blocked = settings.through
    ? !inMapBounds(table.width, table.height, tx, ty)
    : !canStepFrom(table, m.tx, m.ty, dir);
  if (blocked) {
    // Blocked: the source cell's exit or the target's reverse entry is
    // dirBlocked, or the target terrain is unenterable. Retry on the next
    // reference tick, unless the route is skippable (MV MoveRoute
    // "skip if cannot move"). A body refusal is an eventTouch bump.
    if (contacts && !settings.through) {
      notePlayerBump(sessionPassageTable(sess, s), s.chars, m.tx, m.ty, dir, eventSettings, contacts);
    }
    if (r.skippable) endPlayerRoute(s);
    return;
  }
  r.phase = 1;
  r.pc++;
  m.moving = true;
  if (r.tilesPerSecond === undefined) delete m.stepTilesPerSecond;
  else m.stepTilesPerSecond = r.tilesPerSecond;
  const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, dir, 1, desiredCfg);
  m.px = px;
  m.py = py;
  if (r.repeat && r.pc >= r.steps.length) r.pc = 0;
}

/** Resolve a route target character to its live cell for a PLAYER route.
 *  The player is always at the mover's own cell; an event resolves through
 *  its live character cell, else its authored origin. */
function resolvePlayerTarget(
  target: "player" | { event: string },
  s: SessionState,
): { x: number; y: number } | null {
  if (target === "player") return { x: s.move.tx, y: s.move.ty };
  const ch = s.chars.chars[target.event];
  if (ch) return { x: ch.tx, y: ch.ty };
  return null;
}

/** Expand/walk one player pathTo or approach step for this reference tick.
 *  The stamped table already carries blocks:true bodies, so the BFS needs
 *  no extra occupancy set. The authored pc advances only when the whole
 *  plan is consumed; `advance` handles repeat/finish/waiter release. */
function stepPlayerPath(
  s: SessionState,
  sess: Session,
  table: PassageTable,
  settings: ResolvedMoveSettings,
  step: Extract<MoveStep, { pathTo: unknown }> | Extract<MoveStep, { approach: unknown }>,
  advance: () => boolean,
  eventSettings?: Readonly<Record<string, ResolvedMoveSettings>>,
  contacts?: string[],
): void {
  const r = s.playerRoute!;
  const m = s.move;
  const cfg = sess.cfg;
  // Path steps run at the route's latched grade, the same way event routes
  // and the plain step path above resolve their speed.
  const moveCfg = routeSpeedConfig(cfg, settings, r.speed, r.tilesPerSecond);

  if (r.plan === null) {
    let gx: number;
    let gy: number;
    let approach: PathPlan["approach"] = null;
    if ("pathTo" in step) {
      gx = step.pathTo.x;
      gy = step.pathTo.y;
    } else {
      const target = step.approach.target;
      if (target === "player") { endPlayerRoute(s); return; }
      const tc = resolvePlayerTarget(target, s);
      if (!tc) { endPlayerRoute(s); return; }
      let side: Dir4;
      if (step.approach.side) {
        side = DIR4_PLAYER[step.approach.side]!;
      } else {
        const resolved = approachSide(m.tx, m.ty, tc.x, tc.y);
        if (resolved === null) { advance(); return; }
        side = resolved;
      }
      const distance = step.approach.distance ?? 1;
      const stand = approachStand(tc.x, tc.y, side, distance);
      gx = stand.x;
      gy = stand.y;
      approach = { target, side, distance };
    }

    if (gx === m.tx && gy === m.ty) {
      if (approach) {
        const tc = resolvePlayerTarget(approach.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null && canFace(settings, true)) { r.dir = f; m.facing = f; m.stepDir = f; }
        }
      }
      advance();
      return;
    }

    if (r.pathRetriesLeft === null) {
      r.pathRetriesLeft =
        ("pathTo" in step ? step.pathTo.retries : step.approach.retries) ?? DEFAULT_PATH_RETRIES;
    }
    // The stamped table already carries every blocks:true body (and the
    // cell it is stepping into). A blocks:false event is walked over by the
    // mover, so the search crosses it too, the way a character route does.
    // Begin a frame-split BFS (one slice per reference tick).
    const search = createPathSearch(table, m.tx, m.ty, gx, gy, undefined, settings.through);
    if (search === null) { endPlayerRoute(s); return; }
    r.plan = { search, dirs: [], blockedTicks: 0, done: false, approach };
  }

  const plan = r.plan;
  if (!plan) return;
  if (plan.search) {
    const res = advancePathSearch(plan.search, table, BFS_CELLS_PER_TICK);
    if (!res.done) return; // still computing; no movement this tick
    plan.search = null;
    if (res.path === null) {
      plan.dirs = [];
      plan.blockedTicks = 1;
    } else if (res.path.length === 0) {
      if (plan.approach) {
        const tc = resolvePlayerTarget(plan.approach.target, s);
        if (tc) {
          const f = facingToward(m.tx, m.ty, tc.x, tc.y);
          if (f !== null && canFace(settings, true)) { r.dir = f; m.facing = f; m.stepDir = f; }
        }
      }
      advance();
      return;
    } else {
      plan.dirs = res.path;
      plan.blockedTicks = 0;
    }
  }
  if (plan.done) return; // the landing branch advances
  const dir = plan.dirs[0];
  if (dir === undefined) {
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return;
    if (r.pathRetriesLeft! <= 0) { endPlayerRoute(s); return; }
    r.pathRetriesLeft = r.pathRetriesLeft! - 1;
    r.plan = null;
    return;
  }
  r.dir = dir;
  if (canFace(settings, false)) m.facing = dir;
  m.stepDir = dir;
  const tx = m.tx + DX[dir];
  const ty = m.ty + DY[dir];
  const blocked = settings.through
    ? !inMapBounds(table.width, table.height, tx, ty)
    : !canStepFrom(table, m.tx, m.ty, dir);
  if (blocked) {
    if (contacts && !settings.through) {
      notePlayerBump(sessionPassageTable(sess, s), s.chars, m.tx, m.ty, dir, eventSettings, contacts);
    }
    plan.blockedTicks++;
    if (plan.blockedTicks < PATH_REPLAN_TICKS) return;
    if (r.pathRetriesLeft! <= 0) { endPlayerRoute(s); return; }
    r.pathRetriesLeft = r.pathRetriesLeft! - 1;
    r.plan = null;
    return;
  }
  r.phase = 1;
  m.moving = true;
  if (r.tilesPerSecond === undefined) delete m.stepTilesPerSecond;
  else m.stepTilesPerSecond = r.tilesPerSecond;
  const { px, py } = stepPixels(m.tx * cfg.tile, m.ty * cfg.tile, dir, 1, moveCfg);
  m.px = px;
  m.py = py;
  plan.dirs.shift();
  if (plan.dirs.length === 0) plan.done = true;
}

const DIR4_PLAYER: Record<Dir, Dir4> = { down: 0, left: 1, up: 2, right: 3 };
