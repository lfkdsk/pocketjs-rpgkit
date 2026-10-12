import { describe, expect, test } from "bun:test";
import { buildGame } from "../examples/sunstone/game-data.ts";
import { DEMO_TAPE_RUNS } from "../examples/sunstone/demo-tape.ts";
import {
  ATTRACT_KEYFRAME_INTERVAL_FRAMES,
  AttractController,
  type AttractKeyframeEntry,
  type AttractOptions,
} from "../src/engine/attract.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { rpgMakerTextRuntime } from "../src/engine/rpgmaker-text.ts";
import { canonicalJson } from "../src/engine/save.ts";
import type { SceneRules } from "../src/engine/scene.ts";
import { releaseSessionMapsExcept } from "../src/engine/session.ts";
import { expandTapeRuns } from "../src/engine/tape.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Command, GameEvent, JsonValue, MapDef, MapRepository, Project } from "../src/engine/types.ts";

const BTN_SELECT = 0x0001;
const BTN_UP = 0x0010;
const BTN_RIGHT = 0x0020;
const BTN_DOWN = 0x0040;
const BTN_LEFT = 0x0080;
const BTN_LTRIGGER = 0x0100;
const BTN_CIRCLE = 0x2000;
const BTN_CROSS = 0x4000;

function map(id: string, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: 8,
    height: 8,
    sheets: ["plain"],
    ground: new Array(64).fill("plain.0"),
    events,
  };
}

function emptyProject(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "keyframe fixture",
    tileSize: 16,
    start: { map: "a", x: 3, y: 3, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map("a")],
  };
}

function randomTape(frames: number): number[] {
  const masks = [0, BTN_UP, BTN_RIGHT, BTN_DOWN, BTN_LEFT, BTN_CIRCLE, BTN_CROSS];
  const tape: number[] = [];
  let seed = 0x6d2b79f5;
  for (let frame = 0; frame < frames; frame++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    tape.push(masks[(seed >>> 0) % masks.length]!);
  }
  return tape;
}

function create(
  project: Project,
  tape: readonly number[],
  hz: number,
  options: Partial<AttractOptions> = {},
): AttractController {
  return new AttractController(project, tape, {
    hz,
    tapeHz: 60,
    idleFrames: 60_000,
    endHoldFrames: 60_000,
    rewindSeconds: 0.5,
    ...options,
  });
}

/** Everything observable after a transport step, encoded canonically so the
 * keyframed path is compared byte-for-byte with a from-zero refold. */
function observable(controller: AttractController): string {
  return canonicalJson({
    state: controller.state,
    status: controller.status(),
    modal: controller.presentedModal(),
    foldedMask: controller.foldedMask(),
    length: controller.length,
    inputLog: controller.inputLog,
  });
}

function expectEquivalent(
  keyed: AttractController,
  fromZero: AttractController,
  label: string,
): void {
  expect(observable(keyed), label).toBe(observable(fromZero));
}

function stepPair(
  keyed: AttractController,
  fromZero: AttractController,
  mask: number,
): void {
  keyed.step(mask);
  fromZero.step(mask);
}

/** Timeline lengths a zero-input run reaches, one per host step, plus the
 *  keyframes captured along the way. A rewind trigger must land on a reached
 *  length exactly: low-rate hosts fold several source frames per step, so a
 *  target length is only available at the rates the probe observed. */
function probeRun(
  project: Project,
  tape: readonly number[],
  hz: number,
  options: Partial<AttractOptions>,
): { lengths: number[]; entries: AttractKeyframeEntry[] } {
  const probe = create(project, tape, hz, options);
  probe.startAttract();
  const lengths = [0];
  while (probe.status().demoFrame < tape.length && lengths.length < 100_000) {
    probe.step(0);
    lengths.push(probe.length);
  }
  return { lengths, entries: probe.keyframeStats().entries };
}

/** Rewind both controllers so the target sits at `timelineFrame + delta` of
 *  a retained keyframe. The trigger is the earliest length the probe reached
 *  past `atLeast`, still before the tape end: it must be far enough past the
 *  keyframe that the held mask and display cursor have since changed, yet
 *  early enough that demoFrame has not reached the tape (its end-of-restore
 *  clamp would otherwise mask a wrong tape cursor). An empty-suffix rewind
 *  must not keep any pre-rewind residue. */
function rewindPairTo(
  project: Project,
  tape: readonly number[],
  hz: number,
  options: Partial<AttractOptions>,
  target: number,
  lengths: readonly number[],
  label: string,
  atLeast = 0,
): { keyed: AttractController; fromZero: AttractController } {
  const floor = Math.max(target + 1, atLeast);
  const reachable = lengths.filter((length) => length >= floor && length < tape.length);
  expect(reachable.length, `${label} reachable trigger`).toBeGreaterThan(0);
  const trigger = reachable[0]!;
  const pairOptions = { ...options, rewindSeconds: (trigger - target) / 60 };
  const keyed = create(project, tape, hz, pairOptions);
  const fromZero = create(project, tape, hz, { ...pairOptions, keyframeMaxBytes: 0 });
  keyed.startAttract();
  fromZero.startAttract();
  while (keyed.length < trigger) stepPair(keyed, fromZero, 0);
  expect(keyed.length, `${label} exact trigger`).toBe(trigger);
  stepPair(keyed, fromZero, BTN_LTRIGGER);
  return { keyed, fromZero };
}

