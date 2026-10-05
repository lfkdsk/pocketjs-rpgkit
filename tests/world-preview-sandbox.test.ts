// Neighbour character preview by sandboxed map entry. Pins that the sandbox
// sees characters placed by entry-time parallels (which the static preview
// must reject), that it never writes the live state, the live session's
// caches or its repository, that its probes and static rules reject what
// they cannot prove in a stable reason order, and that the cached reader
// invalidates on durable changes only and spreads its work over frames.

import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/engine/save.ts";
import { createSession, startSession, stepSession, type Session, type SessionState } from "../src/engine/session.ts";
import { selectWorldMapPreview } from "../src/engine/world-preview.ts";
import {
  createSandboxPreviewReader,
  createSandboxSession,
  holdSandboxMap,
  runSandboxEntry,
  SANDBOX_PREVIEW_REJECT_REASONS,
  SANDBOX_PREVIEW_STAMPED_CONTEXT,
  sandboxWorldMapPreview,
  summarizeSandboxPreviewCoverage,
  type SandboxPreviewOptions,
} from "../src/engine/world-preview-sandbox.ts";
import type { ExtensionReadContext } from "../src/engine/extensions.ts";
import type { GameEvent, JsonValue, Project } from "../src/engine/types.ts";
import type { SessionOptions } from "../src/engine/session.ts";
import { handoffProject } from "./fixtures/seamless-handoff/fixture-data.ts";

const IDLE = { buttons: 0, confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };

const spawned: GameEvent = {
  id: "a",
  x: 0,
  y: 0,
  pages: [
    { trigger: "action", commands: [] },
    {
      trigger: "action",
      commands: [],
      sprite: "a",
      dir: "left",
      condition: { variable: { id: "local.spawn", op: "==", value: 1 } },
    },
  ],
};
const spawner: GameEvent = {
  id: "spawn",
  x: 0,
  y: 3,
  pages: [{
    trigger: "parallel",
    condition: { variable: { id: "local.spawn", op: "==", value: 0 } },
    commands: [
      { op: "variable", id: "local.spawn", set: { op: "set", value: 1 } },
      { op: "place", target: { event: "a" }, x: 2, y: 1 },
    ],
  }],
};
const still: GameEvent = { id: "b", x: 3, y: 3, pages: [{ trigger: "action", commands: [], sprite: "b" }] };
const watcher: GameEvent = {
  id: "c",
  x: 1,
  y: 2,
  pages: [{ trigger: "action", commands: [], sprite: "c" }],
};
const turner: GameEvent = {
  id: "turn",
  x: 3,
  y: 0,
  pages: [{
    trigger: "parallel",
    condition: { variable: { id: "local.turned", op: "==", value: 0 } },
    commands: [
      { op: "variable", id: "local.turned", set: { op: "set", value: 1 } },
      { op: "moveRoute", target: { event: "c" }, route: { steps: ["turnTowardPlayer"], repeat: false, skippable: true } },
    ],
  }],
};
const dice: GameEvent = {
  id: "dice",
  x: 0,
  y: 1,
  pages: [{
    trigger: "parallel",
    condition: { variable: { id: "local.rolled", op: "==", value: 0 } },
    commands: [
      { op: "variable", id: "local.rolled", set: { op: "set", value: 1 } },
      { op: "variable", id: "roll", set: { op: "random", min: 0, max: 1000 } },
      {
        op: "if",
        if: { kind: "variable", id: "roll", op: ">=", value: 500 },
        then: [{ op: "place", target: { event: "d" }, x: 1, y: 0 }],
        else: [{ op: "place", target: { event: "d" }, x: 2, y: 0 }],
      },
    ],
  }],
};
const rolled: GameEvent = { id: "d", x: 3, y: 1, pages: [{ trigger: "action", commands: [], sprite: "d" }] };
/** Shown only at night: the game's clock lives in the extension state. */
const owl: GameEvent = {
  id: "owl",
  x: 4,
  y: 4,
  pages: [
    { trigger: "action", commands: [] },
    { trigger: "action", commands: [], sprite: "owl", condition: { all: [{ kind: "ext", call: "demo.night", args: null }] } },
  ],
};
/** Gated on a durable switch the west map can flip. */
const gated: GameEvent = {
  id: "g",
  x: 6,
  y: 1,
  pages: [
    { trigger: "action", commands: [] },
    { trigger: "action", commands: [], sprite: "g", condition: { switch: "open" } },
  ],
};

