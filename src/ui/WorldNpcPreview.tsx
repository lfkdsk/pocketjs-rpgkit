// Read-only character preview for the visible maps next to the active one in
// a connected world. The active map keeps sole ownership of simulation; this
// layer only paints a snapshot of what each other visible placement shows on
// entry, so the people across a seam are already in place when a seamless
// handoff makes their map active. The map the last seamless handoff left is
// painted from the reducer's frozen snapshot of it instead
// (SessionState.leftMap), so its characters stay where they were.
//
// Two sources of entry snapshots:
// - static (default): engine/world-preview.ts proves the entry page of each
//   event without running anything;
// - sandboxed entry (opt-in, `options.sandbox`): engine/world-preview-
//   sandbox.ts enters the map in a private state and paints its first target
//   tick, cached by durable state and computed one probe per frame. A map
//   whose sandbox preview is not ready yet is painted from the static
//   preview. The snapshot last painted for a map is handed to GameView's
//   actor pool for the seamless commit frame (WorldPreviewHandover), so a
//   character spawned by entry code is never missing for that one frame.
// Nothing here writes session state, collides or responds to input.

import { View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createElement, insertNode, setProp, type NodeMirror } from "@pocketjs/framework/renderer";
import type { Accessor, JSX } from "solid-js";
import type { LeftMapSnapshot } from "../engine/session.ts";
import {
  createSandboxPreviewReader,
  SANDBOX_PREVIEW_REJECT_REASONS,
  type SandboxMapPreview,
  type SandboxPreviewActor,
  type SandboxPreviewHooks,
  type SandboxPreviewReader,
} from "../engine/world-preview-sandbox.ts";
import { TILE } from "../engine/tiles.ts";
import type {
  Dir,
  Facing,
  SandboxPreviewRejectReason,
  WorldComponent,
  WorldPlacement,
  WorldPreviewRejectReason,
} from "../engine/types.ts";
import {
  createWorldPreviewReader,
  WORLD_PREVIEW_REJECT_REASONS,
  type WorldMapPreview,
} from "../engine/world-preview.ts";
import { npcArt, npcArtHeight, npcArtKey } from "./npc-art.ts";
import type {
  GameViewWorldPreviewSource,
  WorldNpcPreviewStats,
  WorldPreviewHandoverActor,
} from "./world-contract.ts";

export type { WorldNpcPreviewStats };

export interface WorldNpcPreviewOptions {
  /** Preview by sandboxed map entry. `true` uses no game hooks; a game whose
   * extension state holds per-step counters or a clock passes `previewKey`
   * and `perturbExt` (SandboxPreviewHooks). `unitsPerFrame` (default 1)
   * bounds the sandbox work done per presented frame. */
  sandbox?: true | (SandboxPreviewHooks & { unitsPerFrame?: number });
}

interface PreviewFrame {
  /** `mapId/eventId`, for the stats. */
  id: string;
  src: string;
  height: 16 | 32;
  x: number;
  y: number;
  depth: number;
  opacity: number;
}

interface PreviewSlot {
  node: NodeMirror;
  src: string;
  height: number;
  x: number;
  y: number;
  depth: number;
  opacity: number;
  shown: boolean;
}

/** What one visible non-active placement paints: its static or sandboxed
 * entry preview, the frozen left-map snapshot, or nothing (not resident). */
type PlacementPreview = WorldMapPreview | SandboxMapPreview | LeftMapSnapshot | undefined;

interface HandoverIndex {
  actors: Map<string, SandboxPreviewActor>;
  rejected: Set<string>;
}

const handoverIndexes = /* @__PURE__ */ new WeakMap<SandboxMapPreview, HandoverIndex>();

function handoverIndex(preview: SandboxMapPreview): HandoverIndex {
  let index = handoverIndexes.get(preview);
  if (!index) {
    index = {
      actors: new Map(preview.actors.map((actor) => [actor.eventId, actor] as const)),
      rejected: new Set(preview.rejected.map((entry) => entry.eventId)),
    };
    handoverIndexes.set(preview, index);
  }
  return index;
}

function isSandboxPreview(preview: PlacementPreview): preview is SandboxMapPreview {
  return preview !== undefined && "outcome" in preview;
}

const byDepth = (a: PreviewFrame, b: PreviewFrame): number => a.depth - b.depth;

const FACING_OF: Readonly<Record<Dir, Facing>> = { down: 0, left: 1, up: 2, right: 3 };

function slotStyle(slot: PreviewSlot) {
  return {
    posType: 1,
    insetL: 0,
    insetT: TILE - slot.height,
    width: TILE,
    height: slot.height,
    translateX: slot.x,
    translateY: slot.y,
    zIndex: slot.depth,
    opacity: slot.opacity,
    display: slot.shown ? 0 : 1,
  };
}

/** Wraps the active map's actor band. Preview characters whose feet are
 * above the active map are painted before it and the rest after it, so a
 * 32px character overlapping across a horizontal seam keeps the y-order of
 * the single-map actor pool. Within each band nodes sort by world (y, x).
 * A snapshot is painted only while its placement is visible. */
