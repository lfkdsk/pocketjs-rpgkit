// Serializable contracts shared by the RPG Maker importer, pure battle
// reducer and opt-in front-view renderer. Keeping these outside engine/types
// means projects that do not import this module retain their original bundle.

import type { RpgMakerFormulaNode } from "./formula.ts";
import type { JsonValue } from "../engine/types.ts";

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
  nickname?: string;
  profile?: string;
  characterName?: string;
  characterIndex?: number;
  faceName?: string;
  faceIndex?: number;
  battlerName?: string;
  /** Slot-aligned ids retained for runtime Change Equipment. Older imported
   * databases omit this and fall back to the immutable aggregate below. */
  initialEquips?: (RpgMakerEquipmentRef | null)[];
  /** Base slot kinds after actor/class dual-wield traits are applied. */
  equipSlots?: ("weapon" | "armor")[];
  /** RPG Maker etype id per slot (1 weapon, 2+ armor categories). */
  equipTypes?: number[];
  /** Immutable projection of Game_Actor.setup's surviving initial equips.
   * Runtime equipment-changing commands remain an importer degradation. */
  equipment: {
    params: [number, number, number, number, number, number, number, number];
    traits: RpgMakerTrait[];
    skills: number[];
  };
}

export interface RpgMakerEquipmentRef {
  kind: "weapon" | "armor";
  id: number;
}

export interface RpgMakerBattleEquipment extends RpgMakerEquipmentRef {
  name: string;
  etypeId: number;
  typeId: number;
  params: [number, number, number, number, number, number, number, number];
  traits: RpgMakerTrait[];
  /** Weapons retain their stock attack-animation database reference. */
  animationId?: number;
  animation?: string;
}

export interface RpgMakerAudioSetting {
  name: string;
  volume: number;
  pitch: number;
  pan: number;
  /** Imported logical audio id when compatible media was available. */
  id?: string;
  /** One-shot length in fixed 60 Hz reference ticks. Present for imported
   * victory/defeat MEs after media conversion succeeds. */
  durationTicks?: number;
}

export interface RpgMakerBattleSettings {
  battleBgm?: RpgMakerAudioSetting;
  victoryMe?: RpgMakerAudioSetting;
  defeatMe?: RpgMakerAudioSetting;
  battleback1Name?: string;
  battleback2Name?: string;
  encounterDisabled?: boolean;
}

export type RpgMakerValueOperand =
  | { kind: "constant"; value: number }
  | { kind: "variable"; id: string };

export type RpgMakerActorTarget =
  | { kind: "all" }
  | { kind: "actor"; id: number }
  | { kind: "variable"; id: string };

export type RpgMakerActorCommand =
  | { kind: "hp"; target: RpgMakerActorTarget; operation: "add" | "sub"; operand: RpgMakerValueOperand; allowDeath: boolean }
  | { kind: "mp" | "tp" | "exp" | "level"; target: RpgMakerActorTarget; operation: "add" | "sub"; operand: RpgMakerValueOperand; show?: boolean }
  | { kind: "state"; target: RpgMakerActorTarget; operation: "add" | "remove"; stateId: number }
  | { kind: "recoverAll"; target: RpgMakerActorTarget }
  | { kind: "parameter"; target: RpgMakerActorTarget; paramId: number; operation: "add" | "sub"; operand: RpgMakerValueOperand }
  | { kind: "skill"; target: RpgMakerActorTarget; operation: "add" | "remove"; skillId: number }
  | { kind: "equipment"; actorId: number; slotId: number; itemId: number }
  | { kind: "class"; actorId: number; classId: number; keepExp: boolean }
  | { kind: "images"; actorId: number; characterName: string; characterIndex: number; faceName: string; faceIndex: number; battlerName: string }
  | { kind: "nickname" | "profile"; actorId: number; value: string };

