// Presentational event inspector. Pointer presses are intentionally handled
// by engine/event-layout.ts; PocketJS views have no DOM click handlers.

import { Text, View } from "@pocketjs/framework/components";
import { createMemo, For, Show } from "solid-js";
import type { Condition, GameEvent, Page } from "../../src/engine/types.ts";
import { isEditableCondition } from "../engine/commands.ts";
import { conditionFields } from "../engine/event-fields.ts";
import {
  EMPTY_EVENT_EDITOR_RESOURCES,
  type EventEditorResources,
} from "../engine/event-resources.ts";
import {
  createEventInspectorLayout,
  inspectorControlFullyVisible,
  inspectorActionKey,
  inspectorCommandFields,
  inspectorCommandOp,
  type EventInspectorAction,
  type EventInspectorLayout,
  type InspectorCommandRow,
  type InspectorConditionRow,
  type InspectorControl,
  type InspectorField,
  type InspectorRect,
  type InspectorRowGeometry,
  type InspectorScrollOffsets,
} from "../engine/event-layout.ts";
import { editorTextWidth, fitEditorText } from "./text-fit.ts";

export type {
  EventInspectorAction,
  EventInspectorLayout,
  InspectorCommandRow,
  InspectorConditionRow,
  InspectorField,
  InspectorScrollOffsets,
} from "../engine/event-layout.ts";

const BG = "#10141d";
const HEADER = "#172033";
const PANEL = "#1b2433";
const ROW = "#202b3d";
const CONTROL = "#2c3a52";
const SELECTED = "#3d506e";
const INK = "#e6e9f0";
const DIM = "#9aa4b8";
const ACCENT = "#ffd24a";
const BRANCH = "#60a5fa";
const READ_ONLY = "#8d3d52";
const READ_ONLY_BADGE_W = 76;

/** Friendly names for screen-presentation commands in the editable rows. */
const SCREEN_COMMAND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  screenFade: "screen fade",
  screenTint: "screen tint",
  screenFlash: "screen flash",
  screenShake: "screen shake",
  camera: "camera",
  scrollMap: "scroll map",
  balloon: "balloon",
  screenBackdrop: "screen backdrop",
  showPicture: "show picture",
  movePicture: "move picture",
  rotatePicture: "rotate picture",
  tintPicture: "tint picture",
  erasePicture: "erase picture",
  mapNameDisplay: "map name display",
  changeParallax: "change parallax",
  autosave: "autosave / 自动存档",
});

function commandLabel(row: InspectorCommandRow): string {
  const op = inspectorCommandOp(row);
  return SCREEN_COMMAND_LABELS[op] ?? op;
}

export interface EventInspectorSelection {
  condition: number | null;
  command: number | null;
}

export interface EventInspectorProps {
  width: number;
  height: number;
  event: GameEvent;
  /** Zero-based page index. */
  activePage: number;
  /** Rows already flattened by the command-tree model. */
  commandRows: readonly InspectorCommandRow[];
  /** Rows already flattened with the active project's resource hints. */
  conditionRows: readonly InspectorConditionRow[];
  selection: EventInspectorSelection;
  /** An action object or inspectorActionKey(action). */
  focus: EventInspectorAction | string | null;
  inputBuffer: string;
  scroll: InspectorScrollOffsets;
  notice?: { kind: "info" | "good" | "bad"; text: string };
}

function stringValue(value: unknown): string {
  if (value === null) return "NONE";
  if (value === true) return "YES";
  if (value === false) return "NO";
  if (typeof value === "string") return value.length === 0 ? "(EMPTY)" : value;
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "?";
  }
}

function localRect(r: InspectorRect, clip: InspectorRect): InspectorRect {
  return { x: r.x - clip.x, y: r.y - clip.y, w: r.w, h: r.h };
}

function field(key: string, label: string, value: InspectorField["value"], readOnly = false): InspectorField {
  return { key, label, value, readOnly };
}

function conditionDetail(
  condition: Condition,
  resources: EventEditorResources,
): { fields: InspectorField[]; readOnly: boolean } {
  return { fields: conditionFields(condition, "", resources), readOnly: !isEditableCondition(condition) };
}

/** Turn both v1 flat clauses and `all` clauses into one visible ordered list.
 * Source metadata lets the app map a selected row back to its authored slot. */
