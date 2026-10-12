import { describe, expect, test } from "bun:test";
import {
  createInterpState,
  createSwitchState,
  createWorld,
  stepInterp,
  type InterpInput,
  type InterpState,
  type ScrollTextModal,
} from "../src/engine/interpreter.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createAutosaveSessionSnapshot } from "../src/engine/save.ts";
import { loadSession } from "../src/engine/save-restore.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import { rpgMakerTextRuntime } from "../src/engine/rpgmaker-text.ts";
import { createSession, startSession, stepSession } from "../src/engine/session.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const CELL = { x: 1, y: 1 };

function input(extra: Partial<InterpInput> = {}): InterpInput {
  return {
    playerCell: CELL,
    prevCell: CELL,
    facing: 2,
    confirmEdge: false,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
    ...extra,
  };
}

function map(commands: Command[]): MapDef {
  const source: GameEvent = {
    id: "credits",
    x: 1,
    y: 1,
    pages: [{ trigger: "autorun", commands }],
  };
  return {
    id: "m",
    name: "m",
    width: 3,
    height: 3,
    sheets: ["base"],
    ground: new Array(9).fill("base.0"),
    events: [source],
  };
}

function modal(state: InterpState): ScrollTextModal {
  expect(state.modal?.kind).toBe("scrollText");
  return state.modal as ScrollTextModal;
}

function open(command: Extract<Command, { op: "scrollText" }>, state = createInterpState()) {
  const world = createWorld(map([command]), [], 60, {
    layoutScrollText: () => ({ contentHeight: 15, viewportHeight: 20 }),
  });
  return { world, state: stepInterp(world, state, input()) };
}

