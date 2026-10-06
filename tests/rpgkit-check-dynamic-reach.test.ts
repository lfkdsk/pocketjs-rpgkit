// tests/rpgkit-check-dynamic-reach.test.ts — the reach check proves
// reachability with a replayable witness: every "reached" map carries a
// button-mask tape the tool itself replays in a fresh session to verify the
// arrival; a "notFound" map is a lead with frontier stats, never a proof.

import { describe, expect, test } from "bun:test";
import { checkReach, type ReachMapResult, type ReachReport } from "../tools/rpgkit-check/src/dynamic/reach.ts";
import { Driver } from "../tools/rpgkit-check/src/dynamic/reach-driver.ts";
import {
  BTN_DOWN,
  replayWitness,
  verifyWitness,
  type ReachWitness,
} from "../tools/rpgkit-check/src/dynamic/reach-witness.ts";
import { checkSessionOptions, reachStartSwitchState } from "../tools/rpgkit-check/src/dynamic/sim.ts";
import { loadReplayFile, replayReachWitness } from "../tools/rpgkit-check/src/dynamic/reach-replay.ts";
import { loadProjectFile } from "../tools/rpgkit-check/src/doc.ts";
import { createSession, startSession } from "../src/engine/session.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import type { Command, GameEvent, MapDef, PageCondition, Project } from "../src/engine/types.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function grassMap(id: string, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: 5,
    height: 5,
    sheets: ["grass"],
    ground: new Array<string>(25).fill("grass.0"),
    events,
  };
}

function fixtureProject(maps: MapDef[], startMap = "A"): Project {
  return {
    format: "rpgkit-project/v1",
    title: "Reach fixture",
    tileSize: 16,
    start: { map: startMap, x: 0, y: 0, dir: "down" },
    sheets: [{ id: "grass", cols: 1, rows: 1 }],
    items: [],
    sprites: { wall: { kind: "image", src: "wall.png" } },
    maps,
  };
}

function touchEvent(id: string, x: number, y: number, target: string): GameEvent {
  return {
    id,
    x,
    y,
    pages: [{ trigger: "playerTouch", commands: [{ op: "transfer", map: target, x: 0, y: 0 }] }],
  };
}

function actionEvent(id: string, x: number, y: number, commands: Command[], condition?: PageCondition): GameEvent {
  return { id, x, y, pages: [{ trigger: "action", ...(condition ? { condition } : {}), commands }] };
}

function blockEvent(id: string, x: number, y: number): GameEvent {
  return { id, x, y, pages: [{ trigger: "action", sprite: "wall", blocks: true, commands: [] }] };
}

function reached(report: ReachReport, map: string): Extract<ReachMapResult, { status: "reached" }> {
  const m = report.maps.find((r) => r.map === map);
  if (!m || m.status !== "reached") throw new Error(`map ${map} not reached`);
  return m;
}

function freshSession(project: Project, hz = 60) {
  return createSession(project, hz, checkSessionOptions(project));
}

// --- basic connectivity -------------------------------------------------------

describe("rpgkit-check reach: connected maps", () => {
  test("playerTouch transfer reaches the target map with a replayable witness", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B")]);
    const report = checkReach(project);
    expect(report.findings).toEqual([]);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual([]);
    const b = reached(report, "B");
    expect(b.frames).toBeGreaterThan(0);
    // The witness really replays to B in a fresh session.
    const replay = replayWitness(freshSession(project), project, b.witness);
    expect(replay.state.mapId).toBe("B");
    expect(replay.finalHash).toBe(b.stateHash);
  });

  test("action transfer reaches the target map", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("portal", 2, 2, [{ op: "transfer", map: "B", x: 0, y: 0 }])]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual([]);
  });

  test("disconnected map is notFound with a frontier, not a proof", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B"), grassMap("C")]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
    const c = report.maps.find((m) => m.map === "C")!;
    expect(c.status).toBe("notFound");
    if (c.status === "notFound") {
      // No literal transfer names C: the frontier is empty and the finding
      // says so.
      expect(c.frontier.inbound).toEqual([]);
    }
    const finding = report.findings.find((f) => f.check === "reach/map-not-found")!;
    expect(finding.severity).toBe("warning");
    expect(finding.message).toContain("lead, not a proof");
    expect(finding.loc.map).toBe("C");
  });

  test("a wall of blocks:true events hides the tiles behind it", () => {
    const project = fixtureProject([grassMap("A", [0, 1, 2, 3, 4].map((y) => blockEvent(`wall${y}`, 2, y)))]);
    const report = checkReach(project);
    expect(report.findings).toEqual([]);
    expect(report.reachableMaps).toEqual(["A"]);
  });

  test("start tile occupied by a blocking body is an error", () => {
    const project = fixtureProject([grassMap("A", [blockEvent("guard", 0, 0)])]);
    const report = checkReach(project);
    const errors = report.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.check).toBe("reach/start-unreachable");
  });

  test("options.start computes reachability from the requested start", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("aDoor", 2, 2, "D")]),
      grassMap("B", [touchEvent("bDoor", 2, 2, "C")]),
      grassMap("C"),
      grassMap("D"),
    ]);
    const report = checkReach(project, { start: { map: "B", x: 0, y: 0 } });
    expect(report.start).toBe("B@0,0");
    expect(report.reachableMaps.sort()).toEqual(["B", "C"]);
    expect(report.notFoundMaps.sort()).toEqual(["A", "D"]);
  });
});

describe("rpgkit-check reach: transfer tile at the map edge", () => {
  test("a door on the east edge is reached via its in-bounds neighbor", () => {
    // The door is on the east edge of a 3x3 map. Its only path-onto neighbor
    // is in bounds; an out-of-bounds neighbor must not produce a bogus path
    // (the y*width+x key collides for off-map cells).
    const edgeMap: MapDef = {
      id: "A", name: "A", width: 3, height: 3, sheets: ["grass"],
      ground: new Array<string>(9).fill("grass.0"),
      events: [touchEvent("door", 2, 0, "B")],
    };
    const project = fixtureProject([edgeMap, grassMap("B")]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
  });
});

// --- the three review rounds' edge cases --------------------------------------
//
// Each fixture has a map the search MUST find (witness replays) and a map the
// search MUST NOT fabricate. These are the shapes the old second-interpreter
// reach got wrong; the real engine gets them right by construction.

describe("rpgkit-check reach: nested branch transfer", () => {
  test("a transfer inside a taken branch kills the parent tail", () => {
    // if (unset switch → true) { transfer B }; transfer C  → B reached, C notFound.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "switch", id: "later", value: false }, then: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
        { op: "transfer", map: "C", x: 0, y: 0 },
      ])]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
    // Cross-check: the real engine ends on B, not C.
    const replay = replayWitness(freshSession(project), project, reached(report, "B").witness);
    expect(replay.state.mapId).toBe("B");
  });
});

