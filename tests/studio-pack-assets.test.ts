// A project's own art: where it lives by convention (editor/studio/
// project-art.ts), how a sharded pack carries it in its optional `assets`
// (editor/api/pack.ts, pack-format.ts), that an editing session keeps it,
// and that opening a folder embeds the art the project references while
// saving the folder never writes art back (editor/studio/project-directory.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { MAX_PACK_ASSET_BYTES, MAX_PACK_ASSETS, MAX_PACK_BYTES, MAX_PNG_BYTES, MAX_PNG_SIDE } from "../editor/api/limits.ts";
import { parseShardedPack, serializeShardedPack, SHARDED_PACK_KIND, type PackAsset } from "../editor/api/pack.ts";
import { decodeBase64, encodeBase64, packText, readPackEnvelope } from "../editor/api/pack-format.ts";
import { EditSession } from "../editor/api/session.ts";
import { MemoryDirectory } from "../editor/studio/host-memory.ts";
import { projectArtRefs, resolveProjectArt } from "../editor/studio/project-art.ts";
import {
  openDirectoryProject,
  openProjectDirectory,
  readProjectArt,
  saveProjectDirectory,
  type ProjectDirectory,
} from "../editor/studio/project-directory.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { Project } from "../src/engine/types.ts";

const SUNSTONE = readFileSync(join(import.meta.dir, "..", "examples", "sunstone", "data", "sunstone.json"), "utf8");
const SPLIT = splitProjectMaps(JSON.parse(SUNSTONE) as Project);
const SHARDS = new Map(SPLIT.entries.map((entry) => [entry.path, entry.text]));

// ---- tiny real PNGs ---------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A valid width×height RGBA PNG filled with one colour, or with noise
 * (which does not compress) when `rgba` is "noise". */
function png(width: number, height: number, rgba: number[] | "noise" = [200, 80, 40, 255]): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 4));
  let seed = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = rgba === "noise" ? [0, 1, 2, 3].map(() => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24) : rgba;
      raw.set(pixel, y * (1 + width * 4) + 1 + x * 4);
    }
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const TILE = png(16, 16, "noise");
const DOT = png(1, 1, [0, 0, 0, 255]);
const asset = (bytes: Uint8Array): PackAsset => ({ type: "image/png", data: encodeBase64(bytes) });

/** The pre-assets spelling of a pack, written independently of packText. */
function legacyPackText(): string {
  const shards = Object.create(null) as Record<string, string>;
  for (const meta of SPLIT.shell.mapIndex) shards[meta.entry] = SHARDS.get(meta.entry)!;
  return `${JSON.stringify({ kind: SHARDED_PACK_KIND, shell: SPLIT.shellText, shards }, null, 2)}\n`;
}

/** A pack text with `assets` as given, bypassing the serializer's checks. */
function packWithRawAssets(assets: unknown): string {
  const pack = JSON.parse(legacyPackText()) as Record<string, unknown>;
  pack.assets = assets;
  return JSON.stringify(pack, null, 2);
}

function errorOf(run: () => unknown): { code?: string; message: string } {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("expected an error");
}

// ---- conventions ------------------------------------------------------------

