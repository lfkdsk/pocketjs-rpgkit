// tools/rpgmaker-import/project.ts — assemble one rpgkit-project/v1
// document (plus the art a cooker needs) from a loaded RPG Maker project.
//
// Maps: every tile layer is composed per cell (compose.ts) into generated
// tile sheets, one per RM tileset ("ts<id>"); the sheet carries each
// cell's passage (block list and the undirected dirBlock edges that match
// MV's four passage bits). Events, common events and the database go
// through events.ts. Art the runtime needs besides the tile sheets
// (character blocks, tile-image events, pictures, the balloon sheet,
// animated water cells) is listed in an ImportAssets manifest so a game's
// asset cooker can bake it; the importer itself never runs at game time.

import type {
  ActorDef,
  AnimationDef,
  AnimationTimingDef,
  CommonEvent,
  Condition,
  Command,
  GameEvent,
  Item,
  MapDef,
  MapTilesetVariant,
  ParallaxDef,
  Page,
  PageCondition,
  Project,
  Sheet,
  SpriteDef,
  TileId,
  VehicleDef,
} from "../../src/engine/types.ts";
import type { RpgMakerBattleDatabase } from "../../src/rpgmaker-battle/types.ts";
import {
  rpgMakerBattleback1ForKind,
  rpgMakerBattleback2ForKind,
} from "../../src/rpgmaker-battle/battleback.ts";
import {
  RPGMAKER_ENCOUNTER_DUE_VARIABLE,
} from "../../src/rpgmaker-battle/rules.ts";
import { cookMvAnimation, MV_ANIMATION_RATE, MvAnimationCookError } from "./animation.ts";
import {
  audioMediaKey,
  type AudioMediaRecord,
  type AudioMediaSuccess,
  type RpgMakerAudioKind,
} from "./audio-types.ts";
import { Coverage } from "./coverage.ts";
import { EMPTY_RPGMAKER_IMPORT_ENVIRONMENT, type RpgMakerImportEnvironment } from "./environment.ts";
import { importBattleDatabase } from "./battle-data.ts";
import { TileAtlas, composeMap } from "./compose.ts";
import { convertCommonEvent, convertPage, type EventContext } from "./events.ts";
import {
  actorId,
  animationId,
  classId,
  commonId,
  eventId,
  itemId,
  mapId,
  partySwitchId,
  skillId,
  slug,
} from "./ids.ts";
import { rmParallaxSpeed, rmTileSize } from "./semantics.ts";
import { passes, RM_FLAG } from "./passage.ts";
import { blankImage, blit, type RgbaImage } from "./image.ts";
import type { RpgMakerMediaEncryption } from "./media-crypto.ts";
import type { RmActor, RmCommand, RmItem, RmPageImage, RmProject, RmTrait, RmVehicle } from "./rm-types.ts";
import { downscale, drawTile, loadTilesetImages, type TilesetImages } from "./tile-render.ts";

export interface ImportOptions {
  /** "visible" turns plugin/script commands into a text box naming them;
   *  "silent" drops them (both count as Placeholder). */
  placeholders?: "visible" | "silent";
}

export interface ImportAnimatedCell {
  x: number;
  y: number;
  above: boolean;
  frames: TileId[];
  frameSeconds: number;
}

/** Render-side outputs a cooker bakes. Paths are relative to the output
 *  directory. */
export interface ImportAssets {
  format: "rpgkit-rpgmaker-assets/v1";
  /** Sheet id -> generated 16 px tile sheet PNG. */
  sheets: Record<string, { png: string; cols: number; rows: number }>;
  /** Sprite key -> PNG of a 3x4 walker block (16 px frames) or a 16x16 tile. */
  sprites: Record<string, { png: string; kind: "walker" | "image"; h: 16 | 32 }>;
  /** Base tile-event sprite key -> active tileset id -> matching tile sprite.
   * Render-only: Change Tileset does not rewrite event/page reducer state. */
  tileEventVariants?: Record<string, Record<string, string>>;
  /** Picture variant id -> source picture PNG (screen-sized, not rescaled). */
  pictures: Record<string, string>;
  /** Parallax image id -> generated logical-pixel PNG and dimensions. */
  parallaxes: Record<string, { png: string; w: number; h: number }>;
  /** Animation id -> generated source sheet plus render-only placement. */
  animations: Record<string, {
    sheet: string;
    offsetX: number;
    offsetY: number;
    originOffsetX?: number;
    originOffsetY?: number;
    position?: 0 | 1 | 2 | 3;
  }>;
  /** Map id -> animated cells (water, waterfalls): sheet cells per step. */
  animated: Record<string, ImportAnimatedCell[]>;
  /** Maps with Change Tileset: map id -> tileset id -> animated cells.
   * Empty lists are significant: selecting that tileset suppresses the
   * authored tileset's animation rather than falling back to it. `animated`
   * remains the base-only spelling consumed by older asset cookers. */
  animatedVariants?: Record<string, Record<string, ImportAnimatedCell[]>>;
  /** Logical audio id -> converted output-relative QOA path. */
  audio: Record<string, string>;
  /** Enemy database id -> imported front-view battler PNG. */
  battlers: Record<string, { png: string; w: number; h: number }>;
  /** Exact RPG Maker battleback basename -> imported source image. */
  battlebacks1: Record<string, { png: string; w: number; h: number }>;
  battlebacks2: Record<string, { png: string; w: number; h: number }>;
  /** The balloon sheet (8 columns x 15 rows of 16 px frames), when used. */
  balloon?: string;
  /** Sprite key of the starting party leader's walking character. */
  player?: string;
}

export interface ImportResult {
  project: Project;
  /** Optional runtime module data written separately as battle.json. */
  battle: RpgMakerBattleDatabase;
  /** Generated images keyed by their output-relative path. */
  images: Map<string, RgbaImage>;
  /** Converted QOA files keyed by their output-relative path. */
  audioFiles: Map<string, Uint8Array>;
  /** Source media copied into the output after any deployment decryption. */
  mediaFiles: Map<string, Uint8Array>;
  /** Per-logical-medium conversion facts for coverage and duration checks. */
  audioMedia: AudioMediaRecord[];
  assets: ImportAssets;
  cov: Coverage;
  warnings: string[];
}

const KIT_TILE = 16;
/** MV balloon: 8 patterns, each shown for 8 frames, then a 12 frame hold
 *  (Sprite_Balloon speed 8, waitTime 12); the kit plays the 8 patterns. */
const BALLOON_FRAME_SECONDS = 8 / 60;

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

interface RegisteredAudio {
  kind: RpgMakerAudioKind;
  name: string;
  id: string;
}

function meDurationSeconds(media: AudioMediaSuccess, pitch: number): number {
  const outputFrames = Math.ceil(media.frames * 100 / pitch);
  return Math.ceil(outputFrames * 60 / media.sampleRate) / 60;
}

/** Fill every imported ME command after media decoding, including commands
 * nested inside choices, branches, loops and battle/scene continuations. */
function applyImportedMeDurations(
  project: Project,
  mediaById: ReadonlyMap<string, AudioMediaSuccess>,
): void {
  const nestedKeys = [
    "commands", "then", "else", "onWin", "onLose", "onEscape", "onDone", "onCancel",
  ] as const;
  const visit = (commands: Command[]): void => {
    for (let index = 0; index < commands.length;) {
      const command = commands[index]!;
      if (command.op === "playMe") {
        const media = mediaById.get(command.id);
        // A zero-duration playMe is the runtime spelling for an explicit ME
        // stop. Missing/corrupt named media must instead be a true dropped
        // import, as recorded in the audio coverage section.
        if (!media) {
          commands.splice(index, 1);
          continue;
        }
        command.duration = meDurationSeconds(media, command.pitch ?? 100);
      }
      const record = command as Command & Record<string, unknown>;
      for (const key of nestedKeys) {
        if (Array.isArray(record[key])) visit(record[key] as Command[]);
      }
      if (command.op === "choices") {
        for (const option of command.options) visit(option.commands);
        if (command.cancel) visit(command.cancel.commands);
      }
      index++;
    }
  };
  for (const map of project.maps) {
    for (const event of map.events ?? []) for (const page of event.pages) visit(page.commands);
  }
  for (const common of project.commonEvents ?? []) visit(common.commands);
}

