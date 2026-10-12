// Inline RPG Maker colour runs for choice prompts and option labels.
// Parser offsets count Unicode code points; TextRow offsets count UTF-16
// indices, so this module is the single conversion boundary used by both
// the text-only and icon choice boxes.

import { breakText, scalarLength, scalarOffset, type Measure, type TextRow } from "../engine/text-break.ts";
import type {
  RpgMakerTextColourSpan,
  RpgMakerTextLayoutControl,
} from "../engine/rpgmaker-text-contract.ts";
import { fitBounded, type BoundedCell } from "./list-window.ts";
import type { TextFlow } from "./text-flow.ts";
import type {
  ChoiceTextCell,
  ChoiceTextPositionedRun,
  ChoiceTextRow,
  ChoiceTextRun,
} from "./choice-text-contract.ts";

export type ChoiceColourRun = ChoiceTextRun;
export type ChoiceColourRow = ChoiceTextRow;
export type ChoiceColourCell = ChoiceTextCell;

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

/** Map MZ's freely assigned font size to the closest regular font atlas. */
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

/** Replay MZ's PX/PY/FS assignments without admitting the implementation to
 * projects that omit the styled-text capability. */
export function layoutRpgMakerTextRuns(
  source: string,
  revealed: number,
  controls: readonly RpgMakerTextLayoutControl[],
  spans: readonly RpgMakerTextColourSpan[],
  measureSlot: (slot: number) => Measure,
): ChoiceTextPositionedRun[] {
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

  const runs: ChoiceTextPositionedRun[] = [];
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

export function choiceColourRowsEqual(
  a: readonly ChoiceColourRow[],
  b: readonly ChoiceColourRow[],
): boolean {
  return a === b || (a.length === b.length && a.every((row, index) => {
    const other = b[index]!;
    return row.text === other.text && row.runs.length === other.runs.length &&
      row.runs.every((run, at) => run.text === other.runs[at]!.text && run.colour === other.runs[at]!.colour);
  }));
}

export function choiceColourCellsEqual(a: ChoiceColourCell, b: ChoiceColourCell): boolean {
  return a === b || (
    a.layout.kind === b.layout.kind &&
    a.layout.overflow === b.layout.overflow &&
    choiceColourRowsEqual(a.rows, b.rows)
  );
}

/** Explicit RPG Maker colour wins; an uncoloured run inherits the live row
 * colour (normal ink, selected accent, or disabled dim). */
export function choiceRunColour(run: ChoiceColourRun, rowColour: string): string {
  return run.colour ?? rowColour;
}

function runsInRow(
  source: string,
  row: TextRow,
  spans: readonly RpgMakerTextColourSpan[] | null | undefined,
): ChoiceColourRun[] {
  if (!spans || spans.length === 0) return [{ text: row.text }];
  let spanIndex = 0;
  let offset = scalarLength(source.slice(0, row.start));
  while (spanIndex < spans.length && spans[spanIndex]!.end <= offset) spanIndex++;
  const runs: ChoiceColourRun[] = [];
  let text = "";
  let active: string | undefined;
  for (const scalar of source.slice(row.start, row.end)) {
    while (spanIndex < spans.length && spans[spanIndex]!.end <= offset) spanIndex++;
    const span = spans[spanIndex];
    const colour = span !== undefined && span.start <= offset && offset < span.end
      ? span.colour
      : undefined;
    if (text !== "" && colour !== active) {
      runs.push(active === undefined ? { text } : { text, colour: active });
      text = "";
    }
    if (text === "") active = colour;
    text += scalar;
    offset++;
  }
  if (text !== "" || runs.length === 0) {
    runs.push(active === undefined ? { text } : { text, colour: active });
  }
  return runs;
}

/** Wrap a label while retaining the exact source interval behind every
 * displayed row. Hanging spaces omitted by the line breaker are omitted
 * from drawing too, but still advance later rows' code-point offsets. */
export function wrapChoiceColourRows(
  source: string,
  width: number,
  measure: Measure,
  spans?: readonly RpgMakerTextColourSpan[] | null,
): ChoiceColourRow[] {
  return breakText(source, width > 0 ? width : Number.NaN, measure).map((row) => ({
    text: row.text,
    runs: runsInRow(source, row, spans),
  }));
}

/** Choice equivalent of fitBounded: wrapped rows when they fit, otherwise
 * one full-source marquee row. Both forms retain colour/source mapping. */
export function fitChoiceColourCell(
  source: string,
  width: number,
  maxRows: number,
  measure: Measure,
  spans?: readonly RpgMakerTextColourSpan[] | null,
): ChoiceColourCell {
  const layout = fitBounded(source, width, maxRows, measure);
  const rows = layout.kind === "marquee"
    ? [{ text: source, runs: runsInRow(source, { text: source, start: 0, end: source.length }, spans) }]
    : wrapChoiceColourRows(source, width, measure, spans);
  return { layout, rows };
}

/** The revealed part of each laid-out message row, split only where RPG
 * Maker's active colour changes. Kept in the optional colour module so a
 * plain DialogBox never bundles this Unicode/span walk. */
export function revealChoiceColourRuns(
  flow: TextFlow,
  revealed: number,
  spans: readonly RpgMakerTextColourSpan[],
  sourceOffset = 0,
): ChoiceColourRun[][] {
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
    const runs: ChoiceColourRun[] = [];
    let run = "";
    let runColour: string | undefined;
    let offset = rowOffset;
    for (const scalar of source.slice(row.start, end)) {
      const colour = colourAt(offset);
      // Text flow uses U+E000 as an invisible soft CJK join.
      if (scalar !== String.fromCharCode(0xe000)) {
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
