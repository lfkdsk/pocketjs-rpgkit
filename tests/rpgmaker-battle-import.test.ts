import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sha256Text } from "../src/engine/map-repository.ts";
import { canonicalJson } from "../src/engine/save.ts";
import { parseRpgMakerFormula, RPGMAKER_FORMULA_FALLBACK } from "../src/rpgmaker-battle/formula.ts";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";

const ROOT = join(import.meta.dir, "fixtures/rpgmaker");
const HOLLOW = join(ROOT, "hollow-mz");
const STAGE = join(ROOT, "stage-mv");

function formulaCoverage(result: Awaited<ReturnType<typeof importRmProject>>) {
  return result.cov.list("battle").filter((row) => row.key.startsWith("formula "));
}

describe("RPG Maker battle database import", () => {
  test("normalizes MZ actors, curves, enemies, troops, items, states, and battler art", async () => {
    const result = await importRmProject(loadRmProject(HOLLOW));
    const battle = result.battle;

    expect(battle.format).toBe("rpgmaker-battle/v1");
    expect(battle.flavor).toBe("MZ");
    expect(battle.sideView).toBe(false);
    expect(battle.displayTp).toBe(true);
    expect(battle.screen).toEqual({ width: 480, height: 272 });
    expect(battle.terms.basic).toMatchObject({ levelAbbr: "Lv", hpAbbr: "HP", mpAbbr: "MP", tpAbbr: "TP" });
    expect(battle.terms.messages).toMatchObject({ emerge: "%1 emerged!", useItem: "%1 uses %2!" });
    expect(battle.party).toEqual([1]);
    expect(battle.actors.map(({ id, name, classId, initialLevel }) => ({ id, name, classId, initialLevel })))
      .toEqual([
        { id: 1, name: "Wren", classId: 1, initialLevel: 1 },
        { id: 2, name: "Moss", classId: 1, initialLevel: 1 },
      ]);
    expect(battle.actors[0]!.equipment).toMatchObject({
      params: [0, 0, 8, 5, 0, 0, 0, 0],
      skills: [],
      traits: [
        { code: 31, dataId: 1, value: 0 },
        { code: 22, dataId: 0, value: 0 },
      ],
    });
    expect(battle.classes[0]).toMatchObject({
      id: 1,
      expParams: [30, 20, 30, 30],
      learnings: [{ level: 1, skillId: 1 }],
    });
    expect(battle.classes[0]!.params.map((curve) => [curve[0], curve[1], curve[99]]))
      .toEqual([
        [400, 440, 4360], [60, 66, 654], [16, 18, 214], [14, 16, 212],
        [12, 14, 210], [12, 14, 210], [14, 16, 212], [10, 11, 109],
      ]);
    expect(battle.enemies[0]).toMatchObject({
      id: 1,
      name: "Golem",
      params: [120, 0, 14, 12, 8, 8, 6, 6],
      exp: 30,
      gold: 0,
      image: "enemy001",
      actions: [{ skillId: 1, rating: 5, conditionType: 0 }],
    });
    expect(battle.troops[0]).toMatchObject({
      id: 1,
      members: [{ enemyId: 1, x: 240, y: 160, hidden: false }],
      pages: [{ span: 0, condition: {}, effects: [], unsupported: 0 }],
    });
    expect(battle.skills[0]).toMatchObject({
      id: 1,
      scope: 1,
      successRate: 100,
      hitType: 1,
      damage: { type: 1, critical: true, variance: 20, source: "a.atk * 4 - b.def * 2" },
    });
    expect(battle.items[0]).toMatchObject({
      id: 1,
      consumable: true,
      effects: [{ code: 11, dataId: 0, value1: 0, value2: 30 }],
    });
    expect(battle.states[0]).toMatchObject({
      id: 1,
      restriction: 4,
      priority: 100,
      messages: [" has fallen!", " is slain!", "", " revives!"],
    });
    expect(result.assets.battlers).toEqual({
      enemy001: { png: "battlers/enemy001.png", w: 64, h: 64 },
    });
    expect(result.images.has("battlers/enemy001.png")).toBe(true);
  });

  test("retains actor metadata, slot-aligned equipment catalogs, and authored battle defaults", async () => {
    const project = loadRmProject(HOLLOW);
    const actor = project.actors[1]!;
    actor.nickname = "The Wayfarer";
    actor.profile = "Keeps walking when the road disappears.";
    actor.faceName = "PeopleFaces";
    actor.faceIndex = 3;
    actor.battlerName = "WrenBattler";
    actor.traits.push({ code: 55, dataId: 1, value: 0 });
    project.system.battleBgm = { name: "BattleTheme", volume: 71, pitch: 105, pan: -4 };
    project.system.victoryMe = { name: "Victory", volume: 82, pitch: 100, pan: 3 };
    project.system.defeatMe = { name: "Defeat", volume: 63, pitch: 95, pan: 0 };
    project.maps.get(1)!.battleback1Name = "Grassland";
    project.maps.get(1)!.battleback2Name = "Forest";
    project.maps.get(2)!.battleback1Name = "Room";
    project.maps.get(2)!.battleback2Name = "Wall";

    const battle = (await importRmProject(project)).battle;

    expect(battle.actors[0]).toMatchObject({
      nickname: "The Wayfarer",
      profile: "Keeps walking when the road disappears.",
      characterName: "People",
      characterIndex: 0,
      faceName: "PeopleFaces",
      faceIndex: 3,
      battlerName: "WrenBattler",
      equipSlots: ["weapon", "weapon", "armor", "armor", "armor"],
      equipTypes: [1, 1, 3, 4, 5],
      initialEquips: [
        { kind: "weapon", id: 1 },
        null,
        null,
        { kind: "armor", id: 1 },
        null,
      ],
      // Keep the legacy immutable aggregate alongside the slot-aligned data.
      equipment: { params: [0, 0, 8, 5, 0, 0, 0, 0] },
    });
    expect(battle.weapons?.[0]).toEqual({
      id: 1,
      kind: "weapon",
      name: "Oak Staff",
      etypeId: 1,
      typeId: 1,
      params: [0, 0, 8, 0, 0, 0, 0, 0],
      traits: [
        { code: 31, dataId: 1, value: 0 },
        { code: 22, dataId: 0, value: 0 },
      ],
    });
    expect(battle.armors?.[0]).toEqual({
      id: 1,
      kind: "armor",
      name: "Cloth Vest",
      etypeId: 4,
      typeId: 1,
      params: [0, 0, 0, 5, 0, 0, 0, 0],
      traits: [],
    });
    expect(battle.settings).toEqual({
      battleBgm: { name: "BattleTheme", volume: 71, pitch: 105, pan: -4 },
      victoryMe: { name: "Victory", volume: 82, pitch: 100, pan: 3 },
      defeatMe: { name: "Defeat", volume: 63, pitch: 95, pan: 0 },
      encounterDisabled: false,
    });
    expect(battle.mapSettings).toEqual(expect.arrayContaining([
      { map: "map001", battleback1Name: "Grassland", battleback2Name: "Forest" },
      { map: "map002", battleback1Name: "Room", battleback2Name: "Wall" },
    ]));
  });

  test("normalizes executable troop enemy effects and records command coverage", async () => {
    const project = loadRmProject(HOLLOW);
    project.troops[1]!.pages[0]!.list = [
      { code: 331, indent: 0, parameters: [-1, 1, 1, 7, true] },
      { code: 332, indent: 0, parameters: [2, 0, 0, 11] },
      { code: 342, indent: 0, parameters: [0, 1, 1, 8] },
      { code: 333, indent: 0, parameters: [-1, 1, 5] },
      { code: 334, indent: 0, parameters: [1] },
      { code: 335, indent: 0, parameters: [2] },
      { code: 336, indent: 0, parameters: [3, 9] },
      { code: 337, indent: 0, parameters: [-1, 12, true] },
      { code: 339, indent: 0, parameters: [1, 4, 6, -2] },
      { code: 340, indent: 0, parameters: [] },
      { code: 999, indent: 0, parameters: ["unknown"] },
      { code: 0, indent: 0, parameters: [] },
    ];

    const result = await importRmProject(project);
    const page = result.battle.troops[0]!.pages[0]!;

    expect(page.effects).toEqual([
      { kind: "enemyHp", index: -1, operation: "sub", operand: { kind: "variable", id: "v007" }, allowDeath: true },
      { kind: "enemyMp", index: 2, operation: "add", operand: { kind: "constant", value: 11 } },
      { kind: "enemyTp", index: 0, operation: "sub", operand: { kind: "variable", id: "v008" } },
      { kind: "enemyState", index: -1, operation: "remove", stateId: 5 },
      { kind: "enemyRecoverAll", index: 1 },
      { kind: "enemyAppear", index: 2 },
      { kind: "enemyTransform", index: 3, enemyId: 9 },
      { kind: "battleAnimation", index: -1, animationId: 12, entireTroop: true },
      { kind: "forceAction", side: "actor", subject: 4, skillId: 6, target: -2 },
      { kind: "abort" },
    ]);
    expect(page.unsupported).toBe(1);

    const commandCoverage = new Map(result.cov.list("command").map((row) => [Number(row.key), row]));
    for (const code of [331, 332, 342, 333, 334, 335, 336, 339, 340]) {
      expect(commandCoverage.get(code)?.counts.Native).toBe(1);
    }
    expect(commandCoverage.get(337)?.counts).toMatchObject({ Native: 0, Degraded: 1, Dropped: 0 });
    expect(commandCoverage.get(337)?.reasons.join(" ")).toContain("numeric database id");
    expect(commandCoverage.get(999)?.counts.Dropped).toBe(1);
  });

  test("binds battle.json to commands with a canonical content hash", async () => {
    const first = await importRmProject(loadRmProject(HOLLOW));
    const second = await importRmProject(loadRmProject(HOLLOW));
    const { databaseHash, ...content } = first.battle;

    expect(databaseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(databaseHash).toBe(sha256Text(canonicalJson(content)));
    expect(JSON.stringify(second.battle, null, 2) + "\n")
      .toBe(JSON.stringify(first.battle, null, 2) + "\n");
    const projectText = canonicalJson(first.project);
    expect(projectText).toContain(`\"databaseHash\":\"${databaseHash}\"`);
  });

  test("records safe-formula coverage for both MV and MZ fixtures", async () => {
    const [hollow, stage] = await Promise.all([
      importRmProject(loadRmProject(HOLLOW)),
      importRmProject(loadRmProject(STAGE)),
    ]);
    const rows = [...formulaCoverage(hollow), ...formulaCoverage(stage)];
    const totals = rows.reduce((sum, row) => ({
      native: sum.native + row.counts.Native,
      degraded: sum.degraded + row.counts.Degraded,
    }), { native: 0, degraded: 0 });

    expect(totals).toEqual({ native: 5, degraded: 0 });
    expect(rows.map((row) => row.key)).toEqual([
      "formula item 1", "formula item 2", "formula skill 1",
      "formula item 1", "formula skill 1",
    ]);
  });

  test("rejects arbitrary JavaScript at import time and persists deterministic fallback", async () => {
    const project = loadRmProject(HOLLOW);
    project.skills[1]!.damage!.formula = "globalThis.process.exit(1)";
    const result = await importRmProject(project);
    const skill = result.battle.skills[0]!;
    const row = formulaCoverage(result).find((entry) => entry.key === "formula skill 1")!;

    expect(skill.damage.source).toBe("globalThis.process.exit(1)");
    expect(skill.damage.fallback).toBe(true);
    expect(skill.damage.formula).toEqual(parseRpgMakerFormula(RPGMAKER_FORMULA_FALLBACK));
    expect(row.counts).toMatchObject({ Native: 0, Degraded: 1 });
    expect(row.reasons.join(" ")).toContain(`fallback ${RPGMAKER_FORMULA_FALLBACK}`);
  });

  test("reports formulas beyond the runtime depth budget as degraded", async () => {
    const project = loadRmProject(HOLLOW);
    project.skills[1]!.damage!.formula = `${"(".repeat(65)}1${")".repeat(65)}`;
    const result = await importRmProject(project);
    const row = formulaCoverage(result).find((entry) => entry.key === "formula skill 1")!;

    expect(result.battle.skills[0]!.damage.fallback).toBe(true);
    expect(row.counts).toMatchObject({ Native: 0, Degraded: 1 });
    expect(row.reasons.join(" ")).toContain("exceeds AST depth 64");
  });

  test("imports weighted region encounters and step threshold", async () => {
    const project = loadRmProject(HOLLOW);
    const map = project.maps.get(1)!;
    map.encounterStep = 17;
    map.encounterList = [
      { troopId: 1, weight: 7, regionSet: [2, 5] },
      { troopId: 1, weight: 3, regionSet: [] },
    ];
    const result = await importRmProject(project);

    expect(result.battle.encounters).toEqual([{
      map: "map001",
      step: 17,
      entries: [
        { troopId: 1, weight: 7, regions: [2, 5] },
        { troopId: 1, weight: 3, regions: [] },
      ],
    }]);
    expect(result.project.system?.stepCounter).toBe(true);
    const encounterEvent = result.project.maps[0]!.events?.find((event) => event.id === "rmi-random-encounter");
    expect(encounterEvent).toMatchObject({
      x: 0,
      y: 0,
      pages: [{
        trigger: "parallel",
        condition: { variable: { id: "rmi-encounter-due", op: ">=", value: 1 } },
        through: true,
        commands: [
          {
            op: "battle",
            setup: {
              system: "rpgmaker",
              databaseHash: result.battle.databaseHash,
              encounter: true,
              map: "map001",
              canEscape: true,
              canLose: false,
            },
            onLose: [{ op: "gameOver" }, { op: "exit" }],
          },
          { op: "variable", id: "rmi-encounter-due", set: { op: "set", value: 0 } },
        ],
      }],
    });
    const coverage = result.cov.list("tile").find((row) => row.key === "map encounters")!;
    expect(coverage.counts.Degraded).toBe(1);
    expect(coverage.reasons.join(" ")).toContain("Encounter Half");
  });
});