/** Sparse [index, value] pairs for a row-major plane, keeping only nonzero
 *  cells so a map without regions/terrain carries no data. */
function sparseCells(plane: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < plane.length; i++) {
    const v = plane[i]!;
    if (v !== 0) out.push([i, v]);
  }
  return out;
}

/** Sparse [index, [z0, z1, z2, z3]] from an MV map's six-plane data array,
 *  keeping only cells with a nonzero tile in any of the four tile layers so
 *  Get Location Info's tile kind returns the raw MV tile ids. */
function sparseTileLayers(data: readonly number[], width: number, height: number): [number, [number, number, number, number]][] {
  const plane = width * height;
  const out: [number, [number, number, number, number]][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const layers: [number, number, number, number] = [
        data[0 * plane + i] ?? 0,
        data[1 * plane + i] ?? 0,
        data[2 * plane + i] ?? 0,
        data[3 * plane + i] ?? 0,
      ];
      if (layers[0] !== 0 || layers[1] !== 0 || layers[2] !== 0 || layers[3] !== 0) {
        out.push([i, layers]);
      }
    }
  }
  return out;
}

/** Project MV/MZ's three vehicle passage checks onto row-major kit cells. */
function vehiclePassage(
  data: readonly number[],
  width: number,
  height: number,
  flags: readonly number[],
): NonNullable<MapDef["vehiclePassage"]> {
  const plane = width * height;
  const boat: number[] = [];
  const ship: number[] = [];
  const airshipLand: number[] = [];
  for (let i = 0; i < plane; i++) {
    const stack = [
      data[0 * plane + i] ?? 0,
      data[1 * plane + i] ?? 0,
      data[2 * plane + i] ?? 0,
      data[3 * plane + i] ?? 0,
    ];
    if (passes(stack, flags, RM_FLAG.BOAT)) boat.push(i);
    if (passes(stack, flags, RM_FLAG.SHIP)) ship.push(i);
    if (passes(stack, flags, RM_FLAG.AIRSHIP) && passes(stack, flags, 0x0f)) airshipLand.push(i);
  }
  return { boat, ship, airshipLand };
}

/** Collect syntactically valid Change Tileset operands from an RPG Maker
 * flat command list. Indentation only encodes the command tree; every line
 * remains reachable through some branch, loop, choice or battle outcome. */
function collectTilesetReferences(commands: readonly RmCommand[], into: Set<number>): void {
  for (const command of commands) {
    if (command.code !== 282) continue;
    const id = command.parameters?.[0];
    if (typeof id === "number" && Number.isInteger(id) && id > 0) into.add(id);
  }
}

/** MV itypeId (1 regular, 2 key, 3 hidden A, 4 hidden B). Absent/other
 *  defaults to regular. */
function itemTypeOf(itypeId: number | undefined): Item["type"] {
  switch (itypeId) {
    case 2: return "key";
    case 3: return "hiddenA";
    case 4: return "hiddenB";
    default: return "regular";
  }
}

function clampNumber(value: unknown, lo: number, hi: number, fallback: number): number {
  const numeric = Number(value);
  return Math.min(hi, Math.max(lo, Number.isFinite(numeric) ? numeric : fallback));
}

function byteNumber(value: unknown): number {
  return Math.round(clampNumber(value, 0, 255, 0));
}

function nonEmpty(s: string | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : fallback;
}

const TRAIT_SKILL_ADD = 43;
const TRAIT_EQUIP_WTYPE = 51;
const TRAIT_EQUIP_ATYPE = 52;
// Trait 53 locks changing a slot but does not invalidate its initial item.
const TRAIT_EQUIP_SEAL = 54;
const TRAIT_SLOT_TYPE = 55;
const SLOT_DUAL_WIELD = 1;

interface InitialEquip {
  kind: "weapon" | "armor";
  id: number;
  item: RmItem;
}

function traitDataIds(traits: readonly RmTrait[] | undefined, code: number): number[] {
  return (traits ?? []).flatMap((trait) =>
    trait.code === code && Number.isInteger(trait.dataId) && trait.dataId > 0
      ? [trait.dataId]
      : []);
}

function actorEquipSlots(rm: RmProject, traits: readonly RmTrait[]): number[] {
  const slots = Array.from(
    { length: Math.max(0, (rm.system.equipTypes?.length ?? 0) - 1) },
    (_, index) => index + 1,
  );
  if (slots.length >= 2 && traits.some((trait) =>
    trait.code === TRAIT_SLOT_TYPE && trait.dataId === SLOT_DUAL_WIELD)) {
    slots[1] = 1;
  }
  return slots;
}

function initialEquipTraits(baseTraits: readonly RmTrait[], equips: readonly (InitialEquip | null)[]): RmTrait[] {
  return [
    ...baseTraits,
    ...equips.flatMap((equip) => equip?.item.traits ?? []),
  ];
}

/** RPG Maker's Game_Actor.setup/initSkills/initEquips projected onto the
 * immutable actor facts used by imported conditional branches. Runtime
 * change-class/skill/equipment/state commands remain separately reported
 * as unsupported, so these are intentionally initial facts. */
