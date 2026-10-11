// Pure, opt-in RPG Maker MV/MZ front-view battle reducer. The generic
// session owns lifecycle only; every menu cursor, RNG draw, action, reward
// and animation clock lives in this JSON state so replay/rewind are exact.

import { deepClone } from "../engine/clone.ts";
import { rngNext } from "../engine/interpreter.ts";
import type { BattleCompletion, BattleRules } from "../engine/battle.ts";
import type { ExtensionOptions, ExtensionReadContext } from "../engine/extensions.ts";
import type { ExtensionCommandContext, ExtensionCommandResult } from "../engine/extensions.ts";
import type { JsonValue, VariableValue } from "../engine/types.ts";
import { evaluateRpgMakerDamageBase, type RpgMakerFormulaBattler } from "./formula.ts";
import type {
  RpgMakerActorRuntime,
  RpgMakerBattleAction,
  RpgMakerBattleCombatant,
  RpgMakerBattleDatabase,
  RpgMakerBattleItem,
  RpgMakerBattleRuntime,
  RpgMakerBattleSkill,
  RpgMakerBattleState,
  RpgMakerBattleStateDef,
  RpgMakerBattleTroop,
  RpgMakerEffect,
  RpgMakerTrait,
  RpgMakerUsableItem,
} from "./types.ts";

const EFFECT_TICKS = 18;
const MESSAGE_CHARS_PER_TICK = 2;
const PARAM_MAX = [999_999, 9_999, 999, 999, 999, 999, 999, 999] as const;

/** Reserved importer/runtime handshake for stock walking encounters. */
export const RPGMAKER_ENCOUNTER_STEP_CALL = "rpgmaker.encounterStep";
export const RPGMAKER_ENCOUNTER_DUE_VARIABLE = "rmi-encounter-due";

interface RpgMakerBattleSetup {
  system?: unknown;
  databaseHash?: unknown;
  troop?: unknown;
  troopVariable?: unknown;
  encounter?: unknown;
  map?: unknown;
  canEscape?: unknown;
  canLose?: unknown;
}

const object = (value: unknown): Record<string, JsonValue> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};

const integer = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

const itemKey = (id: number): string => `item${String(id).padStart(3, "0")}`;
const switchKey = (id: number): string => `s${String(id).padStart(3, "0")}`;
const partySwitchKey = (id: number): string => `party-actor${String(id).padStart(3, "0")}`;
const partyOutSwitchKey = (id: number): string => `party-out-actor${String(id).padStart(3, "0")}`;

function jsonState(state: RpgMakerBattleState): JsonValue {
  return state as unknown as JsonValue;
}

export function rpgMakerBattleState(value: JsonValue): Readonly<RpgMakerBattleState> {
  return value as unknown as RpgMakerBattleState;
}

function mutableState(value: JsonValue): RpgMakerBattleState {
  return deepClone(value) as unknown as RpgMakerBattleState;
}

function draw(state: RpgMakerBattleState): number {
  const next = rngNext(state.rng);
  state.rng = next.next;
  return next.value;
}

function drawInt(state: RpgMakerBattleState, span: number): number {
  return span > 0 ? Math.floor(draw(state) * span) : 0;
}

function findById<T extends { id: number }>(values: readonly T[], id: number): T | undefined {
  return values.find((value) => value.id === id);
}

export function rpgMakerExpForLevel(
  db: RpgMakerBattleDatabase,
  classId: number,
  level: number,
): number {
  const klass = findById(db.classes, classId);
  if (!klass || level <= 1) return 0;
  const [basis, extra, accelerationA, accelerationB] = klass.expParams;
  const safeB = Math.max(1, accelerationB);
  const value = basis * Math.pow(level - 1, 0.9 + accelerationA / 250) * level * (level + 1) /
    (6 + Math.pow(level, 2) / 50 / safeB) + (level - 1) * extra;
  return Math.max(0, Math.round(value));
}

function actorBaseParams(
  db: RpgMakerBattleDatabase,
  actorId: number,
  classId: number,
  level: number,
): [number, number, number, number, number, number, number, number] {
  const actor = findById(db.actors, actorId);
  const klass = findById(db.classes, classId);
  return Array.from({ length: 8 }, (_, id) => Math.max(0,
    integer(klass?.params[id]?.[level]) + integer(actor?.equipment.params[id]))) as
    [number, number, number, number, number, number, number, number];
}

function stateDef(db: RpgMakerBattleDatabase, id: number): RpgMakerBattleStateDef | undefined {
  return findById(db.states, id);
}

function combatantTraits(db: RpgMakerBattleDatabase, battler: RpgMakerBattleCombatant): RpgMakerTrait[] {
  const base = battler.side === "actor"
    ? [
        ...(findById(db.actors, battler.databaseId)?.traits ?? []),
        ...(findById(db.actors, battler.databaseId)?.equipment.traits ?? []),
        ...(findById(db.classes, battler.actor?.classId ?? 0)?.traits ?? []),
      ]
    : [...(findById(db.enemies, battler.databaseId)?.traits ?? [])];
  for (const state of battler.states) base.push(...(stateDef(db, state.id)?.traits ?? []));
  return base;
}

function traitProduct(
  db: RpgMakerBattleDatabase,
  battler: RpgMakerBattleCombatant,
  code: number,
  dataId: number,
): number {
  let value = 1;
  for (const trait of combatantTraits(db, battler)) {
    if (trait.code === code && trait.dataId === dataId) value *= trait.value;
  }
  return value;
}

function traitSum(
  db: RpgMakerBattleDatabase,
  battler: RpgMakerBattleCombatant,
  code: number,
  dataId: number,
): number {
  let value = 0;
  for (const trait of combatantTraits(db, battler)) {
    if (trait.code === code && trait.dataId === dataId) value += trait.value;
  }
  return value;
}

function hasTrait(
  db: RpgMakerBattleDatabase,
  battler: RpgMakerBattleCombatant,
  code: number,
  dataId: number,
): boolean {
  return combatantTraits(db, battler).some((trait) => trait.code === code && trait.dataId === dataId);
}

function partyAbility(db: RpgMakerBattleDatabase, state: RpgMakerBattleState, dataId: number): boolean {
  return state.actors.some((actor) => hasTrait(db, actor, 64, dataId));
}

export function rpgMakerCombatantParam(
  db: RpgMakerBattleDatabase,
  battler: Readonly<RpgMakerBattleCombatant>,
  paramId: number,
): number {
  const id = clamp(Math.trunc(paramId), 0, 7);
  const base = battler.params[id] ?? 0;
  const traitRate = traitProduct(db, battler as RpgMakerBattleCombatant, 21, id);
  const buffRate = 1 + clamp(battler.buffs[id]?.level ?? 0, -2, 2) * 0.25;
  return clamp(Math.round(base * traitRate * buffRate), id === 0 ? 1 : 0, PARAM_MAX[id]!);
}

function formulaBattler(db: RpgMakerBattleDatabase, battler: RpgMakerBattleCombatant): RpgMakerFormulaBattler {
  return {
    hp: battler.hp,
    mp: battler.mp,
    tp: battler.tp,
    mhp: rpgMakerCombatantParam(db, battler, 0),
    mmp: rpgMakerCombatantParam(db, battler, 1),
    atk: rpgMakerCombatantParam(db, battler, 2),
    def: rpgMakerCombatantParam(db, battler, 3),
    mat: rpgMakerCombatantParam(db, battler, 4),
    mdf: rpgMakerCombatantParam(db, battler, 5),
    agi: rpgMakerCombatantParam(db, battler, 6),
    luk: rpgMakerCombatantParam(db, battler, 7),
    level: battler.actor?.level ?? 1,
  };
}

function numericVariables(values: Readonly<Record<string, number | string>>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, value] of Object.entries(values)) {
    const match = /^v0*([0-9]+)$/.exec(id);
    if (match && typeof value === "number" && Number.isFinite(value)) out[Number(match[1])] = value;
  }
  return out;
}

function restriction(db: RpgMakerBattleDatabase, battler: RpgMakerBattleCombatant): number {
  let result = 0;
  for (const state of battler.states) result = Math.max(result, stateDef(db, state.id)?.restriction ?? 0);
  return result;
}

const alive = (battler: RpgMakerBattleCombatant): boolean => battler.hp > 0 && !battler.hidden;

function resetStateTurns(db: RpgMakerBattleDatabase, state: RpgMakerBattleState, id: number): number {
  const definition = stateDef(db, id);
  if (!definition) return 0;
  const min = Math.max(0, definition.minTurns);
  const span = Math.max(1, definition.maxTurns - min + 1);
  // Game_BattlerBase.resetStateCounts calls randomInt even for a fixed
  // one-value range; preserving that draw keeps later outcomes aligned.
  return min + drawInt(state, span);
}

function clearBuffs(battler: RpgMakerBattleCombatant): void {
  for (const buff of battler.buffs) {
    buff.level = 0;
    buff.turns = 0;
  }
}

function die(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  battler: RpgMakerBattleCombatant,
  knockoutTurns = resetStateTurns(db, state, 1),
): void {
  battler.hp = 0;
  battler.states = [];
  clearBuffs(battler);
  if (stateDef(db, 1)) battler.states.push({ id: 1, turns: knockoutTurns });
}

