// Pure event-inspector geometry: every visible control is a real pointer
// target at both supported editor profiles. No PocketJS host or bundle.

import { describe, expect, test } from "bun:test";
import {
  createEventInspectorLayout,
  hitTestEventInspector,
  inspectorActionKey,
  inspectorControlFullyVisible,
  inspectorFieldLines,
  INSPECTOR_ROW_H,
  type EventInspectorAction,
  type InspectorCommandRow,
  type InspectorConditionRow,
  type InspectorControl,
  type InspectorRect,
} from "../editor/engine/event-layout.ts";
import { flattenCommands } from "../editor/engine/commands.ts";
import { commandInspectorRows } from "../editor/engine/event-fields.ts";
import { HEADER_H, STATUS_H } from "../editor/engine/layout.ts";

const conditions: InspectorConditionRow[] = [
  {
    key: "all:0",
    kind: "variable",
    summary: "quest >= 2",
    source: { kind: "all", index: 0 },
    fields: [
      { key: "id", label: "ID", value: "quest" },
      { key: "op", label: "OP", value: ">=" },
      { key: "value", label: "VALUE", value: 2 },
    ],
  },
];

const commands: InspectorCommandRow[] = [
  {
    key: "root:0",
    depth: 0,
    op: "switch",
    summary: "gate = ON",
    fields: [
      { key: "id", label: "ID", value: "gate" },
      { key: "value", label: "VALUE", value: true },
    ],
  },
];

function center(r: InspectorRect): [number, number] {
  return [r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2)];
}

function expectHit(
  layout: ReturnType<typeof createEventInspectorLayout>,
  control: InspectorControl,
): void {
  const [x, y] = center(control.rect);
  expect(hitTestEventInspector(layout, x, y)).toEqual(control.action);
}

function expectKinds(
  actions: readonly EventInspectorAction[],
  expected: readonly EventInspectorAction["kind"][],
): void {
  expect(actions.map((action) => action.kind)).toEqual([...expected]);
}

for (const [width, height] of [[480, 272], [720, 480]] as const) {
  describe(`event inspector ${width}x${height}`, () => {
    const layout = createEventInspectorLayout({
      width,
      height: height - HEADER_H - STATUS_H,
      pageCount: 3,
      activePage: 1,
      conditions,
      commands,
      scroll: { pagesX: 0, conditionsY: 0, commandsY: 0 },
    });

    test("uses the responsive column and remains inside the viewport", () => {
      expect(layout.compact).toBe(width === 480);
      expect(layout.leftWidth).toBe(width === 480 ? 210 : 260);
      for (const region of layout.hitRegions) {
        expect(region.rect.x).toBeGreaterThanOrEqual(0);
        expect(region.rect.y).toBeGreaterThanOrEqual(0);
        expect(region.rect.x + region.rect.w).toBeLessThanOrEqual(width);
        expect(region.rect.y + region.rect.h).toBeLessThanOrEqual(height - HEADER_H - STATUS_H);
        expect(region.rect.w).toBeGreaterThan(0);
        expect(region.rect.h).toBeGreaterThan(0);
      }
    });

    test("hits back and all event fields", () => {
      expectHit(layout, layout.close);
      expect(inspectorActionKey(layout.close.action)).toBe("close");
      layout.eventFields.forEach((control) => expectHit(layout, control));
      expectKinds(layout.eventFields.map((control) => control.action), [
        "event-field",
        "event-field",
        "event-field",
        "event-field",
        "event-field",
      ]);
      expect(layout.eventFields.map((control) => control.action.kind === "event-field" && control.action.field)).toEqual([
        "name", "x", "y", "w", "h",
      ]);
    });

    test("hits page operations, visible tabs, page settings and route controls", () => {
      layout.pageActions.forEach((control) => expectHit(layout, control));
      expect(layout.pageActions.map((control) => control.action.kind === "page-action" && control.action.action)).toEqual([
        "add", "delete", "up", "down", "copy",
      ]);

      expect(layout.pageTabs).toHaveLength(3);
      layout.pageTabs.forEach((control) => expectHit(layout, control));
      expect(layout.pageTabs.map((control) => control.action.kind === "page-select" && control.action.page)).toEqual([0, 1, 2]);

      layout.pageFields.forEach((control) => expectHit(layout, control));
      expect(layout.pageFields.map((control) => control.action.kind === "page-field" && control.action.field)).toEqual([
        "trigger", "sprite", "direction", "moveType", "blocks",
      ]);

      layout.routeFields.forEach((control) => expectHit(layout, control));
      expect(layout.routeFields.map((control) => control.action.kind === "route-field" && control.action.field)).toEqual([
        "enabled", "repeat", "skippable", "steps",
      ]);
    });

    test("hits condition toolbar, selection row and each field row", () => {
      layout.conditionActions.forEach((control) => expectHit(layout, control));
      expect(layout.conditionActions.map((control) => control.action.kind === "condition-action" && control.action.action)).toEqual([
        "add", "delete",
      ]);
      const row = layout.conditionRows[0]!;
      const visible = [row.header, ...row.fields].filter((control) =>
        inspectorControlFullyVisible(control, layout.conditionClip)
      );
      expect(visible.length).toBeGreaterThan(0);
      visible.forEach((control) => expectHit(layout, control));
      for (const control of [row.header, ...row.fields].filter((candidate) => !visible.includes(candidate))) {
        const [x, y] = center(control.rect);
        expect(hitTestEventInspector(layout, x, y)).toBeNull();
      }
      expect(row.fields.map((control) => control.action.kind === "condition-field" && control.action.field)).toEqual([
        "id", "op", "value",
      ]);
    });

    test("hits command toolbar, selection row and each field row", () => {
      layout.commandActions.forEach((control) => expectHit(layout, control));
      expect(layout.commandActions.map((control) => control.action.kind === "command-action" && control.action.action)).toEqual([
        "add", "delete", "up", "down", "copy",
      ]);
      const row = layout.commandRows[0]!;
      expectHit(layout, row.header);
      row.fields.forEach((control) => expectHit(layout, control));
      expect(row.fields.map((control) => control.action.kind === "command-field" && control.action.field)).toEqual([
        "id", "value",
      ]);
    });

    test("empty chrome and outside coordinates do not hit", () => {
      expect(hitTestEventInspector(layout, width - 2, 1)).toBeNull();
      expect(hitTestEventInspector(layout, -1, 10)).toBeNull();
      expect(hitTestEventInspector(layout, width, height - 1)).toBeNull();
      expect(hitTestEventInspector(layout, 2, height - 2)).toBeNull();
    });
  });
}

