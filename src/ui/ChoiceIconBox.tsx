// src/ui/ChoiceIconBox.tsx — the choices box with a picture beside every
// option (ChoiceOption.icon); the `pocket-rpgkit/ui/choice-icons` entry.
// The sprite lookup is ui/choice-icons.ts.
//
// Pay for use: a game opts in by passing this component to GameView's
// `choiceIcons` (or DialogBox's `choiceIconBox`) prop, so games without
// icons do not bundle it. DialogBox mounts the box the first time a choices
// modal carries `icons` (the interpreter sets them only when an authored
// option has an icon) and keeps it mounted, hidden, afterwards; the
// text-only choices box renders exactly as before.
//
//   ┌──────────────────────────────┐  248 px wide, docked bottom right
//   │ Who do you ask?              │  (the message box is hidden during
//   │┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓│   choices, so the box takes its place
//   │┃ ☺  The curator             ┃│   and grows upward)
//   │┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛│  selected row: accent frame over an
//   │  ☺  The guide                │   accent tint, label in accent
//   │ [?] Someone else             │  missing sprite: framed "?" box
//   │                    ok  back  │
//   └──────────────────────────────┘
//
// An option is 24 px tall for a one-row label, 14 px taller per extra row:
// a label wider than its column wraps (list-window.ts wrapLabel), and so
// does the prompt, onto as many 14 px rows as it needs; nothing is cut.
// The box grows upward by the extra rows. It still shows at most four
// options, fewer when their rows would push the box off the top of the
// screen (windowByRows), and the selected option is always whole. The
// cursor bar covers every row of the selected option.
//
// Icons draw at 1x, nearest-neighbour, in a 16x24 cell at the top of the
// option: a 16x16 image is centred in it; a 16x32 walker frame is anchored
// at its feet and its top 8 rows are clipped. Walker sheets leave that band
// for heads that overflow the tile above, and the Tuxemon characters (rows
// 11..30 of the frame) come out centred in the cell, whole.

import { createMemo, For, Show, type Accessor, type Component } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { ChoiceModal } from "../engine/interpreter.ts";
import { windowByRows, wrapLabel } from "./list-window.ts";
import type {
  ChoiceTextRow,
  ChoiceTextRuntime,
  ChoiceTextRunsProps,
} from "./choice-text-contract.ts";
import { Panel } from "./Panel.tsx";
import { slotMeasure } from "./text-measure.ts";
import type { ChoiceIconArt, ChoiceIconResolver } from "./choice-icons.ts";
import { windowTonePaletteColor, type UiTheme } from "./theme.ts";

export { resolveChoiceIcon, type ChoiceIconArt, type ChoiceIconBoxComponent, type ChoiceIconResolver } from "./choice-icons.ts";

const ROWS = [0, 1, 2, 3];
/** Height of a one-row option; the icon cell is this tall. */
const ROW_H = 24;
/** Height of a text row (prompt and label rows). */
const LINE_H = 14;
/** A label's first row sits centred in the 24 px cell, the rest below it. */
const LABEL_T = (ROW_H - LINE_H) / 2;
/** Content width: the 248 px box minus the Panel's 2 px border and the
 *  paper's 6 px padding (p-[6]) per side. The prompt rows span it. */
const CONTENT_W = 248 - 2 * (2 + 6);
/** Pixel width of an option label: the label starts 26 px into the row
 *  (insetL, past the 4 px inset 16 px icon cell and a 6 px gap) and stops
 *  4 px short of the row's end, mirroring the icon's inset, so its ink
 *  stays inside the cursor bar's 1 px frame. */
const LABEL_W = CONTENT_W - 26 - 4;
/** Box height with a one-row prompt and four one-row options: frame 2 +
 *  padding 6, prompt 14, gap 4, four rows, gap 2, legend 12, padding 6 +
 *  frame 2. */
const BOX_H = 144;
/** The box's distance from the bottom of the screen (insetB), kept free
 *  above it too when the box grows. */
