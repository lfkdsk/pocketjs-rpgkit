// tests/krm3-fixes.test.ts — the KRM3 round-1 review probes, pinned as
// regression tests: MV-faithful select-item inventory filtering, the 104/134/
// 135/285 importer parameter layouts, a root-to-choice label jump that
// continues after the branch, Get Location Info reading a moved event's live
// placement, a common event's label scope surviving a mid-wait save/restore,
// and rpgkit-check counting the KRM3 variable reads and writes.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  selectItemRules,
  type SelectItemState,
} from "../src/engine/select-item.ts";
import {
  continueBattle,
  continueExternal,
  continueScene,
  createInterpState,
  createWorld,
  stepInterp,
  type InterpInput,
  type InterpState,
} from "../src/engine/interpreter.ts";
import {
  createSession,
  startSession,
  stepSession,
} from "../src/engine/session.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { createSnapshot, decodeEnvelopeText, encodeEnvelope, type SaveSnapshot } from "../src/engine/save.ts";
import { restoreSessionEnvelope, saveSession } from "../src/engine/save-restore.ts";
import { MAP_SCHEMA_HASH } from "../src/engine/schema-identity.ts";
import { initialMovement } from "../src/engine/movement.ts";
import { validateSnapshot } from "../src/engine/save-validate.ts";
import type { BattleRules } from "../src/engine/battle.ts";
import type {
  Command,
  CommonEvent,
  GameEvent,
  Item,
  MapDef,
  Project,
  ProjectShell,
} from "../src/engine/types.ts";
import { Coverage } from "../tools/rpgmaker-import/coverage.ts";
import {
  convertCommands,
  type EventContext,
} from "../tools/rpgmaker-import/events.ts";
import type { RmCommand, RmProject } from "../tools/rpgmaker-import/rm-types.ts";
import { lintProject } from "../tools/rpgkit-check/src/lint.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import schema from "../src/data/schema.json" with { type: "json" };

const C = (code: number, parameters: unknown[]): RmCommand => ({ code, indent: 0, parameters });

function importerContext(placeholders: "visible" | "silent" = "visible"): EventContext {
  return {
    rm: { flavor: "MV" } as RmProject,
    cov: new Coverage(),
    placeholders,
    maps: new Map([[1, "map001"]]),
    owner: {
      kind: "page",
      mapId: "map001",
      eventId: "ev001",
      page: 0,
      trigger: "action",
      eventIds: new Map([[1, "ev001"]]),
    },
    sprite: () => null,
    picture: (name) => name,
    parallax: () => null,
    animation: () => null,
    animationFailure: () => undefined,
    balloon: () => null,
    audio: (_kind, name) => name,
    nextShopId: () => "shop001",
    nextAnimationId: () => "anim001",
  };
}

function migrateFixtureGeneration(shell: ProjectShell, saveText: string): string {
  if (typeof shell.mapManifestHash !== "string" || typeof shell.mapSchemaHash !== "string") {
    throw new Error("schema compatibility fixture is missing its content identity");
  }
  const oldContent = { manifest: shell.mapManifestHash, schema: shell.mapSchemaHash };
  const snapshot = decodeEnvelopeText(saveText, oldContent);
  shell.mapSchemaHash = MAP_SCHEMA_HASH;
  return encodeEnvelope(snapshot, { manifest: oldContent.manifest, schema: MAP_SCHEMA_HASH });
}

function map(events: GameEvent[]): MapDef {
  return {
    id: "m",
    name: "review probe",
    width: 12,
    height: 12,
    sheets: ["plain"],
    ground: Array(144).fill("plain.0"),
    events,
  };
}

function once(id: string, commands: Command[]): GameEvent {
  return {
    id,
    x: 2,
    y: 2,
    pages: [
      { trigger: "autorun", commands: [{ op: "selfSwitch", key: "A", value: true }, ...commands] },
      { trigger: "action", condition: { selfSwitch: "A" }, commands: [] },
    ],
  };
}

function idle(world: ReturnType<typeof createWorld>, state: InterpState, ticks = 1): InterpState {
  const input: InterpInput = {
    confirmEdge: false,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
    playerCell: { x: 1, y: 1 },
    prevCell: { x: 1, y: 1 },
    facing: 0,
  };
  for (let i = 0; i < ticks; i++) state = stepInterp(world, state, input);
  return state;
}

/** A minimal InterpInput for direct stepInterp folds (no session). */
function bareInput(): InterpInput {
  return {
    confirmEdge: false,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
    playerCell: { x: 1, y: 1 },
    prevCell: { x: 1, y: 1 },
    facing: 0,
  };
}

test("MV Select Item lists only owned database items", () => {
  const catalog: Item[] = [
    { id: "item001", name: "Owned", sprite: "s", type: "regular" },
    { id: "item002", name: "Unowned", sprite: "s", type: "regular" },
    { id: "weapon003", name: "Owned weapon", sprite: "s", kind: "weapon" },
  ];
  const started = selectItemRules.start(null, { variable: "picked", itemType: "regular" }, 0, {
    ext: null,
    switches: {},
    variables: {},
    items: { item001: 1, item002: 0, weapon003: 1 },
    gold: 0,
    playerName: "Hero",
    itemCatalog: catalog,
  });
  expect((started!.state as unknown as SelectItemState).items.map((item) => item.id)).toEqual(["item001"]);
});

test("MV importer decodes 104, 134/135 and literal 285 parameters", () => {
  const commands = convertCommands([
    C(104, [1, 1]),
    C(134, [0]),
    C(135, [1]),
    C(285, [2, 0, 0, 3, 4]),
    C(0, []),
  ], importerContext());
  expect(commands).toEqual([
    { op: "selectItem", variable: "v001", itemType: "regular" },
    { op: "saveAccess", enabled: false },
    { op: "menuAccess", enabled: true },
    { op: "locationInfo", variable: "v002", x: 3, y: 4, kind: "terrain" },
  ]);
});

