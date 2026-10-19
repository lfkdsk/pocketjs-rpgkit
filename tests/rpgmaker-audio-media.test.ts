import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { QoaFile } from "../src/ui/audio/qoa.ts";
import {
  convertRpgMakerAudioMedia,
  type AudioMediaSuccess,
  type RpgMakerAudioKind,
} from "../tools/rpgmaker-import/audio-media.ts";
import { decodeOggVorbisPcm } from "../tools/rpgmaker-import/ogg-decode.ts";

const FFMPEG = Bun.which("ffmpeg");
if (!FFMPEG) throw new Error("rpgmaker-audio-media tests require ffmpeg on PATH");
const SCRATCH_ROOT = "/var/tmp/fleet/4306";
const PARITY_OGG = join(import.meta.dir, "fixtures", "rpgmaker", "hollow-mz", "audio", "bgm", "hollow-map.ogg");
mkdirSync(SCRATCH_ROOT, { recursive: true });

const DEPLOYMENT_HEADER = Uint8Array.of(
  0x52, 0x50, 0x47, 0x4d, 0x56, 0x00, 0x00, 0x00,
  0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
);

function encryptedMedia(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(DEPLOYMENT_HEADER.length + bytes.length);
  out.set(DEPLOYMENT_HEADER);
  out.set(bytes, DEPLOYMENT_HEADER.length);
  for (let index = 0; index < Math.min(16, bytes.length); index++) out[DEPLOYMENT_HEADER.length + index] ^= key[index]!;
  return out;
}

function pcm(frames: number, frequency: number, sampleRate = 22_050): Uint8Array {
  const bytes = new Uint8Array(frames * 2);
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * frame / sampleRate) * 24_000);
    view.setInt16(frame * 2, sample, true);
  }
  return bytes;
}

