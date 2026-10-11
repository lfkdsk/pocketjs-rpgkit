import { describe, expect, test } from "bun:test";
import type { AudioState } from "../src/engine/audio.ts";
import { createInterpState } from "../src/engine/interpreter.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { createSnapshot, type SaveSnapshot } from "../src/engine/save.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";

const VALID_AUDIO: AudioState = {
  bgm: {
    id: "field-theme",
    volume: 0,
    pitch: 50,
    pan: -100,
    positionTicks: 120,
    paused: true,
    fade: { totalTicks: 60, leftTicks: 30, direction: "in" },
  },
  bgs: {
    id: "rain",
    volume: 100,
    pitch: 150,
    pan: 100,
    positionTicks: 8,
  },
  me: {
    id: "victory",
    volume: 62,
    pitch: 99,
    positionTicks: 4,
    durationTicks: 90,
    leftTicks: 86,
  },
  savedBgm: {
    id: "field-theme",
    volume: 75,
    pitch: 100,
    positionTicks: 90,
  },
  walkingBgm: {
    id: "walking-theme",
    volume: 65,
    pitch: 105,
    positionTicks: 45,
  },
};

function baseSnapshot(): SaveSnapshot {
  return createSnapshot(
    "map",
    initialMovement(1, 2, 0, { tile: 16, speed: 2 }),
    createInterpState(),
    0,
  );
}

function audioSnapshot(): SaveSnapshot {
  const snapshot = baseSnapshot();
  snapshot.interp.audio = structuredClone(VALID_AUDIO);
  return snapshot;
}

function snapshotWithProgram(program: unknown[]): SaveSnapshot {
  const snapshot = baseSnapshot();
  snapshot.interp.parallels["map/audio"] = {
    key: "map/audio",
    pageIndex: 0,
    parallel: true,
    stack: [{ prog: program, pc: 0 }],
    mode: "run",
    since: 0,
    erase: false,
  } as never;
  return snapshot;
}

