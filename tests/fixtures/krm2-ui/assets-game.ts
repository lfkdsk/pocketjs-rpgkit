// AUTO-GENERATED shape for the deterministic KRM2 fixture assets.

import type { GameAssets } from "../../../src/ui/game-assets.ts";

const WALKER = {
  idle: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkL: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
  walkR: ["assets/walker.png", "assets/walker.png", "assets/walker.png", "assets/walker.png"] as const,
};

const GROUND = [
  "assets/map-krm2-clockwork-observatory-ground-0.png",
  "assets/map-krm2-clockwork-observatory-ground-1.png",
  "assets/map-krm2-clockwork-observatory-ground-2.png",
  "assets/map-krm2-clockwork-observatory-ground-3.png",
] as const;
const UPPER = [
  "assets/map-krm2-clockwork-observatory-upper-0.png",
  "assets/map-krm2-clockwork-observatory-upper-1.png",
  "assets/map-krm2-clockwork-observatory-upper-2.png",
  "assets/map-krm2-clockwork-observatory-upper-3.png",
] as const;

export const GAME_ASSETS: GameAssets = {
  ground: { "krm2-clockwork-observatory": GROUND },
  upper: { "krm2-clockwork-observatory": UPPER },
  chunkColumns: { "krm2-clockwork-observatory": 2 },
  maxChunks: 4,
  world: { "krm2-clockwork-observatory": { w: 960, h: 576 } },
  order: ["krm2-clockwork-observatory"],
  npcSrc: {},
  player: WALKER,
  layers: {
    pictures: {
      placement: "screen",
      defaultVisible: false,
      variants: {
        "clockwork-card": { image: "assets/clockwork-card.png", w: 128, h: 64 },
        "effect-add": { image: "assets/effect-swatch.png", color: "#3c2814", w: 16, h: 16 },
        "effect-multiply": { image: "assets/effect-swatch.png", color: "#3c2814", w: 16, h: 16 },
        "effect-screen": { image: "assets/effect-swatch.png", color: "#3c2814", w: 16, h: 16 },
        "effect-tone": { image: "assets/effect-swatch.png", color: "#3c2814", w: 16, h: 16 },
      },
    },
  },
};
