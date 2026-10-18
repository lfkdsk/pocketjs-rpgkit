import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import {
  animFrameIndex,
  compileAnim,
  createInterpState,
  createWorld,
  stepInterp,
  type InterpInput,
  type MapAnimInstance,
} from "../src/engine/interpreter.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { AnimationDef, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const TIMED: AnimationDef = {
  id: "burst",
  sheet: "burst.png",
  count: 4,
  frameDuration: 4 / 60,
  timings: [
    { frame: 0, se: { id: "start", volume: 80, pitch: 110, pan: -30 } },
    {
      frame: 2,
      se: { id: "middle" },
      flash: { color: { r: 255, g: 224, b: 160, a: 255 }, intensity: 144, duration: 8 / 60 },
    },
  ],
};

function fixture(wait = false, loop = false): { map: MapDef; project: Project; event: GameEvent } {
  const event: GameEvent = {
    id: "fx",
    x: 2,
    y: 3,
    pages: [{
      trigger: "action",
      commands: [
        { op: "mapAnim", id: "burst-instance", anim: "burst", target: "player", loop, wait },
        { op: "switch", id: "continued", value: true },
      ],
    }],
  };
  const map: MapDef = {
    id: "map",
    name: "Map",
    width: 5,
    height: 5,
    sheets: ["tiles"],
    ground: new Array(25).fill("tiles.0"),
    events: [event],
  };
  return {
    map,
    event,
    project: {
      format: "rpgkit-project/v1",
      title: "Timed animation",
      tileSize: 16,
      start: { map: "map", x: 2, y: 2, dir: "down" },
      sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
      items: [],
      animations: [TIMED],
      maps: [map],
    },
  };
}

const input = (confirmEdge = false): InterpInput => ({
  confirmEdge,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  playerCell: { x: 2, y: 2 },
  prevCell: { x: 2, y: 2 },
  facing: 0,
});

describe("KRM3V animation timing", () => {
  test("schema accepts sound/full-screen-flash timings", () => {
    expect(validateSchema(schema, fixture().project)).toEqual([]);
  });

  test("map compilation emits only screen-scoped flashes", () => {
    const scoped: AnimationDef = {
      ...TIMED,
      timings: [
        {
          frame: 0,
          flash: {
            scope: "target",
            color: { r: 255, g: 224, b: 160, a: 255 },
            intensity: 144,
            duration: 5 / 60,
          },
        },
        { frame: 1, hide: { duration: 2 / 60 } },
        {
          frame: 2,
          flash: {
            scope: "screen",
            color: { r: 160, g: 208, b: 255, a: 255 },
            intensity: 120,
            duration: 3 / 60,
          },
        },
      ],
    };
    const timings = compileAnim(scoped, 60).timings!;

    expect(timings[0]).toEqual({ tick: 0 });
    expect(timings[1]).toEqual({ tick: 4 });
    expect(timings[2]).toMatchObject({ tick: 8, flash: { intensity: 120, frames: 3 } });
  });

  test("cumulative quantization preserves short MV animation duration at every supported hz", () => {
    const totals = [60, 30, 20, 4].map((hz) => compileAnim(TIMED, hz).total);
    expect(totals).toEqual([16, 8, 5, 1]);
    const at4 = compileAnim(TIMED, 4);
    const instance: MapAnimInstance = {
      id: "fx", anim: "burst", start: 0, x: 0, y: 0, target: null, layer: "above", loop: false,
    };
    expect(animFrameIndex(at4, instance, 0)).toBe(0);
    expect(animFrameIndex(at4, instance, 1)).toBe(-1);
  });

  test("non-waited playback emits frame-zero and future cues on saved ticks", () => {
    const { map } = fixture(false);
    const world = createWorld(map, [], 60, { animations: [TIMED] });
    let state = stepInterp(world, createInterpState(), input(true));
    expect(state.cues).toEqual([{ name: "start", volume: 80, pitch: 110, pan: -30 }]);
    expect(state.sw.switches.continued).toBe(true);
    const start = state.anims![0]!.start;
    while (state.frame - start < 7) state = stepInterp(world, state, input());
    expect(state.cues).toEqual([]);
    state = stepInterp(world, state, input());
    expect(state.frame - start).toBe(8);
    expect(state.cues).toEqual([{ name: "middle", volume: 100, pitch: 100 }]);
    expect(state.screen?.flash).toMatchObject({
      from: { r: 255, g: 224, b: 160, a: 144 },
      to: { r: 255, g: 224, b: 160, a: 0 },
      total: 8,
      left: 8,
    });
  });

  test("wait parks only the caller through one playthrough", () => {
    const { map } = fixture(true);
    const world = createWorld(map, [], 60, { animations: [TIMED] });
    let state = stepInterp(world, createInterpState(), input(true));
    expect(state.sw.switches.continued).toBeUndefined();
    const start = state.anims![0]!.start;
    while (state.frame - start < 15) state = stepInterp(world, state, input());
    expect(state.sw.switches.continued).toBeUndefined();
    state = stepInterp(world, state, input());
    expect(state.frame - start).toBe(16);
    expect(state.sw.switches.continued).toBe(true);
  });

  test("looping timelines repeat frame-zero cues without duplicating intervening ticks", () => {
    const { map } = fixture(false, true);
    const world = createWorld(map, [], 60, { animations: [TIMED] });
    let state = stepInterp(world, createInterpState(), input(true));
    const start = state.anims![0]!.start;
    const heard: { elapsed: number; name: string }[] = state.cues.flatMap((cue) => ("name" in cue ? [{ elapsed: 0, name: cue.name }] : []));
    for (let i = 0; i < 16; i++) {
      state = stepInterp(world, state, input());
      for (const cue of state.cues) if ("name" in cue) heard.push({ elapsed: state.frame - start, name: cue.name });
    }
    expect(heard).toEqual([
      { elapsed: 0, name: "start" },
      { elapsed: 8, name: "middle" },
      { elapsed: 16, name: "start" },
    ]);
  });
});
