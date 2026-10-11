import { describe, expect, test } from "bun:test";
import {
  createSwitchState,
  evalCondition,
  type ConditionContext,
} from "../src/engine/interpreter.ts";
import type { ActorDef, Condition } from "../src/engine/types.ts";

const ACTORS: readonly ActorDef[] = [
  {
    id: "actor001",
    databaseId: 1,
    name: "Wren",
    classId: "class001",
    skills: ["skill001"],
    weapons: ["weapon001"],
    armors: ["armor001"],
    states: ["state001"],
  },
  {
    id: "actor002",
    databaseId: 2,
    name: "Moss",
    classId: "class002",
    skills: ["skill002"],
    weapons: ["weapon002"],
    armors: ["armor002"],
    states: ["state002"],
  },
];

const CONTEXT: ConditionContext = {
  worldIdle: true,
  actors: new Map(ACTORS.map((actor) => [actor.id, actor] as const)),
  playerActor: "actor001",
};

function actorCondition(
  actor: string,
  test: Extract<Condition, { kind: "actor" }>["test"],
  value: string,
): Condition {
  return { kind: "actor", actor, test, value };
}

describe("actor conditions", () => {
  test("all imported predicates distinguish matching and non-matching facts", () => {
    const state = createSwitchState();
    for (const [test, yes, no] of [
      ["class", "class002", "class001"],
      ["skill", "skill002", "skill001"],
      ["weapon", "weapon002", "weapon001"],
      ["armor", "armor002", "armor001"],
      ["state", "state002", "state001"],
    ] as const) {
      expect(evalCondition(actorCondition("actor002", test, yes), state, "map/ev", undefined, undefined, CONTEXT)).toBe(true);
      expect(evalCondition(actorCondition("actor002", test, no), state, "map/ev", undefined, undefined, CONTEXT)).toBe(false);
    }
    expect(evalCondition(actorCondition("actor999", "class", "class002"), state, "map/ev", undefined, undefined, CONTEXT)).toBe(false);
  });

  test("leader and nonleader names use their live persistent rename stores", () => {
    const state = createSwitchState({
      playerName: "Lead Rename",
      variables: { "actor002-name": "Companion Rename" },
    });
    expect(evalCondition(actorCondition("actor001", "name", "Lead Rename"), state, "map/ev", undefined, undefined, CONTEXT)).toBe(true);
    expect(evalCondition(actorCondition("actor001", "name", "Wren"), state, "map/ev", undefined, undefined, CONTEXT)).toBe(false);
    expect(evalCondition(actorCondition("actor002", "name", "Companion Rename"), state, "map/ev", undefined, undefined, CONTEXT)).toBe(true);
    expect(evalCondition(actorCondition("actor002", "name", "Moss"), state, "map/ev", undefined, undefined, CONTEXT)).toBe(false);
  });

  test("a nonleader without a rename falls back to the imported database name", () => {
    const state = createSwitchState();
    expect(evalCondition(actorCondition("actor002", "name", "Moss"), state, "map/ev", undefined, undefined, CONTEXT)).toBe(true);
  });
});
