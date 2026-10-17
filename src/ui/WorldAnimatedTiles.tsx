// Viewport-pooled animated terrain for a connected WorldLayout component.
// The simulation still owns one active map; this renderer only projects the
// immutable animated-tile declarations of visible placements into world
// coordinates. One pool is shared across every map visited in the component.

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { jump } from "@pocketjs/framework/animation";
import {
  createElement,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import type { WorldComponent, WorldPlacement } from "../engine/types.ts";
import { TILE } from "../engine/tiles.ts";
import type { ChunkPoint, ChunkViewport } from "../engine/chunk-window.ts";
import type { AnimatedTile } from "./game-assets.ts";
import type { AnimatedTilesStats } from "./AnimatedTiles.tsx";
import { upperRowDepth } from "./occlusion-depth.ts";

export interface WorldAnimatedTilesProps {
  activeMapId: () => string;
  component: () => WorldComponent;
  /** Stable, map-id-sorted result from createVisibleWorldMapsReader. */
  visibleMaps: () => readonly WorldPlacement[];
  tiles: Readonly<Record<string, readonly AnimatedTile[]>>;
  sourceKey?: () => string;
  above: boolean;
  camera: () => ChunkPoint;
  viewport: () => ChunkViewport;
  ringTiles?: number;
  active?: Accessor<boolean>;
  visible?: () => boolean;
  debugName?: string;
  onStats?: (stats: AnimatedTilesStats) => void;
  /** Optional flat upper/actor host. Used only by above tiles so their row
   * depth can interleave with characters. */
  host?: NodeMirror;
}

interface LiveTile {
  node: NodeMirror;
  mapId: string;
  worldX: number;
  worldY: number;
  sprite: string;
}

const mapIsVisible = (placements: readonly WorldPlacement[], mapId: string): boolean => {
  for (const placement of placements) if (placement.mapId === mapId) return true;
  return false;
};

/** One z-band of component-qualified animated tiles. */
export function WorldAnimatedTiles(props: WorldAnimatedTilesProps): SolidJSX.Element {
  if (props.host && !props.above) {
    throw new Error("WorldAnimatedTiles: a flat occlusion host is only valid for above tiles");
  }
  const root = props.host ?? createElement("view");
  let paintedVisible = props.visible?.() ?? true;
  if (!props.host) {
    setProp(root, "style", {
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: 0,
      height: 0,
      display: paintedVisible ? 0 : 1,
    });
  }
  const baseName = props.debugName ?? (props.above ? "rpgkit-world-anim-above" : "rpgkit-world-anim-below");
  if (!props.host) setProp(root, "debugName", baseName);

  const live = new Map<string, LiveTile>();
  const pool: NodeMirror[] = [];
  let created = 0;
  let currentComponent = "";
  let currentSourceKey = "";
  let previousX0 = Number.NaN;
  let previousY0 = Number.NaN;
  let previousX1 = Number.NaN;
  let previousY1 = Number.NaN;

  const report = (): void => {
    props.onStats?.({
      mapId: props.activeMapId(),
      mounted: live.size,
      created,
      pooled: pool.length,
    });
  };

  const release = (key: string, tile: LiveTile): void => {
    setProp(tile.node, "sprite", null, tile.node.domAttrs?.sprite);
    live.delete(key);
    pool.push(tile.node);
  };

  const clear = (): void => {
    for (const [key, tile] of [...live]) release(key, tile);
    previousX0 = previousY0 = previousX1 = previousY1 = Number.NaN;
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
    const nextVisible = props.visible?.() ?? true;
    if (nextVisible !== paintedVisible) {
      paintedVisible = nextVisible;
      if (props.host) {
        for (const tile of live.values()) {
          setProp(tile.node, "style", { display: paintedVisible ? 0 : 1 }, tile.node.domAttrs?.style);
        }
      } else {
        setProp(root, "style", { display: paintedVisible ? 0 : 1 }, root.domAttrs?.style);
      }
    }
    const component = props.component();
    const componentKey = `${component.worldId}\0${component.componentId}`;
    const sourceKey = props.sourceKey?.() ?? "";
    if (componentKey !== currentComponent || sourceKey !== currentSourceKey) {
      clear();
      currentComponent = componentKey;
      currentSourceKey = sourceKey;
    }
    const ring = props.ringTiles ?? 1;
    if (!Number.isInteger(ring) || ring < 0) {
      throw new Error(`WorldAnimatedTiles: ringTiles must be a non-negative integer, got ${ring}`);
    }
    const camera = props.camera();
    const viewport = props.viewport();
    const x0 = Math.floor(camera.x / TILE) - ring;
    const y0 = Math.floor(camera.y / TILE) - ring;
    const x1 = Math.ceil((camera.x + viewport.w) / TILE) + ring - 1;
    const y1 = Math.ceil((camera.y + viewport.h) / TILE) + ring - 1;
    if (x0 === previousX0 && y0 === previousY0 && x1 === previousX1 && y1 === previousY1) return;
    previousX0 = x0;
    previousY0 = y0;
    previousX1 = x1;
    previousY1 = y1;

    const placements = props.visibleMaps();
    for (const [key, tile] of [...live]) {
      if (
        !mapIsVisible(placements, tile.mapId) ||
        tile.worldX < x0 || tile.worldX > x1 || tile.worldY < y0 || tile.worldY > y1
      ) {
        release(key, tile);
      }
    }

    // placements are validated/sorted by map id; authored array order is the
    // deterministic final tie-break for duplicate coordinates.
    for (const placement of placements) {
      const localX0 = x0 - placement.originTileX;
      const localY0 = y0 - placement.originTileY;
      const localX1 = x1 - placement.originTileX;
      const localY1 = y1 - placement.originTileY;
      const authored = props.tiles[placement.mapId] ?? [];
      for (let index = 0; index < authored.length; index++) {
        const tile = authored[index]!;
        if (
          tile.above !== props.above || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) ||
          tile.x < localX0 || tile.x > localX1 || tile.y < localY0 || tile.y > localY1
        ) continue;
        const key = `${placement.mapId}\0${tile.x},${tile.y}`;
        const worldX = placement.originTileX + tile.x;
        const worldY = placement.originTileY + tile.y;
        const existing = live.get(key);
        if (existing) {
          if (existing.sprite !== tile.sprite) {
            setProp(existing.node, "sprite", tile.sprite, existing.sprite);
            existing.sprite = tile.sprite;
          }
          continue;
        }
        const node = nodeFor();
        if (props.host) {
          const width = (component.bounds.maxTileX - component.bounds.minTileX) * TILE;
          setProp(node, "style", {
            zIndex: upperRowDepth(worldY - component.bounds.minTileY, width),
            display: paintedVisible ? 0 : 1,
          }, node.domAttrs?.style);
        }
        jump(node, "translateX", worldX * TILE);
        jump(node, "translateY", worldY * TILE);
        setProp(node, "debugName", `${baseName}-${placement.mapId}-${tile.x},${tile.y}`);
        setProp(node, "sprite", tile.sprite, node.domAttrs?.sprite);
        live.set(key, { node, mapId: placement.mapId, worldX, worldY, sprite: tile.sprite });
      }
    }
    report();
  };

  // Late-mounted renderer branches miss the host's already frozen callback
  // list for this frame. Bind their initial visible cells before first paint.
  sync();
  onFrame(sync);
  onCleanup(() => {
    clear();
    report();
  });
  return (props.host ? null : root) as unknown as SolidJSX.Element;
}
