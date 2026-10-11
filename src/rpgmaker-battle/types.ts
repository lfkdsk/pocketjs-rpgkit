// Serializable contracts shared by the RPG Maker importer, pure battle
// reducer and opt-in front-view renderer. Keeping these outside engine/types
// means projects that do not import this module retain their original bundle.

import type { RpgMakerFormulaNode } from "./formula.ts";

export type RpgMakerFlavor = "MV" | "MZ";

export interface RpgMakerTrait {
  code: number;
  dataId: number;
  value: number;
}

export interface RpgMakerBattleActor {
  id: number;
  name: string;
  classId: number;
  initialLevel: number;
  maxLevel: number;
  traits: RpgMakerTrait[];
}

export interface RpgMakerBattleClass {
  id: number;
  name: string;
  /** [mhp,mmp,atk,def,mat,mdf,agi,luk][level]. */
  params: number[][];
  /** basis, extra, acceleration A, acceleration B. */
  expParams: [number, number, number, number];
  learnings: { level: number; skillId: number }[];
  traits: RpgMakerTrait[];
}

export interface RpgMakerDamage {
  type: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  elementId: number;
  critical: boolean;
  variance: number;
  source: string;
  formula: RpgMakerFormulaNode;
  /** Present only when source was outside the safe subset. */
  fallback?: true;
}

export interface RpgMakerEffect {
  code: number;
  dataId: number;
  value1: number;
  value2: number;
}

export interface RpgMakerUsableItem {
  id: number;
  name: string;
  description: string;
  iconIndex: number;
  scope: number;
  occasion: number;
  repeats: number;
  speed: number;
  successRate: number;
  hitType: 0 | 1 | 2;
  tpGain: number;
  damage: RpgMakerDamage;
  effects: RpgMakerEffect[];
}

export interface RpgMakerBattleSkill extends RpgMakerUsableItem {
  mpCost: number;
  tpCost: number;
  stypeId: number;
}

export interface RpgMakerBattleItem extends RpgMakerUsableItem {
  consumable: boolean;
}

export interface RpgMakerEnemyAction {
  skillId: number;
  rating: number;
  /** 0 always, 1 turn, 2 HP, 3 MP, 4 state, 5 party level, 6 switch. */
  conditionType: number;
  conditionParam1: number;
  conditionParam2: number;
}

export interface RpgMakerDropItem {
  /** 0 none, 1 item, 2 weapon, 3 armour. */
  kind: number;
  dataId: number;
  denominator: number;
  /** Pocket RPG Kit inventory id, omitted for kind 0/unknown records. */
  item?: string;
}

export interface RpgMakerBattleEnemy {
  id: number;
  name: string;
  params: [number, number, number, number, number, number, number, number];
  exp: number;
  gold: number;
  image?: string;
  actions: RpgMakerEnemyAction[];
  drops: RpgMakerDropItem[];
  traits: RpgMakerTrait[];
}

export type RpgMakerTroopPageEffect =
  | { kind: "message"; lines: string[] }
  | { kind: "switch"; id: string; value: boolean }
  | {
      kind: "variable";
      id: string;
      op: "set" | "add" | "sub" | "mul" | "div" | "mod";
      value: number;
    };

export interface RpgMakerTroopPageCondition {
  turnEnding?: true;
  turn?: { a: number; b: number };
  enemyHp?: { index: number; percent: number };
  actorHp?: { actorId: number; percent: number };
  switch?: string;
}

export interface RpgMakerTroopPage {
  /** 0 battle, 1 turn, 2 moment. */
  span: 0 | 1 | 2;
  condition: RpgMakerTroopPageCondition;
  effects: RpgMakerTroopPageEffect[];
  /** Count of event commands not executable by the battle mini-interpreter. */
  unsupported: number;
}

export interface RpgMakerBattleTroop {
  id: number;
  name: string;
  members: { enemyId: number; x: number; y: number; hidden: boolean }[];
  pages: RpgMakerTroopPage[];
}

export interface RpgMakerBattleStateDef {
  id: number;
  name: string;
  restriction: number;
  priority: number;
  minTurns: number;
  maxTurns: number;
  autoRemovalTiming: number;
  removeAtBattleEnd: boolean;
  removeByDamage: boolean;
  chanceByDamage: number;
  traits: RpgMakerTrait[];
}

export interface RpgMakerMapEncounter {
  map: string;
  step: number;
  entries: { troopId: number; weight: number; regions: number[] }[];
}

export interface RpgMakerBattleDatabase {
  format: "rpgmaker-battle/v1";
  /** SHA-256 of canonical JSON for every other field. Battle commands carry
   * the same value, binding separately packaged battle.json to map content. */
  databaseHash: string;
  flavor: RpgMakerFlavor;
  /** True means authored side-view data is intentionally rendered front-view. */
  sideView: boolean;
  party: number[];
  actors: RpgMakerBattleActor[];
  classes: RpgMakerBattleClass[];
  enemies: RpgMakerBattleEnemy[];
  troops: RpgMakerBattleTroop[];
  skills: RpgMakerBattleSkill[];
  items: RpgMakerBattleItem[];
  states: RpgMakerBattleStateDef[];
  encounters: RpgMakerMapEncounter[];
  elements: string[];
  currencyUnit: string;
  terms: {
    fight: string;
    escape: string;
    attack: string;
    guard: string;
    item: string;
    skill: string;
    victory: string;
    defeat: string;
  };
}

/** A saved actor record inside the game's generic SessionState.ext tree. */
export interface RpgMakerActorRuntime {
  actorId: number;
  classId: number;
  level: number;
  exp: number;
  hp: number;
  mp: number;
  tp: number;
  skills: number[];
  states: { id: number; turns: number }[];
  buffs: number[];
}

export interface RpgMakerBattleRuntime {
  version: 1;
  actors: Record<string, RpgMakerActorRuntime>;
  battleCount: number;
  winCount: number;
  escapeCount: number;
  encounter: {
    map: string;
    remaining: number;
  } | null;
}

/** The module owns one namespaced member and preserves every sibling. */
export interface RpgMakerBattleExtensionRoot {
  rpgmakerBattle: RpgMakerBattleRuntime;
}

