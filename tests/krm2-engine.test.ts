// KRM2 engine integration: map scroll, numbered pictures, timer, number
// input, host lifecycle requests, player rename and map-name banners.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import type { SceneRules } from "../src/engine/scene.ts";
import {
  evalCondition,
  scrollMapFrames,
  type HostAction,
} from "../src/engine/interpreter.ts";
import {
  NUMBER_INPUT_SCENE_ID,
  numberInputRules,
  type NumberInputState,
} from "../src/engine/number-input.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  encodeEnvelope,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope, saveSession } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionHostEffect,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, MapDef, Project } from "../src/engine/types.ts";

const SHEET = { id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" } as const;

function map(id: string, name = id, commands: Command[] = []): MapDef {
  return {
    id,
    name,
    width: 12,
    height: 10,
    sheets: [SHEET.id],
    ground: new Array(120).fill("plain.0"),
    events: commands.length === 0 ? [] : [{
      id: "director",
      x: 1,
      y: 1,
      pages: [
        { trigger: "autorun", commands },
        { condition: { switch: "done" }, trigger: "action", commands: [] },
      ],
    }],
  };
}

function project(commands: Command[], options: {
  systemMapName?: boolean;
  extraMaps?: MapDef[];
  initialVariables?: never;
} = {}): Project {
  return {
    format: "rpgkit-project/v1",
    title: "KRM2 engine fixture",
    tileSize: 16,
    start: { map: "start", x: 3, y: 4, dir: "down" },
    ...(options.systemMapName === undefined
      ? {}
      : { system: { mapNameDisplay: options.systemMapName } }),
    sheets: [SHEET],
    items: [],
    maps: [map("start", "Starting Harbor", commands), ...(options.extraMaps ?? [])],
  };
}

function run(session: Session, state: SessionState, frames: number): SessionState {
  let next = state;
  for (let i = 0; i < frames; i++) next = stepSession(session, next, { buttons: 0 });
  return next;
}

const AUTOSAVE_DELAY_SCENE = "test.autosaveDelay";
const autosaveDelayRules: SceneRules = {
  start(ext) {
    return { ext, state: { ticks: 0 } };
  },
  step(raw, _input, ticks) {
    return { ticks: (raw as { ticks: number }).ticks + ticks };
  },
  done(raw) {
    return (raw as { ticks: number }).ticks >= 5 ? {} : null;
  },
};

function deferredAutosaveProject(): Project {
  const p = project([]);
  p.maps[0]!.events!.push(
    {
      id: "a-scene",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "scene", id: AUTOSAVE_DELAY_SCENE },
            { op: "switch", id: "scene.done", value: true },
          ],
        },
        { condition: { switch: "scene.done" }, trigger: "action", commands: [] },
      ],
    },
    {
      id: "b-autosave-now",
      x: 2,
      y: 1,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "autosave" },
            { op: "switch", id: "autosave.now.done", value: true },
          ],
        },
        { condition: { switch: "autosave.now.done" }, trigger: "action", commands: [] },
      ],
    },
    {
      id: "c-autosave-later",
      x: 3,
      y: 1,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "wait", seconds: 1 / 60 },
            { op: "autosave" },
            { op: "switch", id: "autosave.later.done", value: true },
          ],
        },
        { condition: { switch: "autosave.later.done" }, trigger: "action", commands: [] },
      ],
    },
  );
  return p;
}

function screenTimeline(): Command[] {
  return [
    { op: "timer", action: "start", seconds: 3 },
    {
      op: "showPicture",
      id: 7,
      layer: "pictures",
      variant: "portrait",
      origin: "center",
      x: 24,
      y: 40,
      scaleX: 100,
      scaleY: 100,
      opacity: 255,
      blend: "normal",
    },
    {
      op: "movePicture",
      id: 7,
      origin: "center",
      x: 144,
      y: 88,
      scaleX: 150,
      scaleY: 75,
      opacity: 128,
      duration: 0.5,
      wait: true,
      easing: "easeInOut",
    },
    { op: "rotatePicture", id: 7, speed: 0.5 },
    {
      op: "tintPicture",
      id: 7,
      tone: { r: 80, g: -40, b: 20, gray: 64 },
      duration: 0.5,
      wait: true,
    },
    { op: "scrollMap", direction: "right", distance: 2, speed: 6, wait: true },
    { op: "camera", target: "player", duration: 0.1, wait: true },
    { op: "switch", id: "done", value: true },
  ];
}

