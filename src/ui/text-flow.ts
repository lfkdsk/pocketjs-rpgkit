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