export function WorldNpcPreview(props: {
  source: GameViewWorldPreviewSource;
  component: Accessor<WorldComponent>;
  placements: Accessor<readonly WorldPlacement[]>;
  options?: WorldNpcPreviewOptions;
  children?: JSX.Element;
}): JSX.Element {
  const source = props.source;
  const reader = createWorldPreviewReader({ commonEvents: source.commonEvents });
  const sandboxOptions = props.options?.sandbox;
  const sandbox: SandboxPreviewReader | undefined = sandboxOptions
    ? createSandboxPreviewReader(source.session, {
        ...(sandboxOptions === true ? {} : sandboxOptions),
        commonEvents: source.commonEvents,
        unitsPerPump: sandboxOptions === true ? 1 : sandboxOptions.unitsPerFrame,
      })
    : undefined;
  /** The sandbox preview last read per visible non-active map (painted,
   * or held for the frozen left map), for its commit frame. */
  const handedOver = new Map<string, SandboxMapPreview>();
  let lastPlacementsHanded: readonly WorldPlacement[] | undefined;
  if (sandbox) {
    source.handover.lookup = (mapId, eventId): WorldPreviewHandoverActor | null | undefined => {
      const preview = handedOver.get(mapId);
      if (!preview) return undefined;
      const index = handoverIndex(preview);
      const actor = index.actors.get(eventId);
      if (actor) return actor.fallback ? undefined : actor;
      return index.rejected.has(eventId) ? undefined : null;
    };
  }
  let behindHost: NodeMirror | undefined;
  let frontHost: NodeMirror | undefined;
  const behindSlots: PreviewSlot[] = [];
  const frontSlots: PreviewSlot[] = [];
  let lastActive = "";
  let lastPlacements: readonly WorldPlacement[] | undefined;
  let lastPreviews: PlacementPreview[] = [];
  let painted = false;
  const previews: PlacementPreview[] = [];
  const behind: PreviewFrame[] = [];
  const front: PreviewFrame[] = [];

  const paint = (host: NodeMirror, slots: PreviewSlot[], frames: readonly PreviewFrame[]): void => {
    while (slots.length < frames.length) {
      const slot: PreviewSlot = {
        node: createElement("image"),
        src: "",
        height: 16,
        x: 0,
        y: 0,
        depth: 0,
        opacity: 1,
        shown: false,
      };
      setProp(slot.node, "style", slotStyle(slot));
      setProp(slot.node, "src", "");
      insertNode(host, slot.node);
      slots.push(slot);
    }
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      const frame = frames[index];
      const shown = frame !== undefined;
      const oldStyle = slot.node.domAttrs?.style as ReturnType<typeof slotStyle> | undefined;
      if (frame) {
        if (frame.src !== slot.src) {
          setProp(slot.node, "src", frame.src, slot.src);
          slot.src = frame.src;
        }
        if (slot.shown && slot.height === frame.height && slot.x === frame.x &&
            slot.y === frame.y && slot.depth === frame.depth && slot.opacity === frame.opacity) continue;
        slot.height = frame.height;
        slot.x = frame.x;
        slot.y = frame.y;
        slot.depth = frame.depth;
        slot.opacity = frame.opacity;
      } else if (!slot.shown) {
        continue;
      }
      slot.shown = shown;
      setProp(slot.node, "style", slotStyle(slot), oldStyle);
    }
  };

  onFrame(() => {
    if (!source.active()) return;
    if (!behindHost || !frontHost) return;
    const state = source.state();
    const active = state.mapId;
    const left = state.leftMap;
    const placements = props.placements();
    if (sandbox) {
      if (placements !== lastPlacements) sandbox.retain(placements.map((placement) => placement.mapId));
      sandbox.observe(state);
      sandbox.pump();
    }
    let changed = !painted || active !== lastActive || placements !== lastPlacements ||
      placements.length !== lastPreviews.length;
    previews.length = placements.length;
    for (let index = 0; index < placements.length; index++) {
      const placement = placements[index]!;
      let preview: PlacementPreview;
      if (placement.mapId !== active) {
        const isLeft = left !== undefined && placement.mapId === left.mapId;
        const map = isLeft && !sandbox ? undefined : source.map(placement.mapId);
        let sandboxed: SandboxMapPreview | undefined;
        if (sandbox) {
          // The sandbox snapshot handed over on this map's commit frame. The
          // map just left is painted frozen but keeps one ready for re-entry.
          sandboxed = map ? sandbox.read(map) : undefined;
          if (sandboxed) handedOver.set(placement.mapId, sandboxed);
          else handedOver.delete(placement.mapId);
        }
        preview = isLeft ? left : map ? sandboxed ?? reader.read(map, state.sw) : undefined;
      }
      previews[index] = preview;
      if (preview !== lastPreviews[index]) changed = true;
    }
    if (!changed) return;
    lastActive = active;
    lastPlacements = placements;
    lastPreviews = previews.slice();
    painted = true;

    const component = props.component();
    const minX = component.bounds.minTileX * TILE;
    const minY = component.bounds.minTileY * TILE;
    const stride = (component.bounds.maxTileX - component.bounds.minTileX) * TILE + 1;
    const activePlacement = component.placements.find((placement) => placement.mapId === active);
    const activeTop = activePlacement ? activePlacement.originTileY * TILE : -Infinity;
    behind.length = 0;
    front.length = 0;
    const maps: string[] = [];
    const unavailable: string[] = [];
    let frozen: string | null = null;
    const reasons = {} as Record<WorldPreviewRejectReason, number>;
    for (const reason of WORLD_PREVIEW_REJECT_REASONS) reasons[reason] = 0;
    let rejected = 0;
    let hidden = 0;
    const sandboxMaps: string[] = [];
    const staticMaps: string[] = [];
    const sandboxReasons = {} as Record<SandboxPreviewRejectReason, number>;
    for (const reason of SANDBOX_PREVIEW_REJECT_REASONS) sandboxReasons[reason] = 0;
    let fallback = 0;
    for (let index = 0; index < placements.length; index++) {
      const placement = placements[index]!;
      // The active map's last snapshot stays for its commit frame.
      if (placement.mapId === active) continue;
      const preview = previews[index];
      if (!preview) {
        unavailable.push(placement.mapId);
        continue;
      }
      maps.push(placement.mapId);
      const originX = placement.originTileX * TILE;
      const originY = placement.originTileY * TILE;
      const add = (eventId: string, art: ReturnType<typeof npcArt>, src: string, x: number, y: number, opacity: number): void => {
        (y < activeTop ? behind : front).push({
          id: `${placement.mapId}/${eventId}`,
          src,
          height: npcArtHeight(art),
          x,
          y,
          depth: (y - minY) * stride + (x - minX),
          opacity,
        });
      };
      if (preview === left) {
        frozen = placement.mapId;
        for (const actor of left.actors) {
          const art = npcArt(actor.sprite, source.sprites, source.npcSrc);
          if (art === "") continue;
          add(actor.eventId, art, npcArtKey(art, actor.pose, actor.facing), originX + actor.px, originY + actor.py, actor.opacity / 255);
        }
        continue;
      }
      if (isSandboxPreview(preview)) {
        sandboxMaps.push(placement.mapId);
        rejected += preview.rejected.length;
        hidden += preview.hidden;
        for (const reject of preview.rejected) sandboxReasons[reject.reason]++;
        for (const actor of preview.actors) {
          const art = npcArt(actor.sprite, source.sprites, source.npcSrc);
          if (art === "") continue;
          if (actor.fallback) fallback++;
          add(actor.eventId, art, npcArtKey(art, actor.pose, actor.facing), originX + actor.px, originY + actor.py, actor.opacity / 255);
        }
        continue;
      }
      if (sandbox) staticMaps.push(placement.mapId);
      const entry = preview as WorldMapPreview;
      rejected += entry.rejected.length;
      hidden += entry.hidden;
      for (const reject of entry.rejected) reasons[reject.reason]++;
      for (const actor of entry.actors) {
        const art = npcArt(actor.sprite, source.sprites, source.npcSrc);
        if (art === "") continue;
        add(actor.eventId, art, npcArtKey(art, 0, FACING_OF[actor.dir]), originX + actor.x * TILE, originY + actor.y * TILE, 1);
      }
    }
    if (placements !== lastPlacementsHanded) {
      lastPlacementsHanded = placements;
      for (const mapId of [...handedOver.keys()]) {
        if (!placements.some((placement) => placement.mapId === mapId)) handedOver.delete(mapId);
      }
    }
    // Slot order follows the paint order inside each band.
    behind.sort(byDepth);
    front.sort(byDepth);
    paint(behindHost, behindSlots, behind);
    paint(frontHost, frontSlots, front);
    source.onStats?.({
      activeMapId: active,
      maps,
      unavailable,
      frozen,
      painted: behind.length + front.length,
      behind: behind.length,
      front: front.length,
      actors: [...behind.map((frame) => frame.id), ...front.map((frame) => frame.id)],
      rejected,
      hidden,
      reasons,
      pooled: behindSlots.length + frontSlots.length,
      ...(sandbox
        ? {
            sandbox: {
              maps: sandboxMaps,
              staticMaps,
              reasons: sandboxReasons,
              fallback,
              pending: sandbox.stats.pending,
              invalidations: sandbox.stats.invalidations,
              probes: sandbox.stats.probes,
              compiles: sandbox.stats.compiles,
            },
          }
        : {}),
    });
  });

  return (
    <>
      <View
        class="absolute"
        nodeRef={(node) => { behindHost = node; }}
        debugName="rpgkit-world-preview-behind"
      />
      {props.children}
      <View
        class="absolute"
        nodeRef={(node) => { frontHost = node; }}
        debugName="rpgkit-world-preview-front"
      />
    </>
  );
}