test("MV command104 keeps its official missing-or-zero fallback to key items", () => {
  // The round-5 review probe: MV's corescript is
  // `$gameMessage.setItemChoice(params[0], params[1] || 2)`, so a missing or
  // zero itypeId is KEY items (2), not regular. 1-4 map to the four
  // standard types; any other truthy value is a non-standard itypeId whose
  // MV list is empty, which the importer records as Degraded with the
  // original itypeId rather than faking regular-item semantics.
  const rm = (code: number, parameters: unknown[]): RmCommand => ({ code, indent: 0, parameters });
  const cov = new Coverage();
  const ctx = { ...importerContext("silent"), cov };
  const converted = [[], [1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [1, 5]].map((parameters) =>
    convertCommands([rm(104, parameters), rm(0, [])], ctx)
  );
  // Missing or zero -> key items (MV's `params[1] || 2`).
  expect(converted[0]).toEqual([{ op: "selectItem", variable: "v000", itemType: "key" }]);
  expect(converted[1]).toEqual([{ op: "selectItem", variable: "v001", itemType: "key" }]);
  // 1-4 -> the four standard types.
  expect(converted[2]).toEqual([{ op: "selectItem", variable: "v001", itemType: "regular" }]);
  expect(converted[3]).toEqual([{ op: "selectItem", variable: "v001", itemType: "key" }]);
  expect(converted[4]).toEqual([{ op: "selectItem", variable: "v001", itemType: "hiddenA" }]);
  expect(converted[5]).toEqual([{ op: "selectItem", variable: "v001", itemType: "hiddenB" }]);
  // A non-standard truthy itypeId is not faked as regular: no picker is
  // emitted and the importer records Degraded naming the original itypeId.
  expect(converted[6]).toEqual([]);
  const row = cov.list("command").find((r) => r.key === "104");
  expect(row?.counts.Native).toBe(6);
  expect(row?.counts.Degraded).toBe(1);
  expect(row?.reasons.join(" ")).toContain("5");
});

test("MV command104 records truthy non-standard itypeIds as Degraded without coercing them", () => {
  // The round-6 review probe: 0.5, 1.5, true and "2" are not the integer
  // 1-4 in MV, so their item lists are empty. The importer must not
  // truncate or coerce them into a standard type (which would offer the
  // player a semantically different list): each is dropped and recorded
  // Degraded with the original value in the reason.
  const rm = (code: number, parameters: unknown[]): RmCommand => ({ code, indent: 0, parameters });
  for (const raw of [0.5, 1.5, true, "2"]) {
    const cov = new Coverage();
    const ctx = { ...importerContext("silent"), cov };
    const out = convertCommands([rm(104, [7, raw]), rm(0, [])], ctx);
    expect(out, String(raw)).toEqual([]);
    const row = cov.list("command").find((r) => r.key === "104");
    expect(row?.counts.Native, String(raw)).toBe(0);
    expect(row?.counts.Degraded, String(raw)).toBe(1);
    expect(row?.reasons.join(" "), String(raw)).toContain(String(raw));
  }
});

test("jumping from a root list into a choice branch resumes after the choice", () => {
  const add: Command = { op: "variable", id: "visits", set: { op: "add", value: 1 } };
  const done: Command = { op: "switch", id: "done", value: true };
  const world = createWorld(map([once("runner", [
    { op: "jumpLabel", name: "inside" },
    { op: "choices", prompt: "?", options: [{ text: "go", commands: [{ op: "label", name: "inside" }, add] }] },
    done,
  ])]));
  const state = idle(world, createInterpState(), 1);
  expect(state.error).toBeUndefined();
  expect(state.sw.variables.visits).toBe(1);
  expect(state.sw.switches.done).toBe(true);
});

test("duplicate labels in battle branches follow MV win-escape-lose source order", () => {
  // The round-3 review probe: MV's Battle Processing lists its result
  // branches in the flat source order Win (601), Escape (602), Lose (603),
  // and command119 scans that flat list top-down. A jumpLabel must land in
  // the Escape branch's label, not Lose's, when both carry the same name.
  const commands: Command[] = [
    { op: "jumpLabel", name: "dup" },
    {
      op: "battle",
      setup: null,
      onLose: [
        { op: "label", name: "dup" },
        { op: "switch", id: "lose", value: true },
      ],
      onEscape: [
        { op: "label", name: "dup" },
        { op: "switch", id: "escape", value: true },
      ],
    },
    { op: "switch", id: "done", value: true },
  ];
  const state = idle(createWorld(map([once("runner", commands)])), createInterpState(), 1);
  expect(state.error).toBeUndefined();
  expect(state.sw.switches.escape).toBe(true);
  expect(state.sw.switches.lose).toBeUndefined();
  expect(state.sw.switches.done).toBe(true);
});

test("duplicate labels in choice branches follow MV option-then-cancel order", () => {
  // MV lists Show Choices branches as option 1, option 2, … then When Cancel.
  const commands: Command[] = [
    { op: "jumpLabel", name: "dup" },
    {
      op: "choices",
      prompt: "?",
      options: [
        { text: "a", commands: [{ op: "label", name: "dup" }, { op: "switch", id: "opt", value: true }] },
        { text: "b", commands: [] },
      ],
      cancel: { commands: [{ op: "label", name: "dup" }, { op: "switch", id: "cancel", value: true }] },
    },
    { op: "switch", id: "done", value: true },
  ];
  const state = idle(createWorld(map([once("runner", commands)])), createInterpState(), 1);
  expect(state.error).toBeUndefined();
  expect(state.sw.switches.opt).toBe(true);
  expect(state.sw.switches.cancel).toBeUndefined();
  expect(state.sw.switches.done).toBe(true);
});

test("duplicate labels in if/else keep then-before-else source order", () => {
  const commands: Command[] = [
    { op: "jumpLabel", name: "dup" },
    {
      op: "if",
      if: { kind: "switch", id: "flag", value: true },
      then: [{ op: "label", name: "dup" }, { op: "switch", id: "then", value: true }],
      else: [{ op: "label", name: "dup" }, { op: "switch", id: "else", value: true }],
    },
    { op: "switch", id: "done", value: true },
  ];
  const state = idle(createWorld(map([once("runner", commands)])), createInterpState(), 1);
  expect(state.error).toBeUndefined();
  expect(state.sw.switches.then).toBe(true);
  expect(state.sw.switches.else).toBeUndefined();
  expect(state.sw.switches.done).toBe(true);
});

test("an imported reversed condition keeps the original label source order", () => {
  // The round-3 review probe: a Gold `<` (or `<=`) condition is imported by
  // swapping then/else (the kit only has gold >= n). MV's command119 scans
  // the ORIGINAL flat list, so the first "dup" label is the original Then's,
  // not the original Else's that the swap moved into the then slot. The
  // importer stamps each label with its flat source ordinal so the runtime's
  // label table picks the lowest-ordinal label regardless of branch order.
  const rm = (code: number, indent: number, parameters: unknown[]): RmCommand => ({ code, indent, parameters });
  const commands = convertCommands([
    rm(119, 0, ["dup"]),
    rm(111, 0, [7, 100, 1]),
    rm(118, 1, ["dup"]),
    rm(121, 1, [1, 1, 0]),
    rm(0, 1, []),
    rm(411, 0, []),
    rm(118, 1, ["dup"]),
    rm(121, 1, [2, 2, 0]),
    rm(0, 1, []),
    rm(412, 0, []),
    rm(121, 0, [3, 3, 0]),
    rm(0, 0, []),
  ], importerContext());
  const state = idle(createWorld(map([once("runner", commands)])), createInterpState(), 1);
  expect(state.error).toBeUndefined();
  expect(state.sw.switches.s001).toBe(true);
  expect(state.sw.switches.s002).toBeUndefined();
  expect(state.sw.switches.s003).toBe(true);
});

test("Get Location Info sees an event's live placement", () => {
  // A `place` command moves the character; the live position the session
  // feeds (eventCells) is what a query reads — the interpreter no longer
  // consults the durable placements record for position (round 4).
  const npc: GameEvent = { id: "ev003", x: 5, y: 5, pages: [{ trigger: "action", commands: [] }] };
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "live placement probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map([
      once("runner", [
        { op: "place", target: { event: "ev003" }, x: 9, y: 9 },
        { op: "locationInfo", variable: "found", x: 9, y: 9, kind: "event" },
      ]),
      npc,
    ])],
  };
  const session = createSession(project);
  let state = startSession(project, session);
  for (let i = 0; i < 300 && state.interp.sw.variables.found === undefined; i++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.interp.sw.variables.found).toBe(3);
});

