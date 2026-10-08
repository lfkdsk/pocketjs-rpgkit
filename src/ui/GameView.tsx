// src/ui/GameView.tsx — a complete game screen for an rpgkit-project/v1
// document: maps, transfers, moving NPCs and all four triggers over the
// pure session reducer (engine/session.ts). The entry passes the project
// and its baked asset manifest (GameAssets, cooked with
// tools/lib/chunks.ts); examples/sunstone mounts its three-map game.
// An entry that also passes an attract tape gets attract mode and
// takeover/rewind: engine/attract.ts owns the fold and derives every press
// edge from the button mask, so a demo frame and a live frame reach the
// reducer identically. Without a tape the view folds live input directly.
//
//   root (overflow-hidden, black)
//     world frame (clips to the CURRENT map or viewport on each axis and
//                 centers undersized axes for black letterboxing)
//       translated world      follows the player on oversized axes
//       ground chunks         row-major 512x512 images
//       upper/actor plane       only current-map characters; actors and
//                               clipped upper rows share (y,x) paint order
//     DialogBox               text / choices (themed, with portraits when
//                             the entry passes theme / faces)
//     fade overlay            black, opacity ramps for a faded transfer
//
// Desktop windows publish their live logical size (hostViewport /
// ui.__viewport). The frame polls it the same way apps/launcher does, so
// camera bounds and letterbox placement follow every resize. Positions and
// the world camera commit through one precompiled jump batch; chunk images
// stay mounted while the player walks.

import { batch, createMemo, createSignal, onCleanup, onMount, Show, type Accessor, type Component } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createJumpBatch, type JumpBatch } from "@pocketjs/framework/animation";
import { createElement, insertNode, setProp } from "@pocketjs/framework/renderer";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { useActions } from "@pocketjs/framework/actions";
import { simulationHz } from "@pocketjs/framework/clock";
import { BTN } from "@pocketjs/framework/input";
import { getOps, hostViewport } from "@pocketjs/framework/host";
import { clampCamera, followCamera } from "../engine/camera.ts";
import { deepClone } from "../engine/clone.ts";
import type { ExtensionOptions, ExtensionRuntime } from "../engine/extensions.ts";
import type { BattleRules, SceneSlot } from "../engine/battle.ts";
import type { SceneRules } from "../engine/scene.ts";
import { centerOffset } from "../engine/viewport.ts";
import {
  createSession,
  fadeOpacity,
  acquireSessionMap,
  isSessionWorldIdle,
  prepareSessionMap,
  releaseSessionMapsExcept,
  sessionPassageTable,
  startSession,
  stepSession,
  type Session,
  type SessionEffectSink,
  type SessionHostEffect,
  type SessionInput,
  type SceneOptions,
  type SessionState,
  type SessionTickDirection,
} from "../engine/session.ts";
import { isProjectShell, MapNotReadyError } from "../engine/map-repository.ts";
import { AttractController, type AttractStatus } from "../engine/attract.ts";
import type { WorldCacheDriver } from "./world-cache-driver.ts";
import {
  activePage,
  effectiveEventAppearance,
  effectivePlayerAppearance,
  eventIdLess,
  eventKey,
  modalChanged,
  type CompiledAnim,
  type EventAppearanceState,
  type Modal,
  type TextTokenResolver,
  type TimerState,
} from "../engine/interpreter.ts";
import type {
  CameraState,
  Dir,
  Facing,
  GameEvent,
  MapDef,
  MapRepository,
  ProjectSource,
  JsonValue,
  SpriteDef,
  WorldLayout,
  WorldTraversalMode,
} from "../engine/types.ts";
import type { MapContentVersion } from "../engine/map-repository.ts";
import { PlayerSprite, playerImageKey } from "./PlayerSprite.tsx";
import { startTapWalk, stepTapWalk, TAP_WALK_DIR_BITS, type TapWalkRoute } from "./tap-to-walk.ts";
import { walkPose, type WalkPose } from "../engine/movement.ts";
import { TILE } from "../engine/tiles.ts";
import {
  cameraFocusAt,
  screenShakeOffset,
  type BalloonEffectState,
  type ScreenEffectsState,
} from "../engine/screen.ts";
import { DialogBox } from "./DialogBox.tsx";
import { createDialogPaginator } from "./dialog-pages.ts";
import { slotMeasure } from "./text-measure.ts";
import { wrapLabel } from "./list-window.ts";
import { formatUiText, KIT_UI_TEXT, mergeUiText, withUiText, type UiTextOverrides } from "../engine/ui-text.ts";
import { resolveChoiceIcon, type ChoiceIconBoxComponent } from "./choice-icons.ts";
import type { ItemIconRowComponent } from "./item-icon.ts";
import { resolveUiTheme, type UiTheme } from "./theme.ts";
import type {
  GameAssets,
  GameMapLayerAssets,
  GameScreenLayerAssets,
  MapLayerVariant,
  NpcArt,
  ScreenLayerVariant,
} from "./game-assets.ts";
import { AnimatedTiles, type AnimatedTilesStats } from "./AnimatedTiles.tsx";
import { MapAnimLayer, type MapAnimStats } from "./MapAnimLayer.tsx";
import type { ParallaxLayerComponent } from "./parallax-contract.ts";
import { BalloonLayer, type BalloonAnchor } from "./BalloonLayer.tsx";
import {
  ScreenEffectsLayer,
  ScreenFadeLayer,
} from "./ScreenEffectsLayer.tsx";
import {
  dispatchGameViewHostEffects,
  type GameViewHostCallbacks,
} from "./game-host-actions.ts";
import { ChunkLayer } from "./ChunkLayer.tsx";
import { npcArt, npcArtHeight, npcArtKey, spritePaints } from "./npc-art.ts";
import { StreamedChunkLayer, type StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import { actorDepth, OccludingUpperLayer } from "./OccludingUpperLayer.tsx";
import { startupProfileMark } from "../startup-profile.ts";
import { frameProfileMark } from "../frame-profile.ts";
import { attractRewindOptions, type GameViewDemoConfig, type GameViewOverlayConfig, type GameViewSessionHost } from "./demo-contract.ts";
import type {
  GameViewWorldConfig,
  GameViewWorldPreviewSource,
  WorldNpcPreviewStats,
  WorldPreviewHandover,
} from "./world-contract.ts";

type Sprites = Record<string, SpriteDef>;

// The PocketJS spec screen; console hosts render at exactly this size.
const SCREEN_W = 480;
const SCREEN_H = 272;

/** A stable description for a falsy async prepare rejection reason, so the
 *  loading path can report it instead of hanging on an empty reason. */
function describeMapPrepareRejection(reason: unknown): string {
  if (reason === undefined) return "undefined";
  if (reason === null) return "null";
  if (typeof reason === "string") return reason === "" ? '""' : reason;
  return String(reason);
}


/** Events that ever show a character image, indexed in stable mount order. */
function collectMapSlots(map: MapDef): GameEvent[] {
  const slots: GameEvent[] = [];
  for (const ev of [...(map.events as GameEvent[])].sort((a, b) => (eventIdLess(a.id, b.id) ? -1 : a.id === b.id ? 0 : 1))) {
    slots.push(ev);
  }
  return slots;
}

interface NpcRenderSlot {
  frame: NpcFrame;
  character: SessionState["chars"]["chars"][string] | undefined;
  appearance: Readonly<EventAppearanceState> | undefined;
  needsPaint: boolean;
  node: NodeMirror;
  px: number;
  py: number;
}

type NpcFrame = [number, number, string, 16 | 32, number, boolean];
const HIDDEN_NPC_FRAME: NpcFrame = [0, 0, "", 16, 1, false];

function sameNpcFrame(a: NpcFrame, b: NpcFrame): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] &&
    a[3] === b[3] && a[4] === b[4] && a[5] === b[5];
}

function depthOrder(points: readonly (readonly [number, number, ...unknown[]])[], worldWidth: number): string {
  const actors = points
    .map((_, index) => index)
    .sort((a, b) => actorDepth(points[a]![0]!, points[a]![1]!, worldWidth)
      - actorDepth(points[b]![0]!, points[b]![1]!, worldWidth) || a - b);
  return `${points.map((point) => Math.floor((Math.floor(point[1]!) - 2) / TILE))}|${actors}`;
}

function npcFrame(
  state: SessionState,
  event: GameEvent,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  extensions: ExtensionRuntime,
  handover?: WorldPreviewHandover,
): NpcFrame {
  const ch = state.chars.chars[event.id];
  // An erased event has no character; without this its active page would
  // still paint at the authored cell (Erase Event must hide it until the
  // map is re-entered).
  if (!ch && Object.prototype.hasOwnProperty.call(state.interp.erased, eventKey(state.mapId, event.id))) {
    return HIDDEN_NPC_FRAME;
  }
  const active = ch && event.pages[ch.pageIndex]
    ? { page: event.pages[ch.pageIndex]!, index: ch.pageIndex }
    : activePage(event, state.sw, state.mapId, state.move.facing, {
        runtime: extensions,
        ext: state.ext,
      }, { worldIdle: isSessionWorldIdle(state) });
  const appearance = effectiveEventAppearance(
    { pageIndex: active?.index ?? -1, sprite: active?.page.sprite ?? null },
    state.interp.eventAppearances?.[event.id],
  );
  const art = npcArt(appearance.sprite, sprites, npcSrc);
  if (ch) {
    return [
      ch.px,
      ch.py,
      npcArtKey(art, walkPose(ch.phase), ch.facing),
      npcArtHeight(art),
      appearance.opacity / 255,
      appearance.visible && art !== "",
    ];
  }
  // Not spawned yet (the map-entry frame before page sync). Ordinary
  // transfers keep the historical authored-cell, facing-down frame.
  if (state.leftMap === undefined) {
    return [
      event.x * TILE,
      event.y * TILE,
      npcArtKey(art, 0, 0),
      npcArtHeight(art),
      appearance.opacity / 255,
      appearance.visible && art !== "",
    ];
  }
  // A seamless commit frame (it always records the map it left). With a
  // sandboxed neighbour preview, paint the snapshot it showed a frame ago:
  // it is the first target tick, which entry-time programs may already have
  // changed (a spawned character is not on its entry page yet here).
  if (handover?.lookup && state.interp.frame === 0) {
    const snapshot = handover.lookup(state.mapId, event.id);
    if (snapshot === null) return HIDDEN_NPC_FRAME;
    if (snapshot !== undefined) {
      const shown = npcArt(snapshot.sprite, sprites, npcSrc);
      return [
        snapshot.px,
        snapshot.py,
        npcArtKey(shown, snapshot.pose, snapshot.facing),
        npcArtHeight(shown),
        snapshot.opacity / 255,
        shown !== "",
      ];
    }
  }
  // Otherwise paint the character exactly as syncPages will create it, from
  // the durable placement or the authored cell, facing the placement/page
  // direction, so it matches the static neighbour preview it replaces.
  const placed = state.interp.placements[event.id];
  const dir = placed?.dir ?? active?.page.dir;
  return [
    (placed ? placed.x : event.x) * TILE,
    (placed ? placed.y : event.y) * TILE,
    npcArtKey(art, 0, dir ? FACING_OF[dir] : 0),
    npcArtHeight(art),
    appearance.opacity / 255,
    appearance.visible && art !== "",
  ];
}

const FACING_OF: Readonly<Record<Dir, Facing>> = { down: 0, left: 1, up: 2, right: 3 };

function npcStyle(height: 16 | 32, depth: number, opacity: number, visible: boolean) {
  return {
    posType: 1,
    insetL: 0,
    insetT: TILE - height,
    width: TILE,
    height,
    zIndex: depth,
    opacity,
    display: visible ? 0 : 1,
  };
}

/** Optional per-frame diagnostics. Arrays are allocated only when a caller
 *  installs the hook; normal game frames pay no tracing allocation. */
export interface ActorRenderStats {
  /** Slots whose dependency identities were inspected this host frame. */
  scanned: number;
  /** Event ids whose complete render frame had to be derived again. */
  recomputed: readonly string[];
  /** Event ids whose image or inline style was submitted to the renderer. */
  updated: readonly string[];
}

