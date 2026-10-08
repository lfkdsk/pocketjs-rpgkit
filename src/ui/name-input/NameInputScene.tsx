// src/ui/name-input/NameInputScene.tsx — the built-in name-input scene UI.
//
// Renders the JSON state of src/engine/name-input.ts's SceneRules: a titled
// edit box (buffer plus underscore padding), the charset grid and the
// BACK/OK/CANCEL actions, with a solid cursor cell. Pure presentation:
// every pixel is a function of `state` and the live logical resolution, so
// replay and rewind reproduce the same screen. The layout scales by an
// integer factor (1× at 480×272, 2× at 960×544); text uses the framework's
// fixed size classes, matching the framework OSK convention.
//
// The default caption and the three action cells are the ui-text table's
// `nameInput.*` words (GameView passes its resolved table as `uiText`). A
// caption wider than the panel wraps and pushes the box and grid down. The
// fixed action cells fit a long translation by the CommandGrid ladder —
// one 14 px row, one 10 px row, two 10 px rows, then a clipped 10 px row
// the focused cell scrolls — so a word is never cut.

import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createMemo, createSignal, For } from "solid-js";
import type { JsonValue } from "../../engine/types.ts";
import { breakText, hasForcedBreak } from "../../engine/text-break.ts";
import {
  NAME_INPUT_UI_TEXT,
  nameInputActionCount,
  nameInputActionKey,
  nameInputCharAt,
  type NameInputState,
} from "../../engine/name-input.ts";
import { withUiText, type UiTextOverrides } from "../../engine/ui-text.ts";
import { fitBounded, marqueeOffset } from "../list-window.ts";
import { BoundedLine } from "../BoundedLine.tsx";
import { slotMeasure, TEXT_2XS_SLOT } from "../text-measure.ts";
/** Font slot of `text-sm`. */
const TEXT_SM_SLOT = 1;
/** Font slot of `text-xs` (12 px). */
const TEXT_XS_SLOT = 0;
/** Row pitch of a one-row action label, and of a two-row 10 px label. */
const ONE_ROW_H = 14;
const SMALL_TWO_ROW_H = 10;
/** Leading of a two-row 10 px label (the core centres the 13 px atlas cell
 *  on the line height, so 8 lifts it within its 10 px row). */
const SMALL_TWO_ROW_LEADING = 8;

const COLOURS = {
  panelBg: "#141c30",
  panelBorder: "#4a5f8f",
  title: "#ffe17a",
  editBg: "#0b1626",
  editBorder: "#3a4a6a",
  buffer: "#ffffff",
  padding: "#3a4a6a",
  cell: "#c8d4f0",
  cursorBg: "#ffe17a",
  cursorText: "#0b1626",
};

/** How an action label sits in its fixed 40×20 cell: size (`small` =
 *  10 px), rows, and for a text too long for two 10 px rows how far its one
 *  clipped row overflows the cell. */
interface ActionLayout {
  kind: "one" | "two" | "clip";
  small: boolean;
  rows: string[];
  overflow: number;
}

/** A label's rows at one size: one row, or two broken where a row may
 *  break; null when it needs more, or a cut inside a word. */
function fitAction(label: string, slot: number, width: number): string[] | null {
  const measure = slotMeasure(slot);
  if (measure(label) <= width) return [label];
  const rows = breakText(label, width, measure);
  return rows.length <= 2 && !hasForcedBreak(label, rows) ? rows.map((row) => row.text) : null;
}

/** Lay out an action label for a cell of `cellW` px. */
function actionLayout(label: string, cellW: number): ActionLayout {
  // A 14 px row, then a 10 px row, then two 10 px rows (the cell is 20 px
  // tall, so two 14 px rows cannot physically fit).
  const one = fitAction(label, TEXT_XS_SLOT, cellW);
  if (one && one.length === 1) return { kind: "one", small: false, rows: one, overflow: 0 };
  const smallOne = fitAction(label, TEXT_2XS_SLOT, cellW);
  if (smallOne && smallOne.length === 1) return { kind: "one", small: true, rows: smallOne, overflow: 0 };
  const smallTwo = fitAction(label, TEXT_2XS_SLOT, cellW);
  if (smallTwo) return { kind: "two", small: true, rows: smallTwo, overflow: 0 };
  const overflow = Math.max(0, slotMeasure(TEXT_2XS_SLOT)(label) - cellW);
  return { kind: "clip", small: true, rows: [label], overflow };
}

const sameLayout = (a: ActionLayout, b: ActionLayout): boolean =>
  a.kind === b.kind && a.small === b.small && a.overflow === b.overflow &&
  a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]);

