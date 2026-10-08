// src/engine/scene.ts — generic game-registered UI scene contracts.
//
// A `scene` event command parks its fiber and asks the session to open a
// full-screen scene owned by the game: a PC storage box, a journal, a
// trading screen, a name input. The kit owns only the lifecycle, exactly
// like Battle Processing (battle.ts): seed once from the session RNG,
// retain the JSON scene state in SessionState.scene, route input/ticks to
// the pure reducer, and resume the parked event branch with the optional
// completion writes. The scene's UI is a game-registered Solid component
// that reads only the JSON state and the live logical resolution, so
// replay and rewind reproduce the same pixels.

import type { ExtensionReadContext } from "./extensions.ts";
import type { Dir, JsonValue, VariableValue } from "./types.ts";

export interface SceneInput {
  buttons: number;
  confirmEdge?: boolean;
  cancelEdge?: boolean;
  upEdge?: boolean;
  downEdge?: boolean;
  leftEdge?: boolean;
  rightEdge?: boolean;
  /** Optional direct-selection gesture from a scene view. The meaning of
   *  an index is scene-specific; reducers must range-check it. It stays
   *  outside the button mask so recorded controller tapes keep their
   *  existing byte format. */
  selectIndex?: number;
}

export interface SceneTransfer {
  map: string;
  x: number;
  y: number;
  dir?: Dir | "keep";
  /** Authored seconds, compiled against the fixed 60 Hz reference. */
  fade?: number;
}

export interface SceneCompletion {
  /** True when the player cancelled. The parked fiber runs onCancel
   *  instead of onDone, and every write field below is ignored. */
  cancelled?: boolean;
  /** Omit to retain the current extension state; null is a valid state. */
  ext?: JsonValue;
  /** Atomic replacements in the built-in variable bank. */
  writes?: Readonly<Record<string, VariableValue>>;
  /** Atomic replacements in the built-in switch bank. */
  switches?: Readonly<Record<string, boolean>>;
  /** Item-count replacements committed to the session backpack. A
   *  normalized count of zero removes the item. */
  items?: Readonly<Record<string, number>>;
  /** Replacement for the session wallet. */
  gold?: number;
  /** Replacement for the player's name (1..24 chars, the save-validated
   *  range). Used by the built-in name input scene. */
  playerName?: string;
  transfer?: SceneTransfer;
}

export interface SceneStart {
  state: JsonValue;
  ext: JsonValue;
}

export interface SceneRules {
  start(
    ext: JsonValue,
    args: JsonValue,
    seed: number,
    context: ExtensionReadContext,
  ): SceneStart | null;
  /** One host-frame fold. ticks is the number of fixed 60 Hz reference
   *  ticks represented by that host frame (1/2/3/15 at 60/30/20/4 Hz). */
  step(state: JsonValue, input: Readonly<SceneInput>, ticks: number): JsonValue;
  done(state: JsonValue): SceneCompletion | null;
}

/** A game-registered scene instance. `id` selects both the SceneRules
 *  (session) and the UI component (GameView sceneViews). */
export interface GameScene {
  kind: "scene";
  id: string;
  fiber: string;
  state: JsonValue;
  /** Reference ticks for which the map world has been paused. Applied to
   *  fiber-relative clocks atomically when this scene completes. */
  pausedTicks: number;
}