const BOX_MARGIN = 8;
/** Screen height assumed when the props give none: the PSP's 272 px. */
const SCREEN_H = 272;
const NO_OPTIONS: readonly string[] = [];
const NO_COLOUR_ROWS: readonly ChoiceTextRow[] = [];
const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a === b || (a.length === b.length && a.every((line, i) => line === b[i]));
const sameColourColumns = (
  a: ChoiceModal["optionColours"],
  b: ChoiceModal["optionColours"],
): boolean => a === b || (!!a && !!b && a.length === b.length && a.every((spans, index) => {
  const other = b[index];
  return spans === other || (!!spans && !!other && spans.length === other.length &&
    spans.every((span, at) => span.start === other[at]!.start && span.end === other[at]!.end &&
      span.colour === other[at]!.colour));
}));
const sameChoiceRows = (a: readonly ChoiceTextRow[], b: readonly ChoiceTextRow[]): boolean =>
  a === b || (a.length === b.length && a.every((row, index) => {
    const other = b[index]!;
    return row.text === other.text && row.runs.length === other.runs.length &&
      row.runs.every((run, at) => run.text === other.runs[at]!.text && run.colour === other.runs[at]!.colour);
  }));
const EmptyChoiceRuns: Component<ChoiceTextRunsProps> = () => null;
/** Height of an option whose label takes `rows` rows. */
const optionH = (rows: number): number => ROW_H + (rows - 1) * LINE_H;

/** A row's picture: art, MISSING (the "?" placeholder) or null (the option
 *  has no icon; its label stays aligned with the others). */
type RowArt = ChoiceIconArt | typeof MISSING | null;
const MISSING = 0;
const warned = new Set<string>();

/** Log a sprite key that cannot paint, once per key per session. The kit
 *  has no development build (the PocketJS build always defines
 *  NODE_ENV=production), so the warning is this one deduplicated line; the
 *  "?" placeholder in the row is the in-game signal. */
function missing(sprite: string): typeof MISSING {
  if (!warned.has(sprite)) {
    warned.add(sprite);
    console.warn(`pocket-rpgkit: choice icon sprite "${sprite}" cannot paint`);
  }
  return MISSING;
}

export interface ChoiceIconBoxProps {
  /** The open choices modal when it has icons, else null (box hidden). */
  modal: Accessor<ChoiceModal | null>;
  legend: Accessor<string>;
  theme: Accessor<UiTheme>;
  resolve?: ChoiceIconResolver;
  /** Optional styled-choice implementation supplied by RPG Maker projects. */
  choiceText?: ChoiceTextRuntime;
  /** Screen height in px, which bounds how far the box may grow upward
   *  (default 272, the PSP screen; DialogBox does not pass one). */
  viewportHeight?: number;
}

/** Indices of a Text pool that only grows: rows mounted for a longer text
 *  stay mounted, hidden, after it, so a later long text restyles them
 *  instead of building nodes. Starts with one row. */
function growingPool(count: () => number): Accessor<number[]> {
  return createMemo((prev: number[]) => {
    const n = count();
    return n <= prev.length ? prev : Array.from({ length: n }, (_, i) => i);
  }, [0]);
}

