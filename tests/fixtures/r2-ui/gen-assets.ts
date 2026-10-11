// Build the animated-tile and 16x32 walker integration fixture. All art is
// procedural so the source sheet, twelve sliced poses, map chunks, sprite
// atlas metadata and GameAssets manifest are reproducible byte for byte.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import {
  bakeMapChunks,
  groundChunkAsset,
  upperChunkAsset,
} from "../../../tools/lib/chunks.ts";
import { loadWalkerSheet } from "../../../tools/lib/bake.ts";
import {
  animatedManifestSource,
  cookAnimationAtlases,
} from "../../../tools/lib/animated.ts";
import { CHUNK_PX, TILE } from "../../../src/engine/tiles.ts";
import {
  ABOVE_ANIMATION,
  R2_MAP,
  R2_MAP_ID,
  R2_MAP_SIZE,
  R2_SECOND_MAP,
  R2_SECOND_MAP_ID,
} from "./fixture-data.ts";

const HERE = import.meta.dir;
const ASSETS = join(HERE, "assets");
mkdirSync(join(ASSETS, "anim"), { recursive: true });

type Rgba = readonly [number, number, number, number];

function solidTile(colour: Rgba): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i++) out.set(colour, i * 4);
  return out;
}

function paintRect(
  image: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: Rgba,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) image.set(colour, (y * width + x) * 4);
  }
}

function travelBoat(): Uint8Array {
  const image = new Uint8Array(TILE * TILE * 4);
  paintRect(image, TILE, 7, 2, 8, 9, [38, 30, 34, 255]);
  for (let y = 3; y <= 8; y++) {
    paintRect(image, TILE, 9, y, 9 + Math.floor((y - 3) / 2), y, [246, 224, 142, 255]);
  }
  paintRect(image, TILE, 1, 9, 14, 11, [50, 38, 48, 255]);
  paintRect(image, TILE, 2, 9, 13, 10, [68, 190, 222, 255]);
  paintRect(image, TILE, 3, 11, 12, 13, [50, 38, 48, 255]);
  paintRect(image, TILE, 4, 11, 11, 12, [34, 118, 170, 255]);
  paintRect(image, TILE, 5, 14, 10, 14, [122, 220, 246, 255]);
  return image;
}

function travelAirship(): Uint8Array {
  const image = new Uint8Array(TILE * 32 * 4);
  const outline: Rgba = [42, 28, 52, 255];
  const balloon: Rgba = [236, 92, 114, 255];
  const highlight: Rgba = [255, 184, 112, 255];
  const spans = [
    [6, 9], [4, 11], [3, 12], [2, 13], [2, 13], [1, 14],
    [1, 14], [2, 13], [2, 13], [3, 12], [4, 11], [6, 9],
  ] as const;
  for (let row = 0; row < spans.length; row++) {
    const [x0, x1] = spans[row]!;
    paintRect(image, TILE, x0, row + 2, x1, row + 2, outline);
    if (x1 - x0 > 1) paintRect(image, TILE, x0 + 1, row + 2, x1 - 1, row + 2, balloon);
  }
  paintRect(image, TILE, 5, 4, 6, 10, highlight);
  paintRect(image, TILE, 4, 15, 4, 23, outline);
  paintRect(image, TILE, 11, 15, 11, 23, outline);
  paintRect(image, TILE, 3, 23, 12, 29, outline);
  paintRect(image, TILE, 4, 24, 11, 27, [230, 176, 68, 255]);
  paintRect(image, TILE, 6, 24, 9, 25, [255, 236, 146, 255]);
  return image;
}

