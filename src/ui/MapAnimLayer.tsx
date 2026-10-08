// src/ui/MapAnimLayer.tsx — render-only map animation instances.
//
// State-driven: each live InterpState.anims instance binds one pooled image
// node, and the frame is selected per frame from the saved reference tick
// (animFrameIndex). Playback is therefore identical under rewind and after a
// save/load, and a looping or static instance costs no node churn while it
// plays: the node set changes only when an instance starts, stops or finishes.
// A transfer keeps the instance ids and rebases their clocks. Position and src updates
// skip unchanged values, so an animation holding a frame emits nothing.
//
// One instance paints one z-band: `above=false` mounts just above the ground
// (under characters); `above=true` mounts after the actor subtree, so it
// paints over every character (Tuxemon layer 4). Frames are anchored to the
// top-left of their tile (or their character's interpolated pixel position);
// a frame taller than one tile shifts up by half its height, the same anchor
// Tuxemon's map view applies to tall map animations (view._position_surfaces:
// rect.y -= surface.get_height() // 2 while height > tile_size).

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump } from "@pocketjs/framework/animation";
import {
  createElement,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import {
  animFrameIndex,
  type CompiledAnim,
  type MapAnimInstance,
} from "../engine/interpreter.ts";
import type { SessionState } from "../engine/session.ts";
import { TILE } from "../engine/tiles.ts";
import type { GameAssets } from "./game-assets.ts";
import { startupProfileMark } from "../startup-profile.ts";

export interface MapAnimStats {
  mapId: string;
  /** Instances with a bound node this frame. */
  mounted: number;
  /** Nodes created over the component's life. */
  created: number;
  /** Pooled (unbound) nodes available to reuse. */
  pooled: number;
}

export interface MapAnimLayerProps {
  /** false = under characters; true = over the whole actor plane. */
  above: boolean;
  state: () => SessionState;
  /** Compiled animation timing for the resident map (World.anims). */
  anims: () => ReadonlyMap<string, CompiledAnim>;
  assets: GameAssets;
  /** While false, the per-frame sync pauses (the layer stays mounted and
   *  hidden with the world). Omit for always active. */
  active?: Accessor<boolean>;
  /** Fired once per synced frame, after the active gate — a heartbeat tests
   *  use to prove the hook paused. Omit in production. */
  onSync?: () => void;
  debugName?: string;
  onStats?: (stats: MapAnimStats) => void;
}

interface BoundSlot {
  node: NodeMirror;
  id: string;
  /** Last painted world-pixel position (translateX / translateY). */
  px: number;
  top: number;
  w: number;
  h: number;
  src: string;
}

interface SlotStyle {
  posType: number;
  insetL: number;
  insetT: number;
  width: number;
  height: number;
}

const slotStyle = (w: number, h: number): SlotStyle => ({
  posType: 1,
  insetL: 0,
  insetT: 0,
  width: w,
  height: h,
});

/** The mapAnim plane for one z-band. The parent owns the world translation;
 *  nodes sit at world tile coordinates and rebind only when the instance set
 *  changes. */
export function MapAnimLayer(props: MapAnimLayerProps): SolidJSX.Element {
  startupProfileMark(`ui-map-anim-${props.above ? "above" : "below"}:start`);
  const root = createElement("view");
  setProp(root, "style", {
    posType: 1,
    insetL: 0,
    insetT: 0,
    width: 0,
    height: 0,
    // The actor plane (OccludingUpperLayer subtree) and ground all paint at
    // the default 0; the above band sorts after the whole actor subtree.
    ...(props.above ? { zIndex: 1 } : {}),
  } as SlotStyle & { zIndex?: number });
  setProp(root, "debugName", props.debugName ?? (props.above ? "rpgkit-map-anim-above" : "rpgkit-map-anim-below"));

  const pool: NodeMirror[] = [];
  /** Instance id -> bound slot, in first-appearance order. */
  const live = new Map<string, BoundSlot>();
  let created = 0;

  const report = (state: SessionState): void => {
    props.onStats?.({ mapId: state.mapId, mounted: live.size, created, pooled: pool.length });
  };

  const release = (slot: BoundSlot): void => {
    setProp(slot.node, "src", "", slot.src);
    slot.src = "";
    live.delete(slot.id);
    pool.push(slot.node);
  };

  const acquire = (id: string): BoundSlot => {
    const node = pool.pop() ?? (() => {
      const n = createElement("image");
      setProp(n, "style", slotStyle(TILE, TILE));
      insertNode(root, n);
      created++;
      return n;
    })();
    const slot: BoundSlot = { node, id, px: -1, top: -1, w: TILE, h: TILE, src: "" };
    live.set(id, slot);
    return slot;
  };

  /** World-pixel top-left the instance tracks. A fixed instance pins to its
   *  tile origin; a following instance tracks the character's interpolated
   *  pixel position (the same move.px/py the actor node is translated by),
   *  so the animation never lags a tile while the character walks. */
  const pixelOf = (state: SessionState, inst: MapAnimInstance): { px: number; py: number } => {
    if (inst.target === null) return { px: inst.x * TILE, py: inst.y * TILE };
    if (inst.target === "player") return { px: state.move.px, py: state.move.py };
    const ch = state.chars.chars[inst.target.event];
    return ch ? { px: ch.px, py: ch.py } : { px: inst.x * TILE, py: inst.y * TILE };
  };

  onFrame(() => {
    if (props.active && !props.active()) return;
    props.onSync?.();
    const state = props.state();
    const interp = state.interp;
    const compiled = props.anims();
    const cooked = props.assets.anims;
    const instances = interp.anims ?? [];

    // Release slots whose instance disappeared (stop/finish-prune).
    const seen = new Set<string>();
    for (const inst of instances) {
      if ((inst.layer === "above") !== props.above) continue;
      seen.add(inst.id);
    }
    for (const [id, slot] of [...live]) {
      if (!seen.has(id)) release(slot);
    }

    for (const inst of instances) {
      if ((inst.layer === "above") !== props.above) continue;
      let slot = live.get(inst.id);
      if (!slot) {
        slot = acquire(inst.id);
        setProp(slot.node, "debugName", `${props.debugName ?? "rpgkit-map-anim"}-${inst.id}`);
      }
      const timing = compiled.get(inst.anim);
      const art = cooked?.[inst.anim];
      let src = "";
      let w = TILE;
      let h = TILE;
      if (timing && art) {
        const idx = animFrameIndex(timing, inst, interp.frame);
        if (idx >= 0) {
          src = art.frames[idx] ?? "";
          w = art.w;
          h = art.h;
        }
      }
      const anchor = pixelOf(state, inst);
      const px = anchor.px + (art?.offsetX ?? 0);
      const top = anchor.py + (art?.offsetY ?? -(h > TILE ? h >> 1 : 0));
      if (px !== slot.px || top !== slot.top) {
        jump(slot.node, "translateX", px);
        jump(slot.node, "translateY", top);
        slot.px = px;
        slot.top = top;
      }
      if (w !== slot.w || h !== slot.h) {
        const old = slot.node.domAttrs?.style as SlotStyle | undefined;
        setProp(slot.node, "style", slotStyle(w, h), old);
        slot.w = w;
        slot.h = h;
      }
      if (src !== slot.src) {
        setProp(slot.node, "src", src, slot.src);
        slot.src = src;
      }
    }
    report(state);
  });

  onCleanup(() => {
    for (const [, slot] of [...live]) release(slot);
    report(props.state());
  });
  startupProfileMark(`ui-map-anim-${props.above ? "above" : "below"}:end`);
  return root as unknown as SolidJSX.Element;
}
