import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import { AttractController } from "../src/engine/attract.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import {
  cloneInterp,
  createInterpState,
  createSwitchState,
  createWorld,
  evalCondition,
  isWorldIdle,
  stepInterp,
  type InterpInput,
  type Modal,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  isSessionWorldIdle,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createSessionSnapshot, decodeSaveCode, encodeSaveCode } from "../src/engine/save.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { Command, GameEvent, MapDef, Project } from "../src/engine/types.ts";

const MAP_ID = "idle-map";

function map(events: GameEvent[] = []): MapDef {
  return {
    id: MAP_ID,
    name: "World idle fixture",
    width: 8,
    height: 8,
    sheets: ["plain"],
    ground: new Array(64).fill("plain.0"),
    events,
  };
}

function project(events: GameEvent[] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "World idle fixture",
    tileSize: 16,
    start: { map: MAP_ID, x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [{ id: "potion", name: "Potion", sprite: "plain.0", price: 10 }],
    maps: [map(events)],
  };
}

function page(
  trigger: GameEvent["pages"][number]["trigger"],
  commands: Command[],
  condition?: GameEvent["pages"][number]["condition"],
): GameEvent["pages"][number] {
  return { trigger, commands, ...(condition ? { condition } : {}) };
}

function event(id: string, pages: GameEvent["pages"]): GameEvent {
  return { id, x: 6, y: 6, pages };
}

const interpInput = (worldIdleBlockers?: InterpInput["worldIdleBlockers"]): InterpInput => ({
  confirmEdge: false,
  cancelEdge: false,
  upEdge: false,
  downEdge: false,
  playerCell: { x: 2, y: 2 },
  prevCell: { x: 2, y: 2 },
  facing: 0,
  worldIdleBlockers,
});

const sessionStep = (session: Session, state: SessionState, confirmEdge = false): SessionState =>
  stepSession(session, state, { buttons: 0, confirmEdge });

