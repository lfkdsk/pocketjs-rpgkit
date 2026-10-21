// tools/rpgmaker-import/rm-types.ts — the subset of the RPG Maker MV/MZ
// `data/*.json` formats the importer reads. Field names follow the files
// as the MV/MZ editors write them; everything the importer does not read is
// left out (extra fields in real files are ignored).
//
// MV and MZ share these shapes. MZ adds `System.tileSize` and the
// `speakerName` parameter of Show Text; both are optional here.

/** One event command: `code` selects the command, `indent` nests it under
 *  the nearest preceding command of a lower indent (branches, loops,
 *  choices), `parameters` is code-specific. */
export interface RmCommand {
  code: number;
  indent: number;
  parameters: unknown[];
}

/** One step of a movement route (Set Movement Route, custom move type). */
export interface RmMoveCommand {
  code: number;
  parameters?: unknown[];
  indent?: number | null;
}

export interface RmMoveRoute {
  list: RmMoveCommand[];
  repeat: boolean;
  skippable: boolean;
  wait: boolean;
}

export interface RmAudio {
  name: string;
  volume: number;
  pitch: number;
  pan: number;
}

/** One RPG Maker trait. Only `code` and `dataId` are needed when deriving
 * an actor's initial equipment permissions, slots and trait-added skills. */
export interface RmTrait {
  code: number;
  dataId: number;
  value: number;
}

/** One cell in an MV frame. Patterns 0..99 address animation1 and 100..199
 * address animation2; each source pattern is a 192 px square in a five-column
 * sheet. The remaining fields are the values written by MV's animation
 * editor, in Sprite_Animation.updateCellSprite order. */
export type RmAnimationCell = [
  pattern: number,
  x: number,
  y: number,
  scale: number,
  rotation: number,
  mirror: boolean,
  opacity: number,
  blendMode: number,
];

/** A sound/flash marker on an MV animation frame. `flashDuration` is measured
 * in animation frames; MV multiplies it by the animation rate (four game
 * frames for database animations). */
export interface RmAnimationTiming {
  frame: number;
  se: RmAudio;
  /** 0 none, 1 target, 2 screen, 3 hide target. */
  flashScope: number;
  flashColor: [number, number, number, number];
  flashDuration: number;
}

/** RPG Maker MV's legacy cell animation. MZ databases may mix these records
 * with Effekseer entries; `frames` is the stock discriminator. */
export interface RmAnimation {
  id: number;
  name: string;
  animation1Name?: string;
  animation1Hue?: number;
  animation2Name?: string;
  animation2Hue?: number;
  /** 0 head, 1 center, 2 feet, 3 screen. */
  position?: number;
  frames?: RmAnimationCell[][];
  timings?: RmAnimationTiming[];
  /** MZ Effekseer entries omit legacy frames and name an effect instead. */
  effectName?: string;
}

/** Event page activation conditions (all present clauses must hold). */
export interface RmPageConditions {
  actorId: number;
  actorValid: boolean;
  itemId: number;
  itemValid: boolean;
  selfSwitchCh: string;
  selfSwitchValid: boolean;
  switch1Id: number;
  switch1Valid: boolean;
  switch2Id: number;
  switch2Valid: boolean;
  variableId: number;
  variableValid: boolean;
  variableValue: number;
}

export interface RmPageImage {
  tileId: number;
  characterName: string;
  /** 0..7 on an eight-character sheet; 0 on a `$` single-character sheet. */
  characterIndex: number;
  /** 2 down, 4 left, 6 right, 8 up. */
  direction: number;
  /** 0..2 walking pattern; 1 is the idle frame. */
  pattern: number;
}

export interface RmEventPage {
  conditions: RmPageConditions;
  directionFix: boolean;
  image: RmPageImage;
  list: RmCommand[];
  moveFrequency: number;
  moveRoute: RmMoveRoute;
  moveSpeed: number;
  /** 0 fixed, 1 random, 2 approach, 3 custom. */
  moveType: number;
  /** 0 below characters, 1 same as characters, 2 above characters. */
  priorityType: number;
  stepAnime: boolean;
  through: boolean;
  /** 0 action button, 1 player touch, 2 event touch, 3 autorun, 4 parallel. */
  trigger: number;
  walkAnime: boolean;
}

export interface RmEvent {
  id: number;
  name: string;
  note: string;
  pages: RmEventPage[];
  x: number;
  y: number;
}

