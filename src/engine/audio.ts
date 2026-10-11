// src/engine/audio.ts — deterministic, host-independent audio state.
//
// The reducer records intent and virtual playback time only. PCM buffers,
// stream handles and host events belong to the opt-in presentation adapter.
// All counters use the engine's fixed 60 Hz reference clock, so save/load,
// rewind and low simulation rates describe the same instant.

export interface AudioFadeState {
  /** Fade duration in reference ticks. Always positive. */
  totalTicks: number;
  /** Ticks remaining before the track is removed. */
  leftTicks: number;
}

export interface AudioTrackState {
  id: string;
  /** RPG-style percentage, 0..100. */
  volume: number;
  /** Playback-rate percentage, 50..150. */
  pitch: number;
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
  positionTicks: number;
}

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
  return track.fade
    ? track.volume * track.fade.leftTicks / track.fade.totalTicks
    : track.volume;
}

/** True when no durable audio fact remains. */
export function audioStateEmpty(audio: Readonly<AudioState>): boolean {
  return !audio.bgm && !audio.bgs && !audio.me && !audio.savedBgm &&
    !Object.prototype.hasOwnProperty.call(audio, "walkingBgm");
}

function advanceFade(track: AudioTrackState): boolean {
  if (!track.fade) return false;
  track.fade.leftTicks--;
  if (track.fade.leftTicks <= 0) return true;
  return false;
}

/** Advance one fixed reference tick on a caller-owned state object. */
export function advanceAudioStateInPlace(audio: AudioState): void {
  const meWasPlaying = audio.me !== undefined;

  if (audio.bgm) {
    if (advanceFade(audio.bgm)) {
      delete audio.bgm;
    } else if (!audio.bgm.paused && !meWasPlaying) {
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
    if (audio.me.leftTicks <= 0) delete audio.me;
  }
}
