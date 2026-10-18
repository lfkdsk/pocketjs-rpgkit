import { describe, expect, test } from "bun:test";
import { ME_REPLAY_FADE_TICKS, audioTrackVolume, type AudioState } from "../src/engine/audio.ts";
import { battleEffectsRuntime } from "../src/engine/battle-effects.ts";
import {
  evalCondition,
  createInterpState,
  createWorld,
  stepInterp,
  type InterpInput,
  type InterpState,
} from "../src/engine/interpreter.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSession, startSession, stepSession, type SessionState } from "../src/engine/session.ts";
import { createSessionSnapshot, decodeEnvelopeText, encodeEnvelope } from "../src/engine/save.ts";
import { restoreSessionSnapshot } from "../src/engine/save-restore.ts";
import type {
  BattleCompletion,
  BattleRules,
  BattleStart,
  BattleTransfer,
} from "../src/engine/battle.ts";
import { travelRuntime } from "../src/travel.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

/** Only battle scenes carry the suspended map audio snapshot. */
function battleReturnAudio(s: SessionState): AudioState | null | undefined {
  return s.scene?.kind === "battle" ? s.scene.returnAudio : undefined;
}

const SILENT_INPUT: InterpInput = {
  confirmEdge: false,
  playerCell: { x: 1, y: 1 },
  prevCell: { x: 1, y: 1 },
  facing: 2,
};

function testMap(id: string, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["base"],
    ground: new Array(16).fill("base.0"),
    events,
  };
}

function action(id: string, commands: Command[]): GameEvent {
  return { id, x: 1, y: 0, pages: [{ trigger: "action", commands }] };
}

