import { For, Show, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { marqueeOffset } from "./list-window.ts";
import {
  choiceRunColour,
  fitChoiceColourCell,
  layoutRpgMakerTextRuns,
  revealChoiceColourRuns,
  wrapChoiceColourRows,
  type ChoiceColourCell,
  type ChoiceColourRun,
} from "./choice-colour.ts";
import type {
  ChoiceTextMessageRowProps,
  ChoiceTextPositionedProps,
  ChoiceTextRuntime,
  ChoiceTextRunsProps,
} from "./choice-text-contract.ts";

export interface ColourBoundedLineProps {
  cell: ChoiceColourCell;
  tick: Accessor<number>;
  textColor: string;
  rowH: number;
  width: number;
  debugName: string;
  sizeClass?: string;
}

export function ColourRuns(props: ChoiceTextRunsProps): JSX.Element {
  return (
    <For each={props.runs}>
      {(run) => (
        <Text
          class={props.sizeClass ?? "text-xs"}
          style={{
            textColor: choiceRunColour(run, props.textColor),
            lineHeight: props.rowH,
            height: props.rowH,
            shrink: 0,
          }}
        >
          {run.text || " "}
        </Text>
      )}
    </For>
  );
}

/** Coloured counterpart to DialogBox's compact plain message row. */
export function ColourMessageRow(props: ChoiceTextMessageRowProps): JSX.Element {
  return (
    <View
      class="flex-row"
      style={{
        height: props.rowH,
        width: props.width,
        display: props.text ? 0 : 1,
        translateX: props.translateX,
        translateY: props.translateY,
      }}
      debugName={`rpgkit-message-row-${props.row}`}
    >
      <ColourRuns runs={props.runs} textColor={props.textColor} rowH={props.rowH} />
      <Show when={props.runs.length === 0}>
        <Text
          class="text-xs"
          style={{ textColor: props.textColor, lineHeight: props.rowH, height: props.rowH, shrink: 0 }}
        > </Text>
      </Show>
    </View>
  );
}

/** Positioned MZ text is optional together with the colour runtime, keeping
 * its font-slot and absolute-layout renderer out of ordinary projects. */
export function PositionedRpgMakerText(props: ChoiceTextPositionedProps): JSX.Element {
  return (
    <View style={{ height: props.height, width: props.width }} debugName="rpgkit-message-mz-layout">
      <For each={props.runs}>
        {(run) => (
          <Text
            class="text-xs"
            style={{
              posType: 1,
              insetL: run.x,
              insetT: run.y,
              width: run.width,
              height: run.lineHeight,
              lineHeight: run.lineHeight,
              fontSlot: run.fontSlot,
              textColor: run.colour ?? props.textColor,
            }}
          >
            {run.text}
          </Text>
        )}
      </For>
    </View>
  );
}

/** A coloured counterpart to BoundedLine, used only when a choice field
 * actually carries spans so the legacy uncoloured tree remains unchanged. */
export function ColourBoundedLine(props: ColourBoundedLineProps): JSX.Element {
  const cell = () => props.cell;
  return (
    <Show when={cell().layout.kind === "wrap"} fallback={
      <View
        style={{ width: props.width, height: props.rowH, overflow: 1 }}
        debugName={props.debugName}
      >
        <View
          class="flex-row"
          style={{
            height: props.rowH,
            shrink: 0,
            translateX: -marqueeOffset(cell().layout.overflow, props.tick()),
          }}
        >
          <ColourRuns
            runs={cell().rows[0]!.runs}
            textColor={props.textColor}
            rowH={props.rowH}
            sizeClass={props.sizeClass}
          />
        </View>
      </View>
    }>
      <View
        class="flex-col"
        style={{ width: props.width, height: props.rowH * cell().rows.length }}
        debugName={props.debugName}
      >
        <For each={cell().rows}>
          {(row) => (
            <View class="flex-row" style={{ height: props.rowH }}>
              <ColourRuns
                runs={row.runs}
                textColor={props.textColor}
                rowH={props.rowH}
                sizeClass={props.sizeClass}
              />
            </View>
          )}
        </For>
      </View>
    </Show>
  );
}

/** UI half of the explicit RPG Maker text capability. */
export const rpgMakerChoiceTextRuntime: ChoiceTextRuntime = Object.freeze({
  fit: fitChoiceColourCell,
  layout: layoutRpgMakerTextRuns,
  reveal: revealChoiceColourRuns,
  wrap: wrapChoiceColourRows,
  BoundedLine: ColourBoundedLine,
  MessageRow: ColourMessageRow,
  Positioned: PositionedRpgMakerText,
  Runs: ColourRuns,
});