describe("KRM2 fixed-clock presentation", () => {
  test("each RPG Maker scroll speed grade has the specified duration", () => {
    expect(([1, 2, 3, 4, 5, 6] as const).map((speed) => scrollMapFrames(1, speed)))
      .toEqual([128, 64, 32, 16, 8, 4]);
  });

  test("a zero-distance scroll preserves live player follow", () => {
    const p = project([
      { op: "scrollMap", direction: "right", distance: 0, speed: 4, wait: true },
      { op: "switch", id: "done", value: true },
    ]);
    const session = createSession(p, 60);
    const state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.sw.switches.done).toBe(true);
    expect(state.interp.screen?.camera).toBeUndefined();
  });

  test("pictures, scroll waits and timer settle identically at 60/30/20/4 Hz", () => {
    const outcomes = ([60, 30, 20, 4] as const).map((hz) => {
      const p = project(screenTimeline());
      const session = createSession(p, hz);
      const state = run(session, startSession(p, session), hz * 2);
      return {
        tick: state.interp.frame,
        done: state.sw.switches.done,
        timer: state.sw.timer,
        picture: state.interp.screen?.pictures?.["7"],
        camera: state.interp.screen?.camera,
      };
    });
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
    expect(outcomes[0]).toMatchObject({
      tick: 120,
      done: true,
      timer: { remaining: 61, running: true, expired: false },
      picture: {
        transform: { x: 144, y: 88, scaleX: 150, scaleY: 75, opacity: 128 },
        tone: { r: 80, g: -40, b: 20, gray: 64 },
        rotationSpeed: 0.5,
      },
      camera: undefined,
    });
  });

  test("an in-flight picture tween saves, restores and resumes exactly", () => {
    const p = project(screenTimeline());
    const session = createSession(p, 60);
    const middle = run(session, startSession(p, session), 18);
    expect(middle.interp.main?.mode).toBe("screenWait");
    expect(middle.interp.screen?.pictures?.["7"]?.move?.left).toBe(13);

    const restored = restoreSessionEnvelope(
      session,
      encodeEnvelope(createSessionSnapshot(session, middle, 0)),
    );
    expect(restored).toEqual(middle);
    expect(run(session, restored, 90)).toEqual(run(session, middle, 90));
  });

  test("rewind restores the saved picture tween and rotation clock", () => {
    const p = project([
      {
        op: "showPicture", id: 2, layer: "pictures", variant: "card",
        x: 0, y: 0, scaleX: 100, scaleY: 100, opacity: 255,
      },
      {
        op: "movePicture", id: 2, x: 300, y: 120, scaleX: 180,
        scaleY: 80, opacity: 120, duration: 10,
      },
      { op: "rotatePicture", id: 2, speed: 1 },
      { op: "wait", seconds: 20 },
    ]);
    const options = { hz: 60, idleFrames: 60_000, rewindSeconds: 3, attractEnabled: false } as const;
    const rewound = new AttractController(p, [], options);
    for (let i = 0; i < 240; i++) rewound.step(0);
    rewound.step(BTN.LTRIGGER);

    const direct = new AttractController(p, [], options);
    for (let i = 0; i < 60; i++) direct.step(0);
    expect(rewound.state).toEqual(direct.state);
    expect(rewound.state.interp.screen?.pictures?.["2"]?.move?.left).toBeGreaterThan(500);
  });
});