export interface RmMap {
  autoplayBgm: boolean;
  autoplayBgs: boolean;
  battleback1Name?: string;
  battleback2Name?: string;
  bgm: RmAudio;
  bgs: RmAudio;
  displayName: string;
  encounterList: { regionSet: number[]; troopId: number; weight: number }[];
  encounterStep: number;
  height: number;
  width: number;
  note: string;
  parallaxName: string;
  parallaxLoopX: boolean;
  parallaxLoopY: boolean;
  parallaxSx: number;
  parallaxSy: number;
  /** Editor-only visibility toggle; runtime still uses parallaxName. */
  parallaxShow: boolean;
  scrollType: number;
  specifyBattleback: boolean;
  tilesetId: number;
  /** Six z-planes of width*height: z 0..3 tile ids, z 4 shadow bits, z 5
   *  region ids. Index = (z * height + y) * width + x. */
  data: number[];
  /** Index 0 is null; event ids index the array. Deleted events are null. */
  events: (RmEvent | null)[];
}

export interface RmMapInfo {
  id: number;
  name: string;
  order: number;
  parentId: number;
  expanded?: boolean;
  scrollX?: number;
  scrollY?: number;
}

export interface RmCommonEvent {
  id: number;
  name: string;
  /** 0 none, 1 autorun, 2 parallel. */
  trigger: number;
  switchId: number;
  list: RmCommand[];
}

export interface RmTileset {
  id: number;
  name: string;
  /** 0 world, 1 area, 2 VX compatible. */
  mode: number;
  /** A1, A2, A3, A4, A5, B, C, D, E image names (without extension). */
  tilesetNames: string[];
  /** 8192 passage/attribute bit fields, indexed by tile id. */
  flags: number[];
  note: string;
}

export interface RmItem {
  id: number;
  name: string;
  description: string;
  iconIndex: number;
  price: number;
  consumable?: boolean;
  /** 1 regular, 2 key item, 3 hidden A, 4 hidden B (items only). */
  itypeId?: number;
  /** Equipment slot type (weapons are 1; armor types start at 2). */
  etypeId?: number;
  /** Permitted-weapon type checked by trait code 51 (weapons only). */
  wtypeId?: number;
  /** Permitted-armor type checked by trait code 52 (armors only). */
  atypeId?: number;
  /** Additive MHP..LUK parameters (weapons and armors). */
  params?: number[];
  traits?: RmTrait[];
  scope?: number;
  occasion?: number;
  repeats?: number;
  speed?: number;
  successRate?: number;
  /** 0 certain, 1 physical, 2 magical. */
  hitType?: number;
  tpGain?: number;
  damage?: RmDamage;
  effects?: RmEffect[];
  animationId?: number;
  note: string;
}

export interface RmDamage {
  critical: boolean;
  elementId: number;
  formula: string;
  /** 0 none, 1 HP damage, 2 MP damage, 3 HP recovery, 4 MP recovery,
   * 5 HP drain, 6 MP drain. */
  type: number;
  variance: number;
}

export interface RmEffect {
  code: number;
  dataId: number;
  value1: number;
  value2: number;
}

export interface RmActor {
  id: number;
  name: string;
  nickname: string;
  characterName: string;
  characterIndex: number;
  faceName: string;
  faceIndex: number;
  classId: number;
  initialLevel: number;
  maxLevel?: number;
  battlerName?: string;
  profile?: string;
  /** Database ids aligned with the actor's equip slots. */
  equips: number[];
  traits: RmTrait[];
  note: string;
}

export interface RmLearning {
  level: number;
  skillId: number;
  note?: string;
}

export interface RmClass {
  id: number;
  name: string;
  learnings: RmLearning[];
  params?: number[][];
  expParams?: number[];
  traits: RmTrait[];
  note: string;
}

export interface RmSkill {
  id: number;
  name: string;
  description?: string;
  iconIndex?: number;
  scope?: number;
  occasion?: number;
  repeats?: number;
  speed?: number;
  successRate?: number;
  hitType?: number;
  tpGain?: number;
  mpCost?: number;
  tpCost?: number;
  stypeId?: number;
  damage?: RmDamage;
  effects?: RmEffect[];
  animationId?: number;
  note: string;
}

export interface RmState {
  id: number;
  name: string;
  restriction?: number;
  priority?: number;
  minTurns?: number;
  maxTurns?: number;
  autoRemovalTiming?: number;
  removeAtBattleEnd?: boolean;
  removeByDamage?: boolean;
  chanceByDamage?: number;
  /** MV/MZ state overlay row and priority motion (0..3). */
  overlay?: number;
  motion?: number;
  message1?: string;
  message2?: string;
  message3?: string;
  message4?: string;
  traits?: RmTrait[];
  note: string;
}

export interface RmEnemyAction {
  conditionParam1: number;
  conditionParam2: number;
  conditionType: number;
  rating: number;
  skillId: number;
}

