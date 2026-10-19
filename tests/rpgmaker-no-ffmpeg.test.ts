import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { QoaFile } from "../src/ui/audio/qoa.ts";
import { convertRpgMakerAudioMedia } from "../tools/rpgmaker-import/audio-media.ts";

const SCRATCH = join(import.meta.dir, `.rpgmaker-no-ffmpeg-${process.pid}`);
const OGG = join(import.meta.dir, "fixtures", "rpgmaker", "hollow-mz", "audio", "bgm", "hollow-map.ogg");
const DEPLOYMENT_HEADER = Uint8Array.of(
  0x52, 0x50, 0x47, 0x4d, 0x56, 0x00, 0x00, 0x00,
  0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
);

beforeAll(() => mkdirSync(SCRATCH, { recursive: true }));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

function root(name: string): string {
  return mkdtempSync(join(SCRATCH, `${name}-`));
}

function missingFfmpeg(projectRoot: string): string {
  return join(projectRoot, "decoder-that-does-not-exist");
}

function encrypt(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  const encrypted = new Uint8Array(DEPLOYMENT_HEADER.length + bytes.length);
  encrypted.set(DEPLOYMENT_HEADER);
  encrypted.set(bytes, DEPLOYMENT_HEADER.length);
  for (let index = 0; index < Math.min(16, bytes.length); index++) {
    encrypted[DEPLOYMENT_HEADER.length + index] ^= key[index]!;
  }
  return encrypted;
}

describe("RPG Maker import without a system ffmpeg", () => {
  test("uses the bundled Ogg decoder deterministically", async () => {
    const project = root("ogg");
    try {
      const directory = join(project, "audio", "bgm");
      mkdirSync(directory, { recursive: true });
      copyFileSync(OGG, join(directory, "Theme.ogg"));
      const options = { ffmpeg: missingFfmpeg(project), sampleRate: 11_025 as const, channels: 1 as const };

      const first = await convertRpgMakerAudioMedia(project, [{ kind: "bgm", name: "theme" }], options);
      const second = await convertRpgMakerAudioMedia(project, [{ kind: "bgm", name: "THEME" }], options);
      expect(first).toHaveLength(1);
      expect(first[0]?.status).toBe("success");
      expect(second[0]?.status).toBe("success");
      if (first[0]?.status !== "success" || second[0]?.status !== "success") {
        throw new Error("bundled Ogg conversion did not succeed");
      }
      expect(first[0].qoaBytes).toEqual(second[0].qoaBytes);
      expect(first[0]).toMatchObject({
        sourcePath: "audio/bgm/Theme.ogg",
        sourceFormat: "ogg",
        channels: 1,
        sampleRate: 11_025,
        frames: 22_080,
      });
      expect(new QoaFile(first[0].qoaBytes)).toMatchObject({ channels: 1, sampleRate: 11_025, frames: 22_080 });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("decrypts deployment Ogg before using the bundled decoder", async () => {
    const project = root("encrypted");
    try {
      const directory = join(project, "audio", "se");
      mkdirSync(directory, { recursive: true });
      const key = Uint8Array.from({ length: 16 }, (_, index) => index * 13);
      writeFileSync(join(directory, "Bell.ogg_"), encrypt(new Uint8Array(readFileSync(OGG)), key));

      const records = await convertRpgMakerAudioMedia(project, [{ kind: "se", name: "bell" }], {
        ffmpeg: missingFfmpeg(project),
        encryption: { key, images: false, audio: true },
      });
      expect(records[0]?.status).toBe("success");
      if (records[0]?.status !== "success") throw new Error("encrypted Ogg conversion did not succeed");
      expect(records[0]).toMatchObject({ sourcePath: "audio/se/Bell.ogg_", sourceFormat: "ogg" });
      expect(new QoaFile(records[0].qoaBytes)).toMatchObject({ channels: 2, sampleRate: 44_100 });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("omits undecodable Ogg and M4A per file with actionable bilingual reasons", async () => {
    const project = root("unsupported");
    try {
      mkdirSync(join(project, "audio", "me"), { recursive: true });
      mkdirSync(join(project, "audio", "bgs"), { recursive: true });
      writeFileSync(join(project, "audio", "me", "Broken.ogg"), "not an Ogg stream\n");
      // A present M4A candidate is enough to exercise decoder selection: with
      // no ffmpeg it must be reported, not opened or allowed to abort import.
      writeFileSync(join(project, "audio", "bgs", "Rain.m4a"), Uint8Array.of(
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
      ));

      const records = await convertRpgMakerAudioMedia(project, [
        { kind: "me", name: "broken" },
        { kind: "bgs", name: "rain" },
      ], { ffmpeg: missingFfmpeg(project) });
      expect(records.map((record) => [record.key, record.status, record.outputBytes])).toEqual([
        ["bgs/rain", "corrupt", 0],
        ["me/broken", "corrupt", 0],
      ]);
      for (const record of records) {
        if (record.status !== "corrupt") throw new Error("expected an omitted present audio record");
        expect(record.reason).toContain("audio decoder unavailable");
        expect(record.reason).toContain("音频解码器不可用");
        expect(record.reason).toContain("ffmpeg");
        expect(record.reason).toContain("PATH");
      }
      expect(records[0]).toMatchObject({ sourcePath: "audio/bgs/Rain.m4a", sourceFormat: "m4a", sourceBytes: 12 });
      if (records[0]?.status === "corrupt") {
        expect(records[0].reason).toContain("built-in decoder supports Ogg Vorbis only");
        expect(records[0].reason).toContain("内置解码器仅支持 Ogg Vorbis");
      }
      expect(records[1]).toMatchObject({ sourcePath: "audio/me/Broken.ogg", sourceFormat: "ogg", sourceBytes: 18 });
      if (records[1]?.status === "corrupt") expect(records[1].reason).toContain("fallback failed");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
