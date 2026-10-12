// tools/rpgmaker-import/audio-media.ts — deterministic MV/MZ audio discovery
// and conversion. The importer supplies the logical names it references; this
// module resolves the matching audio/<kind> file and returns QOA bytes plus the
// decoded-media facts needed for coverage and ME duration calculation.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodeQoa } from "../lib/qoa.ts";
import {
  encryptedRpgMakerAudioFormat,
  readRpgMakerMedia,
} from "./media.ts";
import type { RpgMakerMediaEncryption } from "./media-crypto.ts";
import {
  RPGMAKER_AUDIO_KINDS,
  audioMediaKey,
  type AudioMediaChannels,
  type AudioMediaOptions,
  type AudioMediaRecord,
  type AudioMediaRequest,
  type AudioMediaSampleRate,
  type RpgMakerAudioKind,
} from "./audio-types.ts";

export {
  RPGMAKER_AUDIO_KINDS,
  audioMediaKey,
  type AudioMediaChannels,
  type AudioMediaCorrupt,
  type AudioMediaMissing,
  type AudioMediaOptions,
  type AudioMediaRecord,
  type AudioMediaRequest,
  type AudioMediaSampleRate,
  type AudioMediaSuccess,
  type RpgMakerAudioKind,
} from "./audio-types.ts";

interface Candidate {
  filename: string;
  format: "ogg" | "m4a";
  path: string;
  relativePath: string;
  encrypted: boolean;
}

const KIND_ORDER = new Map<RpgMakerAudioKind, number>(
  RPGMAKER_AUDIO_KINDS.map((kind, index) => [kind, index]),
);
const FORMAT_ORDER: Readonly<Record<Candidate["format"], number>> = { ogg: 0, m4a: 1 };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRequests(a: AudioMediaRequest, b: AudioMediaRequest): number {
  return KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
    compareText(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareText(a.name, b.name);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return FORMAT_ORDER[a.format] - FORMAT_ORDER[b.format] ||
    compareText(a.filename.toLowerCase(), b.filename.toLowerCase()) ||
    compareText(a.filename, b.filename);
}

function candidatesIn(
  projectRoot: string,
  kind: RpgMakerAudioKind,
  encryption?: RpgMakerMediaEncryption,
): Map<string, Candidate[]> {
  const directory = join(projectRoot, "audio", kind);
  const byName = new Map<string, Candidate[]>();
  if (!existsSync(directory)) return byName;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const encryptedFormat = encryption?.audio ? encryptedRpgMakerAudioFormat(entry.name) : null;
    const plainFormat = lower.endsWith(".ogg") ? "ogg" : lower.endsWith(".m4a") ? "m4a" : null;
    const format = plainFormat ?? encryptedFormat;
    if (!format) continue;
    const suffixLength = plainFormat ? 4 : lower.endsWith(".rpgmvo") || lower.endsWith(".rpgmvm") ? 7 : 5;
    const name = entry.name.slice(0, -suffixLength);
    const key = name.toLowerCase();
    const candidates = byName.get(key) ?? [];
    candidates.push({
      filename: entry.name,
      format,
      path: join(directory, entry.name),
      relativePath: `audio/${kind}/${entry.name}`,
      encrypted: encryptedFormat !== null,
    });
    byName.set(key, candidates);
  }
  for (const candidates of byName.values()) candidates.sort(compareCandidates);
  return byName;
}

function decodeError(stderr: Uint8Array, sourcePath: string, exitCode: number): string {
  const text = new TextDecoder().decode(stderr).replaceAll(sourcePath, "<source>");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const detail = lines.at(-1) ?? `ffmpeg exited with status ${exitCode}`;
  return `ffmpeg decode failed: ${detail.slice(0, 320)}`;
}

function pcmSamples(bytes: Uint8Array): Int16Array | null {
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return samples;
}