function setHp(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  battler: RpgMakerBattleCombatant,
  value: number,
): void {
  const next = clamp(Math.round(value), 0, rpgMakerCombatantParam(db, battler, 0));
  if (next === 0) {
    if (battler.hp > 0 || !battler.states.some((active) => active.id === 1)) die(db, state, battler);
    else battler.hp = 0;
    return;
  }
  battler.hp = next;
  const knockout = battler.states.findIndex((active) => active.id === 1);
  if (knockout >= 0) battler.states.splice(knockout, 1);
}

function initialActorRuntime(db: RpgMakerBattleDatabase, actorId: number): RpgMakerActorRuntime | null {
  const actor = findById(db.actors, actorId);
  const klass = actor ? findById(db.classes, actor.classId) : undefined;
  if (!actor || !klass) return null;
  const level = clamp(actor.initialLevel, 1, actor.maxLevel);
  const skills = [
    ...klass.learnings.filter((learning) => learning.level <= level).map((learning) => learning.skillId),
    ...actor.equipment.skills,
    ...[...actor.traits, ...klass.traits]
      .filter((trait) => trait.code === 43)
      .map((trait) => trait.dataId),
  ];
  return {
    actorId,
    classId: actor.classId,
    level,
    exp: rpgMakerExpForLevel(db, actor.classId, level),
    // Negative values are an internal construction sentinel; published
    // runtime records always contain the full initial HP/MP computed below.
    hp: -1,
    mp: -1,
    tp: 0,
    skills: [...new Set(skills)].sort((a, b) => a - b),
    states: [],
    buffs: Array(8).fill(0),
  };
}

function runtimeRoot(ext: JsonValue): { root: Record<string, JsonValue>; runtime: RpgMakerBattleRuntime } {
  const root = object(ext);
  const raw = object(root.rpgmakerBattle);
  const actorsRaw = object(raw.actors);
  const actors: Record<string, RpgMakerActorRuntime> = {};
  for (const [id, value] of Object.entries(actorsRaw)) {
    const record = object(value);
    if (integer(record.actorId) <= 0) continue;
    actors[id] = deepClone(record) as unknown as RpgMakerActorRuntime;
  }
  const encounterRaw = object(raw.encounter);
  const encounter = typeof encounterRaw.map === "string" && encounterRaw.map.length > 0
    ? { map: encounterRaw.map, remaining: Math.max(0, integer(encounterRaw.remaining)) }
    : null;
  return {
    root,
    runtime: {
      version: 1,
      actors,
      battleCount: Math.max(0, integer(raw.battleCount)),
      winCount: Math.max(0, integer(raw.winCount)),
      escapeCount: Math.max(0, integer(raw.escapeCount)),
      encounter,
    },
  };
}

/** MV/MZ Game_Player.makeEncounterCount: two uniform integer draws in
 * [0, encounterStep), plus one. The cursor belongs to SessionState and is
 * advanced only on map entry/reset, never by presentation. */
function nextEncounterCount(step: number, random: () => number): number {
  const n = Math.max(1, integer(step, 30));
  return Math.floor(random() * n) + Math.floor(random() * n) + 1;
}

/** Opt-in stock walking-encounter integration. The importer installs one
 * hidden parallel Battle Processing event on maps with encounter tables;
 * this player-step hook owns only the saved countdown and raises its private
 * variable when that event should run. Games without this registration pay
 * no step-hook cost and never import this module. */
function encounterStepHandler(db: RpgMakerBattleDatabase) {
  return (context: ExtensionCommandContext): ExtensionCommandResult => {
    const { root, runtime } = runtimeRoot(context.ext);
    const mapId = context.mapId;
    const encounter = mapId ? db.encounters.find((entry) => entry.map === mapId) : undefined;
    if (!encounter || encounter.entries.length === 0) {
      runtime.encounter = null;
      return {
        ext: withRuntime(root, runtime),
        writes: { [RPGMAKER_ENCOUNTER_DUE_VARIABLE]: 0 },
      };
    }
    const previous = runtime.encounter;
    let remaining = previous !== null && previous.map === mapId
      ? previous.remaining
      : nextEncounterCount(encounter.step, context.random);
    remaining--;
    const due = remaining <= 0;
    if (due) remaining = nextEncounterCount(encounter.step, context.random);
    runtime.encounter = { map: mapId!, remaining };
    return {
      ext: withRuntime(root, runtime),
      writes: { [RPGMAKER_ENCOUNTER_DUE_VARIABLE]: due ? 1 : 0 },
    };
  };
}

function contextAfterResult(
  context: ExtensionCommandContext,
  result: ExtensionCommandResult | void,
): ExtensionCommandContext {
  if (!result) return context;
  return {
    ...context,
    ext: result.ext === undefined ? context.ext : result.ext,
    variables: result.writes ? { ...context.variables, ...result.writes } : context.variables,
    items: result.items ? { ...context.items, ...result.items } : context.items,
    gold: result.gold ?? context.gold,
  };
}

function mergeCommandResults(
  first: ExtensionCommandResult | void,
  second: ExtensionCommandResult | void,
): ExtensionCommandResult | void {
  if (!first) return second;
  if (!second) return first;
  return {
    ...(first.ext === undefined ? {} : { ext: first.ext }),
    ...(first.writes ? { writes: first.writes } : {}),
    ...(first.items ? { items: first.items } : {}),
    ...(first.gold === undefined ? {} : { gold: first.gold }),
    ...(second.ext === undefined ? {} : { ext: second.ext }),
    ...((first.writes || second.writes) ? { writes: { ...first.writes, ...second.writes } } : {}),
    ...((first.items || second.items) ? { items: { ...first.items, ...second.items } } : {}),
    ...(second.gold === undefined ? {} : { gold: second.gold }),
  };
}

/** Add walking encounters without replacing an existing extension registry.
 * Command names are collision-checked. When another player-step hook exists,
 * one deterministic wrapper runs it first and lets the encounter hook observe
 * its returned ext/banks. Existing codecs and validators are preserved; as
 * with every namespaced extension, they must retain/accept unknown siblings. */
export function augmentRpgMakerBattleExtensions(
  base: ExtensionOptions,
  db: RpgMakerBattleDatabase,
): ExtensionOptions {
  const commands = { ...(base.commands ?? {}) };
  if (commands[RPGMAKER_ENCOUNTER_STEP_CALL]) {
    throw new Error(`RPG Maker encounter extension command collision: ${RPGMAKER_ENCOUNTER_STEP_CALL}`);
  }
  const encounter = encounterStepHandler(db);
  commands[RPGMAKER_ENCOUNTER_STEP_CALL] = encounter;
  if (!base.playerStep) {
    return { ...base, commands, playerStep: { call: RPGMAKER_ENCOUNTER_STEP_CALL } };
  }

  const previous = commands[base.playerStep.call];
  if (!previous) throw new Error(`RPG Maker encounter extension cannot find player-step command ${base.playerStep.call}`);
  const composedCall = "rpgmaker.composedEncounterStep";
  if (commands[composedCall]) throw new Error(`RPG Maker encounter extension command collision: ${composedCall}`);
  const previousArgs = base.playerStep.args ?? null;
  commands[composedCall] = (context) => {
    const first = previous(context, previousArgs);
    if (context.playerStep?.kind === "relocation") return first;
    const second = encounter(contextAfterResult(context, first));
    return mergeCommandResults(first, second);
  };
  return {
    ...base,
    commands,
    playerStep: {
      call: composedCall,
      displacement: base.playerStep.displacement === true,
    },
  };
}

export function createRpgMakerBattleExtensions(db: RpgMakerBattleDatabase): ExtensionOptions {
  return augmentRpgMakerBattleExtensions({}, db);
}

function withRuntime(ext: JsonValue, runtime: RpgMakerBattleRuntime): JsonValue {
  return { ...object(ext), rpgmakerBattle: runtime as unknown as JsonValue };
}

function actorCombatant(
  db: RpgMakerBattleDatabase,
  runtime: RpgMakerActorRuntime,
  index: number,
): RpgMakerBattleCombatant | null {
  const actor = findById(db.actors, runtime.actorId);
  const klass = actor ? findById(db.classes, runtime.classId) : undefined;
  if (!actor || !klass) return null;
  const level = clamp(runtime.level, 1, actor.maxLevel);
  const params = actorBaseParams(db, actor.id, runtime.classId, level);
  const combatant: RpgMakerBattleCombatant = {
    key: `actor${String(runtime.actorId).padStart(3, "0")}`,
    side: "actor",
    databaseId: runtime.actorId,
    name: actor.name,
    hp: runtime.hp,
    mp: runtime.mp,
    tp: clamp(runtime.tp, 0, 100),
    params,
    states: (runtime.states ?? []).map((state) => ({ id: state.id, turns: Math.max(0, integer(state.turns)) })),
    buffs: Array.from({ length: 8 }, () => ({ level: 0, turns: 0 })),
    guarding: false,
    hidden: false,
    actor: {
      classId: runtime.classId,
      level,
      exp: Math.max(0, integer(runtime.exp)),
      skills: [...new Set(runtime.skills ?? [])].sort((a, b) => a - b),
    },
  };
  const mhp = rpgMakerCombatantParam(db, combatant, 0);
  const mmp = rpgMakerCombatantParam(db, combatant, 1);
  combatant.hp = runtime.hp < 0 ? mhp : clamp(runtime.hp, 0, mhp);
  combatant.mp = runtime.mp < 0 ? mmp : clamp(runtime.mp, 0, mmp);
  void index;
  return combatant;
}

