// src/ui/dialog-pages.ts — where a dialog message that needs more than one
// box breaks into pages. Pure (no host calls of its own): the measurer is a
// parameter, so the game passes the running core's baked-font measurer and
// a headless tool passes the build-time one (tools/lib/font-measure.ts),
// and both get the same pages.
//
// The interpreter asks once, when a text box opens (WorldOptions
// .paginateText), and keeps the answer in the open modal (TextModal
// .pageStarts), so the number of confirms a message takes is reducer state:
// the same at every host rate, after a rewind and in a replay. Saves never
// hold an open text box. Pages are cut at the design size (the 480x272
// screen), not the live window, so a resized desktop window or a 960 px
// web page shows the same pages; DialogBox lays each page out at the live
// size.
//
// A message whose rows fit the box (text-flow.ts: authored rows, wrapped
// lines, or the soft reflow of a pre-wrapped page) is one page and gets no
// page state at all. Otherwise the wrapped rows go a box's rows to a page
// (four in the default box); authored line breaks are kept.
//
// A text command's layout (TextBoxLayout) moves the box: `top`, `center`
// and `bottom` are the RPG Maker band, like the default box (full width
// less 8 px a side, 92 px high, 8 px from the top or bottom edge). The
// corners and the sides are Tuxemon's small dialog window (ui/dialogue.py
// with large_gui off): 0.8 of the screen wide and 0.25 high, flush against
// the edges it is anchored to (384x68 at 480x272, 768x136 at 960x544). Its
// words wrap narrower and its text area holds fewer rows (two at the
// design size), so a message takes more pages; the box still grows rather
// than cut a page that needs more rows at the live size. A speaker's
// portrait never changes the window's size or place: it is drawn inside,
// scaled to the window's inner height (whole multiples of the 64 px image
// when one fits, smaller when it does not: 48 px at 480x272), and the
// words wrap in the narrower column beside it. The geometry helpers below
// are shared by the paginator and DialogBox so both agree.
//
//   topLeft      top       topRight        corners touch both edges;
//   left         center    right           center/left/right sit at the
//   bottomLeft   bottom    bottomRight     screen's mid-height

import { scalarLength, scalarOffset, type Measure } from "../engine/text-break.ts";
import { flowRows } from "./text-flow.ts";
import { splitSpeaker, type SpeakerSplit } from "./theme.ts";
import type { TextBoxLayout, TextBoxPosition } from "../engine/types.ts";

/** Rows of the band box (the schema's commands.text.lines cap). */
export const DIALOG_ROWS = 4;
/** The design screen width pages are cut at. */
export const DIALOG_PAGE_VIEWPORT = 480;
/** The design screen height: a corner or side box's rows per page are cut
 *  at it (the box itself takes its height from the live screen). */
export const DIALOG_VIEWPORT_H = 272;
/** Row height of the message box's text rows. */
export const DIALOG_ROW_H = 15;
/** Gap between the band box and the screen edges it is docked to. */
const BOX_INSET = 8;
/** The band box's height: four rows, the legend row and the chrome. */
export const DIALOG_BOX_H = 92;
/** Frame (2 px) and padding (8 px) above and below the box's content. */
const BOX_V_INSET = 2 * (2 + 8);
/** That plus the legend row under the text: the box height that is not
 *  the text area. */
const BOX_V_CHROME = BOX_V_INSET + 12;
/** Frame and padding left and right of the text column. */
const BOX_H_CHROME = 2 * (2 + 8);
/** Default portrait column: the 64 px image and an 8 px gap. */
export const FACE_WIDTH = 72;
/** Portrait images are 64x64 (pak images must be power-of-two). */
export const FACE_PX = 64;

const NO_SPEAKER: SpeakerSplit = { name: null, rest: "", cut: 0 };

export interface DialogLayout {
  /** Screen width the box spans. */
  viewportWidth: number;
  /** Screen height, which sizes a corner or side box and its portrait
   *  (default DIALOG_VIEWPORT_H, the height pages are cut at). */
  viewportHeight?: number;
  /** Speaker portraits (DialogBoxProps.faces). */
  faces?: Readonly<Record<string, string>>;
  /** Portrait column width (default FACE_WIDTH). */
  faceWidth?: number;
  /** The theme draws a 1 px rim inside the frame. */
  rim?: boolean;
}

