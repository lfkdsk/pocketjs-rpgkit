// The project preview draws a loaded document's Chinese text
// (tools/preview/cjk-glyphs.ts): the run-time baker is the build's baker
// byte for byte, a supplemented atlas equals the atlas a build would bake,
// and over the preview protocol two different Chinese lines draw two
// different, legible pictures, the same picture every time.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bakeSlot as vendorBakeSlot } from "../vendor/pocketjs/framework/compiler/bake-font.ts";
import { fontSlotInfo } from "../vendor/pocketjs/framework/compiler/tailwind.ts";
import { BTN, MAX_FONT_SLOTS } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { bootWorld, type SimWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { bakeSlot } from "../tools/preview/glyph-bake.ts";
import { parseAtlas, supplementAtlas } from "../tools/preview/atlas-merge.ts";
import { slotPx } from "../tools/preview/cjk-glyphs.ts";
import { parseFont } from "../tools/preview/opentype.ts";
import { previewBudgetText } from "../tools/preview/gen-cjk-font.ts";
import { fallbackCharacters } from "../tools/lib/cjk-font.ts";
import { appBundle, appPreflight, fnv1a } from "./helpers/boot.ts";

const ROOT = join(import.meta.dir, "..");
const FONTS = join(ROOT, "vendor/pocketjs/assets/fonts");
const font = (path: string) => parseFont(new Uint8Array(readFileSync(path)));
const inter = font(join(FONTS, "Inter-Regular.ttf"));
const interBold = font(join(FONTS, "Inter-Bold.ttf"));
const cjk = font(join(ROOT, "tools/preview/fonts/NotoSansCJKsc-preview.otf"));
const latin = font(join(ROOT, "tools/preview/fonts/Inter-preview.otf"));
const ASCII = Array.from({ length: 95 }, (_, i) => 32 + i);
const cps = (s: string) => [...new Set([...s].map((ch) => ch.codePointAt(0)!))].sort((a, b) => a - b);
const CHINESE = "从前有一位年轻的训练师，他每天清晨都会去海边散步。「欢迎回来！」：；、？";

describe("run-time baker", () => {
  test("the port bakes exactly what the vendored baker bakes", () => {
    const chars = cps("Hello, world! çé" + CHINESE);
    for (const [face, slot, px, bold] of [[inter, 0, 12, false], [inter, 2, 16, false], [interBold, 9, 16, true]] as const) {
      for (const density of [1, 2, 3]) {
        const ours = bakeSlot(face, slot, px, bold, chars, density, [cjk]);
        const theirs = vendorBakeSlot(face as never, slot, px, bold, chars, density, [cjk as never]);
        expect(Buffer.compare(Buffer.from(ours.bytes), Buffer.from(theirs.bytes)), `slot ${slot} @${density}x`).toBe(0);
      }
    }
  });

  test("slot sizes agree with the compiler's slot table", () => {
    let known = 0;
    for (let slot = 0; slot < MAX_FONT_SLOTS; slot++) {
      let px: number | undefined;
      try {
        px = fontSlotInfo(slot).px;
      } catch {
        px = undefined;
      }
      if (px === undefined) continue;
      expect(slotPx(slot), `slot ${slot}`).toBe(px);
      known++;
    }
    expect(known).toBeGreaterThanOrEqual(19);
  });

  test("a supplemented atlas is the atlas a build bakes with the text in it", () => {
    for (const [slot, px] of [[0, 12], [1, 14], [3, 18]] as const) {
      for (const density of [1, 2]) {
        const base = vendorBakeSlot(inter as never, slot, px, false, ASCII, density, []);
        const full = vendorBakeSlot(inter as never, slot, px, false, cps(String.fromCodePoint(...ASCII) + CHINESE), density, [cjk as never]);
        const merged = supplementAtlas(base.bytes, px, cps(CHINESE), [latin, cjk]);
        expect(merged.missing).toEqual([]);
        expect(merged.added).toEqual(cps(CHINESE));
        expect(Buffer.compare(Buffer.from(merged.bytes), Buffer.from(full.bytes)), `slot ${slot} @${density}x`).toBe(0);
      }
    }
  });

  test("Latin beyond ASCII comes from the Inter subset with Inter's advances", () => {
    const extra = cps("“”‘’…—–·éü€→");
    const base = vendorBakeSlot(inter as never, 0, 12, false, ASCII, 2, []);
    const full = parseAtlas(vendorBakeSlot(inter as never, 0, 12, false, cps(String.fromCodePoint(...ASCII, ...extra)), 2, []).bytes);
    const merged = supplementAtlas(base.bytes, 12, extra, [latin, cjk]);
    expect(merged.missing).toEqual([]);
    const got = parseAtlas(merged.bytes);
    expect(got.cellW).toBe(full.cellW);
    // Same cmap (codepoint, gid, advance, xoff) as the build.
    expect(got.entries).toEqual(full.entries);
  });

  test("nothing to add returns the base atlas itself; unknown characters are reported", () => {
    const base = vendorBakeSlot(inter as never, 0, 12, false, ASCII, 1, []).bytes;
    expect(supplementAtlas(base, 12, cps("Hello"), [latin, cjk]).bytes).toBe(base);
    const rare = supplementAtlas(base, 12, cps("一\u{2A6D6}"), [latin, cjk]);
    expect(rare.added).toEqual([0x4e00]);
    expect(rare.missing).toEqual([0x2a6d6]);
  });

  test("the budget covers the GB2312 level-1 hanzi", () => {
    const wanted = fallbackCharacters([previewBudgetText()]);
    const hanzi = wanted.filter((cp) => cp >= 0x4e00 && cp <= 0x9fff);
    expect(hanzi.length).toBe(3755);
    for (const cp of hanzi) expect(cjk.charToGlyphIndex(String.fromCodePoint(cp)), `U+${cp.toString(16)}`).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The preview app in the sim, driven through its protocol hook
// ---------------------------------------------------------------------------

const preflight = appPreflight("preview");
const simDescribe = preflight.ok ? describe : describe.skip;
if (!preflight.ok) console.warn(`preview-glyphs: ${preflight.reason}`);

/** The preview demo's sample project with the gardener saying `lines`. */
function sampleDocument(lines: string[], uiText?: Record<string, string>): string {
  const html = readFileSync(join(ROOT, "tools/web/preview-demo.html"), "utf8");
  const json = html.match(/<script type="application\/json" id="sample-project">([\s\S]*?)<\/script>/)![1]!;
  const doc = JSON.parse(json);
  doc.maps[0].events[0].pages[0].commands[0].lines = lines;
  if (uiText) doc.uiText = uiText;
  return JSON.stringify(doc);
}

interface PreviewHook {
  load(document: unknown): { glyphs?: { added: number; missing: string } };
  start(target: unknown): unknown;
  state(): { message: { kind: string; text: string } | null };
}
const hook = () => (globalThis as { __rpgkitPreview?: PreviewHook }).__rpgkitPreview!;

const LINE_A = ["园丁：欢迎来到预览的小院子。", "这个世界是一段粘贴进来的文档。"];
const LINE_B = ["园丁：明天早上记得给花浇水，", "别忘了关上东边那扇木门。"];
const LINE_EN = ["GARDENER: Welcome to the preview yard.", "This world arrived as a pasted JSON document."];
/** Plane-2 ideographs outside the budget, as many per row as LINE_A: they
 *  draw as boxes. */
const LINE_TOFU = LINE_A.map((row, r) => [...row].map((_, i) => String.fromCodePoint(0x2a6b0 + r * 20 + i)).join(""));

simDescribe("the preview draws a loaded document's Chinese text", () => {
  let world: SimWorld;
  // PREVIEW_GLYPH_SHOTS=<dir> writes each frame there as a PNG for a look.
  const SHOTS = process.env.PREVIEW_GLYPH_SHOTS ?? "";
  const shoot = SHOTS !== "";

  beforeAll(async () => {
    world = await bootWorld(appBundle("preview"), 60);
    world.frame(0);
  });

  const pump = (n: number, buttons = 0) => {
    for (let i = 0; i < n; i++) world.frame(buttons);
  };

  /** Load a document whose gardener says `lines`, talk to him, let the
   *  typewriter finish, and return the load reply and the frame. */
  function talk(lines: string[], name: string, uiText?: Record<string, string>) {
    const load = hook().load(sampleDocument(lines, uiText));
    pump(2);
    hook().start({ kind: "tile", map: "yard", x: 5, y: 3, dir: "up" });
    pump(4);
    pump(1, BTN.CIRCLE);
    pump(240);
    const message = hook().state().message;
    const frame = world.render().slice();
    if (shoot) {
      mkdirSync(SHOTS, { recursive: true });
      Bun.write(join(SHOTS, `${name}.png`), encodePNG(frame, 480, 272));
    }
    return { load, message, frame, hash: fnv1a(frame) };
  }

  test("two different Chinese lines draw two different pictures with real glyphs", () => {
    const english = talk(LINE_EN, "english");
    expect(english.load.glyphs).toEqual({ added: 0, missing: "" });
    expect(english.message?.text).toBe(LINE_EN.join("\n"));

    const a = talk(LINE_A, "chinese-a");
    const b = talk(LINE_B, "chinese-b");
    const tofu = talk(LINE_TOFU, "tofu");
    expect(a.message?.text).toBe(LINE_A.join("\n"));
    expect(b.message?.text).toBe(LINE_B.join("\n"));
    expect(a.load.glyphs!.missing).toBe("");
    expect(a.load.glyphs!.added).toBe(new Set([...LINE_A.join("")].filter((ch) => ch.codePointAt(0)! > 0x7e)).size);
    expect(b.load.glyphs!.missing).toBe("");
    expect(tofu.load.glyphs!.missing).toBe([...new Set(LINE_TOFU.join(""))].sort().join(""));

    // Before the fix both Chinese lines drew identical boxes.
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).not.toBe(tofu.hash);
    expect(b.hash).not.toBe(tofu.hash);

    // Legible glyphs, not boxes: every box is the same hollow outline, so a
    // row of boxes repeats one pattern, while a row of ideographs has a
    // different pattern in nearly every 12 px cell. A wider baked atlas may
    // phase the same tofu outline across five of those fixed sampling cells;
    // real ideographs still occupy at least nine distinct cells. Cells are
    // cut from the first text row of the dialog box (light ink on the dark
    // panel).
    const distinctCells = (frame: Uint8Array) => {
      const lit = (x: number, y: number) => {
        const i = (y * 480 + x) * 4;
        return frame[i]! + frame[i + 1]! + frame[i + 2]! > 450;
      };
      let x0 = 0;
      for (let x = 12; x < 100 && !x0; x++) for (let y = 180; y < 198; y++) if (lit(x, y)) x0 = x;
      const cells = new Set<string>();
      for (let c = 0; c < 10; c++) {
        let key = "";
        for (let y = 180; y < 198; y++) for (let x = x0 + c * 12; x < x0 + c * 12 + 12; x++) key += lit(x, y) ? "1" : "0";
        cells.add(key);
      }
      return cells.size;
    };
    expect(distinctCells(a.frame)).toBeGreaterThanOrEqual(9);
    expect(distinctCells(b.frame)).toBeGreaterThanOrEqual(9);
    expect(distinctCells(tofu.frame)).toBeLessThanOrEqual(5);

    // The same document draws the same picture whatever was loaded before.
    const again = talk(LINE_A, "chinese-a-again");
    expect(again.hash).toBe(a.hash);
    // A Latin document after Chinese ones draws exactly as on a fresh page.
    const englishAgain = talk(LINE_EN, "english-again");
    expect(englishAgain.load.glyphs).toEqual({ added: 0, missing: "" });
    expect(englishAgain.hash).toBe(english.hash);
  }, 60_000);

  test("a document's uiText replaces the kit's words in the play-test, glyphs baked", () => {
    const legendText = () => {
      const find = (node: { n?: string; t?: string; x?: string; k?: unknown[] }): string | null => {
        if (node.n === "rpgkit-message-legend") {
          const texts: string[] = [];
          const walk = (n: { t?: string; x?: string; k?: unknown[] }) => {
            if (n.t === "#text" && n.x) texts.push(n.x);
            for (const c of (n.k ?? []) as { t?: string; x?: string; k?: unknown[] }[]) walk(c);
          };
          walk(node);
          return texts.join("");
        }
        for (const c of (node.k ?? []) as { n?: string; t?: string; x?: string; k?: unknown[] }[]) {
          const hit = find(c);
          if (hit !== null) return hit;
        }
        return null;
      };
      return find(world.getTree() as { k?: unknown[] });
    };
    const english = talk(LINE_EN, "legend-english");
    expect(legendText()).toContain("next");
    const zh = talk(LINE_EN, "legend-chinese", { "legend.next": "下一页" });
    expect(zh.load.glyphs).toEqual({ added: 3, missing: "" });
    expect(legendText()).toContain("下一页");
    expect(legendText()).not.toContain("next");
    expect(zh.hash).not.toBe(english.hash);
  }, 60_000);
});
