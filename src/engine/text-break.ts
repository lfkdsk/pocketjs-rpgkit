// src/engine/text-break.ts — line breaking for mixed Latin / CJK text.
//
// Pure functions shared by the kit's text boxes (they measure with the
// running core's baked font) and by build-time importers (they measure with
// the same font files, tools/lib/font-measure.ts), so a page an importer cut
// to four rows lays out as the same four rows on the device.
//
// Rules, a simplified UAX #14 plus the common Chinese / Japanese kinsoku subset:
//   - a space run is a break opportunity; the spaces hang at the end of the
//     row (they are not drawn and do not count against the width);
//   - next to a CJK character (Han, kana, Hangul, CJK and fullwidth
//     punctuation) a break is allowed on either side;
//   - between two non-CJK characters there is no break, so a Latin word or a
//     number ("Route 1", "HP 120", "3.5") is never split, even inside Chinese;
//   - NO_LINE_START characters (fullwidth comma, full stop, closing
//     brackets and quotes, ellipsis, dashes, small kana, ASCII closers) never
//     begin a row and NO_LINE_END characters (opening brackets and quotes)
//     never end one: the break before / after them is removed, so the
//     neighbouring character moves to the next row together with them;
//   - a single unbreakable run wider than the row (a very long word, a long
//     punctuation chain) is cut between characters as a last resort.
//
// Offsets are UTF-16 indices into the source string; widths come from the
// caller's `measure`. Every rule works on code points, so a supplementary
// character (U+20BB7) is one unit and never split into its surrogates.

/** Width of `text` in pixels. The kit's core measures a run as the sum of its
 *  glyph advances, so callers may cache per character. */
export type Measure = (text: string) => number;

/** One laid-out row: `text` is `source.slice(start, end)` without the spaces
 *  hanging at the break. */
export interface TextRow {
  text: string;
  start: number;
  end: number;
}

// The sets are code point lists, not string literals: the PocketJS build
// bakes every character of every string literal it sees into the app's font
// atlas, and a Latin-only game must not pay for CJK punctuation.
/** Characters that may not begin a row: CJK and fullwidth closing
 *  punctuation, small kana, dashes and ellipses, ASCII closers. */
export const NO_LINE_START: readonly number[] = [
  0xff0c, 0x3002, 0xff0e, 0x3001, 0xff1b, 0xff1a, 0xff1f, 0xff01, // ，。．、；：？！
  0x203c, 0x2047, 0x2048, 0x2049, // ‼ ⁇ ⁈ ⁉
  0xff61, 0xff64, 0xff65, // ｡ ､ ･
  0xff09, 0xff3d, 0xff5d, 0x3015, 0x3009, 0x300b, 0x300d, 0x300f, 0x3011, 0x3019, 0x3017, 0x301b, 0x301e, 0x301f, // closing brackets
  0xff63, // ｣
  0x2019, 0x201d, 0xff60, 0x00bb, 0x203a, // ’ ” ｠ » ›
  0x2026, 0x2025, 0x2014, 0x2013, 0xff5e, 0x301c, 0x00b7, 0x30fb, 0x30fc, 0x30a0, 0x3005, 0x303b, // … ‥ — – ～ 〜 · ・ ー ゠ 々 〻
  0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087, 0x308e, 0x3095, 0x3096, // small hiragana
  0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7, 0x30ee, 0x30f5, 0x30f6, // small katakana
  0x3099, 0x309a, 0x309b, 0x309c, 0xff9e, 0xff9f, 0x30fd, 0x30fe, 0x309d, 0x309e, // sound marks, iteration marks
  0x21, 0x25, 0x29, 0x2c, 0x2e, 0x3a, 0x3b, 0x3f, 0x5d, 0x7d, // ! % ) , . : ; ? ] }
  0x00a2, 0x00b0, 0x2032, 0x2033, 0x2103, 0xff05, // ¢ ° ′ ″ ℃ ％
];
/** Characters that may not end a row: opening brackets and quotes, currency
 *  signs that prefix a number. */
