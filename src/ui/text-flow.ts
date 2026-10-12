// src/ui/text-flow.ts — lay a typewriter message's lines out in a fixed
// number of rows of a fixed pixel width (DialogBox, battle MessageBand).
//
// The reducer owns the words and the reveal count (code points of
// `lines.join("\n")`); this module only decides where the rows break, so a
// rewind or a different host width never changes game state.
//
//   1. Lines that already fit keep their authored rows exactly: a Latin
//      dialog authored to the box width lays out as it always has.
//   2. A line wider than the box wraps (text-break.ts: CJK breaks between
//      characters with kinsoku, Latin words and numbers are not split).
//   3. If that needs more rows than the box has (a player name substituted
//      into a pre-wrapped page), the authored breaks become soft and the
//      whole text reflows as one paragraph.
//   4. Text that still needs more rows keeps the wrapped rows of step 2,
//      all of them: nothing is cut. A dialog shows them a page of rows at a
//      time (dialog-pages.ts); a band or label box grows to show them.

import { breakLine, breakText, isCjk, scalarOffset, type Measure, type TextRow } from "../engine/text-break.ts";
import type {
  RpgMakerTextColourSpan,
  RpgMakerTextLayoutControl,
} from "../engine/rpgmaker-text.ts";

/** Marks a soft-joined "\n" between two CJK characters: never drawn, zero
 *  width, a break opportunity. Same UTF-16 length as "\n", so reveal offsets
 *  still index the authored text. */
const JOIN = String.fromCharCode(0xe000);
const JOIN_RE = new RegExp(JOIN, "g");

/** A message laid out in rows; each row's `start`/`end` index `source`,
 *  which has the length (and code points) of `lines.join("\n")`. */
export interface TextFlow {
  rows: TextRow[];
  source: string;
}

/** One contiguous colour run in a laid-out row. Missing `colour` means the
 * dialog theme's normal ink. */
export interface TextColourRun {
  text: string;
  colour?: string;
}

/** One visible run from MZ's mutable text state. `x`/`y` are pixels inside
 * the message content box; `fontSlot` selects the nearest baked PocketJS
 * regular face to the authored FS size. */
export interface PositionedRpgMakerTextRun extends TextColourRun {
  x: number;
  y: number;
  width: number;
  fontSlot: number;
  lineHeight: number;
}

export interface RpgMakerFontMetrics {
  slot: number;
  px: number;
  lineHeight: number;
}

const MZ_DEFAULT_FONT_SIZE = 26;
const KIT_DEFAULT_FONT_SIZE = 12;
const MZ_TO_KIT_TEXT_SCALE = KIT_DEFAULT_FONT_SIZE / MZ_DEFAULT_FONT_SIZE;
const MAX_LAYOUT_PIXEL = 4096;
const FONT_METRICS: readonly RpgMakerFontMetrics[] = [
  { slot: 19, px: 10, lineHeight: 13 },
  { slot: 0, px: 12, lineHeight: 15 },
  { slot: 1, px: 14, lineHeight: 17 },
  { slot: 2, px: 16, lineHeight: 19 },
  { slot: 3, px: 18, lineHeight: 21 },
  { slot: 4, px: 20, lineHeight: 23 },
  { slot: 5, px: 24, lineHeight: 27 },
  { slot: 6, px: 36, lineHeight: 39 },
  { slot: 14, px: 54, lineHeight: 57 },
];

/** Map MZ's freely assigned font size to the closest regular font atlas the
 * host bakes. The relative size is retained (26 MZ px == the kit's 12 px
 * default) without adding a new atlas or cost to projects that never use FS. */
export function rpgMakerFontMetrics(fontSize: number): RpgMakerFontMetrics {
  const target = Math.max(0, fontSize) * MZ_TO_KIT_TEXT_SCALE;
  let best = FONT_METRICS[0]!;
  for (const candidate of FONT_METRICS.slice(1)) {
    if (Math.abs(candidate.px - target) < Math.abs(best.px - target)) best = candidate;
  }
  return best;
}

function assignedPixel(value: number): number {
  return Math.min(MAX_LAYOUT_PIXEL, Math.round(Math.max(0, value) * MZ_TO_KIT_TEXT_SCALE));
}

/** Replay MZ's PX/PY/FS assignments and place the revealed glyphs. Newlines
 * reset x and advance by the tallest FS value on that authored line, while
 * an explicit PY replaces the cursor y exactly. Controls and colour spans
 * use the reducer's global Unicode-code-point coordinate system. */
