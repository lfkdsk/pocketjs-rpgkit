// Optional follower/vehicle painting. Import this entry only for projects
// that declare travel; ordinary GameView bundles keep its frame logic out.

import { createSignal, Index, type JSX } from "solid-js";
import { Image, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { effectivePlayerAppearance } from "../engine/interpreter.ts";
import { walkPose } from "../engine/movement.ts";
import { TILE } from "../engine/tiles.ts";
import { npcArt, npcArtHeight, npcArtKey } from "./npc-art.ts";
import {
  airshipShadowFrame,
  sameAirshipShadowFrame,
  sameTravelActorFrames,
  travelActorFrames,
  type AirshipShadowFrame,
  type TravelActorFrame,
} from "./travel-actors.ts";
import type {
  PlayerRenderFrame,
  TravelActorsProps,
  TravelPresentation,
} from "./travel-presentation-contract.ts";

function actorStyle(height: 16 | 32, depth: number, opacity: number, visible: boolean) {
  return {
    posType: 1,
    insetL: 0,
    insetT: TILE - height,
    width: TILE,
    height,
    zIndex: depth,
    opacity,
    display: visible ? 0 : 1,
  };
}

function travelActorStyle(frame: TravelActorFrame) {
  return {
    ...actorStyle(frame.height, frame.depth, 1, frame.visible),
    translateX: frame.px,
    translateY: frame.py,
  };
}

function airshipShadowStyle(frame: AirshipShadowFrame) {
  return {
    posType: 1,
    insetL: 0,
    insetT: 0,
    width: 12,
    height: 6,
    zIndex: frame.depth,
    opacity: frame.opacity,
    display: frame.visible ? 0 : 1,
    translateX: frame.px,
    translateY: frame.py,
  };
}

export function TravelActors(props: TravelActorsProps): JSX.Element {
  const initial = travelActorFrames(props.initial, props.sprites, props.npcSrc, props.worldWidth);
  const initialShadow = airshipShadowFrame(props.initial, props.worldWidth);
  const [followers, setFollowers] = createSignal<readonly TravelActorFrame[]>(initial.followers);
  const [vehicles, setVehicles] = createSignal<readonly TravelActorFrame[]>(initial.vehicles);
  const [shadow, setShadow] = createSignal<AirshipShadowFrame>(initialShadow);

  onFrame(() => {
    if (props.active && !props.active()) return;
    const next = travelActorFrames(props.state(), props.sprites, props.npcSrc, props.worldWidth);
    const nextShadow = airshipShadowFrame(props.state(), props.worldWidth);
    setFollowers((current) => sameTravelActorFrames(current, next.followers) ? current : next.followers);
    setVehicles((current) => sameTravelActorFrames(current, next.vehicles) ? current : next.vehicles);
    setShadow((current) => sameAirshipShadowFrame(current, nextShadow) ? current : nextShadow);
  });

  return (
    <>
      <View class="absolute" style={airshipShadowStyle(shadow())} debugName="rpgkit-airship-shadow">
        <View style={{ posType: 1, insetL: 2, insetT: 0, width: 8, height: 2, bgColor: "#000000" }} />
        <View style={{ posType: 1, insetL: 0, insetT: 2, width: 12, height: 2, bgColor: "#000000" }} />
        <View style={{ posType: 1, insetL: 2, insetT: 4, width: 8, height: 2, bgColor: "#000000" }} />
      </View>
      <Index each={followers()}>{(frame) => (
        <Image
          class="absolute"
          src={frame().src}
          style={travelActorStyle(frame())}
          debugName={`rpgkit-follower-${frame().id}`}
        />
      )}</Index>
      <Index each={vehicles()}>{(frame) => (
        <Image
          class="absolute"
          src={frame().src}
          style={travelActorStyle(frame())}
          debugName={`rpgkit-vehicle-${frame().id}`}
        />
      )}</Index>
    </>
  );
}

function riddenPlayerFrame(
  state: Parameters<TravelPresentation["playerFrame"]>[0],
  sprites: Parameters<TravelPresentation["playerFrame"]>[1],
  npcSrc: Parameters<TravelPresentation["playerFrame"]>[2],
  builtIn: Parameters<TravelPresentation["playerFrame"]>[3],
  builtInHeight: Parameters<TravelPresentation["playerFrame"]>[4],
  fallback: Parameters<TravelPresentation["playerFrame"]>[5],
): PlayerRenderFrame {
  const id = state.travel?.vehicles?.riding;
  const vehicle = id
    ? state.travel!.vehicles!.entries.find((entry) => entry.id === id)
    : undefined;
  if (!vehicle) return fallback(state, sprites, npcSrc, builtIn, builtInHeight);
  const appearance = effectivePlayerAppearance(state.sw);
  const art = npcArt(vehicle.sprite, sprites, npcSrc);
  return {
    src: npcArtKey(art, walkPose(state.move.phase), state.move.facing),
    height: npcArtHeight(art),
    opacity: appearance.opacity / 255,
    visible: appearance.visible && art !== "",
  };
}

export const travelPresentation: TravelPresentation = Object.freeze({
  playerFrame: riddenPlayerFrame,
  playerY: (state: Parameters<TravelPresentation["playerY"]>[0]) =>
    state.move.py - (state.travel?.vehicles?.airshipAltitude ?? 0),
  Actors: TravelActors,
});