describe("worldIdle derived predicate", () => {
  test("compiles live idle context only for maps that read it", () => {
    expect(createWorld(map()).needsWorldIdleContext).toBe(false);

    const pageWorld = createWorld(map([event("page", [page(
      "action",
      [],
      { all: [{ kind: "worldIdle" }] },
    )])]));
    expect(pageWorld.needsWorldIdleContext).toBe(true);

    const branchWorld = createWorld(map([event("branch", [page("action", [{
      op: "if",
      if: { kind: "worldIdle", negate: true },
      then: [],
    }])])]));
    expect(branchWorld.needsWorldIdleContext).toBe(true);
  });

  test("condition and negate use a supplied point-in-time value", () => {
    const sw = createSwitchState();
    expect(evalCondition({ kind: "worldIdle" }, sw, "idle-map/test")).toBe(false);
    expect(evalCondition(
      { kind: "worldIdle" }, sw, "idle-map/test", undefined, undefined, { worldIdle: true },
    )).toBe(true);
    expect(evalCondition(
      { kind: "worldIdle", negate: true }, sw, "idle-map/test", undefined, undefined, { worldIdle: true },
    )).toBe(false);
    expect(evalCondition(
      { kind: "worldIdle", negate: true }, sw, "idle-map/test", undefined, undefined, { worldIdle: false },
    )).toBe(true);
  });

  test("each interpreter-owned blocker is false alone and true after release", () => {
    const idle = createInterpState();
    expect(isWorldIdle(idle)).toBe(true);

    const inputLock = cloneInterp(idle);
    inputLock.inputLocked = true;
    expect(isWorldIdle(inputLock)).toBe(false);
    inputLock.inputLocked = false;
    expect(isWorldIdle(inputLock)).toBe(true);

    const modals: Modal[] = [
      { kind: "text", fiber: "idle-map/p", lines: ["x"], total: 1, revealed: 0, complete: false },
      { kind: "choices", fiber: "idle-map/p", prompt: "?", options: ["a", "b"], index: 0, cancellable: false },
      {
        kind: "choices",
        fiber: "idle-map/p",
        prompt: "PARTY",
        options: ["A", "B"],
        keys: ["a", "b"],
        enabled: [true, false],
        index: 0,
        cancellable: true,
      },
      { kind: "shop", fiber: "idle-map/p", gold: 0, sell: false, stage: "buy", index: 0, rows: [{ kind: "leave" }] },
    ];
    for (const modal of modals) {
      const state = cloneInterp(idle);
      state.modal = modal;
      expect(isWorldIdle(state), `${modal.kind} modal blocks`).toBe(false);
      state.modal = null;
      expect(isWorldIdle(state), `${modal.kind} modal released`).toBe(true);
    }

    const transfer = cloneInterp(idle);
    transfer.pendingTransfer = {
      fiber: "idle-map/p", map: "elsewhere", x: 0, y: 0, dir: "keep", fadeFrames: 0,
    };
    expect(isWorldIdle(transfer)).toBe(false);
    transfer.pendingTransfer = null;
    expect(isWorldIdle(transfer)).toBe(true);

    const battle = cloneInterp(idle);
    battle.pendingBattles.push({ fiber: "idle-map/p", setup: null });
    expect(isWorldIdle(battle)).toBe(false);
    battle.pendingBattles = [];
    expect(isWorldIdle(battle)).toBe(true);

    const playerRoute = cloneInterp(idle);
    playerRoute.pendingMoveRoutes.push({
      fiber: "idle-map/p",
      target: "player",
      eventId: "p",
      route: { steps: ["moveDown"], repeat: false, skippable: true },
      wait: false,
    });
    expect(isWorldIdle(playerRoute)).toBe(false);
    playerRoute.pendingMoveRoutes = [];
    expect(isWorldIdle(playerRoute)).toBe(true);

    const npcRoute = cloneInterp(idle);
    npcRoute.pendingMoveRoutes.push({
      fiber: "idle-map/p",
      target: { event: "npc" },
      eventId: "npc",
      route: { steps: ["moveDown"], repeat: false, skippable: true },
      wait: false,
    });
    expect(isWorldIdle(npcRoute), "an NPC route does not take player control").toBe(true);

    const fatal = cloneInterp(idle);
    fatal.error = { kind: "content", message: "broken transfer" };
    expect(isWorldIdle(fatal)).toBe(false);
    delete fatal.error;
    expect(isWorldIdle(fatal)).toBe(true);
  });

  test("a blocking main fiber blocks, while a parallel fiber alone does not", () => {
    const mainWorld = createWorld(map([
      event("main", [
        page("autorun", [{ op: "wait", seconds: 1 }, { op: "switch", id: "main.done", value: true }]),
        page("action", [], { switch: "main.done" }),
      ]),
    ]));
    const main = stepInterp(mainWorld, createInterpState(), interpInput());
    expect(main.main).not.toBeNull();
    expect(isWorldIdle(main)).toBe(false);
    main.main = null;
    expect(isWorldIdle(main)).toBe(true);

    const parallelWorld = createWorld(map([
      event("parallel", [page("parallel", [{ op: "wait", seconds: 1 }])]),
    ]));
    const parallel = stepInterp(parallelWorld, createInterpState(), interpInput());
    expect(Object.keys(parallel.parallels)).toEqual([`${MAP_ID}/parallel`]);
    expect(isWorldIdle(parallel)).toBe(true);
  });

  test("session scene, fade, player route, and host menu blockers are derived and reversible", () => {
    const p = project();
    const session = createSession(p);
    const idle = startSession(p, session);
    expect(isSessionWorldIdle(idle)).toBe(true);

    const scene = structuredClone(idle);
    scene.scene = { kind: "battle", fiber: "idle-map/p", state: null, pausedTicks: 0 };
    expect(isSessionWorldIdle(scene)).toBe(false);
    scene.scene = null;
    expect(isSessionWorldIdle(scene)).toBe(true);

    const fade = structuredClone(idle);
    fade.fade = { phase: "out", left: 1, half: 1 };
    expect(isSessionWorldIdle(fade)).toBe(false);
    fade.fade = null;
    expect(isSessionWorldIdle(fade)).toBe(true);

    const route = structuredClone(idle);
    route.playerRoute = {
      steps: ["moveDown"], pc: 0, repeat: false, skippable: true,
      waiter: null, phase: 0, dir: 0, takeOver: false, plan: null, pathRetriesLeft: null,
    };
    expect(isSessionWorldIdle(route)).toBe(false);
    route.playerRoute = null;
    expect(isSessionWorldIdle(route)).toBe(true);

    expect(isSessionWorldIdle(idle, true), "host-owned menu open").toBe(false);
    expect(isSessionWorldIdle(idle, false), "host-owned menu closed").toBe(true);
  });
});

