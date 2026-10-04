// Type-only seam between the base GameView and the optional connected-world
// renderer. The concrete renderer lives behind `pocket-rpgkit/ui/world`, so a
// game that does not import and pass it cannot pull that implementation into
// its bundle.
//
// Coordinate spaces — the one contract every world consumer shares:
//
//   map-local      origin at the active map's top-left tile. `state.move`
//                  (tx/ty/px/py), the legacy single-map camera and every
//                  per-map layer coordinate live here.
//
//   component-world  origin at the connected component's signed world origin.
//                  `WorldPlacement.originTileX/Y`, `WorldComponent.bounds`,
//                  `visibleMaps`/`workingSet` rects and the camera returned by
//                  `GameViewWorldRuntime.cameraFor` live here.
//
//   world = local + placement.origin   (pixels: origin * tileSize)
//   local = world - placement.origin
//
// GameView is the single place that converts between the two: it presents a
// component-world camera to the world renderer and to the cache driver
// (`WorldCacheDriver.sync`). The active map's own extra layers receive a
// map-local camera (via `localCameraFor`); actors receive the component-
// world camera and are translated by the shared `worldNode`. Both sit inside
// the renderer's `ActiveMapPlane`, which adds the active placement's origin,
// so neither band adds the origin itself. A consumer that receives a
// component-world camera must never add the placement origin again.

import type { Accessor, Component, JSX } from "solid-js";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import type { SessionState } from "../engine/session.ts";
import type {
  CameraState,
  CommonEvent,
  MapDef,
  SpriteDef,
  WorldLayout,
  WorldPreviewRejectReason,
} from "../engine/types.ts";
import type { WorldHandoffResolver } from "../engine/world-handoff-contract.ts";
import type { AnimatedTilesStats } from "./AnimatedTiles.tsx";
import type { StreamedChunkLayerStats } from "./StreamedChunkLayer.tsx";
import type { AnimatedTile, GameAssets, StreamedGameAssets } from "./game-assets.ts";

export type GameViewWorldBand = "ground" | "upper";

export interface GameViewWorldViewport {
  w: number;
  h: number;
}

export interface GameViewWorldBandSource {
  refs: Accessor<Readonly<Record<string, readonly (string | null)[]>>>;
  columns: Accessor<Readonly<Record<string, number>>>;
  sourceKey: Accessor<string>;
  visible: Accessor<boolean>;
  margin: Accessor<number | undefined>;
  loadBudget: Accessor<number | undefined>;
}

/** Reported after every repaint of the preview layer. */
export interface WorldNpcPreviewStats {
  /** The active (simulated) map, never previewed. */
  activeMapId: string;
  /** Visible non-active maps that were painted (entry preview or frozen
   * snapshot), in placement order. */
  maps: readonly string[];
  /** Visible non-active maps whose MapDef was not resident yet. */
  unavailable: readonly string[];
  /** The visible map painted from the frozen snapshot of the map the last
   * seamless handoff left (`SessionState.leftMap`), or null. */
  frozen: string | null;
  /** Painted preview characters (`front` + `behind`). */
  painted: number;
  /** Painted characters ordered behind / in front of the active map's actors. */
  behind: number;
  front: number;
  /** Event ids painted, as `mapId/eventId`, in paint order: the behind band
   * then the front band, each by world (y, x) depth. */
  actors: readonly string[];
  /** Entry-preview rejections and hidden events (the frozen map has none). */
  rejected: number;
  hidden: number;
  reasons: Readonly<Record<WorldPreviewRejectReason, number>>;
  /** Image nodes owned by the layer; grows to the high-water mark only. */
  pooled: number;
}

/** Read-only inputs for the neighbour-map character preview. `map` must only
 * look up already-resident MapDefs; it never acquires or loads a map. */
export interface GameViewWorldPreviewSource {
  state: Accessor<SessionState>;
  map(mapId: string): Readonly<MapDef> | undefined;
  commonEvents: readonly CommonEvent[];
  sprites: Readonly<Record<string, SpriteDef>>;
  npcSrc: GameAssets["npcSrc"];
  active: Accessor<boolean>;
  onStats?: (stats: WorldNpcPreviewStats) => void;
}

/** Read-only values and map-local slots supplied by GameView to an opted-in
 * connected-world renderer. The renderer owns only presentation state. */
export interface GameViewWorldRenderProps {
  activeMapId: Accessor<string>;
  camera: Accessor<CameraState>;
  viewport: Accessor<GameViewWorldViewport>;
  active: Accessor<boolean>;
  stream: StreamedGameAssets;
  animated?: Readonly<Record<string, readonly AnimatedTile[]>>;
  ground: GameViewWorldBandSource;
  upper: GameViewWorldBandSource;
  below?: JSX.Element;
  actors?: JSX.Element;
  above?: JSX.Element;
  actorHost?: (node: NodeMirror) => void;
  /** Inputs for the read-only character preview of visible neighbour maps. */
  preview?: GameViewWorldPreviewSource;
  onStreamStats?: (layer: GameViewWorldBand, stats: StreamedChunkLayerStats) => void;
  onAnimatedStats?: (layer: "below" | "above", stats: AnimatedTilesStats) => void;
}

export interface GameViewWorldFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One GameView-local renderer instance created by an opt-in factory. */
export interface GameViewWorldRuntime {
  readonly View: Component<GameViewWorldRenderProps>;
  /** Pure opening resolver paired with this renderer's immutable layout. */
  readonly handoff: WorldHandoffResolver;
  /** Whether View owns this map. A renderer may include isolated maps that
   * are absent from the connected layout in order to preserve one subtree. */
  hasMap(mapId: string): boolean;
  frameFor(mapId: string, viewport: Readonly<GameViewWorldViewport>): GameViewWorldFrame | undefined;
  cameraFor(
    state: Readonly<SessionState>,
    viewport: Readonly<GameViewWorldViewport>,
  ): CameraState | undefined;
  localCameraFor(mapId: string, camera: Readonly<CameraState>): CameraState | undefined;
}

export interface GameViewWorldFactoryHost {
  readonly layout: Readonly<WorldLayout>;
  readonly tileSize: number;
  readonly debugCamera?: () => { x: number; y: number } | undefined;
}

/** Passed explicitly to GameView by games that want connected-world
 * rendering. Keeping this factory type-only makes the default renderer path
 * unable to reach the concrete world modules. */
export interface GameViewWorldConfig {
  create(host: GameViewWorldFactoryHost): GameViewWorldRuntime;
}
