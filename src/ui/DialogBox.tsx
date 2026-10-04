// src/ui/DialogBox.tsx — P1③ message layer: the typewriter dialog
// box and the choices box (docs/HIG.md §2.4 screen anatomy). The component is
// pure presentation: the interpreter reducer (engine/interpreter.ts) owns
// every word and the cursor; Solid signals only repaint when the visible
// string changes, so a fully-revealed box emits zero guest->core ops.
//
// Every row is its OWN fixed Text node (max four rows, the schema's
// commands.text.lines cap). One multiline Text repaints whole-document on
// every typed character and the framework's row pool leaves stale glyphs
// behind when the document shrinks; four independent row nodes change only
// their own line and nothing else.
//
//   ┌───────────────────────────┐  choices box (when modal=choices),
//   │  Read the weathered note? │    right-aligned above the message box
//   │  >Read note              │
//   │    Walk on                │
//   └───────────────────────────┘
//   ┌───────────────────────────┐  message box docked to the bottom
//   │ BRAMBLE MEADOW            │    of the 480x272 playfield
//   │ South: quiet grass....    │
//   │                   ○ next  │
//   └───────────────────────────┘
//
// All three boxes are Panels coloured by the `theme` prop (ui/theme.ts); without
// one they draw the kit's default palette. The shop's own words (stage,
// gold, Sell/Leave/Back, the price column) come from the `uiText` table
// (engine/ui-text.ts), English by default, and wrap like item names.
//
// Portraits. With a `faces` table, a text whose first line opens with a
// listed speaker ("KEEPER: The lamp is lit.") shows that speaker's 64x64
// image in a column left of the text and a name tab ("Keeper") on the
// box's top edge. The prefix is dropped from the typed text; the
// interpreter still counts it, so the reveal is offset by its length (the
// words start after that many characters' worth of typing time). Other
// lines hide the column and the tab and lay out exactly as without faces.
// The portrait never changes the box's size or place: it is scaled
// (nearest neighbour) to the box's inner height, 64 px in a band and 48 px
// in a 480x272 corner or side box (dialog-pages.ts dialogFaceSize), and the
// tab of a box against the top edge of the screen hangs below it.
//
//     ┌ Keeper ┐
//   ┌─┴────────┴────────────────┐
//   │ ┌──────┐ The lamp is lit. │
//   │ │ face │ Climb while the  │
//   │ └──────┘           ○ next │
//   └───────────────────────────┘
//
// Layout. A text command may place its box (`position`: the top, centre or
// bottom band, a corner or a side; dialog-pages.ts has the geometry), align
// each row left/centre/right and the page's rows top/centre/bottom in the
// box's text area, and draw it on the framed window, a translucent fill
// without the frame ("dim") or nothing ("transparent"). A text without
// layout fields carries no `box` and draws exactly the default box. Rows
// are aligned as whole rows (paint offsets of the fixed row nodes), so the
// typewriter never shifts letters it has already drawn.

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import type { Modal, ShopRow } from "../engine/interpreter.ts";
import { fitBounded, marqueeOffset, windowByRows, wrapLabel, type BoundedCell } from "./list-window.ts";
import { useMarqueeTick } from "./use-marquee-tick.ts";
import { BoundedLine } from "./BoundedLine.tsx";
import { flowRows, revealRows } from "./text-flow.ts";
import {
  DIALOG_PAGE_VIEWPORT,
  DIALOG_ROWS,
  DIALOG_VIEWPORT_H,
  dialogAlignShift,
  dialogBoxBottom,
  dialogBoxHeight,
  dialogBoxInsets,
  dialogBoxRows,
  dialogColumnWidth,
  dialogFaceColumn,
  dialogFaceSize,
  dialogTextAreaHeight,
  dialogValignShift,
  messagePage,
  messageSpeaker,
  pageRevealed,
  shownMessageLines,
} from "./dialog-pages.ts";
import { slotMeasure } from "./text-measure.ts";
import { Panel } from "./Panel.tsx";
import { CLEAR_COLOR, resolveUiTheme, speakerLabel, translucentColor, type SpeakerSplit, type UiTheme } from "./theme.ts";
import type { TextBoxLayout } from "../engine/types.ts";
import { startupProfileMark } from "../startup-profile.ts";
import type { ChoiceIconBoxComponent, ChoiceIconResolver } from "./choice-icons.ts";
import { formatUiText, KIT_UI_TEXT, withUiText, type UiTextOverrides } from "../engine/ui-text.ts";
import {
  ITEM_ICON_GAP,
  ITEM_ICON_ROW_H,
  ITEM_ICON_W,
  itemIconBlockHeight,
  itemListHasResolvedIcon,
  resolvedItemIcon,
  type ItemIconArt,
  type ItemIconRowComponent,
} from "./item-icon.ts";

type ShopText = { readonly [K in keyof typeof KIT_UI_TEXT]: string };

/** Presentation-only item data consumed by the shop box. `{ name }` remains
 * the complete legacy shape; a nonempty icon opts the current shop into its
 * icon layout. */
export interface DialogItemPresentation {
  name: string;
  icon?: ItemIconArt;
}