test("Get Location Info reads a routed NPC's live session position", () => {
  // The round-2 review probe: an NPC walks a forced route from its authored
  // cell to a new one. A locationInfo event query must find it on the NEW
  // cell and report 0 on the OLD one. Route movement lives in the session's
  // character state and reaches the interpreter through the per-frame
  // eventCells record — the interpreter's `placements` record never sees it,
  // so reading placements alone returns the authored cell (0 on the new
  // cell, the event id on the old one: exactly the inverted result).
  const npc: GameEvent = {
    id: "ev003",
    x: 5,
    y: 5,
    pages: [{ trigger: "action", commands: [] }],
  };
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "live location probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map([
      once("runner", [
        {
          op: "moveRoute",
          target: { event: "ev003" },
          wait: true,
          route: { steps: ["moveRight", "moveRight", "moveRight", "moveRight"], repeat: false, skippable: false },
        },
        { op: "locationInfo", variable: "newCell", x: 9, y: 5, kind: "event" },
        { op: "locationInfo", variable: "oldCell", x: 5, y: 5, kind: "event" },
      ]),
      npc,
    ])],
  };
  const session = createSession(project);
  let state = startSession(project, session);
  for (let i = 0; i < 300; i++) {
    state = stepSession(session, state, { buttons: 0 });
    if (state.interp.sw.variables.newCell !== undefined) break;
  }
  expect(state.interp.sw.variables.newCell).toBe(3);
  expect(state.interp.sw.variables.oldCell).toBe(0);
});

test("Get Location Info sees a same-tick place after a routed move", () => {
  // The round-3 review probe: an NPC walks a forced route to its end cell,
  // then the SAME fiber issues `place` and queries Get Location Info in the
  // same step. MV's Set Event Location calls locate() synchronously, so the
  // query must read the placed cell, not the route-end cell the per-frame
  // eventCells snapshot still holds. The `place` writes the durable placement
  // record at once; the interpreter marks it fresh for this step so a
  // same-step eventOrigin read prefers it over the stale snapshot.
  const npc: GameEvent = {
    id: "ev003",
    x: 5,
    y: 5,
    pages: [{ trigger: "action", commands: [] }],
  };
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "same-tick place probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map([
      once("runner", [
        {
          op: "moveRoute",
          target: { event: "ev003" },
          wait: true,
          route: { steps: ["moveRight"], repeat: false, skippable: false },
        },
        { op: "place", target: { event: "ev003" }, x: 9, y: 5 },
        { op: "locationInfo", variable: "atPlaced", x: 9, y: 5, kind: "event" },
        { op: "locationInfo", variable: "atRouteEnd", x: 6, y: 5, kind: "event" },
      ]),
      npc,
    ])],
  };
  const session = createSession(project);
  let state = startSession(project, session);
  for (let i = 0; i < 300 && state.interp.sw.variables.atPlaced === undefined; i++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.interp.sw.variables.atPlaced).toBe(3);
  expect(state.interp.sw.variables.atRouteEnd).toBe(0);
});

test("a place followed by a route back to the authored cell stays live", () => {
  // The round-4 review probe: `place ev003 6,5`, then a waited route walks
  // the character LEFT back onto its authored (5,5). A following Get
  // Location Info must find the event on (5,5) and report 0 on the stale
  // placement cell (6,5). The live character position is the single source:
  // once the char stands on the authored cell again, the durable placement
  // must not resurface as the event's origin.
  const npc: GameEvent = {
    id: "ev003",
    x: 5,
    y: 5,
    pages: [{ trigger: "action", commands: [] }],
  };
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "route-back-to-authored probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map([
      once("runner", [
        { op: "place", target: { event: "ev003" }, x: 6, y: 5 },
        {
          op: "moveRoute",
          target: { event: "ev003" },
          wait: true,
          route: { steps: ["moveLeft"], repeat: false, skippable: false },
        },
        { op: "locationInfo", variable: "authored", x: 5, y: 5, kind: "event" },
        { op: "locationInfo", variable: "stalePlace", x: 6, y: 5, kind: "event" },
      ]),
      npc,
    ])],
  };
  const session = createSession(project);
  let state = startSession(project, session);
  for (let i = 0; i < 300 && state.interp.sw.variables.authored === undefined; i++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.interp.sw.variables.authored).toBe(3);
  expect(state.interp.sw.variables.stalePlace).toBe(0);
});

test("stepInterp does not mutate a frozen caller input", () => {
  // The round-4 review probe: the public fold promises to return new state
  // without mutating either input. A program exercising place, jumpLabel,
  // selectItem and locationInfo must run on an Object.freeze'd input without
  // throwing (the fix-3 scratch set was written onto the caller's input).
  const world = createWorld(map([
    once("runner", [
      { op: "place", target: { event: "ev003" }, x: 6, y: 5 },
      { op: "jumpLabel", name: "land" },
      { op: "switch", id: "skipped", value: true },
      { op: "label", name: "land" },
      { op: "locationInfo", variable: "atPlaced", x: 6, y: 5, kind: "event" },
      { op: "selectItem", variable: "picked", itemType: "regular" },
    ]),
    { id: "ev003", x: 5, y: 5, pages: [{ trigger: "action", commands: [] }] },
  ]));
  const frozen = Object.freeze({
    confirmEdge: false,
    cancelEdge: false,
    upEdge: false,
    downEdge: false,
    playerCell: { x: 1, y: 1 },
    prevCell: { x: 1, y: 1 },
    facing: 0,
  }) as InterpInput;
  expect(() => stepInterp(world, createInterpState(), frozen)).not.toThrow();
});

