// tests/fixtures/rmi-play/gen-assets.ts — import the RPG Maker test
// projects and bake what GameView needs to play them.
//
//   bun tests/fixtures/rmi-play/gen-assets.ts   (run by build:example)
//
// For each game: tools/rpgmaker-import writes the rpgkit project and its
// generated art into assets/imported/<game>/; this cooker then bakes the
// 512 px map chunks from the generated tile sheets, slices every character
// block into the kit's twelve walker frames, cooks the animated water cells
// into shared sprite atlases, slices every imported AnimationDef sheet into
// per-frame images, and bakes item icons, parallaxes, and pictures. Every
// output is a pure function of tests/fixtures/rpgmaker/.
//
// games.ts (committed) carries the imported projects, normalized battle
// databases, battler image names, and their GameAssets.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodePng } from "../../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import { CHUNK_PX, TILE, mapForTileset } from "../../../src/engine/tiles.ts";
import type { Project, TileId } from "../../../src/engine/types.ts";
import { bakeMapChunks, cutCell } from "../../../tools/lib/chunks.ts";
import { sliceWalkerSheet, TUXEMON_WALKER_LAYOUT } from "../../../tools/lib/bake.ts";
import { animatedManifestSource, cookAnimationAtlases, type AnimationSequenceInput } from "../../../tools/lib/animated.ts";
import { sliceAnimationSheet } from "../../../tools/lib/anim-sheet.ts";
import { bakeBushDepth, fitPakTexture, resampleRgba } from "../../../tools/lib/pak-image.ts";
import { fallbackCharacters } from "../../../tools/lib/cjk-font.ts";
import { appTextInventory } from "../../../tools/lib/text-inventory.ts";
import { importToDirectory } from "../../../tools/rpgmaker-import/index.ts";
import { readPng, type RgbaImage } from "../../../tools/rpgmaker-import/png.ts";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..", "..", "..");
const ASSETS = join(HERE, "assets");

export const RMI_SOURCES = [
  { id: "hollow", dir: "tests/fixtures/rpgmaker/hollow-mz" },
  { id: "stage", dir: "tests/fixtures/rpgmaker/stage-mv" },
  { id: "sideview", dir: "tests/fixtures/rpgmaker/sideview-mz" },
] as const;

/** RM character sheets list rows down, left, right, up and columns
 *  step-left, idle, step-right: the same grid as the Tuxemon walker. */
const RM_WALKER_LAYOUT = TUXEMON_WALKER_LAYOUT;
/** Pictures are drawn to fill the screen; the pak needs power-of-two edges. */
const PICTURE_W = 512;
const PICTURE_H = 256;

const imageMeta: Record<string, { psm: number }> = {};
const writeAsset = (rel: string, bytes: Uint8Array): string => {
  const path = join(HERE, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return rel;
};

const asSheet = (img: RgbaImage) => ({ width: img.width, height: img.height, rgba: img.data });
const nextPow2 = (value: number): number => {
  let result = 1;
  while (result < value) result <<= 1;
  return result;
};

const bushPng = (png: Uint8Array, depth = 4): Uint8Array => {
  const decoded = decodePng(png);
  const bush = bakeBushDepth({ width: decoded.width, height: decoded.height, data: decoded.rgba }, depth);
  return encodePNG(bush.data, bush.width, bush.height);
};

/** Crop an authored side-view cell without resampling its pixels; transparent
 * right/bottom padding satisfies the pak's power-of-two texture constraint. */
function sideViewCell(image: RgbaImage, x: number, y: number, w: number, h: number): Uint8Array {
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > image.width || y + h > image.height) {
    throw new Error(`rmi-play: invalid side-view frame ${x},${y},${w},${h}`);
  }
  const width = nextPow2(w);
  const height = nextPow2(h);
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < h; row++) {
    rgba.set(image.data.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + w) * 4), row * width * 4);
  }
  return encodePNG(rgba, width, height);
}