describe("projectArtRefs", () => {
  test("lists each sheet, sprite and animation's candidate paths in order", () => {
    const refs = projectArtRefs({
      sheets: [{ id: "town", cols: 8, rows: 8 }],
      sprites: {
        wiz: { kind: "image", src: "assets/npc/wiz.png" },
        hero: { kind: "walker", sheet: "sprites/adventurer.png" },
        old: { kind: "walker", atlases: { down: "d.png", left: "l.png", right: "r.png", up: "u.png" }, frames: 3, step: 8 },
      },
      animations: [{ id: "splash", sheet: "fx/splash.png", frameDuration: 4 }],
    });
    expect(refs).toEqual([
      { kind: "sheet", id: "town", candidates: ["art/sheets/town.png", "sheets/town.png", "tiles/town.png"] },
      { kind: "sprite", id: "wiz", candidates: ["assets/npc/wiz.png", "art/sprites/wiz.png"] },
      { kind: "sprite", id: "hero", candidates: ["sprites/adventurer.png", "art/sprites/hero.png"] },
      { kind: "animation", id: "splash", candidates: ["fx/splash.png"] },
    ]);
  });

  test("drops unsafe and non-PNG candidates and duplicates", () => {
    const refs = projectArtRefs({
      sheets: [{ id: "../up", cols: 1, rows: 1 }, { id: "a b", cols: 1, rows: 1 }],
      sprites: {
        abs: { kind: "image", src: "/etc/x.png" },
        back: { kind: "image", src: "npc\\x.png" },
        dot: { kind: "image", src: "./x.png" },
        gap: { kind: "image", src: "npc//x.png" },
        drive: { kind: "image", src: "C:/x.png" },
        gif: { kind: "image", src: "npc/x.gif" },
        upper: { kind: "image", src: "npc/X.PNG" },
        same: { kind: "image", src: "art/sprites/same.png" },
      },
      animations: [{ id: "up", sheet: "../fx.png", frameDuration: 4 }],
    });
    expect(refs.map((ref) => ref.candidates)).toEqual([
      [],
      ["art/sheets/a b.png", "sheets/a b.png", "tiles/a b.png"],
      ["art/sprites/abs.png"],
      ["art/sprites/back.png"],
      ["art/sprites/dot.png"],
      ["art/sprites/gap.png"],
      ["art/sprites/drive.png"],
      ["art/sprites/gif.png"],
      ["npc/X.PNG", "art/sprites/upper.png"],
      ["art/sprites/same.png"],
      [],
    ]);
  });

  test("resolveProjectArt picks the first present candidate and skips refs with none", () => {
    const refs = projectArtRefs({ sheets: [{ id: "town", cols: 1, rows: 1 }, { id: "dun", cols: 1, rows: 1 }], sprites: { wiz: { kind: "image", src: "npc/wiz.png" } } });
    const present = new Set(["sheets/town.png", "art/sheets/town.png", "art/sprites/wiz.png"]);
    expect(resolveProjectArt(refs, (path) => present.has(path)).map(({ ref, path }) => [ref.id, path])).toEqual([
      ["town", "art/sheets/town.png"],
      ["wiz", "art/sprites/wiz.png"],
    ]);
  });

  test("an imported tile sheet falls back to tiles/<id>.png without overriding authored sheet paths", () => {
    const [sheet] = projectArtRefs({ sheets: [{ id: "ts1", cols: 4, rows: 4 }] });
    expect(sheet!.candidates).toEqual(["art/sheets/ts1.png", "sheets/ts1.png", "tiles/ts1.png"]);
    expect(resolveProjectArt([sheet!], (path) => path === "tiles/ts1.png")[0]?.path).toBe("tiles/ts1.png");
    expect(resolveProjectArt([sheet!], (path) => path === "art/sheets/ts1.png" || path === "tiles/ts1.png")[0]?.path)
      .toBe("art/sheets/ts1.png");
  });
});

// ---- the pack format --------------------------------------------------------

