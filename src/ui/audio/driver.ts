// src/ui/audio/driver.ts — the opt-in bridge from reducer audio intent to the
// PocketJS audio module. One driver owns every stream and drains audio.poll()
// exactly once, so events for one voice cannot be swallowed by another.

import {
  AUDIO_RING_FRAMES,
  decodeWav,
  type AudioOps,
  type WavPcm,
} from "@pocketjs/framework/audio";
import { get as pakGet } from "@pocketjs/framework/pak";
import {
  audioTrackIsFadingOut,
  audioTrackVolume,
  type AudioMeState,
  type AudioState,
  type AudioTrackState,
} from "../../engine/audio.ts";
import type { SoundCue } from "../../engine/interpreter.ts";
import { QoaFile } from "./qoa.ts";

const MAX_STREAMS = 4;
const TICKS_PER_SECOND = 60;

type PersistentKind = "bgm" | "bgs" | "me";
type VoiceKind = PersistentKind | "se";

export interface AudioDriverState {
  readonly frame: number;
  readonly interp: {
    readonly audio?: Readonly<AudioState>;
    readonly cues: readonly Readonly<SoundCue>[];
    readonly error?: unknown;
  };
}

export type AudioResourceReader = (pakKey: string) => Uint8Array;

interface AudioSource {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frames: number;
  sample(frame: number, channel: number): number;
  readInto?(output: Int16Array, outputFrame: number, sourceFrame: number, frames: number): void;
}

interface AudioAsset {
  open(): AudioSource;
}

interface Voice {
  readonly handle: number;
  readonly kind: VoiceKind;
  readonly id: string;
  readonly pakKey: string;
  readonly source: AudioSource;
  readonly pitch: number;
  readonly pan: number;
  /** Panned mono is expanded to stereo; centred voices retain source shape. */
  readonly outputChannels: number;
  readonly looping: boolean;
  readonly serial: number;
  /** Absolute output-frame cursor. Pitch is applied only when selecting source samples. */
  cursor: number;
  /** Last game-frame/position pair observed for discontinuity detection. */
  gameFrame: number;
  positionTicks: number;
  /** Guest-side mirror of the host ring's free source-frame capacity. */
  free: number;
  volume: number;
  /** Reducer playback gate observed on the previous sync. */
  reducerPlaying: boolean;
  desiredPlaying: boolean;
  hostPlaying: boolean;
  endSent: boolean;
  finished: boolean;
}

function clampVolume(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(1, percent / 100));
}

function normalizedPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 100;
  return Math.max(1, Math.round(pitch));
}

function normalizedPan(pan: number | undefined): number {
  if (!Number.isFinite(pan)) return 0;
  return Math.max(-100, Math.min(100, Math.round(pan!)));
}

function pannedSample(sample: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(sample)));
}

/** Azimuth produced by RPG Maker's PannerNode position (x=pan,
 * z=1-|pan|), after WebAudio folds rear positions into [-90, 90]. */
function pannerAzimuth(pan: number): number {
  const x = pan / 100;
  const z = 1 - Math.abs(x);
  return Math.atan2(x, z) * 180 / Math.PI;
}

function outputFrameAtTick(ticks: number, sampleRate: number): number {
  if (!Number.isFinite(ticks) || ticks <= 0) return 0;
  return Math.floor(ticks * sampleRate / TICKS_PER_SECOND);
}

function oneShotOutputFrames(source: AudioSource, pitch: number): number {
  return Math.ceil(source.frames * 100 / pitch);
}

function wavAsset(pcm: WavPcm): AudioAsset {
  return {
    open: () => ({
      sampleRate: pcm.sampleRate,
      channels: pcm.channels,
      frames: pcm.frames,
      sample: (frame, channel) => pcm.data[frame * pcm.channels + channel] ?? 0,
    }),
  };
}

/**
 * Central four-stream driver. Persistent reducer tracks are reconciled before
 * transient SE, and every host event is dispatched here by handle.
 */
export class AudioDriver {
  private readonly voices = new Map<number, Voice>();
  private readonly persistent: Partial<Record<PersistentKind, Voice>> = {};
  /** One paused BGM is kept as a bounded return candidate. Scene-owned music
   * commonly replaces a map track and later restores the exact reducer
   * position; retaining its already-filled native ring keeps that restore off
   * the frame's QOA decode path. */
  private suspendedBgm: Voice | undefined;
  private readonly assetCache = new Map<string, AudioAsset | null>();
  private lastState: AudioDriverState | undefined;
  private lastFrame: number | undefined;
  private nextSerial = 1;