const go: GameEvent = {
  id: "go",
  x: 0,
  y: 0,
  pages: [
    { trigger: "action", commands: [] },
    {
      trigger: "autorun",
      condition: { switch: "go" },
      commands: [{ op: "transfer", map: "east", x: 0, y: 1, dir: "right" }],
    },
  ],
};

interface Clock {
  hour: number;
  steps: number;
}

const CLOCK_OPTIONS: SessionOptions = {
  immutableState: true,
  extensions: {
    initial: { hour: 12, steps: 0 },
    conditions: { "demo.night": (context) => (context.ext as unknown as Clock).hour >= 20 },
  },
};

function setup(events: GameEvent[], options: SessionOptions = { immutableState: true }, sourceEvent = go) {
  const project = handoffProject({ mapEvents: { east: events }, sourceEvent });
  const session = createSession(project, 60, options);
  let state: SessionState = startSession(project, session);
  state = stepSession(session, state, IDLE);
  return { project, session, state };
}

function sandboxFor(session: Session, ...mapIds: string[]): Session {
  const sandbox = createSandboxSession(session);
  for (const id of mapIds) holdSandboxMap(sandbox, session, session.maps.get(id)!);
  return sandbox;
}

function preview(session: Session, state: SessionState, options: SandboxPreviewOptions = {}) {
  return sandboxWorldMapPreview(sandboxFor(session, "east"), state, "east", options);
}

function withExt(state: SessionState, ext: JsonValue): SessionState {
  return { ...state, ext };
}

function withSwitch(state: SessionState, id: string, value: boolean): SessionState {
  const sw = { ...state.sw, switches: { ...state.sw.switches, [id]: value } };
  return { ...state, sw, interp: { ...state.interp, sw } };
}

function withVariable(state: SessionState, id: string, value: number): SessionState {
  const sw = { ...state.sw, variables: { ...state.sw.variables, [id]: value } };
  return { ...state, sw, interp: { ...state.interp, sw } };
}

function withSw(state: SessionState, patch: Partial<SessionState["sw"]>): SessionState {
  const sw = { ...state.sw, ...patch };
  return { ...state, sw, interp: { ...state.interp, sw } };
}