test("a jump inside a battle result branch keeps its completion transfer", () => {
  // The round-4 review probe: continueBattle appended the completion
  // transfer to a CLONE of the result branch, but the label table knows
  // only the original branch. A jumpLabel inside the branch rebuilt the
  // frame from the original, dropping the appended transfer, so the
  // cross-map completion never happened. The branch now runs the original
  // program with the transfer hung on the frame as its onDone action: a
  // jump inside the branch still completes the transfer when the branch
  // finishes.
  const jumpBranch = (extra?: Command): Command[] => [
    { op: "jumpLabel", name: "land" },
    { op: "switch", id: "skipped", value: true },
    { op: "label", name: "land" },
    ...(extra ? [extra] : []),
    { op: "switch", id: "branchDone", value: true },
  ];
  for (const result of ["win", "escape", "lose"] as const) {
    const commands: Command[] = [
      {
        op: "battle",
        setup: null,
        onWin: result === "win" ? jumpBranch() : [],
        onEscape: result === "escape" ? jumpBranch() : [],
        onLose: result === "lose" ? jumpBranch() : [],
      },
      { op: "switch", id: "afterBattle", value: true },
    ];
    const world = createWorld(map([once("runner", commands)]));
    let state = stepInterp(world, createInterpState(), bareInput());
    const fiber = state.pendingBattles[0]!.fiber;
    state = continueBattle(state, fiber, result, {
      map: "next", x: 3, y: 4, dir: "down", fadeFrames: 0,
    });
    state = stepInterp(world, state, bareInput());
    expect(state.sw.switches.branchDone).toBe(true);
    expect(state.sw.switches.skipped).toBeUndefined();
    // The completion transfer parks the fiber; the post-battle command
    // runs only after the session performs the transfer and resumes it.
    expect(state.pendingTransfer).toMatchObject({ map: "next", x: 3, y: 4 });
    expect(state.sw.switches.afterBattle).toBeUndefined();
    state = continueExternal(state, fiber);
    state = stepInterp(world, state, bareInput());
    expect(state.sw.switches.afterBattle).toBe(true);
  }
});

test("a jump inside a scene result branch keeps its completion transfer", () => {
  // The scene mirror of the battle probe: continueScene appended the
  // completion transfer to a branch clone, so a jump inside onDone/onCancel
  // lost it. The transfer now hangs on the frame as onDone.
  const jumpBranch = (): Command[] => [
    { op: "jumpLabel", name: "land" },
    { op: "switch", id: "skipped", value: true },
    { op: "label", name: "land" },
    { op: "switch", id: "branchDone", value: true },
  ];
  for (const cancelled of [false, true]) {
    const commands: Command[] = [
      {
        op: "scene",
        id: "test.scene",
        args: null,
        onDone: cancelled ? [] : jumpBranch(),
        onCancel: cancelled ? jumpBranch() : [],
      },
      { op: "switch", id: "afterScene", value: true },
    ];
    const world = createWorld(map([once("runner", commands)]));
    let state = stepInterp(world, createInterpState(), bareInput());
    const fiber = state.pendingScenes![0]!.fiber;
    state = continueScene(state, fiber, cancelled, {
      map: "next", x: 3, y: 4, dir: "down", fadeFrames: 0,
    });
    state = stepInterp(world, state, bareInput());
    expect(state.sw.switches.branchDone).toBe(true);
    expect(state.sw.switches.skipped).toBeUndefined();
    expect(state.pendingTransfer).toMatchObject({ map: "next", x: 3, y: 4 });
    expect(state.sw.switches.afterScene).toBeUndefined();
    state = continueExternal(state, fiber);
    state = stepInterp(world, state, bareInput());
    expect(state.sw.switches.afterScene).toBe(true);
  }
});

test("a battle result jump to its parent list keeps the completion transfer", () => {
  // The round-5 review probe: a jumpLabel inside a battle result branch may
  // target a label in the branch's parent list (the page/common event the
  // battle sits in). applyJumpLabel's ancestor path popped the branch frame
  // without extracting its onDone, so the cross-map completion vanished.
  // The completion now relocates to the landing frame and fires when it
  // runs out, so the transfer happens exactly once however the branch is
  // left.
  const branch: Command[] = [
    { op: "jumpLabel", name: "outside" },
    { op: "switch", id: "branchBad", value: true },
  ];
  const commands: Command[] = [
    { op: "battle", setup: null, onWin: branch },
    { op: "label", name: "outside" },
    { op: "switch", id: "rootLanded", value: true },
  ];
  const world = createWorld(map([once("runner", commands)]));
  let state = stepInterp(world, createInterpState(), bareInput());
  const fiber = state.pendingBattles[0]!.fiber;
  state = continueBattle(state, fiber, "win", { map: "next", x: 3, y: 4, dir: "down", fadeFrames: 0 });
  state = stepInterp(world, state, bareInput());
  expect(state.sw.switches.rootLanded).toBe(true);
  expect(state.sw.switches.branchBad).toBeUndefined();
  expect(state.pendingTransfer).toMatchObject({ map: "next", x: 3, y: 4, fiber });
  // The transfer fired once: resuming ends the fiber without re-firing.
  state = continueExternal(state, fiber);
  state = stepInterp(world, state, bareInput());
  expect(state.error).toBeUndefined();
  expect(state.main).toBeNull();
});

test("a scene result jump to its parent list keeps the completion transfer", () => {
  // The scene mirror of the battle probe: a jump in onDone/onCancel to a
  // parent-list label must keep the scene's completion transfer.
  const branch: Command[] = [
    { op: "jumpLabel", name: "outside" },
    { op: "switch", id: "branchBad", value: true },
  ];
  for (const cancelled of [false, true]) {
    const commands: Command[] = [
      { op: "scene", id: "test.scene", args: null, onDone: cancelled ? [] : branch, onCancel: cancelled ? branch : [] },
      { op: "label", name: "outside" },
      { op: "switch", id: "rootLanded", value: true },
    ];
    const world = createWorld(map([once("runner", commands)]));
    let state = stepInterp(world, createInterpState(), bareInput());
    const fiber = state.pendingScenes![0]!.fiber;
    state = continueScene(state, fiber, cancelled, { map: "next", x: 3, y: 4, dir: "down", fadeFrames: 0 });
    state = stepInterp(world, state, bareInput());
    expect(state.sw.switches.rootLanded, String(cancelled)).toBe(true);
    expect(state.sw.switches.branchBad, String(cancelled)).toBeUndefined();
    expect(state.pendingTransfer, String(cancelled)).toMatchObject({ map: "next", x: 3, y: 4, fiber });
    state = continueExternal(state, fiber);
    state = stepInterp(world, state, bareInput());
    expect(state.error, String(cancelled)).toBeUndefined();
    expect(state.main, String(cancelled)).toBeNull();
  }
});