describe("rpgkit-check reach: recursive common events", () => {
  test("a self-recursive common runaways before its transfer", () => {
    // common loop = [common loop, transfer B]. The engine hits its stack-depth
    // guard; B is never reached.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [{ op: "common", id: "loop" }])]),
      grassMap("B"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "loop", commands: [{ op: "common", id: "loop" }, { op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.notFoundMaps).toEqual(["B"]);
  });

  test("mutual recursion also runaways", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [{ op: "common", id: "ping" }])]),
      grassMap("B"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "ping", commands: [{ op: "common", id: "pong" }] },
      { trigger: "none", id: "pong", commands: [{ op: "common", id: "ping" }, { op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.notFoundMaps).toEqual(["B"]);
  });

  test("a non-recursive common that transfers is found", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [{ op: "common", id: "go" }])]),
      grassMap("B"),
    ]);
    project.commonEvents = [
      { trigger: "none", id: "go", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
    ];
    const report = checkReach(project);
    expect(report.reachableMaps).toEqual(["A", "B"]);
  });
});

describe("rpgkit-check reach: non-zero item/gold baseline", () => {
  test("an item added on top of a non-zero baseline propagates through a forced transfer", () => {
    // Start holding key=1. A's autorun adds one (→2) and transfers to B; B's
    // page gated on key>=2 transfers to C. The old merge treated the non-zero
    // baseline as a disagreement and lost it.
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "item", item: "key", set: "add", count: 1 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "item", id: "key", count: 2 }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { start: { map: "A", x: 0, y: 0, items: { key: 1 } } });
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
  });

  test("a gate above the carried count is notFound", () => {
    // Same shape, but B's gate needs key>=3 while only 2 is carried.
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "item", item: "key", set: "add", count: 1 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "item", id: "key", count: 3 }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { start: { map: "A", x: 0, y: 0, items: { key: 1 } } });
    expect(report.reachableMaps.sort()).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
  });

  test("gold above a non-zero baseline propagates", () => {
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "gold", set: "add", amount: 5 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "gold", amount: 15 }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { start: { map: "A", x: 0, y: 0, gold: 10 } });
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
  });
});

describe("rpgkit-check reach: delayed forced transfer chain", () => {
  test("a forced transfer after a 1 s wait is followed (no fixed tick window)", () => {
    // A's autorun waits 1 s, adds key, transfers B; B's autorun gated on key
    // transfers C. The old 10-tick dry-run window lost the delayed state.
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "wait", seconds: 1.0 },
          { op: "item", item: "key", set: "add", count: 1 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [{
        id: "gate", x: 2, y: 2,
        pages: [{ condition: { item: "key" }, trigger: "autorun", commands: [{ op: "transfer", map: "C", x: 0, y: 0 }] }],
      }]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
    // Every reached map's witness replays to that map at 60 Hz.
    for (const id of ["A", "B", "C"]) {
      const m = reached(report, id);
      expect(replayWitness(freshSession(project), project, m.witness).state.mapId).toBe(id);
    }
  });

  test("a gate the delayed chain never satisfies is notFound", () => {
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "wait", seconds: 1.0 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B", [{
        id: "gate", x: 2, y: 2,
        pages: [{ condition: { switch: "never" }, trigger: "autorun", commands: [{ op: "transfer", map: "C", x: 0, y: 0 }] }],
      }]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
  });
});

describe("rpgkit-check reach: parallel transient page", () => {
  const transientProject = (farX: number, farY: number): Project => {
    // A parallel opens `open` for ~0.33 s starting at 0.5 s. A near action
    // page (1,0) gated on open transfers B; a far one gated on open transfers
    // C. The search must catch the transient page and reach B; the far event
    // cannot be reached while the window is open.
    const timer: GameEvent = {
      id: "timer", x: 0, y: 0,
      pages: [
        { trigger: "parallel", commands: [
          { op: "wait", seconds: 0.5 },
          { op: "switch", id: "open", value: true },
          { op: "wait", seconds: 0.33 },
          { op: "switch", id: "open", value: false },
          { op: "selfSwitch", key: "A", value: true },
        ] },
        { trigger: "parallel", condition: { selfSwitch: "A" }, commands: [] },
      ],
    };
    const gate = (id: string, x: number, y: number, target: string): GameEvent => ({
      id, x, y,
      pages: [{ condition: { switch: "open" }, trigger: "action", commands: [{ op: "transfer", map: target, x: 0, y: 0 }] }],
    });
    return fixtureProject([
      grassMap("A", [timer, gate("near", 1, 0, "B"), gate("far", farX, farY, "C")]),
      grassMap("B"),
      grassMap("C"),
    ]);
  };

  test("a page a parallel activates briefly is caught and triggered", () => {
    const report = checkReach(transientProject(4, 4));
    expect(report.reachableMaps).toContain("B");
  });

  test("an event too far to reach while the window is open is notFound", () => {
    const report = checkReach(transientProject(4, 4));
    expect(report.notFoundMaps).toContain("C");
    const c = report.maps.find((m) => m.map === "C")!;
    expect(c.status).toBe("notFound");
  });
});

describe("rpgkit-check reach: dedup key soundness", () => {
  test("a long parallel timer opening a door is ridden out and the door is found", () => {
    // The timer runs longer than the wait macro's quiet-exit window, so the
    // first wait leaf parks with the fiber still mid-wait. The dedup key
    // zeroes the absolute frame clock; it must also rebase the fiber's
    // absolute `since` anchor onto the same zero, or the leaf's key equals
    // the root's (same absolute since, frame zeroed both) and the leaf is
    // dropped — the queue empties and the door's map is never found.
    const project = fixtureProject([
      grassMap("A", [
        { id: "timer", x: 0, y: 0, pages: [{ trigger: "parallel", commands: [
          { op: "wait", seconds: 10 },
          { op: "switch", id: "open", value: true },
        ] }] },
        { id: "door", x: 2, y: 0, pages: [{
          condition: { switch: "open" },
          trigger: "playerTouch",
          commands: [{ op: "transfer", map: "B", x: 0, y: 0 }],
        }] },
      ]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 5000 });
    expect(report.reachableMaps).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual([]);
    // The witness really replays to B in a fresh session.
    const b = reached(report, "B");
    expect(replayWitness(freshSession(project), project, b.witness).state.mapId).toBe("B");
  });
});

describe("rpgkit-check reach: switch set before an in-page transfer", () => {
  test("a switch an action page sets before transferring opens the target's door", () => {
    // A's action: set gate=true; transfer B. B's action gated on gate → C.
    // The old reach never ran action pages, so gate never propagated.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "switch", id: "gate", value: true },
        { op: "transfer", map: "B", x: 0, y: 0 },
      ])]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "switch", id: "gate" }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
  });

  test("a gate the page never sets stays notFound", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "switch", id: "gate", value: true },
        { op: "transfer", map: "B", x: 0, y: 0 },
      ])]),
      grassMap("B", [actionEvent("door", 2, 2, [
        { op: "if", if: { kind: "switch", id: "other" }, then: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B"]);
    expect(report.notFoundMaps).toEqual(["C"]);
  });
});

// --- cross-macro key state ------------------------------------------------------
//
// A macro inherits the button state the previous macro ended with: a key still
// held across the boundary must not be re-observed as a fresh pressed edge by
// the search (the replay carries `prev` across the whole tape, so a search
// that resets it records a tape whose edges do not match the replay's).

describe("rpgkit-check reach: cross-macro key state", () => {
  test("a switch set on another map, then a gated door back on the first, is witnessed", () => {
    // A→B (action sets open=true) → back to A → a playerTouch door on A that
    // is only active while `open` holds → C. The witness spans three macros;
    // the second macro ends with a held confirm, and the third must inherit
    // that held state instead of treating its own first press as a new edge.
    const project = fixtureProject([
      grassMap("A", [
        actionEvent("to-b", 1, 0, [{ op: "transfer", map: "B", x: 0, y: 0 }]),
        {
          id: "gate-c",
          x: 0,
          y: 2,
          pages: [{
            condition: { switch: "open" },
            trigger: "playerTouch",
            commands: [{ op: "transfer", map: "C", x: 0, y: 0 }],
          }],
        },
      ]),
      grassMap("B", [actionEvent("return", 1, 0, [
        { op: "switch", id: "open", value: true },
        { op: "transfer", map: "A", x: 0, y: 0 },
      ])]),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
    expect(report.notFoundMaps).toEqual([]);
    // The witness really replays to C from a fresh session.
    const c = reached(report, "C");
    const replay = replayWitness(freshSession(project), project, c.witness);
    expect(replay.state.mapId).toBe("C");
    expect(replay.finalHash).toBe(c.stateHash);
  });
});

// --- choices branching ---------------------------------------------------------

describe("rpgkit-check reach: choices branch per option", () => {
  test("every option's transfer target is reached", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "choices", prompt: "?", options: [
          { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
          { text: "c", commands: [{ op: "transfer", map: "C", x: 0, y: 0 }] },
        ] },
      ])]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
  });

  test("a cancellable choices box also reaches the post-choice map", () => {
    // Option 0 → B; cancel → falls through to C.
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "choices", prompt: "?", cancel: { commands: [] }, options: [
          { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
        ] },
        { op: "transfer", map: "C", x: 0, y: 0 },
      ])]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project);
    expect(report.reachableMaps.sort()).toEqual(["A", "B", "C"]);
  });
});

