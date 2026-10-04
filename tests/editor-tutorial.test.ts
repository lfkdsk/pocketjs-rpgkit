// Guard test for docs/editor-tutorial.md. The suites below drive the
// headless editor through the tutorial's steps 3-5 and run its step 7 CLI
// commands, so the document goes red if it drifts from the implementation.

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import {
  eventToolButtons,
  fittedView,
  headerButtons,
  HEADER_H,
  paletteSlotOrigin,
  STATUS_H,
  TILE,
} from "../editor/engine/layout.ts";
import {
  createEventInspectorLayout,
  type EventInspectorLayout,
  type InspectorControl,
} from "../editor/engine/event-layout.ts";
import { createMapInspectorLayout } from "../editor/engine/map-layout.ts";
import { commandInspectorRows, conditionFields } from "../editor/engine/event-fields.ts";
import type { InspectorConditionRow } from "../editor/engine/event-layout.ts";
import { playtestDebugRows } from "../editor/engine/playtest.ts";
import { playtestPanelRect, playtestRowRect } from "../editor/engine/playtest-layout.ts";
import type { Page, Project } from "../src/engine/types.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import { appPreflight } from "./helpers/boot.ts";
import {
  bootEditorWorld,
  installEditorSimIsolation,
  type BoundEditorWorld,
} from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor tutorial tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const W = 720;
const H = 480;
const SUNSTONE = BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!;
const ROOT = resolve(import.meta.dir, "..");
const EDIT_CLI = join(ROOT, "tools", "rpgkit-edit", "cli.ts");
const CHECK_CLI = join(ROOT, "tools", "rpgkit-check", "cli.ts");

type World = BoundEditorWorld;
let live: World | null = null;
const probes = () => live!.probes();

// Mirrors flattenInspectorConditions for the `all` clauses the editor's
// condition-add prompt produces (the UI module pulls a JSX runtime the test
// bundle does not alias).
function flattenConditions(page: Page | undefined): InspectorConditionRow[] {
  const all = page?.condition?.all;
  if (!all) return [];
  return all.map((clause, index) => ({
    key: `all:${index}`,
    kind: clause.kind,
    summary: "",
    source: { kind: "all" as const, index },
    fields: conditionFields(clause),
  }));
}

function frame(world: World): void {
  world.frame(0);
  world.tick();
}

async function bootSvc(inbox: string[], outbox: string[]): Promise<World> {
  const world = await bootEditorWorld(
    60,
    undefined,
    (ops) => {
      ops.svcOpen = () => true;
      ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
      ops.svcSend = (line: string) => outbox.push(line);
    },
    { width: W, height: H },
  );
  live = world;
  for (let i = 0; i < 4; i++) frame(world);
  return world;
}

function line(inbox: string[], world: World, value: object): void {
  inbox.push(JSON.stringify(value));
  frame(world);
}
function click(inbox: string[], world: World, x: number, y: number): void {
  line(inbox, world, { t: "mouse", x, y, d: true });
  line(inbox, world, { t: "mouse", x, y, d: false });
}
function typeText(inbox: string[], world: World, text: string): void {
  line(inbox, world, { t: "ch", s: text });
}
function key(inbox: string[], world: World, k: string, cmd = false): void {
  line(inbox, world, { t: "key", k, cmd, sh: false, alt: false, ctl: cmd });
}
function press(world: World, mask: number): void {
  world.frame(mask);
  world.tick();
  world.frame(0);
  world.tick();
}
function idle(world: World, frames: number): void {
  for (let i = 0; i < frames; i++) frame(world);
}

