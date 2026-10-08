import { mount } from "@pocketjs/framework";
import { GameView, type MapAnimStats } from "../../../src/ui/index.ts";
import type { GameAssets } from "../../../src/ui/game-assets.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { KA1_PROJECT, KS1_PERSIST_PROJECT, KS1_PROJECT } from "./fixture-data.ts";

export interface Ka1Stats {
  below?: MapAnimStats;
  above?: MapAnimStats;
}

declare global {
  // eslint-disable-next-line no-var
  var __ka1Stats: Ka1Stats | undefined;
  // eslint-disable-next-line no-var
  var __ka1Ks1: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ka1Persist: boolean | undefined;
}

const stats: Ka1Stats = {};
globalThis.__ka1Stats = stats;
const persistFixture = globalThis.__ka1Persist === true;
globalThis.__ka1Persist = undefined;
const ks1Fixture = globalThis.__ka1Ks1 === true;
globalThis.__ka1Ks1 = undefined;

const KS1_ASSETS: GameAssets = {
  ...GAME_ASSETS,
  playerHeight: 32,
  layers: {
    cutscene: {
      placement: "screen",
      variants: { blue: { color: "#184070" }, red: { color: "#701818" } },
    },
  },
};

mount(() => (
  <GameView
    project={persistFixture ? KS1_PERSIST_PROJECT : ks1Fixture ? KS1_PROJECT : KA1_PROJECT}
    assets={persistFixture || ks1Fixture ? KS1_ASSETS : GAME_ASSETS}
    onMapAnimStats={(layer, value) => {
      stats[layer] = value;
    }}
  />
));