function enemyCombatant(
  db: RpgMakerBattleDatabase,
  troop: RpgMakerBattleTroop,
  member: RpgMakerBattleTroop["members"][number],
  index: number,
): RpgMakerBattleCombatant | null {
  const enemy = findById(db.enemies, member.enemyId);
  if (!enemy) return null;
  return {
    key: `enemy${String(index + 1).padStart(2, "0")}`,
    side: "enemy",
    databaseId: enemy.id,
    name: enemy.name,
    hp: Math.max(1, enemy.params[0]),
    mp: Math.max(0, enemy.params[1]),
    tp: 0,
    params: [...enemy.params],
    states: [],
    buffs: Array.from({ length: 8 }, () => ({ level: 0, turns: 0 })),
    guarding: false,
    hidden: member.hidden,
    ...(enemy.image ? { image: enemy.image } : {}),
  };
}

function chooseEncounterTroop(
  db: RpgMakerBattleDatabase,
  setup: RpgMakerBattleSetup,
  state: Pick<RpgMakerBattleState, "rng">,
  context: ExtensionReadContext,
): number {
  const map = typeof setup.map === "string" ? setup.map : context.mapId;
  if (!map) return 0;
  const encounter = db.encounters.find((entry) => entry.map === map);
  if (!encounter) return 0;
  const region = context.playerCell?.region ?? 0;
  const eligible = encounter.entries.filter((entry) => entry.regions.length === 0 || entry.regions.includes(region));
  const total = eligible.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return 0;
  const holder = state as RpgMakerBattleState;
  let cursor = draw(holder) * total;
  for (const entry of eligible) {
    cursor -= Math.max(0, entry.weight);
    if (cursor < 0) return entry.troopId;
  }
  return eligible[eligible.length - 1]!.troopId;
}

function resolveTroopId(
  db: RpgMakerBattleDatabase,
  setup: RpgMakerBattleSetup,
  state: Pick<RpgMakerBattleState, "rng">,
  context: ExtensionReadContext,
): number {
  if (setup.encounter === true) return chooseEncounterTroop(db, setup, state, context);
  if (typeof setup.troopVariable === "string") {
    return Math.max(0, integer(context.variables[setup.troopVariable]));
  }
  return Math.max(0, integer(setup.troop));
}

function cloneVariables(values: Readonly<Record<string, VariableValue>>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [id, value] of Object.entries(values)) {
    if (typeof value === "number" || typeof value === "string") out[id] = value;
  }
  return out;
}

function cloneNumbers(values: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(values)) out[id] = Math.max(0, integer(value));
  return out;
}

function showMessage(
  state: RpgMakerBattleState,
  message: string,
  after: RpgMakerBattleState["afterMessage"],
): void {
  state.phase = "message";
  state.message = message;
  state.messageStart = state.nowTick;
  state.afterMessage = after;
}

export function rpgMakerMessageRevealed(state: Readonly<RpgMakerBattleState>): number {
  if (state.phase !== "message") return 0;
  return Math.min(state.message.length, Math.max(0, state.nowTick - state.messageStart) * MESSAGE_CHARS_PER_TICK);
}

function pageConditionHolds(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  page: RpgMakerBattleTroop["pages"][number],
  turnEnding: boolean,
): boolean {
  const condition = page.condition;
  const any = condition.turnEnding || condition.turn || condition.enemyHp || condition.actorHp || condition.switch;
  if (!any) return false;
  if (condition.turnEnding && !turnEnding) return false;
  if (condition.turn) {
    const { a, b } = condition.turn;
    if (b === 0 ? state.turn !== a : state.turn < 1 || state.turn < a || state.turn % b !== a % b) return false;
  }
  if (condition.enemyHp) {
    const enemy = state.enemies[condition.enemyHp.index];
    if (!enemy || 100 * enemy.hp > condition.enemyHp.percent * rpgMakerCombatantParam(db, enemy, 0)) return false;
  }
  if (condition.actorHp) {
    const actor = state.actors.find((entry) => entry.databaseId === condition.actorHp!.actorId);
    if (!actor || 100 * actor.hp > condition.actorHp.percent * rpgMakerCombatantParam(db, actor, 0)) return false;
  }
  if (condition.switch && state.switches[condition.switch] !== true) return false;
  return true;
}

function applyVariableOperation(current: number, op: string, value: number): number {
  switch (op) {
    case "set": return value;
    case "add": return current + value;
    case "sub": return current - value;
    case "mul": return current * value;
    case "div": return value === 0 ? 0 : current / value;
    case "mod": return value === 0 ? 0 : current % value;
    default: return current;
  }
}

function runTroopPages(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  turnEnding: boolean,
): string[] {
  const troop = findById(db.troops, state.troopId);
  if (!troop) return [];
  for (let index = 0; index < troop.pages.length; index++) {
    const page = troop.pages[index]!;
    const run = state.pageRuns[index] ??= { battle: false, lastTurn: -1, active: false };
    const holds = pageConditionHolds(db, state, page, turnEnding);
    const eligible = holds && (
      page.span === 0 ? !run.battle :
      page.span === 1 ? run.lastTurn !== state.turn :
      true
    );
    run.active = holds;
    if (!eligible) continue;
    if (page.span === 0) run.battle = true;
    if (page.span === 1) run.lastTurn = state.turn;
    const messages: string[] = [];
    for (const effect of page.effects) {
      if (effect.kind === "message") messages.push(effect.lines.join("\n"));
      else if (effect.kind === "switch") state.switches[effect.id] = effect.value;
      else {
        const current = typeof state.variables[effect.id] === "number" ? state.variables[effect.id] as number : 0;
        const next = applyVariableOperation(current, effect.op, effect.value);
        state.variables[effect.id] = Number.isFinite(next) ? Math.trunc(next) : 0;
      }
    }
    // Game_Troop.setupBattleEvent starts the first eligible page only. A
    // moment page stays eligible after its interpreter becomes idle; battle
    // and turn pages are gated by their persistent/per-turn flags above.
    return messages;
  }
  return [];
}

function usableForAction(
  db: RpgMakerBattleDatabase,
  action: RpgMakerBattleAction,
): RpgMakerBattleSkill | RpgMakerBattleItem | undefined {
  return action.kind === "item" ? findById(db.items, action.id) : findById(db.skills, action.id);
}

function skillAffordable(actor: RpgMakerBattleCombatant, skill: RpgMakerBattleSkill): boolean {
  return actor.mp >= skill.mpCost && actor.tp >= skill.tpCost;
}

export function rpgMakerSkillChoices(
  db: RpgMakerBattleDatabase,
  state: Readonly<RpgMakerBattleState>,
): RpgMakerBattleSkill[] {
  const actor = state.actors[state.actorIndex];
  if (!actor?.actor) return [];
  const ids = new Set([
    ...actor.actor.skills,
    ...combatantTraits(db, actor).filter((trait) => trait.code === 43).map((trait) => trait.dataId),
  ]);
  return [...ids].sort((a, b) => a - b).flatMap((id) => {
    const skill = findById(db.skills, id);
    return skill && skill.occasion !== 2 && skill.occasion !== 3 ? [skill] : [];
  });
}

export function rpgMakerItemChoices(
  db: RpgMakerBattleDatabase,
  state: Readonly<RpgMakerBattleState>,
): RpgMakerBattleItem[] {
  return db.items.filter((item) =>
    (state.items[itemKey(item.id)] ?? 0) > 0 && item.occasion !== 2 && item.occasion !== 3 && item.scope !== 0);
}

function targetSide(scope: number): "actor" | "enemy" | "user" | null {
  if (scope >= 1 && scope <= 6) return "enemy";
  if (scope >= 7 && scope <= 10) return "actor";
  if (scope === 11) return "user";
  return null;
}

function scopeNeedsSelection(scope: number): boolean {
  return scope === 1 || scope === 7 || scope === 9;
}

function isDeadScope(scope: number): boolean {
  return scope === 9 || scope === 10;
}

function selectableTargets(state: RpgMakerBattleState, usable: RpgMakerUsableItem): number[] {
  const side = targetSide(usable.scope);
  const list = side === "enemy" ? state.enemies : state.actors;
  if (!list) return [];
  const dead = isDeadScope(usable.scope);
  return list.flatMap((target, index) => target.hidden || (dead ? target.hp > 0 : target.hp <= 0) ? [] : [index]);
}

function currentActorCanInput(db: RpgMakerBattleDatabase, actor: RpgMakerBattleCombatant): boolean {
  return alive(actor) && restriction(db, actor) === 0;
}

function actionSpeed(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  action: RpgMakerBattleAction,
): number {
  const user = action.side === "actor" ? state.actors[action.user] : state.enemies[action.user];
  if (!user) return 0;
  const usable = usableForAction(db, action);
  const agi = rpgMakerCombatantParam(db, user, 6);
  return agi + (usable?.speed ?? 0) + drawInt(state, Math.floor(5 + agi / 4));
}

function enemyActionValid(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  enemy: RpgMakerBattleCombatant,
  action: NonNullable<ReturnType<typeof findById<RpgMakerBattleDatabase["enemies"][number]>>>["actions"][number],
): boolean {
  const p1 = action.conditionParam1;
  const p2 = action.conditionParam2;
  switch (action.conditionType) {
    case 0: return true;
    case 1: return p2 === 0
      ? state.turn === p1
      : state.turn > 0 && state.turn >= p1 && state.turn % p2 === p1 % p2;
    case 2: {
      const rate = enemy.hp / Math.max(1, rpgMakerCombatantParam(db, enemy, 0));
      return rate >= p1 && rate <= p2;
    }
    case 3: {
      const rate = enemy.mp / Math.max(1, rpgMakerCombatantParam(db, enemy, 1));
      return rate >= p1 && rate <= p2;
    }
    case 4: return enemy.states.some((entry) => entry.id === p1);
    case 5: return Math.max(0, ...state.actors.map((actor) => actor.actor?.level ?? 0)) >= p1;
    case 6: return state.switches[switchKey(p1)] === true;
    default: return false;
  }
}