/** The speaker split of a message's first line under `faces`. */
export function messageSpeaker(lines: readonly string[], faces: DialogLayout["faces"]): SpeakerSplit {
  if (!faces || lines.length === 0) return NO_SPEAKER;
  return splitSpeaker(lines[0]!, faces);
}

/** The lines the box draws: the first without its "NAME: " prefix. */
export function shownMessageLines(lines: readonly string[], speaker: SpeakerSplit): readonly string[] {
  return speaker.name ? [speaker.rest, ...lines.slice(1)] : lines;
}

/** Positions with the small window (four fifths of the screen wide). */
function narrowPosition(position: TextBoxPosition | undefined): -1 | 0 | 1 {
  switch (position) {
    case "topLeft": case "bottomLeft": case "left": return -1;
    case "topRight": case "bottomRight": case "right": return 1;
    default: return 0;
  }
}

/** The box's left and right insets on a screen `viewportWidth` wide: 8 px
 *  a side for a band; a corner or side box is four fifths of the screen
 *  wide, flush with its edge. */
export function dialogBoxInsets(viewportWidth: number, position?: TextBoxPosition): { left: number; right: number } {
  const side = narrowPosition(position);
  if (side === 0) return { left: BOX_INSET, right: BOX_INSET };
  const far = viewportWidth - Math.floor((viewportWidth * 4) / 5);
  return side < 0 ? { left: 0, right: far } : { left: far, right: 0 };
}

/** The box's height on a screen `viewportHeight` high before a page that
 *  needs more rows grows it: 92 px for a band, a quarter of the screen for
 *  a corner or side box. */
export function dialogBoxHeight(position: TextBoxPosition | undefined, viewportHeight: number): number {
  return narrowPosition(position) === 0 ? DIALOG_BOX_H : Math.floor(viewportHeight / 4);
}

/** Pixels of the box's text area (above the legend row). */
export function dialogTextAreaHeight(position: TextBoxPosition | undefined, viewportHeight: number): number {
  return Math.max(DIALOG_ROW_H, dialogBoxHeight(position, viewportHeight) - BOX_V_CHROME);
}

/** Text rows the box holds: four for a band, two in a corner or side box
 *  at the design size, at least one. */
export function dialogBoxRows(position: TextBoxPosition | undefined, viewportHeight: number): number {
  return Math.floor(dialogTextAreaHeight(position, viewportHeight) / DIALOG_ROW_H);
}

/** The box's bottom inset on a screen `viewportHeight` high for a box
 *  `boxHeight` tall: a band 8 px from the bottom or the top edge, a corner
 *  against it, or centred. `topGap` replaces the top band's gap (room for
 *  a name tab); a corner stays against the top edge. */
export function dialogBoxBottom(position: TextBoxPosition | undefined, viewportHeight: number, boxHeight: number, topGap?: number): number {
  switch (position) {
    case "top":
      return viewportHeight - (topGap ?? BOX_INSET) - boxHeight;
    case "topLeft": case "topRight":
      return viewportHeight - boxHeight;
    case "center": case "left": case "right":
      return Math.floor((viewportHeight - boxHeight) / 2);
    case "bottomLeft": case "bottomRight":
      return 0;
    default:
      return BOX_INSET;
  }
}

/** The portrait's side in a box at `position` on a screen `viewportHeight`
 *  high: the largest whole multiple of the 64 px image that fits the box's
 *  inner height, or that height when even 1x does not (a corner or side
 *  box below 336 px of screen). 64 px in a band. */
export function dialogFaceSize(position: TextBoxPosition | undefined, viewportHeight: number): number {
  const inner = dialogBoxHeight(position, viewportHeight) - BOX_V_INSET;
  return inner >= FACE_PX ? Math.floor(inner / FACE_PX) * FACE_PX : Math.max(1, inner);
}

/** The portrait column's width: `faceWidth` (the 64 px image and its gap)
 *  scaled with the image. */
export function dialogFaceColumn(layout: DialogLayout, position?: TextBoxPosition): number {
  const face = dialogFaceSize(position, layout.viewportHeight ?? DIALOG_VIEWPORT_H);
  return Math.floor(((layout.faceWidth ?? FACE_WIDTH) * face) / FACE_PX);
}

/** The text column's width (the Text node) for a message with or without a
 *  portrait, in a box at `position` (default: the full-width box). */
export function dialogColumnWidth(layout: DialogLayout, speaking: boolean, position?: TextBoxPosition): number {
  const insets = dialogBoxInsets(layout.viewportWidth, position);
  const boxWidth = layout.viewportWidth - insets.left - insets.right;
  return Math.max(0, boxWidth - BOX_H_CHROME - (layout.faces && speaking ? dialogFaceColumn(layout, position) : 0));
}

