import { describe, expect, test } from "bun:test";
import { AttractController } from "../src/engine/attract.ts";
import { createJsonMapRepository, MapNotReadyError } from "../src/engine/map-repository.ts";
import { loadSession, saveSession } from "../src/engine/save-restore.ts";
import { canonicalJson } from "../src/engine/save.ts";
import {
  acquireSessionMap,
  createSession,
  prepareSessionMap,
  releaseSessionMapLayers,
  startSession,
  stepSession,
  type Session,
  type SessionOptions,
  type SessionState,
} from "../src/engine/session.ts";
import { createWorldHandoffResolver } from "../src/engine/world-handoff.ts";
import type { ExtensionOptions } from "../src/engine/extensions.ts";
import type { Command, GameEvent, JsonValue, Project } from "../src/engine/types.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import {
  autorunTransfer,
  CAPABILITY_EAST,
  handoffProject,
  HANDOFF_LAYOUT,
  markedTransfer,
  playerTouchTransfer,
  PORTAL_ONLY_EAST,
  SAFE_EAST,
  SAFE_SOUTH,
  SAFE_WEST,
} from "./fixtures/seamless-handoff/fixture-data.ts";

function runtime(
  project: Project,
  hz = 60,
  handoffCapability?: SessionOptions["handoffCapability"],
): { session: Session; state: SessionState } {
  const session = createSession(project, hz, {
    handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    handoffCapability,
  });
  return { session, state: startSession(project, session) };
}

function step(session: Session, state: SessionState, frames = 1): SessionState {
  let next = state;
  for (let frame = 0; frame < frames; frame++) {
    next = stepSession(session, next, { buttons: 0 });
  }
  return next;
}

function walkToPortal(session: Session, state: SessionState, buttons: number): SessionState {
  let next = state;
  for (let tick = 0; tick < 8; tick++) {
    next = stepSession(session, next, { buttons });
  }
  return next;
}

function autorun(commands: Command[], id = "script"): GameEvent {
  return { id, x: 0, y: 0, pages: [{ trigger: "autorun", commands }] };
}

function fatalParallel(waitFrames: number, kind: "invalid-variable" | "unknown-map"): GameEvent {
  const event = autorun([
    { op: "wait", seconds: waitFrames / 60 },
    {
      op: "transfer",
      map: kind === "invalid-variable" ? { variable: "missing.destination" } : "missing-map",
      x: 0,
      y: 0,
      dir: "keep",
    },
  ], `fatal-${kind}`);
  event.pages[0]!.trigger = "parallel";
  return event;
}

function normalizeHostFrame(state: SessionState): SessionState {
  return { ...state, frame: 0 };
}