export function ChoiceIconBox(props: ChoiceIconBoxProps) {
  const theme = props.theme;
  const measure = slotMeasure();
  const ChoiceRuns = props.choiceText?.Runs ?? EmptyChoiceRuns;
  // Compared by content (the reducer may copy the modal on any step), so
  // the lookups, and any warning, run once per opened menu.
  const icons = createMemo(() => props.modal()?.icons, undefined, {
    equals: (a, b) =>
      a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => {
        const y = b[i];
        return x === y || (!!x && !!y && x.sprite === y.sprite && x.dir === y.dir && x.frame === y.frame);
      })),
  });
  const arts = createMemo((): RowArt[] =>
    (icons() ?? []).map((icon) => icon && (props.resolve?.(icon) ?? missing(icon.sprite))));
  const index = () => props.modal()?.index ?? 0;
  // Content-compared too: the labels wrap once per menu, not per step.
  const options = createMemo(() => props.modal()?.options ?? NO_OPTIONS, NO_OPTIONS, { equals: sameLines });
  const optionColours = createMemo(() => props.modal()?.optionColours, undefined, { equals: sameColourColumns });
  const labels = createMemo(() => options().map((label, at) => {
    const spans = optionColours()?.[at];
    return spans && props.choiceText
      ? props.choiceText.wrap(label, LABEL_W, measure, spans)
      : wrapLabel(label, LABEL_W, measure).map((text) => ({ text, runs: [] }));
  }));
  const counts = createMemo(() => labels().map((rows) => rows.length));
  const promptRows = createMemo(() => {
    const modal = props.modal();
    const source = modal?.prompt ?? "";
    return modal?.promptColours && props.choiceText
      ? props.choiceText.wrap(source, CONTENT_W, measure, modal.promptColours)
      : wrapLabel(source, CONTENT_W, measure).map((text) => ({ text, runs: [] }));
  }, [{ text: "", runs: [] }], { equals: sameChoiceRows });
  // Label rows the four-option window may hold: what the screen leaves
  // above the box's bottom margin for the options, less the 10 px each of
  // four options adds to its rows (optionH), in 14 px rows.
  const maxRows = () => {
    const room = (props.viewportHeight ?? SCREEN_H) - 2 * BOX_MARGIN - (BOX_H - ROWS.length * ROW_H) -
      (promptRows().length - 1) * LINE_H;
    return Math.max(1, Math.floor((room - ROWS.length * (ROW_H - LINE_H)) / LINE_H));
  };
  const win = createMemo(() => windowByRows(index(), counts(), ROWS.length, maxRows()), undefined, {
    equals: (a, b) => a.start === b.start && a.end === b.end,
  });
  // The option area keeps the four-row height it always had and grows by
  // the extra rows of the options in the window.
  const areaH = createMemo(() => {
    const { start, end } = win();
    let h = 0;
    for (let i = start; i < end; i++) h += optionH(counts()[i]!);
    return Math.max(ROWS.length * ROW_H, h);
  });
  const boxH = () => BOX_H + (promptRows().length - 1) * LINE_H + areaH() - ROWS.length * ROW_H;
  const bar = () => {
    let top = 0;
    for (let i = win().start; i < index(); i++) top += optionH(counts()[i]!);
    return { posType: 1, insetL: 0, insetR: 0, insetT: top, height: optionH(counts()[index()] ?? 1) };
  };
  const promptPool = growingPool(() => promptRows().length);

  return (
    <Panel
      theme={theme()}
      style={{ posType: 1, width: 248, height: boxH(), insetR: 12, insetB: BOX_MARGIN, display: props.modal() ? 0 : 1 }}
      paperClass="flex-col p-[6]"
      debugName="rpgkit-choices-icon-box"
    >
      {/* One Text per prompt row; the first always holds its 14 px. */}
      <For each={promptPool()}>
        {(row) => {
          const prompt = () => promptRows()[row];
          return (
            <Show when={props.modal()?.promptColours && props.choiceText} fallback={
              <Text
                class="text-xs"
                style={{
                  textColor: theme().dim,
                  lineHeight: LINE_H,
                  height: LINE_H,
                  display: row === 0 || row < promptRows().length ? 0 : 1,
                }}
              >
                {prompt()?.text || " "}
              </Text>
            }>
              <View
                class="flex-row"
                style={{
                  height: LINE_H,
                  display: row === 0 || row < promptRows().length ? 0 : 1,
                }}
              >
                <ChoiceRuns
                  runs={prompt()?.runs ?? []}
                  textColor={theme().dim}
                  rowH={LINE_H}
                />
              </View>
            </Show>
          );
        }}
      </For>
      <View style={{ height: areaH(), marginT: 4, flexDir: 1 }}>
        {/* The cursor bar under the rows, spanning icon and label: an
            accent tint and an opaque 1 px accent frame. */}
        <View style={{ ...bar(), bgColor: theme().accent, opacity: 0.2 }} />
        <View style={{ ...bar(), borderWidth: 1, borderColor: theme().accent }} />
        <For each={ROWS}>
          {(row) => {
            const at = () => win().start + row;
            const shown = () => at() < win().end;
            const rows = createMemo(
              () => (shown() ? labels()[at()] ?? NO_COLOUR_ROWS : NO_COLOUR_ROWS),
              NO_COLOUR_ROWS,
              { equals: sameChoiceRows },
            );
            return iconRow(at, shown, rows, props, arts, theme);
          }}
        </For>
      </View>
      <Text class="text-xs" style={{ textColor: theme().dim, lineHeight: 12, height: 12, marginT: 2, textAlign: 2 }}>
        {`${props.legend()}`}
      </Text>
    </Panel>
  );
}

