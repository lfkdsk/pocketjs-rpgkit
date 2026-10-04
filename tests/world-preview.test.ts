// Read-only NPC preview of a map the player has not entered yet. The unit
// tests pin each selection/rejection rule of selectWorldMapPreview against
// hand-built maps; the handoff tests check that the preview of a seamless
// neighbour is exactly what map-entry page sync creates once the crossing
// commits, at every host rate and across save/restore.

import { describe, expect, test } from "bun:test";
import { createSwitchState, type SwitchState } from "../src/engine/interpreter.ts";
import { loadSession, saveSession } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import { createWorldHandoffResolver } from "../src/engine/world-handoff.ts";
import {
  createWorldPreviewReader,
  selectWorldMapPreview,
  summarizeWorldPreviewCoverage,
  WORLD_PREVIEW_REJECT_REASONS,
  type WorldMapPreview,
} from "../src/engine/world-preview.ts";
import type {
  Command,
  CommonEvent,
  Condition,
  Dir,
  GameEvent,
  MapDef,
  Page,
  PageCondition,
  Project,
} from "../src/engine/types.ts";
import {
  handoffMap,
  handoffProject,
  HANDOFF_LAYOUT,
  markedTransfer,
  playerTouchTransfer,
  SAFE_EAST,
} from "./fixtures/seamless-handoff/fixture-data.ts";

// --- builders ----------------------------------------------------------------

function page(fields: Partial<Page> = {}): Page {
  return { trigger: "action", commands: [], ...fields };
}

function npc(id: string, x: number, y: number, pages: Page[]): GameEvent {
  return { id, x, y, pages };
}

/** One painting page plus a higher page gated by `condition`. */
function gated(id: string, condition: PageCondition, x = 1, y = 1): GameEvent {
  return npc(id, x, y, [page({ sprite: `${id}-base` }), page({ sprite: `${id}-gated`, condition })]);
}

function clause(c: Condition): PageCondition {
  return { all: [c] };
}

function autorunEvent(id: string, commands: Command[], condition?: PageCondition): GameEvent {
  return npc(id, 0, 0, [page({ trigger: "autorun", commands, ...(condition ? { condition } : {}) })]);
}

function parallelEvent(id: string, commands: Command[], condition?: PageCondition): GameEvent {
  return npc(id, 0, 0, [page({ trigger: "parallel", commands, ...(condition ? { condition } : {}) })]);
}

function preview(
  events: GameEvent[],
  sw: SwitchState = createSwitchState(),
  commonEvents?: CommonEvent[],
): WorldMapPreview {
  return selectWorldMapPreview(handoffMap("east", events), sw, commonEvents ? { commonEvents } : {});
}

function actorOf(result: WorldMapPreview, id: string) {
  return result.actors.find((actor) => actor.eventId === id);
}

function reasonOf(result: WorldMapPreview, id: string) {
  return result.rejected.find((entry) => entry.eventId === id)?.reason;
}

const ROUTE = { steps: ["moveLeft" as const], repeat: false, skippable: true };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

// --- session helpers -----------------------------------------------------------

function runtime(project: Project, hz = 60, sw0?: SwitchState): { session: Session; state: SessionState } {
  const session = createSession(project, hz, {
    handoff: createWorldHandoffResolver(HANDOFF_LAYOUT),
  });
  return { session, state: startSession(project, session, sw0) };
}

function step(session: Session, state: SessionState, frames = 1, buttons = 0): SessionState {
  let next = state;
  for (let frame = 0; frame < frames; frame++) next = stepSession(session, next, { buttons });
  return next;
}

const RIGHT = 0x0020;
const DIR_INDEX: Record<Dir, 0 | 1 | 2 | 3> = { down: 0, left: 1, up: 2, right: 3 };

function mapOf(project: Project, id: string): MapDef {
  return project.maps.find((map) => map.id === id)!;
}

/** East holds a static NPC, a random wanderer, a patrol, a switch-ON NPC, a
 * switch-OFF NPC, an NPC whose switch an entry autorun writes, the writer
 * itself and a parallel counter. */
