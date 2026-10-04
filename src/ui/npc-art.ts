// How a page/appearance sprite key paints one character frame. Shared by the
// active-map actor pool and the connected-world neighbour preview so both
// resolve the same image key for the same sprite, pose and facing.

import type { WalkPose } from "../engine/movement.ts";
import type { Facing, SpriteDef } from "../engine/types.ts";
import type { GameAssets, NpcArt } from "./game-assets.ts";
import { playerImageKey } from "./PlayerSprite.tsx";

/** Whether a project SpriteDef ever paints a character (static or walker). */
export function spritePaints(def: SpriteDef | undefined): boolean {
  return !!def && (def.kind === "walker" || !!def.src);
}

/** The npcSrc art for a sprite key, or "" when it paints nothing. */
export function npcArt(
  name: string | null,
  sprites: Readonly<Record<string, SpriteDef>>,
  npcSrc: GameAssets["npcSrc"],
): NpcArt | "" {
  return name && spritePaints(sprites[name]) ? (npcSrc[name] ?? "") : "";
}

/** Image key and frame height for resolved art ("" paints nothing). */
export function npcArtKey(art: NpcArt | "", pose: WalkPose, facing: Facing): string {
  return art === "" || typeof art === "string" ? art : playerImageKey(pose, facing, art);
}

export function npcArtHeight(art: NpcArt | ""): 16 | 32 {
  return typeof art === "string" ? 16 : art.h;
}