const header = new Map<string, { x: number; y: number; w: number; h: number }>(
  headerButtons(W).map((b) => [b.id, b]),
);
function headerCenter(id: string): [number, number] {
  const b = header.get(id)!;
  return [b.x + Math.floor(b.w / 2), b.y + Math.floor(b.h / 2)];
}
function cellPoint(tx: number, ty: number): [number, number] {
  const f = fittedView(W, H, false).frame;
  return [f.x + tx * TILE + 8, f.y + ty * TILE + 8];
}
function paletteSlot(slot: number): [number, number] {
  const o = paletteSlotOrigin(slot);
  return [o.x + 6, HEADER_H + o.y + 6];
}
function eventToolPoint(id: "new" | "edit" | "copy" | "delete"): [number, number] {
  const b = eventToolButtons().find((c) => c.id === id)!;
  return [b.x + Math.floor(b.w / 2), HEADER_H + b.y + Math.floor(b.h / 2)];
}
function clickControl(inbox: string[], world: World, control: { rect: { x: number; y: number; w: number; h: number } }): void {
  click(inbox, world, control.rect.x + Math.floor(control.rect.w / 2), HEADER_H + control.rect.y + Math.floor(control.rect.h / 2));
}

let cmdScroll = 0;
function inspectorLayout(): EventInspectorLayout {
  const s = probes().state().editor;
  const map = s.project.maps[s.mapIndex]!;
  const event = map.events.find((e: any) => e.id === s.selectedEventId)!;
  const page = event.pages[s.selectedPageIndex]!;
  return createEventInspectorLayout({
    width: W,
    height: H - HEADER_H - STATUS_H,
    pageCount: event.pages.length,
    activePage: s.selectedPageIndex,
    conditions: flattenConditions(page),
    commands: commandInspectorRows(page.commands),
    scroll: { pagesX: 0, conditionsY: 0, commandsY: cmdScroll },
    // The app sizes rows of fields that draw their hint with the baked font.
    measure: (text) => (globalThis as unknown as { ui: { measureText(s: string, slot: number): number } }).ui.measureText(text, 0),
  });
}
function allControls(layout: EventInspectorLayout): InspectorControl[] {
  return [
    ...layout.eventFields,
    ...layout.pageFields,
    ...layout.conditionRows.flatMap((r) => r.fields),
    ...layout.commandRows.flatMap((r) => r.fields),
  ];
}
function fieldKey(key: string) {
  return (c: InspectorControl) =>
    (c.action as { kind: string; field?: string }).kind.endsWith("-field") &&
    (c.action as { field?: string }).field === key;
}
function clickField(inbox: string[], world: World, pred: (c: InspectorControl) => boolean): void {
  let layout = inspectorLayout();
  let control = allControls(layout).find(pred);
  expect(control).toBeDefined();
  let guard = 0;
  while (control!.rect.y + control!.rect.h > layout.commandClip.y + layout.commandClip.h && guard++ < 12) {
    line(inbox, world, { t: "scroll", dy: 1 });
    cmdScroll += 36;
    layout = inspectorLayout();
    control = allControls(layout).find(pred);
    expect(control).toBeDefined();
  }
  clickControl(inbox, world, control!);
}
function setTextField(inbox: string[], world: World, pred: (c: InspectorControl) => boolean, text: string): void {
  clickField(inbox, world, pred);
  for (let i = 0; i < 24; i++) key(inbox, world, "Backspace");
  typeText(inbox, world, text);
  key(inbox, world, "Enter");
}
function addCommand(inbox: string[], world: World, op: string): void {
  const layout = inspectorLayout();
  const add = layout.commandActions.find((a) => a.action.kind === "command-action" && a.action.action === "add")!;
  clickControl(inbox, world, add);
  typeText(inbox, world, op);
  key(inbox, world, "Enter");
}
function addCondition(inbox: string[], world: World, kind: string): void {
  const layout = inspectorLayout();
  const add = layout.conditionActions.find((a) => a.action.kind === "condition-action" && a.action.action === "add")!;
  clickControl(inbox, world, add);
  typeText(inbox, world, kind);
  key(inbox, world, "Enter");
}
function addPage(inbox: string[], world: World): void {
  const layout = inspectorLayout();
  const add = layout.pageActions.find((a) => a.action.kind === "page-action" && a.action.action === "add")!;
  clickControl(inbox, world, add);
  cmdScroll = 0;
}
function selectCommandRow(inbox: string[], world: World, pred: (row: any) => boolean): void {
  const s = probes().state().editor;
  const map = s.project.maps[s.mapIndex]!;
  const event = map.events.find((e: any) => e.id === s.selectedEventId)!;
  const page = event.pages[s.selectedPageIndex]!;
  const index = commandInspectorRows(page.commands).findIndex((r) => pred(r));
  expect(index).toBeGreaterThanOrEqual(0);
  // Scroll the command list until the row's header is inside its clip.
  let layout = inspectorLayout();
  let geo = layout.commandRows.find((r) => r.row === index)!;
  let guard = 0;
  while (geo.header.rect.y < layout.commandClip.y && cmdScroll > 0 && guard++ < 24) {
    line(inbox, world, { t: "scroll", dy: -1 });
    cmdScroll = Math.max(0, cmdScroll - 36);
    layout = inspectorLayout();
    geo = layout.commandRows.find((r) => r.row === index)!;
  }
  while (geo.header.rect.y + geo.header.rect.h > layout.commandClip.y + layout.commandClip.h && guard++ < 24) {
    line(inbox, world, { t: "scroll", dy: 1 });
    cmdScroll += 36;
    layout = inspectorLayout();
    geo = layout.commandRows.find((r) => r.row === index)!;
  }
  clickControl(inbox, world, geo.header);
}
function enterEventMode(inbox: string[], world: World): void {
  click(inbox, world, ...headerCenter("layer")); // ground -> upper
  click(inbox, world, ...headerCenter("layer")); // upper -> passage
  click(inbox, world, ...headerCenter("layer")); // passage -> events
  expect(probes().state().eventMode).toBe(true);
}

