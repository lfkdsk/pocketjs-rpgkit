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

function troopEffects(commands: readonly RmCommand[]): { effects: RpgMakerTroopPageEffect[]; unsupported: number } {
  const out: RpgMakerTroopPageEffect[] = [];
  let unsupported = 0;
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
    // Comments are metadata, not a battle-side effect.
    if (command.code === 108) continue;
    unsupported++;
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
  const converted = troopEffects(page.list ?? []);
  if (converted.unsupported > 0) {
    cov.record(
      "battle",
      `troop ${troopId} page ${index + 1}`,
      "Degraded",
      `${converted.unsupported} battle-event command(s) are outside the message/switch/constant-variable subset`,
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
    return [{
      id: nonNegative(actor.id),
      name: String(actor.name ?? ""),
      classId: nonNegative(actor.classId),
      initialLevel: Math.max(1, nonNegative(actor.initialLevel, 1)),
      maxLevel: Math.max(1, nonNegative(actor.maxLevel, 99)),
      traits: traits(actor.traits),
    }];
  });
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
        weight: Math.max(1, nonNegative(entry.weight, 1)),
        regions: (entry.regionSet ?? []).map((region) => nonNegative(region)),
      })),
    }));

  if (rm.system.optSideView === true) {
    cov.record("battle", "presentation", "Degraded", "side-view projects use the deterministic front-view renderer");
  } else {
    cov.record("battle", "presentation", "Native");
  }
  const commands = rm.system.terms?.commands ?? [];
  const messages = rm.system.terms?.messages ?? {};
  const database: Omit<RpgMakerBattleDatabase, "databaseHash"> = {
    format: "rpgmaker-battle/v1",
    flavor: rm.flavor,
    sideView: rm.system.optSideView === true,
    party: (rm.system.partyMembers ?? []).map((id) => nonNegative(id)).filter((id) => id > 0),
    actors,
    classes,
    enemies,
    troops,
    skills,
    items,
    states,
    encounters,
    elements: (rm.system.elements ?? []).map((entry) => String(entry ?? "")),
    currencyUnit: String(rm.system.currencyUnit ?? "G"),
    terms: {
      fight: String(commands[0] ?? "Fight"),
      escape: String(commands[1] ?? "Escape"),
      attack: String(commands[2] ?? "Attack"),
      guard: String(commands[3] ?? "Guard"),
      item: String(commands[4] ?? "Item"),
      skill: String(commands[5] ?? "Skill"),
      victory: String(messages.victory ?? "%1 was victorious!"),
      defeat: String(messages.defeat ?? "%1 was defeated."),
    },
  };
  return { ...database, databaseHash: sha256Text(canonicalJson(database)) };
}

