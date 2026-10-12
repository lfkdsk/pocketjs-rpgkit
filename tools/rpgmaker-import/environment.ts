// Host boundary for RPG Maker import conversion. The conversion core only
// sees portable paths, decoded RGBA images and explicit audio results; Node
// filesystem/ffmpeg and browser DirectoryHandle/canvas adapters implement it.

import {
  RPGMAKER_AUDIO_KINDS,
  audioMediaKey,
  type AudioMediaOptions,
  type AudioMediaRecord,
  type AudioMediaRequest,
} from "./audio-types.ts";
import type { RgbaImage } from "./image.ts";
import type { RpgMakerMediaEncryption } from "./media-crypto.ts";

export interface RpgMakerImportEnvironment {
  join(...parts: string[]): string;
  exists(path: string): boolean;
  /** File names directly inside a directory, in deterministic order. */
  list(path: string): readonly string[];
  readPng(path: string, encryption?: RpgMakerMediaEncryption): Promise<RgbaImage>;
  readMedia(path: string, encryption?: RpgMakerMediaEncryption, kind?: "image" | "audio"): Promise<Uint8Array>;
  convertAudio(
    projectRoot: string,
    requests: Iterable<AudioMediaRequest>,
    options?: AudioMediaOptions,
  ): Promise<AudioMediaRecord[]> | AudioMediaRecord[];
}

const KIND_ORDER = new Map(RPGMAKER_AUDIO_KINDS.map((kind, index) => [kind, index]));
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Stable missing records for hosts that cannot decode/encode source audio. */
export function unavailableAudioRecords(requests: Iterable<AudioMediaRequest>, reason: string): AudioMediaRecord[] {
  const unique = new Map<string, AudioMediaRequest>();
  for (const request of requests) {
    if (!request.name) continue;
    unique.set(audioMediaKey(request.kind, request.name), request);
  }
  return [...unique.values()].sort((a, b) =>
    KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.name, b.name),
  ).map((request) => ({
    ...request,
    key: audioMediaKey(request.kind, request.name),
    sourceBytes: 0,
    outputBytes: 0,
    status: "missing" as const,
    reason,
  }));
}

/** Synthetic projects in unit tests have no host filesystem. */
export const EMPTY_RPGMAKER_IMPORT_ENVIRONMENT: RpgMakerImportEnvironment = {
  join: (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/"),
  exists: () => false,
  list: () => [],
  async readPng(path) {
    throw new Error(`rpgmaker-import: no media environment can read ${path}`);
  },
  async readMedia(path) {
    throw new Error(`rpgmaker-import: no media environment can read ${path}`);
  },
  convertAudio: (_root, requests) => unavailableAudioRecords(requests, "audio conversion is unavailable in this import environment"),
};
