// Opt-in validation and pure state projection for battle SE/result ME.
// Kept out of the engine barrel; RPG Maker battle rules attach this runtime
// explicitly so ordinary projects do not bundle these contracts.

import { cloneAudioState, type AudioState } from "./audio.ts";
import type { BattleEffectsRuntime } from "./battle-effects-contract.ts";
import type { SoundCue } from "./interpreter.ts";

function soundCues(value: unknown): SoundCue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("battle cues: array required");
  if (value.length === 0) return undefined;
  const out: SoundCue[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`battle cue ${index}: object required`);
    }
    const cue = entry as Record<string, unknown>;
    if (typeof cue.id !== "string" || cue.id.length === 0) {
      throw new Error(`battle cue ${index}.id: non-empty string required`);
    }
    const volume = cue.volume ?? 100;
    if (!Number.isInteger(volume) || (volume as number) < 0 || (volume as number) > 100) {
      throw new Error(`battle cue ${index}.volume: integer 0..100 required`);
    }
    const pitch = cue.pitch ?? 100;
    if (!Number.isInteger(pitch) || (pitch as number) < 50 || (pitch as number) > 150) {
      throw new Error(`battle cue ${index}.pitch: integer 50..150 required`);
    }
    const pan = cue.pan ?? 0;
    if (!Number.isInteger(pan) || (pan as number) < -100 || (pan as number) > 100) {
      throw new Error(`battle cue ${index}.pan: integer -100..100 required`);
    }
    out.push({
      name: cue.id,
      volume: volume as number,
      pitch: pitch as number,
      ...((pan as number) !== 0 ? { pan: pan as number } : {}),
    });
  }
  return out;
}

function completeAudio(
  value: unknown,
  suspended: Readonly<AudioState> | null | undefined,
  current: Readonly<AudioState> | undefined,
): AudioState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("battle completion audio: object required");
  }
  const audio = value as Record<string, unknown>;
  const restore = audio.restore ?? "map";
  if (restore !== "map" && restore !== "none") {
    throw new Error("battle completion audio.restore: map or none required");
  }
  if (audio.alreadyStarted !== undefined && audio.alreadyStarted !== true) {
    throw new Error("battle completion audio.alreadyStarted: true required when present");
  }
  const cueValue = audio.cue;
  if (cueValue === null || typeof cueValue !== "object" || Array.isArray(cueValue)) {
    throw new Error("battle completion audio.cue: object required");
  }
  const cue = cueValue as Record<string, unknown>;
  if (typeof cue.id !== "string" || cue.id.length === 0) {
    throw new Error("battle completion audio.cue.id: non-empty string required");
  }
  const volume = cue.volume ?? 100;
  if (!Number.isInteger(volume) || (volume as number) < 0 || (volume as number) > 100) {
    throw new Error("battle completion audio.cue.volume: integer 0..100 required");
  }
  const pitch = cue.pitch ?? 100;
  if (!Number.isInteger(pitch) || (pitch as number) < 50 || (pitch as number) > 150) {
    throw new Error("battle completion audio.cue.pitch: integer 50..150 required");
  }
  const pan = cue.pan ?? 0;
  if (!Number.isInteger(pan) || (pan as number) < -100 || (pan as number) > 100) {
    throw new Error("battle completion audio.cue.pan: integer -100..100 required");
  }
  if (!Number.isInteger(cue.durationTicks) || (cue.durationTicks as number) <= 0) {
    throw new Error("battle completion audio.cue.durationTicks: positive integer required");
  }

  if (audio.alreadyStarted === true) return current ? cloneAudioState(current) : {};
  if (current?.me && current.me.id === cue.id && current.me.volume === volume &&
      current.me.pitch === pitch && (current.me.pan ?? 0) === pan &&
      current.me.durationTicks === cue.durationTicks && current.me.positionTicks === 0 &&
      current.me.leftTicks === cue.durationTicks) {
    return cloneAudioState(current);
  }

  const base = restore === "none"
    ? undefined
    : suspended === undefined
      ? current
      : suspended ?? undefined;
  const result = base ? cloneAudioState(base) : {};
  result.me = {
    id: cue.id,
    volume: volume as number,
    pitch: pitch as number,
    ...((pan as number) !== 0 ? { pan: pan as number } : {}),
    positionTicks: 0,
    durationTicks: cue.durationTicks as number,
    leftTicks: cue.durationTicks as number,
  };
  return result;
}

export const battleEffectsRuntime: BattleEffectsRuntime = {
  soundCues,
  completeAudio,
};

export type { BattleEffectsRuntime } from "./battle-effects-contract.ts";
