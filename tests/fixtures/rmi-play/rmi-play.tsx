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
  // eslint-disable-next-line no-var
  var __rmiBattlePreview: "en" | "zh" | undefined;
}

const game = RMI_GAMES[globalThis.__rmiGame ?? "hollow"];
const preview = globalThis.__rmiBattlePreview;
globalThis.__rmiGame = undefined;
globalThis.__rmiBattlePreview = undefined;

const previewMap = preview === undefined
  ? null
  : game.project.maps.find((map) => map.id === "map003");
const project = previewMap
  ? {
      ...game.project,
      start: { map: "map003", x: 10, y: 5, dir: "up" as const },
      maps: game.project.maps.map((map) => map === previewMap
        ? { ...map, events: map.events?.filter((event) => event.id === "ev002") }
        : map),
    }
  : game.project;

const longNames = preview === "zh"
  ? { actor: "守护者巴塞洛缪", enemy: "北方古门的黑曜石巨像" }
  : { actor: "Bartholomew-the-Unyielding Guardian", enemy: "Obsidian Golem of the Forgotten Northern Gate" };
const database = preview === undefined
  ? game.battle
  : {
      ...game.battle,
      actors: game.battle.actors.map((actor, index) => index === 0 ? { ...actor, name: longNames.actor } : actor),
      enemies: game.battle.enemies.map((enemy, index) => index === 0 ? { ...enemy, name: longNames.enemy } : enemy),
      troops: game.battle.troops.map((troop, index) => index === 0
        ? { ...troop, members: [
            { ...troop.members[0]!, x: 170 },
            { ...troop.members[0]!, x: 310 },
          ] }
        : troop),
      ...(preview === "zh" ? {
        terms: {
          ...game.battle.terms,
          basic: {
            ...game.battle.terms.basic,
            level: "等级",
            levelAbbr: "级",
            mp: "法力",
            mpAbbr: "法",
            tp: "怒气",
            tpAbbr: "怒",
            exp: "经验",
            expAbbr: "经验",
          },
          messages: {
            ...game.battle.terms.messages,
            actionFailure: "%1没有受到影响！",
            actorDamage: "%1受到了%2点伤害！",
            enemyDamage: "%1受到了%2点伤害！",
            actorRecovery: "%1恢复了%2点%3！",
            enemyRecovery: "%1恢复了%2点%3！",
            actorLoss: "%1失去了%2点%3！",
            enemyLoss: "%1失去了%2点%3！",
            actorNoDamage: "%1没有受到伤害！",
            enemyNoDamage: "%1没有受到伤害！",
            actorNoHit: "没有命中%1！",
            enemyNoHit: "没有命中%1！",
            actorEvasion: "%1避开了攻击！",
            enemyEvasion: "%1避开了攻击！",
            actorMagicEvasion: "%1化解了法术！",
            enemyMagicEvasion: "%1化解了法术！",
            criticalToActor: "猛烈的一击！",
            criticalToEnemy: "漂亮的一击！",
            useItem: "%1使用了%2！",
            emerge: "%1出现了！",
            escapeStart: "%1开始撤退！",
            escapeFailure: "但是没有成功！",
            victory: "%1获得了胜利！",
            defeat: "%1被击败了。",
            obtainExp: "获得%1点%2！",
            obtainGold: "找到了%1\\G！",
            obtainItem: "找到了%1！",
            levelUp: "%1升到了%2%3！",
          },
        },
      } : {}),
    };
const battleText = preview === "zh"
  ? { ok: "确定", target: "选择古老守护者精心准备攻击的目标", party: "队伍" }
  : preview === "en"
    ? { ok: "Confirm", target: "Choose a target for the ancient guardian's carefully prepared attack", party: "Party" }
    : undefined;

const AudioEffects = createAudioEffects(project.audio ?? {});
const battle = createRpgMakerBattleRules(database);
const BattleScene = createRpgMakerBattleScene(database, { enemyImages: game.enemyImages, text: battleText });

mount(() => (
  <GameView
    project={project}
    assets={game.assets}
    itemIcons={ItemIconRow}
    parallax={ParallaxLayer}
    screenPresentation={krm2ScreenPresentation}
    extensions={createRpgMakerBattleExtensions(database)}
    battle={battle}
    battleScene={BattleScene}
    scenes={{ [NAME_INPUT_SCENE_ID]: nameInputRules }}
    sceneViews={{ [NAME_INPUT_SCENE_ID]: NameInputScene }}
    effects={AudioEffects}
  />
));
