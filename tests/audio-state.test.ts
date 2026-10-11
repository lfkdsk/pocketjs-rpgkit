import { describe, expect, test } from "bun:test";
import { ME_REPLAY_FADE_TICKS, audioTrackVolume, type AudioState } from "../src/engine/audio.ts";
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
import type { BattleRules, BattleStart, BattleTransfer } from "../src/engine/battle.ts";
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
} = {}): BattleRules {
  return {
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
        ? { ext: null, result: "win", ...(options.transfer ? { transfer: options.transfer } : {}) }
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
      battle: audioBattleRules({ audio: { bgm: { id: "combat", volume: 88, pitch: 105 } } }),
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
      bgm: { id: "combat", volume: 88, pitch: 105, positionTicks: 0 },
    });

    const played = sessionStep(session, entered);
    expect(played.interp.audio?.bgm?.positionTicks).toBe(1);
    const completed = sessionStep(session, played, true);
    expect(completed.scene).toBeNull();
    expect(completed.interp.audio).toEqual(suspended);
    expect(completed.interp.audio).not.toBe(battleReturnAudio(played));
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

  test("malformed game-owned battle tracks fail at the reducer boundary", () => {
    const p = battleProject([]);
    const invalidAudio = { bgm: { id: "combat", volume: 101 } } as unknown as BattleStart["audio"];
    const session = createSession(p, 60, {
      battle: audioBattleRules({ audio: invalidAudio }),
    });
    expect(() => sessionStep(session, startSession(p, session), true)).toThrow(
      "battle start audio.bgm.volume: integer 0..100 required",
    );
  });
});
