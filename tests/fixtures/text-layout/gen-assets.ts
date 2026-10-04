// tests/fixtures/text-layout/gen-assets.ts — procedural art for the
// text layout fixture: a trivial 4x4 map (never walked; the dialog opens
// on map entry), a placeholder walker so GameView's actor mount has art and
// the speaker's 64x64 portrait.
// Reproducible byte for byte; the PNGs are build outputs kept out of git.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../../../vendor/pocketjs/tests/png.ts";
import { bakeMapChunks, groundChunkAsset, upperChunkAsset } from "../../../tools/lib/chunks.ts";
import { CHUNK_PX, TILE } from "../../../src/engine/tiles.ts";
import { MAP, MAP_ID } from "./fixture-data.ts";
import { FACE_PX, faceRgba } from "../ui-theme/faces.ts";

const HERE = import.meta.dir;
const ASSETS = join(HERE, "assets");
mkdirSync(ASSETS, { recursive: true });

type Rgba = readonly [number, number, number, number];

function solidTile(colour: Rgba): Uint8Array {
  const out = new Uint8Array(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i++) out.set(colour, i * 4);
  return out;
}

function solidImage(colour: Rgba, size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) out.set(colour, i * 4);
  return out;
}

const ground = solidTile([18, 26, 20, 255]);
const baked = bakeMapChunks(MAP, () => ground, ground);
const chunkCount = baked.columns * baked.rows;
for (let i = 0; i < chunkCount; i++) {
  writeFileSync(join(HERE, groundChunkAsset(MAP_ID, i, chunkCount)), encodePNG(baked.ground[i]!, CHUNK_PX, CHUNK_PX));
  writeFileSync(join(HERE, upperChunkAsset(MAP_ID, i, chunkCount)), encodePNG(baked.upper[i]!, CHUNK_PX, CHUNK_PX));
}

const walkerName = "assets/walker.png";
writeFileSync(join(HERE, walkerName), encodePNG(solidImage([80, 80, 96, 255], TILE), TILE, TILE));

// KEEPER's portrait (fixture-data.ts FACES): the ui-theme fixture's keeper.
writeFileSync(join(ASSETS, "face-keeper.png"), encodePNG(faceRgba("keeper"), FACE_PX, FACE_PX));
