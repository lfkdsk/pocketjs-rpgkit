import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import { AttractController } from "../src/engine/attract.ts";
import {
  createInterpState,
  createWorld,
  effectivePlayerAppearance,
  effectivePlayerCombatSheet,
  stepInterp,
  type InterpInput,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  sessionPassageTable,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import {
  buildPassage,
  canStepFrom,
  withTilePropertyOverrides,
} from "../src/engine/passability.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  createSnapshot,
  decodeEnvelopeText,
  encodeEnvelope,
  fnv1aText,
} from "../src/engine/save.ts";
import { restoreProblem, restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import type { Command, GameEvent, MapDef, Page, Project, Sheet } from "../src/engine/types.ts";

const NO_EDGE = { confirmEdge: false, cancelEdge: false, upEdge: false, downEdge: false };
const CIRCLE = 0x2000;
const L_TRIGGER = 0x0100;

function input(partial: Partial<InterpInput> = {}): InterpInput {
  const playerCell = partial.playerCell ?? { x: 2, y: 2 };
  return {
    ...NO_EDGE,
    playerCell,
    prevCell: partial.prevCell ?? playerCell,
    facing: partial.facing ?? 2,
    ...partial,
  };
}

function page(trigger: Page["trigger"], commands: Command[], extra: Partial<Page> = {}): Page {
  return { trigger, sprite: null, commands, ...extra };
}

function event(id: string, x: number, y: number, pages: Page[]): GameEvent {
  return { id, x, y, pages };
}

function map(id: string, events: GameEvent[] = [], passage?: MapDef["passage"]): MapDef {
  return {
    id,
    name: id,
    width: 8,
    height: 8,
    sheets: ["floor"],
    ground: new Array(64).fill("floor.0"),
    ...(passage ? { passage } : {}),
    events,
  };
}

function project(maps: MapDef[]): Project {
  return {
    format: "rpgkit-project/v1",
    title: "KV1",
    tileSize: 16,
    start: { map: maps[0]!.id, x: 2, y: 2, dir: "up" },
    sheets: [{ id: "floor", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    sprites: {
      base: { kind: "image", src: "base.png" },
      next: { kind: "image", src: "next.png" },
      swimmer: { kind: "image", src: "swimmer.png" },
      hero: { kind: "image", src: "hero.png" },
    },
    maps,
  };
}

function frames(session: Session, state: SessionState, count: number, buttons = 0): SessionState {
  let next = state;
  for (let i = 0; i < count; i++) next = stepSession(session, next, { buttons });
  return next;
}

describe("KV1 appearance reducer", () => {
  test("schema accepts the three commands and two conditions and rejects malformed fields", () => {
    const commands: Command[] = [
      { op: "appearance", target: "player", sprite: "hero", opacity: 128, visible: true },
      { op: "layer", layer: "weather", visible: false, variant: "night" },
      { op: "tileProperty", x: 3, y: 2, passage: "pass", enter: [], exit: ["down"] },
      {
        op: "if",
        if: { kind: "appearance", target: "player", sprite: "hero" },
        then: [{
          op: "if",
          if: { kind: "tileProperty", x: 3, y: 2, passage: "pass", enter: [] },
          then: [],
        }],
      },
    ];
    expect(validateSchema(schema, project([map("a", [event("valid", 1, 1, [page("action", commands)])])]))).toEqual([]);

    for (const invalid of [
      { op: "appearance", target: "player", opacity: 256 },
      { op: "appearance", target: "this", sprite: "hero", saveDefault: true },
      { op: "layer", layer: "weather" },
      { op: "tileProperty", x: -1, y: 2, passage: "pass" },
    ]) {
      const bad = project([map("a", [event("bad", 1, 1, [page("action", [invalid as Command])])])]);
      expect(validateSchema(schema, bad).length, JSON.stringify(invalid)).toBeGreaterThan(0);
    }
  });

  test("player default/current appearance and a following condition fold atomically", () => {
    const commands: Command[] = [
      { op: "appearance", target: "player", sprite: "hero", saveDefault: true },
      { op: "appearance", target: "player", sprite: "swimmer" },
      {
        op: "if",
        if: { kind: "appearance", target: "player", sprite: "swimmer" },
        then: [{ op: "switch", id: "saw-swimmer", value: true }],
      },
      { op: "appearance", target: "player", sprite: null, opacity: 0, visible: false },
      {
        op: "if",
        if: { kind: "appearance", target: "player", sprite: "hero" },
        then: [{ op: "switch", id: "restored", value: true }],
      },
    ];
    const world = createWorld(map("v", [event("touch", 2, 2, [page("playerTouch", commands)])]));
    const state = stepInterp(world, createInterpState(), input({ prevCell: { x: 2, y: 3 } }));

    expect(state.sw.switches).toMatchObject({ "saw-swimmer": true, restored: true });
    expect(state.sw.playerAppearance).toEqual({ defaultSprite: "hero", opacity: 0, visible: false });
    expect(effectivePlayerAppearance(state.sw)).toEqual({ sprite: "hero", opacity: 0, visible: false });
    expect(createInterpState(state.sw).sw.playerAppearance).toEqual(state.sw.playerAppearance);
  });

  test("player combat sheet: saveDefault baseline, runtime override, and restore", () => {
    const commands: Command[] = [
      // The race choice saves the combat-sheet baseline (and the walking one).
      { op: "appearance", target: "player", sprite: "heroine", combatSheet: "heroineblack", saveDefault: true },
      // A runtime override (e.g. a scripted sheet swap).
      { op: "appearance", target: "player", combatSheet: "adventurer" },
      // combatSheet:null clears the override, restoring the saved baseline.
      { op: "appearance", target: "player", combatSheet: null },
    ];
    const world = createWorld(map("v", [event("touch", 2, 2, [page("playerTouch", commands)])]));
    let state = stepInterp(world, createInterpState(), input({ prevCell: { x: 2, y: 3 } }));
    expect(state.sw.playerAppearance).toEqual({ defaultSprite: "heroine", defaultCombatSheet: "heroineblack" });
    expect(effectivePlayerCombatSheet(state.sw)).toBe("heroineblack");

    // Re-run just the override to observe the mid-state.
    const world2 = createWorld(map("v", [event("touch", 2, 2, [page("playerTouch", [
      { op: "appearance", target: "player", sprite: "heroine", combatSheet: "heroineblack", saveDefault: true },
      { op: "appearance", target: "player", combatSheet: "adventurer" },
    ])])]));
    state = stepInterp(world2, createInterpState(), input({ prevCell: { x: 2, y: 3 } }));
    expect(state.sw.playerAppearance).toMatchObject({ defaultCombatSheet: "heroineblack", combatSheet: "adventurer" });
    expect(effectivePlayerCombatSheet(state.sw)).toBe("adventurer");

    // No appearance at all: the baked sheet (null).
    expect(effectivePlayerCombatSheet(createInterpState().sw)).toBeNull();
  });

  test("schema accepts combatSheet and rejects a non-string", () => {
    const ok: Command = { op: "appearance", target: "player", combatSheet: "heroine", saveDefault: false };
    expect(validateSchema(schema, project([map("a", [event("valid", 1, 1, [page("action", [ok])])])]))).toEqual([]);
    const bad = { op: "appearance", target: "player", combatSheet: 42, saveDefault: false } as unknown as Command;
    expect(validateSchema(schema, project([map("a", [event("bad", 1, 1, [page("action", [bad])])])])).length).toBeGreaterThan(0);
  });

  test("another event's effective appearance is writable and testable in the same tick", () => {
    const actor = event("actor", 4, 4, [page("action", [], { sprite: "base" })]);
    const controller = event("controller", 2, 1, [page("action", [
      { op: "appearance", target: { event: "actor" }, sprite: "swimmer" },
      {
        op: "if",
        if: { kind: "appearance", target: { event: "actor" }, sprite: "swimmer" },
        then: [{ op: "switch", id: "saw-event-sprite", value: true }],
      },
    ])]);
    const p = project([map("a", [controller, actor])]);
    const session = createSession(p);
    let state = frames(session, startSession(p, session), 2);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });

    expect(state.interp.eventAppearances?.actor).toEqual({ pageIndex: 0, sprite: "swimmer" });
    expect(state.sw.switches["saw-event-sprite"]).toBe(true);
  });

  test("an event override is visible on its issuing page and clears on page change", () => {
    const actor = event("actor", 2, 1, [
      page("action", [
        { op: "appearance", target: "this", sprite: "swimmer", opacity: 96 },
        { op: "switch", id: "next-page", value: true },
      ], { sprite: "base" }),
      page("action", [], { sprite: "next", condition: { switch: "next-page" } }),
    ]);
    const p = project([map("a", [actor])]);
    const session = createSession(p);
    let state = frames(session, startSession(p, session), 2);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });
    expect(state.interp.eventAppearances?.actor).toEqual({ pageIndex: 0, sprite: "swimmer", opacity: 96 });

    state = stepSession(session, state, { buttons: 0 });
    expect(state.chars.chars.actor?.pageIndex).toBe(1);
    expect(state.interp.eventAppearances).toBeUndefined();
  });
});

