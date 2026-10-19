// Browser RPG Maker import: real DirectoryHandle-shaped traversal, the shared
// conversion core with a browser codec, staged pack/art/coverage, lifecycle,
// and a browser bundle that contains no Node/Bun runtime dependency.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseShardedPack } from "../editor/api/pack.ts";
import { EditSession } from "../editor/api/session.ts";
import { resolveProjectArt, projectArtRefs } from "../editor/studio/project-art.ts";
import { BrowserRpgMakerImporter } from "../editor/studio/rpgmaker-import-browser.ts";
import type { BrowserRpgMakerImageCodec } from "../editor/studio/rpgmaker-import-browser-io.ts";
import type {
  BrowserDirectoryHandle,
  BrowserFileHandle,
  BrowserFileLike,
} from "../editor/studio/rpgmaker-import-browser-source.ts";
import {
  BrowserRpgMakerSource,
  loadBrowserRmProject,
} from "../editor/studio/rpgmaker-import-browser-source.ts";
import { decodePngBytes, writePngBytes } from "../tools/rpgmaker-import/png.ts";

const STAGE = join(import.meta.dir, "fixtures", "rpgmaker", "stage-mv");

class FsFileHandle implements BrowserFileHandle {
  readonly kind = "file" as const;
  readonly name: string;

  constructor(private readonly path: string) {
    this.name = path.split("/").at(-1)!;
  }

  async getFile(): Promise<BrowserFileLike> {
    const bytes = new Uint8Array(readFileSync(this.path));
    return {
      name: this.name,
      size: bytes.length,
      async text() {
        return new TextDecoder().decode(bytes);
      },
      async arrayBuffer() {
        const copy = new Uint8Array(bytes.length);
        copy.set(bytes);
        return copy.buffer;
      },
    };
  }
}

class FsDirectoryHandle implements BrowserDirectoryHandle {
  readonly kind = "directory" as const;
  readonly name: string;

  constructor(private readonly path: string) {
    this.name = path.split("/").at(-1)!;
  }

  async getFileHandle(name: string): Promise<BrowserFileHandle> {
    const path = join(this.path, name);
    if (!existsSync(path)) throw new DOMException("File not found", "NotFoundError");
    return new FsFileHandle(path);
  }