const TIMED_SCENE_ID = "test.timed-scene";
const FROZEN_TICKS = 12;

const timedSceneRules: SceneRules = {
  start: (ext) => ({ ext, state: { left: FROZEN_TICKS } }),
  step: (state, _input, ticks) => ({
    left: Math.max(0, (state as { left: number }).left - ticks),
  }),
  done: (state) => (state as { left: number }).left === 0 ? {} : null,
};

const timedBattleRules: BattleRules = {
  start: (ext) => ({ ext, state: { left: FROZEN_TICKS } }),
  step: (state, _input, ticks) => ({
    left: Math.max(0, (state as { left: number }).left - ticks),
  }),
  done: (state) => (state as { left: number }).left === 0
    ? { ext: null, result: "win" }
    : null,
};

function frozenEffectProject(effect: Command, opener: Command): Project {
  const effectEvent: GameEvent = {
    id: "effect",
    x: 0,
    y: 0,
    pages: [
      {
        trigger: "autorun",
        commands: [effect, { op: "switch", id: "effect.done", value: true }],
      },
      { condition: { switch: "effect.done" }, trigger: "action", commands: [] },
    ],
  };
  const openerEvent: GameEvent = {
    id: "opener",
    x: 0,
    y: 0,
    pages: [
      {
        trigger: "parallel",
        commands: [opener, { op: "switch", id: "scene.done", value: true }],
      },
      { condition: { switch: "scene.done" }, trigger: "action", commands: [] },
    ],
  };
  return { ...emptyProject(), maps: [map("a", [effectEvent, openerEvent])] };
}

function screenTimelineControllers(
  project: Project,
  options: Partial<AttractOptions>,
): { live: AttractController; keyed: AttractController; fromZero: AttractController } {
  const tape = new Array<number>(120).fill(0);
  const common = {
    immutableState: true,
    keyframeIntervalFrames: 100_000,
    rewindSeconds: 6 / 60,
    ...options,
  } satisfies Partial<AttractOptions>;
  const live = create(project, tape, 60, common);
  const keyed = create(project, tape, 60, common);
  const fromZero = create(project, tape, 60, { ...common, keyframeMaxBytes: 0 });
  for (const controller of [live, keyed, fromZero]) controller.startAttract();
  return { live, keyed, fromZero };
}

function stepScreenTimelines(
  controllers: ReturnType<typeof screenTimelineControllers>,
  mask = 0,
): void {
  controllers.live.step(mask);
  controllers.keyed.step(mask);
  controllers.fromZero.step(mask);
}

function enterScreenScene(controllers: ReturnType<typeof screenTimelineControllers>): void {
  for (let frame = 0; frame < 10 && controllers.live.state.scene === null; frame++) {
    stepScreenTimelines(controllers);
  }
  expect(controllers.live.state.scene).not.toBeNull();
  expectEquivalent(controllers.keyed, controllers.fromZero, "scene entry");
}

function rewindAndReplayFrozenSuffix(
  controllers: ReturnType<typeof screenTimelineControllers>,
  expected: string,
  label: string,
): void {
  stepPair(controllers.keyed, controllers.fromZero, BTN_LTRIGGER);
  expect(controllers.keyed.state.scene, `${label} rewind target`).not.toBeNull();
  expectEquivalent(controllers.keyed, controllers.fromZero, `${label} rewind`);
  expect(controllers.keyed.keyframeStats().lastRefoldStart, `${label} used scene boundary`)
    .toBeGreaterThan(0);
  for (let frame = 0; frame < 6; frame++) stepPair(controllers.keyed, controllers.fromZero, 0);
  expectEquivalent(controllers.keyed, controllers.fromZero, `${label} replay`);
  expect(canonicalJson(controllers.keyed.state as unknown as JsonValue), `${label} live replay`)
    .toBe(expected);
}

