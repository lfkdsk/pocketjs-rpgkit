/// <reference lib="dom" />
// editor/studio/inspector.ts — Studio's right-hand inspector: map
// properties, the selected event, its pages, page conditions and the command
// tree. Every edit is one protocol operation (or one transaction) through
// StudioApp.run()/transaction(); field text is parsed and validated by the
// shared editor/engine field adapters before anything is sent, so invalid
// input shows an inline error and never reaches the document.

import type { Command, GameEvent, MapDef, Page } from "../../src/engine/types.ts";
import type { EditCommandName, EditResponse } from "../api/types.ts";
import type { SessionOperation } from "../api/session.ts";
import {
  CONDITION_KINDS,
  commandAddressKey,
  flattenCommands,
  getCommand,
  defaultCommand,
  getCommandList,
  isEditableCommand,
  pageConditionClauses,
  pageConditionSummary,
  type CommandAddress,
  type FlatCommandRow,
} from "../engine/commands.ts";
import {
  addPageCondition,
  commandFields,
  conditionFields,
  deletePageCondition,
  editCommandField,
  editPageConditionField,
  editPageField,
  editPageRouteField,
  eventGeometryValue,
  pageFieldDescriptors,
  pageRouteFieldDescriptors,
  type EditableField,
  type FieldEdit,
} from "../engine/event-fields.ts";
import type { EventEditorResources } from "../engine/event-resources.ts";
import { explainEffectsDigest, explainEvent, type EventExplanation } from "../engine/event-explain.ts";
import type { Selection, StudioApp } from "./app.ts";
import { emptyState, h, icon, replace, type Child } from "./dom.ts";
import {
  addPageOp,
  cellInfo,
  clauseFields,
  commandBranchTargets,
  commandCategory,
  commandCopyOp,
  commandDropOps,
  commandMoveOps,
  commandTreeItems,
  conditionSource,
  deleteCommandOp,
  eventCopyOp,
  fieldControl,
  fieldLabel,
  fieldText,
  filterPickerEntries,
  insertCommandOp,
  insertionAddress,
  isConditionKind,
  opLabel,
  pageCopyOp,
  pageDeleteOp,
  pageMoveOps,
  parseSheetList,
  selectionAfterDelete,
  sessionResources,
  adjacentCommand,
  updatePageOp,
  type FieldControl,
  type PageRef,
  type TreeItem,
} from "./inspector-model.ts";

export const SHARDED_MAP_NOTE =
  "Sharded packs keep their map catalog fixed: add, duplicate, delete, rename and resize maps in the inline project or with rpgkit-edit.";

/** Collapsed command keys: `${map}/${event}/${page}/${row.key}`. */
const collapsedCommands = new Set<string>();

/** Reasons that always re-render, even while an inspector input has focus. */
const STRUCTURAL_REASONS = new Set(["document", "edit", "history", "selection", "map", "load"]);
const IGNORED_REASONS = new Set(["hover", "view"]);

type CommitResult = string | null;

interface FieldSpec {
  field: string;
  label: string;
  control: FieldControl;
  value: string | boolean;
  options?: readonly string[];
  suggestions?: readonly string[];
  hint?: string;
  disabled?: boolean;
  integer?: boolean;
  min?: number;
  /** Parse and run; return an error message to show inline. */
  commit: (raw: string) => CommitResult;
}

