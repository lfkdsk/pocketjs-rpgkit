import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { rngNext } from "../src/engine/interpreter.ts";
import type { BattleInput, BattleRules } from "../src/engine/battle.ts";
import type { ExtensionReadContext } from "../src/engine/extensions.ts";
import type { JsonValue } from "../src/engine/types.ts";
import {
  createRpgMakerBattleExtensions,
  createRpgMakerBattleRules,
  RPGMAKER_ENCOUNTER_DUE_VARIABLE,
  RPGMAKER_ENCOUNTER_STEP_CALL,
  rpgMakerBattleState,
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

  test("an allowed defeat returns lose and preserves zero HP", () => {
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
    expect((completion.ext as Record<string, any>).rpgmakerBattle.actors["1"].hp).toBe(0);
    expect((completion.ext as Record<string, any>).rpgmakerBattle.winCount).toBe(0);
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

    // Enemy action choice, actor speed, enemy speed, hit, evade, critical,
    // two variance rolls, and the guaranteed drop each consume one draw.
    let expected = seed >>> 0;
    for (let i = 0; i < 9; i++) expected = rngNext(expected).next;
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
