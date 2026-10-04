// Pure, deterministic geometry for the event inspector.  The renderer and
// the companion-input path both consume this object, so there are no hidden
// DOM hit targets (PocketJS receives raw logical-pixel pointer coordinates).

import { breakText, type Measure } from "../../src/engine/text-break.ts";

export interface InspectorRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InspectorField {
  /** Stable key understood by the event editor reducer. */
  key: string;
  label: string;
  value: string | number | boolean | null;
  kind?: "text" | "integer" | "number" | "boolean" | "enum";
  options?: readonly string[];
  hint?: string;
  /** Draw `hint` under the field, wrapped (see inspectorFieldLines). */
  inlineHint?: boolean;
  readOnly?: boolean;
}

/** Structural row accepted from the command-tree flattener.  It deliberately
 * does not import the command editor: the app can adapt any address/path
 * representation while this presentational module stays independent. */
export interface InspectorCommandRow {
  readonly key: string;
  readonly depth: number;
  /** Branch caption such as THEN, ELSE, CHOICE 2, WIN, or CANCEL. */
  readonly branch?: string;
  readonly branchLabel?: string;
  /** `flattenCommands()` supplies command; `op` remains as a convenient
   * adapter shorthand for tests or other flatteners. */
  readonly command?: { readonly op: string };
  readonly op?: string;
  readonly summary?: string;
  readonly fields?: readonly InspectorField[];
  readonly editable?: boolean;
  readonly readOnly?: boolean;
  /** Explicit false marks an operation the editor can display but not edit. */
  readonly supported?: boolean;
  /** Equivalent positive marker for adapters whose flattener uses this form. */
  readonly unsupported?: boolean;
}

export type InspectorConditionSource =
  | { kind: "flat"; key: "switch" | "selfSwitch" | "variable" | "item" }
  | { kind: "all"; index: number };

export interface InspectorConditionRow {
  key: string;
  kind: string;
  summary: string;
  source: InspectorConditionSource;
  fields: readonly InspectorField[];
  readOnly?: boolean;
}

export interface InspectorScrollOffsets {
  pagesX: number;
  conditionsY: number;
  commandsY: number;
}

export const ZERO_INSPECTOR_SCROLL: Readonly<InspectorScrollOffsets> = {
  pagesX: 0,
  conditionsY: 0,
  commandsY: 0,
};

export type EventField = "name" | "x" | "y" | "w" | "h";
export type PageField = "trigger" | "sprite" | "direction" | "moveType" | "blocks";
export type RouteField = "enabled" | "repeat" | "skippable" | "steps";
export type PageAction = "add" | "delete" | "up" | "down" | "copy";
export type ConditionAction = "add" | "delete";
export type CommandAction = "add" | "delete" | "up" | "down" | "copy";

export type EventInspectorAction =
  | { kind: "close" }
  | { kind: "event-field"; field: EventField }
  | { kind: "page-action"; action: PageAction }
  | { kind: "page-select"; page: number }
  | { kind: "page-field"; field: PageField }
  | { kind: "route-field"; field: RouteField }
  | { kind: "condition-action"; action: ConditionAction }
  | { kind: "condition-select"; row: number }
  | { kind: "condition-field"; row: number; field: string; readOnly: boolean }
  | { kind: "command-action"; action: CommandAction }
  | { kind: "command-select"; row: number }
  | { kind: "command-field"; row: number; field: string; readOnly: boolean }
  | { kind: "command-pick"; row: number };

export interface InspectorControl<A = EventInspectorAction> {
  rect: InspectorRect;
  action: A;
  label: string;
}

export interface InspectorRowGeometry {
  row: number;
  key: string;
  /** Unclipped content rectangle. Children are clipped to the list window. */
  rect: InspectorRect;
  header: InspectorControl;
  fields: InspectorControl[];
  /** Transfer rows only: the PICK button at the header's right edge. */
  pick?: InspectorControl;
  readOnly: boolean;
}