export interface DialogBoxProps {
  modal: Accessor<Modal | null>;
  legend: Accessor<string>;
  /** Screen width for fixed message cells; omit to retain intrinsic layout. */
  viewportWidth?: number;
  /** Screen height, for a message box placed at the top or the centre
   *  (default 272, the design height). */
  viewportHeight?: number;
  /** Colours of both boxes; missing keys keep DEFAULT_UI_THEME. */
  theme?: Partial<UiTheme>;
  /** Speaker portraits: NAME -> 64x64 image src (a full string literal
   *  somewhere in the game's sources, so the build bakes it). A text whose
   *  first line starts "NAME: " for a listed NAME shows that portrait. */
  faces?: Readonly<Record<string, string>>;
  /** Width of the portrait column, text starts after it (default 72: the
   *  64 px image and an 8 px gap). Art drawn smaller inside its 64x64
   *  canvas can narrow it. */
  faceWidth?: number;
  /** Shop box item presentation: id -> display name and optional icon. An id
   * absent from the table (or the prop itself omitted) renders its raw id.
   * A shop with no resolved nonempty icon keeps the legacy text-only layout. */
  items?: Readonly<Record<string, DialogItemPresentation>>;
  /** Opt-in icon row implementation from `pocket-rpgkit/ui/item-icons`.
   * Without it, even icon-bearing item metadata uses the legacy text-only
   * shop path and the Image implementation stays out of the bundle. */
  itemIconRow?: ItemIconRowComponent;
  /** The choices box for options with an `icon` (pocket-rpgkit/ui/choice-icons
   *  ChoiceIconBox). Opt-in, so games without icons do not bundle it; while
   *  it is absent an icon choice opens the text-only box (labels only) and
   *  logs one warning. */
  choiceIconBox?: ChoiceIconBoxComponent;
  /** Maps an option's `icon` to baked art for choiceIconBox (GameView passes
   *  resolveChoiceIcon over the project's sprites). An icon this returns
   *  null for (or every icon, without the prop) shows a "?" placeholder. */
  choiceIcon?: ChoiceIconResolver;
  /** The kit's words (engine/ui-text.ts): any subset of keys; missing keys
   *  keep English. */
  uiText?: UiTextOverrides;
}

/** The choices/shop list shows at most this many items around the cursor;
 *  the pixel budget may narrow it further when the chrome is tall. */
const VISIBLE_ROWS = 4;
/** Content width of the choices and shop boxes: 248 outer, 2 px border and
 *  6 px padding each side, 1 px more each side for a theme rim. A label
 *  wider than it (after the cursor prefix) wraps onto more rows; nothing
 *  is cut. */
const LIST_TEXT_WIDTH = 248 - 2 * (2 + 6);
/** The choices/shop box's fallback height (an empty list): one-row
 *  prompt/header and legend, no item rows. A populated box grows to fit
 *  its window, capped to BOX_CAP_H. */
const LIST_BOX_H = 96;
const LIST_ROW_H = 14;
/** Width of the shop header's gold column and of an item's price column:
 *  each wraps inside its column and the row/header grows by its rows. */
const SHOP_GOLD_W = 110;
const SHOP_PRICE_W = 90;
/** Row height of a box's bottom legend (`text-xs`, 12 px). */
const LEGEND_ROW_H = 12;
/** Text rows of the message box are 15 px; the box's height and row count
 *  come from its position (dialog-pages.ts: 92 px and four rows for the
 *  band). A page that needs more rows at a window narrower than the design
 *  width grows it upward. */
const MESSAGE_ROW_H = 15;
/** Row cursor prefixes ("> " selected, "  " not); the label is fitted to
 *  what remains after the wider of the two. */
const CURSOR_ON = "> ";
const CURSOR_OFF = "  ";
const NO_SPEAKER: SpeakerSplit = { name: null, rest: "", cut: 0 };
/** The dim background's fill: the theme's paper at this opacity. */
const DIM_ALPHA = 0.6;
/** Gap above the top band while its name tab shows. */
const TAB_TOP_GAP = 16;
/** The name tab's height; it overlaps the frame (and rim) it sits on. */
const TAB_H = 15;
const sameBox = (a: TextBoxLayout | undefined, b: TextBoxLayout | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.position === b.position && a.align === b.align &&
    a.valign === b.valign && a.background === b.background);
const EMPTY_LINES: readonly string[] = [];
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const sameRange = (a: number[], b: number[]): boolean => a.length === b.length;

/** One drawn row of the choices or shop box: an item's first row carries
 *  the cursor prefix (and a shop price), its further rows indent. */
interface ListRow {
  item: number;
  left: string;
  right: string;
}

interface ChoiceListRow extends ListRow {
  /** Pixels the complete prefixed row must travel inside its clip. */
  leftMarquee: number;
}

