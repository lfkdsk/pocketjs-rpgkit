import { describe, expect, test } from "bun:test";
import { MAX_PACK_ASSET_BYTES, MAX_PACK_ASSETS, MAX_PNG_BYTES, MAX_PNG_SIDE } from "../editor/api/limits.ts";
import { encodeBase64 } from "../editor/api/pack-format.ts";
// The web host intentionally stays plain JavaScript so it can be copied
// verbatim beside generated pages.
// @ts-expect-error no declaration file for the browser-only host module
import * as browserHost from "../tools/web/player.js";

const {
  BrowserEditorHost,
  BrowserMessageReassembler,
  BrowserProjectPack,
  createBrowserAutosaveBridge,
  EDITOR_CHUNK_MAX_CODE_UNITS,
  EDITOR_CHUNK_MAX_COUNT,
  EDITOR_TRANSFER_MAX_CODE_UNITS,
  SHARDED_PACK_KIND,
} = browserHost;

describe("browser autosave bridge", () => {
  test("uses one app-scoped key and quietly reports unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const bridge = createBrowserAutosaveBridge("app:autosave", storage);
    expect(bridge.read()).toBeNull();
    expect(bridge.write("envelope-1")).toBe(true);
    expect(bridge.read()).toBe("envelope-1");
    expect(values).toEqual(new Map([["app:autosave", "envelope-1"]]));

    const original = console.debug;
    const logged: unknown[][] = [];
    console.debug = (...args: unknown[]) => { logged.push(args); };
    try {
      const unavailable = createBrowserAutosaveBridge("app:autosave", {
        getItem() { throw new Error("denied"); },
        setItem() { throw new Error("denied"); },
      });
      expect(unavailable.read()).toBeNull();
      expect(unavailable.write("ignored")).toBe(false);
      expect(logged).toHaveLength(2);
    } finally {
      console.debug = original;
    }
  });
});

const digest = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function pngHeader(width = 1, height = 1): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const PNG_DATA = encodeBase64(pngHeader());

function fixture(count = 263) {
  const shards: Record<string, string> = Object.create(null);
  const mapIndex = Array.from({ length: count }, (_, index) => {
    const entry = `maps/map_${String(index).padStart(3, "0")}.json`;
    const text = JSON.stringify({ id: `map-${index}`, marker: `payload-only-${index}` });
    shards[entry] = text;
    return { id: `map-${index}`, width: 1, height: 1, entry, sha256: digest(text) };
  });
  const shell = JSON.stringify({
    format: "rpgkit-project/v1",
    title: "263 map browser fixture",
    mapManifestHash: "a".repeat(64),
    mapIndex,
  });
  const text = JSON.stringify({ kind: SHARDED_PACK_KIND, shell, shards });
  return { shell, shards, text };
}

