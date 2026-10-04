// End-to-end event-editor interaction over the real PocketJS wasm host.
// The tests deliberately drive only public pointer/key service lines: they
// prove that the visible controls, editor reducer, serializer, and runtime
// interpreter agree on the same project data.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import type { Command, GameEvent, Project } from "../src/engine/types.ts";
import { BUNDLED_PROJECTS } from "../editor/engine/projects.ts";
import { commandInspectorRows } from "../editor/engine/event-fields.ts";
import { flattenCommands } from "../editor/engine/commands.ts";
import {
  createEventInspectorLayout,
  type EventInspectorLayout,
  type InspectorControl,
} from "../editor/engine/event-layout.ts";
import {
  compactHeader,
  eventToolButtons,
  fittedView,
  headerButtons,
  HEADER_H,
  PASS_TOOL_IDS,
  STATUS_H,
  TILE,
  passToolButtons,
  type HeaderActionId,
} from "../editor/engine/layout.ts";
import { initialCursor, stepCursor } from "../editor/engine/cursor.ts";
import { createMapInspectorLayout } from "../editor/engine/map-layout.ts";
import { createProposalPanelLayout, proposalActionRects } from "../editor/engine/proposal-layout.ts";
import { fitTextToWidth, wrapTextToWidth } from "../editor/engine/text-layout.ts";
import { appPreflight, fnv1a } from "./helpers/boot.ts";
import {
  bootEditorWorld,
  installEditorSimIsolation,
  type BoundEditorWorld,
} from "./helpers/editor-session.ts";

