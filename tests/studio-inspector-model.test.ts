import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, GameEvent, MapDef, Page } from "../src/engine/types.ts";
import { EditSession } from "../editor/api/session.ts";
import {
  commandPathKey,
  defaultCommand,
  EDITABLE_COMMAND_OPS,
  flattenCommands,
  getCommand,
  moveCommand,
  pageConditionClauses,
  type CommandAddress,
} from "../editor/engine/commands.ts";
import { commandFields, conditionFields } from "../editor/engine/event-fields.ts";
import {
  addPageOp,
  adjacentCommand,
  cellInfo,
  clauseFields,
  COMMAND_CATEGORIES,
  commandBranchTargets,
  commandCategory,
  commandCopyOp,
  commandDropOps,
  commandMoveOps,
  commandTreeItems,
  conditionSource,
  deleteCommandOp,
  eventCopyOp,
  fieldControl,
  fieldText,
  fieldLabel,
  filterPickerEntries,
  insertCommandOp,
  insertionAddress,
  mapMoveOp,
  nextFreeCell,
  opLabel,
  pageCopyOp,
  pageDeleteOp,
  pageMoveOps,
  parseSheetList,
  PICKER_ENTRIES,
  selectionAfterDelete,
  sessionResources,
  updatePageOp,
  type PageRef,
} from "../editor/studio/inspector-model.ts";

const SUNSTONE = readFileSync(join(import.meta.dir, "../examples/sunstone/data/sunstone.json"), "utf8");

function open(): EditSession {
  return EditSession.open(SUNSTONE);
}

function eventOf(session: EditSession, map: string, event: string): GameEvent {
  return session.map(map)!.events!.find((item) => item.id === event)!;
}

/** One history step, a real change, and undo restores the exact bytes. */
function expectOneUndoableStep(session: EditSession, apply: () => { ok: boolean }): void {
  const before = session.exportText();
  const depth = session.history().length;
  const response = apply();
  expect(response.ok).toBe(true);
  expect(session.history().length).toBe(depth + 1);
  expect(session.exportText()).not.toBe(before);
  const after = session.exportText();
  session.undo();
  expect(session.history().length).toBe(depth);
  expect(session.exportText()).toBe(before);
  session.redo();
  expect(session.exportText()).toBe(after);
  session.undo();
  expect(session.exportText()).toBe(before);
}

describe("command categories and picker", () => {
  test("every editable op has a category and a picker entry", () => {
    for (const op of EDITABLE_COMMAND_OPS) expect(COMMAND_CATEGORIES).toContain(commandCategory(op));
    expect(PICKER_ENTRIES.map((entry) => entry.op)).toEqual([...EDITABLE_COMMAND_OPS]);
    for (const entry of PICKER_ENTRIES) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description).not.toContain("Unknown command");
    }
  });

  test("category groups", () => {
    expect(["if", "battle", "scene", "wait", "exit", "common", "openMenu", "openSave", "autosave", "gameOver", "returnTitle"].map(commandCategory)).toEqual(Array(11).fill("flow"));
    expect(["text", "choices", "balloon", "inputNumber"].map(commandCategory)).toEqual(Array(4).fill("message"));
    expect(["switch", "variable", "selfSwitch", "item", "gold", "timer", "changeName"].map(commandCategory)).toEqual(Array(7).fill("state"));
    expect(["moveRoute", "transfer", "moveControl", "place"].map(commandCategory)).toEqual(Array(4).fill("move"));
    expect(["screenFade", "camera", "scrollMap", "showPicture", "movePicture", "rotatePicture", "tintPicture", "erasePicture", "mapNameDisplay", "mapAnim", "appearance", "layer"].map(commandCategory)).toEqual(Array(12).fill("present"));
    expect(["se", "playBgm", "fadeoutBgs", "playMe"].map(commandCategory)).toEqual(Array(4).fill("audio"));
    expect(commandCategory("ext")).toBe("other");
    expect(commandCategory("somethingNew")).toBe("other");
    expect(commandCategory(42)).toBe("other");
  });

  test("labels", () => {
    expect(opLabel("screenFade")).toBe("Screen fade");
    expect(opLabel("playBgm")).toBe("Play BGM");
    expect(opLabel("openSave")).toBe("Open save screen");
    expect(opLabel("autosave")).toBe("Autosave / 自动存档");
    expect(opLabel("mapNameDisplay")).toBe("Map name display");
    expect(fieldLabel("MOVE TYPE")).toBe("Move type");
  });

  test("filter ranks name matches first and searches descriptions", () => {
    expect(filterPickerEntries("").length).toBe(EDITABLE_COMMAND_OPS.length);
    expect(filterPickerEntries("text")[0]!.op).toBe("text");
    const fade = filterPickerEntries("fade").map((entry) => entry.op);
    expect(fade).toContain("screenFade");
    expect(fade).toContain("fadeoutBgm");
    expect(fade.indexOf("fadeoutBgm")).toBeLessThan(fade.indexOf("screenFade"));
    expect(filterPickerEntries("audio").map((entry) => entry.op)).toContain("playSe");
    expect(filterPickerEntries("picture").map((entry) => entry.op)).toContain("showPicture");
    expect(filterPickerEntries("自动存档").map((entry) => entry.op)).toEqual(["autosave"]);
    expect(filterPickerEntries("zzz-no-such")).toEqual([]);
  });
});