test("nested battle completions relocate innermost first to the jump's landing frame", () => {
  // A battle result branch that itself runs a battle leaves both branch
  // frames carrying a completion transfer. A jump from the inner branch to
  // a page-root label pops both frames; the completions relocate to the
  // landing frame ahead of any it carried, so they fire innermost first,
  // each exactly once.
  const innerBranch: Command[] = [
    { op: "jumpLabel", name: "outside" },
    { op: "switch", id: "innerBad", value: true },
  ];
  const outerBranch: Command[] = [
    { op: "battle", setup: null, onWin: innerBranch },
    { op: "switch", id: "outerBad", value: true },
  ];
  const commands: Command[] = [
    { op: "battle", setup: null, onWin: outerBranch },
    { op: "label", name: "outside" },
    { op: "switch", id: "rootLanded", value: true },
  ];
  const world = createWorld(map([once("runner", commands)]));
  let state = stepInterp(world, createInterpState(), bareInput());
  const fiber = state.pendingBattles[0]!.fiber;
  state = continueBattle(state, fiber, "win", { map: "outer", x: 1, y: 1, dir: "down", fadeFrames: 0 });
  state = stepInterp(world, state, bareInput());
  state = continueBattle(state, fiber, "win", { map: "inner", x: 2, y: 2, dir: "down", fadeFrames: 0 });
  state = stepInterp(world, state, bareInput());
  expect(state.sw.switches.rootLanded).toBe(true);
  expect(state.sw.switches.innerBad).toBeUndefined();
  expect(state.sw.switches.outerBad).toBeUndefined();
  // The innermost completion fires first.
  expect(state.pendingTransfer).toMatchObject({ map: "inner", fiber });
  // Resuming fires the outer completion next, then ends the fiber.
  state = continueExternal(state, fiber);
  state = stepInterp(world, state, bareInput());
  expect(state.pendingTransfer).toMatchObject({ map: "outer", fiber });
  state = continueExternal(state, fiber);
  state = stepInterp(world, state, bareInput());
  expect(state.error).toBeUndefined();
  expect(state.main).toBeNull();
});

test("a nested battle that is the outer branch's last command still completes both", () => {
  // The round-6 review probe (nested-last-command): the outer result branch
  // runs a single inner battle, so the outer frame is parked at pc ===
  // length when the inner branch jumps to a page-root label. The jump pops
  // both frames; the outer completion is collected all the same and fires
  // after the inner one, innermost first, each exactly once.
  const innerBranch: Command[] = [{ op: "jumpLabel", name: "outside" }];
  const outerBranch: Command[] = [{ op: "battle", setup: null, onWin: innerBranch }];
  const commands: Command[] = [
    { op: "battle", setup: null, onWin: outerBranch },
    { op: "label", name: "outside" },
    { op: "switch", id: "rootLanded", value: true },
  ];
  const world = createWorld(map([once("runner", commands)]));
  let state = stepInterp(world, createInterpState(), bareInput());
  const fiber = state.pendingBattles[0]!.fiber;
  state = continueBattle(state, fiber, "win", { map: "outer", x: 1, y: 1, dir: "down", fadeFrames: 0 });
  state = stepInterp(world, state, bareInput());
  state = continueBattle(state, fiber, "win", { map: "inner", x: 2, y: 2, dir: "down", fadeFrames: 0 });
  state = stepInterp(world, state, bareInput());
  expect(state.sw.switches.rootLanded).toBe(true);
  // The innermost completion fires first.
  expect(state.pendingTransfer).toMatchObject({ map: "inner", fiber });
  // Resuming fires the outer completion next, then ends the fiber.
  state = continueExternal(state, fiber);
  state = stepInterp(world, state, bareInput());
  expect(state.pendingTransfer).toMatchObject({ map: "outer", fiber });
  state = continueExternal(state, fiber);
  state = stepInterp(world, state, bareInput());
  expect(state.error).toBeUndefined();
  expect(state.main).toBeNull();
  expect(state.pendingTransfer).toBeNull();
});

test("an outer completion still fires when the inner battle carries no transfer", () => {
  // Semantics B's non-cross-map case: the inner battle completes without a
  // transfer, so only the outer frame carries a completion. The inner
  // branch's jump pops both frames; the outer completion relocates to the
  // landing frame and fires when that frame runs out.
  const innerBranch: Command[] = [{ op: "jumpLabel", name: "outside" }];
  const outerBranch: Command[] = [{ op: "battle", setup: null, onWin: innerBranch }];
  const commands: Command[] = [
    { op: "battle", setup: null, onWin: outerBranch },
    { op: "label", name: "outside" },
    { op: "switch", id: "rootLanded", value: true },
  ];
  const world = createWorld(map([once("runner", commands)]));
  let state = stepInterp(world, createInterpState(), bareInput());
  const fiber = state.pendingBattles[0]!.fiber;
  state = continueBattle(state, fiber, "win", { map: "outer", x: 1, y: 1, dir: "down", fadeFrames: 0 });
  state = stepInterp(world, state, bareInput());
  // The inner battle completes with no completion transfer.
  state = continueBattle(state, fiber, "win", null);
  state = stepInterp(world, state, bareInput());
  expect(state.sw.switches.rootLanded).toBe(true);
  expect(state.pendingTransfer).toMatchObject({ map: "outer", fiber });
  state = continueExternal(state, fiber);
  state = stepInterp(world, state, bareInput());
  expect(state.error).toBeUndefined();
  expect(state.main).toBeNull();
  expect(state.pendingTransfer).toBeNull();
});

test("a real Session applies only the innermost nested cross-map completion", () => {
  // Semantics A: a cross-map transfer rebuilds the interpreter for the new
  // map, so the old map's fibers — and any completion transfers still
  // queued on them — end there. Of two nested cross-map completions only
  // the innermost takes effect; the outer one is discarded with the old
  // map. This is the kit's documented transfer semantics (unlike RPG Maker
  // MV, whose interpreter keeps running across a map swap).
  const innerBranch: Command[] = [{ op: "jumpLabel", name: "outside" }];
  const outerBranch: Command[] = [{ op: "battle", setup: { map: "inner" }, onWin: innerBranch }];
  const startMap = map([once("runner", [
    { op: "battle", setup: { map: "outer" }, onWin: outerBranch },
    { op: "label", name: "outside" },
    { op: "switch", id: "rootLanded", value: true },
  ])]);
  const emptyMap = (id: string): MapDef => ({ ...map([]), id, name: id });
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "nested completion session probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [startMap, emptyMap("inner"), emptyMap("outer")],
  };
  const rules: BattleRules = {
    start(ext, setup) { return { ext, state: setup }; },
    step(state) { return state; },
    done(state) {
      const target = (state as { map: string }).map;
      return { ext: null, result: "win", transfer: { map: target, x: 1, y: 1, fade: 0 } };
    },
  };
  const session = createSession(project, 60, { battle: rules });
  let state = startSession(project, session);
  const visited: string[] = [state.mapId];
  for (let i = 0; i < 20; i++) {
    state = stepSession(session, state, { buttons: 0 });
    if (visited.at(-1) !== state.mapId) visited.push(state.mapId);
  }
  expect(visited).toEqual(["m", "inner"]);
  expect(state.mapId).toBe("inner");
});

for (const kind of ["battle", "scene"] as const) {
  for (const terminal of ["exit", "erase"] as const) {
    test(`a ${terminal} in a ${kind} result branch abandons its completion transfer`, () => {
      // Semantics C: exit/erase ends the whole event. A completion transfer
      // still queued on the branch frame is abandoned with the fiber — the
      // pre-KRM3 behavior — rather than firing after the terminal command.
      const branch: Command[] = [{ op: terminal }];
      const result: Command = kind === "battle"
        ? { op: "battle", setup: null, onWin: branch }
        : { op: "scene", id: "probe.scene", args: null, onDone: branch };
      const world = createWorld(map([once("runner", [result])]));
      let state = stepInterp(world, createInterpState(), bareInput());
      const fiber = kind === "battle" ? state.pendingBattles[0]!.fiber : state.pendingScenes![0]!.fiber;
      const transfer = { map: `${kind}-${terminal}`, x: 3, y: 4, dir: "down" as const, fadeFrames: 0 };
      state = kind === "battle"
        ? continueBattle(state, fiber, "win", transfer)
        : continueScene(state, fiber, false, transfer);
      state = stepInterp(world, state, bareInput());
      expect(state.main).toBeNull();
      expect(state.pendingTransfer).toBeNull();
    });
  }
}

