// tests/rpgkit-session.test.ts — P1④ session orchestration
// (engine/session.ts): cross-map and same-map transfer, the fade machine,
// switch persistence across a map swap, command move routes, and the four
// triggers driven through one fold. Pure reducer tests over tiny inline
// projects plus the three-map sample game.

import { describe, expect, test } from "bun:test";
import {
  createSession,
  startSession,
  stepSession,
  fadeOpacity,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import { buildMiniProject } from "../examples/meadow/mini-project.ts";
import type { Command, GameEvent, MapDef, MoveStep, PageCondition, Project, TileId } from "../src/engine/types.ts";

const GRASS: TileId = "town.0";

function project(
  maps: MapDef[],
  start: { map: string; x: number; y: number; dir: "up" | "down" | "left" | "right" } = {
    map: "a",
    x: 2,
    y: 2,
    dir: "up",
  },
): Project {
  return {
    format: "rpgkit-project/v1",
    title: "t",
    tileSize: 16,
    start,
    sheets: [{ id: "town", cols: 12, rows: 11, defaultPassage: "pass" }],
    items: [],
    maps,
  };
}

function actorProject(
  maps: MapDef[],
  start?: { map: string; x: number; y: number; dir: "up" | "down" | "left" | "right" },
): Project {
  return {
    ...project(maps, start),
    playerName: "Leader Two",
    system: { rpgMakerText: { party: [2, 1], currencyUnit: "G" } },
    actors: [
      { id: "actor001", databaseId: 1, name: "Actor One", classId: "class001" },
      { id: "actor002", databaseId: 2, name: "Leader Two", classId: "class002" },
    ],
  };
}

function map(id: string, w: number, h: number, events: GameEvent[]): MapDef {
  return {
    id,
    name: id,
    width: w,
    height: h,
    sheets: ["town"],
    ground: new Array(w * h).fill(GRASS),
    events,
  };
}

function ge(id: string, x: number, y: number, pages: GameEvent["pages"]): GameEvent {
  return { id, x, y, pages };
}
const page = (
  trigger: GameEvent["pages"][number]["trigger"],
  commands: Command[],
  extra: Partial<GameEvent["pages"][number]> = {},
): GameEvent["pages"] => [
  { trigger, sprite: null, commands, ...extra },
];

function run(sess: Session, s: SessionState, frames: number, input = { buttons: 0 }): SessionState {
  let out = s;
  for (let i = 0; i < frames; i++) out = stepSession(sess, out, input);
  return out;
}

function pulse(sess: Session, s: SessionState, _buttons = 0): SessionState {
  // The host derives pressed edges; the session consumes booleans, so a
  // confirm pulse is a one-frame confirmEdge followed by a release frame.
  let out = stepSession(sess, s, { buttons: 0, confirmEdge: true });
  out = stepSession(sess, out, { buttons: 0 });
  return out;
}

describe("P1④ session — transfer", () => {
  const gate = ge(
    "gate",
    2,
    0,
    page("playerTouch", [{ op: "transfer", map: "b", x: 5, y: 5, dir: "up" }]),
  );
  const mk = (): { sess: Session; s: SessionState } => {
    const p = project([map("a", 8, 8, [gate]), map("b", 8, 8, [])]);
    const sess = createSession(p);
    return { sess, s: startSession(p, sess) };
  };

  test("walking onto a touch transfer swaps map and places the player", () => {
    const { sess, s } = mk();
    // start (2,2) facing up; hold up two tiles onto (2,0)
    let out = run(sess, s, 8 * 2, { buttons: 0x0010 }); // BTN.UP
    expect(out.mapId).toBe("b");
    expect([out.move.tx, out.move.ty]).toEqual([5, 5]);
    expect(out.move.facing).toBe(2);
  });

  test("a map swap rebuilds the interpreter and characters but keeps switches", () => {
    const { sess, s } = mk();
    // seed a switch, then transfer
    let out = stepSession(sess, s, { buttons: 0 });
    out.sw.switches["hero-flag"] = true;
    out.sw.gold = 42;
    out = run(sess, out, 8 * 2, { buttons: 0x0010 });
    expect(out.mapId).toBe("b");
    expect(out.sw.switches["hero-flag"]).toBe(true);
    expect(out.sw.gold).toBe(42);
    // fresh map state: a brand-new interpreter (frame 0 on the swap frame,
    // 1 after the next step) and no characters yet.
    expect(out.interp.frame).toBe(0);
    expect(Object.keys(out.chars.chars)).toHaveLength(0);
    out = stepSession(sess, out, { buttons: 0 });
    expect(out.interp.frame).toBe(1);
  });

  test("a same-map transfer resets the player and rebuilds the map state", () => {
    const local = ge("pad", 2, 1, page("playerTouch", [{ op: "transfer", map: "a", x: 6, y: 6, dir: "down" }]));
    const p = project([map("a", 8, 8, [local])]);
    const sess = createSession(p);
    let out = startSession(p, sess);
    out = run(sess, out, 8, { buttons: 0x0010 }); // up onto (2,1)
    expect(out.mapId).toBe("a");
    expect([out.move.tx, out.move.ty]).toEqual([6, 6]);
    expect(out.move.facing).toBe(0);
    expect(out.interp.frame).toBe(0); // rebuilt on the swap frame
    expect(stepSession(sess, out, { buttons: 0 }).interp.frame).toBe(1);
  });

  test("a faded transfer freezes gameplay and swaps on the first fully-black frame", () => {
    const fadeGate = ge(
      "gate",
      2,
      0,
      page("playerTouch", [{ op: "transfer", map: "b", x: 5, y: 5, dir: "up", fade: 0.4 }]),
    );
    const p = project([map("a", 8, 8, [fadeGate]), map("b", 8, 8, [])]);
    const sess = createSession(p);
    let out = run(sess, startSession(p, sess), 8 * 2, { buttons: 0x0010 });
    // 0.4s at 60Hz = 24 frames; swap at the end of the 12-frame out ramp.
    expect(out.fade).not.toBeNull();
    expect(out.fade!.phase).toBe("out");
    expect(out.mapId).toBe("a");
    out = run(sess, out, 11); // frames 1..11 still fading out, map unchanged
    expect(out.mapId).toBe("a");
    const before = fadeOpacity(out.fade);
    expect(before).toBeGreaterThan(0.9);
    out = stepSession(sess, out, { buttons: 0 }); // frame 12: black -> swap
    expect(out.mapId).toBe("b");
    expect(out.fade!.phase).toBe("in");
    out = run(sess, out, 12); // fade-in clears
    expect(out.fade).toBeNull();
  });
});

describe("P1④ session — command move routes", () => {
  test("a waited self-route parks the dialog until the NPC lands, then continues", () => {
    const porter = ge(
      "porter",
      2,
      2,
      page(
        "action",
        [
          {
            op: "moveRoute",
            target: "this",
            wait: true,
            route: { steps: ["moveRight", "moveRight"], repeat: false, skippable: false },
          },
          { op: "switch", id: "route-done", value: true },
        ],
        { sprite: "merchant", blocks: true },
      ),
    );
    const p = project([map("a", 10, 10, [porter])], { map: "a", x: 2, y: 1, dir: "down" });
    const sess = createSession(p);
    // face the porter (it is directly below) and confirm
    let out = pulse(sess, startSession(p, sess)); // BTN.CIRCLE
    expect(out.interp.main).toBeTruthy();
    expect(out.sw.switches["route-done"]).toBeUndefined();
    // two 8-frame steps; the fiber resumes on the landing frame
    out = run(sess, out, 8 * 2);
    expect([out.chars.chars["porter"]!.tx, out.chars.chars["porter"]!.ty]).toEqual([4, 2]);
    expect(out.sw.switches["route-done"]).toBe(true);
  });

  test("a fire-and-forget player turn applies immediately and never parks", () => {
    const turner = ge(
      "turner",
      2,
      1,
      page(
        "action",
        [
          {
            op: "moveRoute",
            target: "player",
            wait: false,
            route: { steps: ["faceUp"], repeat: false, skippable: false },
          },
          { op: "switch", id: "turned", value: true },
        ],
        { sprite: "merchant", blocks: true },
      ),
    );
    const turnerBelow = ge("turner", 2, 3, page(
      "action",
      [
        {
          op: "moveRoute",
          target: "player",
          wait: false,
          route: { steps: ["faceUp"], repeat: false, skippable: false },
        },
        { op: "switch", id: "turned", value: true },
      ],
      { sprite: "merchant", blocks: true },
    ));
    // Player starts at (2,2) facing DOWN; the turner stands one tile south
    // in the faced cell.
    const p = project([map("a", 10, 10, [turnerBelow])], { map: "a", x: 2, y: 2, dir: "down" });
    const sess = createSession(p);
    const out = pulse(sess, startSession(p, sess));
    expect(out.move.facing).toBe(2); // faceUp turned the player around
    expect(out.sw.switches["turned"]).toBe(true);
    expect(out.playerRoute).toBeNull();
  });

  test("every same-tick waited NPC route is installed and resumes its publisher", () => {
    const walker = (id: string, x: number): GameEvent => ge(id, x, 1, page("parallel", [
      {
        op: "moveRoute",
        target: "this",
        wait: true,
        route: { steps: ["moveDown"], repeat: false, skippable: false },
      },
      { op: "switch", id: `done-${id}`, value: true },
      { op: "erase" },
    ]));
    const p = project(
      [map("a", 12, 8, [walker("a", 6), walker("b", 8)])],
      { map: "a", x: 1, y: 6, dir: "right" },
    );

    for (const hz of [60, 4] as const) {
      const sess = createSession(p, hz);
      const out = run(sess, startSession(p, sess), hz);
      expect(out.sw.switches["done-a"], `${hz} Hz route a`).toBe(true);
      expect(out.sw.switches["done-b"], `${hz} Hz route b`).toBe(true);
      expect(Object.keys(out.interp.erased).sort(), `${hz} Hz erased pages`)
        .toEqual(["a/a", "a/b"]);
    }
  });
});

describe("immutable session page cache", () => {
  test("actor clauses select pages through the session and track the starting leader", () => {
    const leader = ge("leader", 5, 5, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: {
        all: [{ kind: "actor", actor: "actor002", test: "name", value: "Leader Two" }],
      } },
    ]);
    const companion = ge("companion", 6, 5, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: {
        all: [{ kind: "actor", actor: "actor001", test: "name", value: "Actor One" }],
      } },
    ]);
    const p = actorProject([map("a", 8, 8, [leader, companion])]);
    const sess = createSession(p, 60, { immutableState: true });
    let state = stepSession(sess, startSession(p, sess), { buttons: 0 });
    expect(state.chars.chars.leader!.pageIndex).toBe(1);
    expect(state.chars.chars.companion!.pageIndex).toBe(1);

    const sw = {
      ...state.sw,
      playerName: "Renamed Leader",
      variables: { ...state.sw.variables, "actor001-name": "Renamed Companion" },
    };
    state = stepSession(sess, { ...state, sw, interp: { ...state.interp, sw } }, { buttons: 0 });
    expect(state.chars.chars.leader!.pageIndex).toBe(0);
    expect(state.chars.chars.companion!.pageIndex).toBe(0);
  });

  test("same-map re-entry invalidates actor-name page templates", () => {
    const leader = ge("leader", 6, 6, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: {
        all: [{ kind: "actor", actor: "actor002", test: "name", value: "Renamed Leader" }],
      } },
    ]);
    const companion = ge("companion", 7, 6, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: {
        all: [{ kind: "actor", actor: "actor001", test: "name", value: "Renamed Companion" }],
      } },
    ]);
    const transfer = ge("transfer", 2, 1, page("playerTouch", [
      { op: "transfer", map: "a", x: 6, y: 6, dir: "up" },
    ]));
    const p = actorProject([map("a", 8, 8, [leader, companion, transfer])]);
    const sess = createSession(p, 60, { immutableState: true });
    let state = stepSession(sess, startSession(p, sess), { buttons: 0 });
    expect(state.chars.chars.leader!.pageIndex).toBe(0);
    expect(state.chars.chars.companion!.pageIndex).toBe(0);
    state = run(sess, state, 8, { buttons: 0x0010 });
    expect(state.interp.frame).toBe(0);
    const sw = {
      ...state.sw,
      playerName: "Renamed Leader",
      variables: { ...state.sw.variables, "actor001-name": "Renamed Companion" },
    };
    state = stepSession(sess, { ...state, sw, interp: { ...state.interp, sw } }, { buttons: 0 });
    expect(state.chars.chars.leader!.pageIndex).toBe(1);
    expect(state.chars.chars.companion!.pageIndex).toBe(1);
  });

  for (const scenario of [
    {
      name: "appearance",
      condition: { kind: "appearance", target: "player", sprite: "hero" } as const,
      update(state: SessionState): SessionState {
        const sw = { ...state.sw, playerAppearance: { sprite: "hero" } };
        return { ...state, sw, interp: { ...state.interp, sw } };
      },
    },
    {
      // The effective player sprite falls back to defaultSprite, which a
      // command can change while `sprite` stays unset.
      name: "default appearance",
      condition: { kind: "appearance", target: "player", sprite: "hero" } as const,
      update(state: SessionState): SessionState {
        const sw = { ...state.sw, playerAppearance: { defaultSprite: "hero" } };
        return { ...state, sw, interp: { ...state.interp, sw } };
      },
    },
    {
      name: "tile property",
      condition: { kind: "tileProperty", x: 0, y: 0, passage: "block" } as const,
      update(state: SessionState): SessionState {
        return {
          ...state,
          interp: { ...state.interp, tileProperties: { "0": { passage: "block" } } },
        };
      },
    },
    {
      name: "playing BGM",
      condition: { kind: "bgmPlaying", id: "theme" } as const,
      update(state: SessionState): SessionState {
        return {
          ...state,
          interp: {
            ...state.interp,
            audio: { bgm: { id: "theme", volume: 100, pitch: 100, positionTicks: 0 } },
          },
        };
      },
    },
  ]) test(`${scenario.name} conditions invalidate cached page selection`, () => {
    const gate = ge("gate", 6, 6, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: { all: [scenario.condition] } },
    ]);
    const p = project([map("a", 8, 8, [gate])]);
    const sess = createSession(p, 60, { immutableState: true });
    let state = stepSession(sess, startSession(p, sess), { buttons: 0 });
    expect(state.chars.chars.gate!.pageIndex).toBe(0);
    state = stepSession(sess, scenario.update(state), { buttons: 0 });
    expect(state.chars.chars.gate!.pageIndex).toBe(1);
  });

  test("starting a BGM fade-out invalidates a bgmPlaying page", () => {
    const gate = ge("gate", 6, 6, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: {
        all: [{ kind: "bgmPlaying", id: "theme" }],
      } },
    ]);
    const p = project([map("a", 8, 8, [gate])]);
    const sess = createSession(p, 60, { immutableState: true });
    let state = startSession(p, sess);
    state = {
      ...state,
      interp: {
        ...state.interp,
        audio: { bgm: { id: "theme", volume: 100, pitch: 100, positionTicks: 0 } },
      },
    };
    state = stepSession(sess, state, { buttons: 0 });
    expect(state.chars.chars.gate!.pageIndex).toBe(1);
    state = {
      ...state,
      interp: {
        ...state.interp,
        audio: { bgm: {
          ...state.interp.audio!.bgm!,
          fade: { totalTicks: 60, leftTicks: 60 },
        } },
      },
    };
    state = stepSession(sess, state, { buttons: 0 });
    expect(state.chars.chars.gate!.pageIndex).toBe(0);
  });

  test("an extension condition cache key ignores unrelated extension churn", () => {
    const gate = ge("gate", 6, 6, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: {
        all: [{ kind: "ext", call: "demo.open", args: null }],
      } },
    ]);
    const p = project([map("a", 8, 8, [gate])]);
    const makeExtensions = (called: { count: number }) => ({
      initial: { clock: 0, open: false },
      immutableConditions: true,
      deterministicConditions: true,
      conditionCacheKey: (value: unknown) => (value as { open: boolean }).open,
      conditions: { "demo.open": (context: { ext: unknown }) => {
        called.count++;
        return (context.ext as { open: boolean }).open;
      } },
    });
    const referenceCalls = { count: 0 };
    const cachedCalls = { count: 0 };
    const reference = createSession(p, 60, { extensions: makeExtensions(referenceCalls) });
    const cached = createSession(p, 60, {
      immutableState: true,
      extensions: makeExtensions(cachedCalls),
    });
    let a = startSession(p, reference), b = startSession(p, cached);
    const callsBeforeFirstCachedStep = cachedCalls.count;
    for (let frame = 0; frame < 12; frame++) {
      const open = frame >= 6;
      const update = (state: SessionState): SessionState => ({
        ...state,
        ext: { clock: frame, open },
      });
      a = stepSession(reference, update(a), { buttons: 0 });
      b = stepSession(cached, update(b), { buttons: 0 });
      expect(b).toEqual(a);
      expect(b.chars.chars.gate!.pageIndex).toBe(open ? 1 : 0);
      if (frame === 0) expect(cachedCalls.count - callsBeforeFirstCachedStep).toBe(1);
    }
    expect(cachedCalls.count).toBeLessThan(referenceCalls.count);
  });

  test("a same-map re-entry reuses the immutable initial character template", () => {
    let conditionCalls = 0;
    const probe = ge("probe", 6, 6, [{
      trigger: "action",
      commands: [],
      condition: { all: [{ kind: "ext", call: "demo.open", args: null }] },
    }]);
    const transfer = ge("transfer", 2, 1, page("playerTouch", [
      { op: "transfer", map: "a", x: 6, y: 6, dir: "up" },
    ]));
    const p = project([map("a", 8, 8, [probe, transfer])]);
    const sess = createSession(p, 60, {
      immutableState: true,
      extensions: {
        initial: { open: true },
        immutableConditions: true,
        deterministicConditions: true,
        conditionCacheKey: (value: unknown) => (value as { open: boolean }).open,
        entryConditionCacheKey: (context: { ext: unknown }) =>
          (context.ext as { open: boolean }).open,
        conditions: {
          "demo.open": () => {
            conditionCalls++;
            return true;
          },
        },
      },
    });
    let state = stepSession(sess, startSession(p, sess), { buttons: 0 });
    expect(conditionCalls).toBe(1);
    const initialProbe = state.chars.chars.probe;
    state = run(sess, state, 8, { buttons: 0x0010 });
    expect(state.interp.frame).toBe(0);
    state = { ...state, chars: { rng: 0x1234_5678, chars: state.chars.chars } };
    const callsBeforeReentry = conditionCalls;
    state = stepSession(sess, state, { buttons: 0 });
    expect(conditionCalls).toBe(callsBeforeReentry);
    expect(state.chars.chars.probe).toBe(initialProbe);
    expect(state.chars.chars.probe!.pageIndex).toBe(0);
    expect(state.chars.rng).toBe(0x1234_5678);
  });

  test("a re-entry re-selects pages when only the default player appearance changed", () => {
    const probe = ge("probe", 6, 6, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: {
        all: [{ kind: "appearance", target: "player", sprite: "hero" }],
      } },
    ]);
    const transfer = ge("transfer", 2, 1, page("playerTouch", [
      { op: "transfer", map: "a", x: 6, y: 6, dir: "up" },
    ]));
    const p = project([map("a", 8, 8, [probe, transfer])]);
    const sess = createSession(p, 60, { immutableState: true });
    let state = stepSession(sess, startSession(p, sess), { buttons: 0 });
    expect(state.chars.chars.probe!.pageIndex).toBe(0);
    state = run(sess, state, 8, { buttons: 0x0010 });
    expect(state.interp.frame).toBe(0);
    const sw = { ...state.sw, playerAppearance: { defaultSprite: "hero" } };
    state = { ...state, sw, interp: { ...state.interp, sw } };
    state = stepSession(sess, state, { buttons: 0 });
    expect(state.chars.chars.probe!.pageIndex).toBe(1);
  });

  test("an entry template stays disabled without a complete extension context key", () => {
    let conditionCalls = 0;
    const probe = ge("probe", 6, 6, [{
      trigger: "action",
      commands: [],
      condition: { all: [{ kind: "ext", call: "demo.open", args: null }] },
    }]);
    const transfer = ge("transfer", 2, 1, page("playerTouch", [
      { op: "transfer", map: "a", x: 6, y: 6, dir: "up" },
    ]));
    const p = project([map("a", 8, 8, [probe, transfer])]);
    const sess = createSession(p, 60, {
      immutableState: true,
      extensions: {
        initial: null,
        immutableConditions: true,
        deterministicConditions: true,
        conditionCacheKey: () => null,
        conditions: { "demo.open": () => (++conditionCalls, true) },
      },
    });
    let state = stepSession(sess, startSession(p, sess), { buttons: 0 });
    state = run(sess, state, 8, { buttons: 0x0010 });
    const callsBeforeReentry = conditionCalls;
    state = stepSession(sess, state, { buttons: 0 });
    expect(conditionCalls).toBe(callsBeforeReentry + 1);
    expect(state.chars.chars.probe!.pageIndex).toBe(0);
  });

  for (const hz of [60, 30, 20, 4]) for (const opaque of [false, true])
    test(`page reads follow every bank, facing, idle and rewind at ${hz} Hz, extension=${opaque}`, () => {
      const conditions: PageCondition[] = [
        { switch: "gate" }, { variable: { id: "phase", op: ">=", value: 1 } },
        { selfSwitch: "A" }, { item: "key" },
        { all: [{ kind: "switch", id: "gate", value: false }] },
        { all: [{ kind: "variable", id: "phase", op: "==", value: 2 }] },
        { all: [{ kind: "selfSwitch", key: "B", value: false }] },
        { all: [{ kind: "item", id: "key", count: 2 }] },
        { all: [{ kind: "gold", amount: 10 }] },
        { all: [{ kind: "facing", dir: "right" }] },
        { all: [{ kind: "worldIdle" }] },
      ];
      if (opaque) conditions.push({ all: [{ kind: "ext", call: "demo.page", args: null }] });
      const p = project([map("a", 24, 16, conditions.map((condition, i) =>
        ge(`npc-${i}`, i + 1, 12, [
          { trigger: "action", commands: [], blocks: false },
          { trigger: "action", commands: [], blocks: true, condition },
        ])))]);
      const extensions = { initial: 0, immutableConditions: true, deterministicConditions: true,
        conditions: { "demo.page": (c: { ext: unknown; gold: number; variables: Record<string, unknown> }) =>
          c.ext === 1 || (c.gold >= 10 && c.variables.phase === 2) } };
      const reference = createSession(p, hz, { extensions });
      const cached = createSession(p, hz, { extensions, immutableState: true });
      let a = startSession(p, reference), b = startSession(p, cached);
      const history: SessionState[] = [];
      const saved: string[] = [];
      for (let frame = 0; frame < 30; frame++) {
        const modify = (s: SessionState): SessionState => {
          const sw: SessionState["sw"] = { ...s.sw, variables: { ...s.sw.variables, unrelated: frame } };
          const value = frame < 15 ? 2 : 0;
          switch (frame % 15) {
            case 2: sw.switches = { ...sw.switches, gate: value > 0 }; break;
            case 4: sw.variables.phase = value; break;
            case 6: sw.self = { ...sw.self, "a/npc-2": value ? "A" : undefined, "a/npc-6": value ? "B" : undefined }; break;
            case 8: sw.items = { ...sw.items, key: value }; break;
            case 10: sw.gold = value * 10; break;
          }
          return { ...s, sw, interp: { ...s.interp, sw }, ext: frame >= 12 && frame < 27 ? 1 : 0 };
        };
        const input = { buttons: frame % 7 === 0 ? 0x0020 : 0 };
        a = stepSession(reference, modify(a), input);
        b = stepSession(cached, modify(b), input);
        expect(b).toEqual(a);
        history.push(b); saved.push(JSON.stringify(b));
      }
      for (let i = history.length - 1; i >= 0; i--) {
        expect(JSON.stringify(history[i])).toBe(saved[i]!);
        const restored = JSON.parse(saved[i]!);
        expect(stepSession(cached, history[i]!, { buttons: 0 }))
          .toEqual(stepSession(reference, restored, { buttons: 0 }));
      }
    });

  test("page conditions without a determinism contract run again with unchanged state", () => {
    let open = false;
    const p = project([map("a", 8, 8, [ge("gate", 6, 6, [
      { trigger: "action", commands: [] },
      { trigger: "action", commands: [], condition: { all: [{ kind: "ext", call: "demo.open", args: null }] } },
    ])])]);
    const sess = createSession(p, 60, { immutableState: true, extensions: {
      immutableConditions: true, conditions: { "demo.open": () => open },
    } });
    let state = startSession(p, sess);
    for (const next of [false, true, false, true]) {
      open = next;
      state = stepSession(sess, state, { buttons: 0 });
      expect(state.chars.chars.gate!.pageIndex).toBe(next ? 1 : 0);
    }
  });

  for (const hz of [60, 30, 20, 4]) test(`wakes an idle scan on input, bank writes, placement and restore at ${hz} Hz`, () => {
    const p = project([map("a", 12, 8, [
      ge("sleep", 0, 0, page("parallel", [{ op: "if",
        if: { kind: "ext", call: "demo.awake", args: null },
        then: [{ op: "variable", id: "clock", set: { op: "add", value: 1 } }],
      }])),
      ge("button", 2, 1, page("action", [
        { op: "wait", seconds: 0.1 },
        { op: "ext", call: "demo.wake", args: null },
        { op: "place", target: { event: "npc" }, x: 3, y: 1, dir: "left" },
        { op: "erase" },
      ])),
      ge("npc", 7, 4, page("playerTouch", [
        { op: "variable", id: "touches", set: { op: "add", value: 1 } },
      ], { blocks: false })),
    ])], { map: "a", x: 1, y: 1, dir: "right" });
    const extensions = {
      initial: "sleep", immutableConditions: true, deterministicConditions: true,
      conditions: { "demo.awake": (context: { ext: unknown }) => context.ext === "awake" },
      commands: { "demo.wake": () => ({ ext: "awake", writes: { clock: 0 } }) },
    };
    const regular = createSession(p, hz, { extensions });
    const optimized = createSession(p, hz, { extensions, immutableState: true });
    let a = startSession(p, regular), b = startSession(p, optimized);
    const history: Array<{ state: SessionState; json: string }> = [];
    for (let frame = 0; frame < hz * 4; frame++) {
      history.push({ state: b, json: JSON.stringify(b) });
      const input = { buttons: frame >= hz * 2 && frame < hz * 3 ? 0x0020 : 0,
        confirmEdge: frame === hz };
      a = stepSession(regular, a, input);
      b = stepSession(optimized, b, input);
      expect(b).toEqual(a);
      if (frame === hz - 1) { a = JSON.parse(JSON.stringify(a)); b = JSON.parse(JSON.stringify(b)); }
    }
    for (const prior of history) expect(JSON.stringify(prior.state)).toBe(prior.json);
    expect(b.ext).toBe("awake");
    expect(b.interp.erased["a/button"]).toBe(true);
    expect(b.sw.variables.clock).toBeGreaterThan(0);
    expect(b.sw.variables.touches).toBe(1);
    expect([b.chars.chars.npc!.tx, b.chars.chars.npc!.ty]).toEqual([3, 1]);
  });

  for (const hz of [60, 30, 20, 4]) test(`shares idle characters while preserving routes, collisions and placements at ${hz} Hz`, () => {
    const p = project([map("a", 24, 16, [
      ...Array.from({ length: 40 }, (_, i) => ge(`static-${i}`, i % 20, 12 + Math.floor(i / 20), page("action", [], { blocks: true }))),
      ge("random", 4, 4, page("action", [], { moveType: "random", blocks: true })),
      ge("patrol", 8, 4, page("action", [], { blocks: true,
        moveRoute: { steps: ["moveLeft", "wait", "moveRight"], repeat: true, skippable: true } })),
      ge("npc", 6, 4, [
        { trigger: "action", commands: [], blocks: true },
        { trigger: "action", commands: [], blocks: false, condition: { all: [{ kind: "switch", id: "phase", value: true }] } },
      ]),
      ge("driver", 0, 0, page("parallel", [
        { op: "wait", seconds: 0.1 },
        { op: "moveRoute", target: { event: "npc" }, wait: true,
          route: { steps: ["moveRight", "moveDown", "moveLeft"], repeat: false, skippable: true } },
        { op: "place", target: { event: "npc" }, x: 3, y: 3, dir: "up" },
        { op: "switch", id: "phase", value: true },
        { op: "erase" },
      ])),
    ])]);
    const regular = createSession(p, hz), optimized = createSession(p, hz, { immutableState: true });
    let a = startSession(p, regular), b = startSession(p, optimized);
    for (let frame = 0; frame < hz * 3; frame++) {
      const before = JSON.stringify(b), retained = b;
      const input = { buttons: frame < hz ? 0x0020 : frame < hz * 2 ? 0x0040 : 0 };
      a = stepSession(regular, a, input);
      b = stepSession(optimized, b, input);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(retained)).toBe(before);
      if (frame === hz) { a = JSON.parse(JSON.stringify(a)); b = JSON.parse(JSON.stringify(b)); }
    }
    expect(b.sw.switches.phase).toBe(true);
    expect([b.chars.chars.npc!.tx, b.chars.chars.npc!.ty]).toEqual([3, 3]);
  });

  for (const hz of [60, 30, 20, 4]) test(`preserves tick, bank-write and restore behavior at ${hz} Hz`, () => {
    const p = project([map("a", 8, 8, [
      ge("counter", 0, 0, page("parallel", [{ op: "variable", id: "clock", set: { op: "add", value: 1 } }])),
      ge("gate", 4, 4, [
        { trigger: "parallel", commands: [] },
        { trigger: "parallel", condition: { all: [{ kind: "variable", id: "clock", op: ">=", value: 2 }] },
          commands: [{ op: "switch", id: "opened", value: true }], sprite: "gate", blocks: true },
      ]),
    ])]);
    const regular = createSession(p, hz), cached = createSession(p, hz, { immutableState: true });
    let a = startSession(p, regular), b = startSession(p, cached);
    for (let frame = 0; frame < 20; frame++) {
      const before = JSON.stringify(b);
      const prior = b;
      a = stepSession(regular, a, { buttons: 0 });
      b = stepSession(cached, b, { buttons: 0 });
      expect(JSON.stringify(prior)).toBe(before);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      if (frame === 9) { a = JSON.parse(JSON.stringify(a)); b = JSON.parse(JSON.stringify(b)); }
    }
    expect(b.sw.switches.opened).toBe(true);
  });
});

