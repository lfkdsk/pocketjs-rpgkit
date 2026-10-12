/** Type-only presentation seam for optional styled choice text. */

import type { Component } from "solid-js";
import type {
  RpgMakerTextColourSpan,
  RpgMakerTextLayoutControl,
} from "../engine/rpgmaker-text-contract.ts";
import type { Measure } from "../engine/text-break.ts";
import type { BoundedCell } from "./list-window.ts";
import type { TextFlow } from "./text-flow.ts";

export interface ChoiceTextRun {
  text: string;
  /** Absent runs inherit the row's selected/disabled/theme colour. */
  colour?: string;
}

export interface ChoiceTextRow {
  text: string;
  runs: readonly ChoiceTextRun[];
}

export interface ChoiceTextCell {
  layout: BoundedCell;
  rows: readonly ChoiceTextRow[];
}

export interface ChoiceTextRunsProps {
  runs: readonly ChoiceTextRun[];
  textColor: string;
  rowH: number;
  sizeClass?: string;
}

export interface ChoiceTextBoundedLineProps {
  cell: ChoiceTextCell;
  tick: () => number;
  textColor: string;
  rowH: number;
  width: number;
  debugName: string;
  sizeClass?: string;
}

export interface ChoiceTextMessageRowProps {
  runs: readonly ChoiceTextRun[];
  text: string;
  textColor: string;
  rowH: number;
  width: number;
  translateX: number;
  translateY: number;
  row: number;
}

/** One visible run from MZ's mutable text state. */
export interface ChoiceTextPositionedRun extends ChoiceTextRun {
  x: number;
  y: number;
  width: number;
  fontSlot: number;
  lineHeight: number;
}

export interface ChoiceTextPositionedProps {
  runs: readonly ChoiceTextPositionedRun[];
  height: number;
  width: number;
  textColor: string;
}

export interface ChoiceTextRuntime {
  fit(
    source: string,
    width: number,
    maxRows: number,
    measure: Measure,
    spans?: readonly RpgMakerTextColourSpan[] | null,
  ): ChoiceTextCell;
  wrap(
    source: string,
    width: number,
    measure: Measure,
    spans?: readonly RpgMakerTextColourSpan[] | null,
  ): ChoiceTextRow[];
  reveal(
    flow: TextFlow,
    revealed: number,
    spans: readonly RpgMakerTextColourSpan[],
    sourceOffset?: number,
  ): readonly (readonly ChoiceTextRun[])[];
  layout(
    source: string,
    revealed: number,
    controls: readonly RpgMakerTextLayoutControl[],
    spans: readonly RpgMakerTextColourSpan[],
    measureSlot: (slot: number) => Measure,
  ): readonly ChoiceTextPositionedRun[];
  BoundedLine: Component<ChoiceTextBoundedLineProps>;
  MessageRow: Component<ChoiceTextMessageRowProps>;
  Positioned: Component<ChoiceTextPositionedProps>;
  Runs: Component<ChoiceTextRunsProps>;
}