function importActorDef(rm: RmProject, actor: RmActor): ActorDef {
  const out: ActorDef = { id: actorId(actor.id), databaseId: actor.id, name: actor.name };
  const actorClass = rm.classes[actor.classId] ?? null;
  if (actorClass) out.classId = classId(actorClass.id);

  const baseTraits = [...(actor.traits ?? []), ...(actorClass?.traits ?? [])];
  // Game_Actor.initEquips decides each raw id's database from the slots
  // before any equipment exists. Equipment traits can change those slots
  // only when releaseUnequippableItems subsequently validates the objects.
  const initialSlots = actorEquipSlots(rm, baseTraits);
  const equips: (InitialEquip | null)[] = initialSlots.map((slotType, slot) => {
    const id = actor.equips?.[slot] ?? 0;
    if (!Number.isInteger(id) || id <= 0) return null;
    const kind = slotType === 1 ? "weapon" : "armor";
    const item = kind === "weapon" ? rm.weapons[id] : rm.armors[id];
    return item ? { kind, id, item } : null;
  });

  // Match releaseUnequippableItems: slots are fixed for one pass, while
  // canEquip observes earlier removals in that pass. A later pass then sees
  // slot changes caused by losing a dual-wield trait. Each changing pass
  // removes at least one object, so the loop is finite.
  for (;;) {
    const slots = actorEquipSlots(rm, initialEquipTraits(baseTraits, equips));
    let changed = false;
    for (let slot = 0; slot < equips.length; slot++) {
      const equip = equips[slot];
      if (!equip) continue;
      const traits = initialEquipTraits(baseTraits, equips);
      const permittedWeaponTypes = new Set(traitDataIds(traits, TRAIT_EQUIP_WTYPE));
      const permittedArmorTypes = new Set(traitDataIds(traits, TRAIT_EQUIP_ATYPE));
      const sealedEquipTypes = new Set(traitDataIds(traits, TRAIT_EQUIP_SEAL));
      const permitted = equip.kind === "weapon"
        ? permittedWeaponTypes.has(equip.item.wtypeId ?? 0)
        : permittedArmorTypes.has(equip.item.atypeId ?? 0);
      if (!permitted || sealedEquipTypes.has(equip.item.etypeId ?? 0) || equip.item.etypeId !== slots[slot]) {
        equips[slot] = null;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const survivingEquips = equips.flatMap((equip) => equip ? [equip] : []);
  const weaponNumbers = survivingEquips.filter((equip) => equip.kind === "weapon").map((equip) => equip.id);
  const armorNumbers = survivingEquips.filter((equip) => equip.kind === "armor").map((equip) => equip.id);
  const equipTraits = survivingEquips.flatMap((equip) => equip.item.traits ?? []);
  if (weaponNumbers.length > 0) {
    out.weapons = [...new Set(weaponNumbers)].sort((a, b) => a - b).map((id) => itemId("weapon", id));
  }
  if (armorNumbers.length > 0) {
    out.armors = [...new Set(armorNumbers)].sort((a, b) => a - b).map((id) => itemId("armor", id));
  }

  const skillNumbers = new Set<number>();
  for (const learning of actorClass?.learnings ?? []) {
    if (Number.isInteger(learning.level) && learning.level <= actor.initialLevel && rm.skills[learning.skillId]) {
      skillNumbers.add(learning.skillId);
    }
  }
  for (const id of traitDataIds([...baseTraits, ...equipTraits], TRAIT_SKILL_ADD)) {
    if (rm.skills[id]) skillNumbers.add(id);
  }
  if (skillNumbers.size > 0) {
    out.skills = [...skillNumbers].sort((a, b) => a - b).map(skillId);
  }
  return out;
}

export async function importRmProject(rm: RmProject, options: ImportOptions = {}): Promise<ImportResult> {
  const environment = rm.environment ?? EMPTY_RPGMAKER_IMPORT_ENVIRONMENT;
  const cov = new Coverage();
  const warnings: string[] = [];
  const images = new Map<string, RgbaImage>();
  const tileSize = rmTileSize(rm);
  if (tileSize % KIT_TILE !== 0) {
    throw new Error(`rpgmaker-import: tile size ${tileSize} is not a multiple of ${KIT_TILE}`);
  }
  const scale = tileSize / KIT_TILE;
  const rpgMakerTextColours = await readWindowColours(rm, environment);
  const assets: ImportAssets = {
    format: "rpgkit-rpgmaker-assets/v1",
    sheets: {},
    sprites: {},
    pictures: {},
    parallaxes: {},
    animations: {},
    animated: {},
    audio: {},
    battlers: {},
    battlebacks1: {},
    battlebacks2: {},
  };
  const audioRequests = new Map<string, RegisteredAudio>();
  const audioIds = new Set<string>();
  const audioFor = (kind: RpgMakerAudioKind, name: string): string => {
    const key = audioMediaKey(kind, name);
    const known = audioRequests.get(key);
    if (known) return known.id;
    const base = `${kind}-${slug(name) || "audio"}`;
    let id = base;
    for (let suffix = 2; audioIds.has(id); suffix++) id = `${base}-${suffix}`;
    audioIds.add(id);
    audioRequests.set(key, { kind, name, id });
    return id;
  };

  // --- front-view battlers and normalized battle database -----------------
  const enemyImages = new Map<number, string>();
  for (const enemy of rm.enemies) {
    if (!enemy?.battlerName) continue;
    const front = findNamedPng(environment, environment.join(rm.root, "img", "enemies"), enemy.battlerName, rm.mediaEncryption);
    const side = findNamedPng(environment, environment.join(rm.root, "img", "sv_enemies"), enemy.battlerName, rm.mediaEncryption);
    const path = front ?? side;
    if (!path) continue;
    const id = `enemy${String(enemy.id).padStart(3, "0")}`;
    const png = `battlers/${id}.png`;
    const image = await environment.readPng(path, rm.mediaEncryption);
    images.set(png, image);
    assets.battlers[id] = { png, w: image.width, h: image.height };
    enemyImages.set(enemy.id, id);
    if (!front && side) {
      warnings.push(`enemy ${enemy.id}: side-view battler ${enemy.battlerName} is shown in the front-view renderer`);
    }
  }
  // --- tilesets -----------------------------------------------------------
  const atlases = new Map<number, TileAtlas>();
  const tilesetImages = new Map<number, TilesetImages>();
  const atlasFor = async (tilesetId: number): Promise<{ atlas: TileAtlas; images: TilesetImages }> => {
    const tileset = rm.tilesets[tilesetId];
    if (!tileset) throw new Error(`rpgmaker-import: tileset ${tilesetId} is missing from Tilesets.json`);
    let atlas = atlases.get(tilesetId);
    if (!atlas) {
      atlas = new TileAtlas(`ts${tilesetId}`);
      atlases.set(tilesetId, atlas);
      tilesetImages.set(tilesetId, await loadTilesetImages(environment, rm.root, tileset.tilesetNames, tileSize, rm.mediaEncryption));
    }
    return { atlas, images: tilesetImages.get(tilesetId)! };
  };

  // --- sprites (characters and tile-image events) -------------------------
  const characterSheets = new Map<string, RgbaImage | null>();
  const spriteKeys = new Map<string, string | null>();
  let currentTilesetId = 0;
  let currentTilesetVariants: readonly number[] = [];
  const loadCharacterSheet = async (name: string): Promise<RgbaImage | null> => {
    if (!characterSheets.has(name)) {
      const path = findNamedPng(environment, environment.join(rm.root, "img", "characters"), name, rm.mediaEncryption);
      characterSheets.set(name, path ? await environment.readPng(path, rm.mediaEncryption) : null);
    }
    return characterSheets.get(name)!;
  };
  // Sprites are registered synchronously from the event converter, so the
  // pixels are cut afterwards (resolveSprites) from these requests.
  const spriteRequests: { key: string; image: Pick<RmPageImage, "characterName" | "characterIndex" | "tileId">; tilesetId: number }[] = [];
  const requestTileSprite = (
    image: Pick<RmPageImage, "characterName" | "characterIndex" | "tileId">,
    tilesetId: number,
  ): string => {
    const key = `tile-${tilesetId}-${image.tileId}`;
    if (!spriteKeys.has(key)) {
      spriteKeys.set(key, key);
      spriteRequests.push({ key, image, tilesetId });
    }
    return key;
  };
  const spriteFor = (image: Pick<RmPageImage, "characterName" | "characterIndex" | "tileId">): string | null => {
    if (image.tileId > 0) {
      const key = requestTileSprite(image, currentTilesetId);
      if (currentTilesetVariants.length > 1) {
        const variants = (assets.tileEventVariants ??= {})[key] ??= {};
        for (const tilesetId of currentTilesetVariants) {
          variants[`ts${tilesetId}`] = requestTileSprite(image, tilesetId);
        }
      }
      return key;
    }
    if (!image.characterName) return null;
    const big = image.characterName.includes("$");
    const key = `chr-${slug(image.characterName)}${big ? "" : `-${image.characterIndex}`}`;
    if (!spriteKeys.has(key)) {
      spriteKeys.set(key, key);
      spriteRequests.push({ key, image, tilesetId: currentTilesetId });
    }
    return key;
  };

  // --- pictures, balloons, audio ------------------------------------------
  const pictureRequests = new Map<string, string>();
  const pictureFor = (name: string): string => {
    const id = slug(name);
    if (!assets.pictures[id]) {
      assets.pictures[id] = `pictures/${id}.png`;
      pictureRequests.set(id, name);
    }
    return id;
  };
  const parallaxRequests = new Map<string, { image: string; zero: boolean }>();
  const parallaxIds = new Set<string>();
  const parallaxFor = (name: string): { image: string; zero: boolean } | null => {
    const raw = name.trim();
    if (!raw) return null;
    const existing = parallaxRequests.get(raw);
    if (existing) return existing;
    const zero = raw.startsWith("!");
    const base = `parallax-${slug(zero ? raw.slice(1) : raw) || "image"}`;
    let image = base;
    for (let suffix = 2; parallaxIds.has(image); suffix++) image = `${base}-${suffix}`;
    parallaxIds.add(image);
    const request = { image, zero };
    parallaxRequests.set(raw, request);
    return request;
  };
  const balloonPath = findNamedPng(environment, environment.join(rm.root, "img", "system"), "Balloon", rm.mediaEncryption);
  const hasBalloon = balloonPath !== null;
  const balloonsUsed = new Set<number>();
  const balloonFor = (n: number): string | null => {
    if (!hasBalloon || n < 1 || n > 15) return null;
    balloonsUsed.add(n);
    return `balloon${n}`;
  };
  // --- MV database animations --------------------------------------------
  const animations: AnimationDef[] = [];
  const animationImports = new Map<number, { id: string; disposition: "Native" | "Degraded"; reason?: string }>();
  const animationFailures = new Map<number, string>();
  const usedAnimationIds = new Set<number>();
  const collectAnimations = (list: readonly { code: number; parameters?: unknown[] }[]): void => {
    for (const command of list) {
      if (command.code === 212) usedAnimationIds.add(Math.max(0, Math.trunc(Number(command.parameters?.[1] ?? 0))));
    }
  };
  for (const rmMap of rm.maps.values()) {
    for (const event of rmMap.events) for (const page of event?.pages ?? []) collectAnimations(page.list);
  }
  for (const common of rm.commonEvents) if (common) collectAnimations(common.list);
  for (const troop of rm.troops) {
    if (!troop) continue;
    for (const page of troop.pages ?? []) {
      for (const command of page.list ?? []) {
        if (command.code === 337) usedAnimationIds.add(Math.max(0, Math.trunc(Number(command.parameters?.[1] ?? 0))));
      }
    }
  }
  for (const usable of [...rm.skills, ...rm.items]) {
    if (usable && Number.isInteger(usable.animationId)) usedAnimationIds.add(Math.max(0, usable.animationId ?? 0));
  }
  for (const n of [...usedAnimationIds].filter((id) => id > 0).sort((a, b) => a - b)) {
    const source = rm.animations[n];
    if (!source) {
      animationFailures.set(n, `animation ${n} does not exist`);
      continue;
    }
    if (!Array.isArray(source.frames)) {
      animationFailures.set(n, "MZ Effekseer animations are not supported by the MV cell compositor");
      continue;
    }
    try {
      const image = async (name: string) => {
        if (!name) return null;
        const path = findNamedPng(environment, environment.join(rm.root, "img", "animations"), name, rm.mediaEncryption);
        return path ? environment.readPng(path, rm.mediaEncryption) : null;
      };
      const cooked = cookMvAnimation(source, {
        animation1: await image(source.animation1Name ?? ""),
        animation2: await image(source.animation2Name ?? ""),
      }, tileSize);
      const id = animationId(n);
      const sheet = `animations/${id}.png`;
      images.set(sheet, cooked.sheet);
      assets.animations[id] = {
        sheet,
        offsetX: cooked.offsetX,
        offsetY: cooked.offsetY,
        originOffsetX: cooked.originOffsetX,
        originOffsetY: cooked.originOffsetY,
        position: source.position as 0 | 1 | 2 | 3,
      };
      const degradations = [...cooked.degradations];
      const timings: AnimationTimingDef[] = [];
      for (const timing of source.timings ?? []) {
        const entry: AnimationTimingDef = { frame: Math.max(0, Math.trunc(timing.frame)) };
        if (timing.se?.name) {
          entry.se = {
            id: audioFor("se", timing.se.name),
            volume: clampNumber(timing.se.volume, 0, 100, 100),
            pitch: clampNumber(timing.se.pitch, 50, 150, 100),
            ...(timing.se.pan !== 0
              ? { pan: Math.round(clampNumber(timing.se.pan, -100, 100, 0)) }
              : {}),
          };
        }
        if (timing.flashScope === 2) {
          const color = Array.isArray(timing.flashColor) ? timing.flashColor : [255, 255, 255, 0];
          entry.flash = {
            color: { r: byteNumber(color[0]), g: byteNumber(color[1]), b: byteNumber(color[2]), a: 255 },
            intensity: byteNumber(color[3]),
            duration: Math.max(0, Number(timing.flashDuration) || 0) * MV_ANIMATION_RATE / 60,
          };
        } else if (timing.flashScope === 1) {
          degradations.push("target-local animation flash is omitted");
        } else if (timing.flashScope === 3) {
          degradations.push("temporary target hiding is omitted");
        }
        if (entry.se || entry.flash) timings.push(entry);
      }
      const uniqueDegradations = [...new Set(degradations)];
      for (const warning of cooked.warnings) warnings.push(`${id}: ${warning}`);
      animations.push({
        id,
        sheet,
        frameW: cooked.frameW,
        frameH: cooked.frameH,
        cols: cooked.cols,
        count: cooked.count,
        frameDuration: MV_ANIMATION_RATE / 60,
        loop: false,
        ...(timings.length > 0 ? { timings } : {}),
      });
      animationImports.set(n, {
        id,
        disposition: uniqueDegradations.length > 0 ? "Degraded" : "Native",
        ...(uniqueDegradations.length > 0 ? { reason: uniqueDegradations.join("; ") } : {}),
      });
    } catch (error) {
      const reason = error instanceof MvAnimationCookError || error instanceof Error ? error.message : String(error);
      animationFailures.set(n, reason);
      warnings.push(reason);
    }
  }

  const battle = importBattleDatabase(rm, cov, {
    enemyImage: (id) => enemyImages.get(id),
    audio: audioFor,
    animation: (id) => animationImports.get(id)?.id,
  });

  // --- battlebacks --------------------------------------------------------
  const battleback1Names = new Set<string>();
  const battleback2Names = new Set<string>();
  const rememberBattleback = (first: unknown, second: unknown): void => {
    const back1 = String(first ?? "");
    const back2 = String(second ?? "");
    if (back1) battleback1Names.add(back1);
    if (back2) battleback2Names.add(back2);
  };
  const collectBattlebacks = (list: readonly { code: number; parameters?: unknown[] }[]): void => {
    for (const command of list) {
      if (command.code === 283) rememberBattleback(command.parameters?.[0], command.parameters?.[1]);
    }
  };
  for (const [id, map] of rm.maps) {
    const setting = battle.mapSettings?.find((entry) => entry.map === mapId(id));
    if (setting?.specified === true) {
      rememberBattleback(setting.battleback1Name, setting.battleback2Name);
    } else if (setting?.overworld === true) {
      // Grassland is the stock fallback for absent/unrecognised autotiles;
      // Ship is selected for every vehicle on an overworld map.
      rememberBattleback("Grassland", "Grassland");
      rememberBattleback("Ship", "Ship");
      for (const [, kind] of setting.autotileKinds ?? []) {
        rememberBattleback(rpgMakerBattleback1ForKind(kind), rpgMakerBattleback2ForKind(kind));
      }
    }
    for (const event of map.events) for (const page of event?.pages ?? []) collectBattlebacks(page.list);
  }
  for (const common of rm.commonEvents) if (common) collectBattlebacks(common.list);
  for (const troop of rm.troops) {
    if (!troop) continue;
    for (const page of troop.pages ?? []) collectBattlebacks(page.list);
  }
  const importBattleback = async (
    layer: 1 | 2,
    name: string,
  ): Promise<void> => {
    const dirName = `battlebacks${layer}`;
    const path = findNamedPng(environment, environment.join(rm.root, "img", dirName), name, rm.mediaEncryption);
    if (!path) {
      const reason = `img/${dirName}/${name}.png is missing`;
      cov.record("battle", `${dirName} ${name}`, "Degraded", reason);
      warnings.push(reason);
      return;
    }
    const image = await environment.readPng(path, rm.mediaEncryption);
    const table = layer === 1 ? assets.battlebacks1 : assets.battlebacks2;
    const used = new Set(Object.values(table).map((entry) => entry.png));
    const base = slug(name) || "image";
    let id = base;
    for (let suffix = 2; used.has(`${dirName}/${id}.png`); suffix++) id = `${base}-${suffix}`;
    const png = `${dirName}/${id}.png`;
    images.set(png, image);
    table[name] = { png, w: image.width, h: image.height };
    cov.record("battle", `${dirName} ${name}`, "Native");
  };
  for (const name of [...battleback1Names].sort()) await importBattleback(1, name);
  for (const name of [...battleback2Names].sort()) await importBattleback(2, name);

  const kitMaps = new Map<number, string>();
  for (const info of rm.mapInfos) if (info && rm.maps.has(info.id)) kitMaps.set(info.id, mapId(info.id));

  const baseContext = {
    rm,
    battleDatabaseHash: battle.databaseHash,
    cov,
    placeholders: options.placeholders ?? "visible",
    maps: kitMaps,
    sprite: spriteFor,
    picture: pictureFor,
    parallax: parallaxFor,
    animation: (id: number) => animationImports.get(id) ?? null,
    animationFailure: (id: number) => animationFailures.get(id),
    balloon: balloonFor,
    audio: audioFor,
  } as const;

  const leaderId = rm.system.partyMembers?.[0];
  const leader = leaderId ? rm.actors[leaderId] : null;
  if (leader?.characterName) {
    const key = spriteFor({ characterName: leader.characterName, characterIndex: leader.characterIndex, tileId: 0 });
    if (key) assets.player = key;
  }

  const initialParty = new Set(rm.system.partyMembers ?? []);
  const followerActors = [
    ...(rm.system.partyMembers ?? []).slice(1).map((actor) => rm.actors[actor]),
    ...rm.actors.filter((actor) => actor && !initialParty.has(actor.id)),
  ].filter((actor, index, all) =>
    !!actor?.characterName && all.findIndex((candidate) => candidate?.id === actor.id) === index
  );
  const followerMembers: NonNullable<Project["followers"]>["members"] = [];
  for (const actor of followerActors.slice(0, 32)) {
    if (!actor) continue;
    const sprite = spriteFor({ characterName: actor.characterName, characterIndex: actor.characterIndex, tileId: 0 });
    if (!sprite) continue;
    const starting = initialParty.has(actor.id);
    followerMembers.push({
      id: `actor${String(actor.id).padStart(3, "0")}`,
      sprite,
      activeSwitch: starting
        ? partySwitchId(actor.id).replace(/^party-/, "party-out-")
        : partySwitchId(actor.id),
      ...(starting ? { activeValue: false } : {}),
    });
  }
  if (followerActors.length > 32) warnings.push(`followers: ${followerActors.length} actors have walking art; only the first 32 were imported`);

  const vehicles: VehicleDef[] = [];
  for (const [id, vehicle] of [
    ["boat", rm.system.boat],
    ["ship", rm.system.ship],
    ["airship", rm.system.airship],
  ] as const satisfies readonly (readonly [VehicleDef["kind"], RmVehicle | undefined])[]) {
    if (!vehicle?.characterName || vehicle.startMapId === 0) continue;
    const map = kitMaps.get(vehicle.startMapId);
    if (!map) {
      warnings.push(`${id}: start map ${vehicle.startMapId} was not imported; vehicle omitted`);
      continue;
    }
    const sprite = spriteFor({ characterName: vehicle.characterName, characterIndex: vehicle.characterIndex, tileId: 0 });
    if (!sprite) continue;
    const sourceBgm = vehicle.bgm;
    const bgmName = typeof sourceBgm?.name === "string" ? sourceBgm.name : "";
    const pan = Math.round(clampNumber(sourceBgm?.pan, -100, 100, 0));
    vehicles.push({
      id,
      kind: id,
      sprite,
      start: { map, x: Math.max(0, vehicle.startX), y: Math.max(0, vehicle.startY), dir: "left" },
      bgm: bgmName === ""
        ? null
        : {
            id: audioFor("bgm", bgmName),
            volume: Math.round(clampNumber(sourceBgm?.volume, 0, 100, 90)),
            pitch: Math.round(clampNumber(sourceBgm?.pitch, 50, 150, 100)),
            ...(pan !== 0 ? { pan } : {}),
          },
    });
  }

  // A map event can select variants only for its owning map. Common and
  // troop event commands can run while any map is current, so their union is
  // composed for every imported map. Sorting later keeps atlas allocation,
  // object insertion and warnings byte-stable.
  const globalTilesetReferences = new Set<number>();
  for (const common of rm.commonEvents) {
    if (common) collectTilesetReferences(common.list, globalTilesetReferences);
  }
  for (const troop of rm.troops) {
    if (!troop) continue;
    for (const page of troop.pages) collectTilesetReferences(page.list, globalTilesetReferences);
  }
  const mapTilesetReferences = new Map<number, Set<number>>();
  const allTilesetReferences = new Set(globalTilesetReferences);
  for (const [rmId, rmMap] of rm.maps) {
    const references = new Set<number>();
    for (const event of rmMap.events) {
      if (!event) continue;
      for (const page of event.pages) collectTilesetReferences(page.list, references);
    }
    mapTilesetReferences.set(rmId, references);
    for (const id of references) allTilesetReferences.add(id);
  }
  for (const tilesetId of [...allTilesetReferences].sort((a, b) => a - b)) {
    if (!rm.tilesets[tilesetId]) {
      warnings.push(`Change Tileset references missing tileset ${tilesetId}; no variant was emitted`);
    }
  }

  // --- maps ---------------------------------------------------------------
  const maps: MapDef[] = [];
  const mapIds = [...rm.maps.keys()].sort((a, b) => a - b);
  for (const rmId of mapIds) {
    const rmMap = rm.maps.get(rmId)!;
    const info = rm.mapInfos[rmId];
    const id = mapId(rmId);
    if (rmMap.width > 256 || rmMap.height > 256) {
      throw new Error(`rpgmaker-import: map ${rmId} is ${rmMap.width}x${rmMap.height}; the kit caps maps at 256x256`);
    }
    currentTilesetId = rmMap.tilesetId;
    currentTilesetVariants = [...new Set([
      rmMap.tilesetId,
      ...globalTilesetReferences,
      ...(mapTilesetReferences.get(rmId) ?? []),
    ])].filter((tilesetId) => rm.tilesets[tilesetId] !== null && rm.tilesets[tilesetId] !== undefined)
      .sort((a, b) => a - b);
    const tileset = rm.tilesets[rmMap.tilesetId]!;
    const { atlas, images: tsImages } = await atlasFor(rmMap.tilesetId);
    const composed = composeMap(rmMap, tileset, tsImages, atlas, cov);
    const cellId = (cell: number | null): TileId => (cell === null ? null : `${atlas.sheetId}.${cell}`);

    const eventIds = new Map<number, string>();
    for (const ev of rmMap.events) if (ev) eventIds.set(ev.id, eventId(ev.id));
    const events: GameEvent[] = [];
    const bumpCells = new Set<number>();
    for (const ev of rmMap.events) {
      if (!ev) continue;
      const kitId = eventId(ev.id);
      let shop = 0;
      const pages: Page[] = ev.pages.map((page, index) => {
        let animation = 0;
        const ctx: EventContext = {
          ...baseContext,
          owner: { kind: "page", mapId: id, eventId: kitId, page: index, trigger: "action", eventIds },
          nextShopId: () => `${id}-${kitId}-shop${shop++}`,
          nextAnimationId: () => `${id}-${kitId}-p${index}-anim${animation++}`,
        };
        const kitPage = convertPage(page, index, ctx);
        if ((page.trigger === 1 || page.trigger === 2) && page.priorityType === 1 && kitPage.commands.length > 0) {
          // The kit records a bump only when the event body, rather than the
          // terrain below it, refuses the step. Make an impassable underlying
          // tile passable while keeping the imported event body blocking.
          bumpCells.add(ev.y * rmMap.width + ev.x);
        }
        return kitPage;
      });
      // MV picks the HIGHEST-numbered page whose conditions hold; the kit
      // picks the same (activePage scans from the last page), so pages keep
      // their order.
      events.push({ id: kitId, name: truncate(nonEmpty(ev.name, kitId), 40), x: ev.x, y: ev.y, pages });
    }

    // Stock map encounters run from a hidden parallel page. The opt-in
    // RPG Maker player-step extension raises a private variable after the
    // saved encounter countdown reaches zero; the ordinary generic battle
    // command then owns scene lifecycle and Game Over semantics.
    if (rmMap.encounterList?.length) {
      events.push({
        id: "rmi-random-encounter",
        name: "Random Encounter",
        x: 0,
        y: 0,
        pages: [{
          trigger: "parallel",
          condition: { variable: { id: RPGMAKER_ENCOUNTER_DUE_VARIABLE, op: ">=", value: 1 } },
          through: true,
          commands: [
            {
              op: "battle",
              setup: {
                system: "rpgmaker",
                databaseHash: battle.databaseHash,
                encounter: true,
                map: id,
                canEscape: true,
                canLose: false,
              },
              onLose: [{ op: "gameOver" }, { op: "exit" }],
            },
            { op: "variable", id: RPGMAKER_ENCOUNTER_DUE_VARIABLE, set: { op: "set", value: 0 } },
          ],
        }],
      });
    }

    const parallaxArt = parallaxFor(rmMap.parallaxName);
    const parallax: ParallaxDef | undefined = parallaxArt ? {
      image: parallaxArt.image,
      loopX: rmMap.parallaxLoopX,
      loopY: rmMap.parallaxLoopY,
      sx: rmParallaxSpeed(rm, rmMap.parallaxSx),
      sy: rmParallaxSpeed(rm, rmMap.parallaxSy),
      ...(parallaxArt.zero ? { zero: true } : {}),
      ...(rmMap.parallaxShow ? { showInEditor: true } : {}),
    } : undefined;
    const regions = sparseCells(composed.regions);
    const terrain = sparseCells(composed.terrain);
    const tiles = rmMap.data.length > 0 ? sparseTileLayers(rmMap.data, rmMap.width, rmMap.height) : [];
    const mapDef: MapDef = {
      id,
      name: truncate(nonEmpty(rmMap.displayName || info?.name, id), 40),
      width: rmMap.width,
      height: rmMap.height,
      sheets: [atlas.sheetId],
      tileset: atlas.sheetId,
      ground: composed.ground.map(cellId),
      ...(parallax ? { parallax } : {}),
      ...(composed.upper.length > 0 ? { upper: composed.upper.map(([i, c]) => [i, cellId(c)] as [number, TileId]) } : {}),
      ...(regions.length > 0 ? { regions } : {}),
      ...(terrain.length > 0 ? { terrain } : {}),
      ...(tiles.length > 0 ? { tiles } : {}),
      vehiclePassage: vehiclePassage(rmMap.data, rmMap.width, rmMap.height, tileset.flags),
      events,
    };
    const openedFor = (ground: readonly (number | null)[], sourceAtlas: TileAtlas): number[] =>
      [...bumpCells].sort((a, b) => a - b).filter((i) => {
        const cell = ground[i];
        return cell === null || cell === undefined || sourceAtlas.blocked(cell).length > 0;
      });
    const opened = openedFor(composed.ground, atlas);
    if (opened.length > 0) mapDef.passage = opened.map((i) => [i, "pass"]);
    const animationAssets = (
      source: typeof composed.animated,
      toCellId: (cell: number | null) => TileId,
    ): ImportAnimatedCell[] => source.map((animation) => ({
      x: animation.x,
      y: animation.y,
      above: animation.above,
      frames: animation.frames.map((cell) => toCellId(cell)),
      frameSeconds: animation.frameSeconds,
    }));
    const baseAnimated = animationAssets(composed.animated, cellId);
    const animatedVariants: Record<string, ImportAnimatedCell[]> = {
      [atlas.sheetId]: baseAnimated,
    };

    const referenced = new Set<number>(globalTilesetReferences);
    for (const tilesetId of mapTilesetReferences.get(rmId) ?? []) referenced.add(tilesetId);
    const variants: Record<string, MapTilesetVariant> = {};
    for (const tilesetId of [...referenced].sort((a, b) => a - b)) {
      if (tilesetId === rmMap.tilesetId) continue;
      const variantTileset = rm.tilesets[tilesetId];
      if (!variantTileset) continue;
      const { atlas: variantAtlas, images: variantImages } = await atlasFor(tilesetId);
      // Variants recompose the same source cells against alternate flags and
      // art. They are output coverage, not additional source constructs, so
      // do not multiply the source coverage report for every reachable
      // Change Tileset target.
      const variantComposed = composeMap(rmMap, variantTileset, variantImages, variantAtlas, cov, false);
      const variantCellId = (cell: number | null): TileId =>
        cell === null ? null : `${variantAtlas.sheetId}.${cell}`;
      variants[variantAtlas.sheetId] = {
        sheets: [variantAtlas.sheetId],
        ground: variantComposed.ground.map(variantCellId),
        upper: variantComposed.upper.map(([i, c]) => [i, variantCellId(c)] as [number, TileId]),
        passage: openedFor(variantComposed.ground, variantAtlas).map((i) => [i, "pass"]),
        vehiclePassage: vehiclePassage(rmMap.data, rmMap.width, rmMap.height, variantTileset.flags),
        terrain: sparseCells(variantComposed.terrain),
      };
      animatedVariants[variantAtlas.sheetId] = animationAssets(variantComposed.animated, variantCellId);
    }
    if (Object.keys(variants).length > 0) {
      mapDef.tilesetVariants = variants;
      (assets.animatedVariants ??= {})[id] = animatedVariants;
    }
    maps.push(mapDef);
    if (baseAnimated.length > 0) assets.animated[id] = baseAnimated;
    if (rmMap.parallaxName) cov.record("tile", "parallax", "Native");
    if (rmMap.autoplayBgm && rmMap.bgm?.name) cov.record("tile", "map autoplay BGM", "Degraded", "autoplay BGM is not started on map entry");
    if (rmMap.encounterList?.length) {
      cov.record(
        "tile",
        "map encounters",
        "Degraded",
        "walking countdown, weights, regions, Encounter Half and vehicle rates are native; bush doubling is not modelled",
      );
    }
  }

  // --- common events ------------------------------------------------------
  const commonEvents: CommonEvent[] = [];
  for (const ce of rm.commonEvents) {
    if (!ce) continue;
    currentTilesetId = 0;
    currentTilesetVariants = [];
    let shop = 0;
    let animation = 0;
    const trigger = ce.trigger === 2 ? "parallel" : ce.trigger === 1 ? "autorun" : "none";
    const ctx: EventContext = {
      ...baseContext,
      owner: { kind: "common", id: commonId(ce.id), trigger },
      nextShopId: () => `${commonId(ce.id)}-shop${shop++}`,
      nextAnimationId: () => `${commonId(ce.id)}-anim${animation++}`,
    };
    commonEvents.push(convertCommonEvent(ce, ctx));
  }

  // --- sheets -------------------------------------------------------------
  const sheets: Sheet[] = [];
  for (const [tilesetId, atlas] of [...atlases.entries()].sort((a, b) => a[0] - b[0])) {
    const block: number[] = [];
    const dirBlock: Record<string, ("down" | "left" | "right" | "up")[]> = {};
    for (let cell = 0; cell < atlas.count; cell++) {
      const dirs = atlas.blocked(cell);
      if (dirs.length === 4) block.push(cell);
      else if (dirs.length > 0) dirBlock[String(cell)] = [...dirs];
    }
    const sheet: Sheet = { id: atlas.sheetId, pak: "chunks", cols: atlas.cols, rows: atlas.rows, defaultPassage: "pass" };
    if (block.length > 0) sheet.block = block;
    if (Object.keys(dirBlock).length > 0) sheet.dirBlock = dirBlock;
    sheets.push(sheet);
    const png = `tiles/${atlas.sheetId}.png`;
    images.set(png, atlas.toImage());
    assets.sheets[atlas.sheetId] = { png, cols: atlas.cols, rows: atlas.rows };
    void tilesetId;
  }

  // --- parallax images ----------------------------------------------------
  for (const [name, request] of [...parallaxRequests].sort((a, b) => a[1].image.localeCompare(b[1].image))) {
    const path = findNamedPng(environment, environment.join(rm.root, "img", "parallaxes"), name, rm.mediaEncryption);
    if (!path) {
      warnings.push(`parallax ${name}: img/parallaxes/${name}.png not found`);
      continue;
    }
    const source = await environment.readPng(path, rm.mediaEncryption);
    if (source.width % scale !== 0 || source.height % scale !== 0) {
      warnings.push(`parallax ${name}: ${source.width}x${source.height} is not divisible by map scale ${scale}`);
      continue;
    }
    const image = scale === 1 ? source : downscale(source, scale);
    const png = `parallaxes/${request.image}.png`;
    images.set(png, image);
    assets.parallaxes[request.image] = { png, w: image.width, h: image.height };
  }

  // --- item icons ---------------------------------------------------------
  const iconSetPath = findNamedPng(environment, environment.join(rm.root, "img", "system"), "IconSet", rm.mediaEncryption);
  let iconSheet: { id: string; cols: number; rows: number; count: number } | null = null;
  if (iconSetPath) {
    const source = await environment.readPng(iconSetPath, rm.mediaEncryption);
    if (source.width > 0 && source.height > 0 && source.width % 32 === 0 && source.height % 32 === 0) {
      const id = "iconset";
      const image = downscale(source, 2);
      const cols = source.width / 32;
      const rows = source.height / 32;
      const png = `tiles/${id}.png`;
      images.set(png, image);
      assets.sheets[id] = { png, cols, rows };
      sheets.push({ id, pak: "chunks", cols, rows, defaultPassage: "pass" });
      iconSheet = { id, cols, rows, count: cols * rows };
    } else {
      warnings.push(`item icons: IconSet.png must be a non-empty grid of 32x32 cells (got ${source.width}x${source.height})`);
    }
  }

  // --- sprites ------------------------------------------------------------
  const sprites: Record<string, SpriteDef> = {};
  for (const req of spriteRequests) {
    const png = `sprites/${req.key}.png`;
    if (req.image.tileId > 0) {
      const ts = tilesetImages.get(req.tilesetId);
      const tileset = rm.tilesets[req.tilesetId];
      if (!ts || !tileset) {
        warnings.push(`sprite ${req.key}: tileset ${req.tilesetId} has no images`);
        continue;
      }
      const native = blankImage(tileSize, tileSize);
      drawTile(native, 0, 0, req.image.tileId, 0, ts, tileset.flags);
      images.set(png, scale === 1 ? native : downscale(native, scale));
      sprites[req.key] = { kind: "image", src: png };
      assets.sprites[req.key] = { png, kind: "image", h: 16 };
      continue;
    }
    const sheet = await loadCharacterSheet(req.image.characterName);
    if (!sheet) {
      warnings.push(`sprite ${req.key}: img/characters/${req.image.characterName}.png not found`);
      continue;
    }
    const big = req.image.characterName.includes("$");
    const fw = big ? sheet.width / 3 : sheet.width / 12;
    const fh = big ? sheet.height / 4 : sheet.height / 8;
    const kitW = fw / scale;
    const kitH = fh / scale;
    if (!Number.isInteger(fw) || !Number.isInteger(fh) || kitW !== KIT_TILE || (kitH !== 16 && kitH !== 32)) {
      warnings.push(`sprite ${req.key}: frames ${fw}x${fh} do not scale to 16x16 or 16x32`);
      continue;
    }
    const idx = big ? 0 : req.image.characterIndex;
    const bx = (idx % 4) * fw * 3;
    const by = Math.floor(idx / 4) * fh * 4;
    const block = blankImage(fw * 3, fh * 4);
    blit(block, 0, 0, sheet, bx, by, fw * 3, fh * 4);
    images.set(png, scale === 1 ? block : downscale(block, scale));
    sprites[req.key] = { kind: "walker", sheet: png, h: kitH as 16 | 32 };
    assets.sprites[req.key] = { png, kind: "walker", h: kitH as 16 | 32 };
  }

  // --- balloons -----------------------------------------------------------
  if (balloonsUsed.size > 0) {
    const sheet = await environment.readPng(balloonPath!, rm.mediaEncryption);
    images.set("system/balloon.png", scale === 1 ? sheet : downscale(sheet, scale));
    assets.balloon = "system/balloon.png";
    for (const n of [...balloonsUsed].sort((a, b) => a - b)) {
      animations.push({
        id: `balloon${n}`,
        sheet: "system/balloon.png",
        cols: 8,
        frames: [0, 1, 2, 3, 4, 5, 6, 7].map((f) => (n - 1) * 8 + f),
        frameDuration: BALLOON_FRAME_SECONDS,
        loop: false,
      });
    }
  }

  // --- database -----------------------------------------------------------
  const firstSheet = sheets[0]?.id ?? "ts0";
  const items: Item[] = [];
  for (const [kind, list] of [["item", rm.items], ["weapon", rm.weapons], ["armor", rm.armors]] as const) {
    for (const entry of list) {
      if (!entry || !entry.name) continue;
      const item: Item = {
        id: itemId(kind, entry.id),
        name: truncate(entry.name, 24),
        sprite: iconSheet && entry.iconIndex >= 0 && entry.iconIndex < iconSheet.count
          ? `${iconSheet.id}.${entry.iconIndex}`
          : `${firstSheet}.0`,
      };
      if (iconSheet && (entry.iconIndex < 0 || entry.iconIndex >= iconSheet.count)) {
        warnings.push(`${kind} ${entry.id}: iconIndex ${entry.iconIndex} is outside IconSet (${iconSheet.count} cells)`);
      }
      if (entry.price > 0) item.price = entry.price;
      if (kind === "item" && entry.itypeId === 2) item.sellable = false;
      if (kind === "item" && entry.consumable === false) item.usable = false;
      if (kind === "item") {
        const type = itemTypeOf(entry.itypeId);
        if (type !== "regular") item.type = type;
      } else {
        // MV's Select Item only offers database items; mark weapons and
        // armors so the scene can exclude them (DataManager.isItem parity).
        item.kind = kind;
      }
      items.push(item);
    }
  }

  const actors = rm.actors.flatMap((actor) =>
    actor && Number.isInteger(actor.id) && actor.id > 0 && actor.name.length > 0
      ? [importActorDef(rm, actor)]
      : []);
  const project: Project = {
    format: "rpgkit-project/v1",
    title: truncate(nonEmpty(rm.system.gameTitle, "Imported RPG Maker project"), 80),
    tileSize: 16,
    start: { map: mapId(rm.system.startMapId), x: rm.system.startX, y: rm.system.startY, dir: "down" },
    system: {
      messageBlocksPlayer: true,
      mapNameDisplay: true,
      rpgMakerText: {
        party: (rm.system.partyMembers ?? []).filter((id) => Number.isInteger(id) && id > 0),
        currencyUnit: String(rm.system.currencyUnit ?? "").slice(0, 24),
        ...(rpgMakerTextColours ? { colours: rpgMakerTextColours } : {}),
      },
      ...(battle.encounters.length > 0 || containsStepRead({ events: maps.map((map) => map.events), commonEvents })
        ? { stepCounter: true }
        : {}),
    },
    ...(leader?.name ? { playerName: leader.name } : {}),
    ...(followerMembers.length > 0 ? { followers: { enabled: rm.system.optFollowers !== false, members: followerMembers } } : {}),
    ...(vehicles.length > 0 ? { vehicles } : {}),
    sheets,
    items,
    ...(actors.length > 0 ? { actors } : {}),
    ...(Object.keys(sprites).length > 0 ? { sprites } : {}),
    ...(animations.length > 0 ? { animations } : {}),
    ...(commonEvents.length > 0 ? { commonEvents } : {}),
    maps,
  };
  invertInitialParty(project, rm.system.partyMembers ?? []);
  const audioMedia = await environment.convertAudio(rm.root, audioRequests.values(), { encryption: rm.mediaEncryption });
  const audioFiles = new Map<string, Uint8Array>();
  const successfulById = new Map<string, AudioMediaSuccess>();
  for (const media of audioMedia) {
    const request = audioRequests.get(media.key)!;
    if (media.status === "success") {
      const rel = `audio/${request.id}.qoa`;
      const pakKey = `audio:qoa.${request.id}`;
      (project.audio ??= {})[request.id] = pakKey;
      assets.audio[request.id] = rel;
      audioFiles.set(rel, media.qoaBytes);
      successfulById.set(request.id, media);
      cov.record("audio", media.key, "Native");
    } else {
      cov.record("audio", media.key, "Dropped", media.reason);
      warnings.push(`${media.key}: ${media.reason}`);
    }
  }
  applyImportedMeDurations(project, successfulById);
  const mediaFiles = new Map<string, Uint8Array>();
  for (const [variant, rel] of Object.entries(assets.pictures)) {
    const name = pictureRequests.get(variant) ?? variant;
    const path = findNamedPng(environment, environment.join(rm.root, "img", "pictures"), name, rm.mediaEncryption);
    if (!path) {
      warnings.push(`picture ${variant}: img/pictures file not found`);
      continue;
    }
    mediaFiles.set(rel, await environment.readMedia(path, rm.mediaEncryption, "image"));
  }
  return { project, battle, images, audioFiles, mediaFiles, audioMedia, assets, cov, warnings };
}

/** Read the 8 x 4 text-colour grid from the bottom-right of MV/MZ's standard
 *  192 px Window.png. Missing art deliberately leaves the runtime's stock
 *  palette in effect; a present but unusable windowskin is an import error. */
async function readWindowColours(rm: RmProject, environment: RpgMakerImportEnvironment): Promise<string[] | undefined> {
  const path = findNamedPng(environment, environment.join(rm.root, "img", "system"), "Window", rm.mediaEncryption);
  if (!path) return undefined;

  let image: RgbaImage;
  try {
    image = await environment.readPng(path, rm.mediaEncryption);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`rpgmaker-import: img/system/Window.png cannot be decoded: ${detail}`);
  }
  if (image.width !== 192 || image.height !== 192) {
    throw new Error(`rpgmaker-import: img/system/Window.png must be 192x192 pixels (got ${image.width}x${image.height})`);
  }
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error("rpgmaker-import: img/system/Window.png decoded to malformed RGBA data");
  }

  const hex = (value: number): string => value.toString(16).padStart(2, "0").toUpperCase();
  return Array.from({ length: 32 }, (_, index) => {
    const x = 96 + (index % 8) * 12 + 6;
    const y = 144 + Math.floor(index / 8) * 12 + 6;
    const offset = (y * image.width + x) * 4;
    return `#${hex(image.data[offset]!)}${hex(image.data[offset + 1]!)}${hex(image.data[offset + 2]!)}`;
  });
}

/** Steps are an opt-in persistent counter. Search the converted event graph
 * so projects that never read it retain the old sparse switch-bank shape. */
function containsStepRead(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsStepRead);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "steps") return true;
  if (record.op === "variable" && record.set && typeof record.set === "object" &&
      (record.set as Record<string, unknown>).op === "steps") return true;
  return Object.values(record).some(containsStepRead);
}

