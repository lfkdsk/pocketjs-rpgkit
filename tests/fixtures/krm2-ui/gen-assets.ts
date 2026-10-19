// Procedural, byte-stable map, walker and picture art for the KRM2 sim.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import {
  bakeMapChunks,
  groundChunkAsset,
  upperChunkAsset,
} from "../../../tools/lib/chunks.ts";
import { CHUNK_PX, TILE } from "../../../src/engine/tiles.ts";
import { MAP, MAP_ID } from "./fixture-data.ts";

const HERE = import.meta.dir;
mkdirSync(join(HERE, "assets"), { recursive: true });

type Rgba = readonly [number, number, number, number];

function image(width: number, height: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(pixel(x, y), (y * width + x) * 4);
  }
  return out;
}

const ground = image(TILE, TILE, (x, y) => {
  const seam = x === 0 || y === 0;
  return seam ? [20, 40, 56, 255] : ((x + y) & 3) === 0 ? [28, 58, 72, 255] : [24, 50, 66, 255];
});
const baked = bakeMapChunks(MAP, () => ground, ground);
const chunkCount = baked.ground.length;
for (let i = 0; i < chunkCount; i++) {
  writeFileSync(join(HERE, groundChunkAsset(MAP_ID, i, chunkCount)), encodePNG(baked.ground[i]!, CHUNK_PX, CHUNK_PX));
  writeFileSync(join(HERE, upperChunkAsset(MAP_ID, i, chunkCount)), encodePNG(baked.upper[i]!, CHUNK_PX, CHUNK_PX));
}

const walker = image(TILE, TILE, (x, y) => {
  if (x >= 5 && x <= 10 && y >= 2 && y <= 13) return [255, 225, 122, 255];
  return [0, 0, 0, 0];
});
writeFileSync(join(HERE, "assets/walker.png"), encodePNG(walker, TILE, TILE));

const cardW = 128;
const cardH = 64;
const card = image(cardW, cardH, (x, y) => {
  if (x < 3 || y < 3 || x >= cardW - 3 || y >= cardH - 3) return [255, 225, 122, 255];
  if (Math.abs(x - cardW / 2) < 3 || Math.abs(y - cardH / 2) < 3) return [245, 248, 255, 255];
  if ((x - cardW / 2) ** 2 + (y - cardH / 2) ** 2 < 12 ** 2) return [248, 113, 113, 255];
  return x < cardW / 2 ? [76, 201, 240, 255] : [167, 139, 250, 255];
});
writeFileSync(join(HERE, "assets/clockwork-card.png"), encodePNG(card, cardW, cardH));

// A uniform opaque source keeps blend/tone semantic pixels independent from
// texture interpolation and from the map beneath each picture. The fixture's
// picture variants provide a known opaque destination colour.
const effectSwatch = image(16, 16, () => [120, 80, 40, 255]);
writeFileSync(join(HERE, "assets/effect-swatch.png"), encodePNG(effectSwatch, 16, 16));