export type RpgMakerSettingCommand =
  | { kind: "battleBgm" | "victoryMe" | "defeatMe"; audio: RpgMakerAudioSetting }
  | { kind: "battleback"; battleback1Name: string; battleback2Name: string }
  | { kind: "encounter"; disabled: boolean };

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
  /** Numeric database id is retained even when the referenced presentation
   * cannot be cooked. `animation` names the optional cooked legacy asset. */
  animationId?: number;
  animation?: string;
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
    }
  | { kind: "enemyHp"; index: number; operation: "add" | "sub"; operand: RpgMakerValueOperand; allowDeath: boolean }
  | { kind: "enemyMp" | "enemyTp"; index: number; operation: "add" | "sub"; operand: RpgMakerValueOperand }
  | { kind: "enemyState"; index: number; operation: "add" | "remove"; stateId: number }
  | { kind: "enemyRecoverAll" | "enemyAppear"; index: number }
  | { kind: "enemyTransform"; index: number; enemyId: number }
  | { kind: "battleAnimation"; index: number; animationId: number; entireTroop: boolean; animation?: string }
  | { kind: "forceAction"; side: "enemy" | "actor"; subject: number; skillId: number; target: number }
  | { kind: "abort" };

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
  /** RPG Maker's actor/enemy/additional/removal state messages. */
  messages: [string, string, string, string];
  traits: RpgMakerTrait[];
}

export interface RpgMakerBattleMessages {
  actionFailure: string;
  actorDamage: string;
  enemyDamage: string;
  actorRecovery: string;
  enemyRecovery: string;
  actorLoss: string;
  enemyLoss: string;
  actorNoDamage: string;
  enemyNoDamage: string;
  actorNoHit: string;
  enemyNoHit: string;
  actorEvasion: string;
  enemyEvasion: string;
  actorMagicEvasion: string;
  enemyMagicEvasion: string;
  criticalToActor: string;
  criticalToEnemy: string;
  useItem: string;
  emerge: string;
  escapeStart: string;
  escapeFailure: string;
  victory: string;
  defeat: string;
  obtainExp: string;
  obtainGold: string;
  obtainItem: string;
  levelUp: string;
}

export interface RpgMakerMapEncounter {
  map: string;
  step: number;
  entries: { troopId: number; weight: number; regions: number[] }[];
}

export interface RpgMakerBattleMapSettings {
  map: string;
  /** RPG Maker distinguishes an unspecified battleback from an explicitly
   * specified empty name. Only the former enables overworld terrain defaults. */
  specified?: boolean;
  battleback1Name: string;
  battleback2Name: string;
  /** True only for tileset mode 0, where stock terrain defaults apply. */
  overworld?: boolean;
  /** Source map width for row-major terrain lookup. */
  width?: number;
  /** Sparse row-major autotile kinds selected from z=1 then z=0. Missing
   * cells have kind -1 and therefore use Grassland/Grassland. */
  autotileKinds?: [index: number, kind: number][];
}