// --- audio state in the dedup key ------------------------------------------------
//
// The dedup key is the engine's canonical state fingerprint, so persistent
// audio intent (which BGM plays) is part of the key: a page gated on
// bgmPlaying must be found after a playBgm, and the pre-/post-music states
// must never merge.

describe("rpgkit-check reach: audio-gated pages", () => {
  const bgmProject = (): Project => ({
    ...fixtureProject([
      grassMap("A", [
        actionEvent("music", 2, 2, [{ op: "playBgm", id: "field" }]),
        actionEvent("door", 1, 0, [
          { op: "transfer", map: "B", x: 0, y: 0 },
        ], { all: [{ kind: "bgmPlaying", id: "field" }] }),
        actionEvent("wrong-door", 0, 2, [
          { op: "transfer", map: "C", x: 0, y: 0 },
        ], { all: [{ kind: "bgmPlaying", id: "battle" }] }),
      ]),
      grassMap("B"),
      grassMap("C"),
    ]),
    audio: { field: "audio:wav.field", battle: "audio:wav.battle" },
  });

  test("a bgmPlaying-gated door is found after the matching playBgm", () => {
    // The search triggers the music event, then observes the door's page
    // active and triggers it. A dedup key that omits persistent audio merges
    // the post-music state into the pre-music root and never sees the door.
    const project = bgmProject();
    const report = checkReach(project);
    // C is intentionally notFound (its door needs a BGM that never plays),
    // so it carries a map-not-found warning; there must be no errors.
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.reachableMaps).toContain("B");
    expect(report.notFoundMaps).toContain("C");
    // The witness really replays to B with the recorded state.
    const b = reached(report, "B");
    const replay = replayWitness(freshSession(project), project, b.witness);
    expect(replay.state.mapId).toBe("B");
    expect(replay.finalHash).toBe(b.stateHash);
    // The BGM is really playing in the replayed state.
    expect(replay.state.interp.audio?.bgm?.id).toBe("field");
  });

  test("the pre- and post-music states are distinct search states", () => {
    // The search explores the root (no music) and the post-music node: the
    // music event is triggered from the root, and the door from the node
    // with the BGM playing.
    const project = bgmProject();
    const report = checkReach(project);
    expect(Number(report.summary.statesExplored)).toBeGreaterThanOrEqual(2);
  });
});

// --- witness integrity ----------------------------------------------------------

describe("rpgkit-check reach: witness tampering", () => {
  test("a witness with its tail cut off fails replay verification", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B")]);
    const report = checkReach(project);
    const b = reached(report, "B");
    const tampered: ReachWitness = { hz: 60, masks: b.witness.masks.slice(0, -10) };
    const verdict = verifyWitness(freshSession(project), project, tampered, "B", b.stateHash);
    expect(verdict.ok).toBe(false);
  });

  test("a witness replayed against the wrong expected hash fails", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B")]);
    const report = checkReach(project);
    const b = reached(report, "B");
    const verdict = verifyWitness(freshSession(project), project, b.witness, "B", "deadbeef");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("hash");
  });
});