describe("branches and the visible tree", () => {
  const merchant = () => eventOf(open(), "village", "merchant").pages[0]!.commands;

  test("branch targets mirror op@branch", () => {
    const commands = merchant();
    const choices = commandBranchTargets(commands[1]!, { path: [], index: 1 });
    expect(choices.map((target) => target.key)).toEqual(["option1", "option2", "cancel"]);
    expect(choices.at(-1)!.present).toBe(false);
    const ifAddress: CommandAddress = { path: choices[0]!.path, index: 0 };
    const ifTargets = commandBranchTargets(getCommand(commands, ifAddress)!, ifAddress);
    expect(ifTargets.map((target) => [target.key, target.present])).toEqual([["then", true], ["else", true]]);
    expect(commandBranchTargets({ op: "battle", setup: {} } as unknown as Command, { path: [], index: 0 }).map((t) => t.key))
      .toEqual(["win", "escape", "lose"]);
    expect(commandBranchTargets({ op: "scene", id: "x" } as Command, { path: [], index: 0 }).map((t) => t.key)).toEqual(["done", "cancel"]);
    expect(commandBranchTargets({ op: "wait", seconds: 1 }, { path: [], index: 0 })).toEqual([]);
    expect(commandBranchTargets({ op: "loop", commands: [] }, { path: [], index: 2 })).toEqual([
      { key: "body", label: "Loop body", path: [{ kind: "loop", index: 2, branch: "body" }], present: true },
    ]);
    expect(commandBranchTargets({ op: "break" }, { path: [], index: 0 })).toEqual([]);
  });

  test("loop and break are flow ops in the picker; a loop body is an insertion target and a tree branch", () => {
    expect([commandCategory("loop"), commandCategory("break")]).toEqual(["flow", "flow"]);
    expect(opLabel("loop")).toBe("Loop");
    expect(opLabel("break")).toBe("Break loop");
    expect(filterPickerEntries("loop").map((entry) => entry.op).slice(0, 2)).toEqual(["loop", "break"]);

    const session = open();
    const ref: PageRef = { map: "village", event: "merchant", page: 0 };
    const commands = () => eventOf(session, "village", "merchant").pages[0]!.commands;
    const loopAt = commands().length;
    const addLoop = insertCommandOp(ref, insertionAddress(commands(), undefined)!, { op: "loop", commands: [] });
    expect(session.run(addLoop.command, addLoop.args).ok).toBe(true);
    const loopAddress: CommandAddress = { path: [], index: loopAt };
    for (const command of [{ op: "text", lines: ["Again?"] }, { op: "break" }] as Command[]) {
      const into = insertionAddress(commands(), loopAddress, "body")!;
      expect(into.path).toEqual([{ kind: "loop", index: loopAt, branch: "body" }]);
      const insert = insertCommandOp(ref, into, command);
      expect(session.run(insert.command, insert.args).ok).toBe(true);
    }
    expect(commands()[loopAt]).toEqual({ op: "loop", commands: [{ op: "text", lines: ["Again?"] }, { op: "break" }] });
    const items = commandTreeItems(commands(), flattenCommands(commands()));
    const tail = items.slice(items.findIndex((item) => item.key === `root#${loopAt}`));
    expect(tail.map((item) => item.kind === "branch" ? `[${item.label}]@${item.depth}` : `${item.key}@${item.depth}`)).toEqual([
      `root#${loopAt}@0`,
      "[Loop body]@1",
      `l${loopAt}:body#0@1`,
      `l${loopAt}:body#1@1`,
    ]);
    const del = deleteCommandOp(ref, { path: [{ kind: "loop", index: loopAt, branch: "body" }], index: 0 });
    expect(session.run(del.command, del.args).ok).toBe(true);
    expect(commands()[loopAt]).toEqual({ op: "loop", commands: [{ op: "break" }] });
  });

  test("insertion address: after, into a branch, or at the end", () => {
    const commands = merchant();
    expect(insertionAddress(commands, undefined)).toEqual({ path: [], index: commands.length });
    expect(insertionAddress(commands, { path: [], index: 0 })).toEqual({ path: [], index: 1 });
    const into = insertionAddress(commands, { path: [], index: 1 }, "option1")!;
    expect(into.index).toBe(1);
    expect(into.path).toEqual([{ kind: "choices", index: 1, branch: "option", option: 0 }]);
    const cancel = insertionAddress(commands, { path: [], index: 1 }, "cancel")!;
    expect(cancel.index).toBe(0);
    expect(insertionAddress(commands, { path: [], index: 1 }, "win")).toBeNull();
  });

  test("tree items interleave branch headers and honour collapse", () => {
    const commands = merchant();
    const rows = flattenCommands(commands);
    const items = commandTreeItems(commands, rows);
    expect(items.map((item) => item.kind === "branch" ? `[${item.label.split(":")[0]}]` : item.key)).toEqual([
      "root#0",
      "root#1",
      "[Option 1]",
      "c1:option:0#0",
      "[Then]",
      "c1:option:0/i0:then#0",
      "c1:option:0/i0:then#1",
      "c1:option:0/i0:then#2",
      "[Else]",
      "c1:option:0/i0:else#0",
      "[Option 2]",
      "c1:option:1#0",
    ]);
    expect(items.filter((item) => item.kind === "branch").map((item) => item.depth)).toEqual([1, 2, 2, 1]);
    const commandItems = items.filter((item) => item.kind === "command");
    expect(commandItems.length).toBe(rows.length);
    expect(commandItems.find((item) => item.key === "root#1")).toMatchObject({ hasChildren: true, collapsed: false, depth: 0 });
    const collapsed = commandTreeItems(commands, rows, (key) => key === "c1:option:0#0");
    expect(collapsed.filter((item) => item.kind === "command").map((item) => item.key))
      .toEqual(["root#0", "root#1", "c1:option:0#0", "c1:option:1#0"]);
    const all = commandTreeItems(commands, rows, () => true);
    expect(all.map((item) => item.key)).toEqual(["root#0", "root#1"]);
  });

  test("keyboard navigation and selection after delete", () => {
    const commands = merchant();
    const items = commandTreeItems(commands, flattenCommands(commands));
    expect(adjacentCommand(items, undefined, 1)).toEqual({ path: [], index: 0 });
    expect(adjacentCommand(items, undefined, -1)!.index).toBe(0);
    const next = adjacentCommand(items, { path: [], index: 1 }, 1)!;
    expect(next.path.length).toBe(1);
    expect(adjacentCommand(items, { path: [], index: 0 }, -1)).toEqual({ path: [], index: 0 });
    expect(selectionAfterDelete(commands, { path: [], index: 1 })).toEqual({ path: [], index: 0 });
    const onlyElse = { path: [{ kind: "choices", index: 1, branch: "option", option: 0 }, { kind: "if", index: 0, branch: "else" }], index: 0 } as const;
    expect(selectionAfterDelete(commands, onlyElse)).toEqual({ path: [{ kind: "choices", index: 1, branch: "option", option: 0 }], index: 0 });
    expect(selectionAfterDelete([{ op: "exit" }], { path: [], index: 0 })).toBeUndefined();
  });
});