/** PocketJS static textures are power-of-two. Pad at the bottom/right so
 * the cooked top-left and its authored placement offsets do not move. */
function padAnimationFrame(png: Uint8Array, width: number, height: number): { png: Uint8Array; w: number; h: number } {
  const w = nextPow2(width);
  const h = nextPow2(height);
  if (w === width && h === height) return { png, w, h };
  const decoded = decodePng(png);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < height; y++) {
    rgba.set(decoded.rgba.subarray(y * width * 4, (y + 1) * width * 4), y * w * 4);
  }
  return { png: encodePNG(rgba, w, h), w, h };
}

rmSync(ASSETS, { recursive: true, force: true });
mkdirSync(ASSETS, { recursive: true });

const q = JSON.stringify;
const gameSources: string[] = [];
const animSequences: AnimationSequenceInput[] = [];
const animPlacements: {
  game: string;
  map: string;
  tileset?: string;
  x: number;
  y: number;
  above: boolean;
  seq: string;
}[] = [];
const tilesetChunks = new Map<string, {
  ground: Record<string, Record<string, string[]>>;
  upper: Record<string, Record<string, string[]>>;
  columns: Record<string, Record<string, number>>;
}>();
const summaries: string[] = [];
const pakAudio = new Map<string, string>();

for (const source of RMI_SOURCES) {
  const out = join(ASSETS, "imported", source.id);
  const result = await importToDirectory(join(ROOT, source.dir), out);
  const { project, assets } = result;
  const prefix = `assets/${source.id}`;

  // --- tile art -----------------------------------------------------------
  const sheets = new Map<string, RgbaImage>();
  for (const [id, sheet] of Object.entries(assets.sheets)) sheets.set(id, result.images.get(sheet.png)!);
  const cellCache = new Map<string, Uint8Array>();
  const tileArt = (tile: TileId): Uint8Array | null => {
    if (!tile) return null;
    let art = cellCache.get(tile);
    if (!art) {
      const dot = tile.lastIndexOf(".");
      const sheet = sheets.get(tile.slice(0, dot));
      if (!sheet) throw new Error(`rmi-play: unknown sheet in ${tile}`);
      const cell = Number(tile.slice(dot + 1));
      const cols = sheet.width / TILE;
      art = cutCell(asSheet(sheet), (cell % cols) * TILE, Math.floor(cell / cols) * TILE);
      cellCache.set(tile, art);
    }
    return art;
  };
  const black = new Uint8Array(TILE * TILE * 4);
  for (let i = 3; i < black.length; i += 4) black[i] = 255;

  const ground: Record<string, string[]> = {};
  const upper: Record<string, string[]> = {};
  const columns: Record<string, number> = {};
  const variantGround: Record<string, Record<string, string[]>> = {};
  const variantUpper: Record<string, Record<string, string[]>> = {};
  const variantColumns: Record<string, Record<string, number>> = {};
  let maxChunks = 1;
  for (const map of project.maps) {
    // A parallax map needs transparent void cells so the backdrop below the
    // ground plane can paint through them. Legacy maps retain their opaque
    // padding byte-for-byte.
    const baked = bakeMapChunks(map, tileArt, map.parallax ? null : black);
    const count = baked.columns * baked.rows;
    maxChunks = Math.max(maxChunks, count);
    columns[map.id] = baked.columns;
    ground[map.id] = [];
    upper[map.id] = [];
    for (let i = 0; i < count; i++) {
      const g = writeAsset(`${prefix}/map-${map.id}-ground-${i}.png`, encodePNG(baked.ground[i]!, CHUNK_PX, CHUNK_PX));
      const u = writeAsset(`${prefix}/map-${map.id}-upper-${i}.png`, encodePNG(baked.upper[i]!, CHUNK_PX, CHUNK_PX));
      imageMeta[g] = { psm: 3 };
      imageMeta[u] = { psm: 3 };
      ground[map.id]!.push(g);
      upper[map.id]!.push(u);
    }
    for (const tilesetId of Object.keys(map.tilesetVariants ?? {}).sort()) {
      const variant = mapForTileset(map, tilesetId);
      if (!variant) throw new Error(`rmi-play: map ${map.id} has no composed tileset ${tilesetId}`);
      const variantBake = bakeMapChunks(variant, tileArt, map.parallax ? null : black);
      const variantCount = variantBake.columns * variantBake.rows;
      maxChunks = Math.max(maxChunks, variantCount);
      (variantColumns[tilesetId] ??= {})[map.id] = variantBake.columns;
      const bakedGround: string[] = [];
      const bakedUpper: string[] = [];
      (variantGround[tilesetId] ??= {})[map.id] = bakedGround;
      (variantUpper[tilesetId] ??= {})[map.id] = bakedUpper;
      for (let i = 0; i < variantCount; i++) {
        const stem = `${prefix}/map-${map.id}-tileset-${tilesetId}`;
        const g = writeAsset(`${stem}-ground-${i}.png`, encodePNG(variantBake.ground[i]!, CHUNK_PX, CHUNK_PX));
        const u = writeAsset(`${stem}-upper-${i}.png`, encodePNG(variantBake.upper[i]!, CHUNK_PX, CHUNK_PX));
        imageMeta[g] = { psm: 3 };
        imageMeta[u] = { psm: 3 };
        bakedGround.push(g);
        bakedUpper.push(u);
      }
      for (const cell of assets.animatedVariants?.[map.id]?.[tilesetId] ?? []) {
        const seq = `${source.id}:${map.id}:${tilesetId}:${cell.x},${cell.y}:${cell.above ? "a" : "b"}`;
        animSequences.push({
          id: seq,
          frames: cell.frames.map((t) => ({ rgba: tileArt(t)!, durationMs: Math.round(cell.frameSeconds * 1000) })),
        });
        animPlacements.push({
          game: source.id,
          map: map.id,
          tileset: tilesetId,
          x: cell.x,
          y: cell.y,
          above: cell.above,
          seq,
        });
      }
    }
    for (const cell of result.assets.animated[map.id] ?? []) {
      const seq = `${source.id}:${map.id}:${cell.x},${cell.y}:${cell.above ? "a" : "b"}`;
      animSequences.push({
        id: seq,
        frames: cell.frames.map((t) => ({ rgba: tileArt(t)!, durationMs: Math.round(cell.frameSeconds * 1000) })),
      });
      animPlacements.push({ game: source.id, map: map.id, x: cell.x, y: cell.y, above: cell.above, seq });
    }
  }
  tilesetChunks.set(source.id, { ground: variantGround, upper: variantUpper, columns: variantColumns });

  // --- item icons ---------------------------------------------------------
  const itemSource: string[] = [];
  for (const sprite of [...new Set(project.items.map((item) => item.sprite))].sort()) {
    const art = tileArt(sprite);
    if (!art) continue;
    const file = writeAsset(`${prefix}/item/${sprite.replace(/[^A-Za-z0-9_-]/g, "-")}.png`, encodePNG(art, TILE, TILE));
    itemSource.push(`${q(sprite)}: ${q(file)}`);
  }

  // --- characters ---------------------------------------------------------
  const walkerSource: string[] = [];
  const staticSource: string[] = [];
  const bushSource: string[] = [];
  const hasBush = project.sheets.some((sheet) => (sheet.bush?.length ?? 0) > 0);
  for (const [key, sprite] of Object.entries(assets.sprites)) {
    const img = result.images.get(sprite.png)!;
    if (sprite.kind === "image") {
      const texture = fitPakTexture(img);
      const normal = writeAsset(`${prefix}/sprite-${key}.png`, encodePNG(texture.data, texture.width, texture.height));
      staticSource.push(`${q(key)}: ${q(normal)}`);
      if (hasBush) {
        const depth = Math.max(1, Math.round(texture.height / 4));
        const bush = bakeBushDepth(texture, depth);
        const variant = writeAsset(`${prefix}/sprite-${key}-bush.png`, encodePNG(bush.data, bush.width, bush.height));
        bushSource.push(`${q(normal)}: ${q(variant)}`);
      }
      continue;
    }
    const frames = sliceWalkerSheet(asSheet(img), { cellW: TILE, cellH: sprite.h, layout: RM_WALKER_LAYOUT }, key);
    const names = { idle: [] as string[], walkL: [] as string[], walkR: [] as string[] };
    for (const pose of ["idle", "walkL", "walkR"] as const) {
      frames[pose].forEach((png, facing) => {
        const normal = writeAsset(`${prefix}/chr/${key}-${pose}-${facing}.png`, png);
        names[pose].push(normal);
        if (hasBush) {
          const variant = writeAsset(`${prefix}/chr/${key}-${pose}-${facing}-bush.png`, bushPng(png));
          bushSource.push(`${q(normal)}: ${q(variant)}`);
        }
      });
    }
    walkerSource.push(
      `${q(key)}: { idle: ${q(names.idle)}, walkL: ${q(names.walkL)}, walkR: ${q(names.walkR)}, h: ${sprite.h} }`,
    );
  }

  // --- front-view battlers ------------------------------------------------
  // ImportAssets keeps authored dimensions. Real RPG Maker battlers commonly
  // are not powers of two, so resample them for PocketJS while the battle UI
  // continues to own their logical on-screen slot.
  const battlerSource: string[] = [];
  for (const [id, battler] of Object.entries(assets.battlers).sort(([a], [b]) => a.localeCompare(b))) {
    const image = result.images.get(battler.png);
    if (!image) throw new Error(`rmi-play: battler ${id} has no imported image ${battler.png}`);
    const texture = fitPakTexture(image);
    const file = writeAsset(`${prefix}/battler-${id}.png`, encodePNG(texture.data, texture.width, texture.height));
    battlerSource.push(`${q(id)}: ${q(file)}`);
  }

  // --- battle presentation art -------------------------------------------
  // These tables stay outside GameAssets: only the opt-in RPG Maker battle
  // scene imports them, which keeps ordinary GameView bundles isolated.
  const faceSource: string[] = [];
  for (const [key, rel] of Object.entries(assets.faces).sort(([a], [b]) => a.localeCompare(b))) {
    const image = result.images.get(rel);
    if (!image) throw new Error(`rmi-play: face ${key} has no imported image ${rel}`);
    const texture = fitPakTexture(image);
    const file = writeAsset(
      `${prefix}/face-${key.replace(/[^A-Za-z0-9_-]/g, "-")}.png`,
      encodePNG(texture.data, texture.width, texture.height),
    );
    faceSource.push(`${q(key)}: ${q(file)}`);
  }

  const battlebackSource = { 1: [] as string[], 2: [] as string[] };
  for (const layer of [1, 2] as const) {
    const table = layer === 1 ? assets.battlebacks1 : assets.battlebacks2;
    for (const [name, entry] of Object.entries(table).sort(([a], [b]) => a.localeCompare(b))) {
      const image = result.images.get(entry.png);
      if (!image) throw new Error(`rmi-play: battleback${layer} ${name} has no imported image ${entry.png}`);
      const texture = fitPakTexture(image);
      const file = writeAsset(
        `${prefix}/battleback${layer}-${name.replace(/[^A-Za-z0-9_-]/g, "-")}.png`,
        encodePNG(texture.data, texture.width, texture.height),
      );
      battlebackSource[layer].push(`${q(name)}: ${q(file)}`);
    }
  }

  // --- optional side-view cells -------------------------------------------
  const actorFrames: Record<string, { frames: string[][]; w: number; h: number }> = {};
  for (const [name, sheet] of Object.entries(assets.sideViewActors ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const image = result.images.get(sheet.png)!;
    if (image.width % 9 || image.height % 6) throw new Error(`rmi-play: actor ${name} must have a 9x6 sheet`);
    const w = image.width / 9;
    const h = image.height / 6;
    const frames = Array.from({ length: 18 }, (_, motion) => Array.from({ length: 3 }, (_, pattern) => {
      const x = (Math.floor(motion / 6) * 3 + pattern) * w;
      const y = (motion % 6) * h;
      return writeAsset(`${prefix}/sv/actor-${encodeURIComponent(name)}-${motion}-${pattern}.png`, sideViewCell(image, x, y, w, h));
    }));
    actorFrames[name] = { frames, w, h };
  }
  const weaponFrames: Record<string, string[]> = {};
  for (const [page, sheet] of Object.entries(assets.sideViewWeapons ?? {})) {
    const image = result.images.get(sheet.png)!;
    for (let index = 0; index < 12; index++) {
      const id = (Number(page) - 1) * 12 + index + 1;
      weaponFrames[id] = Array.from({ length: 3 }, (_, frame) => writeAsset(
        `${prefix}/sv/weapon-${id}-${frame}.png`,
        sideViewCell(image, (Math.floor(index / 6) * 3 + frame) * 96, (index % 6) * 64, 96, 64),
      ));
    }
  }
  const overlayFrames: Record<string, string[]> = {};
  if (assets.sideViewStates) {
    const image = result.images.get(assets.sideViewStates.png)!;
    for (let row = 0; row < Math.floor(image.height / 96); row++) {
      overlayFrames[row + 1] = Array.from({ length: 8 }, (_, frame) => writeAsset(
        `${prefix}/sv/overlay-${row + 1}-${frame}.png`, sideViewCell(image, frame * 96, row * 96, 96, 96),
      ));
    }
  }
  const shadow = assets.sideViewShadow ? (() => {
    const image = result.images.get(assets.sideViewShadow!.png)!;
    const texture = fitPakTexture(image);
    return writeAsset(`${prefix}/sv/shadow.png`, encodePNG(texture.data, texture.width, texture.height));
  })() : undefined;
  const sideViewSource = q({ actors: actorFrames, weapons: weaponFrames, overlays: overlayFrames, shadow });

  // --- map animations and balloons ---------------------------------------
  const animSource: string[] = [];
  const battleAnimSource: string[] = [];
  const battleAnimPositionSource: string[] = [];
  for (const def of project.animations ?? []) {
    const image = result.images.get(def.sheet);
    if (!image) throw new Error(`rmi-play: animation ${def.id} has no imported sheet ${def.sheet}`);
    const cooked = sliceAnimationSheet(asSheet(image), def);
    const padded = cooked.frames.map((png) => padAnimationFrame(png, cooked.w, cooked.h));
    const names = padded.map((frame, i) => writeAsset(`${prefix}/anim/${def.id}-${i}.png`, frame.png));
    const placement = assets.animations[def.id];
    animSource.push(
      `${q(def.id)}: { frames: ${q(names)}, w: ${padded[0]!.w}, h: ${padded[0]!.h}` +
      (placement ? `, offsetX: ${placement.offsetX}, offsetY: ${placement.offsetY}` : "") +
      ` }`,
    );
    if (placement) {
      battleAnimPositionSource.push(`${q(def.id)}: ${placement.position ?? 1}`);
      battleAnimSource.push(
        `${q(def.id)}: { frames: ${q(names)}, w: ${padded[0]!.w}, h: ${padded[0]!.h}, ` +
        `position: ${placement.position ?? 1}, originOffsetX: ${placement.originOffsetX ?? placement.offsetX}, ` +
        `originOffsetY: ${placement.originOffsetY ?? placement.offsetY}, frameDuration: ${def.frameDuration}` +
        (def.timings && def.timings.length > 0 ? `, timings: ${q(def.timings)}` : "") +
        ` }`,
      );
    }
  }

  // --- parallaxes ---------------------------------------------------------
  const parallaxSource: string[] = [];
  for (const [id, parallax] of Object.entries(assets.parallaxes)) {
    const image = result.images.get(parallax.png);
    if (!image) throw new Error(`rmi-play: parallax ${id} has no imported image ${parallax.png}`);
    const texture = fitPakTexture(image);
    const file = writeAsset(`${prefix}/parallax/${id}.png`, encodePNG(texture.data, texture.width, texture.height));
    parallaxSource.push(`${q(id)}: { image: ${q(file)}, w: ${parallax.w}, h: ${parallax.h} }`);
  }

  // --- pictures -----------------------------------------------------------
  const pictureVariants: string[] = [];
  for (const [variant, rel] of Object.entries(assets.pictures)) {
    const img = await readPng(join(out, rel));
    const texture = resampleRgba(img, PICTURE_W, PICTURE_H);
    const file = writeAsset(`${prefix}/picture-${variant}.png`, encodePNG(texture.data, texture.width, texture.height));
    // The cooked texture is power-of-two for the host, but RPG Maker's
    // picture coordinates and percentage scale use the source PNG's natural
    // logical size. Preserve that size in GameAssets so presentation does
    // not stretch every imported picture to the viewport.
    pictureVariants.push(`${q(variant)}: { image: ${q(file)}, w: ${img.width}, h: ${img.height} }`);
  }

  // --- audio --------------------------------------------------------------
  for (const [id, rel] of Object.entries(assets.audio).sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = result.audioFiles.get(rel);
    const key = project.audio?.[id];
    if (!bytes || !key) throw new Error(`rmi-play: imported audio ${id} has no QOA bytes or project key`);
    const file = writeAsset(`${prefix}/${rel}`, bytes);
    const duplicate = pakAudio.get(key);
    if (duplicate && duplicate !== file) throw new Error(`rmi-play: duplicate pak audio key ${key}`);
    pakAudio.set(key, file);
  }

  const player = assets.player ? `WALKERS_${source.id}[${q(assets.player)}]!` : "undefined!";
  const maxActors = Math.max(1, ...project.maps.map((m) => m.events?.length ?? 0));
  const world = Object.fromEntries(project.maps.map((m) => [m.id, { w: m.width * TILE, h: m.height * TILE }]));
  gameSources.push(
    `const WALKERS_${source.id}: Record<string, CharacterFrames> = {\n  ${walkerSource.join(",\n  ")}\n};\n\n` +
      `const PROJECT_${source.id}: Project = ${JSON.stringify(project)};\n\n` +
      `const BATTLE_${source.id}: RpgMakerBattleDatabase = ${JSON.stringify(result.battle)};\n\n` +
      `const ASSETS_${source.id}: GameAssets = {\n` +
      `  ground: ${q(ground)},\n  upper: ${q(upper)},\n  chunkColumns: ${q(columns)},\n` +
      `  maxChunks: ${maxChunks},\n  maxActors: ${maxActors},\n  world: ${q(world)},\n` +
      `  order: ${q(project.maps.map((m) => m.id))},\n` +
      `  npcSrc: { ...WALKERS_${source.id}, ${staticSource.join(", ")} },\n` +
      (bushSource.length > 0 ? `  bushSrc: { ${bushSource.join(", ")} },\n` : "") +
      (assets.tileEventVariants ? `  tileEventVariants: ${q(assets.tileEventVariants)},\n` : "") +
      `  itemSrc: { ${itemSource.join(", ")} },\n` +
      `  player: ${player},\n  playerHeight: ${assets.player ? `${assets.sprites[assets.player]!.h}` : 16},\n` +
      `  animated: ANIMATED_${source.id},\n` +
      (Object.keys(variantGround).length > 0 ? `  tilesetVariants: TILESET_VARIANTS_${source.id},\n` : "") +
      `  anims: { ${animSource.join(", ")} },\n` +
      `  parallaxes: { ${parallaxSource.join(", ")} },\n` +
      `  layers: { picture: { placement: "screen", defaultVisible: false, variants: { ${pictureVariants.join(", ")} } } },\n` +
      `};\n`,
  );
  gameSources.push(
    `const BATTLERS_${source.id}: Record<string, string> = { ${battlerSource.join(", ")} };\n` +
    `const SIDEVIEW_${source.id}: RpgMakerSideViewImages = ${sideViewSource};\n`,
  );
  gameSources.push(
    `const FACES_${source.id}: Record<string, string> = { ${faceSource.join(", ")} };\n` +
    `const BATTLEBACKS1_${source.id}: Record<string, string> = { ${battlebackSource[1].join(", ")} };\n` +
    `const BATTLEBACKS2_${source.id}: Record<string, string> = { ${battlebackSource[2].join(", ")} };\n` +
    `const BATTLE_ANIMATION_POSITIONS_${source.id}: Record<string, 0 | 1 | 2 | 3> = { ${battleAnimPositionSource.join(", ")} };\n` +
    `const BATTLE_ANIMATIONS_${source.id}: Record<string, RpgMakerBattleAnimationAsset> = { ${battleAnimSource.join(", ")} };\n`,
  );
  summaries.push(
    `${source.id}: ${project.maps.length} maps, ${Object.keys(assets.sprites).length} sprites, ` +
    `${project.animations?.length ?? 0} animations, ${Object.keys(assets.parallaxes).length} parallaxes, ` +
    `${Object.keys(assets.pictures).length} pictures, ${Object.keys(assets.battlers).length} battlers`,
  );
}

// Animated cells: identical sequences across both games share one atlas.
const cooked = cookAnimationAtlases(animSequences, { directory: "assets/anim", prefix: "rmi" });
for (const atlas of cooked.atlases) writeAsset(atlas.file, atlas.png);
writeFileSync(join(HERE, "sprites.json"), JSON.stringify(cooked.spritesJson, null, 2) + "\n");
const animatedSources = RMI_SOURCES.map((source) => {
  const byMap = new Map<string, { x: number; y: number; above: boolean; sprite: string }[]>();
  for (const p of animPlacements.filter((a) => a.game === source.id && a.tileset === undefined)) {
    if (!byMap.has(p.map)) byMap.set(p.map, []);
    byMap.get(p.map)!.push({ x: p.x, y: p.y, above: p.above, sprite: cooked.atlasFor.get(p.seq)! });
  }
  return `const ANIMATED_${source.id}: GameAssets["animated"] = ${animatedManifestSource([...byMap.entries()].map(([id, tiles]) => ({ id, tiles })))};\n`;
});
const tilesetSources = RMI_SOURCES.map((source) => {
  const chunks = tilesetChunks.get(source.id)!;
  const variants: Record<string, {
    ground: { chunks: Record<string, string[]>; columns: Record<string, number> };
    upper: { chunks: Record<string, string[]>; columns: Record<string, number> };
    animated: Record<string, { x: number; y: number; above: boolean; sprite: string }[]>;
  }> = {};
  for (const tilesetId of Object.keys(chunks.ground).sort()) {
    const animated: Record<string, { x: number; y: number; above: boolean; sprite: string }[]> = {};
    for (const map of Object.keys(chunks.ground[tilesetId]!).sort()) animated[map] = [];
    for (const placement of animPlacements.filter((entry) =>
      entry.game === source.id && entry.tileset === tilesetId)) {
      animated[placement.map]!.push({
        x: placement.x,
        y: placement.y,
        above: placement.above,
        sprite: cooked.atlasFor.get(placement.seq)!,
      });
    }
    variants[tilesetId] = {
      ground: { chunks: chunks.ground[tilesetId]!, columns: chunks.columns[tilesetId]! },
      upper: { chunks: chunks.upper[tilesetId]!, columns: chunks.columns[tilesetId]! },
      animated,
    };
  }
  return `const TILESET_VARIANTS_${source.id}: NonNullable<GameAssets["tilesetVariants"]> = ${q(variants)};\n`;
});

writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");
writeFileSync(
  join(HERE, "pak.json"),
  JSON.stringify([
    { key: "license:NotoSansCJK.txt", file: "fonts/LICENSE-NotoSansCJK.txt" },
    ...[...pakAudio].sort(([a], [b]) => a.localeCompare(b)).map(([key, file]) => ({ key, file })),
  ], null, 2) + "\n",
);
const gamesPath = join(HERE, "games.ts");
writeFileSync(
  gamesPath,
  `// AUTO-GENERATED by tests/fixtures/rmi-play/gen-assets.ts from the RPG Maker\n` +
    `// test projects in tests/fixtures/rpgmaker — do not edit. The projects are\n` +
    `// the importer's output verbatim; the asset names are full literals so the\n` +
    `// PocketJS pak pass bakes them.\n\n` +
    `import type { Project } from "../../../src/engine/types.ts";\n` +
    `import type { RpgMakerBattleDatabase } from "../../../src/rpgmaker-battle/types.ts";\n` +
    `import type { RpgMakerBattleAnimationAsset, RpgMakerSideViewImages } from "../../../src/ui/rpgmaker-battle/index.tsx";\n` +
    `import type { CharacterFrames, GameAssets } from "../../../src/ui/game-assets.ts";\n\n` +
    `export type RmiGameId = ${RMI_SOURCES.map((s) => q(s.id)).join(" | ")};\n\n` +
    animatedSources.join("\n") + "\n" +
    tilesetSources.join("\n") + "\n" +
    gameSources.join("\n") + "\n" +
    `export const RMI_GAMES: Record<RmiGameId, { project: Project; battle: RpgMakerBattleDatabase; enemyImages: Record<string, string>; sideViewImages: RpgMakerSideViewImages; faceImages: Record<string, string>; battlebacks1: Record<string, string>; battlebacks2: Record<string, string>; battleAnimationPositions: Record<string, 0 | 1 | 2 | 3>; battleAnimations: Record<string, RpgMakerBattleAnimationAsset>; assets: GameAssets }> = {\n` +
    RMI_SOURCES.map((s) => `  ${s.id}: { project: PROJECT_${s.id}, battle: BATTLE_${s.id}, enemyImages: BATTLERS_${s.id}, sideViewImages: SIDEVIEW_${s.id}, faceImages: FACES_${s.id}, battlebacks1: BATTLEBACKS1_${s.id}, battlebacks2: BATTLEBACKS2_${s.id}, battleAnimationPositions: BATTLE_ANIMATION_POSITIONS_${s.id}, battleAnimations: BATTLE_ANIMATIONS_${s.id}, assets: ASSETS_${s.id} },`).join("\n") +
    `\n};\n`,
);
// PocketJS deliberately does not bake every string literal in a generated
// database: doing so would pull ids and metadata into every font atlas. List
// the decoded text inventory explicitly so imported CJK dialogue gets real
// glyphs. The broad, committed fallback face in fonts.json supplies those
// outlines; this file only selects the characters this build actually uses.
const fontCharacters = fallbackCharacters(appTextInventory({
  entries: [join(HERE, "rmi-play.tsx")],
  files: [gamesPath],
}));
writeFileSync(
  join(HERE, "fonts", "cjk-charset.txt"),
  fontCharacters.map((codepoint) => String.fromCodePoint(codepoint)).join(""),
);
console.log(`rmi-play gen-assets: ${summaries.join("; ")}; ${cooked.atlases.length} animated atlases`);
