// tests/rpgkit-save-fs.test.ts — P1⑤ desktop fs save store against the
// sim fs host (hosts/sim/fs.ts): the same globalThis.fs namespace the
// desktop host mounts, driven in-process with no disk. Covers:
//   - hasFsSave follows the mounted namespace (null -> false)
//   - save/load slot files at save/slot-N.json with overwrite
//   - listSlotsFs: empty slots are null, a written slot summarizes, a
//     corrupt file reports an error entry
//   - fs errors surface (the SDK throws rather than silently dropping)

import { afterEach, describe, expect, test } from "bun:test";
import { createSimFsHost, type SimFsHost } from "../vendor/pocketjs/hosts/sim/fs.ts";
import {
  AUTOSAVE_FS_PATH,
  fsSaveStore,
  hasFsSave,
  inspectAutosaveFs,
  listSlotsFs,
  loadAutosaveFs,
  loadSlotFs,
  saveAutosaveFs,
  saveSlotFs,
} from "../src/host/save-fs.ts";
import {
  createSnapshot,
  SaveError,
  type SaveSnapshot,
} from "../src/engine/save.ts";
import type { MapContentIdentity } from "../src/engine/map-repository.ts";
import {
  createInterpState,
  createSwitchState,
} from "../src/engine/interpreter.ts";
import { initialMovement } from "../src/engine/movement.ts";

const g = globalThis as { fs?: unknown };
let host: SimFsHost | null = null;
const CONTENT: MapContentIdentity = { manifest: "manifest-a", schema: "schema-a" };

function mount(): SimFsHost {
  host = createSimFsHost();
  g.fs = host.ns;
  return host;
}

afterEach(() => {
  host?.dispose();
  host = null;
  g.fs = undefined;
});

function snap(map: string, gold = 0, frame = 0): SaveSnapshot {
  const interp = createInterpState(createSwitchState({ gold }));
  // stamp the frame clock the snapshot records
  for (let i = 0; i < frame; i++) interp.frame++;
  return createSnapshot(map, initialMovement(12, 9, 0, { tile: 16, speed: 2 }), interp, 0);
}

describe("P1⑤ save — fs store presence", () => {
  test("no mounted fs: hasFsSave is false and the store is null", () => {
    expect(hasFsSave()).toBe(false);
    expect(fsSaveStore()).toBeNull();
    expect(() => saveSlotFs(1, snap("m"))).toThrow(/not mounted/);
  });

  test("a mounted sim fs: hasFsSave is true", () => {
    mount();
    expect(hasFsSave()).toBe(true);
    expect(fsSaveStore()).not.toBeNull();
  });
});

describe("P1⑤ save — fs slot write/read", () => {
  test("saves land at save/slot-N.json and load back byte-identically", () => {
    const h = mount();
    const s = snap("meadow", 50);
    saveSlotFs(2, s);
    // The fs namespace saw the write under the save/ directory.
    expect(h.log.some((l) => l.startsWith("op write save/slot-2.json"))).toBe(true);
    expect(loadSlotFs(2)).toEqual(s);
  });

  test("the three slots are independent and overwrite replaces", () => {
    mount();
    saveSlotFs(1, snap("map-a", 10));
    saveSlotFs(3, snap("map-c", 30));
    expect(loadSlotFs(1).map).toBe("map-a");
    expect(loadSlotFs(3).interp.sw.gold).toBe(30);
    saveSlotFs(1, snap("map-b", 11));
    expect(loadSlotFs(1).map).toBe("map-b");
    expect(loadSlotFs(1).interp.sw.gold).toBe(11);
    // slot 2 was never written.
    expect(() => loadSlotFs(2)).toThrow(SaveError);
  });

  test("autosave uses a dedicated file and never occupies a numbered slot", () => {
    const h = mount();
    const first = snap("auto-a", 12, 7);
    const second = snap("auto-b", 13, 8);
    saveAutosaveFs(first);
    expect(h.log.some((line) => line.startsWith(`op write ${AUTOSAVE_FS_PATH}`))).toBe(true);
    expect(loadAutosaveFs()).toEqual(first);
    expect(listSlotsFs()).toEqual([null, null, null]);
    expect(inspectAutosaveFs()).toMatchObject({ slot: 0, map: "auto-a", frame: 7 });
    saveAutosaveFs(second);
    expect(loadAutosaveFs()).toEqual(second);
  });

  test("files persist across a fresh store handle (one app data root)", () => {
    mount();
    saveSlotFs(1, snap("map-a"));
    // A second adapter over the same namespace sees the file, the way a
    // guest reload keeps its data root.
    expect(fsSaveStore()!.exists(1)).toBe(true);
    expect(loadSlotFs(1).map).toBe("map-a");
  });

  test("content identity is written and enforced by load and slot listing", () => {
    mount();
    const s = snap("sharded-map", 7, 23);
    saveSlotFs(2, s, CONTENT);
    expect(loadSlotFs(2, CONTENT)).toEqual(s);
    expect(listSlotsFs(CONTENT)[1]).toMatchObject({ slot: 2, map: "sharded-map", frame: 23 });

    const other = { ...CONTENT, manifest: "manifest-b" };
    expect(() => loadSlotFs(2, other)).toThrow(/manifest hash/);
    expect(listSlotsFs(other)[1]).toMatchObject({ slot: 2, error: expect.stringMatching(/manifest hash/) });
  });
});

describe("P1⑤ save — slot listing for the menu", () => {
  test("empty slots are null; written slots summarize map and frame", () => {
    mount();
    expect(listSlotsFs()).toEqual([null, null, null]);
    saveSlotFs(2, snap("town", 0, 42));
    const list = listSlotsFs();
    expect(list[0]).toBeNull();
    expect(list[1]).toMatchObject({ slot: 2, map: "town", frame: 42 });
    expect(list[2]).toBeNull();
    expect(typeof (list[1] as { checksum: string }).checksum).toBe("string");
  });

  test("a corrupt slot file reports an error entry instead of crashing", () => {
    const h = mount();
    saveSlotFs(1, snap("town"));
    // Corrupt the file behind the adapter's back.
    const writeOp = h.ns.write as (p: string, d: string, mode: number) => number;
    writeOp("save/slot-1.json", JSON.stringify("{not valid"), 0);
    const list = listSlotsFs();
    expect(list[0]).toMatchObject({ slot: 1 });
    expect((list[0] as { error?: string }).error).toBeTruthy();
    // Loading it raises a typed SaveError.
    expect(() => loadSlotFs(1)).toThrow(SaveError);
  });

  test("with no fs mounted the list is three nulls (menu hides slots)", () => {
    expect(listSlotsFs()).toEqual([null, null, null]);
  });
});
