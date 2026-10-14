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

function memoryCache(): Cache {
  const values = new Map<string, Response>();
  return {
    async match(request: RequestInfo | URL) {
      return values.get(String(request))?.clone();
    },
    async put(request: RequestInfo | URL, value: Response) {
      values.set(String(request), value.clone());
    },
    async delete(request: RequestInfo | URL) {
      return values.delete(String(request));
    },
    async add() { throw new Error("unused"); },
    async addAll() { throw new Error("unused"); },
    async keys() { return []; },
    async matchAll() { return []; },
  } as Cache;
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
        requires: [],
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
        { id: "maps", ...asset(HASH, maps, "maps"), entries: ["maps/a"], requires: [] },
        { id: "audio", ...asset(HASH, audio, "audio"), entries: ["music/theme"], background: true, requires: [] },
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
      chunks: [{ id: "maps", ...asset(HASH, wrong, "maps"), entries: ["maps/a"], requires: [] }],
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

  test("bounds post-first-frame background requests without making them blockers", async () => {
    const startup = new Uint8Array([1]);
    const chunks = ["a", "b", "c"].map((id) => ({
      id,
      bytes: pack([{ key: `maps/${id}`, dtype: 0, data: new Uint8Array([id.charCodeAt(0)]) }]),
    }));
    const manifest = {
      version: 1,
      format: "pocket-pak-chunks/v1",
      startup: asset(HASH, startup, "startup"),
      chunks: chunks.map(({ id, bytes }) => ({
        id,
        ...asset(HASH, bytes, id),
        entries: [`maps/${id}`],
        background: true,
        requires: [],
      })),
    };
    const releases: Array<() => void> = [];
    const fetchMock = async (input: URL | RequestInfo): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("manifest.json")) return response(JSON.stringify(manifest));
      const chunk = chunks.find(({ id }) => url.includes(`/${id}-`))!;
      await new Promise<void>((resolve) => releases.push(resolve));
      return response(exact(chunk.bytes));
    };
    const loader = await openPakChunkLoader("https://example.test/manifest.json", {
      fetch: fetchMock,
      sha256: async () => HASH,
      gunzip: async (bytes: ArrayBuffer) => bytes,
      backgroundConcurrency: 2,
    });
    loader.startBackground();
    expect(releases).toHaveLength(2);
    expect(loader.blocking).toBe(false);
    expect(loader.stats().pending).toHaveLength(2);
    expect(loader.stats().queued).toHaveLength(1);
    releases[0]!();
    for (let turn = 0; turn < 4 && releases.length < 3; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(releases).toHaveLength(3);
    releases[1]!();
    releases[2]!();
    await Promise.all(chunks.map(({ id }) => loader.prefetch(`maps/${id}`)));
    expect(loader.stats()).toMatchObject({ resident: ["a", "b", "c"], pending: [], queued: [] });
  });

  test("prepares declared dependencies under the same blocking veil", async () => {
    const startup = new Uint8Array([1]);
    const map = pack([{ key: "maps/a", dtype: 0, data: new Uint8Array([2]) }]);
    const audio = pack([{ key: "audio/theme", dtype: 0, data: new Uint8Array([3]) }]);
    const manifest = {
      version: 1,
      format: "pocket-pak-chunks/v1",
      startup: asset(HASH, startup, "startup"),
      chunks: [
        { id: "map", ...asset(HASH, map, "map"), entries: ["maps/a"], requires: ["audio"] },
        { id: "audio", ...asset(HASH, audio, "audio"), entries: ["audio/theme"], requires: [] },
      ],
    };
    const files = new Map<string, Uint8Array>([
      [manifest.chunks[0].file, map],
      [manifest.chunks[1].file, audio],
    ]);
    const loader = await openPakChunkLoader("https://example.test/manifest.json", {
      fetch: async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.endsWith("manifest.json")) return response(JSON.stringify(manifest));
        const name = url.slice(url.lastIndexOf("/") + 1);
        return response(exact(files.get(name)!));
      },
      sha256: async () => HASH,
      gunzip: async (bytes: ArrayBuffer) => bytes,
    });
    const preparing = loader.prepare("maps/a");
    expect(loader.blocking).toBe(true);
    expect(loader.stats().blocking).toEqual(["audio", "map"]);
    await preparing;
    expect(loader.ready("maps/a")).toBe(true);
    expect(loader.ready("audio/theme")).toBe(true);
    expect(loader.stats().resident).toEqual(["audio", "map"]);
  });

  test("reuses verified content-addressed assets across loader instances", async () => {
    const startup = new Uint8Array([4, 5, 6]);
    const map = pack([{ key: "maps/a", dtype: 0, data: new Uint8Array([7]) }]);
    const manifest = {
      version: 1,
      format: "pocket-pak-chunks/v1",
      startup: asset(HASH, startup, "startup"),
      chunks: [{ id: "map", ...asset(HASH, map, "map"), entries: ["maps/a"], requires: [] }],
    };
    const cache = memoryCache();
    const requests: string[] = [];
    const fetchMock = async (input: URL | RequestInfo): Promise<Response> => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("manifest.json")) return response(JSON.stringify(manifest));
      if (url.includes("startup-")) return response(exact(startup));
      if (url.includes("map-")) return response(exact(map));
      return response("missing", { status: 404 });
    };
    const open = () => openPakChunkLoader("https://example.test/game/manifest.json", {
      fetch: fetchMock,
      sha256: async () => HASH,
      gunzip: async (bytes: ArrayBuffer) => bytes,
      cache,
    });

    const cold = await open();
    await cold.startup();
    await cold.prepare("maps/a");
    const warm = await open();
    await warm.startup();
    await warm.prepare("maps/a");

    expect(requests.filter((url) => url.endsWith("manifest.json"))).toHaveLength(2);
    expect(requests.filter((url) => url.includes("startup-"))).toHaveLength(1);
    expect(requests.filter((url) => url.includes("map-") && !url.endsWith("manifest.json"))).toHaveLength(1);
    expect([...new Uint8Array(warm.read("maps/a", 0, 1)!)]).toEqual([7]);
  });
});
