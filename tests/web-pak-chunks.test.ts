import { describe, expect, test } from "bun:test";
import { pack } from "../vendor/pocketjs/framework/compiler/pak.ts";
import {
  openPakChunkLoader,
  parsePakChunkManifest,
} from "../tools/web/pak-chunks.js";

const HASH = "1".repeat(64);
const OTHER_HASH = "2".repeat(64);
const exact = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function asset(hash: string, bytes: Uint8Array, stem: string) {
  return {
    file: `${stem}-${hash}.pak.gz`,
    encoding: "gzip",
    bytes: bytes.byteLength,
    unpackedBytes: bytes.byteLength,
    sha256: hash,
  } as const;
}

function response(body: BodyInit, init?: ResponseInit): Response {
  return new Response(body, init);
}

describe("Web pak chunk manifest", () => {
  test("requires content-addressed assets and one owner per deferred entry", () => {
    const bytes = new Uint8Array([1]);
    const valid = {
      version: 1,
      format: "pocket-pak-chunks/v1",
      startup: asset(HASH, bytes, "startup"),
      chunks: [{
        id: "maps",
        ...asset(OTHER_HASH, bytes, "maps"),
        entries: ["maps/a"],
        background: true,
      }],
    };
    const parsed = parsePakChunkManifest(valid);
    expect(parsed.format).toBe("pocket-pak-chunks/v1");
    expect(parsed.startup).toEqual(valid.startup);
    expect(parsed.chunks).toEqual(valid.chunks);
    expect(() => parsePakChunkManifest({
      ...valid,
      startup: { ...valid.startup, file: "startup.pak.gz" },
    })).toThrow(/file must contain its SHA-256/);
    expect(() => parsePakChunkManifest({
      ...valid,
      chunks: [valid.chunks[0], { ...valid.chunks[0], id: "again" }],
    })).toThrow(/entry maps\/a belongs to both maps and again/);
  });
});

describe("Web pak chunk loader", () => {
  test("keeps reads synchronous, blocks only prepare, and starts background work explicitly", async () => {
    const startup = new Uint8Array([9, 8, 7]);
    const maps = pack([
      { key: "maps/a", dtype: 0, data: new Uint8Array([1, 2, 3, 4]) },
    ]);
    const audio = pack([
      { key: "music/theme", dtype: 0, data: new Uint8Array([5, 6]) },
    ]);
    const manifest = {
      version: 1,
      format: "pocket-pak-chunks/v1",
      startup: asset(HASH, startup, "startup"),
      chunks: [
        { id: "maps", ...asset(HASH, maps, "maps"), entries: ["maps/a"] },
        { id: "audio", ...asset(HASH, audio, "audio"), entries: ["music/theme"], background: true },
      ],
    };
    let releaseMaps!: () => void;
    const mapsGate = new Promise<void>((resolve) => { releaseMaps = resolve; });
    const requests: string[] = [];
    const fetchMock = async (input: URL | RequestInfo): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("manifest.json")) return response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } });
      if (url.includes("startup-")) return response(exact(startup));
      if (url.includes("maps-")) {
        await mapsGate;
        return response(exact(maps));
      }
      if (url.includes("audio-")) return response(exact(audio));
      return response("missing", { status: 404 });
    };
    const loader = await openPakChunkLoader("https://example.test/game/manifest.json", {
      fetch: fetchMock,
      sha256: async () => HASH,
      gunzip: async (bytes: ArrayBuffer) => bytes,
    });

    expect(loader.ready("embedded/startup")).toBe(true);
    expect(loader.ready("maps/a")).toBe(false);
    expect(loader.read("maps/a", 0, 4)).toBeUndefined();
    const startupCopy = new Uint8Array(await loader.startup());
    startupCopy[0] = 0;
    expect([...new Uint8Array(await loader.startup())]).toEqual([9, 8, 7]);
    expect(requests.filter((url) => url.includes("startup-")).length).toBe(1);

    const preparing = loader.prepare("maps/a");
    expect(loader.blocking).toBe(true);
    expect(loader.stats().blocking).toEqual(["maps"]);
    releaseMaps();
    await preparing;
    expect(loader.blocking).toBe(false);
    expect(loader.ready("maps/a")).toBe(true);
    expect([...new Uint8Array(loader.read("maps/a", 1, 3)!)]).toEqual([2, 3]);
    const copy = new Uint8Array(loader.read("maps/a", 0, 4)!);
    copy[0] = 99;
    expect([...new Uint8Array(loader.read("maps/a", 0, 4)!)]).toEqual([1, 2, 3, 4]);
    expect(loader.read("maps/a", -1, 2)).toBeUndefined();

    expect(loader.ready("music/theme")).toBe(false);
    loader.startBackground();
    await loader.prefetch("music/theme");
    expect(loader.blocking).toBe(false);
    expect(loader.ready("music/theme")).toBe(true);
    expect(loader.stats()).toMatchObject({
      resident: ["audio", "maps"],
      pending: [],
      blocking: [],
      failures: {},
    });
  });

  test("rejects a chunk whose directory disagrees with the manifest", async () => {
    const startup = new Uint8Array([1]);
    const wrong = pack([{ key: "maps/wrong", dtype: 0, data: new Uint8Array([2]) }]);
    const manifest = {
      version: 1,
      format: "pocket-pak-chunks/v1",
      startup: asset(HASH, startup, "startup"),
      chunks: [{ id: "maps", ...asset(HASH, wrong, "maps"), entries: ["maps/a"] }],
    };
    const loader = await openPakChunkLoader("https://example.test/manifest.json", {
      fetch: async (input: URL | RequestInfo) => String(input).endsWith("manifest.json")
        ? response(JSON.stringify(manifest))
        : response(exact(wrong)),
      sha256: async () => HASH,
      gunzip: async (bytes: ArrayBuffer) => bytes,
    });
    await expect(loader.prepare("maps/a")).rejects.toThrow(/entries do not match its manifest/);
    expect(loader.blocking).toBe(false);
    expect(loader.stats().failures.maps).toMatch(/entries do not match/);
  });
});
