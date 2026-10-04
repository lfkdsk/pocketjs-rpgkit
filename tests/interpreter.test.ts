// tests/rpgkit-interpreter.test.ts — pure-TS unit tests for the P1③ event
// interpreter. No host/framework imports: the engine is a plain reducer, so
// these run under bun directly (and in the browser condition in the rpgkit
// sim stage). Each command in the v1 vocabulary has a case, plus nested
// branches, page-selection timing, autorun/parallel arbitration, the seeded
// RNG, and the external (transfer/moveRoute) parking used by P1④.

import { describe, expect, test } from "bun:test";
import {
  TICK_HZ,
  compile,
  continueExternal,
  createInterpState,
  createSwitchState,
  createWorld,
  eventKey,
  eventIdLess,
  isBusy,
  randInt,
  revealedChars,
  secondsToFrames,
  stepInterp,
  stepInterpWithExtensionsInPlace,
  shareInterp,
  ownRecord,
  type InterpInput,
  type InterpState,
} from "../src/engine/interpreter.ts";
import { activePage, evalCondition, cloneInterp } from "../src/engine/interpreter.ts";
import { createExtensionRuntime } from "../src/engine/extensions.ts";
import { validateSchema, type VError } from "../src/engine/schema-validate.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

// --- test scaffolding --------------------------------------------------------

const MAP_ID = "v";

function map(events: GameEvent[], w = 20, h = 13): MapDef {
  return {
    id: MAP_ID,
    name: "test",
    width: w,
    height: h,
    sheets: ["town"],
    ground: Array(w * h).fill("town.0"),
    events,
  };
}

const NO_EDGE = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

function input(partial: Partial<InterpInput> = {}): InterpInput {
  const cell = partial.playerCell ?? { x: 10, y: 10 };
  return {
    ...NO_EDGE,
    playerCell: cell,
    prevCell: partial.prevCell ?? cell,
    facing: partial.facing ?? 2,
    ...partial,
  };
}

/** Run n plain frames (no edges), player standing still. */
function idle(s0: InterpState, w: ReturnType<typeof createWorld>, n = 1): InterpState {
  let s = s0;
  for (let i = 0; i < n; i++) s = stepInterp(w, s, input());
  return s;
}

function confirmAt(
  s0: InterpState,
  w: ReturnType<typeof createWorld>,
  cell = { x: 10, y: 10 },
  facing: 0 | 1 | 2 | 3 = 2,
): InterpState {
  return stepInterp(w, s0, input({ confirmEdge: true, playerCell: cell, facing }));
}

function event(id: string, x: number, y: number, commands: Command[], trigger: GameEvent["pages"][number]["trigger"] = "action", condition?: GameEvent["pages"][number]["condition"]): GameEvent {
  return {
    id,
    x,
    y,
    pages: [{ trigger, commands, ...(condition ? { condition } : {}) }],
  };
}

// --- virtual time ------------------------------------------------------------

describe("virtual time", () => {
  test("seconds map to exact frame counts at 60/30/10/2 Hz", () => {
    expect(secondsToFrames(0.5, 60)).toBe(30);
    expect(secondsToFrames(0.5, 30)).toBe(15);
    expect(secondsToFrames(0.5, 10)).toBe(5);
    expect(secondsToFrames(0.5, 2)).toBe(1);
    expect(secondsToFrames(1, 60)).toBe(60);
  });

  test("typewriter reveals the same characters at the same virtual instant across Hz", () => {
    // R2 contract: at virtual t=1s a 30-cps line shows exactly 30 chars.
    for (const hz of [60, 30, 10, 2]) {
      expect(revealedChars(40, 30, hz, hz)).toBe(30);
    }
    // 30 cps at 60 Hz = 0.5 char/frame: floor accumulation.
    expect(revealedChars(40, 30, 1, 60)).toBe(0);
    expect(revealedChars(40, 30, 2, 60)).toBe(1);
    expect(revealedChars(40, 30, 4, 60)).toBe(2);
    // clamps at line length, never negative.
    expect(revealedChars(5, 30, 100, 60)).toBe(5);
    expect(revealedChars(5, 30, 0, 60)).toBe(0);
  });

  test("a one-second wait compiles and elapses over hz frames through stepInterp", () => {
    for (const hz of [60, 20, 4]) {
      const w = createWorld(map([event("e", 10, 10, [
        { op: "wait", seconds: 1 },
        { op: "switch", id: "done", value: true },
      ], "autorun")]), [], hz);
      let s = createInterpState();
      // One frame starts the fiber and parks it on the wait; hz frames later
      // the wait lands and the switch applies on that release frame.
      s = idle(s, w, hz + 1);
      expect(s.sw.switches["done"], `done set after one virtual second at ${hz} Hz`).toBe(true);
    }
  });
});

// --- seeded RNG --------------------------------------------------------------

describe("seeded RNG (mulberry32, cursor in state)", () => {
  test("same cursor yields the same draw; a different cursor diverges", () => {
    const a = randInt(7, 1, 100);
    const a2 = randInt(7, 1, 100);
    expect(a2.value).toBe(a.value);
    const b = randInt(8, 1, 100);
    expect(b.value).not.toBe(a.value);
    // the cursor advances on every draw and is what gets saved.
    expect(a.next).not.toBe(7);
  });

  test("variable random draws from state.rng and advances the cursor", () => {
    const w = createWorld(map([event("e", 10, 9, [{ op: "variable", id: "roll", set: { op: "random", min: 1, max: 6 } }])]));
    let s = createInterpState(createSwitchState({ rng: 42 }));
    s = confirmAt(s, w);
    const first = s.sw.variables["roll"]!;
    const cursorAfter = s.sw.rng;
    // same cursor reproduces the draw
    const s2 = createInterpState(createSwitchState({ rng: 42 }));
    expect(confirmAt(s2, w).sw.variables["roll"]).toBe(first);
    // the next draw follows the advanced cursor
    const s3 = createInterpState(createSwitchState({ rng: cursorAfter }));
    expect(confirmAt(s3, w).sw.variables["roll"]).toBe(randInt(cursorAfter, 1, 6).value);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(6);
  });

  test("RNG continues identically across a JSON save/load boundary", () => {
    const w = createWorld(map([event("e", 10, 9, [
      { op: "variable", id: "roll", set: { op: "random", min: 0, max: 9999 } },
    ])]));
    const s1 = confirmAt(createInterpState(createSwitchState({ rng: 1234 })), w);
    const snapshot = JSON.parse(JSON.stringify(s1)) as InterpState;
    // reload and take the next draw through a new event run
    const w2 = createWorld(map([event("e2", 10, 9, [{ op: "variable", id: "next", set: { op: "random", min: 0, max: 9999 } }])]));
    const reloaded = confirmAt(snapshot, w2);
    const direct = randInt(snapshot.sw.rng, 0, 9999);
    expect(reloaded.sw.variables["next"]).toBe(direct.value);
    expect(reloaded.sw.rng).toBe(direct.next);
  });
});

// --- conditions and pages ----------------------------------------------------

