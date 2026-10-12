// Normalize MV/MZ's id-indexed battle database into the optional
// rpgmaker-battle/v1 module. This is build-time code: game bundles import the
// pure reducer only when they explicitly wire the generated battle.json.

import {
  parseRpgMakerFormula,
  RPGMAKER_FORMULA_FALLBACK,
  type RpgMakerFormulaNode,
} from "../../src/rpgmaker-battle/formula.ts";
import { sha256Text } from "../../src/engine/map-repository.ts";
import { canonicalJson } from "../../src/engine/save.ts";
import type {
  RpgMakerBattleDatabase,
  RpgMakerBattleEquipment,
  RpgMakerBattleItem,
  RpgMakerBattleSkill,
  RpgMakerDamage,
  RpgMakerEffect,
  RpgMakerTroopPage,
  RpgMakerTroopPageEffect,
  RpgMakerTrait,
  RpgMakerUsableItem,
} from "../../src/rpgmaker-battle/types.ts";
import type { Coverage } from "./coverage.ts";
import { itemId, mapId, switchId, variableId } from "./ids.ts";
import type {
  RmCommand,
  RmActor,
  RmDamage,
  RmEffect,
  RmItem,
  RmProject,
  RmSkill,
  RmTrait,
  RmTroopPage,
} from "./rm-types.ts";

const finite = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const integer = (value: unknown, fallback = 0): number => Math.trunc(finite(value, fallback));
const nonNegative = (value: unknown, fallback = 0): number => Math.max(0, integer(value, fallback));
const clamp = (value: unknown, lo: number, hi: number, fallback = lo): number =>
  Math.max(lo, Math.min(hi, integer(value, fallback)));

const TRAIT_SKILL_ADD = 43;
const TRAIT_EQUIP_WTYPE = 51;
const TRAIT_EQUIP_ATYPE = 52;
const TRAIT_EQUIP_SEAL = 54;
const TRAIT_SLOT_TYPE = 55;

interface InitialEquip {
  kind: "weapon" | "armor";
  item: RmItem;
}

interface InitialEquipment {
  aggregate: RpgMakerBattleDatabase["actors"][number]["equipment"];
  refs: RpgMakerBattleDatabase["actors"][number]["initialEquips"];
  slots: NonNullable<RpgMakerBattleDatabase["actors"][number]["equipSlots"]>;
  types: NonNullable<RpgMakerBattleDatabase["actors"][number]["equipTypes"]>;
}

function traitDataIds(source: readonly RmTrait[] | undefined, code: number): number[] {
  return (source ?? []).flatMap((trait) =>
    trait.code === code && Number.isInteger(trait.dataId) && trait.dataId > 0 ? [trait.dataId] : []);
}

function equipSlots(rm: RmProject, source: readonly RmTrait[]): number[] {
  const slots = Array.from({ length: Math.max(0, (rm.system.equipTypes?.length ?? 0) - 1) }, (_, index) => index + 1);
  if (slots.length >= 2 && source.some((trait) => trait.code === TRAIT_SLOT_TYPE && trait.dataId === 1)) slots[1] = 1;
  return slots;
}

