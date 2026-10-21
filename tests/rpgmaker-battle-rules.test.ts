import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rngNext } from "../src/engine/interpreter.ts";
import type { BattleInput, BattleRules } from "../src/engine/battle.ts";
import type {
  ExtensionCommandContext,
  ExtensionCommandResult,
  ExtensionReadContext,
} from "../src/engine/extensions.ts";
import type { AnimationDef, JsonValue } from "../src/engine/types.ts";
import {
  augmentRpgMakerBattleExtensions,
  createRpgMakerBattleExtensions,
  createRpgMakerBattleRules,
  RPGMAKER_ACTOR_CHANGE_CALL,
  RPGMAKER_BATTLE_SETTING_CALL,
  RPGMAKER_ENCOUNTER_DUE_VARIABLE,
  RPGMAKER_ENCOUNTER_STEP_CALL,
  rpgMakerBattleState,
  rpgMakerCombatantParam,
  rpgMakerExpForLevel,
} from "../src/rpgmaker-battle/rules.ts";
import type { RpgMakerBattleDatabase, RpgMakerBattleState } from "../src/rpgmaker-battle/types.ts";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";

const HOLLOW = join(import.meta.dir, "fixtures/rpgmaker/hollow-mz");
const imported = await importRmProject(loadRmProject(HOLLOW));

const cloneDb = (): RpgMakerBattleDatabase => structuredClone(imported.battle);

const CONTEXT: ExtensionReadContext = {
  ext: {},
  switches: {},
  variables: {},
  items: {},
  gold: 0,
  playerName: "Wren",
  mapId: "map003",
  playerCell: { x: 10, y: 4, region: 0 },
};

function setup(db: RpgMakerBattleDatabase, extra: Record<string, JsonValue> = {}): JsonValue {
  return {
    system: "rpgmaker",
    databaseHash: db.databaseHash,
    troop: 1,
    canEscape: true,
    canLose: true,
    ...extra,
  };
}

function start(
  db: RpgMakerBattleDatabase,
  seed = 1,
  ext: JsonValue = {},
  context: ExtensionReadContext = CONTEXT,
): { rules: BattleRules; state: JsonValue; startedExt: JsonValue } {
  const rules = createRpgMakerBattleRules(db);
  const result = rules.start(ext, setup(db), seed, context);
  if (!result) throw new Error("battle unexpectedly declined");
  return { rules, state: result.state, startedExt: result.ext };
}

function fold(rules: BattleRules, state: JsonValue, edges: Partial<BattleInput> = {}, ticks = 1): JsonValue {
  return rules.step(state, { buttons: 0, ...edges }, ticks);
}

function confirm(rules: BattleRules, state: JsonValue, ticks = 1): JsonValue {
  return fold(rules, state, { confirmEdge: true }, ticks);
}

function state(value: JsonValue): Readonly<RpgMakerBattleState> {
  return rpgMakerBattleState(value);
}

function mutable(value: JsonValue): RpgMakerBattleState {
  return structuredClone(state(value)) as RpgMakerBattleState;
}

function json(value: RpgMakerBattleState): JsonValue {
  return value as unknown as JsonValue;
}

function forceAction(
  rules: BattleRules,
  value: JsonValue,
  action: RpgMakerBattleState["queue"][number],
): JsonValue {
  const next = mutable(value);
  next.phase = "message";
  next.afterMessage = "nextAction";
  next.queue = [action];
  next.queueIndex = 0;
  next.message = "";
  return confirm(rules, json(next));
}

function runExtensionCommand(
  db: RpgMakerBattleDatabase,
  call: string,
  args: JsonValue,
  context: Partial<ExtensionCommandContext> = {},
): ExtensionCommandResult {
  const handler = createRpgMakerBattleExtensions(db).commands?.[call];
  if (!handler) throw new Error(`missing extension command ${call}`);
  const result = handler({ ...CONTEXT, random: () => 0, ...context }, args);
  if (!result) throw new Error(`extension command ${call} returned no result`);
  return result;
}