describe("rpgkit-check reach: determinism", () => {
  test("two runs with the same params are byte-identical", () => {
    const project = fixtureProject([
      grassMap("A", [
        touchEvent("door", 2, 2, "B"),
        actionEvent("choice", 4, 4, [
          { op: "choices", prompt: "?", options: [
            { text: "b", commands: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
          ] },
        ]),
      ]),
      grassMap("B"),
    ]);
    const r1 = JSON.stringify(checkReach(project));
    const r2 = JSON.stringify(checkReach(project));
    expect(r2).toBe(r1);
  });
});

// --- budgets ---------------------------------------------------------------------
//
// maxFrames / maxStates / maxSeconds are execution limits, not hints: the
// search checks them inside each macro's ride-out / battle / wait loop and
// parks the macro the moment the budget is spent, so a long macro cannot run
// a full macro past the limit. The block-constant tape makes one block
// (6 ticks) the minimum unit of work, so maxFrames=1 runs one block.

describe("rpgkit-check reach: budgets are execution limits", () => {
  test("maxFrames=1 runs one block of work and ends on the frame budget", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 1 });
    expect(report.endedReason).toBe("frame-budget");
    // One block (6 ticks) is the minimum unit of work: the search steps one
    // block, the in-macro check parks it, and no map is falsely reached.
    expect(report.summary.framesRun).toBeGreaterThan(0);
    expect(report.summary.framesRun).toBeLessThanOrEqual(12);
    expect(report.reachableMaps).toEqual(["A"]);
    expect(report.notFoundMaps).toEqual(["B"]);
  });

  test("a tiny maxSeconds parks the macro inside its ride-out, not after a full macro", () => {
    // A's autorun waits 10000 s then transfers B; without an in-macro
    // deadline the ride-out would run the whole wait. With a 1 ms budget it
    // parks inside the first few blocks (the long wait guarantees the
    // search cannot finish before the deadline on any machine).
    const project = fixtureProject([
      grassMap("A", [{
        id: "boot", x: 0, y: 0,
        pages: [{ trigger: "autorun", commands: [
          { op: "wait", seconds: 10000.0 },
          { op: "transfer", map: "B", x: 0, y: 0 },
        ] }],
      }]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxSeconds: 0.001 });
    expect(report.endedReason).toBe("time-budget");
    // It parked inside the ride-out, nowhere near the 600000-tick wait.
    expect(report.summary.framesRun).toBeLessThan(6000);
  });

  test("maxStates stops the search after exploring that many states", () => {
    // C is unreachable, so the all-maps early stop never trips and the state
    // budget is what ends the search.
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
      grassMap("C"),
    ]);
    const report = checkReach(project, { maxStates: 1 });
    expect(report.endedReason).toBe("state-budget");
    expect(report.summary.statesExplored).toBeLessThanOrEqual(1);
  });

  test("a budget-exhausted search still reports notFound with frontier stats", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 1 });
    const b = report.maps.find((m) => m.map === "B");
    expect(b?.status).toBe("notFound");
    // The frontier points at the inbound transfer whose source page never ran.
    expect(b?.status === "notFound" && b.frontier.inbound.length).toBeGreaterThan(0);
  });

  test("a choices fan-out charges its shared prefix once, not once per leaf", () => {
    // A's action event waits 1 s, then opens an 8-option choices box; every
    // option transfers to B0..B7, and B0 has an onward door to C. The walk,
    // the wait, the trigger and the cursor navigation are a SHARED prefix:
    // the old accounting added every leaf's full tape suffix to framesRun,
    // charging the prefix eight times (1266 ticks for a 600-tick budget) and
    // stopping with all eight B nodes still queued, so C was left notFound
    // with real budget left. The macro now reports the ticks it really
    // executed once.
    const options = Array.from({ length: 8 }, (_, i) => ({
      text: `b${i}`,
      commands: [{ op: "transfer" as const, map: `B${i}`, x: 0, y: 0 }],
    }));
    const project = fixtureProject([
      grassMap("A", [actionEvent("fan", 2, 2, [
        { op: "wait", seconds: 1.0 },
        { op: "choices", prompt: "?", options },
      ])]),
      ...Array.from({ length: 8 }, (_, i) =>
        grassMap(`B${i}`, i === 0 ? [actionEvent("onward", 2, 2, [{ op: "transfer", map: "C", x: 0, y: 0 }])] : []),
      ),
      grassMap("C"),
    ]);
    const report = checkReach(project, { maxFrames: 1000 });
    // The fan-out's real spend is well under the budget; every map is
    // reached, so the all-maps early stop ends the search ("goals-met").
    expect(Number(report.summary.framesRun)).toBeLessThan(1000);
    expect(report.endedReason).toBe("goals-met");
    // C is reached: B0 was explored and its onward door triggered.
    expect(report.reachableMaps).toContain("C");
    expect(report.notFoundMaps).toEqual([]);
    const c = reached(report, "C");
    const replay = replayWitness(freshSession(project), project, c.witness);
    expect(replay.state.mapId).toBe("C");
    expect(replay.finalHash).toBe(c.stateHash);
    // The shared prefix is charged once, not eight times: the whole search
    // spends fewer ticks than eight times the shortest B witness (the old
    // per-leaf accounting charged at least that for the fan-out alone).
    const bFrames = report.maps
      .filter((m) => m.map.startsWith("B") && m.status === "reached")
      .map((m) => (m as Extract<ReachMapResult, { status: "reached" }>).frames);
    expect(Number(report.summary.framesRun)).toBeLessThan(8 * Math.min(...bFrames));
  });

  test("the frame budget is never overshot by more than one block", () => {
    // Every macro parks the moment its real spend reaches the remaining
    // budget (checked before each 6-tick block, between a release block and
    // its edge block, and after each block), so the whole search spends at
    // most one block past maxFrames. The old per-leaf accounting could
    // report hundreds of ticks over the budget.
    const project = fixtureProject([
      grassMap("A", [actionEvent("fan", 2, 2, [
        { op: "wait", seconds: 1.0 },
        { op: "choices", prompt: "?", options: [
          { text: "b0", commands: [{ op: "transfer", map: "B0", x: 0, y: 0 }] },
          { text: "b1", commands: [{ op: "transfer", map: "B1", x: 0, y: 0 }] },
        ] },
      ])]),
      grassMap("B0"),
      grassMap("B1"),
    ]);
    for (const maxFrames of [1, 30, 60, 120, 300]) {
      const report = checkReach(project, { maxFrames });
      expect(Number(report.summary.framesRun)).toBeLessThanOrEqual(maxFrames + 6);
    }
  });

  test("a held edge across macros never overshoots by more than one block", () => {
    // The first macro presses CIRCLE on A's action door and rides the
    // transfer out inside the same block, so the node's end mask still
    // holds CIRCLE. The next macro (B's action door) re-requests CIRCLE:
    // the driver emits a release block before the edge block. The release
    // block's six ticks must count toward the budget BEFORE the park
    // callback is consulted between the two blocks, or one act() runs
    // twelve ticks and the search overshoots by nearly two blocks (the
    // 13..17 budgets below all ran 24 ticks before the fix — 7..11 over).
    const project = {
      ...fixtureProject([
        grassMap("A", [actionEvent("door", 1, 0, [
          { op: "transfer", map: "B", x: 0, y: 0 },
        ])]),
        grassMap("B", [actionEvent("door", 1, 0, [
          { op: "transfer", map: "C", x: 0, y: 0 },
        ])]),
        grassMap("C"),
      ]),
      // Facing the door: the first macro presses CIRCLE and rides the
      // transfer out inside the same block, so the node still holds CIRCLE.
      start: { map: "A", x: 0, y: 0, dir: "right" as const },
    };
    for (const maxFrames of [1, 13, 14, 15, 16, 17, 30, 60, 120, 300]) {
      const report = checkReach(project, { maxFrames });
      expect(Number(report.summary.framesRun)).toBeLessThanOrEqual(maxFrames + 6);
    }
  });
});

// --- driver block boundary ---------------------------------------------------------
//
// A pressed edge whose button is still held from the previous block needs a
// release block first. The budget check runs between the release and the edge
// block, so a macro parks at most one block past the budget even there.

describe("rpgkit-check reach: driver block boundary", () => {
  test("a re-requested held edge parks between its release and edge block", () => {
    const project = fixtureProject([grassMap("A")]);
    const session = freshSession(project);
    const state = startSession(project, session);
    const driver = new Driver(session, state, 0);
    // First block holds DOWN; prevMask is now BTN_DOWN.
    expect(driver.act({ hold: BTN_DOWN })).toHaveLength(6);
    // Re-requesting DOWN while held emits a release block first. A park that
    // trips after the release block keeps the edge block from running.
    let parked = false;
    const ticks = driver.act({ hold: 0, down: true }, () => {
      parked = true;
      return true;
    });
    expect(ticks).toHaveLength(6); // release block only
    expect(parked).toBe(true);
  });
});

// --- witness tape format ---------------------------------------------------------
//
// A witness records masks in constant 6-tick blocks, with every pressed edge
// on a block boundary. The tool verifies witnesses at 60 Hz only and makes
// no claim about other host frame rates.

