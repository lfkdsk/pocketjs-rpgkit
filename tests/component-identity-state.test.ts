// Runtime character identity and semantic name-input selection. Kept
// separate from the UI pointer tests: this file proves reducer/save/replay
// behaviour without mounting a view.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { AttractController } from "../src/engine/attract.ts";
import { createSwitchState } from "../src/engine/interpreter.ts";
import {
  NAME_INPUT_SCENE_ID,
  nameInputRules,
  type NameInputState,
} from "../src/engine/name-input.ts";
import {
  createSessionSnapshot,
  canonicalJson,
  decodeEnvelopeText,
  encodeEnvelope,
  fnv1aText,
} from "../src/engine/save.ts";
import { restoreSessionEnvelope } from "../src/engine/save-restore.ts";
import {
  createSession,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Command, GameEvent, Project } from "../src/engine/types.ts";

const MAP_ID = "names";
const EVENT_ID = "NPC_1";

function project(commands: Command[], characterNames?: boolean): Project {
  const npc: GameEvent = {
    id: EVENT_ID,
    name: "Guide",
    x: 3,
    y: 3,
    pages: [
      { trigger: "autorun", commands },
      { trigger: "action", commands: [], condition: { selfSwitch: "A" } },
    ],
  };
  return {
    format: "rpgkit-project/v1",
    title: "Runtime name fixture",
    tileSize: 16,
    start: { map: MAP_ID, x: 1, y: 1, dir: "down" },
    ...(characterNames === undefined ? {} : { system: { characterNames } }),
    sheets: [{ id: "plain", cols: 1, rows: 1, pak: "chunks", defaultPassage: "pass" }],
    items: [],
    maps: [{
      id: MAP_ID,
      name: "Names",
      width: 6,
      height: 6,
      sheets: ["plain"],
      ground: new Array(36).fill("plain.0"),
      events: [npc],
    }],
  };
}

function pump(session: Session, state: SessionState, frames = 8): SessionState {
  let next = state;
  for (let i = 0; i < frames; i++) next = stepSession(session, next, { buttons: 0 });
  return next;
}

