// src/ui/OccludingUpperLayer.tsx — row-sliced upper map art interleaved
// with character sprites.
//
// Tuxemon/pyscroll's `tall_sprites=2` rule redraws only the map cells hit by
// the bottom two pixels of a character.  A fixed depth for each 16px upper
// row is equivalent for 16px-wide, bottom-anchored actors: the row sorts
// after actors whose top-of-foot-cell y is at most rowY + 1, and before
// actors at rowY + 2.  The row's clip means art outside those intersecting
// cells cannot cover the sprite.  Unlike per-actor redraws, every upper
// pixel is painted exactly once, so translucent tiles also stay correct.
//
// Eager 512px chunks are clipped directly.  Streamed chunks retain one
// loadTileTexture handle per resident chunk and bind that same handle to all
// visible row slices; slicing never duplicates a texture upload.

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps } from "@pocketjs/framework/host";
import { freeTileTexture, loadTileTexture } from "../../vendor/pocketjs/framework/src/tiles.ts";
import {
  createElement,
  detachNode,
  insert,
  insertNode,
  release,
  retain,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import { ENUMS } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import {
  createChunkWindowReader,
  chunkWindowContains,
  expandChunkWindow,
  type ChunkPoint,
  type ChunkViewport,
  type ChunkWindow,
} from "../engine/chunk-window.ts";
import type { MapDef } from "../engine/types.ts";
import { CHUNK_PX, TILE } from "../engine/tiles.ts";
import type { AnimatedTilesStats } from "./AnimatedTiles.tsx";
import type { GameAssets, MapLayerVariant } from "./game-assets.ts";
import type { StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import { startupProfileMark } from "../startup-profile.ts";
import { actorDepth, upperRowDepth } from "./occlusion-depth.ts";

export { actorDepth, upperRowDepth } from "./occlusion-depth.ts";

const EMPTY_WINDOW: ChunkWindow = { x0: 0, y0: 0, x1: -1, y1: -1 };

function sameWindow(a: ChunkWindow, b: ChunkWindow): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

interface AboveTile {
  id: number;
  x: number;
  sprite: string;
}

interface LiveTexture {
  handle: number;
}

interface LiveRow {
  node: NodeMirror;
  y: number;
  images: NodeMirror[];
  indices: number[];
  animations: Map<number, NodeMirror>;
  used: boolean;
}

export interface OccludingUpperLayerProps {
  mapId: string;
  maps: ReadonlyMap<string, MapDef>;
  assets: GameAssets;
  firstMapId: string;
  /** Maximum map width in pixels. Required by sharded projects so depth
   * ordering does not depend on which MapDefs happen to be resident. */
  worldWidth?: number;
  camera: () => ChunkPoint;
  viewport: () => ChunkViewport;
  /** While false, the layer's per-frame pool sync pauses (the subtree stays
   *  mounted and hidden). Omit for always active. */
  active?: Accessor<boolean>;
  debugName?: string;
  /** Selected prepackaged upper source. undefined keeps the legacy source. */
  source?: () => { key: string; variant?: MapLayerVariant };
  /** Active animated-tile manifest. Omit to read GameAssets.animated. The
   * source key above invalidates both upper chunks and these placements. */
  animated?: () => GameAssets["animated"];
  /** Hide upper rows/above animations without hiding actor children. */
  visible?: () => boolean;
  onStreamStats?: (stats: StreamedChunkLayerStats) => void;
  onAnimatedStats?: (stats: AnimatedTilesStats) => void;
  /** Receives the layer's root view once, at mount. Children that grow their
   *  node pool at runtime insert into this root so their nodes stay siblings
   *  of the upper rows (zIndex paint order is per parent). */
  nodeRef?: (node: NodeMirror) => void;
  children?: SolidJSX.Element;
}

/** Persistent current-map upper/actor plane. Rows and image slices remain
 *  attached while scrolling or transferring; animation nodes are retained. */
export function OccludingUpperLayer(props: OccludingUpperLayerProps): SolidJSX.Element {
  const chunkWindow = createChunkWindowReader();
  const tileWindow = createChunkWindowReader();
  startupProfileMark("ui-upper:start");
  const root = createElement("view");
  setProp(root, "style", { posType: ENUMS.PosType.Absolute, insetL: 0, insetT: 0, width: 0, height: 0 });
  props.nodeRef?.(root);
  insert(root, () => props.children);

  // A modulo-addressed ring keeps every viewport row and slice attached.
  // Scrolling reassigns one row at a boundary; transfers only rebind sources.
  const rows: LiveRow[] = [];
  const spritePool: NodeMirror[] = [];
  const liveTextures = new Map<number, LiveTexture>();
  const textureUsers = new Map<number, Set<NodeMirror>>();
  let textureSlotsPooled = 0;
  let textureSlotsCreated = 0;
  let uploads = 0;
  let frees = 0;
  let spriteNodesCreated = 0;

  let currentMap = "";
  let currentSourceKey = "";
  let mapWidth = 0;
  let mapHeight = 0;
  const worldWidth = props.worldWidth
    ?? Math.max(1, ...[...props.maps.values()].map((map) => map.width * TILE));
  let refs: readonly (string | null)[] = [];
  let names: readonly string[] = [];
  let columns = 0;
  let chunkRows = 0;
  let chunkPx = CHUNK_PX;
  let streamMargin = TILE;
  let streamLoadBudget: number | undefined;
  let aboveByRow = new Map<number, AboveTile[]>();
  let lastTextureWindow: ChunkWindow = EMPTY_WINDOW;
  let lastTileWindow: ChunkWindow = EMPTY_WINDOW;
  let lastPaintChunkWindow: ChunkWindow = EMPTY_WINDOW;
  let texturePending = false;
  let rebind = false;
  const stream = props.assets.stream;
  const isStreamed = stream !== undefined;
  const loadTile = stream?.loadTile ?? loadTileTexture;
  let upperVisible = props.visible?.() ?? true;

  const reportStream = (pending: number): void => {
    if (!isStreamed || !props.onStreamStats) return;
    let textures = 0;
    for (const chunk of liveTextures.values()) if (chunk.handle >= 0) textures++;
    props.onStreamStats({
      mapId: currentMap,
      resident: liveTextures.size,
      textures,
      textureBytes: textures * (1024 + chunkPx * chunkPx),
      pooled: textureSlotsPooled,
      created: textureSlotsCreated,
      uploads,
      frees,
      pending,
    });
  };

  const reportAnimated = (): void => {
    if (!(props.animated?.() ?? props.assets.animated) || !props.onAnimatedStats) return;
    let mounted = 0;
    for (const row of rows) mounted += row.animations.size;
    props.onAnimatedStats({
      mapId: currentMap,
      mounted,
      created: spriteNodesCreated,
      pooled: spritePool.length,
    });
  };

  const setTexture = (index: number, handle: number): void => {
    for (const node of textureUsers.get(index) ?? []) getOps().setImage(node.id, handle);
  };

  const releaseTexture = (index: number, texture: LiveTexture): void => {
    setTexture(index, -1);
    if (texture.handle >= 0) {
      freeTileTexture(texture.handle);
      frees++;
    }
    liveTextures.delete(index);
    textureSlotsPooled++;
  };

  const clearTextures = (): void => {
    for (const [index, texture] of [...liveTextures]) releaseTexture(index, texture);
    lastTextureWindow = EMPTY_WINDOW;
    texturePending = false;
  };

  const releaseAnimationNode = (id: number, row: LiveRow, node: NodeMirror): void => {
    setProp(node, "sprite", null);
    retain(node);
    detachNode(row.node, node);
    row.animations.delete(id);
    spritePool.push(node);
  };

  const clearRow = (row: LiveRow): void => {
    for (let slot = 0; slot < row.images.length; slot++) {
      if (row.indices[slot]! >= 0) setChunkSlot(row, slot, -1);
    }
    for (const [id, node] of [...row.animations]) releaseAnimationNode(id, row, node);
  };

  const selectMap = (mapId: string, sourceKey: string): void => {
    for (const row of rows) {
      for (const [id, node] of [...row.animations]) releaseAnimationNode(id, row, node);
    }
    clearTextures();
    currentMap = mapId;
    currentSourceKey = sourceKey;
    const map = props.maps.get(mapId);
    if (!map) throw new Error(`OccludingUpperLayer: unknown map ${JSON.stringify(mapId)}`);
    mapWidth = map.width;
    mapHeight = map.height;

    const selected = props.source?.().variant;
    if (stream) {
      if (selected && !("refs" in selected)) {
        throw new Error("OccludingUpperLayer: streamed base requires streamed variants");
      }
      const source = selected && "refs" in selected ? selected : undefined;
      refs = source?.refs[mapId] ?? stream.upper[mapId] ?? [];
      names = [];
      columns = source?.columns[mapId] ?? stream.columns[mapId] ?? 0;
      chunkPx = source?.chunkPx ?? stream.chunkPx;
      streamMargin = source?.margin ?? stream.margin ?? TILE;
      streamLoadBudget = source?.loadBudget ?? stream.loadBudget;
    } else {
      if (selected && !("chunks" in selected)) {
        throw new Error("OccludingUpperLayer: eager base requires eager variants");
      }
      const source = selected && "chunks" in selected ? selected : undefined;
      refs = [];
      names = source?.chunks[mapId]
        ?? props.assets.upper[mapId]
        ?? props.assets.upper[props.firstMapId]
        ?? [];
      columns = source?.columns[mapId]
        ?? props.assets.chunkColumns[mapId]
        ?? props.assets.chunkColumns[props.firstMapId]
        ?? (names.length > 0 ? 1 : 0);
      chunkPx = CHUNK_PX;
    }
    const count = isStreamed ? refs.length : names.length;
    if (count === 0 && columns === 0) {
      chunkRows = 0;
    } else if (!Number.isInteger(columns) || columns < 1 || count % columns !== 0) {
      throw new Error(
        `OccludingUpperLayer: map ${JSON.stringify(mapId)} has ${count} upper chunks and ${columns} columns`,
      );
    } else {
      chunkRows = count / columns;
    }

    aboveByRow = new Map();
    let id = 0;
    for (const tile of (props.animated?.() ?? props.assets.animated)?.[mapId] ?? []) {
      if (!tile.above) continue;
      const group = aboveByRow.get(tile.y) ?? [];
      group.push({ id: id++, x: tile.x, sprite: tile.sprite });
      aboveByRow.set(tile.y, group);
    }
    lastTileWindow = EMPTY_WINDOW;
    lastPaintChunkWindow = EMPTY_WINDOW;
    rebind = true;
    setProp(root, "debugName", `${props.debugName ?? "rpgkit-actors"}-${mapId}`);
  };

  const sourceAt = (index: number): string | null =>
    isStreamed ? (refs[index] ?? null) : (names[index] || null);

  const textureWindow = (): ChunkWindow => {
    if (columns === 0 || chunkRows === 0) return EMPTY_WINDOW;
    return chunkWindow(
      props.camera(),
      props.viewport(),
      chunkPx,
      columns,
      chunkRows,
      streamMargin,
    );
  };

  const syncTextures = (): void => {
    if (!stream || columns === 0 || chunkRows === 0) {
      if (stream) reportStream(0);
      return;
    }
    const nextWindow = textureWindow();
    const moved = !sameWindow(lastTextureWindow, nextWindow);
    if (!moved && !texturePending) return;
    lastTextureWindow = nextWindow;

    const retention = expandChunkWindow(nextWindow, 1, columns, chunkRows);
    if (moved) {
      for (const [index, texture] of [...liveTextures]) {
        const x = index % columns;
        const y = Math.floor(index / columns);
        if (!chunkWindowContains(retention, x, y)) releaseTexture(index, texture);
      }
    }

    const camera = props.camera();
    const viewport = props.viewport();
    const centerX = (camera.x + viewport.w / 2) / chunkPx - 0.5;
    const centerY = (camera.y + viewport.h / 2) / chunkPx - 0.5;
    const missing: { index: number; distance: number }[] = [];
    for (let y = nextWindow.y0; y <= nextWindow.y1; y++) {
      for (let x = nextWindow.x0; x <= nextWindow.x1; x++) {
        const index = y * columns + x;
        if (liveTextures.has(index) || !refs[index]) continue;
        const dx = x - centerX;
        const dy = y - centerY;
        missing.push({ index, distance: dx * dx + dy * dy });
      }
    }
    missing.sort((a, b) => a.distance - b.distance || a.index - b.index);

    const configured = streamLoadBudget;
    if (configured !== undefined && (!Number.isFinite(configured) || configured < 0)) {
      throw new Error(`OccludingUpperLayer: loadBudget must be a non-negative number, got ${configured}`);
    }
    const budget = configured === undefined ? Number.POSITIVE_INFINITY : Math.floor(configured);
    const count = Math.min(missing.length, budget);
    for (let i = 0; i < count; i++) {
      const index = missing[i]!.index;
      const ref = refs[index]!;
      const hash = ref.lastIndexOf("#");
      const tileIndex = Number(ref.slice(hash + 1));
      if (hash <= 0 || !Number.isInteger(tileIndex) || tileIndex < 0) {
        throw new Error(`OccludingUpperLayer: bad ref ${JSON.stringify(ref)}`);
      }
      if (textureSlotsPooled > 0) textureSlotsPooled--;
      else textureSlotsCreated++;
      const handle = loadTile(ref.slice(0, hash), tileIndex);
      if (handle >= 0) uploads++;
      liveTextures.set(index, { handle });
      setTexture(index, handle);
    }
    texturePending = count < missing.length;
    reportStream(missing.length - count);
  };

  const makeImage = (row: LiveRow, x: number): void => {
    const node = createElement("image");
    setProp(node, "style", {
      posType: ENUMS.PosType.Absolute,
      insetL: 0,
      translateX: x * chunkPx,
      insetT: 0,
      translateY: Math.floor((row.y * TILE) / chunkPx) * chunkPx - row.y * TILE,
      width: chunkPx,
      height: chunkPx,
    });
    insertNode(row.node, node, row.animations.values().next().value);
    row.images.push(node);
    row.indices.push(-1);
  };

  const makeRow = (y: number, slices = 0): LiveRow => {
    const node = createElement("view");
    setProp(node, "style", {
      posType: ENUMS.PosType.Absolute,
      insetL: 0,
      insetT: 0,
      translateY: y * TILE,
      width: worldWidth,
      height: TILE,
      overflow: ENUMS.Overflow.Hidden,
      zIndex: upperRowDepth(y, worldWidth),
      display: upperVisible ? 0 : 1,
    });
    insertNode(root, node);
    const row: LiveRow = { node, y, images: [], indices: [], animations: new Map(), used: false };
    for (let x = 0; x < slices; x++) makeImage(row, x);
    return row;
  };

  function setChunkSlot(row: LiveRow, slot: number, index: number): void {
    const node = row.images[slot]!;
    const old = row.indices[slot] ?? -1;
    if (isStreamed && old >= 0) {
      const users = textureUsers.get(old);
      users?.delete(node);
      if (users?.size === 0) textureUsers.delete(old);
    }
    row.indices[slot] = index;
    if (index < 0) {
      if (isStreamed) getOps().setImage(node.id, -1);
      else setProp(node, "src", "", node.domAttrs?.src as string | undefined);
      return;
    }
    const x = index % columns;
    setProp(node, "style", {
      insetL: 0,
      translateX: x * chunkPx,
      insetT: 0,
      translateY: Math.floor((row.y * TILE) / chunkPx) * chunkPx - row.y * TILE,
    }, node.domAttrs?.style);
    setProp(node, "debugName", `rpgkit-upper-row-${row.y}-chunk-${index}`);
    if (isStreamed) {
      const users = textureUsers.get(index) ?? new Set<NodeMirror>();
      users.add(node);
      textureUsers.set(index, users);
      getOps().setImage(node.id, liveTextures.get(index)?.handle ?? -1);
    } else {
      setProp(node, "src", names[index] ?? "", node.domAttrs?.src as string | undefined);
    }
  }

  const syncRow = (
    row: LiveRow,
    tileWin: ChunkWindow,
    chunkWin: ChunkWindow,
  ): void => {
    const chunkY = Math.floor((row.y * TILE) / chunkPx);
    const wanted: number[] = [];
    if (chunkY >= 0 && chunkY < chunkRows) {
      for (let x = chunkWin.x0; x <= chunkWin.x1; x++) {
        const index = chunkY * columns + x;
        if (sourceAt(index)) wanted.push(index);
      }
    }
    while (row.images.length < wanted.length) makeImage(row, row.images.length);
    for (let slot = 0; slot < row.images.length; slot++) {
      const index = wanted[slot] ?? -1;
      if (row.indices[slot] !== index || (rebind && index >= 0)) setChunkSlot(row, slot, index);
    }

    const wantedAnimations = new Map<number, AboveTile>();
    for (const tile of aboveByRow.get(row.y) ?? []) {
      if (tile.x >= tileWin.x0 && tile.x <= tileWin.x1) wantedAnimations.set(tile.id, tile);
    }
    for (const [id, node] of [...row.animations]) {
      if (!wantedAnimations.has(id)) releaseAnimationNode(id, row, node);
    }
    for (const [id, tile] of wantedAnimations) {
      if (row.animations.has(id)) continue;
      const pooled = spritePool.pop();
      if (pooled) release(pooled);
      const node = pooled ?? createElement("image");
      if (!pooled) spriteNodesCreated++;
      setProp(node, "style", {
        posType: ENUMS.PosType.Absolute,
        insetL: tile.x * TILE,
        insetT: 0,
        width: TILE,
        height: TILE,
      });
      setProp(node, "debugName", `rpgkit-anim-above-tile-${tile.x},${row.y}`);
      insertNode(row.node, node);
      setProp(node, "sprite", tile.sprite);
      row.animations.set(id, node);
    }
  };

  const syncRows = (): void => {
    const tileWin = tileWindow(
      props.camera(),
      props.viewport(),
      TILE,
      mapWidth,
      mapHeight,
      TILE,
    );
    const chunkWin = textureWindow();
    if (
      sameWindow(tileWin, lastTileWindow)
      && sameWindow(chunkWin, lastPaintChunkWindow)
    ) return;
    lastTileWindow = tileWin;
    lastPaintChunkWindow = chunkWin;

    const rowCount = Math.max(0, tileWin.y1 - tileWin.y0 + 1);
    while (rows.length < rowCount) rows.push(makeRow(rows.length));
    for (const row of rows) row.used = false;
    for (let y = tileWin.y0; y <= tileWin.y1; y++) {
      const chunkY = Math.floor((y * TILE) / chunkPx);
      let hasChunk = false;
      if (chunkY >= 0 && chunkY < chunkRows) {
        for (let x = chunkWin.x0; x <= chunkWin.x1; x++) {
          if (sourceAt(chunkY * columns + x)) {
            hasChunk = true;
            break;
          }
        }
      }
      const hasAnimation = (aboveByRow.get(y) ?? []).some(
        (tile) => tile.x >= tileWin.x0 && tile.x <= tileWin.x1,
      );
      if (!hasChunk && !hasAnimation) continue;
      const row = rows[y % rows.length]!;
      row.used = true;
      if (row.y !== y) {
        clearRow(row);
        row.y = y;
        setProp(row.node, "style", {
          insetT: 0,
          translateY: y * TILE,
          zIndex: upperRowDepth(y, worldWidth),
        }, row.node.domAttrs?.style);
      }
      setProp(row.node, "debugName", `rpgkit-upper-row-${y}`);
      syncRow(row, tileWin, chunkWin);
    }
    for (const row of rows) if (!row.used) clearRow(row);
    rebind = false;
    reportAnimated();
  };

  // Establish the initial map metadata/debug identity during mount; texture
  // uploads and viewport row creation remain frame-driven like the existing
  // streamed and animated layers.
  selectMap(props.mapId, props.source?.().key ?? "");
  startupProfileMark("ui-upper:selected");
  const viewport = props.viewport();
  const rowCount = Math.ceil(viewport.h / TILE) + 3;
  const sliceCount = Math.min(
    Math.max(0, ...Object.values(stream?.columns ?? props.assets.chunkColumns)),
    Math.ceil(viewport.w / chunkPx) + 2,
  );
  for (let y = 0; y < rowCount; y++) rows.push(makeRow(y, sliceCount));
  startupProfileMark("ui-upper:pooled");

  onFrame(() => {
    if (props.active && !props.active()) return;
    const nextVisible = props.visible?.() ?? true;
    if (upperVisible !== nextVisible) {
      upperVisible = nextVisible;
      for (const row of rows) {
        setProp(row.node, "style", { display: upperVisible ? 0 : 1 }, row.node.domAttrs?.style);
      }
    }
    const sourceKey = props.source?.().key ?? "";
    if (currentMap !== props.mapId || currentSourceKey !== sourceKey) selectMap(props.mapId, sourceKey);
    syncTextures();
    syncRows();
  });

  onCleanup(() => {
    for (const row of rows) clearRow(row);
    clearTextures();
    // A pool retains detached mirrors only while this component can reuse
    // them. Once the owner unmounts, release every parked node so the normal
    // frame-end sweep can destroy the native subtrees.
    for (const node of spritePool) release(node);
    rows.length = 0;
    spritePool.length = 0;
    reportStream(0);
    reportAnimated();
  });

  startupProfileMark("ui-upper:end");
  return root as unknown as SolidJSX.Element;
}