  async *values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle> {
    for (const entry of readdirSync(this.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(this.path, entry.name);
      yield entry.isDirectory() ? new FsDirectoryHandle(path) : new FsFileHandle(path);
    }
  }
}

const NODE_TEST_CODEC: BrowserRpgMakerImageCodec = {
  async decode(bytes) {
    return decodePngBytes(bytes);
  },
  async encode(image) {
    return writePngBytes(image);
  },
};

describe("browser RPG Maker import", () => {
  test("source indexing ignores unrelated deployed runtime directories", async () => {
    let enteredJs = false;
    const file = (name: string, text: string): BrowserFileHandle => ({
      kind: "file",
      name,
      async getFile() {
        const bytes = new TextEncoder().encode(text);
        return { name, size: bytes.length, text: async () => text, arrayBuffer: async () => bytes.slice().buffer };
      },
    });
    const data: BrowserDirectoryHandle = {
      kind: "directory",
      name: "data",
      async *values() {
        yield file("System.json", JSON.stringify({ gameTitle: "Small", partyMembers: [], startMapId: 0 }));
      },
    };
    const js: BrowserDirectoryHandle = {
      kind: "directory",
      name: "js",
      async *values() {
        enteredJs = true;
        throw new Error("unrelated runtime directory should not be enumerated");
      },
    };
    const root: BrowserDirectoryHandle = {
      kind: "directory",
      name: "deployed",
      async *values() {
        yield data;
        yield js;
      },
    };
    const source = await BrowserRpgMakerSource.index(root);
    const loaded = await loadBrowserRmProject(source, { codec: NODE_TEST_CODEC });
    expect(enteredJs).toBe(false);
    expect(loaded.project.system.gameTitle).toBe("Small");
  });

  test("targeted browser registry lookup keeps declarations inert without enumerating js", async () => {
    let enumerated = false;
    let implementationRead = false;
    const registry = `var $plugins = ${JSON.stringify([{ name: "Fixture", status: true, description: "Safe", parameters: { nested: '{"x":1}' } }])};`;
    const js: BrowserDirectoryHandle = {
      kind: "directory", name: "js",
      async *values() { enumerated = true; throw new Error("js must not be enumerated"); },
      async getFileHandle(name) {
        expect(name).toBe("plugins.js");
        return { kind: "file", name, async getFile() {
          return { name, size: registry.length, text: async () => registry,
            arrayBuffer: async () => { implementationRead = true; throw new Error("no implementation bytes"); } };
        } };
      },
    };
    const root: BrowserDirectoryHandle = {
      kind: "directory", name: "fixture",
      async *values() {
        yield { kind: "directory" as const, name: "data", async *values() {
          yield { kind: "file" as const, name: "System.json", async getFile() {
            const text = JSON.stringify({ gameTitle: "Fixture", partyMembers: [], startMapId: 0 });
            return { name: "System.json", size: text.length, text: async () => text,
              arrayBuffer: async () => new ArrayBuffer(0) };
          } };
        } };
        yield js;
      },
    };
    const source = await BrowserRpgMakerSource.index(root);
    const loaded = await loadBrowserRmProject(source, { codec: NODE_TEST_CODEC });
    expect(loaded.project.plugins).toEqual([{ name: "Fixture", status: true,
      description: "Safe", parameters: { nested: '{"x":1}' } }]);
    expect(enumerated).toBe(false);
    expect(implementationRead).toBe(false);
    expect(source.isFile("js/Fixture.js")).toBe(false);
  });

  test("read-only folder pick imports maps and PNGs, reports audio, and stages an openable pack", async () => {
    let pickerMode: string | undefined;
    const importer = new BrowserRpgMakerImporter(
      () => async (options) => {
        pickerMode = options.mode;
        return new FsDirectoryHandle(STAGE);
      },
      NODE_TEST_CODEC,
    );
    const progress: string[] = [];
    importer.onProgress((event) => progress.push(event.phase));

    const outcome = await importer.import({ token: "web-1", placeholders: "visible" });
    expect(pickerMode).toBe("read");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.token).toBe("web-1");
    expect(outcome.opened.label).toBe("stage-mv (imported)");
    expect(outcome.opened.fileName).toBe("stage-mv-imported.rpgpack.json");
    expect(outcome.opened.target).toBeUndefined();
    expect(outcome.coverage.totals.total).toBeGreaterThan(0);
    expect(outcome.coverage.rows.some((row) => row.section === "audio" && row.counts.Dropped > 0)).toBe(true);
    const warnings = outcome.warnings.join("\n");
    for (const guidance of [
      "Browser Studio cannot invoke system ffmpeg",
      "Ogg/M4A audio is omitted while maps and images continue importing",
      "Desktop Studio or the CLI can import this audio when ffmpeg is installed",
      "浏览器版 Studio 无法调用系统 ffmpeg",
      "因此会省略 Ogg/M4A 音频，但地图和图片会继续导入",
      "安装 ffmpeg 后，桌面版 Studio 或 CLI 可以导入这些音频",
    ]) expect(warnings).toContain(guidance);
    expect(progress[0]).toBe("selecting");
    expect(progress).toContain("reading");
    expect(progress).toContain("converting");
    expect(progress).toContain("packing");
    expect(progress.at(-1)).toBe("complete");

    const pack = parseShardedPack(outcome.opened.text);
    expect(pack.shell.mapIndex).toHaveLength(1);
    expect(pack.assets.has("tiles/ts1.png")).toBe(true);
    expect(pack.assets.has("pictures/curtain.png")).toBe(true);
    const art = resolveProjectArt(projectArtRefs(pack.shell), (path) => pack.assets.has(path));
    expect(art.some(({ ref, path }) => ref.kind === "sheet" && path === "tiles/ts1.png")).toBe(true);
    expect(EditSession.open(outcome.opened.text).title()).toBe("Lantern Stage");
  });

  test("a concurrent request is BUSY and cancellation stops directory indexing cooperatively", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: BrowserDirectoryHandle = {
      kind: "directory",
      name: "slow",
      async *values() {
        await gate;
      },
    };
    const importer = new BrowserRpgMakerImporter(() => async () => slow, NODE_TEST_CODEC);
    const first = importer.import({ token: "first", placeholders: "visible" });
    const busy = await importer.import({ token: "second", placeholders: "silent" });
    expect(busy).toEqual({ ok: false, token: "second", code: "BUSY", message: "Another RPG Maker import is already running." });
    importer.cancel("first");
    release();
    expect(await first).toEqual({ ok: false, token: "first", code: "CANCELLED", message: "RPG Maker import cancelled." });
  });

  test("a folder without data/System.json is classified as an invalid source", async () => {
    const empty: BrowserDirectoryHandle = { kind: "directory", name: "empty", async *values() {} };
    const importer = new BrowserRpgMakerImporter(() => async () => empty, NODE_TEST_CODEC);
    const outcome = await importer.import({ token: "bad", placeholders: "visible" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVALID_SOURCE");
    expect(outcome.message).toContain("no data/System.json");
  });

  test("the browser importer bundle contains no Node or Bun runtime dependency", async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "editor", "studio", "rpgmaker-import-browser.ts")],
      target: "browser",
      minify: false,
    });
    expect(built.success).toBe(true);
    expect(built.logs).toEqual([]);
    const text = await built.outputs[0]!.text();
    expect(text).not.toContain("node:fs");
    expect(text).not.toContain("node:path");
    expect(text).not.toContain("node:zlib");
    expect(text).not.toMatch(/\bBun\./);
  });
});
