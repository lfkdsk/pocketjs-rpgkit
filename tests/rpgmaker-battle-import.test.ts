import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sha256Text } from "../src/engine/map-repository.ts";
import { canonicalJson } from "../src/engine/save.ts";
import {
  resolveRpgMakerBattlebacks,
  rpgMakerBattleback1ForKind,
  rpgMakerBattleback2ForKind,
} from "../src/rpgmaker-battle/battleback.ts";
import { parseRpgMakerFormula, RPGMAKER_FORMULA_FALLBACK } from "../src/rpgmaker-battle/formula.ts";
import { loadRmProject } from "../tools/rpgmaker-import/load.ts";
import { importRmProject } from "../tools/rpgmaker-import/project.ts";
import { staticCommandTable } from "../tools/rpgmaker-import/report.ts";

const ROOT = join(import.meta.dir, "fixtures/rpgmaker");
const HOLLOW = join(ROOT, "hollow-mz");
const STAGE = join(ROOT, "stage-mv");

function formulaCoverage(result: Awaited<ReturnType<typeof importRmProject>>) {
  return result.cov.list("battle").filter((row) => row.key.startsWith("formula "));
}

function battleSetupHashes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(battleSetupHashes);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = record.op === "battle" && record.setup !== null && typeof record.setup === "object" &&
      !Array.isArray(record.setup) && typeof (record.setup as Record<string, unknown>).databaseHash === "string"
    ? [(record.setup as Record<string, string>).databaseHash]
    : [];
  return own.concat(Object.values(record).flatMap(battleSetupHashes));
}

function extensionArgs(value: unknown, call: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => extensionArgs(entry, call));
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = record.op === "ext" && record.call === call && record.args !== null &&
      typeof record.args === "object" && !Array.isArray(record.args)
    ? [record.args as Record<string, unknown>]
    : [];
  return own.concat(Object.values(record).flatMap((entry) => extensionArgs(entry, call)));
}

