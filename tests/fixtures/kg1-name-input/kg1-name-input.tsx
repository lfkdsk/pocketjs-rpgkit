// tests/fixtures/kg1-name-input/kg1-name-input.tsx — sim fixture proving
// the built-in name-input scene end to end through the real GameView ->
// scene pipeline: the scene opens on frame 1 (autorun) and NameInputScene
// renders every frame straight off SessionState.scene.state.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import { NameInputScene } from "../../../src/ui/name-input/NameInputScene.tsx";
import { NAME_INPUT_SCENE_ID, nameInputRules } from "../../../src/engine/name-input.ts";
import type { Project } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { nameInputEvent, MAP, MAP_ID } from "./fixture-data.ts";

declare global {
  // eslint-disable-next-line no-var
  var __kg1NameArgs: Record<string, unknown> | undefined;
  // eslint-disable-next-line no-var
  var __kg1Attract: boolean | undefined;
}

const args = globalThis.__kg1NameArgs ?? { variable: "player.nick", default: "Hero", maxLength: 8 };
const attract = globalThis.__kg1Attract === true;
globalThis.__kg1NameArgs = undefined;
globalThis.__kg1Attract = undefined;

const project: Project = {
  format: "rpgkit-project/v1",
  title: "kg1 name input fixture",
  tileSize: 16,
  start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [{ ...MAP, events: [nameInputEvent(args)] }],
};

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    scenes={{ [NAME_INPUT_SCENE_ID]: nameInputRules }}
    sceneViews={{ [NAME_INPUT_SCENE_ID]: NameInputScene }}
    {...(attract ? { attractTape: [] } : {})}
  />
));