describe("sandboxed entry preview", () => {
  test("shows a character an entry-time parallel places, where the static preview rejects it", () => {
    const { session, state } = setup([spawned, spawner, still]);
    const map = session.maps.get("east")!;
    const fixed = selectWorldMapPreview(map, state.sw);
    expect(fixed.actors.map((actor) => actor.eventId)).toEqual(["b"]);
    expect(fixed.rejected).toEqual([{ eventId: "a", reason: "entry-actor-command" }]);

    const result = preview(session, state);
    expect(result.outcome).toBe("ok");
    expect(result.rejected).toEqual([]);
    expect(result.actors.map((actor) => [actor.eventId, actor.tx, actor.ty, actor.px, actor.py, actor.facing, actor.sprite]))
      .toEqual([
        ["a", 2, 1, 32, 16, 1, "a"],
        ["b", 3, 3, 48, 48, 0, "b"],
      ]);
    expect(result.hidden).toBe(1);
    expect(summarizeSandboxPreviewCoverage([result])).toMatchObject({ maps: 1, events: 3, previewed: 2, hidden: 1, rejected: 0 });
  });

  test("writes neither the live state, its records, the live session's caches nor its repository", () => {
    const { session, state: started } = setup([spawned, spawner, still, turner, watcher, dice, rolled]);
    // A per-visit id in the live bank: entry clears it in its own copy.
    const state = withVariable(started, "local.here", 7);
    const before = canonicalJson(state);
    const records = [state.sw.switches, state.sw.variables, state.sw.items, state.sw.self];
    const resident = [...session.maps.keys()];
    const worlds = [...session.worlds.values()];
    const sandbox = sandboxFor(session, "east");
    sandboxWorldMapPreview(sandbox, state, "east");
    runSandboxEntry(sandbox, state, "east", { x: 0, y: 0, facing: 0 }, { ticks: 120 });
    expect(canonicalJson(state)).toBe(before);
    expect([state.sw.switches, state.sw.variables, state.sw.items, state.sw.self]).toEqual(records);
    expect(state.sw.variables["local.here"]).toBe(7);
    expect([...session.maps.keys()]).toEqual(resident);
    expect([...session.worlds.values()]).toEqual(worlds);
    // The sandbox adopted the live compiled map instead of compiling again.
    expect(sandbox.worlds.get("east")).toBe(session.worlds.get("east"));
  });

  test("matches the first tick of a real entry", () => {
    const { session, state } = setup([spawned, spawner, still]);
    const run = runSandboxEntry(sandboxFor(session, "east"), state, "east", { x: 0, y: 1, facing: 3 });
    // Real entry through an immediate transfer, then one target tick.
    let real = stepSession(session, withSwitch(state, "go", true), IDLE);
    expect(real.mapId).toBe("east");
    real = stepSession(session, real, IDLE);
    const chars = Object.values(real.chars.chars)
      .filter((ch) => ch.visible && ch.id !== "spawn")
      .map((ch) => [ch.id, ch.tx, ch.ty, ch.px, ch.py, ch.facing]);
    expect(run.actors.map((actor) => [actor.eventId, actor.tx, actor.ty, actor.px, actor.py, actor.facing])).toEqual(
      chars.filter(([id]) => id === "a" || id === "b").sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  });

  test("rejects characters whose entry depends on the player or the random cursor", () => {
    const { session, state } = setup([still, turner, watcher, dice, rolled]);
    // The turn lands on the second target tick: the first-tick snapshot is
    // still exact, a later snapshot is not.
    const first = preview(session, state);
    expect(first.rejected).toEqual([{ eventId: "d", reason: "random-dependent" }]);
    const later = preview(session, state, { ticks: 4 });
    expect(later.actors.map((actor) => actor.eventId)).toEqual(["b"]);
    expect(later.rejected).toEqual([
      { eventId: "c", reason: "player-dependent" },
      { eventId: "d", reason: "random-dependent" },
    ]);
  });

  test("the game's perturbExt probe rejects characters that follow its volatile state", () => {
    const { session, state } = setup([still, owl], CLOCK_OPTIONS);
    const night = withExt(state, { hour: 22, steps: 0 });
    // Without the hook the clock dependence is invisible: the owl previews.
    expect(preview(session, night).actors.map((actor) => actor.eventId)).toEqual(["b", "owl"]);
    const perturbExt = (ext: JsonValue): JsonValue => {
      const value = ext as unknown as Clock;
      return { ...value, hour: (value.hour + 12) % 24 };
    };
    const hooked = preview(session, night, { perturbExt });
    expect(hooked.actors.map((actor) => actor.eventId)).toEqual(["b"]);
    expect(hooked.rejected).toEqual([{ eventId: "owl", reason: "volatile-dependent" }]);
    // By day the owl paints in the perturbed run only: still rejected.
    const day = withExt(state, { hour: 10, steps: 0 });
    expect(preview(session, day, { perturbExt }).rejected).toEqual([{ eventId: "owl", reason: "volatile-dependent" }]);
  });

  test("rejects the whole map when entry transfers away, even to a map the sandbox does not hold", () => {
    const leave: GameEvent = {
      id: "leave",
      x: 0,
      y: 0,
      pages: [{ trigger: "autorun", commands: [{ op: "transfer", map: "west", x: 1, y: 1 }] }],
    };
    const { session, state } = setup([leave, still]);
    const before = [...session.worlds.entries()];
    const result = preview(session, state);
    expect(result.outcome).toBe("entry-transfer");
    expect(result.actors).toEqual([]);
    expect(result.rejected).toEqual([{ eventId: "b", reason: "entry-transfer" }]);
    expect([...session.worlds.entries()]).toEqual(before);
  });

  test("an entry that starts a scene or fails rejects the map", () => {
    const fight: GameEvent = {
      id: "fight",
      x: 0,
      y: 0,
      pages: [{ trigger: "autorun", commands: [{ op: "battle", troop: "slime" } as never] }],
    };
    const battle = setup([fight, still], {
      immutableState: true,
      battle: {
        start: (ext: JsonValue) => ({ ext, state: 0 }),
        step: (state: JsonValue) => state,
        done: () => null,
      },
    });
    const scene = preview(battle.session, battle.state);
    expect(scene.outcome).toBe("entry-scene");
    expect(scene.rejected).toEqual([{ eventId: "b", reason: "entry-scene" }]);

    const broken: GameEvent = {
      id: "broken",
      x: 0,
      y: 0,
      pages: [{ trigger: "autorun", commands: [{ op: "ext", call: "demo.boom", args: null }] }],
    };
    const failing = setup([broken, still], {
      immutableState: true,
      extensions: { commands: { "demo.boom": () => { throw new Error("boom"); } } },
    });
    const error = preview(failing.session, failing.state);
    expect(error.outcome).toBe("entry-error");
    expect(error.rejected).toEqual([{ eventId: "b", reason: "entry-error" }]);
    expect(runSandboxEntry(sandboxFor(failing.session, "east"), failing.state, "east", { x: 0, y: 0, facing: 0 }).error)
      .toContain("boom");
  });

  test("reasons are reported in the documented order", () => {
    expect(SANDBOX_PREVIEW_REJECT_REASONS).toEqual([
      "duplicate-id",
      "entry-transfer",
      "entry-scene",
      "entry-error",
      "entry-runtime-branch",
      "facing-condition",
      "runtime-condition",
      "player-dependent",
      "random-dependent",
      "volatile-dependent",
    ]);
    // A duplicated id that is also random-dependent reports duplicate-id; a
    // facing-gated page above the winner reports facing-condition before the
    // probe differences.
    const twin: GameEvent = { ...rolled };
    const facing: GameEvent = {
      id: "f",
      x: 2,
      y: 2,
      pages: [
        { trigger: "action", commands: [], sprite: "f" },
        { trigger: "action", commands: [], sprite: "f2", condition: { all: [{ kind: "facing", dir: "left" }] } },
      ],
    };
    const { session, state } = setup([dice, rolled, twin, facing]);
    const verdict = preview(session, state);
    // Both copies of the duplicated id are rejected, so every event is
    // accounted for once.
    expect(verdict.rejected).toEqual([
      { eventId: "d", reason: "duplicate-id" },
      { eventId: "d", reason: "duplicate-id" },
      { eventId: "f", reason: "facing-condition" },
    ]);
    expect(verdict.actors.length + verdict.rejected.length + verdict.hidden).toBe(verdict.events);
    // Any autorun branching on the timer rejects every painting event.
    const timed: GameEvent = {
      id: "timed",
      x: 6,
      y: 6,
      pages: [{
        trigger: "parallel",
        commands: [{ op: "if", if: { kind: "timer", op: ">=", seconds: 1 } as never, then: [] }],
      }],
    };
    const branch = setup([timed, still]);
    expect(preview(branch.session, branch.state).rejected).toEqual([{ eventId: "b", reason: "entry-runtime-branch" }]);
  });

  test("a sandbox rejection the static preview can prove falls back to it", () => {
    const { session, state } = setup([still, dice, rolled]);
    const map = session.maps.get("east")!;
    const fallback = selectWorldMapPreview(map, state.sw);
    // The static rules reject d (an entry program places it); the walker b
    // is proven both ways and keeps its sandbox actor.
    expect(fallback.actors.map((actor) => actor.eventId)).toEqual(["b"]);
    const wander: GameEvent = { id: "w", x: 1, y: 3, pages: [{ trigger: "action", sprite: "w", moveType: "approach", commands: [] }] };
    const shaky = setup([still, wander]);
    const shakyMap = shaky.session.maps.get("east")!;
    // Probes near the map, so the walker heads for the player.
    const near: SandboxPreviewOptions = {
      ticks: 90,
      base: { x: -2, y: 0, facing: 0 },
      probes: [{ reason: "player-dependent", probe: { x: 6, y: 3, facing: 2 } }],
    };
    const plain = preview(shaky.session, shaky.state, near);
    expect(plain.rejected).toEqual([{ eventId: "w", reason: "player-dependent" }]);
    const merged = preview(shaky.session, shaky.state, { ...near, fallback: selectWorldMapPreview(shakyMap, shaky.state.sw) });
    expect(merged.rejected).toEqual([]);
    expect(merged.actors.map((actor) => [actor.eventId, actor.px, actor.py, actor.fallback ?? false])).toEqual([
      ["b", 48, 48, false],
      ["w", 16, 48, true],
    ]);
  });
});

describe("sandbox preview reader", () => {
  const perturbExt = (ext: JsonValue): JsonValue => {
    const value = ext as unknown as Clock;
    return { ...value, hour: (value.hour + 12) % 24 };
  };
  const previewKey = (ext: JsonValue): unknown => (ext as unknown as Clock).hour >= 20;

  function pumpAll(reader: ReturnType<typeof createSandboxPreviewReader>): number {
    let frames = 0;
    while (reader.stats.pending > 0 || frames === 0) {
      reader.pump();
      frames++;
      if (frames > 100) throw new Error("reader never settled");
    }
    return frames;
  }

  test("spreads one preview over frames, one unit per pump, then serves it by identity", () => {
    const { session, state: noon } = setup([spawned, spawner, still, owl], CLOCK_OPTIONS);
    const state = withExt(noon, { hour: 10, steps: 0 });
    const reader = createSandboxPreviewReader(session, { perturbExt, previewKey });
    const map = session.maps.get("east")!;
    reader.observe(state);
    expect(reader.read(map)).toBeUndefined();
    const before = reader.stats.probes;
    // Base + player + random + volatile probes: four frames.
    expect(reader.pump()).toBe(false);
    expect(reader.stats.probes - before).toBe(1);
    expect(reader.pump()).toBe(false);
    expect(reader.pump()).toBe(false);
    expect(reader.pump()).toBe(true);
    expect(reader.stats.compiles).toBe(0);
    const first = reader.read(map)!;
    expect(first.actors.map((actor) => actor.eventId)).toEqual(["a", "b"]);
    expect(first.rejected).toEqual([{ eventId: "owl", reason: "volatile-dependent" }]);
    // Twenty more frames of the live game: the same object, no more work.
    let live = state;
    for (let frame = 0; frame < 20; frame++) {
      live = stepSession(session, live, IDLE);
      reader.observe(live);
      expect(reader.read(map)).toBe(first);
      expect(reader.pump()).toBe(false);
    }
    expect(reader.stats.probes - before).toBe(4);
    expect(reader.stats.invalidations).toBe(1);
  });

  test("invalidates on a durable change only, keeping the old preview until the new one is complete", () => {
    const { session, state } = setup([still, gated, owl], CLOCK_OPTIONS);
    const reader = createSandboxPreviewReader(session, { perturbExt, previewKey });
    const map = session.maps.get("east")!;
    reader.observe(state);
    reader.read(map);
    pumpAll(reader);
    const closed = reader.read(map)!;
    expect(closed.actors.map((actor) => actor.eventId)).toEqual(["b"]);
    // Per-visit ids, the random cursor and ext parts outside previewKey: no
    // invalidation.
    const invalidations = reader.stats.invalidations;
    let next = withVariable(state, "local.anything", 3);
    next = { ...next, sw: { ...next.sw, rng: 99 }, interp: { ...next.interp, sw: { ...next.sw, rng: 99 } } };
    next = withExt(next, { hour: 13, steps: 40 });
    reader.observe(next);
    expect(reader.stats.invalidations).toBe(invalidations);
    expect(reader.read(map)).toBe(closed);
    // A durable switch: stale, still served, queued; replaced when done.
    const opened = withSwitch(next, "open", true);
    reader.observe(opened);
    expect(reader.stats.invalidations).toBe(invalidations + 1);
    expect(reader.read(map)).toBe(closed);
    // Queued by the read, in progress after the first pump.
    expect(reader.stats.pending).toBe(1);
    reader.pump();
    expect(reader.stats.pending).toBe(1);
    expect(reader.read(map)).toBe(closed);
    pumpAll(reader);
    expect(reader.read(map)!.actors.map((actor) => actor.eventId)).toEqual(["b", "g"]);
    // The previewKey sees nightfall.
    reader.observe(withExt(opened, { hour: 21, steps: 40 }));
    expect(reader.stats.invalidations).toBe(invalidations + 2);
  });

  test("restarts a job when durable state changes mid-way and never uses a mixed state", () => {
    const { session, state } = setup([still, gated]);
    const reader = createSandboxPreviewReader(session);
    const map = session.maps.get("east")!;
    reader.observe(state);
    reader.read(map);
    reader.pump();
    reader.observe(withSwitch(state, "open", true));
    reader.read(map);
    pumpAll(reader);
    expect(reader.stats.restarted).toBe(1);
    expect(reader.read(map)!.actors.map((actor) => actor.eventId)).toEqual(["b", "g"]);
  });

  test("compiles a parsed-only map as its own unit and trims what is no longer retained", () => {
    const { session, state } = setup([still]);
    const reader = createSandboxPreviewReader(session);
    // Pretend the live session holds east parsed only.
    const map = session.maps.get("east")!;
    const liveWorld = session.worlds.get("east")!;
    const liveTable = session.tables.get("east")!;
    session.worlds.delete("east");
    session.tables.delete("east");
    try {
      reader.observe(state);
      reader.read(map);
      // World, then passage table: two frames, no probe yet.
      reader.pump();
      expect(reader.stats.compiles).toBe(1);
      reader.pump();
      expect(reader.stats.compiles).toBe(2);
      expect(reader.stats.probes).toBe(0);
      pumpAll(reader);
      expect(reader.read(map)!.actors.map((actor) => actor.eventId)).toEqual(["b"]);
      expect(session.worlds.has("east")).toBe(false);
      expect(session.tables.has("east")).toBe(false);
      reader.retain(["west"]);
      expect(reader.read(map)).toBeUndefined();
    } finally {
      session.worlds.set("east", liveWorld);
      session.tables.set("east", liveTable);
    }
  });

  test("adopts a world the live prefetcher has staged instead of compiling it", () => {
    const { session, state } = setup([still]);
    const reader = createSandboxPreviewReader(session);
    const map = session.maps.get("east")!;
    const liveWorld = session.worlds.get("east")!;
    const liveTable = session.tables.get("east")!;
    session.worlds.delete("east");
    session.tables.delete("east");
    session.preparingMaps.set("east", { id: "east", map, world: liveWorld, table: liveTable });
    try {
      reader.observe(state);
      reader.read(map);
      pumpAll(reader);
      expect(reader.stats.compiles).toBe(0);
      expect(reader.read(map)!.actors.map((actor) => actor.eventId)).toEqual(["b"]);
    } finally {
      session.preparingMaps.delete("east");
      session.worlds.set("east", liveWorld);
      session.tables.set("east", liveTable);
    }
  });

  test("ignores maps the live session does not hold", () => {
    const { session, state } = setup([still]);
    const reader = createSandboxPreviewReader(session);
    const map = session.maps.get("east")!;
    reader.observe(state);
    session.maps.delete("east");
    try {
      reader.read(map);
      expect(reader.pump()).toBe(false);
      expect(reader.stats.pending).toBe(0);
    } finally {
      session.maps.set("east", map);
    }
  });
});

describe("sandbox hook isolation and the durable fingerprint", () => {
  interface Nested {
    hour: number;
    steps: number;
    party: { lead: string; list: number[] };
  }
  const nested = (): JsonValue => ({ hour: 22, steps: 0, party: { lead: "x", list: [1, 2] } });
  const NESTED_OPTIONS: SessionOptions = {
    immutableState: true,
    extensions: {
      initial: nested(),
      conditions: { "demo.night": (context) => (context.ext as unknown as Nested).hour >= 20 },
    },
  };

  function liveView(state: SessionState) {
    const ext = state.ext as unknown as Nested;
    return {
      json: canonicalJson(state),
      refs: [state.ext, ext.party, ext.party.list, state.sw, state.sw.switches, state.sw.variables, state.sw.items, state.sw.self],
    };
  }

  function expectUntouched(state: SessionState, before: ReturnType<typeof liveView>): void {
    const after = liveView(state);
    expect(after.json).toBe(before.json);
    expect(after.refs.length).toBe(before.refs.length);
    for (let i = 0; i < after.refs.length; i++) expect(after.refs[i]).toBe(before.refs[i]);
  }

  // Hooks that are legal by their types but write their argument in place.
  const writeThenReturnSame = (ext: JsonValue): JsonValue => {
    const value = ext as unknown as Nested;
    value.hour = 9;
    value.party.list.push(3);
    return ext;
  };
  const writeThenReturnNew = (ext: JsonValue): JsonValue => {
    const value = ext as unknown as Nested;
    value.hour = 9;
    value.party.lead = "y";
    return { ...value, alias: value.party } as unknown as JsonValue;
  };
  const keyWriteThenReturnSame = (ext: JsonValue): unknown => {
    const value = ext as unknown as Nested;
    value.hour = 1;
    value.party.list.length = 0;
    return ext;
  };
  const keyWriteThenReturnNew = (ext: JsonValue): unknown => {
    const value = ext as unknown as Nested;
    value.steps = 99;
    delete (value as Partial<Nested>).party;
    return value.hour >= 20;
  };

  for (const [label, perturbExt, previewKey] of [
    ["writes in place and returns the same object", writeThenReturnSame, keyWriteThenReturnSame],
    ["writes in place and returns a new object", writeThenReturnNew, keyWriteThenReturnNew],
  ] as const) {
    test(`a hook that ${label} never reaches the live session`, () => {
      const { session, state } = setup([still, owl, spawned, spawner], NESTED_OPTIONS);
      const before = liveView(state);
      const once = preview(session, state, { perturbExt });
      expectUntouched(state, before);
      runSandboxEntry(sandboxFor(session, "east"), state, "east", { x: 0, y: 0, facing: 0, perturbExt });
      expectUntouched(state, before);
      // The hook only ever saw a copy: the next preview sees the same night.
      expect(preview(session, state, { perturbExt })).toEqual(once);
      expect(once.rejected).toEqual([{ eventId: "owl", reason: "volatile-dependent" }]);

      const reader = createSandboxPreviewReader(session, { perturbExt, previewKey });
      const map = session.maps.get("east")!;
      let live = state;
      for (let frame = 0; frame < 12; frame++) {
        // A fresh ext identity every frame calls previewKey every frame.
        const next = withExt(live, { ...(live.ext as object), steps: frame } as unknown as JsonValue);
        const nextBefore = liveView(next);
        reader.observe(next);
        reader.read(map);
        reader.pump();
        expectUntouched(next, nextBefore);
        live = next;
      }
      expectUntouched(state, before);
      // A key returning its (fresh) argument never compares equal, so the
      // reader settles once the state stops changing.
      const settled = liveView(live);
      for (let frame = 0; frame < 20; frame++) {
        reader.read(map);
        reader.pump();
      }
      expectUntouched(live, settled);
      expect(reader.read(map)!.rejected).toEqual([{ eventId: "owl", reason: "volatile-dependent" }]);
    });
  }

  test("a perturbExt result the hook keeps and later writes does not reach the live session", () => {
    const { session, state } = setup([still, owl], NESTED_OPTIONS);
    const kept: Nested[] = [];
    const perturbExt = (ext: JsonValue): JsonValue => {
      const value = { ...(ext as unknown as Nested), hour: 10 };
      kept.push(value);
      return value as unknown as JsonValue;
    };
    const before = liveView(state);
    const result = preview(session, state, { perturbExt });
    for (const value of kept) value.party.list.push(7);
    expectUntouched(state, before);
    expect(result.rejected).toEqual([{ eventId: "owl", reason: "volatile-dependent" }]);
  });

  test("a perturbExt result that aliases the live state is copied on entry", () => {
    const seen: JsonValue[] = [];
    const peek: GameEvent = {
      id: "peek",
      x: 5,
      y: 3,
      pages: [
        { trigger: "action", commands: [] },
        { trigger: "action", commands: [], sprite: "peek", condition: { all: [{ kind: "ext", call: "demo.peek", args: null }] } },
      ],
    };
    const { session, state } = setup([still, peek], {
      immutableState: true,
      extensions: {
        initial: nested(),
        // Immutable conditions see the sandbox's extension state uncopied.
        immutableConditions: true,
        conditions: { "demo.peek": (context) => (seen.push(context.ext), true) },
      },
    });
    // A hook that hands back the live object it closed over.
    const perturbExt = (): JsonValue => state.ext;
    const live = state.ext as unknown as Nested;
    seen.length = 0;
    const probe = { x: -16, y: -16, facing: 0 as const, perturbExt };
    // Zero ticks reads the characters straight off the entered state; one
    // tick reads them after a reducer step.
    runSandboxEntry(sandboxFor(session, "east"), state, "east", probe, { ticks: 0 });
    runSandboxEntry(sandboxFor(session, "east"), state, "east", probe);
    expect(seen.length).toBeGreaterThan(1);
    for (const ext of seen) {
      expect(ext).toEqual(state.ext);
      expect(ext).not.toBe(state.ext);
      expect((ext as unknown as Nested).party).not.toBe(live.party);
    }
  });

  const named: GameEvent = {
    id: "named",
    x: 5,
    y: 2,
    pages: [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], sprite: "named", condition: { all: [{ kind: "ext", call: "demo.ada", args: null }] } },
    ],
  };
  const NAME_OPTIONS: SessionOptions = {
    immutableState: true,
    extensions: { conditions: { "demo.ada": (context) => context.playerName === "Ada" } },
  };

  test("renaming the player updates a cached preview an extension condition reads the name for", () => {
    const { session, state: started } = setup([still, named], NAME_OPTIONS);
    const ada = withSw(started, { playerName: "Ada" });
    const reader = createSandboxPreviewReader(session);
    const map = session.maps.get("east")!;
    reader.observe(ada);
    reader.read(map);
    let frames = 0;
    while (reader.stats.pending > 0 || frames === 0) { reader.pump(); frames++; }
    const cached = reader.read(map)!;
    expect(cached.actors.map((actor) => actor.eventId)).toEqual(["b", "named"]);
    const invalidations = reader.stats.invalidations;

    const bob = withSw(ada, { playerName: "Bob" });
    reader.observe(bob);
    expect(reader.stats.invalidations).toBe(invalidations + 1);
    // Stale until the replacement is complete, then recomputed for Bob.
    expect(reader.read(map)).toBe(cached);
    frames = 0;
    while (reader.stats.pending > 0 || frames === 0) { reader.pump(); frames++; }
    const renamed = reader.read(map)!;
    expect(renamed).not.toBe(cached);
    expect(renamed.actors.map((actor) => actor.eventId)).toEqual(["b"]);
    expect(renamed).toEqual(preview(session, bob));
  });

  // Every field an extension condition reads, by its type: adding a field to
  // ExtensionReadContext fails to compile here until it has a state change
  // that must invalidate the reader ("project" marks immutable project data).
  type ContextChange = ((state: SessionState) => SessionState) | "project";
  const CONTEXT_CHANGES: { readonly [K in keyof Required<ExtensionReadContext>]: ContextChange } = {
    ext: (state) => withExt(state, { changed: true }),
    switches: (state) => withSwitch(state, "durable", true),
    variables: (state) => withVariable(state, "durable", 5),
    items: (state) => withSw(state, { items: { ...state.sw.items, potion: 2 } }),
    gold: (state) => withSw(state, { gold: state.sw.gold + 10 }),
    playerName: (state) => withSw(state, { playerName: `${state.sw.playerName}!` }),
    itemCatalog: "project",
  };

  test("the fingerprint covers every field the extension condition context carries", () => {
    let seen: string[] = [];
    const capture: GameEvent = {
      id: "capture",
      x: 5,
      y: 3,
      pages: [
        { trigger: "action", commands: [] },
        { trigger: "action", commands: [], sprite: "cap", condition: { all: [{ kind: "ext", call: "demo.capture", args: null }] } },
      ],
    };
    const { session, state } = setup([still, capture], {
      immutableState: true,
      extensions: {
        initial: { n: 0 },
        conditions: {
          "demo.capture": (context) => {
            seen = Object.keys(context);
            return true;
          },
        },
      },
    });
    preview(session, state);
    // The keys the interpreter really builds, not only the declared ones.
    expect(seen.length).toBeGreaterThan(0);
    for (const key of seen) expect(Object.keys(CONTEXT_CHANGES)).toContain(key);
    // The engine's own stamp table names the same fields.
    expect(Object.keys(SANDBOX_PREVIEW_STAMPED_CONTEXT).sort()).toEqual(Object.keys(CONTEXT_CHANGES).sort());

    const map = session.maps.get("east")!;
    for (const [field, change] of Object.entries(CONTEXT_CHANGES)) {
      if (change === "project") {
        expect(SANDBOX_PREVIEW_STAMPED_CONTEXT[field as keyof ExtensionReadContext]).toBe("project");
        continue;
      }
      const reader = createSandboxPreviewReader(session);
      reader.observe(state);
      reader.read(map);
      for (let frame = 0; frame < 20; frame++) reader.pump();
      const cached = reader.read(map);
      expect(cached).toBeDefined();
      const invalidations = reader.stats.invalidations;
      const changed = change(state);
      expect(changed).not.toBe(state);
      reader.observe(changed);
      expect({ field, invalidated: reader.stats.invalidations - invalidations }).toEqual({ field, invalidated: 1 });
      reader.read(map);
      for (let frame = 0; frame < 20; frame++) reader.pump();
      expect(reader.read(map)).not.toBe(cached);
    }
    // Self switches are not in the context but page conditions read them.
    const reader = createSandboxPreviewReader(session);
    reader.observe(state);
    const invalidations = reader.stats.invalidations;
    reader.observe(withSw(state, { self: { ...state.sw.self, "east/b": "A" } }));
    expect(reader.stats.invalidations).toBe(invalidations + 1);
  });
});

export type { Project };
