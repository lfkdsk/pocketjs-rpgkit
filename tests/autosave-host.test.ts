import { afterEach, describe, expect, test } from "bun:test";
import { createInterpState, createSwitchState } from "../src/engine/interpreter.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { createSnapshot } from "../src/engine/save.ts";
import {
  autosaveBridge,
  createSimAutosaveBridge,
  inspectAutosaveHost,
  loadAutosaveHost,
  type AutosaveBridge,
  writeAutosaveHost,
} from "../src/host/autosave.ts";

const globals = globalThis as { __rpgkitAutosave?: AutosaveBridge };

afterEach(() => {
  delete globals.__rpgkitAutosave;
});

function snapshot(map: string, frame: number) {
  const interp = createInterpState(createSwitchState());
  interp.frame = frame;
  return createSnapshot(map, initialMovement(2, 3, 0, { tile: 16, speed: 2 }), interp, 0);
}

describe("autosave host bridge", () => {
  test("an absent host is a deterministic quiet no-op", () => {
    expect(autosaveBridge()).toBeNull();
    expect(writeAutosaveHost(snapshot("none", 1))).toBe(false);
    expect(loadAutosaveHost()).toBeNull();
    expect(inspectAutosaveHost()).toBeNull();
  });

  test("the sim bridge keeps one replaceable envelope for save-menu load", () => {
    const bridge = createSimAutosaveBridge();
    globals.__rpgkitAutosave = bridge;
    const first = snapshot("first", 7);
    const second = snapshot("second", 11);
    expect(writeAutosaveHost(first)).toBe(true);
    expect(loadAutosaveHost()).toEqual(first);
    expect(inspectAutosaveHost()).toMatchObject({ slot: 0, map: "first", frame: 7 });
    expect(writeAutosaveHost(second)).toBe(true);
    expect(loadAutosaveHost()).toEqual(second);
    expect(bridge.text()).toContain('"map":"second"');
  });

  test("inspection shows a host read failure while loading still throws", () => {
    globals.__rpgkitAutosave = {
      read() {
        throw new Error("memory stick read failed");
      },
      write: () => true,
    };
    expect(inspectAutosaveHost()).toEqual({ slot: 0, error: "memory stick read failed" });
    expect(() => loadAutosaveHost()).toThrow("memory stick read failed");
  });
});