export const NO_LINE_END: readonly number[] = [
  0xff08, 0xff3b, 0xff5b, 0x3014, 0x3008, 0x300a, 0x300c, 0x300e, 0x3010, 0x3018, 0x3016, 0x301a, 0x301d, // opening brackets
  0xff62, // ｢
  0x2018, 0x201c, 0xff5f, 0x00ab, 0x2039, // ‘ “ ｟ « ‹
  0x28, 0x5b, 0x7b, 0x24, 0x00a3, 0x00a5, 0xffe5, 0xff04, // ( [ { $ £ ¥ ￥ ＄
];

const NO_START = new Set<number>(NO_LINE_START);
const NO_END = new Set<number>(NO_LINE_END);

/** True for characters set solid in CJK text: every boundary next to one is a
 *  break opportunity (subject to kinsoku). */
export function isCjk(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2fdf) || // radicals
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols and punctuation
    (cp >= 0x3040 && cp <= 0x30ff) || // kana
    (cp >= 0x3100 && cp <= 0x31ff) || // bopomofo, kana ext.
    (cp >= 0x3200 && cp <= 0x33ff) || // enclosed, compatibility
    (cp >= 0x3400 && cp <= 0x4dbf) || // ext. A
    (cp >= 0x4e00 && cp <= 0x9fff) || // unified ideographs
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul
    (cp >= 0xf900 && cp <= 0xfaff) || // compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // vertical forms
    (cp >= 0xff00 && cp <= 0xffef) || // fullwidth forms
    (cp >= 0x20000 && cp <= 0x3fffd) // supplementary ideographs
  );
}

/** True when `text` holds at least one CJK character. */
export function hasCjk(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x2e80) {
      const cp = text.codePointAt(i)!;
      if (isCjk(cp)) return true;
      if (cp > 0xffff) i++;
    }
  }
  return false;
}

const SURROGATE = /[\uD800-\uDFFF]/;

/** Number of code points (= glyphs drawn by the core) in `text`. Equals
 *  `text.length` for any text without supplementary characters. */
export function scalarLength(text: string): number {
  if (!SURROGATE.test(text)) return text.length;
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** The first `count` code points of `text`. */
export function sliceScalars(text: string, count: number): string {
  if (count <= 0) return "";
  if (!SURROGATE.test(text)) return text.slice(0, count);
  let i = 0;
  let n = 0;
  while (i < text.length && n < count) {
    i += text.codePointAt(i)! > 0xffff ? 2 : 1;
    n++;
  }
  return text.slice(0, i);
}

/** UTF-16 index of the code point after the first `count` code points. */
export function scalarOffset(text: string, count: number): number {
  return sliceScalars(text, count).length;
}

function isSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0x3000 || cp === 0x09;
}

/** May a row end between code points `a` (before) and `b` (after)? */
function canBreak(a: number, b: number): boolean {
  if (isSpace(b)) return false; // spaces stay with the row they follow
  if (NO_START.has(b) || NO_END.has(a)) return false;
  if (isSpace(a)) return true;
  return isCjk(a) || isCjk(b);
}

/** Break one line (no "\n") into rows no wider than `maxWidth`. An empty line
 *  yields one empty row; `offset` shifts the reported indices. */