/** One option: the picture in a clipped 16 px cell 4 px in at the top, the
 *  label rows 6 px after it, one Text per row. */
function iconRow(
  at: () => number,
  shown: () => boolean,
  rows: Accessor<readonly ChoiceTextRow[]>,
  props: ChoiceIconBoxProps,
  arts: Accessor<RowArt[]>,
  theme: Accessor<UiTheme>,
) {
  const ChoiceRuns = props.choiceText?.Runs ?? EmptyChoiceRuns;
  const art = () => (shown() ? arts()[at()] ?? null : null);
  const image = () => art() || null;
  const disabled = () => props.modal()?.enabled?.[at()] === false;
  const rowColor = () => disabled() ? theme().dim : props.modal()?.index === at() ? theme().accent : theme().ink;
  const pool = growingPool(() => rows().length);
  return (
    <View style={{ height: optionH(Math.max(1, rows().length)), flexDir: 0, align: 1, overflow: 1, display: shown() ? 0 : 1 }}>
      <Image
        src={image()?.src ?? ""}
        style={{
          posType: 1,
          insetL: 4,
          insetT: ROW_H - (image()?.h === 32 ? 32 : 20),
          width: 16,
          height: image()?.h ?? 16,
          display: image() ? 0 : 1,
        }}
      />
      <Text
        class="text-xs"
        style={{
          posType: 1,
          insetL: 4,
          insetT: 4,
          width: 16,
          height: 16,
          lineHeight: 16,
          textAlign: 1,
          textColor: theme().dim,
          bgColor: windowTonePaletteColor(theme(), theme().paper),
          borderWidth: 1,
          borderColor: theme().dim,
          display: art() === MISSING ? 0 : 1,
        }}
      >
        ?
      </Text>
      <For each={pool()}>
        {(line) => {
          const row = () => rows()[line];
          return (
            <Show when={props.modal()?.optionColours?.[at()] && props.choiceText} fallback={
              <Text
                class="text-xs"
                style={{
                  posType: 1,
                  insetL: 26,
                  insetT: LABEL_T + line * LINE_H,
                  textColor: rowColor(),
                  lineHeight: LINE_H,
                  height: LINE_H,
                  display: line < rows().length ? 0 : 1,
                }}
              >
                {row()?.text || " "}
              </Text>
            }>
              <View
                class="flex-row"
                style={{
                  posType: 1,
                  insetL: 26,
                  insetT: LABEL_T + line * LINE_H,
                  width: LABEL_W,
                  height: LINE_H,
                  display: line < rows().length ? 0 : 1,
                }}
              >
                <ChoiceRuns
                  runs={row()?.runs ?? []}
                  textColor={rowColor()}
                  rowH={LINE_H}
                />
              </View>
            </Show>
          );
        }}
      </For>
    </View>
  );
}