export function flattenInspectorConditions(
  page: Page | undefined,
  resources: EventEditorResources = EMPTY_EVENT_EDITOR_RESOURCES,
): InspectorConditionRow[] {
  const condition = page?.condition;
  if (!condition) return [];
  const rows: InspectorConditionRow[] = [];
  if (condition.switch !== undefined) {
    rows.push({
      key: "flat:switch",
      kind: "switch",
      summary: `${condition.switch} ON`,
      source: { kind: "flat", key: "switch" },
      fields: [field("id", "ID", condition.switch)],
    });
  }
  if (condition.selfSwitch !== undefined) {
    rows.push({
      key: "flat:selfSwitch",
      kind: "self switch",
      summary: `${condition.selfSwitch} ON`,
      source: { kind: "flat", key: "selfSwitch" },
      fields: [field("key", "KEY", condition.selfSwitch)],
    });
  }
  if (condition.variable !== undefined) {
    rows.push({
      key: "flat:variable",
      kind: "variable",
      summary: `${condition.variable.id} ${condition.variable.op} ${condition.variable.value}`,
      source: { kind: "flat", key: "variable" },
      fields: [
        field("id", "ID", condition.variable.id),
        field("op", "OP", condition.variable.op),
        field("value", "VALUE", condition.variable.value),
      ],
    });
  }
  if (condition.item !== undefined) {
    rows.push({
      key: "flat:item",
      kind: "item",
      summary: condition.item,
      source: { kind: "flat", key: "item" },
      fields: [field("id", "ITEM", condition.item)],
    });
  }
  for (let index = 0; index < (condition.all?.length ?? 0); index++) {
    const clause = condition.all![index]!;
    const detail = conditionDetail(clause, resources);
    rows.push({
      key: `all:${index}`,
      kind: clause.kind,
      summary: conditionSummary(clause),
      source: { kind: "all", index },
      fields: detail.fields,
      readOnly: detail.readOnly,
    });
  }
  return rows;
}

function conditionSummary(condition: Condition): string {
  switch (condition.kind) {
    case "switch": return `${condition.id}=${condition.value ?? true}`;
    case "variable": return `${condition.id} ${condition.op} ${condition.value}`;
    case "selfSwitch": return `${condition.key}=${condition.value ?? true}`;
    case "item": return `${condition.id} x${condition.count}`;
    case "gold": return `gold >= ${condition.amount}`;
    case "facing": return condition.dir;
    case "worldIdle": return condition.negate ? "world busy" : "world idle";
    case "bgmPlaying": {
      const target = condition.id === undefined ? "Any BGM" : `BGM ${condition.id}`;
      return `${target} is ${condition.negate ? "not " : ""}playing`;
    }
    case "timer": return `timer ${condition.op} ${condition.seconds}s`;
    case "ext": return condition.call;
    case "appearance": return `appearance ${condition.sprite ?? "default"}`;
    case "tileProperty": return `tile (${condition.x}, ${condition.y})`;
    case "region": return `region ${condition.id} at (${condition.x}, ${condition.y})`;
  }
}

function isFocused(
  focus: EventInspectorProps["focus"],
  action: EventInspectorAction,
): boolean {
  const key = typeof focus === "string" ? focus : inspectorActionKey(focus);
  return key !== "" && key === inspectorActionKey(action);
}

function DisplayControl(props: {
  control: InspectorControl;
  value?: unknown;
  selected?: boolean;
  focused?: boolean;
  readOnly?: boolean;
  rect?: InspectorRect;
  debugName?: string;
}): JSX.Element {
  const r = () => props.rect ?? props.control.rect;
  const text = () => {
    const value = props.value === undefined ? "" : ` ${stringValue(props.value)}`;
    return fitEditorText(`${props.control.label}${value}`, Math.max(0, r().w - 6));
  };
  return (
    <View
      class="absolute flex-row items-center"
      style={{
        posType: 1,
        insetL: r().x,
        insetT: r().y,
        width: r().w,
        height: r().h,
        bgColor: props.readOnly ? "#332330" : props.selected ? SELECTED : CONTROL,
        borderWidth: props.focused ? 1 : 0,
        borderColor: ACCENT,
        overflow: 1,
      }}
      debugName={props.debugName}
    >
      <Text
        class="text-xs absolute"
        style={{ posType: 1, insetL: 3, insetT: 3, height: 12, lineHeight: 12, textColor: props.readOnly ? DIM : INK }}
      >
        {text()}
      </Text>
    </View>
  );
}

function ReadOnlyBadge(props: { x: number; y: number }): JSX.Element {
  return (
    <View
      class="absolute flex-row items-center justify-center"
      style={{ posType: 1, insetL: props.x, insetT: props.y, width: READ_ONLY_BADGE_W, height: 14, bgColor: READ_ONLY }}
    >
      <Text class="text-xs" style={{ height: 10, lineHeight: 10, textColor: INK }}>
        READ ONLY
      </Text>
    </View>
  );
}