describe("KRM2 timer and host lifecycle", () => {
  for (const immutableState of [false, true]) {
    test(`a timer-conditioned page wakes after its threshold, immutable=${immutableState}`, () => {
      const p = project([
        { op: "timer", action: "start", seconds: 10 },
        { op: "switch", id: "done", value: true },
      ]);
      p.maps[0]!.events!.push({
        id: "timer-gate",
        x: 2,
        y: 1,
        pages: [{
          trigger: "parallel",
          condition: { all: [{ kind: "timer", op: "<=", seconds: 5 }] },
          commands: [
            { op: "switch", id: "timer-page-fired", value: true },
            { op: "erase" },
          ],
        }],
      });
      const session = createSession(p, 60, {
        immutableState,
        extensions: { immutableConditions: true, deterministicConditions: true },
      });
      const state = run(session, startSession(p, session), 8 * 60);
      expect(state.sw.switches["timer-page-fired"]).toBe(true);
    });
  }

  for (const immutableState of [false, true]) {
    test(`timer changes wake an idle trigger scan, immutable=${immutableState}`, () => {
      const p = project([
        { op: "timer", action: "start", seconds: 10 },
        { op: "switch", id: "done", value: true },
      ]);
      p.maps[0]!.events!.push({
        id: "timer-branch",
        x: 2,
        y: 1,
        pages: [{
          trigger: "parallel",
          commands: [{
            op: "if",
            if: { kind: "timer", op: "<=", seconds: 5 },
            then: [{ op: "switch", id: "timer-branch-fired", value: true }],
          }],
        }],
      });
      const session = createSession(p, 60, {
        immutableState,
        extensions: { immutableConditions: true, deterministicConditions: true },
      });
      const state = run(session, startSession(p, session), 8 * 60);
      expect(state.sw.switches["timer-branch-fired"]).toBe(true);
    });
  }

  test("the global timer continues through a default-frozen scene", () => {
    const neverEnds: BattleRules = {
      start(ext) { return { ext, state: { open: true } }; },
      step(state) { return state; },
      done() { return null; },
    };
    const p = project([
      { op: "timer", action: "start", seconds: 1 },
      { op: "battle", setup: null },
    ]);
    const session = createSession(p, 4, { battle: neverEnds });
    let state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.scene?.kind).toBe("battle");
    state = run(session, state, 4);
    expect(state.sw.timer).toEqual({ remaining: 0, running: true, expired: true });
    expect(evalCondition({ kind: "timer", op: "<=", seconds: 0 }, state.sw, "start/director")).toBe(true);
    expect(evalCondition({ kind: "timer", op: ">=", seconds: 1 }, state.sw, "start/director")).toBe(false);
  });

  test("low-Hz frames preserve every ordered host request, then drain them", () => {
    const oneTick = 1 / 60;
    const p = project([
      { op: "openMenu" },
      { op: "wait", seconds: oneTick },
      { op: "openSave" },
      { op: "wait", seconds: oneTick },
      { op: "gameOver" },
      { op: "wait", seconds: oneTick },
      { op: "returnTitle" },
      { op: "switch", id: "done", value: true },
    ]);
    const session = createSession(p, 4);
    let state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.interp.hostActions as HostAction[]).toEqual(["menu", "save", "gameOver", "title"]);
    expect(state.sw.switches.done).toBe(true);
    state = stepSession(session, state, { buttons: 0 });
    expect(state.interp.hostActions).toBeUndefined();
  });

  test("autosave captures its exact reference tick and resumes after the command at every host rate", () => {
    const p = project([
      { op: "variable", id: "before", set: { op: "set", value: 1 } },
      { op: "autosave" },
      { op: "variable", id: "after", set: { op: "set", value: 2 } },
      { op: "switch", id: "done", value: true },
    ]);
    const envelopes = [60, 30, 20].map((hz) => {
      const session = createSession(p, hz);
      const effects: SessionHostEffect[] = [];
      const state = stepSession(
        session,
        startSession(p, session),
        { buttons: BTN.CIRCLE },
        { publish: (effect) => effects.push(effect) },
      );
      expect(effects).toHaveLength(1);
      expect(effects[0]!.action).toBe("autosave");
      if (effects[0]!.action !== "autosave") throw new Error("expected autosave effect");
      const snapshot = effects[0]!.snapshot;
      expect(snapshot.autosave).toBe(true);
      expect(snapshot.held).toBe(BTN.CIRCLE);
      expect(snapshot.interp.frame).toBe(1);
      expect(snapshot.interp.sw.variables).toEqual({ before: 1 });
      expect(snapshot.interp.main?.mode).toBe("run");

      // At 30/20 Hz the host frame has already folded later reference ticks;
      // mutating that live state must not alter the captured checkpoint.
      if (hz !== 60) expect(state.sw.variables.after).toBe(2);
      expect(snapshot.interp.sw.variables.after).toBeUndefined();

      let restored = restoreSessionEnvelope(session, encodeEnvelope(snapshot));
      const replayEffects: SessionHostEffect[] = [];
      restored = stepSession(session, restored, { buttons: BTN.CIRCLE }, {
        publish: (effect) => replayEffects.push(effect),
      });
      expect(restored.sw.variables.after).toBe(2);
      expect(restored.sw.switches.done).toBe(true);
      expect(replayEffects).toEqual([]);
      return encodeEnvelope(snapshot);
    });
    expect(envelopes[1]).toBe(envelopes[0]);
    expect(envelopes[2]).toBe(envelopes[0]);
  });

  test("a parallel autosave preserves an in-flight player step", () => {
    const p = project([]);
    p.maps[0]!.events!.push({
      id: "checkpoint",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "autosave" },
            { op: "switch", id: "checkpointDone", value: true },
          ],
        },
        { condition: { switch: "checkpointDone" }, trigger: "action", commands: [] },
      ],
    });
    const session = createSession(p, 60);
    const effects: SessionHostEffect[] = [];
    let live = stepSession(session, startSession(p, session), { buttons: BTN.RIGHT }, {
      publish: (effect) => effects.push(effect),
    });
    expect(live.move).toMatchObject({ moving: true, phase: 1, px: 50 });
    expect(effects).toHaveLength(1);
    const effect = effects[0]!;
    if (effect.action !== "autosave") throw new Error("expected autosave effect");
    expect(effect.snapshot.player).toEqual(live.move);

    let restored = restoreSessionEnvelope(session, encodeEnvelope(effect.snapshot));
    expect(restored.move).toEqual(live.move);
    for (let i = 0; i < 8; i++) {
      live = stepSession(session, live, { buttons: 0 });
      restored = stepSession(session, restored, { buttons: 0 });
    }
    expect(restored).toEqual(live);
    expect(restored.sw.switches.checkpointDone).toBe(true);
  });

  test("a parallel autosave round-trips a main fiber waiting on a player route", () => {
    const p = project([
      {
        op: "moveRoute",
        target: "player",
        wait: true,
        route: {
          steps: ["moveRight", "moveRight"],
          repeat: false,
          skippable: false,
        },
      },
      { op: "switch", id: "route.done", value: true },
    ]);
    p.maps[0]!.events!.push({
      id: "checkpoint",
      x: 1,
      y: 2,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "autosave" },
            { op: "switch", id: "checkpoint.done", value: true },
          ],
        },
        { condition: { switch: "checkpoint.done" }, trigger: "action", commands: [] },
      ],
    });

    const session = createSession(p, 60);
    const effects: SessionHostEffect[] = [];
    let live = stepSession(session, startSession(p, session), { buttons: 0 }, {
      publish: (effect) => effects.push(effect),
    });
    expect(live.interp.main?.mode).toBe("external");
    expect(live.playerRoute?.waiter).toBe("start/director");
    expect(effects).toHaveLength(1);
    const effect = effects[0]!;
    if (effect.action !== "autosave") throw new Error("expected autosave effect");
    expect(effect.snapshot.interp.main?.mode).toBe("external");
    expect(effect.snapshot.mapRuntime?.playerRoute?.waiter).toBe("start/director");

    let restored = restoreSessionEnvelope(session, encodeEnvelope(effect.snapshot));
    for (let i = 0; i < 20; i++) {
      live = stepSession(session, live, { buttons: 0 });
      restored = stepSession(session, restored, { buttons: 0 });
    }
    expect(restored.sw.switches).toMatchObject({
      "route.done": true,
      "checkpoint.done": true,
    });
    expect(canonicalJson(restored)).toBe(canonicalJson(live));
  });

  test("autosave round-trips another parallel fiber's open choices modal", () => {
    const p = project([]);
    p.maps[0]!.events!.push(
      {
        id: "a-evolution",
        x: 1,
        y: 1,
        pages: [
          {
            trigger: "parallel",
            commands: [
              {
                op: "choices",
                prompt: "Allow evolution?",
                options: [
                  { text: "Yes", commands: [{ op: "switch", id: "evolution.allowed", value: true }] },
                  { text: "No", commands: [{ op: "switch", id: "evolution.allowed", value: false }] },
                ],
              },
              { op: "switch", id: "evolution.done", value: true },
            ],
          },
          { condition: { switch: "evolution.done" }, trigger: "action", commands: [] },
        ],
      },
      {
        id: "b-checkpoint",
        x: 2,
        y: 1,
        pages: [
          {
            trigger: "parallel",
            commands: [
              { op: "autosave" },
              { op: "switch", id: "checkpoint.done", value: true },
            ],
          },
          { condition: { switch: "checkpoint.done" }, trigger: "action", commands: [] },
        ],
      },
    );
    const session = createSession(p, 60);
    const effects: SessionHostEffect[] = [];
    let live = stepSession(session, startSession(p, session), { buttons: 0 }, {
      publish: (effect) => effects.push(effect),
    });
    expect(effects).toHaveLength(1);
    const effect = effects[0]!;
    if (effect.action !== "autosave") throw new Error("expected autosave effect");
    expect(effect.snapshot.interp.modal).toMatchObject({
      kind: "choices",
      fiber: "start/a-evolution",
      prompt: "Allow evolution?",
    });

    let restored = restoreSessionEnvelope(session, encodeEnvelope(effect.snapshot));
    expect(restored.interp.modal).toEqual(effect.snapshot.interp.modal);
    const tail = [
      { buttons: BTN.CIRCLE, confirmEdge: true },
      { buttons: 0 },
      { buttons: 0 },
    ];
    for (const input of tail) {
      live = stepSession(session, live, input);
      restored = stepSession(session, restored, input);
    }
    expect(restored.interp.modal).toBeNull();
    expect(restored.sw.switches).toMatchObject({
      "evolution.allowed": true,
      "evolution.done": true,
      "checkpoint.done": true,
    });
    expect(canonicalJson(restored)).toBe(canonicalJson(live));
  });

  test("an unsafe autosave waits, merges later requests, and publishes on one reference tick at every rate", () => {
    const envelopes = [60, 30, 20].map((hz) => {
      const p = deferredAutosaveProject();
      const options = {
        scenes: { [AUTOSAVE_DELAY_SCENE]: autosaveDelayRules },
        scene: { worldContinues: true },
      } as const;
      const session = createSession(p, hz, options);
      const hostlessSession = createSession(p, hz, options);
      const effects: SessionHostEffect[] = [];
      let state = startSession(p, session);
      let hostless = startSession(p, hostlessSession);
      let authoredRequests = 0;
      for (let frame = 0; frame < 12 && effects.length === 0; frame++) {
        state = stepSession(session, state, { buttons: 0 }, {
          publish: (effect) => effects.push(effect),
        });
        hostless = stepSession(hostlessSession, hostless, { buttons: 0 });
        authoredRequests += state.interp.hostActions?.filter((action) => action === "autosave").length ?? 0;
        expect(hostless).toEqual(state);
        if (state.scene !== null) expect(state.pendingAutosave).toBe(true);
      }
      expect(authoredRequests).toBeGreaterThanOrEqual(2);
      expect(effects).toHaveLength(1);
      const effect = effects[0]!;
      if (effect.action !== "autosave") throw new Error("expected autosave effect");
      expect(effect.snapshot.interp.frame).toBe(7);
      expect(effect.snapshot.autosave).toBe(true);
      expect("pendingAutosave" in effect.snapshot).toBe(false);
      expect(state.pendingAutosave).toBeUndefined();
      return encodeEnvelope(effect.snapshot);
    });
    expect(envelopes[1]).toBe(envelopes[0]);
    expect(envelopes[2]).toBe(envelopes[0]);
  });

  test("a deferred autosave cannot be lost through a manual save point", () => {
    const p = project([]);
    const session = createSession(p, 60);
    const state = startSession(p, session);
    state.pendingAutosave = true;
    const result = saveSession(session, state, 0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refused manual save");
    expect(result.error.code).toBe("not-safe-point");
    expect(() => createSessionSnapshot(session, state, 0)).toThrow(/deferred autosave request/);
  });

  test("attract rewind refolds autosave without republishing the host effect", () => {
    const p = project([
      { op: "autosave" },
      { op: "wait", seconds: 20 },
      { op: "switch", id: "done", value: true },
    ]);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 3,
      keyframeMaxBytes: 0,
    });
    const effects: SessionHostEffect[] = [];
    const sink = { publish: (effect: SessionHostEffect) => effects.push(effect) };
    controller.step(0, sink);
    expect(effects.map((effect) => effect.action)).toEqual(["autosave"]);
    for (let i = 0; i < 239; i++) controller.step(0, sink);
    controller.step(BTN.LTRIGGER, sink);
    expect(effects.map((effect) => effect.action)).toEqual(["autosave"]);
  });
});

