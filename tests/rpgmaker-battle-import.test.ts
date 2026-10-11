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
    expect(battle.party).toEqual([1]);
    expect(battle.actors.map(({ id, name, classId, initialLevel }) => ({ id, name, classId, initialLevel })))
      .toEqual([
        { id: 1, name: "Wren", classId: 1, initialLevel: 1 },
        { id: 2, name: "Moss", classId: 1, initialLevel: 1 },
      ]);
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
    expect(battle.states[0]).toMatchObject({ id: 1, restriction: 4, priority: 100 });
    expect(result.assets.battlers).toEqual({
      enemy001: { png: "battlers/enemy001.png", w: 64, h: 64 },
    });
    expect(result.images.has("battlers/enemy001.png")).toBe(true);
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
    expect(result.cov.list("tile").find((row) => row.key === "map encounters")?.counts.Native).toBe(1);
  });
});