interface PlayerRenderFrame {
  src: string;
  height: 16 | 32;
  opacity: number;
  visible: boolean;
}

function playerFrame(
  state: SessionState,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  builtIn: GameAssets["player"],
  builtInHeight: 16 | 32,
): PlayerRenderFrame {
  const appearance = effectivePlayerAppearance(state.sw);
  if (appearance.sprite === null) {
    return {
      src: playerImageKey(walkPose(state.move.phase), state.move.facing, builtIn),
      height: builtInHeight,
      opacity: appearance.opacity / 255,
      visible: appearance.visible,
    };
  }
  const art = spritePaints(sprites[appearance.sprite]) ? npcSrc[appearance.sprite] : undefined;
  return {
    src: typeof art === "string"
      ? art
      : art
        ? playerImageKey(walkPose(state.move.phase), state.move.facing, art)
        : "",
    height: typeof art === "string" || art === undefined ? 16 : art.h,
    opacity: appearance.opacity / 255,
    visible: appearance.visible && art !== undefined,
  };
}

/** Per-map actor node pool statistics (GameView's onActorStats). */
export interface ActorPoolStats extends ActorRenderStats {
  /** The map whose events the pool is currently bound to. */
  mapId: string;
  /** Slots bound to a current-map event this frame. */
  active: number;
  /** Image nodes owned by the pool (>= active). Grows when a transfer
   *  destination has more events; never shrinks. */
  pooled: number;
  /** Nodes created over this component instance's life. */
  created: number;
}

/** The only mounted actor subtree. It owns one stable image slot per event
 *  of the CURRENT map and grows the slot pool when a transfer destination
 *  has more events, rebinding without replacing native nodes. The pool
 *  never shrinks, so revisiting a small map after a big one reuses the big
 *  pool's nodes (parked hidden); `cap` (the baked global maxActors) bounds
 *  the growth and stays the resource budget. */
function CurrentMapActors(props: {
  immutableState?: boolean;
  slots: () => readonly GameEvent[];
  /** Initial pool size: the start map's event count. */
  slotCount: number;
  /** Hard upper bound on pool growth (GameAssets.maxActors / inline max). */
  cap: number;
  /** The upper-plane root the actor nodes mount under. Growth inserts new
   *  nodes there so they stay siblings of the clipped upper rows. */
  host: () => NodeMirror | undefined;
  worldWidth: number;
  sprites: Sprites;
  npcSrc: GameAssets["npcSrc"];
  extensions: ExtensionRuntime;
  /** Commit-frame snapshots from the neighbour preview (world renderer). */
  handover?: WorldPreviewHandover;
  player: GameAssets["player"];
  playerHeight: 16 | 32;
  pose: Accessor<WalkPose>;
  facing: Accessor<Facing>;
  state: () => SessionState;
  worldNode: () => NodeMirror | undefined;
  camera: () => CameraState;
  onStats?: (stats: ActorPoolStats) => void;
  /** While false, the per-frame actor sync pauses (the pool stays mounted
   *  and hidden with the world). Omit for always active. */
  active?: Accessor<boolean>;
  /** Fired once per synced frame, after the active gate. */
  onSync?: () => void;
}) {
  startupProfileMark("ui-actors:start");
  const initial = props.state();
  let slots = props.slots();
  const stride = props.worldWidth;
  let created = 0;
  /** Create one pool slot. At mount `slots` holds the start map and the
   *  initial state is current, so slots bind their event's art directly.
   *  Growth (`hidden`) runs mid-transfer against the stale mount state; the
   *  same onFrame pass rebinds the new slots, so they start parked hidden
   *  with an empty source instead of writing a throwaway frame. */
  const newSlot = (index: number, hidden = false): NpcRenderSlot => {
    const source = hidden ? undefined : slots[index];
    const frame = source
      ? npcFrame(initial, source, props.sprites, props.npcSrc, props.extensions, props.handover)
      : HIDDEN_NPC_FRAME;
    const node = createElement("image");
    setProp(node, "style", npcStyle(
      frame[3], actorDepth(frame[0], frame[1], stride), frame[4], frame[5],
    ));
    setProp(node, "src", frame[2]);
    if (source) setProp(node, "debugName", `rpgkit-npc-${source.id}`);
    created++;
    return {
      node,
      frame,
      character: source ? initial.chars.chars[source.id] : undefined,
      appearance: source ? initial.interp.eventAppearances?.[source.id] : undefined,
      needsPaint: false,
      px: frame[0],
      py: frame[1],
    };
  };
  const npcs: NpcRenderSlot[] = Array.from({ length: props.slotCount }, (_, index) => newSlot(index));
  startupProfileMark("ui-actors:pooled");

  const report = (render?: ActorRenderStats): void => {
    if (!props.onStats) return;
    props.onStats({
      mapId: props.state().mapId,
      active: slots.length,
      pooled: npcs.length,
      created,
      scanned: render?.scanned ?? 0,
      recomputed: render?.recomputed ?? [],
      updated: render?.updated ?? [],
    });
  };

  /** Grow the pool to `needed` slots, inserting only the delta nodes. The
   *  transfer rebind in the same onFrame pass configures their art, so new
   *  nodes start hidden. */
  const grow = (needed: number): void => {
    if (needed > props.cap) {
      throw new Error(
        `GameView: map ${JSON.stringify(props.state().mapId)} needs ${needed} actor slots; ` +
        `GameAssets.maxActors is ${props.cap}`,
      );
    }
    const host = props.host();
    if (!host) throw new Error("GameView: actor pool host is not mounted");
    while (npcs.length < needed) {
      const slot = newSlot(npcs.length, true);
      insertNode(host, slot.node);
      npcs.push(slot);
    }
  };

  const [playerDepth, setPlayerDepth] = createSignal(actorDepth(initial.move.px, initial.move.py, stride));
  const [playerVisual, setPlayerVisual] = createSignal(
    playerFrame(initial, props.sprites, props.npcSrc, props.player, props.playerHeight),
  );
  let hero: NodeMirror | undefined;
  let positions: JumpBatch | undefined;
  let { px, py } = initial.move;
  let { x: cx, y: cy } = props.camera();
  let order = depthOrder(
    [
      [initial.move.px, initial.move.py],
      ...npcs.slice(0, slots.length).map((npc) => [npc.px, npc.py] as const),
    ],
    stride,
  );

  const compilePositions = (): void => {
    const worldNode = props.worldNode();
    if (!worldNode || !hero) return;
    const entries: [NodeMirror, "translateX" | "translateY"][] = [
      [worldNode, "translateX"],
      [worldNode, "translateY"],
      [hero, "translateX"],
      [hero, "translateY"],
    ];
    for (let index = 0; index < slots.length; index++) {
      const npc = npcs[index]!;
      entries.push([npc.node, "translateX"], [npc.node, "translateY"]);
    }
    positions = createJumpBatch(entries);
    const state = props.state();
    const camera = props.camera();
    positions.set(0, -camera.x);
    positions.set(1, -camera.y);
    positions.set(2, state.move.px);
    positions.set(3, state.move.py);
    for (let index = 0; index < slots.length; index++) {
      const npc = npcs[index]!;
      positions!.set(4 + index * 2, npc.px);
      positions!.set(5 + index * 2, npc.py);
    }
    positions.commit();
    px = state.move.px;
    py = state.move.py;
    cx = camera.x;
    cy = camera.y;
  };

  onMount(() => {
    report();
    compilePositions();
  });

  let previousCharacters = initial.chars.chars;
  let previousAppearances = initial.interp.eventAppearances;
  const fallbackSlots: number[] = [];
  for (let index = 0; index < slots.length; index++) {
    const source = slots[index]!;
    if (initial.chars.chars[source.id] === undefined) fallbackSlots.push(index);
  }

  onFrame(() => {
    if (props.active && !props.active()) return;
    props.onSync?.();
    const trace = props.onStats;
    const recomputed = trace ? [] as string[] : undefined;
    const updated = trace ? [] as string[] : undefined;
    const state = props.state();
    const next = props.slots();
    const transfer = next !== slots;
    if (transfer) {
      slots = next;
      if (slots.length > npcs.length) grow(slots.length);
    }
    let moved = false;
    let dirty = transfer;
    const camera = props.camera();
    if (!transfer && (camera.x !== cx || camera.y !== cy)) {
      positions?.set(0, -camera.x);
      positions?.set(1, -camera.y);
      moved = true;
    }
    if (!transfer && (state.move.px !== px || state.move.py !== py)) {
      positions?.set(2, state.move.px);
      positions?.set(3, state.move.py);
      moved = true;
      dirty = true;
    }

    // A reducer-owned CharState already contains the selected page and every
    // movement/pose input. Immutable folds retain its identity until that
    // one actor changes. Event appearance entries use the same COW rule.
    // Slots without a character are conservative: their initial/inactive
    // fallback page can depend on extension state, so they are re-evaluated.
    const scanAll = transfer || !props.immutableState ||
      previousCharacters !== state.chars.chars ||
      previousAppearances !== state.interp.eventAppearances;
    const touched = transfer ? npcs.length : slots.length;
    const scanCount = scanAll ? touched : fallbackSlots.length;
    if (scanAll) fallbackSlots.length = 0;
    for (let scan = 0; scan < scanCount; scan++) {
      const index = scanAll ? scan : fallbackSlots[scan]!;
      const source = slots[index];
      const npc = npcs[index]!;
      const character = source ? state.chars.chars[source.id] : undefined;
      const appearance = source ? state.interp.eventAppearances?.[source.id] : undefined;
      if (scanAll && source && character === undefined) fallbackSlots.push(index);
      const cached = props.immutableState && !transfer && character !== undefined &&
        npc.character === character && npc.appearance === appearance;
      const computed: NpcFrame = cached
        ? npc.frame
        : source
          ? npcFrame(state, source, props.sprites, props.npcSrc, props.extensions, props.handover)
          : HIDDEN_NPC_FRAME;
      if (!cached && source) recomputed?.push(source.id);
      const frame = sameNpcFrame(npc.frame, computed) ? npc.frame : computed;
      npc.needsPaint = transfer || frame !== npc.frame;
      npc.frame = frame;
      npc.character = character;
      npc.appearance = appearance;
      if (!transfer && source && (npc.px !== frame[0] || npc.py !== frame[1])) {
        positions?.set(4 + index * 2, frame[0]);
        positions?.set(5 + index * 2, frame[1]);
        moved = true;
        dirty = true;
      }
      npc.px = frame[0];
      npc.py = frame[1];
    }
    previousCharacters = state.chars.chars;
    previousAppearances = state.interp.eventAppearances;
    let reorder = transfer;
    if (dirty) {
      const nextOrder = depthOrder([
        [state.move.px, state.move.py],
        ...npcs.slice(0, slots.length).map((npc) => npc.frame),
      ], stride);
      reorder ||= order !== nextOrder;
      order = nextOrder;
    }
    if (transfer) compilePositions();
    else if (moved) positions?.commit();
    if (reorder) setPlayerDepth(actorDepth(state.move.px, state.move.py, stride));
    const paintAll = transfer || reorder;
    const paintCount = paintAll ? touched : scanCount;
    for (let paint = 0; paint < paintCount; paint++) {
      const index = paintAll ? paint : scanAll ? paint : fallbackSlots[paint]!;
      const npc = npcs[index]!;
      if (!paintAll && !npc.needsPaint) continue;
      const frame = npc.frame;
      const oldStyle = npc.node.domAttrs?.style as ReturnType<typeof npcStyle> | undefined;
      let changed = false;
      const oldSrc = npc.node.domAttrs?.src as string | undefined;
      if (oldSrc !== frame[2]) {
        setProp(npc.node, "src", frame[2], oldSrc);
        changed = true;
      }
      const depth = slots[index] && reorder
        ? actorDepth(frame[0], frame[1], stride)
        : oldStyle?.zIndex ?? 0;
      const display = frame[5] ? 0 : 1;
      if (!oldStyle || oldStyle.height !== frame[3] || oldStyle.zIndex !== depth ||
          oldStyle.opacity !== frame[4] || oldStyle.display !== display) {
        setProp(npc.node, "style", npcStyle(frame[3], depth, frame[4], frame[5]), oldStyle);
        changed = true;
      }
      if (changed && slots[index]) updated?.push(slots[index]!.id);
      if (transfer) {
        setProp(
          npc.node,
          "debugName",
          slots[index] ? `rpgkit-npc-${slots[index]!.id}` : undefined,
          npc.node.domAttrs?.debugName,
        );
      }
      npc.needsPaint = false;
    }
    px = state.move.px;
    py = state.move.py;
    cx = camera.x;
    cy = camera.y;
    const nextPlayer = playerFrame(state, props.sprites, props.npcSrc, props.player, props.playerHeight);
    setPlayerVisual((current) =>
      current.src === nextPlayer.src &&
      current.height === nextPlayer.height &&
      current.opacity === nextPlayer.opacity &&
      current.visible === nextPlayer.visible
        ? current
        : nextPlayer,
    );
    if (trace) report({ scanned: scanCount, recomputed: recomputed!, updated: updated! });
  });

  const view = (
    <>
      <PlayerSprite
        pose={props.pose()}
        facing={props.facing()}
        frames={props.player}
        src={playerVisual().src}
        height={playerVisual().height}
        opacity={playerVisual().opacity}
        visible={playerVisual().visible}
        zIndex={playerDepth()}
        debugName="rpgkit-player"
        ref={(node) => {
          hero = node;
        }}
      />
      {npcs.map((npc) => npc.node as any)}
    </>
  );
  startupProfileMark("ui-actors:end");
  return view;
}

