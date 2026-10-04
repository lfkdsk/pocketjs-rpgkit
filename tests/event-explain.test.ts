import { describe, expect, test } from "bun:test";
import {
  classifyCommand,
  explainEffectsDigest,
  explainEvent,
  explainPageHeadline,
  explainTrigger,
  VARIABLE_WRITE_OPS,
  type CommandWriteClass,
  type EventExplanation,
} from "../editor/engine/event-explain.ts";
import type { Command, GameEvent } from "../src/engine/types.ts";

function event(pages: GameEvent["pages"]): GameEvent {
  return { id: "test", x: 1, y: 2, pages };
}

describe("event explanation", () => {
  test("describes every trigger kind", () => {
    expect(explainTrigger("action")).toContain("confirms facing");
    expect(explainTrigger("playerTouch")).toContain("walks onto");
    expect(explainTrigger("eventTouch")).toContain("bumps into");
    expect(explainTrigger("autorun")).toContain("automatically");
    expect(explainTrigger("parallel")).toContain("background");
  });

  test("lists each page's condition, trigger and command count in order", () => {
    const explanation = explainEvent(event([
      { trigger: "action", commands: [{ op: "text", lines: ["hi"] }] },
      {
        trigger: "autorun",
        condition: { switch: "gate" },
        commands: [{ op: "exit" }],
      },
    ]));
    expect(explanation.trigger).toBe(explanation.pages[0]!.trigger);
    expect(explanation.pages).toHaveLength(2);
    expect(explanation.pages[0]!.condition).toBe("Always");
    expect(explanation.pages[0]!.commandCount).toBe(1);
    expect(explanation.pages[1]!.condition).toBe("Switch gate is ON");
    expect(explanation.pages[1]!.trigger).toContain("automatically");
    expect(explanation.pages[1]!.commandCount).toBe(1);
  });

  test("flattens branches into execution order with depth and branch labels", () => {
    const commands: Command[] = [
      { op: "text", lines: ["root"] },
      {
        op: "if",
        if: { kind: "switch", id: "gate" },
        then: [{ op: "switch", id: "gate", value: false }],
        else: [{ op: "exit" }],
      },
    ];
    const explanation = explainEvent(event([{ trigger: "action", commands }]));
    const steps = explanation.pages[0]!.steps;
    expect(steps.map((s) => s.summary)).toEqual([
      "Text: root",
      "If Switch gate is ON",
      "Switch gate = OFF",
      "Exit event",
    ]);
    expect(steps.map((s) => s.depth)).toEqual([0, 0, 1, 1]);
    expect(steps[2]!.branch).toBe("Then");
    expect(steps[3]!.branch).toBe("Else");
  });

  test("collects switches, self switches, variables, items, gold and common events across branches", () => {
    const commands: Command[] = [
      { op: "switch", id: "gate", value: true },
      { op: "selfSwitch", key: "A", value: true },
      { op: "variable", id: "count", set: { op: "set", value: 1 } },
      { op: "item", item: "potion", set: "add", count: 1 },
      { op: "gold", set: "add", amount: 50 },
      { op: "common", id: "heal" },
      {
        op: "choices",
        prompt: "Pick",
        options: [
          { text: "One", commands: [{ op: "item", item: "torch", set: "sub", count: 1 }] },
        ],
        cancel: { commands: [{ op: "gold", set: "sub", amount: 10 }] },
      },
    ];
    const explanation = explainEvent(event([{ trigger: "action", commands }]));
    expect(explanation.switches).toEqual(["gate"]);
    expect(explanation.selfSwitches).toEqual(["A"]);
    expect(explanation.variables).toEqual(["count"]);
    expect(explanation.items).toEqual([
      { id: "potion", direction: "gains" },
      { id: "torch", direction: "loses" },
    ]);
    expect(explanation.gold).toBe("both");
    expect(explanation.commonEvents).toEqual(["heal"]);
  });

  test("collects literal transfer targets but not variable-target ones", () => {
    const commands: Command[] = [
      { op: "transfer", map: "town", x: 1, y: 2 },
      { op: "transfer", map: { variable: "nextMap" }, x: 1, y: 2 },
    ];
    const explanation = explainEvent(event([{ trigger: "action", commands }]));
    expect(explanation.transfers).toEqual(["town"]);
  });

  test("an item both gained and lost is reported as loses (the conservative direction)", () => {
    const commands: Command[] = [
      { op: "item", item: "key", set: "add", count: 1 },
      { op: "item", item: "key", set: "sub", count: 1 },
    ];
    const explanation = explainEvent(event([{ trigger: "action", commands }]));
    expect(explanation.items).toEqual([{ id: "key", direction: "loses" }]);
  });

  test("the digest is a one-line summary and says so when nothing changes", () => {
    const busy = explainEvent(event([{
      trigger: "action",
      commands: [
        { op: "switch", id: "gate", value: true },
        { op: "transfer", map: "town", x: 1, y: 2 },
      ],
    }]));
    expect(explainEffectsDigest(busy)).toBe("sets switch gate; transfers to town");
    const idle = explainEvent(event([{ trigger: "action", commands: [{ op: "text", lines: ["hi"] }] }]));
    expect(explainEffectsDigest(idle)).toContain("changes no switches");
  });

  test("the digest never claims no-change when a runtime-decided writer is present", () => {
    // The round-2 review probe: ext/extChoice/battle/scene can return writes,
    // items, gold, switches or transfers at runtime (the handler/reducer owns
    // them). The static digest must not assert "changes no switches,
    // variables, items or maps" for an event that only contains one of these;
    // it must say the state change is runtime-decided instead. Only an event
    // with neither static writes nor any such command may claim no change.
    const extOnly = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "ext", call: "game.op", args: null }],
    }]));
    const extDigest = explainEffectsDigest(extOnly);
    expect(extDigest).not.toContain("changes no switches");
    expect(extDigest.toLowerCase()).toContain("runtime");
    expect(extDigest).toContain("extension");
    expect(extOnly.runtimeWrites).toEqual(["extension command"]);

    const battleOnly = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "battle", setup: { troop: 1 } }],
    }]));
    const battleDigest = explainEffectsDigest(battleOnly);
    expect(battleDigest).not.toContain("changes no switches");
    expect(battleDigest.toLowerCase()).toContain("runtime");
    expect(battleDigest).toContain("battle");
    expect(battleOnly.runtimeWrites).toEqual(["battle"]);

    const sceneOnly = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "scene", id: "game.journal" }],
    }]));
    const sceneDigest = explainEffectsDigest(sceneOnly);
    expect(sceneDigest).not.toContain("changes no switches");
    expect(sceneDigest.toLowerCase()).toContain("runtime");
    expect(sceneDigest).toContain("scene");
    expect(sceneOnly.runtimeWrites).toEqual(["scene"]);

    // extChoice without a static write field is still a runtime writer: its
    // resolver may return writes. (With a write field the static targets are
    // listed too — see the per-op test above.)
    const choiceOnly = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "extChoice", call: "game.pick", args: null, prompt: "Pick" }],
    }]));
    const choiceDigest = explainEffectsDigest(choiceOnly);
    expect(choiceDigest).not.toContain("changes no switches");
    expect(choiceDigest.toLowerCase()).toContain("runtime");
    expect(choiceOnly.runtimeWrites).toEqual(["extension choice"]);

    // A static write plus a runtime writer: both are named, in order.
    const mixed = explainEvent(event([{
      trigger: "action",
      commands: [
        { op: "switch", id: "gate", value: true },
        { op: "ext", call: "game.op", args: null },
      ],
    }]));
    const mixedDigest = explainEffectsDigest(mixed);
    expect(mixedDigest).toContain("sets switch gate");
    expect(mixedDigest.toLowerCase()).toContain("runtime");
    expect(mixedDigest.indexOf("sets switch gate")).toBeLessThan(mixedDigest.indexOf("runtime"));
    expect(mixed.runtimeWrites).toEqual(["extension command"]);

    // A runtime writer nested in a branch is still seen.
    const nested = explainEvent(event([{
      trigger: "action",
      commands: [{
        op: "choices",
        prompt: "Pick",
        options: [{ text: "One", commands: [{ op: "battle", setup: { troop: 1 } }] }],
      }],
    }]));
    expect(nested.runtimeWrites).toEqual(["battle"]);
    expect(explainEffectsDigest(nested)).not.toContain("changes no switches");

    // An event with neither static writes nor runtime writers still says so.
    const idle = explainEvent(event([{ trigger: "action", commands: [{ op: "text", lines: ["hi"] }] }]));
    expect(idle.runtimeWrites).toEqual([]);
    expect(explainEffectsDigest(idle)).toBe("changes no switches, variables, items or maps");
  });

  test("the digest never claims no-change for a shop (items and gold change at runtime)", () => {
    // The round-3 review probe: a shop changes items and gold when the player
    // buys or sells, so the static digest must not assert "changes no
    // switches, variables, items or maps" for an event that only opens a
    // shop; it must name the shop as a runtime-decided channel instead.
    const shopOnly = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "shop", id: "mart", goods: [] }],
    }]));
    const digest = explainEffectsDigest(shopOnly);
    expect(digest).not.toContain("changes no switches");
    expect(digest.toLowerCase()).toContain("runtime");
    expect(digest).toContain("shop");
    expect(shopOnly.runtimeWrites).toEqual(["shop"]);
  });

  test("the digest never claims no-change for a variable-target transfer", () => {
    // The round-3 review probe: a transfer whose map is read from a variable
    // resolves its destination at runtime, so the static digest cannot name
    // the map and must not claim "changes no switches, variables, items or
    // maps". A literal-map transfer is still listed statically.
    const varTarget = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "transfer", map: { variable: "nextMap" }, x: 1, y: 2 }],
    }]));
    const digest = explainEffectsDigest(varTarget);
    expect(digest).not.toContain("changes no switches");
    expect(digest.toLowerCase()).toContain("runtime");
    expect(digest).toContain("variable-target transfer");
    expect(varTarget.runtimeWrites).toEqual(["variable-target transfer"]);
    expect(varTarget.transfers).toEqual([]);

    const literal = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "transfer", map: "town", x: 1, y: 2 }],
    }]));
    expect(literal.runtimeWrites).toEqual([]);
    expect(literal.transfers).toEqual(["town"]);
    expect(explainEffectsDigest(literal)).toBe("transfers to town");
  });

  test("the digest never claims no-change for a static write with an empty-string id", () => {
    // The round-4 review probe: item's id field is `type: string` with no
    // minLength, so { item: "" } is schema-valid and the interpreter writes
    // items[""]. The collector skipped empty-string targets, so the digest
    // saw an empty display set and falsely claimed "changes no switches,
    // variables, items or maps" on a document that does write state. Empty
    // targets are listed (shown as an empty id) and the no-change claim is
    // gated on classifyCommand's results, not on whether the display
    // fragments came out empty.
    const commands: Command[] = [
      { op: "item", item: "", set: "add", count: 1 },
      { op: "common", id: "" },
      { op: "transfer", map: "", x: 1, y: 1 },
    ];
    const explanation = explainEvent(event([{ trigger: "action", commands }]));
    expect(explanation.items).toEqual([{ id: "", direction: "gains" }]);
    expect(explanation.commonEvents).toEqual([""]);
    expect(explanation.transfers).toEqual([""]);
    const digest = explainEffectsDigest(explanation);
    expect(digest).not.toContain("changes no switches");
    // The empty id is shown, not silently dropped.
    expect(digest).toContain('""');
  });

  test("the no-change claim is gated on the command classification, not on display fragments", () => {
    // A switch command without an id is not schema-valid, but Explain runs
    // on any openable document (lint reports the schema error separately).
    // classifyCommand still says `static` for it, so the digest must not
    // claim "changes no …" even though no display fragment can name the
    // target: the gate is the classification, not the collected fragments.
    const unnamed = { op: "switch", value: true } as unknown as Command;
    const explanation = explainEvent(event([{ trigger: "action", commands: [unnamed] }]));
    expect(explanation.switches).toEqual([]);
    expect(explainEffectsDigest(explanation)).not.toContain("changes no switches");
  });

  test("classifies every command op as static, runtime or none", () => {
    // One minimal command per op, with the class the classifier must return.
    // The Record type forces every op to have an entry, so a new op that
    // joins the Command union fails to compile here (and in classifyCommand's
    // never assertion) until it is classified — the digest can never again
    // silently call a state-changing command "no change".
    const examples: Record<Command["op"], { command: Command; expected: CommandWriteClass["kind"] }> = {
      text: { command: { op: "text", lines: [] }, expected: "none" },
      choices: { command: { op: "choices", prompt: "", options: [] }, expected: "none" },
      switch: { command: { op: "switch", id: "s", value: true }, expected: "static" },
      variable: { command: { op: "variable", id: "v", set: { op: "set", value: 1 } }, expected: "static" },
      selfSwitch: { command: { op: "selfSwitch", key: "A", value: true }, expected: "static" },
      if: { command: { op: "if", if: { kind: "switch", id: "s" }, then: [] }, expected: "none" },
      transfer: { command: { op: "transfer", map: "m", x: 0, y: 0 }, expected: "static" },
      moveRoute: { command: { op: "moveRoute", target: "player", route: { steps: [], repeat: false, skippable: false } }, expected: "none" },
      moveControl: { command: { op: "moveControl", target: "player", control: { kind: "stop" } }, expected: "none" },
      appearance: { command: { op: "appearance", target: "player" }, expected: "none" },
      layer: { command: { op: "layer", layer: "l" }, expected: "none" },
      changeParallax: { command: { op: "changeParallax", image: null, loopX: false, loopY: false, sx: 0, sy: 0 }, expected: "none" },
      tileProperty: { command: { op: "tileProperty", x: 0, y: 0 }, expected: "none" },
      screenFade: { command: { op: "screenFade", direction: "out", duration: 0 }, expected: "none" },
      screenTint: { command: { op: "screenTint", layer: "l", color: { r: 0, g: 0, b: 0, a: 0 }, duration: 0 }, expected: "none" },
      screenFlash: { command: { op: "screenFlash", color: { r: 0, g: 0, b: 0, a: 0 }, intensity: 0, duration: 0 }, expected: "none" },
      screenShake: { command: { op: "screenShake", strength: 0, speed: 0, duration: 0 }, expected: "none" },
      camera: { command: { op: "camera", target: "player", duration: 0 }, expected: "none" },
      scrollMap: { command: { op: "scrollMap", direction: "down", distance: 0, speed: 1 }, expected: "none" },
      balloon: { command: { op: "balloon", target: "player" }, expected: "none" },
      screenBackdrop: { command: { op: "screenBackdrop", layer: "l" }, expected: "none" },
      showPicture: { command: { op: "showPicture", id: 0, layer: "l", variant: "v", x: 0, y: 0 }, expected: "none" },
      movePicture: { command: { op: "movePicture", id: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 0, duration: 0 }, expected: "none" },
      rotatePicture: { command: { op: "rotatePicture", id: 0, speed: 0 }, expected: "none" },
      tintPicture: { command: { op: "tintPicture", id: 0, tone: { r: 0, g: 0, b: 0, gray: 0 }, duration: 0 }, expected: "none" },
      erasePicture: { command: { op: "erasePicture", id: 0 }, expected: "none" },
      timer: { command: { op: "timer", action: "read", variable: "v" }, expected: "static" },
      inputNumber: { command: { op: "inputNumber", variable: "v", digits: 1 }, expected: "static" },
      selectItem: { command: { op: "selectItem", variable: "v", itemType: "regular" }, expected: "static" },
      openMenu: { command: { op: "openMenu" }, expected: "none" },
      openSave: { command: { op: "openSave" }, expected: "none" },
      // A host-owned request like openSave: it writes no reducer state, so
      // it must not surface as a state-changing (or runtime) channel.
      autosave: { command: { op: "autosave" }, expected: "none" },
      gameOver: { command: { op: "gameOver" }, expected: "none" },
      returnTitle: { command: { op: "returnTitle" }, expected: "none" },
      changeName: { command: { op: "changeName", name: "" }, expected: "none" },
      mapNameDisplay: { command: { op: "mapNameDisplay", visible: true }, expected: "none" },
      menuAccess: { command: { op: "menuAccess", enabled: true }, expected: "none" },
      saveAccess: { command: { op: "saveAccess", enabled: true }, expected: "none" },
      locationInfo: { command: { op: "locationInfo", variable: "v", x: 0, y: 0, kind: "terrain" }, expected: "static" },
      wait: { command: { op: "wait", seconds: 0 }, expected: "none" },
      gold: { command: { op: "gold", set: "add", amount: 0 }, expected: "static" },
      item: { command: { op: "item", item: "i", set: "add", count: 1 }, expected: "static" },
      se: { command: { op: "se", name: "s" }, expected: "none" },
      playBgm: { command: { op: "playBgm", id: "b" }, expected: "none" },
      fadeoutBgm: { command: { op: "fadeoutBgm", duration: 0 }, expected: "none" },
      stopBgm: { command: { op: "stopBgm" }, expected: "none" },
      pauseBgm: { command: { op: "pauseBgm" }, expected: "none" },
      resumeBgm: { command: { op: "resumeBgm" }, expected: "none" },
      playBgs: { command: { op: "playBgs", id: "b" }, expected: "none" },
      fadeoutBgs: { command: { op: "fadeoutBgs", duration: 0 }, expected: "none" },
      playMe: { command: { op: "playMe", id: "m", duration: 0 }, expected: "none" },
      playSe: { command: { op: "playSe", id: "s" }, expected: "none" },
      stopSe: { command: { op: "stopSe" }, expected: "none" },
      saveBgm: { command: { op: "saveBgm" }, expected: "none" },
      replayBgm: { command: { op: "replayBgm" }, expected: "none" },
      erase: { command: { op: "erase" }, expected: "none" },
      exit: { command: { op: "exit" }, expected: "none" },
      loop: { command: { op: "loop", commands: [] }, expected: "none" },
      break: { command: { op: "break" }, expected: "none" },
      label: { command: { op: "label", name: "l" }, expected: "none" },
      jumpLabel: { command: { op: "jumpLabel", name: "l" }, expected: "none" },
      common: { command: { op: "common", id: "c" }, expected: "static" },
      shop: { command: { op: "shop", id: "s", goods: [] }, expected: "runtime" },
      mapAnim: { command: { op: "mapAnim", id: "a", anim: "an" }, expected: "none" },
      stopAnim: { command: { op: "stopAnim" }, expected: "none" },
      lockInput: { command: { op: "lockInput" }, expected: "none" },
      unlockInput: { command: { op: "unlockInput" }, expected: "none" },
      place: { command: { op: "place", target: "player", x: 0, y: 0 }, expected: "none" },
      ext: { command: { op: "ext", call: "c", args: null }, expected: "runtime" },
      extChoice: { command: { op: "extChoice", call: "c", args: null, prompt: "" }, expected: "runtime" },
      battle: { command: { op: "battle", setup: null }, expected: "runtime" },
      scene: { command: { op: "scene", id: "s" }, expected: "runtime" },
    };
    for (const [op, { command, expected }] of Object.entries(examples)) {
      const cls = classifyCommand(command);
      expect(cls.kind, `op ${op}`).toBe(expected);
      if (cls.kind === "runtime") expect(cls.channel.length, `op ${op} channel`).toBeGreaterThan(0);
    }
    // The mixed ops' other variants: timer start/stop write no digest channel,
    // and a variable-target transfer is runtime.
    expect(classifyCommand({ op: "timer", action: "start", seconds: 1 }).kind).toBe("none");
    expect(classifyCommand({ op: "timer", action: "stop" }).kind).toBe("none");
    expect(classifyCommand({ op: "transfer", map: { variable: "nextMap" }, x: 0, y: 0 }))
      .toMatchObject({ kind: "runtime", channel: "variable-target transfer" });
  });

  test("an event with no pages explains without crashing", () => {
    const explanation: EventExplanation = explainEvent(event([]));
    expect(explanation.pages).toEqual([]);
    expect(explanation.switches).toEqual([]);
    expect(explanation.transfers).toEqual([]);
  });

  test("keeps long command text whole: the tail marker survives, no ellipsis", () => {
    const tail = "TAIL-MARKER";
    const long = `${"x".repeat(80)}${tail}`;
    const explanation = explainEvent(event([{
      trigger: "action",
      commands: [{ op: "text", lines: [long] }],
    }]));
    const summary = explanation.pages[0]!.steps[0]!.summary;
    expect(summary).toContain(tail);
    expect(summary).not.toContain("…");
    expect(summary).toContain("x".repeat(80));
  });

  test("keeps a long condition whole inside a nested command (the full flag reaches it)", () => {
    // The round-2 review probe: a legal long extension condition nested in an
    // `if` was truncated at the model layer (conditionSummary never received
    // the full flag), so the tail was gone before CSS wrapping could run.
    const tail = "COND-TAIL-MARKER";
    const long = `${"y".repeat(80)}${tail}`;
    const explanation = explainEvent(event([{
      trigger: "action",
      commands: [{
        op: "if",
        if: { kind: "ext", call: "game.condition", args: { note: long } },
        then: [{ op: "exit" }],
      }],
    }]));
    const summary = explanation.pages[0]!.steps[0]!.summary;
    expect(summary).toContain(tail);
    expect(summary).not.toContain("…");
    expect(summary).toContain("y".repeat(80));
    // The page's own condition line keeps the same guarantee.
    const pageCondition = explainEvent(event([{
      trigger: "action",
      condition: { all: [{ kind: "ext", call: "game.condition", args: { note: long } }] },
      commands: [],
    }])).pages[0]!.condition;
    expect(pageCondition).toContain(tail);
    expect(pageCondition).not.toContain("…");
  });

  test("reports every variable a command can write, per command op", () => {
    // One example per op in the exhaustive VARIABLE_WRITE_OPS list. When a
    // new command with a variable write target joins the Command union, the
    // type-level assertion in event-explain.ts fails to compile until the op
    // is listed here and handled by the collector.
    const examples: Record<(typeof VARIABLE_WRITE_OPS)[number], { command: Command; writes: string[] }> = {
      variable: { command: { op: "variable", id: "w.var", set: { op: "set", value: 1 } }, writes: ["w.var"] },
      timer: { command: { op: "timer", action: "read", variable: "w.timer" }, writes: ["w.timer"] },
      inputNumber: { command: { op: "inputNumber", variable: "w.input", digits: 1 }, writes: ["w.input"] },
      selectItem: { command: { op: "selectItem", variable: "w.select", itemType: "regular" }, writes: ["w.select"] },
      locationInfo: { command: { op: "locationInfo", variable: "w.loc", x: 0, y: 0, kind: "terrain" }, writes: ["w.loc"] },
      extChoice: {
        command: { op: "extChoice", call: "game.choice", args: null, prompt: "Pick", write: { index: "w.index", key: "w.key", cancelled: "w.cancel" } },
        writes: ["w.index", "w.key", "w.cancel"],
      },
    };
    for (const op of VARIABLE_WRITE_OPS) {
      const { command, writes } = examples[op]!;
      const explanation = explainEvent(event([{ trigger: "action", commands: [command] }]));
      for (const id of writes) {
        expect(explanation.variables).toContain(id);
      }
    }
    // All together, across a branch.
    const all = explainEvent(event([{
      trigger: "action",
      commands: [{
        op: "choices",
        prompt: "Pick",
        options: [{ text: "One", commands: [examples.variable!.command, examples.timer!.command] }],
        cancel: { commands: [examples.extChoice!.command] },
      }, examples.inputNumber!.command, examples.selectItem!.command, examples.locationInfo!.command],
    }]));
    expect(all.variables).toEqual([
      "w.cancel", "w.index", "w.input", "w.key", "w.loc", "w.select", "w.timer", "w.var",
    ]);
  });

  test("a timer start or stop is not a variable write", () => {
    const explanation = explainEvent(event([{
      trigger: "action",
      commands: [
        { op: "timer", action: "start", seconds: 10 },
        { op: "timer", action: "stop" },
      ],
    }]));
    expect(explanation.variables).toEqual([]);
  });

  test("sorts effects by code point, not the host locale", () => {
    // Ordinal order is a10 < a2 < b1; a locale-aware numeric collation would
    // put a2 before a10. The explanation must be identical on every host.
    const explanation = explainEvent(event([{
      trigger: "action",
      commands: [
        { op: "variable", id: "a2", set: { op: "set", value: 1 } },
        { op: "variable", id: "a10", set: { op: "set", value: 1 } },
        { op: "variable", id: "b1", set: { op: "set", value: 1 } },
      ],
    }]));
    expect(explanation.variables).toEqual(["a10", "a2", "b1"]);
  });

  test("the page headline carries the page's own trigger, condition and command count", () => {
    const explanation = explainEvent(event([
      { trigger: "autorun", commands: [{ op: "text", lines: ["one"] }, { op: "exit" }] },
      { trigger: "parallel", condition: { switch: "gate" }, commands: [] },
    ]));
    const first = explainPageHeadline(explanation.pages[0]!);
    expect(first).toContain("Page 1");
    expect(first).toContain("automatically");
    expect(first).toContain("Always");
    expect(first).toContain("2 commands");
    const second = explainPageHeadline(explanation.pages[1]!);
    expect(second).toContain("Page 2");
    expect(second).toContain("background");
    expect(second).toContain("Switch gate is ON");
  });
});