test("a saved frame completion cannot inject its owning fiber", () => {
  // The round-5 review probe: a frame's onDone queue holds completion
  // transfers, each a PendingTransfer minus the fiber key the runtime
  // fills in. A save that forges a `fiber` field (or any unknown key) in a
  // queued completion must be rejected, and the live owner must never be
  // overwritten by saved data.
  const owner = "m/runner";
  const forgedSnapshot = (completion: Record<string, unknown>): SaveSnapshot => {
    const snapshot = createSnapshot("m", initialMovement(1, 1, 0, { tile: 16, speed: 2 }), createInterpState(), 0);
    snapshot.interp.parallels[owner] = {
      key: owner,
      pageIndex: 0,
      parallel: true,
      stack: [{ prog: [], pc: 0, onDone: [completion] }],
      mode: "run",
      since: 0,
      erase: false,
    } as never;
    return snapshot;
  };
  // The forged `fiber` key is rejected (the runtime owns it)…
  const hijack = forgedSnapshot({
    fiber: "m/hijack", map: "next", x: 3, y: 4, dir: "down", fadeFrames: 0,
  });
  let validation = validateSnapshot(hijack);
  expect(validation).not.toBeNull();
  expect(validation).toContain("onDone[0].fiber");
  // …and so is any other unknown field.
  const smuggled = forgedSnapshot({
    map: "next", x: 3, y: 4, dir: "down", fadeFrames: 0, smuggled: true,
  });
  validation = validateSnapshot(smuggled);
  expect(validation).not.toBeNull();
  expect(validation).toContain("onDone[0].smuggled");
  // Even if a forged completion reached the runtime, the owner is the live
  // fiber: the spread puts fiber last, so saved data cannot override it.
  const world = createWorld(map([{ id: "runner", x: 2, y: 2, pages: [{ trigger: "parallel", commands: [] }] }]));
  const stepped = stepInterp(world, hijack.interp, bareInput());
  expect(stepped.pendingTransfer?.fiber).toBe(owner);
});

test("a single-object onDone frame is not a published save identity and is rejected", () => {
  // Semantics E: the array onDone queue is the only published wire shape.
  // A predecessor build briefly wrote a single completion object under the
  // same save version, but that shape never shipped on main, so the kit's
  // compatibility promise (published schema identities on main only) does
  // not cover it: the validator refuses it rather than the restore path
  // guessing at a migration.
  const owner = "m/runner";
  const snapshot = createSnapshot("m", initialMovement(1, 1, 0, { tile: 16, speed: 2 }), createInterpState(), 0);
  snapshot.interp.parallels[owner] = {
    key: owner,
    pageIndex: 0,
    parallel: true,
    stack: [{
      prog: [],
      pc: 0,
      onDone: { map: "next", x: 3, y: 4, dir: "down", fadeFrames: 0 },
    }],
    mode: "run",
    since: 0,
    erase: false,
  } as never;
  const validation = validateSnapshot(snapshot);
  expect(validation).not.toBeNull();
  expect(validation).toContain("completion queue must be an array");
});

test("a jump reaches a label inside an unsupported condition's Then branch", () => {
  // The round-4 review probe: MV's command119 can jump to any 118 in the
  // flat list, including one inside a conditional branch. The importer
  // dropped the Then of an unevaluable (script) condition entirely, so the
  // label and its commands vanished and the jump fell through to the Else.
  // The condition is now treated as always-false: the Then is kept as
  // label-only-reachable structure, so the jump lands in it and the Else
  // is skipped. The condition itself is still recorded as Placeholder.
  const rm = (code: number, indent: number, parameters: unknown[]): RmCommand => ({ code, indent, parameters });
  const commands = convertCommands([
    rm(119, 0, ["inside"]),
    rm(111, 0, [12, "false"]),
    rm(118, 1, ["inside"]),
    rm(121, 1, [1, 1, 0]),
    rm(0, 1, []),
    rm(411, 0, []),
    rm(121, 1, [2, 2, 0]),
    rm(0, 1, []),
    rm(412, 0, []),
    rm(0, 0, []),
  ], importerContext("silent"));
  // The Then's label survives in the converted program.
  expect(commands.some((c) => c.op === "label" && c.name === "inside")).toBe(true);
  const state = stepInterp(createWorld(map([once("runner", commands)])), createInterpState(), bareInput());
  expect(state.sw.switches.s001).toBe(true);
  expect(state.sw.switches.s002).toBeUndefined();
});

test("an unsupported condition's synthetic labels cannot collide with an authored label", () => {
  // The round-5 review probe: deadBranch named its synthetic jump/label
  // pairs __dead_else_N / __dead_end_N in the same namespace as authored
  // labels. An authored label named __dead_else_0 sat before the branch, so
  // the fall-through synthetic jump resolved to the authored label and the
  // program looped back until the runaway budget fired. The importer now
  // collects every authored label (and jump target) in the list before
  // converting and keeps synthetic names out of that set, so the
  // fall-through lands on the synthetic label and runs the Else.
  const rm = (code: number, indent: number, parameters: unknown[]): RmCommand => ({ code, indent, parameters });
  for (const colliding of ["__dead_else_0", "__dead_end_0"]) {
    const commands = convertCommands([
      rm(118, 0, [colliding]),
      rm(111, 0, [12, "false"]),
      rm(121, 1, [1, 1, 0]),
      rm(0, 1, []),
      rm(411, 0, []),
      rm(121, 1, [2, 2, 0]),
      rm(0, 1, []),
      rm(412, 0, []),
      rm(0, 0, []),
    ], importerContext("silent"));
    const state = stepInterp(createWorld(map([once("runner", commands)])), createInterpState(), bareInput());
    expect(state.error, colliding).toBeUndefined();
    expect(state.sw.switches.s001, colliding).toBeUndefined();
    expect(state.sw.switches.s002, colliding).toBe(true);
  }
});