describe("pure helpers", () => {
  test("field controls", () => {
    const text = commandFields({ op: "text", lines: ["a", "b"] });
    expect(text.map(fieldControl)).toEqual(["textarea", "number", "select", "select", "select", "select"]);
    expect(text.slice(2).map((field) => [fieldLabel(field.label), fieldText(field), field.options?.length])).toEqual([
      ["Position", "bottom", 9], ["Align", "left", 3], ["V-align", "top", 3], ["Background", "window", 3],
    ]);
    const sw = commandFields({ op: "switch", id: "s", value: true });
    expect(sw.map(fieldControl)).toEqual(["text", "checkbox"]);
    const self = commandFields({ op: "selfSwitch", key: "A", value: true });
    expect(fieldControl(self[0]!)).toBe("select");
  });

  test("cell info reads sparse layers last-wins", () => {
    const map = {
      id: "m", name: "M", width: 3, height: 2,
      ground: ["a.0", "a.1", null, "a.2", "a.3", "a.4"],
      upper: [[1, "u.0"], [1, "u.1"]],
      passage: [[4, "block"]],
    } as MapDef;
    expect(cellInfo(map, 1, 0)).toEqual({ x: 1, y: 0, ground: "a.1", upper: "u.1", passage: null });
    expect(cellInfo(map, 1, 1)).toEqual({ x: 1, y: 1, ground: "a.3", upper: null, passage: "block" });
    expect(cellInfo(map, 2, 0)!.ground).toBeNull();
    expect(cellInfo(map, 3, 0)).toBeNull();
  });

  test("sheet lists", () => {
    expect(parseSheetList(" town, ,cave ,")).toEqual(["town", "cave"]);
  });

  test("next free cell avoids events and fits the rectangle", () => {
    const event = (id: string, x: number, y: number, w?: number, h?: number) => ({ id, x, y, ...(w ? { w } : {}), ...(h ? { h } : {}), pages: [] });
    const map = { width: 4, height: 3, events: [event("a", 1, 1), event("b", 2, 1)] };
    expect(nextFreeCell(map, map.events[0]!)).toEqual({ x: 1, y: 0 });
    const wide = event("w", 0, 0, 2, 2);
    expect(nextFreeCell({ width: 4, height: 2, events: [wide] }, wide)).toEqual({ x: 2, y: 0 });
    const full = { width: 1, height: 1, events: [event("a", 0, 0)] };
    expect(nextFreeCell(full, full.events[0]!)).toEqual({ x: 0, y: 0 });
  });

  test("flat condition clauses expose only the fields the page gate can hold", () => {
    const page = { trigger: "action", commands: [], condition: { switch: "s", selfSwitch: "A", all: [{ kind: "gold", amount: 3 }] } } as Page;
    const clauses = pageConditionClauses(page.condition);
    const [flatSwitch, flatSelf, gold] = clauses.map((clause) => clauseFields(clause, conditionFields(clause.condition)));
    expect(flatSwitch!.map((field) => [field.key, field.readOnly === true])).toEqual([["id", false], ["value", true]]);
    expect(flatSelf!.map((field) => [field.key, field.readOnly === true])).toEqual([["key", false], ["value", true]]);
    expect(gold!.every((field) => !field.readOnly)).toBe(true);
    expect(clauses.map(conditionSource)).toEqual([
      { kind: "flat", key: "switch" },
      { kind: "flat", key: "selfSwitch" },
      { kind: "all", index: 0 },
    ]);
  });

  test("resources for an inline session", () => {
    const session = open();
    const resources = sessionResources(session, session.map("village")!);
    expect(resources.maps).toEqual(["cave", "forest", "village"]);
    expect(resources.events).toContain("merchant");
  });
});