function chooseEnemyAction(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  enemy: RpgMakerBattleCombatant,
  index: number,
): RpgMakerBattleAction | null {
  const enemyRestriction = restriction(db, enemy);
  if (!alive(enemy) || enemyRestriction === 4) return null;
  if (enemyRestriction > 0) {
    return { side: "enemy", user: index, kind: "skill", id: attackSkillId(db, enemy), target: -1, speed: 0 };
  }
  const definition = findById(db.enemies, enemy.databaseId);
  const valid = (definition?.actions ?? []).filter((action) =>
    !!findById(db.skills, action.skillId) && enemyActionValid(db, state, enemy, action));
  if (valid.length === 0) return null;
  const maximum = Math.max(...valid.map((action) => action.rating));
  const candidates = valid.filter((action) => action.rating > maximum - 3);
  const total = candidates.reduce((sum, action) => sum + action.rating - (maximum - 3), 0);
  let cursor = draw(state) * total;
  let selected = candidates[candidates.length - 1]!;
  for (const action of candidates) {
    cursor -= action.rating - (maximum - 3);
    if (cursor < 0) {
      selected = action;
      break;
    }
  }
  return { side: "enemy", user: index, kind: "skill", id: selected.skillId, target: -1, speed: 0 };
}

function attackSkillId(db: RpgMakerBattleDatabase, battler: RpgMakerBattleCombatant): number {
  let id = 1;
  for (const trait of combatantTraits(db, battler)) {
    if (trait.code === 35) id = Math.max(id, trait.dataId);
  }
  return findById(db.skills, id) ? id : 1;
}

function prepareResolution(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  includeActors: boolean,
): void {
  state.turn++;
  const queue = includeActors ? [...state.actorActions] : [];
  state.enemies.forEach((enemy, index) => {
    const action = chooseEnemyAction(db, state, enemy, index);
    if (action) queue.push(action);
  });
  for (const action of queue) action.speed = actionSpeed(db, state, action);
  queue.sort((a, b) => b.speed - a.speed || (a.side === b.side ? a.user - b.user : a.side === "actor" ? -1 : 1));
  state.queue = queue;
  state.queueIndex = 0;
  state.actorActions = [];
}

function startPreparedResolution(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  const pages = runTroopPages(db, state, false);
  if (pages.length > 0) showMessage(state, pages.join("\n"), "nextAction");
  else resolveNextAction(db, state);
}

function beginResolution(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  prepareResolution(db, state, true);
  startPreparedResolution(db, state);
}

function chooseActorInput(db: RpgMakerBattleDatabase, state: RpgMakerBattleState, start: number): void {
  for (let index = start; index < state.actors.length; index++) {
    const actor = state.actors[index]!;
    if (!alive(actor)) continue;
    const actorRestriction = restriction(db, actor);
    if (actorRestriction === 0) {
      state.actorIndex = index;
      state.menuIndex = 0;
      state.phase = "command";
      return;
    }
    if (actorRestriction < 4) {
      state.actorActions.push({
        side: "actor",
        user: index,
        kind: "skill",
        id: attackSkillId(db, actor),
        target: -1,
        speed: 0,
      });
    }
  }
  beginResolution(db, state);
}

function enqueueActorAction(db: RpgMakerBattleDatabase, state: RpgMakerBattleState, action: RpgMakerBattleAction): void {
  state.actorActions.push(action);
  delete state.selected;
  state.listIndex = 0;
  state.targetIndex = 0;
  chooseActorInput(db, state, state.actorIndex + 1);
}

function beginUsableAction(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  kind: "skill" | "item",
  id: number,
): void {
  const usable = kind === "skill" ? findById(db.skills, id) : findById(db.items, id);
  if (!usable) return;
  const targets = selectableTargets(state, usable);
  if (targetSide(usable.scope) !== null && targets.length === 0) return;
  if (scopeNeedsSelection(usable.scope) && targets.length > 1) {
    state.selected = { kind, id };
    state.targetIndex = targets[0]!;
    state.phase = "target";
    return;
  }
  enqueueActorAction(db, state, {
    side: "actor",
    user: state.actorIndex,
    kind,
    id,
    target: scopeNeedsSelection(usable.scope) ? (targets[0] ?? -1) : -1,
    speed: 0,
  });
}

function actionTargets(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  action: RpgMakerBattleAction,
  usable: RpgMakerUsableItem,
  user: RpgMakerBattleCombatant,
): { side: "actor" | "enemy"; index: number }[] {
  const scopeSide = targetSide(usable.scope);
  if (scopeSide === "user") return [{ side: action.side, index: action.user }];
  const userRestriction = restriction(db, user);
  let targetSideName: "actor" | "enemy";
  if (userRestriction >= 1 && userRestriction <= 3) {
    const opponents = action.side === "actor" ? "enemy" : "actor";
    const friends = action.side;
    targetSideName = userRestriction === 1
      ? opponents
      : userRestriction === 2
        ? (draw(state) < 0.5 ? opponents : friends)
        : friends;
  } else {
    targetSideName = action.side === "actor"
      ? (scopeSide ?? "enemy")
      : scopeSide === "actor" ? "enemy" : "actor";
  }
  const list = targetSideName === "actor" ? state.actors : state.enemies;
  const dead = userRestriction === 0 && isDeadScope(usable.scope);
  const eligible = list.flatMap((target, index) => target.hidden || (dead ? target.hp > 0 : target.hp <= 0) ? [] : [index]);
  if (eligible.length === 0) return [];
  if (action.target >= 0 && eligible.includes(action.target)) return [{ side: targetSideName, index: action.target }];
  if (action.target >= 0) return [{ side: targetSideName, index: eligible[0]! }];
  if (userRestriction === 0 && (usable.scope === 2 || usable.scope === 8 || usable.scope === 10)) {
    return eligible.map((index) => ({ side: targetSideName, index }));
  }
  const randomCount = userRestriction === 0 && usable.scope >= 3 && usable.scope <= 6 ? usable.scope - 2 : 1;
  const targets: { side: "actor" | "enemy"; index: number }[] = [];
  for (let i = 0; i < randomCount; i++) {
    let index: number;
    if (dead) {
      index = eligible[drawInt(state, eligible.length)]!;
    } else {
      const total = eligible.reduce((sum, candidate) => sum + Math.max(0, traitProduct(db, list[candidate]!, 23, 0)), 0);
      let cursor = draw(state) * total;
      index = eligible[0]!;
      for (const candidate of eligible) {
        cursor -= Math.max(0, traitProduct(db, list[candidate]!, 23, 0));
        if (cursor <= 0) {
          index = candidate;
          break;
        }
      }
    }
    targets.push({ side: targetSideName, index });
  }
  return targets;
}

function applyState(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  target: RpgMakerBattleCombatant,
  id: number,
): boolean {
  const definition = stateDef(db, id);
  if (!definition || !alive(target) || combatantTraits(db, target).some((trait) => trait.code === 14 && trait.dataId === id)) {
    return false;
  }
  const turns = resetStateTurns(db, state, id);
  if (id === 1) {
    die(db, state, target, turns);
    return true;
  }
  const active = target.states.find((entry) => entry.id === id);
  if (active) active.turns = turns;
  else target.states.push({ id, turns });
  return true;
}

function removeState(db: RpgMakerBattleDatabase, target: RpgMakerBattleCombatant, id: number): boolean {
  const index = target.states.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  target.states.splice(index, 1);
  if (id === 1 && target.hp === 0) target.hp = Math.min(1, rpgMakerCombatantParam(db, target, 0));
  return true;
}

function luckEffectRate(
  db: RpgMakerBattleDatabase,
  user: RpgMakerBattleCombatant,
  target: RpgMakerBattleCombatant,
): number {
  return Math.max(0, 1 + (rpgMakerCombatantParam(db, user, 7) - rpgMakerCombatantParam(db, target, 7)) * 0.001);
}

/** RPG Maker database terms use %1, %2... and \\G for the currency unit. */
function formatTerm(db: RpgMakerBattleDatabase, source: string, ...values: (string | number)[]): string {
  return source
    .replace(/%([1-9][0-9]*)/g, (whole, index: string) => values[Number(index) - 1] === undefined
      ? whole
      : String(values[Number(index) - 1]))
    .replace(/\\G/g, db.currencyUnit);
}

function sideMessage(
  db: RpgMakerBattleDatabase,
  target: RpgMakerBattleCombatant,
  actor: keyof RpgMakerBattleDatabase["terms"]["messages"],
  enemy: keyof RpgMakerBattleDatabase["terms"]["messages"],
  ...values: (string | number)[]
): string {
  return formatTerm(db, db.terms.messages[target.side === "actor" ? actor : enemy], ...values);
}

function stateAppliedMessage(
  db: RpgMakerBattleDatabase,
  target: RpgMakerBattleCombatant,
  id: number,
): string {
  const definition = stateDef(db, id);
  const source = definition?.messages[target.side === "actor" ? 0 : 1] ?? "";
  return source.length > 0
    ? source.includes("%1") ? formatTerm(db, source, target.name) : target.name + source
    : `${target.name}: ${definition?.name ?? String(id)}`;
}

