// Pure follower/vehicle render projection. Keeping this outside GameView's
// JSX module makes the reducer-to-paint contract cheap to test and lets the
// live component own only node lifetime/reactivity.

import { walkPose } from "../engine/movement.ts";
import type { SessionState } from "../engine/session.ts";
import type { SpriteDef } from "../engine/types.ts";
import type { GameAssets, NpcArt } from "./game-assets.ts";
import { actorDepth } from "./OccludingUpperLayer.tsx";

type Sprites = Readonly<Record<string, SpriteDef>>;

function actorArt(
  sprite: string,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
): NpcArt | "" {
  const definition = sprites[sprite];
  return definition && (definition.kind === "walker" || !!definition.src)
    ? npcSrc[sprite] ?? ""
    : "";
}

function actorArtKey(art: NpcArt | "", phase: number, facing: 0 | 1 | 2 | 3): string {
  if (art === "" || typeof art === "string") return art;
  const pose = walkPose(phase);
  return pose === 1 ? art.walkL[facing]!
    : pose === 2 ? art.walkR[facing]!
    : art.idle[facing]!;
}

export interface TravelActorFrame {
  id: string;
  px: number;
  py: number;
  src: string;
  height: 16 | 32;
  visible: boolean;
  depth: number;
}

export interface AirshipShadowFrame {
  px: number;
  py: number;
  opacity: number;
  visible: boolean;
  depth: number;
}

/** RPG Maker's airship shadow stays on the ground while the craft rises and
 * fades in proportion to altitude. The renderer draws the small oval from
 * Views, so projects need no extra baked asset. */
export function airshipShadowFrame(
  state: Readonly<SessionState>,
  worldWidth: number,
): AirshipShadowFrame {
  const vehicles = state.travel?.vehicles;
  const riding = vehicles?.riding;
  const vehicle = riding ? vehicles!.entries.find((entry) => entry.id === riding) : undefined;
  const altitude = vehicle?.kind === "airship" ? vehicles!.airshipAltitude : 0;
  return {
    px: state.move.px + 2,
    py: state.move.py + 11,
    opacity: Math.max(0, Math.min(1, altitude / 16)),
    visible: vehicle?.kind === "airship" && vehicle.mapId === state.mapId && altitude > 0,
    depth: actorDepth(state.move.px, state.move.py, worldWidth) - 1,
  };
}

export function sameAirshipShadowFrame(a: AirshipShadowFrame, b: AirshipShadowFrame): boolean {
  return a.px === b.px && a.py === b.py && a.opacity === b.opacity &&
    a.visible === b.visible && a.depth === b.depth;
}

function travelFrame(
  id: string,
  move: SessionState["move"],
  sprite: string,
  visible: boolean,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  worldWidth: number,
): TravelActorFrame {
  const art = actorArt(sprite, sprites, npcSrc);
  return {
    id,
    px: move.px,
    py: move.py,
    src: actorArtKey(art, move.phase, move.facing),
    height: typeof art === "string" ? 16 : art.h,
    visible: visible && art !== "",
    depth: actorDepth(move.px, move.py, worldWidth),
  };
}

/** Ridden vehicles are deliberately absent: the player node paints that
 * vehicle so there is exactly one moving body and one altitude transform. */
export function travelActorFrames(
  state: Readonly<SessionState>,
  sprites: Sprites,
  npcSrc: GameAssets["npcSrc"],
  worldWidth: number,
): { followers: TravelActorFrame[]; vehicles: TravelActorFrame[] } {
  const riding = state.travel?.vehicles?.riding ?? null;
  const followers = state.travel?.followers;
  return {
    followers: (followers?.members ?? []).map((member) => travelFrame(
      member.id,
      member.move,
      member.sprite,
      followers!.visible && riding === null,
      sprites,
      npcSrc,
      worldWidth,
    )),
    vehicles: (state.travel?.vehicles?.entries ?? []).map((vehicle) => travelFrame(
      vehicle.id,
      vehicle.move,
      vehicle.sprite,
      vehicle.mapId === state.mapId && vehicle.id !== riding,
      sprites,
      npcSrc,
      worldWidth,
    )),
  };
}

function sameTravelActorFrame(a: TravelActorFrame, b: TravelActorFrame): boolean {
  return a.id === b.id && a.px === b.px && a.py === b.py && a.src === b.src &&
    a.height === b.height && a.visible === b.visible && a.depth === b.depth;
}

export function sameTravelActorFrames(
  a: readonly TravelActorFrame[],
  b: readonly TravelActorFrame[],
): boolean {
  return a.length === b.length && a.every((frame, index) => sameTravelActorFrame(frame, b[index]!));
}