function initialEquipment(
  rm: RmProject,
  actor: RmActor,
): InitialEquipment {
  const klass = rm.classes[actor.classId] ?? null;
  const baseTraits = [...(actor.traits ?? []), ...(klass?.traits ?? [])];
  const slots = equipSlots(rm, baseTraits);
  const equipped: (InitialEquip | null)[] = slots.map((slotType, slot) => {
    const id = actor.equips?.[slot] ?? 0;
    if (!Number.isInteger(id) || id <= 0) return null;
    const kind = slotType === 1 ? "weapon" : "armor";
    const item = kind === "weapon" ? rm.weapons[id] : rm.armors[id];
    return item ? { kind, item } : null;
  });

  // Match releaseUnequippableItems: equipment traits can change slots and
  // permissions, so repeat validation until a pass removes nothing.
  for (;;) {
    const allTraits = [...baseTraits, ...equipped.flatMap((entry) => entry?.item.traits ?? [])];
    const currentSlots = equipSlots(rm, allTraits);
    const weaponTypes = new Set(traitDataIds(allTraits, TRAIT_EQUIP_WTYPE));
    const armorTypes = new Set(traitDataIds(allTraits, TRAIT_EQUIP_ATYPE));
    const sealed = new Set(traitDataIds(allTraits, TRAIT_EQUIP_SEAL));
    let changed = false;
    for (let slot = 0; slot < equipped.length; slot++) {
      const entry = equipped[slot];
      if (!entry) continue;
      const permitted = entry.kind === "weapon"
        ? weaponTypes.has(entry.item.wtypeId ?? 0)
        : armorTypes.has(entry.item.atypeId ?? 0);
      if (!permitted || sealed.has(entry.item.etypeId ?? 0) || entry.item.etypeId !== currentSlots[slot]) {
        equipped[slot] = null;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const surviving = equipped.flatMap((entry) => entry ? [entry.item] : []);
  const equipTraits = surviving.flatMap((entry) => entry.traits ?? []);
  return {
    aggregate: {
      params: Array.from({ length: 8 }, (_, id) =>
        surviving.reduce((sum, entry) => sum + integer(entry.params?.[id]), 0)) as
        [number, number, number, number, number, number, number, number],
      traits: traits(equipTraits),
      skills: [...new Set(traitDataIds(equipTraits, TRAIT_SKILL_ADD))]
        .filter((id) => !!rm.skills[id])
        .sort((a, b) => a - b),
    },
    refs: equipped.map((entry) => entry ? { kind: entry.kind, id: nonNegative(entry.item.id) } : null),
    slots: slots.map((slot) => slot === 1 ? "weapon" : "armor"),
    types: slots,
  };
}

function traits(source: readonly RmTrait[] | undefined): RpgMakerTrait[] {
  return (source ?? []).map((trait) => ({
    code: integer(trait.code),
    dataId: integer(trait.dataId),
    value: finite(trait.value),
  }));
}

function effects(source: readonly RmEffect[] | undefined): RpgMakerEffect[] {
  return (source ?? []).map((effect) => ({
    code: integer(effect.code),
    dataId: integer(effect.dataId),
    value1: finite(effect.value1),
    value2: finite(effect.value2),
  }));
}

function equipmentCatalog(
  source: readonly (RmItem | null)[],
  kind: RpgMakerBattleEquipment["kind"],
): RpgMakerBattleEquipment[] {
  return source.flatMap((entry) => entry ? [{
    id: nonNegative(entry.id),
    kind,
    name: String(entry.name ?? ""),
    etypeId: nonNegative(entry.etypeId),
    typeId: nonNegative(kind === "weapon" ? entry.wtypeId : entry.atypeId),
    params: Array.from({ length: 8 }, (_, index) => integer(entry.params?.[index])) as
      [number, number, number, number, number, number, number, number],
    traits: traits(entry.traits),
  }] : []);
}

function audioSetting(source: RmProject["system"]["battleBgm"]): NonNullable<
  NonNullable<RpgMakerBattleDatabase["settings"]>["battleBgm"]
> {
  return {
    name: String(source?.name ?? ""),
    volume: finite(source?.volume, 90),
    pitch: finite(source?.pitch, 100),
    pan: finite(source?.pan),
  };
}

function damage(
  raw: RmDamage | undefined,
  cov: Coverage,
  key: string,
): RpgMakerDamage {
  const source = typeof raw?.formula === "string" && raw.formula.trim() !== "" ? raw.formula : "0";
  let formula: RpgMakerFormulaNode;
  let fallback: true | undefined;
  try {
    formula = parseRpgMakerFormula(source);
    cov.record("battle", `formula ${key}`, "Native");
  } catch (error) {
    formula = parseRpgMakerFormula(RPGMAKER_FORMULA_FALLBACK);
    fallback = true;
    cov.record(
      "battle",
      `formula ${key}`,
      "Degraded",
      `${error instanceof Error ? error.message : String(error)}; fallback ${RPGMAKER_FORMULA_FALLBACK}`,
    );
  }
  return {
    type: clamp(raw?.type, 0, 6, 0) as RpgMakerDamage["type"],
    elementId: integer(raw?.elementId),
    critical: raw?.critical === true,
    variance: clamp(raw?.variance, 0, 100, 0),
    source,
    formula,
    ...(fallback ? { fallback } : {}),
  };
}

function usable(
  raw: RmSkill | RmItem,
  cov: Coverage,
  key: string,
): RpgMakerUsableItem {
  return {
    id: nonNegative(raw.id),
    name: String(raw.name ?? ""),
    description: String(raw.description ?? ""),
    iconIndex: nonNegative(raw.iconIndex),
    scope: nonNegative(raw.scope),
    occasion: clamp(raw.occasion, 0, 3, 0),
    repeats: Math.max(1, nonNegative(raw.repeats, 1)),
    speed: integer(raw.speed),
    successRate: clamp(raw.successRate, 0, 100, 100),
    hitType: clamp(raw.hitType, 0, 2, 0) as RpgMakerUsableItem["hitType"],
    tpGain: integer(raw.tpGain),
    damage: damage(raw.damage, cov, key),
    effects: effects(raw.effects),
  };
}

/** Convert the executable subset of troop-page commands. Exported so the
 * static command catalogue measures battle-only commands through the same
 * converter used by real imports instead of reporting map-event fallbacks. */
export function convertRpgMakerTroopEffects(
  commands: readonly RmCommand[],
  cov: Coverage,
): { effects: RpgMakerTroopPageEffect[]; unsupported: number } {
  const out: RpgMakerTroopPageEffect[] = [];
  let unsupported = 0;
  const operand = (type: unknown, value: unknown) => integer(type) === 1
    ? { kind: "variable" as const, id: variableId(nonNegative(value)) }
    : { kind: "constant" as const, value: integer(value) };
  const operation = (value: unknown): "add" | "sub" => integer(value) === 0 ? "add" : "sub";
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!;
    const p = command.parameters ?? [];
    if (command.code === 0 || command.code === 401 || command.code === 408) continue;
    if (command.code === 101) {
      const lines: string[] = [];
      while (commands[i + 1]?.code === 401) lines.push(String(commands[++i]!.parameters?.[0] ?? ""));
      if (lines.length > 0) out.push({ kind: "message", lines });
      continue;
    }
    if (command.code === 121) {
      const first = nonNegative(p[0]);
      const last = Math.max(first, nonNegative(p[1], first));
      for (let id = first; id <= last; id++) out.push({ kind: "switch", id: switchId(id), value: integer(p[2]) === 0 });
      continue;
    }
    if (command.code === 122 && integer(p[3]) === 0) {
      const operations = ["set", "add", "sub", "mul", "div", "mod"] as const;
      const op = operations[integer(p[2])];
      if (op) {
        const first = nonNegative(p[0]);
        const last = Math.max(first, nonNegative(p[1], first));
        for (let id = first; id <= last; id++) {
          out.push({ kind: "variable", id: variableId(id), op, value: integer(p[4]) });
        }
        continue;
      }
    }
    if (command.code === 331) {
      out.push({
        kind: "enemyHp",
        index: integer(p[0]),
        operation: operation(p[1]),
        operand: operand(p[2], p[3]),
        allowDeath: p[4] === true,
      });
      cov.record("command", 331, "Native");
      continue;
    }
    if (command.code === 332 || command.code === 342) {
      out.push({
        kind: command.code === 332 ? "enemyMp" : "enemyTp",
        index: integer(p[0]),
        operation: operation(p[1]),
        operand: operand(p[2], p[3]),
      });
      cov.record("command", command.code, "Native");
      continue;
    }
    if (command.code === 333) {
      out.push({
        kind: "enemyState",
        index: integer(p[0]),
        operation: integer(p[1]) === 0 ? "add" : "remove",
        stateId: nonNegative(p[2]),
      });
      cov.record("command", 333, "Native");
      continue;
    }
    if (command.code === 334 || command.code === 335) {
      out.push({ kind: command.code === 334 ? "enemyRecoverAll" : "enemyAppear", index: integer(p[0]) });
      cov.record("command", command.code, "Native");
      continue;
    }
    if (command.code === 336) {
      out.push({ kind: "enemyTransform", index: integer(p[0]), enemyId: nonNegative(p[1]) });
      cov.record("command", 336, "Native");
      continue;
    }
    if (command.code === 337) {
      out.push({
        kind: "battleAnimation",
        index: integer(p[0]),
        animationId: nonNegative(p[1]),
        entireTroop: p[2] === true,
      });
      cov.record(
        "command",
        337,
        "Degraded",
        "battle animation keeps its numeric database id because no cooked animation id is available",
      );
      continue;
    }
    if (command.code === 339) {
      out.push({
        kind: "forceAction",
        side: integer(p[0]) === 0 ? "enemy" : "actor",
        subject: integer(p[1]),
        skillId: nonNegative(p[2]),
        target: integer(p[3]),
      });
      cov.record("command", 339, "Native");
      continue;
    }
    if (command.code === 340) {
      out.push({ kind: "abort" });
      cov.record("command", 340, "Native");
      continue;
    }
    // Comments are metadata, not a battle-side effect.
    if (command.code === 108) continue;
    unsupported++;
    cov.record("command", command.code, "Dropped", "battle-event command is not executable by the battle interpreter");
  }
  return { effects: out, unsupported };
}

function troopPage(page: RmTroopPage, cov: Coverage, troopId: number, index: number): RpgMakerTroopPage {
  const raw = page.conditions;
  const condition: RpgMakerTroopPage["condition"] = {};
  if (raw?.turnEnding) condition.turnEnding = true;
  if (raw?.turnValid) condition.turn = { a: nonNegative(raw.turnA), b: nonNegative(raw.turnB) };
  if (raw?.enemyValid) {
    condition.enemyHp = { index: nonNegative(raw.enemyIndex), percent: clamp(raw.enemyHp, 0, 100, 100) };
  }
  if (raw?.actorValid) {
    condition.actorHp = { actorId: nonNegative(raw.actorId), percent: clamp(raw.actorHp, 0, 100, 100) };
  }
  if (raw?.switchValid) condition.switch = switchId(nonNegative(raw.switchId));
  const converted = convertRpgMakerTroopEffects(page.list ?? [], cov);
  if (converted.unsupported > 0) {
    cov.record(
      "battle",
      `troop ${troopId} page ${index + 1}`,
      "Degraded",
      `${converted.unsupported} battle-event command(s) are not executable by the battle interpreter`,
    );
  } else {
    cov.record("battle", `troop ${troopId} page ${index + 1}`, "Native");
  }
  return {
    span: clamp(page.span, 0, 2, 0) as 0 | 1 | 2,
    condition,
    effects: converted.effects,
    unsupported: converted.unsupported,
  };
}

export interface BattleDatabaseOptions {
  enemyImage?(id: number, battlerName: string): string | undefined;
}

export function importBattleDatabase(
  rm: RmProject,
  cov: Coverage,
  options: BattleDatabaseOptions = {},
): RpgMakerBattleDatabase {
  const actors = rm.actors.flatMap((actor) => {
    if (!actor) return [];
    cov.record("battle", `actor ${actor.id}`, "Native");
    const initial = initialEquipment(rm, actor);
    return [{
      id: nonNegative(actor.id),
      name: String(actor.name ?? ""),
      nickname: String(actor.nickname ?? ""),
      profile: String(actor.profile ?? ""),
      characterName: String(actor.characterName ?? ""),
      characterIndex: nonNegative(actor.characterIndex),
      faceName: String(actor.faceName ?? ""),
      faceIndex: nonNegative(actor.faceIndex),
      battlerName: String(actor.battlerName ?? ""),
      classId: nonNegative(actor.classId),
      initialLevel: Math.max(1, nonNegative(actor.initialLevel, 1)),
      maxLevel: Math.max(1, nonNegative(actor.maxLevel, 99)),
      traits: traits(actor.traits),
      initialEquips: initial.refs,
      equipSlots: initial.slots,
      equipTypes: initial.types,
      equipment: initial.aggregate,
    }];
  });
  const weapons = equipmentCatalog(rm.weapons, "weapon");
  const armors = equipmentCatalog(rm.armors, "armor");
  const classes = rm.classes.flatMap((entry) => {
    if (!entry) return [];
    const params = Array.from({ length: 8 }, (_, param) =>
      Array.isArray(entry.params?.[param]) ? entry.params![param]!.map((value) => nonNegative(value)) : [0, 1]);
    const rawExp = entry.expParams ?? [];
    const expParams: [number, number, number, number] = [
      nonNegative(rawExp[0], 30),
      nonNegative(rawExp[1], 20),
      nonNegative(rawExp[2], 30),
      Math.max(1, nonNegative(rawExp[3], 30)),
    ];
    cov.record("battle", `class ${entry.id}`, entry.params && entry.expParams ? "Native" : "Degraded",
      entry.params && entry.expParams ? undefined : "missing parameter or experience curves use deterministic defaults");
    return [{
      id: nonNegative(entry.id),
      name: String(entry.name ?? ""),
      params,
      expParams,
      learnings: (entry.learnings ?? []).map((learning) => ({
        level: Math.max(1, nonNegative(learning.level, 1)),
        skillId: nonNegative(learning.skillId),
      })),
      traits: traits(entry.traits),
    }];
  });
  const skills: RpgMakerBattleSkill[] = rm.skills.flatMap((entry) => {
    if (!entry) return [];
    cov.record("battle", `skill ${entry.id}`, "Native");
    return [{
      ...usable(entry, cov, `skill ${entry.id}`),
      mpCost: nonNegative(entry.mpCost),
      tpCost: nonNegative(entry.tpCost),
      stypeId: nonNegative(entry.stypeId),
    }];
  });
  const items: RpgMakerBattleItem[] = rm.items.flatMap((entry) => {
    if (!entry) return [];
    cov.record("battle", `item ${entry.id}`, "Native");
    return [{ ...usable(entry, cov, `item ${entry.id}`), consumable: entry.consumable === true }];
  });
  const states = rm.states.flatMap((entry) => {
    if (!entry) return [];
    cov.record("battle", `state ${entry.id}`, "Native");
    return [{
      id: nonNegative(entry.id),
      name: String(entry.name ?? ""),
      restriction: clamp(entry.restriction, 0, 4, 0),
      priority: nonNegative(entry.priority),
      minTurns: nonNegative(entry.minTurns),
      maxTurns: Math.max(nonNegative(entry.minTurns), nonNegative(entry.maxTurns)),
      autoRemovalTiming: clamp(entry.autoRemovalTiming, 0, 2, 0),
      removeAtBattleEnd: entry.removeAtBattleEnd === true,
      removeByDamage: entry.removeByDamage === true,
      chanceByDamage: clamp(entry.chanceByDamage, 0, 100, 0),
      messages: [
        String(entry.message1 ?? ""),
        String(entry.message2 ?? ""),
        String(entry.message3 ?? ""),
        String(entry.message4 ?? ""),
      ] as [string, string, string, string],
      traits: traits(entry.traits),
    }];
  });
  const enemies = rm.enemies.flatMap((enemy) => {
    if (!enemy) return [];
    const params = Array.from({ length: 8 }, (_, index) => nonNegative(enemy.params?.[index])) as
      [number, number, number, number, number, number, number, number];
    const image = options.enemyImage?.(enemy.id, String(enemy.battlerName ?? ""));
    cov.record("battle", `enemy ${enemy.id}`, image || !enemy.battlerName ? "Native" : "Degraded",
      image || !enemy.battlerName ? undefined : `battler image ${enemy.battlerName}.png is missing`);
    return [{
      id: nonNegative(enemy.id),
      name: String(enemy.name ?? ""),
      params,
      exp: nonNegative(enemy.exp),
      gold: nonNegative(enemy.gold),
      ...(image ? { image } : {}),
      actions: (enemy.actions ?? []).map((action) => ({
        skillId: nonNegative(action.skillId),
        rating: clamp(action.rating, 1, 9, 5),
        conditionType: nonNegative(action.conditionType),
        conditionParam1: finite(action.conditionParam1),
        conditionParam2: finite(action.conditionParam2),
      })),
      drops: (enemy.dropItems ?? []).map((drop) => ({
        kind: clamp(drop.kind, 0, 3, 0),
        dataId: nonNegative(drop.dataId),
        denominator: Math.max(1, nonNegative(drop.denominator, 1)),
        ...(drop.kind === 1 ? { item: itemId("item", drop.dataId) }
          : drop.kind === 2 ? { item: itemId("weapon", drop.dataId) }
          : drop.kind === 3 ? { item: itemId("armor", drop.dataId) }
          : {}),
      })),
      traits: traits(enemy.traits),
    }];
  });
  const troops = rm.troops.flatMap((troop) => {
    if (!troop) return [];
    cov.record("battle", `troop ${troop.id}`, "Native");
    return [{
      id: nonNegative(troop.id),
      name: String(troop.name ?? ""),
      members: (troop.members ?? []).map((member) => ({
        enemyId: nonNegative(member.enemyId),
        x: integer(member.x),
        y: integer(member.y),
        hidden: member.hidden === true,
      })),
      pages: (troop.pages ?? []).map((page, index) => troopPage(page, cov, troop.id, index)),
    }];
  });
  const encounters = [...rm.maps.entries()]
    .filter(([, map]) => (map.encounterList?.length ?? 0) > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([id, map]) => ({
      map: mapId(id),
      step: Math.max(1, nonNegative(map.encounterStep, 30)),
      entries: map.encounterList.map((entry) => ({
        troopId: nonNegative(entry.troopId),
        weight: nonNegative(entry.weight, 1),
        regions: (entry.regionSet ?? []).map((region) => nonNegative(region)),
      })),
    }));

  if (rm.system.optSideView === true) {
    cov.record("battle", "presentation", "Degraded", "side-view projects use the deterministic front-view renderer");
  } else {
    cov.record("battle", "presentation", "Native");
  }
  const commands = rm.system.terms?.commands ?? [];
  const basic = rm.system.terms?.basic ?? [];
  const messages = rm.system.terms?.messages ?? {};
  const params = rm.system.terms?.params ?? [];
  const message = (key: string, fallback: string): string => String(messages[key] ?? fallback);
  const database: Omit<RpgMakerBattleDatabase, "databaseHash"> = {
    format: "rpgmaker-battle/v1",
    flavor: rm.flavor,
    sideView: rm.system.optSideView === true,
    displayTp: rm.system.optDisplayTp === true,
    screen: {
      width: Math.max(1, nonNegative(rm.system.advanced?.screenWidth, 816)),
      height: Math.max(1, nonNegative(rm.system.advanced?.screenHeight, 624)),
    },
    party: (rm.system.partyMembers ?? []).map((id) => nonNegative(id)).filter((id) => id > 0),
    actors,
    weapons,
    armors,
    classes,
    enemies,
    troops,
    skills,
    items,
    states,
    encounters,
    elements: (rm.system.elements ?? []).map((entry) => String(entry ?? "")),
    currencyUnit: String(rm.system.currencyUnit ?? "G"),
    settings: {
      battleBgm: audioSetting(rm.system.battleBgm),
      victoryMe: audioSetting(rm.system.victoryMe),
      defeatMe: audioSetting(rm.system.defeatMe),
      encounterDisabled: false,
    },
    mapSettings: [...rm.maps.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, map]) => ({
        map: mapId(id),
        battleback1Name: String(map.battleback1Name ?? ""),
        battleback2Name: String(map.battleback2Name ?? ""),
      })),
    terms: {
      fight: String(commands[0] ?? "Fight"),
      escape: String(commands[1] ?? "Escape"),
      attack: String(commands[2] ?? "Attack"),
      guard: String(commands[3] ?? "Guard"),
      item: String(commands[4] ?? "Item"),
      skill: String(commands[5] ?? "Skill"),
      basic: {
        level: String(basic[0] ?? "Level"),
        levelAbbr: String(basic[1] ?? "Lv"),
        hp: String(basic[2] ?? "HP"),
        hpAbbr: String(basic[3] ?? "HP"),
        mp: String(basic[4] ?? "MP"),
        mpAbbr: String(basic[5] ?? "MP"),
        tp: String(basic[6] ?? "TP"),
        tpAbbr: String(basic[7] ?? "TP"),
        exp: String(basic[8] ?? "EXP"),
        expAbbr: String(basic[9] ?? "EXP"),
      },
      params: Array.from({ length: 8 }, (_, index) => String(params[index] ?? [
        "Max HP", "Max MP", "Attack", "Defense", "M.Attack", "M.Defense", "Agility", "Luck",
      ][index]!)),
      messages: {
        actionFailure: message("actionFailure", "There was no effect on %1!"),
        actorDamage: message("actorDamage", "%1 took %2 damage!"),
        enemyDamage: message("enemyDamage", "%1 took %2 damage!"),
        actorRecovery: message("actorRecovery", "%1 recovered %2 %3!"),
        enemyRecovery: message("enemyRecovery", "%1 recovered %2 %3!"),
        actorLoss: message("actorLoss", "%1 lost %2 %3!"),
        enemyLoss: message("enemyLoss", "%1 lost %2 %3!"),
        actorNoDamage: message("actorNoDamage", "%1 took no damage!"),
        enemyNoDamage: message("enemyNoDamage", "%1 took no damage!"),
        actorNoHit: message("actorNoHit", "Miss! %1 took no damage!"),
        enemyNoHit: message("enemyNoHit", "Miss! %1 took no damage!"),
        actorEvasion: message("actorEvasion", "%1 evaded the attack!"),
        enemyEvasion: message("enemyEvasion", "%1 evaded the attack!"),
        actorMagicEvasion: message("actorMagicEvasion", "%1 nullified the magic!"),
        enemyMagicEvasion: message("enemyMagicEvasion", "%1 nullified the magic!"),
        criticalToActor: message("criticalToActor", "A painful blow!!"),
        criticalToEnemy: message("criticalToEnemy", "An excellent hit!!"),
        useItem: message("useItem", "%1 uses %2!"),
        emerge: message("emerge", "%1 emerged!"),
        escapeStart: message("escapeStart", "%1 has started to escape!"),
        escapeFailure: message("escapeFailure", "However, it was unable to escape!"),
        victory: message("victory", "%1 was victorious!"),
        defeat: message("defeat", "%1 was defeated."),
        obtainExp: message("obtainExp", "%1 %2 received!"),
        obtainGold: message("obtainGold", "%1\\G found!"),
        obtainItem: message("obtainItem", "%1 found!"),
        levelUp: message("levelUp", "%1 is now %2 %3!"),
      },
    },
  };
  return { ...database, databaseHash: sha256Text(canonicalJson(database)) };
}