function stateRemovedMessage(
  db: RpgMakerBattleDatabase,
  target: RpgMakerBattleCombatant,
  id: number,
): string {
  const definition = stateDef(db, id);
  const source = definition?.messages[3] ?? "";
  return source.length > 0
    ? source.includes("%1") ? formatTerm(db, source, target.name) : target.name + source
    : `${target.name}: -${definition?.name ?? String(id)}`;
}

function applyEffect(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  user: RpgMakerBattleCombatant,
  target: RpgMakerBattleCombatant,
  usable: RpgMakerUsableItem,
  effect: RpgMakerEffect,
): string | null {
  switch (effect.code) {
    case 11: {
      const before = target.hp;
      const base = rpgMakerCombatantParam(db, target, 0) * effect.value1 + effect.value2;
      const recoveryRate = traitProduct(db, target, 23, 2);
      const pharmacology = user.side === "actor" ? traitProduct(db, user, 23, 3) : 1;
      setHp(db, state, target, target.hp + Math.floor(base * recoveryRate * pharmacology));
      return target.hp !== before
        ? sideMessage(db, target, "actorRecovery", "enemyRecovery", target.name, target.hp - before, db.terms.basic.hpAbbr)
        : null;
    }
    case 12: {
      const before = target.mp;
      const amount = Math.floor((rpgMakerCombatantParam(db, target, 1) * effect.value1 + effect.value2) *
        traitProduct(db, target, 23, 2));
      target.mp = clamp(target.mp + amount, 0, rpgMakerCombatantParam(db, target, 1));
      return target.mp !== before
        ? sideMessage(db, target, "actorRecovery", "enemyRecovery", target.name, target.mp - before, db.terms.basic.mpAbbr)
        : null;
    }
    case 13:
      target.tp = clamp(target.tp + Math.floor(effect.value1), 0, 100);
      return null;
    case 21: {
      if (effect.dataId === 0) {
        const added: string[] = [];
        const attackStateIds = combatantTraits(db, user)
          .filter((trait) => trait.code === 32)
          .map((trait) => trait.dataId);
        for (const id of attackStateIds) {
          const rate = traitSum(db, user, 32, id);
          const chance = effect.value1 * rate * traitProduct(db, target, 13, id) * luckEffectRate(db, user, target);
          if (draw(state) < chance && applyState(db, state, target, id)) {
            added.push(stateAppliedMessage(db, target, id));
          }
        }
        return added.length > 0 ? added.join("\n") : null;
      }
      const chance = effect.value1 * (usable.hitType === 0
        ? 1
        : traitProduct(db, target, 13, effect.dataId) * luckEffectRate(db, user, target));
      return draw(state) < chance && applyState(db, state, target, effect.dataId)
        ? stateAppliedMessage(db, target, effect.dataId)
        : null;
    }
    case 22:
      return draw(state) < effect.value1 && removeState(db, target, effect.dataId)
        ? stateRemovedMessage(db, target, effect.dataId)
        : null;
    case 31:
    case 32: {
      const buff = target.buffs[clamp(effect.dataId, 0, 7)]!;
      buff.level = clamp(buff.level + (effect.code === 31 ? 1 : -1), -2, 2);
      buff.turns = Math.max(buff.turns, Math.max(0, Math.trunc(effect.value1)));
      return null;
    }
    case 33:
    case 34: {
      const buff = target.buffs[clamp(effect.dataId, 0, 7)]!;
      if ((effect.code === 33 && buff.level > 0) || (effect.code === 34 && buff.level < 0)) {
        buff.level = 0;
        buff.turns = 0;
      }
      return null;
    }
    default:
      return null;
  }
}

function elementRate(
  db: RpgMakerBattleDatabase,
  user: RpgMakerBattleCombatant,
  target: RpgMakerBattleCombatant,
  elementId: number,
): number {
  if (elementId > 0) return traitProduct(db, target, 11, elementId);
  if (elementId === -1) {
    const elements = combatantTraits(db, user).filter((trait) => trait.code === 31).map((trait) => trait.dataId);
    return elements.length > 0 ? Math.max(...elements.map((id) => traitProduct(db, target, 11, id))) : 1;
  }
  return 1;
}

function applyVariance(state: RpgMakerBattleState, value: number, variance: number): number {
  const amplitude = Math.floor(Math.max(Math.abs(value) * variance / 100, 0));
  const spread = drawInt(state, amplitude + 1) + drawInt(state, amplitude + 1) - amplitude;
  return value >= 0 ? value + spread : value - spread;
}

function removeStatesByDamage(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  target: RpgMakerBattleCombatant,
): void {
  for (const active of [...target.states]) {
    const definition = stateDef(db, active.id);
    if (definition?.removeByDamage && drawInt(state, 100) < definition.chanceByDamage) removeState(db, target, active.id);
  }
}

function applyDamage(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  user: RpgMakerBattleCombatant,
  target: RpgMakerBattleCombatant,
  usable: RpgMakerUsableItem,
): { text: string; effect: RpgMakerBattleState["effect"] } {
  const used = formatTerm(db, db.terms.messages.useItem, user.name, usable.name);
  const success = usable.successRate / 100 * (usable.hitType === 1 ? traitSum(db, user, 22, 0) : 1);
  if (draw(state) >= success) return {
    text: `${used}\n${sideMessage(db, target, "actorNoHit", "enemyNoHit", target.name)}`,
    effect: null,
  };
  const evasion = usable.hitType === 1 ? traitSum(db, target, 22, 1)
    : usable.hitType === 2 ? traitSum(db, target, 22, 4) : 0;
  if (draw(state) < evasion) return {
    text: `${used}\n${usable.hitType === 2
      ? sideMessage(db, target, "actorMagicEvasion", "enemyMagicEvasion", target.name)
      : sideMessage(db, target, "actorEvasion", "enemyEvasion", target.name)}`,
    effect: null,
  };

  const critical = usable.damage.critical && draw(state) <
    traitSum(db, user, 22, 2) * (1 - traitSum(db, target, 22, 3));
  let value = evaluateRpgMakerDamageBase(usable.damage.formula, usable.damage.type, {
    a: formulaBattler(db, user),
    b: formulaBattler(db, target),
    variables: numericVariables(state.variables),
  });
  value *= elementRate(db, user, target, usable.damage.elementId);
  if (usable.hitType === 1) value *= traitProduct(db, target, 23, 6);
  if (usable.hitType === 2) value *= traitProduct(db, target, 23, 7);
  if (critical) value *= 3;
  value = applyVariance(state, value, usable.damage.variance);
  if (value > 0 && target.guarding) value /= Math.max(1, 2 * traitProduct(db, target, 23, 1));
  value = Math.round(value);

  let text = used;
  let effect: RpgMakerBattleState["effect"] = null;
  if (usable.damage.type === 1 || usable.damage.type === 3 || usable.damage.type === 5) {
    const before = target.hp;
    setHp(db, state, target, target.hp - value);
    const changed = before - target.hp;
    text += changed > 0
      ? `\n${sideMessage(db, target, "actorDamage", "enemyDamage", target.name, changed)}`
      : changed < 0
        ? `\n${sideMessage(db, target, "actorRecovery", "enemyRecovery", target.name, -changed, db.terms.basic.hpAbbr)}`
        : `\n${sideMessage(db, target, "actorNoDamage", "enemyNoDamage", target.name)}`;
    effect = {
      side: target.side,
      index: target.side === "actor" ? state.actors.indexOf(target) : state.enemies.indexOf(target),
      from: before,
      to: target.hp,
      startTick: state.nowTick,
      duration: EFFECT_TICKS,
      kind: target.hp === 0 ? "faint" : changed >= 0 ? "hit" : "heal",
    };
    if (changed > 0) removeStatesByDamage(db, state, target);
    if (changed > 0) {
      const damageRate = changed / Math.max(1, rpgMakerCombatantParam(db, target, 0));
      target.tp = clamp(target.tp + Math.floor(50 * damageRate * traitProduct(db, target, 23, 5)), 0, 100);
    }
    if (usable.damage.type === 5 && changed > 0) setHp(db, state, user, user.hp + Math.min(changed, before));
  } else if (usable.damage.type === 2 || usable.damage.type === 4 || usable.damage.type === 6) {
    const before = target.mp;
    target.mp = clamp(target.mp - value, 0, rpgMakerCombatantParam(db, target, 1));
    const changed = before - target.mp;
    text += changed > 0
      ? `\n${sideMessage(db, target, "actorLoss", "enemyLoss", target.name, changed, db.terms.basic.mpAbbr)}`
      : changed < 0
        ? `\n${sideMessage(db, target, "actorRecovery", "enemyRecovery", target.name, -changed, db.terms.basic.mpAbbr)}`
        : `\n${formatTerm(db, db.terms.messages.actionFailure, target.name)}`;
    if (usable.damage.type === 6 && changed > 0) user.mp = clamp(user.mp + changed, 0, rpgMakerCombatantParam(db, user, 1));
  }
  const effectMessages: string[] = [];
  for (const effectEntry of usable.effects) {
    const message = applyEffect(db, state, user, target, usable, effectEntry);
    if (message) effectMessages.push(message);
  }
  if (critical) text += `\n${target.side === "actor" ? db.terms.messages.criticalToActor : db.terms.messages.criticalToEnemy}`;
  if (effectMessages.length > 0) text += `\n${effectMessages.join("\n")}`;
  return { text, effect };
}

