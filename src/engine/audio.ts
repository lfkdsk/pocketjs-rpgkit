// src/engine/audio.ts — deterministic, host-independent audio state.
//
// The reducer records intent and virtual playback time only. PCM buffers,
// stream handles and host events belong to the opt-in presentation adapter.
// All counters use the engine's fixed 60 Hz reference clock, so save/load,
// rewind and low simulation rates describe the same instant.

export interface AudioFadeState {
  /** Fade duration in reference ticks. Always positive. */
  totalTicks: number;
  /** Ticks remaining before the transition completes. */
  leftTicks: number;
  /** Omitted keeps the original fade-out save shape and semantics. */
  direction?: "in";
}

export interface AudioTrackState {
  id: string;
  /** RPG-style percentage, 0..100. */
  volume: number;
  /** Playback-rate percentage, 50..150. */
  pitch: number;
  /** Stereo balance, -100 (left) through 100 (right). Omitted is centred. */
  pan?: number;
  /** Virtual playback position in reference ticks. */
  positionTicks: number;
  /** Only BGM can be explicitly paused. */
  paused?: true;
  fade?: AudioFadeState;
}

export interface AudioMeState extends AudioTrackState {
  /** Authored one-shot duration in reference ticks. */
  durationTicks: number;
  /** Ticks remaining before BGM resumes. */
  leftTicks: number;
}

export interface SavedBgmState {
  id: string;
  volume: number;
  pitch: number;
  pan?: number;
  positionTicks: number;
}

/** RPG Maker MV/MZ resumes BGM through a 0.5 second fade after an ME. */
export const ME_REPLAY_FADE_TICKS = 30;

/** Sparse persistent audio intent. Missing fields mean silence. */
export interface AudioState {
  bgm?: AudioTrackState;
  bgs?: AudioTrackState;
  me?: AudioMeState;
  savedBgm?: SavedBgmState;
  /** BGM (or explicit silence) captured when a vehicle ride begins. This is
   * independent of event commands' saveBgm slot. */
  walkingBgm?: SavedBgmState | null;
}

export function cloneAudioTrack<T extends AudioTrackState>(track: Readonly<T>): T {
  return {
    ...track,
    ...(track.fade ? { fade: { ...track.fade } } : {}),
  } as T;
}

export function cloneAudioState(audio: Readonly<AudioState>): AudioState {
  return {
    ...(audio.bgm ? { bgm: cloneAudioTrack(audio.bgm) } : {}),
    ...(audio.bgs ? { bgs: cloneAudioTrack(audio.bgs) } : {}),
    ...(audio.me ? { me: cloneAudioTrack(audio.me) } : {}),
    ...(audio.savedBgm ? { savedBgm: { ...audio.savedBgm } } : {}),
    ...(Object.prototype.hasOwnProperty.call(audio, "walkingBgm")
      ? { walkingBgm: audio.walkingBgm ? { ...audio.walkingBgm } : null }
      : {}),
  };
}

/** Effective host volume after a reducer-owned fade. */
export function audioTrackVolume(track: Readonly<AudioTrackState>): number {
  if (!track.fade) return track.volume;
  return track.fade.direction === "in"
    ? track.volume * (track.fade.totalTicks - track.fade.leftTicks) / track.fade.totalTicks
    : track.volume * track.fade.leftTicks / track.fade.totalTicks;
}

/** RPG Maker clears its current-track identity as soon as fade-out starts,
 * even though the old buffer remains audible until the fade completes. */
export function audioTrackIsFadingOut(track: Readonly<AudioTrackState>): boolean {
  return track.fade !== undefined && track.fade.direction !== "in";
}

/** True when no durable audio fact remains. */
export function audioStateEmpty(audio: Readonly<AudioState>): boolean {
  return !audio.bgm && !audio.bgs && !audio.me && !audio.savedBgm &&
    !Object.prototype.hasOwnProperty.call(audio, "walkingBgm");
}

function advanceFade(track: AudioTrackState): boolean {
  if (!track.fade) return false;
  track.fade.leftTicks--;
  if (track.fade.leftTicks <= 0) {
    if (track.fade.direction === "in") {
      delete track.fade;
      return false;
    }
    return true;
  }
  return false;
}

/** Stop a live ME and resume the held BGM through RPG Maker's replay fade. */
export function stopMeAndResumeBgmInPlace(audio: AudioState): boolean {
  if (!audio.me) return false;
  delete audio.me;
  if (audio.bgm && !audioTrackIsFadingOut(audio.bgm)) {
    audio.bgm.fade = {
      totalTicks: ME_REPLAY_FADE_TICKS,
      leftTicks: ME_REPLAY_FADE_TICKS,
      direction: "in",
    };
  }
  return true;
}

/** Advance one fixed reference tick on a caller-owned state object. */
export function advanceAudioStateInPlace(audio: AudioState): void {
  const meWasPlaying = audio.me !== undefined;

  // RPG Maker stops a current BGM buffer while an ME owns the music channel.
  // A buffer already fading out is no longer current, so it continues beside
  // the ME instead of being held or resumed afterward.
  if (audio.bgm && (!meWasPlaying || audioTrackIsFadingOut(audio.bgm))) {
    if (advanceFade(audio.bgm)) {
      delete audio.bgm;
    } else if (!audio.bgm.paused) {
      audio.bgm.positionTicks++;
    }
  }

  if (audio.bgs) {
    if (advanceFade(audio.bgs)) delete audio.bgs;
    else audio.bgs.positionTicks++;
  }

  if (audio.me) {
    audio.me.positionTicks++;
    audio.me.leftTicks--;
    if (audio.me.leftTicks <= 0) stopMeAndResumeBgmInPlace(audio);
  }
}
