// tests/text-layout-sim.test.ts — the text command's layout fields through
// the real GameView on the deterministic wasm sim host
// (tests/fixtures/text-layout). For every text of the fixture, at 480x272
// and 960x544, the pixels say where the box is and how it looks: the frame
// colour bounds the expected rectangle (or is absent for the dim and
// transparent backgrounds), the ink sits in the rows the vertical alignment
// puts it in, and each row's ink is left, centred or right in the text
// column. A dim box is the paper colour over the map; a transparent one
// leaves the map untouched outside its words. A message too long for the
// narrow side box takes pages, and every character is shown. A speaker
// with a portrait leaves a corner or side window exactly where and as big
// as it is without one: the portrait is scaled into the window's inner
// height (nearest neighbour), the words wrap in the narrower column beside
// it and take more pages, and the name tab hangs off an edge that is not
// against the screen.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { DEFAULT_PLAYER_NAME, substituteLines } from "../src/engine/player-name.ts";
import type { TextBoxLayout } from "../src/engine/types.ts";
import { dialogBoxBottom, dialogBoxHeight, dialogBoxInsets, dialogBoxRows, dialogTextAreaHeight, messagePageStarts } from "../src/ui/dialog-pages.ts";
import { DEFAULT_UI_THEME, splitSpeaker, translucentColor } from "../src/ui/theme.ts";
import { createFontMeasure } from "../tools/lib/font-measure.ts";
import { FACES, SAME_WORDS_FIRST, SPEAKER_LONG, TEXTS } from "./fixtures/text-layout/fixture-data.ts";
import { FACE_PALETTES, FACE_PX, faceRgba } from "./fixtures/ui-theme/faces.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("text-layout");
if (!preflight.ok) console.warn(`text layout sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

const FONT = join(import.meta.dir, "fixtures", "cjk-text", "fonts", "NotoSansCJKsc-subset.otf");
const buildMeasure = createFontMeasure({ px: 12, fallbacks: [FONT] });

/** The RPG Maker band's height (top, center, bottom and the default). */
const BAND_H = 92;
/** Tuxemon's small dialog window (ui/dialogue.py with large_gui off) at
 *  each viewport: 0.8 of the width, 0.25 of the height. */
const SMALL_BOX: Record<number, { w: number; h: number }> = { 480: { w: 384, h: 68 }, 960: { w: 768, h: 136 } };
const NARROW = new Set(["topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"]);
/** Frame 2 + padding 8 between the box edge and the text column. */
const CHROME = 10;
const ROW_H = 15;
/** The portrait's side in a corner or side window: the window's inner
 *  height (68 - 20) when the 64 px image does not fit it, the image at 1x
 *  when it does; 64 px in a band at every size. */
const SMALL_FACE: Record<number, number> = { 480: 48, 960: 64 };
const BAND_FACE = 64;
/** The portrait column: the default 72 px (image and gap) scaled with it. */
const faceColumn = (face: number): number => Math.floor((72 * face) / FACE_PX);
/** The name tab: 15 px high, 2 px of it over the frame. */
const TAB_OUT = 13;
/** The top band's gap above it while the name tab shows (unchanged). */
const TAB_TOP_GAP = 16;

interface TreeNode {
  t?: string;
  n?: string;
  x?: string;
  k?: TreeNode[];
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

function messageRows(world: BoundGameWorld): string[] {
  const tree = world.getTree() as TreeNode;
  const rows: string[] = [];
  for (let i = 0; i < 8; i++) {
    const text = nodeText(findNode(tree, `rpgkit-message-row-${i}`));
    if (text.trim() !== "") rows.push(text);
  }
  return rows;
}

function measure(text: string): number {
  const ops = (globalThis as unknown as { ui: { measureText(s: string, slot: number): number } }).ui;
  return ops.measureText(text, 0);
}

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function confirm(world: BoundGameWorld): void {
  pump(world, 1, BTN.CIRCLE);
  pump(world, 1);
}

type ModalProbe = { kind: string; complete?: boolean; lines?: string[]; pageStarts?: number[]; page?: number; box?: TextBoxLayout } | null;
function modal(world: BoundGameWorld): ModalProbe {
  return (world.probes().state as unknown as { interp: { modal: ModalProbe } }).interp.modal;
}

function settle(world: BoundGameWorld): void {
  const done = () => {
    const m = modal(world);
    return m !== null && (m.kind !== "text" || m.complete === true);
  };
  for (let i = 0; i < 600 && !done(); i++) pump(world, 1);
  pump(world, 2);
}

const rgb = (color: string): number[] => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));

function pixel(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [frame[i]!, frame[i + 1]!, frame[i + 2]!];
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Bounds of the pixels of exactly `color` inside `within` (whole frame
 *  when absent); null when there are none. */
function colorBounds(frame: Uint8Array, width: number, height: number, color: string, within?: Rect): Rect | null {
  const [r, g, b] = rgb(color);
  return pixelBounds(frame, width, height, (pr, pg, pb) => pr === r && pg === g && pb === b, within);
}

/** Bounds of the text's glyph pixels: the ink colour, or close to it on an
 *  antialiased edge. The legend's dim colour, the paper and the map are all
 *  far darker. */
function inkBounds(frame: Uint8Array, width: number, height: number, within: Rect): Rect | null {
  const [r, g, b] = rgb(DEFAULT_UI_THEME.ink);
  return pixelBounds(frame, width, height, (pr, pg, pb) => pr >= r! - 60 && pg >= g! - 60 && pb >= b! - 60, within);
}

function pixelBounds(
  frame: Uint8Array,
  width: number,
  height: number,
  hit: (r: number, g: number, b: number) => boolean,
  within?: Rect,
  outside?: Rect,
): Rect | null {
  const area = within ?? { x0: 0, y0: 0, x1: width, y1: height };
  let out: Rect | null = null;
  for (let y = area.y0; y < area.y1; y++) {
    for (let x = area.x0; x < area.x1; x++) {
      if (outside && x >= outside.x0 && x < outside.x1 && y >= outside.y0 && y < outside.y1) continue;
      const i = (y * width + x) * 4;
      if (!hit(frame[i]!, frame[i + 1]!, frame[i + 2]!)) continue;
      if (!out) out = { x0: x, y0: y, x1: x + 1, y1: y + 1 };
      else {
        out.x0 = Math.min(out.x0, x);
        out.y0 = Math.min(out.y0, y);
        out.x1 = Math.max(out.x1, x + 1);
        out.y1 = Math.max(out.y1, y + 1);
      }
    }
  }
  return out;
}

/** The box rectangle a layout should occupy (a page that fits it). A
 *  speaker's portrait moves only the top band (down, under its name tab). */
function expectedBox(box: TextBoxLayout, width: number, height: number, speaking = false): Rect {
  const insets = dialogBoxInsets(width, box.position);
  const boxH = dialogBoxHeight(box.position, height);
  const bottom = dialogBoxBottom(box.position, height, boxH, speaking ? TAB_TOP_GAP : undefined);
  return { x0: insets.left, x1: width - insets.right, y0: height - bottom - boxH, y1: height - bottom };
}

/** Bounds of the pixels of `color` outside `rect`. */
function colorBoundsOutside(frame: Uint8Array, width: number, height: number, color: string, rect: Rect): Rect | null {
  const [r, g, b] = rgb(color);
  return pixelBounds(frame, width, height, (pr, pg, pb) => pr === r && pg === g && pb === b, undefined, rect);
}

/** One frame of an open text, with what the test knows about it. */
interface Shot {
  index: number;
  frame: Uint8Array;
  rows: string[];
  box: TextBoxLayout;
  /** The first line names KEEPER: the portrait and the name tab show. */
  speaking: boolean;
}

/** Checks a complete page's frame: box rectangle and look, ink rows and
 *  alignment. Returns the rectangle for the background checks. */
function checkShot(shot: Shot, width: number, height: number, reference: Uint8Array): void {
  const { frame, rows, box, index, speaking } = shot;
  const label = `text ${index} at ${width}x${height}`;
  const rect = expectedBox(box, width, height, speaking);
  if (box.position && NARROW.has(box.position)) {
    // The upstream window size, flush with the edges it is anchored to.
    expect({ w: rect.x1 - rect.x0, h: rect.y1 - rect.y0 }, `${label}: small window`).toEqual(SMALL_BOX[width]!);
    expect(rect.x0 === 0 || rect.x1 === width, `${label}: touches a side`).toBe(true);
    if (box.position.startsWith("top")) expect(rect.y0, `${label}: touches the top`).toBe(0);
    if (box.position.startsWith("bottom")) expect(rect.y1, `${label}: touches the bottom`).toBe(height);
  } else {
    expect(rect.y1 - rect.y0, `${label}: band height`).toBe(BAND_H);
    if (speaking && box.position === "top") expect(rect.y0, `${label}: top band under the tab`).toBe(TAB_TOP_GAP);
  }
  const background = box.background ?? "window";
  const border = colorBounds(frame, width, height, DEFAULT_UI_THEME.border, speaking ? rect : undefined);
  if (background === "window") {
    expect(border, `${label}: frame rectangle`).toEqual(rect);
  } else {
    expect(border, `${label}: no frame`).toBeNull();
  }

  let face = 0;
  if (speaking) {
    // The name tab is the only frame colour outside the window: a 13 px
    // strip against its top edge, or its bottom edge for a window against
    // the top of the screen.
    const tab = colorBoundsOutside(frame, width, height, DEFAULT_UI_THEME.border, rect);
    expect(tab, `${label}: name tab`).not.toBeNull();
    expect(tab!.y1 - tab!.y0, `${label}: name tab height`).toBe(TAB_OUT);
    expect(tab!.x0, `${label}: name tab left`).toBe(rect.x0 + 12);
    expect(tab!.x1, `${label}: name tab inside the window's width`).toBeLessThan(rect.x1);
    if (rect.y0 === 0) expect(tab!.y0, `${label}: name tab under the window`).toBe(rect.y1);
    else expect(tab!.y1, `${label}: name tab over the window`).toBe(rect.y0);

    // The portrait: inside the window's paper and padding, at the window's
    // inner height (or 64 px when that fits), nearest-neighbour scaled
    // (every pixel one of the drawing's colours).
    face = box.position && NARROW.has(box.position) ? SMALL_FACE[width]! : BAND_FACE;
    const palette = Object.values(FACE_PALETTES.keeper);
    const ring = rgb(`#${palette[0]!.map((c) => c.toString(16).padStart(2, "0")).join("")}`);
    const faceBounds = pixelBounds(frame, width, height, (r, g, b) => r === ring[0] && g === ring[1] && b === ring[2]);
    const at = { x0: rect.x0 + CHROME, y0: rect.y0 + CHROME, x1: rect.x0 + CHROME + face, y1: rect.y0 + CHROME + face };
    expect(faceBounds, `${label}: portrait rectangle`).toEqual(at);
    expect(at.y1, `${label}: portrait inside the window`).toBeLessThanOrEqual(rect.y1 - CHROME);
    expect(at.x1, `${label}: portrait inside the window`).toBeLessThanOrEqual(rect.x1 - CHROME);
    const source = faceRgba("keeper");
    for (let y = at.y0; y < at.y1; y++) {
      for (let x = at.x0; x < at.x1; x++) {
        const got = pixel(frame, width, x, y);
        if (face === FACE_PX) {
          const i = ((y - at.y0) * FACE_PX + (x - at.x0)) * 4;
          expect(got, `${label}: portrait pixel (${x},${y})`).toEqual([source[i]!, source[i + 1]!, source[i + 2]!]);
        } else if (!palette.some((c) => c[0] === got[0] && c[1] === got[1] && c[2] === got[2])) {
          throw new Error(`${label}: portrait pixel (${x},${y}) ${got} is not one of the drawing's colours`);
        }
      }
    }
  }

  // The text column and its rows (right of the portrait column).
  const colX = rect.x0 + CHROME + (face ? faceColumn(face) : 0);
  const budget = rect.x1 - rect.x0 - 2 * CHROME - (face ? faceColumn(face) : 0);
  const free = Math.max(0, dialogTextAreaHeight(box.position, height) - rows.length * ROW_H);
  const shift = box.valign === "bottom" ? free : box.valign === "center" ? Math.floor(free / 2) : 0;
  const textTop = rect.y0 + CHROME + shift;
  const column = { x0: colX, x1: rect.x1, y0: rect.y0, y1: rect.y1 };
  const ink = inkBounds(frame, width, height, column);
  expect(ink, `${label}: ink`).not.toBeNull();
  expect(ink!.y0, `${label}: first ink row`).toBeGreaterThanOrEqual(textTop);
  expect(ink!.y0, `${label}: first ink row`).toBeLessThan(textTop + 5);
  expect(ink!.y1, `${label}: last ink row`).toBeLessThanOrEqual(textTop + rows.length * ROW_H);
  expect(ink!.y1, `${label}: last ink row`).toBeGreaterThan(textTop + (rows.length - 1) * ROW_H + 5);
  for (let r = 0; r < rows.length; r++) {
    const band = { x0: colX, x1: rect.x1, y0: textTop + r * ROW_H, y1: textTop + (r + 1) * ROW_H };
    const rowInk = inkBounds(frame, width, height, band);
    expect(rowInk, `${label}: ink in row ${r}`).not.toBeNull();
    expect(measure(rows[r]!), `${label}: row ${r} fits the column`).toBeLessThanOrEqual(budget);
    const left = rowInk!.x0 - colX;
    const right = colX + budget - rowInk!.x1;
    expect(left, `${label}: row ${r} inside the column`).toBeGreaterThanOrEqual(0);
    expect(right, `${label}: row ${r} inside the column`).toBeGreaterThanOrEqual(0);
    // The row's advance (the core's measurer) sets where it starts: flush
    // left, half the free width in, or all of it. Ink starts within a side
    // bearing of that and ends inside the advance (a fullwidth "！" leaves
    // the right part of its cell blank, so ink margins alone are not even).
    const align = box.align ?? "left";
    const advance = measure(rows[r]!.replace(/ +$/, ""));
    const expectedLeft = align === "right" ? budget - advance : align === "center" ? Math.floor((budget - advance) / 2) : 0;
    expect(left, `${label}: row ${r} ${align} (${left} | ${right})`).toBeGreaterThanOrEqual(expectedLeft);
    expect(left, `${label}: row ${r} ${align} (${left} | ${right})`).toBeLessThanOrEqual(expectedLeft + 4);
    expect(rowInk!.x1, `${label}: row ${r} ink inside its advance`).toBeLessThanOrEqual(colX + expectedLeft + advance + 1);
    if (align === "right") expect(right, `${label}: row ${r} right`).toBeLessThanOrEqual(12);
    if (align !== "left") expect(left, `${label}: row ${r} not flush left`).toBeGreaterThan(8);
  }

  if (background === "dim") {
    // The paper colour at 60 % over the map: sampled in the top padding.
    const fill = translucentColor(DEFAULT_UI_THEME.paper, 0.6);
    const alpha = parseInt(fill.slice(7, 9), 16) / 255;
    const paper = rgb(DEFAULT_UI_THEME.paper);
    for (const [x, y] of [[rect.x0 + 4, rect.y0 + 4], [rect.x1 - 5, rect.y1 - 5], [rect.x0 + 4, rect.y1 - 5]] as const) {
      const under = pixel(reference, width, x, y);
      const got = pixel(frame, width, x, y);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(got[c]! - (paper[c]! * alpha + under[c]! * (1 - alpha))), `${label}: dim at (${x},${y})`).toBeLessThanOrEqual(2);
      }
    }
  }
  if (background === "transparent") {
    // Outside the text area the box draws nothing: the map shows unchanged.
    const text = { x0: colX, x1: colX + budget, y0: rect.y0 + CHROME, y1: rect.y1 - CHROME };
    let differing = 0;
    for (let y = rect.y0; y < rect.y1; y++) {
      for (let x = rect.x0; x < rect.x1; x++) {
        const inText = x >= text.x0 && x < text.x1 && y >= text.y0 && y < text.y1;
        const same = pixel(frame, width, x, y).every((v, c) => v === pixel(reference, width, x, y)[c]);
        if (!same && !inText) differing++;
      }
    }
    expect(differing, `${label}: pixels drawn outside the words`).toBe(0);
  }
}

