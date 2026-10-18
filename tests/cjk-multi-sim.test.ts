// Japanese and Traditional Chinese language-app example. The real battle,
// dialog/shop and save-menu components render at PSP density and web density;
// atlas assertions prove that shared Han codepoints came from the selected
// regional Noto face, not merely that a glyph exists.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { bakeSlot } from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import { decodePng, unpack } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { parseFontFile } from "../tools/lib/cjk-font.ts";
import type { CjkMultiPage, CjkMultiStrings } from "../examples/cjk-multi/app.tsx";
import { JAPANESE_STRINGS } from "../examples/cjk-multi/strings-jp.ts";
import { TRADITIONAL_CHINESE_STRINGS } from "../examples/cjk-multi/strings-tc.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const PROBES = [..."骨令返曜"];
const PAGES: readonly CjkMultiPage[] = ["dialog", "choices", "shop", "battle", "save"];

const CASES = [
  { variant: "jp", app: "cjk-multi-jp", strings: JAPANESE_STRINGS },
  { variant: "tc", app: "cjk-multi-tc", strings: TRADITIONAL_CHINESE_STRINGS },
] as const;

const CELL_HASHES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "jp:1": { 骨: "444d20c4a60e0732", 令: "90dc94e2b67ff4ea", 返: "5d77239f1e6b0b46", 曜: "1250c3e25ce6a530" },
  "jp:2": { 骨: "51624e5f88355321", 令: "0bc11e8bf9aa44c3", 返: "b2933d37d89f8d34", 曜: "7b0f83af133ce24c" },
  "tc:1": { 骨: "fb23042d40ea58d8", 令: "dd276f4c4f1e3a94", 返: "0bf37d2eff75bf90", 曜: "f49ee620befa7b85" },
  "tc:2": { 骨: "a50637937dfac1a0", 令: "79365af84f11a079", 返: "67d301200a470618", 曜: "e079497faf9c7b7d" },
};

const ready = CASES.every(({ app }) =>
  existsSync(join(DIST, `${app}.js`)) && existsSync(join(DIST, `${app}.pak`)) &&
  existsSync(join(DIST, "density-2", `${app}.js`)) && existsSync(join(DIST, "density-2", `${app}.pak`))) &&
  existsSync(join(ROOT, "vendor/pocketjs/hosts/web/pocketjs.wasm"));
if (!ready) console.warn("CJK multi sim tests skipped: run `bun run build:wasm && bun run build:example cjk-multi-jp cjk-multi-tc`");
const simDescribe = ready ? describe : describe.skip;

interface TreeNode {
  t?: string;
  x?: string;
  k?: TreeNode[];
}

function treeText(node: TreeNode): string {
  if (node.t === "#text") return node.x ?? "";
  return (node.k ?? []).map(treeText).join("");
}

function frame(world: SimWorld): void {
  world.frame(0);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function expectedText(page: CjkMultiPage, s: CjkMultiStrings): readonly string[] {
  switch (page) {
    case "dialog": return s.dialog;
    case "choices": return [s.choicePrompt, ...s.choices];
    case "shop": return [s.itemNames.medicine, s.itemNames.map, s.shopText["shop.buy"]!];
    case "battle": return [s.battleTitle, s.battleRows[0], ...s.battleCommands, s.battleMessage];
    case "save": return [s.saveTitle, s.saveText["save.toSlot"]!, s.saveText["save.fromSlot"]!];
  }
}

async function golden(name: string, rgba: Uint8Array, width: number, height: number): Promise<void> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.CJK_MULTI_UPDATE_GOLDENS) await Bun.write(url, encodePNG(rgba, width, height));
  const png = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(rgba, name).toEqual(decodePng(png).rgba);
}

interface Atlas {
  bytes: Uint8Array;
  codepoints: number[];
  cells: ReadonlyMap<number, Uint8Array>;
}

function atlas(path: string): Atlas {
  const blob = unpack(new Uint8Array(readFileSync(path))).find((entry) => entry.key === "ui:font.0");
  if (!blob) throw new Error(`${path} has no ui:font.0`);
  const bytes = blob.data as Uint8Array;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const glyphCount = view.getUint16(6, true);
  const cellBytes = bytes[8]! * bytes[9]! * bytes[14]! * bytes[14]!;
  const coverage = FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE;
  const codepoints: number[] = [];
  const cells = new Map<number, Uint8Array>();
  for (let i = 0; i < glyphCount; i++) {
    const offset = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    const cp = view.getUint32(offset, true);
    const gid = view.getUint16(offset + 4, true);
    codepoints.push(cp);
    cells.set(cp, bytes.subarray(coverage + gid * cellBytes, coverage + (gid + 1) * cellBytes));
  }
  return { bytes, codepoints, cells };
}

function cellHash(cell: Uint8Array): string {
  return createHash("sha256").update(cell).digest("hex").slice(0, 16);
}

simDescribe("regional CJK example", () => {
  for (const { variant, app, strings } of CASES) {
    for (const density of [1, 2] as const) {
      const physical = density === 1 ? { width: 480, height: 272 } : { width: 960, height: 544 };
      const bundle = join(DIST, density === 1 ? app : join("density-2", app));

      test(`${strings.locale} shows every UI surface at ${physical.width}x${physical.height}`, async () => {
        const world = await bootWorld(bundle, 60, undefined, undefined, {
          width: 480,
          height: 272,
          rasterDensity: density,
          renderScale: density,
        });
        frame(world);
        expect(globalThis.__cjkMulti?.locale).toBe(strings.locale);
        for (const page of PAGES) {
          globalThis.__cjkMulti!.show(page);
          frame(world);
          frame(world);
          const text = treeText(world.getTree() as TreeNode);
          for (const wanted of expectedText(page, strings)) expect(text, `${page}: ${wanted}`).toContain(wanted);
          expect(text).not.toContain("�");
          await golden(
            `cjk-multi.${variant}.${page}.${physical.width}x${physical.height}`,
            world.render().slice(),
            physical.width,
            physical.height,
          );
        }
      });

      test(`${strings.locale} atlas pixels come from Noto CJK ${variant.toUpperCase()} at density ${density}`, () => {
        const pak = `${bundle}.pak`;
        const actual = atlas(pak);
        const inter = parseFontFile(join(ROOT, "vendor/pocketjs/assets/fonts/Inter-Regular.ttf"));
        const fallback = parseFontFile(join(ROOT, `examples/cjk-multi/${variant}/fonts/NotoSansCJK${variant}-subset.otf`));
        const expected = bakeSlot(inter, 0, 12, false, actual.codepoints, density, [fallback]).bytes;
        expect(actual.bytes, "the complete slot matches a direct render of the selected face").toEqual(expected);

        for (const glyph of PROBES) {
          const cell = actual.cells.get(glyph.codePointAt(0)!);
          expect(cell, `${glyph} is mapped`).toBeDefined();
          expect(cellHash(cell!), `${glyph} regional bitmap`).toBe(CELL_HASHES[`${variant}:${density}`]![glyph]);
        }
      });
    }
  }

  test("the reviewed JP and TC Han probes are visibly different", () => {
    for (const density of [1, 2] as const) {
      const prefix = density === 1 ? DIST : join(DIST, "density-2");
      const jp = atlas(join(prefix, "cjk-multi-jp.pak"));
      const tc = atlas(join(prefix, "cjk-multi-tc.pak"));
      for (const glyph of PROBES) {
        expect(cellHash(jp.cells.get(glyph.codePointAt(0)!)!)).not.toBe(cellHash(tc.cells.get(glyph.codePointAt(0)!)!));
      }
    }
  });
});
