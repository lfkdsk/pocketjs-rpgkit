import { For, Show, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { marqueeOffset } from "./list-window.ts";
import { choiceRunColour, type ChoiceColourCell, type ChoiceColourRun } from "./choice-colour.ts";

export interface ColourBoundedLineProps {
  cell: ChoiceColourCell;
  tick: Accessor<number>;
  textColor: string;
  rowH: number;
  width: number;
  debugName: string;
  sizeClass?: string;
}

function ColourRuns(props: {
  runs: readonly ChoiceColourRun[];
  textColor: string;
  rowH: number;
  sizeClass?: string;
}): JSX.Element {
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