describe("name-input semantic selectors", () => {
  const context = (value: number) => ({
    ext: null,
    switches: {},
    variables: { selector: value },
    items: {},
    gold: 0,
    playerName: "Player",
  });

  test("numeric selector variables choose String(value) rows, including 0/1/2", () => {
    const table = { "0": ["Zero"], "1": ["One"], "2": ["Two"] };
    for (const [value, expected] of [[0, "Zero"], [1, "One"], [2, "Two"]] as const) {
      const started = nameInputRules.start(null, {
        variable: "name",
        randomNames: table,
        randomNamesKeyVariable: "selector",
      }, 123, context(value));
      expect((started!.state as unknown as NameInputState).randomPool).toEqual([expected]);
    }
  });

  test("selectIndex atomically selects and activates a valid cell", () => {
    const started = nameInputRules.start(null, {
      variable: "name",
      charset: ["A"],
    }, 123, context(0))!;
    let state = nameInputRules.step(started.state, { buttons: 0, selectIndex: 0 }, 1);
    expect((state as unknown as NameInputState).buffer).toBe("A");
    // One character, then BACK (1), OK (2), CANCEL (3).
    state = nameInputRules.step(state, { buttons: 0, selectIndex: 2 }, 1);
    expect(nameInputRules.done(state)).toEqual({ ext: null, writes: { name: "A" } });
  });

  test("an invalid selectIndex neither moves nor confirms the focused cell", () => {
    const started = nameInputRules.start(null, {
      variable: "name",
      charset: ["A"],
    }, 123, context(0))!;
    const state = nameInputRules.step(started.state, { buttons: 0, selectIndex: 99 }, 1);
    expect(state).toEqual(started.state);
    expect(nameInputRules.done(state)).toBeNull();
  });
});
describe("runtime NPC names", () => {
  const renameAndSpeak: Command[] = [
    { op: "changeName", target: "this", name: { variable: "picked-name" } },
    { op: "text", lines: ["{char:this}: Welcome, {char:player}."] },
  ];

  test("a variable-fed NPC rename is consumed by visible dialog text", () => {
    const p = project(renameAndSpeak, true);
    const session = createSession(p);
    const initial = createSwitchState({ variables: { "picked-name": "Ada" }, playerName: "Red" });
    const state = pump(session, startSession(p, session, initial));
    expect(state.sw.eventNames).toEqual({ [`${MAP_ID}/${EVENT_ID}`]: "Ada" });
    expect(state.interp.modal).toMatchObject({
      kind: "text",
      lines: ["Ada: Welcome, Red."],
    });
  });

  test("without the project opt-in, old {char:} text remains literal", () => {
    const p = project(renameAndSpeak);
    const session = createSession(p);
    const initial = createSwitchState({ variables: { "picked-name": "Ada" }, playerName: "Red" });
    const state = pump(session, startSession(p, session, initial));
    expect(state.interp.modal).toMatchObject({
      kind: "text",
      lines: ["{char:this}: Welcome, {char:player}."],
    });
  });

  test("unused projects retain sparse zero-allocation state", () => {
    const p = project([{ op: "selfSwitch", key: "A", value: true }]);
    const session = createSession(p);
    const state = pump(session, startSession(p, session), 30);
    expect("eventNames" in state.sw).toBe(false);
    expect("eventNames" in state.interp.sw).toBe(false);
  });

  test("a real session save envelope restores the map-scoped NPC identity", () => {
    const p = project([
      { op: "changeName", target: "this", name: { variable: "picked-name" } },
      { op: "selfSwitch", key: "A", value: true },
    ], true);
    const session = createSession(p);
    const initial = createSwitchState({ variables: { "picked-name": "Ada" } });
    const played = pump(session, startSession(p, session, initial));
    expect(played.interp.main).toBeNull();

    const encoded = encodeEnvelope(createSessionSnapshot(session, played, 0), session.content);
    const restored = restoreSessionEnvelope(session, encoded);
    expect(restored.sw.eventNames).toEqual({ [`${MAP_ID}/${EVENT_ID}`]: "Ada" });
    expect(restored.interp.sw).toBe(restored.sw);
  });

  test("a real session save envelope preserves both combat-sheet layers", () => {
    const p = project([
      {
        op: "appearance",
        target: "player",
        sprite: "heroine",
        combatSheet: "heroineblack",
        saveDefault: true,
      },
      { op: "appearance", target: "player", combatSheet: "adventurer" },
      { op: "selfSwitch", key: "A", value: true },
    ]);
    const session = createSession(p);
    const played = pump(session, startSession(p, session));
    expect(played.sw.playerAppearance).toMatchObject({
      defaultCombatSheet: "heroineblack",
      combatSheet: "adventurer",
    });

    const encoded = encodeEnvelope(createSessionSnapshot(session, played, 0), session.content);
    const restored = restoreSessionEnvelope(session, encoded);
    expect(restored.sw.playerAppearance).toEqual(played.sw.playerAppearance);
    expect(restored.sw.playerAppearance).toMatchObject({
      defaultCombatSheet: "heroineblack",
      combatSheet: "adventurer",
    });
  });

  test("one AttractController rewinds a RANDOM draw and repeats its name and scene RNG", () => {
    const p = project([{
      op: "scene",
      id: NAME_INPUT_SCENE_ID,
      args: {
        variable: "picked-name",
        randomNames: ["Ada", "Bea", "Cleo", "Dara"],
      },
    }]);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 4 / 60,
      scenes: { [NAME_INPUT_SCENE_ID]: nameInputRules },
    });
    for (let i = 0; i < 8 && controller.state.scene === null; i++) controller.step(0);
    expect(controller.state.scene?.kind).toBe("scene");
    const nameState = (): NameInputState => {
      if (controller.state.scene?.kind !== "scene") throw new Error("name scene not open");
      return controller.state.scene.state as unknown as NameInputState;
    };
    const rngBefore = nameState().rng;

    // From cell zero, LEFT selects the trailing RANDOM cell; release and
    // CIRCLE are separate recorded reducer frames, followed by its release.
    for (const buttons of [BTN.LEFT, 0, BTN.CIRCLE, 0]) controller.step(buttons);
    const first = { name: nameState().buffer, rng: nameState().rng };
    expect(first.name).toBeTruthy();
    expect(first.rng).not.toBe(rngBefore);

    controller.step(BTN.LTRIGGER);
    expect(controller.rewound).toBe(true);
    expect(nameState()).toMatchObject({ cursor: 0, buffer: "", rng: rngBefore });

    // Replaying the identical select/confirm stream must consume only the
    // restored per-scene RNG, never hidden module-global state.
    for (const buttons of [BTN.LEFT, 0, BTN.CIRCLE, 0]) controller.step(buttons);
    expect({ name: nameState().buffer, rng: nameState().rng }).toEqual(first);
  });

  test("one AttractController really rewinds and re-folds the same NPC name and dialog", () => {
    const p = project([
      { op: "changeName", target: "this", name: "Ada" },
      { op: "text", lines: ["{char:this}: Hello."] },
    ], true);
    const controller = new AttractController(p, [], {
      hz: 60,
      attractEnabled: false,
      rewindSeconds: 1,
    });
    for (let i = 0; i < 8; i++) controller.step(0);
    const before = canonicalJson(controller.state);
    expect(controller.state.interp.modal).toMatchObject({ lines: ["Ada: Hello."] });

    controller.step(BTN.LTRIGGER);
    expect(controller.rewound).toBe(true);
    expect(controller.state.sw.eventNames).toBeUndefined();
    for (let i = 0; i < 8; i++) controller.step(0);
    expect(canonicalJson(controller.state)).toBe(before);
  });

  test("save validation rejects malformed eventNames and both combat-sheet fields", () => {
    const p = project([
      { op: "changeName", target: "this", name: "Ada" },
      { op: "selfSwitch", key: "A", value: true },
    ], true);
    const session = createSession(p);
    const played = pump(session, startSession(p, session));
    const snapshot = createSessionSnapshot(session, played, 0);

    const reject = (mutate: (sw: Record<string, any>) => void, pattern: RegExp): void => {
      const envelope = JSON.parse(encodeEnvelope(snapshot, session.content)) as any;
      mutate(envelope.state.interp.sw);
      envelope.checksum = fnv1aText(canonicalJson(envelope.state));
      expect(() => decodeEnvelopeText(JSON.stringify(envelope), session.content)).toThrow(pattern);
    };

    reject((sw) => { sw.eventNames = { npc: "Ada" }; }, /eventNames/);
    reject((sw) => { sw.eventNames = { "names/npc": "" }; }, /eventNames/);
    reject((sw) => { sw.playerAppearance = { defaultCombatSheet: 7 }; }, /defaultCombatSheet/);
    reject((sw) => { sw.playerAppearance = { combatSheet: "" }; }, /combatSheet/);
  });
});