/** Build the tutorial's Greeter NPC through the event inspector. */
function buildGreeter(inbox: string[], world: World): void {
  enterEventMode(inbox, world);
  click(inbox, world, ...cellPoint(9, 8));
  click(inbox, world, ...eventToolPoint("new"));
  expect(probes().state().inspectorOpen).toBe(true);

  setTextField(inbox, world, fieldKey("name"), "Greeter");
  setTextField(inbox, world, fieldKey("sprite"), "villager");
  clickField(inbox, world, fieldKey("blocks"));

  addCommand(inbox, world, "text");
  setTextField(inbox, world, (c) => fieldKey("lines")(c) && (c.action as any).row === 0, "VILLAGER: Welcome to Bramble Hollow!");

  addCommand(inbox, world, "choices");
  setTextField(inbox, world, (c) => fieldKey("prompt")(c) && (c.action as any).row === 1, "VILLAGER: Want a tip?");
  setTextField(inbox, world, fieldKey("option:0"), "Yes, please!");
  setTextField(inbox, world, fieldKey("option:1"), "No, thanks.");

  selectCommandRow(inbox, world, (r) => r.command?.op === "choices");
  addCommand(inbox, world, "text@option1");
  setTextField(inbox, world, (c) => fieldKey("lines")(c) && (c.action as any).row === 2, "VILLAGER: The forest road is east. Watch for slimes.");
  selectCommandRow(inbox, world, (r) => r.command?.op === "choices");
  addCommand(inbox, world, "text@option2");
  setTextField(inbox, world, (c) => fieldKey("lines")(c) && (c.action as any).row === 3, "VILLAGER: Safe travels!");

  selectCommandRow(inbox, world, (r) => r.command?.op === "choices");
  addCommand(inbox, world, "switch");
  setTextField(inbox, world, (c) => fieldKey("id")(c) && (c.action as any).row === 4, "met-villager");

  // Page 2: reward, gated by switch on / self switch A off.
  addPage(inbox, world);
  addCondition(inbox, world, "switch");
  setTextField(inbox, world, (c) => fieldKey("id")(c) && (c.action as any).row === 0, "met-villager");
  addCondition(inbox, world, "selfSwitch");
  clickField(inbox, world, (c) => fieldKey("value")(c) && (c.action as any).row === 1);

  addCommand(inbox, world, "text");
  setTextField(inbox, world, (c) => fieldKey("lines")(c) && (c.action as any).row === 0, "VILLAGER: Welcome back! Take these 10 gold.");
  addCommand(inbox, world, "gold");
  setTextField(inbox, world, (c) => fieldKey("amount")(c) && (c.action as any).row === 1, "10");
  addCommand(inbox, world, "selfSwitch");

  // Page 3: after the reward.
  addPage(inbox, world);
  addCondition(inbox, world, "selfSwitch");
  addCommand(inbox, world, "text");
  setTextField(inbox, world, (c) => fieldKey("lines")(c) && (c.action as any).row === 0, "VILLAGER: I already gave you the reward. Go on!");
}