describe("conditions and page selection", () => {
  test("evalCondition covers switch/variable/selfSwitch/item/gold", () => {
    const sw = createSwitchState({
      switches: { a: true },
      self: { "v/e": "A" },
      items: { key: 1, torch: 0 },
      variables: { n: 5 },
      gold: 9,
    });
    expect(evalCondition({ kind: "switch", id: "a" }, sw, "v/e")).toBe(true);
    expect(evalCondition({ kind: "switch", id: "a", value: false }, sw, "v/e")).toBe(false);
    expect(evalCondition({ kind: "switch", id: "missing" }, sw, "v/e")).toBe(false);
    expect(evalCondition({ kind: "variable", id: "n", op: ">=", value: 5 }, sw, "v/e")).toBe(true);
    expect(evalCondition({ kind: "variable", id: "n", op: ">=", value: 6 }, sw, "v/e")).toBe(false);
    expect(evalCondition({ kind: "variable", id: "n", op: "==", value: 5 }, sw, "v/e")).toBe(true);
    expect(evalCondition({ kind: "variable", id: "n", op: "!=", value: 4 }, sw, "v/e")).toBe(true);
    expect(evalCondition({ kind: "selfSwitch", key: "A" }, sw, "v/e")).toBe(true);
    expect(evalCondition({ kind: "selfSwitch", key: "B" }, sw, "v/e")).toBe(false);
    expect(evalCondition({ kind: "item", id: "key", count: 1 }, sw, "v/e")).toBe(true);
    expect(evalCondition({ kind: "item", id: "torch", count: 1 }, sw, "v/e")).toBe(false);
    expect(evalCondition({ kind: "gold", amount: 9 }, sw, "v/e")).toBe(true);
    expect(evalCondition({ kind: "gold", amount: 10 }, sw, "v/e")).toBe(false);
  });

  test("B6: selfSwitch false selects the off branch", () => {
    const commands: Command[] = [{
      op: "if",
      if: { kind: "selfSwitch", key: "A", value: false },
      then: [{ op: "switch", id: "off", value: true }],
      else: [{ op: "switch", id: "on", value: true }],
    }];
    const w = createWorld(map([event("npc", 10, 9, commands)]));

    const absent = confirmAt(createInterpState(), w);
    const held = confirmAt(createInterpState(createSwitchState({
      self: { "v/npc": "A" },
    })), w);

    expect(evalCondition(
      { kind: "selfSwitch", key: "A", value: false },
      absent.sw,
      "v/npc",
    )).toBe(true);
    expect(absent.sw.switches).toMatchObject({ off: true });
    expect(absent.sw.switches["on"]).toBeUndefined();
    expect(held.sw.switches).toMatchObject({ on: true });
    expect(held.sw.switches["off"]).toBeUndefined();
  });

  test("activePage is the highest-index page whose condition holds", () => {
    const sw = createSwitchState();
    const ev: GameEvent = {
      id: "chest",
      x: 0, y: 0,
      pages: [
        { trigger: "action", commands: [] },
        { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
        { trigger: "action", condition: { selfSwitch: "B" }, commands: [] },
      ],
    };
    expect(activePage(ev, sw, MAP_ID)?.index).toBe(0);
    sw.self[eventKey(MAP_ID, "chest")] = "A";
    expect(activePage(ev, sw, MAP_ID)?.index).toBe(1);
    sw.self[eventKey(MAP_ID, "chest")] = "B";
    expect(activePage(ev, sw, MAP_ID)?.index).toBe(2);
  });

  test("a page with no active page does not trigger", () => {
    const ev: GameEvent = {
      id: "gated",
      x: 10, y: 9,
      pages: [{ trigger: "action", condition: { switch: "locked" }, commands: [{ op: "switch", id: "fired", value: true }] }],
    };
    const w = createWorld(map([ev]));
    const s = confirmAt(createInterpState(), w);
    expect(s.sw.switches["fired"]).toBeUndefined();
  });

  test("multi-condition page requires switch AND variable AND selfSwitch simultaneously", () => {
    const ev: GameEvent = {
      id: "gate", x: 10, y: 9,
      pages: [{
        trigger: "action",
        condition: { switch: "rune-lit", selfSwitch: "A", variable: { id: "n", op: ">=", value: 3 } },
        commands: [{ op: "switch", id: "opened", value: true }],
      }],
    };
    const w = createWorld(map([ev]));
    const sw0 = createSwitchState({ switches: { "rune-lit": true }, variables: { n: 3 } });
    // self switch missing: inactive
    expect(confirmAt(createInterpState(sw0), w).sw.switches["opened"]).toBeUndefined();
    const sw1 = createSwitchState({ switches: { "rune-lit": true }, variables: { n: 3 }, self: { [`${MAP_ID}/gate`]: "A" } });
    expect(confirmAt(createInterpState(sw1), w).sw.switches["opened"]).toBe(true);
  });
});

// --- instant commands --------------------------------------------------------

describe("instant commands", () => {
  function run(cmds: Command[]): InterpState {
    const w = createWorld(map([event("e", 10, 9, cmds)]));
    return idle(confirmAt(createInterpState(createSwitchState({ gold: 5 })), w), w, 2);
  }

  test("switch sets a global boolean", () => {
    expect(run([{ op: "switch", id: "a", value: true }]).sw.switches["a"]).toBe(true);
  });

  test("variable set/add/sub", () => {
    expect(run([{ op: "variable", id: "v", set: { op: "set", value: 4 } }]).sw.variables["v"]).toBe(4);
    expect(run([{ op: "variable", id: "v", set: { op: "add", value: 3 } }]).sw.variables["v"]).toBe(3);
    expect(run([{ op: "variable", id: "v", set: { op: "sub", value: 2 } }]).sw.variables["v"]).toBe(-2);
  });

  test("selfSwitch sets this event's A..D and false clears it", () => {
    const s = run([{ op: "selfSwitch", key: "A", value: true }]);
    expect(s.sw.self[`${MAP_ID}/e`]).toBe("A");
    const s2 = run([
      { op: "selfSwitch", key: "A", value: true },
      { op: "selfSwitch", key: "A", value: false },
    ]);
    expect(s2.sw.self[`${MAP_ID}/e`]).toBeUndefined();
  });

  test("gold add/sub starts from initialGold", () => {
    expect(run([{ op: "gold", set: "add", amount: 25 }]).sw.gold).toBe(30);
    expect(run([{ op: "gold", set: "sub", amount: 5 }]).sw.gold).toBe(0);
  });

  test("item add/sub counts and can go negative only on sub", () => {
    const s = run([
      { op: "item", item: "key", set: "add", count: 2 },
      { op: "item", item: "key", set: "sub", count: 1 },
    ]);
    expect(s.sw.items["key"]).toBe(1);
  });

  test("se emits a drained-on-next-step cue", () => {
    const w = createWorld(map([event("e", 10, 9, [{ op: "se", name: "drip", volume: 40 }])]));
    const fired = confirmAt(createInterpState(), w);
    expect(fired.cues).toEqual([{ name: "drip", volume: 40, pitch: 100 }]);
    const next = idle(fired, w, 1);
    expect(next.cues).toEqual([]); // cues live one frame
  });

  test("stopSe emits a stop cue in the same sequence", () => {
    const w = createWorld(map([event("e", 10, 9, [
      { op: "se", name: "a" },
      { op: "stopSe" },
      { op: "se", name: "b" },
    ])]));
    const fired = confirmAt(createInterpState(), w);
    expect(fired.cues).toEqual([
      { name: "a", volume: 80, pitch: 100 },
      { stop: true },
      { name: "b", volume: 80, pitch: 100 },
    ]);
  });

  test("exit stops the interpreter before later commands", () => {
    const s = run([
      { op: "switch", id: "a", value: true },
      { op: "exit" },
      { op: "switch", id: "b", value: true },
    ]);
    expect(s.sw.switches["a"]).toBe(true);
    expect(s.sw.switches["b"]).toBeUndefined();
    expect(isBusy(s)).toBe(false);
  });

  test("erase removes the event for the rest of the map visit", () => {
    const w = createWorld(map([event("e", 10, 9, [
      { op: "variable", id: "n", set: { op: "add", value: 1 } },
      { op: "erase" },
    ])]));
    let s = confirmAt(createInterpState(), w);
    expect(s.erased[`${MAP_ID}/e`]).toBe(true);
    expect(s.sw.variables["n"]).toBe(1);
    // confirming again does nothing: the event is gone
    const again = confirmAt(s, w);
    expect(again.sw.variables["n"]).toBe(1);
  });

  test("wait pauses for the converted frame count then continues", () => {
    const w = createWorld(map([event("e", 10, 9, [
      { op: "wait", seconds: 0.5 },
      { op: "switch", id: "after", value: true },
    ])]));
    let s = confirmAt(createInterpState(), w); // frame 1: wait begins
    expect(s.sw.switches["after"]).toBeUndefined();
    s = idle(s, w, 29); // frames 2..30 waiting
    expect(s.sw.switches["after"]).toBeUndefined();
    s = idle(s, w, 1); // frame 31: wait completes and the switch applies
    expect(s.sw.switches["after"]).toBe(true);
    expect(isBusy(s)).toBe(false);
  });
});

// --- conditional branches ----------------------------------------------------

describe("conditional branches", () => {
  const nested: Command = {
    op: "if",
    if: { kind: "switch", id: "a", value: true },
    then: [{
      op: "if",
      if: { kind: "variable", id: "v", op: ">=", value: 5 },
      then: [{
        op: "if",
        if: { kind: "item", id: "key", count: 1 },
        then: [{ op: "gold", set: "add", amount: 100 }],
      }],
    }],
  };

  test("three-deep nested ifs evaluate bottom-up (compile to if/jmp)", () => {
    const prog = compile([nested]);
    expect(prog.map((i) => i.op)).toEqual(["if", "if", "if", "gold", "jmp", "jmp", "jmp"]);
    const w = createWorld(map([event("e", 10, 9, [nested])]));
    const sw = createSwitchState({ switches: { a: true }, variables: { v: 10 }, items: { key: 1 }, gold: 0 });
    expect(idle(confirmAt(createInterpState(sw), w), w, 1).sw.gold).toBe(100);
    const failEach = [
      createSwitchState({ switches: { a: false }, variables: { v: 10 }, items: { key: 1 } }),
      createSwitchState({ switches: { a: true }, variables: { v: 4 }, items: { key: 1 } }),
      createSwitchState({ switches: { a: true }, variables: { v: 5 }, items: {} }),
    ];
    for (const bad of failEach) expect(idle(confirmAt(createInterpState(bad), w), w, 1).sw.gold).toBe(0);
  });

  test("else runs when the condition fails", () => {
    const w = createWorld(map([event("e", 10, 9, [{
      op: "if",
      if: { kind: "switch", id: "a" },
      then: [{ op: "gold", set: "add", amount: 10 }],
      else: [{ op: "gold", set: "add", amount: 100 }],
    }])]));
    expect(idle(confirmAt(createInterpState(), w), w, 1).sw.gold).toBe(100);
  });

  test("variable threshold at == satisfies >=", () => {
    const w = createWorld(map([event("e", 10, 9, [{
      op: "if",
      if: { kind: "variable", id: "c", op: ">=", value: 5 },
      then: [{ op: "switch", id: "yes", value: true }],
    }])]));
    const sw = createSwitchState({ variables: { c: 5 } });
    expect(idle(confirmAt(createInterpState(sw), w), w, 1).sw.switches["yes"]).toBe(true);
  });
});

// --- text + choices suspending commands --------------------------------------

describe("text command", () => {
  const w = createWorld(map([event("sign", 10, 9, [
    { op: "text", cps: 30, lines: ["ABCDEFGHIJ", "KLMNOPQRST"] }, // 20 + 1 newline
    { op: "switch", id: "read", value: true },
  ])]));

  test("typewriter reveals floor(cps/hz * frame) chars of the joined text", () => {
    let s = confirmAt(createInterpState(), w);
    expect(s.modal?.kind).toBe("text");
    // the trigger and the text opening both resolve on frame 1: since=1,
    // elapsed 0 -> 0 chars.
    expect((s.modal as { revealed: number }).revealed).toBe(0);
    s = idle(s, w, 1); // elapsed 1 frame -> 0 chars (0.5/frame)
    expect((s.modal as { revealed: number }).revealed).toBe(0);
    s = idle(s, w, 1); // elapsed 2 -> 1
    expect((s.modal as { revealed: number }).revealed).toBe(1);
    s = idle(s, w, 38); // elapsed 40 -> floor(20.0)
    expect((s.modal as { revealed: number }).revealed).toBe(20);
    expect(s.modal).toMatchObject({ complete: false });
    s = idle(s, w, 2); // elapsed 42 -> 21 = 20 chars + newline
    expect((s.modal as { revealed: number }).revealed).toBe(21);
    expect(s.modal).toMatchObject({ complete: true });
  });

  test("confirm skips the typewriter; the next confirm advances past it", () => {
    let s = confirmAt(createInterpState(), w); // opens at frame 1
    s = stepInterp(w, s, input({ confirmEdge: true })); // frame 2: skip
    expect(s.modal).toMatchObject({ complete: true, revealed: 21 });
    expect(s.sw.switches["read"]).toBeUndefined();
    s = stepInterp(w, s, input({ confirmEdge: true })); // frame 3: advance
    expect(s.modal).toBeNull();
    expect(s.sw.switches["read"]).toBe(true);
    expect(isBusy(s)).toBe(false);
  });
});

describe("choices command", () => {
  const w = createWorld(map([event("elder", 10, 9, [
    { op: "text", lines: ["Hello."] },
    {
      op: "choices",
      prompt: "Which?",
      options: [
        { text: "First", commands: [{ op: "switch", id: "pick", value: false }, { op: "switch", id: "first", value: true }] },
        { text: "Second", commands: [{ op: "switch", id: "pick", value: true }] },
      ],
    },
  ])]));

  function openChoices(): InterpState {
    let s = confirmAt(createInterpState(), w); // opens text
    s = stepInterp(w, s, input({ confirmEdge: true })); // skip text
    s = stepInterp(w, s, input({ confirmEdge: true })); // advance -> choices
    expect(s.modal).toMatchObject({ kind: "choices", index: 0 });
    return s;
  }

  test("up/down move the cursor with wraparound", () => {
    let s = openChoices();
    s = stepInterp(w, s, input({ downEdge: true }));
    expect(s.modal).toMatchObject({ kind: "choices", index: 1 });
    s = stepInterp(w, s, input({ downEdge: true }));
    expect(s.modal).toMatchObject({ index: 0 });
    s = stepInterp(w, s, input({ upEdge: true }));
    expect(s.modal).toMatchObject({ index: 1 });
  });

  test("confirm runs the selected branch as a pushed stack frame", () => {
    let s = openChoices();
    s = stepInterp(w, s, input({ downEdge: true }));
    s = stepInterp(w, s, input({ confirmEdge: true }));
    expect(s.sw.switches["pick"]).toBe(true);
    expect(isBusy(s)).toBe(false);
  });

  test("confirm on the default runs the first branch", () => {
    let s = openChoices();
    s = stepInterp(w, s, input({ confirmEdge: true }));
    expect(s.sw.switches["first"]).toBe(true);
    expect(s.sw.switches["pick"]).toBe(false);
  });

  test("cancel runs the cancel branch when present and nothing otherwise", () => {
    const wc = createWorld(map([event("e", 10, 9, [{
      op: "choices",
      prompt: "Q",
      options: [
        { text: "A", commands: [{ op: "switch", id: "a", value: true }] },
        { text: "B", commands: [] },
      ],
      cancel: { commands: [{ op: "switch", id: "cancelled", value: true }] },
    }])]));
    let s = confirmAt(createInterpState(), wc);
    expect(s.modal).toMatchObject({ kind: "choices", cancellable: true });
    s = stepInterp(wc, s, input({ cancelEdge: true }));
    expect(s.sw.switches["cancelled"]).toBe(true);
    // without a cancel branch, back is ignored
    const wn = createWorld(map([event("e", 10, 9, [{
      op: "choices", prompt: "Q",
      options: [{ text: "A", commands: [] }, { text: "B", commands: [] }],
    }])]));
    const s2 = stepInterp(wn, confirmAt(createInterpState(), wn), input({ cancelEdge: true }));
    expect(s2.modal).toMatchObject({ kind: "choices", cancellable: false });
  });

  test("an if inside a choice branch resolves against live state (merchant gold gate)", () => {
    const wg = createWorld(map([event("m", 10, 9, [{
      op: "choices",
      prompt: "Buy?",
      options: [{
        text: "Buy",
        commands: [{
          op: "if",
          if: { kind: "gold", amount: 10 },
          then: [{ op: "gold", set: "sub", amount: 10 }, { op: "item", item: "torch", set: "add", count: 1 }],
          else: [{ op: "switch", id: "poor", value: true }],
        }],
      }, { text: "No", commands: [] }],
    }])]));
    const rich = stepInterp(wg, confirmAt(createInterpState(createSwitchState({ gold: 25 })), wg), input({ confirmEdge: true }));
    expect(rich.sw.gold).toBe(15);
    expect(rich.sw.items["torch"]).toBe(1);
    const poor = stepInterp(wg, confirmAt(createInterpState(createSwitchState({ gold: 5 })), wg), input({ confirmEdge: true }));
    expect(poor.sw.switches["poor"]).toBe(true);
  });
});

// --- page switching timing ---------------------------------------------------

describe("page switching timing (chest pattern)", () => {
  const chest: GameEvent = {
    id: "chest", x: 10, y: 9,
    pages: [
      { trigger: "action", commands: [
        { op: "item", item: "key", set: "add", count: 1 },
        { op: "selfSwitch", key: "A", value: true },
        { op: "text", lines: ["Found a key."] },
      ] },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [{ op: "switch", id: "empty", value: true }] },
    ],
  };

  test("the active page is chosen at trigger time, mid-run flips do not swap it", () => {
    const w = createWorld(map([chest]));
    let s = confirmAt(createInterpState(), w); // page 0 starts, flips A
    s = stepInterp(w, s, input({ confirmEdge: true })); // skip
    s = stepInterp(w, s, input({ confirmEdge: true })); // advance
    expect(s.sw.items["key"]).toBe(1);
    expect(s.sw.switches["empty"]).toBeUndefined(); // page 1 did not run
    // next interaction selects page 1
    s = confirmAt(s, w);
    expect(s.sw.switches["empty"]).toBe(true);
  });
});

