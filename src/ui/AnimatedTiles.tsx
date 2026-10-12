// src/ui/AnimatedTiles.tsx — render-only animated map tiles.
//
// Animated tiles are NOT reducer state: each one binds a native auto-play
// sprite atlas (the core cycles the atlas frame from its inherited explicit
// world clock), so this component never advances a frame and the simulation
// is unaffected. A tile mounts
// an image node only while its 16px cell is inside the viewport plus a
// one-tile ring; leaving the ring unbinds the atlas and returns the node to
// a pool. Scrolling and map swaps therefore reuse a small node set.
//
// One instance paints one z-band: `above=false` mounts just above the
// ground (under characters); `above=true` mounts with the upper/star layer
// (over characters). The atlas frame count and per-frame duration come from
// the app's sprites.json (baked into the SPRITE pak entry), so this
// component only names the atlas; the registered meta supplies the cycle.

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump } from "@pocketjs/framework/animation";
import {
  createElement,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import type { AnimatedTile } from "./game-assets.ts";
import {
  createChunkWindowReader,
  type ChunkPoint,
  type ChunkViewport,
  type ChunkWindow,
} from "../engine/chunk-window.ts";
import { TILE } from "../engine/tiles.ts";
import { startupProfileMark } from "../startup-profile.ts";

export interface AnimatedTilesStats {
  mapId: string;
  /** Tiles with a bound atlas this frame. */
  mounted: number;
  /** Nodes created over the component's life. */
  created: number;
  /** Pooled (unbound) nodes available to reuse. */
  pooled: number;
}

export interface AnimatedTilesProps {
  mapId: string;
  /** Map id -> every animated tile placement; this instance keeps only the
   *  entries matching its `above` band. */
  tiles: Readonly<Record<string, readonly AnimatedTile[]>>;
  /** Changes when the same map selects another immutable tile source. */
  sourceKey?: string;
  above: boolean;
  camera: () => ChunkPoint;
  viewport: () => ChunkViewport;
  /** Current map size in 16px tiles for window clamping. */
  mapTiles: () => { w: number; h: number };
  /** Extra ring in tiles around the viewport to keep mounted (default 1). */
  ringTiles?: number;
  /** While false, the window sync pauses (the subtree stays mounted and
   *  hidden). The owning GameView also freezes its inherited sprite clock.
   *  Omit for always active. */
  active?: Accessor<boolean>;
  debugName?: string;
  /** Hide paint without unbinding atlases or changing the viewport pool. */
  visible?: boolean;
  onStats?: (stats: AnimatedTilesStats) => void;
}

function sameWindow(a: ChunkWindow, b: ChunkWindow): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

const EMPTY: ChunkWindow = { x0: 0, y0: 0, x1: -1, y1: -1 };

/** One animated-tile z-band. The parent owns the world translation; nodes
 *  sit at world tile coordinates and rebind only when the window changes. */
export function AnimatedTiles(props: AnimatedTilesProps): SolidJSX.Element {
  const chunkWindow = createChunkWindowReader();
  startupProfileMark(`ui-animated-${props.above ? "above" : "below"}:start`);
  const root = createElement("view");
  setProp(root, "style", {
    posType: 1, insetL: 0, insetT: 0, width: 0, height: 0,
    display: props.visible === false ? 1 : 0,
  });
  setProp(root, "debugName", props.debugName ?? (props.above ? "rpgkit-anim-above" : "rpgkit-anim-below"));

  const pool: NodeMirror[] = [];
  /** Key `${x},${y}` -> bound node, for the current map only. */
  const live = new Map<string, NodeMirror>();
  let currentMap = "";
  let currentSourceKey = "";
  /** Sparse rows keep window changes proportional to animated cells. */
  const rows = new Map<number, { x: number; key: string; sprite: string }[]>();
  let hasTiles = false;
  let lastWindow: ChunkWindow = EMPTY;
  let created = 0;
  let visible = props.visible !== false;

  const report = (): void => {
    props.onStats?.({ mapId: currentMap, mounted: live.size, created, pooled: pool.length });
  };

  const unbind = (node: NodeMirror): void => {
    setProp(node, "sprite", null, node.domAttrs?.sprite);
    pool.push(node);
  };

  const selectMap = (mapId: string, sourceKey: string): void => {
    for (const node of live.values()) unbind(node);
    live.clear();
    currentMap = mapId;
    currentSourceKey = sourceKey;
    rows.clear();
    const cells = new Map<string, AnimatedTile>();
    for (const tile of props.tiles[mapId] ?? []) {
      if (tile.above === props.above && Number.isInteger(tile.x) && Number.isInteger(tile.y)) {
        cells.set(`${tile.x},${tile.y}`, tile);
      }
    }
    for (const [key, tile] of cells) {
      let row = rows.get(tile.y);
      if (!row) rows.set(tile.y, row = []);
      row.push({ x: tile.x, key, sprite: tile.sprite });
    }
    for (const row of rows.values()) row.sort((a, b) => a.x - b.x);
    hasTiles = cells.size > 0;
    lastWindow = EMPTY;
  };

  const nodeFor = (): NodeMirror => {
    const reused = pool.pop();
    if (reused) return reused;
    const node = createElement("image");
    setProp(node, "style", { posType: 1, insetL: 0, insetT: 0, width: TILE, height: TILE });
    insertNode(root, node);
    created++;
    return node;
  };

  const sync = (): void => {
    if (props.active && !props.active()) return;
    const nextVisible = props.visible !== false;
    if (visible !== nextVisible) {
      visible = nextVisible;
      setProp(root, "style", { display: visible ? 0 : 1 }, root.domAttrs?.style);
    }
    const sourceKey = props.sourceKey ?? "";
    if (currentMap !== props.mapId || currentSourceKey !== sourceKey) selectMap(props.mapId, sourceKey);
    if (!hasTiles) {
      if (live.size !== 0) {
        for (const node of live.values()) unbind(node);
        live.clear();
        report();
      }
      return;
    }
    const { w, h } = props.mapTiles();
    const ring = props.ringTiles ?? 1;
    if (!Number.isInteger(ring) || ring < 0) {
      throw new Error(`AnimatedTiles: ringTiles must be a non-negative integer, got ${ring}`);
    }
    const win = chunkWindow(props.camera(), props.viewport(), TILE, w, h, ring * TILE);
    if (sameWindow(win, lastWindow)) return;
    lastWindow = win;

    // Unbind tiles that left the ring first, so their nodes serve cells
    // scrolling in during the same update (one pass would otherwise create a
    // node per entering cell before the leaving ones free theirs).
    for (const [key, node] of [...live]) {
      const comma = key.indexOf(",");
      const x = Number(key.slice(0, comma));
      const y = Number(key.slice(comma + 1));
      if (x < win.x0 || x > win.x1 || y < win.y0 || y > win.y1) {
        unbind(node);
        live.delete(key);
      }
    }

    for (let y = win.y0; y <= win.y1; y++) {
      const row = rows.get(y);
      if (!row) continue;
      for (const { x, key, sprite } of row) {
        if (x < win.x0) continue;
        if (x > win.x1) break;
        if (live.has(key)) continue;
        const node = nodeFor();
        setProp(node, "debugName", `${props.debugName ?? "rpgkit-anim"}-tile-${key}`);
        jump(node, "translateX", x * TILE);
        jump(node, "translateY", y * TILE);
        setProp(node, "sprite", sprite, null);
        live.set(key, node);
      }
    }
    report();
  };

  onFrame(sync);
  onCleanup(() => {
    for (const node of live.values()) unbind(node);
    live.clear();
    report();
  });
  startupProfileMark(`ui-animated-${props.above ? "above" : "below"}:end`);
  return root as unknown as SolidJSX.Element;
}
