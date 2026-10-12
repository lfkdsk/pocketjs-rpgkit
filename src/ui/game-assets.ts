// src/ui/game-assets.ts — the baked-asset manifest GameView renders a
// project with. A game's asset cooker (examples/sunstone/gen-assets.ts,
// using tools/lib/chunks.ts gameManifestSource) writes one as plain .ts
// with full string literals, so the PocketJS pak pass bakes every name.

import type { PlayerFrames } from "./PlayerSprite.tsx";

export interface StreamedGameAssets {
  /** Edge of each TILESET chunk texture (normally 256px). */
  chunkPx: number;
  /** Map id -> row-major streamed ground refs (`ui:tile.*#index`). */
  ground: Readonly<Record<string, readonly (string | null)[]>>;
  /** Map id -> row-major streamed upper refs; null chunks stay unmounted. */
  upper: Readonly<Record<string, readonly (string | null)[]>>;
  /** Map id -> chunk columns shared by ground and upper. */
  columns: Readonly<Record<string, number>>;
  /** Pixel prefetch margin around the viewport (default 16). */
  margin?: number;
  /** Texture loads per layer per frame (default unlimited). */
  loadBudget?: number;
  /** Optional tile loader for the ground and upper streams, called with a
   *  ref's key and index when a tile enters the window, in place of
   *  PocketJS loadTileTexture. It returns a texture handle the layer later
   *  frees with freeTileTexture, or -1 for nothing. Hosts that make tiles
   *  at run time (the preview page's supplied sheets) use it; baked games
   *  omit it. Render-only: never part of reducer state. */
  loadTile?: (key: string, index: number) => number;
}

/** One prepackaged eager variant of a named map layer. Switching variants
 * only rebinds image names; it never invokes the map cooker at runtime. */
export interface EagerMapLayerVariant {
  chunks: Readonly<Record<string, readonly string[]>>;
  columns: Readonly<Record<string, number>>;
}

/** One prepackaged streamed variant. All variants of a mounted layer should
 * use the same chunkPx; `sourceKey` invalidation releases/rebinds only the
 * viewport-resident textures. */
export interface StreamedMapLayerVariant {
  refs: Readonly<Record<string, readonly (string | null)[]>>;
  columns: Readonly<Record<string, number>>;
  chunkPx: number;
  margin?: number;
  loadBudget?: number;
}

export type MapLayerVariant = EagerMapLayerVariant | StreamedMapLayerVariant;

/** A stable world-space layer. `ground` and `upper` describe variants for
 * the built-in bands; `below`/`above` mount an additional band before/after
 * actors. Additional above layers are flat overlays rather than row-sliced
 * occluders. */
export interface GameMapLayerAssets {
  placement: "ground" | "upper" | "below" | "above";
  mode: "eager" | "streamed";
  defaultVariant?: string;
  defaultVisible?: boolean;
  /** Fixed eager slot capacity across every variant/map. */
  maxChunks?: number;
  variants: Readonly<Record<string, MapLayerVariant>>;
}

/** A viewport-space overlay variant, drawn over the world and below dialog.
 * It may be a translucent solid colour, a scaled image, or both. */
export interface ScreenLayerVariant {
  color?: string;
  image?: string;
  opacity?: number;
  /** Natural picture width/height in logical pixels. Numbered pictures use
   * the containing viewport dimensions when either value is omitted. */
  w?: number;
  h?: number;
}

/** One map-parallax image in logical pixels. The renderer tiles it across
 * the active map's visible viewport; the active ParallaxDef determines MV's
 * camera/scroll origin independently on each axis. */
export interface ParallaxAsset {
  image: string;
  w: number;
  h: number;
}

/** One cooked deterministic map animation. Optional offsets are the baked
 * frame canvas' top-left relative to the target tile's top-left. Their
 * absence retains the original mapAnim top-left/tall-frame anchor. */
export interface CookedMapAnimation {
  frames: readonly string[];
  w: number;
  h: number;
  offsetX?: number;
  offsetY?: number;
}

export interface GameScreenLayerAssets {
  placement: "screen";
  defaultVariant?: string;
  defaultVisible?: boolean;
  variants: Readonly<Record<string, ScreenLayerVariant>>;
}

export type GameVisualLayerAssets = GameMapLayerAssets | GameScreenLayerAssets;

/** One animated-tile placement on a map. `sprite` is the registered sprite
 *  atlas name (an entry in the app's sprites.json); its frame count and
 *  frame duration live there, so the core auto-plays the atlas and the JS
 *  side never advances a frame. Render-only: never part of reducer state. */
export interface AnimatedTile {
  /** Tile column (16px grid). */
  x: number;
  /** Tile row. */
  y: number;
  /** false = drawn under characters (just above the ground layer);
   *  true = drawn above characters (with the upper/star layer). */
  above: boolean;
  /** Registered sprite atlas name (key in sprites.json). */
  sprite: string;
}

/** Pre-cooked render sources for one runtime map-tileset identity. The
 * reducer keeps only the active tileset id; bulky chunk names and animated
 * atlas bindings stay in the immutable asset manifest. Both bands use the
 * same eager/streamed mode as the GameAssets base sources. */
export interface GameTilesetVariantAssets {
  ground: MapLayerVariant;
  upper: MapLayerVariant;
  /** Map id -> animated placements for this tileset. An explicit empty array
   * suppresses the base map's animation cells. */
  animated: Readonly<Record<string, readonly AnimatedTile[]>>;
}

/** Change Tileset is an atomic world-source change. A named generic
 * ground/upper layer may replace the ordinary baked source, but it must not
 * keep stale art mounted once a tileset variant is active while collision,
 * terrain and animated cells have already switched. */