const EAST_EVENTS: GameEvent[] = [
  npc("a-static", 2, 2, [page({ sprite: "npc-a", dir: "left" })]),
  npc("b-wander", 3, 3, [page({ sprite: "npc-b", moveType: "random" })]),
  npc("c-patrol", 2, 0, [page({
    sprite: "npc-c",
    dir: "right",
    moveRoute: { steps: ["moveDown", "moveUp"], repeat: true, skippable: true },
  })]),
  npc("d-lamp", 1, 3, [page({ sprite: "npc-d", dir: "up", condition: { switch: "east.lamp" } })]),
  npc("e-off", 1, 2, [page({ sprite: "npc-e", condition: { switch: "east.off" } })]),
  npc("f-written", 3, 0, [
    page({ sprite: "npc-f0" }),
    page({ sprite: "npc-f1", condition: { switch: "east.flag" } }),
  ]),
  npc("g-writer", 0, 3, [
    page({
      trigger: "autorun",
      commands: [
        { op: "switch", id: "east.flag", value: true },
        { op: "selfSwitch", key: "A", value: true },
      ],
    }),
    page({ condition: { selfSwitch: "A" } }),
  ]),
  npc("h-counter", 0, 2, [page({
    trigger: "parallel",
    commands: [{ op: "variable", id: "east.ran", set: { op: "add", value: 1 } }],
  })]),
];

function eastProject(westEvents: GameEvent[] = []): Project {
  return handoffProject({
    start: { map: "west", x: 2, y: 1, dir: "right" },
    sourceEvent: playerTouchTransfer("to-east", 3, 1, markedTransfer("east", 0, 1, "right", SAFE_EAST)),
    mapEvents: { east: EAST_EVENTS, west: westEvents },
  });
}

function lampOn(): SwitchState {
  return createSwitchState({ switches: { "east.lamp": true } });
}

function eastPreview(project: Project, sw: SwitchState): WorldMapPreview {
  return selectWorldMapPreview(mapOf(project, "east"), sw, { commonEvents: project.commonEvents });
}

// --- rules ---------------------------------------------------------------------

