// tests/text-break.test.ts — the pure line breaker (src/engine/text-break.ts)
// and the row flow over it (src/ui/text-flow.ts), with a fixed-width
// measurer (CJK 12 px, everything else 6 px) and with the build-time
// measurer over the real fixture fonts.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  NO_LINE_END,
  NO_LINE_START,
  breakLine,
  breakText,
  fitText,
  hasCjk,
  hasForcedBreak,
  isCjk,
  paginateText,
  scalarLength,
  sliceScalars,
  type Measure,
} from "../src/engine/text-break.ts";
import { flowRows, revealRows } from "../src/ui/text-flow.ts";
import { DEFAULT_PLAYER_NAME, substitutePlayerName } from "../src/engine/player-name.ts";
import { createFontMeasure } from "../tools/lib/font-measure.ts";
import { PAGES } from "./fixtures/cjk-text/fixture-data.ts";

const mono: Measure = (s) => [...s].reduce((w, ch) => w + (ch === "\n" ? 0 : isCjk(ch.codePointAt(0)!) ? 12 : 6), 0);
const texts = (rows: { text: string }[]) => rows.map((row) => row.text);
const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch);

// Independent minimum Japanese kinsoku oracle. Do not derive this from the
// production arrays: membership and layout assertions below must fail when a
// production rule is accidentally removed.
const JA_MIN_NO_START = [
  ..."、。，．・：；？！‼⁇⁈⁉ー〜～…‥—–）］｝〕〉》」』】〙〗〛〞’”｠»›",
  ..."ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ",
  ..."゙゚゛゜ヽヾゝゞ｡､･｣ﾞﾟ",
];
const JA_MIN_NO_END = [..."（［｛〔〈《「『【〘〖〚〝‘“｟«‹｢"];

describe("breakLine", () => {
  test("a line that fits is one row, untouched", () => {
    expect(breakLine("Hello there", 200, mono)).toEqual([{ text: "Hello there", start: 0, end: 11 }]);
    expect(breakLine("", 10, mono)).toEqual([{ text: "", start: 0, end: 0 }]);
  });

  test("CJK breaks between characters", () => {
    expect(texts(breakLine("一二三四五六七", 36, mono))).toEqual(["一二三", "四五六", "七"]);
  });

  test("Latin breaks at spaces and the spaces hang", () => {
    expect(texts(breakLine("Route 120 ahead", 40, mono))).toEqual(["Route", "120", "ahead"]);
    const rows = breakLine("aa bb", 18, mono);
    expect(rows).toEqual([{ text: "aa", start: 0, end: 2 }, { text: "bb", start: 3, end: 5 }]);
  });

  test("a Latin word next to CJK moves to the next row whole", () => {
    expect(texts(breakLine("训练师Tuxemon中心", 60, mono))).toEqual(["训练师", "Tuxemon中", "心"]);
  });

  test("no-line-start punctuation takes the previous character with it", () => {
    expect(texts(breakLine("一二三。四五", 36, mono))).toEqual(["一二", "三。四", "五"]);
    expect(texts(breakLine("一二三！？四", 36, mono))).toEqual(["一二", "三！？", "四"]);
  });

  test("no-line-end brackets move down to what they open", () => {
    // "「" may not end row one; "」" may not start row three.
    expect(texts(breakLine("一二「三四」", 36, mono))).toEqual(["一二", "「三", "四」"]);
  });

  test("Japanese line-start kinsoku uses an independent minimum oracle", () => {
    const production = new Set(NO_LINE_START);
    for (const forbidden of JA_MIN_NO_START) {
      const cp = forbidden.codePointAt(0)!;
      expect(production.has(cp), `missing no-line-start U+${cp.toString(16).toUpperCase()}`).toBe(true);
      expect(texts(breakLine(`甲乙${forbidden}丙`, 24, mono)), `layout for U+${cp.toString(16).toUpperCase()}`).toEqual([
        "甲",
        `乙${forbidden}`,
        "丙",
      ]);
    }
  });

  test("Japanese line-end kinsoku uses an independent minimum oracle", () => {
    const production = new Set(NO_LINE_END);
    for (const forbidden of JA_MIN_NO_END) {
      const cp = forbidden.codePointAt(0)!;
      expect(production.has(cp), `missing no-line-end U+${cp.toString(16).toUpperCase()}`).toBe(true);
      expect(texts(breakLine(`甲${forbidden}乙丙`, 24, mono)), `layout for U+${cp.toString(16).toUpperCase()}`).toEqual([
        "甲",
        `${forbidden}乙`,
        "丙",
      ]);
    }
  });

  test("Japanese combining marks, halfwidth punctuation, and wave dash stay attached", () => {
    expect(texts(breakLine("あいか\u3099き", 36, mono))).toEqual(["あい", "か\u3099き"]);
    expect(texts(breakLine("あいう〜え", 36, mono))).toEqual(["あい", "う〜え"]);
    expect(texts(breakLine("あいう｡え", 36, mono))).toEqual(["あい", "う｡え"]);
    expect(texts(breakLine("あいう｢え", 48, mono))).toEqual(["あいう", "｢え"]);
  });

  test("an unbreakable run wider than the row is cut by code point", () => {
    expect(texts(breakLine("abcdefghij", 24, mono))).toEqual(["abcd", "efgh", "ij"]);
    const rows = texts(breakLine("\u{20BB7}\u{20BB7}\u{20BB7}", 24, mono));
    expect(rows).toEqual(["\u{20BB7}\u{20BB7}", "\u{20BB7}"]);
  });

  test("hasForcedBreak tells a last-resort cut from a legal break", () => {
    const forced = (text: string, width: number) => hasForcedBreak(text, breakText(text, width, mono));
    expect(forced("abcdefghij", 24)).toBe(true); // a word cut between letters
    expect(forced("Route 120 ahead", 40)).toBe(false); // breaks at spaces
    expect(forced("一二三四五六七", 36)).toBe(false); // between Han characters
    expect(forced("训练师Tuxemon中心", 60)).toBe(false);
    expect(forced("\u{20BB7}\u{20BB7}\u{20BB7}", 24)).toBe(false); // supplementary Han
    expect(forced("ab\ncd", 200)).toBe(false); // an authored break
    expect(forced("一二三！？四", 18)).toBe(true); // the "三！？" cluster is cut
    expect(forced("Hello there", 200)).toBe(false); // one row
  });

  test("rows never begin or end with forbidden characters at any width", () => {
    const start = new Set(NO_LINE_START);
    const end = new Set(NO_LINE_END);
    const line = "他说：「你好，世界！」然后（慢慢地）走了……我们去Route 1吧。";
    // Below 36 px the cluster "界！」" (which may not be broken) fits no
    // row and is cut by code point as a last resort; every character still
    // shows.
    for (let width = 12; width < 36; width++) {
      expect(texts(breakLine(line, width, mono)).join("").replace(/ /g, "")).toBe(line.replace(/ /g, ""));
    }
    for (let width = 36; width <= 400; width++) {
      const rows = breakLine(line, width, mono);
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!.text;
        if (r > 0) expect(start.has(row.codePointAt(0)!), `width ${width} row ${r} "${row}"`).toBe(false);
        if (r < rows.length - 1) expect(end.has([...row].at(-1)!.codePointAt(0)!), `width ${width} row ${r} "${row}"`).toBe(false);
      }
      expect(rows.map((row) => row.text).join("").replace(/ /g, "")).toBe(line.replace(/ /g, ""));
    }
  });
});