function project(maps: MapDef[], start = maps[0]!.id): Project {
  return {
    format: "rpgkit-project/v1",
    title: "audio fixture",
    tileSize: 16,
    start: { map: start, x: 1, y: 1, dir: "up" },
    sheets: [{ id: "base", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    audio: {},
    maps,
  };
}

function issue(state: InterpState, command: Command, id = "source"): InterpState {
  return issueMany(state, [command], id);
}

function issueMany(state: InterpState, commands: Command[], id = "source"): InterpState {
  const world = createWorld(testMap("m", [action(id, commands)]), []);
  return stepInterp(world, state, { ...SILENT_INPUT, confirmEdge: true });
}

function idleInterp(state: InterpState, ticks: number): InterpState {
  const world = createWorld(testMap("m"), []);
  let next = state;
  for (let i = 0; i < ticks; i++) next = stepInterp(world, next, SILENT_INPUT);
  return next;
}

function audioBattleRules(options: {
  audio?: BattleStart["audio"];
  instant?: boolean;
  decline?: boolean;
  transfer?: BattleTransfer;
  immutable?: boolean;
  completionAudio?: BattleCompletion["audio"];
} = {}): BattleRules {
  return {
    effects: battleEffectsRuntime,
    ...(options.immutable ? { immutableState: true } : {}),
    start(ext) {
      if (options.decline) return null;
      return {
        ext,
        state: { done: options.instant === true },
        ...(options.audio !== undefined ? { audio: options.audio } : {}),
      };
    },
    step(rawState, input) {
      const state = rawState as { done: boolean };
      return { done: state.done || input.confirmEdge === true };
    },
    done(rawState) {
      const state = rawState as { done: boolean };
      return state.done
        ? {
          ext: null,
          result: "win",
          ...(options.transfer ? { transfer: options.transfer } : {}),
          ...(options.completionAudio ? { audio: options.completionAudio } : {}),
        }
        : null;
    },
  };
}

function battleProject(before: Command[], extraMaps: MapDef[] = []): Project {
  return project([
    testMap("m", [action("battle", [
      ...before,
      { op: "battle", setup: null },
    ])]),
    ...extraMaps,
  ]);
}

function sessionStep(
  session: ReturnType<typeof createSession>,
  state: SessionState,
  confirmEdge = false,
): SessionState {
  return stepSession(session, state, { buttons: 0, confirmEdge });
}

describe("audio reducer state", () => {
  test("play/pause/resume/stop BGM and bgmPlaying are deterministic", () => {
    let state = issue(createInterpState(), { op: "playBgm", id: "route-1" });
    expect(state.audio?.bgm).toEqual({ id: "route-1", volume: 100, pitch: 100, positionTicks: 0 });
    expect(evalCondition(
      { kind: "bgmPlaying" },
      state.sw,
      "m/source",
      undefined,
      undefined,
      { worldIdle: true, audio: state.audio },
    )).toBe(true);
    expect(evalCondition(
      { kind: "bgmPlaying", id: "other", negate: true },
      state.sw,
      "m/source",
      undefined,
      undefined,
      { worldIdle: true, audio: state.audio },
    )).toBe(true);

    state = issue(state, { op: "pauseBgm" }, "pause");
    expect(state.audio?.bgm?.paused).toBe(true);
    const held = state.audio!.bgm!.positionTicks;
    state = idleInterp(state, 5);
    expect(state.audio?.bgm?.positionTicks).toBe(held);
    expect(evalCondition(
      { kind: "bgmPlaying", id: "route-1" }, state.sw, "m/source", undefined, undefined,
      { worldIdle: true, audio: state.audio },
    )).toBe(false);

    state = issue(state, { op: "resumeBgm" }, "resume");
    state = idleInterp(state, 1);
    expect(state.audio?.bgm?.positionTicks).toBe(held + 1);
    state = issue(state, { op: "stopBgm" }, "stop");
    expect(state.audio).toBeUndefined();
  });

  test("BGM/BGS fades use exact reference ticks and monotonic volume", () => {
    let state = issue(createInterpState(), { op: "playBgm", id: "field", volume: 80, pitch: 90 });
    state = issue(state, { op: "playBgs", id: "rain", volume: 60 }, "bgs");
    state = issueMany(state, [
      { op: "fadeoutBgm", duration: 1 },
      { op: "fadeoutBgs", duration: 0.5 },
    ], "fades");
    expect(state.audio?.bgm?.fade).toEqual({ totalTicks: 60, leftTicks: 60 });
    expect(state.audio?.bgs?.fade).toEqual({ totalTicks: 30, leftTicks: 30 });
    expect(evalCondition(
      { kind: "bgmPlaying", id: "field" }, state.sw, "m/source", undefined, undefined,
      { worldIdle: true, audio: state.audio },
    )).toBe(false);

    const volumes: number[] = [];
    for (let i = 0; i < 29; i++) {
      state = idleInterp(state, 1);
      volumes.push(audioTrackVolume(state.audio!.bgm!));
    }
    expect(volumes.every((value, i) => i === 0 || value < volumes[i - 1]!)).toBe(true);
    expect(state.audio?.bgs).toBeDefined();
    state = idleInterp(state, 1);
    expect(state.audio?.bgs).toBeUndefined();
    expect(state.audio?.bgm?.fade?.leftTicks).toBe(30);
    state = idleInterp(state, 30);
    expect(state.audio).toBeUndefined();
  });

  test("ME suspends BGM and automatically restores it after its authored duration", () => {
    let state = issue(createInterpState(), { op: "playBgm", id: "route" });
    state = idleInterp(state, 10);
    state = issue(state, { op: "playMe", id: "fanfare", duration: 0.5, volume: 70 }, "me");
    const held = state.audio!.bgm!.positionTicks;
    expect(state.audio?.me).toMatchObject({ id: "fanfare", durationTicks: 30, leftTicks: 30 });
    expect(evalCondition(
      { kind: "bgmPlaying" }, state.sw, "m/source", undefined, undefined,
      { worldIdle: true, audio: state.audio },
    )).toBe(false);
    state = idleInterp(state, 29);
    expect(state.audio?.bgm?.positionTicks).toBe(held);
    expect(state.audio?.me?.leftTicks).toBe(1);
    state = idleInterp(state, 1);
    expect(state.audio?.me).toBeUndefined();
    expect(state.audio?.bgm?.positionTicks).toBe(held);
    expect(state.audio?.bgm?.fade).toEqual({
      totalTicks: ME_REPLAY_FADE_TICKS,
      leftTicks: ME_REPLAY_FADE_TICKS,
      direction: "in",
    });
    expect(audioTrackVolume(state.audio!.bgm!)).toBe(0);
    state = idleInterp(state, 1);
    expect(state.audio?.bgm?.positionTicks).toBe(held + 1);
    expect(audioTrackVolume(state.audio!.bgm!)).toBeCloseTo(100 / ME_REPLAY_FADE_TICKS);
    state = idleInterp(state, ME_REPLAY_FADE_TICKS - 1);
    expect(state.audio?.bgm?.fade).toBeUndefined();
    expect(audioTrackVolume(state.audio!.bgm!)).toBe(100);
  });

  test("saveBgm/replayBgm restore id, parameters and virtual position without stopping ME", () => {
    let state = issue(createInterpState(), { op: "playBgm", id: "first", volume: 73, pitch: 120, pan: -40 });
    state = idleInterp(state, 8);
    state = issue(state, { op: "saveBgm" }, "save");
    const saved = { ...state.audio!.savedBgm! };
    state = issue(state, { op: "playBgm", id: "second" }, "replace");
    state = issue(state, { op: "playMe", id: "sting", duration: 2 }, "me");
    state = issue(state, { op: "replayBgm" }, "replay");
    expect(state.audio?.bgm).toEqual({
      ...saved,
      fade: { totalTicks: ME_REPLAY_FADE_TICKS, leftTicks: ME_REPLAY_FADE_TICKS, direction: "in" },
    });
    expect(state.audio?.me?.id).toBe("sting");

    state = issue(state, { op: "saveBgm" }, "save-again");
    const position = state.audio!.bgm!.positionTicks;
    state = issue(state, { op: "replayBgm" }, "replay-same");
    expect(state.audio?.bgm?.positionTicks).toBe(position);
    expect(state.audio?.bgm?.fade).toEqual({
      totalTicks: ME_REPLAY_FADE_TICKS, leftTicks: ME_REPLAY_FADE_TICKS, direction: "in",
    });

    state = issue(state, { op: "playBgm", id: "first", volume: 20, pitch: 90, pan: 30 }, "pitch-update");
    const changedPitchPosition = state.audio!.bgm!.positionTicks;
    state = issue(state, { op: "replayBgm" }, "replay-same-different-pitch");
    expect(state.audio?.bgm).toMatchObject({
      ...state.audio!.savedBgm!,
      positionTicks: changedPitchPosition,
    });
  });

  test("same-id volume/pan/pitch preserve position and explicit ME stop fades", () => {
    let state = issue(createInterpState(), { op: "playBgm", id: "route", volume: 70 });
    state = issue(state, { op: "playBgs", id: "rain", volume: 55 }, "bgs");
    state = idleInterp(state, 12);
    const bgmBeforeUpdate = state.audio!.bgm!.positionTicks;
    state = issue(state, { op: "playBgm", id: "route", volume: 80, pitch: 100, pan: 25 }, "bgm-update");
    expect(state.audio?.bgm?.positionTicks).toBe(bgmBeforeUpdate + 1);
    const bgmBeforeBgsUpdate = state.audio!.bgm!.positionTicks;
    const bgsBeforeUpdate = state.audio!.bgs!.positionTicks;
    state = issue(state, { op: "playBgs", id: "rain", volume: 65, pitch: 100, pan: -30 }, "bgs-update");
    expect(state.audio?.bgm).toEqual({
      id: "route", volume: 80, pitch: 100, pan: 25, positionTicks: bgmBeforeBgsUpdate + 1,
    });
    expect(state.audio?.bgs).toEqual({
      id: "rain", volume: 65, pitch: 100, pan: -30, positionTicks: bgsBeforeUpdate + 1,
    });

    const bgmBeforePitch = state.audio!.bgm!.positionTicks;
    const bgsBeforeBgmPitch = state.audio!.bgs!.positionTicks;
    state = issue(state, { op: "playBgm", id: "route", volume: 80, pitch: 120, pan: 25 }, "bgm-pitch");
    expect(state.audio?.bgm).toEqual({
      id: "route", volume: 80, pitch: 120, pan: 25, positionTicks: bgmBeforePitch + 1,
    });
    expect(state.audio?.bgs?.positionTicks).toBe(bgsBeforeBgmPitch + 1);

    const bgmBeforeBgsPitch = state.audio!.bgm!.positionTicks;
    const bgsBeforePitch = state.audio!.bgs!.positionTicks;
    state = issue(state, { op: "playBgs", id: "rain", volume: 65, pitch: 90, pan: -30 }, "bgs-pitch");
    expect(state.audio?.bgm?.positionTicks).toBe(bgmBeforeBgsPitch + 1);
    expect(state.audio?.bgs).toEqual({
      id: "rain", volume: 65, pitch: 90, pan: -30, positionTicks: bgsBeforePitch + 1,
    });

    state = issue(state, { op: "playMe", id: "sting", duration: 2 }, "me");
    state = idleInterp(state, 5);
    const held = state.audio!.bgm!.positionTicks;
    state = issue(state, { op: "stopMe" }, "stop-me");
    expect(state.audio?.me).toBeUndefined();
    expect(state.audio?.bgm?.positionTicks).toBe(held);
    expect(state.audio?.bgm?.fade).toEqual({
      totalTicks: ME_REPLAY_FADE_TICKS,
      leftTicks: ME_REPLAY_FADE_TICKS,
      direction: "in",
    });
  });

  test("fadeout clears BGM identity for same-id play, replay, save, and ME stop", () => {
    let state = issue(createInterpState(), { op: "playBgm", id: "route", volume: 70 });
    state = idleInterp(state, 8);
    state = issue(state, { op: "saveBgm" }, "save");
    const saved = { ...state.audio!.savedBgm! };

    state = issue(state, { op: "fadeoutBgm", duration: 2 }, "fade");
    state = idleInterp(state, 5);
    expect(state.audio!.bgm!.positionTicks).toBeGreaterThan(saved.positionTicks);
    state = issue(state, { op: "replayBgm" }, "replay-after-fade");
    expect(state.audio?.bgm).toEqual({
      ...saved,
      fade: {
        totalTicks: ME_REPLAY_FADE_TICKS,
        leftTicks: ME_REPLAY_FADE_TICKS,
        direction: "in",
      },
    });

    state = issue(state, { op: "fadeoutBgm", duration: 2 }, "fade-again");
    state = issue(state, { op: "playBgm", id: "route", volume: 80 }, "fresh-same-id");
    expect(state.audio?.bgm).toEqual({ id: "route", volume: 80, pitch: 100, positionTicks: 0 });

    state = issue(state, { op: "fadeoutBgm", duration: 2 }, "fade-before-save");
    state = issue(state, { op: "saveBgm" }, "save-fading");
    expect(state.audio?.savedBgm).toBeUndefined();

    state = issue(state, { op: "playBgm", id: "route" }, "bgm-before-me");
    state = issue(state, { op: "playMe", id: "sting", duration: 2 }, "me-before-fade");
    state = issue(state, { op: "fadeoutBgm", duration: 1 }, "fade-during-me");
    expect(state.audio?.bgm).toBeUndefined();
    expect(state.audio?.me?.id).toBe("sting");
    state = issue(state, { op: "stopMe" }, "stop-me-after-fade");
    expect(state.audio).toBeUndefined();
  });

  test("playSe and legacy se share the ordered transient cue channel", () => {
    const world = createWorld(testMap("m", [action("source", [
      { op: "se", name: "legacy", volume: 40 },
      { op: "playSe", id: "modern", pitch: 125, pan: 100 },
    ])]), []);
    let state = stepInterp(world, createInterpState(), { ...SILENT_INPUT, confirmEdge: true });
    expect(state.cues).toEqual([
      { name: "legacy", volume: 40, pitch: 100 },
      { name: "modern", volume: 100, pitch: 125, pan: 100 },
    ]);
    state = idleInterp(state, 1);
    expect(state.cues).toEqual([]);
  });
});

describe("session audio clock", () => {
  const startCommands: Command[] = [
    { op: "playBgm", id: "route" },
    { op: "playBgs", id: "rain" },
    { op: "playMe", id: "intro", duration: 0.5 },
    { op: "selfSwitch", key: "A", value: true },
  ];
  const startup: GameEvent = {
    id: "startup",
    x: 0,
    y: 0,
    pages: [
      { trigger: "autorun", commands: startCommands },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ],
  };

  test("60/30/20/4 Hz reach the same audio state after one virtual second", () => {
    const snapshots: unknown[] = [];
    for (const hz of [60, 30, 20, 4]) {
      const p = project([testMap("m", [startup])]);
      const session = createSession(p, hz);
      let state = startSession(p, session);
      for (let i = 0; i < hz; i++) state = stepSession(session, state, { buttons: 0 });
      snapshots.push(state.interp.audio);
    }
    for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
    expect(snapshots[0]).toEqual({
      bgm: {
        id: "route", volume: 100, pitch: 100, positionTicks: 29,
        fade: { totalTicks: ME_REPLAY_FADE_TICKS, leftTicks: 1, direction: "in" },
      },
      bgs: { id: "rain", volume: 100, pitch: 100, positionTicks: 59 },
    });
  });

  test("low-Hz batches retain every cue, including one before an immediate transfer", () => {
    const timed: GameEvent = {
      id: "timed",
      x: 0,
      y: 0,
      pages: [{ trigger: "autorun", commands: [
        { op: "playSe", id: "first" },
        { op: "wait", seconds: 1 / 60 },
        { op: "playSe", id: "second" },
        { op: "selfSwitch", key: "A", value: true },
      ] }, { trigger: "action", condition: { selfSwitch: "A" }, commands: [] }],
    };
    const p = project([testMap("m", [timed])]);
    const session = createSession(p, 30);
    const state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.interp.cues.flatMap((cue) => ("name" in cue ? [cue.name] : []))).toEqual(["first", "second"]);

    const transfer: GameEvent = {
      id: "transfer",
      x: 0,
      y: 0,
      pages: [{ trigger: "autorun", commands: [
        { op: "playSe", id: "door" },
        { op: "transfer", map: "b", x: 1, y: 1 },
      ] }],
    };
    const p2 = project([testMap("a", [transfer]), testMap("b")], "a");
    const session2 = createSession(p2, 60);
    const moved = stepSession(session2, startSession(p2, session2), { buttons: 0 });
    expect(moved.mapId).toBe("b");
    expect(moved.interp.cues.flatMap((cue) => ("name" in cue ? [cue.name] : []))).toEqual(["door"]);
  });

  test("audio survives map transfer and a save/load envelope", () => {
    const transfer: GameEvent = {
      id: "transfer",
      x: 0,
      y: 0,
      pages: [{ trigger: "autorun", commands: [
        { op: "playBgm", id: "overworld", volume: 75 },
        { op: "transfer", map: "b", x: 1, y: 1 },
      ] }],
    };
    const p = project([testMap("a", [transfer]), testMap("b")], "a");
    const session = createSession(p);
    const state = stepSession(session, startSession(p, session), { buttons: 0 });
    expect(state.mapId).toBe("b");
    expect(state.interp.audio?.bgm?.id).toBe("overworld");
    const snapshot = createSessionSnapshot(session, state, 0);
    const restored = decodeEnvelopeText(encodeEnvelope(snapshot));
    expect(restored.interp.audio).toEqual(state.interp.audio);
  });

  test("attract rewind restores the reference-tick audio position", () => {
    const p = project([testMap("m", [startup])]);
    const rewound = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 1,
      keyframeIntervalFrames: 20,
    });
    rewound.startPlay();
    for (let i = 0; i < 120; i++) rewound.step(0);
    rewound.step(0x0100);

    const reference = new AttractController(p, [], { hz: 60, attractEnabled: false });
    reference.startPlay();
    for (let i = 0; i < rewound.length; i++) reference.step(0);
    expect(rewound.state.interp.audio).toEqual(reference.state.interp.audio);
  });
});