describe("rpgkit-check reach: witness tape format", () => {
  test("a witness is recorded in constant 6-tick blocks with edges on block boundaries", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    const b = reached(report, "B");
    const masks = b.witness.masks;
    expect(masks.length % 6).toBe(0);
    for (let i = 0; i < masks.length; i += 6) {
      for (let j = i + 1; j < i + 6; j++) expect(masks[j]).toBe(masks[i]);
    }
    // Every pressed edge lands on a block boundary (tick 0 of a block):
    // no block introduces a bit the previous block did not already hold,
    // except at a block start.
    let prev = 0;
    for (let i = 0; i < masks.length; i += 6) {
      const m = masks[i]!;
      const pressed = (m & ~prev) >>> 0;
      if (i % 6 !== 0) expect(pressed).toBe(0);
      prev = m;
    }
    // The witness is a 60 Hz tape.
    expect(b.witness.hz).toBe(60);
  });
});

// --- battle policy ---------------------------------------------------------------

describe("rpgkit-check reach: battles", () => {
  const winRules: BattleRules = {
    start: () => ({ state: { t: 0 }, ext: null }),
    step: (state: { t: number }) => ({ t: state.t + 1 }),
    done: (state: { t: number }) =>
      state.t >= 30 ? { ext: null, result: "win", switches: { won: true } } : null,
  };

  test("under the default policy encounters are declined and onWin never runs", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("boss", 2, 2, [
        { op: "battle", setup: null, onWin: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
      ])]),
      grassMap("B"),
    ]);
    const report = checkReach(project);
    expect(report.battlePolicy).toBe("encounters-declined");
    expect(report.notFoundMaps).toContain("B");
  });

  test("registered rules fight the battle for real and follow onWin", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("boss", 2, 2, [
        { op: "battle", setup: null, onWin: [{ op: "transfer", map: "B", x: 0, y: 0 }] },
      ])]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { battle: { rules: winRules } });
    expect(report.battlePolicy).toBe("registered-rules");
    expect(report.reachableMaps).toContain("B");
    // The witness replays the battle identically.
    const b = reached(report, "B");
    const replay = replayWitness(createSession(project, 60, { ...checkSessionOptions(project), battle: winRules }), project, b.witness);
    expect(replay.state.mapId).toBe("B");
  });
});

// --- structural checks ------------------------------------------------------------

describe("rpgkit-check reach: structural transfer checks", () => {
  test("a transfer to a missing map is an error", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "GONE")])]);
    const report = checkReach(project);
    const f = report.findings.find((x) => x.check === "reach/transfer-target-missing");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("error");
    expect(f!.loc.event).toBe("door");
  });

  test("a transfer landing on a void tile is a warning", () => {
    const b: MapDef = { ...grassMap("B"), ground: [...grassMap("B").ground] };
    b.ground[0] = null as never;
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), b]);
    const report = checkReach(project);
    const f = report.findings.find((x) => x.check === "reach/transfer-landing-blocked");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("warning");
  });

  test("a map no literal transfer names is an orphan info", () => {
    const project = fixtureProject([grassMap("A", [touchEvent("door", 2, 2, "B")]), grassMap("B"), grassMap("C")]);
    const report = checkReach(project);
    const orphans = report.findings.filter((x) => x.check === "reach/map-orphan").map((x) => x.loc.map);
    expect(orphans).toEqual(["C"]);
  });

  test("a dynamic-target transfer is listed as info", () => {
    const project = fixtureProject([
      grassMap("A", [actionEvent("door", 2, 2, [
        { op: "switch", id: "dest", value: true },
        { op: "transfer", map: { variable: "destMap" }, x: 0, y: 0 },
      ])]),
    ]);
    const report = checkReach(project);
    const f = report.findings.find((x) => x.check === "reach/dynamic-transfer");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("info");
  });
});

// --- report shape ------------------------------------------------------------------

describe("rpgkit-check reach: report shape", () => {
  test("the report is not marked experimental and lists its assumptions", () => {
    const project = fixtureProject([grassMap("A"), grassMap("B")]);
    const report = checkReach(project);
    expect((report as unknown as Record<string, unknown>).experimental).toBeUndefined();
    expect(report.assumptions.length).toBeGreaterThan(0);
    expect(report.assumptions.join("\n")).toContain("lead, not a proof");
  });

  test("budgets are reported", () => {
    const project = fixtureProject([grassMap("A"), grassMap("B")]);
    const report = checkReach(project, { maxFrames: 100, maxStates: 5, maxSeconds: 10 });
    expect(report.budgets).toEqual({ maxFrames: 100, maxStates: 5, maxSeconds: 10 });
  });
});

// --- example documents ---------------------------------------------------------------

describe("rpgkit-check reach: example documents", () => {
  for (const path of [
    "examples/sunstone/data/sunstone.json",
    "examples/meadow/data/meadow.json",
  ]) {
    // The sunstone search takes a few seconds; the default 5s timeout is too
    // tight under full-suite load.
    test(`${path} runs and every reached map's witness replays`, () => {
      const loaded = loadProjectFile(path);
      expect(loaded.project).not.toBeNull();
      const report = checkReach(loaded.project!);
      // Every reached map's witness replays to that map in a fresh session.
      for (const m of report.maps) {
        if (m.status !== "reached") continue;
        const replay = replayWitness(freshSession(loaded.project!), loaded.project!, m.witness);
        expect(replay.state.mapId).toBe(m.map);
        expect(replay.finalHash).toBe(m.stateHash);
        // The witness is a 60 Hz tape in constant 6-tick blocks.
        expect(m.witness.hz).toBe(60);
        expect(m.witness.masks.length % 6).toBe(0);
      }
      // The search explores more than one state on a real multi-map project.
      // A single-map project already reaches its one map from the root, so
      // the all-maps early stop ends it before any expansion.
      if (loaded.project!.maps.length > 1) {
        expect(Number(report.summary.statesExplored)).toBeGreaterThan(1);
      } else {
        expect(report.endedReason).toBe("goals-met");
      }
    }, 60_000);
  }
});

// --- state goals -------------------------------------------------------------------
//
// With goals the search stops as soon as the combined predicate holds at one
// observed state ("goals-met"), reporting a replayable witness to that state;
// an unmet run reports the closest state and a suggested budget. With no
// goals the implicit goal is every map, so the search stops as soon as each
// map has a witness instead of spending the rest of the budget.

