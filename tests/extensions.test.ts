import { describe, expect, test } from "bun:test";
import { loadProject, serializeProject } from "../editor/engine/document.ts";
import { assertImmutableJsonValue, createExtensionRuntime } from "../src/engine/extensions.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSwitchState, evalCondition, rngNext } from "../src/engine/interpreter.ts";
import {
  createSession,
  isSessionWorldIdle,
  startSession,
  stepSession,
  type Session,
  type SessionInput,
  type SessionState,
} from "../src/engine/session.ts";
import {
  canonicalJson,
  createSessionSnapshot,
  encodeEnvelope,
  fnv1aText,
  SaveError,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import type { ExtensionCommandResult, ExtensionOptions } from "../src/engine/extensions.ts";
import type { Command, GameEvent, JsonValue, MapDef, Project } from "../src/engine/types.ts";

const TILE = "plain.0";
const RIGHT = 0x0020;
const DOWN = 0x0040;
const L = 0x0100;
const CIRCLE = 0x2000;
const CROSS = 0x4000;

function map(id: string, commands: Command[] = [], condition?: GameEvent["pages"][number]["condition"]): MapDef {
  return {
    id,
    name: id,
    width: 6,
    height: 6,
    sheets: ["plain"],
    ground: new Array(36).fill(TILE),
    events: commands.length || condition ? [{
      id: "event",
      x: 1,
      y: 1,
      pages: [{ trigger: "autorun", commands, ...(condition ? { condition } : {}) }],
    }] : [],
  };
}

function project(commands: Command[], extraMaps: MapDef[] = []): Project {
  return {
    format: "rpgkit-project/v1",
    title: "extensions",
    tileSize: 16,
    start: { map: "a", x: 2, y: 2, dir: "down" },
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [map("a", commands), ...extraMaps],
  };
}

function step(
  session: Session,
  state: SessionState,
  input: SessionInput = { buttons: 0 },
): SessionState {
  return stepSession(session, state, input);
}

function projectWithEvents(events: GameEvent[]): Project {
  const p = project([]);
  return { ...p, maps: [{ ...p.maps[0]!, events }] };
}

const RESULT_WRITE = {
  index: "choice.index",
  key: "choice.key",
  cancelled: "choice.cancelled",
} as const;

function partyChoice(
  cancel = true,
  write: Extract<Command, { op: "extChoice" }>["write"] = RESULT_WRITE,
): Extract<Command, { op: "extChoice" }> {
  return {
    op: "extChoice",
    call: "demo.party",
    args: { source: "party" },
    prompt: "Choose for {name}",
    cancel,
    ...(write ? { write } : {}),
  };
}

function partyExtensions(withResolver = true): ExtensionOptions {
  const handler: NonNullable<ExtensionOptions["choices"]>[string] = {
    options(context, args) {
      expect(args).toEqual({ source: "party" });
      const revision = context.variables.revision === 1 ? 1
        : context.variables.revision === 2 ? 2
        : 0;
      const option = (key: string, label: string, enabled = true) => ({
        key,
        label,
        enabled,
        data: { key, revision },
      });
      if (revision === 1) {
        return [option("b", "Beta live"), option("a", "Alpha live"), option("x", "Locked live", false)];
      }
      if (revision === 2) return [option("b", "Beta only")];
      return [option("a", "Alpha"), option("x", "Locked", false), option("b", "Beta")];
    },
  };
  if (withResolver) {
    handler.resolve = (context, args, result): ExtensionCommandResult => {
      expect(args).toEqual({ source: "party" });
      const ext = context.ext as {
        party: string[];
        resolves: JsonValue[];
        cancellations: number;
      };
      const receipt = Math.floor(context.random() * 1_000_000);
      if (result.kind === "cancel") {
        return {
          ext: {
            ...ext,
            cancellations: ext.cancellations + 1,
            resolves: [...ext.resolves, { kind: "cancel", receipt }],
          },
          writes: { "resolver.kind": "cancel" },
        };
      }
      const data = result.data as { key: string; revision: number };
      return {
        ext: {
          ...ext,
          party: ext.party.filter((key) => key !== result.key),
          resolves: [...ext.resolves, { ...result, receipt }],
        },
        writes: {
          "resolver.kind": "select",
          "resolver.dataRevision": data.revision,
        },
      };
    };
  }
  return {
    initial: { party: ["a", "b"], resolves: [], cancellations: 0 },
    choices: { "demo.party": handler },
  };
}

/** A parallel choice opens before a lexically-later parallel changes the
 * provider's live input. On the next reducer tick the list is rebuilt. */
function dynamicChoiceProject(revision: 1 | 2 = 1): Project {
  return projectWithEvents([
    {
      id: "a-choice",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "parallel",
          commands: [partyChoice(), { op: "switch", id: "choice.done", value: true }],
        },
        { trigger: "action", commands: [], condition: { switch: "choice.done" } },
      ],
    },
    {
      id: "z-refresh",
      x: 1,
      y: 2,
      pages: [
        {
          trigger: "parallel",
          commands: [
            {
              op: "if",
              if: { kind: "worldIdle" },
              then: [{ op: "switch", id: "observer.idle", value: true }],
              else: [{ op: "switch", id: "observer.busy", value: true }],
            },
            { op: "variable", id: "revision", set: { op: "set", value: revision } },
            { op: "switch", id: "refresh.done", value: true },
          ],
        },
        { trigger: "action", commands: [], condition: { switch: "refresh.done" } },
      ],
    },
  ]);
}