describe("battle one-shot cue projection", () => {
  test("requires the opt-in effects runtime before accepting a cue projector", () => {
    const rules: BattleRules = {
      start: (ext) => ({ ext, state: null }),
      step: (state) => state,
      cues: () => undefined,
      done: () => null,
    };
    expect(() => createSession(battleProject([]), 60, { battle: rules })).toThrow(
      "BattleRules.cues requires a battle effects runtime",
    );
  });

  test("protects mutable previous state, preserves cue order, and keeps silent projects cold", () => {
    let projections = 0;
    const rules: BattleRules = {
      effects: battleEffectsRuntime,
      start: (ext) => ({ ext, state: { tick: 0 } }),
      step(raw, _input, ticks) {
        const state = raw as { tick: number };
        state.tick += ticks;
        return raw;
      },
      cues(previousRaw, nextRaw) {
        projections++;
        const previous = previousRaw as { tick: number };
        const next = nextRaw as { tick: number };
        return previous.tick === 0 && next.tick > 0
          ? [
            { id: "first", volume: 80, pitch: 110, pan: -20 },
            { id: "second" },
          ]
          : undefined;
      },
      done: () => null,
    };
    const p = battleProject([]);
    const session = createSession(p, 60, { battle: rules });
    const entered = sessionStep(session, startSession(p, session), true);
    expect(projections).toBe(0);
    const fired = sessionStep(session, entered);
    expect(projections).toBe(1);
    expect(fired.interp.cues).toEqual([
      { name: "first", volume: 80, pitch: 110, pan: -20 },
      { name: "second", volume: 100, pitch: 100 },
    ]);
    expect((entered.scene!.state as { tick: number }).tick).toBe(0);
    expect((fired.scene!.state as { tick: number }).tick).toBe(1);
    const drained = sessionStep(session, fired);
    expect(drained.interp.cues).toEqual([]);

    // At low host rates, a map command can emit before opening the battle
    // while the remaining reference ticks advance its new scene. Preserve
    // map-before-battle ordering when both lists share one host frame.
    const mergedProject = battleProject([{ op: "playSe", id: "map-cue" }]);
    const mergedSession = createSession(mergedProject, 20, { battle: rules });
    const merged = sessionStep(mergedSession, startSession(mergedProject, mergedSession), true);
    expect(merged.interp.cues).toEqual([
      { name: "map-cue", volume: 100, pitch: 100 },
      { name: "first", volume: 80, pitch: 110, pan: -20 },
      { name: "second", volume: 100, pitch: 100 },
    ]);

    const noAudio = structuredClone(p);
    delete noAudio.audio;
    const coldSession = createSession(noAudio, 60, { battle: rules });
    const coldEntered = sessionStep(coldSession, startSession(noAudio, coldSession), true);
    const callsBefore = projections;
    sessionStep(coldSession, coldEntered);
    expect(projections).toBe(callsBefore);
  });

  for (const [value, message] of [
    [null, "array required"],
    [[{}], "id: non-empty string"],
    [[{ id: "x", volume: 101 }], "volume: integer 0..100"],
    [[{ id: "x", pitch: 49 }], "pitch: integer 50..150"],
    [[{ id: "x", pan: -101 }], "pan: integer -100..100"],
  ] as const) {
    test(`rejects malformed projected cues: ${message}`, () => {
      const rules: BattleRules = {
        effects: battleEffectsRuntime,
        start: (ext) => ({ ext, state: { tick: 0 } }),
        step: () => ({ tick: 1 }),
        cues: (() => value) as BattleRules["cues"],
        done: () => null,
      };
      const p = battleProject([]);
      const session = createSession(p, 60, { battle: rules });
      const entered = sessionStep(session, startSession(p, session), true);
      expect(() => sessionStep(session, entered)).toThrow(message);
    });
  }

  test("save/load drains historical cues while a rewind can cross the edge again", () => {
    const rules: BattleRules = {
      effects: battleEffectsRuntime,
      save: {
        encode: (state) => structuredClone(state),
        decode: (state) => structuredClone(state),
      },
      start: (ext) => ({ ext, state: { tick: 0 } }),
      step(raw) {
        return { tick: (raw as { tick: number }).tick + 1 };
      },
      cues(previousRaw, nextRaw) {
        const previous = (previousRaw as { tick: number }).tick;
        const next = (nextRaw as { tick: number }).tick;
        return previous < 2 && next >= 2 ? [{ id: "edge" }] : undefined;
      },
      done: () => null,
    };
    const p = battleProject([]);
    const session = createSession(p, 60, { battle: rules });
    const entered = sessionStep(session, startSession(p, session), true);
    const before = sessionStep(session, entered);
    const restoredBefore = restoreSessionSnapshot(session, createSessionSnapshot(session, before, 0));
    expect(restoredBefore.interp.cues).toEqual([]);
    const crossed = sessionStep(session, restoredBefore);
    expect(crossed.interp.cues).toEqual([{ name: "edge", volume: 100, pitch: 100 }]);

    const restoredAfter = restoreSessionSnapshot(session, createSessionSnapshot(session, crossed, 0));
    expect(restoredAfter.interp.cues).toEqual([]);
    expect(sessionStep(session, restoredAfter).interp.cues).toEqual([]);

    const rewound = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 1 / 60,
      keyframeIntervalFrames: 1,
      battle: rules,
    });
    rewound.startPlay();
    rewound.step(0x2000); // enter battle
    rewound.step(0); // tick 1
    rewound.step(0); // tick 2, cue edge
    expect(rewound.state.interp.cues).toEqual([{ name: "edge", volume: 100, pitch: 100 }]);
    rewound.step(0x0100); // rewind to tick 1
    expect((rewound.state.scene!.state as { tick: number }).tick).toBe(1);
    expect(rewound.state.interp.cues).toEqual([]);
    rewound.step(0); // cross tick 2 on the new forward worldline
    expect(rewound.state.interp.cues).toEqual([{ name: "edge", volume: 100, pitch: 100 }]);
  });
});