describe("pack assets", () => {
  test("base64 round-trips every length and refuses malformed text", () => {
    for (let n = 0; n < 8; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff);
      const text = encodeBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString("base64"));
      expect(decodeBase64(text)).toEqual(bytes);
    }
    expect(encodeBase64(TILE)).toBe(Buffer.from(TILE).toString("base64"));
    for (const bad of ["A", "AB=", "A===", "AB=C", "AB C", "AB\nC", "QQ=A", "QR==", "QUJ=", "ä===", "QUJD QUJD"]) {
      expect(decodeBase64(bad)).toBeNull();
    }
  });

  test("a pack without assets keeps its exact pre-assets bytes", () => {
    const legacy = legacyPackText();
    expect(serializeShardedPack(SPLIT.shellText, SPLIT.shell.mapIndex, SHARDS)).toBe(legacy);
    expect(serializeShardedPack(SPLIT.shellText, SPLIT.shell.mapIndex, SHARDS, new Map())).toBe(legacy);
    const parsed = parseShardedPack(legacy);
    expect(parsed.assets.size).toBe(0);
    expect(serializeShardedPack(parsed.shellText, parsed.shell.mapIndex, parsed.shards, parsed.assets)).toBe(legacy);
    expect(EditSession.open(legacy).exportText()).toBe(legacy);
    const envelope = readPackEnvelope(legacy);
    expect(envelope.problem === null && envelope.assets).toBeUndefined();
  });

  test("assets are written after the shards and round-trip byte for byte", () => {
    const assets = new Map([["assets/npc/wiz.png", asset(TILE)], ["art/sheets/town.png", asset(DOT)], ["__proto__", asset(DOT)]]);
    const text = serializeShardedPack(SPLIT.shellText, SPLIT.shell.mapIndex, SHARDS, assets);
    expect(text.startsWith(legacyPackText().slice(0, -3))).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["kind", "shell", "shards", "assets"]);
    const parsed = parseShardedPack(text);
    expect([...parsed.assets.keys()]).toEqual(["assets/npc/wiz.png", "art/sheets/town.png", "__proto__"]);
    expect(parsed.assets.get("assets/npc/wiz.png")).toEqual(asset(TILE));
    expect(decodeBase64(parsed.assets.get("assets/npc/wiz.png")!.data)).toEqual(TILE);
    expect(serializeShardedPack(parsed.shellText, parsed.shell.mapIndex, parsed.shards, parsed.assets)).toBe(text);
    expect(packText(parsed.shellText, parsed.shards, parsed.assets)).toBe(text);
  });

  test("every malformed or oversized asset is refused with its code", () => {
    const cases: [string, unknown, string, RegExp][] = [
      ["not an object", [], "INVALID_PACK", /"assets" must be an object/],
      ["null", null, "INVALID_PACK", /"assets" must be an object/],
      ["traversal key", { "../x.png": asset(DOT) }, "INVALID_PACK", /unsafe asset path/],
      ["absolute key", { "/x.png": asset(DOT) }, "INVALID_PACK", /unsafe asset path/],
      ["backslash key", { "a\\x.png": asset(DOT) }, "INVALID_PACK", /unsafe asset path/],
      ["empty key", { "": asset(DOT) }, "INVALID_PACK", /unsafe asset path/],
      ["string value", { "x.png": "iVBOR" }, "INVALID_PACK", /only "type" and "data"/],
      ["extra field", { "x.png": { ...asset(DOT), name: "x" } }, "INVALID_PACK", /only "type" and "data"/],
      ["missing data", { "x.png": { type: "image/png" } }, "INVALID_PACK", /only "type" and "data"/],
      ["wrong type", { "x.png": { type: "image/jpeg", data: encodeBase64(DOT) } }, "INVALID_PACK", /only "image\/png"/],
      ["bad base64", { "x.png": { type: "image/png", data: "not base64!" } }, "INVALID_PACK", /not valid base64/],
      ["unpadded base64", { "x.png": { type: "image/png", data: encodeBase64(DOT).replace(/=+$/, "") } }, "INVALID_PACK", /not valid base64/],
      ["not a PNG", { "x.png": { type: "image/png", data: encodeBase64(new TextEncoder().encode("GIF89a, honestly not a png at all")) } }, "INVALID_PACK", /is not a PNG image/],
      ["empty image", { "x.png": { type: "image/png", data: "" } }, "INVALID_PACK", /is not a PNG image/],
      ["too wide", { "x.png": asset(png(MAX_PNG_SIDE + 1, 1)) }, "TOO_LARGE", /8,192 px on a side/],
    ];
    for (const [name, assets, code, message] of cases) {
      const error = errorOf(() => parseShardedPack(packWithRawAssets(assets)));
      expect({ name, code: error.code }).toEqual({ name, code });
      expect(error.message).toMatch(message);
      // EditSession reports the same refusal.
      expect(errorOf(() => EditSession.open(packWithRawAssets(assets))).code).toBe(code);
    }
  });

  test("size limits: one image, the count and the decoded total", () => {
    // One image over MAX_PNG_BYTES is refused from its base64 length.
    const huge = { "big.png": { type: "image/png", data: "A".repeat(Math.ceil((MAX_PNG_BYTES + 1) / 3) * 4) } };
    const big = errorOf(() => parseShardedPack(packWithRawAssets(huge)));
    expect(big.code).toBe("TOO_LARGE");
    expect(big.message).toMatch(/local PNGs can be at most 16 MiB/);

    const many = Object.fromEntries(Array.from({ length: MAX_PACK_ASSETS + 1 }, (_, i) => [`a/${i}.png`, asset(DOT)]));
    const count = errorOf(() => parseShardedPack(packWithRawAssets(many)));
    expect(count.code).toBe("TOO_LARGE");
    expect(count.message).toBe("the pack has 4,097 asset images; a pack can have at most 4,096.");
    delete many[`a/${MAX_PACK_ASSETS}.png`];
    expect(parseShardedPack(packWithRawAssets(many)).assets.size).toBe(MAX_PACK_ASSETS);

    // Three 11 MiB images (a valid header followed by padding) pass each
    // image's limit but not the 32 MiB total; the pack stays under 64 MiB.
    const filler = new Uint8Array(11 * 1024 * 1024);
    filler.set(png(1, 1));
    const data = encodeBase64(filler);
    const three = Object.fromEntries([0, 1, 2].map((i) => [`big/${i}.png`, { type: "image/png", data }]));
    const total = packWithRawAssets(three);
    expect(total.length).toBeLessThan(MAX_PACK_BYTES);
    const heavy = errorOf(() => parseShardedPack(total));
    expect(heavy.code).toBe("TOO_LARGE");
    expect(heavy.message).toBe("the pack's asset images are 33.0 MiB together; a pack can carry at most 32 MiB of images.");
    delete three["big/2.png"];
    expect(parseShardedPack(packWithRawAssets(three)).assets.size).toBe(2);
    expect(MAX_PACK_ASSET_BYTES).toBe(32 * 1024 * 1024);
  });
});