  constructor(
    private readonly ops: AudioOps,
    private readonly resources: Readonly<Record<string, string>>,
    private readonly readResource: AudioResourceReader = pakGet,
    private readonly referenceTicksPerFrame = 1,
  ) {
    if (!Number.isInteger(referenceTicksPerFrame) || referenceTicksPerFrame <= 0) {
      throw new Error("audio: referenceTicksPerFrame must be a positive integer");
    }
  }

  /** Reconcile one reducer frame, then fill every credited ring. */
  sync(state: AudioDriverState): void {
    this.drainEvents();

    // Solid returns the same immutable state object until the game advances.
    // A different object at the same (or an older) frame is a refold/load and
    // must rebuild durable voices without replaying historical one-shot cues.
    const repeated = this.lastState === state;
    const refolded = !repeated && this.lastFrame !== undefined && state.frame !== this.lastFrame + 1;
    // A fatal reducer can stop partway through a low-Hz batch. Rebuild once at
    // its canonical position; on later fatal frames the reducer advances one
    // tick while the presentation is deliberately allowed to keep playing.
    const enteredFatal = !repeated && state.interp.error !== undefined &&
      this.lastState !== undefined && this.lastState.interp.error === undefined;
    if (refolded || enteredFatal) this.destroyAll();

    if (!repeated) {
      const elapsedTicksPerFrame = state.interp.error === undefined
        ? this.referenceTicksPerFrame
        : 1;
      this.reconcilePersistent(state.interp.audio, state.frame, elapsedTicksPerFrame);
      // A refold ends on historical cues. Rebuild persistent tracks at their
      // restored positions, but never replay those one-shot side effects.
      if (!refolded) {
        for (const cue of state.interp.cues) {
          if ("stop" in cue) this.stopAllSe();
          else this.startSe(cue);
        }
      }
      this.lastState = state;
      this.lastFrame = state.frame;
    }

    this.pumpAll();
  }

  dispose(): void {
    this.destroyAll();
    this.lastState = undefined;
    this.lastFrame = undefined;
  }

