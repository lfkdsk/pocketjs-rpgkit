// tests/rpgkit-save-restore.test.ts — map-aware restore gate (R1202-3).
//
// restoreProblem() proves a structurally-valid snapshot fits the live map
// before any live state is replaced: in-bounds standable player tile and
// fiber event/page provenance. These are the checks the map-agnostic
// save-validate.ts cannot make (the engine core has no World).
import { describe, expect, test } from "bun:test";
import { buildMiniProject } from "../examples/meadow/mini-project.ts";
import { buildPassage } from "../src/engine/passability.ts";
import { initialMovement, type MovementState } from "../src/engine/movement.ts";
import { createInterpState } from "../src/engine/interpreter.ts";
import { createSnapshot, encodeEnvelope, decodeEnvelopeText } from "../src/engine/save.ts";
import { restoreProblem } from "../src/engine/save-restore.ts";
import type { MapDef } from "../src/engine/types.ts";

const project = buildMiniProject();
const MAP: MapDef = project.maps[0]!;
const TABLE = buildPassage(MAP, new Map(project.sheets.map((s) => [s.id, s])));
const CFG = { tile: project.tileSize, speed: 2 };

function snapshotAt(tx: number, ty: number) {
  const player: MovementState = initialMovement(tx, ty, 0, CFG);
  return createSnapshot(MAP.id, player, createInterpState(), 0);
}

describe("restoreProblem — map identity and player bounds", () => {
  test("a legal snapshot at the start tile is fine", () => {
    expect(restoreProblem(snapshotAt(10, 7), MAP, TABLE)).toBeNull();
  });

  test("a snapshot for another map is rejected", () => {
    const snap = snapshotAt(10, 7);
    (snap as { map: string }).map = "elsewhere";
    expect(restoreProblem(snap, MAP, TABLE)).toMatch(/elsewhere/);
  });

  test("an out-of-map tile is rejected even with internally-consistent pixels", () => {
    const snap = snapshotAt(1_000_000, 9);
    // px stays exactly 16*tx, so the map-agnostic validator accepts this.
    expect(snap.player.px).toBe(16_000_000);
    expect(restoreProblem(snap, MAP, TABLE)).toMatch(/outside/);
  });

  test("a negative tile is rejected", () => {
    expect(restoreProblem(snapshotAt(-1, 9), MAP, TABLE)).toMatch(/outside/);
  });

  test("a tile past the far edge is rejected", () => {
    expect(restoreProblem(snapshotAt(20, 0), MAP, TABLE)).toMatch(/outside/);
    expect(restoreProblem(snapshotAt(0, 12), MAP, TABLE)).toMatch(/outside/);
  });

  test("an autosave may be mid-step, but its destination must stay in the map", () => {
    const x = MAP.width - 1;
    const y = 7;
    const passableEdge: MapDef = {
      ...MAP,
      passage: [...(MAP.passage ?? []), [y * MAP.width + x, "pass"]],
    };
    const passableTable = buildPassage(passableEdge, new Map(project.sheets.map((s) => [s.id, s])));
    const snap = snapshotAt(x, y);
    snap.autosave = true;
    Object.assign(snap.player, {
      tx: x,
      ty: y,
      px: x * 16 + 2,
      py: y * 16,
      phase: 1,
      moving: true,
      walking: true,
      facing: 3,
      stepDir: 3,
    });
    expect(decodeEnvelopeText(encodeEnvelope(snap)).player).toEqual(snap.player);
    expect(restoreProblem(snap, passableEdge, passableTable)).toMatch(/player step target.*outside/);
  });
});

describe("restoreProblem — fiber provenance", () => {
  function parallelSnapshot(eventId: string, pageIndex: number, parallel: boolean) {
    const snap = snapshotAt(10, 7);
    snap.interp.parallels[`${MAP.id}/${eventId}`] = {
      key: `${MAP.id}/${eventId}`,
      pageIndex,
      parallel,
      stack: [{ prog: [{ op: "wait", frames: 5 }, { op: "exit" }], pc: 0 }],
      mode: "wait",
      since: 0,
      erase: false,
    };
    return snap;
  }

  test("a fiber for an event the live map lacks is rejected", () => {
    const snap = parallelSnapshot("ghost", 0, true);
    expect(restoreProblem(snap, MAP, TABLE)).toMatch(/does not exist/);
  });

  test("a fiber parking on a page index the event lacks is rejected", () => {
    const snap = parallelSnapshot("signpost", 9, true);
    expect(restoreProblem(snap, MAP, TABLE)).toMatch(/page 9/);
  });

  test("a non-parallel fiber on a parallel-flag mismatch is rejected", () => {
    // signpost page 0 is an action trigger, so a parallel-flagged fiber for
    // it cannot belong to that page.
    const snap = parallelSnapshot("signpost", 0, true);
    expect(restoreProblem(snap, MAP, TABLE)).toMatch(/trigger/);
  });

  test("fibers whose trigger matches their page are accepted (action + parallel)", () => {
    const customMap: MapDef = {
      ...MAP,
      events: [
        {
          id: "npc", x: 5, y: 5,
          pages: [{ trigger: "action", commands: [{ op: "exit" }] }],
        },
        {
          id: "clock", x: 1, y: 1,
          pages: [{ trigger: "parallel", commands: [{ op: "wait", seconds: 1 }, { op: "exit" }] }],
        },
      ],
    };
    const customTable = buildPassage(customMap, new Map(project.sheets.map((s) => [s.id, s])));
    const snap = snapshotAt(10, 7);
    snap.interp.main = null;
    snap.interp.parallels[`${MAP.id}/clock`] = {
      key: `${MAP.id}/clock`, pageIndex: 0, parallel: true,
      stack: [{ prog: [{ op: "wait", frames: 5 }, { op: "exit" }], pc: 0 }],
      mode: "wait", since: 0, erase: false,
    };
    expect(restoreProblem(snap, customMap, customTable)).toBeNull();
  });

  test("the full decode -> restore gate accepts a checksum-valid in-bounds save", () => {
    const bytes = encodeEnvelope(snapshotAt(10, 7));
    expect(restoreProblem(decodeEnvelopeText(bytes), MAP, TABLE)).toBeNull();
  });
});