describe("selectWorldMapPreview: entry snapshot", () => {
  test("previews the entry page at the authored cell and page facing", () => {
    const result = preview([
      npc("guard", 2, 2, [page({ sprite: "guard", dir: "left" })]),
      npc("plain", 1, 3, [page({ sprite: "plain" })]),
      npc("sign", 0, 0, [page({ trigger: "action" })]),
    ]);
    expect(result.mapId).toBe("east");
    expect(result.actors).toEqual([
      { eventId: "guard", pageIndex: 0, x: 2, y: 2, dir: "left", sprite: "guard" },
      { eventId: "plain", pageIndex: 0, x: 1, y: 3, dir: "down", sprite: "plain" },
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.hidden).toBe(1);
    expect(result.events).toBe(3);
  });

  test("an event with no holding page is hidden", () => {
    const result = preview([npc("ghost", 1, 1, [page({ sprite: "ghost", condition: { switch: "never" } })])]);
    expect(result.actors).toEqual([]);
    expect(result.hidden).toBe(1);
  });
});

describe("selectWorldMapPreview: page selection follows durable state", () => {
  test("a switch-gated higher page wins only while the switch is on", () => {
    const events = [gated("npc", { switch: "gate" })];
    expect(actorOf(preview(events), "npc")).toMatchObject({ pageIndex: 0, sprite: "npc-base" });
    const on = preview(events, createSwitchState({ switches: { gate: true } }));
    expect(actorOf(on, "npc")).toMatchObject({ pageIndex: 1, sprite: "npc-gated" });
  });

  test("local switches and variables read as cleared on entry", () => {
    const sw = createSwitchState({
      switches: { "local.door": true, door: true },
      variables: { "local.count": 5, count: 5 },
    });
    const result = preview([
      gated("local-switch", { switch: "local.door" }),
      gated("durable-switch", { switch: "door" }),
      gated("local-clause", clause({ kind: "switch", id: "local.door" })),
      gated("local-var", { variable: { id: "local.count", op: ">=", value: 1 } }),
      gated("durable-var", { variable: { id: "count", op: ">=", value: 1 } }),
      gated("local-var-clause", clause({ kind: "variable", id: "local.count", op: "==", value: 0 })),
    ], sw);
    expect(actorOf(result, "local-switch")?.pageIndex).toBe(0);
    expect(actorOf(result, "durable-switch")?.pageIndex).toBe(1);
    expect(actorOf(result, "local-clause")?.pageIndex).toBe(0);
    expect(actorOf(result, "local-var")?.pageIndex).toBe(0);
    expect(actorOf(result, "durable-var")?.pageIndex).toBe(1);
    expect(actorOf(result, "local-var-clause")?.pageIndex).toBe(1);
  });

  test("self switches are keyed by this map and event", () => {
    const events = [gated("npc", { selfSwitch: "A" })];
    expect(actorOf(preview(events, createSwitchState({ self: { "east/npc": "A" } })), "npc")?.pageIndex).toBe(1);
    expect(actorOf(preview(events, createSwitchState({ self: { "west/npc": "A" } })), "npc")?.pageIndex).toBe(0);
    expect(actorOf(preview(events, createSwitchState({ self: { "east/npc": "B" } })), "npc")?.pageIndex).toBe(0);
    const offClause = [gated("npc", clause({ kind: "selfSwitch", key: "A", value: false }))];
    expect(actorOf(preview(offClause), "npc")?.pageIndex).toBe(1);
    expect(actorOf(preview(offClause, createSwitchState({ self: { "east/npc": "A" } })), "npc")?.pageIndex).toBe(0);
  });

  test("variable, item, gold and player-appearance conditions", () => {
    const events = [
      gated("var", { variable: { id: "v", op: ">=", value: 3 } }),
      gated("var-ne", clause({ kind: "variable", id: "v", op: "!=", value: 3 })),
      gated("item", { item: "key" }),
      gated("items", clause({ kind: "item", id: "gem", count: 2 })),
      gated("gold", clause({ kind: "gold", amount: 100 })),
      gated("look", clause({ kind: "appearance", target: "player", sprite: "hero-alt" })),
    ];
    const low = preview(events, createSwitchState({ variables: { v: 2 }, items: { gem: 1 }, gold: 99 }));
    const high = preview(events, createSwitchState({
      variables: { v: 3 },
      items: { key: 1, gem: 2 },
      gold: 100,
      playerAppearance: { sprite: "hero-alt" },
    }));
    expect(low.actors.map((actor) => [actor.eventId, actor.pageIndex])).toEqual([
      ["gold", 0], ["item", 0], ["items", 0], ["look", 0], ["var", 0], ["var-ne", 1],
    ]);
    expect(high.actors.map((actor) => [actor.eventId, actor.pageIndex])).toEqual([
      ["gold", 1], ["item", 1], ["items", 1], ["look", 1], ["var", 1], ["var-ne", 0],
    ]);
  });
});

describe("selectWorldMapPreview: undecidable conditions", () => {
  test("each context clause rejects with its reason", () => {
    const result = preview([
      gated("facing", clause({ kind: "facing", dir: "up" })),
      gated("idle", clause({ kind: "worldIdle" })),
      gated("bgm", clause({ kind: "bgmPlaying" })),
      gated("timer", clause({ kind: "timer", op: ">=", seconds: 1 })),
      gated("ext", clause({ kind: "ext", call: "game.flag", args: null })),
      gated("tile", clause({ kind: "tileProperty", x: 0, y: 0, passage: "block" })),
      gated("region", clause({ kind: "region", x: 0, y: 0, id: 1 })),
      gated("other-look", clause({ kind: "appearance", target: { event: "facing" }, sprite: null })),
      gated("this-look", clause({ kind: "appearance", target: "this", sprite: null })),
    ]);
    expect(result.actors).toEqual([]);
    expect(Object.fromEntries(result.rejected.map((entry) => [entry.eventId, entry.reason]))).toEqual({
      facing: "facing-condition",
      idle: "runtime-condition",
      bgm: "runtime-condition",
      timer: "runtime-condition",
      ext: "extension-condition",
      tile: "visit-condition",
      region: "visit-condition",
      "other-look": "visit-condition",
      "this-look": "visit-condition",
    });
  });

  test("a context page below a holding page does not reject", () => {
    const result = preview([
      npc("npc", 1, 1, [
        page({ sprite: "low", condition: clause({ kind: "facing", dir: "up" }) }),
        page({ sprite: "high" }),
      ]),
    ]);
    expect(result.actors).toEqual([{ eventId: "npc", pageIndex: 1, x: 1, y: 1, dir: "down", sprite: "high" }]);
    expect(result.rejected).toEqual([]);
  });

  test("a context page above a false durable page still rejects", () => {
    const result = preview([
      npc("npc", 1, 1, [
        page({ sprite: "low", condition: { switch: "off" } }),
        page({ sprite: "high", condition: clause({ kind: "worldIdle" }) }),
      ]),
    ]);
    expect(reasonOf(result, "npc")).toBe("runtime-condition");
  });

  test("a context page on an event that never paints is hidden", () => {
    const result = preview([
      npc("invisible", 1, 1, [page(), page({ condition: clause({ kind: "facing", dir: "up" }) })]),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.actors).toEqual([]);
    expect(result.hidden).toBe(1);
  });

  test("the reported reason follows declaration order, not clause or page order", () => {
    const region: Condition = { kind: "region", x: 0, y: 0, id: 1 };
    const facing: Condition = { kind: "facing", dir: "up" };
    const idle: Condition = { kind: "worldIdle" };
    // Both clauses on one page, in either order: facing-condition ranks first.
    for (const all of [[region, facing], [facing, region]]) {
      expect(reasonOf(preview([gated("npc", { all })]), "npc"), JSON.stringify(all)).toBe("facing-condition");
    }
    // Two undecidable pages above a holding base page, in either order.
    const pages = [page({ sprite: "region", condition: clause(region) }), page({ sprite: "idle", condition: clause(idle) })];
    for (const above of [pages, [...pages].reverse()]) {
      const result = preview([npc("npc", 1, 1, [page({ sprite: "base" }), ...above])]);
      expect(reasonOf(result, "npc")).toBe("runtime-condition");
    }
  });

  test("duplicate event ids reject both copies", () => {
    const result = preview([
      npc("twin", 1, 1, [page({ sprite: "a" })]),
      npc("twin", 2, 2, [page({ sprite: "b" })]),
      npc("solo", 3, 3, [page({ sprite: "c" })]),
    ]);
    expect(result.rejected).toEqual([
      { eventId: "twin", reason: "duplicate-id" },
      { eventId: "twin", reason: "duplicate-id" },
    ]);
    expect(result.actors.map((actor) => actor.eventId)).toEqual(["solo"]);
    expect(result.events).toBe(3);
  });
});

describe("selectWorldMapPreview: entry-time writers", () => {
  test("an active autorun that writes a read switch rejects only its readers", () => {
    const events = [
      autorunEvent("writer", [{ op: "switch", id: "S", value: true }]),
      gated("reader", { switch: "S" }),
      gated("bystander", { switch: "T" }),
    ];
    const result = preview(events);
    expect(reasonOf(result, "reader")).toBe("entry-state-write");
    expect(actorOf(result, "bystander")).toMatchObject({ pageIndex: 0 });
    expect(result.hidden).toBe(1);
    // Without the writer the reader is an ordinary actor.
    expect(actorOf(preview(events.slice(1)), "reader")).toMatchObject({ pageIndex: 0 });
  });

  test("variable, item, gold, self and player-appearance writes reach their readers", () => {
    const result = preview([
      autorunEvent("writer", [
        { op: "variable", id: "v", set: { op: "set", value: 1 } },
        { op: "item", item: "key", set: "add", count: 1 },
        { op: "gold", set: "add", amount: 1 },
        { op: "appearance", target: "player", sprite: "hero-alt" },
      ]),
      gated("var", { variable: { id: "v", op: ">=", value: 1 } }),
      gated("item", { item: "key" }),
      gated("gold", clause({ kind: "gold", amount: 1 })),
      gated("look", clause({ kind: "appearance", target: "player", sprite: "hero-alt" })),
      gated("other-var", { variable: { id: "w", op: ">=", value: 1 } }),
      npc("self", 1, 1, [
        page({ sprite: "self-a", trigger: "parallel", commands: [{ op: "selfSwitch", key: "A", value: true }] }),
        page({ sprite: "self-b", condition: { selfSwitch: "A" } }),
      ]),
    ]);
    expect(reasonOf(result, "var")).toBe("entry-state-write");
    expect(reasonOf(result, "item")).toBe("entry-state-write");
    expect(reasonOf(result, "gold")).toBe("entry-state-write");
    expect(reasonOf(result, "look")).toBe("entry-state-write");
    expect(reasonOf(result, "self")).toBe("entry-state-write");
    expect(actorOf(result, "other-var")).toBeDefined();
  });

  test("an autorun gated off by unwritten state does not reject", () => {
    const events = [
      autorunEvent("writer", [{ op: "switch", id: "S", value: true }], { switch: "G" }),
      gated("reader", { switch: "S" }),
    ];
    expect(actorOf(preview(events), "reader")).toMatchObject({ pageIndex: 0 });
    expect(reasonOf(preview(events, createSwitchState({ switches: { G: true } })), "reader"))
      .toBe("entry-state-write");
  });

  test("writes close over pages they switch on", () => {
    const chain = [
      parallelEvent("second", [{ op: "switch", id: "B", value: true }], { switch: "A" }),
      gated("reader", { switch: "B" }),
    ];
    expect(actorOf(preview(chain), "reader")).toBeDefined();
    const result = preview([autorunEvent("first", [{ op: "switch", id: "A", value: true }]), ...chain]);
    expect(reasonOf(result, "reader")).toBe("entry-state-write");
  });

  test("actor commands reject the targeted event", () => {
    for (const command of [
      { op: "moveRoute", target: { event: "npc" }, route: ROUTE },
      { op: "moveControl", target: { event: "npc" }, control: { through: true } },
      { op: "place", target: { event: "npc" }, x: 0, y: 0 },
      { op: "appearance", target: { event: "npc" }, sprite: "other" },
    ] as Command[]) {
      const result = preview([
        autorunEvent("director", [command]),
        npc("npc", 1, 1, [page({ sprite: "npc" })]),
        npc("extra", 2, 2, [page({ sprite: "extra" })]),
      ]);
      expect(reasonOf(result, "npc"), command.op).toBe("entry-actor-command");
      expect(actorOf(result, "extra"), command.op).toBeDefined();
    }
  });

  test("this-targeted actor commands on the event's own parallel page reject it", () => {
    for (const command of [
      { op: "erase" },
      { op: "moveRoute", target: "this", route: ROUTE },
      { op: "place", target: "this", x: 0, y: 0 },
      { op: "appearance", target: "this", visible: false },
    ] as Command[]) {
      const result = preview([
        npc("npc", 1, 1, [page({ sprite: "npc", trigger: "parallel", commands: [command] })]),
        npc("extra", 2, 2, [page({ sprite: "extra" })]),
      ]);
      expect(reasonOf(result, "npc"), command.op).toBe("entry-actor-command");
      expect(actorOf(result, "extra"), command.op).toBeDefined();
    }
    // The same page on an action trigger does not run on entry.
    const idle = preview([npc("npc", 1, 1, [page({ sprite: "npc", commands: [{ op: "erase" }] })])]);
    expect(actorOf(idle, "npc")).toBeDefined();
  });

  test("an opaque command in an active autorun rejects every painting event", () => {
    for (const command of [
      { op: "ext", call: "game.thing", args: null },
      { op: "battle", setup: null },
      { op: "transfer", map: "west", x: 0, y: 0 },
      { op: "common", id: "missing" },
      { op: "autosave" },
    ] as Command[]) {
      const result = preview([
        autorunEvent("opaque", [command]),
        npc("a", 1, 1, [page({ sprite: "a" })]),
        npc("b", 2, 2, [page({ sprite: "b", condition: { switch: "never" } }), page({ sprite: "b2" })]),
      ]);
      expect(result.actors, command.op).toEqual([]);
      expect(result.rejected, command.op).toEqual([
        { eventId: "a", reason: "entry-opaque-command" },
        { eventId: "b", reason: "entry-opaque-command" },
      ]);
      expect(result.hidden, command.op).toBe(1);
    }
    const gatedOff = preview([
      autorunEvent("opaque", [{ op: "battle", setup: null }], { switch: "never" }),
      npc("a", 1, 1, [page({ sprite: "a" })]),
    ]);
    expect(actorOf(gatedOff, "a")).toBeDefined();
  });

  test("common calls are followed, including recursive ones", () => {
    const commonEvents: CommonEvent[] = [
      { id: "outer", trigger: "none", commands: [{ op: "common", id: "inner" }] },
      {
        id: "inner",
        trigger: "none",
        commands: [{ op: "common", id: "outer" }, { op: "if", if: { kind: "gold", amount: 1 }, then: [
          { op: "switch", id: "S", value: true },
        ] }],
      },
    ];
    const events = [
      autorunEvent("caller", [{ op: "common", id: "outer" }]),
      gated("reader", { switch: "S" }),
      gated("bystander", { switch: "T" }),
    ];
    const result = preview(events, createSwitchState(), commonEvents);
    expect(reasonOf(result, "reader")).toBe("entry-state-write");
    expect(actorOf(result, "bystander")).toBeDefined();
  });

  test("a call to a missing common event is opaque, though the runtime skips it", () => {
    const events = [autorunEvent("caller", [{ op: "common", id: "nowhere" }]), gated("reader", { switch: "S" })];
    expect(reasonOf(preview(events, createSwitchState(), []), "reader")).toBe("entry-opaque-command");
  });

  test("the session never starts a parallel common event by itself", () => {
    // Pins the runtime fact behind the conservative rule below.
    const project = handoffProject({ start: { map: "west", x: 2, y: 1, dir: "right" } });
    project.commonEvents = [{ id: "ticker", trigger: "parallel", commands: [{ op: "switch", id: "ticked", value: true }] }];
    const { session, state } = runtime(project);
    expect(step(session, state, 30).sw.switches.ticked).toBeUndefined();
  });

  test("gated-on parallel common events count as entry writers, conservatively", () => {
    const commonEvents: CommonEvent[] = [{
      id: "ticker",
      trigger: "parallel",
      conditionSwitch: "clock",
      commands: [{ op: "switch", id: "S", value: true }],
    }];
    const events = [gated("reader", { switch: "S" })];
    expect(actorOf(preview(events, createSwitchState(), commonEvents), "reader")).toBeDefined();
    const on = preview(events, createSwitchState({ switches: { clock: true } }), commonEvents);
    expect(reasonOf(on, "reader")).toBe("entry-state-write");
    // An entry writer can also switch the common event on.
    const started = preview(
      [autorunEvent("starter", [{ op: "switch", id: "clock", value: true }]), ...events],
      createSwitchState(),
      commonEvents,
    );
    expect(reasonOf(started, "reader")).toBe("entry-state-write");
    // A trigger-none common event never runs by itself.
    const idle: CommonEvent[] = [{ ...commonEvents[0]!, trigger: "none" }];
    expect(actorOf(preview(events, createSwitchState({ switches: { clock: true } }), idle), "reader")).toBeDefined();
  });
});

describe("selectWorldMapPreview: caches", () => {
  test("a shared common-event commands array is analysed per common-event list", () => {
    const ticker: Command[] = [{ op: "common", id: "body" }];
    const listA: CommonEvent[] = [
      { id: "ticker", trigger: "parallel", commands: ticker },
      { id: "body", trigger: "none", commands: [{ op: "switch", id: "T", value: true }] },
    ];
    const listB: CommonEvent[] = [
      { id: "ticker", trigger: "parallel", commands: ticker },
      { id: "body", trigger: "none", commands: [{ op: "switch", id: "S", value: true }] },
    ];
    const events = [gated("reader", { switch: "S" })];
    expect(actorOf(preview(events, createSwitchState(), listA), "reader")).toBeDefined();
    expect(reasonOf(preview(events, createSwitchState(), listB), "reader")).toBe("entry-state-write");
  });

  test("the reader returns the same preview until a read value changes", () => {
    const map = handoffMap("east", [gated("reader", { switch: "S" }), npc("plain", 2, 2, [page({ sprite: "p" })])]);
    const reader = createWorldPreviewReader();
    const sw = createSwitchState();
    const first = reader.read(map, sw);
    expect(first).toEqual(selectWorldMapPreview(map, sw));
    // Unrelated and local writes do not change what the map reads.
    sw.switches.unrelated = true;
    sw.switches["local.S"] = true;
    expect(reader.read(map, sw)).toBe(first);
    // An in-place write of a read id is detected by value.
    sw.switches.S = true;
    const second = reader.read(map, sw);
    expect(second).not.toBe(first);
    expect(actorOf(second, "reader")?.sprite).toBe("reader-gated");
    expect(reader.read(map, createSwitchState({ switches: { S: true } }))).toBe(second);
  });
});

describe("selectWorldMapPreview: purity", () => {
  test("never writes its frozen inputs and is repeatable", () => {
    const commonEvents = deepFreeze<CommonEvent[]>([{
      id: "ticker",
      trigger: "parallel",
      commands: [{ op: "variable", id: "n", set: { op: "add", value: 1 } }],
    }]);
    const map = deepFreeze(handoffMap("east", [
      autorunEvent("writer", [{ op: "switch", id: "S", value: true }]),
      gated("reader", { switch: "S" }),
      gated("counter", { variable: { id: "n", op: ">=", value: 1 } }),
      gated("plain", { switch: "gate" }),
      npc("twin", 1, 1, [page({ sprite: "t" })]),
      npc("twin", 2, 1, [page({ sprite: "t" })]),
    ]));
    const sw = deepFreeze(createSwitchState({
      switches: { gate: true, "local.x": true },
      variables: { "local.y": 1 },
      self: { "east/plain": "A" },
    }));
    const first = selectWorldMapPreview(map, sw, { commonEvents });
    const second = selectWorldMapPreview(map, sw, { commonEvents });
    expect(second).toEqual(first);
    expect(first.actors).toEqual([{ eventId: "plain", pageIndex: 1, x: 1, y: 1, dir: "down", sprite: "plain-gated" }]);
    expect(first.rejected).toEqual([
      { eventId: "counter", reason: "entry-state-write" },
      { eventId: "reader", reason: "entry-state-write" },
      { eventId: "twin", reason: "duplicate-id" },
      { eventId: "twin", reason: "duplicate-id" },
    ]);
  });
});

// --- handoff consistency -------------------------------------------------------

/** Assert that the characters page sync created on `state` match the
 * preview's actors: cell, page, sprite and visibility for all of them, and
 * the spawn facing for actors without autonomous motion. A wanderer or a
 * patrol is created and advanced in the same reference tick, so the first
 * state that holds it already shows that tick's turn/step. */
function expectCharsMatchPreview(project: Project, state: SessionState, result: WorldMapPreview, label: string): void {
  const east = mapOf(project, "east");
  for (const actor of result.actors) {
    const char = state.chars.chars[actor.eventId];
    const where = `${label} ${actor.eventId}`;
    expect(char, where).toBeDefined();
    expect(
      { tx: char!.tx, ty: char!.ty, pageIndex: char!.pageIndex, visible: char!.visible },
      where,
    ).toEqual({ tx: actor.x, ty: actor.y, pageIndex: actor.pageIndex, visible: true });
    const pageDef = east.events!.find((event) => event.id === actor.eventId)!.pages[char!.pageIndex]!;
    expect(pageDef.sprite, where).toBe(actor.sprite);
    const moves = (pageDef.moveType ?? "static") !== "static" || pageDef.moveRoute !== undefined;
    if (!moves) expect(char!.facing, where).toBe(DIR_INDEX[actor.dir]);
  }
}

describe("world preview across a seamless handoff", () => {
  test("the preview is stable before commit and matches entry page sync", () => {
    const project = eastProject();
    const { session } = runtime(project, 60, lampOn());
    let state = startSession(project, session, lampOn());

    const expected = eastPreview(project, state.sw);
    expect(expected.actors).toEqual([
      { eventId: "a-static", pageIndex: 0, x: 2, y: 2, dir: "left", sprite: "npc-a" },
      { eventId: "b-wander", pageIndex: 0, x: 3, y: 3, dir: "down", sprite: "npc-b" },
      { eventId: "c-patrol", pageIndex: 0, x: 2, y: 0, dir: "right", sprite: "npc-c" },
      { eventId: "d-lamp", pageIndex: 0, x: 1, y: 3, dir: "up", sprite: "npc-d" },
    ]);
    expect(expected.rejected).toEqual([{ eventId: "f-written", reason: "entry-state-write" }]);
    expect(expected.hidden).toBe(3);
    expect(expected.events).toBe(8);

    // On the source map and through the whole crossing, east never runs and
    // its preview never changes.
    let crossingTicks = 0;
    for (let tick = 0; tick < 40 && state.mapId === "west"; tick++) {
      expect(eastPreview(project, state.sw), `tick ${tick}`).toEqual(expected);
      expect(Object.hasOwn(state.sw.variables, "east.ran"), `tick ${tick}`).toBe(false);
      expect(state.sw.switches["east.flag"], `tick ${tick}`).toBeUndefined();
      if (state.handoff) crossingTicks++;
      state = stepSession(session, state, { buttons: tick < 8 ? RIGHT : 0 });
    }
    expect(crossingTicks).toBe(8);
    expect(state.mapId).toBe("east");
    expect(Object.keys(state.chars.chars)).toHaveLength(0);
    expect(Object.hasOwn(state.sw.variables, "east.ran")).toBe(false);
    expect(eastPreview(project, state.sw)).toEqual(expected);

    state = step(session, state);
    expectCharsMatchPreview(project, state, expected, "60Hz");
    // Every previewed id appears exactly once; the other chars are the live
    // rejected/hidden-but-active events, and the switch-off NPC has none.
    expect(Object.keys(state.chars.chars).sort()).toEqual([
      "a-static", "b-wander", "c-patrol", "d-lamp", "f-written", "g-writer", "h-counter",
    ]);
    for (const id of ["g-writer", "h-counter"]) expect(state.chars.chars[id]!.visible).toBe(false);
    expect(state.chars.chars["e-off"]).toBeUndefined();

    // The target programs are live after commit, so their zero execution
    // before commit was meaningful.
    state = step(session, state, 4);
    expect(state.sw.variables["east.ran"]).toBeGreaterThan(0);
    expect(state.sw.switches["east.flag"]).toBe(true);
  });

  test("the switch-OFF preview hides the gated NPC and it gets no character", () => {
    const project = eastProject();
    const { session, state: start } = runtime(project);
    const expected = eastPreview(project, start.sw);
    expect(actorOf(expected, "d-lamp")).toBeUndefined();
    expect(expected.hidden).toBe(4);
    let state = step(session, start, 8, RIGHT);
    state = step(session, state, 8);
    expect(state.mapId).toBe("east");
    state = step(session, state);
    expectCharsMatchPreview(project, state, expected, "lamp off");
    expect(state.chars.chars["d-lamp"]).toBeUndefined();
  });

  test("the same traversal previews identically at 20, 30 and 60 Hz", () => {
    const project = eastProject();
    const runs = ([20, 30, 60] as const).map((hz) => {
      const { session, state: start } = runtime(project, hz, lampOn());
      const movementFrames = Math.ceil(8 / (60 / hz));
      let state = start;
      const previews: WorldMapPreview[] = [];
      for (let frame = 0; frame < hz && state.mapId === "west"; frame++) {
        previews.push(eastPreview(project, state.sw));
        state = stepSession(session, state, { buttons: frame < movementFrames ? RIGHT : 0 });
      }
      expect(state.mapId, `${hz}Hz`).toBe("east");
      // A low-rate host frame may fold target ticks after the commit tick;
      // the first state holding characters is the first presented frame.
      if (Object.keys(state.chars.chars).length === 0) state = step(session, state);
      return { hz, previews, state };
    });
    const reference = runs[2]!.previews[0]!;
    expect(reference.actors).toHaveLength(4);
    for (const run of runs) {
      expect(run.previews.length, `${run.hz}Hz`).toBeGreaterThan(0);
      for (const [frame, value] of run.previews.entries()) {
        expect(value, `${run.hz}Hz frame ${frame}`).toEqual(reference);
      }
      expectCharsMatchPreview(project, run.state, reference, `${run.hz}Hz`);
    }
  });

  test("save and restore on the source map preserve the preview", () => {
    // A west autorun turns on the switch that gates an east NPC.
    const toggler = npc("toggler", 0, 0, [
      page({
        trigger: "autorun",
        commands: [
          { op: "switch", id: "east.lamp", value: true },
          { op: "selfSwitch", key: "A", value: true },
        ],
      }),
      page({ condition: { selfSwitch: "A" } }),
    ]);
    const project = eastProject([toggler]);
    const original = runtime(project);
    const untouched = eastPreview(project, original.state.sw);
    const state = step(original.session, original.state, 3);
    expect(state.mapId).toBe("west");
    expect(state.sw.switches["east.lamp"]).toBe(true);
    const before = eastPreview(project, state.sw);
    expect(before).not.toEqual(untouched);
    expect(actorOf(before, "d-lamp")).toBeDefined();

    const saving = saveSession(original.session, state, 0);
    expect(saving.ok).toBe(true);
    if (!saving.ok) return;
    const resumed = runtime(project);
    const loaded = loadSession(resumed.session, saving.snapshot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.state.mapId).toBe("west");
    expect(eastPreview(project, loaded.state.sw)).toEqual(before);
  });
});

describe("summarizeWorldPreviewCoverage", () => {
  test("sums previews and reports every reason", () => {
    const first = preview([
      npc("a", 1, 1, [page({ sprite: "a" })]),
      npc("b", 2, 2, [page()]),
      gated("c", clause({ kind: "facing", dir: "up" })),
    ]);
    const second = preview([
      npc("twin", 1, 1, [page({ sprite: "t" })]),
      npc("twin", 2, 2, [page({ sprite: "t" })]),
      gated("d", clause({ kind: "region", x: 0, y: 0, id: 1 })),
      npc("e", 3, 3, [page({ sprite: "e" })]),
    ]);
    const coverage = summarizeWorldPreviewCoverage([first, second]);
    expect(coverage).toEqual({
      maps: 2,
      events: 7,
      previewed: 2,
      hidden: 1,
      rejected: 4,
      reasons: {
        "duplicate-id": 2,
        "entry-opaque-command": 0,
        "facing-condition": 1,
        "runtime-condition": 0,
        "extension-condition": 0,
        "visit-condition": 1,
        "entry-actor-command": 0,
        "entry-state-write": 0,
      },
    });
    expect(Object.keys(coverage.reasons).sort()).toEqual([...WORLD_PREVIEW_REJECT_REASONS].sort());
    const empty = summarizeWorldPreviewCoverage([]);
    expect(empty.maps).toBe(0);
    for (const reason of WORLD_PREVIEW_REJECT_REASONS) expect(empty.reasons[reason]).toBe(0);
  });
});