export function breakLine(line: string, maxWidth: number, measure: Measure, offset = 0): TextRow[] {
  const rows: TextRow[] = [];
  const n = line.length;
  if (n === 0) return [{ text: "", start: offset, end: offset }];
  if (!(maxWidth > 0) || measure(line) <= maxWidth) {
    return [{ text: line, start: offset, end: offset + n }];
  }
  // Segments run between break opportunities; a segment's ink excludes its
  // trailing spaces, which hang past the row end when the row breaks there.
  let rowStart = 0;
  let rowInkEnd = 0;
  let rowWidth = 0; // through the last segment's trailing spaces
  const push = (start: number, end: number) => {
    rows.push({ text: line.slice(start, end), start: offset + start, end: offset + end });
  };
  let segStart = 0;
  while (segStart < n) {
    let i = segStart;
    let prev = -1;
    while (i < n) {
      const cp = line.codePointAt(i)!;
      if (prev >= 0 && canBreak(prev, cp)) break;
      prev = cp;
      i += cp > 0xffff ? 2 : 1;
    }
    const segEnd = i;
    let inkEnd = segEnd;
    while (inkEnd > segStart && isSpace(line.charCodeAt(inkEnd - 1))) inkEnd--;
    const ink = inkEnd > segStart ? measure(line.slice(segStart, inkEnd)) : 0;
    const hang = inkEnd < segEnd ? measure(line.slice(inkEnd, segEnd)) : 0;
    if (rowInkEnd > rowStart && rowWidth + ink > maxWidth) {
      push(rowStart, rowInkEnd);
      rowStart = segStart;
      rowInkEnd = segStart;
      rowWidth = 0;
    }
    if (rowWidth + ink > maxWidth) {
      // Nothing else on the row and still too wide: cut between code points.
      let j = segStart;
      while (j < inkEnd) {
        const cp = line.codePointAt(j)!;
        const step = cp > 0xffff ? 2 : 1;
        const cw = measure(line.slice(j, j + step));
        if (j > rowStart && rowWidth + cw > maxWidth) {
          push(rowStart, j);
          rowStart = j;
          rowWidth = 0;
        }
        rowWidth += cw;
        j += step;
      }
    } else {
      rowWidth += ink;
    }
    if (inkEnd > segStart) rowInkEnd = inkEnd;
    rowWidth += hang;
    segStart = segEnd;
  }
  if (rowInkEnd > rowStart || rows.length === 0) push(rowStart, Math.max(rowStart, rowInkEnd));
  return rows;
}

/** Break text with hard "\n" breaks into rows; each paragraph is broken with
 *  breakLine and the offsets index the whole `text`. */
export function breakText(text: string, maxWidth: number, measure: Measure): TextRow[] {
  const rows: TextRow[] = [];
  let start = 0;
  for (const para of text.split("\n")) {
    for (const row of breakLine(para, maxWidth, measure, start)) rows.push(row);
    start += para.length + 1;
  }
  return rows;
}

/** Whether `rows` (breakText over `text`) end a row anywhere a row may not
 *  end: the last-resort cut inside a word, or inside a kinsoku cluster,
 *  that is wider than the row. A box that has a smaller size to step down
 *  to can treat such rows as not fitting. */
export function hasForcedBreak(text: string, rows: readonly TextRow[]): boolean {
  for (let k = 1; k < rows.length; k++) {
    const end = rows[k - 1]!.end;
    const start = rows[k]!.start;
    // Spaces hang between the rows, or a "\n" does: a legal break.
    if (end !== start) continue;
    const low = text.charCodeAt(end - 1);
    const before = text.codePointAt(low >= 0xdc00 && low <= 0xdfff && end >= 2 ? end - 2 : end - 1)!;
    if (!canBreak(before, text.codePointAt(start)!)) return true;
  }
  return false;
}

/** Cut `text` into pages of at most `rows` rows of at most `maxWidth` px,
 *  for importers turning a long message into several text boxes. */
export function paginateText(text: string, maxWidth: number, rowsPerPage: number, measure: Measure): string[][] {
  const pages: string[][] = [];
  const rows = breakText(text, maxWidth, measure).map((row) => row.text);
  for (let i = 0; i < rows.length; i += rowsPerPage) pages.push(rows.slice(i, i + rowsPerPage));
  return pages.length ? pages : [[""]];
}

/** `text` unchanged when it fits `maxWidth`; otherwise its longest prefix of
 *  whole code points that fits together with `ellipsis`. */
export function fitText(text: string, maxWidth: number, measure: Measure, ellipsis = "…"): string {
  if (!(maxWidth >= 0) || measure(text) <= maxWidth) return text;
  const budget = maxWidth - measure(ellipsis);
  let end = 0;
  let w = 0;
  while (end < text.length) {
    const cp = text.codePointAt(end)!;
    const step = cp > 0xffff ? 2 : 1;
    const cw = measure(text.slice(end, end + step));
    if (w + cw > budget) break;
    w += cw;
    end += step;
  }
  return text.slice(0, end).replace(/[ \u3000]+$/, "") + ellipsis;
}
