// Per-app CJK fallback font (tools/lib/cjk-font.ts) and the build-time
// measurer (tools/lib/font-measure.ts). No network: the committed Noto CJK
// demo subset stands in for the pinned Simplified Chinese source.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeSlot } from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE } from "../vendor/pocketjs/contracts/spec/spec.ts";
import {
  CJK_FONT_SOURCES,
  CJK_FONT_VARIANTS,
  LICENSE_PAK_KEY,
  OFL_TITLE,
  REPO_ROOT,
  checkAppCjkFont,
  cjkAppFontFiles,
  fallbackCharacters,
  opentype,
  pakManifestWithLicense,
  parseFontFile,
  subsetFont,
  writeAppCjkFont,
} from "../tools/lib/cjk-font.ts";
import { createFontMeasure } from "../tools/lib/font-measure.ts";
import { fontLicenseFiles } from "../tools/lib/font-licenses.ts";
import { appModules, appTextInventory, fileStrings } from "../tools/lib/text-inventory.ts";
import { copyFontLicenses, fontLicenseOutputName } from "../tools/web.ts";
import { unpack } from "../vendor/pocketjs/framework/compiler/pak.ts";

const DEMO = join(REPO_ROOT, "vendor/pocketjs/assets/fonts/NotoSansCJK-Demo.otf");
const INTER = join(REPO_ROOT, "vendor/pocketjs/assets/fonts/Inter-Regular.ttf");
const scratch = mkdtempSync(join(tmpdir(), "rpgkit-cjk-font-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const cps = (s: string) => [...s].map(ch => ch.codePointAt(0)!);
// U+3000-30FF, U+4E00-4EFF and U+20BB7 are in the demo subset.
const SUBSET_TEXT = "一丁七万三上下中人、。「」ア𠮷";

describe("fallbackCharacters", () => {
  test("picks what Inter lacks, sorted and unique", () => {
    const got = fallbackCharacters(["A 你好，你。", "“quoted”… — done\n\tend", "�\u0085"]);
    expect(got).toEqual(cps("你好，。").sort((a, b) => a - b));
    for (const cp of cps("A“”…— \n\t")) expect(got).not.toContain(cp);
  });
});

describe("subsetFont", () => {
  const want = cps(SUBSET_TEXT);
  const a = subsetFont(DEMO, [...want, 0x9f8d /* 龍: not in the demo subset */]);
  const b = subsetFont(DEMO, [...want].reverse());

  test("is deterministic", () => {
    expect(a.missing).toEqual([0x9f8d]);
    expect(b.missing).toEqual([]);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  test("keeps source advances, metrics and names", () => {
    const source = parseFontFile(DEMO);
    const out = opentype.parse(a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength));
    expect(out.unitsPerEm).toBe(source.unitsPerEm);
    expect(out.ascender).toBe(source.ascender);
    expect(out.descender).toBe(source.descender);
    expect(out.glyphs.length).toBe(want.length + 1);
    expect(out.glyphs.get(0).name).toBe(".notdef");
    expect(out.getEnglishName("fontFamily")).toBe("Noto Sans CJK SC Subset");
    for (const cp of want) {
      const ch = String.fromCodePoint(cp);
      const g = out.glyphs.get(out.charToGlyphIndex(ch));
      const s = source.glyphs.get(source.charToGlyphIndex(ch));
      expect(g.name).toBe(cp > 0xffff ? `u${cp.toString(16).toUpperCase()}` : `uni${cp.toString(16).toUpperCase()}`);
      expect(g.advanceWidth).toBe(s.advanceWidth);
      expect(g.getPath(0, 0, 1000).getBoundingBox()).toEqual(s.getPath(0, 0, 1000).getBoundingBox());
    }
  });

  test("head stamps are fixed and checksums are valid", () => {
    const bytes = a.bytes;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sum = (from: number, len: number) => {
      let s = 0;
      for (let i = 0; i < len; i += 4) {
        let w = 0;
        for (let k = 0; k < 4; k++) w = w * 256 + (i + k < len ? bytes[from + i + k]! : 0);
        s = (s + w) % 0x100000000;
      }
      return s;
    };
    expect(sum(0, bytes.length)).toBe(0xb1b0afba);
    const numTables = dv.getUint16(4);
    let head = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (String.fromCharCode(...bytes.subarray(rec, rec + 4)) === "head") head = dv.getUint32(rec + 8);
    }
    expect(head).toBeGreaterThan(0);
    const created = dv.getBigUint64(head + 20);
    expect(dv.getBigUint64(head + 28)).toBe(created);
    expect(Number(created) - 2082844800).toBe(1704067200);
  });
});

describe("createFontMeasure", () => {
  const subsetPath = join(scratch, "measure-subset.otf");
  writeFileSync(subsetPath, subsetFont(DEMO, cps(SUBSET_TEXT)).bytes);
  const inter = parseFontFile(INTER);
  const fallback = parseFontFile(subsetPath);
  // ASCII + Latin Inter maps + the subset's CJK + one codepoint no face maps
  // (U+9F8D) and U+FFFD, the tofu entry.
  const chars = [...new Set([...Array.from({ length: 95 }, (_, i) => 32 + i), ...cps("éîï“”…—"), ...cps(SUBSET_TEXT), 0x9f8d, 0xfffd])]
    .sort((x, y) => x - y);

  for (const px of [12, 16]) {
    test(`matches every baked advance at ${px}px`, () => {
      const atlas = bakeSlot(inter, 0, px, false, chars, 1, [fallback]);
      const dv = new DataView(atlas.bytes.buffer, atlas.bytes.byteOffset, atlas.bytes.byteLength);
      const measure = createFontMeasure({ px, fallbacks: [subsetPath], charset: chars });
      const baked = new Map<number, number>();
      for (let i = 0; i < atlas.glyphCount; i++) {
        const o = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
        baked.set(dv.getUint32(o, true), atlas.bytes[o + 6]!);
      }
      expect(baked.size).toBe(chars.length - 1); // every char but the unmapped U+9F8D (U+FFFD is the tofu entry)
      expect(baked.has(0x9f8d)).toBe(false);
      for (const [cp, advance] of baked) expect([cp, measure(String.fromCodePoint(cp))]).toEqual([cp, advance]);
      // A miss advances by the cell width, the core's fallback.
      expect(measure("龍")).toBe(atlas.cellW);
      expect(measure("\u0001")).toBe(atlas.cellW);
      expect(measure("\n")).toBe(0);
      const mixed = "Hi，一人「𠮷」…\n龍�é";
      let sum = 0;
      for (const ch of mixed) sum += ch === "\n" ? 0 : (baked.get(ch.codePointAt(0)!) ?? atlas.cellW);
      expect(measure(mixed)).toBe(sum);
      // CJK cells are wider than Inter's glyphs: a CJK-bearing atlas without
      // an explicit charset still gets the same cell width.
      expect(createFontMeasure({ px, fallbacks: [subsetPath] })("龍")).toBe(atlas.cellW);
    });
  }

  test("bold uses Inter Bold advances", () => {
    const regular = createFontMeasure({ px: 12 });
    const bold = createFontMeasure({ px: 12, bold: true });
    expect(bold("Wide words")).toBeGreaterThan(regular("Wide words"));
  });
});

describe("writeAppCjkFont / checkAppCjkFont", () => {
  test("writes the subset, charset, license, provenance and fonts.json", async () => {
    const appDir = join(scratch, "app");
    const texts = ["export const LINES = ['Hello', '一人上下', '「中」。'];", "ア 𠮷"];
    const result = await writeAppCjkFont({ appDir, texts, source: DEMO });
    expect(result.characters).toBe(fallbackCharacters(texts).length);
    expect(readdirSync(join(appDir, "fonts")).sort()).toEqual([
      "LICENSE-NotoSansCJK.txt",
      "NotoSansCJKsc-subset.md",
      "NotoSansCJKsc-subset.otf",
      "cjk-charset.txt",
    ]);
    expect(readFileSync(join(appDir, "fonts.json"), "utf8")).toBe(
      JSON.stringify({ fallback: ["fonts/NotoSansCJKsc-subset.otf"], characterFiles: ["fonts/cjk-charset.txt"] }, null, 2) + "\n",
    );
    const charset = readFileSync(join(appDir, "fonts/cjk-charset.txt"), "utf8");
    expect(cps(charset)).toEqual(fallbackCharacters(texts));
    expect(result.fontBytes).toBe(readFileSync(join(appDir, "fonts/NotoSansCJKsc-subset.otf")).length);
    expect(createHash("sha256").update(readFileSync(join(appDir, "fonts/NotoSansCJKsc-subset.otf"))).digest("hex"))
      .toBe("48c817bc1b8a7f46a27e99a5118805110e3f24518b1859023ba1e22d1f85d23d");
    // The notice: the source's copyright line, then the OFL text verbatim.
    const notice = readFileSync(join(appDir, "fonts/LICENSE-NotoSansCJK.txt"), "utf8");
    const ofl = readFileSync(join(REPO_ROOT, "vendor/pocketjs/assets/fonts/LICENSE-NotoSansCJK.txt"), "utf8");
    expect(notice.endsWith(ofl)).toBe(true);
    expect(notice).toContain(`Copyright notice: ${parseFontFile(DEMO).getEnglishName("copyright")}`);
    expect(notice).toContain(OFL_TITLE);
    // pak.json ships the notice inside the pak.
    expect(JSON.parse(readFileSync(join(appDir, "pak.json"), "utf8"))).toEqual([
      { key: LICENSE_PAK_KEY, file: "fonts/LICENSE-NotoSansCJK.txt" },
    ]);
    const md = readFileSync(join(appDir, "fonts/NotoSansCJKsc-subset.md"), "utf8");
    expect(md).toContain("2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b");
    expect(md).toContain(`Characters: ${result.characters}`);
    expect(md).not.toContain(scratch);

    expect(checkAppCjkFont(appDir, texts)).toEqual([]);
    const problems = checkAppCjkFont(appDir, [...texts, "七"]);
    expect(problems.some(p => p.includes("cjk-charset.txt") && p.includes("U+4E03"))).toBe(true);
    expect(problems.some(p => p.includes("does not map") && p.includes("U+4E03"))).toBe(true);
  });

  test("a Latin-only app gets no files", async () => {
    const appDir = join(scratch, "latin");
    const result = await writeAppCjkFont({ appDir, texts: ["Hello “world” — café…"], source: DEMO });
    expect(result).toEqual({ characters: 0, fontBytes: 0 });
    expect(existsSync(appDir)).toBe(false);
    expect(checkAppCjkFont(appDir, ["Hello"])).toEqual([]);
  });

  test("a character the source cannot supply is an error", async () => {
    await expect(writeAppCjkFont({ appDir: join(scratch, "bad"), texts: ["龍"], source: DEMO })).rejects.toThrow("U+9F8D");
  });

  test("a missing fonts.json is reported", () => {
    expect(checkAppCjkFont(join(scratch, "none"), ["一"])).toContain("fonts.json is missing");
  });

  for (const variant of CJK_FONT_VARIANTS) {
    test(`${variant} writes and checks the selected regional face`, async () => {
      const appDir = join(scratch, `variant-${variant}`);
      const files = cjkAppFontFiles(variant);
      const texts = ["一丁ア"];
      await writeAppCjkFont({ appDir, texts, source: DEMO, variant });

      expect(JSON.parse(readFileSync(join(appDir, "fonts.json"), "utf8"))).toEqual({
        fallback: [`fonts/${files.font}`],
        characterFiles: [`fonts/${files.charset}`],
      });
      expect(parseFontFile(join(appDir, "fonts", files.font)).getEnglishName("fontFamily")).toBe(files.subsetFamily);
      const notice = readFileSync(join(appDir, "fonts", files.license), "utf8");
      expect(notice).toContain(`${files.subsetFamily}: a subset`);
      expect(notice).toContain(`of ${CJK_FONT_SOURCES[variant].family},`);
      expect(notice).toContain(CJK_FONT_SOURCES[variant].revision);
      expect(notice).toContain(OFL_TITLE);
      const note = readFileSync(join(appDir, "fonts", files.provenance), "utf8");
      expect(note).toContain(`/Sans/OTF/${CJK_FONT_SOURCES[variant].directory}/${CJK_FONT_SOURCES[variant].file}`);
      expect(note).toContain(CJK_FONT_SOURCES[variant].sha256);
      expect(checkAppCjkFont(appDir, texts, variant)).toEqual([]);

      const wrong = variant === "sc" ? "jp" : "sc";
      expect(checkAppCjkFont(appDir, texts, wrong).some(problem => problem.includes("fonts.json does not list"))).toBe(true);
    });
  }
});

describe("license shipping", () => {
  test("an existing pak.json keeps its rows; the license row is added once", async () => {
    const appDir = join(scratch, "with-pak");
    mkdirSync(appDir, { recursive: true });
    const tileset = { key: "TILESET:a", file: "assets/a.bin" };
    writeFileSync(join(appDir, "pak.json"), JSON.stringify([tileset]));
    await writeAppCjkFont({ appDir, texts: ["一"], source: DEMO });
    await writeAppCjkFont({ appDir, texts: ["一"], source: DEMO });
    expect(JSON.parse(readFileSync(join(appDir, "pak.json"), "utf8"))).toEqual([
      tileset,
      { key: LICENSE_PAK_KEY, file: "fonts/LICENSE-NotoSansCJK.txt" },
    ]);
  });

  test("--check fails when the pak would not carry the license", async () => {
    const appDir = join(scratch, "no-license-row");
    await writeAppCjkFont({ appDir, texts: ["一"], source: DEMO });
    expect(checkAppCjkFont(appDir, ["一"])).toEqual([]);
    // A regenerated asset manifest that drops the row (a game's gen-assets
    // rewriting pak.json) is caught.
    writeFileSync(join(appDir, "pak.json"), "[]");
    expect(checkAppCjkFont(appDir, ["一"]).some(p => p.includes(LICENSE_PAK_KEY))).toBe(true);
    writeFileSync(join(appDir, "pak.json"), JSON.stringify(pakManifestWithLicense(appDir)));
    rmSync(join(appDir, "fonts/LICENSE-NotoSansCJK.txt"));
    expect(checkAppCjkFont(appDir, ["一"]).some(p => p.includes("LICENSE-NotoSansCJK.txt is missing"))).toBe(true);
  });

  test("the license files of an app's fallback fonts", () => {
    expect(fontLicenseFiles(join(REPO_ROOT, "tests/fixtures/cjk-text"))).toEqual([
      join(REPO_ROOT, "tests/fixtures/cjk-text/fonts/LICENSE-NotoSansCJK.txt"),
    ]);
    // A fixture borrowing another app's font borrows its license.
    expect(fontLicenseFiles(join(REPO_ROOT, "tests/fixtures/no-truncation"))).toEqual([
      join(REPO_ROOT, "tests/fixtures/cjk-text/fonts/LICENSE-NotoSansCJK.txt"),
    ]);
    expect(fontLicenseFiles(join(REPO_ROOT, "examples/sunstone"))).toEqual([]);
  });

  test("web license destinations keep only the basename on every host path syntax", () => {
    expect(fontLicenseOutputName("D:\\work\\game\\fonts\\LICENSE-Inter.txt")).toBe("LICENSE-Inter.txt");
    expect(fontLicenseOutputName("\\\\server\\share\\fonts\\LICENSE-Noto.txt")).toBe("LICENSE-Noto.txt");
    expect(fontLicenseOutputName("/work/game/fonts/LICENSE-Inter.txt")).toBe("LICENSE-Inter.txt");
  });

  test("the web site copies the license beside the game and links it", () => {
    const dir = join(scratch, "site-game");
    mkdirSync(dir, { recursive: true });
    const names = copyFontLicenses(join(REPO_ROOT, "tests/fixtures/cjk-text"), dir);
    expect(names).toEqual(["LICENSE-NotoSansCJK.txt"]);
    expect(readFileSync(join(dir, "LICENSE-NotoSansCJK.txt"), "utf8")).toContain(OFL_TITLE);
    expect(copyFontLicenses(join(REPO_ROOT, "examples/sunstone"), join(scratch, "latin-site"))).toEqual([]);
  });
});

/** Every app directory in the repo that bakes from a fallback font. */
function fallbackApps(): string[] {
  const out: string[] = [];
  for (const parent of ["examples", "tests/fixtures", "tools"]) {
    for (const name of readdirSync(join(REPO_ROOT, parent))) {
      const dir = join(REPO_ROOT, parent, name);
      if (existsSync(join(dir, "fonts.json"))) out.push(dir);
    }
  }
  return out.sort();
}

describe("built paks carry the font license", () => {
  test("every app with a fallback font ships the notice in its pak (density 1, 2 and 3 builds)", () => {
    const apps = fallbackApps();
    expect(apps.map(dir => dir.slice(REPO_ROOT.length + 1))).toEqual(
      expect.arrayContaining(["tests/fixtures/cjk-text", "tests/fixtures/no-truncation"]),
    );
    let checked = 0;
    for (const dir of apps) {
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      for (const pak of [`dist/${name}.pak`, `dist/density-2/${name}.pak`, `dist/density-3/${name}.pak`]) {
        const path = join(REPO_ROOT, pak);
        if (!existsSync(path)) continue;
        const entry = unpack(new Uint8Array(readFileSync(path))).find(blob => blob.key === LICENSE_PAK_KEY);
        expect(entry, `${pak} has no ${LICENSE_PAK_KEY}`).toBeDefined();
        const text = new TextDecoder().decode(entry!.data as Uint8Array);
        expect(text).toContain(OFL_TITLE);
        expect(text).toContain("Copyright notice: © 2014-2021 Adobe");
        checked++;
      }
    }
    // cjk-text at 1x/2x/3x and no-truncation are built by build:example.
    expect(checked).toBeGreaterThanOrEqual(4);
  });
});

describe("decoded text inventory", () => {
  test("module literals come out decoded: escapes, templates, JSX text", () => {
    const file = join(scratch, "escapes.tsx");
    writeFileSync(
      file,
      [
        'export const A = "\\u{20BB7}野";',
        "export const B = '\\u4e00\\u4e01';",
        "export const C = `x\\u4e03${A}\\u{4E07}`;",
        "export const D = () => <Text>三上</Text>;",
        "// a comment with 龍 is not display text",
      ].join("\n"),
    );
    const source = readFileSync(file, "utf8");
    expect(source).not.toContain("𠮷"); // only the escape is in the file
    const strings = fileStrings(file);
    const chars = new Set(strings.join(""));
    for (const ch of "𠮷野一丁七万三上") expect(chars.has(ch)).toBe(true);
    expect(chars.has("龍")).toBe(false);
  });

  test("JSON documents give their decoded keys and values, nested JSON too", () => {
    const doc = join(scratch, "project.json");
    writeFileSync(doc, '{"title":"\\u4e00","events":[{"text":"\\ud842\\udfb7"}],"\\u4e01":1}');
    expect(new Set(fileStrings(doc).join(""))).toEqual(new Set([..."title一eventstext𠮷丁"]));
    const module = join(scratch, "serialized.ts");
    writeFileSync(module, `export const DOC = '{"line":"\\\\u4e07"}';`);
    expect(fileStrings(module).join("")).toContain("万");
  });

  test("other text is read as is and with \\u escapes decoded", () => {
    const po = join(scratch, "strings.po");
    writeFileSync(po, 'msgid "hi"\nmsgstr "上\\u{20BB7}"\n');
    const text = fileStrings(po).join("");
    expect(text).toContain("上");
    expect(text).toContain("𠮷");
  });

  test("an app entry brings in the kit's and the framework's literals", () => {
    const modules = appModules(join(REPO_ROOT, "tests/fixtures/cjk-text/cjk-text.tsx"));
    expect(modules.some(m => m.endsWith("/src/ui/DialogBox.tsx"))).toBe(true);
    expect(modules.some(m => m.endsWith("/tests/fixtures/cjk-text/fixture-data.ts"))).toBe(true);
    expect(modules.some(m => m.includes("/vendor/pocketjs/framework/"))).toBe(true);
    expect(modules.some(m => m.endsWith("styles.generated.ts"))).toBe(false);
  });
});

describe("--check sees escaped characters", () => {
  const CLI = join(REPO_ROOT, "tools/cjk-font.ts");
  const run = (...args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
  };

  test("rejects an unknown regional variant", () => {
    const result = run(`--app=${scratch}`, "--variant=wrong");
    expect(result.code).toBe(2);
    expect(result.out).toContain("expected sc|tc|jp|kr");
  });

  test("a character only written as an escape fails --check until the subset is regenerated", async () => {
    const appDir = join(scratch, "escaped-app");
    mkdirSync(appDir, { recursive: true });
    const text = join(appDir, "text.ts");
    writeFileSync(text, 'export const LINE = "\\u4e00\\u{20BB7}";\n');
    // An earlier subset generated before the escaped line was added.
    await writeAppCjkFont({ appDir, texts: ["一"], source: DEMO });

    const before = run(`--app=${appDir}`, `--entry=${text}`, "--check");
    expect(before.code).toBe(1);
    expect(before.out).toContain("U+20BB7");

    const regenerate = run(`--app=${appDir}`, `--entry=${text}`, `--source=${DEMO}`);
    expect(regenerate.code).toBe(0);
    const after = run(`--app=${appDir}`, `--entry=${text}`, "--check");
    expect(after.out).toContain("covered");
    expect(after.code).toBe(0);
    expect(readFileSync(join(appDir, "fonts/cjk-charset.txt"), "utf8")).toContain("𠮷");
  });

  test("a project document is read decoded (--scan)", async () => {
    const appDir = join(scratch, "doc-app");
    const doc = join(scratch, "doc-app.json");
    writeFileSync(doc, JSON.stringify({ text: "x" }).replace("x", "\\u4e03"));
    await writeAppCjkFont({ appDir, texts: ["一"], source: DEMO });
    const before = run(`--app=${appDir}`, "--no-entry", `--scan=${doc}`, "--check");
    expect(before.code).toBe(1);
    expect(before.out).toContain("U+4E03");
  });
});

describe("committed app subsets", () => {
  const app = join(REPO_ROOT, "tests/fixtures/cjk-text");
  const inventory = () => appTextInventory({ entries: [join(app, "cjk-text.tsx")] });
  const regionalApps = [
    { app: join(REPO_ROOT, "examples/cjk-multi/jp"), entry: "cjk-multi-jp.tsx", variant: "jp" },
    { app: join(REPO_ROOT, "examples/cjk-multi/tc"), entry: "cjk-multi-tc.tsx", variant: "tc" },
  ] as const;

  test("the CJK text fixture's subset covers its decoded text (U+20BB7 is only an escape there)", () => {
    expect(readFileSync(join(app, "fixture-data.ts"), "utf8")).not.toContain("𠮷");
    const texts = inventory();
    expect(fallbackCharacters(texts)).toContain(0x20bb7);
    expect(checkAppCjkFont(app, texts)).toEqual([]);
    expect(checkAppCjkFont(app, [...texts, "\u{9F98}"]).length).toBeGreaterThan(0);
  });

  test("the committed charset is exactly the inventory's fallback characters", () => {
    expect(cps(readFileSync(join(app, "fonts/cjk-charset.txt"), "utf8"))).toEqual(fallbackCharacters(inventory()));
  });

  test("the regional examples have exact inventories, report missing glyphs, and expose their OFL", () => {
    for (const regional of regionalApps) {
      const texts = appTextInventory({ entries: [join(regional.app, regional.entry)] });
      expect(cps(readFileSync(join(regional.app, "fonts/cjk-charset.txt"), "utf8"))).toEqual(fallbackCharacters(texts));
      expect(checkAppCjkFont(regional.app, texts, regional.variant)).toEqual([]);
      const missing = checkAppCjkFont(regional.app, [...texts, "龘"], regional.variant);
      expect(missing.some(problem => problem.includes("cjk-charset.txt") && problem.includes("U+9F98"))).toBe(true);
      expect(missing.some(problem => problem.includes("does not map") && problem.includes("U+9F98"))).toBe(true);
      expect(fontLicenseFiles(regional.app)).toEqual([join(regional.app, "fonts/LICENSE-NotoSansCJK.txt")]);
    }
  });

  test("the undeclared SC app files retain their reviewed bytes", () => {
    const digest = (file: string) => createHash("sha256").update(readFileSync(join(app, file))).digest("hex");
    expect({
      font: digest("fonts/NotoSansCJKsc-subset.otf"),
      charset: digest("fonts/cjk-charset.txt"),
      config: digest("fonts.json"),
      pak: digest("pak.json"),
    }).toEqual({
      font: "92da6341be4d84473e9bbd13c8d2eb1c94b32dd30c6547f048f3c9168dda70e8",
      charset: "e0f88a185dd59090942c48cf3c13c33c3f36ca12b59542f47696ccba7b86cbb9",
      config: "3175f6980d75770e083e3c64b134cc5c16359d5ee82f6405678e6d0656e7a538",
      pak: "27db709343804904b1ccd177dd6a715011d83e4f30b3b9b4969b1c3599f34419",
    });
  });

  test("the undeclared SC app retains its reviewed pak bytes at every density", () => {
    const digest = (file: string) => createHash("sha256").update(readFileSync(join(REPO_ROOT, file))).digest("hex");
    expect({
      density1: digest("dist/cjk-text.pak"),
      density2: digest("dist/density-2/cjk-text.pak"),
      density3: digest("dist/density-3/cjk-text.pak"),
    }).toEqual({
      density1: "f04a87d82c742de6b58835f4132f93973db8005d8e787cbda6b2580be5c73308",
      density2: "b8b5dd2b07bd51ac275de2a2fbe807bf8db2bba9a46df69679cdbfd394081419",
      density3: "2f84a7245a784f544c3e755c19bfdb433306eb35228b8b993a7013b1e0aad225",
    });
  });
});