  private drainEvents(): void {
    for (let line = this.ops.poll(); line !== undefined; line = this.ops.poll()) {
      let event: { t?: unknown; h?: unknown; free?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (typeof event.h !== "number") continue;
      const voice = this.voices.get(event.h);
      if (!voice) continue;
      if (event.t === "credit" && typeof event.free === "number") {
        voice.free = Math.max(0, Math.min(AUDIO_RING_FRAMES, Math.floor(event.free)));
      } else if (event.t === "ended") {
        voice.hostPlaying = false;
        voice.finished = true;
        if (voice.kind === "se") this.destroyVoice(voice);
      }
    }
  }

  private reconcilePersistent(
    audio: Readonly<AudioState> | undefined,
    gameFrame: number,
    elapsedTicksPerFrame: number,
  ): void {
    this.reconcileTrack(
      "bgm",
      audio?.bgm,
      !!audio?.bgm && !audio.bgm.paused && (!audio.me || audioTrackIsFadingOut(audio.bgm)),
      true,
      gameFrame,
      elapsedTicksPerFrame,
    );
    this.reconcileTrack("bgs", audio?.bgs, audio?.bgs !== undefined, true, gameFrame, elapsedTicksPerFrame);
    this.reconcileTrack("me", audio?.me, audio?.me !== undefined, false, gameFrame, elapsedTicksPerFrame);
  }

  private reconcileTrack(
    kind: PersistentKind,
    track: Readonly<AudioTrackState | AudioMeState> | undefined,
    playing: boolean,
    looping: boolean,
    gameFrame: number,
    elapsedTicksPerFrame: number,
  ): void {
    let voice = this.persistent[kind];
    if (!track) {
      if (voice) {
        if (kind === "bgm") this.suspendBgm(voice);
        else this.destroyVoice(voice);
      }
      return;
    }

    const pakKey = this.resources[track.id];
    if (!pakKey) {
      if (voice) this.destroyVoice(voice);
      return;
    }
    const pitch = normalizedPitch(track.pitch);
    const pan = normalizedPan(track.pan);
    const sameTrack = voice && voice.id === track.id && voice.pakKey === pakKey &&
      voice.pitch === pitch && voice.pan === pan;
    if (voice && !sameTrack) {
      const returning = kind === "bgm"
        ? this.takeSuspendedBgm(track, pakKey, pitch, gameFrame)
        : undefined;
      if (returning) {
        this.destroyVoice(voice);
        voice = returning;
      } else if (kind === "bgm") {
        this.suspendBgm(voice);
        voice = undefined;
      } else {
        this.destroyVoice(voice);
        voice = undefined;
      }
    } else if (!voice && kind === "bgm") {
      voice = this.takeSuspendedBgm(track, pakKey, pitch, gameFrame);
    }

    // A matching active voice can still represent a seek/restart. That path
    // deliberately destroys it instead of suspending a stale position.
    if (voice) {
      const elapsed = (gameFrame - voice.gameFrame) * elapsedTicksPerFrame;
      const advanced = track.positionTicks - voice.positionTicks;
      // Host credit follows its independent audio clock and may arrive in
      // coarse batches (the web worklet reports about every 512 source
      // frames), so it cannot be compared with the reducer on every game
      // frame. Reducer position itself is exact: a live track advances for
      // every elapsed reference tick, or remains still while paused or
      // interrupted by ME. Anything else is a seek/load discontinuity.
      // Between two presentation syncs the host keeps the PREVIOUS reducer
      // gate. If a low-Hz reducer batch starts/stops ME, pauses, resumes or
      // restarts a same-id track mid-batch, its final position differs from
      // that old gate. Rebuild at the canonical final position in that case.
      // Equal positions are PCM-equivalent and need no generation token.
      const expectedAdvance = voice.reducerPlaying ? elapsed : 0;
      if (
        elapsed < 0 || advanced !== expectedAdvance ||
        (voice.finished && looping)
      ) {
        this.destroyVoice(voice);
        voice = undefined;
      }
    }

    if (!voice) {
      const asset = this.loadAsset(pakKey);
      if (!asset) return;
      const source = asset.open();
      const cursor = outputFrameAtTick(track.positionTicks, source.sampleRate);
      voice = this.createVoice(
        kind,
        track.id,
        pakKey,
        source,
        pitch,
        pan,
        looping,
        cursor,
        gameFrame,
        track.positionTicks,
      );
      if (!voice) return;
      this.persistent[kind] = voice;
    }

    voice.gameFrame = gameFrame;
    voice.positionTicks = track.positionTicks;
    voice.reducerPlaying = playing;

    const volume = clampVolume(audioTrackVolume(track));
    if (voice.volume !== volume) {
      voice.volume = volume;
      this.ops.setVolume(voice.handle, volume);
    }
    voice.desiredPlaying = playing && !voice.finished;
    if (!voice.desiredPlaying && voice.hostPlaying) {
      this.ops.pause(voice.handle);
      voice.hostPlaying = false;
    }
  }

  private startSe(cue: Readonly<SoundCue>): void {
    if ("stop" in cue) return; // a stop cue is handled by stopAllSe()
    const pakKey = this.resources[cue.name];
    if (!pakKey) return;
    const asset = this.loadAsset(pakKey);
    if (!asset) return;
    const voice = this.createVoice(
      "se",
      cue.name,
      pakKey,
      asset.open(),
      normalizedPitch(cue.pitch),
      normalizedPan(cue.pan),
      false,
      0,
    );
    if (!voice) return;
    const volume = clampVolume(cue.volume);
    voice.volume = volume;
    this.ops.setVolume(voice.handle, volume);
    voice.desiredPlaying = true;
  }

  /** Stop every live SE voice (RPG Maker Stop SE). Persistent BGM/BGS/ME
   *  voices are untouched. */
  private stopAllSe(): void {
    for (const voice of [...this.voices.values()]) {
      if (voice.kind === "se") this.destroyVoice(voice);
    }
  }

  private loadAsset(pakKey: string): AudioAsset | null {
    if (this.assetCache.has(pakKey)) return this.assetCache.get(pakKey)!;
    let asset: AudioAsset | null = null;
    try {
      const bytes = this.readResource(pakKey);
      if (pakKey.startsWith("audio:wav.")) {
        const decoded = decodeWav(bytes);
        if (decoded.frames > 0) asset = wavAsset(decoded);
      } else if (pakKey.startsWith("audio:qoa.")) {
        const file = new QoaFile(bytes);
        asset = { open: () => file.stream() };
      }
    } catch {
      // Optional audio must not turn a missing or malformed resource into a
      // gameplay failure. Cache the miss so it stays off the frame path.
    }
    this.assetCache.set(pakKey, asset);
    return asset;
  }

  private createVoice(
    kind: VoiceKind,
    id: string,
    pakKey: string,
    source: AudioSource,
    pitch: number,
    pan: number,
    looping: boolean,
    cursor: number,
    gameFrame = 0,
    positionTicks = 0,
  ): Voice | undefined {
    if (!this.makeRoom()) return undefined;
    let handle: number;
    try {
      handle = this.ops.createStream(source.sampleRate, pan === 0 ? source.channels : 2);
    } catch {
      return undefined;
    }
    if (!Number.isInteger(handle) || handle < 0) return undefined;
    const voice: Voice = {
      handle,
      kind,
      id,
      pakKey,
      source,
      pitch,
      pan,
      outputChannels: pan === 0 ? source.channels : 2,
      looping,
      serial: this.nextSerial++,
      cursor,
      gameFrame,
      positionTicks,
      free: AUDIO_RING_FRAMES,
      volume: -1,
      reducerPlaying: false,
      desiredPlaying: false,
      hostPlaying: false,
      endSent: false,
      finished: false,
    };
    this.voices.set(handle, voice);
    return voice;
  }

  /** Persistent tracks and new SE both evict only the oldest transient voice. */
  private makeRoom(): boolean {
    if (this.voices.size < MAX_STREAMS) return true;
    // A return candidate is an optimization, never a correctness resource.
    // Release it before evicting a live one-shot when all native slots are in
    // use.
    if (this.suspendedBgm) this.destroyVoice(this.suspendedBgm);
    if (this.voices.size < MAX_STREAMS) return true;
    let oldest: Voice | undefined;
    for (const voice of this.voices.values()) {
      if (voice.kind === "se" && (!oldest || voice.serial < oldest.serial)) oldest = voice;
    }
    if (!oldest) return false;
    this.destroyVoice(oldest);
    return true;
  }

  private pumpAll(): void {
    // Map insertion order makes write/play/end ordering deterministic.
    for (const voice of [...this.voices.values()]) {
      if (voice !== this.suspendedBgm) this.pumpVoice(voice);
    }
  }

  private pumpVoice(voice: Voice): void {
    if (voice.finished) return;
    const total = voice.looping ? Number.POSITIVE_INFINITY : oneShotOutputFrames(voice.source, voice.pitch);
    while (voice.free > 0 && voice.cursor < total) {
      const wanted = Math.min(voice.free, total - voice.cursor);
      const frames = Math.floor(wanted);
      if (frames <= 0) break;
      const data = this.renderFrames(voice, frames);
      const reported = this.ops.writePcm(voice.handle, data.buffer as ArrayBuffer);
      const accepted = Number.isFinite(reported)
        ? Math.max(0, Math.min(frames, Math.floor(reported)))
        : 0;
      if (accepted === 0) break;
      voice.cursor += accepted;
      voice.free -= accepted;
    }

    const queued = AUDIO_RING_FRAMES - voice.free;
    if (voice.desiredPlaying && !voice.hostPlaying && queued > 0) {
      this.ops.play(voice.handle);
      voice.hostPlaying = true;
    }
    if (!voice.looping && voice.cursor >= total && !voice.endSent) {
      voice.endSent = true;
      this.ops.endStream(voice.handle);
    }
  }

  private renderFrames(voice: Voice, frames: number): Int16Array {
    const channels = voice.outputChannels;
    const out = new Int16Array(frames * channels);
    if (voice.pan === 0 && voice.pitch === 100 && voice.source.readInto) {
      let outputFrame = 0;
      let sourceFrame = voice.looping ? voice.cursor % voice.source.frames : voice.cursor;
      while (outputFrame < frames) {
        const take = Math.min(frames - outputFrame, voice.source.frames - sourceFrame);
        voice.source.readInto(out, outputFrame, sourceFrame, take);
        outputFrame += take;
        sourceFrame += take;
        if (sourceFrame === voice.source.frames && voice.looping) sourceFrame = 0;
      }
      return out;
    }
    for (let output = 0; output < frames; output++) {
      let source = Math.floor((voice.cursor + output) * voice.pitch / 100);
      if (voice.looping) source %= voice.source.frames;
      if (voice.pan === 0) {
        for (let channel = 0; channel < channels; channel++) {
          out[output * channels + channel] = voice.source.sample(source, channel);
        }
      } else {
        // Centred PCM deliberately retains its legacy source shape above.
        // Nonzero pan follows PannerNode's normative equal-power mono/stereo
        // algorithms, including stereo crossfeed into the near channel.
        const azimuth = pannerAzimuth(voice.pan);
        const left = voice.source.sample(source, 0);
        if (voice.source.channels === 1) {
          const x = (azimuth + 90) / 180;
          const leftGain = Math.cos(x * Math.PI / 2);
          const rightGain = Math.sin(x * Math.PI / 2);
          out[output * 2] = pannedSample(left * leftGain);
          out[output * 2 + 1] = pannedSample(left * rightGain);
        } else {
          const right = voice.source.sample(source, 1);
          const x = azimuth <= 0 ? (azimuth + 90) / 90 : azimuth / 90;
          const leftGain = Math.cos(x * Math.PI / 2);
          const rightGain = Math.sin(x * Math.PI / 2);
          if (azimuth <= 0) {
            out[output * 2] = pannedSample(left + right * leftGain);
            out[output * 2 + 1] = pannedSample(right * rightGain);
          } else {
            out[output * 2] = pannedSample(left * leftGain);
            out[output * 2 + 1] = pannedSample(right + left * rightGain);
          }
        }
      }
    }
    return out;
  }

  private destroyVoice(voice: Voice): void {
    if (!this.voices.delete(voice.handle)) return;
    if (this.suspendedBgm === voice) this.suspendedBgm = undefined;
    if (voice.kind !== "se" && this.persistent[voice.kind] === voice) {
      delete this.persistent[voice.kind];
    }
    this.ops.destroyStream(voice.handle);
  }

  /** Pause, detach and retain at most one BGM. If a scene has already parked
   * its map track, later battle/result transitions are destroyed normally so
   * they cannot displace the return candidate. */
  private suspendBgm(voice: Voice): void {
    if (this.suspendedBgm && this.suspendedBgm !== voice) {
      this.destroyVoice(voice);
      return;
    }
    if (this.persistent.bgm === voice) delete this.persistent.bgm;
    voice.desiredPlaying = false;
    voice.reducerPlaying = false;
    if (voice.hostPlaying) {
      this.ops.pause(voice.handle);
      voice.hostPlaying = false;
    }
    this.suspendedBgm = voice;
  }

  /** Reattach an exact-position return candidate. A same-track request at a
   * different position is a real restart/seek, so discard the stale native
   * ring and let the ordinary creation path rebuild it. */
  private takeSuspendedBgm(
    track: Readonly<AudioTrackState | AudioMeState>,
    pakKey: string,
    pitch: number,
    gameFrame: number,
  ): Voice | undefined {
    const voice = this.suspendedBgm;
    if (!voice) return undefined;
    const sameIdentity = voice.id === track.id && voice.pakKey === pakKey && voice.pitch === pitch;
    if (!sameIdentity) return undefined;
    if (voice.finished || voice.positionTicks !== track.positionTicks) {
      this.destroyVoice(voice);
      return undefined;
    }
    this.suspendedBgm = undefined;
    this.persistent.bgm = voice;
    // The reducer clock advanced while the scene owned BGM. Rebase the
    // presentation comparison at the restore boundary; the queued PCM and
    // native play head remained paused at this same reducer position.
    voice.gameFrame = gameFrame;
    voice.reducerPlaying = false;
    return voice;
  }

  private destroyAll(): void {
    for (const voice of [...this.voices.values()]) this.destroyVoice(voice);
  }
}

export function createAudioDriver(
  ops: AudioOps,
  resources: Readonly<Record<string, string>>,
  readResource: AudioResourceReader = pakGet,
  referenceTicksPerFrame = 1,
): AudioDriver {
  return new AudioDriver(ops, resources, readResource, referenceTicksPerFrame);
}