// ---- the editing session ----------------------------------------------------

describe("EditSession on a pack with assets", () => {
  test("edits, undo and redo keep the assets in every export", () => {
    const assets = new Map([["assets/npc/wiz.png", asset(TILE)], ["art/sheets/town.png", asset(DOT)]]);
    const source = serializeShardedPack(SPLIT.shellText, SPLIT.shell.mapIndex, SHARDS, assets);
    const session = EditSession.open(source);
    expect(session.assets()).toEqual(assets);
    expect(session.exportText()).toBe(source);

    const response = session.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" });
    expect(response.ok).toBe(true);
    const edited = parseShardedPack(session.exportText());
    expect(edited.shards.get("maps/village.json")).not.toBe(SHARDS.get("maps/village.json"));
    expect(edited.assets).toEqual(assets);

    session.undo();
    expect(session.exportText()).toBe(source);
    session.redo();
    expect(parseShardedPack(session.exportText()).assets).toEqual(assets);
    expect(session.assets()).toEqual(assets);
  });

  test("inline documents have no assets", () => {
    expect(EditSession.open(SUNSTONE).assets().size).toBe(0);
  });
});

// ---- folders ----------------------------------------------------------------

/** Sunstone as a loose folder with some of its art: the town sheet by
 * convention, two NPC sprites at their `src` paths, plus unreferenced art. */
function folderWithArt(): MemoryDirectory {
  const files = new Map<string, string>([["project.json", SPLIT.shellText]]);
  for (const [entry, text] of SHARDS) files.set(entry, text);
  const dir = new MemoryDirectory("sunstone/", files);
  dir.binary.set("art/sheets/town.png", TILE);
  dir.binary.set("assets/npc/wiz.png", DOT);
  dir.binary.set("assets/npc/boy.png", DOT);
  dir.binary.set("art/sheets/unused.png", TILE);
  dir.binary.set("assets/npc/unused.png", DOT);
  return dir;
}