describe("frozen-scene screen keyframes", () => {
  test("ordinary scenes freeze native effects, preserve rewind bytes and compensate their waits", () => {
    const project = frozenEffectProject(
      {
        op: "screenTint",
        layer: "slow",
        color: { r: 20, g: 40, b: 80, a: 160 },
        duration: 0.1,
        wait: true,
      },
      { op: "scene", id: TIMED_SCENE_ID },
    );
    const controllers = screenTimelineControllers(project, {
      scenes: { [TIMED_SCENE_ID]: timedSceneRules },
    });
    enterScreenScene(controllers);
    expect(controllers.live.state.scene?.kind).toBe("scene");
    const opened = controllers.live.state.interp.screen?.tints?.slow?.left;
    const waitSince = controllers.live.state.interp.main?.since;
    expect(opened).toBe(6);

    for (let frame = 0; frame < 8; frame++) stepScreenTimelines(controllers);
    expect(controllers.live.state.scene).not.toBeNull();
    expect(controllers.live.state.interp.screen?.tints?.slow?.left).toBe(opened);
    const liveMidScene = canonicalJson(controllers.live.state as unknown as JsonValue);
    rewindAndReplayFrozenSuffix(controllers, liveMidScene, "ordinary scene");

    while (controllers.live.state.scene !== null) stepScreenTimelines(controllers);
    expect(controllers.live.state.interp.main?.mode).toBe("screenWait");
    expect(controllers.live.state.interp.main?.since).toBeGreaterThan(waitSince!);
    stepScreenTimelines(controllers);
    expect(controllers.live.state.sw.switches["effect.done"]).toBeUndefined();
    for (let frame = 0; frame < 10; frame++) stepScreenTimelines(controllers);
    expect(controllers.live.state.sw.switches["effect.done"]).toBe(true);
    expect(canonicalJson(controllers.keyed.state as unknown as JsonValue))
      .toBe(canonicalJson(controllers.live.state as unknown as JsonValue));
    expectEquivalent(controllers.keyed, controllers.fromZero, "ordinary scene settled");
  });

  test("declared RPG Maker battles advance Game_Screen, preserve rewind bytes and keep live waits", () => {
    const project = frozenEffectProject(
      { op: "screenFade", direction: "out", duration: 0.1, wait: true },
      { op: "battle", setup: null },
    );
    project.system = { rpgMakerText: { party: [], currencyUnit: "G" } };
    const controllers = screenTimelineControllers(project, {
      battle: timedBattleRules,
      rpgMakerText: rpgMakerTextRuntime,
    });
    enterScreenScene(controllers);
    expect(controllers.live.state.scene?.kind).toBe("battle");
    const waitSince = controllers.live.state.interp.main?.since;
    expect(controllers.live.state.interp.screen?.fade?.left).toBe(6);

    for (let frame = 0; frame < 8; frame++) stepScreenTimelines(controllers);
    expect(controllers.live.state.scene).not.toBeNull();
    expect(controllers.live.state.interp.screen?.fade?.left).toBe(0);
    const liveMidScene = canonicalJson(controllers.live.state as unknown as JsonValue);
    rewindAndReplayFrozenSuffix(controllers, liveMidScene, "RPG Maker battle");

    while (controllers.live.state.scene !== null) stepScreenTimelines(controllers);
    expect(controllers.live.state.interp.main?.mode).toBe("screenWait");
    expect(controllers.live.state.interp.main?.since).toBe(waitSince);
    stepScreenTimelines(controllers);
    expect(controllers.live.state.sw.switches["effect.done"]).toBe(true);
    expect(canonicalJson(controllers.keyed.state as unknown as JsonValue))
      .toBe(canonicalJson(controllers.live.state as unknown as JsonValue));
    expectEquivalent(controllers.keyed, controllers.fromZero, "RPG Maker battle settled");
  });
});