describe("P1④ session — triggers under real movement", () => {
  test("autorun runs exclusively: it owns main and freezes the mover", () => {
    const auto = ge(
      "auto",
      2,
      2,
      page("autorun", [{ op: "wait", seconds: 0.2 }, { op: "switch", id: "a", value: true }]),
    );
    const p = project([map("a", 8, 8, [auto])]);
    const sess = createSession(p);
    let out = stepSession(sess, startSession(p, sess), { buttons: 0x0010 }); // held up
    expect(out.interp.main).toBeTruthy();
    const before = [out.move.tx, out.move.ty];
    out = run(sess, out, 20, { buttons: 0x0010 }); // held through the wait
    expect([out.move.tx, out.move.ty]).toEqual(before); // mover frozen
    expect(out.sw.switches["a"]).toBe(true);
  });

  test("parallel runs while the player walks and never owns main", () => {
    const para = ge(
      "amb",
      7,
      7,
      page("parallel", [{ op: "wait", seconds: 0.2 }, { op: "switch", id: "tick", value: true }]),
    );
    const p = project([map("a", 8, 8, [para])]);
    const sess = createSession(p);
    const out = run(sess, startSession(p, sess), 20, { buttons: 0x0010 });
    expect(out.interp.main).toBeNull();
    expect(out.sw.switches["tick"]).toBe(true);
    expect(out.move.ty).toBeLessThan(2); // the player was free to walk
  });

  test("action fires on the event one tile in FRONT of the facing player", () => {
    const npc = ge("npc", 2, 1, page("action", [{ op: "switch", id: "talked", value: true }], { sprite: "wiz", blocks: true }));
    const p = project([map("a", 8, 8, [npc])], { map: "a", x: 2, y: 2, dir: "up" });
    const sess = createSession(p);
    // confirm while facing down opens nothing
    let out = pulse(sess, startSession(p, sess));
    // start faces up per project start; the NPC is one tile north -> opens
    expect(out.sw.switches["talked"]).toBe(true);
  });
});

