import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { rpgMakerTextRuntime } from "../src/engine/rpgmaker-text.ts";
import type { Project } from "../src/engine/types.ts";
import type { GameViewProps } from "../src/ui/GameView.tsx";
import type { GameAssets } from "../src/ui/game-assets.ts";

// Bun's test loader does not use PocketJS's Solid transform. This test exits
// at session admission before rendering, so compile TSX with a factory that
// makes any accidental presentation work fail loudly.
Bun.plugin({
  name: "game-view-screen-capability-without-jsx",
  setup(build) {
    build.onLoad({ filter: /src\/ui\/.*\.tsx$/ }, async ({ path }) => {
      const transpiler = new Bun.Transpiler({
        loader: "tsx",
        tsconfig: {
          compilerOptions: {
            jsx: "react",
            jsxFactory: "__noJsx",
            jsxFragmentFactory: "__noJsx",
          },
        },
      });
      const code = transpiler.transformSync(await Bun.file(path).text());
      return {
        loader: "js",
        contents: `const __noJsx = () => { throw new Error("screen capability admission rendered before validation"); };\n${code}`,
      };
    });
  },
});
const { GameView } = await import("../src/ui/GameView.tsx");

const WALKER = {
  idle: ["walker.png", "walker.png", "walker.png", "walker.png"],
  walkL: ["walker.png", "walker.png", "walker.png", "walker.png"],
  walkR: ["walker.png", "walker.png", "walker.png", "walker.png"],
} as const;

const PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "screen capability UI admission",
  tileSize: 16,
  start: { map: "stage", x: 0, y: 0, dir: "down" },
  sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
  items: [],
  maps: [{
    id: "stage",
    name: "stage",
    width: 1,
    height: 1,
    sheets: ["plain"],
    ground: ["plain.0"],
    events: [{
      id: "tone",
      x: 0,
      y: 0,
      pages: [{
        trigger: "autorun",
        commands: [{
          op: "screenTone",
          tone: { r: -20, g: 10, b: 30, gray: 40 },
          duration: 1,
          wait: true,
        }],
      }],
    }],
  }],
};

const ASSETS: GameAssets = {
  ground: { stage: ["ground.png"] },
  upper: { stage: [] },
  chunkColumns: { stage: 1 },
  maxChunks: 1,
  world: { stage: { w: 16, h: 16 } },
  order: ["stage"],
  npcSrc: {},
  player: WALKER,
};

function createWithoutPresentation(attract: boolean): void {
  createRoot((dispose) => {
    try {
      const props: GameViewProps = {
        project: PROJECT,
        assets: ASSETS,
        rpgMakerText: rpgMakerTextRuntime,
        ...(attract ? { attractTape: [] } : {}),
      };
      GameView(props);
    } finally {
      dispose();
    }
  });
}

describe("GameView RPG Maker screen capability admission", () => {
  test.each([
    ["live", false],
    ["attract", true],
  ] as const)("%s session rejects an omitted screen presentation", (_name, attract) => {
    expect(() => createWithoutPresentation(attract)).toThrow(
      "RPG Maker screen: commands screenTone require the optional screenPresentation capability",
    );
  });
});