function SectionTitle(props: { text: string; x: number; y: number; width: number }): JSX.Element {
  return (
    <Text
      class="text-xs absolute"
      style={{ posType: 1, insetL: props.x, insetT: props.y, width: props.width, height: 12, lineHeight: 12, textColor: DIM }}
    >
      {props.text}
    </Text>
  );
}

function valueForEvent(event: GameEvent, fieldName: string): unknown {
  switch (fieldName) {
    case "name": return event.name ?? event.id;
    case "x": return event.x;
    case "y": return event.y;
    case "w": return event.w ?? 1;
    case "h": return event.h ?? 1;
    default: return "";
  }
}

function valueForPage(page: Page | undefined, fieldName: string): unknown {
  switch (fieldName) {
    case "trigger": return page?.trigger ?? "action";
    case "sprite": return page?.sprite ?? "NONE";
    case "direction": return page?.dir ?? "down";
    case "moveType": return page?.moveType ?? "static";
    case "blocks": return page?.blocks ?? false;
    default: return "";
  }
}

function valueForRoute(page: Page | undefined, fieldName: string): unknown {
  switch (fieldName) {
    case "enabled": return page?.moveRoute ? `${page.moveRoute.steps.length} STEPS` : "OFF";
    case "repeat": return page?.moveRoute?.repeat ?? false;
    case "skippable": return page?.moveRoute?.skippable ?? false;
    case "steps": return page?.moveRoute?.steps.map((step) => typeof step === "string" ? step : JSON.stringify(step)).join(",") ?? "";
    default: return "";
  }
}

/** Header prompt for the two add flows, kept exported so an input controller
 * can mirror the exact prompt in accessibility/status output if desired. */
export function inspectorEditPrompt(
  focus: EventInspectorProps["focus"],
  inputBuffer: string,
): string | null {
  const key = typeof focus === "string" ? focus : inspectorActionKey(focus);
  if (key === "command-action:add") return `ADD OP OR OP@BRANCH: ${inputBuffer}_`;
  if (key === "condition-action:add") return `ADD CONDITION KIND: ${inputBuffer}_`;
  return null;
}

