// Build the KA1 map-animation fixture. All art is procedural so the source
// sheets, sliced frames, map chunks and GameAssets manifest are reproducible
// byte for byte.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import {
  bakeMapChunks,
  groundChunkAsset,
  upperChunkAsset,
  gameManifestSource,
} from "../../../tools/lib/chunks.ts";
import { loadWalkerSheet } from "../../../tools/lib/bake.ts";
import { loadAnimationSheet } from "../../../tools/lib/anim-sheet.ts";
import { CHUNK_PX, TILE } from "../../../src/engine/tiles.ts";
import {
  KA1_MAP_SIZE,
  KA1_PROJECT,
  KS1_PERSIST_PROJECT,
} from "./fixture-data.ts";

const HERE = import.meta.dir;
const ASSETS = join(HERE, "assets");
mkdirSync(ASSETS, { recursive: true });

type Rgba = readonly [number, number, number, number];

// Dark ground so the bright animation frames read cleanly in pixel tests.
const ground = new Uint8Array(TILE * TILE * 4);
for (let y = 0; y < TILE; y++) {
  for (let x = 0; x < TILE; x++) {
    const colour: Rgba = ((x >> 2) + (y >> 2)) % 2 === 0
      ? [10, 14, 22, 255]
      : [13, 18, 28, 255];
    ground.set(colour, (y * TILE + x) * 4);
  }
}

const imageMeta: Record<string, { psm: number }> = {};
let chunkCount = 0;
for (const map of KS1_PERSIST_PROJECT.maps) {
  const baked = bakeMapChunks(map, () => ground, ground);
  const mapChunkCount = baked.columns * baked.rows;
  chunkCount += mapChunkCount;
  for (let i = 0; i < mapChunkCount; i++) {
    const groundName = groundChunkAsset(map.id, i, mapChunkCount);
    const upperName = upperChunkAsset(map.id, i, mapChunkCount);
    writeFileSync(join(HERE, groundName), encodePNG(baked.ground[i]!, CHUNK_PX, CHUNK_PX));
    writeFileSync(join(HERE, upperName), encodePNG(baked.upper[i]!, CHUNK_PX, CHUNK_PX));
    imageMeta[groundName] = { psm: 3 };
    imageMeta[upperName] = { psm: 3 };
  }
}

// A minimal 3x4 walker sheet: one body colour per facing, a 2px foot marker
// per pose column, so the player is visible without distracting from the
// animation pixels under test.
const sourceW = 3 * TILE;
const sourceH = 4 * 32;
const source = new Uint8Array(sourceW * sourceH * 4);
const facingColours: readonly Rgba[] = [
  [246, 92, 92, 255],
  [86, 216, 116, 255],
  [74, 132, 246, 255],
  [246, 206, 74, 255],
];
for (let row = 0; row < 4; row++) {
  for (let col = 0; col < 3; col++) {
    for (let y = 4; y <= 25; y++) {
      for (let x = 4; x <= 11; x++) {
        const px = col * TILE + x;
        const py = row * 32 + y;
        source.set(facingColours[row]!, (py * sourceW + px) * 4);
      }
    }
    for (let y = 27; y <= 30; y++) {
      for (let x = 4 + col; x <= 5 + col; x++) {
        const px = col * TILE + x;
        const py = row * 32 + y;
        source.set([238, 238, 244, 255], (py * sourceW + px) * 4);
      }
    }
  }
}
const walkerName = "assets/walker-source.png";
writeFileSync(join(HERE, walkerName), encodePNG(source, sourceW, sourceH));
const walker = await loadWalkerSheet(join(HERE, walkerName));
const poseFrames: Record<"idle" | "walkL" | "walkR", string[]> = { idle: [], walkL: [], walkR: [] };
for (const pose of ["idle", "walkL", "walkR"] as const) {
  for (let facing = 0; facing < 4; facing++) {
    const name = `assets/walker-${pose}-${facing}.png`;
    writeFileSync(join(HERE, name), walker[pose][facing]!);
    imageMeta[name] = { psm: 3 };
    poseFrames[pose].push(name);
  }
}