export interface RmEnemy {
  id: number;
  name: string;
  battlerName: string;
  battlerHue: number;
  params: number[];
  exp: number;
  gold: number;
  actions: RmEnemyAction[];
  dropItems: { kind: number; dataId: number; denominator: number }[];
  traits: RmTrait[];
  note: string;
}

export interface RmTroopPageCondition {
  actorHp: number;
  actorId: number;
  actorValid: boolean;
  enemyHp: number;
  enemyIndex: number;
  enemyValid: boolean;
  switchId: number;
  switchValid: boolean;
  turnA: number;
  turnB: number;
  turnEnding: boolean;
  turnValid: boolean;
}

export interface RmTroopPage {
  conditions: RmTroopPageCondition;
  list: RmCommand[];
  /** 0 battle, 1 turn, 2 moment. */
  span: number;
}

export interface RmTroop {
  id: number;
  name: string;
  members: { enemyId: number; x: number; y: number; hidden: boolean }[];
  pages: RmTroopPage[];
}

/** One of System.json's built-in boat, ship or airship records. */
export interface RmVehicle {
  bgm: RmAudio;
  characterIndex: number;
  characterName: string;
  startMapId: number;
  startX: number;
  startY: number;
}

export interface RmSystem {
  gameTitle: string;
  currencyUnit: string;
  partyMembers: number[];
  battleBgm?: RmAudio;
  victoryMe?: RmAudio;
  defeatMe?: RmAudio;
  optSideView?: boolean;
  /** Weapon type index -> attack pose (0 thrust, 1 swing, 2 missile) and sheet id. */
  attackMotions?: { type: number; weaponImageId: number }[];
  /** Skill-type ids which use RPG Maker's magic chant and spell motions. */
  magicSkills?: number[];
  optDisplayTp?: boolean;
  optExtraExp?: boolean;
  elements?: string[];
  terms?: {
    basic?: (string | null)[];
    commands?: (string | null)[];
    messages?: Record<string, string>;
    params?: (string | null)[];
  };
  /** Index 0 is blank; indices 1..n define the actor's equipment slots. */
  equipTypes?: string[];
  /** Initial visibility of the party trail and player, respectively. */
  optFollowers?: boolean;
  optTransparent?: boolean;
  boat?: RmVehicle;
  ship?: RmVehicle;
  airship?: RmVehicle;
  startMapId: number;
  startX: number;
  startY: number;
  switches: string[];
  variables: string[];
  /** MZ only; MV is always 48. */
  tileSize?: number;
  locale?: string;
  /** Present in both; MZ writes `advanced` with extra screen settings. */
  advanced?: { screenWidth?: number; screenHeight?: number };
  /** MV/MZ store the editor version as a number; MZ files carry
   *  `versionId` and an `advanced` block. */
  versionId?: number;
  /** Deployment media flags and XOR key. The importer consumes these at
   *  build time; they are never copied into the kit project. */
  hasEncryptedImages?: boolean;
  hasEncryptedAudio?: boolean;
  encryptionKey?: string;
}

/** Everything the importer reads from one project's `data/` directory.
 *  Arrays keep the files' own layout: index 0 is null and ids index the
 *  array; a missing optional file reads as `[null]`. */
export interface RmPluginDeclaration {
  name: string;
  status: boolean;
  description: string;
  parameters: Record<string, string>;
}

export interface RmProject {
  /** Parsed js/plugins.js declarations only; never plugin JavaScript. */
  plugins?: RmPluginDeclaration[];
  /** Absolute project root (the directory holding `data/` and `img/`). */
  root: string;
  /** "MZ" when System.json has the MZ-only fields, else "MV". */
  flavor: "MV" | "MZ";
  /** Host operations for media discovery and conversion. `loadRmProject`
   * installs the Node/Bun adapter; the web loader installs a DirectoryHandle
   * adapter. Synthetic unit-test projects may omit it. */
  environment?: import("./environment.ts").RpgMakerImportEnvironment;
  /** Validated deployment-media settings, absent for ordinary projects. */
  mediaEncryption?: import("./media-crypto.ts").RpgMakerMediaEncryption;
  system: RmSystem;
  mapInfos: (RmMapInfo | null)[];
  maps: Map<number, RmMap>;
  tilesets: (RmTileset | null)[];
  commonEvents: (RmCommonEvent | null)[];
  items: (RmItem | null)[];
  weapons: (RmItem | null)[];
  armors: (RmItem | null)[];
  actors: (RmActor | null)[];
  classes: (RmClass | null)[];
  skills: (RmSkill | null)[];
  states: (RmState | null)[];
  enemies: (RmEnemy | null)[];
  troops: (RmTroop | null)[];
  animations: (RmAnimation | null)[];
}