const EMPTY_CHUNKS: Readonly<Record<string, readonly string[]>> = {};
const EMPTY_REFS: Readonly<Record<string, readonly (string | null)[]>> = {};
const EMPTY_COLUMNS: Readonly<Record<string, number>> = {};

function selectedVariant(
  id: string,
  assets: GameMapLayerAssets | GameScreenLayerAssets,
  state: SessionState,
): { name: string | null; variant: MapLayerVariant | ScreenLayerVariant | undefined; visible: boolean } {
  const override = state.interp.layers?.[id];
  const name = override?.variant ?? assets.defaultVariant ?? null;
  const variant = name === null ? undefined : assets.variants[name];
  if (name !== null && variant === undefined) {
    throw new Error(`GameView: layer ${JSON.stringify(id)} has no variant ${JSON.stringify(name)}`);
  }
  return {
    name,
    variant,
    visible: override?.visible ?? assets.defaultVisible ?? true,
  };
}

function maxLayerChunks(layer: GameMapLayerAssets): number {
  let max = 1;
  for (const variant of Object.values(layer.variants)) {
    if (!("chunks" in variant)) continue;
    for (const chunks of Object.values(variant.chunks)) max = Math.max(max, chunks.length);
  }
  return layer.maxChunks ?? max;
}

/** One optional extra world-space band. Its nodes stay mounted across
 * visibility and variant changes; a source key makes streamed textures
 * release/rebind without rebuilding any map art. */
function ExtraMapLayer(props: {
  id: string;
  layer: GameMapLayerAssets;
  mapId: Accessor<string>;
  revision: Accessor<number>;
  state: () => SessionState;
  camera: () => CameraState;
  viewport: () => { w: number; h: number };
  active: Accessor<boolean>;
}) {
  const selection = () => {
    props.revision();
    return selectedVariant(props.id, props.layer, props.state());
  };
  const variant = (): MapLayerVariant | undefined => {
    const value = selection().variant;
    if (value === undefined) return undefined;
    if (!("chunks" in value) && !("refs" in value)) {
      throw new Error(`GameView: map layer ${JSON.stringify(props.id)} selected a screen variant`);
    }
    if (props.layer.mode === "eager" && !("chunks" in value)) {
      throw new Error(`GameView: eager layer ${JSON.stringify(props.id)} requires eager variants`);
    }
    if (props.layer.mode === "streamed" && !("refs" in value)) {
      throw new Error(`GameView: streamed layer ${JSON.stringify(props.id)} requires streamed variants`);
    }
    return value;
  };
  const streamedVariant = () => {
    const value = variant();
    return value && "refs" in value ? value : undefined;
  };
  const eagerVariant = () => {
    const value = variant();
    return value && "chunks" in value ? value : undefined;
  };
  const firstStreamed = Object.values(props.layer.variants).find(
    (candidate): candidate is Extract<MapLayerVariant, { refs: unknown }> => "refs" in candidate,
  );
  if (props.layer.mode === "streamed") {
    if (!firstStreamed) throw new Error(`GameView: streamed layer ${JSON.stringify(props.id)} has no source`);
    for (const candidate of Object.values(props.layer.variants)) {
      if (!("refs" in candidate) || candidate.chunkPx !== firstStreamed.chunkPx) {
        throw new Error(`GameView: streamed layer ${JSON.stringify(props.id)} variants must share chunkPx`);
      }
    }
  }
  return props.layer.mode === "streamed" ? (
    <StreamedChunkLayer
      mapId={props.mapId()}
      refs={streamedVariant()?.refs ?? EMPTY_REFS}
      columns={streamedVariant()?.columns ?? EMPTY_COLUMNS}
      chunkPx={firstStreamed!.chunkPx}
      camera={props.camera}
      viewport={props.viewport}
      margin={streamedVariant()?.margin}
      loadBudget={streamedVariant()?.loadBudget}
      sourceKey={`${props.id}:${selection().name ?? ""}`}
      visible={selection().visible && streamedVariant() !== undefined}
      active={props.active}
      debugName={`rpgkit-layer-${props.id}`}
    />
  ) : (
    <ChunkLayer
      names={eagerVariant()?.chunks[props.mapId()] ?? []}
      columns={eagerVariant()?.columns[props.mapId()] ?? 1}
      slots={maxLayerChunks(props.layer)}
      visible={selection().visible && eagerVariant() !== undefined}
      debugName={`rpgkit-layer-${props.id}`}
    />
  );
}

function ScreenVisualLayer(props: {
  id: string;
  layer: GameScreenLayerAssets;
  revision: Accessor<number>;
  state: () => SessionState;
}) {
  const selection = () => {
    props.revision();
    return selectedVariant(props.id, props.layer, props.state());
  };
  const variant = (): ScreenLayerVariant | undefined => {
    const value = selection().variant;
    if (value === undefined) return undefined;
    if ("chunks" in value || "refs" in value) {
      throw new Error(`GameView: screen layer ${JSON.stringify(props.id)} selected a map variant`);
    }
    return value;
  };
  return (
    <View
      class="absolute w-full h-full"
      style={{
        posType: 1,
        bgColor: variant()?.color ?? "#00000000",
        opacity: variant()?.opacity ?? 1,
        display: selection().visible && variant() !== undefined ? 0 : 1,
      }}
      debugName={`rpgkit-screen-layer-${props.id}`}
    >
      <Image
        class="absolute w-full h-full"
        src={variant()?.image ?? ""}
        style={{ posType: 1, display: variant()?.image ? 0 : 1 }}
      />
    </View>
  );
}

function StartupProfileTail() {
  onMount(() => startupProfileMark("game-view:mounted"));
  return null;
}

// Bench-only mount/unmount tracing (frame-profile.ts): a pass-through
// component that records when a Show branch mounts and unmounts, so native
// QuickJS benches can attribute entry/exit frame time to the world subtree,
// the dialog box and the battle scene. Adds no nodes of its own.
function ProfileMount(props: { stage: string; children: JSX.Element }) {
  onMount(() => frameProfileMark(`${props.stage}:mount`));
  onCleanup(() => frameProfileMark(`${props.stage}:unmount`));
  return props.children;
}

// The view exposes its bare reducer state and camera to sim tests; the
// read-only globals carry no behavior.
declare global {
  // eslint-disable-next-line no-var
  var __rpgSessionState: SessionState | undefined;
  // eslint-disable-next-line no-var
  var __rpgGameCamera: CameraState | undefined;
  // eslint-disable-next-line no-var
  var __rpgPlayerScreen: { x: number; y: number } | undefined;
}

/** A game-owned scene renderer is deliberately read-only. All animation,
 * selection and battle data must live in the supplied JSON state so replay
 * and rewind reproduce the same pixels. */
export interface BattleSceneViewProps {
  state: JsonValue;
  width: number;
  height: number;
  /** False while the once-mounted scene is hidden between battles. Resource
   * scopes use this edge to release the completed battle's texture pins. */
  active: boolean;
  /** Game-scene-only UI bridge. A renderer may request one indexed entry;
   *  GameView folds it through SessionInput on the next live-play frame.
   *  Battle renderers and attract playback receive no callback. */
  onSelectIndex?: (index: number) => void;
  /** The kit's words replaced by the game (project `uiText` under
   *  GameView's prop), for scene views that draw kit text such as the name
   *  input. Undefined when the game replaces none. */
  uiText?: UiTextOverrides;
}

export type BattleSceneComponent = Component<BattleSceneViewProps>;

/** KG1: a game-registered scene renderer receives the same read-only props
 *  as a battle scene: reducer state plus the live logical resolution. All
 *  animation and selection must live in the JSON state so replay and rewind
 *  reproduce the same pixels. */
export type SceneComponent = Component<BattleSceneViewProps>;

/** Optional host-side effects observe reducer state but cannot mutate it.
 * Keeping the component injected lets apps that do not opt in exclude an
 * effect implementation (and its host SDK imports) from their bundle. */
export interface GameEffectsProps {
  state: () => Readonly<SessionState>;
}

export type GameEffectsComponent = Component<GameEffectsProps>;

/** Read-only inputs shared by optional screen-presentation layers. Reducer
 * state remains the only animation clock; presentation components cannot
 * mutate the session. */
export interface GameScreenPresentationProps {
  screen: Accessor<ScreenEffectsState | undefined>;
  timer: Accessor<TimerState | undefined>;
  layers: Readonly<Record<string, GameScreenLayerAssets>>;
  width: Accessor<number>;
  height: Accessor<number>;
}

export type GameScreenPresentationComponent = Component<GameScreenPresentationProps>;

/** Explicit screen-presentation seam. `effects` paints between the base
 * backdrop and tint/flash; `hud` paints above them but below dialogs. */
export interface GameScreenPresentation {
  fingerprint: (
    screen: Readonly<ScreenEffectsState> | undefined,
    timer: Readonly<TimerState> | undefined,
  ) => string;
  effects?: GameScreenPresentationComponent;
  hud?: GameScreenPresentationComponent;
}

export {
  dispatchGameViewHostActions,
  dispatchGameViewHostEffects,
  hostActionAllowed,
  type GameViewHostCallbacks,
} from "./game-host-actions.ts";

