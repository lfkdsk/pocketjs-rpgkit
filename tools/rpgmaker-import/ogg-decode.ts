// Permissively licensed, host-independent Ogg Vorbis fallback used only when
// the normal ffmpeg process cannot be started. stb-vorbis embeds its Wasm in
// one module, so a compiled Studio helper does not need a sidecar binary.

import type {
  AudioMediaChannels,
  AudioMediaSampleRate,
} from "./audio-types.ts";

type Decoder = typeof import("stb-vorbis")["StbVorbis"];

let decoderPromise: Promise<Decoder> | undefined;

async function decoder(): Promise<Decoder> {
  decoderPromise ??= import("stb-vorbis").then(async ({ StbVorbis }) => {
    await StbVorbis.ready;
    return StbVorbis;
  });
  return decoderPromise;
}

function s16(sample: number): number {
  const scaled = Math.round(sample * 32_768);
  return scaled < -32_768 ? -32_768 : scaled > 32_767 ? 32_767 : scaled;
}

function mixedSample(
  source: readonly Float32Array[],
  frame: number,
  channel: number,
  outputChannels: AudioMediaChannels,
): number {
  if (source.length === 1) return source[0]![frame]!;
  if (outputChannels === 1) return (source[0]![frame]! + source[1]![frame]!) * 0.5;
  return source[channel]![frame]!;
}

/**
 * Decode one complete Ogg Vorbis stream and produce the same interleaved
 * signed-16 layout consumed by the QOA encoder. A short Hann-windowed sinc
 * keeps downsampling band-limited while remaining deterministic in Bun and
 * the compiled Studio helper.
 */
export async function decodeOggVorbisPcm(
  bytes: Uint8Array,
  sampleRate: AudioMediaSampleRate,
  channels: AudioMediaChannels,
): Promise<Int16Array> {
  const decoded = (await decoder()).decode(bytes);
  const source = decoded.channels;
  const sourceRate = decoded.sampleRate;
  if (!Number.isInteger(sourceRate) || sourceRate <= 0) {
    throw new Error(`invalid source sample rate ${sourceRate}`);
  }
  if (source.length !== 1 && source.length !== 2) {
    throw new Error(`unsupported source channel count ${source.length}; expected mono or stereo`);
  }
  const sourceFrames = source[0]!.length;
  if (sourceFrames === 0 || source.some((channel) => channel.length !== sourceFrames)) {
    throw new Error("decoder returned empty or uneven channels");
  }
  for (const channel of source) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error("decoder returned a non-finite PCM sample");
    }
  }

  if (sourceRate === sampleRate) {
    const pcm = new Int16Array(sourceFrames * channels);
    for (let frame = 0; frame < sourceFrames; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        pcm[frame * channels + channel] = s16(mixedSample(source, frame, channel, channels));
      }
    }
    return pcm;
  }

  const outputFrames = Math.max(1, Math.round(sourceFrames * sampleRate / sourceRate));
  const pcm = new Int16Array(outputFrames * channels);
  const radius = 8;
  // Leave a narrow transition band before the new Nyquist limit. The factor
  // was compared against ffmpeg's swresample path on the repository tones.
  const cutoff = Math.min(1, sampleRate / sourceRate) * 0.97;
  for (let frame = 0; frame < outputFrames; frame++) {
    const position = frame * sourceRate / sampleRate;
    const centre = Math.floor(position);
    const first = Math.max(0, centre - radius + 1);
    const last = Math.min(sourceFrames - 1, centre + radius);
    let norm = 0;
    let left = 0;
    let right = 0;
    for (let input = first; input <= last; input++) {
      const distance = position - input;
      const absolute = Math.abs(distance);
      const sinc = absolute < 1e-12
        ? 1
        : Math.sin(Math.PI * distance * cutoff) / (Math.PI * distance * cutoff);
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
      const weight = cutoff * sinc * window;
      norm += weight;
      left += mixedSample(source, input, 0, channels) * weight;
      if (channels === 2) right += mixedSample(source, input, 1, channels) * weight;
    }
    if (!Number.isFinite(norm) || Math.abs(norm) < 1e-12) {
      throw new Error("resampler produced an invalid normalization weight");
    }
    pcm[frame * channels] = s16(left / norm);
    if (channels === 2) pcm[frame * channels + 1] = s16(right / norm);
  }
  return pcm;
}
