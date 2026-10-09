import { describe, expect, test } from "bun:test";
import {
  BASIC_MOVE_STEPS,
  CONDITION_KINDS,
  EDITABLE_COMMAND_OPS,
  ROOT_COMMAND_PATH,
  battleBranchPath,
  choiceBranchPath,
  commandAddress,
  commandSummary,
  conditionSummary,
  copyCommand,
  defaultCommand,
  defaultCondition,
  defaultMoveStep,
  defaultPageCondition,
  deleteCommand,
  flattenCommands,
  getCommandList,
  ifBranchPath,
  insertCommand,
  isEditableCommand,
  isEditableCondition,
  loopBodyPath,
  commandAddressKey,
  commandPathKey,
  moveCommand,
  moveStepSummary,
  pageConditionClauses,
  pageConditionSummary,
  sceneBranchPath,
  updateCommand,
  type CommandAddress,
} from "../editor/engine/commands.ts";
import { validateProject } from "../editor/engine/document.ts";
import type { Command, Condition, PageCondition, Project } from "../src/engine/types.ts";

const root = (index: number): CommandAddress => commandAddress(ROOT_COMMAND_PATH, index);

function switchCommand(id: string): Command {
  return { op: "switch", id, value: true };
}

describe("editor command tree", () => {
  test("flattens nested branches in deterministic pre-order with editable rows", () => {
    const commands: Command[] = [
      { op: "text", lines: ["root"] },
      {
        op: "if",
        if: { kind: "switch", id: "gate" },
        then: [
          {
            op: "choices",
            prompt: "Pick",
            options: [
              { text: "One", commands: [switchCommand("one")] },
              { text: "Two", commands: [{ op: "ext", call: "game.two", args: { exact: 2 } }] },
            ],
            cancel: { commands: [{ op: "exit" }] },
          },
        ],
        else: [{ op: "shop", id: "store", goods: [{ item: "potion" }] }],
      },
      {
        op: "battle",
        setup: { enemy: "slime" },
        onWin: [switchCommand("won")],
        onLose: [{ op: "erase" }],
        onEscape: [{ op: "wait", seconds: 1 }],
      },
    ];

    const rows = flattenCommands(commands);
    expect(rows.map((row) => row.command.op)).toEqual([
      "text",
      "if",
      "choices",
      "switch",
      "ext",
      "exit",
      "shop",
      "battle",
      "switch",
      "wait",
      "erase",
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 1, 2, 2, 2, 1, 0, 1, 1, 1]);
    expect(rows.map((row) => row.branch ?? null)).toEqual([
      null,
      null,
      "Then",
      "Option 1: One",
      "Option 2: Two",
      "Cancel",
      "Else",
      null,
      "Win",
      "Escape",
      "Lose",
    ]);
    expect(rows.every((row) => row.editable && !row.readOnly)).toBe(true);
    expect(rows[3]!.key).toBe("i1:then/c0:option:0#0");
    expect(getCommandList(commands, rows[3]!.address.path)).toBe(
      (commands[1] as Extract<Command, { op: "if" }>).then[0]!.op === "choices"
        ? ((commands[1] as Extract<Command, { op: "if" }>).then[0] as Extract<Command, { op: "choices" }>).options[0]!.commands
        : null,
    );
  });

  test("inserts into all optional and required branch families without mutating the input", () => {
    const original: Command[] = [
      { op: "if", if: { kind: "gold", amount: 1 }, then: [] },
      { op: "choices", prompt: "?", options: [{ text: "A", commands: [] }, { text: "B", commands: [] }] },
      { op: "battle", setup: { id: "b" } },
    ];
    const snapshot = JSON.stringify(original);

    let next = insertCommand(original, commandAddress(ifBranchPath(root(0), "then"), 0), switchCommand("then"));
    next = insertCommand(next, commandAddress(ifBranchPath(root(0), "else"), 0), switchCommand("else"));
    next = insertCommand(next, commandAddress(choiceBranchPath(root(1), 1), 0), switchCommand("option"));
    next = insertCommand(next, commandAddress(choiceBranchPath(root(1), "cancel"), 0), switchCommand("cancel"));
    next = insertCommand(next, commandAddress(battleBranchPath(root(2), "win"), 0), switchCommand("win"));
    next = insertCommand(next, commandAddress(battleBranchPath(root(2), "lose"), 0), switchCommand("lose"));
    next = insertCommand(next, commandAddress(battleBranchPath(root(2), "escape"), 0), switchCommand("escape"));

    expect(JSON.stringify(original)).toBe(snapshot);
    expect(flattenCommands(next).map((row) => row.command.op === "switch" ? row.command.id : row.command.op)).toEqual([
      "if", "then", "else", "choices", "option", "cancel", "battle", "win", "escape", "lose",
    ]);
    expect((next[0] as Extract<Command, { op: "if" }>).else).toEqual([switchCommand("else")]);
    expect((next[1] as Extract<Command, { op: "choices" }>).cancel?.commands).toEqual([switchCommand("cancel")]);
    expect((next[2] as Extract<Command, { op: "battle" }>).onEscape).toEqual([switchCommand("escape")]);
  });

  test("treats scene onDone/onCancel as command containers like battle branches", () => {
    // B6: a scene's result branches are command containers, addressable and
    // editable exactly like battle win/lose/escape.
    const commands: Command[] = [
      {
        op: "scene",
        id: "game.pc",
        onDone: [switchCommand("done")],
        onCancel: [{ op: "text", lines: ["cancelled"] }],
      },
    ];
    const rows = flattenCommands(commands);
    expect(rows.map((row) => row.command.op)).toEqual(["scene", "switch", "text"]);
    expect(rows.map((row) => row.branch ?? null)).toEqual([null, "Done", "Cancel"]);
    expect(rows.map((row) => row.readOnly)).toEqual([false, false, false]);
    expect(rows[1]!.key).toBe("s0:done#0");
    expect(getCommandList(commands, rows[1]!.address.path)).toBe(
      (commands[0] as Extract<Command, { op: "scene" }>).onDone ?? null,
    );
    // Insert into both branches without mutating the input.
    const snapshot = JSON.stringify(commands);
    let next = insertCommand(commands, commandAddress(sceneBranchPath(root(0), "done"), 1), switchCommand("done2"));
    next = insertCommand(next, commandAddress(sceneBranchPath(root(0), "cancel"), 0), switchCommand("cancelled"));
    expect(JSON.stringify(commands)).toBe(snapshot);
    expect(flattenCommands(next).map((row) => row.command.op === "switch" ? row.command.id : row.command.op)).toEqual([
      "scene", "done", "done2", "cancelled", "text",
    ]);
    expect((next[0] as Extract<Command, { op: "scene" }>).onCancel).toEqual([
      switchCommand("cancelled"),
      { op: "text", lines: ["cancelled"] },
    ]);
  });

  test("a text summary names only the layout fields an author set", () => {
    expect(commandSummary({ op: "text", lines: ["Hi", "there"], cps: 20 })).toBe("Text: Hi / there");
    expect(commandSummary({ op: "text", lines: ["Hi"], position: "top", align: "center" })).toBe("Text: Hi [top, center]");
    expect(commandSummary({ op: "text", lines: ["Hi"], position: "bottomRight", align: "right", valign: "bottom", background: "dim" }))
      .toBe("Text: Hi [bottomRight, right, bottom, dim]");
    expect(commandSummary({ op: "text", lines: ["Hi"], background: 3 })).toBe("Text: Hi");
  });

  test("treats a loop body as a command container with break as an owned leaf", () => {
    expect(defaultCommand("loop")).toEqual({ op: "loop", commands: [] });
    expect(defaultCommand("break")).toEqual({ op: "break" });
    expect(isEditableCommand({ op: "loop", commands: [] })).toBe(true);
    expect(isEditableCommand({ op: "break" })).toBe(true);
    expect(commandSummary({ op: "loop", commands: [{ op: "break" }] })).toBe("Loop (1 command)");
    expect(commandSummary({ op: "break" })).toBe("Break loop");

    // Insert a loop, then a text and a break into its body; nothing mutates.
    const original: Command[] = [{ op: "text", lines: ["before"] }];
    const snapshot = JSON.stringify(original);
    let commands = insertCommand(original, root(1), defaultCommand("loop"));
    const body = loopBodyPath(root(1));
    expect(commandPathKey(body)).toBe("l1:body");
    expect(commandAddressKey(commandAddress(body, 0))).toBe("l1:body#0");
    commands = insertCommand(commands, commandAddress(body, 0), { op: "text", lines: ["HP {v:hp}"] });
    commands = insertCommand(commands, commandAddress(body, 1), { op: "break" });
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(commands[1]).toEqual({ op: "loop", commands: [{ op: "text", lines: ["HP {v:hp}"] }, { op: "break" }] });

    // The body flattens one level deeper, under a "Body" branch, in order.
    const rows = flattenCommands(commands);
    expect(rows.map((row) => [row.key, row.command.op, row.depth, row.branch ?? null])).toEqual([
      ["root#0", "text", 0, null],
      ["root#1", "loop", 0, null],
      ["l1:body#0", "text", 1, "Body"],
      ["l1:body#1", "break", 1, "Body"],
    ]);
    expect(rows.every((row) => !row.readOnly)).toBe(true);

    // Nested containers inside a loop body keep composing.
    const ifInLoop = insertCommand(commands, commandAddress(body, 1), defaultCommand("if"));
    const thenPath = [...body, { kind: "if", index: 1, branch: "then" } as const];
    const withNested = insertCommand(ifInLoop, commandAddress(thenPath, 0), { op: "break" });
    expect(flattenCommands(withNested).find((row) => row.depth === 2)?.key).toBe("l1:body/i1:then#0");

    // Move the break out of the body to the root, then back, then delete.
    const movedOut = moveCommand(commands, commandAddress(body, 1), root(0));
    expect(movedOut.map((command) => command.op)).toEqual(["break", "text", "loop"]);
    expect(getCommandList(movedOut, loopBodyPath(root(2)))).toEqual([{ op: "text", lines: ["HP {v:hp}"] }]);
    const movedBack = moveCommand(movedOut, root(0), commandAddress(loopBodyPath(root(2)), 0));
    expect(getCommandList(movedBack, loopBodyPath(root(1)))?.map((command) => command.op)).toEqual(["break", "text"]);
    // A loop cannot be moved into its own body.
    expect(moveCommand(commands, root(1), commandAddress(body, 0))).toBe(commands);
    const deleted = deleteCommand(commands, commandAddress(body, 0));
    expect(getCommandList(deleted, body)).toEqual([{ op: "break" }]);
    // A loop segment on a non-loop command does not resolve.
    expect(getCommandList(commands, loopBodyPath(root(0)))).toBeNull();
  });

  test("updates, copies, deletes and moves nested commands with structural sharing", () => {
    const option0 = [switchCommand("a"), switchCommand("b"), switchCommand("c")];
    const untouchedOption = { text: "Other", commands: [switchCommand("other")] };
    const choices: Extract<Command, { op: "choices" }> = {
      op: "choices",
      prompt: "Pick",
      options: [{ text: "Main", commands: option0 }, untouchedOption],
    };
    const commands: Command[] = [choices, { op: "text", lines: ["after"] }];
    const path = choiceBranchPath(root(0), 0);

    const updated = updateCommand(commands, commandAddress(path, 1), (command) => {
      expect(command.op).toBe("switch");
      return switchCommand("updated");
    });
    expect(getCommandList(updated, path)?.map((command) => command.op === "switch" ? command.id : "?")).toEqual(["a", "updated", "c"]);
    expect(updated[1]).toBe(commands[1]);
    expect((updated[0] as typeof choices).options[1]).toBe(untouchedOption);

    const copied = copyCommand(updated, commandAddress(path, 0));
    expect(getCommandList(copied, path)?.map((command) => command.op === "switch" ? command.id : "?")).toEqual(["a", "a", "updated", "c"]);
    expect(getCommandList(copied, path)?.[0]).toBe(getCommandList(copied, path)?.[1]);

    const moved = moveCommand(copied, commandAddress(path, 3), 0);
    expect(getCommandList(moved, path)?.map((command) => command.op === "switch" ? command.id : "?")).toEqual(["c", "a", "a", "updated"]);
    const deleted = deleteCommand(moved, commandAddress(path, 2));
    expect(getCommandList(deleted, path)?.map((command) => command.op === "switch" ? command.id : "?")).toEqual(["c", "a", "updated"]);

    const invalid = insertCommand(deleted, commandAddress([{ kind: "if", index: 0, branch: "then" }], 0), switchCommand("bad"));
    expect(invalid).toBe(deleted);
  });

  test("keeps choice option icons through branch edits, copies and moves", () => {
    const choices: Extract<Command, { op: "choices" }> = {
      op: "choices",
      prompt: "Who?",
      options: [
        { text: "Hero", icon: { sprite: "hero", dir: "up", frame: 1 }, commands: [switchCommand("a")] },
        { text: "Guard", icon: { sprite: "npc" }, commands: [] },
      ],
    };
    let commands: Command[] = [choices];
    commands = insertCommand(commands, commandAddress(choiceBranchPath(root(0), 0), 1), switchCommand("b"));
    commands = moveCommand(commands, commandAddress(choiceBranchPath(root(0), 0), 0), commandAddress(choiceBranchPath(root(0), 1), 0));
    commands = deleteCommand(commands, commandAddress(choiceBranchPath(root(0), 0), 0));
    commands = copyCommand(commands, root(0));
    for (const command of commands) {
      expect((command as typeof choices).options.map((option) => option.icon)).toEqual([
        { sprite: "hero", dir: "up", frame: 1 },
        { sprite: "npc" },
      ]);
    }
    expect((commands[0] as typeof choices).options[1]!.commands).toEqual([switchCommand("a")]);
    expect(flattenCommands(commands).filter((row) => row.branch).map((row) => row.branch)).toEqual(["Option 2: Guard", "Option 2: Guard"]);
  });

  test("moves commands across branch lists and refuses moves into their own descendants", () => {
    const commands: Command[] = [
      {
        op: "if",
        if: { kind: "switch", id: "x" },
        then: [switchCommand("move-me")],
        else: [],
      },
      { op: "text", lines: ["tail"] },
    ];
    const thenPath = ifBranchPath(root(0), "then");
    const elsePath = ifBranchPath(root(0), "else");
    const moved = moveCommand(
      commands,
      commandAddress(thenPath, 0),
      commandAddress(elsePath, 0),
    );
    expect(getCommandList(moved, thenPath)).toEqual([]);
    expect(getCommandList(moved, elsePath)).toEqual([switchCommand("move-me")]);

    const selfNested: Command[] = [{
      op: "if",
      if: { kind: "switch", id: "self" },
      then: [switchCommand("child")],
    }];
    expect(moveCommand(
      selfNested,
      root(0),
      commandAddress(ifBranchPath(root(0), "then"), 1),
    )).toBe(selfNested);
  });

  test("provides schema-valid defaults for every editable command op", () => {
    const commands = EDITABLE_COMMAND_OPS.map((op) => defaultCommand(op));
    expect(commands.map((command) => command.op)).toEqual([...EDITABLE_COMMAND_OPS]);
    expect(defaultCommand("choices").options).toHaveLength(2);
    expect(defaultCommand("moveRoute").route).toEqual({ steps: [], repeat: false, skippable: false });

    const project: Project = {
      format: "rpgkit-project/v1",
      title: "Defaults",
      tileSize: 16,
      start: { map: "map", x: 0, y: 0, dir: "down" },
      sheets: [{ id: "town", cols: 1, rows: 1, pak: "chunks" }],
      items: [{ id: "item", name: "Item", sprite: "town.0" }],
      maps: [{
        id: "map",
        name: "Map",
        width: 1,
        height: 1,
        sheets: ["town"],
        ground: [null],
        events: [{ id: "event", x: 0, y: 0, pages: [{ trigger: "action", commands }] }],
      }],
      commonEvents: [{ id: "common", trigger: "none", commands: [] }],
    };
    expect(validateProject(project)).toEqual([]);
  });

  test("keeps complex payloads intact when other commands change and permits owned updates", () => {
    const shop: Command = {
      op: "shop",
      id: "rare-shop",
      goods: [{ item: "gem", price: 17, condition: { all: [{ kind: "ext", call: "game.rare", args: { z: 1, a: [2] } }] } }],
      sell: false,
      sellList: "hide",
    };
    const ext: Command = { op: "ext", call: "game.do", args: { z: 1, nested: ["x", { y: true }] } };
    const setup = { enemy: "slime", phases: [{ hp: 2 }] };
    const battle: Command = { op: "battle", setup, onWin: [switchCommand("won")] };
    const commands: Command[] = [shop, ext, battle, switchCommand("change")];
    const bytes = commands.slice(0, 3).map((command) => JSON.stringify(command));

    const changed = updateCommand(commands, root(3), switchCommand("changed"));
    expect(changed.slice(0, 3)).toEqual([shop, ext, battle]);
    expect(changed[0]).toBe(shop);
    expect(changed[1]).toBe(ext);
    expect(changed[2]).toBe(battle);
    expect(changed.slice(0, 3).map((command) => JSON.stringify(command))).toEqual(bytes);

    const replaced = updateCommand(changed, root(1), switchCommand("replace-extension"));
    expect(replaced).not.toBe(changed);
    expect(replaced[1]).toEqual(switchCommand("replace-extension"));
    const battleEdited = insertCommand(changed, commandAddress(battleBranchPath(root(2), "lose"), 0), { op: "exit" });
    const editedBattle = battleEdited[2] as Extract<Command, { op: "battle" }>;
    expect(editedBattle.setup).toBe(setup);
    expect(editedBattle.onWin).toBe((battle as Extract<Command, { op: "battle" }>).onWin);
    expect(JSON.stringify(editedBattle.setup)).toBe(JSON.stringify(setup));
  });

  test("summarizes screen commands and owns their rows", () => {
    const screen: Command[] = [
      { op: "screenFade", direction: "out", duration: 0.5 },
      { op: "screenTint", layer: "night", color: { r: 8, g: 16, b: 32, a: 96 }, duration: 1 },
      { op: "screenFlash", color: { r: 255, g: 240, b: 220, a: 200 }, intensity: 128, duration: 0.2 },
      { op: "screenShake", strength: 6, speed: 4, duration: 0.5 },
      { op: "camera", target: { x: 3, y: 4 }, duration: 1 },
      { op: "balloon", target: { event: "guide" }, icon: "alert", duration: 2 },
      { op: "screenBackdrop", layer: "cutscene", variant: "gradient-blue" },
    ];
    const rows = flattenCommands(screen);
    expect(rows.every((row) => row.editable && !row.readOnly)).toBe(true);
    expect(rows.map((row) => row.summary)).toEqual([
      "Screen fade out 0.5s",
      "Screen tint night rgba(8,16,32,96) 1s",
      "Screen flash rgba(255,240,220,200) ×128 0.2s",
      "Screen shake 6px @ 4Hz for 0.5s",
      "Camera tile (3, 4) 1s",
      "Balloon alert on event guide for 2s",
      "Backdrop cutscene = gradient-blue",
    ]);

    const commands = [...screen, switchCommand("before")];
    const bytes = screen.map((command) => JSON.stringify(command));
    const changed = updateCommand(commands, root(screen.length), switchCommand("after"));
    expect(changed.slice(0, screen.length).map((command) => JSON.stringify(command))).toEqual(bytes);
    const edited = updateCommand(changed, root(0), (command) => command.op === "screenFade"
      ? { ...command, duration: 2 }
      : command);
    expect(edited[0]).toEqual({ op: "screenFade", direction: "out", duration: 2 });
  });

  test("summarizes audio commands and owns their rows", () => {
    const audio: Command[] = [
      { op: "playBgm", id: "field", volume: 80, pitch: 90 },
      { op: "fadeoutBgm", duration: 1.5 },
      { op: "stopBgm" },
      { op: "pauseBgm" },
      { op: "resumeBgm" },
      { op: "playBgs", id: "rain" },
      { op: "fadeoutBgs", duration: 0 },
      { op: "playMe", id: "victory", duration: 4, volume: 75 },
      { op: "playSe", id: "door", pitch: 120 },
      { op: "saveBgm" },
      { op: "replayBgm" },
    ];
    const rows = flattenCommands(audio);
    expect(rows.every((row) => row.editable && !row.readOnly)).toBe(true);
    expect(rows.map((row) => row.summary)).toEqual([
      "Play BGM field",
      "Fade out BGM over 1.5s",
      "Stop BGM",
      "Pause BGM",
      "Resume BGM",
      "Play BGS rain",
      "Fade out BGS over 0s",
      "Play ME victory for 4s",
      "Play SE door",
      "Save BGM",
      "Replay BGM",
    ]);
  });

  test("summarizes movement control and map animation commands", () => {
    const commands: Command[] = [
      { op: "moveControl", target: { event: "guard" }, control: { kind: "speed", value: 6 } },
      {
        op: "moveControl",
        target: { event: "runner" },
        control: { kind: "routeSpeed", value: 5, tilesPerSecond: 7 },
      },
      { op: "mapAnim", id: "spark-1", anim: "spark", x: 3, y: 4 },
      { op: "mapAnim", id: "aura-1", anim: "aura", target: "player" },
      { op: "stopAnim", id: "spark-1" },
      { op: "stopAnim", anim: "aura" },
      { op: "stopAnim" },
    ];
    expect(commands.map((command) => commandSummary(command))).toEqual([
      "Move control event guard: speed 6",
      "Move control event runner: routeSpeed 5 @ 7 tiles/s",
      "Map animation spark as spark-1 on tile (3, 4)",
      "Map animation aura as aura-1 on player",
      "Stop map animation spark-1",
      "Stop map animations using aura",
      "Stop all map animations",
    ]);
    expect(flattenCommands(commands).every((row) => row.editable && !row.readOnly)).toBe(true);
  });
});

