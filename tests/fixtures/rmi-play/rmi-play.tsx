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
import { createRpgMakerFormation } from "../../../src/ui/rpgmaker-formation/index.tsx";
import type { Command, GameEvent, Project } from "../../../src/engine/types.ts";
import { RMI_GAMES, type RmiGameId } from "./games.ts";

declare global {
  // eslint-disable-next-line no-var
  var __rmiGame: RmiGameId | undefined;
  // eslint-disable-next-line no-var
  var __rmiBattlePreview: "en" | "zh" | undefined;
  // eslint-disable-next-line no-var
  var __rmiBattleScreenEffects: boolean | undefined;
  // eslint-disable-next-line no-var
  var __rmiScreenPreview: "weather" | "weather-base" | "tone" | "tone-base" | "tileset" | undefined;
  // eslint-disable-next-line no-var
  var __rmiWeatherPower: number | undefined;
}

const game = RMI_GAMES[globalThis.__rmiGame ?? "hollow"];
const preview = globalThis.__rmiBattlePreview;
const battleScreenEffects = globalThis.__rmiBattleScreenEffects === true;
const screenPreview = globalThis.__rmiScreenPreview;
const weatherPower = globalThis.__rmiWeatherPower;
globalThis.__rmiGame = undefined;
globalThis.__rmiBattlePreview = undefined;
globalThis.__rmiBattleScreenEffects = undefined;
globalThis.__rmiScreenPreview = undefined;
globalThis.__rmiWeatherPower = undefined;

function command(
  commands: readonly Command[],
  op: Command["op"],
  occurrence = 0,
): Command {
  const found = commands.filter((candidate) => candidate.op === op)[occurrence];
  if (!found) throw new Error(`rmi-play: imported command ${op}[${occurrence}] is absent`);
  return found;
}

function previewWeatherCommand(commands: readonly Command[], occurrence: number): Command {
  const found = command(commands, "weather", occurrence);
  if (weatherPower === undefined) return found;
  if (!Number.isInteger(weatherPower) || weatherPower < 0 || weatherPower > 9) {
    throw new Error(`rmi-play: invalid weather preview power ${weatherPower}`);
  }
  return found.op === "weather" ? { ...found, power: weatherPower } : found;
}

/** Keep these review scenes coupled to the imported fixture: the shortened
 * autoruns select the real lowered commands instead of spelling equivalent
 * reducer commands in the app. This makes a visual green depend on the
 * importer, cooked assets, GameView and renderer together. */
function screenPreviewProject(
  source: Project,
  kind: "weather" | "weather-base" | "tone" | "tone-base" | "tileset",
): Project {
  const map = source.maps.find((candidate) => candidate.id === "map001");
  const importedEvent = map?.events?.find((candidate) => candidate.id === "ev001");
  const importedPage = importedEvent?.pages[0];
  if (!map || !importedEvent || !importedPage) {
    throw new Error("rmi-play: screen preview source event is absent");
  }
  const imported = importedPage.commands;
  const textCommands = imported.filter((candidate) => candidate.op === "text");
  const commands: Command[] = kind === "weather"
    ? [
        previewWeatherCommand(imported, 0),
        textCommands[2]!,
        command(imported, "weather", 1),
        command(imported, "changeTileset", 0),
        command(imported, "weather", 2),
        textCommands[3]!,
        command(imported, "changeTileset", 1),
        command(imported, "weather", 3),
        command(imported, "selfSwitch", 0),
      ]
    : kind === "tone"
      ? [
        command(imported, "formationAccess", 0),
        command(imported, "windowTone", 0),
        command(imported, "screenTone", 0),
        textCommands[textCommands.length - 1]!,
        command(imported, "formationAccess", 1),
        command(imported, "selfSwitch", 0),
      ]
      : kind === "tileset"
        ? [
            // Pause on all three states so the sim can inspect the same
            // tile-image event before, during and after the imported swap.
            command(imported, "changeTileset", 1),
            textCommands[2]!,
            command(imported, "changeTileset", 0),
            textCommands[3]!,
            command(imported, "changeTileset", 1),
            textCommands[2]!,
            command(imported, "selfSwitch", 0),
          ]
        : [
          // Match the imported 30-frame wait so base/effect raster
          // comparisons observe identical map/parallax animation clocks.
          { op: "wait", seconds: 0.5 },
          kind === "weather-base" ? textCommands[2]! : textCommands[textCommands.length - 1]!,
          command(imported, "selfSwitch", 0),
        ];
  if (commands.some((entry) => entry === undefined)) {
    throw new Error(`rmi-play: ${kind} preview source text is absent`);
  }
  const previewEvent: GameEvent = {
    ...importedEvent,
    pages: [
      { ...importedPage, commands },
      importedEvent.pages[1] ?? { trigger: "action", commands: [] },
    ],
  };
  const events = kind === "tileset"
    ? [previewEvent, ...map.events!.filter((event) => event.id === "ev004")]
    : [previewEvent];
  return {
    ...source,
    start: { ...source.start, map: map.id },
    maps: source.maps.map((candidate) => candidate.id === map.id
      ? { ...candidate, events }
      : candidate),
  };
}

const previewMap = preview === undefined
  ? null
  : game.project.maps.find((map) => map.id === "map003");
const battleEffectCommands: Command[] = battleScreenEffects
  ? [
      { op: "screenTone", tone: { r: -68, g: 34, b: -17, gray: 96 }, duration: 0, wait: false },
      { op: "weather", kind: "rain", power: 3, duration: 0, wait: false },
    ]
  : [];
const battlePreviewProject = previewMap
  ? {
      ...game.project,
      start: { map: "map003", x: 10, y: 5, dir: "up" as const },
      maps: game.project.maps.map((map) => map === previewMap
        ? {
            ...map,
            events: map.events?.filter((event) => event.id === "ev002").map((event) =>
              battleScreenEffects
                ? {
                    ...event,
                    pages: event.pages.map((page, index) => index === 0
                      ? {
                          ...page,
                          commands: [
                            ...battleEffectCommands,
                            ...page.commands,
                          ],
                        }
                      : page),
                  }
                : event)
          }
        : map),
    }
  : game.project;
const project = screenPreview
  ? screenPreviewProject(battlePreviewProject, screenPreview)
  : battlePreviewProject;

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
const formation = createRpgMakerFormation();

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
    overlay={formation}
    scenes={{ [NAME_INPUT_SCENE_ID]: nameInputRules }}
    sceneViews={{ [NAME_INPUT_SCENE_ID]: NameInputScene }}
    effects={AudioEffects}
  />
));
