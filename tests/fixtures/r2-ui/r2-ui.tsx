import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { createEffect } from "solid-js";
import {
  GameView,
  type ActorRenderStats,
  type AnimatedTilesStats,
  type BattleSceneViewProps,
  type GameWorldOverlayProps,
} from "../../../src/ui/index.ts";
import type { MapRepository, Project, ProjectShell, ProjectSource } from "../../../src/engine/types.ts";
import type { SceneRules } from "../../../src/engine/scene.ts";
import { toyBattleRules, toyState } from "../toy-battle.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { KV1_UI_PROJECT, KV2_TAPE, R2_SECOND_MAP_ID, R2_UI_PROJECT } from "./fixture-data.ts";

export interface R2UiStats {
  below?: AnimatedTilesStats;
  above?: AnimatedTilesStats;
}

export type R2ActorTrace = ActorRenderStats[];

declare global {
  // eslint-disable-next-line no-var
  var __r2UiStats: R2UiStats | undefined;
  // eslint-disable-next-line no-var
  var __r2ActorTrace: R2ActorTrace | undefined;
  // eslint-disable-next-line no-var
  var __r2Battle: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2BattleModal: boolean | undefined;
  // Test-only sequence: mount a battle, then replace it with a generic scene.
  // The trace observes the kept-alive battle renderer's active resource edge.
  // eslint-disable-next-line no-var
  var __r2BattleThenScene: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2BattleActiveTrace: boolean[] | undefined;
  // eslint-disable-next-line no-var
  var __r2TransparentBattle: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2BattleDelay: number | undefined;
  // eslint-disable-next-line no-var
  var __r2StaticBattle: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2FatalTransfer: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2Kv1: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2Kv2: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2CapRepro: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2Rewind: boolean | undefined;
  // eslint-disable-next-line no-var
  var __r2Kv2BattleGrow: boolean | undefined;
  // Test-only opt-in for the GameView world-overlay presentation slot.
  // eslint-disable-next-line no-var
  var __r2WorldOverlay: boolean | undefined;
  // Test probe: fired with the layer name on every world-layer sync frame
  // (actors / mapAnimBelow / mapAnimAbove / balloons). Silent while a scene
  // gates the world, so a test can prove the per-frame hooks paused.
  // eslint-disable-next-line no-var
  var __r2UiSyncTick: ((layer: string) => void) | undefined;
}

const stats: R2UiStats = {};
globalThis.__r2UiStats = stats;
const actorTrace = globalThis.__r2ActorTrace;
const battleModalFixture = globalThis.__r2BattleModal === true;
const battleThenSceneFixture = globalThis.__r2BattleThenScene === true;
const battleActiveTrace = globalThis.__r2BattleActiveTrace;
const transparentBattleFixture = globalThis.__r2TransparentBattle === true;
const battleFixture = globalThis.__r2Battle === true || battleModalFixture || battleThenSceneFixture;
const fatalTransferFixture = globalThis.__r2FatalTransfer === true;
// KB6 bench: keep the world steady-mounted for this many seconds before the
// autorun battle opens, so the entry frame is measured against a warm world.
const battleDelay = Math.max(0, globalThis.__r2BattleDelay ?? 0);
const staticBattleFixture = globalThis.__r2StaticBattle === true;
const kv1Fixture = globalThis.__r2Kv1 === true;
const kv2Fixture = globalThis.__r2Kv2 === true;
const capRepro = globalThis.__r2CapRepro === true;
const rewindFixture = globalThis.__r2Rewind === true;
// KV2+KB6 merge: an autorun battle whose win branch transfers to the denser
// second map, so a test can prove the actor pool grows (not rebuilds) when a
// battle closes onto a bigger map.
const battleGrowFixture = globalThis.__r2Kv2BattleGrow === true;
const worldOverlayFixture = globalThis.__r2WorldOverlay === true;
const syncTick = globalThis.__r2UiSyncTick;
globalThis.__r2UiSyncTick = undefined;
globalThis.__r2Battle = undefined;
globalThis.__r2BattleModal = undefined;
globalThis.__r2BattleThenScene = undefined;
globalThis.__r2BattleActiveTrace = undefined;
globalThis.__r2TransparentBattle = undefined;
globalThis.__r2BattleDelay = undefined;
globalThis.__r2StaticBattle = undefined;
globalThis.__r2FatalTransfer = undefined;
globalThis.__r2Kv1 = undefined;
globalThis.__r2Kv2 = undefined;
globalThis.__r2CapRepro = undefined;
globalThis.__r2Rewind = undefined;
globalThis.__r2Kv2BattleGrow = undefined;
globalThis.__r2WorldOverlay = undefined;