function exportedProject(): Project {
  const result = probes().export();
  expect(result.ok).toBe(true);
  return JSON.parse(result.text) as Project;
}

function findGreeter(project: Project) {
  const village = project.maps.find((m) => m.id === "village")!;
  return village.events!.find((e) => e.name === "Greeter")!;
}

// --- step 3: the Greeter NPC ------------------------------------------------

simDescribe("tutorial step 3: the Greeter NPC", () => {
  test("authors three pages whose conditions gate a one-time reward", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    buildGreeter(inbox, world);

    const project = exportedProject();
    const greeter = findGreeter(project);
    expect(greeter).toMatchObject({ name: "Greeter", x: 9, y: 8 });
    expect(greeter.pages).toHaveLength(3);

    const [p1, p2, p3] = greeter.pages;
    expect(p1).toMatchObject({ trigger: "action", sprite: "villager", blocks: true });
    expect(p1.commands.map((c) => c.op)).toEqual(["text", "choices", "switch"]);
    const choices = p1.commands[1] as Extract<Page["commands"][number], { op: "choices" }>;
    expect(choices.options.map((o) => o.text)).toEqual(["Yes, please!", "No, thanks."]);
    expect(choices.options[0]!.commands).toEqual([{ op: "text", lines: ["VILLAGER: The forest road is east. Watch for slimes."] }]);
    expect(choices.options[1]!.commands).toEqual([{ op: "text", lines: ["VILLAGER: Safe travels!"] }]);
    expect(p1.commands[2]).toMatchObject({ op: "switch", id: "met-villager", value: true });

    expect(p2.condition!.all).toEqual([
      { kind: "switch", id: "met-villager", value: true },
      { kind: "selfSwitch", key: "A", value: false },
    ]);
    expect(p2.commands.map((c) => c.op)).toEqual(["text", "gold", "selfSwitch"]);
    expect(p2.commands[1]).toMatchObject({ op: "gold", set: "add", amount: 10 });
    expect(p2.commands[2]).toMatchObject({ op: "selfSwitch", key: "A", value: true });

    expect(p3.condition!.all).toEqual([{ kind: "selfSwitch", key: "A", value: true }]);
    expect(p3.commands).toHaveLength(1);
  });

  test("pays the reward exactly once across three talks", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    buildGreeter(inbox, world);
    const project = exportedProject();

    const session = createSession(project, 60);
    let state = startSession(project, session);
    // The authored start (9,9) faces up at the Greeter on (9,8).
    const noInput = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };
    const confirm = () => stepSession(session, state, { buttons: BTN.CIRCLE, confirmEdge: true, cancelEdge: false, upEdge: false, downEdge: false });
    const pump = (frames = 4) => {
      for (let i = 0; i < frames; i++) state = stepSession(session, state, noInput);
    };
    const converse = () => {
      const texts: string[] = [];
      let choices = 0;
      state = confirm();
      for (let i = 0; i < 80; i++) {
        pump(3);
        const modal = state.interp.modal;
        if (!modal) break;
        if (modal.kind === "text") texts.push(modal.lines[modal.lines.length - 1]!);
        else if (modal.kind === "choices") choices++;
        state = confirm();
      }
      return { texts, choices };
    };

    const first = converse();
    expect(first.choices).toBe(1);
    expect(first.texts).toContain("VILLAGER: Welcome to Bramble Hollow!");
    expect(first.texts).toContain("VILLAGER: The forest road is east. Watch for slimes.");
    expect(state.sw.switches["met-villager"]).toBe(true);

    const goldBefore = state.sw.gold;
    const second = converse();
    expect(second.texts).toContain("VILLAGER: Welcome back! Take these 10 gold.");
    expect(state.sw.gold).toBe(goldBefore + 10);
    expect(state.sw.self["village/event"]).toBe("A");

    const third = converse();
    expect(third.texts).toContain("VILLAGER: I already gave you the reward. Go on!");
    expect(state.sw.gold).toBe(goldBefore + 10); // no second payout
  });
});