function travelFollower(body: Rgba, accent: Rgba, ears: "round" | "pointed"): Uint8Array {
  const image = new Uint8Array(TILE * 32 * 4);
  const outline: Rgba = [24, 24, 34, 255];
  if (ears === "pointed") {
    paintRect(image, TILE, 3, 9, 5, 13, outline);
    paintRect(image, TILE, 10, 9, 12, 13, outline);
    paintRect(image, TILE, 4, 10, 4, 12, accent);
    paintRect(image, TILE, 11, 10, 11, 12, accent);
  } else {
    paintRect(image, TILE, 2, 11, 5, 14, outline);
    paintRect(image, TILE, 10, 11, 13, 14, outline);
    paintRect(image, TILE, 3, 12, 4, 13, accent);
    paintRect(image, TILE, 11, 12, 12, 13, accent);
  }
  paintRect(image, TILE, 3, 13, 12, 27, outline);
  paintRect(image, TILE, 4, 14, 11, 26, body);
  paintRect(image, TILE, 5, 18, 6, 19, [246, 246, 250, 255]);
  paintRect(image, TILE, 9, 18, 10, 19, [246, 246, 250, 255]);
  paintRect(image, TILE, 6, 22, 9, 23, accent);
  paintRect(image, TILE, 3, 28, 6, 30, outline);
  paintRect(image, TILE, 9, 28, 12, 30, outline);
  return image;
}

const ground = new Uint8Array(TILE * TILE * 4);
for (let y = 0; y < TILE; y++) {
  for (let x = 0; x < TILE; x++) {
    const colour: Rgba = ((x >> 2) + (y >> 2)) % 2 === 0
      ? [20, 28, 42, 255]
      : [26, 38, 54, 255];
    ground.set(colour, (y * TILE + x) * 4);
  }
}
const canopy = solidTile([174, 48, 142, 255]);
const baked = bakeMapChunks(
  R2_MAP,
  (id) => id === "fixture.1" ? canopy : ground,
  ground,
);
const bakedSecond = bakeMapChunks(
  R2_SECOND_MAP,
  (id) => id === "fixture.1" ? canopy : ground,
  ground,
);

const imageMeta: Record<string, { psm: number }> = {};
const travelImages = {
  "assets/travel-boat.png": travelBoat(),
  "assets/travel-airship.png": travelAirship(),
  "assets/travel-follower-coral.png": travelFollower([236, 96, 126, 255], [255, 210, 116, 255], "pointed"),
  "assets/travel-follower-mint.png": travelFollower([82, 204, 154, 255], [116, 238, 232, 255], "round"),
} as const;
for (const [name, rgba] of Object.entries(travelImages)) {
  const height = name.includes("boat") ? TILE : 32;
  writeFileSync(join(HERE, name), encodePNG(rgba, TILE, height));
  imageMeta[name] = { psm: 3 };
}
const chunkCount = baked.columns * baked.rows;
for (let i = 0; i < chunkCount; i++) {
  const groundName = groundChunkAsset(R2_MAP_ID, i, chunkCount);
  const upperName = upperChunkAsset(R2_MAP_ID, i, chunkCount);
  writeFileSync(join(HERE, groundName), encodePNG(baked.ground[i]!, CHUNK_PX, CHUNK_PX));
  writeFileSync(join(HERE, upperName), encodePNG(baked.upper[i]!, CHUNK_PX, CHUNK_PX));
  imageMeta[groundName] = { psm: 3 };
  imageMeta[upperName] = { psm: 3 };
  const secondUpperName = upperChunkAsset(R2_SECOND_MAP_ID, i, chunkCount);
  writeFileSync(join(HERE, secondUpperName), encodePNG(bakedSecond.upper[i]!, CHUNK_PX, CHUNK_PX));
  imageMeta[secondUpperName] = { psm: 3 };
}

// Tuxemon source layout rows: down, left, right, up. Columns: walk-L,
// idle, walk-R. Every facing has a distinct body colour and every pose a
// distinct foot marker so sim pixels can prove both axes of the selection.
const sourceW = 3 * TILE;
const sourceH = 4 * 32;
const source = new Uint8Array(sourceW * sourceH * 4);
const facingColours: readonly Rgba[] = [
  [246, 92, 92, 255],
  [86, 216, 116, 255],
  [74, 132, 246, 255],
  [246, 206, 74, 255],
];
const poseColours: readonly Rgba[] = [
  [252, 72, 214, 255],
  [238, 238, 244, 255],
  [68, 232, 248, 255],
];

function sourcePixel(col: number, row: number, x: number, y: number, colour: Rgba): void {
  const px = col * TILE + x;
  const py = row * 32 + y;
  source.set(colour, (py * sourceW + px) * 4);
}