describe("KR2 rewind keyframes", () => {
  test("default and configured periodic captures use source frames, independent of host hz", () => {
    expect(ATTRACT_KEYFRAME_INTERVAL_FRAMES).toBe(3_600);
    const tape = new Array<number>(400).fill(0);
    const captures = ([60, 30, 20, 4] as const).map((hz) => {
      const controller = create(emptyProject(), tape, hz, {
        keyframeIntervalFrames: 37,
      });
      controller.startAttract();
      while (controller.status().demoFrame < 333) controller.step(0);
      return controller.keyframeStats().entries.map((entry) => ({
        sourceFrame: entry.sourceFrame,
        timelineFrame: entry.timelineFrame,
        interval: entry.interval,
      }));
    });
    for (const entries of captures) {
      expect(entries).toEqual(captures[0]);
      expect(entries.map((entry) => entry.sourceFrame)).toEqual([
        37, 74, 111, 148, 185, 222, 259, 296, 333,
      ]);
      expect(entries.every((entry) => entry.interval)).toBe(true);
    }
  });

  test("random tape matches from-zero refolds at many targets at 60/30/20/4 Hz", () => {
    const tape = randomTape(6_000);
    for (const hz of [60, 30, 20, 4] as const) {
      const keyed = create(emptyProject(), tape, hz, { keyframeIntervalFrames: 97 });
      const fromZero = create(emptyProject(), tape, hz, { keyframeMaxBytes: 0 });
      keyed.startAttract();
      fromZero.startAttract();

      for (const trigger of [503, 811, 1_237, 1_901, 2_777, 3_419, 4_503, 5_201]) {
        while (keyed.length < trigger) stepPair(keyed, fromZero, 0);
        stepPair(keyed, fromZero, BTN_LTRIGGER);
        expectEquivalent(keyed, fromZero, `random target ${trigger} @${hz} Hz`);
        expect(keyed.keyframeStats().lastRefoldFrames, `bounded suffix @${hz} Hz`)
          .toBeLessThan(97);
        expect(fromZero.keyframeStats().lastRefoldStart).toBe(0);
        stepPair(keyed, fromZero, 0); // release L before the next transport edge
      }
    }
  });

  test("real paced tape restores canonical display and controller state at every host rate", () => {
    const tape = expandTapeRuns(DEMO_TAPE_RUNS);
    const project = buildGame().project;
    for (const hz of [60, 30, 20, 4] as const) {
      const keyed = create(project, tape, hz, {
        keyframeIntervalFrames: 29,
        rewindSeconds: 1,
      });
      const fromZero = create(project, tape, hz, {
        keyframeMaxBytes: 0,
        rewindSeconds: 1,
      });
      keyed.startAttract();
      fromZero.startAttract();

      for (const sourceTarget of [90, 180, 300, 430, 530]) {
        while (keyed.status().demoFrame < sourceTarget) stepPair(keyed, fromZero, 0);
        stepPair(keyed, fromZero, BTN_LTRIGGER);
        expectEquivalent(keyed, fromZero, `paced target ${sourceTarget} @${hz} Hz`);
        expect(keyed.keyframeStats().lastRefoldFrames).toBeLessThan(29);
        stepPair(keyed, fromZero, 0);
      }
    }
  });

  test("takeover, continued play, rewind, resume and a second rewind stay equivalent", () => {
    const tape = randomTape(2_000);
    const keyed = create(emptyProject(), tape, 60, { keyframeIntervalFrames: 23 });
    const fromZero = create(emptyProject(), tape, 60, { keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    while (keyed.length < 240) stepPair(keyed, fromZero, 0);

    stepPair(keyed, fromZero, BTN_RIGHT); // takeover still folds the tape
    for (let frame = 0; frame < 140; frame++) {
      const mask = frame % 19 < 8 ? BTN_UP : frame % 19 < 12 ? 0 : BTN_LEFT;
      stepPair(keyed, fromZero, mask);
    }
    stepPair(keyed, fromZero, BTN_LTRIGGER);
    expectEquivalent(keyed, fromZero, "first post-takeover rewind");

    stepPair(keyed, fromZero, 0);
    for (let frame = 0; frame < 80; frame++) stepPair(keyed, fromZero, frame % 9 < 4 ? BTN_DOWN : 0);
    stepPair(keyed, fromZero, BTN_LTRIGGER);
    expectEquivalent(keyed, fromZero, "second post-takeover rewind");

    stepPair(keyed, fromZero, 0);
    stepPair(keyed, fromZero, BTN_SELECT);
    expectEquivalent(keyed, fromZero, "select after repeated rewind");
  });

  test("map transfers and battle entry/exit create boundary keyframes used by rewind", () => {
    const transfer: GameEvent = {
      id: "transfer",
      x: 0,
      y: 0,
      pages: [{
        trigger: "autorun",
        commands: [{ op: "transfer", map: "b", x: 3, y: 3, dir: "down" }],
      }],
    };
    const battle: GameEvent = {
      id: "battle",
      x: 0,
      y: 0,
      pages: [
        {
          trigger: "autorun",
          commands: [
            { op: "battle", setup: null, onWin: [{ op: "switch", id: "won", value: true }] },
            { op: "switch", id: "done", value: true },
          ],
        },
        { condition: { switch: "done" }, trigger: "action", commands: [] },
      ],
    };
    const project: Project = {
      ...emptyProject(),
      title: "keyframe boundaries",
      maps: [map("a", [transfer]), map("b", [battle])],
    };
    const battleRules: BattleRules = {
      start: (ext) => ({ ext, state: { left: 2 } }),
      step: (state, _input, ticks) => ({
        left: Math.max(0, (state as { left: number }).left - ticks),
      }),
      done: (state) => (state as { left: number }).left === 0
        ? { ext: null, result: "win" }
        : null,
    };
    const signatures: string[] = [];
    for (const hz of [60, 30, 20, 4] as const) {
      const options = {
        battle: battleRules,
        keyframeIntervalFrames: 1_000,
        rewindSeconds: 4 / 60,
      } satisfies Partial<AttractOptions>;
      const keyed = create(project, new Array<number>(50).fill(0), hz, options);
      const fromZero = create(project, new Array<number>(50).fill(0), hz, {
        ...options,
        keyframeMaxBytes: 0,
      });
      keyed.startAttract();
      fromZero.startAttract();
      while (keyed.length < 12) stepPair(keyed, fromZero, 0);

      const boundaries = keyed.keyframeStats().entries;
      expect(boundaries.some((entry) => entry.mapBoundary)).toBe(true);
      expect(boundaries.filter((entry) => entry.sceneBoundary)).toHaveLength(2);
      expect(boundaries.every((entry) => !entry.interval)).toBe(true);
      signatures.push(canonicalJson(boundaries.map((entry) => ({
        sourceFrame: entry.sourceFrame,
        mapBoundary: entry.mapBoundary,
        sceneBoundary: entry.sceneBoundary,
      }))));

      stepPair(keyed, fromZero, BTN_LTRIGGER);
      expectEquivalent(keyed, fromZero, `rewind across map/battle history @${hz} Hz`);
      expect(keyed.keyframeStats().lastRefoldStart).toBeGreaterThan(0);
    }
    expect(new Set(signatures).size).toBe(1);
  });

  test("the byte cap evicts oldest snapshots and an older target falls back to frame zero", () => {
    const project = emptyProject();
    const tape = new Array<number>(100).fill(0);
    const probe = create(project, tape, 60, { keyframeIntervalFrames: 2 });
    probe.startAttract();
    probe.step(0);
    probe.step(0);
    const oneKeyframeBytes = probe.keyframeStats().estimatedBytes;
    expect(oneKeyframeBytes).toBeGreaterThan(0);

    const capped = create(project, tape, 60, {
      keyframeIntervalFrames: 2,
      keyframeMaxBytes: oneKeyframeBytes + 1_024,
      rewindSeconds: 10 / 60,
    });
    const fromZero = create(project, tape, 60, {
      keyframeMaxBytes: 0,
      rewindSeconds: 10 / 60,
    });
    capped.startAttract();
    fromZero.startAttract();
    for (let frame = 0; frame < 20; frame++) stepPair(capped, fromZero, 0);
    const before = capped.keyframeStats();
    expect(before.estimatedBytes).toBeLessThanOrEqual(before.maxBytes);
    expect(before.evicted).toBeGreaterThan(0);
    expect(before.entries[0]!.timelineFrame).toBeGreaterThan(10);

    stepPair(capped, fromZero, BTN_LTRIGGER); // target 10 predates retained snapshots
    expectEquivalent(capped, fromZero, "evicted-prefix fallback");
    expect(capped.keyframeStats().lastRefoldStart).toBe(0);
    expect(capped.keyframeEstimatedBytes).toBeLessThanOrEqual(before.maxBytes);
    expect(capped.rewindHistoryEstimatedBytes).toBe(
      capped.historyAllocatedBytes + capped.keyframeEstimatedBytes,
    );
  });

  test("invalid budgets fail early and zero budget is an explicit reference mode", () => {
    const project = emptyProject();
    expect(() => create(project, [0], 60, { keyframeIntervalFrames: -1 })).toThrow(/non-negative/);
    expect(() => create(project, [0], 60, { keyframeMaxBytes: 1.5 })).toThrow(/non-negative/);
    const disabled = create(project, new Array<number>(20).fill(0), 60, {
      keyframeIntervalFrames: 1,
      keyframeMaxBytes: 0,
    });
    disabled.startAttract();
    for (let frame = 0; frame < 20; frame++) disabled.step(0);
    expect(disabled.keyframeStats()).toMatchObject({ count: 0, estimatedBytes: 0, maxBytes: 0 });
  });

  test("a rewind whose target is exactly a keyframe (empty suffix) restores the held mask", () => {
    // The review's repro, formalized: masks UP for 10 frames then DOWN, a
    // keyframe every 10 source frames, and a rewind distance that lands the
    // target exactly on the keyframe at timelineFrame 10. The suffix loop in
    // restoreTimeline() never runs, so the held mask must come from the
    // keyframe payload: BTN_UP, not the BTN_DOWN held at the trigger. The
    // trigger stops mid-tape (frame 30 of 40) so a wrong tape cursor is not
    // masked by the end-of-restore clamp to tape length.
    const tape = [
      ...new Array<number>(10).fill(BTN_UP),
      ...new Array<number>(30).fill(BTN_DOWN),
    ];
    for (const hz of [60, 30, 20, 4] as const) {
      const keyed = create(emptyProject(), tape, hz, {
        keyframeIntervalFrames: 10,
        rewindSeconds: 20 / 60,
      });
      const fromZero = create(emptyProject(), tape, hz, {
        keyframeMaxBytes: 0,
        rewindSeconds: 20 / 60,
      });
      keyed.startAttract();
      fromZero.startAttract();
      while (keyed.length < 30) stepPair(keyed, fromZero, 0);
      expect(keyed.length).toBe(30);
      stepPair(keyed, fromZero, BTN_LTRIGGER);
      const stats = keyed.keyframeStats();
      expect(stats.lastRefoldFrames, `empty suffix @${hz} Hz`).toBe(0);
      expect(stats.lastRefoldStart, `keyframe start @${hz} Hz`).toBe(10);
      expect(keyed.foldedMask(), `held mask from keyframe @${hz} Hz`).toBe(BTN_UP);
      expect(keyed.status().demoFrame, `tape cursor from keyframe @${hz} Hz`).toBe(10);
      expectEquivalent(keyed, fromZero, `empty-suffix held mask @${hz} Hz`);
    }
  });

  test("rewind targets on, before and after a periodic keyframe match from-zero refolds at every host rate", () => {
    // A long autorun dialog keeps the presentation mid-typing for hundreds of
    // source frames, so periodic keyframes are captured with stage 1 and a
    // positive displayTicks. cps 15 matches the attract overlay's 15 cps, so
    // the reducer typewriter and the overlay finish together and the source
    // stays one fold per timeline tick. The tape holds UP then DOWN, so the
    // held mask at the trigger differs from the mask the keyframe saved.
    // Landing the rewind target exactly on the keyframe (delta 0) exercises
    // the payload-only restore of held mask, display cursor and tape cursor;
    // delta -1 truncates that keyframe and refolds from the previous one;
    // delta +1 folds exactly one suffix entry.
    const dialog: GameEvent = {
      id: "dialog",
      x: 3,
      y: 3,
      pages: [{
        trigger: "autorun",
        commands: [{ op: "text", lines: ["x".repeat(120)], cps: 15 }],
      }],
    };
    const project: Project = {
      ...emptyProject(),
      title: "periodic keyframe boundaries",
      maps: [map("a", [dialog])],
    };
    const tape = [
      ...new Array<number>(300).fill(BTN_UP),
      ...new Array<number>(400).fill(BTN_DOWN),
    ];
    const options = { keyframeIntervalFrames: 120 } satisfies Partial<AttractOptions>;
    const signatures: string[] = [];
    for (const hz of [60, 30, 20, 4] as const) {
      const { lengths, entries } = probeRun(project, tape, hz, options);
      signatures.push(canonicalJson(entries.map((entry) => ({
        sourceFrame: entry.sourceFrame,
        timelineFrame: entry.timelineFrame,
        interval: entry.interval,
      }))));
      for (const sourceFrame of [120, 240]) {
        const keyframe = entries.find((entry) => entry.sourceFrame === sourceFrame);
        expect(keyframe, `keyframe at source ${sourceFrame} @${hz} Hz`).toBeDefined();
        const boundary = keyframe!.timelineFrame;
        for (const delta of [-1, 0, 1] as const) {
          const label = `periodic src=${sourceFrame} delta=${delta} @${hz} Hz`;
          const { keyed, fromZero } = rewindPairTo(
            project, tape, hz, options, boundary + delta, lengths, label, 400,
          );
          expectEquivalent(keyed, fromZero, label);
          const stats = keyed.keyframeStats();
          if (delta === 0) {
            expect(stats.lastRefoldFrames, `${label} empty suffix`).toBe(0);
            expect(stats.lastRefoldStart, `${label} keyframe start`).toBe(boundary);
            expect(keyed.foldedMask(), `${label} held mask`).toBe(BTN_UP);
            const modal = keyed.presentedModal();
            expect(modal?.kind, `${label} still typing`).toBe("text");
            const revealed = (modal as { revealed: number }).revealed;
            expect(revealed, `${label} mid-text`).toBeGreaterThan(0);
            expect(revealed, `${label} mid-text`).toBeLessThan(120);
            expect(
              (fromZero.presentedModal() as { revealed: number }).revealed,
              `${label} display cursor`,
            ).toBe(revealed);
          } else if (delta === 1) {
            expect(stats.lastRefoldStart, `${label} suffix start`).toBe(boundary);
          } else {
            expect(stats.lastRefoldStart, `${label} truncated to earlier keyframe`).toBeLessThan(boundary);
          }
        }
      }
    }
    expect(new Set(signatures).size).toBe(1);
  });

  test("rewind targets on, before and after map and battle boundary keyframes match from-zero refolds", () => {
    const transfer: GameEvent = {
      id: "transfer",
      x: 0,
      y: 0,
      pages: [{
        trigger: "autorun",
        commands: [{ op: "transfer", map: "b", x: 3, y: 3, dir: "down" }],
      }],
    };
    const battle: GameEvent = {
      id: "battle",
      x: 0,
      y: 0,
      pages: [
        {
          trigger: "autorun",
          commands: [
            { op: "battle", setup: null, onWin: [{ op: "switch", id: "won", value: true }] },
            { op: "switch", id: "done", value: true },
          ],
        },
        { condition: { switch: "done" }, trigger: "action", commands: [] },
      ],
    };
    const project: Project = {
      ...emptyProject(),
      title: "boundary keyframe targets",
      maps: [map("a", [transfer]), map("b", [battle])],
    };
    const battleRules: BattleRules = {
      start: (ext) => ({ ext, state: { left: 2 } }),
      step: (state, _input, ticks) => ({
        left: Math.max(0, (state as { left: number }).left - ticks),
      }),
      done: (state) => (state as { left: number }).left === 0
        ? { ext: null, result: "win" }
        : null,
    };
    // Zeros while the boundaries happen, then a held direction: the held mask
    // at the trigger differs from the masks saved with the boundary keyframes.
    const tape = [
      ...new Array<number>(20).fill(0),
      ...new Array<number>(30).fill(BTN_UP),
    ];
    const options = {
      battle: battleRules,
      keyframeIntervalFrames: 1_000,
    } satisfies Partial<AttractOptions>;
    const signatures: string[] = [];
    for (const hz of [60, 30, 20, 4] as const) {
      const { lengths, entries } = probeRun(project, tape, hz, options);
      expect(entries.some((entry) => entry.mapBoundary)).toBe(true);
      expect(entries.filter((entry) => entry.sceneBoundary)).toHaveLength(2);
      signatures.push(canonicalJson(entries.map((entry) => ({
        sourceFrame: entry.sourceFrame,
        timelineFrame: entry.timelineFrame,
        mapBoundary: entry.mapBoundary,
        sceneBoundary: entry.sceneBoundary,
      }))));
      for (const [index, keyframe] of entries.entries()) {
        const boundary = keyframe.timelineFrame;
        for (const delta of [-1, 0, 1] as const) {
          const label = `boundary ${index} delta=${delta} @${hz} Hz`;
          const { keyed, fromZero } = rewindPairTo(
            project, tape, hz, options, boundary + delta, lengths, label, 30,
          );
          expectEquivalent(keyed, fromZero, label);
          if (delta === 0) {
            const stats = keyed.keyframeStats();
            expect(stats.lastRefoldFrames, `${label} empty suffix`).toBe(0);
            expect(stats.lastRefoldStart, `${label} keyframe start`).toBe(boundary);
          }
        }
      }
    }
    expect(new Set(signatures).size).toBe(1);
  });
});

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key], seen);
}