export function layoutRpgMakerTextRuns(
  source: string,
  revealed: number,
  controls: readonly RpgMakerTextLayoutControl[],
  spans: readonly RpgMakerTextColourSpan[],
  measureSlot: (slot: number) => Measure,
): PositionedRpgMakerTextRun[] {
  const lineHeights: number[] = [];
  let controlIndex = 0;
  let fontSize = MZ_DEFAULT_FONT_SIZE;
  let lineHeight = rpgMakerFontMetrics(fontSize).lineHeight;
  let offset = 0;
  for (const scalar of source) {
    while (controls[controlIndex]?.at === offset) {
      const control = controls[controlIndex++]!;
      if (control.fontSize !== undefined) fontSize = control.fontSize;
    }
    lineHeight = Math.max(lineHeight, rpgMakerFontMetrics(fontSize).lineHeight);
    if (scalar === "\n") {
      lineHeights.push(lineHeight);
      lineHeight = rpgMakerFontMetrics(fontSize).lineHeight;
    }
    offset++;
  }
  lineHeights.push(lineHeight);

  const runs: PositionedRpgMakerTextRun[] = [];
  controlIndex = 0;
  fontSize = MZ_DEFAULT_FONT_SIZE;
  let metrics = rpgMakerFontMetrics(fontSize);
  let x = 0;
  let y = 0;
  let line = 0;
  let spanIndex = 0;
  offset = 0;
  for (const scalar of source) {
    while (controls[controlIndex]?.at === offset) {
      const control = controls[controlIndex++]!;
      if (control.x !== undefined) x = assignedPixel(control.x);
      if (control.y !== undefined) y = assignedPixel(control.y);
      if (control.fontSize !== undefined) {
        fontSize = control.fontSize;
        metrics = rpgMakerFontMetrics(fontSize);
      }
    }
    if (scalar === "\n") {
      x = 0;
      y += lineHeights[line++]!;
      offset++;
      continue;
    }
    while (spanIndex < spans.length && spans[spanIndex]!.end <= offset) spanIndex++;
    const span = spans[spanIndex];
    const colour = span !== undefined && span.start <= offset && offset < span.end
      ? span.colour
      : undefined;
    const width = measureSlot(metrics.slot)(scalar);
    if (offset < revealed) {
      const previous = runs.at(-1);
      if (previous !== undefined && previous.fontSlot === metrics.slot && previous.lineHeight === metrics.lineHeight &&
          previous.colour === colour && previous.y === y && previous.x + previous.width === x) {
        previous.text += scalar;
        previous.width += width;
      } else {
        runs.push({
          text: scalar,
          ...(colour === undefined ? {} : { colour }),
          x,
          y,
          width,
          fontSlot: metrics.slot,
          lineHeight: metrics.lineHeight,
        });
      }
    }
    x += width;
    offset++;
  }
  return runs;
}

function codePointBefore(text: string, i: number): number {
  if (i <= 0) return 0x20;
  const low = text.charCodeAt(i - 1);
  return low >= 0xdc00 && low <= 0xdfff && i >= 2 ? text.codePointAt(i - 2)! : low;
}

/** Lay `lines` out in rows of `maxWidth` px, preferring at most `maxRows`
 *  rows; text that needs more keeps every row (rows.length > maxRows).
 *  `maxWidth` NaN or <= 0 keeps the authored rows. */
export function flowRows(lines: readonly string[], maxWidth: number, maxRows: number, measure: Measure): TextFlow {
  const joined = lines.join("\n");
  const rows = breakText(joined, maxWidth > 0 ? maxWidth : Number.NaN, measure);
  if (!(maxWidth > 0) || rows.length <= maxRows) return { rows, source: joined };
  let soft = "";
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i]!;
    if (c !== "\n") soft += c;
    else {
      const after = i + 1 < joined.length ? joined.codePointAt(i + 1)! : 0x20;
      soft += isCjk(codePointBefore(joined, i)) || isCjk(after) ? JOIN : " ";
    }
  }
  const softMeasure: Measure = (text) => measure(text.includes(JOIN) ? text.replace(JOIN_RE, "") : text);
  const reflowed = breakLine(soft, maxWidth, softMeasure);
  if (reflowed.length > maxRows) return { rows, source: joined };
  for (const row of reflowed) row.text = row.text.replace(JOIN_RE, "");
  return { rows: reflowed, source: soft };
}

/** The part of each row the typewriter has reached: `revealed` counts code
 *  points of the joined text (the reducer's unit); a row whose turn has not
 *  come is "". */
export function revealRows(flow: TextFlow, revealed: number): string[] {
  const { rows, source } = flow;
  const cut = revealed >= source.length ? source.length : scalarOffset(source, revealed);
  return rows.map((row) => {
    if (cut <= row.start) return "";
    if (cut >= row.end) return row.text;
    const shown = source.slice(row.start, cut);
    return shown.includes(JOIN) ? shown.replace(JOIN_RE, "") : shown;
  });
}

/** The revealed part of each row, split only where RPG Maker's active
 * colour changes. `sourceOffset` is the page's Unicode-code-point offset in
 * the full modal text (speaker prefix and earlier pages included).
 *
 * Soft CJK joins remain one source code point, like the newline they
 * replace, but draw no glyph. This keeps parser spans, wrapping and the
 * reducer's typewriter counter on the same coordinate system. */
export function revealColourRuns(
  flow: TextFlow,
  revealed: number,
  spans: readonly RpgMakerTextColourSpan[],
  sourceOffset = 0,
): TextColourRun[][] {
  const { rows, source } = flow;
  const cut = revealed >= source.length ? source.length : scalarOffset(source, revealed);
  let spanIndex = 0;
  const colourAt = (offset: number): string | undefined => {
    while (spanIndex < spans.length && spans[spanIndex]!.end <= offset) spanIndex++;
    const span = spans[spanIndex];
    return span !== undefined && span.start <= offset && offset < span.end
      ? span.colour
      : undefined;
  };
  let rowOffset = sourceOffset;
  let cursor = 0;
  return rows.map((row) => {
    rowOffset += Array.from(source.slice(cursor, row.start)).length;
    cursor = row.start;
    if (cut <= row.start) return [];
    const end = Math.min(cut, row.end);
    const runs: TextColourRun[] = [];
    let run = "";
    let runColour: string | undefined;
    let offset = rowOffset;
    for (const scalar of source.slice(row.start, end)) {
      const colour = colourAt(offset);
      if (scalar !== JOIN) {
        if (run !== "" && colour !== runColour) {
          runs.push(runColour === undefined ? { text: run } : { text: run, colour: runColour });
          run = "";
        }
        if (run === "") runColour = colour;
        run += scalar;
      }
      offset++;
    }
    if (run !== "") runs.push(runColour === undefined ? { text: run } : { text: run, colour: runColour });
    rowOffset += Array.from(source.slice(row.start, row.end)).length;
    cursor = row.end;
    return runs;
  });
}
