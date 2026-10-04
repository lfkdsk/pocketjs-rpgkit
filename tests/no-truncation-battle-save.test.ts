// tests/no-truncation-battle-save.test.ts — the battle MessageBand,
// CommandGrid and ListMenu and the SaveMenu never cut a string: no "…",
// and every character of every string the test hands them is drawn. Runs
// the built no-truncation fixture (tests/fixtures/no-truncation) on the
// deterministic wasm sim host with over-long Latin strings and Chinese
// strings (characters of the cjk-text fixture's subset font, written as
// code points so this file stays ASCII).
//
//   MessageBand  a message longer than its rows grows the band upward a row
//                at a time; the rows, read back, are the message.
//   ListMenu     long labels wrap under their prefix (the detail stays on
//                the first row), the window scrolls by whole items and the
//                selected item is always whole; title and description wrap.
//   CommandGrid  a label that does not fit one 12 px row wraps to two; one
//                that does not fit two 12 px rows steps down to 10 px
//                (font slot 19) on one row or two, every character drawn
//                inside the cell. Only a label too long for two 10 px rows
//                shows one clipped 10 px row, whose text is still the whole
//                label, and the FOCUSED cell scrolls it (marquee) until its
//                last character is inside the clip. An unfocused cell never
//                scrolls, and the grid's own clock costs zero ops while
//                nothing overflows.
//   DialogBox    an option beyond the choice row budget stays inside a clip
//                and scrolls until its final character is visible.
//   SaveMenu     title, slot summaries and message wrap; a page whose rows
//                need it grows the panel.
//
// Texts are read from the host ops (setText/replaceText by node id), not
// from the DevTools tree, which shortens a long text for display; a node's
// font slot is its last setStyle record's fontSlot in the built pak's
// style table.
//
// Mutation check: restoring a cut (fitText(label, budget, measure) for the
// grid's clipped label, or the "…" row in text-flow.ts) turns these red, and
// so does dropping the grid's 10 px step (the shrink cases clip instead).
//
// Needs the fixture built (`bun run build:example no-truncation`) and the
// wasm core; without them the cases register as skips.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { decodeStyleTable, PROP, type DecodedStyleTable } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { unpack } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { breakText, hasForcedBreak } from "../src/engine/text-break.ts";
import { MARQUEE_HOLD, MARQUEE_TICKS_PER_PX, marqueeOffset } from "../src/ui/list-window.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";