describe("session — the shipped example project", () => {
  test("builds with its map and seeds the start tile and starting gold", () => {
    const p = buildMiniProject();
    expect(p.maps.map((m) => m.id)).toEqual(["meadow"]);
    const sess = createSession(p);
    const s = startSession(p, sess, createSwitchState({ gold: 5 }));
    expect(s.mapId).toBe("meadow");
    expect(s.sw.gold).toBe(5);
    // the session holds the map table and world
    expect(sess.maps.size).toBe(1);
  });

  test("the session fold is byte-identical across two runs of the same tape", () => {
    const p = buildMiniProject();
    const tape: number[] = [];
    for (let i = 0; i < 60; i++) tape.push(i % 3 === 0 ? 0x0010 : 0);
    const drive = (): SessionState => {
      const sess = createSession(p);
      let s = startSession(p, sess);
      for (const b of tape) s = stepSession(sess, s, { buttons: b });
      return s;
    };
    expect(drive()).toEqual(drive());
  });
});

describe("P1④-fix — terrain passage never bypasses a character body (R4)", () => {
  const RIGHT = 0x0020;
  const setup = (forced: boolean) => {
    const wall = ge("wall", 3, 2, page("action", [], { sprite: "wiz", blocks: true }));
    const events: GameEvent[] = [wall];
    if (forced) {
      events.push(ge("driver", 7, 7, page("parallel", [
        { op: "moveRoute", target: "player", wait: true, route: { steps: ["moveRight"], repeat: false, skippable: false } },
        { op: "erase" },
      ])));
    }
    const m = map("a", 9, 9, events);
    // Terrain reopens the cell; the blocks:true body must still own it.
    m.passage = [[2 * 9 + 3, "pass"]];
    const p = project([m, map("b", 9, 9, [])], { map: "a", x: 2, y: 2, dir: "up" });
    const sess = createSession(p);
    return { sess, s: startSession(p, sess) };
  };

  test("a manual step is refused by a blocks:true NPC standing on a pass cell", () => {
    const { sess, s } = setup(false);
    const out = run(sess, s, 8, { buttons: RIGHT });
    expect([out.move.tx, out.move.ty]).toEqual([2, 2]);
  });

  test("a forced step is refused by a blocks:true NPC standing on a pass cell", () => {
    const { sess, s } = setup(true);
    // The parallel installs on frame 1; give the waited route nine frames
    // to attempt (and retry) its one east step.
    const out = run(sess, s, 9, { buttons: 0 });
    expect([out.move.tx, out.move.ty]).toEqual([2, 2]);
    // The route never lands, so its fiber stays parked and erase never runs.
    expect(out.interp.parallels["a/driver"]?.mode).toBe("external");
  });

  test("a pass cell with no body on it stays enterable (terrain override survives)", () => {
    const m = map("a", 9, 9, []);
    m.passage = [[2 * 9 + 3, "pass"]];
    const p = project([m, map("b", 9, 9, [])], { map: "a", x: 2, y: 2, dir: "up" });
    const sess = createSession(p);
    const out = run(sess, startSession(p, sess), 8, { buttons: RIGHT });
    expect([out.move.tx, out.move.ty]).toEqual([3, 2]);
  });
});