describe("audio save validation", () => {
  test("accepts omitted and complete sparse audio state", () => {
    expect(validateSnapshot(baseSnapshot())).toBeNull();
    expect(validateSnapshot(audioSnapshot())).toBeNull();
    const empty = baseSnapshot();
    empty.interp.audio = {};
    expect(validateSnapshot(empty)).toBeNull();
    const silentWalking = baseSnapshot();
    silentWalking.interp.audio = { walkingBgm: null };
    expect(validateSnapshot(silentWalking)).toBeNull();
  });

  test("rejects malformed tracks, fades, ME counters, and saved BGM", () => {
    const cases: Array<[string, (snapshot: any) => void, string]> = [
      ["audio container", (s) => { s.interp.audio = []; }, "state.interp.audio"],
      ["unknown audio field", (s) => { s.interp.audio.extra = true; }, "audio.extra"],
      ["track container", (s) => { s.interp.audio.bgm = null; }, "audio.bgm"],
      ["empty id", (s) => { s.interp.audio.bgm.id = ""; }, "audio.bgm.id"],
      ["low volume", (s) => { s.interp.audio.bgm.volume = -0.1; }, "audio.bgm.volume"],
      ["high volume", (s) => { s.interp.audio.bgs.volume = 100.1; }, "audio.bgs.volume"],
      ["fractional volume", (s) => { s.interp.audio.me.volume = 62.5; }, "audio.me.volume"],
      ["low pitch", (s) => { s.interp.audio.bgm.pitch = 49.9; }, "audio.bgm.pitch"],
      ["high pitch", (s) => { s.interp.audio.bgs.pitch = 150.1; }, "audio.bgs.pitch"],
      ["fractional pitch", (s) => { s.interp.audio.me.pitch = 99.5; }, "audio.me.pitch"],
      ["low pan", (s) => { s.interp.audio.bgm.pan = -101; }, "audio.bgm.pan"],
      ["high pan", (s) => { s.interp.audio.bgs.pan = 101; }, "audio.bgs.pan"],
      ["fractional pan", (s) => { s.interp.audio.me.pan = 0.5; }, "audio.me.pan"],
      ["fractional position", (s) => { s.interp.audio.bgm.positionTicks = 1.5; }, "positionTicks"],
      ["false paused marker", (s) => { s.interp.audio.bgm.paused = false; }, "paused"],
      ["fade container", (s) => { s.interp.audio.bgm.fade = []; }, "fade"],
      ["zero fade duration", (s) => { s.interp.audio.bgm.fade.totalTicks = 0; }, "totalTicks"],
      ["zero fade remainder", (s) => { s.interp.audio.bgm.fade.leftTicks = 0; }, "leftTicks"],
      ["oversized fade remainder", (s) => { s.interp.audio.bgm.fade.leftTicks = 61; }, "leftTicks"],
      ["invalid fade direction", (s) => { s.interp.audio.bgm.fade.direction = "sideways"; }, "direction"],
      ["zero ME duration", (s) => { s.interp.audio.me.durationTicks = 0; }, "durationTicks"],
      ["zero ME remainder", (s) => { s.interp.audio.me.leftTicks = 0; }, "leftTicks"],
      ["oversized ME remainder", (s) => { s.interp.audio.me.leftTicks = 91; }, "leftTicks"],
      ["saved BGM paused", (s) => { s.interp.audio.savedBgm.paused = true; }, "savedBgm.paused"],
      ["saved BGM fade", (s) => {
        s.interp.audio.savedBgm.fade = { totalTicks: 1, leftTicks: 1 };
      }, "savedBgm.fade"],
      ["walking BGM paused", (s) => { s.interp.audio.walkingBgm.paused = true; }, "walkingBgm.paused"],
      ["walking BGM position", (s) => { s.interp.audio.walkingBgm.positionTicks = -1; }, "walkingBgm.positionTicks"],
    ];

    for (const [label, mutate, expectedPath] of cases) {
      const snapshot: any = audioSnapshot();
      mutate(snapshot);
      expect(validateSnapshot(snapshot), label).toContain(expectedPath);
    }
  });

  test("accepts every compiled audio instruction and bgmPlaying condition", () => {
    const program = [
      { op: "playBgm", id: "theme", volume: 0, pitch: 50, pan: -100 },
      { op: "fadeoutBgm", frames: 0 },
      { op: "stopBgm" },
      { op: "pauseBgm" },
      { op: "resumeBgm" },
      { op: "playBgs", id: "rain", volume: 100, pitch: 150, pan: 100 },
      { op: "fadeoutBgs", frames: 30 },
      { op: "playMe", id: "victory", durationFrames: 1, volume: 50, pitch: 100, pan: -25 },
      { op: "stopMe" },
      { op: "playSe", id: "click", volume: 80, pitch: 100, pan: 25 },
      { op: "saveBgm" },
      { op: "replayBgm" },
      { op: "setVehicleBgm", id: "boat", bgm: { id: "boat-theme", volume: 70, pitch: 110 } },
      { op: "if", cond: { kind: "bgmPlaying", id: "theme", negate: true }, onFalse: 14 },
      { op: "exit" },
    ];
    expect(validateSnapshot(snapshotWithProgram(program))).toBeNull();
  });

  test("rejects malformed compiled audio instructions and conditions", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["empty id", { op: "playBgm", id: "", volume: 100, pitch: 100 }, ".id"],
      ["volume", { op: "playBgs", id: "rain", volume: 101, pitch: 100 }, ".volume"],
      ["fractional volume", { op: "playBgs", id: "rain", volume: 50.5, pitch: 100 }, ".volume"],
      ["pitch", { op: "playSe", id: "click", volume: 100, pitch: 49 }, ".pitch"],
      ["fractional pitch", { op: "playSe", id: "click", volume: 100, pitch: 99.5 }, ".pitch"],
      ["low pan", { op: "playBgm", id: "theme", volume: 100, pitch: 100, pan: -101 }, ".pan"],
      ["high pan", { op: "playBgs", id: "rain", volume: 100, pitch: 100, pan: 101 }, ".pan"],
      ["fractional pan", { op: "playSe", id: "click", volume: 100, pitch: 100, pan: 0.5 }, ".pan"],
      ["fade frames", { op: "fadeoutBgm", frames: 1.5 }, ".frames"],
      ["ME duration", {
        op: "playMe", id: "victory", durationFrames: -1, volume: 100, pitch: 100,
      }, ".durationFrames"],
      ["condition id", {
        op: "if", cond: { kind: "bgmPlaying", id: 1 }, onFalse: 1,
      }, ".cond.id"],
      ["empty condition id", {
        op: "if", cond: { kind: "bgmPlaying", id: "" }, onFalse: 1,
      }, ".cond.id"],
      ["condition negate", {
        op: "if", cond: { kind: "bgmPlaying", negate: "no" }, onFalse: 1,
      }, ".cond.negate"],
      ["vehicle BGM id", { op: "setVehicleBgm", id: "boat", bgm: { id: "" } }, ".bgm.id"],
      ["vehicle BGM volume", { op: "setVehicleBgm", id: "boat", bgm: { id: "boat", volume: 101 } }, ".bgm.volume"],
      ["vehicle BGM pitch", { op: "setVehicleBgm", id: "boat", bgm: { id: "boat", pitch: 49 } }, ".bgm.pitch"],
    ];

    for (const [label, instruction, expectedPath] of cases) {
      expect(validateSnapshot(snapshotWithProgram([instruction])), label).toContain(expectedPath);
    }
  });

  test("audio state does not relax the drained-cue save invariant", () => {
    const snapshot = audioSnapshot();
    snapshot.interp.cues.push({ name: "click", volume: 80, pitch: 100 });
    expect(validateSnapshot(snapshot)).toBe("state.interp.cues: cues must drain before save");
  });
});