const project: Project = kv1Fixture
  ? KV1_UI_PROJECT
  : battleFixture
  ? {
      ...R2_UI_PROJECT,
      maps: R2_UI_PROJECT.maps.map((map, index) => index === 0
        ? {
            ...map,
            events: [
              ...(battleModalFixture ? [{
                id: "battle-modal-fixture",
                x: 2,
                y: 2,
                pages: [{
                  trigger: "parallel" as const,
                  commands: [{
                    op: "choices" as const,
                    prompt: "PARKED MAP CHOICE",
                    options: [
                      { text: "Wait here", commands: [] },
                      { text: "Keep waiting", commands: [] },
                    ],
                  }],
                }],
              }] : []),
              {
              id: "battle-scene-fixture",
              x: 1,
              y: 1,
              pages: [
                {
                  trigger: "autorun" as const,
                  commands: [
                    ...(battleDelay > 0 ? [{ op: "wait" as const, seconds: battleDelay }] : []),
                    {
                      op: "battle" as const,
                      setup: { enemyHp: 1 },
                      onWin: [{ op: "switch" as const, id: "battle-ui-won", value: true }],
                    },
                    ...(battleThenSceneFixture
                      ? [{ op: "scene" as const, id: "probe.keptAlive" }]
                      : []),
                    { op: "switch" as const, id: "battle-ui-done", value: true },
                  ],
                },
                {
                  condition: { switch: "battle-ui-done" },
                  trigger: "action" as const,
                  commands: [],
                },
              ],
              },
              ...(staticBattleFixture ? [] : map.events ?? []),
            ],
          }
        : map),
    }
  : fatalTransferFixture
    ? {
        ...R2_UI_PROJECT,
        maps: R2_UI_PROJECT.maps.map((map, index) => index === 0
          ? {
              ...map,
              events: [{
                id: "fatal-transfer",
                x: 1,
                y: 1,
                pages: [{
                  trigger: "autorun" as const,
                  commands: [{
                    op: "transfer" as const,
                    map: { variable: "missing.map" },
                    x: 1,
                    y: 1,
                  }],
                }],
              }, ...(map.events ?? [])],
            }
          : map),
      }
  : battleGrowFixture
    ? {
        ...R2_UI_PROJECT,
        maps: R2_UI_PROJECT.maps.map((map, index) => index === 0
          ? {
              ...map,
              events: [
                {
                  id: "battle-grow-fixture",
                  x: 1,
                  y: 1,
                  pages: [{
                    trigger: "autorun" as const,
                    commands: [{
                      op: "battle" as const,
                      setup: { enemyHp: 1 },
                      onWin: [{ op: "transfer" as const, map: R2_SECOND_MAP_ID, x: 5, y: 5, dir: "down" as const }],
                    }],
                  }],
                },
                ...(map.events ?? []),
              ],
            }
          : map),
      }
  : R2_UI_PROJECT;

// B1 regression: the same project served through a ProjectShell + local
// MapRepository, with a maxActors budget below the start map's event count.
// Inline projects raise the cap to their own biggest map, so only a shell
// exposes whether the start map's precached slots pass the cap check.
const capMaps = new Map(R2_UI_PROJECT.maps.map((map) => [map.id, map]));
const capIndex = R2_UI_PROJECT.maps.map((map) => ({
  id: map.id,
  width: map.width,
  height: map.height,
  entry: `maps/${map.id}.json`,
  sha256: "0000000000000000000000000000000000000000000000000000000000000000",
}));
const { maps: _maps, ...shellFields } = R2_UI_PROJECT;
const capProject: ProjectShell = { ...shellFields, mapIndex: capIndex };
const capRepository: MapRepository = {
  meta: (id) => capIndex.find((entry) => entry.id === id),
  acquire: (id) => capMaps.get(id)!,
  releaseExcept: () => {},
};
const mountedProject: ProjectSource = capRepro ? capProject : project;

function ToyBattleScene(props: BattleSceneViewProps) {
  const state = () => toyState(props.state);
  if (battleActiveTrace) {
    createEffect(() => {
      battleActiveTrace.push(props.active);
    });
  }
  return (
    <View
      class="absolute flex-col items-center justify-center"
      style={{
        posType: 1,
        insetL: 0,
        insetT: 0,
        width: props.width,
        height: props.height,
        bgColor: "#39164f",
        ...(transparentBattleFixture ? { opacity: 0.6 } : {}),
      }}
      debugName="toy-battle-scene"
    >
      <Text class="text-xl" style={{ textColor: "#ffffff", height: 28, lineHeight: 28 }}>
        TOY BATTLE
      </Text>
      <Text class="text-sm" style={{ textColor: "#ffe17a", height: 20, lineHeight: 20 }}>
        {`HP ${state().playerHp} - ${state().enemyHp}`}
      </Text>
      <Text class="text-xs" style={{ textColor: "#9ddcff", height: 16, lineHeight: 16 }}>
        {`${props.width}x${props.height}`}
      </Text>
    </View>
  );
}

const keptAliveSceneRules: SceneRules = {
  start(ext) {
    return { ext, state: { open: true } };
  },
  step(state) {
    return state;
  },
  done() {
    return null;
  },
};

function KeptAliveScene(props: BattleSceneViewProps) {
  return (
    <View
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }}
      debugName="kept-alive-game-scene"
    />
  );
}

function FixtureWorldOverlay(props: GameWorldOverlayProps) {
  return (
    <View
      class="absolute w-full h-full"
      debugName={`rpgkit-fixture-world-overlay-${props.state().mapId}`}
    />
  );
}

mount(() => (
  <GameView
    immutableState
    project={mountedProject}
    maps={capRepro ? capRepository : undefined}
    assets={capRepro ? { ...GAME_ASSETS, maxActors: 1 } : GAME_ASSETS}
    battle={toyBattleRules}
    battleScene={ToyBattleScene}
    scenes={battleThenSceneFixture ? { "probe.keptAlive": keptAliveSceneRules } : undefined}
    sceneViews={battleThenSceneFixture ? { "probe.keptAlive": KeptAliveScene } : undefined}
    worldOverlay={worldOverlayFixture ? FixtureWorldOverlay : undefined}
    attractTape={kv2Fixture ? [...KV2_TAPE] : rewindFixture ? [] : undefined}
    onAnimatedStats={(layer, value) => {
      stats[layer] = value;
    }}
    onActorStats={actorTrace
      ? (value) => actorTrace.push({
          scanned: value.scanned,
          recomputed: [...value.recomputed],
          updated: [...value.updated],
        })
      : undefined}
    onLayerSync={syncTick}
  />
));