describe("event inspector scrolling and clipping", () => {
  const manyConditions: InspectorConditionRow[] = Array.from({ length: 5 }, (_, row) => ({
    key: `all:${row}`,
    kind: row === 4 ? "ext" : "switch",
    summary: `condition ${row}`,
    source: { kind: "all", index: row },
    fields: [{ key: "id", label: "ID", value: `switch-${row}`, readOnly: row === 4 }],
    readOnly: row === 4,
  }));
  const manyCommands: InspectorCommandRow[] = Array.from({ length: 6 }, (_, row) => ({
    key: `root:${row}`,
    depth: row % 3,
    branch: row === 2 ? "ELSE" : undefined,
    op: row === 5 ? "ext" : "text",
    summary: `command ${row}`,
    fields: [{ key: "value", label: "VALUE", value: row }],
  }));

  test("scrolled rows retain semantic indices and cannot hit through list clips", () => {
    const layout = createEventInspectorLayout({
      width: 480,
      height: 272 - HEADER_H - STATUS_H,
      pageCount: 12,
      activePage: 9,
      conditions: manyConditions,
      commands: manyCommands,
      scroll: { pagesX: 180, conditionsY: 84, commandsY: 96 },
    });

    // Raw geometry is allowed above the clip; only complete control lines
    // enter hitRegions, so fixed toolbars remain clickable and no half-line
    // presents a misleading target.
    expect(layout.conditionRows[0]!.rect.y).toBeLessThan(layout.conditionClip.y);
    expect(layout.commandRows[0]!.rect.y).toBeLessThan(layout.commandClip.y);
    expectHit(layout, layout.conditionActions[0]!);
    expectHit(layout, layout.commandActions[0]!);

    const visibleCondition = layout.hitRegions.find((control) =>
      control.action.kind === "condition-select" && control.action.row > 0
    );
    const visibleCommand = layout.hitRegions.find((control) =>
      control.action.kind === "command-select" && control.action.row > 0
    );
    expect(visibleCondition).toBeDefined();
    expect(visibleCommand).toBeDefined();
    expectHit(layout, visibleCondition!);
    expectHit(layout, visibleCommand!);

    // Horizontal page scrolling retains original page indices.
    expect(layout.pageTabs.length).toBeGreaterThan(0);
    expect(layout.pageTabs[0]!.action).toMatchObject({ kind: "page-select", page: 4 });
    expect(layout.pageTabs.some((tab) => tab.action.kind === "page-select" && tab.action.page === 9)).toBe(true);
  });

  test("ext rows are marked read-only down through field actions", () => {
    const layout = createEventInspectorLayout({
      width: 720,
      height: 480,
      pageCount: 1,
      activePage: 0,
      conditions: manyConditions.slice(4),
      commands: manyCommands.slice(5),
    });
    expect(layout.conditionRows[0]!.readOnly).toBe(true);
    expect(layout.conditionRows[0]!.fields[0]!.action).toMatchObject({
      kind: "condition-field",
      readOnly: true,
    });
    expect(layout.commandRows[0]!.readOnly).toBe(true);
    expect(layout.commandRows[0]!.fields[0]!.action).toMatchObject({
      kind: "command-field",
      readOnly: true,
    });
  });

  test("command-tree rows without explicit fields render headers only", () => {
    const rows = flattenCommands([
      { op: "switch", id: "gate", value: true },
      { op: "if", if: { kind: "switch", id: "branch" }, then: [
        { op: "wait", seconds: 0.5 },
      ] },
      { op: "ext", call: "game.custom", args: { mode: 2 } },
    ]);
    const layout = createEventInspectorLayout({
      width: 720,
      height: 480,
      pageCount: 1,
      activePage: 0,
      conditions: [],
      commands: rows,
    });
    // The layout never derives editable keys from the command payload: rows
    // without `fields` contribute only their header control.
    expect(layout.commandRows.map((row) => row.fields)).toEqual([[], [], [], []]);
    expect(layout.commandRows[2]!.rect.x).toBeGreaterThan(layout.commandRows[1]!.rect.x);
    expect(layout.commandRows[3]!.readOnly).toBe(true);
  });
});