describe("seamless-v1 opening handoff", () => {
  test("crosses a proven opening in one eight-reference-tick step and enters atomically", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "safe-east",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const { session } = runtime(project);
    let state = startSession(project, session);

    state = walkToPortal(session, state, 0x0020);
    expect(state.mapId).toBe("west");
    expect(state.handoff).toMatchObject({
      sourceMapId: "west",
      targetMapId: "east",
      sourceX: 3,
      sourceY: 1,
      targetX: 0,
      targetY: 1,
      direction: 3,
      phase: 0,
      totalTicks: 8,
    });
    expect(state.move).toMatchObject({ tx: 3, ty: 1, px: 48, py: 16, moving: true, phase: 0 });

    for (let phase = 1; phase < 8; phase++) {
      state = step(session, state);
      expect(state.mapId, `phase ${phase} owner`).toBe("west");
      expect(state.handoff?.phase, `phase ${phase}`).toBe(phase);
      expect(state.move.px, `phase ${phase} world progress`).toBe(48 + phase * 2);
      expect(state.move.py).toBe(16);
    }

    state = step(session, state);
    expect(state.mapId).toBe("east");
    expect(Object.prototype.hasOwnProperty.call(state, "handoff")).toBe(false);
    expect(state.move).toMatchObject({
      tx: 0,
      ty: 1,
      px: 0,
      py: 16,
      facing: 3,
      moving: false,
      phase: 0,
    });
    // west origin 0 + crossing endpoint 64px equals east origin 64px + local 0.
    expect(4 * 16 + state.move.px).toBe(64);
    expect(state.interp.frame).toBe(0);
    expect(Object.keys(state.chars.chars)).toHaveLength(0);
  });

  test("supports the independently proven reverse opening", () => {
    const project = handoffProject({
      start: { map: "east", x: 1, y: 1, dir: "left" },
      sourceEvent: playerTouchTransfer(
        "safe-west",
        0,
        1,
        markedTransfer("west", 3, 1, "left", SAFE_WEST),
      ),
    });
    const { session } = runtime(project);
    let state = walkToPortal(session, startSession(project, session), 0x0080);
    expect(state.handoff?.direction).toBe(1);
    state = step(session, state, 8);
    expect(state.mapId).toBe("west");
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([3, 1, 1]);
    expect(state.move.px).toBe(48);
  });

  test("lets an accepted crossing replace its fade but preserves the fade on legacy fallback", () => {
    const acceptedTransfer = {
      ...markedTransfer("east", 0, 1, "right", SAFE_EAST),
      fade: 0.2,
    };
    const acceptedProject = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("accepted-fade", 3, 1, acceptedTransfer),
    });
    const acceptedRuntime = runtime(acceptedProject);
    let accepted = walkToPortal(acceptedRuntime.session, acceptedRuntime.state, 0x0020);
    expect(accepted.handoff?.phase).toBe(0);
    expect(accepted.fade).toBeNull();
    accepted = step(acceptedRuntime.session, accepted, 8);
    expect(accepted.mapId).toBe("east");
    expect(accepted.fade).toBeNull();

    const rejectedTransfer = {
      ...markedTransfer("east", 1, 1, "right", SAFE_EAST),
      fade: 0.2,
    };
    const rejectedProject = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("rejected-fade", 3, 1, rejectedTransfer),
    });
    const rejectedRuntime = runtime(rejectedProject);
    let rejected = walkToPortal(rejectedRuntime.session, rejectedRuntime.state, 0x0020);
    expect(Object.hasOwn(rejected, "handoff")).toBe(false);
    expect(rejected.mapId).toBe("west");
    expect(rejected.fade).toEqual({ phase: "out", left: 6, half: 6 });
    rejected = step(rejectedRuntime.session, rejected, 5);
    expect(rejected.mapId).toBe("west");
    expect(rejected.fade).toEqual({ phase: "out", left: 1, half: 6 });
    rejected = step(rejectedRuntime.session, rejected);
    expect(rejected.mapId).toBe("east");
    expect(rejected.fade).toEqual({ phase: "in", left: 6, half: 6 });
    rejected = step(rejectedRuntime.session, rejected, 6);
    expect(rejected.fade).toBeNull();
  });

  test("matches legacy playerStep calls at the source edge without counting atomic target placement", () => {
    const hook: ExtensionOptions = {
      initial: { steps: 0 },
      commands: {
        "test.player_step": (context) => ({
          ext: { steps: (context.ext as { steps: number }).steps + 1 },
        }),
      },
      playerStep: { call: "test.player_step" },
    };
    const make = (traversal: Project["worldTraversal"]): Project => handoffProject({
      traversal,
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "step-parity",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const runRoute = (traversal: Project["worldTraversal"]) => {
      const project = make(traversal);
      const session = createSession(project, 60, {
        extensions: hook,
        handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
      });
      let state = startSession(project, session);
      const calls: { map: string; x: number; y: number }[] = [];
      let atSourceEdge: SessionState | undefined;
      for (let frame = 0; frame < 16; frame++) {
        const before = state;
        const previousSteps = (before.ext as { steps: number }).steps;
        state = stepSession(session, before, { buttons: frame < 8 ? 0x0020 : 0 });
        const nextSteps = (state.ext as { steps: number }).steps;
        if (nextSteps !== previousSteps) {
          const dx = [0, -1, 0, 1][before.move.stepDir]!;
          const dy = [1, 0, -1, 0][before.move.stepDir]!;
          calls.push({
            map: before.mapId,
            x: before.move.moving ? before.move.tx + dx : state.move.tx,
            y: before.move.moving ? before.move.ty + dy : state.move.ty,
          });
        }
        if (frame === 7) atSourceEdge = state;
      }
      return { calls, atSourceEdge: atSourceEdge!, state };
    };

    const legacy = runRoute("legacy-transfer");
    const seamless = runRoute("seamless-v1");
    const sourceEdgeCall = [{ map: "west", x: 3, y: 1 }];
    expect(legacy.calls).toEqual(sourceEdgeCall);
    expect(seamless.calls).toEqual(sourceEdgeCall);
    expect(legacy.atSourceEdge.mapId).toBe("east");
    expect(Object.hasOwn(legacy.atSourceEdge, "handoff")).toBe(false);
    expect(seamless.atSourceEdge.mapId).toBe("west");
    expect(seamless.atSourceEdge.handoff).toMatchObject({
      sourceMapId: "west",
      sourceX: 3,
      sourceY: 1,
      phase: 0,
    });
    expect(legacy.state.mapId).toBe("east");
    expect(seamless.state.mapId).toBe("east");
    expect(legacy.state.ext).toEqual({ steps: 1 });
    expect(seamless.state.ext).toEqual({ steps: 1 });
  });

  test("opted-in playerStep displacement reports the atomic handoff relocation", () => {
    const hook: ExtensionOptions = {
      initial: { movements: [] },
      commands: {
        "test.player_step": (context) => ({
          ext: {
            movements: [
              ...(context.ext as { movements: JsonValue[] }).movements,
              context.playerStep ? { ...context.playerStep } : null,
            ],
          },
        }),
      },
      playerStep: { call: "test.player_step", displacement: true },
    };
    const runRoute = (traversal: Project["worldTraversal"]) => {
      const project = handoffProject({
        traversal,
        start: { map: "west", x: 2, y: 1, dir: "right" },
        sourceEvent: playerTouchTransfer(
          "step-displacement",
          3,
          1,
          markedTransfer("east", 0, 1, "right", SAFE_EAST),
        ),
      });
      const session = createSession(project, 60, {
        extensions: hook,
        handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
      });
      let state = startSession(project, session);
      for (let frame = 0; frame < 16; frame++) {
        state = stepSession(session, state, { buttons: frame < 8 ? 0x0020 : 0 });
      }
      return state;
    };

    for (const traversal of ["legacy-transfer", "seamless-v1"] as const) {
      const state = runRoute(traversal);
      expect(state.mapId).toBe("east");
      expect(state.ext).toEqual({ movements: [
        { dx: 1, dy: 0, kind: "step" },
        { dx: -3, dy: 0, kind: "relocation" },
      ] });
    }
  });

  test("crosses a proven north-south opening", () => {
    const project = handoffProject({
      start: { map: "north", x: 1, y: 2, dir: "down" },
      sourceEvent: playerTouchTransfer(
        "safe-south",
        1,
        3,
        markedTransfer("west", 1, 0, "down", SAFE_SOUTH),
      ),
    });
    const { session } = runtime(project);
    let state = walkToPortal(session, startSession(project, session), 0x0040);
    expect(state.handoff).toMatchObject({
      sourceMapId: "north",
      targetMapId: "west",
      direction: 0,
      sourceX: 1,
      sourceY: 3,
      targetX: 1,
      targetY: 0,
    });
    state = step(session, state, 8);
    expect(state.mapId).toBe("west");
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([1, 0, 0]);
  });

  const fallbackCases = [
    ["project mode omitted", undefined, "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 1, "right", SAFE_EAST)],
    ["command marker omitted", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, { op: "transfer", map: "east", x: 0, y: 1, dir: "right" }],
    ["portal-only opening", "seamless-v1", "west", 2, 2, "right", 3, 2, 0x0020, markedTransfer("east", 0, 2, "right", PORTAL_ONLY_EAST)],
    ["wrong portal provenance", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 1, "right", "missing")],
    ["wrong landing", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 2, "right", SAFE_EAST)],
    ["wrong direction", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 0, 1, "left", SAFE_EAST)],
    ["wrong player facing", "seamless-v1", "west", 3, 0, "down", 3, 1, 0x0040, markedTransfer("east", 0, 1, "right", SAFE_EAST)],
    ["source outside the opening span", "seamless-v1", "west", 2, 0, "right", 3, 0, 0x0020, markedTransfer("east", 0, 0, "right", SAFE_EAST)],
    ["direction alone without opening geometry", "seamless-v1", "west", 0, 3, "right", 1, 3, 0x0020, markedTransfer("east", 0, 0, "right", SAFE_EAST)],
    ["world-space gap", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, markedTransfer("east", 1, 1, "right", SAFE_EAST)],
    ["unplaced indoor story transfer", "seamless-v1", "west", 2, 1, "right", 3, 1, 0x0020, { op: "transfer", map: "indoor", x: 2, y: 2, dir: "up" }],
  ] satisfies readonly (readonly [
    string,
    Project["worldTraversal"] | undefined,
    string,
    number,
    number,
    "up" | "down" | "left" | "right",
    number,
    number,
    number,
    Extract<Command, { op: "transfer" }> & { map: string; x: number; y: number },
  ])[];

  test.each(fallbackCases)("falls back to legacy for %s", (
    _name, traversal, sourceMap, startX, startY, startDir, eventX, eventY, buttons, command,
  ) => {
    const project = handoffProject({
      start: { map: sourceMap, x: startX, y: startY, dir: startDir },
      traversal,
      sourceEvent: playerTouchTransfer("fallback", eventX, eventY, command),
    });
    if (traversal === undefined) delete project.worldTraversal;
    const { session } = runtime(project);
    const state = walkToPortal(session, startSession(project, session), buttons);
    expect(Object.prototype.hasOwnProperty.call(state, "handoff")).toBe(false);
    expect(state.mapId).toBe(command.map);
    expect([state.move.tx, state.move.ty]).toEqual([command.x, command.y]);
  });

  test("requires open authored target passage before starting the crossing", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "blocked-target",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    project.maps.find((map) => map.id === "east")!.passage = [[4, "block"]];
    const { session } = runtime(project);
    const state = walkToPortal(session, startSession(project, session), 0x0020);
    expect(state.mapId).toBe("east");
    expect(Object.hasOwn(state, "handoff")).toBe(false);
  });

  test("lets a trusted opening capability relax only target solid terrain", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "surf-target",
        3,
        1,
        markedTransfer("east", 0, 1, "right", CAPABILITY_EAST),
      ),
    });
    project.maps.find((map) => map.id === "east")!.passage = [[4, "block"]];
    const calls: Array<{ capability: string; mapId: string }> = [];
    const capable = runtime(project, 60, (capability, state) => {
      calls.push({ capability, mapId: state.mapId });
      return capability === "surf";
    });
    const state = walkToPortal(capable.session, capable.state, 0x0020);
    expect(state.handoff).toMatchObject({
      portalId: CAPABILITY_EAST,
      sourceMapId: "west",
      targetMapId: "east",
      phase: 0,
      totalTicks: 8,
    });
    expect(calls).toEqual([{ capability: "surf", mapId: "west" }]);
  });

  test("keeps solid terrain blocking when the capability is absent or refused", () => {
    const make = () => {
      const project = handoffProject({
        start: { map: "west", x: 2, y: 1, dir: "right" },
        sourceEvent: playerTouchTransfer(
          "surf-target",
          3,
          1,
          markedTransfer("east", 0, 1, "right", CAPABILITY_EAST),
        ),
      });
      project.maps.find((map) => map.id === "east")!.passage = [[4, "block"]];
      return project;
    };
    for (const callback of [undefined, () => false] as const) {
      const run = runtime(make(), 60, callback);
      const state = walkToPortal(run.session, run.state, 0x0020);
      expect(state.mapId).toBe("east");
      expect(Object.hasOwn(state, "handoff")).toBe(false);
    }
  });

  test("requires the opening capability even when its target terrain is ordinarily passable", () => {
    const make = () => handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "surf-passable-target",
        3,
        1,
        markedTransfer("east", 0, 1, "right", CAPABILITY_EAST),
      ),
    });
    for (const callback of [undefined, () => false] as const) {
      const run = runtime(make(), 60, callback);
      const state = walkToPortal(run.session, run.state, 0x0020);
      expect(state.mapId).toBe("east");
      expect(Object.hasOwn(state, "handoff")).toBe(false);
    }

    const capable = runtime(make(), 60, () => true);
    expect(walkToPortal(capable.session, capable.state, 0x0020).handoff?.phase).toBe(0);
  });

  test("never lets a capability bypass source exit, target entry or target body blockers", () => {
    const make = () => {
      const project = handoffProject({
        start: { map: "west", x: 2, y: 1, dir: "right" },
        sourceEvent: playerTouchTransfer(
          "surf-target",
          3,
          1,
          markedTransfer("east", 0, 1, "right", CAPABILITY_EAST),
        ),
      });
      project.maps.find((map) => map.id === "east")!.passage = [[4, "block"]];
      return runtime(project, 60, () => true);
    };
    const cases = [
      {
        name: "source exit",
        block: (session: Session) => { session.tables.get("west")!.exitMask[7] = 8; },
      },
      {
        name: "target entry",
        block: (session: Session) => { session.tables.get("east")!.entryMask[4] = 2; },
      },
      {
        name: "target body",
        block: (session: Session) => {
          session.tables.get("east")!.bodyBlocks = new Set([4]);
        },
      },
    ] as const;
    for (const entry of cases) {
      const run = make();
      entry.block(run.session);
      const state = walkToPortal(run.session, run.state, 0x0020);
      expect(Object.hasOwn(state, "handoff"), entry.name).toBe(false);
      expect(state.mapId, entry.name).toBe("east");
    }
  });

  test("falls back when the real map dimensions disagree with the opening placement", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "wrong-size",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const east = project.maps.find((map) => map.id === "east")!;
    east.width = 5;
    east.ground = new Array(5 * east.height).fill("plain.0");
    const { session } = runtime(project);
    const state = walkToPortal(session, startSession(project, session), 0x0020);
    expect(state.mapId).toBe("east");
    expect(Object.hasOwn(state, "handoff")).toBe(false);
  });

  test("requires the authored source cell's exit edge to be open", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "blocked-source-exit",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    project.sheets.push({
      id: "source-exit",
      cols: 1,
      rows: 1,
      defaultPassage: "pass",
      dirEdges: { "0": { exit: ["right"] } },
    });
    const west = project.maps.find((map) => map.id === "west")!;
    west.sheets!.push("source-exit");
    west.ground[1 * west.width + 3] = "source-exit.0";
    const { session } = runtime(project);
    const state = walkToPortal(session, startSession(project, session), 0x0020);
    expect(state.mapId).toBe("east");
    expect(Object.hasOwn(state, "handoff")).toBe(false);
  });

  test("does not let a runtime tile override revoke immutable opening topology", () => {
    const portal = playerTouchTransfer(
      "runtime-source-exit",
      3,
      1,
      markedTransfer("east", 0, 1, "right", SAFE_EAST),
    );
    portal.pages[0]!.commands.unshift({ op: "tileProperty", x: 3, y: 1, exit: ["right"] });
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: portal,
    });
    const { session } = runtime(project);
    const state = walkToPortal(session, startSession(project, session), 0x0020);
    expect(state.interp.tileProperties?.["7"]?.exit).toEqual(["right"]);
    expect(state.handoff?.phase).toBe(0);
    expect(state.mapId).toBe("west");
  });

  test("requires a resolver bound to the project's topology identity", () => {
    const makeProject = () => handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "identity",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const noResolverProject = makeProject();
    const noResolverSession = createSession(noResolverProject);
    expect(walkToPortal(noResolverSession, startSession(noResolverProject, noResolverSession), 0x0020).mapId)
      .toBe("east");

    const noLayoutProject = makeProject();
    delete noLayoutProject.worldLayout;
    const noLayoutSession = createSession(noLayoutProject, 60, {
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    expect(walkToPortal(noLayoutSession, startSession(noLayoutProject, noLayoutSession), 0x0020).mapId)
      .toBe("east");

    const wrongTopologyProject = makeProject();
    wrongTopologyProject.worldLayout = {
      ...HANDOFF_LAYOUT,
      topologyHash: "e".repeat(64),
    };
    const wrongTopologySession = createSession(wrongTopologyProject, 60, {
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    expect(walkToPortal(wrongTopologySession, startSession(wrongTopologyProject, wrongTopologySession), 0x0020).mapId)
      .toBe("east");
  });

  test("pauses an async cold target and retries the same logical portal tick", async () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "async-safe",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.text]));
    const westEntry = split.shell.mapIndex.find((entry) => entry.id === "west")!.entry;
    const ready = new Set([westEntry]);
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => ready.has(entry) ? files.get(entry) : undefined,
      prepare: async (entry) => { ready.add(entry); },
    });
    const session = createSession(split.shell, 60, {
      maps: repository,
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    let state = startSession(split.shell, session);
    for (let tick = 0; tick < 7; tick++) {
      state = stepSession(session, state, { buttons: 0x0020 });
    }
    const before = canonicalJson(state);
    expect(() => stepSession(session, state, { buttons: 0x0020 })).toThrow(MapNotReadyError);
    expect(canonicalJson(state)).toBe(before);
    expect([...session.maps.keys()]).toEqual(["west"]);

    await prepareSessionMap(session, "east");
    state = stepSession(session, state, { buttons: 0x0020 });
    expect(state.handoff?.phase).toBe(0);
    expect(state.interp.frame).toBe(8);
    state = step(session, state, 8);
    expect(state.mapId).toBe("east");
    expect([...session.maps.keys()].sort()).toEqual(["east", "west"]);
  });

  test("does not flatten the connected-world parsed keep-set on commit", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "cache-safe",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
    });
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => {
        const meta = split.shell.mapIndex.find((candidate) => candidate.entry === entry);
        return meta ? files.get(meta.id) : undefined;
      },
    });
    const session = createSession(split.shell, 60, {
      maps: repository,
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    });
    let state = startSession(split.shell, session);
    acquireSessionMap(session, "east");
    acquireSessionMap(session, "north");
    // W3 keeps a visible-only map parsed while dropping its compiled layers.
    releaseSessionMapLayers(session, ["east", "north", "west"], ["east", "west"], "west");
    expect([...session.maps.keys()].sort()).toEqual(["east", "north", "west"]);
    expect(session.worlds.has("north")).toBe(false);
    expect(session.tables.has("north")).toBe(false);

    state = walkToPortal(session, state, 0x0020);
    expect(state.handoff?.phase).toBe(0);
    state = step(session, state, 8);
    expect(state.mapId).toBe("east");
    // Restoring the old flat release at the atomic commit deletes north and
    // makes this fail; only the cache driver knows the real working set.
    expect(session.maps.has("north")).toBe(true);
    expect(session.worlds.has("north")).toBe(false);
    expect(session.tables.has("north")).toBe(false);
  });

  test("does not reinterpret marked autorun, action, parallel, or nested-common transfers", () => {
    const command = () => markedTransfer("east", 0, 1, "right", SAFE_EAST);
    const cases: { name: string; event: GameEvent; input: { buttons: number; confirmEdge?: boolean } }[] = [
      { name: "autorun", event: autorunTransfer(command()), input: { buttons: 0 } },
      {
        name: "action",
        event: { id: "action", x: 3, y: 1, pages: [{ trigger: "action", commands: [command()] }] },
        input: { buttons: 0, confirmEdge: true },
      },
      {
        name: "parallel",
        event: { id: "parallel", x: 0, y: 0, pages: [{ trigger: "parallel", commands: [command()] }] },
        input: { buttons: 0 },
      },
    ];
    for (const entry of cases) {
      const project = handoffProject({ sourceEvent: entry.event });
      const { session, state } = runtime(project);
      const transferred = stepSession(session, state, entry.input);
      expect(transferred.mapId, entry.name).toBe("east");
      expect(Object.hasOwn(transferred, "handoff"), entry.name).toBe(false);
    }

    const nested = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: {
        id: "nested",
        x: 3,
        y: 1,
        pages: [{ trigger: "playerTouch", commands: [{ op: "common", id: "portal-common" }] }],
      },
    });
    nested.commonEvents = [{ id: "portal-common", trigger: "none", commands: [command()] }];
    const nestedRuntime = runtime(nested);
    const nestedState = walkToPortal(nestedRuntime.session, nestedRuntime.state, 0x0020);
    expect(nestedState.mapId).toBe("east");
    expect(Object.hasOwn(nestedState, "handoff")).toBe(false);
  });

  test("keeps source runtime as the sole owner and starts target pages one tick after entry", () => {
    const sourceParallel = autorun([
      { op: "variable", id: "source.ticks", set: { op: "add", value: 1 } },
    ], "source-parallel");
    sourceParallel.pages[0]!.trigger = "parallel";
    const targetAutorun = autorun([
      { op: "switch", id: "target.autorun", value: true },
      { op: "wait", seconds: 10 },
    ], "target-autorun");
    const targetParallel = autorun([
      { op: "switch", id: "target.parallel", value: true },
      { op: "wait", seconds: 10 },
    ], "target-parallel");
    targetParallel.pages[0]!.trigger = "parallel";
    targetParallel.pages[0]!.sprite = "npc";
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "safe-east",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
      mapEvents: {
        west: [sourceParallel],
        east: [targetAutorun, targetParallel],
      },
    });
    project.sprites = {
      npc: { kind: "image", src: "npc.png" },
    };
    const { session } = runtime(project);
    let state = walkToPortal(session, startSession(project, session), 0x0020);
    const sourceTicks = Number(state.sw.variables["source.ticks"]);
    expect(sourceTicks).toBe(8);
    expect(state.sw.switches["target.autorun"]).toBeUndefined();
    expect(state.sw.switches["target.parallel"]).toBeUndefined();
    for (let phase = 1; phase < 8; phase++) {
      state = step(session, state);
      expect(state.sw.variables["source.ticks"], `source phase ${phase}`).toBe(sourceTicks! + phase);
      expect(state.sw.switches["target.autorun"], `target autorun phase ${phase}`).toBeUndefined();
      expect(state.sw.switches["target.parallel"], `target parallel phase ${phase}`).toBeUndefined();
      expect(Object.keys(state.chars.chars)).toContain("source-parallel");
      expect(Object.keys(state.chars.chars)).not.toContain("target-parallel");
    }
    state = step(session, state);
    expect(state.mapId).toBe("east");
    expect(state.interp.frame).toBe(0);
    expect(Object.keys(state.chars.chars)).toEqual([]);
    expect(state.sw.switches["target.autorun"]).toBeUndefined();
    expect(state.sw.switches["target.parallel"]).toBeUndefined();
    expect(state.sw.variables["source.ticks"]).toBe(sourceTicks! + 8);

    state = step(session, state);
    expect(state.interp.frame).toBe(1);
    expect(state.sw.switches["target.autorun"]).toBe(true);
    expect(state.sw.switches["target.parallel"]).toBe(true);
    expect(Object.keys(state.chars.chars).sort()).toEqual(["target-autorun", "target-parallel"]);
  });

  test("reuses legacy map-entry cleanup and preserves transfer-safe screen/audio state", () => {
    const setup: Command[] = [
      { op: "variable", id: "local.visit", set: { op: "set", value: 9 } },
      { op: "switch", id: "local.flag", value: true },
      { op: "switch", id: "global.flag", value: true },
      { op: "playBgm", id: "route", volume: 73 },
      { op: "screenTint", layer: "night", color: { r: 5, g: 10, b: 30, a: 120 }, duration: 0 },
      { op: "screenFlash", color: { r: 255, g: 255, b: 255, a: 255 }, intensity: 255, duration: 5 },
      { op: "camera", target: { x: 1, y: 1 }, duration: 5 },
      {
        op: "moveRoute",
        target: "player",
        wait: false,
        route: { steps: ["moveUp"], repeat: false, skippable: false },
      },
    ];
    const make = (seamless: boolean): Project => {
      const project = handoffProject({
        start: { map: "west", x: 2, y: 1, dir: "right" },
        sourceEvent: {
          id: "entry-semantics",
          x: 3,
          y: 1,
          pages: [{
            trigger: "playerTouch",
            commands: [
              ...setup,
              seamless
                ? markedTransfer("east", 0, 1, "right", SAFE_EAST)
                : { op: "transfer", map: "east", x: 0, y: 1, dir: "right" },
            ],
          }],
        },
      });
      project.system = { ...project.system, transferPresentation: "retain" };
      return project;
    };

    const legacyProject = make(false);
    const legacyRuntime = runtime(legacyProject);
    const legacy = walkToPortal(legacyRuntime.session, legacyRuntime.state, 0x0020);
    const seamlessProject = make(true);
    const seamlessRuntime = runtime(seamlessProject);
    let seamless = walkToPortal(seamlessRuntime.session, seamlessRuntime.state, 0x0020);
    expect(seamless.playerRoute).not.toBeNull();
    seamless = step(seamlessRuntime.session, seamless, 8);

    for (const state of [legacy, seamless]) {
      expect(state.mapId).toBe("east");
      expect(state.move).toMatchObject({ tx: 0, ty: 1, facing: 3, moving: false, phase: 0 });
      expect(state.sw.variables["local.visit"]).toBeUndefined();
      expect(state.sw.switches["local.flag"]).toBeUndefined();
      expect(state.sw.switches["global.flag"]).toBe(true);
      expect(state.playerRoute).toBeNull();
      expect(Object.keys(state.chars.chars)).toEqual([]);
      expect(state.interp.main).toBeNull();
      expect(state.interp.frame).toBe(0);
      expect(state.interp.screen).toMatchObject({ tints: { night: { left: 0 } } });
      expect(state.interp.screen?.flash).toBeUndefined();
      expect(state.interp.screen?.camera).toMatchObject({
        mode: "fixed",
        toX: 24,
        toY: 24,
        total: 300,
      });
      expect(state.interp.audio?.bgm?.id).toBe("route");
    }
    expect(legacy.interp.screen?.camera?.left).toBe(300);
    expect(seamless.interp.screen?.camera?.left).toBe(292);
    expect(legacy.interp.audio?.bgm?.positionTicks).toBe(0);
    expect(seamless.interp.audio?.bgm?.positionTicks).toBe(8);
  });

  test("aborts mid-flight and completion-tick handoffs into the frozen source error state", () => {
    const cases = [
      { kind: "unknown-map", waitFrames: 10, lastSafePhase: 2, message: 'unknown map "missing-map"' },
      {
        kind: "invalid-variable",
        waitFrames: 15,
        lastSafePhase: 7,
        message: "map variable must hold a non-empty string",
      },
    ] as const;
    for (const scenario of cases) {
      const project = handoffProject({
        start: { map: "west", x: 2, y: 1, dir: "right" },
        sourceEvent: playerTouchTransfer(
          `fatal-handoff-${scenario.kind}`,
          3,
          1,
          markedTransfer("east", 0, 1, "right", SAFE_EAST),
        ),
        mapEvents: { west: [fatalParallel(scenario.waitFrames, scenario.kind)] },
      });
      const { session } = runtime(project);
      let state = walkToPortal(session, startSession(project, session), 0x0020);
      expect(state.handoff?.phase, scenario.kind).toBe(0);
      let lastSafePhase = 0;
      for (let guard = 0; !state.interp.error && guard < 8; guard++) {
        lastSafePhase = state.handoff?.phase ?? -1;
        state = step(session, state);
      }
      expect(lastSafePhase, scenario.kind).toBe(scenario.lastSafePhase);
      expect(state.interp.error, scenario.kind).toEqual({
        kind: "content",
        message: expect.stringContaining(scenario.message),
      });
      expect(state.mapId, scenario.kind).toBe("west");
      expect(Object.hasOwn(state, "handoff"), scenario.kind).toBe(false);
      expect(state.move, scenario.kind).toMatchObject({
        tx: 3,
        ty: 1,
        px: 48,
        py: 16,
        facing: 3,
        phase: 0,
        moving: false,
        walking: false,
      });
      const saving = saveSession(session, state, 0);
      expect(saving.ok, scenario.kind).toBe(false);
      if (!saving.ok) expect(saving.error.code, scenario.kind).toBe("not-safe-point");
      const frozen = step(session, state);
      expect(frozen.frame, scenario.kind).toBe(state.frame + 1);
      expect(frozen.mapId, scenario.kind).toBe(state.mapId);
      expect(frozen.interp, scenario.kind).toEqual(state.interp);
      expect(frozen.move, scenario.kind).toEqual(state.move);
      expect(Object.hasOwn(frozen, "handoff"), scenario.kind).toBe(false);
    }
  });

  test("folds the same virtual traversal at 20, 30 and 60 Hz", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("rates", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const states = ([20, 30, 60] as const).map((hz) => {
      const { session, state } = runtime(project, hz);
      const ticksPerFrame = 60 / hz;
      const movementFrames = Math.ceil(8 / ticksPerFrame);
      let next = state;
      for (let frame = 0; frame < hz; frame++) {
        next = stepSession(session, next, { buttons: frame < movementFrames ? 0x0020 : 0 });
      }
      return normalizeHostFrame(next);
    });
    expect(canonicalJson(states[1])).toBe(canonicalJson(states[0]));
    expect(canonicalJson(states[2])).toBe(canonicalJson(states[0]));
    expect(states[0]!.mapId).toBe("east");
    expect(states[0]!.interp.frame).toBe(44);
  });

  test("rejects every in-flight save, keeps the v1 shape, and resumes before and after the handoff", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("save", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const original = runtime(project);
    const before = saveSession(original.session, original.state, 0);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(Object.keys(before.snapshot).sort()).toEqual(["ext", "held", "interp", "map", "mapRuntime", "player"]);
    expect(canonicalJson(before.snapshot)).not.toContain("handoff");

    let state = walkToPortal(original.session, original.state, 0x0020);
    for (let phase = 0; phase < 8; phase++) {
      expect(state.handoff?.phase).toBe(phase);
      const saving = saveSession(original.session, state, 0);
      expect(saving.ok, `phase ${phase}`).toBe(false);
      if (!saving.ok) expect(saving.error.code).toBe("not-safe-point");
      state = step(original.session, state);
    }
    expect(state.mapId).toBe("east");
    expect(saveSession(original.session, state, 0).ok).toBe(true);

    const resumedRuntime = runtime(project);
    const loaded = loadSession(resumedRuntime.session, before.snapshot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(Object.hasOwn(loaded.state, "handoff")).toBe(false);
    let resumed = walkToPortal(resumedRuntime.session, loaded.state, 0x0020);
    resumed = step(resumedRuntime.session, resumed, 8);
    expect(canonicalJson(resumed)).toBe(canonicalJson(state));
  });

  test("rewinds through a mid-handoff keyframe and refolds byte-identically", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("rewind", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const tape = [...new Array<number>(8).fill(0x0020), ...new Array<number>(32).fill(0)];
    const options = {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 3 / 60,
      keyframeIntervalFrames: 1,
      worldTraversal: "seamless-v1" as const,
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    };
    const keyed = new AttractController(project, tape, options);
    const fromZero = new AttractController(project, tape, { ...options, keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    for (let frame = 0; frame < 15; frame++) {
      keyed.step(0);
      fromZero.step(0);
    }
    expect(keyed.state.handoff?.phase).toBe(7);
    keyed.step(0x0100);
    fromZero.step(0x0100);
    expect(keyed.length).toBe(12);
    expect(keyed.state.handoff?.phase).toBe(4);
    expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));
    for (let frame = 0; frame < 4; frame++) {
      keyed.step(0);
      fromZero.step(0);
      expect(canonicalJson(keyed.state), `refold suffix ${frame}`).toBe(canonicalJson(fromZero.state));
    }
    expect(keyed.state.mapId).toBe("east");
    expect(keyed.keyframeStats().lastRefoldStart).toBe(12);
  });

  test("forwards opening capabilities through attract playback and refolds", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "surf-attract",
        3,
        1,
        markedTransfer("east", 0, 1, "right", CAPABILITY_EAST),
      ),
    });
    project.maps.find((map) => map.id === "east")!.passage = [[4, "block"]];
    const tape = [...new Array<number>(8).fill(0x0020), ...new Array<number>(16).fill(0)];
    const controller = new AttractController(project, tape, {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      worldTraversal: "seamless-v1",
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
      handoffCapability: (capability) => capability === "surf",
      rewindSeconds: 3 / 60,
      keyframeIntervalFrames: 1,
    });
    controller.startAttract();
    for (let frame = 0; frame < 8; frame++) controller.step(0);
    expect(controller.state.handoff?.phase).toBe(0);
    for (let frame = 0; frame < 8; frame++) controller.step(0);
    expect(controller.state.mapId).toBe("east");
    controller.step(0x0100);
    expect(controller.state.handoff).toBeDefined();
  });

  test("rewinds before a source fatal and refolds to the same aborted handoff", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer(
        "fatal-rewind",
        3,
        1,
        markedTransfer("east", 0, 1, "right", SAFE_EAST),
      ),
      mapEvents: { west: [fatalParallel(15, "invalid-variable")] },
    });
    const tape = [...new Array<number>(8).fill(0x0020), ...new Array<number>(24).fill(0)];
    const options = {
      hz: 60,
      tapeHz: 60,
      idleFrames: 60_000,
      endHoldFrames: 60_000,
      rewindSeconds: 3 / 60,
      keyframeIntervalFrames: 1,
      worldTraversal: "seamless-v1" as const,
      handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
    };
    const keyed = new AttractController(project, tape, options);
    const fromZero = new AttractController(project, tape, { ...options, keyframeMaxBytes: 0 });
    keyed.startAttract();
    fromZero.startAttract();
    for (let frame = 0; frame < 16; frame++) {
      keyed.step(0);
      fromZero.step(0);
    }
    expect(keyed.state.interp.error?.kind).toBe("content");
    expect(Object.hasOwn(keyed.state, "handoff")).toBe(false);
    expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));

    keyed.step(0x0100);
    fromZero.step(0x0100);
    expect(keyed.state.handoff?.phase).toBe(5);
    expect(canonicalJson(keyed.state)).toBe(canonicalJson(fromZero.state));
    for (let frame = 0; frame < 3; frame++) {
      keyed.step(0);
      fromZero.step(0);
      expect(canonicalJson(keyed.state), `fatal refold suffix ${frame}`).toBe(canonicalJson(fromZero.state));
    }
    expect(keyed.state.interp.error?.kind).toBe("content");
    expect(keyed.state.mapId).toBe("west");
    expect(Object.hasOwn(keyed.state, "handoff")).toBe(false);
    expect(keyed.keyframeStats().lastRefoldStart).toBe(13);
  });

  test("a non-empty tape without traversal identity remains on the legacy timeline", () => {
    const project = handoffProject({
      start: { map: "west", x: 2, y: 1, dir: "right" },
      sourceEvent: playerTouchTransfer("tape", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    });
    const resolver = createWorldHandoffResolver(HANDOFF_LAYOUT);
    const tape = new Array<number>(8).fill(0x0020);
    const legacy = new AttractController(project, tape, {
      hz: 60,
      idleFrames: 60_000,
      handoff: resolver,
    });
    legacy.startAttract();
    for (let frame = 0; frame < 8; frame++) legacy.step(0);
    expect(legacy.state.mapId).toBe("east");
    expect(Object.hasOwn(legacy.state, "handoff")).toBe(false);

    const seamless = new AttractController(project, tape, {
      hz: 60,
      idleFrames: 60_000,
      worldTraversal: "seamless-v1",
      handoff: resolver,
    });
    seamless.startAttract();
    for (let frame = 0; frame < 8; frame++) seamless.step(0);
    expect(seamless.state.mapId).toBe("west");
    expect(seamless.state.handoff?.phase).toBe(0);
  });
});
