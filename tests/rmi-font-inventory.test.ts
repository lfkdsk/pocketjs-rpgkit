import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fallbackCharacters, parseFontFile } from "../tools/lib/cjk-font.ts";
import { appTextInventory } from "../tools/lib/text-inventory.ts";

const APP = join(import.meta.dir, "fixtures", "rmi-play");
const codepoints = (text: string): number[] => [...text].map((character) => character.codePointAt(0)!);

describe("RPG Maker GameView font inventory", () => {
  test("generated character coverage exactly follows imported display text", () => {
    const inventory = appTextInventory({
      entries: [join(APP, "rmi-play.tsx")],
      files: [join(APP, "games.ts")],
    });
    const charset = readFileSync(join(APP, "fonts", "cjk-charset.txt"), "utf8");
    expect(codepoints(charset)).toEqual(fallbackCharacters(inventory));
  });

  test("a broad fallback covers imported characters beyond the small fixture subset", () => {
    const config = JSON.parse(readFileSync(join(APP, "fonts.json"), "utf8"));
    expect(config.fallback).toContain("../../../tools/preview/fonts/NotoSansCJKsc-preview.otf");

    // U+4E03 is intentionally absent from the fixture's original hand-sized
    // subset. A generated project can request it through cjk-charset.txt and
    // the committed broad face supplies a real glyph instead of tofu.
    const small = parseFontFile(join(APP, "fonts", "NotoSansCJKsc-subset.otf"));
    const broad = parseFontFile(join(APP, "..", "..", "..", "tools", "preview", "fonts", "NotoSansCJKsc-preview.otf"));
    expect(small.charToGlyphIndex("七")).toBe(0);
    expect(broad.charToGlyphIndex("七")).toBeGreaterThan(0);
  });
});