test("locationInfo tile queries do not depend on the tiles plane order", () => {
  // The round-2 review probe: the schema only requires unique pairs, not
  // sorted or unique indices, but the runtime binary-searched the plane as
  // if it were sorted. A schema-valid unordered plane returned 0 for cells
  // whose entry sat past a mid miss. The runtime now builds a cell-index map
  // at world construction, so authored order is irrelevant and a duplicate
  // index keeps the last entry.
  const tilesMap: MapDef = {
    id: "m",
    name: "unordered tiles",
    width: 4,
    height: 1,
    sheets: ["plain"],
    ground: ["plain.0", "plain.1", "plain.0", "plain.0"],
    // Deliberately out of order, with a duplicate index 0 (last wins).
    tiles: [
      [3, [30, 31, 32, 33]],
      [0, [1, 2, 3, 4]],
      [2, [20, 21, 22, 23]],
      [0, [5, 6, 7, 8]],
    ],
    events: [],
  };
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "unordered tiles probe",
    tileSize: 16,
    start: { map: "m", x: 0, y: 0, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [tilesMap],
  };
  // The plane is schema-valid as authored (unordered, duplicate index).
  expect(validateSchema(schema, project)).toEqual([]);
  const world = createWorld({
    ...tilesMap,
    events: [once("runner", [
      { op: "locationInfo", variable: "c0l0", x: 0, y: 0, kind: "tile", layer: 0 },
      { op: "locationInfo", variable: "c0l3", x: 0, y: 0, kind: "tile", layer: 3 },
      { op: "locationInfo", variable: "c2l1", x: 2, y: 0, kind: "tile", layer: 1 },
      { op: "locationInfo", variable: "c3l2", x: 3, y: 0, kind: "tile", layer: 2 },
      { op: "locationInfo", variable: "c1l0", x: 1, y: 0, kind: "tile", layer: 0 },
    ])],
  });
  const state = idle(world, createInterpState(), 1);
  expect(state.sw.variables.c0l0).toBe(5); // duplicate index 0 keeps the last entry
  expect(state.sw.variables.c0l3).toBe(8);
  expect(state.sw.variables.c2l1).toBe(21); // entry authored before cell 3's
  expect(state.sw.variables.c3l2).toBe(32); // entry authored first
  // Cell 1 has no tile entry: layer 0 falls back to the composed ground's
  // sheet index (plain.1 -> 1), never a silent 0.
  expect(state.sw.variables.c1l0).toBe(1);
});

test("a restored common event keeps its own label scope", () => {
  const common: CommonEvent = {
    id: "ce1",
    trigger: "none",
    commands: [
      { op: "screenFade", direction: "out", duration: 0.5, wait: true },
      { op: "jumpLabel", name: "after" },
      { op: "variable", id: "bad", set: { op: "add", value: 1 } },
      { op: "label", name: "after" },
      { op: "variable", id: "commonGood", set: { op: "add", value: 1 } },
    ],
  };
  const events = [once("runner", [
    { op: "common", id: "ce1" },
    { op: "label", name: "after" },
    { op: "variable", id: "page", set: { op: "add", value: 1 } },
  ])];
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "review probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    commonEvents: [common],
    maps: [map(events)],
  };
  const session = createSession(project);
  let state = startSession(project, session);
  for (let i = 0; i < 5; i++) state = stepSession(session, state, { buttons: 0 });
  expect(state.interp.main?.mode).toBe("screenWait");
  const saved = saveSession(session, state, 0);
  if (!saved.ok) throw new Error(saved.error.code);
  state = restoreSessionEnvelope(createSession(project), encodeEnvelope(saved.snapshot));
  for (let i = 0; i < 60; i++) state = stepSession(session, state, { buttons: 0 });
  expect(state.interp.sw.variables.bad).toBeUndefined();
  expect(state.interp.sw.variables.commonGood).toBe(1);
  expect(state.interp.sw.variables.page).toBe(1);
});

test("a restored pre-unit save rebuilds a common event's label scope", () => {
  // The round-2 review probe: saves written before frames recorded their
  // label-scope root lack `unit` markers. Restoring one as-is let a common
  // event's jumpLabel fall back to the page scope, so it jumped into the
  // page's label list and the common event's own labels never ran (the probe
  // saw {"page":1} with commonGood missing). The restore boundary now
  // rebuilds the markers from the fiber/page/common stack structure.
  const common: CommonEvent = {
    id: "ce1",
    trigger: "none",
    commands: [
      { op: "screenFade", direction: "out", duration: 0.5, wait: true },
      { op: "jumpLabel", name: "after" },
      { op: "variable", id: "bad", set: { op: "add", value: 1 } },
      { op: "label", name: "after" },
      { op: "variable", id: "commonGood", set: { op: "add", value: 1 } },
    ],
  };
  const events = [once("runner", [
    { op: "common", id: "ce1" },
    { op: "label", name: "after" },
    { op: "variable", id: "page", set: { op: "add", value: 1 } },
  ])];
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "old save probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    commonEvents: [common],
    maps: [map(events)],
  };
  const session = createSession(project);
  let state = startSession(project, session);
  for (let i = 0; i < 5; i++) state = stepSession(session, state, { buttons: 0 });
  expect(state.interp.main?.mode).toBe("screenWait");
  const saved = saveSession(session, state, 0);
  if (!saved.ok) throw new Error(saved.error.code);
  // Simulate a save from before the `unit` field existed: no frame carries
  // the marker (a real old save has none anywhere).
  const strip = (fiber: { stack?: { unit?: true }[] } | null): void => {
    if (!fiber) return;
    for (const frame of fiber.stack ?? []) delete frame.unit;
  };
  strip(saved.snapshot.interp.main);
  for (const f of Object.values(saved.snapshot.interp.parallels)) strip(f);
  // The validator still accepts the marker-less shape (a documented compat
  // generation); restore rebuilds the scope so the common event's jumpLabel
  // resolves in its own list.
  state = restoreSessionEnvelope(createSession(project), encodeEnvelope(saved.snapshot));
  for (let i = 0; i < 60; i++) state = stepSession(session, state, { buttons: 0 });
  expect(state.interp.sw.variables.bad).toBeUndefined();
  expect(state.interp.sw.variables.commonGood).toBe(1);
  expect(state.interp.sw.variables.page).toBe(1);
});