describe("editor condition and route helpers", () => {
  test("covers defaults and summaries for every condition kind", () => {
    const conditions = CONDITION_KINDS.map((kind) => defaultCondition(kind));
    expect(conditions.map((condition) => condition.kind)).toEqual([...CONDITION_KINDS]);
    expect(conditions.map((condition) => conditionSummary(condition))).toEqual([
      "Switch switch is ON",
      "Variable variable >= 0",
      "Self switch A is ON",
      "Item item ×1",
      "Gold ≥ 0",
      "Facing down",
      "Appearance this uses default sprite",
      'Tile property (0, 0) {"passage":null}',
      "World is idle",
      "Any BGM is playing",
      "Timer >= 0s",
      "Region 0 at (0, 0)",
      "Extension game.condition null",
    ]);
    expect(CONDITION_KINDS.map((kind) => defaultPageCondition(kind))).toEqual([
      { switch: "switch" },
      { variable: { id: "variable", op: ">=", value: 0 } },
      { selfSwitch: "A" },
      { item: "item" },
      { all: [{ kind: "gold", amount: 0 }] },
      { all: [{ kind: "facing", dir: "down" }] },
      { all: [{ kind: "appearance", target: "this", sprite: null }] },
      { all: [{ kind: "tileProperty", x: 0, y: 0, passage: null }] },
      { all: [{ kind: "worldIdle", negate: false }] },
      { all: [{ kind: "bgmPlaying", negate: false }] },
      { all: [{ kind: "timer", op: ">=", seconds: 0 }] },
      { all: [{ kind: "region", x: 0, y: 0, id: 0 }] },
      { all: [{ kind: "ext", call: "game.condition", args: null }] },
    ]);
  });

  test("displays compound page clauses with editable extension conditions", () => {
    const ext: Condition = { kind: "ext", call: "quest.ready", args: { chapter: 4, flags: ["a", "b"] } };
    const pageCondition: PageCondition = {
      switch: "opened",
      selfSwitch: "B",
      variable: { id: "visits", op: ">=", value: 3 },
      item: "key",
      all: [{ kind: "gold", amount: 10 }, ext],
    };
    const clauses = pageConditionClauses(pageCondition);
    expect(clauses.map((clause) => clause.source)).toEqual(["switch", "selfSwitch", "variable", "item", "all", "all"]);
    expect(clauses[5]!.condition).toBe(ext);
    expect(clauses[5]!.readOnly).toBe(false);
    expect(clauses[5]!.editable).toBe(true);
    expect(isEditableCondition(ext)).toBe(true);
    expect(clauses[5]!.summary).toContain("quest.ready");
    expect(clauses[5]!.summary).toContain('"chapter":4');
    expect(pageConditionSummary(pageCondition)).toContain("Switch opened is ON AND Self switch B is ON");
    expect(pageConditionSummary()).toBe("Always");
  });

  test("summarizes BGM conditions as editor-owned", () => {
    const any: Condition = { kind: "bgmPlaying" };
    const specific: Condition = { kind: "bgmPlaying", id: "field", negate: true };
    expect(conditionSummary(any)).toBe("Any BGM is playing");
    expect(conditionSummary(specific)).toBe("BGM field is not playing");
    expect(isEditableCondition(any)).toBe(true);

    const clauses = pageConditionClauses({ all: [specific] });
    expect(clauses).toEqual([expect.objectContaining({
      condition: specific,
      summary: "BGM field is not playing",
      editable: true,
      readOnly: false,
    })]);
  });

  test("summarizes appearance and tile-property conditions", () => {
    expect(conditionSummary({ kind: "appearance", target: { event: "guard" }, sprite: "armored" }))
      .toBe("Appearance event guard uses armored");
    expect(conditionSummary({ kind: "tileProperty", x: 2, y: 3, passage: "block", enter: ["left"] }))
      .toBe('Tile property (2, 3) {"passage":"block","enter":["left"]}');
  });

  test("names every basic move-route step and safely displays advanced steps", () => {
    expect(BASIC_MOVE_STEPS.map((step) => moveStepSummary(defaultMoveStep(step)))).toEqual([
      "Move down",
      "Move left",
      "Move right",
      "Move up",
      "Step forward",
      "Face down",
      "Face left",
      "Face right",
      "Face up",
      "Wait",
      "Turn randomly",
      "Turn toward player",
    ]);
    expect(moveStepSummary({ turnToward: { event: "guard" } })).toBe("Turn toward event guard");
    expect(moveStepSummary({ pathTo: { x: 4, y: 7, retries: 2 } })).toBe("Path to (4, 7)");
    expect(moveStepSummary({ approach: { target: "player" } })).toBe("Approach player");
  });

  test("summaries remain total for opaque and malformed values", () => {
    expect(commandSummary({ op: "futureOp", payload: { x: 1 } })).toBe("Unknown command (futureOp)");
    expect(conditionSummary({ kind: "futureCondition", payload: true })).toBe("Unknown condition (futureCondition)");
    const cyclic: Record<string, unknown> = { op: "ext", call: "game.cyclic" };
    cyclic.args = cyclic;
    expect(commandSummary(cyclic)).toBe("Extension game.cyclic [opaque]");
  });
});