describe("rpgkit-check reach: state goals", () => {
  test("a switch goal stops the search early with a replayable witness", () => {
    const project = fixtureProject([
      grassMap("A", [
        actionEvent("chest", 2, 2, [
          { op: "switch", id: "done", value: true },
          { op: "text", lines: ["Done."] },
        ]),
      ]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { goals: ["switch:done=true"], maxFrames: 120000 });
    expect(report.endedReason).toBe("goals-met");
    // Early stop: the search spent a few hundred frames, not the budget.
    expect(Number(report.summary.framesRun)).toBeLessThan(5000);
    expect(report.goals?.status).toBe("met");
    expect(report.goals?.results).toEqual([
      expect.objectContaining({ goal: "switch:done=true", status: "met" }),
    ]);
    const witness = report.goals!.witness!;
    expect(witness.hz).toBe(60);
    // The witness replays in a fresh session and the goal holds on replay.
    const replay = replayWitness(freshSession(project), project, witness);
    expect(replay.finalHash).toBe(report.goals!.expectedHash!);
    expect(replay.state.sw.switches["done"]).toBe(true);
    // The terminal state summary says where the tape ends and what changed.
    expect(report.goals!.final?.map).toBe("A");
    expect(report.goals!.final?.switches).toMatchObject({ done: true });
  });

  test("all-mode: every goal must hold at the same state", () => {
    const project = fixtureProject([
      grassMap("A", [
        actionEvent("chest", 2, 2, [
          { op: "switch", id: "done", value: true },
          { op: "gold", set: "add", amount: 10 },
          { op: "text", lines: ["Loot."] },
        ]),
      ]),
    ]);
    const report = checkReach(project, {
      goals: ["switch:done=true", "gold>=10"],
      maxFrames: 120000,
    });
    expect(report.endedReason).toBe("goals-met");
    expect(report.goals?.status).toBe("met");
    expect(report.goals?.mode).toBe("all");
    expect(report.goals?.results.every((r) => r.status === "met")).toBe(true);
    const replay = replayWitness(freshSession(project), project, report.goals!.witness!);
    expect(replay.state.sw.switches["done"]).toBe(true);
    expect(replay.state.sw.gold).toBe(10);
  });

  test("any-mode: one satisfied goal is enough", () => {
    const project = fixtureProject([
      grassMap("A", [
        actionEvent("chest", 2, 2, [
          { op: "gold", set: "add", amount: 10 },
          { op: "text", lines: ["Loot."] },
        ]),
      ]),
    ]);
    const report = checkReach(project, {
      goals: ["switch:impossible=true", "gold>=10"],
      goalMode: "any",
      maxFrames: 120000,
    });
    expect(report.endedReason).toBe("goals-met");
    expect(report.goals?.status).toBe("met");
    const met = report.goals!.results!.filter((r) => r.status === "met").map((r) => r.goal);
    expect(met).toEqual(["gold>=10"]);
  });

  test("an unmet goal reports the closest state and a suggested budget", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { goals: ["switch:never=true"], maxFrames: 60 });
    expect(report.endedReason).toBe("frame-budget");
    expect(report.goals?.status).toBe("unmet");
    expect(report.goals?.closest).toBeDefined();
    expect(report.goals!.closest!.unsatisfied).toEqual(["switch:never=true"]);
    expect(report.goals!.closest!.satisfied).toEqual([]);
    // The closest state carries its own replayable witness.
    const closest = report.goals!.closest!;
    expect(closest.witness).toBeDefined();
    const replay = replayWitness(freshSession(project), project, closest.witness!);
    expect(replay.state.mapId).toBe(closest.final.map);
    // A budget stop suggests a larger budget worth retrying with.
    expect(report.goals!.suggestedBudget?.maxFrames).toBeGreaterThan(60);
  });

  test("a map@x,y goal is witnessed at the tile, including a pass-through", () => {
    // BFS from (0,0) to the door at (2,2) walks (0,1),(0,2),(1,2),(2,2)
    // (down is the first dir tried): (0,1) is only passed through mid-walk,
    // never an idle node.
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const passThrough = checkReach(project, { goals: ["map:A@0,1"], maxFrames: 120000 });
    expect(passThrough.endedReason).toBe("goals-met");
    const replay1 = replayWitness(freshSession(project), project, passThrough.goals!.witness!);
    expect(replay1.state.mapId).toBe("A");
    expect(replay1.state.move.tx).toBe(0);
    expect(replay1.state.move.ty).toBe(1);
    // The landing tile of a transfer is an idle state.
    const landing = checkReach(project, { goals: ["map:B@0,0"], maxFrames: 120000 });
    expect(landing.endedReason).toBe("goals-met");
    const replay2 = replayWitness(freshSession(project), project, landing.goals!.witness!);
    expect(replay2.state.mapId).toBe("B");
    expect(replay2.state.move.tx).toBe(0);
    expect(replay2.state.move.ty).toBe(0);
  });

  test("event-page and selfSwitch goals", () => {
    const project = fixtureProject([
      grassMap("A", [
        {
          id: "door",
          x: 4,
          y: 0,
          pages: [
            { trigger: "action", commands: [{ op: "text", lines: ["Locked."] }] },
            { trigger: "action", condition: { switch: "opened" }, commands: [{ op: "text", lines: ["Open."] }] },
          ],
        },
        actionEvent("lever", 2, 2, [
          { op: "switch", id: "opened", value: true },
          { op: "text", lines: ["Click."] },
        ]),
        actionEvent("chest", 0, 4, [
          { op: "selfSwitch", key: "A", value: true },
          { op: "text", lines: ["Opened."] },
        ]),
      ]),
    ]);
    const page = checkReach(project, { goals: ["event-page:A/door=1"], maxFrames: 120000 });
    expect(page.endedReason).toBe("goals-met");
    expect(page.goals?.status).toBe("met");
    const self = checkReach(project, { goals: ["selfSwitch:A/chest/A"], maxFrames: 120000 });
    expect(self.endedReason).toBe("goals-met");
    const replay = replayWitness(freshSession(project), project, self.goals!.witness!);
    expect(replay.state.sw.self["A/chest"]).toBe("A");
  });

  test("goals already holding at the start give a zero-frame witness", () => {
    const project = fixtureProject([grassMap("A"), grassMap("B")]);
    const report = checkReach(project, {
      start: { map: "A", x: 0, y: 0, switches: { done: true } },
      goals: ["switch:done=true"],
    });
    expect(report.endedReason).toBe("goals-met");
    expect(Number(report.summary.framesRun)).toBe(0);
    expect(report.goals!.witness!.masks).toEqual([]);
  });

  test("a goal naming an unknown map is an error finding", () => {
    const project = fixtureProject([grassMap("A")]);
    const report = checkReach(project, { goals: ["map:NOPE@0,0"] });
    expect(report.findings.some((f) => f.check === "reach/goal-unknown-target" && f.severity === "error")).toBe(true);
    expect(report.goals?.status).toBe("unmet");
  });

  test("with no goals the search stops as soon as every map is reached", () => {
    // The retest complaint: an all-maps run spent its whole 800004-frame
    // budget after finding the last map. The implicit goal is every map, so
    // the search now stops the moment each one has a witness.
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B", [touchEvent("door", 2, 2, "C")]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { maxFrames: 120000 });
    expect(report.endedReason).toBe("goals-met");
    expect(report.reachableMaps).toEqual(["A", "B", "C"]);
    expect(Number(report.summary.framesRun)).toBeLessThan(120000);
  });

  test("a no-goal state-budget stop with unfound maps reports a closest state and a suggested budget", () => {
    // The retest complaint: a default reach run that only found some maps
    // gave no hint what to try next. With no goals the implicit goal is
    // every map; a budget stop with maps unfound now carries the same
    // closest-state and suggested-budget lead a goals run gives.
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B", [touchEvent("door", 2, 2, "C")]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { maxStates: 1 });
    expect(report.endedReason).toBe("state-budget");
    expect(report.notFoundMaps).toEqual(["C"]);
    expect(report.suggestedBudget?.maxStates).toBeGreaterThan(1);
    expect(report.closest).toBeDefined();
    // The closest state is the deepest the search got (B, one macro in).
    expect(report.closest!.depth).toBeGreaterThanOrEqual(1);
    expect(report.closest!.final.map).toBe("B");
    // It carries its own replayable witness.
    const replay = replayWitness(freshSession(project), project, report.closest!.witness);
    expect(replay.state.mapId).toBe("B");
    expect(Number(report.closest!.frames)).toBeGreaterThan(0);
  });

  test("a no-goal report's closest state replays through loadReplayFile", () => {
    // S1: a no-goal report's top-level closest is a lead worth re-verifying,
    // but --replay on the whole report used to exit 2 ("no goals section").
    // The closest now carries expectedHash/start so a fresh replay re-verifies
    // the lead from the same origin.
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B", [touchEvent("door", 2, 2, "C")]),
      grassMap("C"),
    ]);
    const report = checkReach(project, { maxStates: 1 });
    expect(report.closest).toBeDefined();
    const closest = report.closest!;
    expect(closest.expectedHash).toBeDefined();
    const expectedHash = closest.expectedHash!;
    const dir = mkdtempSync(join(tmpdir(), "reach-closest-"));
    const path = join(dir, "report.json");
    writeFileSync(path, JSON.stringify(report));
    const file = loadReplayFile(path);
    expect(file.witness.masks.length).toBe(closest.witness.masks.length);
    expect(file.expectedHash).toBe(expectedHash);
    expect(file.targetMap).toBe("B");
    const verdict = replayReachWitness(project, file);
    expect(verdict.ok).toBe(true);
    expect(verdict.finalHash).toBe(expectedHash);
    expect(verdict.final.map).toBe("B");
  });

  test("a no-goal frame-budget stop with unfound maps reports a suggested budget", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 1 });
    expect(report.endedReason).toBe("frame-budget");
    expect(report.notFoundMaps).toEqual(["B"]);
    expect(report.suggestedBudget?.maxFrames).toBeGreaterThan(1);
    expect(report.closest).toBeDefined();
    const replay = replayWitness(freshSession(project), project, report.closest!.witness);
    expect(replay.state.mapId).toBe(report.closest!.final.map);
  });

  test("a no-goal run that finds every map carries no budget hint", () => {
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { maxFrames: 120000 });
    expect(report.endedReason).toBe("goals-met");
    expect(report.suggestedBudget).toBeUndefined();
    expect(report.closest).toBeUndefined();
  });

  test("a goal met on a map entered mid-macro counts that map as reached", () => {
    // S1: the goal parks the macro mid-ride (no leaf is produced), so the map
    // entry the driver observed was never flushed to the search — the report
    // proved a goal on a map it also listed as notFound. The combined witness
    // lands on that map, so the map counts as reached with that witness.
    const project = fixtureProject([
      grassMap("A", [touchEvent("door", 2, 2, "B")]),
      grassMap("B"),
    ]);
    const report = checkReach(project, { goals: ["map:B@0,0"], maxFrames: 120000 });
    expect(report.endedReason).toBe("goals-met");
    expect(report.goals?.status).toBe("met");
    expect(report.reachableMaps).toContain("B");
    expect(report.notFoundMaps).not.toContain("B");
    expect(
      report.findings.some((f) => f.check === "reach/map-not-found" && f.message.includes('"B"')),
    ).toBe(false);
    // The map's witness is the goal witness and replays onto B.
    const b = report.maps.find((m) => m.map === "B");
    expect(b?.status).toBe("reached");
    if (b && b.status === "reached") {
      const replay = replayWitness(freshSession(project), project, b.witness);
      expect(replay.state.mapId).toBe("B");
      expect(replay.finalHash).toBe(b.stateHash);
    }
  });

  test("a custom start's bank seeds the same fields as the engine's fresh playthrough", () => {
    // S2: reachStartSwitchState and the engine's startSession are two pieces
    // of code that must seed the same session fields. If the engine adds a
    // new seeded field, the helper must pick it up or a recorded witness
    // replays to a different hash. Compare the full SwitchState for a
    // project with every seedable field set.
    const project: Project = {
      ...fixtureProject([grassMap("A")]),
      playerName: "Red",
      initialGold: 42,
      system: { mapNameDisplay: true },
    };
    const engineSw = startSession(project, freshSession(project)).sw;
    // A custom start with no bank fields must seed exactly what the engine's
    // fresh playthrough does.
    const helperSw = reachStartSwitchState(project, {});
    expect(helperSw).toBeDefined();
    expect(helperSw!).toEqual(engineSw);
    // A custom start with bank fields keeps them and still carries the
    // project seeds.
    const banked = reachStartSwitchState(project, {
      switches: { done: true },
      variables: { count: 3 },
      items: { key: 1 },
      gold: 7,
    })!;
    expect(banked.switches).toEqual({ done: true });
    expect(banked.variables).toEqual({ count: 3 });
    expect(banked.items).toEqual({ key: 1 });
    expect(banked.gold).toBe(7);
    expect(banked.playerName).toBe("Red");
    expect(banked.mapNameDisplay).toBe(true);
  });
});

