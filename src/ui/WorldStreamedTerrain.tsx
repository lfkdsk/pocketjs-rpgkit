// Component-wide viewport streaming for placed world terrain. Unlike the
// single-map StreamedChunkLayer, this renderer keeps one node/texture pool per
// paint band and addresses live chunks by map id, so crossing a placement edge
// neither rebuilds the scene tree nor gives every map its own upload budget.

import { onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import { getOps } from "@pocketjs/framework/host";
import { onFrame } from "@pocketjs/framework/lifecycle";
import {
  createElement,
  insert,
  insertNode,
  setProp,
  type NodeMirror,
} from "@pocketjs/framework/renderer";
import { ENUMS } from "../../vendor/pocketjs/contracts/spec/spec.ts";
import { freeTileTexture, loadTileTexture } from "../../vendor/pocketjs/framework/src/tiles.ts";
import {
  chunkWindow,
  expandChunkWindow,
  type ChunkPoint,
  type ChunkViewport,
  type ChunkWindow,
} from "../engine/chunk-window.ts";
import { TILE } from "../engine/tiles.ts";
import type { WorldComponent, WorldPlacement } from "../engine/types.ts";
import type { StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import { upperRowDepth } from "./occlusion-depth.ts";

export type WorldStreamedTerrainBand = "ground" | "upper";

export interface WorldStreamedTerrainBandSource {
  /** Map id -> row-major `ui:tile.*#index` refs; null is transparent. */
  refs: Accessor<Readonly<Record<string, readonly (string | null)[]>>>;
  /** Map id -> chunk columns. Rows are derived from the corresponding refs. */
  columns: Accessor<Readonly<Record<string, number>>>;
  /** Change this whenever the meaning of refs changes in place. */
  sourceKey?: Accessor<string>;
  /** Paint-only gate. Hidden bands retain textures and pooled nodes. */
  visible?: Accessor<boolean>;
  /** Pixel prefetch margin around the viewport (default one tile). */
  margin?: Accessor<number | undefined>;
  /** Uploads from this band per frame. Omit for no limit; zero pauses. */
  loadBudget?: Accessor<number | undefined>;
}

export interface WorldStreamedTerrainStats extends StreamedChunkLayerStats {
  worldId: string;
  componentId: string;
  /** Sorted map ids offered by visiblePlacements for this sync. */
  visibleMaps: readonly string[];
  /** Upper-only row compositor high-water marks. */
  rowNodes?: number;
  sliceNodes?: number;
  textureBindings?: number;
  /** Cumulative upper compositor work counters for diagnostics/regression tests. */
  rowSyncs?: number;
  chunkSorts?: number;
  rowStyleWrites?: number;
  rowNameWrites?: number;
  imageWrites?: number;
}

export interface WorldStreamedTerrainProps {
  /** Used for the compatible StreamedChunkLayerStats.mapId field. */
  activeMapId: Accessor<string>;
  /** The currently rendered connected component. Immutable objects are ideal. */
  component: WorldComponent | Accessor<WorldComponent>;
  /** Stable viewport-relevant placements. Origins are component-world tiles. */
  visiblePlacements: Accessor<readonly WorldPlacement[]>;
  /** Camera top-left in the component's signed world-pixel coordinates. */
  camera: Accessor<ChunkPoint>;
  viewport: Accessor<ChunkViewport>;
  chunkPx: number;
  /** Optional runtime tile loader; returned handles are freed with freeTileTexture. */
  loadTile?: (key: string, index: number) => number;
  ground: WorldStreamedTerrainBandSource;
  upper: WorldStreamedTerrainBandSource;
  /** While false, residency and uploads pause with the kept-alive world. */
  active?: Accessor<boolean>;
  debugName?: string;
  /** Slots are deliberately siblings: ground -> below -> flat upper/actors -> above. */
  below?: SolidJSX.Element;
  /** Insert actors, preview actors and above animated cells into the flat
   * upper-row host. */
  occlusion?: (host: NodeMirror) => SolidJSX.Element;
  above?: SolidJSX.Element;
  onStats?: (band: WorldStreamedTerrainBand, stats: WorldStreamedTerrainStats) => void;
}

interface LiveChunk {
  key: string;
  node?: NodeMirror;
  handle: number;
  mapId: string;
  index: number;
  x: number;
  y: number;
}

interface BandState {
  readonly band: WorldStreamedTerrainBand;
  readonly source: WorldStreamedTerrainBandSource;
  readonly root: NodeMirror;
  readonly live: Map<string, LiveChunk>;
  readonly pool: NodeMirror[];
  sourceKey: string;
  refs: Readonly<Record<string, readonly (string | null)[]>> | undefined;
  columns: Readonly<Record<string, number>> | undefined;
  margin: number | undefined;
  placements: readonly WorldPlacement[] | undefined;
  /** Reused scratch point for projecting the world camera into each map. */
  readonly localCamera: ChunkPoint;
  readonly windows: Map<string, ChunkWindow>;
  visible: boolean;
  pending: boolean;
  created: number;
  uploads: number;
  frees: number;
  virtualPooled: number;
}

interface UpperSlice {
  node: NodeMirror;
  key: string;
}

interface UpperRow {
  node: NodeMirror;
  worldY: number;
  minX: number;
  width: number;
  zIndex: number;
  display: number;
  debugName: string;
  slices: UpperSlice[];
  used: boolean;
}

interface MissingChunk {
  worldId: string;
  mapId: string;
  band: WorldStreamedTerrainBand;
  index: number;
  ref: string;
  x: number;
  y: number;
}

const BAND_ORDER: Readonly<Record<WorldStreamedTerrainBand, number>> = {
  ground: 0,
  upper: 1,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameComponent(a: WorldComponent | undefined, b: WorldComponent): boolean {
  return a === b || !!a && a.worldId === b.worldId && a.componentId === b.componentId &&
    a.bounds.minTileX === b.bounds.minTileX && a.bounds.minTileY === b.bounds.minTileY &&
    a.bounds.maxTileX === b.bounds.maxTileX && a.bounds.maxTileY === b.bounds.maxTileY;
}

function liveKey(mapId: string, band: WorldStreamedTerrainBand, index: number): string {
  return `${mapId}\0${band}\0${index}`;
}

function parseRef(ref: string): { key: string; index: number } {
  const hash = ref.lastIndexOf("#");
  const index = Number(ref.slice(hash + 1));
  if (hash <= 0 || !Number.isInteger(index) || index < 0) {
    throw new Error(`WorldStreamedTerrain: bad ref ${JSON.stringify(ref)}`);
  }
  return { key: ref.slice(0, hash), index };
}

function readComponent(source: WorldComponent | Accessor<WorldComponent>): WorldComponent {
  return typeof source === "function" ? source() : source;
}

function configuredBudget(source: WorldStreamedTerrainBandSource, band: WorldStreamedTerrainBand): number {
  const configured = source.loadBudget?.();
  if (configured !== undefined && (!Number.isFinite(configured) || configured < 0)) {
    throw new Error(
      `WorldStreamedTerrain: ${band} loadBudget must be a non-negative number, got ${configured}`,
    );
  }
  return configured === undefined ? Number.POSITIVE_INFINITY : Math.floor(configured);
}

/**
 * Two streamed terrain bands sharing one component-wide scheduling pass.
 * Placement origins and the camera use the same signed world-pixel space; the
 * caller owns any component-bounds normalization outside this component.
 */
export function WorldStreamedTerrain(props: WorldStreamedTerrainProps): SolidJSX.Element {
  if (!Number.isFinite(props.chunkPx) || props.chunkPx <= 0) {
    throw new Error(`WorldStreamedTerrain: chunkPx must be positive, got ${props.chunkPx}`);
  }

  const makeBand = (
    band: WorldStreamedTerrainBand,
    source: WorldStreamedTerrainBandSource,
  ): BandState => {
    const root = createElement("view");
    const visible = source.visible?.() ?? true;
    setProp(root, "style", {
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: 0,
      height: 0,
      // Upper rows share this root with actors, so only their row nodes hide.
      display: band === "upper" || visible ? 0 : 1,
    });
    setProp(root, "debugName", `${props.debugName ?? "rpgkit-world-terrain"}-${band}`);
    return {
      band,
      source,
      root,
      live: new Map(),
      pool: [],
      sourceKey: source.sourceKey?.() ?? "",
      refs: undefined,
      columns: undefined,
      margin: undefined,
      placements: undefined,
      localCamera: { x: 0, y: 0 },
      windows: new Map(),
      visible,
      pending: false,
      created: 0,
      uploads: 0,
      frees: 0,
      virtualPooled: 0,
    };
  };

  const ground = makeBand("ground", props.ground);
  const upper = makeBand("upper", props.upper);
  const bands = [ground, upper] as const;
  let currentComponent: WorldComponent | undefined;
  let reportedPlacements: readonly WorldPlacement[] | undefined;
  let visibleMapIds: readonly string[] = [];
  const upperRows: UpperRow[] = [];
  const upperUsers = new Map<string, Set<NodeMirror>>();
  const upperVisibleChunks: LiveChunk[] = [];
  const upperRowBuckets: LiveChunk[][] = [];
  let upperRowsDirty = true;
  let upperWindowX0 = Number.NaN;
  let upperWindowY0 = Number.NaN;
  let upperWindowX1 = Number.NaN;
  let upperWindowY1 = Number.NaN;
  let upperRowSyncs = 0;
  let upperChunkSorts = 0;
  let upperRowStyleWrites = 0;
  let upperRowNameWrites = 0;
  let upperImageWrites = 0;

  const clearUpperSlice = (slice: UpperSlice): void => {
    if (slice.key === "") return;
    const users = upperUsers.get(slice.key);
    users?.delete(slice.node);
    if (users?.size === 0) upperUsers.delete(slice.key);
    getOps().setImage(slice.node.id, -1);
    upperImageWrites++;
    slice.key = "";
  };

  const clearUpperRows = (): void => {
    for (const row of upperRows) {
      for (const slice of row.slices) clearUpperSlice(slice);
      row.used = false;
    }
    upperWindowX0 = upperWindowY0 = upperWindowX1 = upperWindowY1 = Number.NaN;
    upperRowsDirty = true;
  };

  const makeUpperRow = (component: WorldComponent, worldY: number): UpperRow => {
    const minX = component.bounds.minTileX * TILE;
    const minY = component.bounds.minTileY * TILE;
    const width = (component.bounds.maxTileX - component.bounds.minTileX) * TILE;
    const zIndex = upperRowDepth((worldY - minY) / TILE, width);
    const display = upper.visible ? 0 : 1;
    const debugName = `rpgkit-world-upper-row-${worldY / TILE}`;
    const node = createElement("view");
    setProp(node, "style", {
      posType: 1,
      insetL: 0,
      insetT: 0,
      translateX: minX,
      translateY: worldY,
      width,
      height: TILE,
      overflow: ENUMS.Overflow.Hidden,
      zIndex,
      display,
    });
    upperRowStyleWrites++;
    setProp(node, "debugName", debugName);
    upperRowNameWrites++;
    insertNode(upper.root, node);
    return { node, worldY, minX, width, zIndex, display, debugName, slices: [], used: false };
  };

  const makeUpperSlice = (row: UpperRow): UpperSlice => {
    const node = createElement("image");
    setProp(node, "style", {
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: props.chunkPx,
      height: props.chunkPx,
    });
    insertNode(row.node, node);
    const slice = { node, key: "" };
    row.slices.push(slice);
    return slice;
  };

  const bindUpperSlice = (
    row: UpperRow,
    slice: UpperSlice,
    key: string,
    chunk: LiveChunk | undefined,
    component: WorldComponent,
  ): void => {
    if (slice.key === key && key !== "" && upperUsers.get(key)?.has(slice.node)) return;
    clearUpperSlice(slice);
    if (!chunk || key === "") return;
    const minX = component.bounds.minTileX * TILE;
    setProp(slice.node, "style", {
      translateX: chunk.x - minX,
      translateY: chunk.y - row.worldY,
    }, slice.node.domAttrs?.style);
    setProp(slice.node, "debugName", `rpgkit-world-upper-row-${row.worldY / TILE}-${chunk.mapId}-${chunk.index}`);
    slice.key = key;
    const users = upperUsers.get(key) ?? new Set<NodeMirror>();
    users.add(slice.node);
    upperUsers.set(key, users);
    getOps().setImage(slice.node.id, chunk.handle);
    upperImageWrites++;
  };

  const updateUpperRow = (
    row: UpperRow,
    component: WorldComponent,
    tileY: number,
  ): void => {
    const worldY = tileY * TILE;
    const minX = component.bounds.minTileX * TILE;
    const minY = component.bounds.minTileY * TILE;
    const width = (component.bounds.maxTileX - component.bounds.minTileX) * TILE;
    const zIndex = upperRowDepth((worldY - minY) / TILE, width);
    const display = upper.visible ? 0 : 1;
    if (row.worldY !== worldY) {
      for (const slice of row.slices) clearUpperSlice(slice);
    }
    if (row.worldY !== worldY || row.minX !== minX || row.width !== width ||
        row.zIndex !== zIndex || row.display !== display) {
      setProp(row.node, "style", {
        translateX: minX,
        translateY: worldY,
        width,
        zIndex,
        display,
      }, row.node.domAttrs?.style);
      upperRowStyleWrites++;
      row.worldY = worldY;
      row.minX = minX;
      row.width = width;
      row.zIndex = zIndex;
      row.display = display;
    }
    const debugName = `rpgkit-world-upper-row-${tileY}`;
    if (row.debugName !== debugName) {
      setProp(row.node, "debugName", debugName, row.node.domAttrs?.debugName);
      upperRowNameWrites++;
      row.debugName = debugName;
    }
  };

  const syncUpperRows = (
    component: WorldComponent,
    camera: ChunkPoint,
    viewport: ChunkViewport,
  ): boolean => {
    // The clip and camera already hide anything outside the exact viewport.
    // Keep a conservative tile-aligned horizontal window so walking one pixel
    // does not resubmit every row and image binding.
    const x0 = Math.floor((camera.x - TILE) / TILE) * TILE;
    const x1 = Math.ceil((camera.x + viewport.w + TILE) / TILE) * TILE;
    const y0 = Math.max(component.bounds.minTileY, Math.floor((camera.y - TILE) / TILE));
    const y1 = Math.min(component.bounds.maxTileY - 1, Math.ceil((camera.y + viewport.h + TILE) / TILE) - 1);
    if (!upperRowsDirty && x0 === upperWindowX0 && y0 === upperWindowY0 &&
        x1 === upperWindowX1 && y1 === upperWindowY1) return false;
    upperRowSyncs++;
    upperWindowX0 = x0;
    upperWindowY0 = y0;
    upperWindowX1 = x1;
    upperWindowY1 = y1;
    const count = Math.max(0, y1 - y0 + 1);
    while (upperRows.length < count) upperRows.push(makeUpperRow(component, (y0 + upperRows.length) * TILE));
    for (const row of upperRows) row.used = false;
    while (upperRowBuckets.length < count) upperRowBuckets.push([]);
    for (let index = 0; index < count; index++) upperRowBuckets[index]!.length = 0;
    upperVisibleChunks.length = 0;
    for (const chunk of upper.live.values()) {
      if (chunk.x < x1 && chunk.x + props.chunkPx > x0 &&
          chunk.y < (y1 + 1) * TILE && chunk.y + props.chunkPx > y0 * TILE) {
        upperVisibleChunks.push(chunk);
      }
    }
    upperVisibleChunks.sort((a, b) =>
      a.x - b.x || compareText(a.mapId, b.mapId) || a.index - b.index
    );
    upperChunkSorts++;
    for (const chunk of upperVisibleChunks) {
      const first = Math.max(y0, Math.ceil(chunk.y / TILE));
      const last = Math.min(y1, Math.ceil((chunk.y + props.chunkPx) / TILE) - 1);
      for (let tileY = first; tileY <= last; tileY++) {
        upperRowBuckets[tileY - y0]!.push(chunk);
      }
    }
    for (let tileY = y0; tileY <= y1; tileY++) {
      const slot = ((tileY % upperRows.length) + upperRows.length) % upperRows.length;
      const row = upperRows[slot]!;
      row.used = true;
      updateUpperRow(row, component, tileY);
      const wanted = upperRowBuckets[tileY - y0]!;
      while (row.slices.length < wanted.length) makeUpperSlice(row);
      for (let index = 0; index < row.slices.length; index++) {
        const chunk = wanted[index];
        bindUpperSlice(row, row.slices[index]!, chunk?.key ?? "", chunk, component);
      }
    }
    for (const row of upperRows) {
      if (!row.used) for (const slice of row.slices) clearUpperSlice(slice);
    }
    upperRowsDirty = false;
    return true;
  };

  insert(upper.root, () => props.occlusion?.(upper.root));

  const release = (state: BandState, key: string, chunk: LiveChunk): void => {
    if (chunk.node) {
      getOps().setImage(chunk.node.id, -1);
      state.pool.push(chunk.node);
    } else {
      for (const node of upperUsers.get(key) ?? []) {
        getOps().setImage(node.id, -1);
        upperImageWrites++;
      }
      upperUsers.delete(key);
      state.virtualPooled++;
      upperRowsDirty = true;
    }
    if (chunk.handle >= 0) {
      freeTileTexture(chunk.handle);
      state.frees++;
    }
    state.live.delete(key);
  };

  const clear = (state: BandState): void => {
    for (const [key, chunk] of [...state.live]) release(state, key, chunk);
    if (state.band === "upper") clearUpperRows();
    state.windows.clear();
    state.pending = false;
  };

  const nodeFor = (state: BandState, mapId: string, index: number): NodeMirror => {
    if (state.band !== "ground") throw new Error("WorldStreamedTerrain: upper chunks use row slices");
    const reused = state.pool.pop();
    if (reused) {
      setProp(
        reused,
        "debugName",
        `${props.debugName ?? "rpgkit-world-terrain"}-${state.band}-${mapId}-${index}`,
        reused.domAttrs?.debugName,
      );
      return reused;
    }
    const node = createElement("image");
    setProp(node, "style", {
      posType: 1,
      insetL: 0,
      insetT: 0,
      width: props.chunkPx,
      height: props.chunkPx,
    });
    setProp(node, "debugName", `${props.debugName ?? "rpgkit-world-terrain"}-${state.band}-${mapId}-${index}`);
    insertNode(state.root, node);
    state.created++;
    return node;
  };

  const report = (state: BandState, component: WorldComponent, pending: number): void => {
    if (!props.onStats) return;
    let textures = 0;
    for (const chunk of state.live.values()) if (chunk.handle >= 0) textures++;
    props.onStats(state.band, {
      mapId: props.activeMapId(),
      worldId: component.worldId,
      componentId: component.componentId,
      visibleMaps: visibleMapIds,
      resident: state.live.size,
      textures,
      textureBytes: textures * (1024 + props.chunkPx * props.chunkPx),
      pooled: state.band === "upper" ? state.virtualPooled : state.pool.length,
      created: state.created,
      uploads: state.uploads,
      frees: state.frees,
      pending,
      ...(state.band === "upper"
        ? {
            rowNodes: upperRows.length,
            sliceNodes: upperRows.reduce((sum, row) => sum + row.slices.length, 0),
            textureBindings: [...upperUsers.values()].reduce((sum, users) => sum + users.size, 0),
            rowSyncs: upperRowSyncs,
            chunkSorts: upperChunkSorts,
            rowStyleWrites: upperRowStyleWrites,
            rowNameWrites: upperRowNameWrites,
            imageWrites: upperImageWrites,
          }
        : {}),
    });
  };

  const workFor = (
    state: BandState,
    component: WorldComponent,
    placements: readonly WorldPlacement[],
    camera: ChunkPoint,
    viewport: ChunkViewport,
    componentChanged: boolean,
  ): MissingChunk[] | undefined => {
    const sourceKey = state.source.sourceKey?.() ?? "";
    const refs = state.source.refs();
    const columnsByMap = state.source.columns();
    const margin = state.source.margin?.() ?? TILE;
    if (!Number.isFinite(margin) || margin < 0) {
      throw new Error(`WorldStreamedTerrain: ${state.band} margin must be non-negative, got ${margin}`);
    }
    const sourceChanged = sourceKey !== state.sourceKey || refs !== state.refs || columnsByMap !== state.columns;
    if (componentChanged || sourceChanged) clear(state);

    const placementsChanged = placements !== state.placements;
    const geometryChanged = componentChanged || sourceChanged || placementsChanged || margin !== state.margin;
    let windowChanged = geometryChanged;
    // A pixel camera change normally remains inside the same chunk windows.
    // Compare those integer boundaries before allocating retention/missing sets.
    for (const placement of placements) {
      const mapRefs = refs[placement.mapId] ?? [];
      const columns = columnsByMap[placement.mapId] ?? 0;
      if (!Number.isInteger(columns) || columns < 1 || mapRefs.length % columns !== 0) {
        if (mapRefs.length !== 0 || columns !== 0) {
          throw new Error(
            `WorldStreamedTerrain: ${state.band} map ${JSON.stringify(placement.mapId)} has ` +
            `${mapRefs.length} refs and ${columns} columns`,
          );
        }
      }
      const originX = placement.originTileX * TILE;
      const originY = placement.originTileY * TILE;
      state.localCamera.x = camera.x - originX;
      state.localCamera.y = camera.y - originY;
      const previous = state.windows.get(placement.mapId);
      const requested = chunkWindow(
        state.localCamera,
        viewport,
        props.chunkPx,
        columns,
        columns === 0 ? 0 : mapRefs.length / columns,
        margin,
        previous,
      );
      if (requested !== previous) {
        state.windows.set(placement.mapId, requested);
        windowChanged = true;
      }
    }
    if (placementsChanged) {
      for (const mapId of [...state.windows.keys()]) {
        if (!placements.some((placement) => placement.mapId === mapId)) state.windows.delete(mapId);
      }
    }

    const shouldSync = windowChanged || state.pending;

    state.sourceKey = sourceKey;
    state.refs = refs;
    state.columns = columnsByMap;
    state.margin = margin;
    state.placements = placements;
    if (!shouldSync) return undefined;

    const retained = new Set<string>();
    const missing: MissingChunk[] = [];
    for (const placement of placements) {
      const mapRefs = refs[placement.mapId] ?? [];
      const columns = columnsByMap[placement.mapId] ?? 0;
      if (!Number.isInteger(columns) || columns < 1 || mapRefs.length % columns !== 0) {
        if (mapRefs.length === 0 && columns === 0) continue;
        throw new Error(
          `WorldStreamedTerrain: ${state.band} map ${JSON.stringify(placement.mapId)} has ` +
          `${mapRefs.length} refs and ${columns} columns`,
        );
      }
      const originX = placement.originTileX * TILE;
      const originY = placement.originTileY * TILE;
      const rows = mapRefs.length / columns;
      const requested = state.windows.get(placement.mapId)!;
      const retention = expandChunkWindow(requested, 1, columns, rows);
      for (let y = retention.y0; y <= retention.y1; y++) {
        for (let x = retention.x0; x <= retention.x1; x++) {
          retained.add(liveKey(placement.mapId, state.band, y * columns + x));
        }
      }
      for (let y = requested.y0; y <= requested.y1; y++) {
        for (let x = requested.x0; x <= requested.x1; x++) {
          const index = y * columns + x;
          const ref = mapRefs[index];
          const key = liveKey(placement.mapId, state.band, index);
          if (!ref || state.live.has(key)) continue;
          missing.push({
            worldId: component.worldId,
            mapId: placement.mapId,
            band: state.band,
            index,
            ref,
            x: originX + x * props.chunkPx,
            y: originY + y * props.chunkPx,
          });
        }
      }
    }

    for (const [key, chunk] of [...state.live]) {
      if (!retained.has(key)) release(state, key, chunk);
    }
    return missing;
  };

  const sync = (
    groundBudgetAlreadyUsed: number,
    upperBudgetAlreadyUsed: number,
    captureLoaded?: Record<WorldStreamedTerrainBand, number>,
  ): void => {
    if (props.active && !props.active()) return;
    const component = readComponent(props.component);
    const componentChanged = !sameComponent(currentComponent, component);
    currentComponent = component;

    // The culler promises a stable array identity; retain it so an unchanged
    // camera/window is a true no-work frame. Scheduling is sorted separately.
    const placements = props.visiblePlacements();
    if (props.onStats && placements !== reportedPlacements) {
      reportedPlacements = placements;
      visibleMapIds = placements.map((placement) => placement.mapId).sort(compareText);
    }
    const camera = props.camera();
    const viewport = props.viewport();

    let visibilityChanged = false;
    for (const state of bands) {
      const visible = state.source.visible?.() ?? true;
      if (visible !== state.visible) {
        state.visible = visible;
        visibilityChanged = true;
        if (state.band === "upper") {
          for (const row of upperRows) {
            const display = visible ? 0 : 1;
            if (row.display !== display) {
              setProp(row.node, "style", { display }, row.node.domAttrs?.style);
              upperRowStyleWrites++;
              row.display = display;
            }
          }
        } else {
          setProp(state.root, "style", { display: visible ? 0 : 1 }, state.root.domAttrs?.style);
        }
      }
    }

    const groundMissing = workFor(ground, component, placements, camera, viewport, componentChanged);
    const upperMissing = workFor(upper, component, placements, camera, viewport, componentChanged);
    if (groundMissing === undefined && upperMissing === undefined) {
      const rowsChanged = syncUpperRows(component, camera, viewport);
      if (visibilityChanged) {
        report(ground, component, 0);
        report(upper, component, 0);
      } else if (rowsChanged) report(upper, component, 0);
      return;
    }
    const missing = groundMissing === undefined
      ? upperMissing!
      : upperMissing === undefined
        ? groundMissing
        : [...groundMissing, ...upperMissing];
    missing.sort((a, b) =>
      compareText(a.worldId, b.worldId) ||
      compareText(a.mapId, b.mapId) ||
      BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
      a.index - b.index
    );

    const budget: Record<WorldStreamedTerrainBand, number> = {
      ground: Math.max(0, configuredBudget(props.ground, "ground") - groundBudgetAlreadyUsed),
      upper: Math.max(0, configuredBudget(props.upper, "upper") - upperBudgetAlreadyUsed),
    };
    const loaded: Record<WorldStreamedTerrainBand, number> = { ground: 0, upper: 0 };
    const load = props.loadTile ?? loadTileTexture;
    for (const entry of missing) {
      if (loaded[entry.band] >= budget[entry.band]) continue;
      const state = entry.band === "ground" ? ground : upper;
      const parsed = parseRef(entry.ref);
      const node = state.band === "ground" ? nodeFor(state, entry.mapId, entry.index) : undefined;
      if (node) {
        jump(node, "translateX", entry.x);
        jump(node, "translateY", entry.y);
      } else if (state.virtualPooled > 0) {
        state.virtualPooled--;
      } else {
        state.created++;
      }
      const handle = load(parsed.key, parsed.index);
      if (handle >= 0) {
        if (node) getOps().setImage(node.id, handle);
        state.uploads++;
      }
      const key = liveKey(entry.mapId, entry.band, entry.index);
      state.live.set(key, {
        key,
        node,
        handle,
        mapId: entry.mapId,
        index: entry.index,
        x: entry.x,
        y: entry.y,
      });
      if (state.band === "upper") upperRowsDirty = true;
      loaded[entry.band]++;
    }
    if (captureLoaded) {
      captureLoaded.ground = loaded.ground;
      captureLoaded.upper = loaded.upper;
    }

    // A failed (-1) load still consumes one unit and becomes resident,
    // matching the single-map layer's retry semantics.
    if (groundMissing !== undefined) {
      const pending = Math.max(0, groundMissing.length - loaded.ground);
      ground.pending = pending > 0;
      report(ground, component, pending);
    } else if (visibilityChanged) report(ground, component, 0);
    let upperReportPending: number | undefined;
    if (upperMissing !== undefined) {
      upperReportPending = Math.max(0, upperMissing.length - loaded.upper);
      upper.pending = upperReportPending > 0;
    } else if (visibilityChanged) upperReportPending = 0;
    syncUpperRows(component, camera, viewport);
    if (upperReportPending !== undefined) report(upper, component, upperReportPending);
  };

  // A Show branch can mount after the host froze this frame's callback list
  // (for example legacy -> connected-world). Populate the initial window now
  // so that branch's first paint is the same as an ordinary mounted frame.
  // Charge those loads to the first registered callback's band budgets too.
  const mountBudgetUsed: Record<WorldStreamedTerrainBand, number> = { ground: 0, upper: 0 };
  sync(0, 0, mountBudgetUsed);
  onFrame(() => {
    const groundBudgetAlreadyUsed = mountBudgetUsed.ground;
    const upperBudgetAlreadyUsed = mountBudgetUsed.upper;
    mountBudgetUsed.ground = 0;
    mountBudgetUsed.upper = 0;
    sync(groundBudgetAlreadyUsed, upperBudgetAlreadyUsed);
  });
  onCleanup(() => {
    const component = currentComponent;
    for (const state of bands) {
      clear(state);
      if (component) report(state, component, 0);
      state.pool.length = 0;
    }
    upperRows.length = 0;
    upperUsers.clear();
  });

  return (
    <>
      {ground.root as unknown as SolidJSX.Element}
      {props.below}
      {upper.root as unknown as SolidJSX.Element}
      {props.above}
    </>
  );
}