describe("opening a folder", () => {
  test("embeds the referenced art, and only that, keyed as the project names it", async () => {
    const dir = folderWithArt();
    const opened = await openProjectDirectory(dir);
    const pack = parseShardedPack(opened.packText);
    // In the shell's order: sheets, then sprites as the shell text lists them.
    expect([...pack.assets.keys()]).toEqual(["art/sheets/town.png", "assets/npc/boy.png", "assets/npc/wiz.png"]);
    expect(decodeBase64(pack.assets.get("art/sheets/town.png")!.data)).toEqual(TILE);
    expect(opened.art).toEqual([...pack.assets.keys()]);
    expect(dir.reads.filter((path) => path.endsWith(".png"))).toEqual(["art/sheets/town.png", "assets/npc/boy.png", "assets/npc/wiz.png"]);
    // The pack's asset keys are where resolveProjectArt looks.
    const found = resolveProjectArt(projectArtRefs(pack.shell), (path) => pack.assets.has(path));
    expect(found.map(({ ref }) => ref.id)).toEqual(["town", "boy", "wiz"]);
    expect(opened.notes[0]).toBe("Loaded 3 art files from the folder.");
    expect(opened.notes[1]).toMatch(/^12 referenced art files are missing: art\/sheets\/dun\.png, assets\/npc\/bat\.png, assets\/npc\/chest-a\.png, assets\/npc\/chest-b\.png, assets\/npc\/chest-c\.png and 7 more\.$/);
    expect(opened.notes).toHaveLength(2);

    const project = await openDirectoryProject(dir);
    expect("error" in project ? project.error : project.notes).toEqual(opened.notes);
  });

  test("skips oversized and non-PNG art without reading the oversized file", async () => {
    const dir = folderWithArt();
    dir.binary.set("art/sheets/dun.png", TILE);
    dir.sizes.set("art/sheets/dun.png", MAX_PNG_BYTES + 1);
    dir.binary.set("assets/npc/boy.png", new TextEncoder().encode("this is not a PNG file, only text."));
    const opened = await openProjectDirectory(dir);
    expect(opened.art).toEqual(["art/sheets/town.png", "assets/npc/wiz.png"]);
    expect(dir.reads).not.toContain("art/sheets/dun.png");
    expect(opened.notes[0]).toBe("Loaded 2 art files from the folder.");
    expect(opened.notes[2]).toBe("Skipped 2 art files: art/sheets/dun.png (too large), assets/npc/boy.png (not a PNG).");
  });

  test("a folder without its art opens as before, and a host without readBytes reads none", async () => {
    const files = new Map<string, string>([["project.json", SPLIT.shellText]]);
    for (const [entry, text] of SHARDS) files.set(entry, text);
    const bare = await openProjectDirectory(new MemoryDirectory("bare/", files));
    expect(bare.packText).toBe(legacyPackText());
    // No art at all is not worth a notice.
    expect(bare.notes).toEqual([]);
    expect(bare.art).toEqual([]);

    const dir = folderWithArt();
    const textOnly: ProjectDirectory = {
      name: dir.name,
      listRoot: () => dir.listRoot(),
      read: (path) => dir.read(path),
      size: (path) => dir.size(path),
      write: (path, text) => dir.write(path, text),
      remove: (path) => dir.remove(path),
    };
    const opened = await openProjectDirectory(textOnly);
    expect(opened.packText).toBe(legacyPackText());
    expect(opened.notes).toEqual([]);
  });

  test("art beside a shell in a subfolder is found there first, then at the root", async () => {
    const dir = new MemoryDirectory("game/", new Map());
    dir.binary.set("game/art/sheets/town.png", TILE);
    dir.binary.set("art/sheets/town.png", DOT);
    dir.binary.set("assets/npc/wiz.png", DOT);
    dir.binary.set("game/assets/npc/boy.png", TILE);
    const art = await readProjectArt(dir, "game/project.json", SPLIT.shell);
    expect([...art.assets.keys()]).toEqual(["art/sheets/town.png", "assets/npc/wiz.png", "assets/npc/boy.png"]);
    expect(decodeBase64(art.assets.get("art/sheets/town.png")!.data)).toEqual(TILE);
    expect(decodeBase64(art.assets.get("assets/npc/boy.png")!.data)).toEqual(TILE);
    expect(dir.reads).toEqual(["game/art/sheets/town.png", "assets/npc/wiz.png", "game/assets/npc/boy.png"]);
  });

  test("art that would overfill the pack is skipped", async () => {
    const dir = folderWithArt();
    // Room for the 1×1 sprites but not the 16×16 noise sheet.
    expect(TILE.length).toBeGreaterThan(1000);
    const room = 2 * (Math.ceil(DOT.length / 3) * 4 + 100) + 64;
    const art = await readProjectArt(dir, "project.json", SPLIT.shell, MAX_PACK_BYTES - room);
    expect([...art.assets.keys()]).toEqual(["assets/npc/wiz.png", "assets/npc/boy.png"]);
    expect(art.notes[2]).toBe("Skipped 1 art file: art/sheets/town.png (pack full).");
    expect(dir.reads).not.toContain("art/sheets/town.png");
  });

  test("saving after an edit writes only the shell and the changed shard, never art", async () => {
    const dir = folderWithArt();
    const opened = await openProjectDirectory(dir);
    const session = EditSession.open(opened.packText);
    expect(session.run("paint-cells", { map: "village", layer: "ground", cells: [[1, 1]], value: "town.37" }).ok).toBe(true);
    const binaryBefore = new Map(dir.binary);
    const saved = await saveProjectDirectory(dir, opened.baseline, session.exportText());
    expect(saved.written).toEqual(["maps/village.json", "project.json"]);
    expect(dir.writes).toEqual(["maps/village.json", "project.json"]);
    expect(dir.binary).toEqual(binaryBefore);
    expect([...dir.files.keys()].filter((path) => path.endsWith(".png"))).toEqual([]);
    expect(dir.files.get("project.json")).toBe(parseShardedPack(session.exportText()).shellText);
  });
});