function updateActionEndStates(db: RpgMakerBattleDatabase, battler: RpgMakerBattleCombatant): void {
  for (const active of [...battler.states]) {
    const definition = stateDef(db, active.id);
    if (definition?.autoRemovalTiming !== 1) continue;
    active.turns--;
    if (active.turns <= 0) removeState(db, battler, active.id);
  }
}

function resolveAction(db: RpgMakerBattleDatabase, state: RpgMakerBattleState, action: RpgMakerBattleAction): string {
  const user = action.side === "actor" ? state.actors[action.user] : state.enemies[action.user];
  if (!user || !alive(user) || restriction(db, user) === 4) return "";
  if (action.kind === "guard") {
    user.guarding = true;
    return formatTerm(db, db.terms.messages.useItem, user.name, db.terms.guard);
  }
  const usable = usableForAction(db, action);
  if (!usable) return "";
  const targets = actionTargets(db, state, action, usable, user);
  if (targets.length === 0) return [
    formatTerm(db, db.terms.messages.useItem, user.name, usable.name),
    formatTerm(db, db.terms.messages.actionFailure, user.name),
  ].join("\n");
  if (action.kind === "skill") {
    const skill = usable as RpgMakerBattleSkill;
    if (!skillAffordable(user, skill)) return formatTerm(db, db.terms.messages.actionFailure, user.name);
    user.mp -= skill.mpCost;
    user.tp = clamp(user.tp - skill.tpCost, 0, 100);
  } else {
    const key = itemKey(action.id);
    if ((state.items[key] ?? 0) <= 0) return formatTerm(db, db.terms.messages.actionFailure, user.name);
    if ((usable as RpgMakerBattleItem).consumable) state.items[key] = Math.max(0, state.items[key]! - 1);
  }
  const messages: string[] = [];
  state.effect = null;
  for (let repeat = 0; repeat < usable.repeats; repeat++) {
    for (const ref of targets) {
      const target = ref.side === "actor" ? state.actors[ref.index] : state.enemies[ref.index];
      if (!target) continue;
      const result = applyDamage(db, state, user, target, usable);
      messages.push(result.text);
      if (result.effect) state.effect = result.effect;
    }
  }
  user.tp = clamp(user.tp + usable.tpGain, 0, 100);
  updateActionEndStates(db, user);
  return messages.join("\n");
}

function allEnemiesDefeated(state: RpgMakerBattleState): boolean {
  return state.enemies.every((enemy) => enemy.hidden || enemy.hp <= 0);
}

function allActorsDefeated(state: RpgMakerBattleState): boolean {
  return state.actors.every((actor) => actor.hp <= 0);
}

function levelActor(
  db: RpgMakerBattleDatabase,
  battler: RpgMakerBattleCombatant,
  exp: number,
): string[] {
  if (!battler.actor) return [];
  const actor = findById(db.actors, battler.databaseId);
  const klass = findById(db.classes, battler.actor.classId);
  if (!actor || !klass) return [];
  battler.actor.exp += exp;
  const messages: string[] = [];
  while (battler.actor.level < actor.maxLevel &&
      battler.actor.exp >= rpgMakerExpForLevel(db, battler.actor.classId, battler.actor.level + 1)) {
    battler.actor.level++;
    battler.params = actorBaseParams(db, battler.databaseId, battler.actor.classId, battler.actor.level);
    for (const learning of klass.learnings) {
      if (learning.level === battler.actor.level && !battler.actor.skills.includes(learning.skillId)) {
        battler.actor.skills.push(learning.skillId);
      }
    }
    battler.actor.skills.sort((a, b) => a - b);
    messages.push(formatTerm(
      db,
      db.terms.messages.levelUp,
      battler.name,
      db.terms.basic.level,
      battler.actor.level,
    ));
  }
  battler.hp = clamp(battler.hp, 0, rpgMakerCombatantParam(db, battler, 0));
  battler.mp = clamp(battler.mp, 0, rpgMakerCombatantParam(db, battler, 1));
  return messages;
}

function beginVictory(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  let exp = 0;
  let gold = 0;
  const drops: Record<string, number> = {};
  const dropRate = partyAbility(db, state, 5) ? 2 : 1;
  for (const battler of state.enemies) {
    if (battler.hidden) continue;
    const enemy = findById(db.enemies, battler.databaseId);
    if (!enemy) continue;
    exp += enemy.exp;
    gold += enemy.gold;
    for (const drop of enemy.drops) {
      if (drop.item && drop.kind > 0 && draw(state) * Math.max(1, drop.denominator) < dropRate) {
        drops[drop.item] = (drops[drop.item] ?? 0) + 1;
      }
    }
  }
  if (partyAbility(db, state, 4)) gold *= 2;
  state.gold += gold;
  for (const [id, count] of Object.entries(drops)) state.items[id] = (state.items[id] ?? 0) + count;
  const levels = state.actors.flatMap((actor) =>
    levelActor(db, actor, Math.round(exp * traitProduct(db, actor, 23, 9))));
  state.reward = { exp, gold, items: drops, levels };
  const partyName = state.actors[0]?.name ?? "";
  const rows = [
    formatTerm(db, db.terms.messages.victory, partyName),
    formatTerm(db, db.terms.messages.obtainExp, exp, db.terms.basic.expAbbr),
    formatTerm(db, db.terms.messages.obtainGold, gold),
  ];
  for (const [id, count] of Object.entries(drops)) {
    const item = /^item0*([1-9][0-9]*)$/.exec(id);
    const name = item ? findById(db.items, Number(item[1]))?.name ?? id : id;
    for (let index = 0; index < count; index++) {
      rows.push(formatTerm(db, db.terms.messages.obtainItem, name));
    }
  }
  rows.push(...levels);
  showMessage(state, rows.join("\n"), "win");
}

function beginDefeat(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  showMessage(state, formatTerm(db, db.terms.messages.defeat, state.actors[0]?.name ?? ""), "lose");
}

function reviveBattleMembers(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  for (const actor of state.actors) {
    if (actor.hp <= 0) setHp(db, state, actor, 1);
  }
}

function updateTurnEndStates(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  battler: RpgMakerBattleCombatant,
): void {
  if (alive(battler)) {
    const mhp = rpgMakerCombatantParam(db, battler, 0);
    const hp = Math.floor(mhp * traitSum(db, battler, 22, 7));
    if (hp !== 0) setHp(db, state, battler, Math.max(1, battler.hp + hp));
    const mp = Math.floor(rpgMakerCombatantParam(db, battler, 1) * traitSum(db, battler, 22, 8));
    battler.mp = clamp(battler.mp + mp, 0, rpgMakerCombatantParam(db, battler, 1));
    const tp = Math.floor(100 * traitSum(db, battler, 22, 9));
    battler.tp = clamp(battler.tp + tp, 0, 100);
  }
  for (const active of [...battler.states]) {
    const definition = stateDef(db, active.id);
    if (definition?.autoRemovalTiming === 2) {
      active.turns--;
      if (active.turns <= 0) removeState(db, battler, active.id);
    }
  }
  for (const buff of battler.buffs) {
    if (buff.turns > 0 && --buff.turns === 0) buff.level = 0;
  }
  battler.guarding = false;
}

function finishTurn(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  state.actors.forEach((actor) => updateTurnEndStates(db, state, actor));
  state.enemies.forEach((enemy) => updateTurnEndStates(db, state, enemy));
  const pages = runTroopPages(db, state, true);
  if (allEnemiesDefeated(state)) beginVictory(db, state);
  else if (allActorsDefeated(state)) beginDefeat(db, state);
  else if (pages.length > 0) showMessage(state, pages.join("\n"), "party");
  else {
    state.phase = "party";
    state.menuIndex = 0;
  }
}

function resolveNextAction(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  if (allEnemiesDefeated(state)) {
    beginVictory(db, state);
    return;
  }
  if (allActorsDefeated(state)) {
    beginDefeat(db, state);
    return;
  }
  const action = state.queue[state.queueIndex++];
  if (!action) {
    finishTurn(db, state);
    return;
  }
  const text = resolveAction(db, state, action);
  const pages = runTroopPages(db, state, false);
  const message = [text, ...pages].filter((line) => line.length > 0).join("\n");
  if (allEnemiesDefeated(state)) beginVictory(db, state);
  else if (allActorsDefeated(state)) beginDefeat(db, state);
  else if (message.length > 0) showMessage(state, message, "nextAction");
  else resolveNextAction(db, state);
}

function tryEscape(db: RpgMakerBattleDatabase, state: RpgMakerBattleState): void {
  if (!state.canEscape) return;
  state.escapeAttempts++;
  const actorAgi = state.actors.filter(alive).reduce((sum, actor) => sum + rpgMakerCombatantParam(db, actor, 6), 0);
  const enemyAgi = state.enemies.filter(alive).reduce((sum, enemy) => sum + rpgMakerCombatantParam(db, enemy, 6), 0);
  const ratio = clamp(0.5 * actorAgi / Math.max(1, enemyAgi) + 0.1 * (state.escapeAttempts - 1), 0, 1);
  const start = formatTerm(db, db.terms.messages.escapeStart, state.actors[0]?.name ?? "");
  if (draw(state) < ratio) showMessage(state, start, "escape");
  else {
    prepareResolution(db, state, false);
    showMessage(state, `${start}\n${db.terms.messages.escapeFailure}`, "turnStart");
  }
}

