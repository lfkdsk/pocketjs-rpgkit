// tests/ui-text-sim.test.ts — the kit's interface words replaced by a
// game, rendered through the real GameView on the deterministic wasm sim
// host (tests/fixtures/ui-text). The fixture's project carries a Chinese
// `uiText` for every key (fixture-data.ts ZH_UI_TEXT); the test opens the
// shop, the save menu overlay (every page), the name input, the demo menu,
// the attract chrome and the event-error screen, and checks that:
//
// - every replaced word is what the kit draws (the tree's text, with the
//   placeholders filled in), and no screen still shows the English default;
// - no drawn string carries an ellipsis the kit added;
// - a translation wider than its box wraps onto more rows (row widths
//   measured by the core) and the rows are painted (pixel checks), instead
//   of being cut;
// - a key the table leaves out keeps its English default, and GameView's
//   `uiText` prop wins over the project's.
//
// Goldens pin one frame per screen (UI_TEXT_UPDATE_GOLDENS=1 rewrites them).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { KIT_UI_TEXT, formatUiText, type UiTextKey, type UiTextTable } from "../src/engine/ui-text.ts";
import { SAVE_MENU_UI_TEXT } from "../src/engine/save-menu.ts";
import { NAME_INPUT_UI_TEXT } from "../src/engine/name-input.ts";
import { DEMO_MENU_UI_TEXT } from "../src/ui/demo/text.ts";
import { STAT_BAR_UI_TEXT } from "../src/ui/battle/text.ts";
import { DEFAULT_UI_THEME } from "../src/ui/theme.ts";
import { checkAppCjkFont } from "../tools/lib/cjk-font.ts";
import { appTextInventory } from "../tools/lib/text-inventory.ts";
import { MAP_ID, MAP_ID_2, SAVE_CODE, ZH_UI_TEXT } from "./fixtures/ui-text/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("ui-text");
if (!preflight.ok) console.warn(`ui text sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const W = 480;
const H = 272;
const ZH: UiTextTable = ZH_UI_TEXT;
const ENGLISH: UiTextTable = {
  ...KIT_UI_TEXT,
  ...SAVE_MENU_UI_TEXT,
  ...NAME_INPUT_UI_TEXT,
  ...DEMO_MENU_UI_TEXT,
  ...STAT_BAR_UI_TEXT,
};

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

function findNodeWhere(node: TreeNode, pred: (n: TreeNode) => boolean): TreeNode | null {
  if (pred(node)) return node;
  for (const child of node.k ?? []) {
    const hit = findNodeWhere(child, pred);
    if (hit) return hit;
  }
  return null;
}

function nodeText(node: TreeNode | null): string {
  if (!node) return "";
  if (node.t === "#text") return node.x ?? "";
  return (node.k ?? []).map(nodeText).join("");
}

function allTexts(node: TreeNode, out: string[] = []): string[] {
  if (node.t === "#text" && node.x) out.push(node.x);
  for (const child of node.k ?? []) allTexts(child, out);
  return out;
}

function measure(text: string, slot = 0): number {
  const ops = (globalThis as unknown as { ui: { measureText(s: string, slot: number): number } }).ui;
  return ops.measureText(text, slot);
}

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function tap(world: BoundGameWorld, button: number): void {
  pump(world, 1, button);
  pump(world, 2);
}

async function boot(scenario: string, globals: Record<string, unknown> = {}): Promise<BoundGameWorld> {
  const world = await bootGameWorld(appBundle("ui-text"), 60, { __uiTextScenario: scenario, ...globals });
  pump(world, 30);
  return world;
}

/** The text of the node named `name`, in the latest frame's tree. */
function text(world: BoundGameWorld, name: string): string {
  const node = findNode(world.getTree() as TreeNode, name);
  expect(node, `node ${name}`).not.toBeNull();
  return nodeText(node);
}

/** A wrapped string read back: rows joined, the cursor prefix and the
 *  indent of continuation rows dropped. */
function dense(drawn: string): string {
  return drawn.split("\n").map((row) => row.replace(/^(> |  )/, "")).join("");
}

/** Every row slot of the shop box, in order. */
function shopRows(world: BoundGameWorld): string[] {
  const tree = world.getTree() as TreeNode;
  const rows: string[] = [];
  for (let slot = 0; ; slot++) {
    const node = findNode(tree, `rpgkit-shop-row-${slot}`);
    if (!node) return rows;
    rows.push(nodeText(node));
  }
}

const covered = new Set<UiTextKey>();

/** The node draws `key`'s Chinese text (filled with `params`). Returns the
 *  drawn rows. */
function expectWord(world: BoundGameWorld, name: string, key: UiTextKey, params: Record<string, string | number> = {}): string[] {
  const drawn = text(world, name);
  const want = formatUiText(ZH[key], params);
  expect(dense(drawn), `${name} draws ${key}`).toContain(want);
  covered.add(key);
  return drawn.split("\n");
}

/** Nothing anywhere in the tree is an English default this screen shows,
 *  and no drawn string has an ellipsis. */
function expectNoEnglish(world: BoundGameWorld, keys: readonly UiTextKey[]): void {
  const drawn = allTexts(world.getTree() as TreeNode);
  for (const value of drawn) expect(value.includes("…"), `ellipsis in ${JSON.stringify(value)}`).toBe(false);
  for (const key of keys) {
    const english = formatUiText(ENGLISH[key], {}).replace(/\{.*$/, "").trim();
    if (english.length < 3) continue;
    for (const value of drawn) expect(value.includes(english), `English ${key} in ${JSON.stringify(value)}`).toBe(false);
  }
}

type Rgba = readonly [number, number, number];
const hex = (value: string): Rgba => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];
const PAPER = hex(DEFAULT_UI_THEME.paper);
/** The name-input panel's background (COLOURS.panelBg). */
const PANEL_BG: Rgba = [0x14, 0x1c, 0x30];

/** Pixels in the rectangle that differ from `bg`: glyph strokes. */
function inkPixels(frame: Uint8Array, x0: number, y0: number, w: number, h: number, bg: Rgba): number {
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      if (frame[i] !== bg[0] || frame[i + 1] !== bg[1] || frame[i + 2] !== bg[2]) count++;
    }
  }
  return count;
}

/** Pixels in the rectangle that exactly match `colour`. */
function colourPixels(frame: Uint8Array, x0: number, y0: number, w: number, h: number, colour: Rgba): number {
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      if (frame[i] === colour[0] && frame[i + 1] === colour[1] && frame[i + 2] === colour[2]) count++;
    }
  }
  return count;
}

function pixel(frame: Uint8Array, x: number, y: number): number[] {
  const i = (y * W + x) * 4;
  return [frame[i]!, frame[i + 1]!, frame[i + 2]!];
}

/** First row at or below `from` in column `x` that has colour `c`. */
function firstRow(frame: Uint8Array, x: number, from: number, c: Rgba): number {
  for (let y = from; y < H; y++) if (pixel(frame, x, y).every((v, i) => v === c[i])) return y;
  return -1;
}

async function golden(name: string, frame: Uint8Array): Promise<void> {
  const url = new URL(`./goldens/ui-text.${name}.png`, import.meta.url);
  if (process.env.UI_TEXT_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, W, H));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame, `golden ${name}`).toEqual(decodePng(bytes).rgba);
}

simDescribe("a game's words replace the kit's", () => {
  test("the fixture's font subset covers every Chinese word", () => {
    const app = join(import.meta.dir, "fixtures", "ui-text");
    expect(checkAppCjkFont(app, appTextInventory({ entries: [join(app, "ui-text.tsx")] }))).toEqual([]);
  });

  test("shop: stage, gold, prices, rows and legends", async () => {
    const world = await boot("shop");
    // The welcome message, then its legend.
    pump(world, 30);
    expectWord(world, "rpgkit-message-legend", "legend.next");
    tap(world, BTN.CIRCLE);
    pump(world, 10);
    expectWord(world, "rpgkit-shop-stage", "shop.buy");
    expectWord(world, "rpgkit-shop-gold", "shop.gold", { gold: 500 });
    expectWord(world, "rpgkit-shop-legend", "legend.ok");
    expectWord(world, "rpgkit-shop-legend", "legend.back");
    const rows = shopRows(world);
    expect(rows[0]).toBe(`> 伤药${formatUiText(ZH["shop.price"], { price: 30 })}`);
    expect(rows[1]).toBe(`  捕捉球${formatUiText(ZH["shop.priceStock"], { price: 200, stock: 3 })}`);
    covered.add("shop.price").add("shop.priceStock");
    expect(rows[2]).toBe(`  ${ZH["shop.rowSell"]}`);
    covered.add("shop.rowSell");
    // "Leave" in Chinese is wider than the box: it takes two rows, every
    // row fits the 230 px list column after the cursor, nothing is lost.
    const leave = rows.slice(3).filter((row) => row.trim() !== "");
    expect(leave.length).toBe(2);
    expect(dense(leave.join("\n"))).toBe(ZH["shop.rowLeave"]);
    covered.add("shop.rowLeave");
    for (const row of leave) expect(measure(row)).toBeLessThanOrEqual(248 - 2 * (2 + 6));
    expectNoEnglish(world, ["shop.buy", "shop.rowSell", "shop.rowLeave", "legend.ok", "legend.back"]);
    const frame = world.render().slice();
    // The box is capped to the viewport: 16 frame + 14 header + 4 gap +
    // 5 item rows (the wrapped "Leave" label takes two) + 16 legend =
    // 120 px, so its top border sits at 174 - 120 = 54 (>= 8, on screen).
    expect(firstRow(frame, 400, 40, hex(DEFAULT_UI_THEME.border))).toBe(54);
    await golden("shop-buy", frame);

    // The sell stage: header and the back row.
    tap(world, BTN.DOWN);
    tap(world, BTN.DOWN);
    tap(world, BTN.CIRCLE);
    pump(world, 4);
    expectWord(world, "rpgkit-shop-stage", "shop.sell");
    const sellRows = shopRows(world);
    expect(sellRows.some((row) => dense(row) === ZH["shop.rowBack"])).toBe(true);
    covered.add("shop.rowBack");
    expectNoEnglish(world, ["shop.sell", "shop.rowBack"]);
  });

  test("save menu overlay: every page, the empty-slot message and the stat readout", async () => {
    const world = await boot("idle");
    // With no modal open, the overlay's footer draws the talk legend.
    expect(text(world, "ui-text-talk-legend")).toContain(ZH["legend.talk"]);
    covered.add("legend.talk");
    tap(world, BTN.START);
    // This fixture deliberately shows the StatBar only while the save menu
    // is open; assert its words on a frame where the node is actually drawn.
    expectWord(world, "ui-text-statbar", "battle.statValue", { current: 37, max: 120 });
    expectWord(world, "rpgkit-save-title", "save.title");
    expectWord(world, "rpgkit-save-root-0", "save.toSlot");
    expectWord(world, "rpgkit-save-root-1", "save.fromSlot");
    expectWord(world, "rpgkit-save-root-2", "save.codeExport");
    expectWord(world, "rpgkit-save-root-3", "save.codeImport");
    expectNoEnglish(world, ["save.title", "save.toSlot", "save.fromSlot", "save.codeExport", "save.codeImport"]);

    // Root rows remain mounted while the reducer moves its cursor. Both the
    // prefix and painted accent must follow DOWN and UP on the next frame.
    const accent = hex(DEFAULT_UI_THEME.accent);
    const expectRootCursor = (index: number): void => {
      for (let row = 0; row < 4; row++) {
        expect(text(world, `rpgkit-save-root-${row}`).startsWith(row === index ? "> " : "  "), `root row ${row} prefix`).toBe(true);
        const pixels = colourPixels(world.render().slice(), 40, 54 + row * 20, 400, 20, accent);
        if (row === index) expect(pixels, `selected root row ${row} is highlighted`).toBeGreaterThan(0);
        else expect(pixels, `idle root row ${row} has no accent ink`).toBe(0);
      }
    };
    expectRootCursor(0);
    tap(world, BTN.DOWN);
    expectRootCursor(1);
    tap(world, BTN.UP);
    expectRootCursor(0);
    await golden("save-root", world.render().slice());

    tap(world, BTN.CIRCLE);
    expectWord(world, "rpgkit-slot-title", "save.slotsSaveTitle");
    expectWord(world, "rpgkit-slot-0", "save.slotEmpty");
    expectWord(world, "rpgkit-slot-1", "save.slotDamaged");
    expectWord(world, "rpgkit-slot-2", "save.slotSummary", { map: MAP_ID, frame: 4321 });
    expectNoEnglish(world, ["save.slotsSaveTitle", "save.slotEmpty", "save.slotDamaged"]);
    await golden("save-slots", world.render().slice());

    tap(world, BTN.CROSS);
    tap(world, BTN.DOWN);
    tap(world, BTN.CIRCLE);
    expectWord(world, "rpgkit-slot-title", "save.slotsLoadTitle");
    expectWord(world, "rpgkit-autosave-slot", "save.autosave");
    // Slot 1 is empty: menuStep words the message from the same table.
    tap(world, BTN.DOWN);
    tap(world, BTN.CIRCLE);
    expectWord(world, "rpgkit-message-title", "save.emptyTitle", { slot: 1 });
    expectWord(world, "rpgkit-message-body", "save.emptyBody");
    expectNoEnglish(world, ["save.emptyTitle", "save.emptyBody"]);

    tap(world, BTN.CIRCLE);
    tap(world, BTN.CROSS);
    tap(world, BTN.DOWN);
    tap(world, BTN.CIRCLE);
    expectWord(world, "rpgkit-code-title", "save.codeTitle", { page: 1, pages: 2 });
    // The hint is wider than the panel: two rows, each within it, both
    // painted above the panel's bottom padding.
    const hint = expectWord(world, "rpgkit-code-hint", "save.codeHint");
    expect(hint.length).toBe(2);
    for (const row of hint) expect(measure(row)).toBeLessThanOrEqual(420 - 2 * (2 + 8));
    expect(text(world, "rpgkit-code-row")).toBe(SAVE_CODE.slice(0, 24));
    expectNoEnglish(world, ["save.codeTitle", "save.codeHint"]);
    const exportFrame = world.render().slice();
    // Panel: 420x232 centred, so its paper's bottom content edge is at
    // 20 + 232 - 10 = 242; the two hint rows sit in the 29 px above it.
    expect(inkPixels(exportFrame, 40, 242 - 14, 380, 14, PAPER)).toBeGreaterThan(40);
    expect(inkPixels(exportFrame, 40, 242 - 29, 380, 15, PAPER)).toBeGreaterThan(40);
    await golden("save-code", exportFrame);
    tap(world, BTN.DOWN);
    expectWord(world, "rpgkit-code-title", "save.codeTitle", { page: 2, pages: 2 });

    tap(world, BTN.CROSS);
    tap(world, BTN.DOWN);
    tap(world, BTN.CIRCLE);
    expectWord(world, "rpgkit-import-title", "save.importTitle");
    expectWord(world, "rpgkit-import-hint", "save.importHint");
    expectNoEnglish(world, ["save.importTitle", "save.importHint"]);
  });

  test("name input: the default caption wraps and pushes the grid down; action cells", async () => {
    const world = await boot("name");
    pump(world, 10);
    const title = expectWord(world, "rpgkit-name-input-panel", "nameInput.title");
    // The panel's own text is the caption only; its first rows are the
    // wrapped caption (the edit box and cells are child nodes).
    expect(title.length).toBeGreaterThanOrEqual(2);
    const cells = [67, 68, 69].map((index) => text(world, `rpgkit-name-input-cell-${index}`));
    expect(cells).toEqual([ZH["nameInput.back"], ZH["nameInput.ok"], ZH["nameInput.cancel"]]);
    covered.add("nameInput.back").add("nameInput.ok").add("nameInput.cancel");
    const frame = world.render().slice();
    // Caption rows at y 16 and 34 (panel top 10 + 6, 18 px rows) are both
    // painted; the edit box (#0b1626) moved from y 38 to 56.
    const panelBg: Rgba = [0x14, 0x1c, 0x30];
    expect(inkPixels(frame, 32, 16, 416, 18, panelBg)).toBeGreaterThan(40);
    expect(inkPixels(frame, 32, 34, 416, 18, panelBg)).toBeGreaterThan(40);
    expect(pixel(frame, 300, 50)).toEqual([...panelBg]);
    expect(pixel(frame, 300, 60)).toEqual([0x0b, 0x16, 0x26]);
    await golden("name-input", frame);
  });

  test("event-error screen title", async () => {
    const world = await boot("error");
    pump(world, 10);
    expectWord(world, "rpgkit-fatal-error-title", "error.event");
    expectNoEnglish(world, ["error.event"]);
  });

  test("demo menu: title, tabs, rows, the wrapped legend, error and toast", async () => {
    const world = await boot("demo");
    tap(world, BTN.SELECT);
    expectWord(world, "rpgkit-demo-menu-title", "demo.menuTitle");
    expectWord(world, "rpgkit-demo-menu-tabs", "demo.tabSelected", { tab: ZH["demo.tabChapters"] });
    expectWord(world, "rpgkit-demo-menu-tabs", "demo.tabWarp");
    expectWord(world, "rpgkit-demo-menu-tabs", "demo.tabAutoplay");
    covered.add("demo.tabChapters");
    const legend = expectWord(world, "rpgkit-demo-menu-legend", "demo.legend");
    expect(legend.length).toBe(2);
    for (const row of legend) expect(measure(row)).toBeLessThanOrEqual(430 - 2 * (2 + 8));
    expectNoEnglish(world, ["demo.menuTitle", "demo.tabChapters", "demo.tabWarp", "demo.tabAutoplay", "demo.legend"]);
    const frame = world.render().slice();
    // The panel grew one 14 px legend row: 242 + 14 = 256 px, centred, so
    // its bottom border row is at 8 + 256 - 1 = 263 and the legend's
    // second row (the last 14 px above the 10 px frame) is painted.
    expect(firstRow(frame, 240, 200, hex(DEFAULT_UI_THEME.border))).toBe(262);
    expect(inkPixels(frame, 30, 263 - 1 - 8 - 14, 400, 14, PAPER)).toBeGreaterThan(20);
    await golden("demo-menu", frame);

    tap(world, BTN.RIGHT);
    tap(world, BTN.RIGHT);
    expectWord(world, "rpgkit-demo-menu-row-speed", "demo.speed", { speed: 1 });
    expectWord(world, "rpgkit-demo-menu-row-speed", "demo.speedHint");
    await golden("demo-autoplay", world.render().slice());

    // Warp: the toast after the menu closes.
    tap(world, BTN.LEFT);
    tap(world, BTN.CIRCLE);
    pump(world, 4);
    expectWord(world, "rpgkit-demo-toast", "demo.warped");
    expectNoEnglish(world, ["demo.warped"]);

    // An error page: its title, the wrapped body and the back legend.
    (globalThis as unknown as { __rpgkitDemo: { jump(id: string): void } }).__rpgkitDemo.jump("nowhere");
    pump(world, 2);
    expectWord(world, "rpgkit-demo-menu-error-title", "demo.error");
    expectWord(world, "rpgkit-demo-menu-error-body", "demo.errorUnknownChapter", { id: '"nowhere"' });
    expectWord(world, "rpgkit-demo-menu-legend", "demo.legendBack");
    expectNoEnglish(world, ["demo.error", "demo.legendBack"]);
  });

  test("demo menu: a warp to a not-yet-prepared map shows the loading legend", async () => {
    const world = await boot("demo");
    tap(world, BTN.SELECT);
    // The warp tab lists both maps; the second is not prepared (the sharded
    // source defers it), so selecting it enters the busy state.
    tap(world, BTN.RIGHT);
    tap(world, BTN.DOWN);
    tap(world, BTN.CIRCLE);
    pump(world, 2);
    expectWord(world, "rpgkit-demo-menu-legend", "demo.loading");
    covered.add("demo.loading");
  });

  test("demo boot errors draw the table's templates, not fixed English", async () => {
    const cases: readonly (readonly [Record<string, unknown>, UiTextKey, Record<string, string>])[] = [
      [{ chapter: "x", map: "y" }, "demo.badLinkChooseOne", {}],
      [{ autoplay: "nowhere" }, "demo.errorUnknownAutoplay", { id: '"nowhere"' }],
      [{ map: "nowhere" }, "demo.errorUnknownMap", { id: '"nowhere"' }],
      [{ map: "ui-text-field", x: 1 }, "demo.errorXY", {}],
      [{ speed: 1 }, "demo.badLinkSpeed", {}],
    ];
    for (const [bootDirective, key, params] of cases) {
      const world = await boot("demo-empty", { __rpgkitBoot: bootDirective });
      expectWord(world, "rpgkit-demo-menu-error-body", key, params);
      covered.add(key);
    }
  });

  test("demo menu: an empty page and a bad boot link", async () => {
    const world = await boot("demo-empty", { __rpgkitBoot: { chapter: "nowhere" } });
    expectWord(world, "rpgkit-demo-menu-error-title", "demo.badLink");
    expectWord(world, "rpgkit-demo-menu-error-body", "demo.errorUnknownChapter", { id: '"nowhere"' });
    covered.add("demo.errorUnknownChapter");
    tap(world, BTN.CROSS);
    const tree = world.getTree() as TreeNode;
    expect(allTexts(tree).some((value) => dense(value) === ZH["demo.empty"])).toBe(true);
    covered.add("demo.empty");
    expectNoEnglish(world, ["demo.badLink", "demo.empty"]);
  });

  test("attract chrome: badge, takeover and rewind notices", async () => {
    const world = await boot("demo");
    pump(world, 640);
    // "演示 {frame}/{frames}": the tape frame, zero-padded, then its length.
    expect(text(world, "rpgkit-demo-badge")).toMatch(/^演示 \d{3}\/600$/);
    covered.add("demo.badge");
    tap(world, BTN.RIGHT);
    expectWord(world, "rpgkit-control-notice", "demo.control");
    pump(world, 200);
    tap(world, BTN.LTRIGGER);
    expectWord(world, "rpgkit-rewind-notice", "demo.rewind", { seconds: 3 });
    expectNoEnglish(world, ["demo.control", "demo.rewind"]);
  });

  test("a partial table keeps English for the keys it leaves out; the prop wins over the project", async () => {
    const partial = await boot("shop", { __uiTextTable: "partial" });
    pump(partial, 30);
    tap(partial, BTN.CIRCLE);
    pump(partial, 10);
    expect(text(partial, "rpgkit-shop-stage")).toBe(ZH["shop.buy"]);
    expect(text(partial, "rpgkit-shop-gold")).toBe(formatUiText(ZH["shop.gold"], { gold: 500 }));
    expect(text(partial, "rpgkit-shop-row-0")).toBe("> 伤药30g");
    expect(text(partial, "rpgkit-shop-row-1")).toBe("  捕捉球200g (3)");
    expect(text(partial, "rpgkit-shop-row-2")).toBe("  Sell");
    expect(text(partial, "rpgkit-shop-row-3")).toBe("  Leave");
    expect(text(partial, "rpgkit-shop-legend")).toContain("ok");

    const layered = await boot("shop", { __uiTextProp: { "shop.buy": "BUY NOW", "legend.next": "MORE" } });
    pump(layered, 30);
    expect(text(layered, "rpgkit-message-legend")).toContain("MORE");
    tap(layered, BTN.CIRCLE);
    pump(layered, 10);
    expect(text(layered, "rpgkit-shop-stage")).toBe("BUY NOW");
    expect(text(layered, "rpgkit-shop-gold")).toBe(formatUiText(ZH["shop.gold"], { gold: 500 }));

    const english = await boot("idle", { __uiTextTable: "none" });
    tap(english, BTN.START);
    expect(text(english, "rpgkit-save-title")).toBe(ENGLISH["save.title"]);
    expect(text(english, "rpgkit-save-root-0")).toBe(`> ${ENGLISH["save.toSlot"]}`);
    expect(text(english, "ui-text-statbar")).toBe("37 / 120");
  });

  test("the uiText prop switches language at run time: the next frame draws the new words", async () => {
    const world = await boot("shop");
    pump(world, 30);
    // The welcome message's legend is the Chinese "next" label.
    expect(text(world, "rpgkit-message-legend")).toContain(ZH["legend.next"]);
    tap(world, BTN.CIRCLE);
    pump(world, 10);
    expect(text(world, "rpgkit-shop-stage")).toBe(ZH["shop.buy"]);

    // Swap the prop at run time (no remount): the shop stage, the legend
    // and the attract badge all follow on the next frame.
    (globalThis as unknown as { __uiTextSetProp: (t: Partial<UiTextTable>) => void }).__uiTextSetProp({
      "shop.buy": "BUY NOW",
      "legend.next": "MORE",
      "legend.ok": "OKAY",
      "demo.badge": "TAPE {frame}/{frames}",
    });
    pump(world, 2);
    expect(text(world, "rpgkit-shop-stage")).toBe("BUY NOW");
    expect(text(world, "rpgkit-shop-legend")).toContain("OKAY");
    // A key the new table leaves out keeps the project's Chinese.
    expect(text(world, "rpgkit-shop-gold")).toBe(formatUiText(ZH["shop.gold"], { gold: 500 }));

    // The attract badge (repaints every frame) follows the prop too.
    const demo = await boot("demo");
    pump(demo, 640);
    expect(text(demo, "rpgkit-demo-badge")).toMatch(/^演示 \d{3}\/600$/);
    (globalThis as unknown as { __uiTextSetProp: (t: Partial<UiTextTable>) => void }).__uiTextSetProp({
      "demo.badge": "TAPE {frame}/{frames}",
    });
    pump(demo, 2);
    expect(text(demo, "rpgkit-demo-badge")).toMatch(/^TAPE \d{3}\/600$/);
  });

  test("long translations in fixed cells paint their ink inside the cell, not cut", async () => {
    // Name-input action cells: a label longer than the 40 px cell takes the
    // CommandGrid ladder (two 10 px rows); every glyph's ink stays inside
    // the cell's 40x20 rect.
    const name = await boot("name");
    pump(name, 10);
    (globalThis as unknown as { __uiTextSetProp: (t: Partial<UiTextTable>) => void }).__uiTextSetProp({
      "nameInput.back": "删除这个字符",
      "nameInput.ok": "确认保存这个名字",
      "nameInput.cancel": "取消并返回",
    });
    pump(name, 2);
    const nameFrame = name.render().slice();
    // The action cells are the last three grid cells (67..69): row 6 of the
    // 10-column grid, which sits at y = 80 + drop(18) + 6*20 = 218, each
    // 40 px wide. Each cell paints its ladder-fitted label; no ink spills
    // past the panel's right content edge (x 440).
    for (const col of [7, 8, 9]) {
      const x0 = 40 + col * 40;
      expect(inkPixels(nameFrame, x0 + 2, 218, 36, 20, PANEL_BG)).toBeGreaterThan(10);
    }
    expect(inkPixels(nameFrame, 444, 218, 12, 20, PANEL_BG)).toBe(0);

    // StatBar readout in a fixed 80 px cell: a long template wraps to two
    // rows (the tree carries both, so neither is cut).
    const idle = await boot("idle");
    tap(idle, BTN.START);
    (globalThis as unknown as { __uiTextSetProp: (t: Partial<UiTextTable>) => void }).__uiTextSetProp({
      "battle.statValue": "生命{current}／{max}，注意回复",
    });
    pump(idle, 2);
    const statRows = text(idle, "ui-text-statbar").split("\n");
    expect(statRows.length).toBeGreaterThan(1);
    expect(dense(statRows.join("\n"))).toContain("生命");
    covered.add("battle.statValue");

    // Shop gold: a long gold readout wraps in its header column; the second
    // row's ink is painted below the first (the header grew).
    const shop = await boot("shop");
    pump(shop, 30);
    tap(shop, BTN.CIRCLE);
    pump(shop, 10);
    (globalThis as unknown as { __uiTextSetProp: (t: Partial<UiTextTable>) => void }).__uiTextSetProp({
      "shop.gold": "你当前持有的金币数量是：{gold}",
    });
    pump(shop, 2);
    const goldRows = text(shop, "rpgkit-shop-gold").split("\n");
    expect(goldRows.length).toBeGreaterThan(1);
    const shopFrame = shop.render().slice();
    // The gold column is the right 110 px of the 248 px box (x 358..464);
    // the header's first and second rows both paint ink.
    expect(inkPixels(shopFrame, 358, 66, 106, 14, PAPER)).toBeGreaterThan(5);
    expect(inkPixels(shopFrame, 358, 80, 106, 14, PAPER)).toBeGreaterThan(5);
  });

  test("every key was checked on some screen", () => {
    // Runs after the screens above (tests in a file run in order).
    const missing = (Object.keys(ZH) as UiTextKey[]).filter((key) => !covered.has(key));
    expect(missing).toEqual([]);
  });
});