simDescribe("text box layouts", () => {
  for (const viewport of VIEWPORTS) {
    const { width, height } = viewport;
    test(`each layout places, aligns and draws its box at ${width}x${height}`, async () => {
      const world = await bootGameWorld(appBundle("text-layout"), 60, undefined, undefined, viewport);
      const shots: Shot[] = [];
      for (let index = 0; index < TEXTS.length; index++) {
        const text = TEXTS[index]!;
        const { op: _op, lines: _lines, cps: _cps, ...box } = text;
        const lines = substituteLines(text.lines, DEFAULT_PLAYER_NAME);
        settle(world);
        const m = modal(world)!;
        expect(m.kind).toBe("text");
        // The modal carries exactly the non-default layout; the default
        // text carries none.
        if (Object.keys(box).length === 0) expect(m.box).toBeUndefined();
        else expect(m.box).toEqual(box);
        // Pages are cut at the design width of this box's window.
        const starts = messagePageStarts(lines, { viewportWidth: 480, faces: FACES }, buildMeasure, box.position);
        expect(m.pageStarts ?? null).toEqual(starts);
        const pages = starts?.length ?? 1;
        const speaking = splitSpeaker(lines[0]!, FACES).name !== null;
        // The long portrait message goes on over pages (its rows fit the
        // column beside the portrait: checkShot).
        if (index === SPEAKER_LONG) expect(pages, "the long portrait message takes pages").toBeGreaterThanOrEqual(3);
        const shown: string[] = [];
        for (let page = 0; page < pages; page++) {
          if (page > 0) settle(world);
          expect(modal(world)!.page ?? 0).toBe(page);
          const rows = messageRows(world);
          expect(rows.length, `text ${index} page ${page}`).toBeGreaterThan(0);
          expect(rows.length, `text ${index} page ${page}`).toBeLessThanOrEqual(dialogBoxRows(box.position, height));
          shown.push(...rows);
          shots.push({ index, frame: world.render().slice(), rows, box, speaking });
          confirm(world);
        }
        // Nothing cut: the rows hold every character in order.
        const strip = (s: string) => s.replace(/[\s]/g, "");
        const said = speaking ? [splitSpeaker(lines[0]!, FACES).rest, ...lines.slice(1)] : lines;
        expect(strip(shown.join("")), `text ${index} complete`).toBe(strip(said.join("")));
      }
      pump(world, 10);
      expect(modal(world)).toBeNull();
      const reference = world.render().slice();
      if (process.env.TEXT_LAYOUT_SHOTS) {
        const { encodePNG } = await import("../vendor/pocketjs/tests/png.ts");
        for (const [i, shot] of shots.entries()) {
          await Bun.write(join(process.env.TEXT_LAYOUT_SHOTS, `${width}-${i}-text${shot.index}.png`), encodePNG(shot.frame, width, height));
        }
      }
      for (const shot of shots) checkShot(shot, width, height, reference);

      // The narrow left box takes more pages than the full-width one.
      const long = substituteLines(TEXTS[5]!.lines, DEFAULT_PLAYER_NAME);
      const narrow = messagePageStarts(long, { viewportWidth: 480 }, buildMeasure, "left")!;
      const wide = messagePageStarts(long, { viewportWidth: 480 }, buildMeasure) ?? [0];
      expect(narrow.length).toBeGreaterThan(wide.length);
    });
  }
});