describe("P1④-fix — player forced routes: takeover, replacement, pacing", () => {
  const RIGHT = 0x0020;

  test("R7: a repeating face-only route advances one command per frame and never throws", () => {
    const driver = ge("driver", 7, 7, page("parallel", [
      { op: "moveRoute", target: "player", wait: false, route: { steps: ["faceUp"], repeat: true, skippable: false } },
      { op: "erase" },
    ]));
    const p = project([map("a", 9, 9, [driver]), map("b", 9, 9, [])]);
    const sess = createSession(p);
    let out = startSession(p, sess);
    expect(() => { for (let i = 0; i < 60; i++) out = stepSession(sess, out, { buttons: 0 }); }).not.toThrow();
    // Repeat route stays installed and keeps the player facing up.
    expect(out.playerRoute).not.toBeNull();
    expect(out.move.facing).toBe(2);
    expect([out.move.tx, out.move.ty]).toEqual([2, 2]);
    expect(out.interp.main).toBeNull(); // a fire-and-forget route never blocks
  });

  test("R2: a forced face installed mid-step snaps back to the origin and never enters the blocked tile", () => {
    const turner = ge("turner", 7, 7, page("parallel", [
      { op: "wait", seconds: 2 / 60 },
      { op: "moveRoute", target: "player", wait: false, route: { steps: ["faceUp"], repeat: false, skippable: false } },
      { op: "erase" },
    ]));
    const m = map("a", 9, 9, [turner]);
    m.passage = [[1 * 9 + 2, "block"]]; // (2,1) north of the start blocks
    const p = project([m, map("b", 9, 9, [])]);
    const sess = createSession(p);
    // Three frames walking right: committed step is at phase 3 / px 38.
    let out = run(sess, startSession(p, sess), 3, { buttons: RIGHT });
    expect([out.move.tx, out.move.ty, out.move.phase, out.move.px]).toEqual([2, 2, 3, 38]);
    // The parallel publishes the route on frame 3; the mover is untouched
    // that frame and the route marks itself for a boundary takeover.
    expect(out.playerRoute?.takeOver).toBe(true);
    out = stepSession(sess, out, { buttons: 0 });
    // Back at the origin boundary, turned up; the committed step was
    // cancelled rather than redirected into the blocked north cell.
    expect([out.move.tx, out.move.ty, out.move.px, out.move.py, out.move.facing]).toEqual([2, 2, 32, 32, 2]);
    out = run(sess, out, 18, { buttons: 0 });
    expect([out.move.tx, out.move.ty]).toEqual([2, 2]);
  });

  test("R1: replacing a waited player route releases the old waiter and its fiber finishes", () => {
    const owner = ge("owner", 2, 1, page("action", [
      { op: "moveRoute", target: "player", wait: true, route: { steps: ["moveRight"], repeat: false, skippable: false } },
      { op: "switch", id: "done", value: true },
    ]));
    const replacer = ge("replacer", 7, 7, page("parallel", [
      { op: "wait", seconds: 2 / 60 },
      { op: "moveRoute", target: "player", wait: false, route: { steps: ["faceDown"], repeat: false, skippable: false } },
      { op: "erase" },
    ]));
    const p = project([map("a", 9, 9, [owner, replacer]), map("b", 9, 9, [])]);
    const sess = createSession(p);
    let out = pulse(sess, startSession(p, sess));
    out = run(sess, out, 64, { buttons: RIGHT });
    expect(out.interp.main).toBeNull();
    expect(out.playerRoute).toBeNull();
    expect(out.sw.switches["done"]).toBe(true);
  });

  test("a move route installed mid-step takes over from the origin and completes its own step", () => {
    // Open field; the route's moveUp must walk one tile NORTH of the
    // origin, never carry the east interpolation onto a diagonal cell.
    const driver = ge("driver", 7, 7, page("parallel", [
      { op: "wait", seconds: 2 / 60 },
      { op: "moveRoute", target: "player", wait: true, route: { steps: ["moveUp"], repeat: false, skippable: false } },
      { op: "switch", id: "north", value: true },
    ]));
    const p = project([map("a", 9, 9, [driver]), map("b", 9, 9, [])]);
    const sess = createSession(p);
    let out = run(sess, startSession(p, sess), 3, { buttons: RIGHT });
    expect([out.move.tx, out.move.ty]).toEqual([2, 2]); // the first east step is only at phase 3
    // The route installs while that east step is committed; the takeover
    // cancels it at (2,2), then walks one tile north.
    out = run(sess, out, 12, { buttons: 0 });
    expect([out.move.tx, out.move.ty]).toEqual([2, 1]);
    expect(out.sw.switches["north"]).toBe(true);
  });
});