describe("RPG Maker battle rules", () => {
  test("renders combat narration entirely from imported localized terms", () => {
    const db = cloneDb();
    db.actors[0]!.name = "守护者";
    db.enemies[0]!.name = "石像";
    db.skills[0]!.name = "重击";
    db.skills[0]!.damage.critical = false;
    db.skills[0]!.damage.variance = 0;
    Object.assign(db.terms.messages, {
      emerge: "%1现身！",
      useItem: "%1施放%2！",
      enemyDamage: "%1受到%2点伤害！",
      enemyNoDamage: "%1没有受到伤害！",
      actionFailure: "%1没有受到影响！",
    });
    const { rules } = start(db, 7);
    let current = rules.start({}, setup(db), 7, CONTEXT)!.state;
    expect(state(current).message).toBe("石像现身！");
    current = confirm(rules, current); // party
    current = confirm(rules, current); // command
    current = confirm(rules, current); // attack / prepared turn
    for (let guard = 0; guard < 8 && !state(current).message.includes("施放"); guard++) {
      current = confirm(rules, current);
    }
    expect(state(current).message).toContain("守护者施放重击！");
    expect(state(current).message).toMatch(/石像(受到[0-9]+点伤害|没有受到伤害)！/);
    expect(state(current).message).not.toMatch(/used|took|appeared|Critical/i);
  });

  test("wins a front-view battle, awards drops/gold/EXP, levels up, and persists namespaced state", () => {
    const db = cloneDb();
    db.skills.push({ ...structuredClone(db.skills[0]!), id: 2, name: "Second Wind" });
    db.classes[0]!.learnings.push({ level: 2, skillId: 2 });
    db.enemies[0]!.params[0] = 1;
    db.enemies[0]!.exp = 200;
    db.enemies[0]!.gold = 37;
    db.enemies[0]!.drops = [{ kind: 1, dataId: 1, denominator: 1, item: "item001" }];
    const originalExt = { otherGame: { untouched: true } };
    const { rules, startedExt } = start(db, 0x12345678, originalExt);
    let current = rules.start(originalExt, setup(db), 0x12345678, CONTEXT)!.state;

    expect((startedExt as Record<string, any>).rpgmakerBattle.battleCount).toBe(1);
    expect((startedExt as Record<string, any>).otherGame).toEqual({ untouched: true });
    expect(state(current).phase).toBe("message");
    current = confirm(rules, current); // intro -> party
    current = confirm(rules, current); // Fight -> actor command
    current = confirm(rules, current); // Attack -> victory rewards
    expect(state(current)).toMatchObject({
      phase: "message",
      afterMessage: "win",
      reward: { exp: 200, gold: 37, items: { item001: 1 } },
    });
    expect(state(current).actors[0]!.actor!.level).toBeGreaterThan(1);
    expect(state(current).actors[0]!.actor!.skills).toContain(2);
    current = confirm(rules, current);

    const completion = rules.done(current)!;
    expect(completion.result).toBe("win");
    expect(completion.gold).toBe(37);
    expect(completion.items).toEqual({ item001: 1 });
    const root = completion.ext as Record<string, any>;
    expect(root.otherGame).toEqual({ untouched: true });
    expect(root.rpgmakerBattle).toMatchObject({ battleCount: 1, winCount: 1, escapeCount: 0 });
    expect(root.rpgmakerBattle.actors["1"].level).toBeGreaterThan(1);
    expect(root.rpgmakerBattle.actors["1"].skills).toContain(2);
  });

  test("an allowed defeat returns lose and revives battle members to one HP", () => {
    const db = cloneDb();
    db.enemies[0]!.params = [999, 0, 999, 12, 8, 8, 1, 6];
    const ext = {
      rpgmakerBattle: {
        version: 1,
        actors: {
          "1": { actorId: 1, classId: 1, level: 1, exp: 0, hp: 1, mp: 10, tp: 0, skills: [1], states: [], buffs: [] },
        },
        battleCount: 0,
        winCount: 0,
        escapeCount: 0,
        encounter: null,
      },
    };
    const { rules } = start(db, 99, ext);
    let current = rules.start(ext, setup(db), 99, CONTEXT)!.state;
    current = confirm(rules, current); // intro
    current = confirm(rules, current); // fight
    current = fold(rules, current, { downEdge: true }); // Guard
    current = confirm(rules, current);
    // Guard message, then enemy action/defeat. Keep confirming until terminal.
    for (let i = 0; i < 6 && state(current).phase !== "done"; i++) current = confirm(rules, current);
    const completion = rules.done(current)!;

    expect(completion.result).toBe("lose");
    expect((completion.ext as Record<string, any>).rpgmakerBattle.actors["1"].hp).toBe(1);
    expect((completion.ext as Record<string, any>).rpgmakerBattle.actors["1"].states).toEqual([]);
    expect((completion.ext as Record<string, any>).rpgmakerBattle.winCount).toBe(0);
  });

  test("uses current party switches and projects initial equipment into battlers", () => {
    const db = cloneDb();
    const initial = state(start(db).state);
    expect(initial.actors.map((actor) => actor.name)).toEqual(["Wren"]);
    expect(rpgMakerCombatantParam(db, initial.actors[0]!, 2)).toBe(26);
    expect(rpgMakerCombatantParam(db, initial.actors[0]!, 3)).toBe(21);

    const swapped = state(start(db, 1, {}, {
      ...CONTEXT,
      switches: { "party-out-actor001": true, "party-actor002": true },
    }).state);
    expect(swapped.actors.map((actor) => actor.name)).toEqual(["Moss"]);
    expect(rpgMakerCombatantParam(db, swapped.actors[0]!, 2)).toBe(32);
  });

  test("actor-change extensions mutate every selector form and preserve progression metadata", () => {
    const db = cloneDb();
    db.party = [1, 2];
    db.states.push({
      id: 99, name: "Poison", restriction: 0, priority: 50,
      minTurns: 2, maxTurns: 2, autoRemovalTiming: 0,
      removeAtBattleEnd: false, removeByDamage: false, chanceByDamage: 0,
      messages: ["", "", "", ""], traits: [],
    });
    db.skills.push({ ...structuredClone(db.skills[0]!), id: 2, name: "Second Wind" });
    db.classes[0]!.learnings.push({ level: 2, skillId: 2 });
    db.classes.push({ ...structuredClone(db.classes[0]!), id: 2, name: "Wayfarer" });

    let ext: JsonValue = {};
    let items: Record<string, number> = { weapon002: 1 };
    const invoke = (args: JsonValue, extra: Partial<ExtensionCommandContext> = {}) => {
      const result = runExtensionCommand(db, RPGMAKER_ACTOR_CHANGE_CALL, args, {
        ext,
        items,
        variables: { selectedActor: 2, amount: 7 },
        ...extra,
      });
      ext = result.ext ?? ext;
      if (result.items) items = { ...items, ...result.items };
      return result;
    };

    invoke({
      kind: "hp", target: { kind: "all" }, operation: "sub",
      operand: { kind: "constant", value: 99999 }, allowDeath: false,
    });
    let actors = (ext as Record<string, any>).rpgmakerBattle.actors;
    expect(actors["1"].hp).toBe(1);
    expect(actors["2"].hp).toBe(1);

    invoke({ kind: "state", target: { kind: "all" }, operation: "add", stateId: 99 });
    actors = (ext as Record<string, any>).rpgmakerBattle.actors;
    expect(actors["1"].states).toEqual([{ id: 99, turns: 2 }]);
    expect(actors["2"].states).toEqual([{ id: 99, turns: 2 }]);
    invoke({
      kind: "state", target: { kind: "variable", id: "selectedActor" },
      operation: "remove", stateId: 99,
    });
    actors = (ext as Record<string, any>).rpgmakerBattle.actors;
    expect(actors["1"].states).toHaveLength(1);
    expect(actors["2"].states).toEqual([]);
    invoke({ kind: "recoverAll", target: { kind: "all" } });

    invoke({
      kind: "mp", target: { kind: "variable", id: "selectedActor" }, operation: "sub",
      operand: { kind: "variable", id: "amount" },
    });
    invoke({
      kind: "tp", target: { kind: "all" }, operation: "add",
      operand: { kind: "constant", value: 20 },
    });
    invoke({
      kind: "exp", target: { kind: "actor", id: 1 }, operation: "add",
      operand: { kind: "constant", value: rpgMakerExpForLevel(db, 1, 2) }, show: true,
    });
    invoke({
      kind: "level", target: { kind: "actor", id: 2 }, operation: "add",
      operand: { kind: "constant", value: 1 }, show: true,
    });
    invoke({
      kind: "parameter", target: { kind: "actor", id: 1 }, paramId: 2, operation: "add",
      operand: { kind: "constant", value: 5 },
    });
    invoke({ kind: "skill", target: { kind: "actor", id: 2 }, operation: "remove", skillId: 2 });
    const equipment = invoke({ kind: "equipment", actorId: 1, slotId: 0, itemId: 2 });
    expect(equipment.items).toEqual({ weapon001: 1, weapon002: 0 });
    invoke({ kind: "class", actorId: 1, classId: 2, keepExp: true });
    invoke({
      kind: "images", actorId: 1, characterName: "Hero2", characterIndex: 3,
      faceName: "Face2", faceIndex: 4, battlerName: "Battler2",
    });
    invoke({ kind: "nickname", actorId: 1, value: "Sparrow" });
    invoke({ kind: "profile", actorId: 1, value: "Keeps walking." });

    actors = (ext as Record<string, any>).rpgmakerBattle.actors;
    expect(actors["1"]).toMatchObject({
      classId: 2,
      level: 2,
      skills: [1, 2],
      paramPlus: [0, 0, 5, 0, 0, 0, 0, 0],
      equips: [{ kind: "weapon", id: 2 }, null, null, { kind: "armor", id: 1 }, null],
      nickname: "Sparrow",
      profile: "Keeps walking.",
      characterName: "Hero2",
      characterIndex: 3,
      faceName: "Face2",
      faceIndex: 4,
      battlerName: "Battler2",
    });
    expect(actors["1"].classExp["2"]).toBe(actors["1"].exp);
    expect(actors["2"]).toMatchObject({ level: 2, mp: 59, tp: 20, skills: [1] });

    const restored = JSON.parse(JSON.stringify(ext)) as JsonValue;
    const battle = state(start(db, 5, restored, { ...CONTEXT, items }).state);
    expect(battle.actors.map((actor) => actor.actor?.level)).toEqual([2, 2]);
    expect(battle.actors[0]!.actor!.equips?.[0]).toEqual({ kind: "weapon", id: 2 });
    expect(rpgMakerCombatantParam(db, battle.actors[0]!, 2)).toBe(39);
    expect(battle.actors[1]!.mp).toBe(59);
  });

  test("troop enemy effects appear, transform, recover, animate, and force the authored target", () => {
    const db = cloneDb();
    db.party = [1, 2];
    db.states.push({
      id: 99, name: "Poison", restriction: 0, priority: 50,
      minTurns: 2, maxTurns: 2, autoRemovalTiming: 0,
      removeAtBattleEnd: false, removeByDamage: false, chanceByDamage: 0,
      messages: ["", "", "", ""], traits: [],
    });
    db.enemies[0]!.params[1] = 30;
    db.enemies.push({
      ...structuredClone(db.enemies[0]!),
      id: 99,
      name: "Crystal Golem",
      params: [80, 50, 50, 10, 8, 8, 20, 6],
      image: "sprites/crystal-golem.png",
    });
    db.skills[0]!.hitType = 0;
    db.skills[0]!.damage.critical = false;
    db.skills[0]!.damage.variance = 0;
    db.troops[0]!.members.push({ enemyId: 1, x: 320, y: 160, hidden: true });
    db.troops[0]!.pages = [{
      span: 0,
      condition: { turn: { a: 0, b: 0 } },
      unsupported: 0,
      effects: [
        { kind: "enemyHp", index: 0, operation: "sub", operand: { kind: "constant", value: 10 }, allowDeath: false },
        { kind: "enemyMp", index: 0, operation: "sub", operand: { kind: "constant", value: 5 } },
        { kind: "enemyTp", index: 0, operation: "add", operand: { kind: "constant", value: 100 } },
        { kind: "enemyState", index: 0, operation: "add", stateId: 99 },
        { kind: "enemyAppear", index: 1 },
        { kind: "enemyTransform", index: 1, enemyId: 99 },
        { kind: "enemyHp", index: 1, operation: "sub", operand: { kind: "constant", value: 15 }, allowDeath: true },
        { kind: "enemyMp", index: 1, operation: "sub", operand: { kind: "constant", value: 12 } },
        { kind: "enemyState", index: 1, operation: "add", stateId: 99 },
        { kind: "enemyRecoverAll", index: 1 },
        { kind: "battleAnimation", index: -1, animationId: 4, entireTroop: true, animation: "anim004" },
        { kind: "forceAction", side: "enemy", subject: 1, skillId: 1, target: 1 },
      ],
    }];

    const started = state(start(db, 0x10203040).state);
    expect(started.enemies[0]).toMatchObject({ hp: 110, mp: 25, tp: 100, states: [{ id: 99, turns: 2 }] });
    expect(started.enemies[1]).toMatchObject({
      databaseId: 99,
      name: "Crystal Golem",
      hp: 80,
      mp: 50,
      hidden: false,
      states: [],
      image: "sprites/crystal-golem.png",
      lastTargetIndex: 1,
    });
    expect(started.battleAnimation).toEqual({
      id: "anim004", targets: [0, 1], targetSide: "enemy", startTick: 0,
    });
    expect(started.actors[0]!.hp).toBe(rpgMakerCombatantParam(db, started.actors[0]!, 0));
    expect(started.actors[1]!.hp).toBeLessThan(rpgMakerCombatantParam(db, started.actors[1]!, 0));
  });

  test("turn-one Force Action replaces the subject's queued ordinary action", () => {
    const db = cloneDb();
    Object.assign(db.skills[0]!, {
      hitType: 0 as const,
      successRate: 100,
      repeats: 1,
      damage: {
        ...db.skills[0]!.damage,
        type: 1,
        critical: false,
        variance: 0,
        source: "10",
        formula: { kind: "number", value: 10 },
      },
      effects: [],
    });
    db.troops[0]!.pages = [{
      span: 1,
      condition: { turn: { a: 1, b: 0 } },
      effects: [{ kind: "forceAction", side: "enemy", subject: 0, skillId: 1, target: 0 }],
      unsupported: 0,
    }];
    const rules = createRpgMakerBattleRules(db);
    let current = rules.start({}, setup(db), 41, CONTEXT)!.state;
    const fullHp = state(current).actors[0]!.hp;
    current = confirm(rules, current); // intro -> party
    current = confirm(rules, current); // Fight -> command
    current = fold(rules, current, { downEdge: true }); // Guard
    current = confirm(rules, current); // prepare turn one + page Force Action

    const forced = state(current);
    expect(forced.turn).toBe(1);
    expect(forced.actors[0]!.hp).toBe(fullHp - 10);
    expect(forced.queue.slice(forced.queueIndex).filter((action) =>
      action.side === "enemy" && action.user === 0)).toEqual([]);
    expect(forced.message.match(/uses Attack/g)).toHaveLength(1);
  });

  test("an invalid forced skill still clears the subject's queued action", () => {
    const db = cloneDb();
    db.classes[0]!.params[6]![0] = 999;
    db.classes[0]!.params[6]![1] = 999;
    db.enemies[0]!.params[6] = 1;
    db.troops[0]!.pages = [{
      span: 1,
      condition: { turn: { a: 1, b: 0 } },
      effects: [{ kind: "forceAction", side: "enemy", subject: 0, skillId: 999, target: 0 }],
      unsupported: 0,
    }];
    const rules = createRpgMakerBattleRules(db);
    let current = rules.start({}, setup(db), 45, CONTEXT)!.state;
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = fold(rules, current, { downEdge: true });
    current = confirm(rules, current);
    const forced = state(current);
    expect(forced.message).toContain(db.terms.guard);
    expect(forced.queue.slice(forced.queueIndex).filter((action) =>
      action.side === "enemy" && action.user === 0)).toEqual([]);
  });

  test("enemy Transform rebuilds its pending action from the new enemy definition", () => {
    const db = cloneDb();
    const fixed = (id: number, name: string, value: number) => ({
      ...structuredClone(db.skills[0]!),
      id,
      name,
      hitType: 0 as const,
      successRate: 100,
      repeats: 1,
      damage: {
        ...db.skills[0]!.damage,
        type: 1 as const,
        critical: false,
        variance: 0,
        source: String(value),
        formula: { kind: "number" as const, value },
      },
      effects: [],
    });
    db.skills[0] = fixed(1, "Old Blow", 10);
    db.skills.push(fixed(2, "Crystal Blow", 30));
    db.enemies.push({
      ...structuredClone(db.enemies[0]!),
      id: 99,
      name: "Crystal Golem",
      actions: [{ skillId: 2, rating: 5, conditionType: 0, conditionParam1: 0, conditionParam2: 0 }],
    });
    db.troops[0]!.pages = [{
      span: 1,
      condition: { turn: { a: 1, b: 0 } },
      effects: [{ kind: "enemyTransform", index: 0, enemyId: 99 }],
      unsupported: 0,
    }];
    const rules = createRpgMakerBattleRules(db);
    let current = rules.start({}, setup(db), 42, CONTEXT)!.state;
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = fold(rules, current, { downEdge: true });
    current = confirm(rules, current);

    const transformed = state(current);
    expect(transformed.enemies[0]!.databaseId).toBe(99);
    expect(transformed.queue.filter((action) => action.side === "enemy" && action.user === 0))
      .toEqual([expect.objectContaining({ id: 2 })]);
    expect(transformed.queue.some((action) => action.side === "enemy" && action.id === 1)).toBe(false);
    let expectedRng = 42;
    for (let drawIndex = 0; drawIndex < 6; drawIndex++) expectedRng = rngNext(expectedRng).next;
    expect(transformed.rng).toBe(expectedRng);
  });

  test("stock smooth-target retargets an explicit dead forced opponent", () => {
    const db = cloneDb();
    db.party = [1, 2];
    Object.assign(db.skills[0]!, {
      hitType: 0,
      successRate: 100,
      repeats: 1,
      damage: {
        ...db.skills[0]!.damage,
        type: 1,
        critical: false,
        variance: 0,
        source: "10",
        formula: { kind: "number", value: 10 },
      },
      effects: [],
    });
    db.troops[0]!.pages = [{
      span: 0,
      condition: { turn: { a: 0, b: 0 } },
      effects: [{ kind: "forceAction", side: "enemy", subject: 0, skillId: 1, target: 1 }],
      unsupported: 0,
    }];
    const ext = {
      rpgmakerBattle: {
        version: 1,
        actors: {
          "2": { actorId: 2, classId: 1, level: 1, exp: 0, hp: 0, mp: 0, tp: 0, skills: [1], states: [{ id: 1, turns: 1 }], buffs: [] },
        },
      },
    } as unknown as JsonValue;
    const started = state(start(db, 43, ext).state);
    expect(started.actors[1]!.hp).toBe(0);
    expect(started.actors[0]!.hp).toBe(rpgMakerCombatantParam(db, started.actors[0]!, 0) - 10);
    expect(started.enemies[0]!.lastTargetIndex).toBe(0);
  });

  test("kit deliberately retargets an explicit hidden-but-living opponent unlike stock", () => {
    const db = cloneDb();
    db.troops[0]!.members.push({ enemyId: 1, x: 320, y: 160, hidden: true });
    Object.assign(db.skills[0]!, {
      hitType: 0,
      successRate: 100,
      repeats: 1,
      damage: {
        ...db.skills[0]!.damage,
        type: 1,
        critical: false,
        variance: 0,
        source: "10",
        formula: { kind: "number", value: 10 },
      },
      effects: [],
    });
    const { rules, state: opened } = start(db, 44);
    const before = state(opened);
    expect(before.enemies[1]!.hp).toBeGreaterThan(0);
    expect(before.enemies[1]!.hidden).toBe(true);
    const firstHp = before.enemies[0]!.hp;
    const hiddenHp = before.enemies[1]!.hp;
    const acted = forceAction(rules, opened, {
      side: "actor", user: 0, kind: "skill", id: 1, target: 1, speed: 0,
    });

    expect(state(acted).enemies[0]!.hp).toBe(firstHp - 10);
    expect(state(acted).enemies[1]!.hp).toBe(hiddenHp);
    expect(state(acted).actors[0]!.lastTargetIndex).toBe(0);
  });

  test("state removal uses message4 for actors and scope-zero actions have no target", () => {
    const db = cloneDb();
    db.states[1]!.messages = [" actor added", " enemy added", " persists", " fades"];
    db.states.push({
      id: 99, name: "Confused", restriction: 1, priority: 50,
      minTurns: 2, maxTurns: 2, autoRemovalTiming: 0,
      removeAtBattleEnd: false, removeByDamage: false, chanceByDamage: 0,
      messages: ["", "", "", ""], traits: [],
    });
    const blank = structuredClone(db.items[0]!.damage);
    db.skills.push({
      ...structuredClone(db.skills[0]!),
      id: 2,
      name: "Cleanse",
      scope: 1,
      hitType: 0,
      damage: { ...blank, type: 0, critical: false, variance: 0 },
      effects: [{ code: 22, dataId: 3, value1: 1, value2: 0 }],
    }, {
      ...structuredClone(db.skills[0]!),
      id: 3,
      name: "Nobody",
      scope: 0,
      mpCost: 5,
      hitType: 0,
      damage: {
        ...blank,
        type: 1,
        critical: false,
        variance: 0,
        source: "999",
        formula: { kind: "number", value: 999 },
      },
      effects: [],
    });
    const rules = createRpgMakerBattleRules(db);
    const begun = mutable(rules.start({}, setup(db), 44, CONTEXT)!.state);
    begun.actors[0]!.states = [{ id: 3, turns: 2 }];
    let current = forceAction(rules, json(begun), {
      side: "enemy", user: 0, kind: "skill", id: 2, target: 0, speed: 0, forced: true,
    });
    expect(state(current).message).toContain(`${begun.actors[0]!.name} fades`);
    expect(state(current).message).not.toContain("persists");

    const before = state(current).enemies[0]!.hp;
    const mpBefore = state(current).actors[0]!.mp;
    const targetBefore = state(current).actors[0]!.lastTargetIndex;
    current = forceAction(rules, current, {
      side: "actor", user: 0, kind: "skill", id: 3, target: -1, speed: 0,
    });
    expect(state(current).enemies[0]!.hp).toBe(before);
    expect(state(current).actors[0]!.mp).toBe(mpBefore - 5);
    expect(state(current).actors[0]!.lastTargetIndex).toBe(targetBefore);
    expect(state(current).message).toContain("uses Nobody");
    expect(state(current).message).not.toContain("There was no effect");

    const confused = mutable(current);
    confused.actors[0]!.states = [{ id: 99, turns: 2 }];
    current = forceAction(rules, json(confused), {
      side: "actor", user: 0, kind: "skill", id: 3, target: -1, speed: 0,
    });
    expect(state(current).enemies[0]!.hp).toBeLessThan(before);
  });

  test("Abort Battle ends as escape even when ordinary escape is disabled", () => {
    const db = cloneDb();
    db.troops[0]!.pages = [{
      span: 0,
      condition: { turn: { a: 0, b: 0 } },
      effects: [{ kind: "abort" }],
      unsupported: 0,
    }];
    const rules = createRpgMakerBattleRules(db);
    const started = rules.start({}, setup(db, { canEscape: false }), 1, CONTEXT)!;
    expect(state(started.state)).toMatchObject({ phase: "done", result: "escape", canEscape: false });
    expect(rules.done(started.state)?.result).toBe("escape");
  });

  test("battle settings persist globally while battlebacks last one map visit", () => {
    const db = cloneDb();
    db.settings = {
      battleBgm: { name: "Default", volume: 90, pitch: 100, pan: 0 },
      encounterDisabled: false,
    };
    db.mapSettings = [
      { map: "map001", battleback1Name: "Field", battleback2Name: "Clouds" },
      { map: "map003", battleback1Name: "Cave", battleback2Name: "Rock" },
    ];
    let ext: JsonValue = {};
    let variables: Record<string, string | number> = {};
    const invoke = (args: JsonValue, mapId = "map003") => {
      const result = runExtensionCommand(db, RPGMAKER_BATTLE_SETTING_CALL, args, { ext, mapId, variables });
      ext = result.ext ?? ext;
      variables = { ...variables, ...result.writes };
      return result;
    };
    invoke({
      kind: "battleBgm",
      audio: { name: "Boss", volume: 80, pitch: 105, pan: -5, id: "bgm-boss" },
    });
    const battleback = invoke({ kind: "battleback", battleback1Name: "Lava", battleback2Name: "Smoke" });
    expect(battleback.writes).toEqual({
      "local.rpgmaker.battleback1": "Lava",
      "local.rpgmaker.battleback2": "Smoke",
    });
    const encounter = invoke({ kind: "encounter", disabled: true });
    expect(encounter.writes).toEqual({ [RPGMAKER_ENCOUNTER_DUE_VARIABLE]: 0 });

    const restored = JSON.parse(JSON.stringify(ext)) as JsonValue;
    const cave = state(start(db, 1, restored, { ...CONTEXT, mapId: "map003", variables }).state);
    expect(cave.settings).toMatchObject({
      battleBgm: { name: "Boss", volume: 80, pitch: 105, pan: -5, id: "bgm-boss" },
      battleback1Name: "Lava",
      battleback2Name: "Smoke",
      encounterDisabled: true,
    });
    // Session.enterMap clears local.* even when transferring back to the same
    // map, so a fresh visit observes the authored battleback again.
    const revisited = state(start(db, 1, restored, {
      ...CONTEXT, mapId: "map003", variables: {},
    }).state);
    expect(revisited.settings).toMatchObject({ battleback1Name: "Cave", battleback2Name: "Rock" });
    const field = state(start(db, 1, restored, {
      ...CONTEXT, mapId: "map001", variables: {},
    }).state);
    expect(field.settings).toMatchObject({ battleback1Name: "Field", battleback2Name: "Clouds" });
    const step = runExtensionCommand(db, RPGMAKER_ENCOUNTER_STEP_CALL, null, {
      ext: restored,
      mapId: "map003",
      playerStep: { dx: 1, dy: 0, kind: "step" },
    });
    expect(step.writes).toEqual({ [RPGMAKER_ENCOUNTER_DUE_VARIABLE]: 0 });
  });

  test("battle-event presentation settings persist without repainting the current battle", () => {
    const db = cloneDb();
    db.mapSettings = [{
      map: "map003", specified: true, battleback1Name: "Cave", battleback2Name: "Rock",
    }];
    db.settings = {
      battleBgm: { name: "Old Battle", id: "bgm-old", volume: 90, pitch: 100, pan: 0 },
      victoryMe: { name: "Old Victory", id: "me-old", volume: 90, pitch: 100, pan: 0, durationTicks: 60 },
    };
    db.troops[0]!.pages = [{
      span: 0,
      condition: { turn: { a: 0, b: 0 } },
      effects: [
        { kind: "battleBgm", audio: { name: "Next Battle", id: "bgm-next", volume: 75, pitch: 104, pan: -5 } },
        { kind: "victoryMe", audio: { name: "New Victory", id: "me-new", volume: 82, pitch: 108, pan: 7, durationTicks: 72 } },
        { kind: "defeatMe", audio: { name: "New Defeat", id: "me-lose", volume: 70, pitch: 96, pan: -8, durationTicks: 80 } },
        { kind: "battleback", battleback1Name: "Lava", battleback2Name: "Smoke" },
        {
          kind: "images", actorId: 1, characterName: "Hero2", characterIndex: 3,
          faceName: "WrenFaces", faceIndex: 5, battlerName: "WrenBattlerAlt",
        },
      ],
      unsupported: 0,
    }];

    const rules = createRpgMakerBattleRules(db);
    const started = rules.start({}, setup(db), 1, CONTEXT)!;
    const current = state(started.state);
    expect(current.settings).toMatchObject({
      battleBgm: { id: "bgm-old" },
      victoryMe: { id: "me-new", durationTicks: 72 },
      defeatMe: { id: "me-lose", durationTicks: 80 },
      battleback1Name: "Cave",
      battleback2Name: "Rock",
    });
    expect(rules.audio?.(started.state)).toEqual({
      bgm: { id: "bgm-old", volume: 90, pitch: 100, pan: 0 },
    });
    expect(current.actors[0]!.actor).toMatchObject({
      faceName: "WrenFaces", faceIndex: 5, battlerName: "WrenBattlerAlt",
    });

    const terminal = mutable(started.state);
    terminal.phase = "done";
    terminal.result = "win";
    const completion = rules.done(json(terminal))!;
    expect(completion.audio).toMatchObject({ cue: { id: "me-new", durationTicks: 72 } });
    expect(completion.writes).toEqual({
      "local.rpgmaker.battleback1": "Lava",
      "local.rpgmaker.battleback2": "Smoke",
    });
    expect(completion.ext).toMatchObject({
      rpgmakerBattle: {
        settings: {
          battleBgm: { id: "bgm-next" },
          victoryMe: { id: "me-new" },
          defeatMe: { id: "me-lose" },
        },
        actors: {
          "1": { characterName: "Hero2", characterIndex: 3, faceName: "WrenFaces", faceIndex: 5 },
        },
      },
    });

    const nextContext = {
      ...CONTEXT,
      variables: { ...CONTEXT.variables, ...completion.writes },
    };
    const next = state(rules.start(completion.ext, setup(db), 2, nextContext)!.state);
    expect(next.settings).toMatchObject({
      battleBgm: { id: "bgm-next" }, battleback1Name: "Lava", battleback2Name: "Smoke",
    });
    const reentered = state(rules.start(completion.ext, setup(db), 3, { ...CONTEXT, variables: {} })!.state);
    expect(reentered.settings).toMatchObject({ battleback1Name: "Cave", battleback2Name: "Rock" });
  });

  test("battle BGM projects with pan and result ME selects the stock restore policy", () => {
    const db = cloneDb();
    db.settings = {
      battleBgm: { name: "Battle", id: "bgm-battle", volume: 81, pitch: 104, pan: -17 },
      victoryMe: { name: "Victory", id: "me-victory", volume: 90, pitch: 110, pan: 8, durationTicks: 75 },
      defeatMe: { name: "Defeat", id: "me-defeat", volume: 70, pitch: 95, pan: -3, durationTicks: 90 },
    };
    const rules = createRpgMakerBattleRules(db);
    const started = rules.start({}, setup(db), 1, CONTEXT)!;
    expect(started.audio).toEqual({
      bgm: { id: "bgm-battle", volume: 81, pitch: 104, pan: -17 },
    });
    expect(rules.audio?.(started.state)).toEqual(started.audio);

    const finished = (result: "win" | "lose" | "escape", canLose: boolean) => {
      const next = mutable(started.state);
      next.phase = "done";
      next.result = result;
      next.canLose = canLose;
      return rules.done(json(next))!;
    };
    expect(finished("win", false).audio).toEqual({
      cue: { id: "me-victory", volume: 90, pitch: 110, pan: 8, durationTicks: 75 },
    });
    expect(finished("lose", true).audio).toEqual({
      cue: { id: "me-defeat", volume: 70, pitch: 95, pan: -3, durationTicks: 90 },
    });
    expect(finished("lose", false).audio).toEqual({
      restore: "none",
      cue: { id: "me-defeat", volume: 70, pitch: 95, pan: -3, durationTicks: 90 },
    });
    expect(finished("escape", true).audio).toBeUndefined();

    db.settings = { battleBgm: { name: "", volume: 90, pitch: 100, pan: 0 } };
    expect(createRpgMakerBattleRules(db).start({}, setup(db), 2, CONTEXT)?.audio).toEqual({ bgm: null });
  });

  test("battle start resolves explicit empty, terrain, and vehicle battlebacks", () => {
    const db = cloneDb();
    db.mapSettings = [
      {
        map: "map001", specified: false, overworld: true, width: 10,
        battleback1Name: "", battleback2Name: "", autotileKinds: [[32, 34]],
      },
      {
        map: "map003", specified: true, overworld: false, width: 20,
        battleback1Name: "", battleback2Name: "",
      },
    ];

    const empty = state(start(db, 1, {}, { ...CONTEXT, mapId: "map003" }).state);
    expect(empty.settings).toMatchObject({ battleback1Name: "", battleback2Name: "" });
    const terrain = state(start(db, 1, {}, {
      ...CONTEXT,
      mapId: "map001",
      playerCell: { x: 2, y: 3, region: 0 },
      vehicle: null,
    }).state);
    expect(terrain.settings).toMatchObject({ battleback1Name: "Lava1", battleback2Name: "Lava" });
    const vehicle = state(start(db, 1, {}, {
      ...CONTEXT,
      mapId: "map001",
      playerCell: { x: 2, y: 3, region: 0 },
      vehicle: "boat",
    }).state);
    expect(vehicle.settings).toMatchObject({ battleback1Name: "Ship", battleback2Name: "Ship" });
  });

  test("skill, item, and current-weapon animations publish deterministic target markers", () => {
    const db = cloneDb();
    const rules = createRpgMakerBattleRules(db);

    db.skills[0]!.animationId = 1;
    db.skills[0]!.animation = "anim-skill";
    let current = rules.start({}, setup(db), 7, CONTEXT)!.state;
    current = forceAction(rules, current, {
      side: "actor", user: 0, kind: "skill", id: 1, target: 0, speed: 0,
    });
    expect(state(current).battleAnimation).toEqual({
      id: "anim-skill", targets: [0], targetSide: "enemy", startTick: 1,
    });

    db.items[0]!.animationId = 1;
    db.items[0]!.animation = "anim-item";
    current = rules.start({}, setup(db), 8, { ...CONTEXT, items: { item001: 1 } })!.state;
    current = forceAction(rules, current, {
      side: "actor", user: 0, kind: "item", id: 1, target: 0, speed: 0,
    });
    expect(state(current).battleAnimation).toEqual({
      id: "anim-item", targets: [0], targetSide: "actor", mirror: true, startTick: 1,
    });

    db.skills[0]!.animationId = -1;
    delete db.skills[0]!.animation;
    db.weapons![0]!.animationId = 1;
    db.weapons![0]!.animation = "anim-weapon";
    current = rules.start({}, setup(db), 9, CONTEXT)!.state;
    current = forceAction(rules, current, {
      side: "actor", user: 0, kind: "skill", id: 1, target: 0, speed: 0,
    });
    expect(state(current).battleAnimation).toEqual({
      id: "anim-weapon", targets: [0], targetSide: "enemy", startTick: 1,
    });
  });

  test("encounter disable freezes the counter and every toggle reseeds it", () => {
    const db = cloneDb();
    db.encounters = [{ map: "map003", step: 10, entries: [{ troopId: 1, weight: 1, regions: [] }] }];
    let ext = runExtensionCommand(db, RPGMAKER_BATTLE_SETTING_CALL, {
      kind: "encounter", disabled: true,
    }, { random: () => 0.5 }).ext!;
    const seeded = (ext as Record<string, any>).rpgmakerBattle.encounter.remaining;
    const frozen = runExtensionCommand(db, RPGMAKER_ENCOUNTER_STEP_CALL, null, {
      ext,
      random: () => { throw new Error("disabled encounters do not draw or decrement"); },
      playerStep: { dx: 1, dy: 0, kind: "step" },
    });
    expect((frozen.ext as Record<string, any>).rpgmakerBattle.encounter.remaining).toBe(seeded);

    let draws = 0;
    ext = runExtensionCommand(db, RPGMAKER_BATTLE_SETTING_CALL, {
      kind: "encounter", disabled: false,
    }, {
      ext: frozen.ext!,
      random: () => { draws++; return 0; },
    }).ext!;
    expect(draws).toBe(2);
    expect((ext as Record<string, any>).rpgmakerBattle.encounter.remaining).toBe(1);
  });

  test("bush, Encounter Half and ship rates multiply while airships freeze", () => {
    const remaining = (half: boolean, vehicle: string | null, bush: boolean): number => {
      const db = cloneDb();
      db.encounters = [{ map: "map003", step: 10, entries: [{ troopId: 1, weight: 1, regions: [] }] }];
      db.actors[0]!.traits = db.actors[0]!.traits.filter((trait) => trait.code !== 64 || trait.dataId !== 0);
      if (half) db.actors[0]!.traits.push({ code: 64, dataId: 0, value: 1 });
      const seeded = {
        rpgmakerBattle: { encounter: { map: "map003", remaining: 4 } },
      } as unknown as JsonValue;
      const result = runExtensionCommand(db, RPGMAKER_ENCOUNTER_STEP_CALL, null, {
        ext: JSON.parse(JSON.stringify(seeded)),
        vehicle,
        playerCell: { x: 2, y: 3, region: 0, ...(bush ? { bush: true } : {}) },
        random: () => { throw new Error("countdown must not reset before it is due"); },
        playerStep: { dx: 1, dy: 0, kind: "step" },
      });
      return (result.ext as Record<string, any>).rpgmakerBattle.encounter.remaining;
    };

    expect([
      remaining(false, null, false),
      remaining(false, null, true),
      remaining(true, null, false),
      remaining(true, null, true),
      remaining(false, "ship", false),
      remaining(false, "ship", true),
      remaining(true, "ship", false),
      remaining(true, "ship", true),
      remaining(false, "boat", false),
      remaining(false, "boat", true),
    ]).toEqual([3, 2, 3.5, 3, 3.5, 3, 3.75, 3.5, 3, 2]);
    expect(remaining(false, "airship", false)).toBe(4);
    expect(remaining(false, "airship", true)).toBe(4);
  });

  test("Encounter Half follows the current four-member formation", () => {
    const db = cloneDb();
    const template = db.actors[0]!;
    for (const id of [3, 4, 5]) {
      db.actors.push({ ...structuredClone(template), id, name: `Actor ${id}`, traits: [] });
    }
    db.party = [1, 2, 3, 4, 5];
    for (const actor of db.actors) actor.traits = actor.id === 5
      ? [{ code: 64, dataId: 0, value: 1 }]
      : actor.traits.filter((trait) => trait.code !== 64 || trait.dataId !== 0);
    db.encounters = [{ map: "map003", step: 10, entries: [{ troopId: 1, weight: 1, regions: [] }] }];
    const seeded = { rpgmakerBattle: { encounter: { map: "map003", remaining: 2 } } } as JsonValue;
    const step = (partyOrder?: readonly number[]) => runExtensionCommand(
      db,
      RPGMAKER_ENCOUNTER_STEP_CALL,
      null,
      {
        ext: seeded,
        ...(partyOrder ? { partyOrder } : {}),
        random: () => { throw new Error("countdown must not reset before it is due"); },
        playerStep: { dx: 1, dy: 0, kind: "step" },
      },
    );

    expect((step().ext as Record<string, any>).rpgmakerBattle.encounter.remaining).toBe(1);
    expect((step([5, 1, 2, 3, 4]).ext as Record<string, any>).rpgmakerBattle.encounter.remaining).toBe(1.5);
  });

  test("confusion restrictions target opponents, either side, and friends for actors and enemies", () => {
    const db = cloneDb();
    db.states.push({
      id: 2, name: "Confusion", restriction: 3, priority: 50,
      minTurns: 2, maxTurns: 2, autoRemovalTiming: 0,
      removeAtBattleEnd: true, removeByDamage: false, chanceByDamage: 0,
      messages: ["", "", "", ""], traits: [],
    });
    const rules = createRpgMakerBattleRules(db);

    const actorCase = rules.start({}, setup(db), 11, CONTEXT)!.state;
    const actorState = mutable(actorCase);
    actorState.phase = "party";
    actorState.actors[0]!.states = [{ id: 2, turns: 2 }];
    actorState.actors[0]!.params[6] = 999;
    actorState.enemies[0]!.params[6] = 1;
    const actorHp = actorState.actors[0]!.hp;
    const enemyHp = actorState.enemies[0]!.hp;
    const afterActor = state(confirm(rules, json(actorState)));
    expect(afterActor.actors[0]!.hp).toBeLessThan(actorHp);
    expect(afterActor.enemies[0]!.hp).toBe(enemyHp);

    const enemyCase = mutable(rules.start({}, setup(db), 12, CONTEXT)!.state);
    enemyCase.phase = "party";
    enemyCase.enemies[0]!.states = [{ id: 2, turns: 2 }];
    enemyCase.enemies[0]!.params[6] = 999;
    enemyCase.actors[0]!.params[6] = 1;
    const enemySelfHp = enemyCase.enemies[0]!.hp;
    const actorBefore = enemyCase.actors[0]!.hp;
    let afterEnemy: JsonValue = confirm(rules, json(enemyCase)); // Fight
    afterEnemy = fold(rules, afterEnemy, { downEdge: true }); // Guard
    afterEnemy = confirm(rules, afterEnemy);
    expect(state(afterEnemy).enemies[0]!.hp).toBeLessThan(enemySelfHp);
    expect(state(afterEnemy).actors[0]!.hp).toBe(actorBefore);

    db.states[1]!.restriction = 2;
    const either = mutable(rules.start({}, setup(db), 13, CONTEXT)!.state);
    either.phase = "party";
    either.actors[0]!.states = [{ id: 2, turns: 2 }];
    either.actors[0]!.params[6] = 999;
    const eitherAfter = state(confirm(rules, json(either)));
    expect(eitherAfter.actors[0]!.hp < either.actors[0]!.hp || eitherAfter.enemies[0]!.hp < either.enemies[0]!.hp).toBe(true);
  });

  test("refreshes states, clears death state siblings and buffs, and revives on death-state removal", () => {
    const db = cloneDb();
    db.states.push({
      id: 2, name: "Poison", restriction: 0, priority: 50,
      minTurns: 3, maxTurns: 3, autoRemovalTiming: 0,
      removeAtBattleEnd: false, removeByDamage: false, chanceByDamage: 0,
      messages: ["", "", "", ""], traits: [],
    });
    const blank = structuredClone(db.items[0]!.damage);
    db.skills.push(
      {
        ...structuredClone(db.skills[0]!), id: 2, name: "Poison",
        hitType: 0, damage: { ...blank, variance: 0 },
        effects: [{ code: 21, dataId: 2, value1: 1, value2: 0 }],
      },
      {
        ...structuredClone(db.skills[0]!), id: 3, name: "Knockout",
        hitType: 0, damage: { ...blank, variance: 0 },
        effects: [{ code: 21, dataId: 1, value1: 1, value2: 0 }],
      },
      {
        ...structuredClone(db.skills[0]!), id: 4, name: "Revive",
        scope: 9, hitType: 0, damage: { ...blank, variance: 0 },
        effects: [{ code: 22, dataId: 1, value1: 1, value2: 0 }],
      },
    );
    db.troops[0]!.members.push({ ...db.troops[0]!.members[0]!, x: 320 });
    const rules = createRpgMakerBattleRules(db);
    const begun = mutable(rules.start({}, setup(db), 21, CONTEXT)!.state);
    begun.enemies[0]!.states = [{ id: 2, turns: 1 }];
    begun.enemies[0]!.buffs[2] = { level: 2, turns: 5 };

    let current = forceAction(rules, json(begun), {
      side: "actor", user: 0, kind: "skill", id: 2, target: 0, speed: 0,
    });
    expect(state(current).enemies[0]!.states).toContainEqual({ id: 2, turns: 3 });

    current = forceAction(rules, current, {
      side: "actor", user: 0, kind: "skill", id: 3, target: 0, speed: 0,
    });
    expect(state(current).enemies[0]!).toMatchObject({ hp: 0, states: [{ id: 1, turns: 1 }] });
    expect(state(current).enemies[0]!.buffs.every((buff) => buff.level === 0 && buff.turns === 0)).toBe(true);

    current = forceAction(rules, current, {
      side: "enemy", user: 1, kind: "skill", id: 4, target: 0, speed: 0,
    });
    expect(state(current).enemies[0]!).toMatchObject({ hp: 1, states: [] });

    db.enemies[0]!.traits.push({ code: 14, dataId: 2, value: 0 });
    const resisted = forceAction(rules, rules.start({}, setup(db), 22, CONTEXT)!.state, {
      side: "actor", user: 0, kind: "skill", id: 2, target: 0, speed: 0,
    });
    expect(state(resisted).enemies[0]!.states.some((active) => active.id === 2)).toBe(false);
  });

  test("troop pages start only the first eligible page, repeat moment spans, and skip periodic turn zero", () => {
    const db = cloneDb();
    db.troops[0]!.pages = [
      {
        span: 0,
        condition: { enemyHp: { index: 0, percent: 100 } },
        effects: [{ kind: "variable", id: "v001", op: "add", value: 1 }],
        unsupported: 0,
      },
      {
        span: 0,
        condition: { enemyHp: { index: 0, percent: 100 } },
        effects: [{ kind: "variable", id: "v002", op: "add", value: 1 }],
        unsupported: 0,
      },
    ];
    let rules = createRpgMakerBattleRules(db);
    let current = rules.start({}, setup(db), 31, CONTEXT)!.state;
    expect(state(current).variables).toMatchObject({ v001: 1 });
    expect(state(current).variables.v002).toBeUndefined();
    current = confirm(rules, current); // intro -> party
    current = confirm(rules, current); // Fight -> command
    current = confirm(rules, current); // Attack -> next first eligible page
    expect(state(current).variables.v002).toBe(1);

    db.troops[0]!.pages = [{
      span: 2,
      condition: { enemyHp: { index: 0, percent: 100 } },
      effects: [{ kind: "variable", id: "v003", op: "add", value: 1 }],
      unsupported: 0,
    }];
    rules = createRpgMakerBattleRules(db);
    current = rules.start({}, setup(db), 32, CONTEXT)!.state;
    expect(state(current).variables.v003).toBe(1);
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = confirm(rules, current);
    expect(state(current).variables.v003).toBe(3);

    db.troops[0]!.pages = [{
      span: 0,
      condition: { turn: { a: 0, b: 1 } },
      effects: [{ kind: "switch", id: "s099", value: true }],
      unsupported: 0,
    }];
    rules = createRpgMakerBattleRules(db);
    current = rules.start({}, setup(db), 33, CONTEXT)!.state;
    expect(state(current).switches.s099).toBeUndefined();
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = confirm(rules, current);
    expect(state(current).switches.s099).toBe(true);
  });

  test("a failed escape advances the troop turn before enemy actions", () => {
    const db = cloneDb();
    db.classes[0]!.params[6]![1] = 1;
    db.enemies[0]!.params[6] = 999;
    const rules = createRpgMakerBattleRules(db);
    let current = rules.start({}, setup(db), 41, CONTEXT)!.state;
    current = confirm(rules, current);
    current = fold(rules, current, { downEdge: true });
    current = confirm(rules, current);
    expect(state(current)).toMatchObject({
      phase: "message",
      afterMessage: "turnStart",
      turn: 1,
      message: "Wren has started to escape!\nHowever, it was unable to escape!",
    });
    expect(state(current).queue.some((action) => action.side === "enemy")).toBe(true);
  });

  test("escape uses the average agility of every battle member", () => {
    const db = cloneDb();
    db.classes[0]!.params[6]![1] = 20;
    db.enemies[0]!.params[6] = 20;
    const rules = createRpgMakerBattleRules(db);
    const seedFor = (lo: number, hi: number): number => {
      for (let seed = 0; seed < 100_000; seed++) {
        const value = rngNext(seed).value;
        if (value > lo && value < hi) return seed;
      }
      throw new Error("no deterministic escape seed in requested interval");
    };
    const attempt = (actors: RpgMakerBattleState["actors"], seed: number): RpgMakerBattleState => {
      const begun = mutable(rules.start({}, setup(db), 1, CONTEXT)!.state);
      begun.phase = "party";
      begun.actors = actors;
      begun.rng = seed;
      begun.menuIndex = 1;
      return state(confirm(rules, json(begun))) as RpgMakerBattleState;
    };

    const template = mutable(rules.start({}, setup(db), 1, CONTEXT)!.state).actors[0]!;
    const fourEqual = Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(template), key: `actor${index + 1}`,
    }));
    // Correct ratio is 0.5. The old sum-based ratio is clamped to 1.
    expect(attempt(fourEqual, seedFor(0.6, 0.9)).afterMessage).toBe("turnStart");

    const withKnockouts = Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(template),
      key: `actor${index + 1}`,
      hp: index === 0 ? template.hp : 0,
      params: [
        ...template.params.slice(0, 6),
        index === 0 ? 1 : 100,
        template.params[7],
      ] as RpgMakerBattleState["actors"][number]["params"],
    }));
    db.enemies[0]!.params[6] = 100;
    // Correct all-member ratio is about 0.376; filtering to the sole living
    // member would make it 0.005 and fail this draw.
    expect(attempt(withKnockouts, seedFor(0.15, 0.3)).afterMessage).toBe("escape");
  });

  test("applies recovery rate and Guard special-flag traits in the damage pipeline", () => {
    const db = cloneDb();
    const fixed = structuredClone(db.skills[0]!);
    Object.assign(fixed, {
      id: 2,
      name: "Fixed Recovery",
      scope: 7,
      hitType: 0,
      successRate: 100,
      repeats: 1,
      damage: {
        ...fixed.damage,
        type: 3,
        critical: false,
        variance: 0,
        source: "100",
        formula: { kind: "number", value: 100 },
      },
      effects: [],
    });
    db.skills.push(fixed);
    db.actors[0]!.traits.push({ code: 23, dataId: 2, value: 0.5 });
    let rules = createRpgMakerBattleRules(db);
    let begun = mutable(rules.start({}, setup(db), 71, CONTEXT)!.state);
    begun.actors[0]!.hp = 100;
    let current = forceAction(rules, json(begun), {
      side: "actor", user: 0, kind: "skill", id: 2, target: 0, speed: 0,
    });
    expect(state(current).actors[0]!.hp).toBe(150);

    const attack = db.skills[0]!;
    Object.assign(attack, {
      hitType: 0,
      successRate: 100,
      repeats: 1,
      damage: {
        ...attack.damage,
        type: 1,
        critical: false,
        variance: 0,
        source: "100",
        formula: { kind: "number", value: 100 },
      },
      effects: [],
    });
    db.classes[0]!.traits.push({ code: 62, dataId: 1, value: 1 });
    rules = createRpgMakerBattleRules(db);
    begun = mutable(rules.start({}, setup(db), 72, CONTEXT)!.state);
    begun.actors[0]!.hp = 400;
    expect(begun.actors[0]!.guarding).toBe(false);
    current = forceAction(rules, json(begun), {
      side: "enemy", user: 0, kind: "skill", id: 1, target: 0, speed: 0,
    });
    expect(state(current).actors[0]!.hp).toBe(350);
  });

  test("applies Attack Speed and Attack Times only to normal attacks", () => {
    const db = cloneDb();
    db.classes[0]!.params[6]![1] = 1;
    db.enemies[0]!.params[6] = 50;
    db.enemies[0]!.params[0] = 200;
    db.classes[0]!.traits.push(
      { code: 33, dataId: 0, value: 100 },
      { code: 34, dataId: 0, value: 1 },
    );
    Object.assign(db.skills[0]!, {
      hitType: 0,
      successRate: 100,
      repeats: 1,
      damage: {
        ...db.skills[0]!.damage,
        type: 1,
        critical: false,
        variance: 0,
        source: "10",
        formula: { kind: "number", value: 10 },
      },
      effects: [],
    });
    const rules = createRpgMakerBattleRules(db);
    let current = rules.start({}, setup(db), 73, CONTEXT)!.state;
    current = confirm(rules, current); // intro -> party
    current = confirm(rules, current); // Fight -> command
    current = confirm(rules, current); // Attack -> sorted action queue
    expect(state(current).queue[0]?.side).toBe("actor");
    expect(state(current).enemies[0]!.hp).toBe(180);
  });

  test("initializes, charges, regenerates, clears, and preserves TP deterministically", () => {
    const db = cloneDb();
    db.actors[0]!.traits.push(
      { code: 22, dataId: 7, value: 0.1 },
      { code: 22, dataId: 8, value: 0.1 },
      { code: 22, dataId: 9, value: 0.1 },
      { code: 23, dataId: 5, value: 2 },
    );
    const seed = 0xabcdef01;
    let cursor = seed >>> 0;
    const actorTp = rngNext(cursor);
    cursor = actorTp.next;
    const enemyTp = rngNext(cursor);
    const rules = createRpgMakerBattleRules(db);
    const begun = mutable(rules.start({}, setup(db), seed, CONTEXT)!.state);
    expect(begun.actors[0]!.tp).toBe(Math.floor(actorTp.value * 25));
    expect(begun.enemies[0]!.tp).toBe(Math.floor(enemyTp.value * 25));

    begun.actors[0]!.hp = 100;
    begun.actors[0]!.mp = 0;
    begun.actors[0]!.tp = 0;
    let current = forceAction(rules, json(begun), {
      side: "enemy", user: 0, kind: "skill", id: 1, target: 0, speed: 0,
    });
    const damaged = state(current);
    const lost = 100 - damaged.actors[0]!.hp;
    expect(damaged.actors[0]!.tp).toBe(Math.floor(50 * lost /
      rpgMakerCombatantParam(db, damaged.actors[0]!, 0) * 2));
    current = confirm(rules, current); // empty queue -> turn-end regeneration
    expect(state(current).actors[0]!.hp).toBe(damaged.actors[0]!.hp +
      Math.floor(rpgMakerCombatantParam(db, damaged.actors[0]!, 0) * 0.1));
    expect(state(current).actors[0]!.mp).toBe(Math.floor(
      rpgMakerCombatantParam(db, damaged.actors[0]!, 1) * 0.1));
    expect(state(current).actors[0]!.tp).toBe(damaged.actors[0]!.tp + 10);

    const terminal = mutable(current);
    terminal.phase = "done";
    terminal.result = "escape";
    expect((rules.done(json(terminal))!.ext as Record<string, any>).rpgmakerBattle.actors["1"].tp).toBe(0);

    db.actors[0]!.traits.push({ code: 62, dataId: 3, value: 0 });
    const savedTp = {
      rpgmakerBattle: {
        version: 1,
        actors: {
          "1": { actorId: 1, classId: 1, level: 1, exp: 0, hp: 100, mp: 10, tp: 77, skills: [1], states: [], buffs: [] },
        },
        battleCount: 0, winCount: 0, escapeCount: 0, encounter: null,
      },
    };
    const preserveRules = createRpgMakerBattleRules(db);
    const preserved = mutable(preserveRules.start(savedTp, setup(db), seed, CONTEXT)!.state);
    expect(preserved.actors[0]!.tp).toBe(77);
    preserved.phase = "done";
    preserved.result = "escape";
    expect((preserveRules.done(json(preserved))!.ext as Record<string, any>).rpgmakerBattle.actors["1"].tp).toBe(77);
  });

  test("applies Gold Double, Drop Item Double, and actor EXP rate to victory rewards", () => {
    const db = cloneDb();
    db.enemies[0]!.params[0] = 1;
    db.enemies[0]!.exp = 100;
    db.enemies[0]!.gold = 10;
    db.enemies[0]!.drops = [{ kind: 1, dataId: 1, denominator: 2, item: "item001" }];
    db.actors[0]!.traits.push(
      { code: 64, dataId: 4, value: 0 },
      { code: 64, dataId: 5, value: 0 },
      { code: 23, dataId: 9, value: 1.5 },
    );
    const rules = createRpgMakerBattleRules(db);
    let current = rules.start({}, setup(db), 51, CONTEXT)!.state;
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = confirm(rules, current);
    expect(state(current).reward).toMatchObject({ exp: 100, gold: 20, items: { item001: 1 } });
    expect(state(current).actors[0]!.actor!.exp).toBe(150);
  });

  test("escape is deterministic, gated by canEscape, and increments its counter", () => {
    const db = cloneDb();
    db.enemies[0]!.params[6] = 1;
    const { rules } = start(db, 7);
    let current = rules.start({}, setup(db), 7, CONTEXT)!.state;
    current = confirm(rules, current);
    current = fold(rules, current, { downEdge: true });
    current = confirm(rules, current);
    expect(state(current)).toMatchObject({ phase: "message", afterMessage: "escape" });
    current = confirm(rules, current);
    const completion = rules.done(current)!;
    expect(completion.result).toBe("escape");
    expect((completion.ext as Record<string, any>).rpgmakerBattle.escapeCount).toBe(1);

    const blocked = rules.start({}, setup(db, { canEscape: false }), 7, CONTEXT)!.state;
    let noEscape = confirm(rules, blocked);
    noEscape = fold(rules, noEscape, { downEdge: true });
    noEscape = confirm(rules, noEscape);
    expect(state(noEscape).phase).toBe("party");
  });

  test("fixed, variable, and weighted region encounter sources resolve deterministically", () => {
    const db = cloneDb();
    db.encounters = [{
      map: "map003",
      step: 30,
      entries: [
        { troopId: 999, weight: 100, regions: [4] },
        { troopId: 1, weight: 1, regions: [7] },
      ],
    }];
    const rules = createRpgMakerBattleRules(db);
    const variable = rules.start({}, {
      system: "rpgmaker", databaseHash: db.databaseHash, troopVariable: "v004", canEscape: true, canLose: true,
    }, 1, {
      ...CONTEXT,
      variables: { v004: 1 },
    });
    expect(variable).not.toBeNull();
    const encounter = rules.start({}, {
      system: "rpgmaker", databaseHash: db.databaseHash, encounter: true, map: "map003",
      canEscape: true, canLose: true,
    }, 1, { ...CONTEXT, playerCell: { x: 1, y: 1, region: 7 } });
    expect(encounter).not.toBeNull();
    expect(state(encounter!.state).troopId).toBe(1);
  });

  test("eligible zero-weight encounters never win and an all-zero table declines battle", () => {
    const db = cloneDb();
    db.encounters = [{
      map: "map003",
      step: 30,
      entries: [
        { troopId: 999, weight: 0, regions: [7] },
        { troopId: 1, weight: 5, regions: [7] },
      ],
    }];
    const rules = createRpgMakerBattleRules(db);
    const setupValue = {
      system: "rpgmaker", databaseHash: db.databaseHash, encounter: true, map: "map003",
      canEscape: true, canLose: true,
    } as JsonValue;
    const context = { ...CONTEXT, playerCell: { x: 1, y: 1, region: 7 } };
    for (const seed of [0, 1, 2, 0xffffffff]) {
      const started = rules.start({}, setupValue, seed, context);
      expect(started, `seed ${seed}`).not.toBeNull();
      expect(state(started!.state).troopId).toBe(1);
    }

    db.encounters[0]!.entries[1]!.weight = 0;
    expect(createRpgMakerBattleRules(db).start({}, setupValue, 1, context)).toBeNull();
  });

  test("walking encounter countdown is saved in ext and survives battle settlement", () => {
    const db = cloneDb();
    db.encounters = [{ map: "map003", step: 1, entries: [{ troopId: 1, weight: 1, regions: [] }] }];
    db.enemies[0]!.params[0] = 1;
    const options = createRpgMakerBattleExtensions(db);
    const hook = options.commands![RPGMAKER_ENCOUNTER_STEP_CALL]!;
    let draws = 0;
    const raised = hook({
      ...CONTEXT,
      ext: { otherGame: 7 },
      random: () => { draws++; return 0; },
      playerStep: { dx: 1, dy: 0, kind: "step" },
    }, null)!;

    expect(raised.writes).toEqual({ [RPGMAKER_ENCOUNTER_DUE_VARIABLE]: 1 });
    expect(draws).toBe(4); // initial two draws, then two for the reset
    expect(raised.ext).toMatchObject({
      otherGame: 7,
      rpgmakerBattle: { encounter: { map: "map003", remaining: 1 } },
    });

    const rules = createRpgMakerBattleRules(db);
    let current = rules.start(raised.ext!, setup(db), 3, CONTEXT)!.state;
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = confirm(rules, current);
    const completed = rules.done(current)!;
    expect((completed.ext as Record<string, any>).rpgmakerBattle.encounter)
      .toEqual({ map: "map003", remaining: 1 });
  });

  test("composes walking encounters with an existing player-step extension", () => {
    const db = cloneDb();
    db.encounters = [{ map: "map003", step: 1, entries: [{ troopId: 1, weight: 1, regions: [] }] }];
    const validate = () => true;
    const options = augmentRpgMakerBattleExtensions({
      commands: {
        "game.step": (context) => ({
          ext: { ...(context.ext as Record<string, JsonValue>), baseSteps: 1 },
          writes: { baseStep: 1 },
        }),
      },
      playerStep: { call: "game.step", args: { source: "base" }, displacement: true },
      validate,
    }, db);
    expect(options.validate).toBe(validate);
    expect(options.playerStep).toEqual({ call: "rpgmaker.composedEncounterStep", displacement: true });
    const hook = options.commands![options.playerStep!.call]!;
    const stepped = hook({
      ...CONTEXT,
      random: () => 0,
      playerStep: { dx: 1, dy: 0, kind: "step" },
    }, null)!;
    expect(stepped.ext).toMatchObject({
      baseSteps: 1,
      rpgmakerBattle: { encounter: { map: "map003", remaining: 1 } },
    });
    expect(stepped.writes).toEqual({ baseStep: 1, [RPGMAKER_ENCOUNTER_DUE_VARIABLE]: 1 });

    const relocated = hook({
      ...CONTEXT,
      random: () => { throw new Error("relocation must not advance encounter RNG"); },
      playerStep: { dx: 4, dy: 0, kind: "relocation" },
    }, null)!;
    expect(relocated).toEqual({ ext: { baseSteps: 1 }, writes: { baseStep: 1 } });
    expect(() => augmentRpgMakerBattleExtensions({
      commands: { [RPGMAKER_ENCOUNTER_STEP_CALL]: () => undefined },
    }, db)).toThrow("command collision");
  });

  test("hit/critical/variance/drop consume a pinned RNG cursor", () => {
    const db = cloneDb();
    db.enemies[0]!.params[0] = 1;
    db.enemies[0]!.drops = [{ kind: 1, dataId: 1, denominator: 1, item: "item001" }];
    const seed = 0x12345678;
    const { rules } = start(db, seed);
    let current = rules.start({}, setup(db), seed, CONTEXT)!.state;
    current = confirm(rules, current);
    current = confirm(rules, current);
    current = confirm(rules, current);

    // Actor/enemy initial TP, enemy action choice, actor/enemy speed, hit,
    // evade, critical, two variance rolls, death-state duration, and the
    // guaranteed drop each consume one draw.
    let expected = seed >>> 0;
    for (let i = 0; i < 12; i++) expected = rngNext(expected).next;
    expect(state(current).rng).toBe(expected);
  });

  test("experience curve matches the MV/MZ class formula", () => {
    const db = cloneDb();
    expect(rpgMakerExpForLevel(db, 1, 1)).toBe(0);
    expect(rpgMakerExpForLevel(db, 1, 2)).toBe(50);
    expect(rpgMakerExpForLevel(db, 1, 3)).toBe(162);
  });

  test("equal reference time is cadence-independent", () => {
    const db = cloneDb();
    const rules = createRpgMakerBattleRules(db);
    const initial = rules.start({}, setup(db), 123, CONTEXT)!.state;
    let at60 = initial;
    let at20 = initial;
    for (let i = 0; i < 60; i++) at60 = fold(rules, at60, {}, 1);
    for (let i = 0; i < 20; i++) at20 = fold(rules, at20, {}, 3);
    expect(at20).toEqual(at60);
    expect(confirm(rules, at20)).toEqual(confirm(rules, at60));
  });

  test("animation timing SE projects every crossed edge at 60/30/20 Hz", () => {
    const db = cloneDb();
    const animation: AnimationDef = {
      id: "anim-timed",
      sheet: "unused.png",
      count: 5,
      frameDuration: 1 / 60,
      timings: [
        { frame: 0, se: { id: "start", volume: 80, pitch: 110, pan: -25 } },
        { frame: 1, se: { id: "one-a" } },
        { frame: 1, se: { id: "one-b", volume: 70 } },
        { frame: 2, se: { id: "two" } },
        { frame: 3, se: { id: "three" } },
        { frame: 4, se: { id: "tail" } },
      ],
    };
    const rules = createRpgMakerBattleRules(db, { animations: [animation] });
    expect(rules.cues).toBeDefined();
    const initial = rules.start({}, setup(db), 1, CONTEXT)!.state;

    const marked = (nowTick: number, startTick: number, targets = [0]): JsonValue => {
      const next = mutable(initial);
      next.nowTick = nowTick;
      next.battleAnimation = {
        id: animation.id,
        targets,
        targetSide: "enemy",
        startTick,
      };
      return json(next);
    };
    const ids = (cues: ReturnType<NonNullable<BattleRules["cues"]>>): string[] =>
      cues?.map((cue) => cue.id) ?? [];
    const sequence = (ticks: 1 | 2 | 3): string[] => {
      const out: string[] = [];
      const started = marked(ticks, ticks);
      out.push(...ids(rules.cues!(initial, started)));
      let previous = started;
      for (let elapsed = 0; elapsed < 5; elapsed += ticks) {
        const next = marked(ticks + Math.min(5, elapsed + ticks), ticks);
        out.push(...ids(rules.cues!(previous, next)));
        previous = next;
      }
      return out;
    };

    const expected = ["start", "one-a", "one-b", "two", "three", "tail"];
    expect(sequence(1)).toEqual(expected);
    expect(sequence(2)).toEqual(expected);
    expect(sequence(3)).toEqual(expected);
    expect(rules.cues!(initial, marked(1, 1))).toEqual([
      { id: "start", volume: 80, pitch: 110, pan: -25 },
    ]);
    expect(ids(rules.cues!(initial, marked(1, 1, [0, 1])))).toEqual([
      "start", "start",
    ]);
    const screenRules = createRpgMakerBattleRules(db, {
      animations: [animation],
      animationPositions: { [animation.id]: 3 },
    });
    expect(ids(screenRules.cues!(initial, marked(1, 1, [0, 1])))).toEqual(["start"]);

    // The old marker is scanned through the transition tick before a new
    // same-id marker emits its independent frame-zero edge.
    const oldMarker = marked(3, 0);
    const replacement = marked(4, 4);
    expect(ids(rules.cues!(oldMarker, replacement))).toEqual(["tail", "start"]);
  });

  test("animation timing SE survives save/load without replaying past edges", () => {
    const db = cloneDb();
    const animation: AnimationDef = {
      id: "anim-save",
      sheet: "unused.png",
      count: 4,
      frameDuration: 1 / 60,
      timings: [
        { frame: 0, se: { id: "start" } },
        { frame: 2, se: { id: "middle" } },
      ],
    };
    const rules = createRpgMakerBattleRules(db, { animations: [animation] });
    const initial = rules.start({}, setup(db), 1, CONTEXT)!.state;
    const marked = (nowTick: number): JsonValue => {
      const next = mutable(initial);
      next.nowTick = nowTick;
      next.battleAnimation = { id: animation.id, targets: [0], startTick: 1 };
      return json(next);
    };
    const before = rules.save!.decode(rules.save!.encode(marked(2)));
    expect(rules.cues!(before, marked(3))).toEqual([
      { id: "middle", volume: 100, pitch: 100 },
    ]);
    const after = rules.save!.decode(rules.save!.encode(marked(3)));
    expect(rules.cues!(after, marked(4))).toBeUndefined();
    // Rewinding to the pre-edge reducer state defines a new forward
    // traversal, so the same deterministic edge is projected once again.
    expect(rules.cues!(before, marked(3))).toEqual([
      { id: "middle", volume: 100, pitch: 100 },
    ]);

    const silentRules = createRpgMakerBattleRules(db, {
      animations: [{ ...animation, timings: [{ frame: 1, hide: { duration: 1 / 60 } }] }],
    });
    expect(silentRules.cues).toBeUndefined();
  });

  test("database identity mismatch fails before publishing battle state", () => {
    const db = cloneDb();
    const rules = createRpgMakerBattleRules(db);
    expect(() => rules.start({}, {
      system: "rpgmaker", databaseHash: "0".repeat(64), troop: 1, canEscape: true, canLose: true,
    }, 1, CONTEXT))
      .toThrow("database hash");
  });
});