simDescribe("a box that changes only its layout", () => {
  // Two texts with the same words, typed fast: at 2 Hz one host frame runs
  // thirty reducer ticks, so the frame that confirms the first box already
  // shows the second one complete. The UI must take the new layout from that
  // frame on (the visible modal identity includes the layout).
  test("replaces the box on screen in the same host frame at 2 Hz", async () => {
    const width = 480;
    const height = 272;
    const world = await bootGameWorld(appBundle("text-layout"), 2, undefined, undefined, { width, height });
    expect(world.ticksPerFrame).toBeGreaterThan(1);
    for (let index = 0; index < SAME_WORDS_FIRST; index++) {
      for (let i = 0; i < 400 && (modal(world)?.kind !== "text" || modal(world)!.complete !== true); i++) pump(world, 1);
      const pages = modal(world)!.pageStarts?.length ?? 1;
      for (let page = 0; page < pages; page++) {
        for (let i = 0; i < 400 && modal(world)!.complete !== true; i++) pump(world, 1);
        confirm(world);
      }
    }
    for (let i = 0; i < 400 && modal(world)?.complete !== true; i++) pump(world, 1);
    const first = TEXTS[SAME_WORDS_FIRST]!;
    const second = TEXTS[SAME_WORDS_FIRST + 1]!;
    expect(modal(world)!.box).toEqual({ position: first.position, align: first.align });
    const firstRect = expectedBox({ position: first.position }, width, height);
    expect(colorBounds(world.render(), width, height, DEFAULT_UI_THEME.border)).toEqual(firstRect);

    // One host frame with the confirm: the first box closes, the second
    // opens and finishes typing; the reducer never shows an empty frame.
    pump(world, 1, BTN.CIRCLE);
    const m = modal(world)!;
    expect(m.kind).toBe("text");
    expect(m.lines).toEqual(second.lines);
    expect(m.complete).toBe(true);
    expect(m.box).toEqual({ position: second.position });
    const secondRect = expectedBox({ position: second.position }, width, height);
    expect(secondRect).not.toEqual(firstRect);
    expect(colorBounds(world.render(), width, height, DEFAULT_UI_THEME.border)).toEqual(secondRect);
    // The words follow the box: left-aligned in the top band.
    const ink = inkBounds(world.render(), width, height, secondRect)!;
    expect(ink.x0 - (secondRect.x0 + CHROME)).toBeLessThanOrEqual(4);
  });
});