describe("breakText with the fixture fonts", () => {
  const measure = createFontMeasure({
    px: 12,
    fallbacks: [join(import.meta.dir, "fixtures", "cjk-text", "fonts", "NotoSansCJKsc-subset.otf")],
  });

  test("never splits a Latin word or number next to CJK, at any width", () => {
    const source = substitutePlayerName(PAGES[2]!.join("\n"), DEFAULT_PLAYER_NAME);
    for (let width = 60; width <= 444; width++) {
      const rows = breakText(source, width, measure);
      for (const row of rows.slice(0, -1)) {
        expect(isWord(source[row.end - 1]) && isWord(source[row.end]), `width ${width} splits at ${row.end}`).toBe(false);
        expect(measure(row.text)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("paginates into pages of at most four rows", () => {
    const pages = paginateText(PAGES.flat().join(""), 444, 4, measure);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(4);
  });
});

describe("helpers", () => {
  test("code point counting and slicing", () => {
    expect(scalarLength("ab")).toBe(2);
    expect(scalarLength("\u{20BB7}野")).toBe(2);
    expect(sliceScalars("\u{20BB7}野", 1)).toBe("\u{20BB7}");
    expect(hasCjk("Route 1")).toBe(false);
    expect(hasCjk("Route 1号")).toBe(true);
  });

  test("fitText keeps text that fits and cuts by width otherwise", () => {
    expect(fitText("short", 60, mono)).toBe("short");
    expect(fitText("一二三四五六", 48, mono)).toBe("一二三…");
  });
});

describe("flowRows / revealRows", () => {
  test("authored rows that fit are kept and reveal like the old slicing", () => {
    const flow = flowRows(["The road north.", "Snow."], 400, 4, mono);
    expect(texts(flow.rows)).toEqual(["The road north.", "Snow."]);
    expect(revealRows(flow, 17)).toEqual(["The road north.", "S"]);
    expect(revealRows(flow, 3)).toEqual(["The", ""]);
  });

  test("more rows than the box reflows the page as one paragraph", () => {
    // Wrapped as authored: 一二三 / 四 / 五六 / 七八九 (four rows).
    const flow = flowRows(["一二三四", "五六", "七八九"], 36, 3, mono);
    expect(texts(flow.rows)).toEqual(["一二三", "四五六", "七八九"]);
    expect(revealRows(flow, 5)).toEqual(["一二三", "四", ""]);
  });

  test("text that still does not fit keeps every wrapped row, uncut", () => {
    const source = "一二三四五六七八九十一二三四五六七八九十";
    const flow = flowRows([source], 36, 2, mono);
    expect(flow.rows.length).toBe(7);
    expect(texts(flow.rows).join("")).toBe(source);
    for (const row of flow.rows) {
      expect(row.text).not.toContain("…");
      expect(mono(row.text)).toBeLessThanOrEqual(36);
    }
    expect(revealRows(flow, 4)).toEqual(["一二三", "四", "", "", "", "", ""]);
  });

  test("past the box, authored breaks are kept (no soft reflow)", () => {
    const flow = flowRows(["一二三四五", "六七八", "九十"], 36, 2, mono);
    expect(texts(flow.rows)).toEqual(["一二三", "四五", "六七八", "九十"]);
  });

  test("a soft-joined Latin break shows as a space", () => {
    const flow = flowRows(["aa", "bb", "cc dd"], 30, 2, mono);
    expect(texts(flow.rows)).toEqual(["aa bb", "cc dd"]);
  });
});