for (let row = 0; row < 4; row++) {
  for (let col = 0; col < 3; col++) {
    for (let y = 3; y <= 26; y++) {
      for (let x = 4; x <= 11; x++) {
        const outline = x === 4 || x === 11 || y === 3 || y === 26;
        sourcePixel(col, row, x, y, outline ? [12, 14, 20, 255] : facingColours[row]!);
      }
    }
    // Direction marks in the head keep the four frames visually distinct.
    if (row === 0) {
      sourcePixel(col, row, 6, 9, [12, 14, 20, 255]);
      sourcePixel(col, row, 9, 9, [12, 14, 20, 255]);
    } else if (row === 1) {
      sourcePixel(col, row, 5, 9, [12, 14, 20, 255]);
    } else if (row === 2) {
      sourcePixel(col, row, 10, 9, [12, 14, 20, 255]);
    } else {
      for (let x = 6; x <= 9; x++) sourcePixel(col, row, x, 7, [12, 14, 20, 255]);
    }
    const foot = poseColours[col]!;
    const ranges = col === 0 ? [[2, 6], [9, 11]] : col === 1 ? [[5, 7], [9, 11]] : [[5, 7], [10, 14]];
    for (const [x0, x1] of ranges) {
      for (let y = 27; y <= 30; y++) for (let x = x0!; x <= x1!; x++) {
        sourcePixel(col, row, x, y, foot);
      }
    }
  }
}

const sourceName = "assets/walker-source.png";
writeFileSync(join(HERE, sourceName), encodePNG(source, sourceW, sourceH));
const walker = await loadWalkerSheet(join(HERE, sourceName));
const poseFrames: Record<"idle" | "walkL" | "walkR", string[]> = {
  idle: [],
  walkL: [],
  walkR: [],
};
for (const pose of ["idle", "walkL", "walkR"] as const) {
  for (let facing = 0; facing < 4; facing++) {
    const name = `assets/walker-${pose}-${facing}.png`;
    writeFileSync(join(HERE, name), walker[pose][facing]!);
    imageMeta[name] = { psm: 3 };
    poseFrames[pose].push(name);
  }
}

function animationFrame(colour: Rgba): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 14; x++) out.set(colour, (y * TILE + x) * 4);
  }
  return out;
}

const animation = cookAnimationAtlases([{
  id: "pulse",
  frames: [
    { rgba: animationFrame([22, 190, 214, 255]), durationMs: 100 },
    { rgba: animationFrame([246, 188, 58, 255]), durationMs: 100 },
    { rgba: animationFrame([124, 96, 238, 255]), durationMs: 100 },
    { rgba: animationFrame([236, 72, 104, 255]), durationMs: 100 },
  ],
}]);
for (const atlas of animation.atlases) writeFileSync(join(HERE, atlas.file), atlas.png);
writeFileSync(join(HERE, "sprites.json"), JSON.stringify(animation.spritesJson, null, 2) + "\n");
writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

const sprite = animation.atlasFor.get("pulse")!;
const animated = animatedManifestSource([{
  id: R2_MAP_ID,
  tiles: [
    ...Array.from({ length: R2_MAP_SIZE.width * R2_MAP_SIZE.height }, (_, index) => ({
      x: index % R2_MAP_SIZE.width,
      y: Math.floor(index / R2_MAP_SIZE.width),
      above: false,
      sprite,
    })),
    { ...ABOVE_ANIMATION, above: true, sprite },
  ],
}]);
const q = JSON.stringify;
const names = (values: readonly string[]): string => `[${values.map((value) => q(value)).join(", ")}]`;
const stillWalker = (name: string): string =>
  `{ idle: ${names([name, name, name, name])} as const, ` +
  `walkL: ${names([name, name, name, name])} as const, ` +
  `walkR: ${names([name, name, name, name])} as const, h: 32 as const }`;