describe("protocol op lists: one history step each, undo restores the bytes", () => {
  test("page move left and right", () => {
    const session = open();
    const chest = eventOf(session, "village", "village-chest");
    expect(pageMoveOps("village", chest, 0, 0)).toBeNull();
    expect(pageMoveOps("village", chest, 1, 2)).toBeNull();
    const ops = pageMoveOps("village", chest, 0, 1)!;
    expect(ops.map((op) => op.command)).toEqual(["delete-page", "add-page"]);
    expectOneUndoableStep(session, () => session.transaction("Move page", ops));
    session.transaction("Move page", ops);
    const moved = eventOf(session, "village", "village-chest");
    expect(moved.pages[1]).toEqual(chest.pages[0]!);
    expect(moved.pages[0]).toEqual(chest.pages[1]!);
    const back = pageMoveOps("village", moved, 1, 0)!;
    session.transaction("Move page back", back);
    expect(session.exportText()).toBe(SUNSTONE); // moving back restores the exact bytes too
  });

  test("page copy, add and delete", () => {
    const session = open();
    const elder = eventOf(session, "village", "elder");
    const copy = pageCopyOp("village", elder, 0)!;
    expectOneUndoableStep(session, () => session.run(copy.command, copy.args));
    session.run(copy.command, copy.args);
    const copied = eventOf(session, "village", "elder");
    expect(copied.pages.length).toBe(2);
    expect(copied.pages[1]).toEqual(copied.pages[0]!);
    session.undo();
    const add = addPageOp("village", "elder", 1);
    expectOneUndoableStep(session, () => session.run(add.command, add.args));
    expect(pageDeleteOp("village", elder, 0)).toBeNull(); // last page is kept
    const chest = eventOf(session, "village", "village-chest");
    const del = pageDeleteOp("village", chest, 1)!;
    expectOneUndoableStep(session, () => session.run(del.command, del.args));
  });

  test("page condition and field updates", () => {
    const session = open();
    const chest = eventOf(session, "village", "village-chest");
    const ref: PageRef = { map: "village", event: "village-chest", page: 1 };
    const op = updatePageOp(ref, { ...chest.pages[1]!, trigger: "playerTouch" });
    expectOneUndoableStep(session, () => session.run(op.command, op.args));
  });

  test("command move up/down at the root and inside a branch", () => {
    const session = open();
    const ref: PageRef = { map: "village", event: "merchant", page: 0 };
    const commands = () => eventOf(session, "village", "merchant").pages[0]!.commands;
    const original = commands();
    expect(commandMoveOps(ref, original, { path: [], index: 0 }, -1)).toBeNull();
    expect(commandMoveOps(ref, original, { path: [], index: 1 }, 1)).toBeNull();
    const down = commandMoveOps(ref, original, { path: [], index: 0 }, 1)!;
    expect(down.to).toEqual({ path: [], index: 1 });
    expectOneUndoableStep(session, () => session.transaction("Move command down", down.ops));
    session.transaction("Move command down", down.ops);
    expect(commands()[0]).toEqual(original[1]!);
    expect(commands()[1]).toEqual(original[0]!);
    session.undo();

    const thenPath = [{ kind: "choices", index: 1, branch: "option", option: 0 }, { kind: "if", index: 0, branch: "then" }] as const;
    const up = commandMoveOps(ref, original, { path: thenPath, index: 2 }, -1)!;
    expect(up.to).toEqual({ path: thenPath, index: 1 });
    expectOneUndoableStep(session, () => session.transaction("Move command up", up.ops));
    session.transaction("Move command up", up.ops);
    expect(getCommand(commands(), up.to)).toEqual(getCommand(original, { path: thenPath, index: 2 })!);
    expect(session.history().length).toBe(1);
  });

  test("command copy, insert into a new branch, and delete", () => {
    const session = open();
    const ref: PageRef = { map: "village", event: "merchant", page: 0 };
    const commands = () => eventOf(session, "village", "merchant").pages[0]!.commands;
    const original = commands();
    const copy = commandCopyOp(ref, original, { path: [], index: 1 })!;
    expect(copy.to).toEqual({ path: [], index: 2 });
    expectOneUndoableStep(session, () => session.run(copy.op.command, copy.op.args));
    session.run(copy.op.command, copy.op.args);
    expect(commands()[2]).toEqual(original[1]!);
    session.undo();

    const cancel = insertionAddress(original, { path: [], index: 1 }, "cancel")!;
    const insert = insertCommandOp(ref, cancel, { op: "text", lines: ["Maybe later."] });
    expectOneUndoableStep(session, () => session.run(insert.command, insert.args));

    const del = deleteCommandOp(ref, { path: [], index: 0 });
    expectOneUndoableStep(session, () => session.run(del.command, del.args));
  });

  test("event copy lands on a free cell with a unique id", () => {
    const session = open();
    const map = session.map("village")!;
    const elder = eventOf(session, "village", "elder");
    const { op, id } = eventCopyOp(map, elder);
    expect(id).toBe("elder-copy");
    expectOneUndoableStep(session, () => session.run(op.command, op.args));
    session.run(op.command, op.args);
    const copy = eventOf(session, "village", id);
    expect(copy.pages).toEqual(elder.pages);
    const occupied = (map.events ?? []).filter((event) => event.x === copy.x && event.y === copy.y);
    expect(occupied).toEqual([]);
    expect(eventCopyOp(session.map("village")!, elder).id).toBe("elder-copy-2");
  });
});