function convertCandidate(
  request: AudioMediaRequest,
  candidate: Candidate,
  sourceBytes: number,
  ffmpeg: string,
  sampleRate: AudioMediaSampleRate,
  channels: AudioMediaChannels,
  encryption?: RpgMakerMediaEncryption,
): AudioMediaRecord {
  let decoded: ReturnType<typeof Bun.spawnSync>;
  try {
    const input = candidate.encrypted ? readRpgMakerMedia(candidate.path, encryption, "audio") : null;
    decoded = Bun.spawnSync({
      cmd: [
        ffmpeg,
        "-v", "error",
        "-nostdin",
        "-i", input ? "pipe:0" : candidate.path,
        "-map", "0:a:0",
        "-vn", "-sn", "-dn",
        "-ac", String(channels),
        "-ar", String(sampleRate),
        "-acodec", "pcm_s16le",
        "-f", "s16le",
        "pipe:1",
      ],
      stdin: input ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(`rpgmaker audio: could not run ${JSON.stringify(ffmpeg)} (${(error as Error).message})`);
  }

  const base = {
    ...request,
    key: audioMediaKey(request.kind, request.name),
    sourcePath: candidate.relativePath,
    sourceFormat: candidate.format,
    sourceBytes,
  } as const;
  if (!decoded.success) {
    return {
      ...base,
      status: "corrupt",
      outputBytes: 0,
      reason: decodeError(decoded.stderr ?? new Uint8Array(), candidate.path, decoded.exitCode),
    };
  }

  const samples = pcmSamples(decoded.stdout ?? new Uint8Array());
  if (!samples || samples.length % channels !== 0) {
    return {
      ...base,
      status: "corrupt",
      outputBytes: 0,
      reason: samples ? "ffmpeg decoded a partial PCM frame" : "ffmpeg decoded no complete PCM samples",
    };
  }

  const frames = samples.length / channels;
  const qoaBytes = encodeQoa(samples, channels, sampleRate);
  return {
    ...base,
    status: "success",
    outputBytes: qoaBytes.byteLength,
    channels,
    sampleRate,
    frames,
    durationTicks: Math.ceil(frames * 60 / sampleRate),
    qoaBytes,
  };
}

/**
 * Resolve and transcode the requested MV/MZ audio names. Requests are
 * deduplicated case-insensitively and records are returned in kind/name order.
 * When both deployment formats exist, Ogg is selected before M4A; a corrupt
 * preferred Ogg is reported as corrupt rather than silently changing source.
 */
export function convertRpgMakerAudioMedia(
  projectRoot: string,
  requests: Iterable<AudioMediaRequest>,
  options: AudioMediaOptions = {},
): AudioMediaRecord[] {
  const sampleRate = options.sampleRate ?? 44_100;
  const channels = options.channels ?? 2;
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const encryption = options.encryption;
  if (sampleRate !== 11_025 && sampleRate !== 22_050 && sampleRate !== 44_100) {
    throw new Error(`rpgmaker audio: unsupported sample rate ${sampleRate}`);
  }
  if (channels !== 1 && channels !== 2) {
    throw new Error(`rpgmaker audio: unsupported channel count ${channels}`);
  }

  const sorted = [...requests].sort(compareRequests);
  const unique: AudioMediaRequest[] = [];
  const seen = new Set<string>();
  for (const request of sorted) {
    if (!KIND_ORDER.has(request.kind)) {
      throw new Error(`rpgmaker audio: unknown kind ${JSON.stringify(request.kind)}`);
    }
    const key = audioMediaKey(request.kind, request.name);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({ kind: request.kind, name: request.name });
    }
  }

  const indexes = new Map(
    RPGMAKER_AUDIO_KINDS.map((kind) => [kind, candidatesIn(projectRoot, kind, encryption)]),
  );
  return unique.map((request): AudioMediaRecord => {
    const candidate = indexes.get(request.kind)!.get(request.name.toLowerCase())?.[0];
    if (!candidate) {
      return {
        ...request,
        key: audioMediaKey(request.kind, request.name),
        status: "missing",
        sourceBytes: 0,
        outputBytes: 0,
        reason: `audio/${request.kind}/${request.name}.ogg or .m4a was not found`,
      };
    }
    const sourceBytes = statSync(candidate.path).size;
    return convertCandidate(request, candidate, sourceBytes, ffmpeg, sampleRate, channels, encryption);
  });
}