describe("P1④-fix — page-scoped parallel cancellation (R6)", () => {
  const w = (seconds: number): Command => ({ op: "wait", seconds });

  test("a parallel whose switch condition fails is canceled before its pending write applies", () => {
    const old = ge("old", 7, 7, page("parallel", [w(4 / 60), { op: "switch", id: "leaked", value: true }], { condition: { switch: "enabled" } }));
    const off = ge("off", 7, 6, page("parallel", [w(1 / 60), { op: "switch", id: "enabled", value: false }, { op: "erase" }]));
    const p = project([map("a", 9, 9, [old, off]), map("b", 9, 9, [])]);
    const sess = createSession(p);
    let out = startSession(p, sess);
    out.sw.switches["enabled"] = true;
    out = run(sess, out, 3);
    expect(out.interp.parallels["a/old"]).toBeUndefined();
    expect(out.chars.chars["old"]).toBeUndefined();
    out = run(sess, out, 10);
    expect(out.sw.switches["leaked"]).toBeUndefined();
  });

  test("a page change cancels the old parallel and starts the new page's fiber", () => {
    const ev0: GameEvent = {
      id: "clock",
      x: 7,
      y: 7,
      pages: [
        { trigger: "parallel", commands: [w(60 / 60), { op: "switch", id: "p0", value: true }] },
        { trigger: "parallel", condition: { switch: "go" }, commands: [{ op: "switch", id: "p1", value: true }, w(60 / 60)] },
      ],
    };
    const trigger = ge("trigger", 6, 6, page("parallel", [w(1 / 60), { op: "switch", id: "go", value: true }, { op: "erase" }]));
    const p = project([map("a", 9, 9, [ev0, trigger]), map("b", 9, 9, [])]);
    const sess = createSession(p);
    let out = run(sess, startSession(p, sess), 4);
    expect(out.sw.switches["p1"]).toBe(true); // new page's fiber ran
    expect(out.sw.switches["p0"]).toBeUndefined(); // old fiber's late write is gone with it
    const f = out.interp.parallels["a/clock"];
    expect(f?.pageIndex).toBe(1);
  });

  test("canceling a parallel parked on a waited this-route removes the char and never resumes it", () => {
    const mover: GameEvent = {
      id: "mover",
      x: 3,
      y: 3,
      pages: [
        { trigger: "parallel", sprite: "wiz", blocks: true, commands: [
          { op: "moveRoute", target: "this", wait: true, route: { steps: ["moveDown"], repeat: false, skippable: false } },
          { op: "switch", id: "after-route", value: true },
        ], condition: { switch: "enabled" } },
      ],
    };
    const off = ge("off", 7, 7, page("parallel", [w(1 / 60), { op: "switch", id: "enabled", value: false }, { op: "erase" }]));
    const p = project([map("a", 9, 9, [mover, off]), map("b", 9, 9, [])]);
    const sess = createSession(p);
    let out = startSession(p, sess);
    out.sw.switches["enabled"] = true;
    out = run(sess, out, 2);
    // The forced route installed and the fiber parked.
    expect(out.chars.chars["mover"]?.route?.waiter).toBe("a/mover");
    out = run(sess, out, 20);
    expect(out.interp.parallels["a/mover"]).toBeUndefined();
    expect(out.chars.chars["mover"]).toBeUndefined(); // inactive page removes the character
    expect(out.sw.switches["after-route"]).toBeUndefined(); // dead fiber never resumes
  });

  test("canceling a parallel parked on a waited player route drops the route mid-step", () => {
    const driver: GameEvent = {
      id: "driver",
      x: 7,
      y: 7,
      pages: [
        { trigger: "parallel", condition: { switch: "enabled" }, commands: [
          { op: "moveRoute", target: "player", wait: true, route: { steps: ["moveRight", "moveRight"], repeat: false, skippable: false } },
          { op: "switch", id: "after-route", value: true },
        ] },
      ],
    };
    const off = ge("off", 7, 6, page("parallel", [w(2 / 60), { op: "switch", id: "enabled", value: false }, { op: "erase" }]));
    const p = project([map("a", 9, 9, [driver, off]), map("b", 9, 9, [])]);
    const sess = createSession(p);
    let out = startSession(p, sess);
    out.sw.switches["enabled"] = true;
    out = run(sess, out, 4); // first east step in flight when the page dies
    expect(out.interp.parallels["a/driver"]).toBeUndefined();
    expect(out.playerRoute).toBeNull(); // the waited route was aborted, not resumed
    out = run(sess, out, 20);
    expect(out.sw.switches["after-route"]).toBeUndefined();
    // No runaway second step: the player ends on the single tile the
    // canceled step had reached at most.
    expect(out.move.tx).toBeLessThanOrEqual(3);
    expect(out.move.ty).toBe(2);
  });
});