describe("continuous scrolling text reducer", () => {
  test("opens below the viewport and advances in exact half-pixels", () => {
    const opened = open({ op: "scrollText", lines: ["Credits"], speed: 1 });
    let state = opened.state;
    expect(modal(state)).toMatchObject({
      lines: ["Credits"],
      speed: 1,
      noFastForward: false,
      offset2: 0,
      contentHeight: 15,
      viewportHeight: 20,
    });
    state = stepInterp(opened.world, state, input());
    expect(modal(state).offset2).toBe(1);
    state = stepInterp(opened.world, state, input());
    expect(modal(state).offset2).toBe(2);
  });

  test("held confirm accelerates 3x, but an edge never dismisses it", () => {
    const opened = open({ op: "scrollText", lines: ["Credits"], speed: 3 });
    let state = stepInterp(opened.world, opened.state, input({ confirmEdge: true }));
    expect(modal(state).offset2).toBe(3);
    state = stepInterp(opened.world, state, input({ scrollFastHeld: true }));
    expect(modal(state).offset2).toBe(12);
  });

  test("No Fast Forward keeps the authored speed", () => {
    const opened = open({ op: "scrollText", lines: ["Credits"], speed: 3, noFastForward: true });
    const state = stepInterp(opened.world, opened.state, input({ scrollFastHeld: true }));
    expect(modal(state).offset2).toBe(3);
  });

  test("closes at the exact viewport-plus-content boundary and continues the fiber", () => {
    const world = createWorld(map([
      { op: "scrollText", lines: ["Credits"], speed: 10 },
      { op: "switch", id: "done", value: true },
    ]), [], 60, { layoutScrollText: () => ({ contentHeight: 5, viewportHeight: 10 }) });
    let state = stepInterp(world, createInterpState(), input());
    expect(modal(state).offset2).toBe(0);
    state = stepInterp(world, state, input());
    expect(modal(state).offset2).toBe(10);
    state = stepInterp(world, state, input());
    expect(modal(state).offset2).toBe(20);
    state = stepInterp(world, state, input());
    expect(state.modal).toBeNull();
    expect(state.sw.switches.done).toBe(true);
  });

  test("escape expansion and colours are frozen when the block opens", () => {
    const state0 = createInterpState(createSwitchState({ variables: { score: 7 } }));
    const world = createWorld(map([{ op: "scrollText", lines: ["Score {v:score} \\C[2]赤\\C[0]"], speed: 2 }]), [], 60, {
      textVariables: true,
      rpgMakerText: {
        runtime: rpgMakerTextRuntime,
        actors: [],
        partyActorIds: [],
        currencyUnit: "G",
        colours: ["#ffffff", "#a0a0a0", "#ff4040"],
      },
      layoutScrollText: () => ({ contentHeight: 15, viewportHeight: 20 }),
    });
    let state = stepInterp(world, state0, input());
    expect(modal(state).lines).toEqual(["Score {v:score} 赤"]);
    expect(modal(state).colours).toEqual([{ start: 16, end: 17, colour: "#FF4040" }]);
    state.sw.variables.score = 99;
    state = stepInterp(world, state, input());
    expect(modal(state).lines).toEqual(["Score {v:score} 赤"]);
  });

  test("headless worlds use fixed fallback dimensions", () => {
    const world = createWorld(map([{ op: "scrollText", lines: ["one", "two"], speed: 2 }]));
    const state = stepInterp(world, createInterpState(), input());
    expect(modal(state)).toMatchObject({ contentHeight: 30, viewportHeight: 272 });
  });

  test("60/30/20 Hz fold the same held-input reference timeline", () => {
    const sourceMap = map([{ op: "scrollText", lines: ["Long credits"], speed: 1 }]);
    const project: Project = {
      format: "rpgkit-project/v1",
      title: "scroll rate",
      tileSize: 16,
      start: { map: "m", x: 1, y: 1, dir: "down" },
      sheets: [{ id: "base", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [],
      maps: [sourceMap],
    };
    const results = [60, 30, 20].map((hz) => {
      const session = createSession(project, hz, {
        layoutScrollText: () => ({ contentHeight: 1000, viewportHeight: 272 }),
      });
      let state = startSession(project, session);
      for (let frame = 0; frame < hz; frame++) {
        state = stepSession(session, state, { buttons: 0x2000 });
      }
      return modal(state.interp);
    });
    expect(results.map((m) => m.offset2)).toEqual([177, 177, 177]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  test("an autosave restores the exact mid-scroll half-pixel position", () => {
    const sourceMap = map([{ op: "scrollText", lines: ["Long credits"], speed: 3 }]);
    const project: Project = {
      format: "rpgkit-project/v1",
      title: "scroll save",
      tileSize: 16,
      start: { map: "m", x: 1, y: 1, dir: "down" },
      sheets: [{ id: "base", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [],
      maps: [sourceMap],
    };
    const layoutScrollText = () => ({ contentHeight: 1000, viewportHeight: 272 });
    const session = createSession(project, 60, { layoutScrollText });
    let state = startSession(project, session);
    for (let frame = 0; frame < 20; frame++) {
      state = stepSession(session, state, { buttons: 0x2000 });
    }
    expect(modal(state.interp).offset2).toBe(171);
    const snapshot = createAutosaveSessionSnapshot(session, state, 0x2000);
    expect(snapshot).not.toBeNull();
    const loaded = loadSession(session, snapshot!);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.state).toEqual(state);
      expect(modal(loaded.state.interp).offset2).toBe(171);
      const next = stepSession(session, loaded.state, { buttons: loaded.held });
      expect(modal(next.interp).offset2).toBe(180);
    }
  });

  test("rewind and replay reproduce the same scrolling modal", () => {
    const sourceMap = map([{ op: "scrollText", lines: ["Long credits"], speed: 2 }]);
    const project: Project = {
      format: "rpgkit-project/v1",
      title: "scroll rewind",
      tileSize: 16,
      start: { map: "m", x: 1, y: 1, dir: "down" },
      sheets: [{ id: "base", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [],
      maps: [sourceMap],
    };
    for (const hz of [60, 30, 20]) {
      const controller = new AttractController(project, [], {
        hz,
        attractEnabled: false,
        rewindSeconds: 1,
        layoutScrollText: () => ({ contentHeight: 1000, viewportHeight: 272 }),
      });
      for (let frame = 0; frame < hz; frame++) controller.step(0x2000);
      const before = structuredClone(controller.state);
      controller.step(0x0100);
      expect(controller.length, `${hz} Hz rewound to the beginning`).toBe(0);
      expect(controller.state.interp.modal).toBeNull();
      for (let frame = 0; frame < hz; frame++) controller.step(0x2000);
      expect(controller.state, `${hz} Hz replay`).toEqual(before);
    }
  });

  test("save validation rejects malformed scrolling programs and modal state", () => {
    const sourceMap = map([{ op: "scrollText", lines: ["Credits"], speed: 2 }]);
    const project: Project = {
      format: "rpgkit-project/v1",
      title: "scroll validation",
      tileSize: 16,
      start: { map: "m", x: 1, y: 1, dir: "down" },
      sheets: [{ id: "base", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [],
      maps: [sourceMap],
    };
    const session = createSession(project, 60, {
      layoutScrollText: () => ({ contentHeight: 15, viewportHeight: 20 }),
    });
    const active = stepSession(session, startSession(project, session), { buttons: 0 });
    const valid = createAutosaveSessionSnapshot(session, active, 0)!;
    expect(validateSnapshot(valid)).toBeNull();

    const cases: Array<[string, (snapshot: any) => void, string]> = [
      ["empty lines", (s) => { s.interp.modal.lines = []; }, "modal.lines"],
      ["zero speed", (s) => { s.interp.modal.speed = 0; }, "modal.speed"],
      ["fractional speed", (s) => { s.interp.modal.speed = 1.5; }, "modal.speed"],
      ["missing no-fast", (s) => { delete s.interp.modal.noFastForward; }, "modal.noFastForward"],
      ["zero content", (s) => { s.interp.modal.contentHeight = 0; }, "modal"],
      ["zero viewport", (s) => { s.interp.modal.viewportHeight = 0; }, "modal"],
      ["negative offset", (s) => { s.interp.modal.offset2 = -1; }, "modal.offset2"],
      ["completed offset", (s) => { s.interp.modal.offset2 = 70; }, "modal.offset2"],
      ["orphan owner", (s) => { s.interp.modal.fiber = "m/missing"; }, "interp.main.mode"],
      ["wrong parked mode", (s) => { s.interp.main.mode = "text"; }, "interp.main.mode"],
      ["bad instruction speed", (s) => { s.interp.main.stack[0].prog[0].speed = 0; }, ".speed"],
      ["bad instruction no-fast", (s) => { delete s.interp.main.stack[0].prog[0].noFastForward; }, ".noFastForward"],
    ];
    for (const [label, mutate, path] of cases) {
      const snapshot = structuredClone(valid) as any;
      mutate(snapshot);
      expect(validateSnapshot(snapshot), label).toContain(path);
    }
  });
});
