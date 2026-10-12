import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import { mapForTileset } from "../src/engine/tiles.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import { isStandable } from "../src/engine/passability.ts";
import { rpgMakerTextRuntime } from "../src/engine/rpgmaker-text.ts";
import { loadSession, restoreSessionEnvelope, saveSession } from "../src/engine/save-restore.ts";
import { encodeEnvelope, encodeSaveCode } from "../src/engine/save.ts";
import {
  advanceScreenEffects,
  screenToneAt,
  startScreenTone,
  startWeather,
  weatherPowerAt,
  type ScreenEffectsState,
} from "../src/engine/screen.ts";
import {
  createSession,
  sessionPassageTable,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";
import { travelRuntime } from "../src/travel.ts";

const W = 8;
const H = 8;
const cell = (x: number, y: number): number => y * W + x;

function once(id: string, commands: Command[], x = 6, y = 6): GameEvent {
  return {
    id,
    x,
    y,
    pages: [
      {
        trigger: "autorun",
        commands: [{ op: "selfSwitch", key: "A", value: true }, ...commands],
      },
      { trigger: "action", commands: [], condition: { selfSwitch: "A" } },
    ],
  };
}

function stage(events: GameEvent[], extra: Partial<MapDef> = {}): MapDef {
  return {
    id: "stage",
    name: "stage",
    width: W,
    height: H,
    sheets: ["plain"],
    ground: Array(W * H).fill("plain.0"),
    ...extra,
    events,
  };
}

function project(commands: Command[], mapExtra: Partial<MapDef> = {}): Project {
  return {
    format: "rpgkit-project/v1",
    title: "KRM5 engine regressions",
    tileSize: 16,
    start: { map: "stage", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [stage([once("director", commands)], mapExtra)],
  };
}

function run(session: Session, state: SessionState, frames: number): SessionState {
  let next = state;
  for (let frame = 0; frame < frames; frame++) {
    next = stepSession(session, next, { buttons: 0 });
  }
  return next;
}

function runUntil(
  session: Session,
  state: SessionState,
  predicate: (candidate: SessionState) => boolean,
  limit = 120,
): SessionState {
  let next = state;
  for (let frame = 0; frame < limit && !predicate(next); frame++) {
    next = stepSession(session, next, { buttons: 0 });
  }
  expect(predicate(next)).toBe(true);
  return next;
}

describe("KRM5 screen tone", () => {
  test("interpolates signed RGB and gray without rounding, and waits on the fixed clock at 60/30/20 Hz", () => {
    let screen: ScreenEffectsState = {};
    startScreenTone(screen, { r: -31, g: 19, b: -11, gray: 41 }, 0);
    startScreenTone(screen, { r: -92, g: 82, b: 52, gray: 162 }, 4);

    screen = advanceScreenEffects(screen)!;
    expect(screenToneAt(screen.tone)).toEqual({ r: -46.25, g: 34.75, b: 4.75, gray: 71.25 });
    screen = advanceScreenEffects(screen)!;
    expect(screenToneAt(screen.tone)).toEqual({ r: -61.5, g: 50.5, b: 20.5, gray: 101.5 });

    const target = { r: -91, g: 61, b: -31, gray: 121 };
    const halfway: ReturnType<typeof screenToneAt>[] = [];
    for (const hz of [60, 30, 20] as const) {
      const source = project([
        { op: "screenTone", tone: target, duration: 1, wait: true },
        { op: "switch", id: "done", value: true },
      ]);
      const session = createSession(source, hz);
      let state = run(session, startSession(source, session), hz / 2);
      expect(state.interp.main?.mode).toBe("screenWait");
      expect(state.interp.screen?.tone).toMatchObject({ total: 60, left: 31 });
      halfway.push(screenToneAt(state.interp.screen?.tone));

      let elapsed = hz / 2;
      while (state.sw.switches.done !== true && elapsed < hz * 2) {
        state = stepSession(session, state, { buttons: 0 });
        elapsed++;
      }
      expect(elapsed).toBe(hz + 1);
      expect(state.interp.main).toBeNull();
      expect(screenToneAt(state.interp.screen?.tone)).toEqual(target);
    }

    expect(halfway[1]).toEqual(halfway[0]);
    expect(halfway[2]).toEqual(halfway[0]);
    expect(halfway[0]).toEqual({
      r: target.r * 29 / 60,
      g: target.g * 29 / 60,
      b: target.b * 29 / 60,
      gray: target.gray * 29 / 60,
    });
  });

  test("preserves an in-flight tone through save/load and L-trigger rewind", () => {
    const target = { r: -120, g: 72, b: 36, gray: 180 };
    const source = project([
      { op: "screenTone", tone: target, duration: 10, wait: true },
      { op: "wait", seconds: 20 },
    ]);
    const session = createSession(source, 30);
    const mid = run(session, startSession(source, session), 75);
    expect(mid.interp.screen?.tone?.left).toBeGreaterThan(0);

    const saved = saveSession(session, mid, 0);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.ok).toBe(true);
    const restored = restoreSessionEnvelope(createSession(source, 30), encodeEnvelope(saved.snapshot));
    const loaded = loadSession(createSession(source, 30), encodeSaveCode(saved.snapshot));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(restored.interp.screen?.tone).toEqual(mid.interp.screen?.tone);
    expect(loaded.state.interp.screen?.tone).toEqual(mid.interp.screen?.tone);
    expect(run(createSession(source, 30), restored, 10).interp.screen?.tone)
      .toEqual(run(session, mid, 10).interp.screen?.tone);

    const options = { hz: 60, idleFrames: 60_000, rewindSeconds: 3, attractEnabled: false } as const;
    const rewound = new AttractController(source, [], options);
    for (let frame = 0; frame < 240; frame++) rewound.step(0);
    rewound.step(BTN.LTRIGGER);
    const direct = new AttractController(source, [], options);
    for (let frame = 0; frame < 60; frame++) direct.step(0);
    expect(rewound.state).toEqual(direct.state);
    expect(rewound.state.interp.screen?.tone?.left).toBeGreaterThan(500);
  });
});

describe("KRM5 weather", () => {
  test("uses exact power interpolation, preserves the emitter clock and seed, and prunes a fade to none", () => {
    let screen: ScreenEffectsState = {};
    startWeather(screen, "storm", 99, 4, 0x1234abcd);
    expect(screen.weather).toEqual({
      kind: "storm",
      fromPower: 0,
      targetPower: 9,
      total: 4,
      left: 4,
      seed: 0x1234abcd,
      clock: 0,
    });

    screen = advanceScreenEffects(screen)!;
    expect(weatherPowerAt(screen.weather)).toBe(2.25);
    expect(screen.weather).toMatchObject({ left: 3, clock: 1 });
    screen = advanceScreenEffects(screen)!;
    expect(weatherPowerAt(screen.weather)).toBe(4.5);
    screen = advanceScreenEffects(screen)!;
    screen = advanceScreenEffects(screen)!;
    expect(screen.weather).toMatchObject({
      kind: "storm",
      fromPower: 9,
      targetPower: 9,
      total: 0,
      left: 0,
      seed: 0x1234abcd,
      clock: 4,
    });

    startWeather(screen, "none", 8, 4, 0xffffffff);
    expect(screen.weather).toMatchObject({
      kind: "storm",
      fromPower: 9,
      targetPower: 0,
      seed: 0x1234abcd,
      clock: 4,
    });
    screen = advanceScreenEffects(screen)!;
    screen = advanceScreenEffects(screen)!;
    expect(weatherPowerAt(screen.weather)).toBe(4.5);
    expect(screen.weather).toMatchObject({ clock: 6, left: 2 });
    screen = advanceScreenEffects(screen)!;
    expect(advanceScreenEffects(screen)).toBeUndefined();
  });

  test("is identical at 60/30/20 Hz and retains seed/clock through save, load, and keyframe replay", () => {
    const source = project([
      { op: "weather", kind: "rain", power: 7, duration: 1, wait: true },
      { op: "switch", id: "done", value: true },
    ]);
    const states = new Map<number, { session: Session; state: SessionState }>();
    const descriptors: unknown[] = [];
    // The first interpreter fold advances frame 0 to frame 1 before the
    // command derives its seed from (frame + 1).
    const expectedSeed = (0x12345678 ^ Math.imul(2, 0x9e3779b9)) >>> 0;

    for (const hz of [60, 30, 20] as const) {
      const session = createSession(source, hz);
      const state = run(session, startSession(source, session), hz / 2);
      expect(state.interp.main?.mode).toBe("screenWait");
      expect(state.interp.screen?.weather).toEqual({
        kind: "rain",
        fromPower: 0,
        targetPower: 7,
        total: 60,
        left: 31,
        seed: expectedSeed,
        clock: 29,
      });
      expect(weatherPowerAt(state.interp.screen?.weather)).toBe(7 * 29 / 60);
      descriptors.push(state.interp.screen?.weather);
      states.set(hz, { session, state });
    }
    expect(descriptors[1]).toEqual(descriptors[0]);
    expect(descriptors[2]).toEqual(descriptors[0]);

    const mid = states.get(30)!;
    const saved = saveSession(mid.session, mid.state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const restored = restoreSessionEnvelope(createSession(source, 30), encodeEnvelope(saved.snapshot));
    const loaded = loadSession(createSession(source, 30), encodeSaveCode(saved.snapshot));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(restored.interp.screen?.weather).toEqual(mid.state.interp.screen?.weather);
    expect(loaded.state.interp.screen?.weather).toEqual(mid.state.interp.screen?.weather);

    const keyframeBefore = structuredClone(mid.state);
    const uninterrupted = run(mid.session, mid.state, 5);
    const replayed = run(createSession(source, 30), restored, 5);
    expect(mid.state).toEqual(keyframeBefore);
    expect(replayed.interp.screen?.weather).toEqual(uninterrupted.interp.screen?.weather);
    expect(replayed.interp.main).toEqual(uninterrupted.interp.main);
  });
});

describe("KRM5 formation and window state", () => {
  test("gates swaps, reconciles follower order, and saves the sparse access and party state", () => {
    const source = project([
      { op: "formationSwap", first: 0, second: 2 },
      { op: "formationAccess", enabled: false },
      { op: "formationSwap", first: 0, second: 1 },
      { op: "formationAccess", enabled: true },
      { op: "formationSwap", first: 1, second: 2 },
      { op: "formationAccess", enabled: false },
    ]);
    source.system = { rpgMakerText: { party: [1, 2, 3], currencyUnit: "G" } };
    source.actors = [
      { id: "actor001", databaseId: 1, name: "One" },
      { id: "actor002", databaseId: 2, name: "Two" },
      { id: "actor003", databaseId: 3, name: "Three" },
    ];
    source.followers = {
      enabled: true,
      members: [
        { id: "actor001", sprite: "one" },
        { id: "actor002", sprite: "two" },
        { id: "actor003", sprite: "three" },
      ],
    };

    expect(createSwitchState({ formationAccess: true }).formationAccess).toBeUndefined();
    const session = createSession(source, 60, {
      rpgMakerText: rpgMakerTextRuntime,
      travel: travelRuntime,
    });
    const state = run(session, startSession(source, session), 3);
    // The swap attempted while disabled is ignored. Re-enabling permits the
    // following swap; the final disable is stored sparsely as false.
    expect(state.sw.partyOrder).toEqual([3, 1, 2]);
    expect(state.sw.formationAccess).toBe(false);
    expect(state.travel?.followers?.members.map((member) => member.id)).toEqual([
      "actor003",
      "actor001",
      "actor002",
    ]);

    const saved = saveSession(session, state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const restored = restoreSessionEnvelope(createSession(source, 60, {
      rpgMakerText: rpgMakerTextRuntime,
      travel: travelRuntime,
    }), encodeEnvelope(saved.snapshot));
    expect(restored.sw.partyOrder).toEqual([3, 1, 2]);
    expect(restored.sw.formationAccess).toBe(false);
    expect(restored.travel?.followers?.members.map((member) => member.id)).toEqual([
      "actor003",
      "actor001",
      "actor002",
    ]);
  });

  test("round-trips a signed window tone through a save code and prunes the neutral tone", () => {
    const tone = { r: -68, g: 34, b: -17, gray: 99 };
    const source = project([{ op: "windowTone", tone }]);
    const session = createSession(source);
    const state = run(session, startSession(source, session), 2);
    expect(state.sw.windowTone).toEqual(tone);

    const saved = saveSession(session, state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const loaded = loadSession(createSession(source), encodeSaveCode(saved.snapshot));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.state.sw.windowTone).toEqual(tone);

    const neutral = project([
      { op: "windowTone", tone },
      { op: "windowTone", tone: { r: 0, g: 0, b: 0, gray: 0 } },
    ]);
    const neutralSession = createSession(neutral);
    const neutralState = run(neutralSession, startSession(neutral, neutralSession), 2);
    expect(neutralState.sw.windowTone).toBeUndefined();
  });
});

describe("KRM5 tileset variants", () => {
  test("partial variants inherit every omitted visual and movement plane", () => {
    const source = stage([], {
      upper: [[1, "plain.0"]],
      passage: [[2, "block"]],
      vehiclePassage: { boat: [3], ship: [4], airshipLand: [5] },
      terrain: [[6, 9]],
      tilesetVariants: {
        alternate: { ground: Array(W * H).fill("plain.0") },
      },
    });
    const resolved = mapForTileset(source, "alternate")!;
    expect(resolved.upper).toBe(source.upper);
    expect(resolved.passage).toBe(source.passage);
    expect(resolved.vehiclePassage).toBe(source.vehiclePassage);
    expect(resolved.terrain).toBe(source.terrain);

    const runtime = project([
      { op: "changeTileset", id: "alternate" },
      { op: "locationInfo", variable: "terrain", x: 6, y: 0, kind: "terrain" },
    ], {
      terrain: [[6, 9]],
      tilesetVariants: {
        alternate: { ground: Array(W * H).fill("plain.0") },
      },
    });
    const session = createSession(runtime);
    const state = run(session, startSession(runtime, session), 2);
    expect(state.sw.variables.terrain).toBe(9);
  });

  test("changes terrain and collision in the command fold, switches back, and resets on transfer", () => {
    const target = cell(2, 1);
    const source = project([
      { op: "changeTileset", id: "night" },
      { op: "locationInfo", variable: "nightTerrain", x: 2, y: 1, kind: "terrain" },
      { op: "wait", seconds: 0.05 },
      { op: "changeTileset", id: "day" },
      { op: "locationInfo", variable: "dayTerrain", x: 2, y: 1, kind: "terrain" },
      { op: "wait", seconds: 0.05 },
      { op: "changeTileset", id: "night" },
      { op: "transfer", map: "next", x: 1, y: 1, dir: "down", fade: 0 },
    ], {
      tileset: "day",
      terrain: [[target, 2]],
      tilesetVariants: {
        night: {
          ground: Array(W * H).fill("plain.0"),
          passage: [[target, "block"]],
          terrain: [[target, 7]],
        },
      },
    });
    source.maps.push({
      id: "next",
      name: "next",
      width: W,
      height: H,
      tileset: "next-day",
      sheets: ["plain"],
      ground: Array(W * H).fill("plain.0"),
      events: [],
    });

    const session = createSession(source, 60);
    let state = stepSession(session, startSession(source, session), { buttons: 0 });
    expect(state.interp.tileset).toBe("night");
    expect(state.sw.variables.nightTerrain).toBe(7);
    expect(isStandable(sessionPassageTable(session, state), 2, 1)).toBe(false);

    state = runUntil(session, state, (candidate) => candidate.sw.variables.dayTerrain !== undefined);
    expect(state.interp.tileset).toBeUndefined();
    expect(state.sw.variables.dayTerrain).toBe(2);
    expect(isStandable(sessionPassageTable(session, state), 2, 1)).toBe(true);

    state = runUntil(session, state, (candidate) => candidate.mapId === "next");
    expect(state.mapId).toBe("next");
    expect(state.interp.tileset).toBeUndefined();
  });

  test("restores a tile standable only in the active variant and rejects unknown or blocked variants", () => {
    const player = cell(1, 1);
    const source = project([{ op: "changeTileset", id: "open" }], {
      tileset: "closed",
      passage: [[player, "block"]],
      tilesetVariants: {
        open: {
          ground: Array(W * H).fill("plain.0"),
          passage: [],
        },
      },
    });
    const session = createSession(source);
    const state = run(session, startSession(source, session), 2);
    expect(state.interp.tileset).toBe("open");
    expect(isStandable(sessionPassageTable(session, state), 1, 1)).toBe(true);

    const saved = saveSession(session, state, 0);
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.message);
    const restored = restoreSessionEnvelope(createSession(source), encodeEnvelope(saved.snapshot));
    expect(restored.interp.tileset).toBe("open");
    expect([restored.move.tx, restored.move.ty]).toEqual([1, 1]);

    const unknown = structuredClone(saved.snapshot);
    unknown.interp.tileset = "missing";
    const unknownResult = loadSession(createSession(source), unknown);
    expect(unknownResult).toMatchObject({ ok: false, error: { code: "shape" } });
    if (!unknownResult.ok) expect(unknownResult.error.message).toContain('has no tileset "missing"');

    const blocked = structuredClone(saved.snapshot);
    delete blocked.interp.tileset;
    const blockedResult = loadSession(createSession(source), blocked);
    expect(blockedResult).toMatchObject({ ok: false, error: { code: "shape" } });
    if (!blockedResult.ok) expect(blockedResult.error.message).toContain("player tile (1,1) is not standable");
  });
});