// --- witness replay ----------------------------------------------------------------
//
// `reach --replay` (and the rpgkit-reach-replay tool) independently re-verifies
// a recorded witness: the tape is replayed in a fresh session and must land on
// the recorded state hash, and every goal the witness carries must re-evaluate
// on the replayed final state.

describe("rpgkit-check reach: witness replay", () => {
  const goalProject = (): Project => fixtureProject([
    grassMap("A", [
      actionEvent("chest", 2, 2, [
        { op: "switch", id: "done", value: true },
        { op: "text", lines: ["Done."] },
      ]),
    ]),
  ]);

  function writeTmp(name: string, body: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "reach-replay-"));
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body));
    return path;
  }

  test("a met report replays and re-verifies its goals", () => {
    const project = goalProject();
    const report = checkReach(project, { goals: ["switch:done=true"] });
    expect(report.goals?.status).toBe("met");
    const path = writeTmp("report.json", report);
    const file = loadReplayFile(path);
    const verdict = replayReachWitness(project, file);
    expect(verdict.ok).toBe(true);
    expect(verdict.final.switches).toMatchObject({ done: true });
    expect(verdict.goals).toEqual([{ goal: "switch:done=true", ok: true }]);
  });

  test("a tampered witness fails the hash check", () => {
    const project = goalProject();
    const report = checkReach(project, { goals: ["switch:done=true"] });
    // Append a second of held LEFT: the replay walks off the recorded final
    // tile and lands on a different state.
    const masks = [...report.goals!.witness!.masks, ...new Array<number>(60).fill(0x0080)];
    const path = writeTmp("bare.json", {
      hz: 60,
      masks,
      expectedHash: report.goals!.expectedHash,
      goals: ["switch:done=true"],
    });
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("hash");
  });

  test("a witness whose goal no longer holds fails the goal check", () => {
    const project = goalProject();
    const report = checkReach(project, { goals: ["switch:done=true"] });
    // Re-verify against a DIFFERENT goal the recorded state does not satisfy.
    const path = writeTmp("bare.json", {
      hz: 60,
      masks: report.goals!.witness!.masks,
      expectedHash: report.goals!.expectedHash,
      goals: ["switch:other=true"],
    });
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("switch:other=true");
    expect(verdict.goals).toEqual([{ goal: "switch:other=true", ok: false }]);
  });

  test("a report without a goals section is a usage error", () => {
    const project = goalProject();
    const report = checkReach(project); // no goals
    const path = writeTmp("plain.json", report);
    expect(() => loadReplayFile(path)).toThrow(/no goals section/);
  });

  test("a witness recorded from a custom start replays from that start", () => {
    // The goal holds at the custom start itself (a switch in the start bank);
    // the witness is empty, but the replay must still seed the bank and the
    // start position, not the project's default start. The project carries
    // initialGold, which the replay must also seed (an unspecified gold
    // falls back to the project's initialGold, not 0).
    const project = { ...goalProject(), initialGold: 500 };
    const report = checkReach(project, {
      start: { map: "A", x: 3, y: 3, dir: "up", switches: { done: true } },
      goals: ["switch:done=true"],
    });
    expect(report.endedReason).toBe("goals-met");
    expect(report.goals!.start).toMatchObject({ map: "A", x: 3, y: 3, switches: { done: true } });
    const path = writeTmp("report.json", report);
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(true);
    expect(verdict.final.map).toBe("A");
    expect(verdict.final.x).toBe(3);
    expect(verdict.final.y).toBe(3);
    expect(verdict.final.switches).toMatchObject({ done: true });
    expect(verdict.final.gold).toBe(500);
  });

  // B1: the replay evaluates the SAME goal expression the search did —
  // any/all and nested combinators included. The old replay required every
  // leaf goal to hold, so a legal any-mode witness was judged a failure.
  const lootProject = (): Project => fixtureProject([
    grassMap("A", [
      actionEvent("chest", 2, 2, [
        { op: "switch", id: "done", value: true },
        { op: "gold", set: "add", amount: 10 },
        { op: "text", lines: ["Loot."] },
      ]),
    ]),
  ]);

  test("an any-mode witness replays and re-verifies under any semantics", () => {
    const project = lootProject();
    const report = checkReach(project, {
      goals: ["switch:impossible=true", "gold>=10"],
      goalMode: "any",
    });
    expect(report.endedReason).toBe("goals-met");
    expect(report.goals?.status).toBe("met");
    // The report records the effective combinator and the canonical expr.
    expect(report.goals?.mode).toBe("any");
    expect(report.goals?.expr).toBe("any(switch:impossible=true, gold>=10)");
    const path = writeTmp("any-report.json", report);
    const verdict = replayReachWitness(project, loadReplayFile(path));
    // The old replay failed here ("goals not all met: switch:impossible").
    expect(verdict.ok).toBe(true);
    // The per-leaf breakdown still shows which leaf carried the witness.
    expect(verdict.goals).toEqual([
      { goal: "switch:impossible=true", ok: false },
      { goal: "gold>=10", ok: true },
    ]);
  });

  test("a nested combinator witness replays under the nested semantics", () => {
    const project = lootProject();
    // A single any(...) goal string is an any-expression even though the
    // --goal-mode option defaults to all.
    const report = checkReach(project, {
      goals: ["any(switch:impossible=true, all(switch:done=true, gold>=10))"],
    });
    expect(report.endedReason).toBe("goals-met");
    expect(report.goals?.mode).toBe("any");
    expect(report.goals?.expr).toBe("any(switch:impossible=true, all(switch:done=true, gold>=10))");
    const path = writeTmp("nested-report.json", report);
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(true);
    expect(verdict.goals?.map((r) => r.ok)).toEqual([false, true, true]);
  });

  test("a bare witness with an expr string re-verifies under it", () => {
    const project = lootProject();
    const report = checkReach(project, { goals: ["switch:done=true"] });
    const path = writeTmp("bare-expr.json", {
      hz: 60,
      masks: report.goals!.witness!.masks,
      expectedHash: report.goals!.expectedHash,
      expr: "any(switch:impossible=true, switch:done=true)",
    });
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(true);
  });

  test("an any-mode witness whose goals all fail on replay fails", () => {
    const project = goalProject();
    const report = checkReach(project, { goals: ["switch:done=true"] });
    const path = writeTmp("any-fail.json", {
      hz: 60,
      masks: report.goals!.witness!.masks,
      expectedHash: report.goals!.expectedHash,
      expr: "any(switch:other=true, switch:nope=true)",
    });
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("switch:other=true");
    expect(verdict.reason).toContain("switch:nope=true");
  });

  // B2: a custom start with NO bank fields must still replay identically.
  // The search built its bank without the project's playerName/mapNameDisplay
  // while the replay took the engine's fresh-playthrough path (which seeds
  // them), so the hash mismatched on any project that sets either field —
  // real Tuxemon projects set playerName.
  const namedProject = (system?: Project["system"]): Project => ({
    ...lootProject(),
    playerName: "Red",
    ...(system ? { system } : {}),
  });

  test("a bank-less custom start replays identically when the project sets playerName", () => {
    const project = namedProject();
    // A map entrance: custom position, no switches/variables/items/gold.
    const report = checkReach(project, {
      start: { map: "A", x: 1, y: 1 },
      goals: ["switch:done=true"],
    });
    expect(report.endedReason).toBe("goals-met");
    expect(report.goals!.start).toMatchObject({ map: "A", x: 1, y: 1 });
    expect(report.goals!.start).not.toHaveProperty("switches");
    const path = writeTmp("named-start.json", report);
    const verdict = replayReachWitness(project, loadReplayFile(path));
    // The old replay failed here (hash mismatch: 5bb128a9 != 165febad).
    expect(verdict.ok).toBe(true);
    expect(verdict.finalHash).toBe(report.goals!.expectedHash!);
    // The replay really carries the project's session field.
    expect(verdict.final.switches).toMatchObject({ done: true });
  });

  test("a bank-less custom start replays identically with mapNameDisplay on", () => {
    const project = namedProject({ mapNameDisplay: true });
    const report = checkReach(project, {
      start: { map: "A", x: 1, y: 1 },
      goals: ["switch:done=true"],
    });
    expect(report.endedReason).toBe("goals-met");
    const path = writeTmp("banner-start.json", report);
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(true);
    expect(verdict.finalHash).toBe(report.goals!.expectedHash!);
  });

  test("a bank-less custom start from the project's own entrance replays identically", () => {
    // The Tuxemon retest shape: start at the map entrance (the project's own
    // start coordinates, no bank), witness a switch goal, replay hash-equal.
    const project = namedProject({ mapNameDisplay: true });
    const report = checkReach(project, {
      start: { map: "A", x: 0, y: 0 },
      goals: ["switch:done=true"],
    });
    expect(report.endedReason).toBe("goals-met");
    const path = writeTmp("entrance-start.json", report);
    const verdict = replayReachWitness(project, loadReplayFile(path));
    expect(verdict.ok).toBe(true);
    expect(verdict.finalHash).toBe(report.goals!.expectedHash!);
  });
});