// Animation sheets: one solid 12x12 colour block per frame, centered, with a
// 2px dark border so a frame is distinguishable from the ground at a glance.
const pulseColours: readonly Rgba[] = [
  [226, 62, 62, 255],
  [72, 200, 96, 255],
  [64, 120, 240, 255],
  [236, 236, 244, 255],
];
const ringColours: readonly Rgba[] = [
  [246, 188, 58, 255],
  [236, 128, 48, 255],
];

function sheet(colours: readonly Rgba[], cols: number, name: string): string {
  const w = cols * TILE;
  const h = TILE;
  const rgba = new Uint8Array(w * h * 4);
  colours.forEach((colour, index) => {
    for (let y = 2; y < 14; y++) {
      for (let x = 2; x < 14; x++) {
        const px = index * TILE + x;
        const py = y;
        const border = x === 2 || x === 13 || y === 2 || y === 13;
        rgba.set(border ? [12, 14, 20, 255] : colour, (py * w + px) * 4);
      }
    }
  });
  const file = `assets/${name}`;
  writeFileSync(join(HERE, file), encodePNG(rgba, w, h));
  return file;
}

const pulseSheet = sheet(pulseColours, 4, "anim-sheet-pulse.png");
const ringSheet = sheet(ringColours, 2, "anim-sheet-ring.png");

// A 32x64 tower (Tuxemon dragonbirth is 48x64; pak textures must be pow2,
// so the fixture is 32 wide — the half-height anchor depends only on the
// 64 px height): two solid frames stacked in a 32x128 sheet, exercising the
// cooker's non-square frame path and the renderer's half-height anchor.
const towerColours: readonly Rgba[] = [
  [172, 64, 192, 255],
  [52, 184, 184, 255],
];
const towerW = 32;
const towerH = 64;
const towerSheet = "assets/anim-sheet-tower.png";
{
  const rgba = new Uint8Array(towerW * towerH * 2 * 4);
  towerColours.forEach((colour, index) => {
    for (let y = 0; y < towerH; y++) {
      for (let x = 0; x < towerW; x++) {
        rgba.set(colour, ((index * towerH + y) * towerW + x) * 4);
      }
    }
  });
  writeFileSync(join(HERE, towerSheet), encodePNG(rgba, towerW, towerH * 2));
}

const animManifest: [string, { frames: string[]; w: number; h: number }][] = [];
for (const [def, sheetFile] of [
  [KA1_PROJECT.animations![0]!, pulseSheet],
  [KA1_PROJECT.animations![1]!, ringSheet],
  [KA1_PROJECT.animations![2]!, towerSheet],
] as const) {
  const cooked = await loadAnimationSheet(join(HERE, sheetFile), def);
  const names: string[] = [];
  cooked.frames.forEach((png, index) => {
    const name = `assets/anim-${def.id}-${index}.png`;
    writeFileSync(join(HERE, name), png);
    imageMeta[name] = { psm: 3 };
    names.push(name);
  });
  animManifest.push([def.id, { frames: names, w: cooked.w, h: cooked.h }]);
}

writeFileSync(join(HERE, "images.json"), JSON.stringify(imageMeta, null, 2) + "\n");

writeFileSync(
  join(HERE, "assets-game.ts"),
  gameManifestSource({
    generator: "tests/fixtures/ka1-anim/gen-assets.ts",
    typesImport: "../../../src/ui/game-assets.ts",
    maps: KS1_PERSIST_PROJECT.maps.map((map) => ({
      id: map.id,
      width: map.width,
      height: map.height,
      events: map.events,
    })),
    npcSrc: [],
    player: {
      idle: poseFrames.idle,
      walkL: poseFrames.walkL,
      walkR: poseFrames.walkR,
    },
    anims: animManifest,
  }),
);

console.log(
  `ka1-anim fixture: ${KA1_MAP_SIZE.width}x${KA1_MAP_SIZE.height}, ${chunkCount} map chunks/layer, ` +
  `${animManifest.map(([id, a]) => `${id}=${a.frames.length}f`).join(", ")}`,
);
