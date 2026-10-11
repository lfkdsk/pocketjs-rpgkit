import { describe, expect, test } from "bun:test";
import { createInterpState } from "../src/engine/interpreter.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { createSnapshot, type SaveSnapshot } from "../src/engine/save.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import type { AirshipPhase, TravelState } from "../src/engine/travel.ts";

const CFG = { tile: 16, speed: 2 } as const;

function snapshot(
  phase: AirshipPhase,
  tick: number,
  altitude: number,
  riding: string | null = "airship",
): SaveSnapshot {
  const out = createSnapshot("map", initialMovement(1, 2, 0, CFG), createInterpState(), 0);
  out.travel = {
    vehicles: {
      entries: [{
        id: "airship",
        kind: "airship",
        sprite: "airship",
        mapId: "map",
        move: initialMovement(1, 2, 0, CFG),
      }],
      boarding: null,
      riding,
      airshipAltitude: altitude,
      airshipPhase: phase,
      airshipPhaseTick: tick,
    },
  } satisfies TravelState;
  return out;
}

describe("travel save validation", () => {
  test("accepts sparse, silent and omitted vehicle BGM and rejects malformed values", () => {
    const valid: any = snapshot("grounded", 0, 0, null);
    valid.travel.vehicles.entries[0].bgm = { id: "airship", volume: 0, pitch: 150, pan: -100 };
    expect(validateSnapshot(valid)).toBeNull();
    valid.travel.vehicles.entries[0].bgm = null;
    expect(validateSnapshot(valid)).toBeNull();
    delete valid.travel.vehicles.entries[0].bgm;
    expect(validateSnapshot(valid)).toBeNull();

    for (const [label, bgm, path] of [
      ["empty id", { id: "" }, ".bgm.id"],
      ["volume", { id: "airship", volume: 101 }, ".bgm.volume"],
      ["pitch", { id: "airship", pitch: 49 }, ".bgm.pitch"],
      ["low pan", { id: "airship", pan: -101 }, ".bgm.pan"],
      ["high pan", { id: "airship", pan: 101 }, ".bgm.pan"],
      ["unknown field", { id: "airship", balance: 1 }, ".bgm.balance"],
    ] as const) {
      const state: any = snapshot("grounded", 0, 0, null);
      state.travel.vehicles.entries[0].bgm = bgm;
      expect(validateSnapshot(state), label).toContain(path);
    }
  });

  test("accepts only phase/tick-correlated airship transition heights", () => {
    for (const [phase, tick, altitude] of [
      ["ascending", 0, 0],
      ["ascending", 1, 16 / 48],
      ["cruising", 48, 16],
      ["descending", 48, 16],
      ["descending", 1, 16 / 48],
    ] as const) {
      expect(validateSnapshot(snapshot(phase, tick, altitude)), `${phase}:${tick}`).toBeNull();
    }
    expect(validateSnapshot(snapshot("grounded", 0, 0, null))).toBeNull();
  });

  test("rejects non-finite, out-of-range and phase-inconsistent altitudes", () => {
    const cases: Array<[string, SaveSnapshot]> = [
      ["NaN", snapshot("ascending", 1, Number.NaN)],
      ["positive infinity", snapshot("ascending", 1, Number.POSITIVE_INFINITY)],
      ["negative infinity", snapshot("ascending", 1, Number.NEGATIVE_INFINITY)],
      ["below zero", snapshot("ascending", 1, -Number.EPSILON)],
      ["above cruise", snapshot("cruising", 48, 16 + Number.EPSILON * 16)],
      ["wrong transition height", snapshot("ascending", 1, 16)],
      ["ascending endpoint", snapshot("ascending", 48, 16)],
      ["descending endpoint", snapshot("descending", 0, 0)],
      ["grounded airship ride", snapshot("grounded", 0, 0)],
      ["transition without ride", snapshot("ascending", 1, 16 / 48, null)],
    ];
    for (const [label, state] of cases) {
      expect(validateSnapshot(state), label).toContain("state.travel.vehicles");
    }
  });

  test("accepts an omitted legacy boarding field and rejects conflicting get-on state", () => {
    const legacy: any = snapshot("grounded", 0, 0, null);
    delete legacy.travel.vehicles.boarding;
    expect(validateSnapshot(legacy)).toBeNull();

    const boarding: any = snapshot("grounded", 0, 0, null);
    boarding.travel.vehicles.boarding = "airship";
    expect(validateSnapshot(boarding)).toBeNull();
    boarding.travel.vehicles.riding = "airship";
    expect(validateSnapshot(boarding)).toContain("riding and boarding cannot both be active");
  });
});