describe("KRM2 input, name and map banner", () => {
  test("inputNumber compiles through the generic scene host and commits the variable", () => {
    const p = project([
      { op: "variable", id: "pin", set: { op: "set", value: 42 } },
      { op: "inputNumber", variable: "pin", digits: 4 },
      { op: "switch", id: "done", value: true },
    ]);
    const session = createSession(p, 60, {
      scenes: { [NUMBER_INPUT_SCENE_ID]: numberInputRules },
    });
    let state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.scene?.kind).toBe("scene");
    expect(state.scene?.kind === "scene" ? state.scene.id : null).toBe(NUMBER_INPUT_SCENE_ID);
    expect(state.scene?.state).toMatchObject({ value: 42, digits: 4, cursor: 0 } satisfies Partial<NumberInputState>);

    state = stepSession(session, state, { buttons: BTN.UP, upEdge: true });
    state = stepSession(session, state, { buttons: BTN.RIGHT, rightEdge: true });
    state = stepSession(session, state, { buttons: BTN.UP, upEdge: true });
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    state = stepSession(session, state, { buttons: 0 });
    expect(state.scene).toBeNull();
    expect(state.sw.variables.pin).toBe(1142);
    expect(state.sw.switches.done).toBe(true);
  });

  test("changeName immediately feeds the existing {name} token", () => {
    const p = project([
      { op: "changeName", name: "Mina" },
      { op: "text", lines: ["Welcome, {name}!"] },
    ]);
    const session = createSession(p, 60);
    const state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.sw.playerName).toBe("Mina");
    expect(state.interp.modal?.kind).toBe("text");
    if (state.interp.modal?.kind === "text") {
      expect(state.interp.modal.lines).toEqual(["Welcome, Mina!"]);
    }
  });

  test("map-name banners are opt-in, persist their flag and restart on transfer", () => {
    const next = map("next", "Moonlit Promenade");
    const enabled = project([
      { op: "transfer", map: "next", x: 2, y: 2, dir: "right", fade: 0 },
    ], { systemMapName: true, extraMaps: [next] });
    const enabledSession = createSession(enabled, 60);
    const fresh = startSession(enabled, enabledSession);
    expect(fresh.interp.screen?.mapNameBanner).toEqual({ text: "Starting Harbor", total: 180, left: 180 });
    const transferred = stepSession(enabledSession, fresh, { buttons: 0 });
    expect(transferred.mapId).toBe("next");
    expect(transferred.sw.mapNameDisplay).toBe(true);
    expect(transferred.interp.screen?.mapNameBanner).toEqual({ text: "Moonlit Promenade", total: 180, left: 180 });

    const disabled = project([], { systemMapName: false });
    const disabledSession = createSession(disabled, 60);
    expect(startSession(disabled, disabledSession).interp.screen).toBeUndefined();

    const switchedOff = project([
      { op: "mapNameDisplay", visible: false },
      { op: "transfer", map: "next", x: 2, y: 2, dir: "right", fade: 0 },
    ], { systemMapName: true, extraMaps: [next] });
    const switchedSession = createSession(switchedOff, 60);
    const after = stepSession(switchedSession, startSession(switchedOff, switchedSession), { buttons: 0 });
    expect(after.sw.mapNameDisplay).toBeUndefined();
    expect(after.interp.screen?.mapNameBanner).toBeUndefined();
  });
});