describe("KV1 layer and tile-property state", () => {
  test("commands are immediately testable and same-map transfer resets visit state only", () => {
    const gate = event("gate", 2, 1, [page("action", [
      { op: "appearance", target: "player", sprite: "hero", saveDefault: true },
      { op: "layer", layer: "screen", variant: "night", visible: true },
      { op: "tileProperty", x: 3, y: 2, passage: "block", enter: ["left"] },
      {
        op: "if",
        if: { kind: "tileProperty", x: 3, y: 2, passage: "block", enter: ["left"] },
        then: [{ op: "switch", id: "tile-matched", value: true }],
      },
      { op: "transfer", map: "a", x: 2, y: 2, dir: "up" },
    ])]);
    const p = project([map("a", [gate])]);
    const session = createSession(p);
    let state = frames(session, startSession(p, session), 2);
    state = stepSession(session, state, { buttons: 0, confirmEdge: true });

    expect(state.sw.switches["tile-matched"]).toBe(true);
    expect(state.sw.playerAppearance?.defaultSprite).toBe("hero");
    expect(state.interp.layers).toBeUndefined();
    expect(state.interp.tileProperties).toBeUndefined();
  });

  test("runtime passage blocks player and NPC movement without mutating the base table", () => {
    const controller = event("controller", 7, 7, [page("parallel", [
      { op: "tileProperty", x: 2, y: 1, passage: "block" },
      { op: "switch", id: "npc-go", value: true },
      { op: "wait", seconds: 60 },
    ])]);
    const npc = event("npc", 1, 1, [page("action", [], {
      condition: { switch: "npc-go" },
      moveRoute: { steps: ["moveRight"], repeat: true, skippable: false },
    })]);
    const p = project([map("a", [controller, npc])]);
    const session = createSession(p);
    const base = session.tables.get("a")!;
    let state = frames(session, startSession(p, session), 3);

    expect(state.interp.tileProperties).toEqual({ "10": { passage: "block" } });
    expect(canStepFrom(base, 2, 2, 2)).toBe(true);
    expect(canStepFrom(sessionPassageTable(session, state), 2, 2, 2)).toBe(false);
    state = frames(session, state, 24, 0x0010);
    expect([state.move.tx, state.move.ty]).toEqual([2, 2]);
    expect([state.chars.chars.npc?.tx, state.chars.chars.npc?.ty]).toEqual([1, 1]);
    expect(canStepFrom(base, 2, 2, 2)).toBe(true);
  });

  test("pass and directional lists replace only their documented cooked opinions", () => {
    const sheets = new Map<string, Sheet>([["floor", {
      id: "floor",
      cols: 2,
      rows: 1,
      defaultPassage: "pass",
      block: [1],
      dirEdges: { "1": { exit: ["right"], enter: ["left", "up"] } },
    }]]);
    const authored = map("a");
    authored.ground[10] = "floor.1";
    authored.ground[11] = "floor.1";
    const base = buildPassage(authored, sheets);
    const runtime = withTilePropertyOverrides(base, {
      "10": { passage: "pass", enter: ["up"], exit: [] },
    });

    expect(canStepFrom(base, 1, 1, 3)).toBe(false);
    expect(canStepFrom(runtime, 1, 1, 3)).toBe(true);
    expect(canStepFrom(runtime, 2, 1, 3)).toBe(false); // target remains default-blocked
    expect([...base.solid]).not.toEqual([...runtime.solid]);
    expect(base.exitMask[10]).toBe(8);
    expect(runtime.exitMask[10]).toBe(0);
    expect(runtime.entryMask[10]).toBe(4);
  });

  test("appearance, layer, and passage state agree after one second at every host rate", () => {
    const driver = event("driver", 7, 7, [
      page("autorun", [
        { op: "wait", seconds: 7 / 60 },
        { op: "appearance", target: "player", sprite: "swimmer", opacity: 144 },
        { op: "layer", layer: "upper", visible: false, variant: "winter" },
        { op: "tileProperty", x: 3, y: 2, passage: "block", enter: ["left"], exit: [] },
        { op: "switch", id: "done", value: true },
      ]),
      page("action", [], { condition: { switch: "done" } }),
    ]);
    const p = project([map("a", [driver])]);
    const samples = ([60, 30, 20, 4] as const).map((hz) => {
      const session = createSession(p, hz);
      const state = frames(session, startSession(p, session), hz);
      return {
        frame: state.interp.frame,
        appearance: state.sw.playerAppearance,
        layers: state.interp.layers,
        tiles: state.interp.tileProperties,
        rightAllowed: canStepFrom(sessionPassageTable(session, state), 2, 2, 3),
        done: state.sw.switches.done,
      };
    });
    expect(samples.slice(1)).toEqual([samples[0], samples[0], samples[0]]);
    expect(samples[0]).toEqual({
      frame: 60,
      appearance: { sprite: "swimmer", opacity: 144 },
      layers: { upper: { visible: false, variant: "winter" } },
      tiles: { "19": { passage: "block", enter: ["left"], exit: [] } },
      rightAllowed: false,
      done: true,
    });
  });

  test("attract rewind removes runtime overrides and replay recreates them byte-for-byte", () => {
    const changer = event("changer", 2, 1, [page("action", [
      { op: "appearance", target: "player", sprite: "swimmer", opacity: 144 },
      { op: "layer", layer: "screen", variant: "night", visible: true },
      { op: "tileProperty", x: 3, y: 2, passage: "block", exit: ["right"] },
    ])]);
    const p = project([map("a", [changer])]);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 8 / 60,
    });
    controller.startPlay();
    const masks = [0, 0, 0, CIRCLE, 0, 0, 0, 0, 0, 0];
    const states = [structuredClone(controller.state)];
    for (const mask of masks) states.push(structuredClone(controller.step(mask).state));
    const completed = structuredClone(controller.state);
    expect(completed.interp.layers?.screen).toEqual({ variant: "night", visible: true });
    expect(completed.interp.tileProperties?.["19"]).toEqual({ passage: "block", exit: ["right"] });

    controller.step(L_TRIGGER);
    expect(controller.length).toBe(2);
    expect(controller.state).toEqual(states[2]);
    expect(controller.state.sw.playerAppearance).toBeUndefined();
    expect(controller.state.interp.layers).toBeUndefined();
    expect(controller.state.interp.tileProperties).toBeUndefined();

    for (const mask of masks.slice(2)) controller.step(mask);
    expect(controller.state).toEqual(completed);
  });
});

