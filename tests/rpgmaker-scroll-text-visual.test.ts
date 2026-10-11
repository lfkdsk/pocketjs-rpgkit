// Rendered evidence for RPG Maker Show Scrolling Text. The isolated r2-ui
// fixture opens a long, coloured block immediately and advances it by an
// exact accelerated reference-tick count. Committed 1x and 2x PNGs pin the
// clipped full-screen presentation and its transparent map backdrop.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { ScrollTextModal } from "../src/engine/interpreter.ts";
import { SCROLL_TEXT_ROW_HEIGHT } from "../src/ui/scroll-text.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`RPG Maker scrolling-text visual tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const TARGETS = [
  { width: 480, height: 272, scale: 1 },
  { width: 960, height: 544, scale: 2 },
] as const;
const TOP_BAND = "TOP EDGE — CORAL BAND — TOP EDGE";
const BOTTOM_BAND = "BOTTOM EDGE — BLUE BAND — BOTTOM EDGE";
const LONG_CJK =
  "长卷逐字排版不丢失，𠮷野春风吹过山川河流，灯火照亮归途，旅人记下每一段故事。".repeat(4);
const EXPECTED_LINES = [
  "SCROLLING TEXT VISUAL — clipped prelude",
  TOP_BAND,
  "02  The map remains visible through this layer",
  "03  Continuous credits cross the whole screen",
  "04  Every authored row keeps its place",
  "05  Half-pixel travel remains deterministic",
  "06  The camera waits beneath the transparent text",
  "07  Checker ground remains crisp",
  "08  Colour escapes survive wrapping",
  "09  Reference ticks own the motion",
  "10  No dialog window is painted",
  "11  Rows pass cleanly through the viewport",
  "12  The long passage continues below",
  "13  Every glyph stays in source order",
  "14  Integer presentation keeps hard pixels",
  "15  The journey continues upward",
  "16  Nothing is paginated or dismissed",
  "17  The lower edge approaches",
  BOTTOM_BAND,
  LONG_CJK,
] as const;

interface TreeNode {
  t?: string;
  n?: string;
  x?: string;
  k?: TreeNode[];
}

interface PixelBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function scrollModal(world: BoundGameWorld): ScrollTextModal | null {
  const value = world.probes().state.interp.modal;
  return value?.kind === "scrollText" ? value : null;
}

function findNode(node: TreeNode, name: string): TreeNode | null {
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const hit = findNode(child, name);
    if (hit) return hit;
  }
  return null;
}

function nodeText(node: TreeNode | null): string {
  if (!node) return "";
  if (node.t === "#text") return node.x ?? "";
  return (node.k ?? []).map(nodeText).join("");
}

function exactColourBounds(
  rgba: Uint8Array,
  width: number,
  height: number,
  colour: readonly [number, number, number, number],
): PixelBounds | null {
  let bounds: PixelBounds | null = null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (
        rgba[at] !== colour[0] || rgba[at + 1] !== colour[1] ||
        rgba[at + 2] !== colour[2] || rgba[at + 3] !== colour[3]
      ) continue;
      if (!bounds) bounds = { x0: x, y0: y, x1: x + 1, y1: y + 1, count: 1 };
      else {
        bounds.x0 = Math.min(bounds.x0, x);
        bounds.y0 = Math.min(bounds.y0, y);
        bounds.x1 = Math.max(bounds.x1, x + 1);
        bounds.y1 = Math.max(bounds.y1, y + 1);
        bounds.count++;
      }
    }
  }
  return bounds;
}

function scalarSlice(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join("");
}

function expectExactNearest2x(one: Uint8Array, two: Uint8Array): void {
  let mismatchedChannels = 0;
  for (let y = 0; y < 544; y++) {
    for (let x = 0; x < 960; x++) {
      const source = ((y >> 1) * 480 + (x >> 1)) * 4;
      const target = (y * 960 + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        if (two[target + channel] !== one[source + channel]) mismatchedChannels++;
      }
    }
  }
  expect(mismatchedChannels, "the 2x framebuffer is exact nearest-neighbour duplication").toBe(0);
}

async function golden(name: string, rgba: Uint8Array, width: number, height: number): Promise<void> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.RPGM1_UPDATE_GOLDENS) await Bun.write(url, encodePNG(rgba, width, height));
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect([expected.width, expected.height]).toEqual([width, height]);
  expect(rgba).toEqual(expected.rgba);
}