export interface EventInspectorLayout {
  width: number;
  height: number;
  compact: boolean;
  bodyTop: number;
  leftWidth: number;
  close: InspectorControl;
  eventFields: InspectorControl[];
  pageActions: InspectorControl[];
  pageTabs: InspectorControl[];
  pageFields: InspectorControl[];
  routeFields: InspectorControl[];
  conditionActions: InspectorControl[];
  conditionClip: InspectorRect;
  conditionRows: InspectorRowGeometry[];
  commandActions: InspectorControl[];
  commandClip: InspectorRect;
  commandRows: InspectorRowGeometry[];
  /** Front-to-back pointer regions. Kept public for tests and focus rings. */
  hitRegions: InspectorControl[];
}

export interface EventInspectorLayoutOptions {
  width: number;
  height: number;
  pageCount: number;
  activePage: number;
  conditions: readonly InspectorConditionRow[];
  commands: readonly InspectorCommandRow[];
  scroll?: Partial<InspectorScrollOffsets>;
  /** Width of a `text-xs` string; the app passes the baked font's
   *  measurer. Sizes the rows of fields that draw their hint (absent: an
   *  estimate of 12 px per CJK character and 7 px per other one). */
  measure?: Measure;
}

export const INSPECTOR_HEADER_H = 24;
export const INSPECTOR_EVENT_H = 28;
export const INSPECTOR_PAGES_H = 28;
export const INSPECTOR_BODY_TOP =
  INSPECTOR_HEADER_H + INSPECTOR_EVENT_H + INSPECTOR_PAGES_H;
export const INSPECTOR_ROW_H = 18;
/** Line height of a field's wrapped text (`text-xs`). */
export const INSPECTOR_LINE_H = 12;
/** Text inset inside a field control: 3 px left, right and top. */
const FIELD_TEXT_PAD = 3;

const PAD = 4;
const GAP = 3;
const CONTROL_H = 20;
const SECTION_H = 22;
const PAGE_TAB_W = 42;

const estimateWidth: Measure = (text) => {
  let width = 0;
  for (const ch of text) width += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 12 : 7;
  return width;
};

/** The wrapped lines of a field that draws its hint (`inlineHint`) in a
 *  control `width` wide: its "LABEL value" lines, then the hint's lines.
 *  Lines break between CJK characters and at spaces, and a word wider than
 *  the control breaks between letters, so nothing is ever cut. The label
 *  lines are sized for the widest option, so cycling an enum keeps the
 *  row's height. Null for a field drawn on one line. */
export function inspectorFieldLines(
  field: InspectorField,
  width: number,
  value: string,
  measure: Measure = estimateWidth,
): { label: string[]; hint: string[]; rows: number } | null {
  if (!field.inlineHint || !field.hint) return null;
  const budget = Math.max(1, width - 2 * FIELD_TEXT_PAD);
  const wrap = (text: string) => breakText(text, budget, measure).map((row) => row.text.replace(/ +$/, ""));
  const label = wrap(value === "" ? field.label : `${field.label} ${value}`);
  const widest = Math.max(label.length, ...(field.options ?? []).map((option) => wrap(`${field.label} ${option}`).length));
  const hint = wrap(field.hint);
  return { label, hint, rows: widest + hint.length };
}

/** Height of a field control: one row, or the wrapped lines of a field
 *  that draws its hint. */
function fieldHeight(field: InspectorField, width: number, measure: Measure | undefined): number {
  const lines = inspectorFieldLines(field, width, String(field.value ?? ""), measure);
  return lines ? Math.max(INSPECTOR_ROW_H, 2 * FIELD_TEXT_PAD + lines.rows * INSPECTOR_LINE_H) : INSPECTOR_ROW_H;
}

export function inspectorCommandOp(row: InspectorCommandRow): string {
  return row.op ?? row.command?.op ?? "unknown";
}