describe("KV1 save boundaries", () => {
  test("appearance, layer, and tile state round-trip; old states may omit them", () => {
    const interp = createInterpState();
    interp.sw.playerAppearance = { defaultSprite: "hero", sprite: "swimmer", opacity: 144 };
    interp.eventAppearances = { npc: { pageIndex: 2, sprite: "swimmer", visible: false } };
    interp.layers = { screen: { variant: "torch", visible: true }, upper: { visible: false } };
    interp.tileProperties = { "10": { passage: "pass", enter: [], exit: ["down"] } };
    const snapshot = createSnapshot("a", initialMovement(2, 2, 2, { tile: 16, speed: 2 }), interp, 0);
    const restored = decodeEnvelopeText(encodeEnvelope(snapshot));

    expect(restored).toEqual(snapshot);
    const p = project([map("a")]);
    const session = createSession(p);
    const started = startSession(p, session);
    const sessionState = { ...started, sw: interp.sw, interp };
    const restoredSession = restoreSessionEnvelope(
      session,
      encodeEnvelope(createSessionSnapshot(session, sessionState, 0)),
    );
    expect(restoredSession.sw.playerAppearance).toEqual(interp.sw.playerAppearance);
    expect(restoredSession.interp.eventAppearances).toEqual(interp.eventAppearances);
    expect(restoredSession.interp.layers).toEqual(interp.layers);
    expect(restoredSession.interp.tileProperties).toEqual(interp.tileProperties);
    const legacy = createInterpState();
    expect(legacy.sw.playerAppearance).toBeUndefined();
    expect(legacy.eventAppearances).toBeUndefined();
    expect(legacy.layers).toBeUndefined();
    expect(legacy.tileProperties).toBeUndefined();
  });

  test("deep validation rejects malformed runtime appearance and tile state", () => {
    const snapshot = createSnapshot(
      "a",
      initialMovement(2, 2, 2, { tile: 16, speed: 2 }),
      createInterpState(),
      0,
    );
    const envelope = JSON.parse(encodeEnvelope(snapshot)) as any;
    envelope.state.interp.sw.playerAppearance = { opacity: 256 };
    envelope.state.interp.tileProperties = { nope: { passage: "pass" } };
    envelope.checksum = fnv1aText(canonicalJson(envelope.state));
    expect(() => decodeEnvelopeText(JSON.stringify(envelope))).toThrow(/playerAppearance\.opacity|tileProperties/);
  });

  test("restore standability uses the snapshot's runtime passage override", () => {
    const authored = map("a", [], [[18, "block"]]);
    const table = buildPassage(authored, new Map([["floor", {
      id: "floor", cols: 1, rows: 1, defaultPassage: "pass",
    }]]));
    const interp = createInterpState();
    interp.tileProperties = { "18": { passage: "pass" } };
    const snapshot = createSnapshot(
      "a",
      initialMovement(2, 2, 2, { tile: 16, speed: 2 }),
      interp,
      0,
    );
    expect(restoreProblem(snapshot, authored, table)).toBeNull();
  });
});
