// tests/fixtures/text-layout/text-layout.tsx — sim fixture for the text
// command's layout fields (tests/text-layout-sim.test.ts): the real
// GameView runs the fixture's autorun texts (fixture-data.ts). fonts.json
// beside this entry bakes the cjk-text fixture's Noto Sans CJK SC subset;
// KEEPER's portrait is the ui-theme fixture's keeper face.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import type { Project } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { FACES, MAP, MAP_ID } from "./fixture-data.ts";

const project: Project = {
  format: "rpgkit-project/v1",
  title: "Text layout fixture",
  tileSize: 16,
  start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [MAP],
};

mount(() => <GameView project={project} assets={GAME_ASSETS} faces={FACES} />);