describe("drag and drop", () => {
  const text = (line: string): Command => ({ op: "text", lines: [line] });
  // root: A, if1 { then: T0 T1, else: E0 }, B, if3 { then: U0 }, C
  const LIST: Command[] = [
    text("A"),
    { ...defaultCommand("if"), then: [text("T0"), text("T1")], else: [text("E0")] } as Command,
    text("B"),
    { ...defaultCommand("if"), then: [text("U0")] } as Command,
    text("C"),
  ];
  const ref: PageRef = { map: "village", event: "merchant", page: 0 };
  const ifBranch = (index: number, branch: "then" | "else") => [{ kind: "if", index, branch }] as const;
  const root = (index: number): CommandAddress => ({ path: [], index });
  const lines = (commands: readonly Command[]): unknown[] =>
    commands.map((command) => command.op === "text"
      ? (command as { lines: string[] }).lines[0]
      : { then: lines((command as { then: Command[] }).then), else: lines((command as { else?: Command[] }).else ?? []) });

  /** A session whose merchant page holds LIST, saved as the baseline. */
  function staged(): { session: EditSession; commands: () => Command[] } {
    const session = open();
    const page = eventOf(session, "village", "merchant").pages[0]!;
    const op = updatePageOp(ref, { ...page, commands: LIST });
    expect(session.run(op.command, op.args).ok).toBe(true);
    return { session, commands: () => eventOf(session, "village", "merchant").pages[0]!.commands };
  }

  /** Apply the drop as one transaction; it must equal the engine's
   * moveCommand and leave the command at `to`. */
  function drop(from: CommandAddress, slot: CommandAddress): { to: CommandAddress; after: Command[] } {
    const { session, commands } = staged();
    const before = commands();
    const result = commandDropOps(ref, before, from, slot)!;
    expect(result).not.toBeNull();
    expect(result.ops.map((op) => op.command)).toEqual(["delete-command", "insert-command"]);
    const expected = commandPathKey(from.path) === commandPathKey(slot.path)
      ? moveCommand(before, from, result.to.index)
      : moveCommand(before, from, slot);
    expectOneUndoableStep(session, () => session.transaction("Move command", result.ops));
    session.transaction("Move command", result.ops);
    expect(session.history().length).toBe(2);
    const after = commands();
    expect(after).toEqual(expected);
    expect(getCommand(after, result.to)).toEqual(getCommand(before, from)!);
    return { to: result.to, after };
  }

  test("same list forward lands one before the slot", () => {
    const { to, after } = drop(root(0), root(3));
    expect(to).toEqual(root(2));
    expect(lines(after)).toEqual([{ then: ["T0", "T1"], else: ["E0"] }, "B", "A", { then: ["U0"], else: [] }, "C"]);
  });

  test("same list backward lands at the slot", () => {
    const { to, after } = drop(root(4), root(1));
    expect(to).toEqual(root(1));
    expect(lines(after)).toEqual(["A", "C", { then: ["T0", "T1"], else: ["E0"] }, "B", { then: ["U0"], else: [] }]);
  });

  test("dropping just before or after itself changes nothing", () => {
    const { commands } = staged();
    expect(commandDropOps(ref, commands(), root(2), root(2))).toBeNull();
    expect(commandDropOps(ref, commands(), root(2), root(3))).toBeNull();
    expect(commandDropOps(ref, commands(), root(4), root(5))).toBeNull();
    expect(commandDropOps(ref, commands(), { path: ifBranch(1, "then"), index: 1 }, { path: ifBranch(1, "then"), index: 2 })).toBeNull();
  });

  test("into a branch of a later sibling rebases the branch path", () => {
    const { to, after } = drop(root(0), { path: ifBranch(3, "then"), index: 1 });
    expect(to).toEqual({ path: ifBranch(2, "then"), index: 1 });
    expect(lines(after)).toEqual([{ then: ["T0", "T1"], else: ["E0"] }, "B", { then: ["U0", "A"], else: [] }, "C"]);
  });

  test("into a branch of an earlier sibling keeps the path", () => {
    const { to, after } = drop(root(4), { path: ifBranch(1, "else"), index: 0 });
    expect(to).toEqual({ path: ifBranch(1, "else"), index: 0 });
    expect(lines(after)).toEqual(["A", { then: ["T0", "T1"], else: ["C", "E0"] }, "B", { then: ["U0"], else: [] }]);
  });

  test("out of a branch to the root and between branches", () => {
    const out = drop({ path: ifBranch(1, "then"), index: 0 }, root(5));
    expect(out.to).toEqual(root(5));
    expect(lines(out.after)).toEqual(["A", { then: ["T1"], else: ["E0"] }, "B", { then: ["U0"], else: [] }, "C", "T0"]);
    const across = drop({ path: ifBranch(1, "else"), index: 0 }, { path: ifBranch(3, "then"), index: 0 });
    expect(across.to).toEqual({ path: ifBranch(3, "then"), index: 0 });
    expect(lines(across.after)).toEqual(["A", { then: ["T0", "T1"], else: [] }, "B", { then: ["E0", "U0"], else: [] }, "C"]);
  });

  test("refuses drops into its own branches and slots that do not resolve", () => {
    const { commands } = staged();
    expect(commandDropOps(ref, commands(), root(1), { path: ifBranch(1, "then"), index: 0 })).toBeNull();
    expect(commandDropOps(ref, commands(), root(1), { path: ifBranch(1, "else"), index: 1 })).toBeNull();
    expect(commandDropOps(ref, commands(), root(0), root(6))).toBeNull();
    expect(commandDropOps(ref, commands(), root(0), root(-1))).toBeNull();
    expect(commandDropOps(ref, commands(), root(0), { path: ifBranch(0, "then"), index: 0 })).toBeNull();
    expect(commandDropOps(ref, commands(), root(9), root(0))).toBeNull();
  });

  test("map move is one undoable step", () => {
    const session = open();
    const op = mapMoveOp("cave", 0);
    expect(op).toEqual({ command: "move-map", args: { map: "cave", index: 0 } });
    expectOneUndoableStep(session, () => session.run(op.command, op.args));
    session.run(op.command, op.args);
    expect(session.maps().map((map) => map.id)).toEqual(["cave", "village", "forest"]);
  });
});