function RowList(props: {
  kind: "condition" | "command";
  clip: InspectorRect;
  geometry: readonly InspectorRowGeometry[];
  conditions: readonly InspectorConditionRow[];
  commands: readonly InspectorCommandRow[];
  selected: number | null;
  focus: EventInspectorProps["focus"];
  inputBuffer: string;
}): JSX.Element {
  // Draw only complete text/control lines. The group background may meet a
  // clip edge, but PocketJS never leaves a misleading half-line of glyphs.
  const visibleRows = () => props.geometry.filter((row) =>
    inspectorControlFullyVisible(row.header, props.clip)
    || row.fields.some((field) => inspectorControlFullyVisible(field, props.clip))
  );
  return (
    <View
      class="absolute"
      style={{
        posType: 1,
        insetL: props.clip.x,
        insetT: props.clip.y,
        width: props.clip.w,
        height: props.clip.h,
        bgColor: PANEL,
        overflow: 1,
      }}
      debugName={`event-inspector-${props.kind}-list`}
    >
      <For each={visibleRows()}>
        {(rowGeom) => {
          const command = () => props.commands[rowGeom.row];
          const condition = () => props.conditions[rowGeom.row];
          const branch = () => command()?.branchLabel ?? command()?.branch;
          const headerText = () => props.kind === "condition"
            ? `${condition()?.kind ?? "?"}: ${condition()?.summary ?? ""}`
            : `${branch() ? `${branch()} › ` : ""}${command() ? commandLabel(command()!) : "?"}: ${command()?.summary ?? ""}`;
          const headerRect = () => localRect(rowGeom.header.rect, props.clip);
          return (
            <>
              <View
                class="absolute"
                style={{
                  posType: 1,
                  insetL: rowGeom.rect.x - props.clip.x,
                  insetT: rowGeom.rect.y - props.clip.y,
                  width: rowGeom.rect.w,
                  height: rowGeom.rect.h,
                  bgColor: props.selected === rowGeom.row ? SELECTED : ROW,
                }}
              />
              <Show when={inspectorControlFullyVisible(rowGeom.header, props.clip)}>
                <View
                  class="absolute flex-row items-center"
                  style={{
                    posType: 1,
                    insetL: headerRect().x,
                    insetT: headerRect().y,
                    width: headerRect().w,
                    height: headerRect().h,
                    bgColor: props.selected === rowGeom.row ? SELECTED : ROW,
                    borderWidth: isFocused(props.focus, rowGeom.header.action) ? 1 : 0,
                    borderColor: ACCENT,
                    overflow: 1,
                  }}
                  debugName={`event-inspector-${props.kind}-${rowGeom.row}`}
                >
                  <Text
                    class="text-xs absolute"
                    style={{
                      posType: 1,
                      insetL: 3,
                      insetT: 3,
                      height: 12,
                      lineHeight: 12,
                      textColor: props.kind === "command" && branch() ? BRANCH : INK,
                    }}
                  >
                    {fitEditorText(
                      headerText(),
                      Math.max(0, headerRect().w - (rowGeom.pick ? 44 : rowGeom.readOnly ? READ_ONLY_BADGE_W + 6 : 6)),
                    )}
                  </Text>
                  {rowGeom.readOnly ? <ReadOnlyBadge x={Math.max(2, headerRect().w - READ_ONLY_BADGE_W - 2)} y={2} /> : null}
                </View>
              </Show>
              {rowGeom.pick && inspectorControlFullyVisible(rowGeom.pick, props.clip) ? (
                <View
                  class="absolute flex-row items-center justify-center"
                  style={{
                    posType: 1,
                    insetL: localRect(rowGeom.pick.rect, props.clip).x,
                    insetT: localRect(rowGeom.pick.rect, props.clip).y,
                    width: rowGeom.pick.rect.w,
                    height: rowGeom.pick.rect.h,
                    bgColor: isFocused(props.focus, rowGeom.pick.action) ? SELECTED : CONTROL,
                    borderWidth: isFocused(props.focus, rowGeom.pick.action) ? 1 : 0,
                    borderColor: ACCENT,
                  }}
                  debugName={`event-inspector-command-pick-${rowGeom.row}`}
                >
                  <Text class="text-xs" style={{ textColor: ACCENT, height: 12, lineHeight: 12 }}>
                    PICK
                  </Text>
                </View>
              ) : null}
              <For each={rowGeom.fields
                .map((fieldGeom, sourceIndex) => ({ fieldGeom, sourceIndex }))
                .filter(({ fieldGeom }) => inspectorControlFullyVisible(fieldGeom, props.clip))}>
                {({ fieldGeom, sourceIndex }) => {
                  const sourceField = () => props.kind === "condition"
                    ? condition()?.fields[sourceIndex]
                    : command() ? inspectorCommandFields(command()!)[sourceIndex] : undefined;
                  const focused = () => isFocused(props.focus, fieldGeom.action);
                  const shownValue = () => focused() ? `${props.inputBuffer}_` : sourceField()?.value;
                  const actionReadOnly = () => fieldGeom.action.kind === "condition-field" || fieldGeom.action.kind === "command-field"
                    ? fieldGeom.action.readOnly
                    : false;
                  return (
                    <DisplayControl
                      control={fieldGeom}
                      rect={localRect(fieldGeom.rect, props.clip)}
                      value={shownValue()}
                      focused={focused()}
                      readOnly={actionReadOnly()}
                      debugName={`event-inspector-${props.kind}-${rowGeom.row}-field-${sourceField()?.key ?? sourceIndex}`}
                    />
                  );
                }}
              </For>
            </>
          );
        }}
      </For>
    </View>
  );
}

/** Complete inspector view. It is deliberately a projection of props: all
 * mutations, pointer dispatch and keyboard editing live in the app/model. */