function generateMedia(
  root: string,
  kind: RpgMakerAudioKind,
  filename: string,
  frequency: number,
): string {
  const directory = join(root, "audio", kind);
  mkdirSync(directory, { recursive: true });
  const raw = join(directory, `${filename}.s16le`);
  const output = join(directory, filename);
  writeFileSync(raw, pcm(2_205, frequency));
  const ogg = filename.toLowerCase().endsWith(".ogg");
  const proc = Bun.spawnSync({
    cmd: [
      FFMPEG!,
      "-y", "-v", "error", "-nostdin",
      "-f", "s16le", "-ar", "22050", "-ac", "1", "-i", raw,
      "-map_metadata", "-1",
      ...(ogg
        ? ["-ac", "2", "-c:a", "vorbis", "-strict", "experimental"]
        : ["-c:a", "aac", "-b:a", "64k"]),
      output,
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!proc.success) {
    throw new Error(`test media generation failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
  return output;
}

function success(record: Awaited<ReturnType<typeof convertRpgMakerAudioMedia>>[number]): AudioMediaSuccess {
  if (record.status !== "success") throw new Error(`expected success, got ${record.status}`);
  return record;
}

describe("RPG Maker audio media conversion", () => {
  test("keeps bundled Ogg PCM within the pinned ffmpeg tolerance", async () => {
    const reference = Bun.spawnSync({
      cmd: [
        FFMPEG!,
        "-v", "error", "-nostdin", "-i", PARITY_OGG,
        "-map", "0:a:0", "-vn", "-sn", "-dn",
        "-ac", "1", "-ar", "11025", "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1",
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(reference.success).toBe(true);
    const expectedBytes = reference.stdout ?? new Uint8Array();
    const expectedView = new DataView(expectedBytes.buffer, expectedBytes.byteOffset, expectedBytes.byteLength);
    const expected = new Int16Array(expectedBytes.byteLength / 2);
    for (let index = 0; index < expected.length; index++) expected[index] = expectedView.getInt16(index * 2, true);
    const actual = await decodeOggVorbisPcm(new Uint8Array(readFileSync(PARITY_OGG)), 11_025, 1);
    expect(actual).toHaveLength(expected.length);

    let signal = 0;
    let noise = 0;
    let maxDifference = 0;
    for (let index = 0; index < actual.length; index++) {
      const difference = actual[index]! - expected[index]!;
      signal += expected[index]! * expected[index]!;
      noise += difference * difference;
      maxDifference = Math.max(maxDifference, Math.abs(difference));
    }
    const snrDb = 10 * Math.log10(signal / noise);
    expect(maxDifference).toBeLessThanOrEqual(64);
    expect(snrDb).toBeGreaterThanOrEqual(60);
  }, 20_000);

  test("decrypts MZ deployment audio before deterministic conversion", async () => {
    const root = mkdtempSync(join(SCRATCH_ROOT, "rpgmaker-audio-encrypted-"));
    try {
      const plainPath = generateMedia(root, "se", "Bell.ogg", 550);
      const plain = new Uint8Array(readFileSync(plainPath));
      const key = Uint8Array.from({ length: 16 }, (_, index) => index * 11);
      const encryptedPath = `${plainPath}_`;
      writeFileSync(encryptedPath, encryptedMedia(plain, key));
      rmSync(plainPath);

      const records = await convertRpgMakerAudioMedia(root, [{ kind: "se", name: "bell" }], {
        sampleRate: 11_025,
        channels: 1,
        encryption: { key, images: false, audio: true },
      });
      const bell = success(records[0]!);
      expect(bell.sourcePath).toBe("audio/se/Bell.ogg_");
      expect(bell.sourceFormat).toBe("ogg");
      expect(bell.sourceBytes).toBe(statSync(encryptedPath).size);
      expect(new QoaFile(bell.qoaBytes)).toMatchObject({ channels: 1, sampleRate: 11_025 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("matches names case-insensitively, prefers Ogg, deduplicates, and is byte-stable", async () => {
    const root = mkdtempSync(join(SCRATCH_ROOT, "rpgmaker-audio-media-"));
    try {
      generateMedia(root, "bgm", "Theme.M4A", 330);
      const ogg = generateMedia(root, "bgm", "tHeMe.OGG", 660);
      const bgs = generateMedia(root, "bgs", "Rain.m4a", 110);
      const requests = [
        { kind: "se" as const, name: "Absent" },
        { kind: "bgm" as const, name: "theme" },
        { kind: "bgs" as const, name: "RAIN" },
        { kind: "bgm" as const, name: "THEME" },
      ];
      const options = { sampleRate: 11_025 as const, channels: 1 as const };

      const first = await convertRpgMakerAudioMedia(root, requests, options);
      const second = await convertRpgMakerAudioMedia(root, [...requests].reverse(), options);
      expect(second).toEqual(first);
      expect(first.map((record) => [record.key, record.status])).toEqual([
        ["bgm/theme", "success"],
        ["bgs/rain", "success"],
        ["se/absent", "missing"],
      ]);

      const theme = success(first[0]!);
      expect(theme.name).toBe("THEME");
      expect(theme.sourcePath).toBe("audio/bgm/tHeMe.OGG");
      expect(theme.sourceFormat).toBe("ogg");
      expect(theme.sourceBytes).toBe(statSync(ogg).size);
      expect(theme.outputBytes).toBe(theme.qoaBytes.byteLength);
      expect(theme).toMatchObject({ channels: 1, sampleRate: 11_025 });
      expect(theme.frames).toBeGreaterThan(0);
      expect(theme.durationTicks).toBe(Math.ceil(theme.frames * 60 / theme.sampleRate));

      const parsed = new QoaFile(theme.qoaBytes);
      expect({ channels: parsed.channels, sampleRate: parsed.sampleRate, frames: parsed.frames }).toEqual({
        channels: theme.channels,
        sampleRate: theme.sampleRate,
        frames: theme.frames,
      });

      const rain = success(first[1]!);
      expect(rain.sourcePath).toBe("audio/bgs/Rain.m4a");
      expect(rain.sourceBytes).toBe(statSync(bgs).size);

      const defaultRain = success((await convertRpgMakerAudioMedia(root, [{ kind: "bgs", name: "rain" }]))[0]!);
      expect(defaultRain).toMatchObject({ channels: 2, sampleRate: 44_100 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("reports corrupt preferred media and does not fall back to M4A", async () => {
    const root = mkdtempSync(join(SCRATCH_ROOT, "rpgmaker-audio-corrupt-"));
    try {
      generateMedia(root, "me", "Fanfare.m4a", 440);
      const directory = join(root, "audio", "me");
      const bad = join(directory, "fAnFaRe.OgG");
      const contents = new TextEncoder().encode("not an ogg stream\n");
      writeFileSync(bad, contents);

      const first = await convertRpgMakerAudioMedia(root, [{ kind: "me", name: "FANFARE" }]);
      const second = await convertRpgMakerAudioMedia(root, [{ kind: "me", name: "fanfare" }]);
      expect(first).toHaveLength(1);
      const firstRecord = first[0]!;
      const secondRecord = second[0]!;
      expect(firstRecord).toMatchObject({
        status: "corrupt",
        key: "me/fanfare",
        sourcePath: "audio/me/fAnFaRe.OgG",
        sourceFormat: "ogg",
        sourceBytes: contents.byteLength,
        outputBytes: 0,
      });
      if (firstRecord.status !== "corrupt" || secondRecord.status !== "corrupt") {
        throw new Error("expected corrupt conversion records");
      }
      expect(firstRecord.reason).toContain("ffmpeg decode failed:");
      expect(secondRecord.reason).toBe(firstRecord.reason);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("reports missing names with stable zero-byte accounting", async () => {
    const root = mkdtempSync(join(SCRATCH_ROOT, "rpgmaker-audio-missing-"));
    try {
      mkdirSync(join(root, "audio", "se"), { recursive: true });
      writeFileSync(join(root, "audio", "se", "Bell.wav"), pcm(20, 220));
      const records = await convertRpgMakerAudioMedia(root, [
        { kind: "se", name: "Bell" },
        { kind: "bgm", name: "Field" },
      ]);
      expect(records).toEqual([
        {
          kind: "bgm",
          name: "Field",
          key: "bgm/field",
          status: "missing",
          sourceBytes: 0,
          outputBytes: 0,
          reason: "audio/bgm/Field.ogg or .m4a was not found",
        },
        {
          kind: "se",
          name: "Bell",
          key: "se/bell",
          status: "missing",
          sourceBytes: 0,
          outputBytes: 0,
          reason: "audio/se/Bell.ogg or .m4a was not found",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

