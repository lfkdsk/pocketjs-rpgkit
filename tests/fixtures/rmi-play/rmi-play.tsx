// tests/fixtures/rmi-play/rmi-play.tsx — plays the RPG Maker test projects
// (tests/fixtures/rpgmaker) through the kit's real GameView after the
// importer (tools/rpgmaker-import) has converted them. gen-assets.ts runs
// the importer and bakes the art; games.ts holds the imported projects and
// their asset manifests. Battles use the visible placeholder rules; Name
// Input opens the kit's name-input scene.
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
import { RMI_GAMES, type RmiGameId } from "./games.ts";
import { placeholderBattleRules } from "./placeholder-battle.ts";
import { PlaceholderBattleScene } from "./placeholder-scene.tsx";

declare global {
  // eslint-disable-next-line no-var
  var __rmiGame: RmiGameId | undefined;
}

const game = RMI_GAMES[globalThis.__rmiGame ?? "hollow"];
globalThis.__rmiGame = undefined;
const AudioEffects = createAudioEffects(game.project.audio ?? {});

mount(() => (
  <GameView
    project={game.project}
    assets={game.assets}
    itemIcons={ItemIconRow}
    parallax={ParallaxLayer}
    screenPresentation={krm2ScreenPresentation}
    battle={placeholderBattleRules}
    battleScene={PlaceholderBattleScene}
    scenes={{ [NAME_INPUT_SCENE_ID]: nameInputRules }}
    sceneViews={{ [NAME_INPUT_SCENE_ID]: NameInputScene }}
    effects={AudioEffects}
  />
));