async function capture(target: (typeof TARGETS)[number]): Promise<Uint8Array> {
  const world = await bootGameWorld(
    appBundle("r2-ui"),
    60,
    { __r2ScrollText: true },
    undefined,
    { width: 480, height: 272, rasterDensity: 1, renderScale: target.scale },
  );
  for (let frame = 0; frame < 120 && scrollModal(world) === null; frame++) pump(world, 1);

  const opened = scrollModal(world);
  expect(opened, "the autorun fixture opens scrolling text").not.toBeNull();
  expect(world.ticksPerFrame).toBe(1);
  expect(opened).toMatchObject({
    lines: [...EXPECTED_LINES],
    speed: 2,
    noFastForward: false,
    offset2: 0,
    viewportHeight: 272,
  });
  expect(opened!.contentHeight, "the long CJK row wraps instead of truncating").toBeGreaterThan(
    EXPECTED_LINES.length * SCROLL_TEXT_ROW_HEIGHT,
  );

  // At 60 Hz these are exactly 95 reducer reference ticks. Holding confirm
  // applies the RPG Maker 3x multiplier: 95 * speed 2 * multiplier 3 = 570.
  pump(world, 95, BTN.CIRCLE);
  const scrolled = scrollModal(world);
  expect(scrolled?.offset2).toBe(570);
  expect(scrolled?.lines).toEqual([...EXPECTED_LINES]);
  const contentTop = scrolled!.viewportHeight - scrolled!.offset2 / 2;
  expect(contentTop).toBe(-13);
  expect(
    { top: [contentTop + SCROLL_TEXT_ROW_HEIGHT, contentTop + 2 * SCROLL_TEXT_ROW_HEIGHT],
      bottom: [contentTop + 18 * SCROLL_TEXT_ROW_HEIGHT, contentTop + 19 * SCROLL_TEXT_ROW_HEIGHT] },
    "the coloured row boxes cross the top and bottom clip boundaries",
  ).toEqual({ top: [2, 17], bottom: [257, 272] });

  const source = scrolled!.lines.join("\n");
  const coral = scrolled!.colours?.find((span) => span.colour === "#FF784C");
  const blue = scrolled!.colours?.find((span) => span.colour === "#20A0D6");
  expect(coral && scalarSlice(source, coral.start, coral.end)).toBe(TOP_BAND);
  expect(blue && scalarSlice(source, blue.start, blue.end)).toBe(BOTTOM_BAND);

  const tree = world.getTree() as TreeNode;
  const content = findNode(tree, "rpgkit-scroll-text-content");
  expect(content).not.toBeNull();
  expect(nodeText(content), "every authored scalar survives CJK wrapping").toBe(EXPECTED_LINES.join(""));

  const frame = world.render().slice();
  const scale = target.scale;
  await golden(`rpgmaker-scroll-text-fast.${target.width}x${target.height}`, frame, target.width, target.height);
  const top = exactColourBounds(frame, target.width, target.height, [255, 120, 76, 255]);
  const bottom = exactColourBounds(frame, target.width, target.height, [32, 160, 214, 255]);
  expect(top?.count, "the coral top-edge text remains visible").toBeGreaterThan(10 * scale * scale);
  expect(top?.y0, "the coral pixels start inside the top row box").toBeLessThanOrEqual(6 * scale);
  expect(top?.y1, "the coral pixels stay in the top row box").toBeLessThanOrEqual(17 * scale);
  expect(bottom?.count, "the blue bottom-edge text remains visible").toBeGreaterThan(10 * scale * scale);
  expect(bottom?.y0, "the blue pixels stay in the bottom row box").toBeGreaterThanOrEqual(254 * scale);
  expect(bottom?.y1, "the blue pixels remain clipped to the viewport").toBeLessThanOrEqual(target.height);

  // Both colours of the procedural ground checker remain abundant under the
  // full-screen text layer; an opaque scroll backdrop would erase them.
  const darkGround = exactColourBounds(frame, target.width, target.height, [20, 28, 42, 255]);
  const lightGround = exactColourBounds(frame, target.width, target.height, [26, 38, 54, 255]);
  expect(darkGround?.count, "transparent layer preserves dark checker cells").toBeGreaterThan(5_000 * scale * scale);
  expect(lightGround?.count, "transparent layer preserves light checker cells").toBeGreaterThan(5_000 * scale * scale);

  return frame;
}

simDescribe("RPG Maker continuous scrolling-text rendering", () => {
  test("renders coloured edge rows over transparent ground at exact integer scale", async () => {
    const frames = new Map<number, Uint8Array>();
    for (const target of TARGETS) frames.set(target.width, await capture(target));
    expectExactNearest2x(frames.get(480)!, frames.get(960)!);
  }, 60_000);
});
