import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rngNext } from "../src/engine/interpreter.ts";
import type { BattleInput, BattleRules } from "../src/engine/battle.ts";
import type { ExtensionReadContext } from "../src/engine/extensions.ts";
import type { JsonValue } from "../src/engine/types.ts";
import {
  augmentRpgMakerBattleExtensions,
  createRpgMakerBattleExtensions,
  createRpgMakerBattleRules,
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

describe("RPG Maker battle rules", () => {
  test("wins a front-view battle, awards drops/gold/EXP, levels up, and persists namespaced state", () => {
    const db = cloneDb();
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
    current = confirm(rules, current);

    const completion = rules.done(current)!;
    expect(completion.result).toBe("win");
    expect(completion.gold).toBe(37);
    expect(completion.items).toEqual({ item001: 1 });
    const root = completion.ext as Record<string, any>;
    expect(root.otherGame).toEqual({ untouched: true });
    expect(root.rpgmakerBattle).toMatchObject({ battleCount: 1, winCount: 1, escapeCount: 0 });
    expect(root.rpgmakerBattle.actors["1"].level).toBeGreaterThan(1);
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

  test("confusion restrictions target opponents, either side, and friends for actors and enemies", () => {
    const db = cloneDb();
    db.states.push({
      id: 2, name: "Confusion", restriction: 3, priority: 50,
      minTurns: 2, maxTurns: 2, autoRemovalTiming: 0,
      removeAtBattleEnd: true, removeByDamage: false, chanceByDamage: 0, traits: [],
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
      removeAtBattleEnd: false, removeByDamage: false, chanceByDamage: 0, traits: [],
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
      message: "Couldn't escape!",
    });
    expect(state(current).queue.some((action) => action.side === "enemy")).toBe(true);
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

  test("database identity mismatch fails before publishing battle state", () => {
    const db = cloneDb();
    const rules = createRpgMakerBattleRules(db);
    expect(() => rules.start({}, {
      system: "rpgmaker", databaseHash: "0".repeat(64), troop: 1, canEscape: true, canLose: true,
    }, 1, CONTEXT))
      .toThrow("database hash");
  });
});
