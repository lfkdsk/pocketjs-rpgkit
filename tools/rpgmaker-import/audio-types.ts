// Browser-safe audio request/result contract. The Node/Bun adapter prefers
// ffmpeg and has a bundled Ogg fallback; browser environments return explicit
// missing records because Studio packs currently carry PNG assets only.

import type { RpgMakerMediaEncryption } from "./media-crypto.ts";

export const RPGMAKER_AUDIO_KINDS = ["bgm", "bgs", "me", "se"] as const;
export type RpgMakerAudioKind = typeof RPGMAKER_AUDIO_KINDS[number];
export type AudioMediaSampleRate = 11_025 | 22_050 | 44_100;
export type AudioMediaChannels = 1 | 2;

export interface AudioMediaRequest {
  kind: RpgMakerAudioKind;
  /** RPG Maker's extension-free audio name. Matching is case-insensitive. */
  name: string;
}

interface AudioMediaRecordBase extends AudioMediaRequest {
  /** Stable, case-insensitive lookup key for joining records to commands. */
  key: string;
  sourceBytes: number;
  outputBytes: number;
}

export interface AudioMediaSuccess extends AudioMediaRecordBase {
  status: "success";
  sourcePath: string;
  sourceFormat: "ogg" | "m4a";
  channels: AudioMediaChannels;
  sampleRate: AudioMediaSampleRate;
  frames: number;
  durationTicks: number;
  qoaBytes: Uint8Array;
}

export interface AudioMediaMissing extends AudioMediaRecordBase {
  status: "missing";
  reason: string;
}

export interface AudioMediaCorrupt extends AudioMediaRecordBase {
  status: "corrupt";
  sourcePath: string;
  sourceFormat: "ogg" | "m4a";
  reason: string;
}

export type AudioMediaRecord = AudioMediaSuccess | AudioMediaMissing | AudioMediaCorrupt;

export interface AudioMediaOptions {
  ffmpeg?: string;
  sampleRate?: AudioMediaSampleRate;
  channels?: AudioMediaChannels;
  encryption?: RpgMakerMediaEncryption;
}

/** The key used by both requests and records. */
export function audioMediaKey(kind: RpgMakerAudioKind, name: string): string {
  return `${kind}/${name.toLowerCase()}`;
}