function choiceModal(state: SessionState) {
  const modal = state.interp.modal;
  expect(modal?.kind).toBe("choices");
  if (modal?.kind !== "choices") throw new Error("expected choices modal");
  return modal;
}

describe("KB1 extension commands and conditions", () => {
  test("playerStep runs on ordinary and forced landings but not placement or a blocked route", () => {
    const stepHook: ExtensionOptions = {
      initial: { steps: 0 },
      commands: {
        "demo.player_step": (context) => ({
          ext: { steps: (context.ext as { steps: number }).steps + 1 },
          writes: { "hook.steps": (context.ext as { steps: number }).steps + 1 },
        }),
      },
      playerStep: { call: "demo.player_step", args: {} },
    };
    const p = projectWithEvents([{
      id: "route",
      x: 4,
      y: 2,
      pages: [{
        trigger: "action",
        commands: [{
          op: "moveRoute",
          target: "player",
          wait: true,
          route: { steps: ["moveDown"], repeat: false, skippable: true },
        }],
      }],
    }]);
    const session = createSession(p, 60, { extensions: stepHook });
    let state = startSession(p, session);

    for (let frame = 0; frame < 8; frame++) state = step(session, state, { buttons: RIGHT });
    expect([state.move.tx, state.move.ty]).toEqual([3, 2]);
    expect(state.ext).toEqual({ steps: 1 });
    expect(state.sw.variables["hook.steps"]).toBe(1);

    state = step(session, state, { buttons: 0, confirmEdge: true });
    for (let frame = 0; frame < 12; frame++) state = step(session, state);
    expect([state.move.tx, state.move.ty]).toEqual([3, 3]);
    expect(state.ext).toEqual({ steps: 2 });
    expect(state.sw.variables["hook.steps"]).toBe(2);

    const placed = project([{ op: "place", target: "player", x: 4, y: 4 }, { op: "erase" }]);
    const placedSession = createSession(placed, 60, { extensions: stepHook });
    let placedState = startSession(placed, placedSession);
    for (let frame = 0; frame < 3; frame++) placedState = step(placedSession, placedState);
    expect([placedState.move.tx, placedState.move.ty]).toEqual([4, 4]);
    expect(placedState.ext).toEqual({ steps: 0 });

    const blocked = project([{
      op: "moveRoute",
      target: "player",
      wait: true,
      route: { steps: ["moveUp"], repeat: false, skippable: true },
    }]);
    blocked.maps[0]!.passage = [[8, "block"]];
    const blockedSession = createSession(blocked, 60, { extensions: stepHook });
    let blockedState = startSession(blocked, blockedSession);
    for (let frame = 0; frame < 12; frame++) blockedState = step(blockedSession, blockedState);
    expect([blockedState.move.tx, blockedState.move.ty]).toEqual([2, 2]);
    expect(blockedState.ext).toEqual({ steps: 0 });
  });

  test("playerStep displacement reports signed landings and opts relocations in", () => {
    const hook: ExtensionOptions = {
      initial: { movements: [] },
      commands: {
        "demo.player_step": (context) => ({
          ext: {
            movements: [
              ...(context.ext as { movements: JsonValue[] }).movements,
              context.playerStep ?? null,
            ],
          },
        }),
      },
      playerStep: { call: "demo.player_step", displacement: true },
    };
    const p = project([
      {
        op: "moveRoute",
        target: "player",
        wait: true,
        route: {
          steps: ["moveRight", "moveDown", "moveLeft", "moveUp"],
          repeat: false,
          skippable: true,
        },
      },
      { op: "place", target: "player", x: 4, y: 3 },
      { op: "transfer", map: "b", x: 1, y: 5, dir: "down" },
    ], [map("b")]);
    const session = createSession(p, 60, { extensions: hook });
    let state = startSession(p, session);
    for (let frame = 0; frame < 80 && state.mapId !== "b"; frame++) state = step(session, state);

    expect(state.mapId).toBe("b");
    expect(state.ext).toEqual({ movements: [
      { dx: 1, dy: 0, kind: "step" },
      { dx: 0, dy: 1, kind: "step" },
      { dx: -1, dy: 0, kind: "step" },
      { dx: 0, dy: -1, kind: "step" },
      { dx: 2, dy: 1, kind: "relocation" },
      { dx: -3, dy: 2, kind: "relocation" },
    ] });
  });

  test("playerStep registration rejects malformed and missing command hooks", () => {
    expect(() => createExtensionRuntime({
      commands: { "demo.step": () => undefined },
      playerStep: { call: "not-namespaced" },
    })).toThrow("playerStep call");
    expect(() => createExtensionRuntime({
      playerStep: { call: "demo.step" },
    })).toThrow('playerStep command "demo.step" is not registered');
  });

  for (const hz of [60, 30, 20, 4]) test(`sleeping guards see earlier parallel writes at ${hz} Hz`, () => {
    const p = project([]);
    p.maps[0]!.events = [
      { id: "00-writer", x: 0, y: 0, pages: [{ trigger: "parallel", commands: [
        { op: "wait", seconds: 0.2 },
        { op: "variable", id: "open", set: { op: "set", value: 1 } },
        { op: "erase" },
      ] }] },
      { id: "10-guard", x: 1, y: 0, pages: [{ trigger: "parallel", commands: [
        { op: "if", if: { kind: "ext", call: "demo.open", args: null }, then: [
          { op: "switch", id: "observed", value: true }, { op: "erase" },
        ] },
      ] }] },
    ];
    const histories: string[][] = [];
    const calls: number[] = [];
    for (const deterministicConditions of [false, true]) {
      let count = 0;
      const session = createSession(p, hz, { immutableState: true, extensions: {
        immutableConditions: true, deterministicConditions,
        conditions: { "demo.open": context => { count++; return context.variables.open === 1; } },
      } });
      let state = startSession(p, session);
      const history: string[] = [];
      for (let frame = 0; frame < hz; frame++) {
        const prior = state, bytes = JSON.stringify(prior);
        state = step(session, state);
        expect(JSON.stringify(prior)).toBe(bytes);
        history.push(JSON.stringify(state));
      }
      expect(state.sw.switches.observed).toBe(true);
      histories.push(history);
      calls.push(count);
    }
    expect(histories[1]).toEqual(histories[0]);
    expect(calls[1]).toBeLessThan(calls[0]!);
  });

  test("condition isolation defaults to copies and can opt into immutable references", () => {
    for (const immutableConditions of [false, true]) {
      const args = { count: 2 };
      let observedExt: JsonValue = null;
      let observedArgs: JsonValue = null;
      const runtime = createExtensionRuntime({
        immutableConditions,
        initial: { count: 2 },
        conditions: { "demo.check": (context, value) => {
          observedExt = context.ext;
          observedArgs = value;
          const matches = (context.ext as typeof args).count === (value as typeof args).count;
          if (!immutableConditions) {
            (context.ext as typeof args).count = 99;
            (value as typeof args).count = 99;
          }
          return matches;
        } },
      });
      const ext = Object.freeze({ count: 2 });
      Object.freeze(args);
      expect(evalCondition({ kind: "ext", call: "demo.check", args },
        createSwitchState(), "event", undefined, { runtime, ext })).toBe(true);
      expect(ext).toEqual({ count: 2 });
      expect(args).toEqual({ count: 2 });
      expect(observedExt === ext).toBe(immutableConditions);
      expect(observedArgs === args).toBe(immutableConditions);
    }
  });

  test("a command reads/writes ext and variables and draws only from the saved session RNG", () => {
    const p = project([
      { op: "ext", call: "demo.increment", args: { amount: 2 } },
      {
        op: "if",
        if: { kind: "ext", call: "demo.at_least", args: { count: 2 } },
        then: [{ op: "switch", id: "condition-passed", value: true }],
      },
    ]);
    const session = createSession(p, 60, {
      extensions: {
        initial: { count: 0 },
        commands: {
          "demo.increment": (context, args) => {
            const ext = context.ext as { count: number };
            const amount = (args as { amount: number }).amount;
            return {
              ext: { count: ext.count + amount },
              writes: { "demo.roll": Math.floor(context.random() * 1_000_000) },
            };
          },
        },
        conditions: {
          "demo.at_least": (context, args) =>
            (context.ext as { count: number }).count >= (args as { count: number }).count,
        },
      },
    });
    const before = startSession(p, session);
    const retainedBefore = JSON.stringify(before);
    const expected = rngNext(before.sw.rng);
    const after = step(session, before);

    expect(JSON.stringify(before)).toBe(retainedBefore);
    expect(before.ext).toEqual({ count: 0 });
    expect(after.ext).toEqual({ count: 2 });
    expect(after.sw.variables["demo.roll"]).toBe(Math.floor(expected.value * 1_000_000));
    expect(after.sw.rng).toBe(expected.next);
    expect(after.sw.switches["condition-passed"]).toBe(true);
  });

  test("a live choice refreshes every tick, follows its stable key, blocks disabled confirmation, and resolves atomically", () => {
    const p = dynamicChoiceProject();
    const session = createSession(p, 60, { extensions: partyExtensions() });
    let state = startSession(p, session);

    state = step(session, state);
    const retainedOpen = state;
    const retainedJson = JSON.stringify(retainedOpen);
    expect(choiceModal(state)).toMatchObject({
      prompt: "Choose for Player",
      options: ["Alpha", "Locked", "Beta"],
      keys: ["a", "x", "b"],
      enabled: [true, false, true],
      index: 0,
      cancellable: true,
    });
    expect(state.interp.main).toBeNull();
    expect(state.sw.switches["observer.busy"]).toBe(true);
    expect(state.sw.switches["observer.idle"]).toBeUndefined();
    expect(isSessionWorldIdle(state)).toBe(false);

    const beforeMove = [state.move.tx, state.move.ty, state.move.px, state.move.py];
    state = step(session, state, { buttons: RIGHT });
    expect([state.move.tx, state.move.ty, state.move.px, state.move.py]).toEqual(beforeMove);
    expect(choiceModal(state)).toMatchObject({
      options: ["Beta live", "Alpha live", "Locked live"],
      keys: ["b", "a", "x"],
      enabled: [true, true, false],
      index: 1,
    });
    expect(JSON.stringify(retainedOpen)).toBe(retainedJson);

    state = step(session, state, { buttons: 0, downEdge: true });
    expect(choiceModal(state).index).toBe(2);
    const beforeDisabled = state.ext;
    state = step(session, state, { buttons: 0, confirmEdge: true });
    expect(choiceModal(state).index).toBe(2);
    expect(state.ext).toEqual(beforeDisabled);
    expect(state.sw.variables["choice.key"]).toBeUndefined();
    expect(state.sw.variables["resolver.kind"]).toBeUndefined();
    expect(state.sw.switches["choice.done"]).toBeUndefined();

    state = step(session, state, { buttons: 0, downEdge: true });
    expect(choiceModal(state).index).toBe(0);
    state = step(session, state, { buttons: 0, confirmEdge: true });
    expect(state.interp.modal).toBeNull();
    expect(state.sw.variables).toMatchObject({
      "choice.index": 0,
      "choice.key": "b",
      "choice.cancelled": 0,
      "resolver.kind": "select",
      "resolver.dataRevision": 1,
    });
    expect(state.ext).toMatchObject({
      party: ["a"],
      cancellations: 0,
      resolves: [{ kind: "select", index: 0, key: "b", data: { key: "b", revision: 1 } }],
    });
    expect(state.sw.switches["choice.done"]).toBe(true);
    expect(isSessionWorldIdle(state)).toBe(true);
  });

  test("a disappearing selected key suppresses the same-frame confirm until the replacement row has been shown", () => {
    const p = dynamicChoiceProject(2);
    const session = createSession(p, 60, { extensions: partyExtensions() });
    let state = step(session, startSession(p, session));
    expect(choiceModal(state)).toMatchObject({ keys: ["a", "x", "b"], index: 0 });

    state = step(session, state, { buttons: 0, confirmEdge: true });
    expect(choiceModal(state)).toMatchObject({
      options: ["Beta only"],
      keys: ["b"],
      index: 0,
    });
    expect(state.sw.variables["choice.key"]).toBeUndefined();
    expect((state.ext as { resolves: JsonValue[] }).resolves).toEqual([]);

    state = step(session, state, { buttons: 0, confirmEdge: true });
    expect(state.interp.modal).toBeNull();
    expect(state.sw.variables["choice.key"]).toBe("b");
    expect((state.ext as { resolves: JsonValue[] }).resolves).toHaveLength(1);
  });

  test("cancel writes explicit sentinels and reaches the resolver; non-cancellable cancel is ignored", () => {
    const cancellable = project([partyChoice(), { op: "erase" }]);
    const session = createSession(cancellable, 60, { extensions: partyExtensions() });
    let state = step(session, startSession(cancellable, session));
    state = step(session, state, { buttons: 0, cancelEdge: true });
    expect(state.interp.modal).toBeNull();
    expect(state.sw.variables).toMatchObject({
      "choice.index": -1,
      "choice.key": "",
      "choice.cancelled": 1,
      "resolver.kind": "cancel",
    });
    expect(state.ext).toMatchObject({ cancellations: 1, resolves: [{ kind: "cancel" }] });

    const fixed = project([partyChoice(false), { op: "erase" }]);
    const fixedSession = createSession(fixed, 60, { extensions: partyExtensions() });
    let fixedState = step(fixedSession, startSession(fixed, fixedSession));
    fixedState = step(fixedSession, fixedState, { buttons: 0, cancelEdge: true });
    expect(choiceModal(fixedState)).toMatchObject({ index: 0, cancellable: false });
    expect(fixedState.sw.variables["choice.cancelled"]).toBeUndefined();
    expect((fixedState.ext as { resolves: JsonValue[] }).resolves).toEqual([]);
  });

  test("direct result writes work when the choice resolver is omitted", () => {
    const p = project([partyChoice(false), { op: "erase" }]);
    const session = createSession(p, 60, { extensions: partyExtensions(false) });
    let state = step(session, startSession(p, session));
    state = step(session, state, { buttons: 0, confirmEdge: true });
    expect(state.interp.modal).toBeNull();
    expect(state.ext).toEqual({ party: ["a", "b"], resolves: [], cancellations: 0 });
    expect(state.sw.variables).toMatchObject({
      "choice.index": 0,
      "choice.key": "a",
      "choice.cancelled": 0,
    });
    expect(state.sw.variables["resolver.kind"]).toBeUndefined();
  });

  test("createSession lists every unregistered call; preview no-op is explicit", () => {
    const commands: Command[] = [
      { op: "ext", call: "demo.missing_command", args: null },
      {
        op: "extChoice",
        call: "demo.missing_choice",
        args: null,
        prompt: "Preview",
      },
      {
        op: "if",
        if: { kind: "ext", call: "demo.missing_condition", args: [] },
        then: [{ op: "switch", id: "wrong", value: true }],
        else: [{ op: "switch", id: "preview-false", value: true }],
      },
    ];
    const p = project(commands);
    expect(() => createSession(p)).toThrow(
      "createSession: unregistered extension calls: choice demo.missing_choice, command demo.missing_command, condition demo.missing_condition",
    );

    const preview = createSession(p, 60, { extensions: { allowUnknown: true } });
    const state = step(preview, startSession(p, preview));
    expect(state.ext).toBeNull();
    expect(state.interp.modal).toBeNull();
    expect(state.sw.switches["preview-false"]).toBe(true);
    expect(state.sw.switches["wrong"]).toBeUndefined();
  });

  for (const scenario of [
    {
      name: "a non-array provider result",
      raw: null,
      message: "options must return an array",
    },
    {
      name: "a non-object option",
      raw: [null],
      message: "option 0 must be an object",
    },
    {
      name: "an empty key",
      raw: [{ key: "", label: "A" }],
      message: "option 0.key must be a non-empty string",
    },
    {
      name: "duplicate stable keys",
      raw: [{ key: "a", label: "A" }, { key: "a", label: "Again" }],
      message: "option key \"a\" is duplicated",
    },
    {
      name: "an empty label",
      raw: [{ key: "a", label: "" }],
      message: "option 0.label must be a non-empty string",
    },
    {
      name: "a non-boolean enabled flag",
      raw: [{ key: "a", label: "A", enabled: "yes" }],
      message: "option 0.enabled must be a boolean",
    },
    {
      name: "non-JSON option data",
      raw: [{ key: "a", label: "A", data: { bad: Number.POSITIVE_INFINITY } }],
      message: "option 0.data: $.bad: finite number required",
    },
    {
      name: "a non-cancellable list with no enabled row",
      raw: [{ key: "a", label: "A", enabled: false }],
      message: "must provide an enabled option when cancel is false",
    },
  ] as const) {
    test(`an extension choice rejects ${scenario.name}`, () => {
      const p = project([{
        op: "extChoice",
        call: "demo.invalid",
        args: null,
        prompt: "Invalid",
        cancel: false,
      }]);
      const session = createSession(p, 60, {
        extensions: {
          choices: {
            "demo.invalid": { options: () => scenario.raw as never },
          },
        },
      });
      const initial = startSession(p, session);
      const retained = JSON.stringify(initial);
      expect(() => step(session, initial)).toThrow(scenario.message);
      expect(JSON.stringify(initial)).toBe(retained);
    });
  }

  test("a cancellable provider may expose an empty list and cancel it", () => {
    const p = project([partyChoice(true), { op: "erase" }]);
    const session = createSession(p, 60, {
      extensions: {
        choices: { "demo.party": { options: () => [] } },
      },
    });
    let state = step(session, startSession(p, session));
    expect(choiceModal(state)).toMatchObject({ options: [], keys: [], enabled: [], index: 0, cancellable: true });
    state = step(session, state, { buttons: 0, cancelEdge: true });
    expect(state.interp.modal).toBeNull();
    expect(state.sw.variables).toMatchObject({
      "choice.index": -1,
      "choice.key": "",
      "choice.cancelled": 1,
    });
  });

  test("write destinations are non-empty and distinct", () => {
    const registered = { extensions: partyExtensions(false) };
    expect(() => createSession(project([
      partyChoice(true, { key: "" }),
    ]), 60, registered)).toThrow("write destinations must be non-empty variable ids");
    expect(() => createSession(project([
      partyChoice(true, { index: "same", key: "same" }),
    ]), 60, registered)).toThrow("write destinations must be distinct");
  });

  test("resolver writes cannot collide with direct sinks and a failed resolution publishes nothing", () => {
    const p = project([partyChoice(false, { key: "choice.key" }), { op: "erase" }]);
    const session = createSession(p, 60, {
      extensions: {
        initial: { untouched: true },
        choices: {
          "demo.party": {
            options: () => [{ key: "a", label: "Alpha", data: { nested: [1, 2] } }],
            resolve: () => ({ ext: { changed: true }, writes: { "choice.key": "shadow" } }),
          },
        },
      },
    });
    const open = step(session, startSession(p, session));
    const retained = JSON.stringify(open);
    expect(() => step(session, open, { buttons: 0, confirmEdge: true })).toThrow(
      "result.writes conflicts with extChoice write target \"choice.key\"",
    );
    expect(JSON.stringify(open)).toBe(retained);
    expect(open.ext).toEqual({ untouched: true });
    expect(open.sw.variables["choice.key"]).toBeUndefined();
  });

  test("a choice resolver must return an extension result object or undefined", () => {
    const p = project([partyChoice(false), { op: "erase" }]);
    const session = createSession(p, 60, {
      extensions: {
        choices: {
          "demo.party": {
            options: () => [{ key: "a", label: "Alpha" }],
            resolve: () => 7 as never,
          },
        },
      },
    });
    const open = step(session, startSession(p, session));
    const retained = JSON.stringify(open);
    expect(() => step(session, open, { buttons: 0, confirmEdge: true })).toThrow(
      "extension choice \"demo.party\" resolver must return an object or undefined",
    );
    expect(JSON.stringify(open)).toBe(retained);
    expect(open.interp.modal).not.toBeNull();
  });

  test("codec, validator, checksum, JSON round-trip and restore all cover ext", () => {
    const p = project([{ op: "ext", call: "demo.increment", args: 3 }]);
    const options = {
      initial: { count: 1 } satisfies JsonValue,
      commands: {
        "demo.increment": (context: { ext: JsonValue }) => ({
          ext: { count: (context.ext as { count: number }).count + 3 },
        }),
      },
      codec: {
        encode: (value: JsonValue): JsonValue => ({ payload: value }),
        decode: (value: JsonValue): JsonValue => (value as { payload: JsonValue }).payload,
      },
      validate: (value: JsonValue) =>
        typeof (value as { count?: unknown } | null)?.count === "number" || "count must be numeric",
    };
    const session = createSession(p, 60, { extensions: options });
    const state = step(session, startSession(p, session));
    const snapshot = createSessionSnapshot(session, state, 0);
    expect(snapshot.ext).toEqual({ payload: { count: 4 } });

    const bytes = encodeEnvelope(snapshot);
    const restored = restoreSessionEnvelope(session, bytes);
    expect(restored.ext).toEqual({ count: 4 });
    expect(restored.scene).toBeNull();
    expect(canonicalJson(createSessionSnapshot(session, restored, 0))).toBe(canonicalJson(snapshot));

    const changed = { ...snapshot, ext: { payload: { count: 5 } } };
    expect(JSON.parse(encodeEnvelope(changed)).checksum).not.toBe(JSON.parse(bytes).checksum);

    const invalid = encodeEnvelope({ ...snapshot, ext: { payload: { count: "bad" } } });
    try {
      restoreSessionEnvelope(session, invalid);
      throw new Error("expected invalid extension save to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(SaveError);
      expect((error as SaveError).code).toBe("shape");
      expect((error as Error).message).toContain("count must be numeric");
    }
  });

  test("a checksum-valid older v1 save hydrates the absent extension slot as null", () => {
    const p = project([]);
    const session = createSession(p);
    const current = JSON.parse(
      encodeEnvelope(createSessionSnapshot(session, startSession(p, session), 0)),
    ) as { state: Record<string, unknown>; checksum: string };
    delete current.state.ext;
    current.checksum = fnv1aText(canonicalJson(current.state));

    expect(restoreSessionEnvelope(session, JSON.stringify(current)).ext).toBeNull();
  });

  test("a safe parallel wait containing a future extChoice restores, while the open modal is not saveable", () => {
    const p = projectWithEvents([{
      id: "saved-choice",
      x: 1,
      y: 1,
      pages: [
        {
          trigger: "parallel",
          commands: [
            { op: "wait", seconds: 0.5 },
            partyChoice(false),
            { op: "switch", id: "choice.done", value: true },
          ],
        },
        { trigger: "action", commands: [], condition: { switch: "choice.done" } },
      ],
    }]);
    const session = createSession(p, 60, { extensions: partyExtensions() });
    let direct = startSession(p, session);
    for (let frame = 0; frame < 10; frame++) direct = step(session, direct);
    expect(direct.interp.parallels["a/saved-choice"]?.mode).toBe("wait");

    const waitingSnapshot = createSessionSnapshot(session, direct, 0);
    let restored = restoreSessionEnvelope(session, encodeEnvelope(waitingSnapshot));
    expect(canonicalJson(createSessionSnapshot(session, restored, 0))).toBe(canonicalJson(waitingSnapshot));
    for (let frame = 0; frame < 40 && direct.interp.modal === null; frame++) {
      direct = step(session, direct);
      restored = step(session, restored);
      expect(restored).toEqual(direct);
    }
    expect(choiceModal(direct)).toMatchObject({ keys: ["a", "x", "b"], index: 0 });
    expect(restored).toEqual(direct);
    expect(direct.interp.main).toBeNull();
    expect(() => createSessionSnapshot(session, direct, 0)).toThrow(/no modal or scene open/);

    direct = step(session, direct, { buttons: 0, confirmEdge: true });
    restored = step(session, restored, { buttons: 0, confirmEdge: true });
    expect(restored).toEqual(direct);
    expect(direct.sw.switches["choice.done"]).toBe(true);
    expect(direct.sw.variables).toMatchObject({
      "choice.index": 0,
      "choice.key": "a",
      "choice.cancelled": 0,
    });
    expect(direct.ext).toMatchObject({ party: ["b"], resolves: [{ kind: "select", key: "a" }] });

    const completed = createSessionSnapshot(session, direct, 0);
    const completedRestored = restoreSessionEnvelope(session, encodeEnvelope(completed));
    expect(canonicalJson(createSessionSnapshot(session, completedRestored, 0))).toBe(canonicalJson(completed));
    expect(completedRestored.ext).toEqual(direct.ext);
    expect(completedRestored.sw.variables).toEqual(direct.sw.variables);
  });

  test("attract rewind refolds extension state and RNG from a clean session", () => {
    const p = project([{ op: "ext", call: "demo.tick", args: null }]);
    const extensions = {
      initial: { count: 0, rolls: [] } satisfies JsonValue,
      commands: {
        "demo.tick": (context: { ext: JsonValue; random(): number }) => {
          const ext = context.ext as { count: number; rolls: number[] };
          return {
            ext: {
              count: ext.count + 1,
              rolls: [...ext.rolls, Math.floor(context.random() * 256)],
            },
          };
        },
      },
    };
    const rewound = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 2 / 60,
      extensions,
    });
    const fresh = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 2 / 60,
      extensions,
    });
    rewound.startPlay();
    fresh.startPlay();
    for (let i = 0; i < 5; i++) rewound.step(0);
    for (let i = 0; i < 3; i++) fresh.step(0);
    rewound.step(0x0100);

    expect(rewound.length).toBe(3);
    expect(rewound.state.ext).toEqual({ count: 3, rolls: expect.any(Array) });
    expect(rewound.state).toEqual(fresh.state);
  });

  test("attract rewind across a resolved extChoice restores its modal, cursor, extension state, and RNG", () => {
    const p = project([partyChoice(false), { op: "erase" }]);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 3 / 60,
      extensions: partyExtensions(),
    });
    controller.startPlay();
    controller.step(0); // open, index 0 (a)
    controller.step(DOWN); // disabled x
    controller.step(0); // release
    controller.step(DOWN); // enabled b
    controller.step(0); // release; rewind target
    const beforeSelection = structuredClone(controller.state);
    expect(choiceModal(controller.state)).toMatchObject({ keys: ["a", "x", "b"], index: 2 });

    controller.step(CIRCLE);
    controller.step(0);
    controller.step(0);
    const completed = structuredClone(controller.state);
    const completedLength = controller.length;
    expect(completed.ext).toMatchObject({ party: ["a"], resolves: [{ kind: "select", key: "b" }] });

    controller.step(L);
    expect(controller.length).toBe(completedLength - 3);
    expect(controller.state).toEqual(beforeSelection);
    expect(choiceModal(controller.state)).toMatchObject({ keys: ["a", "x", "b"], index: 2 });
    expect((controller.state.ext as { resolves: JsonValue[] }).resolves).toEqual([]);

    controller.step(CIRCLE);
    controller.step(0);
    controller.step(0);
    expect(controller.state).toEqual(completed);
  });

  test("an extChoice journey has the same semantic state at 60/30/20/4 Hz", () => {
    const run = (hz: 60 | 30 | 20 | 4): string => {
      const p = dynamicChoiceProject();
      const session = createSession(p, hz, { extensions: partyExtensions() });
      let state = startSession(p, session);
      const ticksPerFrame = 60 / hz;
      for (let tick = 0; tick < 180; tick += ticksPerFrame) {
        state = step(session, state, {
          buttons: 0,
          downEdge: tick === 60 || tick === 120,
          confirmEdge: tick === 90 || tick === 150,
        });
      }
      expect(state.interp.frame).toBe(180);
      expect(state.interp.modal).toBeNull();
      expect(state.sw.variables).toMatchObject({
        "choice.index": 0,
        "choice.key": "b",
        "choice.cancelled": 0,
        "resolver.dataRevision": 1,
      });
      expect(state.ext).toMatchObject({ party: ["a"], resolves: [{ kind: "select", key: "b" }] });
      return JSON.stringify({ ...state, frame: 0 });
    };

    const reference = run(60);
    for (const hz of [30, 20, 4] as const) expect(run(hz), `${hz} Hz`).toBe(reference);
  });

  test("attract presents an extChoice boundary and readable hold at every host rate", () => {
    const p = project([partyChoice(false), { op: "erase" }]);
    const tape = [0, CIRCLE, 0];
    const states = ([60, 30, 20, 4] as const).map((hz) => {
      const controller = new AttractController(p, tape, {
        hz,
        tapeHz: 60,
        endHoldFrames: 60_000,
        extensions: partyExtensions(),
      });
      controller.startAttract();
      controller.step(0);
      expect(controller.status().demoFrame, `open boundary at ${hz} Hz`).toBe(1);
      expect(controller.presentedModal(), `visible choice at ${hz} Hz`).toMatchObject({
        kind: "choices",
        keys: ["a", "x", "b"],
        enabled: [true, false, true],
        index: 0,
      });

      controller.step(0);
      expect(controller.status().demoFrame, `held source at ${hz} Hz`).toBe(1);
      expect(controller.status().readHold, `read hold at ${hz} Hz`).toBeGreaterThan(0);
      let guard = 0;
      while (controller.status().demoFrame < tape.length && guard++ < hz * 5) controller.step(0);
      expect(controller.status().demoFrame, `completed tape at ${hz} Hz`).toBe(tape.length);
      expect(controller.state.ext).toMatchObject({ party: ["b"], resolves: [{ kind: "select", key: "a" }] });
      return controller.state;
    });
    expect(states.slice(1)).toEqual([states[0], states[0], states[0]]);
  });

  test("transfer resolves map, coordinates and direction from live variables", () => {
    const p = project([
      { op: "ext", call: "demo.destination", args: null },
      {
        op: "transfer",
        map: { variable: "dest.map" },
        x: { variable: "dest.x" },
        y: { variable: "dest.y" },
        dir: { variable: "dest.dir" },
      },
    ], [map("b")]);
    const session = createSession(p, 60, {
      extensions: {
        commands: {
          "demo.destination": () => ({
            writes: { "dest.map": "b", "dest.x": 4, "dest.y": 3, "dest.dir": "left" },
          }),
        },
      },
    });
    const state = step(session, startSession(p, session));
    expect(state.mapId).toBe("b");
    expect([state.move.tx, state.move.ty, state.move.facing]).toEqual([4, 3, 1]);
  });

  for (const scenario of [
    {
      name: "an unset map variable",
      variables: { "dest.x": 4, "dest.y": 3, "dest.dir": "left" },
      message: "map variable must hold a non-empty string",
    },
    {
      name: "a non-integer coordinate variable",
      variables: { "dest.map": "b", "dest.x": 1.5, "dest.y": 3, "dest.dir": "left" },
      message: "coordinate variables must hold non-negative integers",
    },
    {
      name: "an invalid direction variable",
      variables: { "dest.map": "b", "dest.x": 4, "dest.y": 3, "dest.dir": "diagonal" },
      message: "direction variable must hold down|left|right|up|keep",
    },
    {
      name: "a non-existent map variable",
      variables: { "dest.map": "missing", "dest.x": 4, "dest.y": 3, "dest.dir": "left" },
      message: "unknown map \"missing\"",
    },
  ] satisfies readonly {
    name: string;
    variables: Readonly<Record<string, string | number>>;
    message: string;
  }[]) {
    test(`${scenario.name} becomes a frozen fatal state instead of throwing`, () => {
      const p = project([
        {
          op: "transfer",
          map: { variable: "dest.map" },
          x: { variable: "dest.x" },
          y: { variable: "dest.y" },
          dir: { variable: "dest.dir" },
        },
        { op: "switch", id: "after-transfer", value: true },
      ], [map("b")]);
      const session = createSession(p);
      const initial = startSession(p, session);
      Object.assign(initial.sw.variables, scenario.variables);
      let failed: SessionState | undefined;

      expect(() => { failed = step(session, initial); }).not.toThrow();
      expect(failed).toBeDefined();
      const fatal = failed!;
      expect(fatal.interp.error).toEqual({
        kind: "content",
        message: `transfer in a/event: ${scenario.message}`,
      });
      expect(fatal.mapId).toBe("a");
      expect(fatal.sw.switches["after-transfer"]).toBeUndefined();
      expect(() => createSessionSnapshot(session, fatal, 0)).toThrow(/no modal or scene open/);

      const frozen = step(session, fatal);
      expect(frozen.frame).toBe(fatal.frame + 1);
      expect(frozen.interp).toEqual(fatal.interp);
      expect(frozen.move).toEqual(fatal.move);
      expect(frozen.chars).toEqual(fatal.chars);
    });
  }

  test("schema/editor JSON round-trip preserves ext, extChoice, and battle commands verbatim", () => {
    const p = project([{
      op: "if",
      if: { kind: "ext", call: "demo.ready", args: { flag: true } },
      then: [
        { op: "ext", call: "demo.run", args: [1, "two", null] },
        {
          op: "extChoice",
          call: "demo.pick",
          args: { party: true },
          prompt: "Choose",
          cancel: true,
          write: { index: "picked.index", key: "picked.key", cancelled: "picked.cancelled" },
        },
      ],
      else: [{ op: "battle", setup: { enemy: "slime" }, onWin: [{ op: "switch", id: "won", value: true }] }],
    }]);
    const text = serializeProject(p);
    const loaded = loadProject(text);
    expect(loaded.errors).toEqual([]);
    expect(serializeProject(loaded.project)).toBe(text);
  });
});


test("immutable JSON validation reuses valid branches without accepting invalid descendants", () => {
  const child = Object.freeze({ count: 3, tags: Object.freeze(["a", "b", 1, null, false]) });
  assertImmutableJsonValue(child, "shared");
  assertImmutableJsonValue({ left: child, right: child }, "dag");
  for (const value of [NaN, Infinity, -Infinity, undefined, () => 0, new Date(), Symbol("x"), 1n]) {
    expect(() => assertImmutableJsonValue({ child, nested: [{ bad: value }] }, "state"))
      .toThrow("state: $.nested[0].bad:");
    expect(() => assertImmutableJsonValue([child, value], "state"))
      .toThrow("state: $[1]:");
  }
  const cycle: Record<string, unknown> = { child };
  cycle.next = cycle;
  expect(() => assertImmutableJsonValue(cycle, "state")).toThrow("state: $.next: cyclic");
  expect(() => assertImmutableJsonValue(cycle, "state")).toThrow("state: $.next: cyclic");
});