describe("browser sharded editor pack host", () => {
  test("reports that local agents require the desktop companion", async () => {
    const sent: unknown[] = [];
    const host = Object.assign(Object.create(BrowserEditorHost.prototype), {
      player: {
        width: 480,
        height: 272,
        sendService(message: unknown) {
          sent.push(message);
        },
      },
      config: { storageKey: "browser-agent-test", examples: [] },
      storageReadError: null,
      setStatus() {},
      finishStartup() {},
    });

    await host.start();

    expect(sent[0]).toMatchObject({ t: "hello", w: 480, h: 272 });
    expect(sent[1]).toEqual({
      t: "agent-ready",
      protocol: "rpgkit-local-agent/v1",
      available: false,
      adapter: "browser",
      message: "Desktop companion required",
      maxPromptChars: 4096,
    });
  });

  test("keeps a pack's image assets when it serializes the pack again", () => {
    const source = fixture(2);
    const assets = { "art/sheets/town.png": { type: "image/png", data: PNG_DATA } };
    const withArt = `${JSON.stringify({ kind: SHARDED_PACK_KIND, shell: source.shell, shards: source.shards, assets }, null, 2)}\n`;
    expect(BrowserProjectPack.parse(withArt).serialize()).toBe(withArt);
    // A pack without assets keeps its spelling: no empty "assets" record.
    const plain = `${JSON.stringify({ kind: SHARDED_PACK_KIND, shell: source.shell, shards: source.shards }, null, 2)}\n`;
    expect(BrowserProjectPack.parse(plain).serialize()).toBe(plain);
    const bad = JSON.stringify({ kind: SHARDED_PACK_KIND, shell: source.shell, shards: source.shards, assets: { "../x.png": { type: "image/png", data: "" } } });
    expect(() => BrowserProjectPack.parse(bad)).toThrow();
  });

  test("uses the edit API's asset gates before retaining accepted bytes", () => {
    const source = fixture(1);
    const packed = (assets: Record<string, unknown>) => JSON.stringify({
      kind: SHARDED_PACK_KIND,
      shell: source.shell,
      shards: source.shards,
      assets,
    });

    const accepted = packed({ "art/tiny.png": { type: "image/png", data: PNG_DATA } });
    expect(BrowserProjectPack.parse(accepted).serialize()).toContain(PNG_DATA);
    expect(() => BrowserProjectPack.parse(packed({ "art/bad.png": { type: "image/png", data: "not base64" } })))
      .toThrow(/not valid base64/);
    const maxSide = encodeBase64(pngHeader(MAX_PNG_SIDE, 1));
    expect(BrowserProjectPack.parse(packed({ "art/max-side.png": { type: "image/png", data: maxSide } })).serialize())
      .toContain(maxSide);
    expect(() => BrowserProjectPack.parse(packed({ "art/wide.png": { type: "image/png", data: encodeBase64(pngHeader(MAX_PNG_SIDE + 1, 1)) } })))
      .toThrow(/8,192 px on a side/);

    const many = Object.fromEntries(Array.from({ length: MAX_PACK_ASSETS + 1 }, (_, index) => [
      `art/${index}.png`,
      { type: "image/png", data: PNG_DATA },
    ]));
    expect(() => BrowserProjectPack.parse(packed(many)))
      .toThrow("the pack has 4,097 asset images; a pack can have at most 4,096.");

    // The encoded length rejects one oversized image before allocating its
    // decoded bytes.
    const oversized = "A".repeat(Math.ceil((MAX_PNG_BYTES + 1) / 3) * 4);
    expect(() => BrowserProjectPack.parse(packed({ "art/huge.png": { type: "image/png", data: oversized } })))
      .toThrow(/local PNGs can be at most 16 MiB/);

    // Two maximum-size entries are exactly the shared 32 MiB cap. One more
    // tiny PNG crosses it, proving the total uses decoded bytes and `>`.
    const half = new Uint8Array(MAX_PACK_ASSET_BYTES / 2);
    half.set(pngHeader());
    const halfData = encodeBase64(half);
    const atTotal = {
      "art/half-0.png": { type: "image/png", data: halfData },
      "art/half-1.png": { type: "image/png", data: halfData },
    };
    expect(BrowserProjectPack.parse(packed(atTotal)).assets).toHaveLength(2);
    expect(() => BrowserProjectPack.parse(packed({
      ...atTotal,
      "art/over-total.png": { type: "image/png", data: PNG_DATA },
    })))
      .toThrow(/a pack can carry at most 32 MiB of images/);
  }, 30_000);

  test("catalogues 263 entries without sending any shard text until map-read", () => {
    const source = fixture();
    const pack = BrowserProjectPack.parse(source.text);
    const project = pack.projectMessage(41);

    expect(project).toEqual({ t: "project", shell: source.shell, request: 41 });
    expect(JSON.parse(project.shell).mapIndex).toHaveLength(263);
    expect(JSON.stringify(project)).not.toContain("payload-only-262");

    expect(pack.read({ t: "map-read", request: 42, entry: "maps/map_262.json" })).toEqual({
      t: "map-data",
      request: 42,
      entry: "maps/map_262.json",
      text: source.shards["maps/map_262.json"],
    });
    expect(pack.read({ t: "map-read", request: 43, entry: "../map_000.json" })).toMatchObject({
      t: "map-error",
      request: 43,
      entry: "../map_000.json",
    });
  });

  test("applies one dirty shard atomically and exports a replacement whole pack", async () => {
    const source = fixture();
    const pack = BrowserProjectPack.parse(source.text);
    const entry = "maps/map_137.json";
    const changed = JSON.stringify({ id: "map-137", marker: "changed-once" });
    const nextShell = JSON.parse(source.shell);
    nextShell.mapManifestHash = "b".repeat(64);
    nextShell.mapIndex[137].sha256 = digest(changed);

    const saved = await pack.save({
      t: "project-save",
      request: 51,
      baseManifestHash: "a".repeat(64),
      shell: JSON.stringify(nextShell),
      shards: [{ entry, text: changed, expectedSha256: digest(source.shards[entry]!) }],
    });

    expect(saved).toEqual({ request: 51, entries: [entry] });
    const replacement = JSON.parse(pack.serialize());
    expect(replacement.kind).toBe(SHARDED_PACK_KIND);
    expect(Object.keys(replacement.shards)).toHaveLength(263);
    expect(replacement.shards[entry]).toBe(changed);
    expect(replacement.shards["maps/map_136.json"]).toBe(source.shards["maps/map_136.json"]);
    expect(JSON.parse(replacement.shell).mapManifestHash).toBe("b".repeat(64));
  });

  test("rejects stale or unsafe writes without partially changing the pack", async () => {
    const source = fixture(2);
    const pack = BrowserProjectPack.parse(source.text);
    const before = pack.serialize();
    await expect(pack.save({
      t: "project-save",
      request: 1,
      baseManifestHash: "f".repeat(64),
      shell: source.shell,
      shards: [],
    })).rejects.toThrow(/base manifest/);
    expect(pack.serialize()).toBe(before);

    const unsafe = JSON.parse(source.text);
    unsafe.shell = JSON.stringify({
      ...JSON.parse(unsafe.shell),
      mapIndex: [{ id: "bad", width: 1, height: 1, entry: "../bad.json", sha256: "0".repeat(64) }],
    });
    unsafe.shards = { "../bad.json": "{}" };
    expect(() => BrowserProjectPack.parse(JSON.stringify(unsafe))).toThrow(/unsafe shard entry/);
  });

  test("reassembles a shard larger than Tuxemon's maximum and applies only its final chunk", async () => {
    const source = fixture(2);
    const pack = BrowserProjectPack.parse(source.text);
    const entry = "maps/map_001.json";
    const changed = JSON.stringify({ id: "map-1", data: "x".repeat(300_000) });
    const nextShell = JSON.parse(source.shell);
    nextShell.mapManifestHash = "c".repeat(64);
    nextShell.mapIndex[1].sha256 = digest(changed);
    const logical = JSON.stringify({
      t: "project-save",
      request: 71,
      baseManifestHash: "a".repeat(64),
      shell: JSON.stringify(nextShell),
      shards: [{ entry, text: changed, expectedSha256: digest(source.shards[entry]!) }],
    });
    const chunks = Array.from(
      { length: Math.ceil(logical.length / EDITOR_CHUNK_MAX_CODE_UNITS) },
      (_, index) => logical.slice(index * EDITOR_CHUNK_MAX_CODE_UNITS, (index + 1) * EDITOR_CHUNK_MAX_CODE_UNITS),
    );
    expect(logical.length).toBeGreaterThan(285_698);
    expect(chunks.length).toBeLessThanOrEqual(EDITOR_CHUNK_MAX_COUNT);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(EDITOR_CHUNK_MAX_CODE_UNITS);

    const reassembler = new BrowserMessageReassembler();
    expect(reassembler.push({ t: "chunk-start", transfer: 9, chunks: chunks.length })).toBeNull();
    let applications = 0;
    for (let index = 0; index < chunks.length; index++) {
      const message = reassembler.push({ t: "chunk", transfer: 9, index, text: chunks[index] });
      if (index + 1 < chunks.length) {
        expect(message).toBeNull();
        continue;
      }
      expect(message?.t).toBe("project-save");
      await pack.save(message);
      applications++;
    }

    expect(applications).toBe(1);
    const replacement = JSON.parse(pack.serialize());
    expect(replacement.shards[entry]).toBe(changed);
    expect(replacement.shards["maps/map_000.json"]).toBe(source.shards["maps/map_000.json"]);
  });

  test("drops malformed, interrupted, and oversized chunk streams", () => {
    const source = fixture(2);
    const pack = BrowserProjectPack.parse(source.text);
    const before = pack.serialize();
    const reassembler = new BrowserMessageReassembler();
    const logical = JSON.stringify({ t: "project-save", request: 1 });

    expect(reassembler.push({ t: "chunk-start", transfer: 1, chunks: 2 })).toBeNull();
    expect(reassembler.push({ t: "chunk", transfer: 1, index: 0, text: logical.slice(0, 4) })).toBeNull();
    expect(reassembler.push({ t: "chunk", transfer: 1, index: 0, text: logical.slice(4) })).toBeNull();
    expect(reassembler.push({ t: "chunk", transfer: 1, index: 1, text: logical.slice(4) })).toBeNull();

    expect(reassembler.push({ t: "chunk-start", transfer: 2, chunks: 2 })).toBeNull();
    expect(reassembler.push({ t: "chunk", transfer: 2, index: 0, text: logical.slice(0, 4) })).toBeNull();
    expect(reassembler.push({ t: "project-save", request: 88 })).toBeNull();
    expect(reassembler.push({ t: "project-save", request: 89 })).toEqual({ t: "project-save", request: 89 });

    expect(reassembler.push({ t: "chunk-start", transfer: 3, chunks: EDITOR_CHUNK_MAX_COUNT + 1 })).toBeNull();
    expect(reassembler.push({ t: "chunk", transfer: 3, index: 0, text: logical })).toBeNull();
    expect(reassembler.push({ t: "chunk-start", transfer: 4, chunks: 1 })).toBeNull();
    expect(reassembler.push({
      t: "chunk",
      transfer: 4,
      index: 0,
      text: "x".repeat(EDITOR_CHUNK_MAX_CODE_UNITS + 1),
    })).toBeNull();
    expect(EDITOR_CHUNK_MAX_COUNT * EDITOR_CHUNK_MAX_CODE_UNITS).toBe(EDITOR_TRANSFER_MAX_CODE_UNITS);
    expect(pack.serialize()).toBe(before);
  });
});