describe("worldIdle evaluation order", () => {
  test("a later branch sees an earlier parallel lock in the same tick", () => {
    const w = createWorld(map([
      event("a-lock", [page("parallel", [
        { op: "lockInput" },
        { op: "switch", id: "lock.done", value: true },
      ])]),
      event("z-observe", [page("parallel", [
        {
          op: "if",
          if: { kind: "worldIdle" },
          then: [{ op: "switch", id: "saw.idle", value: true }],
          else: [{ op: "switch", id: "saw.busy", value: true }],
        },
      ])]),
    ]));
    const state = stepInterp(w, createInterpState(), interpInput());
    expect(state.sw.switches["saw.busy"]).toBe(true);
    expect(state.sw.switches["saw.idle"]).toBeUndefined();
  });

  test("page conditions sample before fibers run; an unlock becomes visible next tick", () => {
    const w = createWorld(map([
      event("a-unlock", [
        page("parallel", [
          { op: "unlockInput" },
          { op: "switch", id: "unlock.done", value: true },
        ]),
        page("action", [], { switch: "unlock.done" }),
      ]),
      event("z-gated", [
        page("autorun", [{ op: "switch", id: "gated.started", value: true }], {
          all: [{ kind: "worldIdle" }],
        }),
        page("action", [], { switch: "gated.started" }),
      ]),
    ]));
    const initial = createInterpState();
    initial.inputLocked = true;

    const unlockTick = stepInterp(w, initial, interpInput());
    expect(unlockTick.inputLocked).toBe(false);
    expect(unlockTick.sw.switches["gated.started"]).toBeUndefined();

    const nextTick = stepInterp(w, unlockTick, interpInput());
    expect(nextTick.sw.switches["gated.started"]).toBe(true);
  });
});

const loseOnConfirm: BattleRules = {
  start(ext) {
    return { ext, state: { done: false } };
  },
  step(raw, input) {
    const state = raw as { done: boolean };
    return { done: state.done || input.confirmEdge === true };
  },
  done(raw) {
    return (raw as { done: boolean }).done ? { ext: null, result: "lose" } : null;
  },
};

function lockedBattleProject(): Project {
  return project([
    event("a-cutscene", [
      page("autorun", [
        { op: "lockInput" },
        {
          op: "battle",
          setup: { opponent: "fixture" },
          onLose: [{ op: "switch", id: "battle.lost", value: true }],
        },
        { op: "wait", seconds: 1 },
        { op: "switch", id: "post.one", value: true },
        { op: "wait", seconds: 1 },
        { op: "switch", id: "post.two", value: true },
        { op: "unlockInput" },
        { op: "switch", id: "cutscene.unlocked", value: true },
        { op: "switch", id: "cutscene.done", value: true },
      ]),
      page("action", [], { switch: "cutscene.done" }),
    ]),
    event("z-global", [
      page("autorun", [
        {
          op: "if",
          if: { kind: "switch", id: "cutscene.unlocked" },
          then: [{ op: "switch", id: "global.safe", value: true }],
          else: [{ op: "switch", id: "global.premature", value: true }],
        },
        { op: "switch", id: "global.done", value: true },
      ], {
        all: [
          { kind: "switch", id: "battle.lost" },
          { kind: "worldIdle" },
        ],
      }),
      page("action", [], { switch: "global.done" }),
    ]),
  ]);
}

function runLockedBattle(hz: 60 | 30 | 20 | 4): {
  final: Record<string, boolean | undefined>;
  unlockTickHadGlobal?: boolean;
} {
  const p = lockedBattleProject();
  const session = createSession(p, hz, { battle: loseOnConfirm });
  let state = startSession(p, session);
  for (let frame = 0; frame < 20 && state.scene === null; frame++) {
    state = sessionStep(session, state);
  }
  expect(state.scene, `battle entered at ${hz} Hz`).not.toBeNull();
  state = sessionStep(session, state, true);
  expect(state.scene, `battle completed at ${hz} Hz`).toBeNull();

  let unlockTickHadGlobal: boolean | undefined;
  for (let frame = 0; frame < hz * 5 && !state.sw.switches["global.done"]; frame++) {
    const wasUnlocked = state.sw.switches["cutscene.unlocked"] === true;
    state = sessionStep(session, state);
    if (!wasUnlocked && state.sw.switches["cutscene.unlocked"] === true) {
      unlockTickHadGlobal = state.sw.switches["global.done"] === true;
    }
    if (!state.sw.switches["cutscene.unlocked"]) {
      expect(state.sw.switches["global.done"], `not before unlock at ${hz} Hz`).toBeUndefined();
    }
  }

  return {
    final: {
      lost: state.sw.switches["battle.lost"],
      postOne: state.sw.switches["post.one"],
      postTwo: state.sw.switches["post.two"],
      unlocked: state.sw.switches["cutscene.unlocked"],
      safe: state.sw.switches["global.safe"],
      premature: state.sw.switches["global.premature"],
      done: state.sw.switches["global.done"],
      inputLocked: state.interp.inputLocked,
      sceneActive: state.scene !== null,
    },
    unlockTickHadGlobal,
  };
}