export interface RpgMakerBattleDatabase {
  format: "rpgmaker-battle/v1";
  /** SHA-256 of canonical JSON for every other field. Battle commands carry
   * the same value, binding separately packaged battle.json to map content. */
  databaseHash: string;
  flavor: RpgMakerFlavor;
  /** True means authored side-view data is intentionally rendered front-view. */
  sideView: boolean;
  displayTp: boolean;
  /** Authored battle canvas used to scale troop member coordinates. */
  screen: { width: number; height: number };
  party: number[];
  actors: RpgMakerBattleActor[];
  weapons?: RpgMakerBattleEquipment[];
  armors?: RpgMakerBattleEquipment[];
  classes: RpgMakerBattleClass[];
  enemies: RpgMakerBattleEnemy[];
  troops: RpgMakerBattleTroop[];
  skills: RpgMakerBattleSkill[];
  items: RpgMakerBattleItem[];
  states: RpgMakerBattleStateDef[];
  encounters: RpgMakerMapEncounter[];
  elements: string[];
  currencyUnit: string;
  settings?: RpgMakerBattleSettings;
  mapSettings?: RpgMakerBattleMapSettings[];
  terms: {
    fight: string;
    escape: string;
    attack: string;
    guard: string;
    item: string;
    skill: string;
    basic: {
      level: string;
      levelAbbr: string;
      hp: string;
      hpAbbr: string;
      mp: string;
      mpAbbr: string;
      tp: string;
      tpAbbr: string;
      exp: string;
      expAbbr: string;
    };
    params: string[];
    messages: RpgMakerBattleMessages;
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
  /** Runtime-mutable fields default from the database when absent so saves
   * produced before actor-change support remain readable. */
  name?: string;
  nickname?: string;
  profile?: string;
  characterName?: string;
  characterIndex?: number;
  faceName?: string;
  faceIndex?: number;
  battlerName?: string;
  paramPlus?: [number, number, number, number, number, number, number, number];
  equips?: (RpgMakerEquipmentRef | null)[];
  classExp?: Record<string, number>;
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
  settings?: RpgMakerBattleSettings;
  /** Change Battle Background is map-local in RPG Maker. Keys are imported
   * map ids so a transfer restores the destination map's authored default. */
  mapSettings?: Record<string, { battleback1Name: string; battleback2Name: string }>;
}

/** The module owns one namespaced member and preserves every sibling. */
export interface RpgMakerBattleExtensionRoot {
  rpgmakerBattle: RpgMakerBattleRuntime;
}

export interface RpgMakerBattleBuff {
  /** -2..2 mirrors RPG Maker's debuff/buff stages. */
  level: number;
  turns: number;
}

export interface RpgMakerBattleCombatant {
  key: string;
  side: "actor" | "enemy";
  databaseId: number;
  name: string;
  hp: number;
  mp: number;
  tp: number;
  params: [number, number, number, number, number, number, number, number];
  states: { id: number; turns: number }[];
  buffs: RpgMakerBattleBuff[];
  guarding: boolean;
  hidden: boolean;
  /** Game_Battler's saved cursor used by Force Action target -2. */
  lastTargetIndex?: number;
  image?: string;
  actor?: {
    classId: number;
    level: number;
    exp: number;
    skills: number[];
    /** Runtime-mutable Change Actor Images projection. Front-view MZ status
     * and opt-in menu presentation consume the face; battlerName remains
     * available for side-view consumers. */
    faceName?: string;
    faceIndex?: number;
    battlerName?: string;
    paramPlus?: [number, number, number, number, number, number, number, number];
    equips?: (RpgMakerEquipmentRef | null)[];
    classExp?: Record<string, number>;
  };
}

export interface RpgMakerBattleAction {
  side: "actor" | "enemy";
  user: number;
  kind: "skill" | "item" | "guard";
  id: number;
  /** -1 means resolve the usable item's all/random/user scope at execution. */
  target: number;
  speed: number;
  /** Forced actions bypass ordinary usability/restriction checks. */
  forced?: boolean;
}

export type RpgMakerBattleAfterMessage =
  | "party"
  | "turnStart"
  | "nextAction"
  | "win"
  | "lose"
  | "escape";

/** Complete reducer-owned scene state. Presentation reads this JSON only. */
export interface RpgMakerBattleState {
  format: "rpgmaker-battle-state/v1";
  databaseHash: string;
  rng: number;
  nowTick: number;
  phase: "message" | "party" | "command" | "skill" | "item" | "target" | "done";
  turn: number;
  canEscape: boolean;
  canLose: boolean;
  escapeAttempts: number;
  troopId: number;
  actors: RpgMakerBattleCombatant[];
  enemies: RpgMakerBattleCombatant[];
  actorIndex: number;
  menuIndex: number;
  listIndex: number;
  targetIndex: number;
  actorActions: RpgMakerBattleAction[];
  queue: RpgMakerBattleAction[];
  queueIndex: number;
  selected?: { kind: "skill" | "item"; id: number };
  message: string;
  messageStart: number;
  afterMessage: RpgMakerBattleAfterMessage;
  result: "win" | "lose" | "escape" | null;
  /** Most recently committed HP change, used only for state-driven tweening. */
  effect: {
    side: "actor" | "enemy";
    index: number;
    from: number;
    to: number;
    startTick: number;
    duration: number;
    kind: "hit" | "heal" | "faint";
  } | null;
  pageRuns: { battle: boolean; lastTurn: number; active: boolean }[];
  variables: Record<string, number | string>;
  initialVariables: Record<string, number | string>;
  switches: Record<string, boolean>;
  initialSwitches: Record<string, boolean>;
  items: Record<string, number>;
  initialItems: Record<string, number>;
  gold: number;
  initialGold: number;
  reward: { exp: number; gold: number; items: Record<string, number>; levels: string[] };
  settings?: RpgMakerBattleSettings;
  /** A playable MV animation can be surfaced by the optional renderer. MZ
   * Effekseer records remain an explicit importer degradation. */
  battleAnimation?: {
    id: string;
    targets: number[];
    /** Omitted in older saves and troop-command markers, where enemy is the
     * backwards-compatible default. */
    targetSide?: "actor" | "enemy";
    startTick: number;
  } | null;
  ext: JsonValue;
}