/** Editable rows for a command row. The app always supplies `fields` (see
 * commandInspectorRows in event-fields.ts), so they are returned verbatim;
 * an adapter that omits them gets an empty list. No field keys are derived
 * from the command payload here — the dotted keys the reducer understands
 * live exclusively in event-fields.ts. */
export function inspectorCommandFields(row: InspectorCommandRow): readonly InspectorField[] {
  return row.fields ?? [];
}

function rect(x: number, y: number, w: number, h: number): InspectorRect {
  return { x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function control<A extends EventInspectorAction>(
  label: string,
  r: InspectorRect,
  action: A,
): InspectorControl<A> {
  return { label, rect: r, action };
}

export function inspectorControlFullyVisible(control: InspectorControl, clip: InspectorRect): boolean {
  return control.rect.x >= clip.x
    && control.rect.y >= clip.y
    && control.rect.x + control.rect.w <= clip.x + clip.w
    && control.rect.y + control.rect.h <= clip.y + clip.h;
}

function normalizeScroll(scroll: Partial<InspectorScrollOffsets> | undefined): InspectorScrollOffsets {
  return {
    pagesX: Math.max(0, scroll?.pagesX ?? 0),
    conditionsY: Math.max(0, scroll?.conditionsY ?? 0),
    commandsY: Math.max(0, scroll?.commandsY ?? 0),
  };
}

function addVisibleRows(
  hitRegions: InspectorControl[],
  rows: InspectorRowGeometry[],
  clip: InspectorRect,
): void {
  for (const row of rows) {
    if (inspectorControlFullyVisible(row.header, clip)) hitRegions.push(row.header);
    // The PICK button overlaps the header's right edge; push it after the
    // header so reverse hit-testing finds the button first.
    if (row.pick && inspectorControlFullyVisible(row.pick, clip)) hitRegions.push(row.pick);
    for (const field of row.fields) {
      if (inspectorControlFullyVisible(field, clip)) hitRegions.push(field);
    }
  }
}

/** Create the complete inspector geometry in logical pixels.  It is usable at
 * arbitrary sizes; 480x272 selects a 210 px detail column and 720x480 a
 * 260 px column. Lists scroll inside their own clips while all chrome stays
 * fixed. */
export function createEventInspectorLayout(
  options: EventInspectorLayoutOptions,
): EventInspectorLayout {
  const width = Math.max(320, Math.floor(options.width));
  const height = Math.max(200, Math.floor(options.height));
  const compact = width < 640;
  const leftWidth = Math.min(width - 180, compact ? 210 : 260);
  const scroll = normalizeScroll(options.scroll);
  const hitRegions: InspectorControl[] = [];

  const close = control("BACK", rect(PAD, 3, 48, 18), { kind: "close" });
  hitRegions.push(close);

  // Event row. Give the name everything not needed by four equal numeric
  // cells; it remains a generous 280 px at the compact target size.
  const eventY = INSPECTOR_HEADER_H + 3;
  const numberW = compact ? 43 : 52;
  const nameW = width - PAD * 2 - (numberW + GAP) * 4;
  let x = PAD;
  const eventFields: InspectorControl[] = [];
  eventFields.push(control("NAME", rect(x, eventY, nameW, CONTROL_H), { kind: "event-field", field: "name" }));
  x += nameW + GAP;
  for (const field of ["x", "y", "w", "h"] as const) {
    const c = control(field.toUpperCase(), rect(x, eventY, numberW, CONTROL_H), {
      kind: "event-field" as const,
      field,
    });
    eventFields.push(c);
    x += numberW + GAP;
  }
  hitRegions.push(...eventFields);

  // Page operations occupy a stable 158 px prefix; tabs scroll horizontally
  // in the remainder. A partially visible tab gets a correspondingly clipped
  // hit box, never a target under the COPY button.
  const pagesY = INSPECTOR_HEADER_H + INSPECTOR_EVENT_H + 3;
  const pageActionSpecs: readonly [PageAction, string, number][] = [
    ["add", "+", 25],
    ["delete", "DEL", 32],
    ["up", "UP", 27],
    ["down", "DN", 27],
    ["copy", "COPY", 40],
  ];
  const pageActions: InspectorControl[] = [];
  x = PAD;
  for (const [action, label, w] of pageActionSpecs) {
    const c = control(label, rect(x, pagesY, w, CONTROL_H), { kind: "page-action", action });
    pageActions.push(c);
    x += w + GAP;
  }
  hitRegions.push(...pageActions);
  const tabsX = x + 1;
  const tabsClip = rect(tabsX, pagesY, width - tabsX - PAD, CONTROL_H);
  const pageTabs: InspectorControl[] = [];
  const pageCount = Math.max(0, Math.floor(options.pageCount));
  const lastTabRight = pageCount > 0 ? tabsX + (pageCount - 1) * (PAGE_TAB_W + GAP) + PAGE_TAB_W : tabsX;
  const maxPagesX = Math.max(0, lastTabRight - (tabsClip.x + tabsClip.w));
  let pagesX = Math.min(scroll.pagesX, maxPagesX);
  if (pageCount > 0) {
    const activePage = Math.max(0, Math.min(pageCount - 1, Math.floor(options.activePage)));
    const activeLeft = tabsX + activePage * (PAGE_TAB_W + GAP);
    const activeRight = activeLeft + PAGE_TAB_W;
    if (activeLeft - pagesX < tabsClip.x) pagesX = activeLeft - tabsClip.x;
    else if (activeRight - pagesX > tabsClip.x + tabsClip.w) pagesX = activeRight - (tabsClip.x + tabsClip.w);
    pagesX = Math.max(0, Math.min(maxPagesX, pagesX));
  }
  for (let page = 0; page < pageCount; page++) {
    const raw = control(
      `P${page + 1}`,
      rect(tabsX + page * (PAGE_TAB_W + GAP) - pagesX, pagesY, PAGE_TAB_W, CONTROL_H),
      { kind: "page-select" as const, page },
    );
    if (inspectorControlFullyVisible(raw, tabsClip)) {
      pageTabs.push(raw);
      hitRegions.push(raw);
    }
  }

  const bodyTop = INSPECTOR_BODY_TOP;
  const detailX = PAD;
  const detailW = leftWidth - PAD * 2;
  const half = Math.floor((detailW - GAP) / 2);
  const third = Math.floor((detailW - GAP * 2) / 3);

  const pageFields: InspectorControl[] = [
    control("TRIGGER", rect(detailX, bodyTop + 3, half, CONTROL_H), { kind: "page-field", field: "trigger" }),
    control("SPRITE", rect(detailX + half + GAP, bodyTop + 3, detailW - half - GAP, CONTROL_H), { kind: "page-field", field: "sprite" }),
    control("DIR", rect(detailX, bodyTop + 3 + SECTION_H, third, CONTROL_H), { kind: "page-field", field: "direction" }),
    control("MOVE", rect(detailX + third + GAP, bodyTop + 3 + SECTION_H, third, CONTROL_H), { kind: "page-field", field: "moveType" }),
    control("BLOCKS", rect(detailX + (third + GAP) * 2, bodyTop + 3 + SECTION_H, detailW - (third + GAP) * 2, CONTROL_H), { kind: "page-field", field: "blocks" }),
  ];
  hitRegions.push(...pageFields);

  const routeY = bodyTop + 3 + SECTION_H * 2;
  const routeFields: InspectorControl[] = [
    control("ROUTE", rect(detailX, routeY, third, CONTROL_H), { kind: "route-field", field: "enabled" }),
    control("REPEAT", rect(detailX + third + GAP, routeY, third, CONTROL_H), { kind: "route-field", field: "repeat" }),
    control("SKIP", rect(detailX + (third + GAP) * 2, routeY, detailW - (third + GAP) * 2, CONTROL_H), { kind: "route-field", field: "skippable" }),
    control("STEPS", rect(detailX, routeY + SECTION_H, detailW, CONTROL_H), { kind: "route-field", field: "steps" }),
  ];
  hitRegions.push(...routeFields);

  const conditionBarY = routeY + SECTION_H * 2 + 2;
  const conditionActions: InspectorControl[] = [
    control("+", rect(leftWidth - 60, conditionBarY, 20, CONTROL_H), { kind: "condition-action", action: "add" }),
    control("DEL", rect(leftWidth - 36, conditionBarY, 32, CONTROL_H), { kind: "condition-action", action: "delete" }),
  ];
  hitRegions.push(...conditionActions);
  const conditionClip = rect(PAD, conditionBarY + CONTROL_H + 2, leftWidth - PAD * 2, height - (conditionBarY + CONTROL_H + 2) - PAD);

  const conditionRows: InspectorRowGeometry[] = [];
  let rowY = conditionClip.y - scroll.conditionsY;
  options.conditions.forEach((condition, row) => {
    const rowH = INSPECTOR_ROW_H + condition.fields.length * INSPECTOR_ROW_H + 3;
    const rowRect = rect(conditionClip.x, rowY, conditionClip.w, rowH);
    const header = control(
      condition.kind.toUpperCase(),
      rect(rowRect.x, rowY, rowRect.w, INSPECTOR_ROW_H),
      { kind: "condition-select" as const, row },
    );
    const fields = condition.fields.map((field, fieldIndex) => control(
      field.label,
      rect(rowRect.x + 8, rowY + INSPECTOR_ROW_H + fieldIndex * INSPECTOR_ROW_H, rowRect.w - 8, INSPECTOR_ROW_H),
      {
        kind: "condition-field" as const,
        row,
        field: field.key,
        readOnly: condition.readOnly === true || field.readOnly === true,
      },
    ));
    conditionRows.push({
      row,
      key: condition.key,
      rect: rowRect,
      header,
      fields,
      readOnly: condition.readOnly === true,
    });
    rowY += rowH + GAP;
  });
  addVisibleRows(hitRegions, conditionRows, conditionClip);

  const commandX = leftWidth + 2;
  const commandW = width - commandX;
  const commandBarY = bodyTop + 3;
  const commandActionSpecs: readonly [CommandAction, string, number][] = width < 440
    ? [
      ["add", "+", 20],
      ["delete", "DEL", 30],
      ["up", "UP", 24],
      ["down", "DN", 26],
      ["copy", "CPY", 34],
    ]
    : [
      ["add", "+", 25],
      ["delete", "DEL", 32],
      ["up", "UP", 27],
      ["down", "DN", 27],
      ["copy", "COPY", 40],
    ];
  const commandActions: InspectorControl[] = [];
  x = commandX + commandW - PAD;
  for (let i = commandActionSpecs.length - 1; i >= 0; i--) {
    const [action, label, w] = commandActionSpecs[i]!;
    x -= w;
    commandActions.unshift(control(label, rect(x, commandBarY, w, CONTROL_H), { kind: "command-action", action }));
    x -= GAP;
  }
  hitRegions.push(...commandActions);
  const commandClip = rect(commandX + PAD, commandBarY + CONTROL_H + 2, commandW - PAD * 2, height - (commandBarY + CONTROL_H + 2) - PAD);

  const commandRows: InspectorRowGeometry[] = [];
  rowY = commandClip.y - scroll.commandsY;
  options.commands.forEach((command, row) => {
    const fieldsList = inspectorCommandFields(command);
    const indent = Math.max(0, Math.floor(command.depth)) * 10;
    const contentX = commandClip.x + Math.min(indent, Math.max(0, commandClip.w - 50));
    const contentW = commandClip.x + commandClip.w - contentX;
    const fieldHeights = fieldsList.map((field) => fieldHeight(field, contentW - 8, options.measure));
    const rowH = CONTROL_H + fieldHeights.reduce((sum, h) => sum + h, 0) + 3;
    const rowRect = rect(contentX, rowY, contentW, rowH);
    const readOnly = command.readOnly === true
      || command.unsupported === true
      || command.supported === false
      || command.editable === false
      || inspectorCommandOp(command) === "ext";
    const header = control(
      inspectorCommandOp(command).toUpperCase(),
      rect(rowRect.x, rowY, rowRect.w, CONTROL_H),
      { kind: "command-select" as const, row },
    );
    // Transfer rows get a PICK button at the header's right edge: click it,
    // then click a cell on any map to fill map/x/y/dir from the canvas.
    // (Registered in hitRegions by addVisibleRows, after the row header.)
    let pick: InspectorControl | undefined;
    if (inspectorCommandOp(command) === "transfer") {
      pick = control(
        "PICK",
        rect(rowRect.x + rowRect.w - 40, rowY, 36, CONTROL_H),
        { kind: "command-pick" as const, row },
      );
    }
    let fieldY = rowY + CONTROL_H;
    const fieldTops = fieldHeights.map((h) => (fieldY += h) - h);
    const fields = fieldsList.map((field, fieldIndex) => control(
      field.label,
      rect(rowRect.x + 8, fieldTops[fieldIndex]!, rowRect.w - 8, fieldHeights[fieldIndex]!),
      {
        kind: "command-field" as const,
        row,
        field: field.key,
        readOnly: readOnly || field.readOnly === true,
      },
    ));
    commandRows.push({ row, key: command.key, rect: rowRect, header, fields, readOnly, pick });
    rowY += rowH + GAP;
  });
  addVisibleRows(hitRegions, commandRows, commandClip);

  return {
    width,
    height,
    compact,
    bodyTop,
    leftWidth,
    close,
    eventFields,
    pageActions,
    pageTabs,
    pageFields,
    routeFields,
    conditionActions,
    conditionClip,
    conditionRows,
    commandActions,
    commandClip,
    commandRows,
    hitRegions,
  };
}

function inside(x: number, y: number, r: InspectorRect): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

/** Raw-pointer hit test. Passing the already-created layout ensures the
 * input path uses precisely the same viewport, rows and scroll offsets that
 * were drawn. */
export function hitTestEventInspector(
  layout: EventInspectorLayout,
  x: number,
  y: number,
): EventInspectorAction | null {
  if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return null;
  // Later controls are visually on top (field rows over their containing
  // row), hence the reverse traversal.
  for (let i = layout.hitRegions.length - 1; i >= 0; i--) {
    const region = layout.hitRegions[i]!;
    if (inside(x, y, region.rect)) return region.action;
  }
  return null;
}

/** Short aliases keep companion/app call sites pleasant. */
export const eventInspectorLayout = createEventInspectorLayout;
export const eventInspectorHitTest = hitTestEventInspector;

/** Stable identity for focus/input-buffer state. */
export function inspectorActionKey(action: EventInspectorAction | null): string {
  if (!action) return "";
  switch (action.kind) {
    case "close": return "close";
    case "event-field": return `event:${action.field}`;
    case "page-action": return `page-action:${action.action}`;
    case "page-select": return `page:${action.page}`;
    case "page-field": return `page-field:${action.field}`;
    case "route-field": return `route:${action.field}`;
    case "condition-action": return `condition-action:${action.action}`;
    case "condition-select": return `condition:${action.row}`;
    case "condition-field": return `condition:${action.row}:${action.field}`;
    case "command-action": return `command-action:${action.action}`;
    case "command-select": return `command:${action.row}`;
    case "command-field": return `command:${action.row}:${action.field}`;
    case "command-pick": return `command-pick:${action.row}`;
  }
}