describe("locked battle narrative", () => {
  test("global autorun stays gated through battle and post-battle story until the tick after unlock", () => {
    const result = runLockedBattle(60);
    expect(result.unlockTickHadGlobal).toBe(false);
    expect(result.final).toEqual({
      lost: true,
      postOne: true,
      postTwo: true,
      unlocked: true,
      safe: true,
      premature: undefined,
      done: true,
      inputLocked: false,
      sceneActive: false,
    });
  });

  test("60/30/20/4 Hz reach the same guarded result", () => {
    const outcomes = ([60, 30, 20, 4] as const).map((hz) => runLockedBattle(hz).final);
    expect(outcomes).toEqual([outcomes[0], outcomes[0], outcomes[0], outcomes[0]]);
  });
});

describe("worldIdle format and save compatibility", () => {
  test("schema accepts page and branch forms, including negate, and rejects malformed negate", () => {
    const valid = project([
      event("schema", [page("parallel", [{
        op: "if",
        if: { kind: "worldIdle", negate: true },
        then: [{ op: "wait", seconds: 1 }],
      }], { all: [{ kind: "worldIdle" }] })]),
    ]);
    expect(validateSchema(schema, valid)).toEqual([]);

    const invalid = structuredClone(valid) as unknown as Record<string, unknown>;
    const maps = invalid.maps as Array<Record<string, unknown>>;
    const events = maps[0]!.events as Array<Record<string, unknown>>;
    const pages = events[0]!.pages as Array<Record<string, unknown>>;
    const condition = pages[0]!.condition as { all: Array<Record<string, unknown>> };
    condition.all[0]!.negate = "yes";
    expect(validateSchema(schema, invalid).some((error) => error.path.includes("condition.all[0]"))).toBe(true);
  });

  test("a saved parallel program containing worldIdle validates and round-trips", () => {
    const p = project([
      event("saved", [page("parallel", [
        {
          op: "if",
          if: { kind: "worldIdle" },
          then: [{ op: "switch", id: "save.idle", value: true }],
        },
        { op: "wait", seconds: 10 },
      ])]),
    ]);
    const session = createSession(p);
    const state = sessionStep(session, startSession(p, session));
    const snapshot = createSessionSnapshot(session, state, 0);
    const decoded = decodeSaveCode(encodeSaveCode(snapshot));
    expect(decoded).toEqual(snapshot);
    expect(decoded.interp.sw.switches["save.idle"]).toBe(true);
  });

  test("attract rewind re-derives worldIdle and refolds byte-identically", () => {
    const p = project([
      event("a-lock", [
        page("autorun", [
          { op: "lockInput" },
          { op: "wait", seconds: 3 / 60 },
          { op: "unlockInput" },
          { op: "switch", id: "lock.done", value: true },
        ]),
        page("action", [], { switch: "lock.done" }),
      ]),
      event("z-idle", [
        page("autorun", [{ op: "switch", id: "idle.done", value: true }], {
          all: [{ kind: "switch", id: "lock.done" }, { kind: "worldIdle" }],
        }),
        page("action", [], { switch: "idle.done" }),
      ]),
    ]);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 3 / 60,
    });
    controller.startPlay();
    const states = [structuredClone(controller.state)];
    for (let frame = 0; frame < 12; frame++) {
      controller.step(0);
      states.push(structuredClone(controller.state));
    }
    const final = structuredClone(controller.state);
    const length = controller.length;
    expect(final.sw.switches["idle.done"]).toBe(true);

    controller.step(0x0100); // L: transport only, no world frame folded.
    expect(controller.length).toBe(length - 3);
    expect(controller.state).toEqual(states[length - 3]);
    for (let frame = 0; frame < 3; frame++) controller.step(0);
    expect(controller.state).toEqual(final);
  });
});
