import { mount } from "@pocketjs/framework";
import { loadTileTexture } from "../../../vendor/pocketjs/framework/src/tiles.ts";
import { onCleanup, onMount, type Component } from "solid-js";
import {
  GameView,
  type AnimatedTilesStats,
  type GameViewOverlayConfig,
} from "../../../src/ui/index.ts";
import { createSessionSnapshot } from "../../../src/engine/save.ts";
import { loadIntoView } from "../../../src/ui/session-saves.ts";
import {
  createWorldRenderer,
  WorldStreamedTerrain,
  type GameViewWorldConfig,
  type GameViewWorldRenderProps,
  type WorldStreamedTerrainStats,
} from "../../../src/ui/world/index.ts";
import type { WorldComponent } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { WORLD_STREAMED_PROJECT } from "./fixture-data.ts";

export interface WorldStreamedFixtureStats {
  ground?: WorldStreamedTerrainStats;
  upper?: WorldStreamedTerrainStats;
  below?: AnimatedTilesStats;
  above?: AnimatedTilesStats;
  worldView: { mounts: number; unmounts: number };
}

export interface WorldStreamedTransitionApi {
  /** Queue one or more save-backed map replacements for the next host frame. */
  transition(...mapIds: string[]): void;
  loads: number;
  error: string | null;
}

export interface WorldStreamedTileLoads {
  ground: number;
  upper: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __worldStreamedCamera: { x: number; y: number } | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedStats: WorldStreamedFixtureStats | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedPreFrameCleanupReads: number | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedInitialMap: string | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedLegacy: boolean | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedTransition: WorldStreamedTransitionApi | undefined;
  // eslint-disable-next-line no-var
  var __worldStreamedTileLoads: WorldStreamedTileLoads | undefined;
}

// Regression probe: disposing the terrain subtree before its first frame must
// not re-read a parent accessor that has already become invalid.
let cleanupComponent: WorldComponent | undefined = WORLD_STREAMED_PROJECT.worldLayout!.components[0]!;
let cleanupReads = 0;
const disposeCleanupProbe = mount(() => (
  <WorldStreamedTerrain
    activeMapId={() => "a-northwest"}
    component={() => {
      cleanupReads++;
      return cleanupComponent!;
    }}
    visiblePlacements={() => []}
    camera={() => ({ x: 0, y: 0 })}
    viewport={() => ({ w: 480, h: 272 })}
    chunkPx={256}
    active={() => false}
    ground={{ refs: () => ({}), columns: () => ({}) }}
    upper={{ refs: () => ({}), columns: () => ({}) }}
    onStats={() => {}}
  />
));
cleanupComponent = undefined;
disposeCleanupProbe();
globalThis.__worldStreamedPreFrameCleanupReads = cleanupReads;

const stats: WorldStreamedFixtureStats = { worldView: { mounts: 0, unmounts: 0 } };
globalThis.__worldStreamedStats = stats;
const tileLoads: WorldStreamedTileLoads = { ground: 0, upper: 0 };
globalThis.__worldStreamedTileLoads = tileLoads;
const trackedAssets = {
  ...GAME_ASSETS,
  stream: {
    ...GAME_ASSETS.stream!,
    loadTile(key: string, index: number): number {
      tileLoads[key.includes("-upper") ? "upper" : "ground"]++;
      return loadTileTexture(key, index);
    },
  },
};

function trackedWorldRenderer(): GameViewWorldConfig {
  const factory = createWorldRenderer();
  return {
    create(host) {
      const runtime = factory.create(host);
      const BaseView = runtime.View;
      const TrackedView: Component<GameViewWorldRenderProps> = (props) => {
        onMount(() => { stats.worldView.mounts++; });
        onCleanup(() => { stats.worldView.unmounts++; });
        return <BaseView {...props} />;
      };
      return { ...runtime, View: TrackedView };
    },
  };
}

let queuedMaps: string[] = [];
const transitionApi: WorldStreamedTransitionApi = {
  transition(...mapIds) {
    queuedMaps = [...mapIds];
  },
  loads: 0,
  error: null,
};
globalThis.__worldStreamedTransition = transitionApi;

function transitionTo(
  host: Parameters<GameViewOverlayConfig["create"]>[0],
  mapId: string,
): boolean {
  const snapshot = createSessionSnapshot(host.session, host.getState(), host.heldButtons());
  snapshot.map = mapId;
  snapshot.player = {
    ...snapshot.player,
    tx: 1,
    ty: 1,
    px: 16,
    py: 16,
    facing: 0,
    phase: 0,
    moving: false,
    walking: false,
    stepDir: 0,
  };
  delete snapshot.mapRuntime;
  const loaded = loadIntoView(host, snapshot);
  if (!loaded.ok) {
    transitionApi.error = loaded.error.code;
    return false;
  }
  transitionApi.loads++;
  return true;
}

const transitions: GameViewOverlayConfig = {
  create(host) {
    const initialMap = globalThis.__worldStreamedInitialMap;
    globalThis.__worldStreamedInitialMap = undefined;
    if (initialMap) transitionTo(host, initialMap);
    return {
      step() {
        if (queuedMaps.length === 0) return { consumed: false };
        const maps = queuedMaps;
        queuedMaps = [];
        let changed = false;
        for (const mapId of maps) changed = transitionTo(host, mapId) || changed;
        return { consumed: true, stateChanged: changed };
      },
      isOpen: () => false,
      render: () => null,
    };
  },
};

const world = globalThis.__worldStreamedLegacy ? undefined : trackedWorldRenderer();
globalThis.__worldStreamedLegacy = undefined;

mount(() => (
  <GameView
    project={WORLD_STREAMED_PROJECT}
    assets={trackedAssets}
    world={world}
    overlay={transitions}
    debugWorldCamera={() => globalThis.__worldStreamedCamera}
    onStreamStats={(layer, value) => { stats[layer] = value as WorldStreamedTerrainStats; }}
    onAnimatedStats={(layer, value) => { stats[layer] = value; }}
  />
));
