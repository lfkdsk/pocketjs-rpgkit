// Inline RPG Maker colour runs for choice prompts and option labels.
// Parser offsets count Unicode code points; TextRow offsets count UTF-16
// indices, so this module is the single conversion boundary used by both
// the text-only and icon choice boxes.

import { breakText, scalarLength, type Measure, type TextRow } from "../engine/text-break.ts";
import type { RpgMakerTextColourSpan } from "../engine/rpgmaker-text.ts";
import { fitBounded, type BoundedCell } from "./list-window.ts";

export interface ChoiceColourRun {
  text: string;
  /** Absent runs inherit the row's selected/disabled/theme colour. */
  colour?: string;
}

export interface ChoiceColourRow {
  text: string;
  runs: readonly ChoiceColourRun[];
}

export interface ChoiceColourCell {
  layout: BoundedCell;
  rows: readonly ChoiceColourRow[];
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
