/** Type-only UI boundary for the optional follower/vehicle presentation. */

import type { Accessor, Component } from "solid-js";
import type { ExtensionRuntime } from "../engine/extensions.ts";
import type { SessionState } from "../engine/session.ts";
import type { SpriteDef } from "../engine/types.ts";
import type { GameAssets } from "./game-assets.ts";
import type { ActorRenderSpace } from "./occlusion-depth.ts";

export interface PlayerRenderFrame {
  src: string;
  height: 16 | 32;
  opacity: number;
  visible: boolean;
}

export type PlayerFrameResolver = (
  state: SessionState,
  sprites: Readonly<Record<string, SpriteDef>>,
  npcSrc: GameAssets["npcSrc"],
  builtIn: GameAssets["player"],
  builtInHeight: 16 | 32,
) => PlayerRenderFrame;

export interface TravelActorsProps {
  initial: Readonly<SessionState>;
  state: () => SessionState;
  sprites: Readonly<Record<string, SpriteDef>>;
  npcSrc: GameAssets["npcSrc"];
  worldWidth: number;
  space?: Accessor<ActorRenderSpace>;
  active?: Accessor<boolean>;
  /** Kept in the contract for future game-owned travel art decisions. */
  extensions?: ExtensionRuntime;
}

export interface TravelPresentation {
  playerFrame(
    state: SessionState,
    sprites: Readonly<Record<string, SpriteDef>>,
    npcSrc: GameAssets["npcSrc"],
    builtIn: GameAssets["player"],
    builtInHeight: 16 | 32,
    fallback: PlayerFrameResolver,
  ): PlayerRenderFrame;
  playerY(state: SessionState): number;
  Actors: Component<TravelActorsProps>;
}