const groundNames = Array.from({ length: chunkCount }, (_, i) => groundChunkAsset(R2_MAP_ID, i, chunkCount));
const upperNames = Array.from({ length: chunkCount }, (_, i) => upperChunkAsset(R2_MAP_ID, i, chunkCount));
const secondUpperNames = Array.from(
  { length: chunkCount },
  (_, i) => upperChunkAsset(R2_SECOND_MAP_ID, i, chunkCount),
);
writeFileSync(
  join(HERE, "assets-game.ts"),
  `// AUTO-GENERATED by tests/fixtures/r2-ui/gen-assets.ts — do not edit.\n` +
    `import type { GameAssets } from "../../../src/ui/game-assets.ts";\n\n` +
    `const WALKER = {\n` +
    `  idle: ${names(poseFrames.idle)} as const,\n` +
    `  walkL: ${names(poseFrames.walkL)} as const,\n` +
    `  walkR: ${names(poseFrames.walkR)} as const,\n` +
    `  h: 32 as const,\n` +
    `};\n\n` +
    `const TRAVEL_FOLLOWER_CORAL = ${stillWalker("assets/travel-follower-coral.png")};\n` +
    `const TRAVEL_FOLLOWER_MINT = ${stillWalker("assets/travel-follower-mint.png")};\n` +
    `const TRAVEL_AIRSHIP = ${stillWalker("assets/travel-airship.png")};\n\n` +
    `export const GAME_ASSETS: GameAssets = {\n` +
    `  ground: { ${q(R2_MAP_ID)}: ${names(groundNames)}, ${q(R2_SECOND_MAP_ID)}: ${names(groundNames)} },\n` +
    `  upper: { ${q(R2_MAP_ID)}: ${names(upperNames)}, ${q(R2_SECOND_MAP_ID)}: ${names(secondUpperNames)} },\n` +
    `  chunkColumns: { ${q(R2_MAP_ID)}: ${baked.columns}, ${q(R2_SECOND_MAP_ID)}: ${baked.columns} },\n` +
    `  maxChunks: ${chunkCount},\n` +
    `  world: { ${q(R2_MAP_ID)}: { w: ${R2_MAP_SIZE.width * TILE}, h: ${R2_MAP_SIZE.height * TILE} }, ${q(R2_SECOND_MAP_ID)}: { w: ${R2_MAP_SIZE.width * TILE}, h: ${R2_MAP_SIZE.height * TILE} } },\n` +
    `  order: [${q(R2_MAP_ID)}, ${q(R2_SECOND_MAP_ID)}],\n` +
    `  npcSrc: { walker: WALKER, alt: "assets/walker-idle-3.png", travelBoat: "assets/travel-boat.png", travelAirship: TRAVEL_AIRSHIP, travelFollowerCoral: TRAVEL_FOLLOWER_CORAL, travelFollowerMint: TRAVEL_FOLLOWER_MINT },\n` +
    `  player: WALKER,\n` +
    `  playerHeight: 32,\n` +
    `  animated: ${animated},\n` +
    // One minimal art entry so GameView mounts the map-animation and balloon
    // layers; the fixture project spawns no instances, so the layers idle.
    `  anims: { "probe-anim": { frames: ["assets/anim/anim-0.png"], w: 16, h: 16 } },\n` +
    `  layers: {\n` +
    `    ground: { placement: "ground", mode: "eager", variants: { void: { chunks: { ${q(R2_MAP_ID)}: ${names(secondUpperNames)} }, columns: { ${q(R2_MAP_ID)}: ${baked.columns} } } } },\n` +
    `    upper: { placement: "upper", mode: "eager", variants: {} },\n` +
    `    "extra-canopy": { placement: "above", mode: "eager", variants: { on: { chunks: { ${q(R2_MAP_ID)}: ${names(upperNames)} }, columns: { ${q(R2_MAP_ID)}: ${baked.columns} } } } },\n` +
    `    "screen-tint": { placement: "screen", variants: { blue: { color: "#2040c080" } } },\n` +
    `  },\n` +
    `};\n`,
);

console.log(
  `r2-ui fixture: ${R2_MAP_SIZE.width}x${R2_MAP_SIZE.height}, ${chunkCount} map chunks/layer, ` +
  `${R2_MAP_SIZE.width * R2_MAP_SIZE.height + 1} animated placements, 12 walker frames`,
);