export interface NameInputSceneProps {
  state: JsonValue;
  width: number;
  height: number;
  /** False while GameView retains this scene off-screen. Hidden cells stop
   *  participating in global focus traversal as well as hit testing. */
  active?: boolean;
  /** UI input bridge supplied by GameView. The reducer validates the index,
   *  moves its cursor and activates the entry in one deterministic fold. */
  onSelectIndex?: (index: number) => void;
  /** The game's replacements of the kit's words (GameView passes them). */
  uiText?: UiTextOverrides;
}

export function NameInputScene(props: NameInputSceneProps) {
  const st = (): NameInputState => props.state as unknown as NameInputState;
  const s = (): number =>
    Math.max(1, Math.round(Math.min(props.width / 480, props.height / 272)));

  const panel = () => ({
    x: 20 * s(),
    y: 10 * s(),
    w: 440 * s(),
    h: 252 * s(),
  });
  const text = () => withUiText(NAME_INPUT_UI_TEXT, props.uiText);
  // The grid's row count (charset rows plus the action row) sets how many
  // title rows fit before the action row would leave the panel: the panel
  // is 252 px, the grid starts at y = 80 + drop and each row is 20 px, so
  // the caption may grow to floor((172 - rows*20) / 18) + 1 rows. A longer
  // caption scrolls sideways (a marquee) instead of pushing the grid out.
  const gridRowCount = (): number =>
    Math.ceil((st().charset.length + nameInputActionCount(st())) / st().columns);
  const maxTitleRows = (): number => Math.max(1, Math.floor((172 - gridRowCount() * 20) / 18) + 1);
  const titleCell = createMemo(() => {
    const state = st();
    // Only a scene that omitted its title takes the table's word; an
    // explicit title (even the literal "Name") is kept as authored.
    const title = state.titleIsDefault ? text()["nameInput.title"] : state.title;
    return fitBounded(title, panel().w - 24 * s(), maxTitleRows(), slotMeasure(TEXT_SM_SLOT));
  });
  // Rows a wrapped caption adds push the edit box and grid down, capped so
  // the action row never leaves the panel.
  const drop = (): number => Math.min((titleCell().rows.length - 1) * 18, 172 - gridRowCount() * 20) * s();
  const edit = () => ({ x: 32 * s(), y: 38 * s() + drop(), w: 416 * s(), h: 30 * s() });
  const grid = () => ({ x: 40 * s(), y: 80 * s() + drop(), cellW: 40 * s(), cellH: 20 * s() });
  const charW = (): number => 16 * s();

  const entryLabel = (index: number): string => {
    const state = st();
    if (index < state.charset.length) return nameInputCharAt(state, index);
    const key = nameInputActionKey(state, index);
    return key ? text()[key] : "";
  };

  // Each action cell's layout, recomputed only when its label changes. The
  // RANDOM cell (index 3) exists only when the state resolved a candidate
  // list; its memo stays mounted but the cell is never drawn.
  const actionLayouts = [0, 1, 2, 3].map((i) =>
    createMemo(
      () => {
        const state = st();
        const index = state.charset.length + i;
        return actionLayout(entryLabel(index), grid().cellW - 4 * s());
      },
      undefined,
      { equals: sameLayout },
    ));
  // The focused action cell's marquee ticks only while it overflows, and
  // the caption's marquee while it does.
  const [tick, setTick] = createSignal(0);
  const focusedOverflow = createMemo(() => {
    const state = st();
    const actionIndex = state.cursor - state.charset.length;
    if (actionIndex < 0 || actionIndex >= nameInputActionCount(state)) return 0;
    return actionLayouts[actionIndex]?.().overflow ?? 0;
  });
  onFrame(() => {
    if (focusedOverflow() > 0 || titleCell().kind === "marquee") setTick((t) => t + 1);
  });

  const cellStyle = (index: number) => {
    const state = st();
    const g = grid();
    const p = panel();
    const row = Math.floor(index / state.columns);
    const col = index % state.columns;
    const cursor = index === state.cursor;
    return {
      posType: 1,
      insetL: g.x - p.x + col * g.cellW,
      insetT: g.y - p.y + row * g.cellH,
      width: g.cellW,
      height: g.cellH,
      ...(cursor ? { bgColor: COLOURS.cursorBg } : {}),
    } as Record<string, number | string>;
  };

  const entries = (): number[] => {
    const state = st();
    return Array.from(
      { length: state.charset.length + nameInputActionCount(state) },
      (_, i) => i,
    );
  };

  /** Stable, paint-free hit cell. Visual cells keep their existing render
   *  lifecycle (and exact pixels); this keyed layer survives the reducer
   *  state update between a touch release and deferred onPress delivery. */
  const hitCell = (index: number) => {
    const state = st();
    const g = grid();
    const p = panel();
    const row = Math.floor(index / state.columns);
    const col = index % state.columns;
    return (
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: g.x - p.x + col * g.cellW,
          insetT: g.y - p.y + row * g.cellH,
          width: g.cellW,
          height: g.cellH,
        }}
        focusable={props.active !== false && props.onSelectIndex !== undefined}
        onPress={() => props.onSelectIndex?.(index)}
        debugName={`rpgkit-name-input-hit-${index}`}
      />
    );
  };

  /** A charset cell's text (single character, fixed 20 px row). */
  const charsetCell = (index: number) => (
    <View
      class="absolute items-center justify-center"
      style={cellStyle(index)}
      debugName={`rpgkit-name-input-cell-${index}`}
    >
      <Text
        class="text-sm"
        style={{
          textColor: index === st().cursor ? COLOURS.cursorText : COLOURS.cell,
          height: 20 * s(),
          lineHeight: 20 * s(),
        }}
      >
        {entryLabel(index)}
      </Text>
    </View>
  );

  /** An action cell: the ladder's one/two/clip layout for its label. */
  const actionCell = (index: number) => {
    const actionIndex = index - st().charset.length;
    const layout = actionLayouts[actionIndex]!;
    const cursor = () => index === st().cursor;
    const colour = () => cursor() ? COLOURS.cursorText : COLOURS.cell;
    const size = () => (layout().small ? "text-2xs" : "text-xs");
    const offset = () => (cursor() ? marqueeOffset(layout().overflow, tick()) : 0);
    const debug = `rpgkit-name-input-cell-${index}`;
    return (
      <View
        class="absolute items-center justify-center"
        style={cellStyle(index)}
        debugName={debug}
      >
        {layout().kind === "clip" ? (
          <View
            style={{ width: grid().cellW - 4 * s(), height: ONE_ROW_H * s(), overflow: 1 }}
            debugName={`${debug}-clip`}
          >
            <Text
              class={size()}
              style={{ textColor: colour(), lineHeight: ONE_ROW_H * s(), height: ONE_ROW_H * s(), shrink: 0, translateX: -offset() }}
              debugName={`${debug}-marquee`}
            >
              {layout().rows[0]!}
            </Text>
          </View>
        ) : (
          <Text
            class={size()}
            style={{
              textColor: colour(),
              lineHeight: (layout().kind === "two" ? SMALL_TWO_ROW_LEADING : ONE_ROW_H) * s(),
              height: (layout().kind === "two" ? 2 * SMALL_TWO_ROW_H : ONE_ROW_H) * s(),
            }}
          >
            {layout().rows.join("\n")}
          </Text>
        )}
      </View>
    );
  };

  return (
    <View
      class="absolute"
      style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: props.height }}
      debugName="rpgkit-name-input-scene"
    >
      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: panel().x,
          insetT: panel().y,
          width: panel().w,
          height: panel().h,
          bgColor: COLOURS.panelBg,
          borderWidth: 2 * s(),
          borderColor: COLOURS.panelBorder,
        }}
        debugName="rpgkit-name-input-panel"
      >
        {titleCell().kind === "wrap" ? (
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: 12 * s(),
              insetT: 6 * s(),
              textColor: COLOURS.title,
              height: 18 * s() * titleCell().rows.length,
              lineHeight: 18 * s(),
            }}
          >
            {titleCell().rows.join("\n")}
          </Text>
        ) : (
          <View
            style={{
              posType: 1,
              insetL: 12 * s(),
              insetT: 6 * s(),
              width: panel().w - 24 * s(),
              height: 18 * s(),
              overflow: 1,
            }}
          >
            <Text
              class="text-sm"
              style={{
                textColor: COLOURS.title,
                height: 18 * s(),
                lineHeight: 18 * s(),
                shrink: 0,
                translateX: -marqueeOffset(titleCell().overflow, tick()) * s(),
              }}
            >
              {titleCell().rows[0]}
            </Text>
          </View>
        )}

        <View
          class="absolute"
          style={{
            posType: 1,
            insetL: edit().x - panel().x,
            insetT: edit().y - panel().y,
            width: edit().w,
            height: edit().h,
            bgColor: COLOURS.editBg,
            borderWidth: s(),
            borderColor: COLOURS.editBorder,
          }}
          debugName="rpgkit-name-input-editbox"
        >
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: 8 * s(),
              insetT: 5 * s(),
              textColor: COLOURS.buffer,
              height: 20 * s(),
              lineHeight: 20 * s(),
            }}
          >
            {st().buffer}
          </Text>
          <Text
            class="text-sm"
            style={{
              posType: 1,
              insetL: 8 * s() + st().buffer.length * charW(),
              insetT: 5 * s(),
              textColor: COLOURS.padding,
              height: 20 * s(),
              lineHeight: 20 * s(),
            }}
          >
            {"_".repeat(Math.max(0, st().maxLength - st().buffer.length))}
          </Text>
        </View>

        {entries().map((index) => (index < st().charset.length ? charsetCell(index) : actionCell(index)))}
        <For each={entries()}>{(index) => hitCell(index)}</For>
      </View>
    </View>
  );
}
