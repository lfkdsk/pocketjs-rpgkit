// Every schema uiText value at its own maximum, drawn by the real ui-text
// fixture.  Text is read from host setText ops (the devtools tree may shorten
// it), and marquee completion is proved from the real Text node translation.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { decodeStyleTable, PROP, type DecodedStyleTable } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { unpack } from "../vendor/pocketjs/framework/compiler/pak.ts";
import schema from "../src/data/schema.json";
import { formatUiText, type UiTextKey, type UiTextTable } from "../src/engine/ui-text.ts";
import { MARQUEE_HOLD, MARQUEE_TICKS_PER_PX } from "../src/ui/list-window.ts";
import { MAP_ID, ZH_UI_TEXT } from "./fixtures/ui-text/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("ui-text");
if (!preflight.ok) console.warn(`ui-text schema-max test skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const W = 480;
const H = 272;
type Route =
  | "idle" | "shop-message" | "shop-buy" | "shop-sell"
  | "save-root" | "save-slots-save" | "save-slots-load" | "save-message"
  | "save-export" | "save-import" | "name"
  | "demo-menu" | "demo-autoplay" | "demo-empty" | "demo-busy" | "demo-toast"
  | "demo-runtime-error" | "demo-attract" | "demo-control" | "demo-rewind"
  | "boot-choose" | "boot-autoplay" | "boot-map" | "boot-xy" | "boot-speed"
  | "fatal";

interface CaseSpec {
  route: Route;
  target: string;
  panel: string;
  control: string;
  params?: Readonly<Record<string, string | number>>;
}

// This is deliberately exhaustive at the type level. A UiTextKey addition,
// removal, typo, or duplicate intent has to be reconciled with a real screen.
const CASES = {
  "legend.talk": { route: "idle", target: "ui-text-talk-legend", panel: "ui-text-talk-legend", control: "ui-text-statbar" },
  "legend.next": { route: "shop-message", target: "rpgkit-message-legend", panel: "rpgkit-message-box", control: "rpgkit-message-legend" },
  "legend.ok": { route: "shop-buy", target: "rpgkit-shop-legend", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0" },
  "legend.back": { route: "shop-buy", target: "rpgkit-shop-legend", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0" },
  "shop.buy": { route: "shop-buy", target: "rpgkit-shop-stage", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0" },
  "shop.sell": { route: "shop-sell", target: "rpgkit-shop-stage", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0" },
  "shop.gold": { route: "shop-buy", target: "rpgkit-shop-gold", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0", params: { gold: 500 } },
  "shop.rowSell": { route: "shop-buy", target: "rpgkit-shop-row-2", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0" },
  "shop.rowLeave": { route: "shop-buy", target: "rpgkit-shop-row-3", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0" },
  "shop.rowBack": { route: "shop-sell", target: "rpgkit-shop-row-1", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0" },
  "shop.price": { route: "shop-buy", target: "rpgkit-shop-row-0", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0", params: { price: 30 } },
  "shop.priceStock": { route: "shop-buy", target: "rpgkit-shop-row-1", panel: "rpgkit-shop-box", control: "rpgkit-shop-row-0", params: { price: 200, stock: 3 } },
  "demo.badge": { route: "demo-attract", target: "rpgkit-demo-badge", panel: "rpgkit-demo-badge", control: "rpgkit-demo-badge" },
  "demo.control": { route: "demo-control", target: "rpgkit-control-notice", panel: "rpgkit-control-notice", control: "rpgkit-control-notice" },
  "demo.rewind": { route: "demo-rewind", target: "rpgkit-rewind-notice", panel: "rpgkit-rewind-notice", control: "rpgkit-rewind-notice", params: { seconds: 3 } },
  "error.event": { route: "fatal", target: "rpgkit-fatal-error-title", panel: "rpgkit-fatal-error", control: "rpgkit-fatal-error-message" },
  "save.title": { route: "save-root", target: "rpgkit-save-title", panel: "rpgkit-save-panel", control: "rpgkit-save-root-0" },
  "save.toSlot": { route: "save-root", target: "rpgkit-save-root-0", panel: "rpgkit-save-panel", control: "rpgkit-save-root-0" },
  "save.fromSlot": { route: "save-root", target: "rpgkit-save-root-1", panel: "rpgkit-save-panel", control: "rpgkit-save-root-0" },
  "save.codeExport": { route: "save-root", target: "rpgkit-save-root-2", panel: "rpgkit-save-panel", control: "rpgkit-save-root-0" },
  "save.codeImport": { route: "save-root", target: "rpgkit-save-root-3", panel: "rpgkit-save-panel", control: "rpgkit-save-root-0" },
  "save.slotsSaveTitle": { route: "save-slots-save", target: "rpgkit-slot-title", panel: "rpgkit-save-panel", control: "rpgkit-slot-0" },
  "save.slotsLoadTitle": { route: "save-slots-load", target: "rpgkit-slot-title", panel: "rpgkit-save-panel", control: "rpgkit-slot-0" },
  "save.autosave": { route: "save-slots-load", target: "rpgkit-autosave-slot", panel: "rpgkit-save-panel", control: "rpgkit-slot-0" },
  "save.slotEmpty": { route: "save-slots-save", target: "rpgkit-slot-0", panel: "rpgkit-save-panel", control: "rpgkit-slot-0" },
  "save.slotDamaged": { route: "save-slots-save", target: "rpgkit-slot-1", panel: "rpgkit-save-panel", control: "rpgkit-slot-0" },
  "save.slotSummary": { route: "save-slots-save", target: "rpgkit-slot-2", panel: "rpgkit-save-panel", control: "rpgkit-slot-0", params: { map: MAP_ID, frame: 4321 } },
  "save.emptyTitle": { route: "save-message", target: "rpgkit-message-title", panel: "rpgkit-save-panel", control: "rpgkit-message-legend", params: { slot: 1 } },
  "save.emptyBody": { route: "save-message", target: "rpgkit-message-body", panel: "rpgkit-save-panel", control: "rpgkit-message-legend" },
  "save.codeTitle": { route: "save-export", target: "rpgkit-code-title", panel: "rpgkit-save-panel", control: "rpgkit-code-row", params: { page: 1, pages: 2 } },
  "save.codeHint": { route: "save-export", target: "rpgkit-code-hint", panel: "rpgkit-save-panel", control: "rpgkit-code-row" },
  "save.importTitle": { route: "save-import", target: "rpgkit-import-title", panel: "rpgkit-save-panel", control: "rpgkit-import-hint" },
  "save.importHint": { route: "save-import", target: "rpgkit-import-hint", panel: "rpgkit-save-panel", control: "rpgkit-import-title" },
  "nameInput.title": { route: "name", target: "rpgkit-name-input-panel", panel: "rpgkit-name-input-panel", control: "rpgkit-name-input-cell-69" },
  "nameInput.back": { route: "name", target: "rpgkit-name-input-cell-67", panel: "rpgkit-name-input-panel", control: "rpgkit-name-input-cell-69" },
  "nameInput.ok": { route: "name", target: "rpgkit-name-input-cell-68", panel: "rpgkit-name-input-panel", control: "rpgkit-name-input-cell-69" },
  "nameInput.cancel": { route: "name", target: "rpgkit-name-input-cell-69", panel: "rpgkit-name-input-panel", control: "rpgkit-name-input-cell-67" },
  "demo.menuTitle": { route: "demo-menu", target: "rpgkit-demo-menu-title", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.tabChapters": { route: "demo-menu", target: "rpgkit-demo-menu-tabs", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.tabWarp": { route: "demo-menu", target: "rpgkit-demo-menu-tabs", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.tabAutoplay": { route: "demo-menu", target: "rpgkit-demo-menu-tabs", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.tabSelected": { route: "demo-menu", target: "rpgkit-demo-menu-tabs", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend", params: { tab: ZH_UI_TEXT["demo.tabChapters"] } },
  "demo.empty": { route: "demo-empty", target: "rpgkit-demo-menu-empty", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.speed": { route: "demo-autoplay", target: "rpgkit-demo-menu-row-speed", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend", params: { speed: 1 } },
  "demo.speedHint": { route: "demo-autoplay", target: "rpgkit-demo-menu-row-speed", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.legend": { route: "demo-menu", target: "rpgkit-demo-menu-legend", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-row-first" },
  "demo.legendBack": { route: "demo-runtime-error", target: "rpgkit-demo-menu-legend", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-error-body" },
  "demo.loading": { route: "demo-busy", target: "rpgkit-demo-menu-legend", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-title" },
  "demo.warped": { route: "demo-toast", target: "rpgkit-demo-toast", panel: "rpgkit-demo-toast", control: "rpgkit-demo-toast" },
  "demo.error": { route: "demo-runtime-error", target: "rpgkit-demo-menu-error-title", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.badLink": { route: "boot-map", target: "rpgkit-demo-menu-error-title", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.errorUnknownChapter": { route: "demo-runtime-error", target: "rpgkit-demo-menu-error-body", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend", params: { id: '"nowhere"' } },
  "demo.errorUnknownMap": { route: "boot-map", target: "rpgkit-demo-menu-error-body", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend", params: { id: '"nowhere"' } },
  "demo.errorUnknownAutoplay": { route: "boot-autoplay", target: "rpgkit-demo-menu-error-body", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend", params: { id: '"nowhere"' } },
  "demo.errorXY": { route: "boot-xy", target: "rpgkit-demo-menu-error-body", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.badLinkChooseOne": { route: "boot-choose", target: "rpgkit-demo-menu-error-body", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "demo.badLinkSpeed": { route: "boot-speed", target: "rpgkit-demo-menu-error-body", panel: "rpgkit-demo-menu-panel", control: "rpgkit-demo-menu-legend" },
  "battle.statValue": { route: "save-root", target: "ui-text-statbar", panel: "ui-text-statbar", control: "ui-text-statbar", params: { current: 37, max: 120 } },
} satisfies Record<UiTextKey, CaseSpec>;

const UI_TEXT_SCHEMA = (schema as {
  properties: { uiText: { properties: Record<UiTextKey, { maxLength: number }> } };
}).properties.uiText.properties;
const SCHEMA_KEYS = Object.keys(UI_TEXT_SCHEMA) as UiTextKey[];
const VERIFIED_KEYS = new Set<UiTextKey>();
const routeKeys = (route: Route): UiTextKey[] => SCHEMA_KEYS.filter((key) => CASES[key].route === route);

interface TreeNode { i: number; t: string; n?: string; k?: TreeNode[] }
interface Rect { x: number; y: number; w: number; h: number }
interface Recording {
  texts: Map<number, string>;
  translateX: Map<number, number>;
  styleIds: Map<number, number>;
  styles: DecodedStyleTable;
  ops: {
    debugInspect(id: number): void;
    debugRectXY(): number;
    debugRectWH(): number;
    measureText(text: string, slot: number): number;
  };
}

function find(node: TreeNode, name: string): TreeNode | undefined {
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const hit = find(child, name);
    if (hit) return hit;
  }
  return undefined;
}

function directText(node: TreeNode, recording: Recording): string {
  return (node.k ?? []).filter((child) => child.t === "#text").map((child) => recording.texts.get(child.i) ?? "").join("");
}

function fullText(node: TreeNode, recording: Recording): string {
  if (node.t === "#text") return recording.texts.get(node.i) ?? "";
  return directText(node, recording) + (node.k ?? []).filter((child) => child.t !== "#text").map((child) => fullText(child, recording)).join("");
}

const dense = (value: string): string => value.replace(/\s/g, "");

function textElement(node: TreeNode, recording: Recording, expected: string): TreeNode | undefined {
  const own = directText(node, recording);
  if (own && dense(own).includes(dense(expected))) return node;
  for (const child of node.k ?? []) {
    if (child.t === "#text") continue;
    const hit = textElement(child, recording, expected);
    if (hit) return hit;
  }
  return undefined;
}

function numericStyle(recording: Recording, node: TreeNode, prop: number): number | undefined {
  const styleId = recording.styleIds.get(node.i);
  const value = styleId === undefined
    ? undefined
    : recording.styles.styles[styleId]?.base?.find((property) => property.prop === prop)?.value;
  return typeof value === "number" ? value : undefined;
}

function liveTextElement(
  world: BoundGameWorld,
  recording: Recording,
  targetName: string,
  expected: string,
): TreeNode {
  const target = find(world.getTree() as TreeNode, targetName);
  expect(target, `live target ${targetName}`).toBeDefined();
  const element = textElement(target!, recording, expected);
  expect(element, `live Text in ${targetName}`).toBeDefined();
  return element!;
}

function liveTranslateX(
  world: BoundGameWorld,
  recording: Recording,
  targetName: string,
  expected: string,
): number {
  const element = liveTextElement(world, recording, targetName, expected);
  return recording.translateX.get(element.i) ?? numericStyle(recording, element, PROP.translateX) ?? 0;
}

function parentOf(node: TreeNode, id: number): TreeNode | undefined {
  for (const child of node.k ?? []) {
    if (child.i === id) return node;
    const hit = parentOf(child, id);
    if (hit) return hit;
  }
  return undefined;
}

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let i = 0; i < frames; i++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function tap(world: BoundGameWorld, button: number): void {
  pump(world, 1, button);
  pump(world, 2);
}

async function boot(scenario: string, globals: Record<string, unknown> = {}): Promise<[BoundGameWorld, Recording]> {
  const texts = new Map<number, string>();
  const translateX = new Map<number, number>();
  const styleIds = new Map<number, number>();
  let host!: Recording["ops"];
  const world = await bootGameWorld(appBundle("ui-text"), 60, { __uiTextScenario: scenario, ...globals }, (ops) => {
    host = ops as unknown as Recording["ops"];
    for (const [name, original] of Object.entries(ops)) {
      if (typeof original !== "function") continue;
      ops[name] = (...args: unknown[]) => {
        if (name === "setText" || name === "replaceText") texts.set(args[0] as number, args[1] as string);
        if (name === "setProp" && args[1] === PROP.translateX) translateX.set(args[0] as number, args[2] as number);
        if (name === "setStyle") styleIds.set(args[0] as number, args[1] as number);
        return (original as (...values: unknown[]) => unknown).apply(ops, args);
      };
    }
  });
  pump(world, 30);
  const styleBlob = unpack(readFileSync(`${appBundle("ui-text")}.pak`)).find((entry) => entry.key === "ui:styles")!;
  return [world, { texts, translateX, styleIds, styles: decodeStyleTable(styleBlob.data), ops: host }];
}

function marker(key: UiTextKey): string {
  const max = UI_TEXT_SCHEMA[key].maxLength;
  const tokens = [...ZH_UI_TEXT[key].matchAll(/\{[A-Za-z][A-Za-z0-9]*\}/g)].map((match) => match[0]).join("");
  // 上/下 are already baked by the fixture and make both ends observable;
  // placeholders remain inside (and count toward) the schema-sized value.
  const value = `上${tokens}${"的".repeat(max - tokens.length - 2)}下`;
  expect(value.length, `${key} BMP marker length`).toBe(max);
  expect([...value].every((ch) => ch.length === 1), `${key} marker is BMP`).toBe(true);
  return value;
}

function unpackRect(xy: number, wh: number): Rect {
  const signed16 = (n: number): number => (n << 16) >> 16;
  return { x: signed16(xy), y: signed16(xy >>> 16), w: wh & 0xffff, h: (wh >>> 16) & 0xffff };
}

function paintedRect(world: BoundGameWorld, recording: Recording, node: TreeNode, label: string): Rect {
  recording.ops.debugInspect(node.i);
  world.render();
  const xy = recording.ops.debugRectXY();
  const wh = recording.ops.debugRectWH();
  recording.ops.debugInspect(0);
  expect(xy, `${label} is painted`).not.toBe(-1);
  return unpackRect(xy, wh);
}

function visibleDescendantRect(world: BoundGameWorld, recording: Recording, node: TreeNode, label: string): Rect {
  recording.ops.debugInspect(node.i);
  world.render();
  const xy = recording.ops.debugRectXY();
  const wh = recording.ops.debugRectWH();
  recording.ops.debugInspect(0);
  if (xy !== -1) {
    const rect = unpackRect(xy, wh);
    if (rect.w > 0 && rect.h > 0) return rect;
  }
  for (const child of node.k ?? []) {
    if (child.t === "#text") continue;
    try {
      return visibleDescendantRect(world, recording, child, label);
    } catch { /* try the next painted descendant */ }
  }
  throw new Error(`${label} has no painted descendant`);
}

function expectInViewport(rect: Rect, label: string): void {
  expect(rect.x, `${label} left`).toBeGreaterThanOrEqual(0);
  expect(rect.y, `${label} top`).toBeGreaterThanOrEqual(0);
  expect(rect.w, `${label} width`).toBeGreaterThan(0);
  expect(rect.h, `${label} height`).toBeGreaterThan(0);
  expect(rect.x + rect.w, `${label} right`).toBeLessThanOrEqual(W);
  expect(rect.y + rect.h, `${label} bottom`).toBeLessThanOrEqual(H);
}

function setMarker(world: BoundGameWorld, key: UiTextKey, value: string): void {
  (globalThis as unknown as { __uiTextSetProp(t: Partial<UiTextTable>): void }).__uiTextSetProp({ [key]: value });
  pump(world, 2);
}

/** Prove one key is complete either as reconstructed wrapped text, or by
 * driving its actual Text node to the marquee's terminal offset. */
function verify(world: BoundGameWorld, recording: Recording, key: UiTextKey, alreadySet = false): void {
  const spec: CaseSpec = CASES[key];
  const template = marker(key);
  if (!alreadySet) setMarker(world, key, template);
  const root = world.getTree() as TreeNode;
  const target = find(root, spec.target);
  expect(target, `${key} target ${spec.target}`).toBeDefined();

  let expected: string;
  if (key === "demo.badge") {
    const drawn = fullText(target!, recording);
    const pattern = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace("\\{frame\\}", "\\d{3}")
      .replace("\\{frames\\}", "600");
    expect(dense(drawn), `${key} formats the live frame and tape length`).toMatch(new RegExp(`^${pattern}$`));
    expected = drawn;
  } else {
    expected = formatUiText(template, spec.params ?? {});
  }
  expect(dense(fullText(target!, recording)), `${key} complete underlying text`).toContain(dense(expected));

  const element = textElement(target!, recording, expected);
  expect(element, `${key} underlying Text node`).toBeDefined();
  // Reading getTree/setText alone also sees display:none subtrees. The stat
  // fixture intentionally hides this node until the save root is open, so
  // inspect the actual Text instead of accepting its retained tree value.
  if (key === "battle.statValue") paintedRect(world, recording, element!, `${key} underlying Text`);
  // A freshly mounted marquee may carry translateX in its initial style
  // table before it ever needs a setProp update. Treat either source as the
  // real marquee signal so a remount cannot accidentally take the weaker
  // wrapped-text assertion path.
  const translated = recording.translateX.has(element!.i) || numericStyle(recording, element!, PROP.translateX) !== undefined;
  if (translated) {
    const parent = parentOf(root, element!.i);
    expect(parent, `${key} marquee clip parent`).toBeDefined();
    const clipWidthFromLayout = key === "nameInput.back" || key === "nameInput.ok" || key === "nameInput.cancel"
      ? 36
      : undefined;
    const clipBox = clipWidthFromLayout === undefined
      ? paintedRect(world, recording, parent!, `${key} marquee clip`)
      : undefined;
    const slot = numericStyle(recording, element!, PROP.fontSlot);
    expect(slot, `${key} marquee font slot`).toBeDefined();
    let overflow: number;
    let fullMeasure: number;
    let clipBudget: number;
    if (key === "demo.speed") {
      const cursorWidth = Math.max(recording.ops.measureText("> ", 1), recording.ops.measureText("  ", 1));
      fullMeasure = recording.ops.measureText(expected, 1);
      clipBudget = 410 - 120 - 12 - cursorWidth;
      overflow = fullMeasure - clipBudget;
    } else {
      fullMeasure = recording.ops.measureText(directText(element!, recording), slot!);
      clipBudget = clipWidthFromLayout ?? clipBox!.w;
      overflow = fullMeasure - clipBudget;
    }
    overflow = Math.max(0, overflow);
    expect(overflow, `${key} marquee overflow`).toBeGreaterThan(0);
    // A reused screen owns one clock for all of its cells. Synchronise to
    // this cell's real start (without assuming a fresh component), then use
    // the documented start-to-terminal duration exactly.
    const cycle = 2 * MARQUEE_HOLD + Math.ceil(overflow) * MARQUEE_TICKS_PER_PX;
    for (let frame = 0; Math.abs(liveTranslateX(world, recording, spec.target, expected)) !== 0 && frame <= cycle; frame++) pump(world, 1);
    expect(Math.abs(liveTranslateX(world, recording, spec.target, expected)), `${key} marquee reaches its start`).toBe(0);
    pump(world, MARQUEE_HOLD + Math.ceil(overflow) * MARQUEE_TICKS_PER_PX);
    const terminalElement = liveTextElement(world, recording, spec.target, expected);
    const terminalOffset = -liveTranslateX(world, recording, spec.target, expected);
    expect(terminalOffset, `${key} terminal translateX`).toBe(Math.ceil(overflow));
    expect(fullMeasure - terminalOffset, `${key} final character is inside the clip`).toBeLessThanOrEqual(clipBudget);
    expect(dense(directText(terminalElement, recording)), `${key} terminal keeps full text`).toContain(dense(expected));
  } else {
    expect(dense(fullText(target!, recording)), `${key} wrapped reconstruction`).toContain(dense(expected));
  }

  const latest = world.getTree() as TreeNode;
  const panel = find(latest, spec.panel);
  const control = find(latest, spec.control);
  expect(panel, `${key} panel ${spec.panel}`).toBeDefined();
  expect(control, `${key} critical control ${spec.control}`).toBeDefined();
  const panelRect = visibleDescendantRect(world, recording, panel!, `${key} panel`);
  expectInViewport(panelRect, `${key} panel`);
  expect(fullText(control!, recording).length, `${key} named critical control has content`).toBeGreaterThan(0);
  let controlRect: Rect;
  try {
    controlRect = visibleDescendantRect(world, recording, control!, `${key} critical control`);
  } catch {
    // Some layout-only named Views have no independently painted AABB; the
    // containing painted panel is their viewport bound.
    controlRect = panelRect;
  }
  expectInViewport(controlRect, `${key} critical control`);
  VERIFIED_KEYS.add(key);
}

function verifyRoute(world: BoundGameWorld, recording: Recording, route: Route): void {
  for (const key of routeKeys(route)) verify(world, recording, key);
}

simDescribe("all schema uiText values render at maxLength", () => {
  test("the schema iteration and exhaustive screen map cover exactly all 58 keys", () => {
    expect(SCHEMA_KEYS).toHaveLength(58);
    expect(new Set(SCHEMA_KEYS)).toEqual(new Set(Object.keys(CASES) as UiTextKey[]));
    for (const key of SCHEMA_KEYS) {
      expect(Number.isSafeInteger(UI_TEXT_SCHEMA[key].maxLength), `${key} maxLength is an integer`).toBe(true);
      expect(UI_TEXT_SCHEMA[key].maxLength, `${key} maxLength is positive`).toBeGreaterThan(1);
    }
  });

  test("idle, shop buy/sell, and message legend", async () => {
    let [world, recording] = await boot("idle");
    verifyRoute(world, recording, "idle");
    [world, recording] = await boot("shop");
    verifyRoute(world, recording, "shop-message");
    tap(world, BTN.CIRCLE);
    pump(world, 8);
    verifyRoute(world, recording, "shop-buy");
    tap(world, BTN.DOWN);
    tap(world, BTN.DOWN);
    tap(world, BTN.CIRCLE);
    pump(world, 3);
    verifyRoute(world, recording, "shop-sell");
  });

  test("save root, save/load slots, message, export, and import", async () => {
    let [world, recording] = await boot("idle");
    tap(world, BTN.START);
    verifyRoute(world, recording, "save-root");
    tap(world, BTN.CIRCLE);
    verifyRoute(world, recording, "save-slots-save");

    [world, recording] = await boot("idle");
    tap(world, BTN.START); tap(world, BTN.DOWN); tap(world, BTN.CIRCLE);
    verifyRoute(world, recording, "save-slots-load");
    // menuStep materialises this message when the empty slot is chosen, so
    // each template must be installed independently before that transition.
    for (const key of routeKeys("save-message")) {
      [world, recording] = await boot("idle");
      tap(world, BTN.START); tap(world, BTN.DOWN); tap(world, BTN.CIRCLE);
      setMarker(world, key, marker(key));
      // The read-only autosave is the first load row; move to empty manual
      // slot 1 before asserting the empty-slot message templates.
      tap(world, BTN.DOWN);
      tap(world, BTN.CIRCLE);
      verify(world, recording, key, true);
    }

    [world, recording] = await boot("idle");
    tap(world, BTN.START); tap(world, BTN.DOWN); tap(world, BTN.DOWN); tap(world, BTN.CIRCLE);
    verifyRoute(world, recording, "save-export");

    [world, recording] = await boot("idle");
    tap(world, BTN.START); tap(world, BTN.DOWN); tap(world, BTN.DOWN); tap(world, BTN.DOWN); tap(world, BTN.CIRCLE);
    verifyRoute(world, recording, "save-import");
  });

  for (const key of routeKeys("name")) {
    test(`name input: ${key} at maxLength`, async () => {
      const [world, recording] = await boot("name");
      const action = ["nameInput.back", "nameInput.ok", "nameInput.cancel"].indexOf(key);
      if (action >= 0) {
        // The 70-entry grid wraps: from index 0, LEFT 3/2/1 lands exactly
        // on BACK/OK/CANCEL (67/68/69) without row-boundary assumptions.
        for (let i = 0; i < 3 - action; i++) tap(world, BTN.LEFT);
        const scene = world.probes().state.scene as unknown as { state: { cursor: number } };
        expect(scene.state.cursor, `${key} is focused`).toBe(67 + action);
      }
      verify(world, recording, key);
    });
  }

  test("demo normal menu, autoplay, runtime error, empty, busy, and toast", async () => {
    let [world, recording] = await boot("demo");
    tap(world, BTN.SELECT);
    verifyRoute(world, recording, "demo-menu");
    tap(world, BTN.RIGHT); tap(world, BTN.RIGHT);
    verifyRoute(world, recording, "demo-autoplay");
    (globalThis as unknown as { __rpgkitDemo: { jump(id: string): void } }).__rpgkitDemo.jump("nowhere");
    pump(world, 2);
    verifyRoute(world, recording, "demo-runtime-error");

    [world, recording] = await boot("demo-empty", { __rpgkitBoot: { chapter: "nowhere" } });
    tap(world, BTN.CROSS);
    verifyRoute(world, recording, "demo-empty");

    [world, recording] = await boot("demo");
    tap(world, BTN.SELECT); tap(world, BTN.RIGHT); tap(world, BTN.DOWN); tap(world, BTN.CIRCLE); pump(world, 2);
    verifyRoute(world, recording, "demo-busy");

    [world, recording] = await boot("demo");
    tap(world, BTN.SELECT); tap(world, BTN.RIGHT); tap(world, BTN.CIRCLE); pump(world, 3);
    verifyRoute(world, recording, "demo-toast");
  });

  test("attract badge, takeover, and rewind notices", async () => {
    const [world, recording] = await boot("demo");
    pump(world, 610);
    verifyRoute(world, recording, "demo-attract");
    tap(world, BTN.RIGHT);
    verifyRoute(world, recording, "demo-control");
    pump(world, 130);
    tap(world, BTN.LTRIGGER);
    verifyRoute(world, recording, "demo-rewind");
  });

  test("all boot-link error variants", async () => {
    const boots: readonly [Route, Record<string, unknown>][] = [
      ["boot-choose", { chapter: "x", map: "y" }],
      ["boot-autoplay", { autoplay: "nowhere" }],
      ["boot-map", { map: "nowhere" }],
      ["boot-xy", { map: MAP_ID, x: 1 }],
      ["boot-speed", { speed: 1 }],
    ];
    for (const [route, directive] of boots) {
      const [world, recording] = await boot("demo-empty", { __rpgkitBoot: directive });
      verifyRoute(world, recording, route);
    }
  });

  test("fatal event-error screen", async () => {
    const [world, recording] = await boot("error");
    verifyRoute(world, recording, "fatal");
  });

  afterAll(() => {
    expect(VERIFIED_KEYS, "every schema key reached its real screen and passed the full assertion set")
      .toEqual(new Set(SCHEMA_KEYS));
  });
});