function errorOf(response: EditResponse | undefined): CommitResult {
  if (!response) return "No document is open";
  return response.ok ? null : response.error.message;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function domId(field: string): string {
  return `ins-${field.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function focusKey(element: Element | null): string | null {
  if (!(element instanceof HTMLElement)) return null;
  const data = element.dataset;
  if (data.field) return `f:${data.field}`;
  if (data.action) return `a:${data.action}:${data.key ?? data.op ?? data.page ?? data.index ?? ""}`;
  if (data.role) return `r:${data.role}`;
  return null;
}

/** Coalesce notifications into one render after the current task, so a
 * change event fired by Tab renders after focus has moved on (and the new
 * focus can be restored). A timer rather than requestAnimationFrame keeps
 * hidden tabs and headless runs current. */
/** The summary without the op name the row already shows ("Text: hi" →
 * "hi", "If Gold ≥ 10" → "Gold ≥ 10"). */
function rowSummary(label: string, summary: string): string {
  const colon = /^[A-Za-z ]+:\s+/.exec(summary);
  if (colon) return summary.slice(colon[0].length) || summary;
  return summary.toLowerCase().startsWith(`${label.toLowerCase()} `) ? summary.slice(label.length + 1) : summary;
}

function schedule(callback: () => void): void {
  setTimeout(callback, 0);
}

/** Pixels a press on a command row moves before it becomes a drag. */
const DRAG_THRESHOLD = 4;
const DROP_CLASSES = ["drop-before", "drop-after"] as const;

/** The command tree as last rendered, for drag and drop. */
interface TreeContext {
  ref: PageRef;
  commands: readonly Command[];
  items: TreeItem<FlatCommandRow>[];
}

/** A press on a command row, and once it moves, the drop slot under the
 * pointer (an insertion address in the tree before the move). */
interface CommandDrag {
  tree: TreeContext;
  from: CommandAddress;
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  slot: CommandAddress | null;
  marked: HTMLElement | null;
}

class Inspector {
  private pending = new Set<string>();
  private scheduled = false;
  private force = false;
  private signature = "";
  private errors = new Map<string, { raw: string; error: string }>();
  private context = "";
  private confirmDeleteMap: string | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private pickerOpen = false;
  private pickerQuery = "";
  private pickerTarget = "after";
  private conditionKind: string = CONDITION_KINDS[0];
  private resourceCache: { key: string; value: EventEditorResources } | null = null;
  private sessionId = new WeakMap<object, number>();
  private sessions = 0;
  /** Scroll the selected command row into view after the next render. */
  private revealSelected = false;
  private treeContext: TreeContext | null = null;
  private commandDrag: CommandDrag | null = null;
  /** Swallow the click that ends a drag. */
  private suppressRowClick = false;

  constructor(private root: HTMLElement, private app: StudioApp) {
    root.classList.add("ins-root");
  }

  // ---- scheduling -------------------------------------------------------------

  notify(reason: string): void {
    if (IGNORED_REASONS.has(reason)) return;
    if (reason === "load") this.resetLocal();
    this.pending.add(reason);
    this.request(false);
  }

  /** Re-render on the next frame; `force` bypasses the focus/no-change skip
   * (local UI state such as inline errors changed). */
  private request(force: boolean): void {
    this.force ||= force;
    if (this.scheduled) return;
    this.scheduled = true;
    schedule(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const reasons = this.pending;
    this.pending = new Set();
    const force = this.force;
    this.force = false;
    if (!force) {
      const structural = [...reasons].some((reason) => STRUCTURAL_REASONS.has(reason));
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && this.root.contains(active) &&
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement);
      if (editing && !structural) return;
      if (this.currentSignature() === this.signature && !reasons.has("load") && !this.app.pulse) return;
    }
    this.render();
  }

  private resetLocal(): void {
    this.errors.clear();
    this.pickerOpen = false;
    this.pickerQuery = "";
    this.pickerTarget = "after";
    this.confirmDeleteMap = null;
    this.resourceCache = null;
  }

  private currentSignature(): string {
    const session = this.app.session;
    if (!session) return "none";
    if (!this.sessionId.has(session)) this.sessionId.set(session, ++this.sessions);
    return `${this.sessionId.get(session)}|${session.revision}|${this.app.mapId}|${JSON.stringify(this.app.selection)}`;
  }

  // ---- rendering ----------------------------------------------------------------

  render(): void {
    const activeKey = focusKey(document.activeElement && this.root.contains(document.activeElement) ? document.activeElement : null);
    const active = document.activeElement;
    const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
    const scrollTop = this.root.scrollTop;
    const treeScroll = this.root.querySelector<HTMLElement>(".ins-tree")?.scrollTop ?? 0;

    this.signature = this.currentSignature();
    // The rows a highlight came from are about to be replaced.
    this.app.highlight = null;
    replace(this.root, this.content());

    this.root.scrollTop = scrollTop;
    const tree = this.root.querySelector<HTMLElement>(".ins-tree");
    if (tree) tree.scrollTop = treeScroll;
    if (activeKey) {
      const target = Array.from(this.root.querySelectorAll<HTMLElement>("[data-field],[data-action],[data-role]"))
        .find((element) => focusKey(element) === activeKey);
      if (target && !(target as HTMLButtonElement).disabled) {
        target.focus({ preventScroll: true });
        if (caret && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.value === caret.value) {
          try {
            target.setSelectionRange(caret.start, caret.end);
          } catch {
            // number inputs have no selection API
          }
        }
      }
    }
    if (this.app.pulse && this.app.selection.kind === "event") {
      this.app.pulse = false;
      this.root.querySelector(".ins-section")?.classList.add("flash");
    }
    if (this.revealSelected) {
      this.revealSelected = false;
      this.root.querySelector<HTMLElement>(".ins-row.selected")?.scrollIntoView?.({ block: "nearest" });
    }
  }

  private content(): Child {
    const session = this.app.session;
    if (!session) return emptyState("open", "Nothing to inspect", "Open or drop a project, then select a map cell or event.");
    const map = this.app.currentMap();
    if (!map) return h("div", { class: "ins-empty" }, "No map is open.");
    const selection = this.app.selection;
    if (selection.kind === "event") {
      const event = map.events?.find((item) => item.id === selection.eventId);
      if (event) return this.eventView(map, event, selection);
    }
    return this.mapView(map, selection);
  }

  private resources(map: MapDef): EventEditorResources {
    const session = this.app.session!;
    const key = `${this.sessionId.get(session)}|${session.revision}|${map.id}`;
    if (this.resourceCache?.key !== key) this.resourceCache = { key, value: sessionResources(session, map) };
    return this.resourceCache.value;
  }

  // ---- generic field ------------------------------------------------------------

  private errorKey(field: string): string {
    return `${this.context}::${field}`;
  }

  private fieldRow(spec: FieldSpec): HTMLElement {
    const id = domId(spec.field);
    const stored = this.errors.get(this.errorKey(spec.field));
    const value = stored ? stored.raw : spec.value;
    const original = typeof spec.value === "boolean" ? String(spec.value) : spec.value;
    const commit = (raw: string): void => {
      const key = this.errorKey(spec.field);
      const had = this.errors.has(key);
      if (raw === original && !had) return;
      const error = raw === original ? null : spec.commit(raw);
      if (error) this.errors.set(key, { raw, error });
      else this.errors.delete(key);
      if (error || had) this.request(true);
    };
    const common = {
      id,
      "data-field": spec.field,
      disabled: spec.disabled === true,
      "aria-invalid": stored ? "true" : undefined,
      "aria-describedby": stored ? `${id}-error` : undefined,
    };
    let control: HTMLElement;
    let datalist: HTMLElement | null = null;
    switch (spec.control) {
      case "checkbox": {
        const input = h("input", { ...common, type: "checkbox", class: "ins-switch" });
        input.checked = value === true || value === "true";
        input.addEventListener("change", () => commit(input.checked ? "true" : "false"));
        control = input;
        break;
      }
      case "select": {
        const options = [...(spec.options ?? [])];
        const current = String(value);
        if (!options.includes(current)) options.unshift(current);
        const select = h("select", { ...common, class: "ins-input" }, options.map((option) => h("option", { value: option }, option)));
        select.value = current;
        select.addEventListener("change", () => commit(select.value));
        control = select;
        break;
      }
      case "textarea": {
        const text = String(value);
        const area = h("textarea", { ...common, class: "ins-input ins-textarea", rows: String(Math.max(2, Math.min(6, text.split("\n").length))), spellcheck: "false" });
        area.value = text;
        area.addEventListener("change", () => commit(area.value));
        area.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            commit(area.value);
          } else if (event.key === "Escape") {
            area.value = String(spec.value);
            area.blur();
          }
        });
        control = area;
        break;
      }
      default: {
        const number = spec.control === "number";
        const input = h("input", {
          ...common,
          class: "ins-input",
          type: number ? "number" : "text",
          ...(number ? { step: spec.integer === false ? "any" : "1", inputmode: spec.integer === false ? "decimal" : "numeric" } : { spellcheck: "false", autocomplete: "off" }),
          ...(spec.min === undefined ? {} : { min: String(spec.min) }),
          ...(spec.suggestions?.length ? { list: `${id}-list` } : {}),
        });
        input.value = String(value);
        input.addEventListener("change", () => {
          if (number && input.validity.badInput) {
            const key = this.errorKey(spec.field);
            this.errors.set(key, { raw: String(spec.value), error: `${spec.label} must be a number` });
            this.request(true);
            return;
          }
          commit(input.value);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(input.value);
          } else if (event.key === "Escape") {
            input.value = String(spec.value);
            input.blur();
          }
        });
        if (spec.suggestions?.length) {
          datalist = h("datalist", { id: `${id}-list` }, spec.suggestions.map((option) => h("option", { value: option })));
        }
        control = input;
      }
    }
    const checkbox = spec.control === "checkbox";
    return h(
      "div",
      { class: `ins-field${checkbox ? " ins-field-check" : ""}${spec.control === "textarea" ? " ins-field-wide" : ""}${stored ? " invalid" : ""}` },
      checkbox ? [control, h("label", { for: id }, spec.label)] : [h("label", { for: id }, spec.label), control],
      datalist,
      stored ? h("div", { class: "ins-error", id: `${id}-error`, role: "alert" }, stored.error) : null,
      !stored && spec.hint ? h("div", { class: "ins-hint" }, spec.hint) : null,
    );
  }

  /** A field described by the shared editor adapters (EditableField). */
  private editableRow(prefix: string, field: EditableField, commit: (raw: string) => CommitResult, extra: Partial<FieldSpec> = {}): HTMLElement {
    const control = fieldControl(field);
    const options = field.kind === "boolean" ? undefined : field.options;
    return this.fieldRow({
      field: `${prefix}.${field.key}`,
      label: fieldLabel(field.label),
      control,
      value: control === "checkbox" ? field.value === true || field.value === "true" : fieldText(field),
      ...(control === "select" ? { options } : {}),
      ...(control === "text" && options?.length ? { suggestions: options } : {}),
      ...(field.hint ? { hint: field.hint } : {}),
      integer: field.kind !== "number",
      disabled: field.readOnly === true,
      commit,
      ...extra,
    });
  }

  private button(action: string, label: string, onClick: () => void, options: { icon?: string; disabled?: boolean; danger?: boolean; title?: string; data?: Record<string, string>; pressed?: boolean; text?: boolean } = {}): HTMLButtonElement {
    const button = h("button", {
      type: "button",
      class: `ins-button${options.danger ? " danger" : ""}${options.text === false ? " icon-only" : ""}`,
      "data-action": action,
      title: options.title ?? label,
      "aria-label": label,
      disabled: options.disabled === true,
      ...(options.pressed === undefined ? {} : { "aria-pressed": String(options.pressed) }),
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        onClick();
      },
    }, options.icon ? icon(options.icon) : null, options.text === false ? null : h("span", null, label));
    if (options.data) Object.assign(button.dataset, options.data);
    return button;
  }

  private section(title: string, actions: Child, ...body: Child[]): HTMLElement {
    return h("section", { class: "ins-section" },
      h("header", { class: "ins-section-head" }, h("h2", null, title), h("div", { class: "ins-actions" }, actions)),
      body,
    );
  }

  private run(command: EditCommandName, args: Record<string, unknown>, label: string): EditResponse | undefined {
    return this.app.run(command, args, label);
  }

  private runOp(op: SessionOperation, label: string): EditResponse | undefined {
    return this.app.run(op.command, op.args ?? {}, label);
  }

  // ---- map ----------------------------------------------------------------------

  private mapView(map: MapDef, selection: Selection): Child {
    const session = this.app.session!;
    const pack = session.kind === "pack";
    this.context = `map:${map.id}`;
    const maps = session.maps();
    const confirming = this.confirmDeleteMap === map.id;
    const actions = [
      this.button("new-map", "New map", () => this.newMap(map), { icon: "plus", disabled: pack, title: pack ? SHARDED_MAP_NOTE : "Add a new map after this one" }),
      this.button("duplicate-map", "Duplicate", () => this.duplicateMap(map), { icon: "copy", disabled: pack, title: pack ? SHARDED_MAP_NOTE : "Duplicate this map" }),
      this.button("delete-map", confirming ? "Confirm delete" : "Delete map", () => this.deleteMap(map), {
        icon: "trash",
        danger: true,
        disabled: pack || maps.length < 2,
        pressed: confirming,
        title: pack ? SHARDED_MAP_NOTE : maps.length < 2 ? "A project needs at least one map" : confirming ? "Click again to delete this map" : "Delete this map",
      }),
    ];
    const update = (changes: Record<string, unknown>, label: string): CommitResult =>
      errorOf(this.run("update-map", { map: map.id, changes }, label));
    const integerChange = (key: "width" | "height") => (raw: string): CommitResult => {
      if (!/^\d+$/.test(raw.trim())) return `${key} must be a whole number`;
      const value = Number(raw);
      if (value < 1 || value > 256) return `${key} must be between 1 and 256`;
      return update({ [key]: value }, `Resize map ${map.id}`);
    };
    const fields = h("div", { class: "ins-grid" },
      this.fieldRow({
        field: "map.id", label: "Id", control: "text", value: map.id, disabled: pack,
        commit: (raw) => {
          const id = raw.trim();
          const error = errorOf(this.run("update-map", { map: map.id, changes: { id } }, `Rename map ${map.id}`));
          if (!error) this.app.openMap(id);
          return error;
        },
      }),
      this.fieldRow({ field: "map.name", label: "Name", control: "text", value: map.name ?? "", commit: (raw) => update({ name: raw }, `Rename map ${map.id}`) }),
      this.fieldRow({ field: "map.width", label: "Width", control: "number", value: String(map.width), min: 1, disabled: pack, commit: integerChange("width") }),
      this.fieldRow({ field: "map.height", label: "Height", control: "number", value: String(map.height), min: 1, disabled: pack, commit: integerChange("height") }),
      this.fieldRow({
        field: "map.sheets", label: "Sheets", control: "text", value: (map.sheets ?? []).join(", "),
        suggestions: session.sheets().map((sheet) => sheet.id),
        hint: `Comma list. Project sheets: ${session.sheets().map((sheet) => sheet.id).join(", ") || "none"}`,
        commit: (raw) => {
          const sheets = parseSheetList(raw);
          if (sheets.length === 0) return "list at least one sheet id";
          if (sameJson(sheets, map.sheets ?? [])) return null;
          return update({ sheets }, `Map ${map.id} sheets`);
        },
      }),
    );
    const events = map.events ?? [];
    return [
      this.section("Map", actions,
        pack ? h("p", { class: "ins-note", "data-role": "pack-note" }, SHARDED_MAP_NOTE) : null,
        confirming ? h("p", { class: "ins-note warn" }, `Delete ${map.id}? Literal transfers into it stay in place. Click “Confirm delete” again to proceed.`) : null,
        fields,
      ),
      selection.kind === "cell" ? this.cellView(map, selection) : null,
      this.section(`Events (${events.length})`, null,
        events.length === 0
          ? emptyState("event", "No events on this map", "Pick the event tool (N) and click a cell to place one.", { label: "Event tool", id: "empty-event-tool", onClick: () => this.app.setTool("event") })
          : h("ul", { class: "ins-event-list" }, events.map((event) =>
            h("li", null, h("button", {
              type: "button",
              class: "ins-link",
              "data-action": "select-event",
              "data-key": event.id,
              onclick: () => this.app.select({ kind: "event", eventId: event.id, page: 0 }),
              onmouseenter: () => { this.app.highlight = event.id; this.app.emit("view"); },
              onmouseleave: () => { this.app.highlight = null; this.app.emit("view"); },
            }, h("span", { class: "ins-mono" }, event.id), event.name ? h("span", { class: "ins-muted" }, ` ${event.name}`) : null,
            h("span", { class: "ins-muted ins-right" }, `(${event.x}, ${event.y})`))))),
      ),
    ];
  }

  private cellView(map: MapDef, selection: Extract<Selection, { kind: "cell" }>): Child {
    const info = cellInfo(map, selection.x, selection.y);
    if (!info) return null;
    const size = (selection.w ?? 1) > 1 || (selection.h ?? 1) > 1 ? ` · ${selection.w ?? 1}×${selection.h ?? 1}` : "";
    const row = (label: string, value: string | null) =>
      [h("dt", null, label), h("dd", { class: "ins-mono" }, value ?? h("span", { class: "ins-muted" }, "none"))];
    return this.section(`Cell (${info.x}, ${info.y})${size}`, null,
      h("dl", { class: "ins-dl", "data-role": "cell-info" },
        row("Ground", info.ground),
        row("Upper", info.upper),
        row("Passage", info.passage === null ? null : info.passage),
      ),
    );
  }

  private newMap(map: MapDef): void {
    const response = this.run("add-map", { after: map.id }, "New map");
    if (response?.ok) this.app.openMap((response.result as MapDef).id);
  }

  private duplicateMap(map: MapDef): void {
    const response = this.run("duplicate-map", { map: map.id }, `Duplicate map ${map.id}`);
    if (response?.ok) this.app.openMap((response.result as MapDef).id);
  }

  private deleteMap(map: MapDef): void {
    if (this.confirmDeleteMap !== map.id) {
      this.confirmDeleteMap = map.id;
      if (this.confirmTimer) clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => {
        this.confirmDeleteMap = null;
        this.request(true);
      }, 5000);
      this.request(true);
      return;
    }
    this.confirmDeleteMap = null;
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    const maps = this.app.session!.maps();
    const at = maps.findIndex((item) => item.id === map.id);
    const neighbour = maps[at + 1]?.id ?? maps[at - 1]?.id;
    const response = this.run("delete-map", { map: map.id }, `Delete map ${map.id}`);
    if (response?.ok && neighbour) this.app.openMap(neighbour);
    this.request(true);
  }

  // ---- event ----------------------------------------------------------------------

  private eventView(map: MapDef, event: GameEvent, selection: Extract<Selection, { kind: "event" }>): Child {
    const pageIndex = Math.max(0, Math.min(selection.page, event.pages.length - 1));
    const page = event.pages[pageIndex]!;
    const ref: PageRef = { map: map.id, event: event.id, page: pageIndex };
    const selected = selection.command && getCommand(page.commands, selection.command) ? selection.command : undefined;
    this.context = `${map.id}/${event.id}/${pageIndex}/${selected ? commandAddressKey(selected) : ""}`;
    const resources = this.resources(map);
    return [
      this.eventSection(map, event, pageIndex),
      this.explainSection(event),
      this.pageSection(map, event, page, ref, resources),
      this.conditionSection(page, ref, resources),
      this.commandSection(page, ref, selected, resources),
    ];
  }

  /** A deterministic, human-readable summary of the selected event: its
   *  trigger, each page's condition and command order, and the state it
   *  changes. Collapsible (default open) so a long event still leaves room
   *  for the command tree. */
  private explainSection(event: GameEvent): HTMLElement {
    const key = `explain:${event.id}`;
    const collapsed = collapsedCommands.has(key);
    const explanation = explainEvent(event);
    const toggle = this.button("explain-toggle", collapsed ? "Show" : "Hide", () => {
      if (collapsedCommands.has(key)) collapsedCommands.delete(key);
      else collapsedCommands.add(key);
      this.request(true);
    }, { icon: collapsed ? "chevron" : "down", text: false, title: collapsed ? "Show the explanation" : "Hide the explanation" });
    const body: Child[] = collapsed ? [] : [
      h("p", { class: "ins-explain-line" }, h("span", { class: "ins-muted" }, "Trigger: "), explanation.trigger),
      h("p", { class: "ins-explain-line" }, h("span", { class: "ins-muted" }, "Changes: "), explainEffectsDigest(explanation)),
      ...explanation.pages.flatMap((page) => this.explainPage(page)),
    ];
    return this.section("Explain", toggle, ...body);
  }

  private explainPage(page: EventExplanation["pages"][number]): Child[] {
    const head = h("p", { class: "ins-explain-page" },
      h("span", { class: "ins-badge" }, `Page ${page.index + 1}`),
      h("span", { class: "ins-muted" }, ` · ${page.trigger} · ${page.condition} · ${page.commandCount} command${page.commandCount === 1 ? "" : "s"}`));
    if (page.steps.length === 0) return [head];
    return [
      head,
      h("ol", { class: "ins-explain-steps" }, page.steps.map((step) =>
        h("li", { style: `--depth: ${step.depth}` },
          step.branch ? h("span", { class: "ins-explain-branch" }, step.branch) : null,
          h("span", null, step.summary)))),
    ];
  }

  private eventSection(map: MapDef, event: GameEvent, pageIndex: number): HTMLElement {
    const update = (changes: Record<string, unknown>, label: string): CommitResult =>
      errorOf(this.run("update-event", { map: map.id, event: event.id, changes }, label));
    const geometry = (key: "x" | "y" | "w" | "h") => (raw: string): CommitResult => {
      if ((key === "w" || key === "h") && raw.trim() === "") return update({ [key]: null }, `Resize event ${event.id}`);
      const parsed = eventGeometryValue(raw, key);
      if (!parsed.ok) return parsed.error;
      return update({ [key]: parsed.value }, key === "x" || key === "y" ? `Move event ${event.id}` : `Resize event ${event.id}`);
    };
    const actions = [
      this.button("copy-event", "Copy", () => {
        const { op, id } = eventCopyOp(map, event);
        if (this.runOp(op, `Copy event ${event.id}`)?.ok) this.app.select({ kind: "event", eventId: id, page: pageIndex });
      }, { icon: "copy", title: "Copy this event to a free cell" }),
      this.button("delete-event", "Delete", () => {
        if (this.run("delete-event", { map: map.id, event: event.id }, `Delete event ${event.id}`)?.ok) {
          this.app.select({ kind: "cell", x: event.x, y: event.y });
        }
      }, { icon: "trash", danger: true, title: "Delete this event" }),
      this.button("close-event", "Map", () => this.app.select({ kind: "none" }), { icon: "map", title: "Back to map properties" }),
    ];
    return this.section(`Event ${event.id}`, actions,
      h("div", { class: "ins-grid" },
        this.fieldRow({
          field: "event.id", label: "Id", control: "text", value: event.id,
          commit: (raw) => {
            const id = raw.trim();
            const error = update({ id }, `Rename event ${event.id}`);
            if (!error) this.app.select({ kind: "event", eventId: id, page: pageIndex });
            return error;
          },
        }),
        this.fieldRow({ field: "event.name", label: "Name", control: "text", value: event.name ?? "", commit: (raw) => update({ name: raw === "" ? null : raw }, `Name event ${event.id}`) }),
        this.fieldRow({ field: "event.x", label: "X", control: "number", value: String(event.x), min: 0, commit: geometry("x") }),
        this.fieldRow({ field: "event.y", label: "Y", control: "number", value: String(event.y), min: 0, commit: geometry("y") }),
        this.fieldRow({ field: "event.w", label: "Width", control: "number", value: event.w === undefined ? "" : String(event.w), min: 1, hint: event.w === undefined ? "Default 1" : undefined, commit: geometry("w") }),
        this.fieldRow({ field: "event.h", label: "Height", control: "number", value: event.h === undefined ? "" : String(event.h), min: 1, hint: event.h === undefined ? "Default 1" : undefined, commit: geometry("h") }),
      ),
    );
  }

  // ---- pages --------------------------------------------------------------------

  private selectPage(event: GameEvent, page: number): void {
    this.app.select({ kind: "event", eventId: event.id, page });
  }

  private pageSection(map: MapDef, event: GameEvent, page: Page, ref: PageRef, resources: EventEditorResources): HTMLElement {
    const index = ref.page;
    const count = event.pages.length;
    const move = (to: number) => {
      const ops = pageMoveOps(map.id, event, index, to);
      if (ops && this.app.transaction(`Move page ${index + 1} of ${event.id}`, ops)?.ok) this.selectPage(event, to);
    };
    const actions = [
      this.button("add-page", "Add page", () => {
        if (this.runOp(addPageOp(map.id, event.id, count), `Add page to ${event.id}`)?.ok) this.selectPage(event, count);
      }, { icon: "plus", text: false }),
      this.button("copy-page", "Copy page", () => {
        const op = pageCopyOp(map.id, event, index);
        if (op && this.runOp(op, `Copy page ${index + 1} of ${event.id}`)?.ok) this.selectPage(event, index + 1);
      }, { icon: "copy", text: false }),
      this.button("move-page-left", "Move page left", () => move(index - 1), { icon: "up", text: false, disabled: index === 0 }),
      this.button("move-page-right", "Move page right", () => move(index + 1), { icon: "down", text: false, disabled: index >= count - 1 }),
      this.button("delete-page", "Delete page", () => {
        const op = pageDeleteOp(map.id, event, index);
        if (op && this.runOp(op, `Delete page ${index + 1} of ${event.id}`)?.ok) this.selectPage(event, Math.min(index, count - 2));
      }, { icon: "trash", text: false, danger: true, disabled: count <= 1, title: count <= 1 ? "An event keeps at least one page" : "Delete page" }),
    ];
    const tabs = h("div", { class: "ins-tabs", role: "tablist", "aria-label": "Pages" },
      event.pages.map((candidate, i) => h("button", {
        type: "button",
        role: "tab",
        class: `ins-tab${i === index ? " active" : ""}`,
        "aria-selected": String(i === index),
        "data-action": "select-page",
        "data-page": String(i),
        title: `Page ${i + 1}: ${candidate.trigger} · ${pageConditionSummary(candidate.condition)}`,
        onclick: () => this.selectPage(event, i),
      }, String(i + 1))),
    );
    const commitPage = (edit: (raw: string) => FieldEdit<Page>, label: string) => (raw: string): CommitResult => {
      const edited = edit(raw);
      if (!edited.ok) return edited.error;
      if (sameJson(edited.value, page)) return null;
      return errorOf(this.runOp(updatePageOp(ref, edited.value), label));
    };
    const routeOn = page.moveRoute !== undefined;
    const pageFields = pageFieldDescriptors(page).map((field) =>
      this.editableRow("page", field, commitPage((raw) => editPageField(page, field.key, raw), `Page ${field.key}`),
        field.key === "sprite"
          ? { suggestions: resources.sprites, hint: "Sprite id, or empty for none", value: page.sprite ?? "" }
          : {}));
    const routeFields = pageRouteFieldDescriptors(page).map((field) =>
      this.editableRow("route", field, commitPage((raw) => editPageRouteField(page, field.key, raw), `Page route ${field.key}`),
        field.key === "enabled" ? { label: "Move route" } : { disabled: !routeOn, ...(field.key === "steps" ? { hint: "Comma list, e.g. moveDown,wait,faceUp" } : {}) }));
    return this.section(`Page ${index + 1} of ${count}`, actions,
      tabs,
      h("div", { class: "ins-grid" }, pageFields),
      h("div", { class: "ins-subhead" }, "Autonomous route"),
      h("div", { class: "ins-grid" }, routeFields),
    );
  }

  // ---- conditions ---------------------------------------------------------------

  private conditionSection(page: Page, ref: PageRef, resources: EventEditorResources): HTMLElement {
    const clauses = pageConditionClauses(page.condition);
    const apply = (next: Page, label: string): CommitResult =>
      sameJson(next, page) ? null : errorOf(this.runOp(updatePageOp(ref, next), label));
    const kindSelect = h("select", {
      id: "ins-condition-kind",
      class: "ins-input",
      "data-field": "condition-kind",
      "aria-label": "Condition kind",
      onchange: (event: Event) => { this.conditionKind = (event.target as HTMLSelectElement).value; },
    }, CONDITION_KINDS.map((kind) => h("option", { value: kind }, kind)));
    kindSelect.value = this.conditionKind;
    const actions = [
      kindSelect,
      this.button("add-condition", "Add", () => {
        const kind = kindSelect.value;
        if (isConditionKind(kind, CONDITION_KINDS)) apply(addPageCondition(page, kind), `Add ${kind} condition`);
      }, { icon: "plus" }),
    ];
    return this.section(`Conditions${clauses.length ? ` (${clauses.length})` : ""}`, actions,
      clauses.length === 0
        ? h("p", { class: "ins-muted" }, "Always active (no conditions).")
        : h("ol", { class: "ins-clauses" }, clauses.map((clause, i) => {
          const source = conditionSource(clause);
          const fields = clauseFields(clause, conditionFields(clause.condition, "", resources));
          return h("li", { class: "ins-clause", "data-index": String(i) },
            h("div", { class: "ins-clause-head" },
              h("span", { class: "ins-badge" }, clause.condition.kind),
              h("span", { class: "ins-clause-summary" }, clause.summary),
              clause.source !== "all" ? h("span", { class: "ins-muted ins-small", title: "Legacy flat page gate" }, "flat") : null,
              this.button("delete-condition", "Remove condition", () => apply(deletePageCondition(page, source), "Remove condition"), {
                icon: "trash", text: false, danger: true, data: { index: String(i) },
              }),
            ),
            clause.readOnly ? h("p", { class: "ins-note" }, "This condition kind is kept as authored but cannot be edited here.") : null,
            h("div", { class: "ins-grid" }, fields.map((field) =>
              this.editableRow(`condition.${i}`, field, (raw) => {
                const edited = editPageConditionField(page, source, field.key, raw);
                return edited.ok ? apply(edited.value, "Edit condition") : edited.error;
              }))),
          );
        })),
    );
  }

  // ---- commands -----------------------------------------------------------------

  private collapseKey(ref: PageRef, key: string): string {
    return `${ref.map}/${ref.event}/${ref.page}/${key}`;
  }

  private selectCommand(ref: PageRef, address: CommandAddress | undefined): void {
    const { map: _, event, page } = ref;
    this.app.select(address ? { kind: "event", eventId: event, page, command: address } : { kind: "event", eventId: event, page });
  }

  private expandTo(ref: PageRef, address: CommandAddress): void {
    for (let depth = 0; depth < address.path.length; depth++) {
      const segment = address.path[depth]!;
      collapsedCommands.delete(this.collapseKey(ref, commandAddressKey({ path: address.path.slice(0, depth), index: segment.index })));
    }
  }

  private deleteSelected(page: Page, ref: PageRef, selected: CommandAddress): void {
    const next = selectionAfterDelete(page.commands, selected);
    if (this.runOp(deleteCommandOp(ref, selected), "Delete command")?.ok) this.selectCommand(ref, next);
  }

  private moveSelected(page: Page, ref: PageRef, selected: CommandAddress, delta: -1 | 1): void {
    const plan = commandMoveOps(ref, page.commands, selected, delta);
    if (plan && this.app.transaction(delta < 0 ? "Move command up" : "Move command down", plan.ops)?.ok) this.selectCommand(ref, plan.to);
  }

  private copySelected(page: Page, ref: PageRef, selected: CommandAddress): void {
    const plan = commandCopyOp(ref, page.commands, selected);
    if (plan && this.runOp(plan.op, "Copy command")?.ok) this.selectCommand(ref, plan.to);
  }

  private insert(page: Page, ref: PageRef, selected: CommandAddress | undefined, op: string): void {
    const address = insertionAddress(page.commands, selected, selected ? this.pickerTarget : undefined);
    if (!address) {
      this.app.notify("error", "That branch is no longer available");
      return;
    }
    const command = defaultCommand(op as Parameters<typeof defaultCommand>[0]);
    if (this.runOp(insertCommandOp(ref, address, command), `Add ${op} command`)?.ok) {
      this.pickerOpen = false;
      this.pickerQuery = "";
      this.pickerTarget = "after";
      this.expandTo(ref, address);
      this.selectCommand(ref, address);
      this.request(true);
    }
  }

  private commandSection(page: Page, ref: PageRef, selected: CommandAddress | undefined, resources: EventEditorResources): Child {
    const rows = flattenCommands(page.commands);
    const items = commandTreeItems(page.commands, rows, (key) => collapsedCommands.has(this.collapseKey(ref, key)));
    const selectedKey = selected ? commandAddressKey(selected) : "";
    const selectedList = selected ? getCommandList(page.commands, selected.path) : null;
    this.treeContext = { ref, commands: page.commands, items };
    const toolbar = [
      this.button("add-command", "Add command", () => {
        this.pickerOpen = !this.pickerOpen;
        this.pickerQuery = "";
        this.render();
        this.root.querySelector<HTMLInputElement>("[data-field='command-picker']")?.focus();
      }, { icon: "plus", pressed: this.pickerOpen }),
      this.button("copy-command", "Copy command", () => selected && this.copySelected(page, ref, selected), { icon: "copy", text: false, disabled: !selected }),
      this.button("move-command-up", "Move command up", () => selected && this.moveSelected(page, ref, selected, -1), { icon: "up", text: false, disabled: !selected || selected.index === 0 }),
      this.button("move-command-down", "Move command down", () => selected && this.moveSelected(page, ref, selected, 1), {
        icon: "down", text: false, disabled: !selected || !selectedList || selected.index >= selectedList.length - 1,
      }),
      this.button("delete-command", "Delete command", () => selected && this.deleteSelected(page, ref, selected), { icon: "trash", text: false, danger: true, disabled: !selected, title: "Delete command (Delete)" }),
    ];

    const tree = h("div", {
      class: "ins-tree",
      role: "tree",
      tabindex: "0",
      "aria-label": "Commands",
      "data-role": "command-tree",
      onpointerdown: (event: PointerEvent) => this.pressCommand(event),
      onkeydown: (event: KeyboardEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, select, textarea, button")) return;
        if ((event.key === "Delete" || event.key === "Backspace") && selected) {
          event.preventDefault();
          this.deleteSelected(page, ref, selected);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (event.altKey && selected) {
            this.moveSelected(page, ref, selected, event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          const next = adjacentCommand(items, selected, event.key === "ArrowUp" ? -1 : 1);
          this.revealSelected = true;
          if (next) this.selectCommand(ref, next);
        } else if (event.key === "Escape" && this.commandDrag?.dragging) {
          this.endCommandDrag(false);
        } else if (event.key === "Escape" && selected) {
          this.selectCommand(ref, undefined);
        }
      },
    }, items.length === 0
      ? emptyState("plus", "No commands on this page yet", "Commands run in order when the page triggers. Drag them to reorder.", {
        label: "Add command",
        id: "empty-add-command",
        onClick: () => {
          this.pickerOpen = true;
          this.pickerQuery = "";
          this.render();
          this.root.querySelector<HTMLInputElement>("[data-field='command-picker']")?.focus();
        },
      })
      : items.map((item) => this.treeRow(item, ref, selectedKey)));

    const picker = this.pickerOpen ? this.picker(page, ref, selected) : null;
    const detail = selected ? this.commandDetail(page, ref, selected, resources) : null;
    return [
      this.section(`Commands (${rows.length})`, toolbar, picker, tree),
      detail,
    ];
  }

  private treeRow(item: TreeItem<FlatCommandRow>, ref: PageRef, selectedKey: string): HTMLElement {
    const indent = `--depth:${item.depth}`;
    if (item.kind === "branch") {
      return h("div", { class: "ins-branch", style: indent, role: "presentation", "data-key": item.key },
        h("span", null, item.label),
        item.empty ? h("span", { class: "ins-muted" }, " — empty") : null,
      );
    }
    const row = item.row;
    const category = commandCategory(row.command.op);
    const isSelected = item.key === selectedKey;
    const label = opLabel(String(row.command.op));
    const toggle = item.hasChildren
      ? h("button", {
        type: "button",
        class: `ins-toggle${item.collapsed ? " collapsed" : ""}`,
        "data-action": "toggle-collapse",
        "data-key": item.key,
        "aria-label": item.collapsed ? "Expand" : "Collapse",
        "aria-expanded": String(!item.collapsed),
        tabindex: "-1",
        onmousedown: (event: MouseEvent) => event.preventDefault(),
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          const key = this.collapseKey(ref, item.key);
          if (collapsedCommands.has(key)) collapsedCommands.delete(key);
          else collapsedCommands.add(key);
          this.render();
        },
      }, icon("chevron"))
      : h("span", { class: "ins-toggle-space" });
    return h("div", {
      class: `ins-row ins-cat-${category}${isSelected ? " selected" : ""}${row.readOnly ? " readonly" : ""}`,
      style: indent,
      role: "treeitem",
      "aria-selected": String(isSelected),
      "aria-level": String(item.depth + 1),
      ...(item.hasChildren ? { "aria-expanded": String(!item.collapsed) } : {}),
      "data-action": "select-command",
      "data-key": item.key,
      "data-op": typeof row.command.op === "string" ? row.command.op : "",
      "data-category": category,
      title: `${row.summary}\nDrag to move; Alt+↑/↓ moves by one`,
      onclick: () => {
        if (this.suppressRowClick) {
          this.suppressRowClick = false;
          return;
        }
        this.selectCommand(ref, row.address);
        this.root.querySelector<HTMLElement>(".ins-tree")?.focus({ preventScroll: true });
      },
    },
    toggle,
    h("span", { class: "ins-op" }, label),
    h("span", { class: "ins-summary" }, rowSummary(label, row.summary)),
    row.readOnly ? h("span", { class: "ins-badge warn" }, "read-only") : null,
    );
  }

  // ---- command drag and drop ------------------------------------------------------

  private pressCommand(event: PointerEvent): void {
    if (event.button !== 0 || !this.treeContext) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    const key = target.closest<HTMLElement>(".ins-row")?.dataset.key;
    const item = this.treeContext.items.find((entry) => entry.kind === "command" && entry.key === key);
    if (!key || item?.kind !== "command") return;
    this.commandDrag = {
      tree: this.treeContext, from: item.row.address, key, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, dragging: false, slot: null, marked: null,
    };
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragUp);
    window.addEventListener("pointercancel", this.onDragCancel);
  }

  private onDragMove = (event: PointerEvent): void => {
    const drag = this.commandDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.dragging) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.dragging = true;
      this.root.classList.add("command-dragging");
      this.root.querySelector<HTMLElement>(`.ins-row[data-key="${CSS.escape(drag.key)}"]`)?.classList.add("dragging");
    }
    event.preventDefault();
    const drop = this.dropAt(drag, event.clientX, event.clientY);
    if (drag.marked) drag.marked.classList.remove(...DROP_CLASSES, "drop-root");
    drag.marked = drop?.element ?? null;
    drag.slot = drop && commandDropOps(drag.tree.ref, drag.tree.commands, drag.from, drop.slot) ? drop.slot : null;
    if (drop && drag.slot) drop.element.classList.add(drop.position === "before" ? "drop-before" : "drop-after", ...(drop.root ? ["drop-root"] : []));
    // Near an edge, scroll the tree, and the inspector when the tree runs
    // past the panel.
    for (const scroller of [this.root.querySelector<HTMLElement>(".ins-tree"), this.root]) {
      if (!scroller) continue;
      const rect = scroller.getBoundingClientRect();
      if (event.clientY < rect.top + 20) scroller.scrollTop -= 8;
      else if (event.clientY > rect.bottom - 20) scroller.scrollTop += 8;
    }
  };

  private onDragUp = (event: PointerEvent): void => {
    if (this.commandDrag && event.pointerId === this.commandDrag.pointerId) this.endCommandDrag(true);
  };

  private onDragCancel = (): void => this.endCommandDrag(false);

  private endCommandDrag(commit: boolean): void {
    const drag = this.commandDrag;
    this.commandDrag = null;
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragUp);
    window.removeEventListener("pointercancel", this.onDragCancel);
    if (!drag?.dragging) return;
    this.suppressRowClick = true;
    setTimeout(() => { this.suppressRowClick = false; }, 0);
    this.root.classList.remove("command-dragging");
    drag.marked?.classList.remove(...DROP_CLASSES, "drop-root");
    this.root.querySelector(".ins-row.dragging")?.classList.remove("dragging");
    if (!commit || !drag.slot) return;
    const { ref, commands } = drag.tree;
    const plan = commandDropOps(ref, commands, drag.from, drag.slot);
    if (plan && this.app.transaction("Move command", plan.ops)?.ok) {
      this.expandTo(ref, plan.to);
      this.revealSelected = true;
      this.selectCommand(ref, plan.to);
    }
  }

  /** The drop slot under the pointer and the row that shows it: the upper
   * half of a command row inserts before it, the lower half after it (or at
   * the top of its first branch when that is open), a branch header at the
   * top of that branch, and the empty space under the rows at the end of
   * the page. */
  private dropAt(drag: CommandDrag, x: number, y: number): { slot: CommandAddress; element: HTMLElement; position: "before" | "after"; root?: boolean } | null {
    const tree = this.root.querySelector<HTMLElement>(".ins-tree");
    const under = document.elementFromPoint(x, y);
    if (!tree || !under || !tree.contains(under)) return null;
    const element = under.closest<HTMLElement>(".ins-row, .ins-branch");
    const { items, commands } = drag.tree;
    if (!element) {
      const rows = tree.querySelectorAll<HTMLElement>(".ins-row, .ins-branch");
      const last = rows[rows.length - 1];
      if (!last || y < last.getBoundingClientRect().bottom) return null;
      return { slot: { path: [], index: commands.length }, element: last, position: "after", root: true };
    }
    const item = items.find((entry) => entry.key === element.dataset.key);
    if (!item) return null;
    if (item.kind === "branch") return { slot: { path: item.path, index: 0 }, element, position: "after" };
    const rect = element.getBoundingClientRect();
    const address = item.row.address;
    if (y < rect.top + rect.height / 2) return { slot: address, element, position: "before" };
    if (item.hasChildren && !item.collapsed) {
      const branch = commandBranchTargets(item.row.command, address).find((target) => target.present);
      const header = element.nextElementSibling as HTMLElement | null;
      if (branch && header?.classList.contains("ins-branch")) return { slot: { path: branch.path, index: 0 }, element: header, position: "after" };
    }
    return { slot: { path: address.path, index: address.index + 1 }, element, position: "after" };
  }

  private picker(page: Page, ref: PageRef, selected: CommandAddress | undefined): HTMLElement {
    const selectedCommand = selected ? getCommand(page.commands, selected) : null;
    const targets = selectedCommand && selected ? commandBranchTargets(selectedCommand, selected) : [];
    if (this.pickerTarget !== "after" && !targets.some((target) => target.key === this.pickerTarget)) this.pickerTarget = "after";
    const list = h("div", { class: "ins-picker-list", role: "listbox", "aria-label": "Command types" });
    const fill = (): void => {
      const entries = filterPickerEntries(this.pickerQuery);
      replace(list, entries.length === 0
        ? h("div", { class: "ins-muted ins-picker-empty" }, "No command matches.")
        : entries.map((entry) => h("button", {
          type: "button",
          role: "option",
          class: `ins-picker-item ins-cat-${entry.category}`,
          "data-op": entry.op,
          title: entry.op,
          onclick: () => this.insert(page, ref, selected, entry.op),
          onkeydown: (event: KeyboardEvent) => {
            const button = event.currentTarget as HTMLElement;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              (button.nextElementSibling as HTMLElement | null)?.focus();
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              ((button.previousElementSibling as HTMLElement | null) ?? input).focus();
            } else if (event.key === "Escape") {
              this.closePicker();
            }
          },
        }, h("span", { class: "ins-picker-op" }, entry.label), h("span", { class: "ins-picker-desc" }, entry.description))));
    };
    const input = h("input", {
      type: "search",
      id: "ins-command-picker",
      class: "ins-input",
      "data-field": "command-picker",
      placeholder: "Search commands…",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Search commands",
      oninput: () => {
        this.pickerQuery = input.value;
        fill();
      },
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const first = filterPickerEntries(this.pickerQuery)[0];
          if (first) this.insert(page, ref, selected, first.op);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          list.querySelector<HTMLElement>("button")?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.closePicker();
        }
      },
    });
    input.value = this.pickerQuery;
    fill();
    let targetRow: Child = null;
    if (targets.length > 0) {
      const select = h("select", {
        id: "ins-command-target",
        class: "ins-input",
        "data-field": "command-target",
        onchange: () => { this.pickerTarget = select.value; },
      },
      h("option", { value: "after" }, "After the selected command"),
      targets.map((target) => h("option", { value: target.key }, `Into ${target.label}${target.present ? "" : " (new)"}`)));
      select.value = this.pickerTarget;
      targetRow = h("div", { class: "ins-field" }, h("label", { for: "ins-command-target" }, "Insert"), select);
    } else {
      targetRow = h("p", { class: "ins-muted ins-small" }, selected ? "Inserts after the selected command." : "Appends to the end of the page.");
    }
    return h("div", { class: "ins-picker", role: "dialog", "aria-label": "Add command" },
      h("div", { class: "ins-picker-head" }, input, this.button("close-picker", "Close", () => this.closePicker(), { text: false, icon: "eyeOff", title: "Close (Escape)" })),
      targetRow,
      list,
    );
  }

  private closePicker(): void {
    this.pickerOpen = false;
    this.pickerQuery = "";
    this.render();
    this.root.querySelector<HTMLElement>("[data-action='add-command']")?.focus();
  }

  private commandDetail(page: Page, ref: PageRef, address: CommandAddress, resources: EventEditorResources): HTMLElement | null {
    const command = getCommand(page.commands, address);
    if (!command) return null;
    const category = commandCategory(command.op);
    const editable = isEditableCommand(command);
    const title = `${opLabel(String(command.op))}`;
    const header = h("span", { class: `ins-cat-chip ins-cat-${category}` }, category);
    if (!editable) {
      return this.section(title, header,
        h("p", { class: "ins-note" }, "This command is preserved exactly as authored, but its fields cannot be edited in Studio. You can still move, copy or delete it."),
        h("pre", { class: "ins-json", "data-role": "command-json" }, JSON.stringify(command, null, 2)),
      );
    }
    const fields: EditableField[] = commandFields(command as Command, resources);
    return this.section(title, header,
      fields.length === 0
        ? h("p", { class: "ins-muted" }, "This command has no settings.")
        : h("div", { class: "ins-grid" }, fields.map((field) =>
          this.editableRow("command", field, (raw) => {
            const edited = editCommandField(command as Command, field.key, raw);
            if (!edited.ok) return edited.error;
            if (sameJson(edited.value, command)) return null;
            return errorOf(this.run("update-command", { ...ref, address, field: field.key, value: raw }, `Edit ${command.op} ${field.key}`));
          }))),
    );
  }
}

/** Mount the inspector into `root`; it re-renders on app notifications. */
export function mountInspector(root: HTMLElement, app: StudioApp): void {
  const inspector = new Inspector(root, app);
  app.on((reason) => inspector.notify(reason));
  inspector.render();
}
