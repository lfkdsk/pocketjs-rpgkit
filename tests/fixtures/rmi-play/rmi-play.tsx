// tests/fixtures/rmi-play/rmi-play.tsx — plays the RPG Maker test projects
// (tests/fixtures/rpgmaker) through the kit's real GameView after the
// importer (tools/rpgmaker-import) has converted them. gen-assets.ts runs
// the importer and bakes the art; games.ts holds the imported projects and
// their asset manifests. Battles use the opt-in RPG Maker reducer and
// front-view scene; Name Input opens the kit's name-input scene.
//
// The sim test picks the game with globalThis.__rmiGame ("hollow" or
// "stage", default "hollow") before boot.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import { createAudioEffects } from "../../../src/ui/audio/index.ts";
import { ItemIconRow } from "../../../src/ui/ItemIconRow.tsx";
import { ParallaxLayer } from "../../../src/ui/ParallaxLayer.tsx";
import { krm2ScreenPresentation } from "../../../src/ui/krm2/index.ts";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../../../src/engine/name-input.ts";
import { NameInputScene } from "../../../src/ui/name-input/NameInputScene.tsx";
import {
  createRpgMakerBattleExtensions,
  createRpgMakerBattleRules,
} from "../../../src/rpgmaker-battle/index.ts";
import { createRpgMakerBattleScene } from "../../../src/ui/rpgmaker-battle/index.tsx";
import { RMI_GAMES, type RmiGameId } from "./games.ts";

declare global {
  // eslint-disable-next-line no-var
  var __rmiGame: RmiGameId | undefined;
}

const game = RMI_GAMES[globalThis.__rmiGame ?? "hollow"];
globalThis.__rmiGame = undefined;
const AudioEffects = createAudioEffects(game.project.audio ?? {});
const battle = createRpgMakerBattleRules(game.battle);
const BattleScene = createRpgMakerBattleScene(game.battle, { enemyImages: game.enemyImages });

mount(() => (
  <GameView
    project={game.project}
    assets={game.assets}
    itemIcons={ItemIconRow}
    parallax={ParallaxLayer}
    screenPresentation={krm2ScreenPresentation}
    extensions={createRpgMakerBattleExtensions(game.battle)}
    battle={battle}
    battleScene={BattleScene}
    scenes={{ [NAME_INPUT_SCENE_ID]: nameInputRules }}
    sceneViews={{ [NAME_INPUT_SCENE_ID]: NameInputScene }}
    effects={AudioEffects}
  />
));