/** Find an RPG Maker PNG by basename without depending on host filesystem
 * case rules. Direct lookup keeps the common path allocation-free. */
function findNamedPng(
  environment: RpgMakerImportEnvironment,
  dir: string,
  name: string,
  encryption?: RpgMakerMediaEncryption,
): string | null {
  const direct = environment.join(dir, `${name}.png`);
  if (environment.exists(direct)) return direct;
  if (encryption?.images) {
    for (const candidate of [`${direct}_`, `${direct.slice(0, -4)}.rpgmvp`]) {
      if (environment.exists(candidate)) return candidate;
    }
  }
  if (!environment.exists(dir)) return null;
  const wanted = new Set([`${name}.png`.toLowerCase()]);
  if (encryption?.images) {
    wanted.add(`${name}.png_`.toLowerCase());
    wanted.add(`${name}.rpgmvp`.toLowerCase());
  }
  const file = environment.list(dir).find((candidate) => wanted.has(candidate.toLowerCase()));
  return file ? environment.join(dir, file) : null;
}

/** The kit has no initial switch values, and party membership is a switch
 *  per actor (ids.ts partySwitchId). For actors in the starting party the
 *  switch is stored inverted ("party-out-…" ON = left the party), so a
 *  fresh game reads them as members without an initialisation event. */