export function EventInspector(props: EventInspectorProps): JSX.Element {
  const activePage = createMemo(() => props.event.pages[props.activePage]);
  const layout = createMemo(() => createEventInspectorLayout({
    width: props.width,
    height: props.height,
    pageCount: props.event.pages.length,
    activePage: props.activePage,
    conditions: props.conditionRows,
    commands: props.commandRows,
    scroll: props.scroll,
  }));
  const focused = (action: EventInspectorAction) => isFocused(props.focus, action);
  const buffered = (action: EventInspectorAction, value: unknown) => focused(action) ? `${props.inputBuffer}_` : value;
  const editPrompt = createMemo(() => inspectorEditPrompt(props.focus, props.inputBuffer));
  const headerMessage = createMemo(() => {
    if (props.notice?.kind === "bad") return props.notice.text;
    return editPrompt() ?? (props.focus && props.notice?.text ? props.notice.text : `EVENT ${props.event.id}`);
  });
  const headerColor = createMemo(() => props.notice?.kind === "bad" ? "#ff7b8b" : editPrompt() || props.focus ? ACCENT : INK);

  return (
    <View
      class="w-full h-full overflow-hidden"
      style={{ bgColor: BG }}
      debugName="event-inspector"
    >
      <View
        class="absolute"
        style={{ posType: 1, insetL: 0, insetT: 0, width: props.width, height: 24, bgColor: HEADER }}
      />
      <DisplayControl
        control={layout().close}
        focused={focused(layout().close.action)}
        debugName="event-inspector-back"
      />
      <Text
        class="text-xs absolute"
        style={{ posType: 1, insetL: 58, insetT: 6, width: Math.max(0, props.width - 64), height: 12, lineHeight: 12, textColor: headerColor() }}
        debugName="event-inspector-edit-prompt"
      >
        {fitEditorText(headerMessage(), Math.max(0, props.width - 64))}
      </Text>

      <For each={layout().eventFields}>
        {(c) => c.action.kind === "event-field" ? (
          <DisplayControl
            control={c}
            value={buffered(c.action, valueForEvent(props.event, c.action.field))}
            focused={focused(c.action)}
            debugName={`event-inspector-event-${c.action.field}`}
          />
        ) : null}
      </For>

      <For each={layout().pageActions}>
        {(c) => <DisplayControl control={c} focused={focused(c.action)} debugName={`event-inspector-${inspectorActionKey(c.action)}`} />}
      </For>
      <For each={layout().pageTabs}>
        {(c) => c.action.kind === "page-select" ? (
          <DisplayControl
            control={c}
            selected={c.action.page === props.activePage}
            focused={focused(c.action)}
            debugName={`event-inspector-page-${c.action.page}`}
          />
        ) : null}
      </For>

      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: 0,
          insetT: layout().bodyTop,
          width: layout().leftWidth,
          height: props.height - layout().bodyTop,
          bgColor: PANEL,
        }}
      />
      <For each={layout().pageFields}>
        {(c) => c.action.kind === "page-field" ? (
          <DisplayControl
            control={c}
            value={buffered(c.action, valueForPage(activePage(), c.action.field))}
            focused={focused(c.action)}
            debugName={`event-inspector-page-field-${c.action.field}`}
          />
        ) : null}
      </For>
      <For each={layout().routeFields}>
        {(c) => c.action.kind === "route-field" ? (
          <DisplayControl
            control={c}
            value={buffered(c.action, valueForRoute(activePage(), c.action.field))}
            focused={focused(c.action)}
            debugName={`event-inspector-route-${c.action.field}`}
          />
        ) : null}
      </For>

      <SectionTitle
        text="CONDITIONS (ALL)"
        x={4}
        y={layout().conditionActions[0]!.rect.y + 4}
        width={layout().leftWidth - 68}
      />
      <For each={layout().conditionActions}>
        {(c) => <DisplayControl control={c} focused={focused(c.action)} debugName={`event-inspector-${inspectorActionKey(c.action)}`} />}
      </For>
      <RowList
        kind="condition"
        clip={layout().conditionClip}
        geometry={layout().conditionRows}
        conditions={props.conditionRows}
        commands={[]}
        selected={props.selection.condition}
        focus={props.focus}
        inputBuffer={props.inputBuffer}
      />

      <View
        class="absolute"
        style={{
          posType: 1,
          insetL: layout().leftWidth,
          insetT: layout().bodyTop,
          width: 2,
          height: props.height - layout().bodyTop,
          bgColor: "#080b10",
        }}
      />
      <SectionTitle
        text={editorTextWidth("COMMANDS") <= Math.max(20, layout().commandActions[0]!.rect.x - layout().leftWidth - 10) ? "COMMANDS" : "CMD"}
        x={layout().leftWidth + 6}
        y={layout().bodyTop + 7}
        width={Math.max(20, layout().commandActions[0]!.rect.x - layout().leftWidth - 10)}
      />
      <For each={layout().commandActions}>
        {(c) => <DisplayControl control={c} focused={focused(c.action)} debugName={`event-inspector-${inspectorActionKey(c.action)}`} />}
      </For>
      <RowList
        kind="command"
        clip={layout().commandClip}
        geometry={layout().commandRows}
        conditions={[]}
        commands={props.commandRows}
        selected={props.selection.command}
        focus={props.focus}
        inputBuffer={props.inputBuffer}
      />
    </View>
  );
}
