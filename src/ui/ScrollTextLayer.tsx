// src/ui/ScrollTextLayer.tsx — transparent, full-screen scrolling text.
//
// The reducer owns the half-pixel travel offset and captures this layer's
// fixed design dimensions when the modal opens. Presentation only projects
// that state: the block starts immediately below the 480x272 viewport and
// travels upward until its final row has left the top edge.

import { createMemo, For, Show, type Accessor, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type {
  Modal,
  ScrollTextModal,
} from "../engine/interpreter.ts";
import type { RpgMakerTextColourSpan } from "../engine/rpgmaker-text.ts";
import {
  revealColourRuns,
  type TextColourRun,
} from "./text-flow.ts";
import { slotMeasure } from "./text-measure.ts";
import { CLEAR_COLOR, resolveUiTheme, type UiTheme } from "./theme.ts";
import {
  SCROLL_TEXT_CONTENT_WIDTH,
  SCROLL_TEXT_INSET_X,
  SCROLL_TEXT_ROW_HEIGHT,
  SCROLL_TEXT_VIEWPORT_HEIGHT,
  SCROLL_TEXT_VIEWPORT_WIDTH,
  scrollTextFlow,
} from "./scroll-text.ts";

export {
  createScrollTextLayout,
  SCROLL_TEXT_CONTENT_WIDTH,
  SCROLL_TEXT_INSET_X,
  SCROLL_TEXT_ROW_HEIGHT,
  SCROLL_TEXT_VIEWPORT_HEIGHT,
  SCROLL_TEXT_VIEWPORT_WIDTH,
  scrollTextFlow,
} from "./scroll-text.ts";

const EMPTY_LINES: readonly string[] = [];
const EMPTY_COLOURS: readonly RpgMakerTextColourSpan[] = [];

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((line, index) => line === b[index]));
}

function sameColours(
  a: readonly RpgMakerTextColourSpan[],
  b: readonly RpgMakerTextColourSpan[],
): boolean {
  return a === b || (a.length === b.length && a.every((span, index) => {
    const other = b[index]!;
    return span.start === other.start && span.end === other.end && span.colour === other.colour;
  }));
}

export interface ScrollTextLayerProps {
  modal: Accessor<Modal | null>;
  /** Uncoloured text uses the dialog theme's normal ink. */
  theme?: Partial<UiTheme>;
}

function ColourRuns(props: {
  runs: readonly TextColourRun[];
  textColor: string;
}): JSX.Element {
  return (
    <For each={props.runs}>
      {(run) => (
        <Text
          class="text-xs"
          style={{
            textColor: run.colour ?? props.textColor,
            lineHeight: SCROLL_TEXT_ROW_HEIGHT,
            height: SCROLL_TEXT_ROW_HEIGHT,
            shrink: 0,
          }}
        >
          {run.text || " "}
        </Text>
      )}
    </For>
  );
}

export function ScrollTextLayer(props: ScrollTextLayerProps): JSX.Element {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const scroll = createMemo((): ScrollTextModal | null => {
    const modal = props.modal();
    return modal?.kind === "scrollText" ? modal : null;
  });
  // GameView publishes a cloned modal on every moving frame. Keep the
  // expensive glyph measurement and colour slicing keyed to content, not to
  // the offset-only modal identity.
  const lines = createMemo(
    () => scroll()?.lines ?? EMPTY_LINES,
    EMPTY_LINES,
    { equals: sameLines },
  );
  const colours = createMemo(
    () => scroll()?.colours ?? EMPTY_COLOURS,
    EMPTY_COLOURS,
    { equals: sameColours },
  );
  const flow = createMemo(() => scrollTextFlow(lines(), slotMeasure()));
  const colourRows = createMemo(() =>
    colours().length > 0
      ? revealColourRuns(flow(), Number.POSITIVE_INFINITY, colours())
      : null
  );

  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: 0,
        insetT: 0,
        width: SCROLL_TEXT_VIEWPORT_WIDTH,
        height: scroll()?.viewportHeight ?? SCROLL_TEXT_VIEWPORT_HEIGHT,
        overflow: 1,
        bgColor: CLEAR_COLOR,
        display: scroll() ? 0 : 1,
      }}
      debugName="rpgkit-scroll-text"
    >
      <View
        class="absolute flex-col"
        style={{
          posType: 1,
          insetL: SCROLL_TEXT_INSET_X,
          insetT: 0,
          width: SCROLL_TEXT_CONTENT_WIDTH,
          height: scroll()?.contentHeight ?? flow().rows.length * SCROLL_TEXT_ROW_HEIGHT,
          translateY: (scroll()?.viewportHeight ?? SCROLL_TEXT_VIEWPORT_HEIGHT) -
            (scroll()?.offset2 ?? 0) / 2,
        }}
        debugName="rpgkit-scroll-text-content"
      >
        <Show
          when={colourRows()}
          fallback={
            <For each={flow().rows}>
              {(row) => (
                <Text
                  class="text-xs"
                  style={{
                    textColor: theme().ink,
                    lineHeight: SCROLL_TEXT_ROW_HEIGHT,
                    height: SCROLL_TEXT_ROW_HEIGHT,
                    shrink: 0,
                  }}
                >
                  {row.text || " "}
                </Text>
              )}
            </For>
          }
        >
          {(rows) => (
            <For each={rows()}>
              {(runs) => (
                <View class="flex-row" style={{ height: SCROLL_TEXT_ROW_HEIGHT, shrink: 0 }}>
                  <ColourRuns runs={runs} textColor={theme().ink} />
                </View>
              )}
            </For>
          )}
        </Show>
      </View>
    </View>
  );
}
