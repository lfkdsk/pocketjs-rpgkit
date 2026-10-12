// Render-level proof for DialogBox's MZ PX/PY/FS branch. The existing text
// layout fixture opens a synthetic RPG Maker message through the real
// interpreter and GameView, then PocketJS's deterministic renderer produces
// the committed frame. Tree and semantic pixel assertions ensure a stable
// but fallback-row, misplaced, same-size, or blank rendering cannot pass.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import type { TextModal } from "../src/engine/interpreter.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("text-layout");
if (!preflight.ok) console.warn(`RPG Maker text layout visual tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

const RUN_COLOURS = {
  base: "#EA4A5A",
  right: "#4AD98B",
  big: "#5598E8",
} as const;

interface TreeNode {
  n?: string;
  t?: string;
  x?: string;
  k?: TreeNode[];
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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

function rgb(colour: string): readonly [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16)) as unknown as readonly [number, number, number];
}

function colourBounds(
  frame: Uint8Array,
  width: number,
  colour: string,
  within: Rect,
): Rect | null {
  const [r, g, b] = rgb(colour);
  let bounds: Rect | null = null;
  for (let y = within.y0; y < within.y1; y++) {
    for (let x = within.x0; x < within.x1; x++) {
      const at = (y * width + x) * 4;
      if (frame[at] !== r || frame[at + 1] !== g || frame[at + 2] !== b || frame[at + 3] !== 0xff) continue;
      if (!bounds) bounds = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
      else {
        bounds.x0 = Math.min(bounds.x0, x);
        bounds.y0 = Math.min(bounds.y0, y);
        bounds.x1 = Math.max(bounds.x1, x + 1);
        bounds.y1 = Math.max(bounds.y1, y + 1);
      }
    }
  }
  return bounds;
}

function pump(world: BoundGameWorld): void {
  world.frame(0, 0x8080);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function settleMessage(world: BoundGameWorld): TextModal {
  for (let frame = 0; frame < 120; frame++) {
    const modal = world.probes().state.interp.modal;
    if (modal?.kind === "text" && modal.complete) return modal;
    pump(world);
  }
  throw new Error("MZ layout preview did not complete its message");
}

async function golden(frame: Uint8Array, width: number, height: number): Promise<void> {
  const url = new URL(`./goldens/rpgmaker-mz-text-layout.${width}x${height}.png`, import.meta.url);
  if (process.env.RPGMAKER_TEXT_LAYOUT_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(frame, width, height));
  }
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect([expected.width, expected.height]).toEqual([width, height]);
  expect(frame).toEqual(expected.rgba);
}

simDescribe("RPG Maker MZ text layout visuals", () => {
  for (const viewport of VIEWPORTS) {
    test(`renders PX/PY/FS as positioned, differently sized runs at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("text-layout"),
        60,
        { __rpgMakerLayoutPreview: true },
        undefined,
        viewport,
      );
      const modal = settleMessage(world);
      expect(modal.lines).toEqual(["BASERIGHTBIG"]);
      expect(modal.rpgMakerLayout).toEqual([
        { at: 4, x: 130 },
        { at: 9, y: 78, fontSize: 52, x: 52 },
      ]);

      const tree = world.getTree() as TreeNode;
      const layout = findNode(tree, "rpgkit-message-mz-layout");
      expect(layout, "DialogBox takes the MZ positioned-run branch").not.toBeNull();
      expect(nodeText(layout)).toBe("BASERIGHTBIG");
      expect(findNode(tree, "rpgkit-message-row-0"), "fallback fixed rows stay unmounted").toBeNull();

      const frame = world.render().slice();
      const messageArea = {
        x0: 8,
        y0: viewport.height - 120,
        x1: viewport.width - 8,
        y1: viewport.height,
      };
      const base = colourBounds(frame, viewport.width, RUN_COLOURS.base, messageArea);
      const right = colourBounds(frame, viewport.width, RUN_COLOURS.right, messageArea);
      const big = colourBounds(frame, viewport.width, RUN_COLOURS.big, messageArea);
      expect(base, "BASE run paints in its authored colour").not.toBeNull();
      expect(right, "RIGHT run paints in its authored colour").not.toBeNull();
      expect(big, "BIG run paints in its authored colour").not.toBeNull();
      if (!base || !right || !big) throw new Error("one or more MZ text runs did not paint");

      // PX[130] scales to 60 kit pixels, while the first run stays at x=0.
      // Font bearings may move the first coloured pixel by a few pixels.
      expect(right.x0 - base.x0, "PX moves RIGHT away from BASE").toBeGreaterThanOrEqual(55);
      expect(Math.abs(right.y0 - base.y0), "PX does not change the baseline").toBeLessThanOrEqual(1);
      // The second PX[52] scales to 24 px, putting BIG between BASE and
      // RIGHT even though it follows RIGHT in the source string.
      expect(big.x0, "the later absolute PX moves BIG back left").toBeGreaterThan(base.x0);
      expect(big.x0, "the later absolute PX moves BIG back left").toBeLessThan(right.x0);
      // PY[78] scales to 36 px and FS[52] selects the 24 px font atlas.
      expect(big.y0 - base.y0, "PY moves BIG to the lower authored row").toBeGreaterThanOrEqual(34);
      expect(big.y1 - big.y0, "FS paints visibly taller glyphs").toBeGreaterThan((base.y1 - base.y0) * 1.5);

      // The lower 27 px line ends three pixels beyond the legacy 60 px text
      // area. DialogBox must grow the bottom-docked, 8 px-inset window upward
      // to 95 px rather than clipping BIG.
      const border = colourBounds(frame, viewport.width, DEFAULT_UI_THEME.border, messageArea);
      expect(border, "message frame paints around the positioned runs").toEqual({
        x0: 8,
        y0: viewport.height - 103,
        x1: viewport.width - 8,
        y1: viewport.height - 8,
      });

      await golden(frame, viewport.width, viewport.height);
    }, 60_000);
  }
});