// --- step 4: a second map and two-way portals ------------------------------

simDescribe("tutorial step 4: new map and portals", () => {
  test("creates grove, picks both transfers, and the runtime round-trips", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);

    // MAP -> NEW -> rename grove -> BACK.
    click(inbox, world, ...headerCenter("map"));
    expect(probes().state().mapInspectorOpen).toBe(true);
    {
      const layout = createMapInspectorLayout({ width: W, height: H - HEADER_H - STATUS_H });
      const newAction = layout.actions.find((a) => a.action.kind === "action" && a.action.action === "new")!;
      click(inbox, world, newAction.rect.x + 30, HEADER_H + newAction.rect.y + 10);
      expect(probes().state().editor.project.maps).toHaveLength(4);
      const idField = layout.fields.find((f) => f.action.kind === "field" && f.action.field === "id")!;
      clickControl(inbox, world, idField);
      for (let i = 0; i < 10; i++) key(inbox, world, "Backspace");
      typeText(inbox, world, "grove");
      key(inbox, world, "Enter");
      click(inbox, world, layout.close.rect.x + 24, HEADER_H + layout.close.rect.y + 9);
    }
    expect(probes().state().mapInspectorOpen).toBe(false);

    // Village portal (11,9) -> grove (3,4), picked on the canvas.
    click(inbox, world, ...headerCenter("mapprev"));
    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(11, 9));
    click(inbox, world, ...eventToolPoint("new"));
    clickField(inbox, world, fieldKey("trigger")); // action -> playerTouch
    addCommand(inbox, world, "transfer");
    {
      const row = inspectorLayout().commandRows.find((r) => r.pick)!;
      clickControl(inbox, world, row.pick!);
      expect(probes().state().pendingPick).not.toBeNull();
      click(inbox, world, ...headerCenter("mapnext"));
      click(inbox, world, ...cellPoint(3, 4));
      expect(probes().state().inspectorOpen).toBe(true);
    }

    // Return portal grove (3,5) -> village (10,9).
    key(inbox, world, "Escape");
    click(inbox, world, ...headerCenter("mapnext"));
    click(inbox, world, ...cellPoint(3, 5));
    click(inbox, world, ...eventToolPoint("new"));
    clickField(inbox, world, fieldKey("trigger"));
    addCommand(inbox, world, "transfer");
    {
      const row = inspectorLayout().commandRows.find((r) => r.pick)!;
      clickControl(inbox, world, row.pick!);
      click(inbox, world, ...headerCenter("mapprev"));
      click(inbox, world, ...cellPoint(10, 9));
    }

    const project = exportedProject();
    const village = project.maps.find((m) => m.id === "village")!;
    const grove = project.maps.find((m) => m.id === "grove")!;
    const eastGate = village.events!.find((e) => e.x === 11 && e.y === 9)!;
    const groveReturn = grove.events!.find((e) => e.x === 3 && e.y === 5)!;
    expect(eastGate.pages[0]!.trigger).toBe("playerTouch");
    expect(eastGate.pages[0]!.commands[0]).toMatchObject({ op: "transfer", map: "grove", x: 3, y: 4 });
    expect(groveReturn.pages[0]!.commands[0]).toMatchObject({ op: "transfer", map: "village", x: 10, y: 9 });

    // Runtime: step onto the village portal, then the grove return portal.
    // The start cell is overridden so the walk is short and deterministic
    // (the village's wandering NPCs can block a cross-map stroll).
    const noInput = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };
    const step = (session: any, state: any, btn: number) =>
      stepSession(session, state, { ...noInput, buttons: btn });
    const walkOnto = (doc: Project, startMap: string, sx: number, sy: number, dir: string, btn: number, tx: number, ty: number) => {
      const copy = JSON.parse(JSON.stringify(doc)) as Project;
      copy.start = { map: startMap, x: sx, y: sy, dir: dir as Project["start"]["dir"] };
      // Freeze autonomous NPCs so the village's approaching slime cannot
      // block the cell under test; the portal round-trip is the subject.
      for (const map of copy.maps) {
        for (const event of map.events ?? []) {
          for (const page of event.pages) {
            delete page.moveType;
            delete page.moveRoute;
          }
        }
      }
      const session = createSession(copy, 60);
      let state = startSession(copy, session);
      for (let i = 0; i < 120; i++) {
        state = step(session, state, btn);
        if (state.move.tx === tx && state.move.ty === ty && state.mapId !== startMap) break;
      }
      return state;
    };
    const there = walkOnto(project, "village", 10, 9, "right", BTN.RIGHT, 3, 4);
    expect(there.mapId).toBe("grove");
    expect([there.move.tx, there.move.ty]).toEqual([3, 4]);
    const back = walkOnto(project, "grove", 3, 4, "down", BTN.DOWN, 10, 9);
    expect(back.mapId).toBe("village");
    expect([back.move.tx, back.move.ty]).toEqual([10, 9]);
  });
});

