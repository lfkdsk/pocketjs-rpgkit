// src/engine/battle.ts — generic Battle Processing contracts.
//
// Rules are supplied by a game. The kit owns only lifecycle: seed once from
// the session RNG, retain the JSON battle state in SessionState.scene, route
// input/ticks to the pure reducer, and resume the parked event branch.

import { deepClone } from "./clone.ts";
import { cloneAudioState, type AudioState } from "./audio.ts";
import { assertJsonValue } from "./extensions.ts";
import type { ExtensionReadContext } from "./extensions.ts";
import type { GameScene } from "./scene.ts";
import type { BattleEffectsRuntime } from "./battle-effects-contract.ts";
import type { Dir, JsonValue, VariableValue } from "./types.ts";

export interface BattleInput {
  buttons: number;
  confirmEdge?: boolean;
  cancelEdge?: boolean;
  upEdge?: boolean;
  downEdge?: boolean;
  /** KG1: horizontal edges. Battle rules ignore them; game scenes (name
   *  input grids) navigate with them. */
  leftEdge?: boolean;
  rightEdge?: boolean;
}

export type BattleResult = "win" | "lose" | "escape" | "draw";

export interface BattleTransfer {
  map: string;
  x: number;
  y: number;
  dir?: Dir | "keep";
  /** Authored seconds, compiled against the fixed 60 Hz reference. */
  fade?: number;
}

export interface BattleCompletion {
  ext: JsonValue;
  result: BattleResult;
  writes?: Readonly<Record<string, VariableValue>>;
  switches?: Readonly<Record<string, boolean>>;
  /** Item-count replacements committed to the session backpack. A
   *  normalized count of zero removes the item. */
  items?: Readonly<Record<string, number>>;
  /** Replacement for the session wallet. */
  gold?: number;
  transfer?: BattleTransfer;
  /** Optional one-shot result cue. The selected base mix is installed before
   * the cue, so an ME can hold and later fade the restored map BGM exactly
   * like an authored playMe command. */
  audio?: BattleCompletionAudio;
}

export interface BattleCompletionCue {
  id: string;
  volume?: number;
  pitch?: number;
  pan?: number;
  /** Decoded one-shot length in fixed 60 Hz reference ticks. */
  durationTicks: number;
}

export interface BattleCompletionAudio {
  cue: BattleCompletionCue;
  /** `map` restores the mix suspended by BattleStart.audio before playing
   * the cue (and is the default). `none` discards every prior track, leaving
   * silence after the cue finishes. */
  restore?: "map" | "none";
}

/** One battle-owned BGM intent. Battle music deliberately owns only BGM:
 * the complete map-side mix remains suspended until the scene completes. */
export interface BattleAudio {
  bgm: {
    id: string;
    volume?: number;
    pitch?: number;
    pan?: number;
  } | null;
}

/** One transient battle-owned SE emitted on a reducer-state edge. Unlike
 * `BattleAudio`, cues are one-shot frame outputs: the session validates and
 * appends them to the interpreter's ordinary per-frame cue sequence. */
export interface BattleCue {
  id: string;
  volume?: number;
  pitch?: number;
  pan?: number;
}

export interface BattleStart {
  state: JsonValue;
  ext: JsonValue;
  /** Optional MV-style battle audio policy. Omit to leave the current audio
   * state alone. When present, the session suspends the complete map audio
   * state, plays only this BGM (or silence for null), then restores the map
   * state atomically when the battle completes. */
  audio?: BattleAudio;
}

/** Optional, game-owned active-battle save codec. The engine can prove the
 * scene wrapper and parked interpreter fiber are resumable, but only the
 * registered rules know whether their opaque JSON state is structurally
 * valid for a later step(). Rules that omit this codec retain the historical
 * behavior: an open battle is not a manual save point. */
export interface BattleSaveCodec {
  /** Produce the JSON payload stored in rpgkit-save/v1. */
  encode(state: JsonValue): JsonValue;
  /** Validate and rebuild a payload before it is exposed to step()/done(). */
  decode(saved: JsonValue): JsonValue;
}

export interface BattleRules {
  /** Opt in only when callbacks preserve every published state and return
   * persistent JSON values. The engine can then share validated subtrees. */
  readonly immutableState?: boolean;
  /** Opt in to manual saves while this battle owns the full-screen scene. */
  readonly save?: BattleSaveCodec;
  /** Optional pure validator/projector for transient cues and completion ME.
   * Its concrete implementation is deliberately outside the engine barrel. */
  readonly effects?: BattleEffectsRuntime;
  start(
    ext: JsonValue,
    setup: JsonValue,
    seed: number,
    context: ExtensionReadContext,
  ): BattleStart | null;
  /** One host-frame fold. ticks is the number of fixed 60 Hz reference ticks
   * represented by that host frame (1/2/3/15 at 60/30/20/4 Hz). */
  step(state: JsonValue, input: Readonly<BattleInput>, ticks: number): JsonValue;
  /** Optional one-shot projection across a completed step. The engine
   * preserves `previousState` even for rules that mutate their step input,
   * validates the result, and never calls this hook for projects without an
   * audio manifest. Omit it to retain the zero-clone/zero-call hot path. */
  cues?(
    previousState: JsonValue,
    state: JsonValue,
  ): readonly BattleCue[] | undefined;
  /** Optional desired BGM projection for a battle that returned
   * `BattleStart.audio`. The engine samples it after each step, changes the
   * owned track only when id/volume/pitch/pan differ, and still restores the
   * suspended map mix on completion. `undefined` keeps the current battle
   * track; `{ bgm: null }` selects silence. */
  audio?(state: JsonValue): BattleAudio | undefined;
  done(state: JsonValue): BattleCompletion | null;
}

export interface BattleScene {
  kind: "battle";
  fiber: string;
  state: JsonValue;
  /** Reference ticks for which the map world has been paused. Applied to
   * fiber-relative clocks atomically when this scene completes. */
  pausedTicks: number;
  /** Complete map-side audio suspended by BattleStart.audio. undefined means
   * the battle did not opt into audio ownership; null means prior silence. */
  returnAudio?: AudioState | null;
}

export type SceneSlot = BattleScene | GameScene;

export function cloneScene(scene: BattleScene, immutableState?: boolean): BattleScene;
export function cloneScene(scene: GameScene, immutableState?: boolean): GameScene;
export function cloneScene(scene: null, immutableState?: boolean): null;
export function cloneScene(scene: SceneSlot | null, immutableState?: boolean): SceneSlot | null;
export function cloneScene(scene: SceneSlot | null, immutableState = false): SceneSlot | null {
  if (scene === null) return null;
  const shareState = scene.kind === "battle" && immutableState;
  if (!shareState) assertJsonValue(scene.state, `${scene.kind} scene state`);
  const state = shareState ? scene.state : deepClone(scene.state);
  if (scene.kind !== "battle") {
    return {
      ...scene,
      state,
      pausedTicks: scene.pausedTicks ?? 0,
    };
  }
  const cloned: BattleScene = {
    ...scene,
    state,
    pausedTicks: scene.pausedTicks ?? 0,
  };
  if (scene.returnAudio !== undefined) {
    cloned.returnAudio = scene.returnAudio === null ? null : cloneAudioState(scene.returnAudio);
  }
  return cloned;
}