// --- I1-fix: a PARALLEL choices box captures the d-pad (review C10) --------

describe("I1-fix — a parallel choices box captures direction and freezes the mover", () => {
  const BTN_DOWN = 0x0040;

  test("down moves the cursor, not the player, while a parallel choice is open", () => {
    const events = [
      ge("pick", 0, 0, page("parallel", [
        { op: "choices", prompt: "PICK", options: [
          { text: "A", commands: [] },
          { text: "B", commands: [] },
        ] },
      ])),
    ];
    const p = project([map("a", 8, 8, events)], { map: "a", x: 2, y: 2, dir: "up" });
    const sess = createSession(p);
    let s = startSession(p, sess);
    // Frame 1: the parallel page installs its choices box.
    s = stepSession(sess, s, { buttons: 0 });
    expect(s.interp.modal).toMatchObject({ kind: "choices", index: 0 });
    const before = { px: s.move.px, py: s.move.py, tx: s.move.tx, ty: s.move.ty };
    // Frame 2: DOWN is held. The cursor must move; the body must not.
    s = stepSession(sess, s, { buttons: BTN_DOWN, downEdge: true });
    expect(s.interp.modal).toMatchObject({ kind: "choices", index: 1 });
    expect({ px: s.move.px, py: s.move.py, tx: s.move.tx, ty: s.move.ty }).toEqual(before);
  });
});