export interface GameViewProps {
  /** Enable identity-based reducer and actor caches. Published snapshots
   *  must be treated as read-only while this option is enabled. */
  immutableState?: boolean;
  project: ProjectSource;
  /** Required with ProjectShell; omitted for backwards-compatible inline
   * projects. Local repositories acquire synchronously. */
  maps?: MapRepository;
  /** Exact older application builds whose saves were reviewed as compatible
   * with the current map content. They remain load-only identities. */
  compatibleSaveContent?: readonly MapContentVersion[];
  /** Pure game registrations forwarded to createSession(). */
  extensions?: ExtensionOptions;
  battle?: BattleRules;
  /** KG1: SceneRules reducers keyed by scene id, forwarded to
   *  createSession(). Register with a matching `sceneViews` entry. */
  scenes?: Record<string, SceneRules>;
  /** Full-screen scenes freeze map simulation unless explicitly enabled. */
  scene?: SceneOptions;
  /** Resolver for `{x:<key>}` text tokens, forwarded to createSession()
   *  for both live play and the attract/demo controller, so a demo, a
   *  rewind and a re-fold expand text identically. Called once per token
   *  when a box opens; must be a pure function of the view. Only consulted
   *  when the project declares `system.textTokens`. */
  textTokens?: TextTokenResolver;
  /** Full-screen renderer used while SessionState.scene is a battle. Its
   * only inputs are reducer state and the live logical resolution. */
  battleScene?: BattleSceneComponent;
  /** KG1: full-screen renderers for game scenes, keyed by scene id. A
   *  scene without a registered renderer mounts nothing (headless tests
   *  register only the rules). */
  sceneViews?: Record<string, SceneComponent>;
  /** Optional opt-in host effects, such as `pocket-rpgkit/ui/audio`. */
  effects?: GameEffectsComponent;
  assets: GameAssets;
  /** One u16 button mask per 60 Hz source frame (engine/attract-tape.ts).
   *  Present: attract/takeover/rewind drive the fold. Absent: live play. */
  attractTape?: readonly number[];
  /** Traversal identity recorded with attractTape. Missing means the tape was
   * authored on the legacy transfer timeline. */
  attractTapeWorldTraversal?: WorldTraversalMode;
  /** Opt-in demo transport/menu runtime. Kept behind a factory so the base
   * GameView has no dependency on a concrete ui/demo implementation. */
  demo?: GameViewDemoConfig;
  /** Opt-in game overlay (a save/load menu, a debug panel) with live-session
   * access. It does not create an attract controller: without
   * `attractTape`/`demo`, L rewind and idle attract stay off. Load a save
   * through `loadIntoView` from `pocket-rpgkit/ui/saves`. */
  overlay?: GameViewOverlayConfig;
  /** Optional handlers for openMenu/openSave/gameOver/returnTitle commands.
   * Requests are delivered once, in command order, after their reducer frame. */
  hostActions?: Readonly<GameViewHostCallbacks>;
  /** Optional reducer-backed screen presentation. Import the RPG Maker
   * numbered-picture/timer/banner implementation from
   * `pocket-rpgkit/ui/krm2`; omitting it keeps that UI out of the bundle. */
  screenPresentation?: Readonly<GameScreenPresentation>;
  /** DialogBox colours (ui/theme.ts); missing keys keep the kit default. */
  theme?: Partial<UiTheme>;
  /** The kit's interface words (engine/ui-text.ts), over the project's
   *  `uiText`: any subset of keys, English for the rest. */
  uiText?: UiTextOverrides;
  /** DialogBox speaker portraits: NAME -> 64x64 image src. */
  faces?: Readonly<Record<string, string>>;
  /** DialogBox portrait column width (default 72). */
  faceWidth?: number;
  /** The choices box for options with an `icon`: pass ChoiceIconBox from
   *  `pocket-rpgkit/ui/choice-icons`. Without it such a choice shows its
   *  labels in the text-only box. */
  choiceIcons?: ChoiceIconBoxComponent;
  /** Optional icon-bearing shop row. Import ItemIconRow from the dedicated
   * item-icons entry; without it itemSrc remains outside the presentation
   * path and shops retain their text-only layout. */
  itemIcons?: ItemIconRowComponent;
  /** Optional map-parallax renderer. Import ParallaxLayer from the dedicated
   * `pocket-rpgkit/ui/parallax` entry; omitting it keeps the concrete
   * renderer outside this GameView bundle. */
  parallax?: ParallaxLayerComponent;
  /** Optional diagnostics for streamed ground/upper residency. */
  onStreamStats?: (layer: "ground" | "upper", stats: StreamedChunkLayerStats) => void;
  /** Optional diagnostics for viewport-mounted animated tile sprites. */
  onAnimatedStats?: (layer: "below" | "above", stats: AnimatedTilesStats) => void;
  /** Optional diagnostics for state-driven map animation instances. */
  onMapAnimStats?: (layer: "below" | "above", stats: MapAnimStats) => void;
  /** Optional diagnostics for the per-map actor pool and immutable render cache. */
  onActorStats?: (stats: ActorPoolStats) => void;
  /** Optional diagnostics for the connected-world renderer's read-only
   *  neighbour-map character preview (fired after each repaint). */
  onWorldPreviewStats?: (stats: WorldNpcPreviewStats) => void;
  /** Per-frame heartbeat from each world layer's sync hook, fired only on
   *  frames the hook actually runs — so it stays silent while a scene gates
   *  the world. Tests use it to prove the hooks paused; omit in production. */
  onLayerSync?: (layer: "actors" | "mapAnimBelow" | "mapAnimAbove" | "balloons") => void;
  /** Browser repositories can report their frame barrier without putting
   * network timing into SessionState. null means ticking has resumed. */
  onMapLoading?: (mapId: string | null) => void;
  /** Fires when the active map changes (after the fold that changed it,
   *  including the first presented frame), with the resident MapDef. Games
   *  use it to evict per-map asset shards to the new keep-set. */
  onMapChange?: (mapId: string, map: MapDef) => void;
  /** Optional factory for the seamless-world cache driver. When the project
   *  carries a worldLayout and this is provided, GameView constructs the
   *  driver and drives it once per presented frame. The factory is a
   *  type-only seam: the driver's code ships only in the game bundle that
   *  imports it, never in the kit's own bundles. */
  createWorldCacheDriver?: (session: Session, layout: WorldLayout) => WorldCacheDriver;
  /** Opt-in connected-world renderer. Import its factory from
   * `pocket-rpgkit/ui/world`; omitting this keeps every concrete world
   * renderer module outside the application's dependency graph. */
  world?: GameViewWorldConfig;
  /** Test/debug-only signed world-camera top-left. It is sampled inside the
   * host frame and clamped to the active component. Production callers should
   * omit it so the camera follows reducer state. Used only with `world`. */
  debugWorldCamera?: () => { x: number; y: number } | undefined;
  /** Tap/click a walkable map tile to walk there (host pointer service
   *  lines; see tap-to-walk.ts). Defaults to true; the editor playtest
   *  passes false because its pointer lines drive the debug panel. */
  tapToWalk?: boolean;
}

/** KG1: renders whichever scene component the active SceneSlot selects.
 *  The component identity is stable while one scene stays open, so Solid
 *  updates the props in place instead of recreating the node tree every
 *  frame (the scene signal fires per frame with a fresh state clone). */
function SceneRenderer(props: {
  view: Component<BattleSceneViewProps>;
  state: JsonValue;
  width: number;
  height: number;
  /** False while the once-mounted scene is hidden (same contract as the
   *  battle view's active prop). */
  active: boolean;
  onSelectIndex?: (index: number) => void;
  uiText: UiTextOverrides | undefined;
}) {
  return <props.view state={props.state} width={props.width} height={props.height} active={props.active} onSelectIndex={props.onSelectIndex} uiText={props.uiText} />;
}