export function tilesetLayerSource(
  tileset: Readonly<GameTilesetVariantAssets> | undefined,
  placement: "ground" | "upper",
  generic: MapLayerVariant | undefined,
): MapLayerVariant | undefined {
  return tileset?.[placement] ?? generic;
}

/** In a connected world, Change Tileset belongs to the current map rather
 * than every visible placement. Keep every neighbour on its prior source
 * and replace exactly one map entry (including an explicitly empty band). */
export function mapScopedLayerSource(
  base: Readonly<MapLayerVariant>,
  alternate: Readonly<MapLayerVariant>,
  mapId: string,
): MapLayerVariant {
  if ("chunks" in alternate) {
    if (!("chunks" in base)) throw new Error("map-scoped tileset source mode mismatch");
    return {
      chunks: { ...base.chunks, [mapId]: alternate.chunks[mapId] ?? [] },
      columns: { ...base.columns, [mapId]: alternate.columns[mapId] ?? base.columns[mapId] ?? 1 },
    };
  }
  if (!("refs" in base)) throw new Error("map-scoped tileset source mode mismatch");
  return {
    ...alternate,
    refs: { ...base.refs, [mapId]: alternate.refs[mapId] ?? [] },
    columns: { ...base.columns, [mapId]: alternate.columns[mapId] ?? base.columns[mapId] ?? 1 },
  };
}

export function mapScopedAnimatedSource(
  base: Readonly<Record<string, readonly AnimatedTile[]>> | undefined,
  alternate: Readonly<Record<string, readonly AnimatedTile[]>>,
  mapId: string,
): Readonly<Record<string, readonly AnimatedTile[]>> {
  return { ...base, [mapId]: alternate[mapId] ?? [] };
}

/** The 12 static walker frames for one character, indexed by facing
 *  (0 down, 1 left, 2 up, 3 right) and by walk pose. Frames are baked IMG
 *  entries chosen from the saved reducer facing + mover phase, never a host
 *  clock, so a restored session renders identical pixels. `h` is the frame
 *  height in pixels (16 square, or 32 for a 16x32 sheet whose extra row
 *  overflows upward and is anchored to the occupied tile's bottom). */
export interface CharacterFrames extends PlayerFrames {
  /** Frame height in px (width is always 16): 16 or 32. */
  h: 16 | 32;
}

/** How one page.sprite key is painted: a single static 16x16 image, or a
 *  twelve-frame walker (optionally 16x32). */
export type NpcArt = string | CharacterFrames;

/** Resolve a tile-image event's base page sprite against Change Tileset.
 * Character-sheet sprites and projects without a render-only variant table
 * take the single direct return path. */
export function tilesetEventSprite(
  sprite: string | null,
  tileset: string | undefined,
  variants: GameAssets["tileEventVariants"],
): string | null {
  return sprite !== null && tileset !== undefined
    ? variants?.[sprite]?.[tileset] ?? sprite
    : sprite;
}

export interface GameAssets {
  /** Map id -> row-major baked 512x512 ground chunks. */
  ground: Readonly<Record<string, readonly string[]>>;
  /** Map id -> row-major baked 512x512 star-layer chunks. */
  upper: Readonly<Record<string, readonly string[]>>;
  /** Map id -> number of chunk columns in each layer. */
  chunkColumns: Readonly<Record<string, number>>;
  /** Maximum chunk slots mounted for one map. */
  maxChunks: number;
  /** Maximum simultaneously visible NPC image slots on one map. A sharded
   * project should provide this scalar because unloaded MapDefs cannot be
   * scanned at view construction. Inline projects may omit it. */
  maxActors?: number;
  /** Map id -> map size in pixels. */
  world: Readonly<Record<string, { w: number; h: number }>>;
  /** Map ids in NPC-container mount order. */
  order: readonly string[];
  /** Page.sprite key -> static 16x16 image src or a 12-frame walker. */
  npcSrc: Readonly<Record<string, NpcArt>>;
  /** Base tile-event page sprite -> active tileset -> matching static art.
   * Optional and render-only; reducer pages keep their authored sprite. */
  tileEventVariants?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Item.sprite tile id -> cooked 16px image. Optional and presentation
   * only: inventory/shop reducer state continues to carry item ids. */
  itemSrc?: Readonly<Record<string, string>>;
  /** The player's 12 static walker frames. */
  player: PlayerFrames;
  /** Player frame height in px; 16 (square) when omitted, 32 for a 16x32
   *  walker anchored to the occupied tile's bottom. */
  playerHeight?: 16 | 32;
  /** Optional viewport-streamed map art. When present GameView does not mount
   *  the legacy eager ground/upper image grids. */
  stream?: StreamedGameAssets;
  /** Map id -> render-only animated tile placements. */
  animated?: Readonly<Record<string, readonly AnimatedTile[]>>;
  /** Tileset id -> pre-cooked map art selected by InterpState.tileset.
   * Omission keeps the pre-K-RPGM5 asset path byte-for-byte. */
  tilesetVariants?: Readonly<Record<string, GameTilesetVariantAssets>>;
  /** AnimationDef id -> cooked per-frame static images in play order. The
   *  mapAnim layer selects frames[animFrameIndex(...)] per frame from the
   *  saved reference tick; never an auto-play atlas. */
  anims?: Readonly<Record<string, CookedMapAnimation>>;
  /** Parallax image id -> immutable cooked art. Active configuration and
   * scroll phase live in InterpState, never in this render-only table. */
  parallaxes?: Readonly<Record<string, ParallaxAsset>>;
  /** Optional named runtime layers and prepackaged variants. The reducer
   * stores only {visible,variant}; these immutable assets remain render-only. */
  layers?: Readonly<Record<string, GameVisualLayerAssets>>;
}