function completionRuntime(
  db: RpgMakerBattleDatabase,
  state: Readonly<RpgMakerBattleState>,
): RpgMakerBattleRuntime {
  const { runtime } = runtimeRoot(state.ext);
  for (const battler of state.actors) {
    if (!battler.actor) continue;
    runtime.actors[String(battler.databaseId)] = {
      actorId: battler.databaseId,
      classId: battler.actor.classId,
      level: battler.actor.level,
      exp: battler.actor.exp,
      hp: battler.hp,
      mp: battler.mp,
      tp: hasTrait(db, battler, 62, 3) ? battler.tp : 0,
      skills: [...battler.actor.skills],
      states: battler.states.filter((active) => stateDef(db, active.id)?.removeAtBattleEnd !== true)
        .map((active) => ({ ...active })),
      buffs: Array(8).fill(0),
    };
  }
  if (state.result === "win") runtime.winCount++;
  if (state.result === "escape") runtime.escapeCount++;
  return runtime;
}

function changed<T extends number | string | boolean>(
  before: Readonly<Record<string, T>>,
  after: Readonly<Record<string, T>>,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[id] !== after[id] && after[id] !== undefined) out[id] = after[id]!;
  }
  return out;
}

function createInitialState(
  db: RpgMakerBattleDatabase,
  ext: JsonValue,
  rawSetup: JsonValue,
  seed: number,
  context: ExtensionReadContext,
): { state: RpgMakerBattleState; ext: JsonValue } | null {
  const setup = object(rawSetup) as unknown as RpgMakerBattleSetup;
  if (setup.system !== "rpgmaker") return null;
  if (setup.databaseHash !== db.databaseHash) {
    throw new Error("RPG Maker battle database hash does not match Battle Processing content");
  }
  const seedState = { rng: seed >>> 0 } as RpgMakerBattleState;
  const troopId = resolveTroopId(db, setup, seedState, context);
  const troop = findById(db.troops, troopId);
  if (!troop) return null;

  const { runtime } = runtimeRoot(ext);
  runtime.battleCount++;
  const initialParty = new Set(db.party);
  const party = [
    ...db.party.filter((actorId) => context.switches[partyOutSwitchKey(actorId)] !== true),
    ...db.actors
      .map((actor) => actor.id)
      .filter((actorId) => !initialParty.has(actorId) && context.switches[partySwitchKey(actorId)] === true)
      .sort((a, b) => a - b),
  ].slice(0, 4);
  for (const actorId of party) {
    if (!runtime.actors[String(actorId)]) {
      const initial = initialActorRuntime(db, actorId);
      if (initial) runtime.actors[String(actorId)] = initial;
    }
  }
  const actors = party.flatMap((id, index) => {
    const actor = runtime.actors[String(id)];
    const combatant = actor ? actorCombatant(db, actor, index) : null;
    return combatant ? [combatant] : [];
  });
  const enemies = troop.members.flatMap((member, index) => {
    const combatant = enemyCombatant(db, troop, member, index);
    return combatant ? [combatant] : [];
  });
  if (actors.length === 0 || enemies.every((enemy) => enemy.hidden)) return null;
  for (const actor of actors) {
    const saved = runtime.actors[String(actor.databaseId)];
    if (saved) {
      saved.hp = actor.hp;
      saved.mp = actor.mp;
    }
  }
  const startedExt = withRuntime(ext, runtime);
  const variables = cloneVariables(context.variables);
  const switches = { ...context.switches };
  const items = cloneNumbers(context.items);
  const state: RpgMakerBattleState = {
    format: "rpgmaker-battle-state/v1",
    databaseHash: db.databaseHash,
    rng: seedState.rng,
    nowTick: 0,
    phase: "message",
    turn: 0,
    canEscape: setup.canEscape === true,
    canLose: setup.canLose === true,
    escapeAttempts: 0,
    troopId,
    actors,
    enemies,
    actorIndex: 0,
    menuIndex: 0,
    listIndex: 0,
    targetIndex: 0,
    actorActions: [],
    queue: [],
    queueIndex: 0,
    message: "",
    messageStart: 0,
    afterMessage: "party",
    result: null,
    effect: null,
    pageRuns: troop.pages.map(() => ({ battle: false, lastTurn: -1, active: false })),
    variables,
    initialVariables: { ...variables },
    switches,
    initialSwitches: { ...switches },
    items,
    initialItems: { ...items },
    gold: context.gold,
    initialGold: context.gold,
    reward: { exp: 0, gold: 0, items: {}, levels: [] },
    ext: startedExt,
  };
  for (const battler of [...state.actors, ...state.enemies]) {
    if (!hasTrait(db, battler, 62, 3)) battler.tp = drawInt(state, 25);
  }
  const pages = runTroopPages(db, state, false);
  const enemyNames = enemies.filter((enemy) => !enemy.hidden).map((enemy) => enemy.name).join(", ");
  showMessage(state, [formatTerm(db, db.terms.messages.emerge, enemyNames), ...pages].join("\n"), "party");
  return { state, ext: startedExt };
}

function stepState(
  db: RpgMakerBattleDatabase,
  state: RpgMakerBattleState,
  input: Parameters<BattleRules["step"]>[1],
): void {
  if (state.phase === "done") return;
  if (state.phase === "message") {
    if (!input.confirmEdge) return;
    state.effect = null;
    if (state.afterMessage === "party") {
      state.phase = "party";
      state.menuIndex = 0;
    } else if (state.afterMessage === "turnStart") {
      startPreparedResolution(db, state);
    } else if (state.afterMessage === "nextAction") {
      resolveNextAction(db, state);
    } else {
      if (state.afterMessage === "lose" && state.canLose) reviveBattleMembers(db, state);
      state.result = state.afterMessage;
      state.phase = "done";
    }
    return;
  }
  if (state.phase === "party") {
    if (input.upEdge || input.downEdge) state.menuIndex = state.menuIndex === 0 ? 1 : 0;
    if (input.confirmEdge) {
      if (state.menuIndex === 1) tryEscape(db, state);
      else {
        state.actorActions = [];
        chooseActorInput(db, state, 0);
      }
    }
    return;
  }
  if (state.phase === "command") {
    if (input.upEdge || input.downEdge) state.menuIndex = state.menuIndex < 2 ? state.menuIndex + 2 : state.menuIndex - 2;
    if (input.leftEdge || input.rightEdge) state.menuIndex = state.menuIndex % 2 === 0 ? state.menuIndex + 1 : state.menuIndex - 1;
    if (input.cancelEdge) {
      state.phase = "party";
      state.actorActions = [];
      state.menuIndex = 0;
      return;
    }
    if (!input.confirmEdge) return;
    const actor = state.actors[state.actorIndex]!;
    if (state.menuIndex === 0) beginUsableAction(db, state, "skill", 1);
    else if (state.menuIndex === 1) {
      state.phase = "skill";
      state.listIndex = 0;
    } else if (state.menuIndex === 2) {
      enqueueActorAction(db, state, { side: "actor", user: state.actorIndex, kind: "guard", id: 0, target: state.actorIndex, speed: 0 });
    } else {
      state.phase = "item";
      state.listIndex = 0;
    }
    void actor;
    return;
  }
  if (state.phase === "skill") {
    const skills = rpgMakerSkillChoices(db, state);
    if (input.cancelEdge) {
      state.phase = "command";
      return;
    }
    if (input.upEdge) state.listIndex = Math.max(0, state.listIndex - 1);
    if (input.downEdge) state.listIndex = Math.min(Math.max(0, skills.length - 1), state.listIndex + 1);
    const skill = skills[state.listIndex];
    if (input.confirmEdge && skill && skillAffordable(state.actors[state.actorIndex]!, skill)) {
      beginUsableAction(db, state, "skill", skill.id);
    }
    return;
  }
  if (state.phase === "item") {
    const items = rpgMakerItemChoices(db, state);
    if (input.cancelEdge) {
      state.phase = "command";
      return;
    }
    if (input.upEdge) state.listIndex = Math.max(0, state.listIndex - 1);
    if (input.downEdge) state.listIndex = Math.min(Math.max(0, items.length - 1), state.listIndex + 1);
    const item = items[state.listIndex];
    if (input.confirmEdge && item) beginUsableAction(db, state, "item", item.id);
    return;
  }
  if (state.phase === "target") {
    const selected = state.selected;
    const usable = selected
      ? selected.kind === "skill" ? findById(db.skills, selected.id) : findById(db.items, selected.id)
      : undefined;
    if (!usable || !selected) {
      state.phase = "command";
      delete state.selected;
      return;
    }
    const targets = selectableTargets(state, usable);
    const at = Math.max(0, targets.indexOf(state.targetIndex));
    if (input.upEdge) state.targetIndex = targets[Math.max(0, at - 1)] ?? state.targetIndex;
    if (input.downEdge) state.targetIndex = targets[Math.min(targets.length - 1, at + 1)] ?? state.targetIndex;
    if (input.cancelEdge) {
      state.phase = selected.kind;
      delete state.selected;
      return;
    }
    if (input.confirmEdge && targets.includes(state.targetIndex)) {
      enqueueActorAction(db, state, {
        side: "actor", user: state.actorIndex, kind: selected.kind, id: selected.id,
        target: state.targetIndex, speed: 0,
      });
    }
  }
}

function savedStateRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function savedInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function savedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function savedNumberRecord(value: unknown, strings = false): boolean {
  return savedStateRecord(value) && Object.values(value).every((entry) =>
    savedNumber(entry) || (strings && typeof entry === "string"));
}

