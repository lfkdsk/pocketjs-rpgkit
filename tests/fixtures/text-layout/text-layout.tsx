// tests/fixtures/text-layout/text-layout.tsx — sim fixture for the text
// command's layout fields (tests/text-layout-sim.test.ts): the real
// GameView runs the fixture's autorun texts (fixture-data.ts). fonts.json
// beside this entry bakes the cjk-text fixture's Noto Sans CJK SC subset;
// KEEPER's portrait is the ui-theme fixture's keeper face.

import { mount } from "@pocketjs/framework";
import { GameView } from "../../../src/ui/GameView.tsx";
import { rpgMakerTextRuntime } from "../../../src/engine/rpgmaker-text.ts";
import { rpgMakerChoiceTextRuntime } from "../../../src/ui/ChoiceColourLine.tsx";
import type { Project } from "../../../src/engine/types.ts";
import { GAME_ASSETS } from "./assets-game.ts";
import { FACES, MAP, MAP_ID } from "./fixture-data.ts";
import { RPG_MAKER_LAYOUT_MAP } from "./rpgmaker-layout-preview.ts";

const mzLayoutPreview = (globalThis as typeof globalThis & {
  __rpgMakerLayoutPreview?: boolean;
}).__rpgMakerLayoutPreview === true;

const project: Project = {
  format: "rpgkit-project/v1",
  title: mzLayoutPreview ? "MZ layout render fixture" : "Text layout fixture",
  tileSize: 16,
  start: { map: mzLayoutPreview ? RPG_MAKER_LAYOUT_MAP.id : MAP_ID, x: 1, y: 1, dir: "down" },
  ...(mzLayoutPreview ? {
    system: {
      rpgMakerText: {
        party: [],
        currencyUnit: "G",
        colours: ["#FFFFFF", "#EA4A5A", "#4AD98B", "#5598E8"],
      },
    },
  } : {}),
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [mzLayoutPreview ? RPG_MAKER_LAYOUT_MAP : MAP],
};

mount(() => (
  <GameView
    project={project}
    assets={GAME_ASSETS}
    faces={FACES}
    rpgMakerText={mzLayoutPreview ? rpgMakerTextRuntime : undefined}
    choiceText={mzLayoutPreview ? rpgMakerChoiceTextRuntime : undefined}
  />
));