/** The width rows may fill: the column less the rim's 1 px per side. */
export function dialogRowWidth(layout: DialogLayout, speaking: boolean, position?: TextBoxPosition): number {
  return dialogColumnWidth(layout, speaking, position) - (layout.rim ? 2 : 0);
}

/** Pixels the page's rows move down in a text area `areaHeight` high (the
 *  band's four rows by default): none for `top` (and for a page that fills
 *  or outgrows the area), half the free pixels for `center`, all of them
 *  for `bottom`. */
export function dialogValignShift(valign: TextBoxLayout["valign"], pageRows: number, areaHeight = DIALOG_ROWS * DIALOG_ROW_H): number {
  if (valign === undefined || valign === "top") return 0;
  const free = areaHeight - pageRows * DIALOG_ROW_H;
  if (free <= 0) return 0;
  return valign === "bottom" ? free : Math.floor(free / 2);
}

/** Pixels a row of `rowWidth` moves right in a column `budget` wide: none
 *  for `left`, the free width for `right`, half of it for `center`. A row
 *  is aligned as a whole, so typing it never shifts its letters. */
export function dialogAlignShift(align: TextBoxLayout["align"], budget: number, rowWidth: number): number {
  if (align === undefined || align === "left" || !(budget > rowWidth)) return 0;
  const free = budget - rowWidth;
  return align === "right" ? free : Math.floor(free / 2);
}

/** Code-point offsets into `lines.join("\n")` (speaker prefix included)
 *  where each page starts, [0, ...], when the message needs more than one
 *  box; null when it fits one. */
export function messagePageStarts(
  lines: readonly string[],
  layout: DialogLayout,
  measure: Measure,
  position?: TextBoxPosition,
): number[] | null {
  const speaker = messageSpeaker(lines, layout.faces);
  const shown = shownMessageLines(lines, speaker);
  const perPage = dialogBoxRows(position, DIALOG_VIEWPORT_H);
  const flow = flowRows(shown, dialogRowWidth(layout, speaker.name !== null, position), perPage, measure);
  if (flow.rows.length <= perPage) return null;
  const starts = [0];
  for (let row = perPage; row < flow.rows.length; row += perPage) {
    starts.push(speaker.cut + scalarLength(flow.source.slice(0, flow.rows[row]!.start)));
  }
  return starts;
}

/** The paginator a session is created with (SessionOptions.paginateText):
 *  pages cut at the design size with this box's portraits and rim, and at
 *  the narrower width and fewer rows of a corner or side box. */
export function createDialogPaginator(
  layout: Omit<DialogLayout, "viewportWidth" | "viewportHeight"> & { viewportWidth?: number },
  measure: Measure,
): (lines: readonly string[], box?: TextBoxLayout) => number[] | null {
  const fixed: DialogLayout = { ...layout, viewportWidth: layout.viewportWidth ?? DIALOG_PAGE_VIEWPORT, viewportHeight: DIALOG_VIEWPORT_H };
  return (lines, box) => messagePageStarts(lines, fixed, measure, box?.position);
}

/** The code points of a page the typewriter has reached: `revealed` counts
 *  the whole message (speaker prefix included). */
export function pageRevealed(revealed: number, cut: number, pageStarts: readonly number[] | undefined, page: number): number {
  const from = pageStarts && pageStarts.length > 1 ? Math.max(0, pageStarts[page]! - cut) : 0;
  return Math.max(0, revealed - cut - from);
}

/** One page of a message as the box draws it: the page's part of the shown
 *  lines (the first line without its speaker prefix of `cut` code points).
 *  `pageStarts` absent means the whole message is one page. */
export function messagePage(
  shown: readonly string[],
  cut: number,
  pageStarts: readonly number[] | undefined,
  page: number,
): readonly string[] {
  if (!pageStarts || pageStarts.length < 2) return shown;
  const joined = shown.join("\n");
  const from = scalarOffset(joined, Math.max(0, pageStarts[page]! - cut));
  const to = page + 1 < pageStarts.length ? scalarOffset(joined, pageStarts[page + 1]! - cut) : joined.length;
  // The break the page was cut at (a newline or a hung space) belongs to
  // the previous page's typing time but draws nothing.
  return joined.slice(from, to).replace(/[\n ]+$/, "").split("\n");
}