function savedBooleanRecord(value: unknown): boolean {
  return savedStateRecord(value) && Object.values(value).every((entry) => typeof entry === "boolean");
}

function savedCombatantProblem(value: unknown, path: string): string | null {
  if (!savedStateRecord(value)) return `${path}: object required`;
  if (typeof value.key !== "string" || typeof value.name !== "string") return `${path}: key/name strings required`;
  if (value.side !== "actor" && value.side !== "enemy") return `${path}.side: actor|enemy required`;
  if (!savedInteger(value.databaseId, 1)) return `${path}.databaseId: positive integer required`;
  for (const key of ["hp", "mp", "tp"] as const) {
    if (!savedNumber(value[key])) return `${path}.${key}: finite number required`;
  }
  if (!Array.isArray(value.params) || value.params.length !== 8 || !value.params.every(savedNumber)) {
    return `${path}.params: eight finite numbers required`;
  }
  if (!Array.isArray(value.states) || !value.states.every((active) =>
    savedStateRecord(active) && savedInteger(active.id, 1) && savedInteger(active.turns))) {
    return `${path}.states: state id/turn array required`;
  }
  if (!Array.isArray(value.buffs) || value.buffs.length !== 8 || !value.buffs.every((buff) =>
    savedStateRecord(buff) && savedInteger(buff.level, -2) && (buff.level as number) <= 2 && savedInteger(buff.turns))) {
    return `${path}.buffs: eight bounded buff records required`;
  }
  if (typeof value.guarding !== "boolean" || typeof value.hidden !== "boolean") {
    return `${path}: guarding/hidden booleans required`;
  }
  if (value.image !== undefined && typeof value.image !== "string") return `${path}.image: string required`;
  if (value.actor !== undefined) {
    const actor = value.actor;
    if (!savedStateRecord(actor) || !savedInteger(actor.classId, 1) || !savedInteger(actor.level, 1) ||
        !savedInteger(actor.exp) || !Array.isArray(actor.skills) || !actor.skills.every((id) => savedInteger(id, 1))) {
      return `${path}.actor: class, level, exp and skill ids required`;
    }
  }
  return null;
}

function savedActionProblem(value: unknown, path: string): string | null {
  if (!savedStateRecord(value)) return `${path}: object required`;
  if (value.side !== "actor" && value.side !== "enemy") return `${path}.side: actor|enemy required`;
  if (!savedInteger(value.user)) return `${path}.user: non-negative integer required`;
  if (value.kind !== "skill" && value.kind !== "item" && value.kind !== "guard") {
    return `${path}.kind: skill|item|guard required`;
  }
  if (!savedInteger(value.id) || !savedInteger(value.target, -1) || !savedNumber(value.speed)) {
    return `${path}: integer id/target and finite speed required`;
  }
  return null;
}

/** Validate the complete reducer shape before a checksum-valid save can feed
 * it back into battle step(). This is deliberately owned by the optional RPG
 * Maker module; the generic save validator knows only that scene.state is
 * JSON and never learns this format. */
function savedBattleStateProblem(db: RpgMakerBattleDatabase, value: JsonValue): string | null {
  if (!savedStateRecord(value)) return "state must be an object";
  if (value.format !== "rpgmaker-battle-state/v1") return "format must be rpgmaker-battle-state/v1";
  if (value.databaseHash !== db.databaseHash) return "database hash does not match the registered battle data";
  if (!savedInteger(value.rng) || (value.rng as number) > 0xffffffff) return "rng must be a u32";
  for (const key of ["nowTick", "turn", "escapeAttempts", "troopId", "actorIndex", "menuIndex", "listIndex", "targetIndex", "queueIndex", "messageStart"] as const) {
    if (!savedInteger(value[key])) return `${key} must be a non-negative integer`;
  }
  if (!db.troops.some((troop) => troop.id === value.troopId)) return "troopId is absent from the registered database";
  if (typeof value.canEscape !== "boolean" || typeof value.canLose !== "boolean") {
    return "canEscape/canLose must be booleans";
  }
  if (!["message", "party", "command", "skill", "item", "target", "done"].includes(value.phase as string)) {
    return "phase is unknown";
  }
  if (!["party", "turnStart", "nextAction", "win", "lose", "escape"].includes(value.afterMessage as string)) {
    return "afterMessage is unknown";
  }
  if (value.result !== null && value.result !== "win" && value.result !== "lose" && value.result !== "escape") {
    return "result is unknown";
  }
  if (typeof value.message !== "string") return "message must be a string";
  for (const side of ["actors", "enemies"] as const) {
    if (!Array.isArray(value[side]) || value[side].length === 0) return `${side} must be a non-empty array`;
    for (let index = 0; index < value[side].length; index++) {
      const problem = savedCombatantProblem(value[side][index], `${side}[${index}]`);
      if (problem) return problem;
      if ((value[side][index] as Record<string, unknown>).side !== (side === "actors" ? "actor" : "enemy")) {
        return `${side}[${index}].side does not match its array`;
      }
    }
  }
  const actors = value.actors as JsonValue[];
  const enemies = value.enemies as JsonValue[];
  if ((value.actorIndex as number) >= actors.length) return "actorIndex is outside actors";
  for (const field of ["actorActions", "queue"] as const) {
    if (!Array.isArray(value[field])) return `${field} must be an array`;
    for (let index = 0; index < value[field].length; index++) {
      const problem = savedActionProblem(value[field][index], `${field}[${index}]`);
      if (problem) return problem;
    }
  }
  const queue = value.queue as JsonValue[];
  if ((value.queueIndex as number) > queue.length) return "queueIndex is outside queue";
  if (value.selected !== undefined && (!savedStateRecord(value.selected) ||
      (value.selected.kind !== "skill" && value.selected.kind !== "item") || !savedInteger(value.selected.id, 1))) {
    return "selected must name a skill or item";
  }
  if (value.effect !== null) {
    if (!savedStateRecord(value.effect) || (value.effect.side !== "actor" && value.effect.side !== "enemy") ||
        !savedInteger(value.effect.index) || !savedNumber(value.effect.from) || !savedNumber(value.effect.to) ||
        !savedInteger(value.effect.startTick) || !savedInteger(value.effect.duration) ||
        !["hit", "heal", "faint"].includes(value.effect.kind as string)) {
      return "effect is malformed";
    }
    const count = value.effect.side === "actor" ? actors.length : enemies.length;
    if ((value.effect.index as number) >= count) return "effect index is outside its side";
  }
  const troop = db.troops.find((entry) => entry.id === value.troopId)!;
  if (!Array.isArray(value.pageRuns) || value.pageRuns.length !== troop.pages.length || !value.pageRuns.every((run) =>
    savedStateRecord(run) && typeof run.battle === "boolean" && savedInteger(run.lastTurn, -1) && typeof run.active === "boolean")) {
    return "pageRuns does not match the troop pages";
  }
  if (!savedNumberRecord(value.variables, true) || !savedNumberRecord(value.initialVariables, true)) {
    return "variable banks must contain finite numbers or strings";
  }
  if (!savedBooleanRecord(value.switches) || !savedBooleanRecord(value.initialSwitches)) {
    return "switch banks must contain booleans";
  }
  if (!savedNumberRecord(value.items) || !savedNumberRecord(value.initialItems)) {
    return "item banks must contain finite numbers";
  }
  if (!savedNumber(value.gold) || !savedNumber(value.initialGold)) return "gold values must be finite";
  if (!savedStateRecord(value.reward) || !savedNumber(value.reward.exp) || !savedNumber(value.reward.gold) ||
      !savedNumberRecord(value.reward.items) || !Array.isArray(value.reward.levels) ||
      !value.reward.levels.every((line) => typeof line === "string")) {
    return "reward is malformed";
  }
  return null;
}

function decodeSavedBattleState(db: RpgMakerBattleDatabase, saved: JsonValue): JsonValue {
  const problem = savedBattleStateProblem(db, saved);
  if (problem) throw new Error(`RPG Maker battle save: ${problem}`);
  return deepClone(saved);
}

export function createRpgMakerBattleRules(db: RpgMakerBattleDatabase): BattleRules {
  return {
    save: {
      encode: (state) => decodeSavedBattleState(db, state),
      decode: (saved) => decodeSavedBattleState(db, saved),
    },
    start(ext, setup, seed, context) {
      const started = createInitialState(db, ext, setup, seed, context);
      return started ? { state: jsonState(started.state), ext: started.ext } : null;
    },
    step(raw, input, ticks) {
      const state = mutableState(raw);
      if (state.format !== "rpgmaker-battle-state/v1" || state.databaseHash !== db.databaseHash) return raw;
      state.nowTick += Math.max(0, integer(ticks));
      stepState(db, state, input);
      return jsonState(state);
    },
    done(raw): BattleCompletion | null {
      const state = rpgMakerBattleState(raw);
      if (state.format !== "rpgmaker-battle-state/v1" || state.phase !== "done" || state.result === null) return null;
      const runtime = completionRuntime(db, state);
      const writes = changed(state.initialVariables, state.variables);
      const switches = changed(state.initialSwitches, state.switches);
      const items = changed(state.initialItems, state.items);
      return {
        result: state.result,
        ext: withRuntime(state.ext, runtime),
        ...(Object.keys(writes).length > 0 ? { writes } : {}),
        ...(Object.keys(switches).length > 0 ? { switches } : {}),
        ...(Object.keys(items).length > 0 ? { items } : {}),
        ...(state.gold !== state.initialGold ? { gold: state.gold } : {}),
      };
    },
  };
}