// --- step 5: play-test ------------------------------------------------------

simDescribe("tutorial step 5: play-test", () => {
  test("starts at the selected cell, the debugger flips a switch, STOP keeps undo", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    buildGreeter(inbox, world);

    // Play from the cell next to the Greeter.
    key(inbox, world, "Escape");
    click(inbox, world, ...cellPoint(8, 8));
    expect(probes().state().playStartCell).toEqual({ mapId: "village", x: 8, y: 8 });
    const before = probes().state().editor;
    click(inbox, world, ...headerCenter("play"));
    idle(world, 3);
    expect(probes().state().playtest).toBe(true);
    expect(probes().state().playState.mapId).toBe("village");
    expect({ tx: probes().state().playState.move.tx, ty: probes().state().playState.move.ty }).toEqual({ tx: 8, ty: 8 });

    // Talk to the Greeter: face right, confirm, advance the dialog and choice.
    press(world, BTN.RIGHT);
    idle(world, 3);
    press(world, BTN.CIRCLE);
    idle(world, 3);
    for (let i = 0; i < 10 && probes().state().playState.interp.modal; i++) {
      press(world, BTN.CIRCLE);
      idle(world, 3);
    }
    expect(probes().state().playState.interp.modal).toBeNull();
    expect(probes().state().playState.sw.switches["met-villager"]).toBe(true);

    // The live debugger toggles the switch in the disposable session only.
    click(inbox, world, 83, 11); // DEBUG
    idle(world, 2);
    expect(probes().state().playDebug).toBe(true);
    const playProject = probes().state().playProject;
    const playState = probes().state().playState;
    const rows = playtestDebugRows(playProject, playState, "switch");
    const rowIndex = rows.findIndex((r: any) => r.kind === "switch" && r.id === "met-villager");
    expect(rowIndex).toBeGreaterThanOrEqual(0);
    const panel = playtestPanelRect(W, H, false);
    const row = playtestRowRect(panel, rowIndex);
    click(inbox, world, row.x + row.w - 7, row.y + Math.floor(row.h / 2));
    idle(world, 2);
    expect(probes().state().playState.sw.switches["met-villager"]).toBe(false);

    // STOP returns to the same editor with its undo history intact.
    click(inbox, world, 28, 11); // STOP
    idle(world, 2);
    expect(probes().state().playtest).toBe(false);
    expect(probes().state().editor).toBe(before);
    expect(probes().state().editor.past.length).toBeGreaterThan(0);
    click(inbox, world, ...headerCenter("undo"));
    expect(probes().state().editor.future.length).toBeGreaterThan(0);
  });

  test("STATE LAST carries the previous run's switches into the next", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    buildGreeter(inbox, world);
    key(inbox, world, "Escape");
    click(inbox, world, ...cellPoint(8, 8));
    click(inbox, world, ...headerCenter("play"));
    idle(world, 3);
    // Talk once so met-villager is set in this run.
    press(world, BTN.RIGHT);
    idle(world, 3);
    press(world, BTN.CIRCLE);
    idle(world, 3);
    for (let i = 0; i < 10 && probes().state().playState.interp.modal; i++) {
      press(world, BTN.CIRCLE);
      idle(world, 3);
    }
    expect(probes().state().playState.sw.switches["met-villager"]).toBe(true);
    click(inbox, world, 28, 11); // STOP captures the switch bank
    idle(world, 2);
    expect(probes().state().hasLastPlayState).toBe(true);

    click(inbox, world, ...headerCenter("state")); // FRESH -> LAST
    expect(probes().state().carryPrevious).toBe(true);
    click(inbox, world, ...headerCenter("play"));
    idle(world, 3);
    expect(probes().state().playState.sw.switches["met-villager"]).toBe(true);
    click(inbox, world, 28, 11);

    click(inbox, world, ...headerCenter("state")); // LAST -> FRESH
    expect(probes().state().carryPrevious).toBe(false);
    click(inbox, world, ...headerCenter("play"));
    idle(world, 3);
    expect(probes().state().playState.sw.switches["met-villager"]).toBeUndefined();
    click(inbox, world, 28, 11);
  });
});