interface KeyframeInternals {
  keyframes: { state: object; timelineFrame: number }[];
}

describe("shared immutable keyframes", () => {
  test("keyframes keep the published state itself and rewind matches copying refolds at every host rate", () => {
    const tape = expandTapeRuns(DEMO_TAPE_RUNS);
    const project = buildGame().project;
    for (const hz of [60, 30, 20, 4] as const) {
      const shared = create(project, tape, hz, {
        immutableState: true,
        keyframeIntervalFrames: 29,
        rewindSeconds: 1,
      });
      const copying = create(project, tape, hz, { keyframeIntervalFrames: 29, rewindSeconds: 1 });
      const fromZero = create(project, tape, hz, { keyframeMaxBytes: 0, rewindSeconds: 1 });
      expect(shared.keyframeStats().shared).toBe(true);
      expect(copying.keyframeStats().shared).toBe(false);
      for (const controller of [shared, copying, fromZero]) controller.startAttract();
      const internals = shared as unknown as KeyframeInternals;
      const seen = new Set<object>();
      const snapshots = new Map<object, string>();
      let identical = 0;

      for (const sourceTarget of [90, 180, 300, 430, 530]) {
        while (shared.status().demoFrame < sourceTarget) {
          const before = internals.keyframes;
          for (const controller of [shared, copying, fromZero]) controller.step(0);
          if (internals.keyframes !== before) {
            const latest = internals.keyframes[internals.keyframes.length - 1]!;
            if (!seen.has(latest.state)) {
              // A keyframe taken on this host frame's last fold is the state
              // the controller just published, not a copy of it.
              const published = shared.state as unknown as { frame: number };
              if ((latest.state as { frame: number }).frame === published.frame) {
                expect(latest.state).toBe(shared.state);
                identical++;
              }
              seen.add(latest.state);
              snapshots.set(latest.state, canonicalJson(latest.state as JsonValue));
              // Any later write into a retained keyframe now throws.
              deepFreeze(latest.state);
            }
          }
        }
        for (const controller of [shared, copying, fromZero]) controller.step(BTN_LTRIGGER);
        expectEquivalent(shared, fromZero, `shared rewind ${sourceTarget} @${hz} Hz`);
        expectEquivalent(copying, fromZero, `copying rewind ${sourceTarget} @${hz} Hz`);
        for (const controller of [shared, copying, fromZero]) controller.step(0);
      }
      expect(seen.size).toBeGreaterThan(3);
      expect(identical).toBeGreaterThan(0);
      for (const [state, json] of snapshots) expect(canonicalJson(state as JsonValue)).toBe(json);
    }
  });

  test("consecutive shared keyframes share unchanged subtrees", () => {
    const tape = expandTapeRuns(DEMO_TAPE_RUNS);
    const controller = create(buildGame().project, tape, 60, {
      immutableState: true,
      keyframeIntervalFrames: 31,
    });
    controller.startAttract();
    while (controller.status().demoFrame < 400) controller.step(0);
    const keyframes = (controller as unknown as KeyframeInternals).keyframes;
    expect(keyframes.length).toBeGreaterThan(3);
    let sharedFields = 0;
    for (let i = 1; i < keyframes.length; i++) {
      const previous = keyframes[i - 1]!.state as Record<string, unknown>;
      const current = keyframes[i]!.state as Record<string, unknown>;
      expect(current).not.toBe(previous);
      // Each fold rebuilds the path to what it changed; the subtrees it did
      // not touch (switch tables, interpreter records) stay the same objects.
      for (const key of Object.keys(current)) {
        const value = current[key];
        const before = previous[key];
        if (value === null || typeof value !== "object" || before === null || typeof before !== "object") continue;
        for (const inner of Object.keys(value)) {
          const child = (value as Record<string, unknown>)[inner];
          if (child !== null && typeof child === "object" && child === (before as Record<string, unknown>)[inner]) {
            sharedFields++;
          }
        }
      }
    }
    expect(sharedFields).toBeGreaterThan(keyframes.length);
  });

  test("the count cap evicts oldest keyframes and zero disables them", () => {
    const project = emptyProject();
    const tape = randomTape(600);
    const capped = create(project, tape, 60, {
      immutableState: true,
      keyframeIntervalFrames: 10,
      keyframeMaxCount: 3,
      rewindSeconds: 15 / 60,
    });
    const fromZero = create(project, tape, 60, { keyframeMaxBytes: 0, rewindSeconds: 15 / 60 });
    capped.startAttract();
    fromZero.startAttract();
    while (capped.length < 200) stepPair(capped, fromZero, 0);
    const stats = capped.keyframeStats();
    expect(stats.maxCount).toBe(3);
    expect(stats.count).toBe(3);
    expect(stats.entries.map((entry) => entry.sourceFrame)).toEqual([180, 190, 200]);
    expect(stats.evicted).toBe(17);
    stepPair(capped, fromZero, BTN_LTRIGGER); // target 185 refolds from keyframe 180
    expectEquivalent(capped, fromZero, "count-capped rewind");
    expect(capped.keyframeStats().lastRefoldStart).toBe(180);
    stepPair(capped, fromZero, 0);

    const disabled = create(project, tape, 60, { keyframeIntervalFrames: 1, keyframeMaxCount: 0 });
    disabled.startAttract();
    for (let frame = 0; frame < 20; frame++) disabled.step(0);
    expect(disabled.keyframeStats()).toMatchObject({ count: 0, estimatedBytes: 0, maxCount: 0 });
    expect(() => create(project, [0], 60, { keyframeMaxCount: -1 })).toThrow(/non-negative/);
  });
});

