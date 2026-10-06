// src/ui/SaveMenu.tsx — P1⑤ save/load menu presentation.
//
// RpgKitApp owns engine/save-menu.ts's pure navigation state and performs
// the command a CONFIRM returns (fs write/read, snapshot build, OSK open);
// this component renders the current page. On a target without data.fs the
// root lists the two code rows only. The code export pages the URL-safe
// base64 of the same envelope the desktop writes; the code import runs the
// system OSK (@pocketjs/framework/osk), whose alphabet covers the code's
// A-Z a-z 0-9 - _. While the OSK is open its button block owns input.
//
// The panel is a Panel coloured by the `theme` prop (ui/theme.ts), over the
// theme's backdrop; `title` renames the root page ("POCKET RPG KIT — SAVE").
// Game-supplied strings (the title, a slot's map id, a message page) are
// never cut. The 420 px panel starts at 232 px high and may grow to 256 px
// (top >= 8 in the 480x272 viewport). Text first wraps within each page's
// row budget; a value that still does not fit is kept whole in a clipped
// pixel window and scrolls from its first through its final pixel. The kit's
// own words come from the `uiText` table (engine/ui-text.ts, English by
// default) and follow those same bounds.

import { createMemo, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { Osk } from "@pocketjs/framework/osk";
import type { OskController } from "@pocketjs/framework/osk";
import type { FsSlotInfo } from "../host/save-fs.ts";
import { SAVE_MENU_UI_TEXT, saveMenuRootRows, type ExtraRootRow, type MenuState } from "../engine/save-menu.ts";
import { fitBounded, marqueeOffset, type BoundedCell } from "./list-window.ts";
import { useMarqueeTick } from "./use-marquee-tick.ts";
import { BoundedLine } from "./BoundedLine.tsx";
import { Panel } from "./Panel.tsx";
import { slotMeasure, TEXT_XS_SLOT } from "./text-measure.ts";
import { resolveUiTheme, type UiTheme } from "./theme.ts";
import { formatUiText, withUiText, type UiTextOverrides } from "../engine/ui-text.ts";

type SaveMenuText = { readonly [K in keyof typeof SAVE_MENU_UI_TEXT]: string };

export type SlotInfo = (FsSlotInfo | { slot: number; error: string } | null)[];
export type AutosaveSlotInfo = FsSlotInfo | { slot: number; error: string } | null;

export interface SaveMenuProps {
  menu: Accessor<MenuState>;
  hasFs: boolean;
  slots: Accessor<SlotInfo>;
  /** A present value adds a read-only autosave row above manual slots on
   * the load page. It is never rendered on the save page. */
  autosave?: Accessor<AutosaveSlotInfo>;
  saveCode: Accessor<string>;
  osk: OskController;
  legend: Accessor<string>;
  /** Panel and backdrop colours; missing keys keep DEFAULT_UI_THEME. */
  theme?: Partial<UiTheme>;
  /** Root page title (default: the table's `save.title`). */
  title?: string;
  /** The kit's words (engine/ui-text.ts): any subset of keys; missing keys
   *  keep English. Pass the same table to menuStep's `text`. */
  uiText?: UiTextOverrides;
  /** Game-defined rows appended after the kit's own root rows. Their labels
   *  are the game's own (already localized) text; CONFIRM on one returns an
   *  `extra` command the host performs. */
  extraRows?: readonly ExtraRootRow[];
}

/** Font slot of `text-sm` (14 px regular): index 1 of PocketJS's FONT_PX
 *  table (framework/compiler/tailwind.ts fontSlotFor). */
const TEXT_SM_SLOT = 1;
/** Content width of the 420 px panel: minus the Panel's 2 px border and the
 *  paper's 8 px padding (p-[8]) per side. The theme's 1 px rim sits inside
 *  that padding. Game-supplied strings (the root title, a slot's map id, a
 *  message page) wrap to it; the kit's own English rows already fit. */
const CONTENT_W = 420 - 2 * (2 + 8);
/** The panel's height when every row fits it; a page whose rows need more
 *  grows it (PANEL_FRAME is the border and padding above and below), capped
 *  to PANEL_CAP_H so it never leaves the 480x272 viewport (top >= 8). */
const PANEL_H = 232;
const PANEL_CAP_H = 256;
const PANEL_FRAME = 2 * (2 + 8);
/** Row budgets per page (px math in the panel-height memo): a page's text
 *  cells are bounded to these many wrapped rows and scroll sideways (a
 *  marquee) when longer, so every schema-valid value stays reachable. */
const TITLE_MAX_ROWS = 2;
const ROOT_ROW_MAX_ROWS = 2;
const SLOT_ROW_MAX_ROWS = 2;
const CODE_TITLE_MAX_ROWS = 2;
const CODE_HINT_MAX_ROWS = 3;
const IMPORT_HINT_MAX_ROWS = 13;
const MESSAGE_BODY_MAX_ROWS = 9;
const LEGEND_MAX_ROWS = 2;
/** Row heights: the root and message pages' `text-sm` rows, a root menu row,
 *  a one-row slot, and each row of a slot summary that wraps. */
const TITLE_ROW_H = 18;
const ROOT_ROW_H = 20;
/** `text-xs` rows of the code export and import pages. */
const XS_ROW_H = 15;
const SLOT_ROW_H = 22;
const SLOT_WRAP_ROW_H = 18;
/** Spacer under a page title, and the legend row at the page's foot. */
const TITLE_GAP = 6;
const LEGEND_H = 14;
const SELECTED_PREFIX = "> ";
const IDLE_PREFIX = "  ";

// Export pages: fixed-width rows of the code, ten rows per page.
const CODE_COLS = 24;
const CODE_ROWS = 10;

function codePages(code: string): string[] {
  const pages: string[] = [];
  for (let i = 0; i < code.length; i += CODE_COLS * CODE_ROWS) {
    pages.push(code.slice(i, i + CODE_COLS * CODE_ROWS));
  }
  return pages.length ? pages : [""];
}

function pageRows(page: string): string[] {
  const rows: string[] = [];
  for (let i = 0; i < CODE_ROWS; i++) {
    rows.push(page.slice(i * CODE_COLS, (i + 1) * CODE_COLS));
  }
  return rows;
}

function slotLabel(info: SlotInfo[number], text: SaveMenuText): string {
  if (info === null) return text["save.slotEmpty"];
  if ("error" in info) return text["save.slotDamaged"];
  return formatUiText(text["save.slotSummary"], { map: info.map, frame: info.frame });
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/** Height of a slot row whose summary takes `rows` rows: one keeps the
 *  list's 22 px row, more stack at SLOT_WRAP_ROW_H with the same 4 px of
 *  air. */
function slotRowHeight(rows: number): number {
  return rows <= 1 ? SLOT_ROW_H : rows * SLOT_WRAP_ROW_H + (SLOT_ROW_H - SLOT_WRAP_ROW_H);
}

/** Height of a root row whose label takes `rows` rows: one keeps the 20 px
 *  row, more stack at TITLE_ROW_H with the same 2 px of air. */
function rootRowHeight(rows: number): number {
  return rows <= 1 ? ROOT_ROW_H : rows * TITLE_ROW_H + (ROOT_ROW_H - TITLE_ROW_H);
}

function isIndex(m: MenuState, i: number): boolean {
  return (m.kind === "root" || m.kind === "slots-save" || m.kind === "slots-load") && m.index === i;
}

export function SaveMenu(props: SaveMenuProps) {
  const pages = createMemo(() => codePages(props.saveCode()));
  const theme = createMemo(() => resolveUiTheme(props.theme));
  const text = createMemo(() => withUiText(SAVE_MENU_UI_TEXT, props.uiText));
  const rawTitle = createMemo(() => props.title ?? text()["save.title"]);
  /** A `text-sm` cell bounded to `maxRows` rows at `width` px. */
  const boundSm = (value: string, width: number, maxRows: number): BoundedCell =>
    fitBounded(value, width, maxRows, slotMeasure(TEXT_SM_SLOT));
  /** A `text-xs` cell bounded to `maxRows` rows at the panel content width. */
  const boundXs = (value: string, maxRows: number): BoundedCell =>
    fitBounded(value, CONTENT_W, maxRows, slotMeasure(TEXT_XS_SLOT));
  const sameCell = (a: BoundedCell, b: BoundedCell): boolean =>
    a.kind === b.kind && a.overflow === b.overflow && sameStrings(a.rows, b.rows);
  const rootTitle = createMemo(() => boundSm(rawTitle(), CONTENT_W, TITLE_MAX_ROWS), undefined, { equals: sameCell });
  const hasAutosave = () => (props.autosave?.() ?? null) !== null;
  const rootRows = () => saveMenuRootRows(props.hasFs, hasAutosave(), props.extraRows);
  // Each root row's label, bounded after the cursor prefix. Kit rows resolve
  // their ui-text key; extra rows carry their own already-localized label.
  const rootLabels = createMemo(
    () => {
      const measure = slotMeasure(TEXT_SM_SLOT);
      const prefix = Math.max(measure(SELECTED_PREFIX), measure(IDLE_PREFIX));
      return rootRows().map((row) =>
        boundSm(row.textKey ? text()[row.textKey] : row.label, CONTENT_W - prefix, ROOT_ROW_MAX_ROWS)
      );
    },
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((cell, i) => sameCell(cell, b[i]!)) },
  );
  const slotTitle = createMemo(
    () => {
      const m = props.menu();
      return boundSm(text()[m.kind === "slots-load" ? "save.slotsLoadTitle" : "save.slotsSaveTitle"], CONTENT_W, TITLE_MAX_ROWS);
    },
    undefined,
    { equals: sameCell },
  );
  // Code export: the title names the page; the hint is static.
  const codeTitle = createMemo(
    () => {
      const m = props.menu();
      const all = pages().length;
      const page = m.kind === "code-export" ? Math.min(m.page, all - 1) : 0;
      return boundXs(formatUiText(text()["save.codeTitle"], { page: page + 1, pages: all }), CODE_TITLE_MAX_ROWS);
    },
    undefined,
    { equals: sameCell },
  );
  const codeHint = createMemo(() => boundXs(text()["save.codeHint"], CODE_HINT_MAX_ROWS), undefined, { equals: sameCell });
  const importTitle = createMemo(() => boundSm(text()["save.importTitle"], CONTENT_W, TITLE_MAX_ROWS), undefined, { equals: sameCell });
  const importHint = createMemo(() => boundXs(text()["save.importHint"], IMPORT_HINT_MAX_ROWS), undefined, { equals: sameCell });
  // Each slot's summary, bounded after the wider prefix and the slot
  // number; re-wraps only when a slot's summary string changes.
  const slotRows = [0, 1, 2].map((row) => {
    const rawSummary = createMemo(() => slotLabel(props.slots()[row]!, text()));
    return createMemo(() => {
      const measure = slotMeasure(TEXT_SM_SLOT);
      const prefix = Math.max(measure(SELECTED_PREFIX), measure(IDLE_PREFIX)) + measure(`${row + 1}. `);
      return boundSm(rawSummary(), CONTENT_W - prefix, SLOT_ROW_MAX_ROWS);
    }, undefined, { equals: sameCell });
  });
  const autosaveCell = createMemo(
    () => {
      const info = props.autosave?.() ?? null;
      if (info === null) return { kind: "wrap", rows: [], overflow: 0 } as BoundedCell;
      const menu = props.menu();
      const selected = menu.kind === "slots-load" && menu.index === 0;
      return boundSm(
        `${selected ? SELECTED_PREFIX : IDLE_PREFIX}${text()["save.autosave"]}: ${slotLabel(info, text())}`,
        CONTENT_W,
        SLOT_ROW_MAX_ROWS,
      );
    },
    undefined,
    { equals: sameCell },
  );
  const messageRows = createMemo(
    () => {
      const m = props.menu();
      return m.kind === "message"
        ? { title: boundSm(m.title, CONTENT_W, TITLE_MAX_ROWS), body: boundSm(m.body, CONTENT_W, MESSAGE_BODY_MAX_ROWS) }
        : { title: { kind: "wrap", rows: [], overflow: 0 } as BoundedCell, body: { kind: "wrap", rows: [], overflow: 0 } as BoundedCell };
    },
    undefined,
    { equals: (a, b) => sameCell(a.title, b.title) && sameCell(a.body, b.body) },
  );
  // The bottom legend is bounded to LEGEND_MAX_ROWS rows at the panel width
  // and scrolls sideways when longer.
  const legendCell = createMemo(
    () => boundXs(props.legend() ?? "", LEGEND_MAX_ROWS),
    { kind: "wrap", rows: [], overflow: 0 } as BoundedCell,
    { equals: sameCell },
  );
  const legendH = () => LEGEND_H * legendCell().rows.length;
  // One tick for every marquee cell; it rests when none scroll.
  const marqueeTick = useMarqueeTick(createMemo(() => {
    if (legendCell().kind === "marquee") return true;
    if (rootTitle().kind === "marquee" || slotTitle().kind === "marquee" || codeTitle().kind === "marquee" ||
        codeHint().kind === "marquee" || importTitle().kind === "marquee" || importHint().kind === "marquee") return true;
    if (rootLabels().some((cell) => cell.kind === "marquee")) return true;
    if (slotRows.some((cell) => cell().kind === "marquee")) return true;
    if (autosaveCell().kind === "marquee") return true;
    const msg = messageRows();
    return msg.title.kind === "marquee" || msg.body.kind === "marquee";
  }));
  // The panel keeps PANEL_H unless the open page's rows need more, capped
  // to PANEL_CAP_H so it never leaves the viewport.
  const panelHeight = createMemo(() => {
    const m = props.menu();
    let content = 0;
    if (m.kind === "root") {
      content = rootTitle().rows.length * TITLE_ROW_H + TITLE_GAP + legendH();
      for (const cell of rootLabels()) content += rootRowHeight(cell.rows.length);
    } else if (m.kind === "slots-save" || m.kind === "slots-load") {
      content = slotTitle().rows.length * TITLE_ROW_H + TITLE_GAP + legendH();
      if (m.kind === "slots-load" && hasAutosave()) {
        content += slotRowHeight(autosaveCell().rows.length);
      }
      if (m.kind === "slots-save" || props.hasFs) {
        for (const cell of slotRows) content += slotRowHeight(cell().rows.length);
      }
    } else if (m.kind === "code-export") {
      content = (codeTitle().rows.length + CODE_ROWS + codeHint().rows.length) * XS_ROW_H + 4 + 14 - XS_ROW_H;
    } else if (m.kind === "code-import") {
      content = importTitle().rows.length * TITLE_ROW_H + 4 + importHint().rows.length * XS_ROW_H;
    } else if (m.kind === "message") {
      const { title, body } = messageRows();
      content = (title.rows.length + body.rows.length) * TITLE_ROW_H + TITLE_GAP + legendH();
    }
    return Math.min(PANEL_CAP_H, Math.max(PANEL_H, content + PANEL_FRAME));
  });

  return (
    <Show when={props.menu().kind !== "closed"}>
      <View
        class="absolute inset-0 flex-row justify-center items-center"
        style={{ posType: 1, bgColor: theme().backdrop }}
        debugName="rpgkit-save-overlay"
      >
        <Panel
          theme={theme()}
          style={{ posType: 1, width: 420, height: panelHeight() }}
          paperClass="flex-col grow p-[8]"
          debugName="rpgkit-save-panel"
        >
          {/* ROOT */}
          <Show when={props.menu().kind === "root"}>
            <BoundedLine
              cell={rootTitle()}
              tick={marqueeTick}
              textColor={theme().accent}
              rowH={TITLE_ROW_H}
              width={CONTENT_W}
              sizeClass="text-sm"
              debugName="rpgkit-save-title"
            />
            <View style={{ height: 6 }} />
            <For each={rootRows()}>
              {(_row, i) => {
                // One row as before, or the bounded label's rows stacked in
                // one Text, every further row indented under the first; a
                // label longer than the row budget scrolls sideways.
                const cell = () => rootLabels()[i()]!;
                const isSel = () => isIndex(props.menu(), i());
                const colour = () => (isSel() ? theme().accent : theme().ink);
                const prefix = () => isSel() ? SELECTED_PREFIX : IDLE_PREFIX;
                const measure = slotMeasure(TEXT_SM_SLOT);
                const labelW = CONTENT_W - Math.max(measure(SELECTED_PREFIX), measure(IDLE_PREFIX));
                return (
                  <Show when={cell().kind === "wrap"} fallback={
                    <View class="flex-row" style={{ height: ROOT_ROW_H }} debugName={`rpgkit-save-root-${i()}`}>
                      <Text class="text-sm" style={{ textColor: colour(), lineHeight: ROOT_ROW_H, height: ROOT_ROW_H }}>{prefix()}</Text>
                      <View style={{ width: labelW, height: ROOT_ROW_H, overflow: 1 }}>
                        <Text
                          class="text-sm"
                          style={{ textColor: colour(), lineHeight: ROOT_ROW_H, height: ROOT_ROW_H, shrink: 0, translateX: -marqueeOffset(cell().overflow, marqueeTick()) }}
                        >
                          {cell().rows[0]}
                        </Text>
                      </View>
                    </View>
                  }>
                    <Text
                      class="text-sm"
                      style={{
                        textColor: colour(),
                        lineHeight: cell().rows.length > 1 ? TITLE_ROW_H : ROOT_ROW_H,
                        height: rootRowHeight(cell().rows.length),
                      }}
                      debugName={`rpgkit-save-root-${i()}`}
                    >
                      {`${prefix()}${cell().rows.join(`\n${IDLE_PREFIX}`)}`}
                    </Text>
                  </Show>
                );
              }}
            </For>
            <View class="grow" />
            <BoundedLine
              cell={legendCell()}
              tick={marqueeTick}
              textColor={theme().dim}
              rowH={14}
              width={CONTENT_W}
              debugName="rpgkit-save-legend"
            />
          </Show>

          {/* SLOT LISTS */}
          <Show when={props.menu().kind === "slots-save" || props.menu().kind === "slots-load"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "slots-save" && m.kind !== "slots-load") return null;
              return (
                <>
                  <BoundedLine
                    cell={slotTitle()}
                    tick={marqueeTick}
                    textColor={theme().accent}
                    rowH={TITLE_ROW_H}
                    width={CONTENT_W}
                    sizeClass="text-sm"
                    debugName="rpgkit-slot-title"
                  />
                  <View style={{ height: 6 }} />
                  <Show when={m.kind === "slots-load" && hasAutosave()}>
                    <BoundedLine
                      cell={autosaveCell()}
                      tick={marqueeTick}
                      textColor={m.index === 0 ? theme().accent : theme().dim}
                      rowH={SLOT_WRAP_ROW_H}
                      width={CONTENT_W}
                      sizeClass="text-sm"
                      debugName="rpgkit-autosave-slot"
                    />
                  </Show>
                  <For each={m.kind === "slots-save" || props.hasFs ? [0, 1, 2] : []}>
                    {(row) => {
                      // The summary (a map id may be CJK) on one row as
                      // before, or wrapped: its rows stack in one Text
                      // beside the prefix and slot number, so every row
                      // starts under the first.
                      const summary = slotRows[row]!;
                      const index = () => row + (m.kind === "slots-load" && hasAutosave() ? 1 : 0);
                      const colour = () => (m.index === index() ? theme().accent : theme().ink);
                      const lead = () => `${m.index === index() ? SELECTED_PREFIX : IDLE_PREFIX}${row + 1}. `;
                      const measure = slotMeasure(TEXT_SM_SLOT);
                      const labelW = CONTENT_W - Math.max(measure(SELECTED_PREFIX), measure(IDLE_PREFIX)) - measure(`${row + 1}. `);
                      return (
                        <Show
                          when={summary().kind === "wrap" && summary().rows.length > 1}
                          fallback={
                            summary().kind === "marquee" ? (
                              <View
                                class="flex-row"
                                style={{ height: SLOT_ROW_H, paddingT: (SLOT_ROW_H - SLOT_WRAP_ROW_H) / 2 }}
                                debugName={`rpgkit-slot-${row}`}
                              >
                                <Text class="text-sm" style={{ textColor: colour(), lineHeight: SLOT_WRAP_ROW_H, height: SLOT_WRAP_ROW_H }}>
                                  {lead()}
                                </Text>
                                <View style={{ width: labelW, height: SLOT_WRAP_ROW_H, overflow: 1 }}>
                                  <Text
                                    class="text-sm"
                                    style={{ textColor: colour(), lineHeight: SLOT_WRAP_ROW_H, height: SLOT_WRAP_ROW_H, shrink: 0, translateX: -marqueeOffset(summary().overflow, marqueeTick()) }}
                                    debugName={`rpgkit-slot-${row}-summary`}
                                  >
                                    {summary().rows[0]}
                                  </Text>
                                </View>
                              </View>
                            ) : (
                              <Text
                                class="text-sm"
                                style={{ textColor: colour(), lineHeight: SLOT_ROW_H, height: SLOT_ROW_H }}
                                debugName={`rpgkit-slot-${row}`}
                              >
                                {`${lead()}${summary().rows[0] ?? ""}`}
                              </Text>
                            )
                          }
                        >
                          <View
                            class="flex-row"
                            style={{ height: slotRowHeight(summary().rows.length), paddingT: (SLOT_ROW_H - SLOT_WRAP_ROW_H) / 2 }}
                            debugName={`rpgkit-slot-${row}`}
                          >
                            <Text class="text-sm" style={{ textColor: colour(), lineHeight: SLOT_WRAP_ROW_H, height: SLOT_WRAP_ROW_H }}>
                              {lead()}
                            </Text>
                            <Text
                              class="text-sm"
                              style={{ textColor: colour(), lineHeight: SLOT_WRAP_ROW_H, height: summary().rows.length * SLOT_WRAP_ROW_H }}
                              debugName={`rpgkit-slot-${row}-summary`}
                            >
                              {summary().rows.join("\n")}
                            </Text>
                          </View>
                        </Show>
                      );
                    }}
                  </For>
                  <View class="grow" />
                  <BoundedLine
                    cell={legendCell()}
                    tick={marqueeTick}
                    textColor={theme().dim}
                    rowH={14}
                    width={CONTENT_W}
                    debugName="rpgkit-slot-legend"
                  />
                </>
              );
            })()}
          </Show>

          {/* CODE EXPORT */}
          <Show when={props.menu().kind === "code-export"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "code-export") return null;
              const all = pages();
              const page = Math.min(m.page, all.length - 1);
              return (
                <>
                  <BoundedLine
                    cell={codeTitle()}
                    tick={marqueeTick}
                    textColor={theme().accent}
                    rowH={XS_ROW_H}
                    width={CONTENT_W}
                    debugName="rpgkit-code-title"
                  />
                  <View style={{ height: 4 }} />
                  <For each={pageRows(all[page]!)}>
                    {(line) => (
                      <Text class="text-xs" style={{ textColor: theme().ink, lineHeight: 15, height: 15 }} debugName="rpgkit-code-row">
                        {line}
                      </Text>
                    )}
                  </For>
                  <View class="grow" />
                  <BoundedLine
                    cell={codeHint()}
                    tick={marqueeTick}
                    textColor={theme().dim}
                    rowH={XS_ROW_H}
                    width={CONTENT_W}
                    debugName="rpgkit-code-hint"
                  />
                </>
              );
            })()}
          </Show>

          {/* CODE IMPORT */}
          <Show when={props.menu().kind === "code-import"}>
            <BoundedLine
              cell={importTitle()}
              tick={marqueeTick}
              textColor={theme().accent}
              rowH={TITLE_ROW_H}
              width={CONTENT_W}
              sizeClass="text-sm"
              debugName="rpgkit-import-title"
            />
            <View style={{ height: 4 }} />
            <BoundedLine
              cell={importHint()}
              tick={marqueeTick}
              textColor={theme().ink}
              rowH={XS_ROW_H}
              width={CONTENT_W}
              debugName="rpgkit-import-hint"
            />
          </Show>

          {/* MESSAGE */}
          <Show when={props.menu().kind === "message"}>
            {(() => {
              const m = props.menu();
              if (m.kind !== "message") return null;
              // Game-supplied texts: wrapped to the panel's width, each
              // one Text of as many rows as it needs.
              const title = () => messageRows().title;
              const body = () => messageRows().body;
              return (
                <>
                  <View class="grow" />
                  <BoundedLine
                    cell={title()}
                    tick={marqueeTick}
                    textColor={theme().accent}
                    rowH={TITLE_ROW_H}
                    width={CONTENT_W}
                    sizeClass="text-sm"
                    debugName="rpgkit-message-title"
                  />
                  <View style={{ height: 6 }} />
                  <BoundedLine
                    cell={body()}
                    tick={marqueeTick}
                    textColor={theme().ink}
                    rowH={TITLE_ROW_H}
                    width={CONTENT_W}
                    sizeClass="text-sm"
                    debugName="rpgkit-message-body"
                  />
                  <View class="grow" />
                  <BoundedLine
                    cell={legendCell()}
                    tick={marqueeTick}
                    textColor={theme().dim}
                    rowH={14}
                    width={CONTENT_W}
                    debugName="rpgkit-message-legend"
                  />
                </>
              );
            })()}
          </Show>
        </Panel>
      </View>
      {/* The system keyboard floats over the overlay while importing. */}
      <Osk osk={props.osk} />
    </Show>
  );
}
