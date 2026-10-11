// Built-fixture visual proof for the optional RPG Maker front-view battle.
// The imported Hollow project enters a real Battle Processing command, then
// this test stops in target selection with deliberately long English and CJK
// labels. Committed goldens catch composition regressions; tree and semantic
// pixel checks keep a stable but clipped, blank, or untranslated frame from
// passing.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("rmi-play");
if (!preflight.ok) console.warn(`RPG Maker battle visual tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface TreeNode {
  n?: string;
  t?: string;
  x?: string;
  k?: TreeNode[];
}

type Rgba = readonly [number, number, number, number];

const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

const CASES = {
  en: {
    actor: "Bartholomew-the-Unyielding Guardian",
    actorHud: "Bartholomew-the-Unyielding Guardian  Lv 1  MP 66  TP 16",
    enemy: "Obsidian Golem of the Forgotten Northern Gate",
    title: "Choose a target for the ancient guardian's carefully prepared attack",
    titleRows: ["Choose a target for the ancient", "guardian's carefully prepared attack"],
    targetRows: [
      "> Obsidian Golem of the Forgotten",
      "  Northern Gate",
      "  Obsidian Golem of the Forgotten",
      "  Northern Gate",
    ],
  },
  zh: {
    actor: "守护者巴塞洛缪",
    actorHud: "守护者巴塞洛缪  级 1  法 66  怒 16",
    enemy: "北方古门的黑曜石巨像",
    title: "选择古老守护者精心准备攻击的目标",
    titleRows: ["选择古老守护者精心准备攻击的目标"],
    targetRows: ["> 北方古门的黑曜石巨像", "  北方古门的黑曜石巨像", "", ""],
  },
} as const;

function pump(world: BoundGameWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

/** The preview begins facing the Golem. Alternating confirm/release advances
 * its opening line, emergence message, Fight, Attack, then target selection. */
function enterTargetSelection(world: BoundGameWorld): void {
  for (let frame = 0; frame < 12; frame++) pump(world, frame % 2 === 0 ? BTN.CIRCLE : 0);
  expect(world.probes().state.scene).toMatchObject({
    kind: "battle",
    state: { format: "rpgmaker-battle-state/v1", phase: "target" },
  });
}

function findNode(node: TreeNode, name: string): TreeNode | null {
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return null;
}

function nodeText(node: TreeNode | null): string {
  if (!node) return "";
  if (node.t === "#text") return node.x ?? "";
  return (node.k ?? []).map(nodeText).join("");
}

function allTexts(node: TreeNode, out: string[] = []): string[] {
  if (node.t === "#text") out.push(node.x ?? "");
  for (const child of node.k ?? []) allTexts(child, out);
  return out;
}

function countColour(frame: Uint8Array, colour: Rgba): number {
  let count = 0;
  for (let at = 0; at < frame.length; at += 4) {
    if (
      frame[at] === colour[0] && frame[at + 1] === colour[1] &&
      frame[at + 2] === colour[2] && frame[at + 3] === colour[3]
    ) count++;
  }
  return count;
}

function countColourAbove(frame: Uint8Array, width: number, maxY: number, colour: Rgba): number {
  let count = 0;
  for (let y = 0; y < maxY; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (
        frame[at] === colour[0] && frame[at + 1] === colour[1] &&
        frame[at + 2] === colour[2] && frame[at + 3] === colour[3]
      ) count++;
    }
  }
  return count;
}

/** Distinct raster patterns across fixed-width CJK cells. Repeated tofu
 * boxes produce one pattern; real glyphs produce many. */
function distinctCellPatterns(
  frame: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  cells: number,
): number {
  const hashes = new Set<number>();
  for (let cell = 0; cell < cells; cell++) {
    let hash = 0x811c9dc5;
    for (let y = y0; y < y0 + 14; y++) {
      for (let x = x0 + cell * 12; x < x0 + (cell + 1) * 12; x++) {
        const at = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          hash ^= frame[at + channel]!;
          hash = Math.imul(hash, 0x01000193);
        }
      }
    }
    hashes.add(hash >>> 0);
  }
  return hashes.size;
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 4;
  return [...frame.subarray(at, at + 4)];
}

async function golden(
  name: string,
  frame: Uint8Array,
  width: number,
  height: number,
): Promise<void> {
  const url = new URL(`./goldens/rpgmaker-battle.${name}.${width}x${height}.png`, import.meta.url);
  if (process.env.RPGMAKER_BATTLE_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(frame, width, height));
  }
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect([expected.width, expected.height]).toEqual([width, height]);
  expect(frame).toEqual(expected.rgba);
}

simDescribe("RPG Maker front-view battle visuals", () => {
  for (const [language, copy] of Object.entries(CASES) as [keyof typeof CASES, (typeof CASES)[keyof typeof CASES]][]) {
    for (const viewport of VIEWPORTS) {
      test(`${language} target selection is complete at ${viewport.width}x${viewport.height}`, async () => {
        const world = await bootGameWorld(
          appBundle("rmi-play"),
          60,
          { __rmiGame: "hollow", __rmiBattlePreview: language },
          undefined,
          viewport,
        );
        enterTargetSelection(world);

        const tree = world.getTree() as TreeNode;
        const battle = findNode(tree, "rpgmaker-battle-scene");
        expect(battle).not.toBeNull();
        expect(nodeText(findNode(tree, "rpgmaker-enemy-name-0"))).toBe(copy.enemy);
        expect(nodeText(findNode(tree, "rpgmaker-enemy-name-1"))).toBe(copy.enemy);
        expect(nodeText(findNode(tree, "rpgmaker-actor-name-0"))).toBe(copy.actorHud);

        const titleRows = copy.titleRows.map((_, row) =>
          nodeText(findNode(tree, `rpgmaker-target-menu-title${row === 0 ? "" : `-${row}`}`)));
        expect(titleRows).toEqual([...copy.titleRows]);
        expect(titleRows.join(language === "en" ? " " : "")).toBe(copy.title);
        const targetRows = [0, 1, 2, 3].map((row) =>
          nodeText(findNode(tree, `rpgmaker-target-menu-row-${row}`)));
        expect(targetRows).toEqual([...copy.targetRows]);

        const battleText = allTexts(battle!);
        expect(battleText.join("\n")).not.toContain("…");
        expect(battleText.join("\n")).not.toContain("�");
        expect(battleText.filter((text) => text.includes(copy.actor)).length).toBe(1);
        expect(battleText.filter((text) => text.includes(copy.enemy)).length).toBeGreaterThanOrEqual(2);

        const frame = world.render().slice();
        // Exact palette classes prove the backdrop, arena floor, target
        // window, selected target, enemy HP, and actor HP are all painted.
        expect(rgbaAt(frame, viewport.width, 2, 2)).toEqual([0x16, 0x25, 0x36, 0xff]);
        expect(rgbaAt(frame, viewport.width, 2, Math.floor(viewport.height / 2)))
          .toEqual([0x24, 0x39, 0x4a, 0xff]);
        expect(countColour(frame, [0x0b, 0x16, 0x26, 0xff]), "target window paper").toBeGreaterThan(13_000);
        expect(countColour(frame, [0x5d, 0x7f, 0xa3, 0xff]), "target window frame").toBeGreaterThan(1_100);
        expect(countColour(frame, [0xff, 0xe9, 0x7a, 0xff]), "selected target and actor HP").toBeGreaterThan(1_200);
        expect(countColour(frame, [0xe8, 0x5d, 0x75, 0xff]), "enemy HP bars").toBeGreaterThan(700);
        expect(
          countColourAbove(frame, viewport.width, Math.floor(viewport.height * 0.55), [0xff, 0xff, 0xff, 0xff]),
          "both enemy name marquees paint above the target window",
        ).toBeGreaterThan(40);
        if (language === "zh") {
          // The one-row title begins four pixels inside the 236 px panel,
          // which is inset eight pixels from the right and bottom.
          expect(
            distinctCellPatterns(frame, viewport.width, viewport.width - 240, viewport.height - 82, 15),
            "Chinese title uses distinct glyphs instead of repeated tofu boxes",
          ).toBeGreaterThan(10);
        }

        await golden(language, frame, viewport.width, viewport.height);
      }, 60_000);
    }
  }
});
