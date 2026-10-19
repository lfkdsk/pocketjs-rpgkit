// src/ui/battle/StatBar.tsx — KB4: an HP/XP bar. The fill width is a pure
// function of the `current`/`max` props (typically computed by the caller
// from a Tween via effects.ts's tweenAt against its own reference-tick
// cursor), so replaying the same state at any tick, Hz, or after an
// L-rewind paints the same width. The readout's wording is the ui-text
// key `battle.statValue` ("{current} / {max}").
//
// The readout is never cut. Without a fixed `numbersWidth` it takes its
// intrinsic width. With one (a reserved HUD cell) it is fitted like a
// CommandGrid cell: one row at 12 px, then two rows at 12 px (the cell
// grows downward), then two rows at 10 px, then one 10 px row clipped to
// the cell which scrolls sideways (a marquee on the bar's own tick, so a
// rewind shows the same frame) so every character still comes into view.

import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createMemo, createSignal } from "solid-js";
import { resolveUiTheme, windowToneDecoration, type UiTheme } from "../theme.ts";
import { barFillWidth } from "./effects.ts";
import { marqueeOffset } from "../list-window.ts";
import { slotMeasure } from "../text-measure.ts";
import { formatUiText, type UiTextOverrides } from "../../engine/ui-text.ts";
import { readoutLayout, type ReadoutLayout } from "./text.ts";

export interface StatBarProps {
  /** Current value, already the tweened point-in-time number (not clamped
   *  by this component: a caller mid-tween may pass a fractional value). */
  current: number;
  max: number;
  width: number;
  height?: number;
  /** Fill colour; defaults to the theme's accent. */
  fill?: string;
  /** Track (empty) colour; defaults to the theme's border. */
  track?: string;
  theme?: Partial<UiTheme>;
  /** "137 / 220" readout to the bar's right. Omit for a bare bar. */
  showNumbers?: boolean;
  /** Fixed readout cell for paint-only number changes in a reserved HUD area. */
  numbersWidth?: number;
  /** The game's words (engine/ui-text.ts): `battle.statValue` rewords the
   *  readout. A scene view passes on the `uiText` GameView gives it. */
  uiText?: UiTextOverrides;
  debugName?: string;
}

const BAR_HEIGHT = 6;
/** Row pitch of a one-row readout (both sizes). */
const ONE_ROW_H = 14;
/** Row pitch of a two-row 12 px readout. */
const TWO_ROW_H = 11;
/** Row pitch and leading of a two-row 10 px readout. */
const SMALL_TWO_ROW_H = 10;
const SMALL_TWO_ROW_LEADING = 8;

const sameLayout = (a: ReadoutLayout, b: ReadoutLayout): boolean =>
  a.kind === b.kind && a.small === b.small && a.overflow === b.overflow &&
  a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]);

export function StatBar(props: StatBarProps) {
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const height = () => props.height ?? BAR_HEIGHT;
  const fillScale = createMemo(() => props.width > 0
    ? barFillWidth(props.current, props.max, props.width) / props.width
    : 0);
  // The readout text: the English template literal unless the game
  // replaced `battle.statValue`.
  const readoutText = createMemo(() => {
    const current = Math.max(0, Math.round(props.current));
    const max = Math.round(props.max);
    const template = props.uiText?.["battle.statValue"];
    return template === undefined ? `${current} / ${max}` : formatUiText(template, { current, max });
  });
  // A fixed cell fits the readout by the ladder; an intrinsic readout
  // (no numbersWidth) is one row and never clips.
  const layout = createMemo(
    () => (props.numbersWidth === undefined
      ? { kind: "one", small: false, rows: [readoutText()], overflow: 0 } as ReadoutLayout
      : readoutLayout(readoutText(), props.numbersWidth)),
    undefined,
    { equals: sameLayout },
  );
  // The marquee ticks only while the clipped readout overflows, so a bar
  // with nothing to scroll emits zero repaint.
  const overflow = createMemo(() => layout().overflow);
  const [tick, setTick] = createSignal(0);
  onFrame(() => {
    if (overflow() > 0) setTick((t) => t + 1);
  });
  const size = createMemo(() => (layout().small ? "text-2xs" : "text-xs"));
  const offset = createMemo(() => marqueeOffset(layout().overflow, tick()));

  return (
    <View class="flex-row items-center" debugName={props.debugName}>
      <View
        class="flex-row"
        style={{
          width: props.width,
          height: height(),
          ...windowToneDecoration(
            props.track === undefined ? theme() : {},
            { bgColor: props.track ?? theme().border },
          ),
        }}
        debugName={props.debugName ? `${props.debugName}-track` : undefined}
      >
        <View
          style={{
            width: props.width,
            height: height(),
            bgColor: props.fill ?? theme().accent,
            scaleX: fillScale(),
            originX: -0.5,
          }}
          debugName={props.debugName ? `${props.debugName}-fill` : undefined}
        />
      </View>
      {props.showNumbers ? (
        layout().kind === "clip" ? (
          <View
            style={{ width: props.numbersWidth!, height: ONE_ROW_H, overflow: 1, insetL: 6 }}
            debugName={props.debugName ? `${props.debugName}-numbers` : undefined}
          >
            <Text
              class={size()}
              style={{ textColor: theme().ink, lineHeight: ONE_ROW_H, height: ONE_ROW_H, shrink: 0, translateX: -offset() }}
              debugName={props.debugName ? `${props.debugName}-numbers-marquee` : undefined}
            >
              {layout().rows[0]!}
            </Text>
          </View>
        ) : (
          <Text
            class={size()}
            style={{
              textColor: theme().ink,
              lineHeight: layout().kind === "two" ? (layout().small ? SMALL_TWO_ROW_LEADING : TWO_ROW_H) : ONE_ROW_H,
              height: layout().kind === "two"
                ? 2 * (layout().small ? SMALL_TWO_ROW_H : TWO_ROW_H)
                : ONE_ROW_H,
              insetL: 6,
              ...(props.numbersWidth === undefined ? {} : { width: props.numbersWidth }),
            }}
            debugName={props.debugName ? `${props.debugName}-numbers` : undefined}
          >
            {layout().rows.join("\n")}
          </Text>
        )
      ) : null}
    </View>
  );
}