// --- step 7: CLI and checks -------------------------------------------------

function runCli(args: string[]): any {
  const result = Bun.spawnSync({
    cmd: [process.execPath, EDIT_CLI, ...args],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  expect(result.exitCode).toBe(0);
  return JSON.parse(stdout);
}
function runCheck(check: string, file: string, extraArgs: string[] = []): any {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CHECK_CLI, check, "--file", file, ...extraArgs],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  return { exitCode: result.exitCode, report: JSON.parse(stdout) };
}

simDescribe("tutorial step 7: rpgkit-edit CLI and rpgkit-check", () => {
  test("reproduces the Greeter and the portal, then lint and explore pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-tutorial-"));
    const file = join(dir, "game.json");
    copyFileSync(join(ROOT, "examples", "sunstone", "data", "sunstone.json"), file);

    // The exact commands from docs/editor-tutorial.md step 7.
    runCli(["add-event", "--file", file, "--json", JSON.stringify({
      map: "village",
      event: {
        id: "greeter", name: "Greeter", x: 9, y: 8,
        pages: [{ trigger: "action", sprite: "villager", blocks: true,
          commands: [{ op: "text", lines: ["VILLAGER: Welcome to Bramble Hollow!"] }] }],
      },
    })]);
    runCli(["insert-command", "--file", file, "--json", JSON.stringify({
      map: "village", event: "greeter", page: 0,
      address: { path: [], index: 1 },
      command: { op: "choices", prompt: "VILLAGER: Want a tip?",
        options: [
          { text: "Yes, please!", commands: [{ op: "text", lines: ["VILLAGER: The forest road is east. Watch for slimes."] }] },
          { text: "No, thanks.", commands: [{ op: "text", lines: ["VILLAGER: Safe travels!"] }] },
        ] },
    })]);
    runCli(["insert-command", "--file", file, "--json", JSON.stringify({
      map: "village", event: "greeter", page: 0,
      address: { path: [], index: 2 },
      command: { op: "switch", id: "met-villager", value: true },
    })]);
    runCli(["add-page", "--file", file, "--json", JSON.stringify({
      map: "village", event: "greeter",
      page: {
        condition: { all: [
          { kind: "switch", id: "met-villager", value: true },
          { kind: "selfSwitch", key: "A", value: false },
        ] },
        trigger: "action", sprite: "villager", blocks: true,
        commands: [{ op: "text", lines: ["VILLAGER: Welcome back!"] }],
      },
    })]);
    runCli(["insert-command", "--file", file, "--json", JSON.stringify({
      map: "village", event: "greeter", page: 1,
      address: { path: [], index: 1 },
      command: { op: "gold", set: "add", amount: 10 },
    })]);
    runCli(["insert-command", "--file", file, "--json", JSON.stringify({
      map: "village", event: "greeter", page: 1,
      address: { path: [], index: 2 },
      command: { op: "selfSwitch", key: "A", value: true },
    })]);
    runCli(["add-page", "--file", file, "--json", JSON.stringify({
      map: "village", event: "greeter",
      page: {
        condition: { all: [{ kind: "selfSwitch", key: "A", value: true }] },
        trigger: "action", sprite: "villager", blocks: true,
        commands: [{ op: "text", lines: ["VILLAGER: Come back any time."] }],
      },
    })]);
    runCli(["update-page", "--file", file, "--json", JSON.stringify({
      map: "village", event: "greeter", page: 2,
      value: {
        condition: { all: [{ kind: "selfSwitch", key: "A", value: true }] },
        trigger: "action", sprite: "villager", blocks: true,
        commands: [{ op: "text", lines: ["VILLAGER: I already gave you the reward. Go on!"] }],
      },
    })]);
    runCli(["add-event", "--file", file, "--json", JSON.stringify({
      map: "village",
      event: {
        id: "forest-gate", name: "Forest Gate", x: 11, y: 9,
        pages: [{ trigger: "playerTouch",
          commands: [{ op: "transfer", map: "forest", x: 9, y: 12, dir: "down" }] }],
      },
    })]);

    // The CLI-authored Greeter matches the editor-authored one.
    const saved = JSON.parse(readFileSync(file, "utf8")) as Project;
    const greeter = saved.maps.find((m) => m.id === "village")!.events!.find((e) => e.id === "greeter")!;
    expect(greeter.pages).toHaveLength(3);
    expect(greeter.pages[0]!.commands.map((c) => c.op)).toEqual(["text", "choices", "switch"]);
    expect(greeter.pages[1]!.condition!.all).toEqual([
      { kind: "switch", id: "met-villager", value: true },
      { kind: "selfSwitch", key: "A", value: false },
    ]);
    expect(greeter.pages[1]!.commands.map((c) => c.op)).toEqual(["text", "gold", "selfSwitch"]);
    expect(greeter.pages[2]!.commands[0]).toMatchObject({ op: "text", lines: ["VILLAGER: I already gave you the reward. Go on!"] });
    const forestGate = saved.maps.find((m) => m.id === "village")!.events!.find((e) => e.id === "forest-gate")!;
    expect(forestGate.pages[0]!.commands[0]).toMatchObject({ op: "transfer", map: "forest", x: 9, y: 12 });

    // Static lint is clean.
    const lint = runCheck("lint", file);
    expect(lint.exitCode).toBe(0);
    expect(lint.report.findings).toEqual([]);

    // Dynamic explore walks the village, talks to the greeter, and crosses
    // the portal into the forest.
    const explore = runCheck("explore", file, ["--json", '{"frames":3000,"stuckFrames":300}']);
    expect(explore.exitCode).toBe(0);
    expect(explore.report.endedReason).not.toBe("error");
    const visited = JSON.stringify(explore.report);
    expect(visited).toContain("forest");
  });
});