const preflight = appPreflight("no-truncation");
if (!preflight.ok) console.warn(`no-truncation sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const W = 480;
const H = 272;
const ELLIPSIS = String.fromCodePoint(0x2026);
const STRUCTURAL = new Set(["createNode", "destroyNode", "insertBefore", "removeChild"]);

/** Chinese characters the cjk-text fixture's subset font (and so this
 *  fixture's atlas) holds. */
const HAN = [
  0x4e00, 0x4e0a, 0x4e0b, 0x4e0d, 0x4e1b, 0x4e2a, 0x4e2d, 0x4e48, 0x4e86, 0x4e8e, 0x4e9b, 0x4eae, 0x4eba, 0x4ec0,
  0x4ece, 0x4ed6, 0x4eec, 0x4f1a, 0x4f24, 0x4f4d, 0x4f4f, 0x4f60, 0x5148, 0x517d, 0x51b3, 0x51c6, 0x51fa, 0x5230,
  0x524d, 0x5317, 0x53bb, 0x53c8, 0x53cb, 0x53d1, 0x53e3, 0x53e4, 0x53e6, 0x540e, 0x5411, 0x5417, 0x5427, 0x5439,
];
/** `count` Chinese characters starting at HAN[start], cycling. */
const han = (start: number, count: number): string =>
  String.fromCodePoint(...Array.from({ length: count }, (_, i) => HAN[(start + i) % HAN.length]!));

const LATIN_MESSAGE =
  "The ancient guardian of the northern pass raises its stone shield and the whole valley trembles " +
  "while Bartholomew-the-Unyielding steadies the line, and the wind howls across the broken battlements.";
const CJK_MESSAGE = han(0, 100);

interface TreeNode {
  i: number;
  t: string;
  n?: string;
  k?: TreeNode[];
}

let world: SimWorld;
/** Every text node's full content, by node id. */
const texts = new Map<number, string>();
/** The last translateX each node was given. */
const translateX = new Map<number, number>();
/** The last style record each node was given. */
const styleIds = new Map<number, number>();
let styleTable: DecodedStyleTable;
let ops = 0;
let structuralOps = 0;

function show(scene: unknown): void {
  (globalThis as { __noTruncation?: { show(s: unknown): void } }).__noTruncation!.show(scene);
  frame();
}

function frame(): void {
  world.frame(0);
  for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
}

function tree(): TreeNode {
  return world.getTree() as TreeNode;
}

function find(node: TreeNode, name: string): TreeNode | undefined {
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const hit = find(child, name);
    if (hit) return hit;
  }
  return undefined;
}

/** The text a node draws: its text children's full contents, in order. */
function textOf(node: TreeNode | undefined): string {
  if (!node) return "";
  if (node.t === "#text") return texts.get(node.i) ?? "";
  return (node.k ?? []).map(textOf).join("");
}

/** Every Text element (a node with "#text" children) under `node`. */
function textNodes(node: TreeNode, out: TreeNode[] = []): TreeNode[] {
  if ((node.k ?? []).some((k) => k.t === "#text")) out.push(node);
  for (const child of node.k ?? []) if (child.t !== "#text") textNodes(child, out);
  return out;
}

function allTexts(root: TreeNode): string[] {
  return textNodes(root).map(textOf);
}

/** Named rows `${name}-0`, `${name}-1`, ... until one is missing; `first`
 *  names row 0 when it has no index suffix. */
function namedRows(root: TreeNode, name: string, first?: string): string[] {
  const rows: string[] = [];
  for (let i = 0; ; i++) {
    const node = find(root, i === 0 && first !== undefined ? first : `${name}-${i}`);
    if (!node) return rows;
    rows.push(textOf(node));
  }
}

const dense = (s: string): string => s.replace(/\s+/g, "");

function measure(text: string, slot = 0): number {
  return (globalThis as unknown as { ui: { measureText(s: string, slot: number): number } }).ui.measureText(text, slot);
}

function expectNoEllipsis(root: TreeNode): void {
  for (const text of allTexts(root)) expect(text.includes(ELLIPSIS), JSON.stringify(text)).toBe(false);
}

function rgbaAt(fb: Uint8Array, x: number, y: number): string {
  const i = (y * W + x) * 4;
  return "#" + [fb[i]!, fb[i + 1]!, fb[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function colourPixels(fb: Uint8Array, colour: string, x0: number, y0: number, width: number, height: number): number {
  let count = 0;
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) if (rgbaAt(fb, x, y) === colour) count++;
  }
  return count;
}

simDescribe("no truncation: battle MessageBand / CommandGrid / ListMenu and SaveMenu", () => {
  beforeAll(async () => {
    world = await bootWorld(appBundle("no-truncation"), 60, undefined, (host) => {
      for (const [name, fn] of Object.entries(host)) {
        if (typeof fn !== "function") continue;
        host[name] = (...args: unknown[]) => {
          ops++;
          if (STRUCTURAL.has(name)) structuralOps++;
          if (name === "setText" || name === "replaceText") texts.set(args[0] as number, args[1] as string);
          if (name === "setProp" && args[1] === PROP.translateX) translateX.set(args[0] as number, args[2] as number);
          if (name === "setStyle") styleIds.set(args[0] as number, args[1] as number);
          return (fn as (...a: unknown[]) => unknown).apply(host, args);
        };
      }
    });
    frame();
    const styles = unpack(readFileSync(`${appBundle("no-truncation")}.pak`)).find((b) => b.key === "ui:styles")!;
    styleTable = decodeStyleTable(styles.data);
  });

  // -- MessageBand ----------------------------------------------------------

  for (const [script, message] of [["Latin", LATIN_MESSAGE], ["Chinese", CJK_MESSAGE]] as const) {
    test(`a ${script} message longer than the band's rows grows the band and shows every character`, () => {
      show({ band: { lines: [message] } });
      const root = tree();
      const rows = namedRows(root, "nt-band-row");
      expect(rows.length, JSON.stringify(rows)).toBeGreaterThan(2);
      expectNoEllipsis(root);
      expect(dense(rows.join(""))).toBe(dense(message));
      // Band 464 wide: content 464 - 16.
      for (const row of rows) expect(measure(row)).toBeLessThanOrEqual(448);
      // The band is bottom-anchored (insetB 8): it grows upward, 15 px a row
      // plus 12 px padding and 4 px border.
      const fb = world.render().slice();
      const top = H - 8 - (rows.length * 15 + 16);
      expect(rgbaAt(fb, 20, top)).toBe(DEFAULT_UI_THEME.border);
      expect(rgbaAt(fb, 20, top - 1)).toBe("#000000");
    });
  }

  test("a message that fits keeps the band's two rows and height", () => {
    show({ band: { lines: ["Wild SLIME appeared!", "What will you do?"] } });
    const root = tree();
    expect(namedRows(root, "nt-band-row")).toEqual(["Wild SLIME appeared!", "What will you do?"]);
    const fb = world.render().slice();
    expect(rgbaAt(fb, 20, H - 8 - 46)).toBe(DEFAULT_UI_THEME.border);
    expect(rgbaAt(fb, 20, H - 8 - 47)).toBe("#000000");
  });

  test("the typewriter reveals into the grown rows in order", () => {
    const shown = LATIN_MESSAGE.length - 20;
    show({ band: { lines: [LATIN_MESSAGE], revealed: shown } });
    const rows = namedRows(tree(), "nt-band-row");
    expect(rows.length).toBeGreaterThan(2);
    expect(dense(rows.join(""))).toBe(dense(LATIN_MESSAGE.slice(0, shown)));
  });

  // -- ListMenu -------------------------------------------------------------

  const LIST_ROWS = [
    { label: "Fire", detail: "3 MP" },
    { label: "Thunderclap of the Forgotten Mountain Kings", detail: "12 MP" },
    { label: han(3, 30), detail: "9 MP" },
    { label: "Heal", detail: "2 MP" },
    { label: "Supercalifragilisticexpialidocious-Barrier-Of-Light", detail: "20 MP" },
    { label: "Ice", detail: "4 MP" },
  ];
  const LIST_TITLE = "Choose a spell to cast upon the gathered enemy party before it strikes";
  const LIST_DESCRIPTION = han(10, 12) + " burns every foe for three turns and lowers their guard";

  /** The list's visible items: each item's first row has its detail; its
   *  continuation rows follow with no detail. */
  function listItems(root: TreeNode): { selected: boolean; label: string; detail: string; rows: string[] }[] {
    const items: { selected: boolean; label: string; detail: string; rows: string[] }[] = [];
    for (let slot = 0; ; slot++) {
      const row = find(root, `nt-list-row-${slot}`);
      if (!row) break;
      const [left, right] = (row.k ?? []).map(textOf);
      if (left === "") continue;
      if (right !== "") items.push({ selected: left!.startsWith("> "), label: "", detail: right!, rows: [] });
      const item = items.at(-1)!;
      // Continuation rows are indented like an unselected first row.
      if (right === "") expect(left!.startsWith("  "), JSON.stringify(left)).toBe(true);
      item.rows.push(left!);
      item.label += left!.slice(2);
      // The label row and its detail fit the 176 px content with their gap.
      expect(measure(left!) + 4 + measure(item.detail)).toBeLessThanOrEqual(176);
    }
    return items;
  }

  test("ListMenu wraps labels, title and description; the selected item is always whole", () => {
    const seen = new Set<string>();
    for (let index = 0; index < LIST_ROWS.length; index++) {
      show({
        list: { rows: LIST_ROWS, index, title: LIST_TITLE, description: LIST_DESCRIPTION, width: 180, visibleRows: 4 },
      });
      const root = tree();
      expectNoEllipsis(root);
      const items = listItems(root);
      const selected = items.filter((item) => item.selected);
      expect(selected.length, `index ${index}`).toBe(1);
      expect(dense(selected[0]!.label)).toBe(dense(LIST_ROWS[index]!.label));
      // Every visible item is whole (the window moves by items, not rows).
      for (const item of items) {
        const source = LIST_ROWS.find((r) => r.detail === item.detail)!;
        expect(dense(item.label), `index ${index}`).toBe(dense(source.label));
        seen.add(source.label);
      }
      // Four rows of list, unless the selected item alone is taller.
      const used = items.reduce((n, item) => n + item.rows.length, 0);
      expect(used).toBeLessThanOrEqual(Math.max(4, selected[0]!.rows.length));
      const title = namedRows(root, "nt-list-title", "nt-list-title");
      expect(title.length).toBeGreaterThan(1);
      expect(dense(title.join(""))).toBe(dense(LIST_TITLE));
      const description = namedRows(root, "nt-list-description", "nt-list-description");
      expect(description.length).toBeGreaterThan(1);
      expect(dense(description.join(""))).toBe(dense(LIST_DESCRIPTION));
    }
    // Scrolling through the list shows every label whole at some point.
    expect(seen.size).toBe(LIST_ROWS.length);
  });

  test("ListMenu grows past visibleRows when the selected label alone needs more rows", () => {
    const label = "An exceedingly long incantation that no two-row window could ever hold whole";
    show({ list: { rows: [{ label: "Fire", detail: "3" }, { label, detail: "99" }], index: 1, width: 120, visibleRows: 2 } });
    const root = tree();
    const items = listItems(root);
    expect(items.map((i) => i.selected)).toEqual([true]);
    expect(items[0]!.rows.length).toBeGreaterThan(2);
    expect(dense(items[0]!.label)).toBe(dense(label));
  });

  test("a ListMenu of short labels keeps one row per item", () => {
    show({ list: { rows: [{ label: "Fire", detail: "3 MP" }, { label: "Heal" }], index: 0, width: 180 } });
    const root = tree();
    expect([0, 1, 2, 3].map((slot) => (find(root, `nt-list-row-${slot}`)?.k ?? []).map(textOf))).toEqual([
      ["> Fire", "3 MP"],
      ["  Heal", ""],
      ["", ""],
      ["", ""],
    ]);
    expect(find(root, "nt-list-row-4")).toBeUndefined();
  });

  // -- CommandGrid ----------------------------------------------------------

  const XS = 0; // text-xs, 12 px
  const XS2 = 19; // text-2xs, 10 px
  const FIT = "Fight";
  const TWO_ROWS = "Summon the storm";
  /** One word too wide for a 12 px row: it goes down a size whole. */
  const SHRINK_WORD = "Thunderstrikeblaster";
  const SHRINK_TWO = "Call down the frozen comet upon them";
  const SHRINK_CJK = han(0, 18);
  const CLIPPED = "Unleash the ancient thunder of the forgotten mountain kings";
  const CLIPPED_CJK = han(0, 24);
  const CELLS = [{ label: FIT }, { label: TWO_ROWS }, { label: CLIPPED }, { label: CLIPPED_CJK }];
  const SHRINK_CELLS = [{ label: SHRINK_WORD }, { label: SHRINK_CJK }, { label: SHRINK_TWO }, { label: SHRINK_CJK }];
  /** A label's width in a cell at `slot`: the cell's 112 px text width
   *  minus the wider prefix ("> ") at the same size. */
  const labelWidth = (slot: number): number => 112 - Math.max(measure("> ", slot), measure("  ", slot));
  const at = (slot: number) => (text: string): number => measure(text, slot);
  const marquee = (root: TreeNode, cell: number): TreeNode => find(root, `nt-grid-cell-${cell}-marquee`)!;
  const offsetOf = (node: TreeNode): number => -(translateX.get(node.i) ?? 0);
  /** The font slot a node's last setStyle gave it. */
  const slotOf = (node: TreeNode): number | undefined => {
    const id = styleIds.get(node.i);
    return id === undefined ? undefined : styleTable.styles[id]?.base?.find((p) => p.prop === PROP.fontSlot)?.value;
  };
  /** A cell's Text elements: their texts and font slots. */
  const cellTexts = (root: TreeNode, cell: number): { text: string; slot: number | undefined }[] =>
    textNodes(find(root, `nt-grid-cell-${cell}`)!).map((node) => ({ text: textOf(node), slot: slotOf(node) }));
  /** Grid cell boxes on screen (grid at insetR 8, insetT 8: content from
   *  x 240, y 12; cells 114 px apart across and 22 px down). The paper
   *  ends at y 54, where the 2 px frame starts. */
  const CELL_X = [240, 354];
  const CELL_Y = [12, 34];
  const PAPER_BOTTOM = 54;
  /** Rows of a cell column range holding anything but paper. */
  const inkRows = (fb: Uint8Array, cell: number, y0: number, y1: number): number[] => {
    const x0 = CELL_X[cell % 2]!;
    const rows: number[] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x0 + 112; x++) {
        if (rgbaAt(fb, x, y) !== DEFAULT_UI_THEME.paper) {
          rows.push(y);
          break;
        }
      }
    }
    return rows;
  };

  test("the fixture's 10 px atlas holds every Chinese character the grid draws", () => {
    // Read the built pak: slot 19 is baked with the same characters as the
    // 12 px slot, the Noto subset's Han glyphs included (gid 0 is tofu).
    const blobs = unpack(readFileSync(`${appBundle("no-truncation")}.pak`));
    const atlas = (slot: number): DataView => {
      const data = blobs.find((b) => b.key === `ui:font.${slot}`)!.data;
      return new DataView(data.buffer, data.byteOffset, data.byteLength);
    };
    const dv = atlas(XS2);
    expect(dv.getUint8(12)).toBe(XS2); // header slot byte
    expect(dv.getUint8(9)).toBe(13); // 10 px cell height (12 px: 15)
    expect(dv.getUint16(6, true)).toBe(atlas(XS).getUint16(6, true));
    const gids = new Map<number, number>();
    for (let i = 0; i < dv.getUint16(6, true); i++) gids.set(dv.getUint32(16 + i * 8, true), dv.getUint16(20 + i * 8, true));
    for (const cp of HAN) expect(gids.get(cp) ?? 0, `U+${cp.toString(16)}`).toBeGreaterThan(0);
  });

  test("CommandGrid: one row at 12 px, then two rows at 12 px", () => {
    show({ grid: { cells: CELLS, index: 0, tick: 0 } });
    const root = tree();
    expectNoEllipsis(root);
    // One row, exactly as before: one 12 px Text holding prefix + label.
    expect(cellTexts(root, 0)).toEqual([{ text: "> Fight", slot: XS }]);
    // Two 12 px rows beside the 12 px prefix.
    const two = cellTexts(root, 1);
    expect(two.map((t) => t.slot)).toEqual([XS, XS, XS]);
    expect(two[0]!.text).toBe("  ");
    expect(dense(two.slice(1).map((t) => t.text).join(""))).toBe(dense(TWO_ROWS));
    for (const row of two.slice(1)) expect(measure(row.text)).toBeLessThanOrEqual(labelWidth(XS));
    expect(measure(TWO_ROWS)).toBeGreaterThan(labelWidth(XS));
  });

  test("CommandGrid: a label too long for two 12 px rows steps down to 10 px, whole", () => {
    show({ grid: { cells: SHRINK_CELLS, index: 1, tick: 0 } });
    const root = tree();
    expectNoEllipsis(root);
    for (const [cell, label] of [[0, SHRINK_WORD], [1, SHRINK_CJK], [2, SHRINK_TWO], [3, SHRINK_CJK]] as const) {
      // None of these fits two 12 px rows broken where a row may break.
      const rows12 = breakText(label, labelWidth(XS), at(XS));
      expect(rows12.length > 2 || hasForcedBreak(label, rows12), label).toBe(true);
      const texts = cellTexts(root, cell);
      // Every Text of the cell, the prefix included, is set at 10 px...
      for (const t of texts) expect(t.slot, `${label}: ${JSON.stringify(t.text)}`).toBe(XS2);
      // ...no marquee, and every character is drawn, on rows that fit.
      expect(find(root, `nt-grid-cell-${cell}-marquee`)).toBeUndefined();
      const prefix = cell === 1 ? "> " : "  ";
      const rows = texts.length === 1 ? [texts[0]!.text.slice(prefix.length)] : texts.slice(1).map((t) => t.text);
      expect((texts.length === 1 ? texts[0]!.text : texts[0]!.text).startsWith(prefix)).toBe(true);
      expect(dense(rows.join(""))).toBe(dense(label));
      for (const row of rows) expect(measure(row, XS2)).toBeLessThanOrEqual(labelWidth(XS2));
    }
    // The long word fits one 10 px row; the others take two.
    expect(cellTexts(root, 0)).toEqual([{ text: `  ${SHRINK_WORD}`, slot: XS2 }]);
    expect(cellTexts(root, 2).length).toBe(3);
    expect(cellTexts(root, 3).length).toBe(3);

    // On screen: each two-row cell draws its ink within the 21 px from 1 px
    // above its top (a Chinese em box reaches there), the rows between the
    // cells stay blank, and nothing lands on the frame below the bottom
    // cells. The Latin rows are two bands with a blank row between them;
    // the Chinese rows' em boxes abut.
    const fb = world.render().slice();
    for (const cell of [1, 2, 3]) {
      const top = CELL_Y[cell >> 1]!;
      const ink = inkRows(fb, cell, top - 1, top + 20);
      expect(ink[0], `cell ${cell}`).toBeLessThanOrEqual(top + 1);
      expect(ink.at(-1), `cell ${cell}`).toBeGreaterThanOrEqual(top + 17);
      const gaps = ink.slice(1).filter((y, k) => y - ink[k]! > 1);
      expect(gaps.length, `cell ${cell}: ${ink.join(",")}`).toBe(cell === 2 ? 1 : 0);
    }
    for (const cell of [0, 1]) expect(inkRows(fb, cell, CELL_Y[1]! - 3, CELL_Y[1]! - 1), `above cell ${cell + 2}`).toEqual([]);
    for (const y of [PAPER_BOTTOM, PAPER_BOTTOM + 1]) {
      for (let x = 240; x < 468; x++) expect(rgbaAt(fb, x, y), `(${x},${y})`).toBe(DEFAULT_UI_THEME.border);
    }
  });

  test("CommandGrid: a bottom cell shows 20 px, so a two-row 12 px label there steps down to 10 px", async () => {
    // TWO_ROWS takes two 12 px rows in a top cell (22 px tall, all shown);
    // the same label in a bottom cell would reach the frame.
    show({ grid: { cells: [{ label: FIT }, { label: TWO_ROWS }, { label: TWO_ROWS }, { label: FIT }], index: 0, tick: 0 } });
    const root = tree();
    expect(cellTexts(root, 1).map((t) => t.slot)).toEqual([XS, XS, XS]);
    const bottom = cellTexts(root, 2);
    for (const t of bottom) expect(t.slot).toBe(XS2);
    const rows = bottom.length === 1 ? [bottom[0]!.text.slice(2)] : bottom.slice(1).map((t) => t.text);
    expect(dense(rows.join(""))).toBe(dense(TWO_ROWS));
    // A fitting bottom label keeps 12 px.
    expect(cellTexts(root, 3)).toEqual([{ text: `  ${FIT}`, slot: XS }]);
    const fb = world.render().slice();
    if (process.env.NT_SHOT) await Bun.write(process.env.NT_SHOT, encodePNG(fb, 480, 272));
    for (const y of [PAPER_BOTTOM, PAPER_BOTTOM + 1]) {
      for (let x = 240; x < 352; x++) expect(rgbaAt(fb, x, y), `(${x},${y})`).toBe(DEFAULT_UI_THEME.border);
    }
  });

  test("BoundedLine reacts wrap to marquee to wrap and reaches its last character", () => {
    const short = "Short";
    const long = han(0, 200);
    const width = 96;

    // Mount the component on its common wrap branch.
    show({ bounded: { text: short, width, maxRows: 2, tick: 0 } });
    let bounded = find(tree(), "nt-bounded")!;
    expect((bounded.k ?? []).some((node) => node.t === "#text"), "short value is a wrap Text").toBe(true);
    expect(textOf(bounded)).toBe(short);

    // Update the already-mounted prop to a schema-maximum value. It must
    // replace the Text with a clipping View, retain the complete string,
    // and apply the terminal marquee offset to the nested Text node.
    const overflow = Math.ceil(measure(long) - width);
    const terminalTick = MARQUEE_HOLD + overflow * MARQUEE_TICKS_PER_PX;
    show({ bounded: { text: long, width, maxRows: 2, tick: terminalTick } });
    bounded = find(tree(), "nt-bounded")!;
    expect((bounded.k ?? []).some((node) => node.t === "#text"), "long value is a clipping View").toBe(false);
    const marqueeText = textNodes(bounded)[0]!;
    expect(textOf(marqueeText)).toBe(long);
    expect(textOf(marqueeText).at(-1)).toBe(long.at(-1));
    expect(offsetOf(marqueeText), "terminal marquee offset").toBe(overflow);
    expect(measure(long) - offsetOf(marqueeText), "last character's right edge is inside the clip").toBeLessThanOrEqual(width);

    // Changing the same mounted prop back must remove the clipping View and
    // restore the plain wrap Text branch.
    show({ bounded: { text: short, width, maxRows: 2, tick: terminalTick } });
    bounded = find(tree(), "nt-bounded")!;
    expect((bounded.k ?? []).some((node) => node.t === "#text"), "short value returns to wrap Text").toBe(true);
    expect(textOf(bounded)).toBe(short);
  });

  test("DialogBox clips a long choice row and scrolls through its final character", () => {
    const label = han(7, 63) + "Z";
    const prefixed = `> ${label}`;
    const choiceWidth = 248 - 2 * (2 + 6);
    // Six prompt rows leave only three rows for options. The schema-valid
    // 64-character option needs four, so it takes the marquee path.
    show({ dialog: { modal: {
      kind: "choices",
      fiber: "long-choice",
      prompt: han(0, 100),
      options: [label],
      index: 0,
      cancellable: false,
    } } });
    let row = find(tree(), "rpgkit-choice-0")!;
    expect(textOf(row)).toBe(prefixed);
    expect(textOf(row).at(-1), "the underlying row keeps its final character").toBe("Z");
    const marqueeText = textNodes(row)[0]!;
    const overflow = Math.ceil(measure(prefixed) - choiceWidth);
    expect(overflow).toBeGreaterThan(0);
    expect(offsetOf(marqueeText)).toBe(0);

    // The selected row paints in accent inside the 232 px content window,
    // never in the six-pixel paper padding between it and the right frame.
    const initial = world.render().slice();
    expect(colourPixels(initial, DEFAULT_UI_THEME.accent, 228, 0, choiceWidth, 174)).toBeGreaterThan(0);
    expect(colourPixels(initial, DEFAULT_UI_THEME.accent, 460, 0, 6, 174)).toBe(0);

    for (let i = 0; i < MARQUEE_HOLD + overflow * MARQUEE_TICKS_PER_PX; i++) frame();
    row = find(tree(), "rpgkit-choice-0")!;
    const terminalText = textNodes(row)[0]!;
    expect(offsetOf(terminalText), "terminal choice marquee offset").toBe(overflow);
    expect(measure(prefixed) - offsetOf(terminalText), "choice final character is inside the clip").toBeLessThanOrEqual(choiceWidth);
    expect(textOf(terminalText).at(-1)).toBe("Z");
  });

  test("CommandGrid: only a label too long for two 10 px rows is clipped, at 10 px, and still holds the whole label", () => {
    show({ grid: { cells: CELLS, index: 0, tick: 0 } });
    const root = tree();
    expectNoEllipsis(root);
    for (const [cell, label] of [[2, CLIPPED], [3, CLIPPED_CJK]] as const) {
      // Two 10 px rows do not hold it: clipping is the last step.
      expect(breakText(label, labelWidth(XS2), at(XS2)).length).toBeGreaterThan(2);
      expect(textOf(marquee(root, cell))).toBe(label);
      expect(slotOf(marquee(root, cell))).toBe(XS2);
      expect(cellTexts(root, cell).map((t) => t.slot)).toEqual([XS2, XS2]);
      expect(measure(label, XS2)).toBeGreaterThan(labelWidth(XS2));
    }
    // Nothing is drawn past the clip: right of the unfocused cell 3's clip
    // (prefix "  " at 10 px) the paper is clean.
    const fb = world.render().slice();
    const clipRight = CELL_X[1]! + measure("  ", XS2) + labelWidth(XS2);
    for (let y = 36; y < 54; y++) {
      for (let x = Math.ceil(clipRight); x < 468; x++) expect(rgbaAt(fb, x, y), `(${x},${y})`).toBe(DEFAULT_UI_THEME.paper);
    }
  });

  test("the focused clipped label scrolls with the caller's tick until its last character shows", () => {
    show({ grid: { cells: CELLS, index: 2, tick: 0 } });
    let root = tree();
    const overflow = measure(CLIPPED, XS2) - labelWidth(XS2);
    const cycle = 2 * MARQUEE_HOLD + Math.ceil(overflow) * MARQUEE_TICKS_PER_PX;
    const offsets: number[] = [];
    for (let tick = 0; tick <= cycle; tick++) {
      show({ grid: { cells: CELLS, index: 2, tick } });
      offsets.push(offsetOf(marquee(root, 2)));
      expect(offsetOf(marquee(root, 2))).toBe(marqueeOffset(overflow, tick));
      // The unfocused clipped cell shows its first characters, unmoved.
      expect(offsetOf(marquee(root, 3))).toBe(0);
    }
    expect(Math.min(...offsets)).toBe(0);
    // At the far end the label's last character is inside the clip.
    expect(Math.max(...offsets)).toBe(Math.ceil(overflow));
    expect(measure(CLIPPED, XS2) - Math.max(...offsets)).toBeLessThanOrEqual(labelWidth(XS2));

    // Focus moves to the Chinese label: it scrolls, the Latin one rests.
    const overflowCjk = measure(CLIPPED_CJK, XS2) - labelWidth(XS2);
    const cycleCjk = 2 * MARQUEE_HOLD + Math.ceil(overflowCjk) * MARQUEE_TICKS_PER_PX;
    let farthest = 0;
    for (let tick = 0; tick <= cycleCjk; tick++) {
      show({ grid: { cells: CELLS, index: 3, tick } });
      farthest = Math.max(farthest, offsetOf(marquee(root, 3)));
      expect(offsetOf(marquee(root, 2))).toBe(0);
    }
    expect(farthest).toBe(Math.ceil(overflowCjk));
    root = tree();
    expect(textOf(marquee(root, 3))).toBe(CLIPPED_CJK);
  });

  test("without a tick prop the grid's own clock runs only while the focused cell overflows", () => {
    // Focus on a label that fits: frames cost nothing.
    show({ grid: { cells: CELLS, index: 0 } });
    frame();
    ops = 0;
    for (let f = 0; f < 120; f++) frame();
    expect(ops, "host ops over 120 idle frames").toBe(0);

    // Focus on the clipped label: it rests, scrolls to its end, rests.
    show({ grid: { cells: CELLS, index: 2 } });
    const root = tree();
    const overflow = Math.ceil(measure(CLIPPED, XS2) - labelWidth(XS2));
    let farthest = 0;
    structuralOps = 0;
    for (let f = 0; f < MARQUEE_HOLD + overflow * MARQUEE_TICKS_PER_PX + 5; f++) {
      frame();
      farthest = Math.max(farthest, offsetOf(marquee(root, 2)));
      expect(offsetOf(marquee(root, 3))).toBe(0);
    }
    expect(farthest).toBe(overflow);
    expect(structuralOps, "the marquee only moves a node").toBe(0);

    // Back on a fitting label: the clock stops, the scrolled label resets.
    show({ grid: { cells: CELLS, index: 0 } });
    frame();
    expect(offsetOf(marquee(root, 2))).toBe(0);
    ops = 0;
    for (let f = 0; f < 60; f++) frame();
    expect(ops).toBe(0);

    // A grid whose labels all fit after the size step has nothing to
    // scroll, focused or not: no clock, no ops.
    show({ grid: { cells: SHRINK_CELLS, index: 2 } });
    frame();
    ops = 0;
    for (let f = 0; f < 60; f++) frame();
    expect(ops, "host ops over 60 frames on a shrunk label").toBe(0);
  });

  // -- SaveMenu -------------------------------------------------------------

  const SAVE_TITLE = "THE CHRONICLES OF THE SUNKEN CATHEDRAL BENEATH THE LAKE OF GLASS - SAVE YOUR JOURNEY";
  const LONG_MAP = "the-very-long-map-identifier-of-the-sunken-cathedral-beneath-the-lake-of-glass";
  const CJK_MAP = han(5, 60);
  const SLOTS = [
    { slot: 1, map: LONG_MAP, frame: 1200, checksum: "0" },
    { slot: 2, map: CJK_MAP, frame: 77, checksum: "0" },
    { slot: 3, map: "hub", frame: 5, checksum: "0" },
  ];

  /** The text-sm rows a SaveMenu Text draws ("\n"-separated). */
  const rowsOf = (root: TreeNode, name: string): string[] => textOf(find(root, name)).split("\n");
  const panelTop = (fb: Uint8Array): number => {
    for (let y = 0; y < H; y++) if (rgbaAt(fb, 240, y) === DEFAULT_UI_THEME.border) return y;
    return -1;
  };

  /** Raw RGB cells for adjacent glyphs. Repeated missing-glyph boxes have
   * identical cells; distinct baked Chinese glyphs do not. */
  const glyphCells = (fb: Uint8Array, text: string, x: number, y: number): string[] => {
    const cells: string[] = [];
    let left = x;
    for (const glyph of text) {
      const width = Math.round(measure(glyph, 1));
      let cell = "";
      for (let py = y; py < y + 18; py++) {
        for (let px = Math.round(left); px < Math.round(left) + width; px++) cell += rgbaAt(fb, px, py);
      }
      cells.push(cell);
      left += measure(glyph, 1);
    }
    return cells;
  };

  test("SaveMenu wraps the root title onto more rows", () => {
    show({ save: { menu: { kind: "root", index: 0 }, slots: SLOTS, title: SAVE_TITLE } });
    const root = tree();
    expectNoEllipsis(root);
    const rows = rowsOf(root, "rpgkit-save-title");
    expect(rows.length).toBe(2);
    expect(dense(rows.join(""))).toBe(dense(SAVE_TITLE));
    for (const row of rows) expect(measure(row, 1)).toBeLessThanOrEqual(400);
    expect(panelTop(world.render().slice())).toBe((H - 232) / 2);
  });

  test("SaveMenu slot summaries wrap; three wrapped slots still fit the 232 px panel", () => {
    show({ save: { menu: { kind: "slots-load", index: 1 }, slots: SLOTS } });
    const root = tree();
    expectNoEllipsis(root);
    for (let row = 0; row < 3; row++) {
      const info = SLOTS[row]!;
      const slot = find(root, `rpgkit-slot-${row}`)!;
      const summary = `${info.map}  f${info.frame}`;
      const shown = row === 2 ? textOf(slot).slice(`  3. `.length) : textOf(find(root, `rpgkit-slot-${row}-summary`));
      // The first summary wraps to two rows; the 60-character CJK summary
      // exceeds the two-row budget and scrolls sideways (one row, full text).
      if (row === 0) {
        expect(shown.split("\n").length).toBeGreaterThan(1);
        expect(textNodes(slot).map(textOf)[0]).toBe(`  ${row + 1}. `);
      }
      expect(dense(shown)).toBe(dense(summary));
    }
    expect(panelTop(world.render().slice())).toBe((H - 232) / 2);
  });

  test("SaveMenu shows the full Chinese autosave label above read-only load slots", () => {
    show({
      save: {
        menu: { kind: "slots-load", index: 0 },
        slots: SLOTS,
        autosave: { slot: 0, map: LONG_MAP, frame: 9876, checksum: "auto" },
        uiText: { "save.autosave": "自动存档" },
      },
    });
    const root = tree();
    expectNoEllipsis(root);
    const row = find(root, "rpgkit-autosave-slot")!;
    expect(dense(textOf(row))).toContain(dense(`> 自动存档: ${LONG_MAP}  f9876`));
    expect(find(root, "rpgkit-slot-0")).toBeDefined();
    const fb = world.render().slice();
    const top = panelTop(fb);
    expect(top).toBeGreaterThanOrEqual(8);
    // 420 px panel: 2 px border + 8 px padding; title is 18 px followed by
    // a 6 px gap. The four label glyphs must not be one repeated tofu box.
    const cells = glyphCells(fb, "自动存档", 40 + measure("> ", 1), top + 10 + 18 + 6);
    expect(new Set(cells).size, "autosave label draws four distinct Chinese glyphs").toBe(4);
  });

  test("SaveMenu message title and body wrap, and the panel grows when they need it", () => {
    const title = "SAVED TO SLOT 1 OF THE SUNKEN CATHEDRAL ARCHIVE AFTER A VERY LONG DAY";
    const body = "Your progress is stored on the memory stick; do not remove it while the light blinks, or it may be lost.";
    show({ save: { menu: { kind: "message", title, body, back: { kind: "root", index: 0 } }, slots: SLOTS } });
    let root = tree();
    expectNoEllipsis(root);
    expect(dense(rowsOf(root, "rpgkit-message-title").join(""))).toBe(dense(title));
    expect(dense(rowsOf(root, "rpgkit-message-body").join(""))).toBe(dense(body));
    expect(panelTop(world.render().slice())).toBe((H - 232) / 2);

    // A title and body longer than the panel's row budgets scroll sideways
    // (marquee) instead of pushing the panel off the 272 px viewport.
    const longTitle = `${title} ${title}`;
    const longBody = `${body} ${body} ${body} ${body} ${body}`;
    show({ save: { menu: { kind: "message", title: longTitle, body: longBody, back: { kind: "root", index: 0 } }, slots: SLOTS } });
    root = tree();
    const titleRows = rowsOf(root, "rpgkit-message-title");
    const bodyRows = rowsOf(root, "rpgkit-message-body");
    expect(dense(titleRows.join(""))).toBe(dense(longTitle));
    expect(dense(bodyRows.join(""))).toBe(dense(longBody));
    // The panel stays inside the 272 px viewport (it is capped at 256 px).
    const top = panelTop(world.render().slice());
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(20);
  });
});