describe("battle audio lifecycle", () => {
  const fullMapAudio: Command[] = [
    { op: "playBgm", id: "map", volume: 73, pitch: 120 },
    { op: "saveBgm" },
    { op: "playBgs", id: "rain", volume: 61, pitch: 90 },
    { op: "playMe", id: "intro", duration: 2, volume: 82, pitch: 110 },
    { op: "fadeoutBgm", duration: 1 },
    { op: "fadeoutBgs", duration: 0.5 },
    { op: "pauseBgm" },
  ];

  test("battle BGM suspends the surviving map mix and restores it atomically", () => {
    const p = battleProject(fullMapAudio);
    const session = createSession(p, 60, {
      battle: audioBattleRules({ audio: { bgm: { id: "combat", volume: 88, pitch: 105, pan: -27 } } }),
    });
    const entered = sessionStep(session, startSession(p, session), true);
    expect(battleReturnAudio(entered)).toEqual({
      bgs: {
        id: "rain", volume: 61, pitch: 90, positionTicks: 0,
        fade: { totalTicks: 30, leftTicks: 30 },
      },
      me: {
        id: "intro", volume: 82, pitch: 110, positionTicks: 0,
        durationTicks: 120, leftTicks: 120,
      },
      savedBgm: { id: "map", volume: 73, pitch: 120, positionTicks: 0 },
    });
    const suspended = structuredClone(battleReturnAudio(entered)!);
    expect(entered.interp.audio).toEqual({
      bgm: { id: "combat", volume: 88, pitch: 105, pan: -27, positionTicks: 0 },
    });

    const played = sessionStep(session, entered);
    expect(played.interp.audio?.bgm?.positionTicks).toBe(1);
    const completed = sessionStep(session, played, true);
    expect(completed.scene).toBeNull();
    expect(completed.interp.audio).toEqual(suspended);
    expect(completed.interp.audio).not.toBe(battleReturnAudio(played));
  });

  test("a state projection changes result BGM once, then restores the map mix", () => {
    const p = battleProject([{ op: "playBgm", id: "map", volume: 73 }]);
    const rules: BattleRules = {
      immutableState: true,
      start: (ext) => ({
        ext,
        state: { phase: "fight" },
        audio: { bgm: { id: "combat", volume: 88 } },
      }),
      step(rawState, input) {
        const state = rawState as { phase: "fight" | "result" | "done" };
        if (!input.confirmEdge) return state;
        return { phase: state.phase === "fight" ? "result" : "done" };
      },
      audio(rawState) {
        const state = rawState as { phase: string };
        return state.phase === "result" || state.phase === "done"
          ? { bgm: { id: "victory", volume: 91 } }
          : undefined;
      },
      done(rawState) {
        return (rawState as { phase: string }).phase === "done"
          ? { ext: null, result: "win" }
          : null;
      },
    };
    const session = createSession(p, 60, { battle: rules });
    const entered = sessionStep(session, startSession(p, session), true);
    expect(entered.interp.audio?.bgm).toEqual({
      id: "combat", volume: 88, pitch: 100, positionTicks: 0,
    });

    const result = sessionStep(session, entered, true);
    expect(result.interp.audio?.bgm).toEqual({
      id: "victory", volume: 91, pitch: 100, positionTicks: 0,
    });
    const held = sessionStep(session, result);
    expect(held.interp.audio?.bgm?.positionTicks).toBe(1);
    expect(result.interp.audio?.bgm?.positionTicks).toBe(0);

    const completed = sessionStep(session, held, true);
    expect(completed.scene).toBeNull();
    expect(completed.interp.audio?.bgm).toEqual({
      id: "map", volume: 73, pitch: 100, positionTicks: 0,
    });
  });

  test("a pan-only battle BGM projection replaces the track once", () => {
    const p = battleProject([]);
    const rules: BattleRules = {
      start: (ext) => ({
        ext,
        state: { shifted: false },
        audio: { bgm: { id: "combat", volume: 88, pitch: 105, pan: -20 } },
      }),
      step(rawState, input) {
        return input.confirmEdge ? { shifted: true } : rawState;
      },
      audio(rawState) {
        return (rawState as { shifted: boolean }).shifted
          ? { bgm: { id: "combat", volume: 88, pitch: 105, pan: 35 } }
          : undefined;
      },
      done: () => null,
    };
    const session = createSession(p, 60, { battle: rules });
    const entered = sessionStep(session, startSession(p, session), true);
    expect(entered.interp.audio?.bgm).toMatchObject({ pan: -20, positionTicks: 0 });

    const shifted = sessionStep(session, entered, true);
    expect(shifted.interp.audio?.bgm).toEqual({
      id: "combat", volume: 88, pitch: 105, pan: 35, positionTicks: 0,
    });
    const held = sessionStep(session, shifted);
    expect(held.interp.audio?.bgm?.positionTicks).toBe(1);
  });

  test("completion ME overlays the restored map mix once and survives save/load", () => {
    const p = battleProject([
      { op: "playBgm", id: "map", volume: 73, pitch: 110, pan: 12 },
      { op: "playBgs", id: "rain", volume: 61 },
    ]);
    const session = createSession(p, 60, {
      battle: audioBattleRules({
        audio: { bgm: { id: "combat" } },
        completionAudio: {
          cue: { id: "victory", volume: 82, pitch: 115, pan: -30, durationTicks: 2 },
        },
      }),
    });
    const entered = sessionStep(session, startSession(p, session), true);
    const completed = sessionStep(session, entered, true);
    expect(completed.scene).toBeNull();
    expect(completed.interp.audio).toEqual({
      bgm: { id: "map", volume: 73, pitch: 110, pan: 12, positionTicks: 0 },
      bgs: { id: "rain", volume: 61, pitch: 100, positionTicks: 0 },
      me: {
        id: "victory", volume: 82, pitch: 115, pan: -30, positionTicks: 0,
        durationTicks: 2, leftTicks: 2,
      },
    });
    const playing = sessionStep(session, completed);
    expect(playing.interp.audio?.bgm?.positionTicks).toBe(0);
    expect(playing.interp.audio?.bgs?.positionTicks).toBe(1);
    expect(playing.interp.audio?.me?.leftTicks).toBe(1);
    const restored = decodeEnvelopeText(encodeEnvelope(createSessionSnapshot(session, playing, 0)));
    expect(restored.interp.audio).toEqual(playing.interp.audio);
    const released = sessionStep(session, playing);
    expect(released.interp.audio?.me).toBeUndefined();
    expect(released.interp.audio?.bgm).toMatchObject({
      id: "map",
      positionTicks: 0,
      fade: {
        totalTicks: ME_REPLAY_FADE_TICKS,
        leftTicks: ME_REPLAY_FADE_TICKS,
        direction: "in",
      },
    });
    const after = sessionStep(session, released);
    expect(after.interp.audio?.me).toBeUndefined();
    expect(after.interp.audio?.bgm).toMatchObject({
      id: "map", positionTicks: 1,
      fade: { leftTicks: ME_REPLAY_FADE_TICKS - 1 },
    });
  });

  test("completion ME can discard every prior track and finish in silence", () => {
    const p = battleProject([
      { op: "playBgm", id: "map" },
      { op: "playBgs", id: "rain" },
    ]);
    const session = createSession(p, 60, {
      battle: audioBattleRules({
        audio: { bgm: { id: "combat" } },
        completionAudio: {
          restore: "none",
          cue: { id: "defeat", durationTicks: 1 },
        },
      }),
    });
    const entered = sessionStep(session, startSession(p, session), true);
    const completed = sessionStep(session, entered, true);
    expect(completed.interp.audio).toEqual({
      me: {
        id: "defeat", volume: 100, pitch: 100, positionTicks: 0,
        durationTicks: 1, leftTicks: 1,
      },
    });
    const silent = sessionStep(session, completed);
    expect(silent.interp.audio).toBeUndefined();
  });

  test("completion ME rewind refolds to the identical one-shot cursor", () => {
    const p = battleProject([{ op: "playBgm", id: "map" }]);
    const battle = audioBattleRules({
      audio: { bgm: { id: "combat" } },
      completionAudio: { cue: { id: "victory", durationTicks: 4 } },
    });
    const rewound = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 1 / 60,
      keyframeIntervalFrames: 1,
      battle,
    });
    rewound.startPlay();
    for (const mask of [0x2000, 0, 0x2000]) rewound.step(mask);
    expect(rewound.state.scene).toBeNull();
    expect(rewound.state.interp.audio?.me?.leftTicks).toBe(4);
    const completed = structuredClone(rewound.state);

    rewound.step(0);
    const forward = structuredClone(rewound.state);
    expect(forward.interp.audio?.me?.leftTicks).toBe(3);
    rewound.step(0x0100);
    expect(rewound.state).toEqual(completed);
    rewound.step(0);
    expect(rewound.state).toEqual(forward);
  });

  for (const hz of [60, 30, 20, 4] as const) {
    test(`immutable frozen battles preserve prior audio states at ${hz} Hz`, () => {
      const p = battleProject([{ op: "playBgm", id: "map", volume: 73 }]);
      const ownedSession = createSession(p, hz, {
        immutableState: true,
        battle: audioBattleRules({
          immutable: true,
          audio: { bgm: { id: "combat", volume: 88 } },
        }),
      });
      const owned = sessionStep(ownedSession, startSession(p, ownedSession), true);
      if (owned.scene?.kind !== "battle") throw new Error("expected an active battle scene");
      expect(owned.scene.returnAudio?.bgm?.id).toBe("map");
      expect(owned.interp.audio?.bgm?.id).toBe("combat");
      const suspended = owned.scene.returnAudio!;
      const ownedJson = JSON.stringify(owned);
      const playing = sessionStep(ownedSession, owned);
      expect(JSON.stringify(owned)).toBe(ownedJson);
      expect(playing.interp.audio?.bgm?.positionTicks)
        .toBe((owned.interp.audio?.bgm?.positionTicks ?? 0) + 60 / hz);
      const playingJson = JSON.stringify(playing);
      const restored = sessionStep(ownedSession, playing, true);
      expect(JSON.stringify(playing)).toBe(playingJson);
      expect(restored.scene).toBeNull();
      expect(restored.interp.audio).toEqual(suspended);
      expect(restored.interp.audio).not.toBe(suspended);

      const liveSession = createSession(p, hz, {
        immutableState: true,
        battle: audioBattleRules({ immutable: true }),
      });
      const live = sessionStep(liveSession, startSession(p, liveSession), true);
      expect(Object.hasOwn(live.scene!, "returnAudio")).toBe(false);
      expect(live.interp.audio?.bgm?.id).toBe("map");
      const liveJson = JSON.stringify(live);
      const advanced = sessionStep(liveSession, live);
      expect(JSON.stringify(live)).toBe(liveJson);
      expect(advanced.interp.audio?.bgm?.positionTicks)
        .toBe((live.interp.audio?.bgm?.positionTicks ?? 0) + 60 / hz);
      const advancedJson = JSON.stringify(advanced);
      const completed = sessionStep(liveSession, advanced, true);
      expect(JSON.stringify(advanced)).toBe(advancedJson);
      expect(completed.scene).toBeNull();
      expect(completed.interp.audio?.bgm?.positionTicks)
        .toBe((live.interp.audio?.bgm?.positionTicks ?? 0) + 2 * (60 / hz));
    });
  }

  test("battle silence restores map audio while omitted audio keeps it live", () => {
    const p = battleProject([{ op: "playBgm", id: "map" }]);
    const silentSession = createSession(p, 60, {
      battle: audioBattleRules({ audio: { bgm: null } }),
    });
    const silent = sessionStep(silentSession, startSession(p, silentSession), true);
    expect(silent.interp.audio).toBeUndefined();
    expect(battleReturnAudio(silent)?.bgm?.id).toBe("map");
    const restored = sessionStep(silentSession, silent, true);
    expect(restored.interp.audio?.bgm?.id).toBe("map");

    const legacySession = createSession(p, 60, { battle: audioBattleRules() });
    const legacy = sessionStep(legacySession, startSession(p, legacySession), true);
    expect(Object.hasOwn(legacy.scene!, "returnAudio")).toBe(false);
    const before = legacy.interp.audio!.bgm!.positionTicks;
    const advanced = sessionStep(legacySession, legacy);
    expect(advanced.interp.audio?.bgm?.positionTicks).toBe(before + 1);
  });

  test("instant completion restores audio in the start fold and survives its transfer", () => {
    const destination = testMap("destination");
    const p = battleProject([{ op: "playBgm", id: "map", volume: 64 }], [destination]);
    const session = createSession(p, 60, {
      battle: audioBattleRules({
        audio: { bgm: { id: "combat" } },
        instant: true,
        transfer: { map: "destination", x: 2, y: 2 },
      }),
    });
    const completed = sessionStep(session, startSession(p, session), true);
    expect(completed.scene).toBeNull();
    expect(completed.interp.audio?.bgm).toEqual({
      id: "map", volume: 64, pitch: 100, positionTicks: 0,
    });
    const transferred = sessionStep(session, completed);
    expect(transferred.mapId).toBe("destination");
    expect(transferred.interp.audio?.bgm?.id).toBe("map");
  });

  test("a declined battle does not claim or replace map audio", () => {
    const p = battleProject([{ op: "playBgm", id: "map" }]);
    const session = createSession(p, 60, {
      battle: audioBattleRules({
        audio: { bgm: { id: "unused" } },
        decline: true,
      }),
    });
    const state = sessionStep(session, startSession(p, session), true);
    expect(state.scene).toBeNull();
    expect(state.interp.audio?.bgm?.id).toBe("map");
  });

  test("battle start context reports the currently ridden vehicle", () => {
    const p = project([testMap("m", [{
      id: "battle",
      x: 0,
      y: 0,
      pages: [{ trigger: "autorun", commands: [{ op: "battle", setup: null }] }],
    }])]);
    p.vehicles = [{
      id: "skiff",
      kind: "boat",
      sprite: "base",
      start: { map: "m", x: 1, y: 1, dir: "up" },
    }];
    let seenVehicle: string | null | undefined;
    const rules: BattleRules = {
      start(_ext, _setup, _seed, context) {
        seenVehicle = context.vehicle;
        return null;
      },
      step: (state) => state,
      done: () => null,
    };
    const session = createSession(p, 60, { battle: rules, travel: travelRuntime });
    let state = startSession(p, session);
    state.travel!.vehicles!.riding = "skiff";
    for (let i = 0; i < 3 && seenVehicle === undefined; i++) {
      state = sessionStep(session, state);
    }
    expect(seenVehicle).toBe("skiff");
  });

  test("malformed game-owned battle tracks fail at the reducer boundary", () => {
    const p = battleProject([]);
    const invalidAudio = { bgm: { id: "combat", volume: 101 } } as unknown as BattleStart["audio"];
    const session = createSession(p, 60, {
      battle: audioBattleRules({ audio: invalidAudio }),
    });
    expect(() => sessionStep(session, startSession(p, session), true)).toThrow(
      "battle start audio.bgm.volume: integer 0..100 required",
    );

    const invalidPan = { bgm: { id: "combat", pan: 101 } } as unknown as BattleStart["audio"];
    const panSession = createSession(p, 60, {
      battle: audioBattleRules({ audio: invalidPan }),
    });
    expect(() => sessionStep(panSession, startSession(p, panSession), true)).toThrow(
      "battle start audio.bgm.pan: integer -100..100 required",
    );

    const cueSession = createSession(p, 60, {
      battle: audioBattleRules({
        completionAudio: { cue: { id: "broken", durationTicks: 0 } },
      }),
    });
    const entered = sessionStep(cueSession, startSession(p, cueSession), true);
    expect(() => sessionStep(cueSession, entered, true)).toThrow(
      "battle completion audio.cue.durationTicks: positive integer required",
    );

    const missingRuntime: BattleRules = {
      start: (ext) => ({ ext, state: false }),
      step: () => true,
      done: (done) => done
        ? { ext: null, result: "win", audio: { cue: { id: "victory", durationTicks: 1 } } }
        : null,
    };
    const missingSession = createSession(p, 60, { battle: missingRuntime });
    const missingEntered = sessionStep(missingSession, startSession(p, missingSession), true);
    expect(() => sessionStep(missingSession, missingEntered)).toThrow(
      "battle completion audio requires a battle effects runtime",
    );
  });
});