test("an explicitly migrated pre-unit probe rebuilds a common event's label scope", () => {
  // The round-4 review probe, honestly relabelled in round 5: the fixture's
  // page root and common event both declare a label named "same", and the
  // common event jumps to it after a waited fade.
  // tests/fixtures/schema-compat/inflight-common-constructed holds a save
  // written by a labels-capable runtime (git archive of 0f14c2e, via
  // generate-inflight.ts) whose `unit` markers were stripped by hand before
  // saving, so it has the SHAPE of a pre-`unit` save but was not naturally
  // produced by one (0f14c2e already serializes `unit`). It is a constructed
  // compatibility probe for the restore-time label-scope reconstruction, not
  // a genuine old-generation save (that is inflight-common-oldgen, which has
  // no labels at all). Restoring it with the current runtime must rebuild the
  // label-scope markers: the common event's jump then lands in its OWN scope
  // (commonLanded) and never reaches the page root's same-named label
  // (pageLanded stays unset). Without the scope reconstruction the jump
  // would resolve against the page scope and set pageLanded instead, so this
  // test goes red if the rebuild is removed.
  const dir = join(import.meta.dir, "fixtures/schema-compat/inflight-common-constructed");
  const read = (entry: string): string => readFileSync(join(dir, entry), "utf8");
  const shell = JSON.parse(read("project.json")) as ProjectShell;
  const saveText = migrateFixtureGeneration(shell, read("save.json"));
  const expected = JSON.parse(read("expected.json")) as {
    commonLanded: boolean;
    pageLanded: boolean;
    mainEnded: boolean;
  };

  const session = createSession(shell, 60, createJsonMapRepository(shell.mapIndex, { read }));
  let state = restoreSessionEnvelope(session, saveText);

  // The fiber is still parked inside the common event, mid-fade.
  expect(state.interp.main).not.toBeNull();
  expect(state.interp.main!.mode).toBe("screenWait");
  expect(state.interp.main!.stack.length).toBe(2);
  // Restore rebuilt the label-scope markers a pre-`unit` save lacks: the
  // bottom frame is the page root (unit) and the top frame the called common
  // event (its own label scope, MV child-interpreter parity).
  const stack = state.interp.main!.stack;
  expect(stack[stack.length - 1]!.unit).toBe(true);
  expect(stack[0]!.unit).toBe(true);

  // Continue: the fade completes and the common event's jumpLabel "same"
  // lands in the common event's own scope (commonLanded), the page root's
  // same-named label is skipped (pageLanded stays unset), and the fiber
  // ends — matching the old runtime's recorded continuation.
  for (let i = 0; i < 240 && state.interp.main !== null; i++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.interp.sw.switches.commonLanded === true).toBe(expected.commonLanded);
  expect(state.interp.sw.switches.pageLanded === true).toBe(expected.pageLanded);
  if (expected.mainEnded) expect(state.interp.main).toBeNull();
});

test("an explicitly migrated genuine old-generation in-flight save keeps its behavior", () => {
  // The round-5 companion to the constructed probe: a save written naturally
  // by the pre-KRM3 runtime db2de159 (the generation that produced
  // gen-0e510772), which has no label/jumpLabel commands at all. Its main
  // fiber is parked inside a called common event (a waited fade), so it
  // exercises the same restore path (a two-frame stack rebuilt on load)
  // with a save a real old runtime produced — no hand editing. The page
  // calls the common event and then sets `pageContinued`; the common event
  // fades and sets `commonDone`. The restored continuation must match the
  // old runtime's recorded continuation (both switches set, fiber ended),
  // proving the restore migrations leave a genuine old save unchanged.
  const dir = join(import.meta.dir, "fixtures/schema-compat/inflight-common-oldgen");
  const read = (entry: string): string => readFileSync(join(dir, entry), "utf8");
  const shell = JSON.parse(read("project.json")) as ProjectShell;
  const oldSaveText = read("save.json");
  const expected = JSON.parse(read("expected.json")) as {
    commonDone: boolean;
    pageContinued: boolean;
    mainEnded: boolean;
  };

  // A genuine pre-KRM3 save: the file on disk has no `unit` markers (the
  // field did not exist yet) and no label/jumpLabel program anywhere.
  const rawSave = JSON.parse(oldSaveText) as {
    state: { interp: { main: { stack: { prog: { op: string }[]; unit?: true }[] } } };
  };
  const rawStack = rawSave.state.interp.main.stack;
  expect(rawStack.length).toBe(2);
  expect(rawStack.every((f) => f.unit === undefined)).toBe(true);
  const hasLabel = (prog: readonly { op: string }[]): boolean =>
    prog.some((c) => c.op === "label" || c.op === "jumpLabel");
  expect(rawStack.every((f) => !hasLabel(f.prog))).toBe(true);

  const saveText = migrateFixtureGeneration(shell, oldSaveText);
  const session = createSession(shell, 60, createJsonMapRepository(shell.mapIndex, { read }));
  let state = restoreSessionEnvelope(session, saveText);

  // The fiber is still parked inside the common event, mid-fade.
  expect(state.interp.main).not.toBeNull();
  expect(state.interp.main!.mode).toBe("screenWait");
  expect(state.interp.main!.stack.length).toBe(2);

  // Continue: the fade completes, the common event sets commonDone and
  // returns, the page sets pageContinued, and the fiber ends — matching the
  // old runtime's recorded continuation.
  for (let i = 0; i < 240 && state.interp.main !== null; i++) {
    state = stepSession(session, state, { buttons: 0 });
  }
  expect(state.interp.sw.switches.commonDone === true).toBe(expected.commonDone);
  expect(state.interp.sw.switches.pageContinued === true).toBe(expected.pageContinued);
  if (expected.mainEnded) expect(state.interp.main).toBeNull();
});

test("rpgkit-check counts KRM3 variable inputs and outputs as live use", () => {
  const project: Project = {
    format: "rpgkit-project/v1",
    title: "review lint probe",
    tileSize: 16,
    start: { map: "m", x: 1, y: 1, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [{ id: "item001", name: "Potion", sprite: "plain.0", type: "regular" }],
    maps: [map([once("runner", [
      { op: "variable", id: "coordX", set: { op: "set", value: 3 } },
      { op: "variable", id: "coordY", set: { op: "set", value: 4 } },
      { op: "selectItem", variable: "selected", itemType: "regular" },
      { op: "locationInfo", variable: "located", x: { variable: "coordX" }, y: { variable: "coordY" }, kind: "region" },
      { op: "if", if: { kind: "variable", id: "selected", op: ">=", value: 0 }, then: [] },
      { op: "if", if: { kind: "variable", id: "located", op: ">=", value: 0 }, then: [] },
    ])])],
  };
  const report = lintProject(project);
  const messages = (check: string) => report.findings
    .filter((finding) => finding.check === check)
    .map((finding) => finding.message);
  expect({
    readNeverSet: messages("lint/variable-read-never-set"),
    setNeverRead: messages("lint/variable-set-never-read"),
  }).toEqual({ readNeverSet: [], setNeverRead: [] });
});

test("public docs describe the completion queue's cross-map and terminal boundaries", () => {
  // The round-6 review probe (semantics A-C): the docs must state the
  // accurate rules, not an unconditional "exactly once": completions fire
  // innermost first; a cross-map transfer rebuilds the interpreter, so the
  // old map's queued completions are discarded (only the innermost takes
  // effect); exit/erase inside a result branch ends the whole event and
  // abandons the queued completion.
  const root = join(import.meta.dir, "..");
  const status = readFileSync(join(root, "docs/status.md"), "utf8");
  const readme = readFileSync(join(root, "src/engine/README.md"), "utf8");
  // The README wraps prose at a fixed column, so compare against the
  // whitespace-collapsed text.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  expect(flat(status)).toContain("ordered `onDone` queue");
  expect(flat(status)).toContain("innermost first");
  expect(flat(status)).toContain("only the innermost takes effect");
  expect(flat(status)).toContain("ends the whole event");
  expect(flat(readme)).toContain("rebuilds the interpreter for the new map");
  expect(flat(readme)).toContain("abandoning the queued completion with the fiber");
  expect(flat(readme)).toContain("plain enumerable frame property");
  expect(flat(readme)).toContain("a save taken before the field existed is rebuilt on restore");
});
