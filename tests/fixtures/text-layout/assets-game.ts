// tests/fixtures/text-layout/assets-game.ts — the pak names gen-assets.ts writes.
import type { GameAssets } from "../../../src/ui/game-assets.ts";

const WALKER = {
  idle: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkL: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkR: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
};

export const GAME_ASSETS: GameAssets = {
  ground: { "layout-field": ["assets/map-layout-field-ground.png"] },
  upper: { "layout-field": ["assets/map-layout-field-upper.png"] },
  chunkColumns: { "layout-field": 1 },
  maxChunks: 1,
  world: { "layout-field": { w: 64, h: 64 } },
  order: ["layout-field"],
  npcSrc: {},
  player: WALKER,
};