const preflight = appPreflight("editor");
if (!preflight.ok) console.warn(`editor event sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

installEditorSimIsolation();

const SUNSTONE = BUNDLED_PROJECTS.find((document) => document.id === "sunstone")!;
const MODERN_COMMAND_SCREENSHOT_PIN = "7418c3a6";
type World = BoundEditorWorld;
let live: World | null = null;
const probes = () => live!.probes();

function frame(world: World): void {
  world.frame(0);
  world.tick();
}

async function bootSvc(
  inbox: string[],
  outbox: string[],
  width = 480,
  height = 272,
  inspectOps?: (ops: Record<string, unknown>) => void,
): Promise<World> {
  const world = await bootEditorWorld(
    60,
    undefined,
    (ops) => {
      inspectOps?.(ops);
      ops.svcOpen = () => true;
      ops.svcPoll = () => (inbox.length ? inbox.splice(0).join("\n") : null);
      ops.svcSend = (line: string) => outbox.push(line);
    },
    { width, height },
  );
  live = world;
  for (let i = 0; i < 4; i++) frame(world);
  return world;
}

interface DebugTreeNode {
  n?: string;
  t?: string;
  x?: string;
  k?: DebugTreeNode[];
}

function findDebugNode(node: DebugTreeNode, name: string): DebugTreeNode | null {
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const found = findDebugNode(child, name);
    if (found) return found;
  }
  return null;
}

function debugText(node: DebugTreeNode): string {
  return node.t === "#text" ? node.x ?? "" : (node.k ?? []).map(debugText).join("");
}

function headerTexts(world: World): string[] {
  const header = findDebugNode(world.getTree() as DebugTreeNode, "editor-header");
  expect(header).not.toBeNull();
  return (header!.k ?? []).map(debugText);
}

async function bootPad(width = 480, height = 272): Promise<World> {
  const world = await bootEditorWorld(60, undefined, undefined, { width, height });
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

function clickHeader(inbox: string[], world: World, id: HeaderActionId, width = 480): void {
  let button = headerButtons(width).find((candidate) => candidate.id === id);
  if (!button) {
    const more = headerButtons(width).find((candidate) => candidate.id === "more")!;
    click(inbox, world, more.x + Math.floor(more.w / 2), more.y + Math.floor(more.h / 2));
    button = headerButtons(width, true).find((candidate) => candidate.id === id);
  }
  expect(button).toBeDefined();
  click(inbox, world, button!.x + Math.floor(button!.w / 2), button!.y + Math.floor(button!.h / 2));
}

function drag(inbox: string[], world: World, from: [number, number], to: [number, number]): void {
  line(inbox, world, { t: "mouse", x: from[0], y: from[1], d: true });
  line(inbox, world, { t: "mouse", x: to[0], y: to[1], d: true });
  line(inbox, world, { t: "mouse", x: to[0], y: to[1], d: false });
}

function typeText(inbox: string[], world: World, text: string): void {
  line(inbox, world, { t: "ch", s: text });
}

function key(inbox: string[], world: World, k: string, cmd = false): void {
  line(inbox, world, { t: "key", k, cmd, sh: false, alt: false, ctl: cmd });
}

function pulse(world: World, buttons: number): void {
  world.frame(buttons);
  world.tick();
  world.frame(0);
  world.tick();
}

function cellPoint(width: number, height: number, tx: number, ty: number): [number, number] {
  const viewport = fittedView(width, height, false);
  return [viewport.frame.x + tx * TILE + 8, viewport.frame.y + ty * TILE + 8];
}

function eventToolPoint(id: "new" | "edit" | "copy" | "delete"): [number, number] {
  const button = eventToolButtons().find((candidate) => candidate.id === id)!;
  return [button.x + Math.floor(button.w / 2), HEADER_H + button.y + Math.floor(button.h / 2)];
}

function selectedEvent(): GameEvent {
  const state = probes().state().editor;
  const map = state.project.maps[state.mapIndex]!;
  return map.events.find((event: GameEvent) => event.id === state.selectedEventId)!;
}

function inspectorLayout(width: number, height: number): EventInspectorLayout {
  const state = probes().state().editor;
  const event = selectedEvent();
  const page = event.pages[state.selectedPageIndex]!;
  return createEventInspectorLayout({
    width,
    height: height - HEADER_H - STATUS_H,
    pageCount: event.pages.length,
    activePage: state.selectedPageIndex,
    // The scripted events in this file have no page conditions; condition
    // geometry is covered by the pure event-layout suite.
    conditions: [],
    commands: commandInspectorRows(page.commands),
    scroll: { pagesX: 0, conditionsY: 0, commandsY: 0 },
  });
}

function clickInspectorControl(
  inbox: string[],
  world: World,
  control: InspectorControl<unknown>,
): void {
  click(
    inbox,
    world,
    control.rect.x + Math.floor(control.rect.w / 2),
    HEADER_H + control.rect.y + Math.floor(control.rect.h / 2),
  );
}

function enterEventMode(inbox: string[], world: World): void {
  click(inbox, world, 26, 10); // ground -> upper
  click(inbox, world, 26, 10); // upper -> passage
  click(inbox, world, 26, 10); // passage -> events
  expect(probes().state().eventMode).toBe(true);
}

simDescribe("editor responsive chrome", () => {
  test("measured labels fit across compact and desktop profiles", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    let measureText: ((text: string, slot: number) => number) | undefined;
    const world = await bootSvc(inbox, outbox, 480, 272, (ops) => {
      measureText = ops.measureText as (text: string, slot: number) => number;
    });
    expect(measureText).toBeDefined();
    const measure = measureText!;

    const assertHeaderFits = (width: number, secondary: boolean): void => {
      const labels = headerTexts(world);
      const buttons = headerButtons(width, secondary);
      expect(labels).toHaveLength(buttons.length);
      for (let index = 0; index < buttons.length; index++) {
        expect(measure(labels[index]!, 0)).toBeLessThanOrEqual(buttons[index]!.w - 8);
        expect(labels[index]!.endsWith("…")).toBe(false);
      }
    };
    const assertStatusFits = (width: number): void => {
      const status = findDebugNode(world.getTree() as DebugTreeNode, "editor-status");
      expect(status).not.toBeNull();
      const text = debugText(status!);
      expect(measure(text, 0)).toBeLessThanOrEqual(width - 8);
      expect(text).toContain("village 20x13");
      expect(text).toContain("GROUND");
      expect(text).toContain("ERASE");
    };

    expect(compactHeader(480)).toBe(true);
    assertHeaderFits(480, false);
    assertStatusFits(480);
    const more = headerButtons(480).find((button) => button.id === "more")!;
    click(inbox, world, more.x + Math.floor(more.w / 2), more.y + Math.floor(more.h / 2));
    assertHeaderFits(480, true);
    const back = headerButtons(480, true).find((button) => button.id === "more")!;
    click(inbox, world, back.x + Math.floor(back.w / 2), back.y + Math.floor(back.h / 2));

    world.resizeViewport(720, 480);
    frame(world);
    frame(world);
    expect(compactHeader(720)).toBe(false);
    assertHeaderFits(720, false);
    assertStatusFits(720);

    // These fixed-width labels share the same baked 12 px face. Pin their
    // real host measurements against the containers used at both target
    // viewport heights, so a font or copy change cannot silently overlap.
    for (const [width, height] of [[400, 240], [480, 272], [720, 480]] as const) {
      const panelH = height - HEADER_H - STATUS_H;
      const proposalLabels = ["BACK", "ACCEPT", "REJECT", "ACCEPT ALL"];
      const proposalActions = proposalActionRects(panelH);
      for (let index = 0; index < proposalActions.length; index++) {
        expect(measure(proposalLabels[index]!, 0)).toBeLessThanOrEqual(proposalActions[index]!.rect.w - 8);
      }
      for (const line of ["SELECT HUNK", "TO LOCATE"]) {
        expect(measure(line, 0)).toBeLessThanOrEqual(130);
      }
      const agent = createProposalPanelLayout(panelH, "compose").agent!;
      expect(measure("ASK LOCAL AGENT", 0)).toBeLessThanOrEqual(agent.heading.w);
      const runLabel = fitTextToWidth("RUN RESPONSIVE OFFLINE AGENT ADAPTER", agent.action.w - 8, (text) => measure(text, 0));
      expect(measure(runLabel, 0)).toBeLessThanOrEqual(agent.action.w - 8);
      const prompt = wrapTextToWidth(
        "Brighten the selected village path and move the elder beside it",
        agent.input.w - 6,
        3,
        (text) => measure(text, 0),
      );
      expect(prompt).toHaveLength(3);
      for (const line of prompt) expect(measure(line, 0)).toBeLessThanOrEqual(agent.input.w - 6);
      const status = wrapTextToWidth(
        "Responsive offline agent is ready for measured proposal layout",
        agent.status.w,
        2,
        (text) => measure(text, 0),
      );
      expect(status).toHaveLength(2);
      for (const line of status) expect(measure(line, 0)).toBeLessThanOrEqual(agent.status.w);
      for (const [index, label] of ["NEW", "EDIT", "COPY", "DELETE"].entries()) {
        expect(measure(label, 0)).toBeLessThanOrEqual(eventToolButtons()[index]!.w - 6);
      }
      expect(measure("TILES (0=ERASE)", 0)).toBeLessThanOrEqual(134);
      expect(measure("READ ONLY", 0)).toBeLessThanOrEqual(68);
      for (const line of [
        "GAMEPAD MODE · DPAD MOVE",
        "O PAINT · X ERASE · SEL LAYER",
        "L/R MAP · START SAVE",
      ]) {
        expect(measure(line, 0)).toBeLessThanOrEqual(width - 148);
      }
    }
  });

  test("scrolled long command rows keep visible E5 fields paired with their values", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox, 400, 240);
    const project = JSON.parse(SUNSTONE.json) as Project;
    const elder = project.maps[0]!.events!.find((event) => event.id === "elder")!;
    elder.pages[0]!.commands = [{
      op: "screenTint",
      layer: "world",
      color: { r: 11, g: 22, b: 33, a: 44 },
      duration: 5,
      wait: true,
    }];
    expect(probes().inject(JSON.stringify(project))).toEqual({ ok: true });

    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(400, 240, 9, 5));
    click(inbox, world, ...eventToolPoint("edit"));
    line(inbox, world, { t: "mouse", x: 350, y: 180, d: false });
    line(inbox, world, { t: "scroll", dy: 1 });

    const tree = world.getTree() as DebugTreeNode;
    expect(findDebugNode(tree, "event-inspector-command-0-field-layer")).toBeNull();
    const green = findDebugNode(tree, "event-inspector-command-0-field-color.g");
    expect(green).not.toBeNull();
    expect(debugText(green!)).toContain("G 22");
    const blue = findDebugNode(tree, "event-inspector-command-0-field-color.b");
    expect(blue).not.toBeNull();
    expect(debugText(blue!)).toContain("B 33");
  });
});

simDescribe("event editor pointer integration", () => {
  test("selects and drags a multi-cell event, then copies/deletes/undoes through visible controls", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const project = JSON.parse(SUNSTONE.json) as Project;
    const elder = project.maps[0]!.events!.find((event) => event.id === "elder")!;
    elder.w = 2;
    elder.h = 2;
    expect(probes().inject(JSON.stringify(project, null, 2) + "\n")).toEqual({ ok: true });

    enterEventMode(inbox, world);
    const start = cellPoint(480, 272, elder.x + 1, elder.y + 1);
    const end = cellPoint(480, 272, elder.x + 2, elder.y + 2);
    click(inbox, world, ...start);
    expect(probes().state().editor.selectedEventId).toBe("elder");
    drag(inbox, world, start, end);
    expect(selectedEvent()).toMatchObject({ id: "elder", x: 10, y: 6, w: 2, h: 2 });
    expect(probes().state().editor.past).toHaveLength(1);

    const beforeCopy = probes().state().editor.project.maps[0].events.length;
    click(inbox, world, ...eventToolPoint("copy"));
    expect(probes().state().editor.project.maps[0].events).toHaveLength(beforeCopy + 1);
    expect(probes().state().editor.selectedEventId).toBe("elder-copy");
    click(inbox, world, ...eventToolPoint("delete"));
    expect(probes().state().editor.project.maps[0].events).toHaveLength(beforeCopy);
    clickHeader(inbox, world, "undo");
    expect(probes().state().editor.project.maps[0].events).toHaveLength(beforeCopy + 1);
  });

  test("creates a named speaking NPC by clicks and typing, saves it, and the runtime opens its text", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    enterEventMode(inbox, world);

    // The starting player is at (9,9), facing up. Put the new NPC directly
    // ahead at (9,8), where the original project has no event.
    click(inbox, world, ...cellPoint(480, 272, 9, 8));
    click(inbox, world, ...eventToolPoint("new"));
    expect(probes().state().inspectorOpen).toBe(true);

    let layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.eventFields.find((c) => c.action.kind === "event-field" && c.action.field === "name")!);
    for (let i = 0; i < 5; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "Greeter");
    key(inbox, world, "Enter");

    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.pageFields.find((c) => c.action.kind === "page-field" && c.action.field === "sprite")!);
    for (let i = 0; i < 4; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "wiz");
    key(inbox, world, "Enter");
    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.pageFields.find((c) => c.action.kind === "page-field" && c.action.field === "blocks")!);

    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.commandActions.find((c) => c.action.kind === "command-action" && c.action.action === "add")!);
    typeText(inbox, world, "text");
    key(inbox, world, "Enter");
    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.commandRows[0]!.fields[0]!);
    typeText(inbox, world, "Hello from the editor.");
    key(inbox, world, "Enter");

    clickHeader(inbox, world, "save");
    const saveLines = outbox
      .map((value) => JSON.parse(value) as { t: string; text?: string })
      .filter((value) => value.t === "save");
    expect(saveLines).toHaveLength(1);
    const savedText = saveLines[0]!.text!;
    const saved = JSON.parse(savedText) as Project;
    const npc = saved.maps[0]!.events!.find((event) => event.id === "event")!;
    expect(npc).toMatchObject({
      name: "Greeter",
      x: 9,
      y: 8,
      pages: [{ trigger: "action", sprite: "wiz", blocks: true, commands: [{ op: "text", lines: ["Hello from the editor."] }] }],
    });
    expect(savedText).toContain('"ELDER: The Sunstone that lit our valley"');
    expect(probes().state().editor.dirty).toBe(false);

    const session = createSession(saved, 60);
    let state = startSession(saved, session);
    state = stepSession(session, state, { buttons: BTN.CIRCLE, confirmEdge: true });
    if (state.interp.modal === null) state = stepSession(session, state, { buttons: 0 });
    expect(state.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Hello from the editor."],
    });
  });

  test("inserts autosave and displays its bilingual handheld label", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox, 720, 480);
    const project = JSON.parse(SUNSTONE.json) as Project;
    const elder = project.maps[0]!.events!.find((event) => event.id === "elder")!;
    elder.pages[0]!.commands = [];
    expect(probes().inject(JSON.stringify(project))).toEqual({ ok: true });

    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(720, 480, 9, 5));
    click(inbox, world, ...eventToolPoint("edit"));
    const add = inspectorLayout(720, 480).commandActions.find(
      (control) => control.action.kind === "command-action" && control.action.action === "add",
    )!;
    clickInspectorControl(inbox, world, add);
    typeText(inbox, world, "autosave");
    key(inbox, world, "Enter");

    expect(selectedEvent().pages[0]!.commands).toEqual([{ op: "autosave" }]);
    frame(world);
    const header = findDebugNode(world.getTree() as DebugTreeNode, "event-inspector-command-0");
    expect(header).not.toBeNull();
    expect(debugText(header!)).toContain("autosave / 自动存档");
  });

  test("edits newer command fields, shows validation and resource hints, and authors battle branches", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox, 720, 480);
    const project = JSON.parse(SUNSTONE.json) as Project;
    const elder = project.maps[0]!.events!.find((event) => event.id === "elder")!;
    elder.pages[0]!.commands = [
      { op: "screenShake", strength: 2, speed: 4, duration: 0.5, wait: true },
      { op: "item", item: "torch", set: "add", count: 1 },
      { op: "battle", setup: null },
    ];
    expect(probes().inject(JSON.stringify(project))).toEqual({ ok: true });

    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(720, 480, 9, 5)); // elder
    click(inbox, world, ...eventToolPoint("edit"));
    expect(probes().state().inspectorOpen).toBe(true);

    const clearInput = (): void => {
      const length = (probes().state().inputBuffer as string).length;
      for (let i = 0; i < length; i++) key(inbox, world, "Backspace");
    };
    const command = (op: Command["op"]): Command => {
      const found = selectedEvent().pages[0]!.commands.find((entry) => entry.op === op);
      expect(found).toBeDefined();
      return found!;
    };
    const commandRow = (op: Command["op"]) => {
      const row = commandInspectorRows(selectedEvent().pages[0]!.commands).findIndex((entry) => entry.command.op === op);
      expect(row).toBeGreaterThanOrEqual(0);
      return { row, geometry: inspectorLayout(720, 480).commandRows[row]! };
    };

    // A newly editable screen-presentation command is changed only through
    // the real pointer/text service path. Invalid input keeps the edit alive
    // and must be visible in the event-inspector header, not a hidden status.
    let shake = commandRow("screenShake");
    const strength = shake.geometry.fields.find(
      (field) => field.action.kind === "command-field" && field.action.field === "strength",
    )!;
    clickInspectorControl(inbox, world, strength);
    clearInput();
    typeText(inbox, world, "-1");
    key(inbox, world, "Enter");
    expect(command("screenShake")).toMatchObject({ strength: 2 });
    expect(probes().state().inspectorFocus).toMatchObject({ kind: "command-field", field: "strength" });
    expect(probes().state().notice).toEqual({ kind: "bad", text: "STRENGTH MUST BE AT LEAST 0" });
    let tree = JSON.stringify(world.getTree());
    expect(tree).toContain("event-inspector-edit-prompt");
    expect(tree).toContain("STRENGTH MUST BE AT LEAST 0");
    const validationFrame = world.render();
    expect(validationFrame).toHaveLength(720 * 480 * 4);
    expect(pixel(validationFrame, 720, strength.rect.x, HEADER_H + strength.rect.y)).toEqual([255, 210, 74, 255]);
    const validationHash = fnv1a(validationFrame);
    if (process.env.EDITOR_EVENT_UPDATE_GOLDENS) {
      await Bun.write(
        new URL("./goldens/editor-modern-commands.720x480.png", import.meta.url),
        encodePNG(validationFrame, 720, 480),
      );
      console.log(`modern command editor golden 720x480: ${validationHash}`);
    } else {
      expect(validationHash).toBe(MODERN_COMMAND_SCREENSHOT_PIN);
    }

    clearInput();
    typeText(inbox, world, "3");
    key(inbox, world, "Enter");
    expect(command("screenShake")).toMatchObject({ strength: 3, speed: 4, duration: 0.5, wait: true });
    expect(probes().state().inspectorFocus).toBeNull();

    // Resource-backed text fields remain directly editable, but focusing one
    // exposes the deterministic project choices in the same visible header.
    const item = commandRow("item");
    const itemId = item.geometry.fields.find(
      (field) => field.action.kind === "command-field" && field.action.field === "item",
    )!;
    clickInspectorControl(inbox, world, itemId);
    expect(probes().state().notice).toMatchObject({ kind: "info" });
    expect(probes().state().notice.text).toContain("PROJECT ITEMS:");
    expect(probes().state().notice.text).toContain("THORN-KEY");
    tree = JSON.stringify(world.getTree());
    expect(tree).toContain("PROJECT ITEMS:");
    expect(tree).toContain("THORN-KEY");
    key(inbox, world, "Escape");

    // Battle is also a newly editable command: edit its JSON payload through
    // the field, then use every supported @branch spelling. The selected
    // escape child is deleted through the visible DEL action afterward.
    const battleBefore = commandRow("battle");
    const setup = battleBefore.geometry.fields.find(
      (field) => field.action.kind === "command-field" && field.action.field === "setup",
    )!;
    clickInspectorControl(inbox, world, setup);
    clearInput();
    typeText(inbox, world, '{"enemy":"slime"}');
    key(inbox, world, "Enter");
    expect(command("battle")).toMatchObject({ setup: { enemy: "slime" } });

    const addInBattleBranch = (entry: string): void => {
      const battle = commandRow("battle");
      clickInspectorControl(inbox, world, battle.geometry.header);
      const layout = inspectorLayout(720, 480);
      const add = layout.commandActions.find(
        (control) => control.action.kind === "command-action" && control.action.action === "add",
      )!;
      clickInspectorControl(inbox, world, add);
      typeText(inbox, world, entry);
      key(inbox, world, "Enter");
    };
    addInBattleBranch("text@win");
    addInBattleBranch("switch@lose");
    addInBattleBranch("wait@escape");

    let battle = command("battle") as Extract<Command, { op: "battle" }>;
    expect(battle.onWin).toEqual([{ op: "text", lines: [""] }]);
    expect(battle.onLose).toEqual([{ op: "switch", id: "switch", value: true }]);
    expect(battle.onEscape).toEqual([{ op: "wait", seconds: 1 }]);
    expect(commandInspectorRows(selectedEvent().pages[0]!.commands).filter((row) => row.depth === 1).map((row) => row.branch)).toEqual([
      "Win", "Escape", "Lose",
    ]);

    const del = inspectorLayout(720, 480).commandActions.find(
      (control) => control.action.kind === "command-action" && control.action.action === "delete",
    )!;
    clickInspectorControl(inbox, world, del);
    battle = command("battle") as Extract<Command, { op: "battle" }>;
    expect(battle.onWin).toHaveLength(1);
    expect(battle.onLose).toHaveLength(1);
    expect(battle.onEscape).toEqual([]);
  });
});

function pixel(framebuffer: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  return [
    framebuffer[offset]!,
    framebuffer[offset + 1]!,
    framebuffer[offset + 2]!,
    framebuffer[offset + 3]!,
  ];
}

const screenshotPins: Record<string, string> = {
  "480x272": "79499b2f",
  "720x480": "03660555",
};

simDescribe("event inspector responsive rendering", () => {
  for (const [width, height] of [[480, 272], [720, 480]] as const) {
    test(`${width}x${height} renders semantic inspector regions and matches its PNG`, async () => {
      const inbox: string[] = [];
      const outbox: string[] = [];
      const world = await bootSvc(inbox, outbox, width, height);
      enterEventMode(inbox, world);
      click(inbox, world, ...cellPoint(width, height, 9, 5)); // elder
      click(inbox, world, ...eventToolPoint("edit"));
      expect(probes().state().inspectorOpen).toBe(true);
      frame(world);

      const layout = inspectorLayout(width, height);
      const framebuffer = world.render();
      expect(framebuffer).toHaveLength(width * height * 4);
      const name = layout.eventFields[0]!.rect;
      expect(pixel(framebuffer, width, name.x + name.w - 2, HEADER_H + name.y + 2)).toEqual([44, 58, 82, 255]);
      expect(pixel(framebuffer, width, layout.leftWidth, HEADER_H + layout.bodyTop + 50)).toEqual([8, 11, 16, 255]);
      const firstCommand = layout.commandRows[0]!.header.rect;
      expect(pixel(framebuffer, width, firstCommand.x + firstCommand.w - 2, HEADER_H + firstCommand.y + 2)).toEqual([32, 43, 61, 255]);

      const nameKey = `${width}x${height}`;
      const hash = fnv1a(framebuffer);
      if (process.env.EDITOR_EVENT_UPDATE_GOLDENS) {
        await Bun.write(
          new URL(`./goldens/editor-events.${nameKey}.png`, import.meta.url),
          encodePNG(framebuffer, width, height),
        );
        console.log(`editor event golden ${nameKey}: ${hash}`);
      }
      const pin = screenshotPins[nameKey];
      if (pin) expect(hash).toBe(pin);
      const png = new Uint8Array(await Bun.file(new URL(`./goldens/editor-events.${nameKey}.png`, import.meta.url)).arrayBuffer());
      const decoded = decodePng(png);
      expect({ width: decoded.width, height: decoded.height, hash: fnv1a(decoded.rgba) }).toEqual({ width, height, hash });
    });
  }
});

// --- E2: new map -> transfer event picked to it -> save -> runtime transfer ---

simDescribe("map management + transfer picking end to end", () => {
  test("new map, picked transfer, save, runtime moves the player", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const s = () => probes().state();

    // 1. MAP header -> NEW creates an empty map after the village.
    clickHeader(inbox, world, "map");
    expect(s().mapInspectorOpen).toBe(true);
    const mapLayout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
    const newAction = mapLayout.actions.find(
      (a) => a.action.kind === "action" && a.action.action === "new",
    )!;
    click(inbox, world, newAction.rect.x + 30, HEADER_H + newAction.rect.y + 10);
    expect(s().editor.project.maps).toHaveLength(4);
    expect(s().editor.mapIndex).toBe(1);
    expect(s().editor.project.maps[1]!.id).toBe("map");
    // rename the new map so the pick's map-operand write is distinguishable
    // from the transfer command's default ("map")
    const idField = mapLayout.fields.find((f) => f.action.kind === "field" && f.action.field === "id")!;
    clickInspectorControl(inbox, world, idField);
    for (let i = 0; i < 10; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "grove");
    key(inbox, world, "Enter");
    expect(s().editor.project.maps[1]!.id).toBe("grove");
    // close the map inspector (BACK)
    click(inbox, world, mapLayout.close.rect.x + 24, HEADER_H + mapLayout.close.rect.y + 9);
    expect(s().mapInspectorOpen).toBe(false);

    // 2. Back to the village, create an event at the start cell (9,9).
    clickHeader(inbox, world, "mapprev");
    expect(s().editor.mapIndex).toBe(0);
    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(480, 272, 9, 9));
    click(inbox, world, ...eventToolPoint("new"));
    expect(s().inspectorOpen).toBe(true);
    expect(s().editor.selectedEventId).toBe("event");

    // 3. Add a transfer command, then PICK its target.
    let layout = inspectorLayout(480, 272);
    const addCmd = layout.commandActions.find(
      (a) => a.action.kind === "command-action" && a.action.action === "add",
    )!;
    clickInspectorControl(inbox, world, addCmd);
    typeText(inbox, world, "transfer");
    key(inbox, world, "Enter");
    layout = inspectorLayout(480, 272);
    const transferRow = layout.commandRows.find((row) => row.pick)!;
    expect(transferRow).toBeDefined();
    clickInspectorControl(inbox, world, transferRow.pick!);
    expect(s().pendingPick).not.toBeNull();
    expect(s().inspectorOpen).toBe(false);

    // 4. Switch to the new map and click cell (3,4) to fill the target.
    clickHeader(inbox, world, "mapnext");
    expect(s().editor.mapIndex).toBe(1);
    click(inbox, world, ...cellPoint(480, 272, 3, 4));
    // the pick applied and the inspector reopened on the event
    expect(s().inspectorOpen).toBe(true);
    const exported = JSON.parse(probes().export().text) as Project;
    const evt = exported.maps[0]!.events!.find((e) => e.id === "event")!;
    const transfer = evt.pages[0]!.commands.find((c) => c.op === "transfer")!;
    // the pick wrote the renamed map id (not the command default "map"), the
    // clicked cell, and kept the template dir
    expect(transfer).toMatchObject({ map: "grove", x: 3, y: 4, dir: "keep" });

    // 5. SAVE and reload into a runtime session.
    clickHeader(inbox, world, "save");
    const saves = outbox
      .map((l) => JSON.parse(l) as { t: string; text?: string })
      .filter((m) => m.t === "save");
    expect(saves).toHaveLength(1);
    const saved = JSON.parse(saves[0]!.text!) as Project;
    expect(saved.maps).toHaveLength(4);

    // 6. The player starts on the event at (9,9); confirming triggers the
    //    action page and the runtime transfers to the new map at (3,4).
    const session = createSession(saved, 60);
    let state = startSession(saved, session);
    expect(state.mapId).toBe("village");
    for (let i = 0; i < 5; i++) state = stepSession(session, state, { buttons: 0 });
    state = stepSession(session, state, { buttons: BTN.CIRCLE, confirmEdge: true });
    for (let i = 0; i < 120; i++) state = stepSession(session, state, { buttons: 0 });
    expect(state.mapId).toBe("grove");
    expect([state.move.tx, state.move.ty]).toEqual([3, 4]);
  });

  test("undo during PICK cancels the stale target instead of rewriting another transfer", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const project = JSON.parse(SUNSTONE.json) as Project;
    const transferA = { op: "transfer" as const, map: "cave", x: 7, y: 8, dir: "up" as const };
    project.maps[0]!.events = [{
      id: "pick-review",
      name: "Pick review",
      x: 0,
      y: 0,
      pages: [{ trigger: "action", commands: [{ op: "text", lines: ["anchor"] }, transferA] }],
    }];
    expect(probes().inject(JSON.stringify(project))).toEqual({ ok: true });

    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(480, 272, 0, 0));
    click(inbox, world, ...eventToolPoint("edit"));
    let layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.commandRows[0]!.header);
    clickInspectorControl(inbox, world, layout.commandActions.find(
      (action) => action.action.kind === "command-action" && action.action.action === "add",
    )!);
    typeText(inbox, world, "transfer");
    key(inbox, world, "Enter");
    expect(selectedEvent().pages[0]!.commands).toHaveLength(3);

    layout = inspectorLayout(480, 272);
    const transferB = layout.commandRows.find((row) => row.pick)!;
    clickInspectorControl(inbox, world, transferB.pick!);
    expect(probes().state().pendingPick).not.toBeNull();

    clickHeader(inbox, world, "undo");
    expect(probes().state().pendingPick).toBeNull();

    // A pending pick also cannot survive a redo that inserts a command in
    // front of its address. Pick A while B is undone, then redo B.
    click(inbox, world, ...eventToolPoint("edit"));
    layout = inspectorLayout(480, 272);
    clickInspectorControl(inbox, world, layout.commandRows.find((row) => row.pick)!.pick!);
    expect(probes().state().pendingPick).not.toBeNull();
    clickHeader(inbox, world, "redo");
    expect(probes().state().pendingPick).toBeNull();
    clickHeader(inbox, world, "undo");

    clickHeader(inbox, world, "mapnext");
    click(inbox, world, ...cellPoint(480, 272, 3, 4));

    const after = (JSON.parse(probes().export().text) as Project)
      .maps[0]!.events![0]!.pages[0]!.commands;
    expect(after).toEqual([{ op: "text", lines: ["anchor"] }, transferA]);
  });

  test("adds the first command into scene @done and @cancel branches through the ADD prompt", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const project = JSON.parse(SUNSTONE.json) as Project;
    project.maps[0]!.events = [{
      id: "scene-review",
      name: "Scene review",
      x: 0,
      y: 0,
      pages: [{ trigger: "action", commands: [{ op: "scene", id: "pc.box" }] }],
    }];
    expect(probes().inject(JSON.stringify(project))).toEqual({ ok: true });

    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(480, 272, 0, 0));
    click(inbox, world, ...eventToolPoint("edit"));

    const sceneLayoutRow = () => {
      const state = probes().state().editor;
      const page = selectedEvent().pages[state.selectedPageIndex]!;
      const key = flattenCommands(page.commands).find((row) => row.command.op === "scene")!.key;
      return inspectorLayout(480, 272).commandRows.find((row) => row.key === key)!;
    };
    const addAction = () => inspectorLayout(480, 272).commandActions.find(
      (action) => action.action.kind === "command-action" && action.action.action === "add",
    )!;
    const sceneCommand = () => selectedEvent().pages[0]!.commands[0] as Extract<Command, { op: "scene" }>;

    // Select the scene row, then ADD into its (absent) done branch.
    clickInspectorControl(inbox, world, sceneLayoutRow().header);
    clickInspectorControl(inbox, world, addAction());
    typeText(inbox, world, "text@done");
    key(inbox, world, "Enter");
    expect(sceneCommand().onDone).toEqual([{ op: "text", lines: [""] }]);
    expect(sceneCommand().onCancel).toBeUndefined();

    // Same for the cancel branch.
    clickInspectorControl(inbox, world, sceneLayoutRow().header);
    clickInspectorControl(inbox, world, addAction());
    typeText(inbox, world, "text@cancel");
    key(inbox, world, "Enter");
    expect(sceneCommand().onCancel).toEqual([{ op: "text", lines: [""] }]);

    // An unknown branch name is rejected without touching either branch.
    clickInspectorControl(inbox, world, sceneLayoutRow().header);
    clickInspectorControl(inbox, world, addAction());
    typeText(inbox, world, "text@bogus");
    key(inbox, world, "Enter");
    expect(probes().state().notice).toMatchObject({ kind: "bad" });
    expect(probes().state().notice.text).toContain("INVALID @BRANCH");
    expect(sceneCommand().onDone).toHaveLength(1);
    expect(sceneCommand().onCancel).toHaveLength(1);
  });
});

// --- E2: passage painting, map inspector, selected-row pixels ---------------

function passToolPoint(id: string): [number, number] {
  const button = passToolButtons().find((candidate) => candidate.id === id)!;
  return [button.x + Math.floor(button.w / 2), HEADER_H + button.y + Math.floor(button.h / 2)];
}

simDescribe("passage mode (pointer)", () => {
  test("paints a block override, shows it, and undoes", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const s = () => probes().state();
    // ground -> upper -> passage
    click(inbox, world, 26, 10);
    click(inbox, world, 26, 10);
    expect(s().editor.layer).toBe("passage");
    // the village already ships ~90 block overrides; pick a null cell (9,0)
    const before = (JSON.parse(SUNSTONE.json) as Project).maps[0]!.passage ?? [];
    expect(before.some(([i]) => i === 9)).toBe(false);
    // pick the BLOCK brush
    click(inbox, world, ...passToolPoint("block"));
    expect(s().passTool).toBe("block");
    // paint cell (9,0): index 9
    const vp = fittedView(480, 272, false);
    click(inbox, world, vp.frame.x + 9 * TILE + 8, vp.frame.y + 8);
    const exported = JSON.parse(probes().export().text) as Project;
    expect(exported.maps[0]!.passage).toContainEqual([9, "block"]);
    expect(exported.maps[0]!.passage!).toHaveLength(before.length + 1);
    // the canvas overlay shows a red block marker on that cell
    const fb = world.render();
    const px = pixel(fb, 480, vp.frame.x + 9 * TILE + 12, vp.frame.y + 12);
    expect(px[0]).toBeGreaterThan(200); // red corner marker
    expect(px[1]).toBeLessThan(120);
    // undo removes just the new override
    clickHeader(inbox, world, "undo");
    const undone = JSON.parse(probes().export().text) as Project;
    expect(undone.maps[0]!.passage).toEqual(before);
  });

  test("PASS to EVENT resets pointer input before the next press", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    click(inbox, world, 26, 10);
    click(inbox, world, 26, 10); // passage mode

    // Deliberately send the next press before the layer-button release. The
    // mode transition owns that press edge and must not leave pointerDown
    // pretending a passage stroke is still held.
    line(inbox, world, { t: "mouse", x: 26, y: 10, d: true });
    expect(probes().state().eventMode).toBe(true);
    line(inbox, world, { t: "mouse", x: cellPoint(480, 272, 9, 5)[0], y: cellPoint(480, 272, 9, 5)[1], d: true });
    line(inbox, world, { t: "mouse", x: cellPoint(480, 272, 9, 5)[0], y: cellPoint(480, 272, 9, 5)[1], d: false });
    expect(probes().state().editor.selectedEventId).toBe("elder");
  });

  test("toggles a sheet dirEdges enter edge and undoes", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const s = () => probes().state();
    click(inbox, world, 26, 10);
    click(inbox, world, 26, 10); // passage mode
    // in-left edge tool (index 6): paints town.0's dirEdges
    click(inbox, world, ...passToolPoint("in-left"));
    const vp = fittedView(480, 272, false);
    click(inbox, world, vp.frame.x + 8, vp.frame.y + 8); // cell (0,0) is town.0
    const exported = JSON.parse(probes().export().text) as Project;
    const town = exported.sheets.find((sheet) => sheet.id === "town")!;
    expect(town.dirEdges).toEqual({ "0": { enter: ["left"] } });
    // the canvas overlay shows a blue enter arrow on that cell
    const fb = world.render();
    const px = pixel(fb, 480, vp.frame.x + 2, vp.frame.y + 8);
    expect(px[2]).toBeGreaterThan(150); // blue-dominant arrow pixel
    // undo removes the edge
    clickHeader(inbox, world, "undo");
    const undone = JSON.parse(probes().export().text) as Project;
    expect(undone.sheets.find((sheet) => sheet.id === "town")!.dirEdges).toBeUndefined();
  });

  test("CLR-EDGE clears a cell's dirEdges (not a passage override)", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const s = () => probes().state();
    click(inbox, world, 26, 10);
    click(inbox, world, 26, 10); // passage mode
    // paint an enter-left edge on town.0
    click(inbox, world, ...passToolPoint("in-left"));
    const vp = fittedView(480, 272, false);
    click(inbox, world, vp.frame.x + 8, vp.frame.y + 8);
    expect(JSON.parse(probes().export().text).sheets.find((sh: { id: string }) => sh.id === "town").dirEdges).toEqual({ "0": { enter: ["left"] } });
    // CLR-EDGE removes it
    click(inbox, world, ...passToolPoint("clr-edge"));
    click(inbox, world, vp.frame.x + 8, vp.frame.y + 8);
    expect(JSON.parse(probes().export().text).sheets.find((sh: { id: string }) => sh.id === "town").dirEdges).toBeUndefined();
    // and it did NOT paint a passage override (the village's authored
    // passage blocks are unchanged)
    const originalPassage = (JSON.parse(SUNSTONE.json) as Project).maps[0]!.passage ?? [];
    expect(JSON.parse(probes().export().text).maps[0].passage).toEqual(originalPassage);
    expect(s().editor.past).toHaveLength(2); // edge add + edge clear
  });
});

simDescribe("passage mode (gamepad)", () => {
  test("PASS to EVENT mid-stroke commits one undoable stroke and clears its input latch", async () => {
    const world = await bootPad();
    pulse(world, BTN.SELECT);
    pulse(world, BTN.SELECT);
    expect(probes().state().passMode).toBe(true);
    const originalPassage = (JSON.parse(probes().export().text) as Project).maps[0]!.passage ?? [];

    world.frame(BTN.CIRCLE);
    world.tick();
    world.frame(BTN.CIRCLE | BTN.SELECT);
    world.tick();
    world.frame(0);
    world.tick();

    const beforeUndo = probes().state();
    expect(beforeUndo.eventMode).toBe(true);
    expect(beforeUndo.editor.stroke).toBeNull();
    expect(beforeUndo.editor.past).toHaveLength(1);
    pulse(world, BTN.SQUARE);
    expect(probes().state().editor.past).toHaveLength(0);
    const passage = (JSON.parse(probes().export().text) as Project).maps[0]!.passage ?? [];
    expect(passage).toEqual(originalPassage);
  });

  test("all twelve two-column PASS tools are reachable without changing ordinary palette geometry", () => {
    const baseWorld = {
      mapW: 20,
      mapH: 13,
      viewCols: 20,
      viewRows: 13,
      camX: 0,
      camY: 0,
      paletteSize: PASS_TOOL_IDS.length,
      paletteCols: 2,
      headerSize: 8,
    };
    const queue = [{ cursor: initialCursor(0, 0), camX: 0, camY: 0 }];
    const visited = new Set<string>();
    const reached = new Set<number>();
    for (let i = 0; i < queue.length; i++) {
      const state = queue[i]!;
      const key = JSON.stringify(state);
      if (visited.has(key)) continue;
      visited.add(key);
      if (state.cursor.zone === "palette") reached.add(state.cursor.slot);
      for (const dir of [0, 1, 2, 3] as const) {
        queue.push(stepCursor(state.cursor, dir, { ...baseWorld, camX: state.camX, camY: state.camY }));
      }
    }
    expect([...reached].sort((a, b) => a - b)).toEqual(PASS_TOOL_IDS.map((_, index) => index));

    const ordinary = stepCursor(
      { ...initialCursor(0, 0), zone: "palette", slot: 1 },
      0,
      { ...baseWorld, paletteSize: 133, paletteCols: undefined },
    );
    expect(ordinary.cursor.slot).toBe(9); // default tile palette remains eight columns
  });

  test("d-pad moves across PASS columns to select BLOCK and IN-LT", async () => {
    const world = await bootPad();
    pulse(world, BTN.SELECT);
    pulse(world, BTN.SELECT);
    pulse(world, BTN.LEFT); // canvas -> PASS slot 0
    pulse(world, BTN.RIGHT); // slot 1, still inside the two-column panel
    expect(probes().state().cursor).toMatchObject({ zone: "palette", slot: 1 });
    pulse(world, BTN.CIRCLE);
    expect(probes().state().passTool).toBe("block");

    pulse(world, BTN.LEFT); // slot 0
    pulse(world, BTN.DOWN); // slot 2
    pulse(world, BTN.DOWN); // slot 4
    pulse(world, BTN.DOWN); // slot 6
    expect(probes().state().cursor).toMatchObject({ zone: "palette", slot: 6 });
    pulse(world, BTN.CIRCLE);
    expect(probes().state().passTool).toBe("in-left");
  });
});

simDescribe("map inspector (pointer)", () => {
  for (const field of ["id", "name", "width", "sheets"] as const) {
    test(`the first ${field} edit survives SAVE text, reload, undo and redo`, async () => {
      const inbox: string[] = [];
      const outbox: string[] = [];
      const world = await bootSvc(inbox, outbox);
      const before = probes().state().editor.project.maps[0]![field];
      const requested = field === "id"
        ? "village-renamed"
        : field === "name"
          ? "Saved village"
          : field === "width"
            ? "21"
            : probes().state().editor.project.sheets.map((sheet: { id: string }) => sheet.id).join(",");
      const expected = field === "width"
        ? Number(requested)
        : field === "sheets"
          ? requested.split(",")
          : requested;

      clickHeader(inbox, world, "map");
      const layout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
      const control = layout.fields.find(
        (candidate) => candidate.action.kind === "field" && candidate.action.field === field,
      )!;
      clickInspectorControl(inbox, world, control);
      const oldText = probes().state().mapInput as string;
      for (let i = 0; i < oldText.length; i++) key(inbox, world, "Backspace");
      typeText(inbox, world, requested);
      key(inbox, world, "Enter");
      expect(probes().state().editor.project.maps[0]![field]).toEqual(expected);

      clickHeader(inbox, world, "undo");
      expect(probes().state().editor.project.maps[0]![field]).toEqual(before);
      clickHeader(inbox, world, "redo");
      expect(probes().state().editor.project.maps[0]![field]).toEqual(expected);

      clickHeader(inbox, world, "save");
      const saves = outbox
        .map((value) => JSON.parse(value) as { t: string; text?: string })
        .filter((value) => value.t === "save");
      expect(saves).toHaveLength(1);
      const savedText = saves[0]!.text!;
      expect((JSON.parse(savedText) as Project).maps[0]![field]).toEqual(expected);

      line(inbox, world, { t: "load", text: savedText });
      expect(probes().state().editor.project.maps[0]![field]).toEqual(expected);
      expect(probes().state().editor.dirty).toBe(false);
    });
  }

  test("resizing a new empty map remains schema-valid through SAVE and reload", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    clickHeader(inbox, world, "map");
    const layout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
    const create = layout.actions.find(
      (candidate) => candidate.action.kind === "action" && candidate.action.action === "new",
    )!;
    clickInspectorControl(inbox, world, create);
    const width = layout.fields.find(
      (candidate) => candidate.action.kind === "field" && candidate.action.field === "width",
    )!;
    clickInspectorControl(inbox, world, width);
    const oldText = probes().state().mapInput as string;
    for (let i = 0; i < oldText.length; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "21");
    key(inbox, world, "Enter");

    const resized = probes().state().editor.project.maps[1]!;
    expect(resized.width).toBe(21);
    expect(resized.events).toEqual([]);
    expect(probes().export()).toMatchObject({ ok: true, errors: [] });
    clickHeader(inbox, world, "save");
    const saves = outbox
      .map((value) => JSON.parse(value) as { t: string; text?: string })
      .filter((value) => value.t === "save");
    expect(saves).toHaveLength(1);
    const savedText = saves[0]!.text!;
    expect((JSON.parse(savedText) as Project).maps[1]!.events).toEqual([]);
    line(inbox, world, { t: "load", text: savedText });
    expect(probes().state().editor.project.maps[1]!.events).toEqual([]);
  });

  test("shows every delete reference through the map inspector pager", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const project = JSON.parse(SUNSTONE.json) as Project;
    const target = project.maps[1]!.id;
    project.maps[0]!.events!.push(...Array.from({ length: 12 }, (_, index) => ({
      id: `review-ref-${index}`,
      x: 0,
      y: 0,
      pages: [{
        trigger: "action" as const,
        commands: [{ op: "transfer" as const, map: target, x: 0, y: 0 }],
      }],
    })));
    expect(probes().inject(JSON.stringify(project))).toEqual({ ok: true });
    clickHeader(inbox, world, "mapnext");
    clickHeader(inbox, world, "map");
    let layout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
    const del = layout.actions.find(
      (candidate) => candidate.action.kind === "action" && candidate.action.action === "del",
    )!;
    clickInspectorControl(inbox, world, del);

    const pending = probes().state().deleteRefs as {
      mapId: string;
      references: { eventId: string }[];
    };
    expect(pending.mapId).toBe(target);
    expect(pending.references).toHaveLength(14); // two authored refs + twelve injected refs
    expect(pending.references.filter((ref) => ref.eventId.startsWith("review-ref-"))).toHaveLength(12);
    layout = createMapInspectorLayout({
      width: 480,
      height: 272 - HEADER_H - STATUS_H,
      referenceCount: pending.references.length,
      referencePage: 0,
      showNotice: true,
    });
    const next = layout.referencePager.find(
      (control) => control.action.kind === "reference-page" && control.action.delta === 1,
    )!;
    expect(next).toBeDefined();
    expect(JSON.stringify(world.getTree())).toContain("map-inspector-delete-confirm");
    clickInspectorControl(inbox, world, next);
    expect(probes().state().mapReferencePage).toBe(1);
    expect(JSON.stringify(world.getTree())).toContain("review-ref");
  });

  test("keeps a crop warning visible while the map inspector is open", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const project = JSON.parse(SUNSTONE.json) as Project;
    project.maps[0]!.events = [
      { id: "keep", x: 0, y: 0, pages: [{ trigger: "action", commands: [] }] },
      { id: "cropped-review", x: 19, y: 12, pages: [{ trigger: "action", commands: [] }] },
    ];
    // Keep the start cell inside the cropped map: the edit protocol refuses
    // a resize that would leave the start position outside it.
    project.start = { ...project.start, x: 0, y: 0 };
    expect(probes().inject(JSON.stringify(project))).toEqual({ ok: true });
    clickHeader(inbox, world, "map");
    const layout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
    const width = layout.fields.find(
      (candidate) => candidate.action.kind === "field" && candidate.action.field === "width",
    )!;
    clickInspectorControl(inbox, world, width);
    const oldText = probes().state().mapInput as string;
    for (let i = 0; i < oldText.length; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "5");
    key(inbox, world, "Enter");

    expect(probes().state().notice).toMatchObject({ kind: "bad" });
    expect(probes().state().notice.text).toContain("cropped-review");
    const tree = JSON.stringify(world.getTree());
    expect(tree).toContain("map-inspector-notice");
    expect(tree).toContain("cropped-review");
    const noticeLayout = createMapInspectorLayout({
      width: 480,
      height: 272 - HEADER_H - STATUS_H,
      showNotice: true,
    });
    expect(pixel(
      world.render(),
      480,
      noticeLayout.noticeClip.x + noticeLayout.noticeClip.w - 3,
      HEADER_H + noticeLayout.noticeClip.y + 3,
    )).toEqual([50, 31, 40, 255]); // visible bad-notice background (#321f28)
  });

  test("keeps a SAVE schema refusal visible while the map inspector is open", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    clickHeader(inbox, world, "map");

    // The app's test probe exposes the live state; remove one required field
    // solely to drive the real performSave validation/refusal boundary.
    const invalidMap = probes().state().editor.project.maps[0] as { events?: unknown[] };
    delete invalidMap.events;
    clickHeader(inbox, world, "save");

    expect(outbox.map((value) => JSON.parse(value)).filter((value) => value.t === "save")).toHaveLength(0);
    expect(probes().state().notice).toMatchObject({ kind: "bad" });
    expect(probes().state().notice.text).toContain("EXPORT REFUSED");
    const tree = JSON.stringify(world.getTree());
    expect(tree).toContain("map-inspector-notice");
    expect(tree).toContain("EXPORT REFUSED");
    const noticeLayout = createMapInspectorLayout({
      width: 480,
      height: 272 - HEADER_H - STATUS_H,
      showNotice: true,
    });
    expect(pixel(
      world.render(),
      480,
      noticeLayout.noticeClip.x + noticeLayout.noticeClip.w - 3,
      HEADER_H + noticeLayout.noticeClip.y + 3,
    )).toEqual([50, 31, 40, 255]);
  });

  test("renames and resizes the map, then undoes both", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const s = () => probes().state();
    clickHeader(inbox, world, "map");
    expect(s().mapInspectorOpen).toBe(true);
    const layout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
    // rename the village (clear the field first, like the event inspector)
    const idField = layout.fields.find((f) => f.action.kind === "field" && f.action.field === "id")!;
    clickInspectorControl(inbox, world, idField);
    for (let i = 0; i < 10; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "village2");
    key(inbox, world, "Enter");
    expect(s().editor.project.maps[0]!.id).toBe("village2");
    // resize to 25 wide
    const wField = layout.fields.find((f) => f.action.kind === "field" && f.action.field === "width")!;
    clickInspectorControl(inbox, world, wField);
    for (let i = 0; i < 4; i++) key(inbox, world, "Backspace");
    typeText(inbox, world, "25");
    key(inbox, world, "Enter");
    expect(s().editor.project.maps[0]!.width).toBe(25);
    // undo resize, then rename
    clickHeader(inbox, world, "undo");
    expect(s().editor.project.maps[0]!.width).toBe(20);
    clickHeader(inbox, world, "undo");
    expect(s().editor.project.maps[0]!.id).toBe("village");
  });

  test("duplicates and deletes a map", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const s = () => probes().state();
    clickHeader(inbox, world, "map");
    const layout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
    const dup = layout.actions.find((a) => a.action.kind === "action" && a.action.action === "dup")!;
    clickInspectorControl(inbox, world, dup);
    expect(s().editor.project.maps).toHaveLength(4);
    expect(s().editor.project.maps[1]!.id).toBe("village-copy");
    // delete the copy (no transfers reference it): one click
    const del = layout.actions.find((a) => a.action.kind === "action" && a.action.action === "del")!;
    clickInspectorControl(inbox, world, del);
    expect(s().editor.project.maps).toHaveLength(3);
    // deleting map 1 clamps the selection to what is now index 1 (forest)
    expect(s().editor.mapIndex).toBe(1);
  });

  test("the map and event inspectors are mutually exclusive", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    const s = () => probes().state();
    // open the event inspector
    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(480, 272, 9, 5)); // elder
    click(inbox, world, ...eventToolPoint("edit"));
    expect(s().inspectorOpen).toBe(true);
    // opening the map inspector closes the event inspector
    clickHeader(inbox, world, "map");
    expect(s().mapInspectorOpen).toBe(true);
    expect(s().inspectorOpen).toBe(false);
    // close the map inspector, reopen the event inspector, then open the map
    // inspector again: only one is ever open
    const layout = createMapInspectorLayout({ width: 480, height: 272 - HEADER_H - STATUS_H });
    click(inbox, world, layout.close.rect.x + 24, HEADER_H + layout.close.rect.y + 9);
    expect(s().mapInspectorOpen).toBe(false);
    click(inbox, world, ...eventToolPoint("edit"));
    expect(s().inspectorOpen).toBe(true);
    clickHeader(inbox, world, "map");
    expect(s().mapInspectorOpen).toBe(true);
    expect(s().inspectorOpen).toBe(false);
  });
});

simDescribe("event inspector selection", () => {
  test("a selected command row renders the selection highlight", async () => {
    const inbox: string[] = [];
    const outbox: string[] = [];
    const world = await bootSvc(inbox, outbox);
    enterEventMode(inbox, world);
    click(inbox, world, ...cellPoint(480, 272, 9, 5)); // elder
    click(inbox, world, ...eventToolPoint("edit"));
    const layout = inspectorLayout(480, 272);
    const row0 = layout.commandRows[0]!;
    // unselected row header is the ROW color
    let fb = world.render();
    const unselected = pixel(fb, 480, row0.header.rect.x + 5, HEADER_H + row0.header.rect.y + 5);
    expect(unselected).not.toEqual([61, 80, 110, 255]);
    // select the row
    clickInspectorControl(inbox, world, row0.header);
    expect(probes().state().inspectorSelection.command).toBe(0);
    fb = world.render();
    const selected = pixel(fb, 480, row0.header.rect.x + 5, HEADER_H + row0.header.rect.y + 5);
    expect(selected).toEqual([61, 80, 110, 255]); // SELECTED #3d506e
  });
});