describe("RPG Maker battle database import", () => {
  test("the static command catalogue measures battle-only commands through the troop converter", () => {
    const rows = new Map(staticCommandTable().map((row) => [row.code, row]));
    for (const code of [331, 332, 333, 334, 335, 336, 339, 340, 342]) {
      expect(rows.get(code)?.disposition).toBe("Native");
    }
    expect(rows.get(337)).toMatchObject({ disposition: "Native", reason: "" });
  });

  test("the two fixture command-coverage snapshots match the documented totals", async () => {
    const [hollow, stage] = await Promise.all([
      importRmProject(loadRmProject(HOLLOW)),
      importRmProject(loadRmProject(STAGE)),
    ]);
    expect(hollow.cov.totals("command")).toEqual({
      Native: 115, Degraded: 12, Placeholder: 1, Dropped: 0, total: 128,
    });
    expect(stage.cov.totals("command")).toEqual({
      Native: 52, Degraded: 9, Placeholder: 0, Dropped: 0, total: 61,
    });
  });

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
      enemy002: { png: "battlers/enemy002.png", w: 64, h: 64 },
    });
    expect(result.images.has("battlers/enemy001.png")).toBe(true);
    expect(result.images.has("battlers/enemy002.png")).toBe(true);
    expect(battle.troops[1]!.pages[0]!.effects).toContainEqual({
      kind: "battleAnimation",
      index: 1,
      animationId: 1,
      entireTroop: false,
      animation: "anim001",
    });
    expect(result.assets.animations.anim001).toEqual({
      sheet: "animations/anim001.png",
      offsetX: -81,
      offsetY: -88,
      originOffsetX: -89,
      originOffsetY: -96,
      position: 1,
    });
    expect(result.images.has("animations/anim001.png")).toBe(true);
    expect(result.assets.battlebacks1.HollowFloor).toEqual({
      png: "battlebacks1/hollowfloor.png", w: 480, h: 272,
    });
    expect(result.assets.battlebacks2.HollowWall).toEqual({
      png: "battlebacks2/hollowwall.png", w: 480, h: 272,
    });
    expect(result.images.has("battlebacks1/hollowfloor.png")).toBe(true);
    expect(result.images.has("battlebacks2/hollowwall.png")).toBe(true);
  });

  test("imports default and Change Actor Images art deterministically and reports every missing candidate", async () => {
    const fixture = () => {
      const project = loadRmProject(HOLLOW);
      const mapList = project.maps.get(1)!.events.find((event) => event !== null)!.pages[0]!.list;
      mapList.splice(mapList.length - 1, 0, {
        code: 322,
        indent: 0,
        parameters: [1, "People", 0, "MissingMapFaces", 1, "MissingMapBattler"],
      });
      const troopList = project.troops[1]!.pages[0]!.list;
      troopList.splice(troopList.length - 1, 0, {
        code: 322,
        indent: 0,
        parameters: [1, "People", 0, "MissingTroopFaces", 2, "MissingTroopBattler"],
      });
      return project;
    };
    const [first, second] = await Promise.all([importRmProject(fixture()), importRmProject(fixture())]);

    expect(first.assets.faces).toEqual({
      "WrenFaces:0": "faces/wrenfaces-0.png",
      "WrenFaces:5": "faces/wrenfaces-5.png",
    });
    expect(first.assets.actorBattlers).toEqual({
      WrenBattler: "actor-battlers/wrenbattler.png",
      WrenBattlerAlt: "actor-battlers/wrenbattleralt.png",
    });
    expect(first.images.get(first.assets.faces["WrenFaces:0"]!)).toMatchObject({ width: 144, height: 144 });
    expect(first.images.get(first.assets.faces["WrenFaces:5"]!)).toMatchObject({ width: 144, height: 144 });
    expect(first.images.get(first.assets.actorBattlers.WrenBattler!)).toMatchObject({ width: 576, height: 384 });
    expect(first.images.get(first.assets.actorBattlers.WrenBattlerAlt!)).toMatchObject({ width: 576, height: 384 });

    const imported = [...Object.values(first.assets.faces), ...Object.values(first.assets.actorBattlers)];
    for (const path of imported) expect(second.images.get(path)?.data).toEqual(first.images.get(path)?.data);
    expect(second.assets.faces).toEqual(first.assets.faces);
    expect(second.assets.actorBattlers).toEqual(first.assets.actorBattlers);

    expect(first.warnings).toEqual(expect.arrayContaining([
      "face MissingMapFaces:1: img/faces/MissingMapFaces.png is missing",
      "face MissingTroopFaces:2: img/faces/MissingTroopFaces.png is missing",
      "actor battler MissingMapBattler: img/sv_actors/MissingMapBattler.png is missing",
      "actor battler MissingTroopBattler: img/sv_actors/MissingTroopBattler.png is missing",
    ]));
    const battleCoverage = new Map(first.cov.list("battle").map((row) => [row.key, row]));
    expect(battleCoverage.get("face MissingMapFaces:1")?.counts.Degraded).toBe(1);
    expect(battleCoverage.get("face MissingTroopFaces:2")?.counts.Degraded).toBe(1);
    expect(battleCoverage.get("actor battler MissingMapBattler")?.counts.Degraded).toBe(1);
    expect(battleCoverage.get("actor battler MissingTroopBattler")?.counts.Degraded).toBe(1);
    const imageCommand = first.cov.list("command").find((row) => row.key === "322")!;
    expect(imageCommand.reasons.join(" ")).toContain("imported faces can update live");
    expect(imageCommand.reasons.join(" ")).toContain("map walking images are not wired");
  });

  test("converts battle-event presentation commands and finalizes their ME clocks", async () => {
    const project = loadRmProject(HOLLOW);
    const page = project.troops[1]!.pages[0]!;
    page.conditions.turnValid = true;
    page.list.splice(page.list.length - 1, 0,
      { code: 132, indent: 0, parameters: [{ name: "hollow-battle", volume: 73, pitch: 101, pan: -4 }] },
      { code: 133, indent: 0, parameters: [{ name: "hollow-victory", volume: 84, pitch: 100, pan: 5 }] },
      { code: 139, indent: 0, parameters: [{ name: "hollow-defeat", volume: 72, pitch: 100, pan: -6 }] },
      { code: 283, indent: 0, parameters: ["Grassland", "HollowWall"] },
      { code: 322, indent: 0, parameters: [1, "People", 0, "WrenFaces", 5, "WrenBattlerAlt"] },
    );
    const mapList = project.maps.get(1)!.events.find((event) => event !== null)!.pages[0]!.list;
    mapList.splice(mapList.length - 1, 0, {
      code: 133,
      indent: 0,
      parameters: [{ name: "hollow-victory", volume: 81, pitch: 100, pan: 2 }],
    });

    const result = await importRmProject(project);
    const effects = result.battle.troops[0]!.pages[0]!.effects;
    expect(effects).toContainEqual({
      kind: "battleBgm",
      audio: { name: "hollow-battle", volume: 73, pitch: 101, pan: -4, id: "bgm-hollow-battle" },
    });
    expect(effects).toContainEqual({
      kind: "battleback", battleback1Name: "Grassland", battleback2Name: "HollowWall",
    });
    expect(effects).toContainEqual({
      kind: "images", actorId: 1, characterName: "People", characterIndex: 0,
      faceName: "WrenFaces", faceIndex: 5, battlerName: "WrenBattlerAlt",
    });
    const fanfare = result.audioMedia.find((entry) => entry.kind === "me" && entry.name === "hollow-victory");
    if (!fanfare || fanfare.status !== "success") throw new Error("hollow victory fixture did not convert");
    expect(effects).toContainEqual({
      kind: "victoryMe",
      audio: {
        name: "hollow-victory", volume: 84, pitch: 100, pan: 5,
        id: "me-hollow-victory", durationTicks: fanfare.durationTicks,
      },
    });
    const defeat = result.audioMedia.find((entry) => entry.kind === "me" && entry.name === "hollow-defeat");
    if (!defeat || defeat.status !== "success") throw new Error("hollow defeat fixture did not convert");
    expect(effects).toContainEqual({
      kind: "defeatMe",
      audio: {
        name: "hollow-defeat", volume: 72, pitch: 100, pan: -6,
        id: "me-hollow-defeat", durationTicks: defeat.durationTicks,
      },
    });
    const mapSetting = extensionArgs(result.project, "rpgmaker.battleSetting")
      .find((args) => args.kind === "victoryMe" && (args.audio as Record<string, unknown>)?.volume === 81);
    expect(mapSetting?.audio).toMatchObject({
      id: "me-hollow-victory", durationTicks: fanfare.durationTicks,
    });
    for (const code of [132, 133, 139, 283, 322]) {
      expect(result.cov.list("command").find((row) => row.key === String(code))?.counts.Native).toBeGreaterThan(0);
    }
  });

  test("binds cooked legacy animations to MZ skills and items by record shape", async () => {
    const project = loadRmProject(HOLLOW);
    project.skills[1]!.animationId = 1;
    project.items[1]!.animationId = 1;

    const battle = (await importRmProject(project)).battle;

    expect(battle.skills[0]).toMatchObject({ animationId: 1, animation: "anim001" });
    expect(battle.items[0]).toMatchObject({ animationId: 1, animation: "anim001" });
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
    project.maps.get(1)!.specifyBattleback = true;
    project.maps.get(2)!.battleback1Name = "Room";
    project.maps.get(2)!.battleback2Name = "Wall";
    project.maps.get(2)!.specifyBattleback = true;

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
      animationId: 1,
      animation: "anim001",
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
      battleBgm: { name: "BattleTheme", volume: 71, pitch: 105, pan: -4, id: "bgm-battletheme" },
      victoryMe: { name: "Victory", volume: 82, pitch: 100, pan: 3, id: "me-victory" },
      defeatMe: { name: "Defeat", volume: 63, pitch: 95, pan: 0, id: "me-defeat" },
      encounterDisabled: false,
    });
    expect(battle.mapSettings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        map: "map001", specified: true, overworld: true,
        battleback1Name: "Grassland", battleback2Name: "Forest",
      }),
      expect.objectContaining({
        map: "map002", specified: true, overworld: false,
        battleback1Name: "Room", battleback2Name: "Wall",
      }),
    ]));
  });

  test("imports logical battle BGM and shared victory/defeat ME media", async () => {
    const result = await importRmProject(loadRmProject(STAGE));

    expect(result.battle.settings).toMatchObject({
      battleBgm: { name: "stage-overture", id: "bgm-stage-overture", volume: 80 },
      victoryMe: { name: "stage-fanfare", id: "me-stage-fanfare", volume: 90 },
      defeatMe: { name: "stage-fanfare", id: "me-stage-fanfare", volume: 90 },
    });
    expect(result.assets.audio).toMatchObject({
      "bgm-stage-overture": "audio/bgm-stage-overture.qoa",
      "me-stage-fanfare": "audio/me-stage-fanfare.qoa",
    });
  });

  test("resolves explicit, vehicle, and terrain-default battlebacks with stock priority", () => {
    expect(resolveRpgMakerBattlebacks({
      map: "map001", specified: true, battleback1Name: "", battleback2Name: "",
    }, { x: 2, y: 3 }, null)).toEqual({ battleback1Name: "", battleback2Name: "" });
    expect(resolveRpgMakerBattlebacks({
      map: "map001", specified: false, overworld: true, width: 10,
      battleback1Name: "", battleback2Name: "", autotileKinds: [[32, 34]],
    }, { x: 2, y: 3 }, null)).toEqual({ battleback1Name: "Lava1", battleback2Name: "Lava" });
    expect(resolveRpgMakerBattlebacks({
      map: "map001", specified: false, overworld: true, width: 10,
      battleback1Name: "", battleback2Name: "", autotileKinds: [[32, 20, 34]],
    }, { x: 2, y: 3 }, null)).toEqual({ battleback1Name: "Lava1", battleback2Name: "Forest" });
    expect(resolveRpgMakerBattlebacks({
      map: "map001", specified: false, overworld: true, width: 10,
      battleback1Name: "", battleback2Name: "", autotileKinds: [[32, 34]],
    }, { x: 2, y: 3 }, "boat")).toEqual({ battleback1Name: "Ship", battleback2Name: "Ship" });
    expect(rpgMakerBattleback1ForKind(24)).toBe("Wasteland");
    expect(rpgMakerBattleback2ForKind(20)).toBe("Forest");
  });

  test("normalizes executable troop enemy effects and records command coverage", async () => {
    const project = loadRmProject(HOLLOW);
    for (const troop of project.troops.slice(2)) {
      for (const page of troop?.pages ?? []) page.list = [{ code: 0, indent: 0, parameters: [] }];
    }
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
    expect(commandCoverage.get(337)?.reasons.join(" ")).toContain("no playable cooked legacy animation");
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

  test("finalizes shared victory and defeat ME durations before hashing battle commands", async () => {
    const fixture = () => {
      const project = loadRmProject(STAGE);
      project.maps.get(1)!.encounterList = [{ troopId: 1, weight: 1, regionSet: [] }];
      return project;
    };
    const first = await importRmProject(fixture());
    const second = await importRmProject(fixture());
    const fanfare = first.audioMedia.find((entry) => entry.kind === "me" && entry.name === "stage-fanfare");
    if (!fanfare || fanfare.status !== "success") throw new Error("stage fanfare fixture did not convert");

    expect(first.audioMedia.filter((entry) => entry.kind === "me" && entry.name === "stage-fanfare")).toHaveLength(1);
    expect(first.battle.settings?.victoryMe).toMatchObject({
      id: "me-stage-fanfare",
      durationTicks: fanfare.durationTicks,
    });
    expect(first.battle.settings?.defeatMe).toMatchObject({
      id: "me-stage-fanfare",
      durationTicks: fanfare.durationTicks,
    });
    expect(fanfare.durationTicks).toBeGreaterThan(0);

    const { databaseHash, ...content } = first.battle;
    expect(databaseHash).toBe(sha256Text(canonicalJson(content)));
    const hashes = battleSetupHashes(first.project);
    expect(hashes.length).toBeGreaterThan(0);
    expect(new Set(hashes)).toEqual(new Set([databaseHash]));
    expect(canonicalJson(second.battle)).toBe(canonicalJson(first.battle));
    expect(canonicalJson(second.project)).toBe(canonicalJson(first.project));
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
      { troopId: 1, weight: 0, regionSet: [9] },
    ];
    const result = await importRmProject(project);

    expect(result.battle.encounters).toEqual([{
      map: "map001",
      step: 17,
      entries: [
        { troopId: 1, weight: 7, regions: [2, 5] },
        { troopId: 1, weight: 3, regions: [] },
        { troopId: 1, weight: 0, regions: [9] },
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