describe("rollback checkpoint does not retain evicted keyframes", () => {
  interface CheckpointInternals {
    checkpoint: {
      state: object;
      keyframes: { state: object; timelineFrame: number }[];
    } | null;
    keyframes: { state: object; timelineFrame: number }[];
  }

  /** A controller whose session repository exposes prepare(), which is what
   *  switches AttractController.step onto the checkpoint/rollback path. */
  function repositoryController(immutableState: boolean): AttractController {
    const split = splitProjectMaps(emptyProject());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
      prepare: async () => {},
    });
    for (const entry of split.shell.mapIndex) repository.acquire(entry.id);
    return new AttractController(split.shell, [0, 0, 0, 0], {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 1 / 60,
      maps: repository,
      immutableState,
      keyframeIntervalFrames: 1,
      keyframeMaxCount: 1,
    });
  }

  for (const immutableState of [true, false]) {
    const mode = immutableState ? "immutable" : "mutable";
    test(`a successful fold resyncs the checkpoint's heavy references (${mode} mode)`, () => {
      const controller = repositoryController(immutableState);
      controller.startAttract();
      const internals = controller as unknown as CheckpointInternals;
      expect(internals.checkpoint).toBeNull(); // lazy: no checkpoint before the first step

      controller.step(0); // source frame 1: captures keyframe 1
      const cp1 = internals.checkpoint!;
      expect(cp1).not.toBeNull();
      expect(cp1.keyframes).toBe(internals.keyframes);
      expect(cp1.state).toBe(controller.state);
      const firstKeyframe = internals.keyframes[0]!;
      expect(internals.keyframes.length).toBe(1);

      controller.step(0); // source frame 2: captures keyframe 2, evicts keyframe 1
      const cp2 = internals.checkpoint!;
      expect(cp2).toBe(cp1); // the checkpoint record is reused, not reallocated
      // The checkpoint names the live keyframe generation and the live
      // state, not the evicted array/state a stale rollback snapshot would
      // keep alive (the review's STALE_CHECKPOINT_REFERENCE probe).
      expect(internals.keyframes.length).toBe(1);
      expect(internals.keyframes[0]).not.toBe(firstKeyframe);
      expect(cp2.keyframes).toBe(internals.keyframes);
      expect(cp2.keyframes[0]).toBe(internals.keyframes[0]);
      expect(cp2.state).toBe(controller.state);
      // Reported accounting matches what is actually reachable.
      const stats = controller.keyframeStats();
      expect(stats.count).toBe(1);
      expect(stats.evicted).toBe(1);
    });
  }

  test("a failed step still rolls back from the checkpoint", () => {
    // The success-path resync must not weaken rollback: force a repository
    // miss during a rewind and confirm the controller restores the pre-step
    // state, keyframes and timeline.
    const split = splitProjectMaps(emptyProject());
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const base = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
      prepare: async () => {},
    });
    let failAcquire = false;
    const repository: MapRepository = {
      meta: (id) => base.meta(id),
      acquire: (id) => {
        if (failAcquire) throw new Error("forced repository miss");
        return base.acquire(id);
      },
      releaseExcept: (ids) => base.releaseExcept(ids),
      prepare: base.prepare,
    };
    for (const entry of split.shell.mapIndex) repository.acquire(entry.id);
    const controller = new AttractController(split.shell, [0, 0, 0, 0], {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 1 / 60,
      maps: repository,
      keyframeIntervalFrames: 1,
      keyframeMaxCount: 64,
    });
    controller.startAttract();
    for (let frame = 0; frame < 4; frame++) controller.step(0);
    const before = canonicalJson(controller.state as unknown as JsonValue);
    const beforeStats = controller.keyframeStats();
    // Evict the resident map so the rewind's keyframe acquire misses the
    // session cache and reaches the (now failing) repository.
    releaseSessionMapsExcept(controller.getSession(), []);
    failAcquire = true;
    expect(() => controller.step(BTN_LTRIGGER)).toThrow("forced repository miss");
    failAcquire = false;
    expect(canonicalJson(controller.state as unknown as JsonValue)).toBe(before);
    expect(controller.keyframeStats()).toMatchObject({
      count: beforeStats.count,
      evicted: beforeStats.evicted,
    });
    expect(controller.status().rewound).toBe(false);
  });
});

describe("keyframe size estimate", () => {
  test("charges the UTF-8 length of non-ASCII and astral text", () => {
    const estimate = (id: string) => {
      const project: Project = {
        ...emptyProject(),
        start: { map: id, x: 3, y: 3, dir: "down" },
        maps: [map(id)],
      };
      const controller = create(project, new Array<number>(4).fill(0), 60, { keyframeIntervalFrames: 2 });
      controller.startAttract();
      controller.step(0);
      controller.step(0);
      const stats = controller.keyframeStats();
      expect(stats.count).toBe(1);
      return { bytes: stats.estimatedBytes, json: JSON.stringify(controller.state) };
    };
    // Same UTF-16 length: "é" is 2 UTF-8 bytes, "😀" is a surrogate pair of 4.
    const ascii = estimate("cafe-xx");
    for (const id of ["café-xx", "cafe-😀"]) {
      const wide = estimate(id);
      expect(wide.json.length).toBe(ascii.json.length);
      const extra = Buffer.byteLength(wide.json) - Buffer.byteLength(ascii.json);
      expect(extra).toBeGreaterThan(0);
      expect(wide.bytes - ascii.bytes).toBe(extra);
    }
  });
});