// --- triggers ----------------------------------------------------------------

describe("trigger arbitration", () => {
  test("action fires only on the tile one cell in front of the player", () => {
    const w = createWorld(map([event("n", 5, 5, [{ op: "switch", id: "hit", value: true }])]));
    // facing up from (10,10): front (10,9), nowhere near (5,5)
    expect(confirmAt(createInterpState(), w, { x: 10, y: 10 }, 2).sw.switches["hit"]).toBeUndefined();
    // walk the stub next to it: facing down, front (10,10)... place event at (10,11)
    const w2 = createWorld(map([event("n", 10, 11, [{ op: "switch", id: "hit", value: true }])]));
    expect(confirmAt(createInterpState(), w2, { x: 10, y: 10 }, 0).sw.switches["hit"]).toBe(true);
  });

  test("playerTouch fires on entry and relatches only after leaving", () => {
    const pad = event("pad", 10, 10, [{ op: "switch", id: "t", value: true }], "playerTouch");
    const w = createWorld(map([pad]));
    // standing still on the cell does nothing
    let s = stepInterp(w, createInterpState(), input({ playerCell: { x: 10, y: 10 }, prevCell: { x: 10, y: 10 } }));
    expect(s.sw.switches["t"]).toBeUndefined();
    // moving INTO the cell fires
    s = stepInterp(w, s, input({ playerCell: { x: 10, y: 10 }, prevCell: { x: 10, y: 11 } }));
    expect(s.sw.switches["t"]).toBe(true);
    // another frame on the same cell does not refire while busy; after it
    // ends, staying put still does not refire (latched)
    s = idle(s, w, 2);
    const t1 = s.sw.switches["t"];
    s = idle(s, w, 1);
    expect(s.sw.switches["t"]).toBe(t1);
  });

  test("autorun starts without input and blocks while running", () => {
    const w = createWorld(map([event("auto", 0, 0, [
      { op: "wait", seconds: 0.2 },
      { op: "switch", id: "ran", value: true },
    ], "autorun")]));
    let s = idle(createInterpState(), w, 1);
    expect(isBusy(s)).toBe(true);
    s = idle(s, w, 12);
    expect(s.sw.switches["ran"]).toBe(true);
  });

  test("a parallel event runs concurrently with an open dialog", () => {
    const dialog = event("npc", 10, 9, [{ op: "text", lines: ["Talk."] }], "action");
    const drip: GameEvent = {
      id: "drip", x: 0, y: 0,
      pages: [{ trigger: "parallel", commands: [
        { op: "variable", id: "drips", set: { op: "add", value: 1 } },
      ] }],
    };
    const w = createWorld(map([dialog, drip]));
    let s = idle(createInterpState(), w, 2); // parallel ran once per frame
    expect(s.sw.variables["drips"]).toBe(2);
    s = confirmAt(s, w); // open the dialog; parallel keeps running
    const before = s.sw.variables["drips"] as number;
    s = idle(s, w, 6);
    expect(s.modal?.kind).toBe("text");
    expect(s.sw.variables["drips"]).toBe(before + 6);
  });

  test("parallels run before main for general same-tick visibility", () => {
    const parallel = event("parallel", 0, 0, [
      { op: "variable", id: "v.parallel", set: { op: "set", value: 1 } },
      {
        op: "if",
        if: { kind: "variable", id: "v.x", op: "==", value: 1 },
        then: [{ op: "variable", id: "v.y", set: { op: "set", value: 1 } }],
      },
    ], "parallel");
    const main = event("main", 0, 0, [
      { op: "variable", id: "v.x", set: { op: "set", value: 1 } },
      {
        op: "if",
        if: { kind: "variable", id: "v.parallel", op: "==", value: 1 },
        then: [{ op: "variable", id: "v.mainSawParallel", set: { op: "set", value: 1 } }],
      },
    ], "autorun");

    const s = idle(createInterpState(), createWorld(map([main, parallel])));

    expect(s.sw.variables["v.x"]).toBe(1);
    expect(s.sw.variables["v.y"]).toBeUndefined();
    expect(s.sw.variables["v.mainSawParallel"]).toBe(1);
  });

  test("only one blocking fiber runs: an autorun is not interrupted by an action", () => {
    const w = createWorld(map([
      event("auto", 0, 0, [{ op: "wait", seconds: 1 }], "autorun"),
      event("npc", 10, 9, [{ op: "switch", id: "talked", value: true }], "action"),
    ]));
    let s = idle(createInterpState(), w, 1);
    expect(isBusy(s)).toBe(true);
    s = confirmAt(s, w);
    expect(s.sw.switches["talked"]).toBeUndefined();
  });

  test("C12: punctuation ids arbitrate by explicit code points, independent of JSON order", () => {
    // "-" is U+002D, "_" is U+005F, so "a-" sorts strictly before "a_" under
    // code-unit order even though localeCompare flips them on QuickJS.
    expect(eventIdLess("a-", "a_")).toBe(true);
    expect(eventIdLess("a_", "a-")).toBe(false);
    for (const ids of [["z", "a-", "a_"], ["a_", "a-", "z"]]) {
      const events = ids.map((id) => event(id, 10, 10, [
        { op: "switch", id, value: true },
        { op: "wait", seconds: 1 },
      ], "action"));
      const s = confirmAt(createInterpState(), createWorld(map(events)), { x: 10, y: 10 }, 0);
      expect(s.main?.key).toBe(`${MAP_ID}/a-`);
    }
  });

  test("C09: a queued parallel line does not overwrite the main dialog slot", () => {
    const sign = event("signpost", 10, 9, [{ op: "text", lines: ["FOREGROUND"] }], "action");
    const para: GameEvent = {
      id: "review-parallel", x: 0, y: 0,
      pages: [{ trigger: "parallel", commands: [
        { op: "wait", seconds: 0.05 },
        { op: "text", lines: ["BACKGROUND"] },
      ] }],
    };
    const w = createWorld(map([para, sign]));
    // The 0.05 s wait (3 frames) lands on frame 4. Open the main dialog on
    // frame 3, before that, so when the parallel reaches its text the slot
    // is already owned.
    let s = idle(createInterpState(), w, 2);
    s = confirmAt(s, w); // frame 3: open the main dialog
    s = idle(s, w, 3);
    expect(s.modal?.kind).toBe("text");
    expect(s.modal?.fiber).toBe("v/signpost");
    // The parallel fiber is still alive, queued behind the main box.
    expect(Object.keys(s.parallels)).toContain("v/review-parallel");
  });

  test("C11: a canceled parallel page never resumes a stale wait", () => {
    const events: GameEvent[] = [
      {
        id: "a-enable", x: 0, y: 0,
        pages: [
          { trigger: "autorun", commands: [
            { op: "switch", id: "enabled", value: true },
            { op: "selfSwitch", key: "A", value: true },
          ] },
          { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
        ],
      },
      {
        id: "b-disable", x: 0, y: 0,
        pages: [{ trigger: "parallel", condition: { switch: "enabled" }, commands: [
          { op: "wait", seconds: 1 / 60 },
          { op: "switch", id: "enabled", value: false },
          { op: "erase" },
        ] }],
      },
      {
        id: "z-timer", x: 0, y: 0,
        pages: [{ trigger: "parallel", condition: { switch: "enabled" }, commands: [
          { op: "wait", seconds: 0.05 },
          { op: "switch", id: "stale", value: true },
        ] }],
      },
    ];
    const w = createWorld(map(events));
    const s = idle(createInterpState(), w, 4);
    expect(s.sw.switches["enabled"]).toBe(false);
    expect(s.sw.switches["stale"] ?? false).toBe(false);
  });
});

// --- external commands (P1④ interface) --------------------------------------

describe("transfer and move routes park the fiber for P1④", () => {
  test("transfer publishes a pending request and continues on continueExternal", () => {
    const w = createWorld(map([event("gate", 10, 9, [
      { op: "transfer", map: "other", x: 3, y: 4, dir: "up", fade: 0.5 },
      { op: "switch", id: "arrived", value: true },
    ], "playerTouch")]));
    let s = stepInterp(w, createInterpState(), input({ playerCell: { x: 10, y: 9 }, prevCell: { x: 10, y: 10 } }));
    expect(s.pendingTransfer).toMatchObject({ map: "other", x: 3, y: 4, dir: "up", fadeFrames: 30 });
    expect(s.sw.switches["arrived"]).toBeUndefined();
    // the request is not republished on the next raw step
    s = idle(s, w, 1);
    expect(s.pendingTransfer).toBeNull();
    // P1④ resumes after swapping maps
    s = continueExternal(s, s.main?.key ?? "");
    // continueExternal advances the parked pc; one more step drains the switch
    s = idle(s, w, 1);
    expect(s.sw.switches["arrived"]).toBe(true);
  });

  test("transfer preserves explicit seamless opening provenance without changing legacy request shape", () => {
    const marked = createWorld(map([event("gate", 10, 9, [{
      op: "transfer",
      map: "other",
      x: 0,
      y: 4,
      handoff: { mode: "seamless-v1", portalId: "west:east:4" },
    }], "playerTouch")]));
    const markedState = stepInterp(
      marked,
      createInterpState(),
      input({ playerCell: { x: 10, y: 9 }, prevCell: { x: 10, y: 10 } }),
    );
    expect(markedState.pendingTransfer).toMatchObject({
      map: "other",
      x: 0,
      y: 4,
      handoff: { mode: "seamless-v1", portalId: "west:east:4" },
      playerTouch: true,
    });

    const legacy = createWorld(map([event("gate", 10, 9, [
      { op: "transfer", map: "other", x: 0, y: 4 },
    ], "playerTouch")]));
    const legacyState = stepInterp(
      legacy,
      createInterpState(),
      input({ playerCell: { x: 10, y: 9 }, prevCell: { x: 10, y: 10 } }),
    );
    expect(Object.prototype.hasOwnProperty.call(legacyState.pendingTransfer, "handoff")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(legacyState.pendingTransfer, "playerTouch")).toBe(false);
  });

  test("a waiting moveRoute parks; a non-waiting route only publishes", () => {
    const w = createWorld(map([event("guard", 10, 9, [
      { op: "moveRoute", target: "this", wait: true, route: { repeat: false, skippable: false, steps: ["moveRight", "moveUp"] } },
      { op: "switch", id: "done", value: true },
    ])]));
    let s = confirmAt(createInterpState(), w);
    const pending = s.pendingMoveRoutes[0];
    expect(pending && "route" in pending ? pending.route.steps : null).toEqual(["moveRight", "moveUp"]);
    s = idle(s, w, 1);
    expect(s.sw.switches["done"]).toBeUndefined();
    s = continueExternal(idle(s, w, 1), s.main?.key ?? "");
    s = idle(s, w, 1);
    expect(s.sw.switches["done"]).toBe(true);

    const w2 = createWorld(map([event("guard", 10, 9, [
      { op: "moveRoute", target: "this", wait: false, route: { repeat: false, skippable: false, steps: ["faceDown"] } },
      { op: "switch", id: "done2", value: true },
    ])]));
    const s2 = idle(confirmAt(createInterpState(), w2), w2, 1);
    expect(s2.pendingMoveRoutes[0] ?? s2.sw.switches["done2"]).toBeTruthy();
    expect(s2.sw.switches["done2"]).toBe(true);
  });

  test("B7: concurrent waiting routes retain every handoff request", () => {
    const route: Command = {
      op: "moveRoute",
      target: "this",
      wait: true,
      route: { repeat: false, skippable: false, steps: ["moveDown"] },
    };
    const w = createWorld(map([
      event("a", 0, 0, [route], "parallel"),
      event("b", 0, 0, [route], "parallel"),
    ]));

    const s = stepInterp(w, createInterpState(), input());
    const parked = Object.values(s.parallels)
      .filter((fiber) => fiber.mode === "external")
      .map((fiber) => fiber.key)
      .sort();

    expect(parked).toEqual(["v/a", "v/b"]);
    expect(s.pendingMoveRoutes.map((request) => request.fiber)).toEqual(parked);
    expect(stepInterp(w, s, input()).pendingMoveRoutes).toEqual([]);
  });

  test("common event pushes its command list", () => {
    const w = createWorld(
      map([event("e", 10, 9, [{ op: "common", id: "ce-1" }, { op: "switch", id: "after", value: true }])]),
      [{ id: "ce-1", trigger: "none", commands: [{ op: "switch", id: "common-ran", value: true }] }],
    );
    const s = idle(confirmAt(createInterpState(), w), w, 1);
    expect(s.sw.switches["common-ran"]).toBe(true);
    expect(s.sw.switches["after"]).toBe(true);
  });
});

// --- determinism -------------------------------------------------------------

describe("determinism", () => {
  test("the same input tape folds to byte-identical state twice", () => {
    const w = createWorld(map([
      event("npc", 10, 9, [
        { op: "text", lines: ["ABCDEFGH"] },
        {
          op: "choices", prompt: "Q",
          options: [
            { text: "yes", commands: [{ op: "switch", id: "yes", value: true }] },
            { text: "no", commands: [{ op: "switch", id: "no", value: true }] },
          ],
        },
      ]),
      { id: "drip", x: 0, y: 0, pages: [{ trigger: "parallel", commands: [
        { op: "wait", seconds: 0.25 },
        { op: "variable", id: "t", set: { op: "add", value: 1 } },
      ] }] },
    ]));
    // tape: idle 3, open, skip, advance, down, confirm, idle 10
    const tape: Partial<InterpInput>[] = [
      ...Array<Partial<InterpInput>>(3).fill({}),
      { confirmEdge: true },
      { confirmEdge: true },
      { confirmEdge: true },
      { downEdge: true },
      { confirmEdge: true },
      ...Array<Partial<InterpInput>>(10).fill({}),
    ];
    const run = (): InterpState => {
      let s = createInterpState(createSwitchState({ rng: 99 }));
      for (const edge of tape) {
        const cell = { x: 10, y: 10 };
        s = stepInterp(w, s, input({ ...edge, playerCell: cell, prevCell: cell, facing: 2 }));
      }
      return s;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.sw.switches["no"]).toBe(true);
    expect(a.sw.variables["t"]).toBeGreaterThan(0);
  });

  test("state is a plain serializable snapshot (save shape)", () => {
    const w = createWorld(map([event("e", 10, 9, [
      { op: "switch", id: "a", value: true },
      { op: "selfSwitch", key: "B", value: true },
      { op: "item", item: "k", set: "add", count: 2 },
    ])]));
    const s = idle(confirmAt(createInterpState(), w), w, 1);
    const restored = JSON.parse(JSON.stringify(s)) as InterpState;
    expect(restored.sw.switches["a"]).toBe(true);
    expect(restored.sw.self[`${MAP_ID}/e`]).toBe("B");
    expect(restored.sw.items["k"]).toBe(2);
    expect(restored.frame).toBe(s.frame);
  });
});

// --- data conformance --------------------------------------------------------

import { buildMiniProject } from "../examples/meadow/mini-project.ts";

describe("the shipped example project conforms to the v1 schema", async () => {
  const schema = await Bun.file(new URL("../src/data/schema.json", import.meta.url)).json();
  const project = buildMiniProject();

  test("buildMiniProject() passes the v1 schema validator", () => {
    const errors: VError[] = validateSchema(schema, project);
    expect(errors).toEqual([]);
  });

  test("carries four events with action, playerTouch and parallel triggers", () => {
    const m = project.maps[0]!;
    expect(m.id).toBe("meadow");
    expect(m.events).toHaveLength(4);
    const triggers = new Set(m.events!.flatMap((e) => e.pages.map((p) => p.trigger)));
    expect(triggers.has("action")).toBe(true);
    expect(triggers.has("playerTouch")).toBe(true);
    expect(triggers.has("parallel")).toBe(true);
  });

  test("the chest page gates on self switch A and grants potion + 25 gold", () => {
    const m = project.maps[0]!;
    const chest = m.events!.find((e) => e.id === "chest")!;
    expect(chest.pages[1]!.condition?.selfSwitch).toBe("A");
    const s = createInterpState(createSwitchState({ gold: project.initialGold ?? 0 }));
    const w = createWorld(m);
    // chest at (15,3); face it from (15,4)
    let run = stepInterp(w, s, input({ confirmEdge: true, playerCell: { x: 15, y: 4 }, prevCell: { x: 15, y: 4 }, facing: 2 }));
    while (run.modal) run = stepInterp(w, run, input({ confirmEdge: true }));
    expect(run.sw.gold).toBe(30);
    expect(run.sw.items["potion"]).toBe(1);
    expect(run.sw.self[`meadow/chest`]).toBe("A");
  });
});

// --- modal identity (fleet review C07: consecutive/nested choices) ----------

import { modalChanged, type Modal } from "../src/engine/interpreter.ts";

describe("modalChanged — visible modal identity", () => {
  const outer: Modal = { kind: "choices", fiber: "m/sign", prompt: "OUTER", options: ["NEXT"], index: 0, cancellable: false };
  const inner: Modal = { kind: "choices", fiber: "m/sign", prompt: "INNER", options: ["YES"], index: 0, cancellable: true };

  test("consecutive choices on the same fiber differ in content and cancel", () => {
    expect(modalChanged(outer, inner)).toBe(true);
  });

  test("an identical choices frame (parked, same index) is unchanged", () => {
    expect(modalChanged(outer, { ...outer })).toBe(false);
  });

  test("dynamic choice metadata compares by content", () => {
    const dynamic: Modal = {
      kind: "choices",
      fiber: "m/sign",
      prompt: "PARTY",
      options: ["A", "B"],
      keys: ["a", "b"],
      enabled: [true, false],
      index: 0,
      cancellable: true,
    };
    expect(modalChanged(dynamic, {
      ...dynamic,
      options: ["A", "B"],
      keys: ["a", "b"],
      enabled: [true, false],
    })).toBe(false);
    expect(modalChanged(dynamic, { ...dynamic, options: ["A", "Bee"] })).toBe(true);
    expect(modalChanged(dynamic, { ...dynamic, enabled: [false, false] })).toBe(true);
  });

  test("a cursor move on the same box is a visible change", () => {
    expect(modalChanged(outer, { ...outer, index: 1 })).toBe(true);
  });

  test("a parked typewriter at the same reveal is unchanged", () => {
    const t: Modal = { kind: "text", fiber: "m/sign", lines: ["abc"], total: 3, revealed: 3, complete: true };
    expect(modalChanged(t, { ...t })).toBe(false);
    expect(modalChanged(t, { ...t, revealed: 2, complete: false })).toBe(true);
  });

  test("a text box that changes only its layout or its page cuts is a change", () => {
    // Same fiber, same words, same typewriter state: a host frame that
    // folds several reducer ticks (low hz) or a rewind that swaps the shown
    // state skips the null frame between two such boxes, so the layout and
    // the page cuts must be part of the identity or the old box stays up.
    const t: Modal = { kind: "text", fiber: "m/sign", lines: ["abc"], total: 3, revealed: 3, complete: true };
    const top: Modal = { ...t, box: { position: "top" } };
    expect(modalChanged(t, top)).toBe(true);
    expect(modalChanged(top, t)).toBe(true);
    expect(modalChanged(top, { ...t, box: { position: "top" } })).toBe(false);
    for (const box of [
      { position: "topRight" },
      { position: "top", align: "center" },
      { position: "top", valign: "bottom" },
      { position: "top", background: "dim" },
    ] as const) {
      expect(modalChanged(top, { ...t, box }), JSON.stringify(box)).toBe(true);
    }
    const paged: Modal = { ...t, total: 3, revealed: 1, pageStarts: [0, 2], page: 0 };
    expect(modalChanged(paged, { ...paged, pageStarts: [0, 2] })).toBe(false);
    expect(modalChanged(paged, { ...paged, pageStarts: [0, 1] })).toBe(true);
    expect(modalChanged(paged, { ...paged, pageStarts: [0, 1, 2] })).toBe(true);
    expect(modalChanged(paged, { ...t, revealed: 1 })).toBe(true);
  });

  test("null <-> modal and kind/fiber swaps are changes", () => {
    expect(modalChanged(null, outer)).toBe(true);
    expect(modalChanged(outer, null)).toBe(true);
    expect(modalChanged(outer, { ...outer, fiber: "m/other" })).toBe(true);
  });
});

describe("host-portable interpreter cloning (F1/1173 QuickJS)", () => {
  test("the fold never touches globalThis.structuredClone", () => {
    // The desktop QuickJS realm has no structuredClone; hide it here to
    // prove the reducer and modal cloning use their own copier.
    const host = globalThis as { structuredClone?: unknown };
    const builtin = host.structuredClone;
    host.structuredClone = undefined;
    try {
      const w = createWorld(map([event("e", 10, 9, [
        { op: "text", lines: ["Hi"] },
        { op: "switch", id: "a", value: true },
      ])]));
      let s = createInterpState();
      expect(() => {
        s = stepInterp(w, s, {
          confirmEdge: true, playerCell: { x: 10, y: 10 },
          prevCell: { x: 10, y: 10 }, facing: 2,
        });
      }).not.toThrow();
      expect(s.modal?.kind).toBe("text");
      s = stepInterp(w, s, {
        confirmEdge: true, playerCell: { x: 10, y: 10 },
        prevCell: { x: 10, y: 10 }, facing: 2,
      });
      s = stepInterp(w, s, {
        confirmEdge: true, playerCell: { x: 10, y: 10 },
        prevCell: { x: 10, y: 10 }, facing: 2,
      });
      expect(s.sw.switches["a"]).toBe(true);
    } finally {
      host.structuredClone = builtin;
    }
  });

  test("cloned interpreter state does not alias mutable nested records", () => {
    const w = createWorld(map([event("e", 10, 9, [{ op: "text", lines: ["Hi"] }])]));
    const open = stepInterp(w, createInterpState(), {
      confirmEdge: true, playerCell: { x: 10, y: 10 },
      prevCell: { x: 10, y: 10 }, facing: 2,
    });
    expect(open.modal).not.toBeNull();
    const copy = cloneInterp(open);
    copy.sw.switches["a"] = true;
    copy.sw.variables["v"] = 5;
    copy.erased["x/y"] = true;
    copy.main!.stack[0]!.pc = 999;
    copy.modal = null;
    expect(open.sw.switches["a"]).toBeUndefined();
    expect(open.sw.variables["v"]).toBeUndefined();
    expect(open.erased["x/y"]).toBeUndefined();
    expect(open.main!.stack[0]!.pc).not.toBe(999);
    expect(open.modal).not.toBeNull();
    // The immutable compiled program stays shared (no per-frame copy).
    expect(copy.main!.stack[0]!.prog).toBe(open.main!.stack[0]!.prog);
  });

  test("cloned dynamic choices do not alias option metadata arrays", () => {
    const original = createInterpState();
    const modal: Modal = {
      kind: "choices",
      fiber: "m/sign",
      prompt: "PARTY",
      options: ["A", "B"],
      keys: ["a", "b"],
      enabled: [true, false],
      index: 0,
      cancellable: true,
    };
    original.modal = modal;

    const copy = cloneInterp(original);
    expect(copy.modal).not.toBe(original.modal);
    expect(copy.modal?.kind).toBe("choices");
    if (copy.modal?.kind !== "choices") throw new Error("expected cloned choices modal");

    expect(copy.modal.options).not.toBe(modal.options);
    expect(copy.modal.keys).not.toBe(modal.keys);
    expect(copy.modal.enabled).not.toBe(modal.enabled);

    copy.modal.options[0] = "Changed";
    copy.modal.keys![0] = "changed";
    copy.modal.enabled![0] = false;
    expect(modal.options).toEqual(["A", "B"]);
    expect(modal.keys).toEqual(["a", "b"]);
    expect(modal.enabled).toEqual([true, false]);
  });
});

// --- review 1274 B1: per-frame runaway backstop ------------------------------
// The save decoder refuses compiler-impossible backward edges, and the
// runtime keeps a second backstop: all fibers share one per-frame step
// budget. Exceeding it records a fatal error on the state instead of
// throwing, so the host frame loop never hangs and later frames freeze.

describe("runaway backstop (review 1274 B1)", () => {
  const CELL = { x: 10, y: 10 };

  for (const trigger of ["autorun", "parallel"] as const)
    for (const messageBlocksPlayer of [false, true])
      test(`cached scans deliver modal edges and subsequent actions: ${trigger}, hold=${messageBlocksPlayer}`, () => {
        const events = [
          event("guard", 0, 0, [{ op: "if", if: { kind: "variable", id: "never", op: "==", value: 1 }, then: [] }], "parallel"),
          event("dialog", 0, 0, [
            { op: "text", lines: ["A line", "Another line"], cps: 20 },
            { op: "choices", prompt: "Pick", options: [
              { text: "One", commands: [{ op: "variable", id: "pick", set: { op: "set", value: 1 } }] },
              { text: "Two", commands: [{ op: "variable", id: "pick", set: { op: "set", value: 2 } }] },
            ], cancel: { commands: [{ op: "variable", id: "pick", set: { op: "set", value: 3 } }] } },
            { op: "erase" },
          ], trigger),
          event("action", 10, 9, [{ op: "variable", id: "actions", set: { op: "add", value: 1 } }]),
        ];
        const histories: InterpState[][] = [];
        for (const immutable of [false, true]) {
          const w = createWorld(map(events), [], 60, { messageBlocksPlayer, extensions: createExtensionRuntime({
            immutableConditions: true, deterministicConditions: true,
          }) });
          let s = createInterpState();
          const history: InterpState[] = [];
          for (let frame = 0; frame < 30; frame++) {
            s = shareInterp(s, immutable);
            stepInterpWithExtensionsInPlace(w, s, input({
              confirmEdge: frame % 4 === 2, cancelEdge: frame % 7 === 6,
              upEdge: frame % 3 === 0, downEdge: frame % 3 === 1,
            }), null, undefined, immutable);
            history.push(s);
          }
          expect(s.sw.variables.pick).toBeDefined();
          expect(s.sw.variables.actions).toBeGreaterThan(0);
          histories.push(history);
        }
        expect(histories[1]).toEqual(histories[0]);
      });

  test("a sleeping parallel scan reserves its budget when the blocking wait finishes", () => {
    const events = [
      event("guard", 10, 10, Array.from({ length: 80 }, () => ({
        op: "if", if: { kind: "variable", id: "never", op: "==", value: 1 }, then: [],
      })), "parallel"),
      event("main", 0, 0, [{ op: "wait", seconds: 0.1 },
        ...Array.from({ length: 9950 }, () => ({ op: "switch" as const, id: "work", value: true })),
      ], "autorun"),
    ];
    const histories: InterpState[][] = [];
    for (const immutable of [false, true]) {
      const w = createWorld(map(events), [], 60, { extensions: createExtensionRuntime({
        immutableConditions: true, deterministicConditions: true,
      }) });
      let s = createInterpState();
      const history: InterpState[] = [];
      for (let frame = 0; frame < 12; frame++) {
        s = shareInterp(s, immutable);
        stepInterpWithExtensionsInPlace(w, s, input(), null, undefined, immutable);
        history.push(s);
      }
      expect(s.error?.kind).toBe("runaway");
      histories.push(history);
    }
    expect(histories[1]).toEqual(histories[0]);
  });

  for (const guardId of ["a", "b"]) test(`cached guards preserve the shared budget in key order ${guardId}`, () => {
    const guards: Command[] = Array.from({ length: 80 }, () => ({
      op: "if", if: { kind: "variable", id: "never", op: "==", value: 1 }, then: [],
    }));
    const worker = event(guardId === "a" ? "b" : "a", 11, 10,
      Array.from({ length: 9950 }, () => ({ op: "switch", id: "work", value: true })), "parallel");
    worker.pages[0]!.condition = { all: [{ kind: "switch", id: "armed", value: true }] };
    const outputs: InterpState[] = [];
    for (const immutable of [false, true]) {
      const w = createWorld(map([event(guardId, 10, 10, guards, "parallel"), worker]));
      let s = createInterpState();
      stepInterpWithExtensionsInPlace(w, s, input(), null, undefined, immutable);
      expect(s.error).toBeUndefined();
      s = shareInterp(s);
      ownRecord(s.sw, "switches").armed = true;
      stepInterpWithExtensionsInPlace(w, s, input(), null, undefined, immutable);
      expect(s.error?.kind).toBe("runaway");
      outputs.push(s);
    }
    expect(outputs[1]).toEqual(outputs[0]);
  });

  /** A state with a hand-built (non-compiler-emitted) parallel fiber. */
  function stateWithParallel(prog: unknown, pc = 0): InterpState {
    const s = createInterpState();
    s.parallels[`${MAP_ID}/loop`] = {
      key: `${MAP_ID}/loop`,
      pageIndex: 0,
      parallel: true,
      stack: [{ prog: prog as never, pc }],
      mode: "run",
      since: 0,
      erase: false,
    };
    return s;
  }

  // The live page is a harmless parallel-exit page: trigger arbitration
  // sees the injected fiber and keeps it, so the injected program runs.
  const loopMap = () => map([event("loop", 10, 10, [{ op: "exit" }], "parallel")]);

  test("a self jump fatalizes the state with a runaway error instead of throwing", () => {
    const w = createWorld(loopMap());
    const s0 = stateWithParallel([{ op: "jmp", to: 0 }]);
    const s1 = stepInterp(w, s0, input({ playerCell: CELL }));
    expect(s1.error).toEqual({
      kind: "runaway",
      message: `interpreter: runaway program in ${MAP_ID}/loop`,
    });
    // The cyclic fiber is parked, not finished: the error names it.
    expect(s1.parallels[`${MAP_ID}/loop`]).toBeDefined();
  });

  test("a multi-instruction backward loop fatalizes on the first frame too", () => {
    const w = createWorld(loopMap());
    const s0 = stateWithParallel([
      { op: "switch", id: "x", value: true },
      { op: "jmp", to: 0 },
      { op: "exit" },
    ]);
    const s1 = stepInterp(w, s0, input({ playerCell: CELL }));
    expect(s1.error?.kind).toBe("runaway");
  });

  test("a fatalized state is frozen: later frames never run a fiber and never throw", () => {
    const w = createWorld(loopMap());
    let s = stepInterp(w, stateWithParallel([{ op: "jmp", to: 0 }]), input({ playerCell: CELL }));
    const frozen = s;
    const fiber = s.parallels[`${MAP_ID}/loop`]!;
    for (let i = 0; i < 5; i++) {
      s = stepInterp(w, s, input({ playerCell: CELL }));
      // deepClone produces a fresh error object each frame, but the fatal
      // record content stays identical and no fiber consumes a step.
      expect(s.error).toEqual(frozen.error);
      // No trigger scan, no fiber run: the parked fiber object and pc stay.
      expect(s.parallels[`${MAP_ID}/loop`]).toBeDefined();
      expect(s.parallels[`${MAP_ID}/loop`]!.stack[0]!.pc).toBe(fiber.stack[0]!.pc);
    }
    expect(s.frame).toBe(frozen.frame + 5);
  });

  test("a long but finite forward program completes under the limit", () => {
    const w = createWorld(loopMap());
    // 500 instant commands + exit in one frame: forward control flow only.
    const prog = compile(Array.from({ length: 500 }, () => ({
      op: "switch" as const, id: "n", value: true,
    })));
    prog.push({ op: "exit" });
    const s1 = stepInterp(w, stateWithParallel(prog), input({ playerCell: CELL }));
    expect(s1.error).toBeUndefined();
    expect(s1.parallels[`${MAP_ID}/loop`]).toBeUndefined();
    expect(s1.sw.switches["n"]).toBe(true);
  });

  test("a compiler-emitted 10,000-op program fatalizes instead of throwing", () => {
    const w = createWorld(loopMap());
    const prog = compile(Array.from({ length: 10_000 }, () => ({
      op: "switch" as const, id: "x", value: true,
    })));
    let out: InterpState | undefined;
    expect(() => {
      out = stepInterp(w, stateWithParallel(prog), input({ playerCell: CELL }));
    }).not.toThrow();
    expect(out!.error).toEqual({
      kind: "runaway",
      message: `interpreter: runaway program in ${MAP_ID}/loop`,
    });
  });

  test("recursive common events fatalize instead of growing the stack without bound", () => {
    const w = createWorld(loopMap(), [{
      id: "recursive",
      trigger: "none",
      commands: [{ op: "common", id: "recursive" }],
    }]);
    const prog = compile([{ op: "common", id: "recursive" }]);
    let out: InterpState | undefined;
    expect(() => {
      out = stepInterp(w, stateWithParallel(prog), input({ playerCell: CELL }));
    }).not.toThrow();
    expect(out!.error?.kind).toBe("runaway");
    expect(out!.parallels[`${MAP_ID}/loop`]!.stack.length).toBeLessThanOrEqual(10_001);
  });

  test("parallel fibers share one frame-wide step budget", () => {
    const events = [
      event("a", 10, 10, [{ op: "exit" }], "parallel"),
      event("b", 11, 10, [{ op: "exit" }], "parallel"),
    ];
    const w = createWorld(map(events));
    const state = createInterpState();
    const prog = compile(Array.from({ length: 6_000 }, () => ({
      op: "switch" as const, id: "x", value: true,
    })));
    for (const id of ["a", "b"] as const) {
      const key = `${MAP_ID}/${id}`;
      state.parallels[key] = {
        key, pageIndex: 0, parallel: true, stack: [{ prog, pc: 0 }],
        mode: "run", since: 0, erase: false,
      };
    }
    const out = stepInterp(w, state, input({ playerCell: CELL }));
    expect(out.error).toEqual({
      kind: "runaway",
      message: `interpreter: runaway program in ${MAP_ID}/b`,
    });
    expect(out.parallels[`${MAP_ID}/a`]).toBeUndefined();
    expect(out.parallels[`${MAP_ID}/b`]!.stack[0]!.pc).toBe(3_999);
  });
});

describe("immutable event appearance tables", () => {
  test("retain idle identity and copy before changing one entry", () => {
    const events = [
      event("subject", 1, 1, []),
      event("driver", 0, 0, [
        { op: "appearance", target: { event: "subject" }, opacity: 128 },
        { op: "wait", seconds: 0.1 },
        { op: "appearance", target: { event: "subject" }, opacity: 64 },
        { op: "wait", seconds: 10 },
      ], "autorun"),
    ];
    const w = createWorld(map(events));
    const frameInput = input({
      eventPages: {
        subject: { pageIndex: 0, sprite: null },
        driver: { pageIndex: 0, sprite: null },
      },
    });
    let s = shareInterp(createInterpState(), true);
    stepInterpWithExtensionsInPlace(w, s, frameInput, null, undefined, true);
    const firstTable = s.eventAppearances!;
    const firstEntry = firstTable.subject!;
    expect(firstEntry.opacity).toBe(128);

    s = shareInterp(s, true);
    stepInterpWithExtensionsInPlace(w, s, frameInput, null, undefined, true);
    expect(s.eventAppearances).toBe(firstTable);
    expect(s.eventAppearances!.subject).toBe(firstEntry);

    for (let frame = 0; frame < 10 && s.eventAppearances?.subject?.opacity === 128; frame++) {
      s = shareInterp(s, true);
      stepInterpWithExtensionsInPlace(w, s, frameInput, null, undefined, true);
    }
    expect(s.eventAppearances).not.toBe(firstTable);
    expect(s.eventAppearances!.subject.opacity).toBe(64);
    expect(firstTable.subject).toBe(firstEntry);
    expect(firstEntry.opacity).toBe(128);
  });
});
