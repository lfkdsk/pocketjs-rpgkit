// Fixed 480x272 layout shared by the scrolling-text reducer callback and
// its presentation layer. Keeping measurement here (without JSX) also makes
// the state-affecting dimensions straightforward to verify in isolation.

import type { ScrollTextLayout } from "../engine/interpreter.ts";
import type { Measure } from "../engine/text-break.ts";
import { flowRows, type TextFlow } from "./text-flow.ts";
import { slotMeasure } from "./text-measure.ts";

/** RPG Maker's scrolling-text viewport uses the kit's fixed design size. */
export const SCROLL_TEXT_VIEWPORT_WIDTH = 480;
export const SCROLL_TEXT_VIEWPORT_HEIGHT = 272;
/** Text uses the same horizontal inset and row rhythm as the dialog layer. */
export const SCROLL_TEXT_INSET_X = 8;
export const SCROLL_TEXT_ROW_HEIGHT = 15;
export const SCROLL_TEXT_CONTENT_WIDTH =
  SCROLL_TEXT_VIEWPORT_WIDTH - 2 * SCROLL_TEXT_INSET_X;

/** Preserve authored rows and wrap only rows wider than the design width.
 * Passing an unbounded row budget deliberately disables dialog-style soft
 * reflow: scrolling text has no page-height limit. */
export function scrollTextFlow(lines: readonly string[], measure: Measure): TextFlow {
  return flowRows(lines, SCROLL_TEXT_CONTENT_WIDTH, Number.POSITIVE_INFINITY, measure);
}

/** Build the pure layout callback installed in SessionOptions. Its fixed
 * dimensions keep scroll completion identical through desktop resizes,
 * save/load, attract playback and rewind. */
export function createScrollTextLayout(measure: Measure = slotMeasure()): ScrollTextLayout {
  return (lines) => ({
    contentHeight: scrollTextFlow(lines, measure).rows.length * SCROLL_TEXT_ROW_HEIGHT,
    viewportHeight: SCROLL_TEXT_VIEWPORT_HEIGHT,
  });
}