// --- I1-fix2: movement routes run on virtual time, not guest frames -------
// One journey (a waited player route with an in-route wait, and a looping
// NPC patrol that also waits) must produce the SAME player and NPC position
// series at 60/30/20/4 Hz. The session folds a fixed 60-tick virtual-time
// reference: every host frame, including the first, covers 60/hz ticks.
// Sampling instants below land on every tested host grid.

describe("I1-fix2 — movement routes are hz-portable (review 1284 B1)", () => {
  function journey(hz: number) {
    // Page 0 autoruns once; page 1 (empty) activates on the done switch so
    // the MV autorun restart cannot re-run the route.
    const driver = ge("driver", 0, 0, [
      {
        trigger: "autorun",
        sprite: null,
        commands: [
          {
            op: "moveRoute",
            target: "player",
            wait: true,
            route: {
              // four steps, one step-long wait, four steps: the in-route
              // wait occupies one step's worth of reference ticks.
              steps: [
                ...Array(4).fill("moveRight"),
                "wait",
                ...Array(4).fill("moveRight"),
              ] as MoveStep[],
              repeat: false,
              skippable: false,
            },
          },
          { op: "switch", id: "route-done", value: true },
        ],
      },
      {
        trigger: "autorun",
        sprite: null,
        condition: { switch: "route-done" },
        commands: [],
      },
    ]);
    const npc = ge("npc", 2, 5, page("action", [], {
      moveRoute: {
        steps: [
          ...Array(4).fill("moveRight"),
          "wait",
          ...Array(4).fill("moveLeft"),
          "wait",
        ] as MoveStep[],
        repeat: true,
        skippable: false,
      },
    }));
    const p = project([map("a", 24, 8, [driver, npc])], { map: "a", x: 2, y: 2, dir: "down" });
    const sess = createSession(p, hz);
    return { sess, s: startSession(p, sess) };
  }

  function runTo(hz: number, targetTick: number) {
    const n = 60 / hz;
    let { sess, s } = journey(hz);
    const frames = targetTick / n;
    if (!Number.isInteger(frames)) throw new Error(`target ${targetTick} off-grid at ${hz} Hz`);
    // Routes self-drive; no buttons are held, so every reference tick sees
    // the same input and the comparison isolates motion timing.
    for (let f = 0; f < frames; f++) s = stepSession(sess, s, { buttons: 0 });
    return s;
  }

  function sample(s: SessionState) {
    const ch = s.chars.chars["npc"]!;
    return {
      player: {
        tx: s.move.tx, ty: s.move.ty, px: s.move.px, py: s.move.py,
        phase: s.move.phase, moving: s.move.moving, facing: s.move.facing,
        routePc: s.playerRoute?.pc ?? null,
        routePhase: s.playerRoute?.phase ?? null,
      },
      npc: {
        tx: ch.tx, ty: ch.ty, px: ch.px, py: ch.py, phase: ch.phase,
        moving: ch.moving, routePc: ch.route?.pc ?? null,
        waitLeft: ch.route?.waitLeft ?? null,
      },
      done: s.sw.switches["route-done"] ?? false,
    };
  }

  for (const targetTick of [30, 60, 90, 120] as const) {
    test(`player and NPC positions agree at tick ${targetTick} across 60/30/20/4 Hz`, () => {
      const at60 = sample(runTo(60, targetTick));
      for (const hz of [30, 20, 4] as const) {
        expect(sample(runTo(hz, targetTick))).toEqual(at60);
      }
    });
  }

  test("the player walks eight tiles with one wait and then sets the done switch", () => {
    // Sanity on the agreed 60 Hz trajectory: 8 right steps from tile 2 land
    // on 10 (8 steps * 8 ticks + an 8-tick wait = 72 moving ticks).
    const at120 = sample(runTo(60, 120));
    expect(at120.player.tx).toBe(10);
    expect(at120.player.moving).toBe(false);
    expect(at120.done).toBe(true);
    // The looping patrol kept moving off its authored post.
    expect(at120.npc.tx).not.toBe(2);
  });

  function afterOneSecond(hz: number, events: GameEvent[]): SessionState {
    const p = project([map("a", 64, 8, events)], { map: "a", x: 2, y: 2, dir: "right" });
    const sess = createSession(p, hz);
    return run(sess, startSession(p, sess), hz);
  }

  test("a ten-step forced player route has a pinned one-second state at every rate", () => {
    const driver = ge("driver", 0, 0, page("autorun", [
      {
        op: "moveRoute",
        target: "player",
        wait: true,
        route: {
          steps: new Array<MoveStep>(10).fill("moveRight"),
          repeat: false,
          skippable: false,
        },
      },
      { op: "switch", id: "route-done", value: true },
    ]));
    for (const hz of [60, 30, 20, 4] as const) {
      const state = afterOneSecond(hz, [driver]);
      expect({
        tx: state.move.tx, px: state.move.px, moving: state.move.moving,
        phase: state.playerRoute?.phase ?? null, pc: state.playerRoute?.pc ?? null,
        done: state.sw.switches["route-done"] ?? false,
      }).toEqual({ tx: 10, px: 166, moving: true, phase: 3, pc: 9, done: false });
    }
  });

  test("a twenty-step NPC patrol has a pinned one-second state at every rate", () => {
    const npc = ge("npc", 10, 4, page("action", [], {
      moveRoute: {
        steps: [
          ...new Array<MoveStep>(10).fill("moveRight"),
          ...new Array<MoveStep>(10).fill("moveLeft"),
        ],
        repeat: true,
        skippable: false,
      },
    }));
    for (const hz of [60, 30, 20, 4] as const) {
      const ch = afterOneSecond(hz, [npc]).chars.chars.npc!;
      expect({
        tx: ch.tx, px: ch.px, moving: ch.moving, phase: ch.phase,
        pc: ch.route?.pc ?? null, waitLeft: ch.route?.waitLeft ?? null,
      }).toEqual({ tx: 17, px: 280, moving: true, phase: 4, pc: 8, waitLeft: 0 });
    }
  });

  test("in-route waits retain five reference ticks after one second at every rate", () => {
    const npc = ge("npc", 10, 4, page("action", [], {
      moveRoute: {
        steps: ["moveRight", "moveRight", "wait", "wait", "moveLeft", "moveLeft", "wait", "wait"],
        repeat: true,
        skippable: false,
      },
    }));
    for (const hz of [60, 30, 20, 4] as const) {
      const ch = afterOneSecond(hz, [npc]).chars.chars.npc!;
      expect({
        tx: ch.tx, px: ch.px, moving: ch.moving, phase: ch.phase,
        pc: ch.route?.pc ?? null, waitLeft: ch.route?.waitLeft ?? null,
      }).toEqual({ tx: 10, px: 160, moving: false, phase: 0, pc: 0, waitLeft: 5 });
    }
  });

  test("sequential waited routes consume the remaining ticks in their host frame", () => {
    const driver = ge("driver", 0, 0, page("autorun", Array.from(
      { length: 12 },
      () => ({
        op: "moveRoute" as const,
        target: "player" as const,
        wait: true,
        route: { steps: ["moveRight" as const], repeat: false, skippable: false },
      }),
    )));
    const p = project([map("a", 24, 8, [driver])], { map: "a", x: 2, y: 2, dir: "right" });
    const samples = [60, 30, 20, 4].map((hz) => {
      const sess = createSession(p, hz);
      const state = run(sess, startSession(p, sess), hz);
      return {
        tx: state.move.tx, px: state.move.px, moving: state.move.moving,
        phase: state.playerRoute?.phase ?? null, pc: state.playerRoute?.pc ?? null,
      };
    });
    expect(samples.slice(1)).toEqual([samples[0], samples[0], samples[0]]);
  });

  test("contested player and NPC routes interleave in reference-tick order", () => {
    const driver = ge("driver", 0, 0, page("autorun", [{
      op: "moveRoute",
      target: "player",
      wait: true,
      route: { steps: new Array<MoveStep>(30).fill("moveRight"), repeat: false, skippable: false },
    }]));
    const npc = ge("npc", 2, 2, page("action", [], {
      blocks: true,
      moveRoute: {
        steps: new Array<MoveStep>(30).fill("moveRight"),
        repeat: true,
        skippable: false,
      },
    }));
    const p = project([map("a", 96, 8, [driver, npc])], { map: "a", x: 1, y: 2, dir: "right" });
    const samples = [60, 30, 20, 4].map((hz) => {
      const sess = createSession(p, hz);
      const state = run(sess, startSession(p, sess), hz);
      const ch = state.chars.chars.npc!;
      return {
        player: { tx: state.move.tx, px: state.move.px, phase: state.playerRoute?.phase },
        npc: { tx: ch.tx, px: ch.px, phase: ch.phase },
      };
    });
    expect(samples.slice(1)).toEqual([samples[0], samples[0], samples[0]]);
  });
});

describe("session reducer purity", () => {
  test("advancing a player route never mutates retained input states", () => {
    const driver = ge("driver", 0, 0, page("autorun", [{
      op: "moveRoute",
      target: "player",
      wait: true,
      route: {
        steps: ["moveRight", "wait", "moveRight"],
        repeat: true,
        skippable: false,
      },
    }]));
    const p = project([map("a", 24, 8, [driver])], { map: "a", x: 2, y: 2, dir: "right" });
    const sess = createSession(p, 60);
    const retained: Array<{ state: SessionState; json: string }> = [];
    let state = startSession(p, sess);

    for (let frame = 0; frame < 40; frame++) {
      retained.push({ state, json: JSON.stringify(state) });
      state = stepSession(sess, state, { buttons: 0 });
      for (const previous of retained.slice(-4)) {
        expect(JSON.stringify(previous.state)).toBe(previous.json);
      }
    }
  });
});