describe("condition action button geometry", () => {
  for (const [width, height, leftWidth] of [[480, 272, 210], [720, 480, 260]] as const) {
    test(`DEL fits its label without overlapping the title at ${width}px`, () => {
      const layout = createEventInspectorLayout({
        width,
        height,
        pageCount: 1,
        activePage: 0,
        conditions,
        commands,
      });
      expect(layout.leftWidth).toBe(leftWidth);
      const [add, del] = layout.conditionActions;
      expect(add!.label).toBe("+");
      expect(del!.label).toBe("DEL");
      // Pinned geometry: + at leftWidth-60 (w=20), DEL at leftWidth-36 (w=32).
      expect({ x: add!.rect.x, w: add!.rect.w }).toEqual({ x: leftWidth - 60, w: 20 });
      expect({ x: del!.rect.x, w: del!.rect.w }).toEqual({ x: leftWidth - 36, w: 32 });
      // compact() in the renderer allows floor((w-8)/6) chars; DEL needs 3.
      expect(Math.floor((del!.rect.w - 8) / 6)).toBeGreaterThanOrEqual(3);
      // The buttons never overlap each other and stay inside the left column.
      expect(add!.rect.x + add!.rect.w).toBeLessThanOrEqual(del!.rect.x);
      expect(del!.rect.x + del!.rect.w).toBeLessThanOrEqual(leftWidth);
      // The CONDITIONS (ALL) title (x=4, width=leftWidth-68) ends 4px before +.
      expect(4 + (leftWidth - 68)).toBe(add!.rect.x - 4);
    });
  }
});

describe("fields that draw their hint", () => {
  // 12 px per CJK character, 6 px per other one.
  const measure = (text: string) => [...text].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x2e80 ? 12 : 6), 0);
  const rows = commandInspectorRows([{ op: "text", lines: ["Hi"], position: "topRight" }]);
  const fields = rows[0]!.fields!;
  const position = fields.find((field) => field.key === "position")!;

  test("the label and the hint wrap inside the control, nothing cut", () => {
    for (const width of [400, 160, 80, 40]) {
      const lines = inspectorFieldLines(position, width, "topRight", measure)!;
      // Each row fits the text budget; joined back they hold every
      // character in order (a too-wide word breaks between letters).
      const strip = (text: string) => text.replace(/\s/g, "");
      expect(strip(lines.label.join(""))).toBe("POSITIONtopRight");
      for (const row of [...lines.label, ...lines.hint]) expect(measure(row)).toBeLessThanOrEqual(width - 6);
      expect(strip(lines.hint.join(""))).toBe(strip(position.hint!));
      if (width >= 160) expect(lines.label).toEqual(["POSITION topRight"]);
      expect(lines.rows).toBeGreaterThanOrEqual(lines.label.length + lines.hint.length);
    }
    // At 40 px the four Chinese characters break between them ("·" may
    // not begin a row, so "置" moves down with it).
    expect(inspectorFieldLines(position, 40, "topRight", measure)!.hint.slice(0, 3)).toEqual(["窗口", "位", "置 ·"]);
    // Fields without inlineHint stay one row.
    expect(inspectorFieldLines(fields.find((field) => field.key === "cps")!, 400, "", measure)).toBeNull();
  });

  test("the command row grows by the hint rows and the fields stack", () => {
    for (const width of [480, 720]) {
      const layout = createEventInspectorLayout({ width, height: 4000, pageCount: 1, activePage: 0, conditions: [], commands: rows, measure });
      const controls = layout.commandRows[0]!.fields;
      expect(controls.map((control) => control.label)).toEqual(fields.map((field) => field.label));
      for (let i = 1; i < controls.length; i++) {
        expect(controls[i]!.rect.y).toBe(controls[i - 1]!.rect.y + controls[i - 1]!.rect.h);
      }
      for (const [i, field] of fields.entries()) {
        const lines = inspectorFieldLines(field, controls[i]!.rect.w, String(field.value), measure);
        expect(controls[i]!.rect.h).toBe(lines ? Math.max(INSPECTOR_ROW_H, 6 + 12 * lines.rows) : INSPECTOR_ROW_H);
      }
      // The four layout fields take two rows or more each.
      expect(controls.slice(2).every((control) => control.rect.h >= 30)).toBe(true);
    }
  });
});