export function GameView(props: GameViewProps) {
  startupProfileMark("game-view:start");
  const { project, assets } = props;
  const Parallax = props.parallax;
  const Effects = props.effects;
  const ScreenPresentationEffects = props.screenPresentation?.effects;
  const ScreenPresentationHud = props.screenPresentation?.hud;
  // Shop box item display names, keyed by id (DialogBox falls back to the
  // raw id for anything absent). Derived once from the project's own item
  // catalog: the same source shop goods and inventory ids resolve against.
  const itemNames: Readonly<Record<string, { name: string; icon?: { src: string; h?: 16 | 32 } }>> = Object.fromEntries(
    project.items.map((it) => {
      const src = props.itemIcons ? assets.itemSrc?.[it.sprite] : undefined;
      return [it.id, { name: it.name, ...(src ? { icon: { src } } : {}) }];
    }),
  );
  startupProfileMark("game-view:item-names");
  // The kit's words: English unless the project or the prop replaces some.
  // Reactive memos, so swapping the `uiText` prop at run time (a language
  // switch without rebuilding the project) reaches every reader next frame.
  const uiTextOverrides = createMemo(() => mergeUiText(project.uiText, props.uiText));
  const uiText = createMemo(() => withUiText(KIT_UI_TEXT, uiTextOverrides()));
  const badgeTemplate = createMemo(() => uiTextOverrides()?.["demo.badge"]);
  // A full-screen banner's `text-sm` rows: one unless a translation is
  // wider than the screen (less 8 px each side). Read only while shown.
  const bannerRows = (key: "demo.control" | "error.event"): string[] =>
    wrapLabel(uiText()[key], viewport().w - 16, slotMeasure(1));
  // The rewind banner fills {seconds} from the attract config before
  // wrapping, so a translation names the real window, not a fixed 3.
  const rewindRows = (): string[] =>
    wrapLabel(
      formatUiText(uiText()["demo.rewind"], { seconds: attract?.rewindSeconds ?? 3 }),
      viewport().w - 16,
      slotMeasure(1),
    );
  // The fatal-error message wraps to the screen (less 16 px each side) and
  // the screen grows with it; nothing is cut.
  const fatalRows = (): string[] =>
    wrapLabel(fatalError() ?? "", viewport().w - 32, slotMeasure(0));
  // The attract badge repaints every frame. The English badge stays a
  // template literal on one fixed row; a replaced template is formatted and,
  // when wider than the plate, wrapped (the plate grows by its rows).
  const badgeRows = (): string[] => {
    const frame = String(demo()?.demoFrame ?? 0).padStart(3, "0");
    const frames = demo()?.tapeFrames ?? 0;
    const template = badgeTemplate();
    if (template === undefined) return [`DEMO ${frame}/${frames}`];
    const text = formatUiText(template, { frame, frames });
    return wrapLabel(text, Math.min(viewport().w - 16, 200), slotMeasure(0));
  };
  if ((props.battle === undefined) !== (props.battleScene === undefined)) {
    throw new Error("GameView: battle and battleScene must be registered together");
  }
  const BattleSceneView = props.battleScene;
  const stream = assets.stream;
  // The base view knows only this type-only seam. All component indexing,
  // camera projection and multi-map render modules live behind the explicit
  // `pocket-rpgkit/ui/world` factory supplied by the game.
  const worldRenderer = stream && project.worldLayout && props.world
    ? props.world.create({
        layout: project.worldLayout,
        tileSize: project.tileSize,
        debugCamera: props.debugWorldCamera,
      })
    : undefined;
  const WorldRendererView = worldRenderer?.View;
  const hasAnimatedTiles = assets.animated !== undefined;
  const layerAssets = assets.layers ?? {};
  const groundLayer = layerAssets.ground?.placement === "ground" ? layerAssets.ground : undefined;
  const upperLayer = layerAssets.upper?.placement === "upper" ? layerAssets.upper : undefined;
  if (layerAssets.ground && !groundLayer) throw new Error("GameView: layer 'ground' must use placement 'ground'");
  if (layerAssets.upper && !upperLayer) throw new Error("GameView: layer 'upper' must use placement 'upper'");
  const expectedMode = stream ? "streamed" : "eager";
  if (groundLayer && groundLayer.mode !== expectedMode) {
    throw new Error(`GameView: ground variants must use ${expectedMode} sources`);
  }
  if (upperLayer && upperLayer.mode !== expectedMode) {
    throw new Error(`GameView: upper variants must use ${expectedMode} sources`);
  }
  for (const [id, layer] of [["ground", groundLayer], ["upper", upperLayer]] as const) {
    if (!layer) continue;
    for (const variant of Object.values(layer.variants)) {
      if (stream) {
        if (!("refs" in variant) || variant.chunkPx !== stream.chunkPx) {
          throw new Error(`GameView: ${id} streamed variants must share the base chunkPx`);
        }
      } else if (!("chunks" in variant)) {
        throw new Error(`GameView: ${id} eager variants require eager chunk sources`);
      }
    }
  }
  const extraBelow = Object.entries(layerAssets).filter(
    (entry): entry is [string, GameMapLayerAssets] => entry[1].placement === "below",
  );
  const extraAbove = Object.entries(layerAssets).filter(
    (entry): entry is [string, GameMapLayerAssets] => entry[1].placement === "above",
  );
  const screenLayers = Object.entries(layerAssets).filter(
    (entry): entry is [string, GameScreenLayerAssets] => entry[1].placement === "screen",
  );
  const screenLayerAssets = Object.fromEntries(screenLayers) as Record<string, GameScreenLayerAssets>;
  // The host rate selects how many fixed 60 Hz reference ticks each frame
  // folds. Time-bearing commands compile against that fixed reference.
  const hz = simulationHz();
  // A message longer than the dialog box takes one confirm per page. The
  // interpreter asks this paginator when a box opens: pages are cut at the
  // design width with the baked font's advances (the same on every host),
  // so the confirms a tape needs never depend on the window or the rate.
  const paginateText = createDialogPaginator(
    { viewportWidth: SCREEN_W, faces: props.faces, faceWidth: props.faceWidth, rim: !!resolveUiTheme(props.theme).rim },
    slotMeasure(),
  );
  // The controller folds the published 60 Hz tape on its source timeline
  // and maps each host frame onto that timeline. The rewind record is
  // picked field-by-field (never spread) so a hand-built demo config cannot
  // overwrite the trusted hz/maps/extensions/battle/scene/immutableState.
  const demoRewind = attractRewindOptions(props.demo?.rewind);
  const attract = props.attractTape !== undefined || props.demo !== undefined
    ? new AttractController(project, [...(props.attractTape ?? [])], {
        hz,
        maps: props.maps,
        compatibleSaveContent: props.compatibleSaveContent,
        extensions: props.extensions,
        battle: props.battle,
        scenes: props.scenes,
        scene: props.scene,
        immutableState: props.immutableState,
        paginateText,
        textTokens: props.textTokens,
        worldTraversal: props.attractTape !== undefined
          ? props.attractTapeWorldTraversal ?? "legacy-transfer"
          : project.worldTraversal,
        handoff: worldRenderer?.handoff,
        ...demoRewind,
      })
    : null;
  const session: Session = attract
    ? attract.getSession()
    : createSession(project, hz, {
        maps: props.maps,
        compatibleSaveContent: props.compatibleSaveContent,
        extensions: props.extensions,
        battle: props.battle,
        scenes: props.scenes,
        scene: props.scene,
        immutableState: props.immutableState,
        paginateText,
        textTokens: props.textTokens,
        handoff: worldRenderer?.handoff,
      });
  startupProfileMark("game-view:session");
  let state: SessionState = attract ? attract.state : startSession(project, session);
  const demoRuntime = props.demo
    ? props.demo.create({
        project,
        session,
        attract: attract!,
        getState: () => state,
      })
    : null;
  // A demo may synchronously load its initial validated chapter in create().
  // Make that controller state the render boot state before deriving any map,
  // camera, actor or scene model below.
  if (demoRuntime) state = attract!.state;
  // Set when an overlay replaced the session; the next host frame presents
  // the new state instead of folding one.
  let replaced = false;
  // Button mask of the latest folded frame (also the edge base below).
  let prevButtons = 0;
  const sessionHost: GameViewSessionHost = {
    project,
    session,
    getState: () => state,
    // Under attract the reducer folds the controller's mask (a tape mask
    // during the demo), not the host buttons.
    heldButtons: attract ? () => attract.foldedMask() : () => prevButtons,
    replaceState: (next, held = 0) => {
      if (attract) {
        // The attract timeline restarts at the loaded state as live play, so
        // rewind cannot cross the load.
        state = attract.loadState(next, held, [], false);
      } else {
        acquireSessionMap(session, next.mapId);
        releaseSessionMapsExcept(session, [next.mapId]);
        state = next;
      }
      replaced = true;
    },
  };
  // Reused collector: projects without host callbacks pass no sink at all;
  // configured hosts allocate effect records only on command ticks.
  const frameHostEffects: SessionHostEffect[] = [];
  const hostEffectSink: SessionEffectSink = {
    publish: (effect) => { frameHostEffects.push(effect); },
  };
  const overlayRuntime = props.overlay ? props.overlay.create(sessionHost) : null;
  // An overlay may also load a save while it is created.
  replaced = false;
  const readState = (): Readonly<SessionState> => state;
  startupProfileMark("game-view:state");
  globalThis.__rpgSessionState = state;

  const mapsById = session.maps;
  const sprites = (project.sprites ?? {}) as Sprites;
  const initialMap = mapsById.get(state.mapId)!;
  const inlineMaxActors = isProjectShell(project)
    ? 0
    : Math.max(0, ...project.maps.map((map) => collectMapSlots(map).length));
  // The baked global maximum stays the resource budget and hard cap; the
  // pool itself starts at the current map's needs and grows on transfer.
  const actorSlotCap = Math.max(assets.maxActors ?? 0, inlineMaxActors);
  // The start map's slots are precached and mounted directly (no cache-miss
  // grow), so they pass the same cap check here: a sharded project whose
  // entry map declares more events than the budget allows is rejected up
  // front instead of silently overshooting the resource budget.
  const initialSlots = collectMapSlots(initialMap);
  if (initialSlots.length > actorSlotCap) {
    throw new Error(
      `GameView: map ${JSON.stringify(state.mapId)} needs ${initialSlots.length} actor slots; ` +
      `GameAssets.maxActors is ${actorSlotCap}`,
    );
  }
  const slotCache = new Map<string, GameEvent[]>([[state.mapId, initialSlots]]);
  const dimensions = isProjectShell(project)
    ? project.mapIndex
    : project.maps.map((map) => ({ id: map.id, width: map.width, height: map.height }));
  const dimensionsById = new Map(dimensions.map((map) => [map.id, map]));
  const worldWidth = Math.max(1, ...dimensions.map((map) => map.width * TILE));
  const currentSlots = (): readonly GameEvent[] => {
    for (const id of [...slotCache.keys()]) if (!mapsById.has(id)) slotCache.delete(id);
    let slots = slotCache.get(state.mapId);
    if (!slots) {
      const map = mapsById.get(state.mapId);
      if (!map) throw new Error(`GameView: map ${JSON.stringify(state.mapId)} is not resident`);
      slots = collectMapSlots(map);
      if (slots.length > actorSlotCap) {
        throw new Error(
          `GameView: map ${JSON.stringify(state.mapId)} needs ${slots.length} actor slots; ` +
          `GameAssets.maxActors is ${actorSlotCap}`,
        );
      }
      slotCache.set(state.mapId, slots);
    }
    return slots;
  };

  const [mapId, setMapId] = createSignal(state.mapId);
  // Compiled animation timing for the resident map (World.anims); an empty
  // map for projects without animations keeps the layer's frame math cheap.
  const EMPTY_ANIMS: ReadonlyMap<string, CompiledAnim> = new Map();
  const worldAnims = (): ReadonlyMap<string, CompiledAnim> =>
    session.worlds.get(state.mapId)?.anims ?? EMPTY_ANIMS;
  const [pose, setPose] = createSignal<WalkPose>(walkPose(state.move.phase));
  const [facing, setFacing] = createSignal<Facing>(state.move.facing);
  const [modal, setModal] = createSignal<Modal | null>(null);
  const [demo, setDemo] = createSignal<AttractStatus | null>(attract?.status() ?? null);
  const initialScene = state.scene;
  // Reducer state has dedicated renderer signals below. This signal is only
  // the presentation key (none / battle / game-scene id), so keep it stable
  // across ordinary scene frames and avoid invalidating every visibility and
  // resource-active consumer when only reducer state changed.
  const [scene, setScene] = createSignal<SceneSlot | null>(initialScene, {
    equals: (a, b) => {
      if (a === b) return true;
      if (a === null || b === null || a.kind !== b.kind) return false;
      return a.kind === "battle" || (b.kind === "scene" && a.id === b.id);
    },
  });
  /** True while any full-screen scene (battle or game scene) owns the
   *  foreground. The world and dialog subtrees stay mounted and hidden
   *  while this is true, matching the battle keep-alive contract. */
  const sceneActive = (): boolean => scene() !== null;
  // Read-only inputs for the world renderer's neighbour-map preview; built
  // once so the renderer reads a stable object.
  const worldHandover: WorldPreviewHandover | undefined = WorldRendererView ? { lookup: null } : undefined;
  const worldPreview: GameViewWorldPreviewSource | undefined = WorldRendererView
    ? {
        state: () => state,
        // Resident MapDefs only: the preview never loads a map.
        map: (id) => session.maps.get(id) ?? session.preparingMaps.get(id)?.map,
        commonEvents: session.commonEvents,
        sprites,
        npcSrc: assets.npcSrc,
        active: () => !sceneActive(),
        onStats: props.onWorldPreviewStats,
        session,
        handover: worldHandover!,
      }
    : undefined;
  /** Id of the active game scene, or null when the active slot is a battle
   *  or no scene is open. */
  const activeSceneId = (): string | null => {
    const slot = scene();
    return slot?.kind === "scene" ? slot.id : null;
  };
  // Visibility is deliberately separate from the renderer input. On exit the
  // hidden battle subtree retains its last state, so changing only the two
  // display gates cannot invalidate every accessor inside a large scene.
  const [battleViewState, setBattleViewState] = createSignal<JsonValue | undefined>(
    initialScene?.kind === "battle" ? initialScene.state : undefined,
  );
  // Game scene views keep their last renderer state per id, same contract.
  const [sceneViewStates, setSceneViewStates] = createSignal<
    Readonly<Record<string, JsonValue>>
  >(initialScene?.kind === "scene" ? { [initialScene.id]: initialScene.state } : {});
  const [worldAnimationTick, setWorldAnimationTick] = createSignal(
    attract?.worldAnimationTick() ?? 0,
  );
  // The battle scene mounts on first use and stays mounted (hidden) for the
  // rest of the session: re-entering a battle only swaps its state prop and
  // visibility, so entry/exit frames pay no scene mount/unmount cost.
  const [battleMounted, setBattleMounted] = createSignal(initialScene?.kind === "battle");
  const [fatalError, setFatalError] = createSignal<string | null>(state.interp.error?.message ?? null);
  // Live host viewport: console hosts omit ui.__viewport (spec screen),
  // desktop windows publish and resize it. Polled in onFrame like
  // apps/launcher, so no host-specific subscription lives in the view.
  // hostViewport() returns ui.__viewport BY REFERENCE and the wasm host
  // mutates that same object on resize (hosts/web/wasm-ops.js), so keep a
  // private snapshot: comparing the shared object's fields would see the
  // new numbers through the signal's old value and never emit, leaving the
  // Solid style effect unpainted.
  const vp0 = hostViewport(getOps());
  const [viewport, setViewport] = createSignal(
    vp0 ? { w: vp0.w, h: vp0.h } : { w: SCREEN_W, h: SCREEN_H },
  );
  const firstMapId = project.start.map;
  const mapSize = (id: string): { w: number; h: number } => {
    const assetSize = assets.world[id];
    if (assetSize) return assetSize;
    const indexed = dimensionsById.get(id);
    if (!indexed) throw new Error(`GameView: unknown map size ${JSON.stringify(id)}`);
    return { w: indexed.width * TILE, h: indexed.height * TILE };
  };
  const worldFrame = createMemo(() => {
    const vp = viewport();
    const connected = worldRenderer?.frameFor(mapId(), vp);
    if (connected) return connected;
    const size = mapSize(mapId());
    const off = centerOffset(size, vp);
    return { x: off.x, y: off.y, w: Math.min(size.w, vp.w), h: Math.min(size.h, vp.h) };
  });
  const legacyCameraFor = (st: SessionState): CameraState => {
    const vp = viewport();
    const size = mapSize(st.mapId);
    const effect = st.interp.screen;
    if (!effect?.camera && !effect?.shake) {
      return followCamera(st.move.px, st.move.py, project.tileSize, st.move.facing, {
        worldW: size.w,
        worldH: size.h,
        viewportW: vp.w,
        viewportH: vp.h,
      });
    }
    const focus = cameraFocusAt(effect.camera, {
      x: st.move.px + project.tileSize / 2,
      y: st.move.py + project.tileSize / 2,
    });
    const clamped = clampCamera(focus.x - vp.w / 2, focus.y - vp.h / 2, {
      worldW: size.w,
      worldH: size.h,
      viewportW: vp.w,
      viewportH: vp.h,
    });
    const shake = screenShakeOffset(effect.shake);
    return { x: clamped.x - shake.x, y: clamped.y - shake.y, facing: st.move.facing };
  };
  const cameraFor: (st: SessionState) => CameraState = worldRenderer
    ? (st) => worldRenderer.cameraFor(st, viewport()) ?? legacyCameraFor(st)
    : legacyCameraFor;
  let camera = cameraFor(state);
  globalThis.__rpgGameCamera = camera;
  // Seamless worlds only, and only when the game opts in by supplying the
  // driver factory: keep the parsed/compiled caches on the
  // active/visible/imminent keep-sets and prefetch imminent targets across
  // frames. Projects without a worldLayout (or without the factory) never
  // construct a driver, so their hot loop gains nothing but the single
  // untaken branch below.
  const worldCache: WorldCacheDriver | null = project.worldLayout && props.createWorldCacheDriver
    ? props.createWorldCacheDriver(session, project.worldLayout)
    : null;
  const [fade, setFade] = createSignal(0);
  const layerFingerprint = (value: SessionState): string =>
    value.interp.layers ? JSON.stringify(value.interp.layers) : "";
  let paintedLayers = layerFingerprint(state);
  const [layerRevision, setLayerRevision] = createSignal(0);
  const baseScreenFingerprint = (screen: Readonly<ScreenEffectsState> | undefined): string =>
    screen && (screen.fade || screen.tints || screen.flash || screen.backdrop)
      ? JSON.stringify([screen.fade, screen.tints, screen.flash, screen.backdrop])
      : "";
  const presentationFingerprint = props.screenPresentation?.fingerprint;
  const screenFingerprint: (value: SessionState) => string = presentationFingerprint
    ? (value) => {
        const base = baseScreenFingerprint(value.interp.screen);
        const extra = presentationFingerprint(value.interp.screen, value.interp.sw.timer);
        return extra ? `${base}\u0000${extra}` : base;
      }
    : (value) => baseScreenFingerprint(value.interp.screen);
  let paintedScreen = screenFingerprint(state);
  const [screenRevision, setScreenRevision] = createSignal(0);
  const presentedScreen = () => {
    screenRevision();
    return state.interp.screen;
  };
  const presentedTimer = () => {
    screenRevision();
    return state.interp.sw.timer;
  };
  const builtInLayer = (
    id: "ground" | "upper",
    definition: GameMapLayerAssets | undefined,
  ): { name: string | null; variant?: MapLayerVariant; visible: boolean } => {
    layerRevision();
    const override = state.interp.layers?.[id];
    if (!definition) {
      if (override?.variant !== undefined) {
        throw new Error(`GameView: layer ${JSON.stringify(id)} has no variant ${JSON.stringify(override.variant)}`);
      }
      return { name: null, visible: override?.visible ?? true };
    }
    const selection = selectedVariant(id, definition, state);
    const variant = selection.variant;
    if (variant && !("chunks" in variant) && !("refs" in variant)) {
      throw new Error(`GameView: built-in layer ${JSON.stringify(id)} selected a screen variant`);
    }
    return { name: selection.name, variant: variant as MapLayerVariant | undefined, visible: selection.visible };
  };
  const groundSelection = () => builtInLayer("ground", groundLayer);
  const upperSelection = () => builtInLayer("upper", upperLayer);
  const groundStreamVariant = () => {
    const variant = groundSelection().variant;
    return variant && "refs" in variant ? variant : undefined;
  };
  const groundEagerVariant = () => {
    const variant = groundSelection().variant;
    return variant && "chunks" in variant ? variant : undefined;
  };
  const upperStreamVariant = () => {
    const variant = upperSelection().variant;
    return variant && "refs" in variant ? variant : undefined;
  };
  const activeMapCamera = (): CameraState => {
    return worldRenderer?.localCameraFor(mapId(), camera) ?? camera;
  };
  // The cache driver works in component-world pixels (see world-contract.ts).
  // With a renderer the presented camera is already world; without one,
  // promote the legacy map-local camera by the active placement's origin so
  // the driver receives one coordinate space regardless of the renderer.
  const worldCameraForDriver = (st: SessionState): CameraState => {
    if (worldRenderer || !project.worldLayout) return camera;
    for (const component of project.worldLayout.components) {
      for (const placement of component.placements) {
        if (placement.mapId === st.mapId) {
          return {
            x: camera.x + placement.originTileX * project.tileSize,
            y: camera.y + placement.originTileY * project.tileSize,
            facing: camera.facing,
          };
        }
      }
    }
    return camera;
  };
  startupProfileMark("game-view:model");

  // Live play fires reducer edges from the action handlers. Under the
  // attract controller the legend is presentational: every press edge
  // (confirm, cancel, choices up/down) is derived from the folded button
  // mask (one unified input stream), so the view never fires edges itself.
  const edge = { confirm: false, cancel: false };
  // A Focusable press is delivered after frame hooks. Retain it for exactly
  // the next reducer fold, tagged with its scene so a close/swap cannot send
  // a stale index elsewhere. Classic CIRCLE also fires Focusable.onPress;
  // ignore that callback because the same frame already carried the normal
  // confirm edge. A touch tap releases with no CIRCLE bit and enters here.
  let scenePressButtons = 0;
  let pendingSceneSelect: { id: string; index: number } | null = null;
  const selectSceneIndex = (id: string, index: number): void => {
    if (
      attract ||
      activeSceneId() !== id ||
      (scenePressButtons & BTN.CIRCLE) !== 0 ||
      !Number.isInteger(index)
    ) return;
    pendingSceneSelect = { id, index };
  };
  const confirm = attract ? undefined : () => { edge.confirm = true; };
  const cancel = attract ? undefined : () => { edge.cancel = true; };
  const actions = useActions(createMemo(() => {
    if (demoRuntime?.isOpen() || overlayRuntime?.isOpen()) return {};
    // Built inside the memo so a run-time uiText prop swap rewords the
    // legend labels on the next frame.
    const t = uiText();
    const talkActions = { confirm: { label: t["legend.talk"], run: confirm } };
    const textActions = { confirm: { label: t["legend.next"], run: confirm } };
    const choiceActions = { confirm: { label: t["legend.ok"], run: confirm } };
    const backActions = { ...choiceActions, back: { label: t["legend.back"], run: cancel } };
    // A full-screen scene is the sole foreground input owner. Map modals
    // remain parked in reducer state while the world is frozen, but must not
    // capture confirm/back until the scene closes and reveals them again.
    if (sceneActive()) {
      return backActions;
    }
    const m = modal();
    if (m?.kind === "choices") {
      return m.cancellable ? backActions : choiceActions;
    }
    if (m?.kind === "shop") {
      return backActions;
    }
    return m ? textActions : talkActions;
  }));

  // The world camera and actor slots stay stable across transfers, so their
  // coordinates can share one precompiled position batch.
  let worldNode: NodeMirror | undefined;
  // The upper-plane root the actor pool mounts under; growth inserts there.
  let actorHost: NodeMirror | undefined;
  let blocked: {
    buttons: number;
    input?: SessionInput;
    ready: boolean;
    /** A prepare rejection was observed. Separate from `error` so a falsy
     *  rejection reason (undefined/null/0/"") still surfaces instead of
     *  hanging the view on the loading screen forever. */
    failed: boolean;
    error?: Error;
  } | null = null;

  // ---- tap-to-walk --------------------------------------------------------
  // View-local only: the route never enters the reducer, so saves, rewind
  // and attract tapes are untouched. A tap (host pointer service line) on a
  // walkable tile plans one BFS route; each frame then folds one direction
  // bit until the player arrives, a modal opens, the map changes or a real
  // direction press takes over.
  const tapToWalk = props.tapToWalk !== false;
  let tapRoute: TapWalkRoute | null = null;
  let tapDown: { x: number; y: number } | null = null;
  const TAP_SLOP = 12;

  /** Drain the host's pointer lines and report one tap (down+up without a
   *  drag). Lines for other consumers are not expected in a GameView app;
   *  everything pending is drained so a tap behind a modal never fires
   *  late. */
  const drainTap = (): { x: number; y: number } | null => {
    const ops = getOps();
    const batch = ops.svcPoll?.() as string | null | undefined;
    if (!batch) return null;
    let tapped: { x: number; y: number } | null = null;
    for (const line of batch.split("\n")) {
      if (!line) continue;
      let message: { t?: string; x?: number; y?: number; d?: boolean; b?: number };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (!message || message.t !== "mouse" || typeof message.x !== "number" || typeof message.y !== "number") continue;
      if (message.b !== undefined && message.b !== 0) continue; // left/touch only
      if (message.d) {
        if (tapDown && (Math.abs(message.x - tapDown.x) > TAP_SLOP || Math.abs(message.y - tapDown.y) > TAP_SLOP)) {
          tapDown = null; // a drag, not a tap
        } else if (!tapDown) {
          tapDown = { x: message.x, y: message.y };
        }
      } else if (tapDown) {
        tapped = tapDown;
        tapDown = null;
      }
    }
    return tapped;
  };

  /** Convert a tap to a tile and plan the walk. Taps while a modal, scene,
   *  battle, dialog or event-driven route owns the world are ignored. */
  const handleTap = (x: number, y: number): void => {
    const st = state;
    if (!isSessionWorldIdle(st) || st.playerRoute) return;
    if (attract && attract.status().phase !== "play") return;
    const frame = worldFrame();
    const cam = activeMapCamera();
    const tx = Math.floor((x - frame.x + cam.x) / project.tileSize);
    const ty = Math.floor((y - frame.y + cam.y) / project.tileSize);
    tapRoute = startTapWalk(
      sessionPassageTable(session, st),
      st.move.tx,
      st.move.ty,
      tx,
      ty,
      st.mapId,
      st.move.px,
      st.move.py,
    );
  };

  /** Re-validate the active route against one state snapshot and report the
   *  direction bit to fold next (0 when there is no route). Called once per
   *  reference tick: at the host frame's start for tick 0, and from the
   *  session's tick-direction resolver on every following tick, so a route
   *  turns at the tile instead of holding one direction across a whole
   *  low-rate host frame. */
  const tapWalkStep = (buttons: number, st: SessionState): number => {
    if (!tapRoute) return 0;
    const userDir = buttons & (BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT);
    if (
      !isSessionWorldIdle(st) ||
      st.playerRoute ||
      st.mapId !== tapRoute.mapId ||
      (attract && attract.status().phase !== "play") ||
      userDir !== 0
    ) {
      tapRoute = null;
      return 0;
    }
    const step = stepTapWalk(tapRoute, st.move.tx, st.move.ty, st.move.px, st.move.py);
    if (!step.alive || step.dir === null) {
      tapRoute = null;
      return 0;
    }
    return TAP_WALK_DIR_BITS[step.dir] ?? 0;
  };

  /** The direction bit to fold this frame's first tick, plus the per-tick
   *  resolver for the ticks that follow (undefined without a route, so the
   *  reducer's hot path stays untouched). */
  const tapWalkFrame = (buttons: number): { bit: number; hook: SessionTickDirection | undefined } => {
    const bit = tapWalkStep(buttons, state);
    return { bit, hook: tapRoute ? (st) => tapWalkStep(buttons, st) : undefined };
  };

  const syncPresentedState = (
    prev: SessionState,
    status: AttractStatus | null,
    nextWorldAnimationTick: number,
  ): void => {
    globalThis.__rpgSessionState = state;

    camera = cameraFor(state);
    globalThis.__rpgGameCamera = camera;
    // The player's top-left in logical screen pixels (letterbox + camera
    // aware, both renderers). Test/debug hook for tap-to-walk verification;
    // carries no behavior.
    {
      const frame = worldFrame();
      const localCam = activeMapCamera();
      globalThis.__rpgPlayerScreen = {
        x: state.move.px - localCam.x + frame.x,
        y: state.move.py - localCam.y + frame.y,
      };
    }

    // Seamless-world cache policy: prefetch imminent targets and evict every
    // layer to its keep-set. Derived-cache only; the fold above is untouched.
    // The viewport signal is read only when a driver exists, so projects
    // without a worldLayout pay a single untaken branch per frame. The
    // driver receives a component-world camera (see world-contract.ts).
    if (state.mapId !== prev.mapId) {
      props.onMapChange?.(state.mapId, session.maps.get(state.mapId)!);
    }
    if (worldCache) worldCache.sync(state, worldCameraForDriver(state), viewport());

    const op = fadeOpacity(state.fade);
    frameProfileMark("signals:start");
    const nextLayers = layerFingerprint(state);
    const nextScreen = screenFingerprint(state);
    batch(() => {
      if (state.mapId !== prev.mapId || mapId() !== state.mapId) setMapId(state.mapId);
      // The walker pose is a pure function of the saved mover phase, so a
      // restore at any host frame offset renders identical pixels (R1202-2).
      const nextPose = walkPose(state.move.phase);
      if (nextPose !== pose()) setPose(nextPose);
      if (state.move.facing !== facing()) setFacing(state.move.facing);
      if (op !== fade()) setFade(op);
      if (nextWorldAnimationTick !== worldAnimationTick()) {
        setWorldAnimationTick(nextWorldAnimationTick);
      }
      if (nextLayers !== paintedLayers) {
        paintedLayers = nextLayers;
        setLayerRevision((revision) => revision + 1);
      }
      if (nextScreen !== paintedScreen) {
        paintedScreen = nextScreen;
        setScreenRevision((revision) => revision + 1);
      }
      const shownModal = attract ? attract.presentedModal() : state.interp.modal;
      setModal((m) => (modalChanged(m, shownModal) ? deepClone(shownModal) : m));
      // stepSession publishes a fresh scene value for every frame. The
      // injected renderers are read-only, so cloning the complete scene state
      // again here only adds a second presentation-boundary traversal.
      const nextScene = state.scene;
      if (nextScene?.kind === "battle") {
        setBattleViewState(nextScene.state);
        setBattleMounted(true);
      } else if (nextScene?.kind === "scene") {
        const id = nextScene.id;
        const nextState = nextScene.state;
        setSceneViewStates((m) => (m[id] === nextState ? m : { ...m, [id]: nextState }));
      }
      setScene(nextScene);
      setFatalError(state.interp.error?.message ?? null);
      if (status) {
        const st = status;
        setDemo((d) =>
          d === null ||
          d.phase !== st.phase ||
          d.demoFrame !== st.demoFrame ||
          d.controlNotice !== st.controlNotice ||
          d.rewindNotice !== st.rewindNotice ||
          d.idle !== st.idle
            ? { ...st }
            : d,
        );
      }
    });
    frameProfileMark("signals:end");
  };

  onFrame((buttons) => {
    frameProfileMark("frame:start");
    scenePressButtons = buttons;
    const pressed = buttons & ~prevButtons;
    const upEdge = !!(pressed & BTN.UP);
    const downEdge = !!(pressed & BTN.DOWN);
    const leftEdge = !!(pressed & BTN.LEFT);
    const rightEdge = !!(pressed & BTN.RIGHT);

    // Pick up a desktop window resize before this frame's layout reads the
    // centering offset (hostViewport stays the one runtime fact).
    const nextViewport = hostViewport(getOps());
    if (
      nextViewport &&
      (nextViewport.w !== viewport().w || nextViewport.h !== viewport().h)
    ) {
      setViewport({ w: nextViewport.w, h: nextViewport.h });
    }

    // Tap-to-walk: drain the host's pointer lines every frame (so a tap
    // behind an open menu never fires late) and convert one tap into a
    // walking target before the fold below.
    const tapped = tapToWalk ? drainTap() : null;

    // Under attract the controller owns the fold: a tape mask or the live
    // mask, takeover, rewind and the idle attract entry all resolve inside it.
    const prev = state;
    let status: AttractStatus | null = null;
    if (blocked) {
      if (blocked.failed) throw blocked.error;
      if (!blocked.ready) return;
    }
    if (overlayRuntime && (replaced || !blocked)) {
      const overlayStep = replaced ? null : overlayRuntime.step(buttons, pressed);
      if (replaced || overlayStep?.consumed || overlayStep?.stateChanged) {
        // Same contract as a demo menu: the overlay owns this host frame, and
        // a replaced session is presented without an extra world tick.
        if (replaced && blocked) props.onMapLoading?.(null);
        if (replaced) blocked = null;
        replaced = false;
        tapRoute = null;
        attract?.syncLiveButtons(buttons);
        prevButtons = buttons;
        edge.confirm = false;
        edge.cancel = false;
        syncPresentedState(
          prev,
          attract ? attract.status() : null,
          attract ? attract.worldAnimationTick() : worldAnimationTick(),
        );
        frameProfileMark("frame:end");
        return;
      }
    }
    if (!blocked && demoRuntime) {
      const demoStep = demoRuntime.step(buttons, pressed);
      if (demoStep.consumed || demoStep.stateChanged) {
        // Menu/transport input owns this host frame. Keep both edge domains
        // aligned while folding no reducer input; a restored chapter is
        // presented directly, without an accidental extra world tick.
        tapRoute = null;
        attract!.syncLiveButtons(buttons);
        prevButtons = buttons;
        edge.confirm = false;
        edge.cancel = false;
        if (demoStep.stateChanged) state = attract!.state;
        syncPresentedState(prev, attract!.status(), attract!.worldAnimationTick());
        frameProfileMark("frame:end");
        return;
      }
    }
    if (tapped) handleTap(tapped.x, tapped.y);
    const { bit: tapBit, hook: tapHook } = tapWalkFrame(buttons);
    const frameButtons = blocked?.buttons ?? (buttons | tapBit);
    const selected = pendingSceneSelect?.id === activeSceneId()
      ? pendingSceneSelect.index
      : undefined;
    const input: SessionInput = blocked?.input ?? {
      buttons: frameButtons,
      confirmEdge: edge.confirm,
      cancelEdge: edge.cancel,
      upEdge,
      downEdge,
      leftEdge,
      rightEdge,
    };
    if (selected !== undefined && blocked?.input === undefined) input.selectIndex = selected;
    try {
      frameProfileMark("reducer:start");
      frameHostEffects.length = 0;
      const effects = props.hostActions === undefined ? undefined : hostEffectSink;
      if (attract) {
        const result = attract.step(frameButtons, effects, tapHook);
        state = result.state;
        status = result.status;
      } else {
        state = stepSession(session, state, input, effects, tapHook);
      }
      pendingSceneSelect = null;
      frameProfileMark("reducer:end");
      dispatchGameViewHostEffects(frameHostEffects, props.hostActions, sessionHost);
      prevButtons = frameButtons;
      if (blocked) props.onMapLoading?.(null);
      blocked = null;
    } catch (error) {
      if (!(error instanceof MapNotReadyError) || !session.repository?.prepare) throw error;
      const pending: NonNullable<typeof blocked> = {
        buttons: frameButtons,
        ...(attract ? {} : { input }),
        ready: false,
        failed: false,
      };
      blocked = pending;
      props.onMapLoading?.(error.mapId);
      void prepareSessionMap(session, error.mapId).then(
        () => { pending.ready = true; },
        (reason) => {
          // Normalize falsy reasons (undefined/null/0/"") to a stable Error:
          // the frame loop keys off `failed`, never the reason's truthiness.
          pending.failed = true;
          pending.error = reason instanceof Error
            ? reason
            : new Error(`map preparation rejected for ${error.mapId}: ${describeMapPrepareRejection(reason)}`);
        },
      );
      return;
    }
    edge.confirm = false;
    edge.cancel = false;

    const nextWorldAnimationTick = !hasAnimatedTiles
      ? 0
      : attract
        ? attract.worldAnimationTick()
        : prev.scene === null && state.scene === null
          ? (worldAnimationTick() + session.ticksPerFrame) >>> 0
          : worldAnimationTick();
    syncPresentedState(prev, status, nextWorldAnimationTick);
    frameProfileMark("frame:end");
  });

  const view = (
    <View class="w-full h-full overflow-hidden bg-black">
      {Effects ? <Effects state={readState} /> : null}
      {/* The world subtree stays mounted across full-screen scenes. Hiding
          it with display:none (core skips layout, paint and hit-testing) and
          pausing its frame hooks is far cheaper than unmounting and
          remounting the chunk, animation, occlusion and actor pools on
          every battle entry/exit. The reducer freezes world simulation
          while a scene is open, so the paused subtree resumes from
          identical state when the scene closes. */}
      <ProfileMount stage="world">
        {/* The frame clips each axis to min(map, viewport). Undersized axes
            are centered over the black root; oversized axes start at zero
            and the inner world translates by the clamped follow camera. */}
        <View
          class="absolute overflow-hidden"
          style={{
            posType: 1,
            insetL: worldFrame().x,
            insetT: worldFrame().y,
            width: worldFrame().w,
            height: worldFrame().h,
            ...(hasAnimatedTiles ? { spriteClock: worldAnimationTick() } : {}),
            // display: 0 shows, 1 hides (spec Display::None).
            display: sceneActive() ? 1 : 0,
          }}
          debugName="rpgkit-world-frame"
        >
          {assets.parallaxes && Parallax ? (
            <Parallax
              state={() => state}
              camera={activeMapCamera}
              viewport={() => ({ w: worldFrame().w, h: worldFrame().h })}
              mapSize={mapSize}
              assets={assets.parallaxes}
              active={() => !sceneActive()}
              debugName="rpgkit-parallax"
            />
          ) : null}
            <View
              class="absolute"
              nodeRef={(n) => {
                worldNode = n;
              }}
              debugName="rpgkit-world"
            >
          {(() => {
            const ActiveBelow = () => (
              <>
                {extraBelow.map(([id, layer]) => (
                  <ExtraMapLayer
                    id={id}
                    layer={layer}
                    mapId={mapId}
                    revision={layerRevision}
                    state={() => state}
                    camera={activeMapCamera}
                    viewport={viewport}
                    active={() => !sceneActive()}
                  />
                ))}
                {assets.anims ? (
                  <MapAnimLayer
                    above={false}
                    state={() => state}
                    anims={worldAnims}
                    assets={assets}
                    active={() => !sceneActive()}
                    onSync={() => props.onLayerSync?.("mapAnimBelow")}
                    debugName="rpgkit-map-anim-below"
                    onStats={(stats) => props.onMapAnimStats?.("below", stats)}
                  />
                ) : null}
              </>
            );

            const ActiveActors = () => (
              <CurrentMapActors
                immutableState={props.immutableState}
                slots={currentSlots}
                slotCount={slotCache.get(state.mapId)!.length}
                cap={actorSlotCap}
                host={() => actorHost}
                worldWidth={worldWidth}
                sprites={sprites}
                npcSrc={assets.npcSrc}
                extensions={session.extensions}
                handover={worldHandover}
                player={assets.player}
                playerHeight={assets.playerHeight ?? 16}
                pose={pose}
                facing={facing}
                state={() => state}
                worldNode={() => worldNode}
                camera={() => camera}
                onStats={props.onActorStats}
                active={() => !sceneActive()}
                onSync={() => props.onLayerSync?.("actors")}
              />
            );

            const ActiveAbove = () => (
              <>
                {extraAbove.map(([id, layer]) => (
                  <ExtraMapLayer
                    id={id}
                    layer={layer}
                    mapId={mapId}
                    revision={layerRevision}
                    state={() => state}
                    camera={activeMapCamera}
                    viewport={viewport}
                    active={() => !sceneActive()}
                  />
                ))}
                {assets.anims ? (
                  <MapAnimLayer
                    above
                    state={() => state}
                    anims={worldAnims}
                    assets={assets}
                    active={() => !sceneActive()}
                    onSync={() => props.onLayerSync?.("mapAnimAbove")}
                    debugName="rpgkit-map-anim-above"
                    onStats={(stats) => props.onMapAnimStats?.("above", stats)}
                  />
                ) : null}
                {assets.anims ? (
                  <BalloonLayer
                    state={() => state}
                    anims={worldAnims}
                    assets={assets}
                    active={() => !sceneActive()}
                    onSync={() => props.onLayerSync?.("balloons")}
                    anchor={(balloon: Readonly<BalloonEffectState>): BalloonAnchor => {
                      if (balloon.target === "player") {
                        const art = playerFrame(
                          state,
                          sprites,
                          assets.npcSrc,
                          assets.player,
                          assets.playerHeight ?? 16,
                        );
                        return { x: state.move.px, y: state.move.py, height: art.height };
                      }
                      const eventId = balloon.target.event;
                      const ch = state.chars.chars[eventId];
                      const event = currentSlots().find((candidate) => candidate.id === eventId);
                      if (!ch || !event) {
                        return { x: balloon.x * TILE, y: balloon.y * TILE, height: TILE };
                      }
                      const frame = npcFrame(state, event, sprites, assets.npcSrc, session.extensions);
                      return { x: frame[0], y: frame[1], height: frame[3] };
                    }}
                  />
                ) : null}
              </>
            );

            const LegacyWorldContent = () => (
              <>
          {stream ? (
            <StreamedChunkLayer
              mapId={mapId()}
              refs={groundStreamVariant()?.refs ?? stream.ground}
              columns={groundStreamVariant()?.columns ?? stream.columns}
              chunkPx={stream.chunkPx}
              camera={() => camera}
              viewport={() => viewport()}
              margin={groundStreamVariant()?.margin ?? stream.margin}
              loadBudget={groundStreamVariant()?.loadBudget ?? stream.loadBudget}
              loadTile={stream.loadTile}
              sourceKey={`ground:${groundSelection().name ?? ""}`}
              visible={groundSelection().visible}
              active={() => !sceneActive()}
              debugName="rpgkit-ground"
              onStats={(stats) => props.onStreamStats?.("ground", stats)}
            />
          ) : (
            <ChunkLayer
              names={groundEagerVariant()?.chunks[mapId()]
                ?? assets.ground[mapId()]
                ?? assets.ground[firstMapId]!}
              columns={groundEagerVariant()?.columns[mapId()]
                ?? assets.chunkColumns[mapId()]
                ?? assets.chunkColumns[firstMapId]
                ?? 1}
              slots={Math.max(assets.maxChunks, groundLayer ? maxLayerChunks(groundLayer) : 1)}
              visible={groundSelection().visible}
              debugName="rpgkit-ground"
            />
          )}

          {assets.animated ? (
            <AnimatedTiles
              mapId={mapId()}
              tiles={assets.animated}
              above={false}
              camera={() => camera}
              viewport={() => viewport()}
              active={() => !sceneActive()}
              mapTiles={() => {
                const m = mapsById.get(mapId())!;
                return { w: m.width, h: m.height };
              }}
              debugName="rpgkit-anim-below"
              visible={groundSelection().visible}
              onStats={(stats) => props.onAnimatedStats?.("below", stats)}
            />
          ) : null}

          <ActiveBelow />

          <OccludingUpperLayer
            mapId={mapId()}
            maps={mapsById}
            assets={assets}
            firstMapId={firstMapId}
            worldWidth={worldWidth}
            camera={() => camera}
            viewport={() => viewport()}
            active={() => !sceneActive()}
            source={() => ({
              key: `upper:${upperSelection().name ?? ""}`,
              variant: upperSelection().variant,
            })}
            visible={() => upperSelection().visible}
            debugName="rpgkit-actors"
            nodeRef={(node) => { actorHost = node; }}
            onStreamStats={(stats) => props.onStreamStats?.("upper", stats)}
            onAnimatedStats={(stats) => props.onAnimatedStats?.("above", stats)}
          >
            <ActiveActors />
          </OccludingUpperLayer>

          <ActiveAbove />
              </>
            );

            const WorldContent = WorldRendererView ? () => (
              <WorldRendererView
                activeMapId={mapId}
                camera={() => camera}
                viewport={viewport}
                stream={stream!}
                animated={assets.animated}
                active={() => !sceneActive()}
                ground={{
                  refs: () => groundStreamVariant()?.refs ?? stream!.ground,
                  columns: () => groundStreamVariant()?.columns ?? stream!.columns,
                  sourceKey: () => `ground:${groundSelection().name ?? ""}`,
                  visible: () => groundSelection().visible,
                  margin: () => groundStreamVariant()?.margin ?? stream!.margin,
                  loadBudget: () => groundStreamVariant()?.loadBudget ?? stream!.loadBudget,
                }}
                upper={{
                  refs: () => upperStreamVariant()?.refs ?? stream!.upper,
                  columns: () => upperStreamVariant()?.columns ?? stream!.columns,
                  sourceKey: () => `upper:${upperSelection().name ?? ""}`,
                  visible: () => upperSelection().visible,
                  margin: () => upperStreamVariant()?.margin ?? stream!.margin,
                  loadBudget: () => upperStreamVariant()?.loadBudget ?? stream!.loadBudget,
                }}
                below={<ActiveBelow />}
                actors={<ActiveActors />}
                above={<ActiveAbove />}
                actorHost={(node) => { actorHost = node; }}
                preview={worldPreview}
                onStreamStats={props.onStreamStats}
                onAnimatedStats={props.onAnimatedStats}
              />
            ) : undefined;

            return WorldContent && worldRenderer ? (
              <Show when={worldRenderer.hasMap(mapId())} fallback={<LegacyWorldContent />}>
                <WorldContent />
              </Show>
            ) : <LegacyWorldContent />;
          })()}
            </View>

          {screenLayers.map(([id, layer]) => (
            <ScreenVisualLayer
              id={id}
              layer={layer}
              revision={layerRevision}
              state={() => state}
            />
          ))}
        </View>
      </ProfileMount>

      {/* Screen effects (tints, flash, shake, backdrops) and the fade sit
          outside the kept-alive world so they keep their place above the
          map and around the dialog; the battle scene below draws over them
          while it is active. */}
      <ScreenEffectsLayer
        screen={presentedScreen}
        layers={screenLayerAssets}
      >
        {ScreenPresentationEffects ? (
          <ScreenPresentationEffects
            screen={presentedScreen}
            timer={presentedTimer}
            layers={screenLayerAssets}
            width={() => viewport().w}
            height={() => viewport().h}
          />
        ) : null}
      </ScreenEffectsLayer>
      {ScreenPresentationHud ? (
        <ScreenPresentationHud
          screen={presentedScreen}
          timer={presentedTimer}
          layers={screenLayerAssets}
          width={() => viewport().w}
          height={() => viewport().h}
        />
      ) : null}

      {/* The dialog box is persistent by design (b778aa0): it stays mounted
          for the whole session and hides its own boxes while unused, so it
          no longer remounts with the world on battle exit. */}
      <ProfileMount stage="dialog">
        <DialogBox
          modal={() => sceneActive() ? null : modal()}
          legend={actions.legend}
          theme={props.theme}
          faces={props.faces}
          faceWidth={props.faceWidth}
          items={itemNames}
          itemIconRow={props.itemIcons}
          choiceIconBox={props.choiceIcons}
          choiceIcon={props.choiceIcons && ((icon) => resolveChoiceIcon(icon, sprites, assets.npcSrc))}
          viewportWidth={viewport().w}
          viewportHeight={viewport().h}
          uiText={uiTextOverrides()}
        />
      </ProfileMount>
      <ScreenFadeLayer screen={presentedScreen} />

      {/* The battle scene mounts on first use and stays mounted (hidden),
          matching the world keep-alive above. */}
      <Show when={battleMounted()}>
        <View
          style={{
            posType: 1,
            insetL: 0,
            insetT: 0,
            width: viewport().w,
            height: viewport().h,
            display: scene()?.kind === "battle" ? 0 : 1,
          }}
          debugName="rpgkit-battle-scene"
        >
          {BattleSceneView ? (
            <ProfileMount stage="battle">
              <BattleSceneView
                state={battleViewState()!}
                width={viewport().w}
                height={viewport().h}
                active={scene()?.kind === "battle"}
                uiText={uiTextOverrides()}
              />
            </ProfileMount>
          ) : null}
        </View>
      </Show>

      {/* Game scene views mount on first use and stay mounted (hidden),
          same contract as the battle view above. A scene without a
          registered renderer mounts nothing (headless tests register only
          the rules). State is the scene's last retained JSON, so a hidden
          view keeps its last props. */}
      {Object.keys(props.sceneViews ?? {}).map((id) => (
        <Show when={sceneViewStates()[id] !== undefined}>
          <View
            style={{
              posType: 1,
              insetL: 0,
              insetT: 0,
              width: viewport().w,
              height: viewport().h,
              display: activeSceneId() === id ? 0 : 1,
            }}
            debugName={`rpgkit-scene-${id}`}
          >
            <ProfileMount stage="scene">
              <SceneRenderer
                view={props.sceneViews![id]!}
                state={sceneViewStates()[id]!}
                width={viewport().w}
                height={viewport().h}
                active={activeSceneId() === id}
                onSelectIndex={attract ? undefined : (index) => selectSceneIndex(id, index)}
                uiText={uiTextOverrides()}
              />
            </ProfileMount>
          </View>
        </Show>
      ))}

      {/* D1/D2 demo overlay. In attract a small DEMO plate with the tape
          frame number sits in the top-right corner, away from the action.
          Takeover flashes "YOU HAVE CONTROL" for two seconds; L rewinds
          and flashes "REWIND". The overlay is presentation only — it
          emits no ops while hidden, and never mounts without a tape. */}
      <Show when={demo()?.phase === "attract"}>
        <View
          class="absolute flex-col items-end"
          style={{ posType: 1, insetT: 6, insetR: 8, bgColor: "#0b1626", opacity: 0.78 }}
          debugName="rpgkit-demo-badge"
        >
          <Text
            class="text-xs"
            style={{ textColor: "#ffe97a", lineHeight: 13, height: 13 * badgeRows().length, insetL: 6, insetT: 2, insetR: 6 }}
          >
            {badgeRows().join("\n")}
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.controlNotice ?? 0) > 0}>
        <View
          class="absolute flex-row justify-center"
          style={{ posType: 1, insetT: 18, insetL: 0, insetR: 0 }}
          debugName="rpgkit-control-notice"
        >
          <Text class="text-sm" style={{ textColor: "#ffe97a", lineHeight: 18, height: 18 * bannerRows("demo.control").length }}>
            {bannerRows("demo.control").join("\n")}
          </Text>
        </View>
      </Show>
      <Show when={(demo()?.rewindNotice ?? 0) > 0}>
        <View
          class="absolute flex-row justify-center"
          style={{ posType: 1, insetT: 40, insetL: 0, insetR: 0 }}
          debugName="rpgkit-rewind-notice"
        >
          <Text class="text-sm" style={{ textColor: "#8ad0ff", lineHeight: 18, height: 18 * rewindRows().length }}>
            {rewindRows().join("\n")}
          </Text>
        </View>
      </Show>

      <View
        class="absolute left-0 right-0 top-0 bottom-0"
        style={{ posType: 1, bgColor: "#000000", opacity: fade() }}
        debugName="rpgkit-fade"
      />
      {/* Opt-in demo chrome stays above the world/fade but below fatal
          errors. Its implementation is supplied by the isolated demo entry. */}
      {demoRuntime ? demoRuntime.render(props.theme, uiTextOverrides()) : null}
      {overlayRuntime ? overlayRuntime.render(props.theme, uiTextOverrides()) : null}
      <Show when={fatalError() !== null}>
        <View
          class="absolute inset-0 flex-col justify-center items-center"
          style={{ posType: 1, bgColor: "#120b12" }}
          debugName="rpgkit-fatal-error"
        >
          <Text
            class="text-sm"
            style={{ textColor: "#ff8a8a", lineHeight: 18, height: 18 * bannerRows("error.event").length }}
            debugName="rpgkit-fatal-error-title"
          >
            {bannerRows("error.event").join("\n")}
          </Text>
          <View style={{ height: 8 }} />
          <Text
            class="text-xs"
            style={{ textColor: "#f3dfe8", lineHeight: 14, height: 14 * fatalRows().length, insetL: 16, insetR: 16 }}
            debugName="rpgkit-fatal-error-message"
          >
            {fatalRows().join("\n")}
          </Text>
        </View>
      </Show>
      <StartupProfileTail />
    </View>
  );
  startupProfileMark("game-view:tree");
  return view;
}
