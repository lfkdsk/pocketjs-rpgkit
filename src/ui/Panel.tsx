// src/ui/Panel.tsx — the kit's framed box: the border layer, the paper
// layer inset 2 px inside it, and the theme's optional rim ring. DialogBox
// (message and choices boxes) and SaveMenu draw their frames with it; a game
// uses it for its own panels (a help or status screen) so they match.
//
//   View  style + bgColor: border        the frame, sized by the caller
//     View  inset 2, bgColor: paper      the children's box (paperClass)
//           + a 1 px rim-coloured inset border when the theme has a rim
//
// The rim is the paper's own inset border (PROP.borderWidth draws inside the
// box and never affects layout), so a rim costs no extra node and leaves
// the children exactly where they are without one. Turning the rim on or off
// swaps the paper layer: a style key the renderer has set is never unset, so
// the rimless paper must be a node that never had one.

import { createMemo, Show, type JSX } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { resolveUiTheme, windowToneDecoration, type UiTheme } from "./theme.ts";

export interface PanelProps {
  /** Frame and paper colours; missing keys keep DEFAULT_UI_THEME. */
  theme?: Partial<UiTheme>;
  /** Style of the outer (border) box: position and size. */
  style?: Record<string, number | string>;
  /** Class of the paper layer, which lays out the children. */
  paperClass?: string;
  debugName?: string;
  children?: JSX.Element;
}

export function Panel(props: PanelProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const border = createMemo(() => windowToneDecoration(theme(), { bgColor: theme().border }));
  const paper = createMemo(() => windowToneDecoration(theme(), {
    bgColor: theme().paper,
    ...(theme().rim === undefined ? {} : { borderColor: theme().rim }),
  }));
  const hasRim = createMemo(() => theme().rim !== undefined);
  return (
    <View class="flex-col p-[2]" style={{ ...props.style, ...border() }} debugName={props.debugName}>
      <Show
        when={hasRim()}
        fallback={
          <View
            class={props.paperClass ?? "flex-col"}
            style={{ posType: 1, insetL: 2, insetT: 2, insetR: 2, insetB: 2, ...paper() }}
          >
            {props.children}
          </View>
        }
      >
        <View
          class={props.paperClass ?? "flex-col"}
          style={{
            posType: 1,
            insetL: 2,
            insetT: 2,
            insetR: 2,
            insetB: 2,
            borderWidth: 1,
            ...paper(),
          }}
        >
          {props.children}
        </View>
      </Show>
    </View>
  );
}