interface ShopListRow extends ListRow {
  leftWidth: number;
  leftMarquee: number;
  rightMarquee: number;
  height: number;
  /** Present on item rows only while this shop is in icon mode. */
  iconLine?: {
    icon: ItemIconArt | null;
    first: boolean;
    cursor: string;
  };
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a === b || (a.length === b.length && a.every((line, i) => line === b[i]));
const sameCell = (a: BoundedCell, b: BoundedCell): boolean =>
  a.kind === b.kind && a.overflow === b.overflow && sameLines(a.rows, b.rows);

let warnedNoIconBox = false;

/** A shop item row's right column. Finite shop stock (B1) shows next to the
 *  price; unlimited goods (stock: null, and every sell-stage row) show the
 *  price alone. */
function priceLabel(r: Extract<ShopRow, { kind: "item" }>, text: ShopText): string {
  return r.stock !== null
    ? formatUiText(text["shop.priceStock"], { price: r.price, stock: r.stock })
    : formatUiText(text["shop.price"], { price: r.price });
}

export function DialogBox(props: DialogBoxProps) {
  startupProfileMark("ui-dialog:start");
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const text = createMemo(() => withUiText(KIT_UI_TEXT, props.uiText));
  const choice = createMemo(() => {
    const modal = props.modal();
    return modal?.kind === "choices" ? modal : null;
  });
  const shop = createMemo(() => {
    const modal = props.modal();
    return modal?.kind === "shop" ? modal : null;
  });
  const shopHasIcons = createMemo(() => {
    const m = shop();
    if (!m || !props.itemIconRow) return false;
    return itemListHasResolvedIcon(
      m.rows.flatMap((row) => row.kind === "item" ? [row.item] : []),
      props.items,
    );
  });
  const ItemIconRow = props.itemIconRow;
  const message = createMemo(() => {
    const modal = props.modal();
    return modal?.kind === "text" ? modal : null;
  });
  // Choices whose options carry icons open the icon box (ChoiceIconBox.tsx);
  // it mounts on first use, so games without icons never build it.
  const IconBox = props.choiceIconBox;
  const iconChoice = createMemo(() => {
    const m = choice();
    if (!m?.icons) return null;
    if (IconBox) return m;
    if (!warnedNoIconBox) {
      warnedNoIconBox = true;
      console.warn("pocket-rpgkit: choice icons need the choiceIconBox prop (ui/choice-icons); showing labels only");
    }
    return null;
  });
  const iconBoxMounted = createMemo((was: boolean) => was || iconChoice() !== null, false);
  const textChoice = createMemo(() => (iconChoice() ? null : choice()));
  const isChoice = () => textChoice() !== null;
  // Re-evaluated per typed character; downstream only sees a new speaker.
  const speaker = createMemo(
    () => {
      const m = message();
      if (m?.kind !== "text") return NO_SPEAKER;
      return messageSpeaker(m.lines, props.faces);
    },
    NO_SPEAKER,
    { equals: (a, b) => a.name === b.name && a.cut === b.cut && a.rest === b.rest },
  );
  // display: 0 shows, 1 hides (the column and the tab stay mounted).
  const faceDisplay = createMemo(() => (speaker().name ? 0 : 1));
  // All three boxes stay mounted and hide while unused: opening a dialog updates
  // text rows instead of mounting the box subtree (on a 333 MHz PSP a mount
  // costs about 100 ms of QuickJS time).
  const choicesDisplay = createMemo(() => (isChoice() ? 0 : 1));
  const shopDisplay = createMemo(() => (shop() ? 0 : 1));
  const messageDisplay = createMemo(() => (message() ? 0 : 1));
  // The open text's layout (absent: the default box). Changes only when a
  // text with a different layout opens.
  const box = createMemo(() => message()?.box, undefined, { equals: sameBox });
  const position = createMemo(() => box()?.position);
  const viewportH = () => props.viewportHeight ?? DIALOG_VIEWPORT_H;
  // The portrait's side and its column (image and gap) in this box.
  const faceSize = createMemo(() => dialogFaceSize(position(), viewportH()));
  const faceColumn = createMemo(() => dialogFaceColumn(
    { viewportWidth: props.viewportWidth ?? DIALOG_PAGE_VIEWPORT, viewportHeight: viewportH(), faceWidth: props.faceWidth },
    position(),
  ));
  const textWidth = createMemo(() => props.viewportWidth === undefined
    ? Number.NaN
    : dialogColumnWidth(
        { viewportWidth: props.viewportWidth, viewportHeight: viewportH(), faces: props.faces, faceWidth: props.faceWidth },
        speaker().name !== null,
        position(),
      ));
  const measure = slotMeasure();
  // Row width the text may fill: the Text node's width, less the rim's 1 px
  // inner border on each side when the theme draws one.
  const textBudget = createMemo(() => textWidth() - (theme().rim ? 2 : 0));
  const listBudget = createMemo(() => LIST_TEXT_WIDTH - (theme().rim ? 2 : 0));
  const labelBudget = createMemo(() => listBudget() - Math.max(measure(CURSOR_ON), measure(CURSOR_OFF)));
  // The choices and shop boxes dock 98 px up in the 180 px message layer,
  // so their bottom sits at y = 272 - 98 = 174 on the 480x272 playfield.
  // They may grow to BOX_CAP_H (top >= 8); past that the row window scrolls
  // by rows and the chrome (prompt/header, legend) is bounded to a few rows
  // and scrolls sideways (a marquee) when a schema-valid value is longer,
  // so every character stays reachable and the box never leaves the
  // viewport.
  const BOX_CAP_H = 166;
  const BOX_FRAME = 2 * (2 + 6);
  const BOX_GAP = 4;
  const LEGEND_MAX_ROWS = 2;
  const HEADER_MAX_ROWS = 2;
  const PROMPT_MAX_ROWS = 6;
  // The bottom legend (shop and choices boxes) is bounded to LEGEND_MAX_ROWS
  // rows at the box width and scrolls sideways when longer. The message box
  // (below) keeps its unbounded legend: it has the whole upward growth
  // budget and a 200-char legend still fits it.
  const legendCell = createMemo(
    () => fitBounded(props.legend() ?? "", LIST_TEXT_WIDTH, LEGEND_MAX_ROWS, measure),
    { kind: "wrap", rows: [], overflow: 0 } as BoundedCell,
    { equals: sameCell },
  );
  const legendRows = createMemo(() => wrapLabel(props.legend() ?? "", LIST_TEXT_WIDTH, measure), [""], { equals: sameLines });
  const legendExtra = () => (legendRows().length - 1) * LEGEND_ROW_H;
  // Choices: the prompt is bounded to PROMPT_MAX_ROWS rows (it scrolls
  // sideways when longer) and each option label to the row window's
  // capacity; the window shows whole options around the cursor and the box
  // is capped to the viewport. The window is a pure function of the live
  // cursor index: never desyncs from the reducer.
  const choicePromptCell = createMemo(
    () => fitBounded(textChoice()?.prompt ?? "", listBudget(), PROMPT_MAX_ROWS, measure),
    { kind: "wrap", rows: [], overflow: 0 } as BoundedCell,
    { equals: sameCell },
  );
  const choiceOptions = createMemo(() => textChoice()?.options ?? EMPTY_LINES, EMPTY_LINES, { equals: sameLines });
  // The option labels' row capacity depends on the chrome the cap leaves;
  // computed together so a taller prompt or legend narrows the window and
  // the labels with it.
  const choiceLayout = createMemo(() => {
    const m = textChoice();
    if (!m) return { rows: [] as ChoiceListRow[], slots: [] as number[], boxH: LIST_BOX_H };
    const promptRows = choicePromptCell().rows.length;
    const legendBlock = BOX_GAP + LEGEND_ROW_H * legendCell().rows.length;
    const windowPx = BOX_CAP_H - BOX_FRAME - promptRows * LIST_ROW_H - BOX_GAP - legendBlock;
    const maxRows = Math.max(1, Math.floor(windowPx / LIST_ROW_H));
    const labels = choiceOptions().map((option) => fitBounded(option, labelBudget(), maxRows, measure));
    const rowCounts = labels.map((cell) => cell.rows.length);
    const { start, end } = windowByRows(m.index, rowCounts, VISIBLE_ROWS, maxRows);
    const rows: ChoiceListRow[] = [];
    for (let item = start; item < end; item++) {
      const count = rowCounts[item]!;
      const labelCell = labels[item]!;
      for (let j = 0; j < count; j++) {
        const left = `${j > 0 ? CURSOR_OFF : item === m.index ? CURSOR_ON : CURSOR_OFF}${labelCell.rows[j] ?? ""}`;
        rows.push({
          item,
          left,
          right: "",
          // A marquee is one row. Measure the actual prefixed string against
          // the clip, as the shop does, so its final glyph reaches the edge.
          leftMarquee: j === 0 && labelCell.kind === "marquee" ? Math.max(0, measure(left) - listBudget()) : 0,
        });
      }
    }
    const boxH = BOX_FRAME + promptRows * LIST_ROW_H + BOX_GAP + rows.length * LIST_ROW_H + legendBlock;
    return { rows, slots: range(rows.length), boxH };
  });
  const choiceBoxH = () => choiceLayout().boxH;
  // Shop: an item name wraps beside its price column (plus a 6 px gap);
  // the price wraps inside its own column and the item takes the taller of
  // the two. A control row (Sell/Leave/Back) wraps to the full label width.
  // Every cell is bounded to the row window's capacity and scrolls
  // sideways when longer, so a schema-valid value never grows the box past
  // the viewport.
  const shopGold = createMemo(() => {
    const m = shop();
    return m ? formatUiText(text()["shop.gold"], { gold: m.gold }) : "";
  });
  const shopStageText = createMemo(
    () => {
      const m = shop();
      if (!m) return "";
      return text()[m.stage === "buy" ? "shop.buy" : "shop.sell"];
    },
    "",
    { equals: (a, b) => a === b },
  );
  const shopLayout = createMemo(() => {
    const m = shop();
    if (!m) {
      return {
        stage: { kind: "wrap", rows: [], overflow: 0 } as BoundedCell,
        gold: { kind: "wrap", rows: [], overflow: 0 } as BoundedCell,
        rows: [] as ShopListRow[],
        slots: [] as number[],
        boxH: LIST_BOX_H,
        headerH: 0,
      };
    }
    const words = text();
    const stage = fitBounded(shopStageText(), listBudget() - SHOP_GOLD_W - 6, HEADER_MAX_ROWS, measure);
    const gold = fitBounded(shopGold(), SHOP_GOLD_W, HEADER_MAX_ROWS, measure);
    const headerRows = Math.max(stage.rows.length, gold.rows.length);
    const legendBlock = BOX_GAP + LEGEND_ROW_H * legendCell().rows.length;
    const windowPx = BOX_CAP_H - BOX_FRAME - headerRows * LIST_ROW_H - BOX_GAP - legendBlock;
    const maxRows = Math.max(1, Math.floor(windowPx / LIST_ROW_H));
    const iconMode = shopHasIcons();
    // An icon-bearing item spends ten more pixels on its first text row. Keep
    // even a single very long selected item inside the same box cap.
    const iconMaxRows = Math.max(1, Math.floor((windowPx - (ITEM_ICON_ROW_H - LIST_ROW_H)) / LIST_ROW_H));
    const labels = m.rows.map((r) => {
      if (r.kind !== "item") {
        const word = words[r.kind === "sell" ? "shop.rowSell" : r.kind === "leave" ? "shop.rowLeave" : "shop.rowBack"];
        return fitBounded(word, labelBudget(), maxRows, measure);
      }
      const name = props.items?.[r.item]?.name ?? r.item;
      const iconGutter = iconMode ? ITEM_ICON_W + ITEM_ICON_GAP : 0;
      return fitBounded(name, labelBudget() - SHOP_PRICE_W - 6 - iconGutter, iconMode ? iconMaxRows : maxRows, measure);
    });
    const rights = m.rows.map((r) => (r.kind === "item"
      ? fitBounded(priceLabel(r, words), SHOP_PRICE_W, iconMode ? iconMaxRows : maxRows, measure)
      : null));
    const rowCounts = m.rows.map((_, i) => Math.max(labels[i]!.rows.length, rights[i]?.rows.length ?? 0));
    const rowHeights = m.rows.map((r, i) => iconMode && r.kind === "item"
      ? itemIconBlockHeight(rowCounts[i]!, LIST_ROW_H)
      : rowCounts[i]! * LIST_ROW_H);
    // windowByRows sums arbitrary positive weights; pixels make the icon
    // window exact, while the legacy path keeps its historical row counts.
    const { start, end } = iconMode
      ? windowByRows(m.index, rowHeights, VISIBLE_ROWS, windowPx)
      : windowByRows(m.index, rowCounts, VISIBLE_ROWS, maxRows);
    const rows: ShopListRow[] = [];
    for (let item = start; item < end; item++) {
      const count = rowCounts[item]!;
      const labelCell = labels[item]!;
      const priceCell = rights[item];
      const shopRow = m.rows[item]!;
      const leftWidth = shopRow.kind === "item" ? listBudget() - SHOP_PRICE_W - 6 : listBudget();
      const iconItem = iconMode && shopRow.kind === "item";
      const icon = shopRow.kind === "item" ? resolvedItemIcon(props.items?.[shopRow.item]?.icon) : null;
      for (let j = 0; j < count; j++) {
        const left = labelCell.rows[j] ?? "";
        const right = priceCell?.rows[j] ?? "";
        const prefixedLeft = `${j > 0 ? CURSOR_OFF : item === m.index ? CURSOR_ON : CURSOR_OFF}${left}`;
        rows.push({
          item,
          left: iconItem ? left : prefixedLeft,
          right,
          leftWidth,
          height: iconItem && j === 0 ? ITEM_ICON_ROW_H : LIST_ROW_H,
          ...(iconItem ? {
            iconLine: {
              icon: j === 0 ? icon : null,
              first: j === 0,
              cursor: j > 0 ? CURSOR_OFF : item === m.index ? CURSOR_ON : CURSOR_OFF,
            },
          } : {}),
          // A marquee cell shows its one row on the item's first row only.
          // Its clip includes the cursor prefix, so measure that same drawn
          // string rather than leaving the last prefix-width of text hidden.
          leftMarquee: j === 0 && labelCell.kind === "marquee"
            ? iconItem ? labelCell.overflow : Math.max(0, measure(prefixedLeft) - leftWidth)
            : 0,
          rightMarquee: j === 0 && priceCell?.kind === "marquee" ? priceCell.overflow : 0,
        });
      }
    }
    const rowsH = iconMode ? rows.reduce((sum, row) => sum + row.height, 0) : rows.length * LIST_ROW_H;
    const boxH = BOX_FRAME + headerRows * LIST_ROW_H + BOX_GAP + rowsH + legendBlock;
    return { stage, gold, rows, slots: range(rows.length), boxH, headerH: headerRows * LIST_ROW_H };
  });
  const shopBoxH = () => shopLayout().boxH;
  // One tick for every marquee cell in the boxes; it rests when none scroll.
  const marqueeTick = useMarqueeTick(createMemo(() => {
    if (legendCell().kind === "marquee" || choicePromptCell().kind === "marquee") return true;
    if (choiceLayout().rows.some((row) => row.leftMarquee > 0)) return true;
    const shop = shopLayout();
    return shop.stage.kind === "marquee" || shop.gold.kind === "marquee" ||
      shop.rows.some((row) => row.leftMarquee > 0 || row.rightMarquee > 0);
  }));
  const messageLegend = createMemo(() => message()?.complete ? props.legend() : "");
  const messageLegendRows = createMemo(
    () => (messageLegend() ? wrapLabel(messageLegend()!, textBudget(), measure) : []),
    [] as string[],
    { equals: sameLines },
  );
  // The rows a message lays out in (text-flow.ts): authored lines that fit
  // stay as they are; a wider line wraps at the text column's pixel width
  // (CJK between characters with kinsoku, Latin at spaces). A message the
  // interpreter split into pages (dialog-pages.ts) shows one page at a
  // time. Recomputed when the words, the page or the column change, not
  // per typed character.
  const shownLines = createMemo(
    () => {
      const m = message();
      if (m?.kind !== "text") return EMPTY_LINES;
      return shownMessageLines(m.lines, speaker());
    },
    EMPTY_LINES,
    { equals: sameLines },
  );
  const pageStarts = createMemo(() => message()?.pageStarts);
  const page = createMemo(() => message()?.page ?? 0);
  const pageLines = createMemo(
    () => messagePage(shownLines(), speaker().cut, pageStarts(), page()),
    EMPTY_LINES,
    { equals: sameLines },
  );
  // The box's rows at the live screen height: four for a band, a quarter
  // of the screen's worth for a corner or side box.
  const boxRows = createMemo(() => dialogBoxRows(position(), viewportH()));
  const flow = createMemo(() => flowRows(pageLines(), textBudget(), boxRows(), measure));
  // Four row nodes, more only when a page needs them (a window narrower
  // than the width pages are cut at); unused rows are hidden.
  const textRows = createMemo(() => range(Math.max(DIALOG_ROWS, flow().rows.length)), range(DIALOG_ROWS), { equals: sameRange });
  // The box grows by the text rows past its own and by the wrapped
  // legend's extra rows (shown once the message is complete).
  const extraTextH = () =>
    Math.max(0, flow().rows.length - boxRows()) * MESSAGE_ROW_H + (messageLegend() ? legendExtra() : 0);
  // Paint offsets of the page's rows (dialog-pages.ts): null/0 for the
  // default box, so its rows draw exactly where they always did.
  const rowShifts = createMemo(() => {
    const align = box()?.align;
    if (align === undefined) return null;
    return flow().rows.map((row) => dialogAlignShift(align, textBudget(), measure(row.text.replace(/ +$/, ""))));
  });
  const rowsShift = createMemo(() => box()?.valign === undefined
    ? 0
    : dialogValignShift(box()!.valign, flow().rows.length, dialogTextAreaHeight(position(), viewportH())));
  const textLines = createMemo(() => {
    const m = message();
    if (m?.kind !== "text") return textRows().map(() => "");
    const shown = pageRevealed(m.revealed, speaker().cut, pageStarts(), page());
    const visible = revealRows(flow(), shown);
    return textRows().map((i) => visible[i] ?? "");
  });

  // Solid replaces an empty string's Text child on the next character. Keep
  // a space in that child and hide its row instead: revealing it only
  // restyles and replaces the retained leaf.
  // Four text rows + the legend row; the column holding them is the paper
  // itself, or the text column right of the portrait when faces are on.
  const messageRows = () => (
    <>
      <For each={textRows()}>
        {(row) => {
          const line = createMemo(() => textLines()[row]!);
          return (
            <Text
              class="text-xs"
              style={{
                textColor: theme().ink,
                lineHeight: MESSAGE_ROW_H,
                height: MESSAGE_ROW_H,
                width: textWidth(),
                display: line() ? 0 : 1,
                translateX: rowShifts()?.[row] ?? 0,
                translateY: rowsShift(),
              }}
              debugName={`rpgkit-message-row-${row}`}
            >
              {line() || " "}
            </Text>
          );
        }}
      </For>
      <View class="flex-row justify-end" style={{ height: LEGEND_ROW_H * messageLegendRows().length, translateY: rowsShift() }}>
        <Text
          class="text-xs"
          style={{
            textColor: theme().dim,
            lineHeight: LEGEND_ROW_H,
            height: LEGEND_ROW_H * messageLegendRows().length,
            width: textWidth(),
            textAlign: 2,
            display: messageLegend() ? 0 : 1,
          }}
          debugName="rpgkit-message-legend"
        >
          {messageLegendRows().join("\n") || " "}
        </Text>
      </View>
    </>
  );

  // The message box's place and look for the open text's layout; the
  // default box keeps its 8 px insets and the theme unchanged.
  const boxInsets = createMemo(() => dialogBoxInsets(props.viewportWidth ?? DIALOG_PAGE_VIEWPORT, position()));
  // A portrait never changes the box: it is scaled into it (faceSize).
  const messageBoxH = () => dialogBoxHeight(position(), viewportH()) + extraTextH();
  const boxBottom = () => dialogBoxBottom(
    position(),
    viewportH(),
    messageBoxH(),
    props.faces && speaker().name ? TAB_TOP_GAP : undefined,
  );
  // The name tab sits on the box's top edge, or hangs from its bottom edge
  // when the box is against the top of the screen (a top corner).
  const tabBottom = () => {
    const overlap = theme().rim ? 3 : 2;
    const pos = position();
    return pos === "topLeft" || pos === "topRight"
      ? boxBottom() - TAB_H + overlap
      : boxBottom() + messageBoxH() - overlap;
  };
  const boxTheme = createMemo((): UiTheme => {
    const look = box()?.background;
    const t = theme();
    if (look === undefined || look === "window") return t;
    // Same layers as the window (a rim stays a node, just unpainted), so
    // switching looks restyles and never remounts the paper.
    const rim = t.rim === undefined ? undefined : CLEAR_COLOR;
    return look === "dim"
      ? { ...t, border: CLEAR_COLOR, rim, paper: translucentColor(t.paper, DIM_ALPHA) }
      : { ...t, border: CLEAR_COLOR, rim, paper: CLEAR_COLOR };
  });

  const view = (
    <View
      class="absolute left-0 right-0 bottom-0"
      style={{ posType: 1, height: 180 }}
      debugName="rpgkit-message-layer"
    >
      {/* Choices box: docked right, immediately above the message box.
          During choices the message box is hidden (the prompt lives in
          this box, MV parity). A long prompt or option is bounded to the
          row window's capacity and scrolls sideways when longer, so the
          box stays inside the viewport. */}
      <Panel
        theme={theme()}
        style={{ posType: 1, width: 248, height: choiceBoxH(), insetR: 12, insetB: 98, display: choicesDisplay() }}
        paperClass="flex-col p-[6]"
        debugName="rpgkit-choices-box"
      >
        <BoundedLine
          cell={choicePromptCell()}
          tick={marqueeTick}
          textColor={theme().dim}
          rowH={LIST_ROW_H}
          width={listBudget()}
          debugName="rpgkit-choice-prompt"
        />
        <View class="flex-col" style={{ height: 4 }} />
        <For each={choiceLayout().slots}>
          {(slot) => {
            const m = textChoice;
            const row = () => choiceLayout().rows[slot];
            const selected = () => row() !== undefined && m()!.index === row()!.item;
            const disabled = () => row() !== undefined && m()!.enabled?.[row()!.item] === false;
            const rowColor = () => disabled() ? theme().dim : selected() ? theme().accent : theme().ink;
            const left = () => row()?.left ?? "";
            return (
              row()?.leftMarquee ? (
                <View
                  style={{ width: listBudget(), height: LIST_ROW_H, overflow: 1 }}
                  debugName={`rpgkit-choice-${slot}`}
                >
                  <Text
                    class="text-xs"
                    style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H, shrink: 0, translateX: -marqueeOffset(row()!.leftMarquee, marqueeTick()) }}
                  >
                    {left()}
                  </Text>
                </View>
              ) : (
                <Text
                  class="text-xs"
                  style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H }}
                  debugName={`rpgkit-choice-${slot}`}
                >
                  {left()}
                </Text>
              )
            );
          }}
        </For>
        <View class="flex-row justify-end" style={{ height: 4 + LEGEND_ROW_H * legendCell().rows.length, insetT: 4 }}>
          <BoundedLine
            cell={legendCell()}
            tick={marqueeTick}
            textColor={theme().dim}
            rowH={LEGEND_ROW_H}
            width={LIST_TEXT_WIDTH}
            debugName="rpgkit-choice-legend"
          />
        </View>
      </Panel>
      {IconBox && (
        <Show when={iconBoxMounted()}>
          <IconBox modal={iconChoice} legend={props.legend} theme={theme} resolve={props.choiceIcon} />
        </Show>
      )}

      {/* Shop box: same footprint and docking as the choices box, with a
            stage/gold header row instead of a prompt and a scrolling row
            list (T2-10). Buy rows a player cannot afford, has capped out
            (backpack cap) or that are out of stock (B1) render dimmed;
            sell rows for an unsellable item (B4) do too. Every dimmed row
            stays navigable, just unconfirmable. The header and legend are
            bounded cells; a schema-valid value scrolls sideways instead
            of growing the box past the viewport. */}
      <Panel
            theme={theme()}
            style={{ posType: 1, width: 248, height: shopBoxH(), insetR: 12, insetB: 98, display: shopDisplay() }}
            paperClass="flex-col p-[6]"
            debugName="rpgkit-shop-box"
          >
            <View class="flex-row justify-between" style={{ height: shopLayout().headerH }}>
              <BoundedLine
                cell={shopLayout().stage}
                tick={marqueeTick}
                textColor={theme().dim}
                rowH={LIST_ROW_H}
                width={listBudget() - SHOP_GOLD_W - 6}
                debugName="rpgkit-shop-stage"
              />
              <BoundedLine
                cell={shopLayout().gold}
                tick={marqueeTick}
                textColor={theme().dim}
                rowH={LIST_ROW_H}
                width={SHOP_GOLD_W}
                textAlign={2}
                debugName="rpgkit-shop-gold"
              />
            </View>
            <View class="flex-col" style={{ height: 4 }} />
            <For each={shopLayout().slots}>
              {(slot) => {
                const m = shop;
                const row = () => shopLayout().rows[slot];
                const shopRow = (): ShopRow | null => (row() ? m()!.rows[row()!.item]! : null);
                const selected = () => row() !== undefined && m()!.index === row()!.item;
                // Buy: unaffordable, capped, or out-of-stock rows are inert
                // (T2-10 backpack cap / B1 finite stock). Sell: an
                // unsellable row (B4 — sellList:"disable") stays listed but
                // cannot be confirmed.
                const disabled = () => {
                  const r = shopRow();
                  if (!r || r.kind !== "item") return false;
                  return m()!.stage === "buy" ? !r.canAfford || r.atCap : !r.sellable;
                };
                const rowColor = () => (disabled() ? theme().dim : selected() ? theme().accent : theme().ink);
                const left = () => row()?.left ?? "";
                const right = () => row()?.right ?? "";
                const leftMarquee = () => row()?.leftMarquee ?? 0;
                const rightMarquee = () => row()?.rightMarquee ?? 0;
                return row()?.iconLine && ItemIconRow ? (
                  <ItemIconRow
                    icon={row()?.iconLine?.icon ?? null}
                    firstLine={row()?.iconLine?.first ?? false}
                    cursor={row()?.iconLine?.cursor ?? ""}
                    label={left()}
                    price={right()}
                    width={listBudget()}
                    leftWidth={row()?.leftWidth ?? listBudget()}
                    cursorWidth={Math.max(measure(CURSOR_ON), measure(CURSOR_OFF))}
                    priceWidth={SHOP_PRICE_W}
                    height={row()?.height ?? LIST_ROW_H}
                    lineHeight={LIST_ROW_H}
                    leftMarquee={leftMarquee() ? marqueeOffset(leftMarquee(), marqueeTick()) : 0}
                    rightMarquee={rightMarquee() ? marqueeOffset(rightMarquee(), marqueeTick()) : 0}
                    rightClipped={rightMarquee() > 0}
                    textColor={rowColor()}
                    dimColor={theme().dim}
                    paperColor={theme().paper}
                    debugName={`rpgkit-shop-row-${slot}`}
                  />
                ) : (
                  <View class="flex-row justify-between" style={{ height: LIST_ROW_H }} debugName={`rpgkit-shop-row-${slot}`}>
                    {row()?.leftMarquee ? (
                      <View style={{ width: row()!.leftWidth, height: LIST_ROW_H, overflow: 1 }}>
                        <Text
                          class="text-xs"
                          style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H, shrink: 0, translateX: -marqueeOffset(row()!.leftMarquee, marqueeTick()) }}
                        >
                          {left()}
                        </Text>
                      </View>
                    ) : (
                      <Text class="text-xs" style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H }}>
                        {left()}
                      </Text>
                    )}
                    {row()?.rightMarquee ? (
                      <View style={{ width: SHOP_PRICE_W, height: LIST_ROW_H, overflow: 1 }}>
                        <Text
                          class="text-xs"
                          style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H, shrink: 0, translateX: -marqueeOffset(row()!.rightMarquee, marqueeTick()) }}
                        >
                          {right()}
                        </Text>
                      </View>
                    ) : (
                      <Text class="text-xs" style={{ textColor: rowColor(), lineHeight: LIST_ROW_H, height: LIST_ROW_H }}>
                        {right()}
                      </Text>
                    )}
                  </View>
                );
              }}
            </For>
            <View class="flex-row justify-end" style={{ height: 4 + LEGEND_ROW_H * legendCell().rows.length, insetT: 4 }}>
              <BoundedLine
                cell={legendCell()}
                tick={marqueeTick}
                textColor={theme().dim}
                rowH={LEGEND_ROW_H}
                width={LIST_TEXT_WIDTH}
                debugName="rpgkit-shop-legend"
              />
            </View>
      </Panel>

        {/* Message box: framed panel, four fixed text rows + legend, and
            the portrait column when the game passes faces. */}
      <Panel
            theme={boxTheme()}
            style={{ posType: 1, height: messageBoxH(), insetL: boxInsets().left, insetR: boxInsets().right, insetB: boxBottom(), display: messageDisplay() }}
            paperClass="flex-col p-[8]"
            debugName="rpgkit-message-box"
          >
            {/* With faces: a row filling the paper, portrait column then
                text column (flexDir 0 row, 1 column). Layout goes through
                style props, not new class strings, so every app's baked
                style table stays as it was. */}
            <Show when={props.faces} fallback={messageRows()}>
              <View style={{ flexDir: 0, grow: 1 }}>
                <View
                  style={{ width: faceColumn(), height: faceSize(), display: faceDisplay() }}
                  debugName="rpgkit-message-face"
                >
                  <Image
                    src={speaker().name ? props.faces![speaker().name!] : ""}
                    style={{ width: faceSize(), height: faceSize() }}
                  />
                </View>
                <View style={{ flexDir: 1, grow: 1 }}>{messageRows()}</View>
              </View>
            </Show>
      </Panel>
      {/* Name tab: overlaps the frame (border, and rim if any) so it
          reads as part of the box; paper-coloured text on the border.
          Above the box, or below a box against the top of the screen. */}
      <Show when={props.faces}>
        <View
          style={{
            posType: 1,
            insetL: boxInsets().left + 12,
            insetB: tabBottom(),
            height: TAB_H,
            flexDir: 0,
            paddingL: 6,
            paddingR: 6,
            bgColor: theme().border,
            display: messageDisplay() === 0 ? faceDisplay() : 1,
          }}
          debugName="rpgkit-message-name"
        >
          <Text class="text-xs" style={{ textColor: theme().paper, lineHeight: TAB_H, height: TAB_H }}>
            {speaker().name ? speakerLabel(speaker().name!) : " "}
          </Text>
        </View>
      </Show>
    </View>
  );
  startupProfileMark("ui-dialog:end");
  return view;
}
