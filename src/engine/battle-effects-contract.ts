// Type-only seam for optional battle audio effects. The concrete validator
// lives outside the engine barrel so projects that never opt in do not bundle
// its RPG-style cue and completion-ME implementation.

import type { AudioState } from "./audio.ts";
import type { SoundCue } from "./interpreter.ts";

export interface BattleEffectsRuntime {
  /** Validate game-owned one-shot cue data and project host-ready SE cues. */
  soundCues(value: unknown): SoundCue[] | undefined;
  /** Validate and atomically install one completion ME over the selected
   * base mix. `suspended` is undefined when the battle never owned audio,
   * null for prior silence, or the complete map-side mix to restore. */
  completeAudio(
    value: unknown,
    suspended: Readonly<AudioState> | null | undefined,
    current: Readonly<AudioState> | undefined,
  ): AudioState;
}