export function invertInitialParty(project: Project, initialParty: readonly number[]): void {
  const inverted = new Map<string, string>();
  for (const actor of initialParty) {
    inverted.set(partySwitchId(actor), partySwitchId(actor).replace(/^party-/, "party-out-"));
  }
  if (inverted.size === 0) return;
  const cond = (c: Condition): Condition => {
    if (c.kind === "switch" && inverted.has(c.id)) return { kind: "switch", id: inverted.get(c.id)!, value: !(c.value ?? true) };
    return c;
  };
  const pageCond = (pc: PageCondition | undefined): PageCondition | undefined => {
    if (!pc) return pc;
    const out: PageCondition = { ...pc };
    if (out.switch && inverted.has(out.switch)) {
      const id = out.switch;
      delete out.switch;
      out.all = [...(out.all ?? []), { kind: "switch", id: inverted.get(id)!, value: false }];
    }
    if (out.all) out.all = out.all.map(cond);
    return out;
  };
  const cmds = (list: Command[]): Command[] => list.map((c): Command => {
    switch (c.op) {
      case "switch":
        return inverted.has(c.id) ? { ...c, id: inverted.get(c.id)!, value: !c.value } : c;
      case "if":
        return { ...c, if: cond(c.if), then: cmds(c.then), ...(c.else ? { else: cmds(c.else) } : {}) };
      case "loop":
        return { ...c, commands: cmds(c.commands) };
      case "choices":
        return {
          ...c,
          options: c.options.map((o) => ({ ...o, commands: cmds(o.commands) })),
          ...(c.cancel ? { cancel: { commands: cmds(c.cancel.commands) } } : {}),
        };
      case "battle":
        return {
          ...c,
          ...(c.onWin ? { onWin: cmds(c.onWin) } : {}),
          ...(c.onLose ? { onLose: cmds(c.onLose) } : {}),
          ...(c.onEscape ? { onEscape: cmds(c.onEscape) } : {}),
        };
      case "scene":
        return {
          ...c,
          ...(c.onDone ? { onDone: cmds(c.onDone) } : {}),
          ...(c.onCancel ? { onCancel: cmds(c.onCancel) } : {}),
        };
      default:
        return c;
    }
  });
  for (const map of project.maps) {
    for (const ev of map.events ?? []) {
      ev.pages = ev.pages.map((p) => {
        const condition = pageCond(p.condition);
        return { ...p, ...(condition ? { condition } : {}), commands: cmds(p.commands) };
      });
    }
  }
  for (const ce of project.commonEvents ?? []) ce.commands = cmds(ce.commands);
}
