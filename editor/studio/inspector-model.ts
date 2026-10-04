// editor/studio/inspector-model.ts — DOM-free logic behind Studio's
// inspector: command categories, the visible command tree, insertion
// targets, and the protocol operation lists for page/command/event
// reordering and copying. Every document change is described here as a
// SessionOperation list; the inspector hands it to StudioApp.run() or
// StudioApp.transaction(), so nothing here edits JSON in place.

import type { Command, GameEvent, MapDef, Page, Project } from "../../src/engine/types.ts";
import type { EditSession, SessionOperation } from "../api/session.ts";
import {
  battleBranchPath,
  choiceBranchPath,
  commandAddressKey,
  commandPathKey,
  commandSummary,
  defaultCommand,
  EDITABLE_COMMAND_OPS,
  getCommand,
  getCommandList,
  ifBranchPath,
  loopBodyPath,
  pathAfterDelete,
  sceneBranchPath,
  type CommandAddress,
  type CommandListPath,
  type ConditionKind,
  type EditableCommandOp,
  type PageConditionClause,
} from "../engine/commands.ts";
import type { ConditionSource, EditableField } from "../engine/event-fields.ts";
import { eventEditorResources, type EventEditorResources } from "../engine/event-resources.ts";
import { uniqueEventId } from "../engine/model.ts";

// ---- command categories ---------------------------------------------------------

export type CommandCategory = "flow" | "message" | "state" | "move" | "present" | "audio" | "other";

export const COMMAND_CATEGORIES: readonly CommandCategory[] = ["flow", "message", "state", "move", "present", "audio", "other"];

const CATEGORY_OF: Readonly<Record<string, CommandCategory>> = {
  if: "flow",
  battle: "flow",
  scene: "flow",
  loop: "flow",
  break: "flow",
  wait: "flow",
  exit: "flow",
  erase: "flow",
  common: "flow",
  lockInput: "flow",
  unlockInput: "flow",
  openMenu: "flow",
  openSave: "flow",
  autosave: "flow",
  gameOver: "flow",
  returnTitle: "flow",
  label: "flow",
  jumpLabel: "flow",
  text: "message",
  choices: "message",
  balloon: "message",
  inputNumber: "message",
  selectItem: "message",
  switch: "state",
  variable: "state",
  selfSwitch: "state",
  item: "state",
  gold: "state",
  shop: "state",
  tileProperty: "state",
  timer: "state",
  changeName: "state",
  menuAccess: "state",
  saveAccess: "state",
  locationInfo: "state",
  moveRoute: "move",
  transfer: "move",
  moveControl: "move",
  place: "move",
  pathTo: "move",
  approach: "move",
  screenFade: "present",
  screenTint: "present",
  screenFlash: "present",
  screenShake: "present",
  screenBackdrop: "present",
  camera: "present",
  scrollMap: "present",
  showPicture: "present",
  movePicture: "present",
  rotatePicture: "present",
  tintPicture: "present",
  erasePicture: "present",
  mapNameDisplay: "present",
  mapAnim: "present",
  stopAnim: "present",
  appearance: "present",
  layer: "present",
  changeParallax: "present",
  se: "audio",
  playBgm: "audio",
  fadeoutBgm: "audio",
  stopBgm: "audio",
  pauseBgm: "audio",
  resumeBgm: "audio",
  playBgs: "audio",
  fadeoutBgs: "audio",
  playMe: "audio",
  playSe: "audio",
  stopSe: "audio",
  saveBgm: "audio",
  replayBgm: "audio",
};

/** Colour-bar category of a command op (unknown and extension ops: other). */
export function commandCategory(op: unknown): CommandCategory {
  return typeof op === "string" && Object.hasOwn(CATEGORY_OF, op) ? CATEGORY_OF[op]! : "other";
}

const OP_LABELS: Readonly<Record<string, string>> = {
  if: "If",
  se: "Sound effect",
  playBgm: "Play BGM",
  fadeoutBgm: "Fade out BGM",
  stopBgm: "Stop BGM",
  pauseBgm: "Pause BGM",
  resumeBgm: "Resume BGM",
  playBgs: "Play BGS",
  fadeoutBgs: "Fade out BGS",
  playMe: "Play ME",
  playSe: "Play SE",
  saveBgm: "Save BGM",
  replayBgm: "Replay BGM",
  selfSwitch: "Self switch",
  ext: "Extension call",
  extChoice: "Extension choice",
  common: "Common event",
  mapAnim: "Map animation",
  stopAnim: "Stop animation",
  break: "Break loop",
  label: "Label",
  jumpLabel: "Jump to label",
  inputNumber: "Input number",
  selectItem: "Select item",
  openMenu: "Open menu screen",
  openSave: "Open save screen",
  autosave: "Autosave / 自动存档",
  gameOver: "Game over",
  returnTitle: "Return to title screen",
  mapNameDisplay: "Map name display",
  menuAccess: "Menu access",
  saveAccess: "Save access",
  locationInfo: "Get location info",
  stopSe: "Stop SE",
  changeParallax: "Change parallax",
};

/** "screenFade" → "Screen fade". */
export function opLabel(op: string): string {
  if (Object.hasOwn(OP_LABELS, op)) return OP_LABELS[op]!;
  const words = op.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "MOVE TYPE" → "Move type" (field labels are authored upper case). */
export function fieldLabel(label: string): string {
  const lower = label.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---- command picker -------------------------------------------------------------

export interface PickerEntry {
  op: EditableCommandOp;
  label: string;
  /** One-line description: the summary of the op's default command. */
  description: string;
  category: CommandCategory;
}

export const PICKER_ENTRIES: readonly PickerEntry[] = EDITABLE_COMMAND_OPS.map((op) => ({
  op,
  label: opLabel(op),
  description: commandSummary(defaultCommand(op)),
  category: commandCategory(op),
}));

/** Filter picker entries by a free-text query over op, label, description
 * and category. Ops whose name or label starts with the query rank first. */
export function filterPickerEntries(query: string, entries: readonly PickerEntry[] = PICKER_ENTRIES): PickerEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  const scored: { entry: PickerEntry; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const op = entry.op.toLowerCase();
    const label = entry.label.toLowerCase();
    let score = -1;
    if (op === q) score = 0;
    else if (op.startsWith(q) || label.startsWith(q)) score = 1;
    else if (op.includes(q) || label.includes(q)) score = 2;
    else if (entry.description.toLowerCase().includes(q) || entry.category.includes(q)) score = 3;
    if (score >= 0) scored.push({ entry, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((item) => item.entry);
}

// ---- branches -------------------------------------------------------------------

export interface BranchTarget {
  /** Stable key: then, else, option1…, cancel, win, lose, escape, done, body. */
  key: string;
  label: string;
  path: CommandListPath;
  /** False for an optional branch that is not authored yet; inserting into
   * it materializes the branch. */
  present: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every child list of `command` (at `address`) a command can be inserted
 * into, mirroring the PocketJS inspector's op@branch targets. */
export function commandBranchTargets(command: Command, address: CommandAddress): BranchTarget[] {
  const value = command as Command & Record<string, unknown>;
  switch (value.op) {
    case "if":
      return [
        { key: "then", label: "Then", path: ifBranchPath(address, "then"), present: true },
        { key: "else", label: "Else", path: ifBranchPath(address, "else"), present: Array.isArray(value.else) },
      ];
    case "choices": {
      const options = Array.isArray(value.options) ? value.options : [];
      const targets: BranchTarget[] = options.map((option, index) => ({
        key: `option${index + 1}`,
        label: `Option ${index + 1}${isRecord(option) && typeof option.text === "string" && option.text ? `: ${option.text}` : ""}`,
        path: choiceBranchPath(address, index),
        present: true,
      }));
      targets.push({
        key: "cancel",
        label: "Cancel",
        path: choiceBranchPath(address, "cancel"),
        present: isRecord(value.cancel) && Array.isArray(value.cancel.commands),
      });
      return targets;
    }
    case "battle":
      return ([["win", "onWin", "Win"], ["escape", "onEscape", "Escape"], ["lose", "onLose", "Lose"]] as const).map(
        ([key, property, label]) => ({ key, label, path: battleBranchPath(address, key), present: Array.isArray(value[property]) }),
      );
    case "scene":
      return ([["done", "onDone", "Done"], ["cancel", "onCancel", "Cancel"]] as const).map(
        ([key, property, label]) => ({ key, label, path: sceneBranchPath(address, key), present: Array.isArray(value[property]) }),
      );
    case "loop":
      return [{ key: "body", label: "Loop body", path: loopBodyPath(address), present: true }];
    default:
      return [];
  }
}

/** Where a new command goes: after `selected` in its own list, at the end of
 * a named branch of `selected`, or at the end of the root list. */
export function insertionAddress(
  commands: readonly Command[],
  selected: CommandAddress | undefined,
  branch?: string,
): CommandAddress | null {
  if (!selected || !getCommand(commands, selected)) return { path: [], index: commands.length };
  if (branch === undefined || branch === "after") return { path: selected.path, index: selected.index + 1 };
  const target = commandBranchTargets(getCommand(commands, selected)!, selected).find((item) => item.key === branch);
  if (!target) return null;
  const list = getCommandList(commands, target.path);
  return list ? { path: target.path, index: list.length } : null;
}

// ---- visible tree ---------------------------------------------------------------

export type TreeItem<Row> =
  | { kind: "command"; key: string; row: Row; depth: number; hasChildren: boolean; collapsed: boolean }
  | { kind: "branch"; key: string; label: string; depth: number; path: CommandListPath; empty: boolean };

/** Interleave branch header rows with flattened command rows, hiding the
 * descendants of collapsed commands. `rows` come from flattenCommands or
 * commandInspectorRows over the same `commands`. */
export function commandTreeItems<Row extends { key: string; address: CommandAddress; command: Command }>(
  commands: readonly Command[],
  rows: readonly Row[],
  isCollapsed: (key: string) => boolean = () => false,
): TreeItem<Row>[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const items: TreeItem<Row>[] = [];
  const walk = (path: CommandListPath, depth: number): void => {
    const list = getCommandList(commands, path) ?? [];
    for (let index = 0; index < list.length; index++) {
      const key = commandAddressKey({ path, index });
      const row = byKey.get(key);
      if (!row) continue;
      const branches = commandBranchTargets(row.command, row.address).filter((branch) => branch.present);
      const collapsed = branches.length > 0 && isCollapsed(key);
      items.push({ kind: "command", key, row, depth, hasChildren: branches.length > 0, collapsed });
      if (collapsed) continue;
      for (const branch of branches) {
        const children = getCommandList(commands, branch.path) ?? [];
        items.push({ kind: "branch", key: `${key}>${branch.key}`, label: branch.label, depth: depth + 1, path: branch.path, empty: children.length === 0 });
        walk(branch.path, depth + 1);
      }
    }
  };
  walk([], 0);
  return items;
}

// ---- command operations ---------------------------------------------------------

export interface PageRef {
  map: string;
  event: string;
  page: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function insertCommandOp(ref: PageRef, address: CommandAddress, command: unknown): SessionOperation {
  return { command: "insert-command", args: { ...ref, address, command: clone(command) } };
}

export function deleteCommandOp(ref: PageRef, address: CommandAddress): SessionOperation {
  return { command: "delete-command", args: { ...ref, address } };
}

/** Delete + reinsert one slot up (-1) or down (+1) in the same list; null
 * when the command is already at that edge. */
export function commandMoveOps(
  ref: PageRef,
  commands: readonly Command[],
  address: CommandAddress,
  delta: -1 | 1,
): { ops: SessionOperation[]; to: CommandAddress } | null {
  const list = getCommandList(commands, address.path);
  const command = getCommand(commands, address);
  if (!list || !command) return null;
  const index = address.index + delta;
  if (index < 0 || index >= list.length) return null;
  const to: CommandAddress = { path: address.path, index };
  return { ops: [deleteCommandOp(ref, address), insertCommandOp(ref, to, command)], to };
}

/** Ops that move the command at `from` so it lands in insertion slot `slot`
 * (an address in the tree BEFORE the move: `slot.index` may equal the list's
 * length). Null when the drop changes nothing (dropping a command just
 * before or after itself) or is illegal (into its own descendants, a slot
 * that does not resolve). `to` is the command's address after the move.
 *
 * The transaction deletes first, so the insert address is rebased onto the
 * tree without the command: a later slot in the same list moves up by one,
 * and so does a branch of a later sibling (moveCommand's semantics). */
export function commandDropOps(
  ref: PageRef,
  commands: readonly Command[],
  from: CommandAddress,
  slot: CommandAddress,
): { ops: SessionOperation[]; to: CommandAddress } | null {
  const command = getCommand(commands, from);
  const list = getCommandList(commands, slot.path);
  if (!command || !list || !Number.isInteger(slot.index) || slot.index < 0 || slot.index > list.length) return null;
  const path = pathAfterDelete(slot.path, from);
  if (!path) return null;
  let index = slot.index;
  if (commandPathKey(slot.path) === commandPathKey(from.path)) {
    if (index === from.index || index === from.index + 1) return null;
    if (index > from.index) index--;
  }
  const to: CommandAddress = { path, index };
  return { ops: [deleteCommandOp(ref, from), insertCommandOp(ref, to, command)], to };
}

/** Insert a deep copy of the command immediately after it. */
export function commandCopyOp(
  ref: PageRef,
  commands: readonly Command[],
  address: CommandAddress,
): { op: SessionOperation; to: CommandAddress } | null {
  const command = getCommand(commands, address);
  if (!command) return null;
  const to: CommandAddress = { path: address.path, index: address.index + 1 };
  return { op: insertCommandOp(ref, to, command), to };
}

/** The command to select after deleting `address`: the next sibling (or
 * the new last one), else the parent command, else nothing. */
export function selectionAfterDelete(commands: readonly Command[], address: CommandAddress): CommandAddress | undefined {
  const list = getCommandList(commands, address.path);
  if (list && list.length > 1) return { path: address.path, index: Math.min(address.index, list.length - 2) };
  const parent = address.path.at(-1);
  return parent ? { path: address.path.slice(0, -1), index: parent.index } : undefined;
}

/** Previous/next visible command address for keyboard navigation. */
export function adjacentCommand<Row extends { key: string; address: CommandAddress }>(
  items: readonly TreeItem<Row>[],
  current: CommandAddress | undefined,
  delta: -1 | 1,
): CommandAddress | undefined {
  const rows = items.filter((item): item is Extract<TreeItem<Row>, { kind: "command" }> => item.kind === "command");
  if (rows.length === 0) return undefined;
  const key = current ? commandAddressKey(current) : "";
  const at = rows.findIndex((item) => item.key === key);
  if (at < 0) return rows[delta > 0 ? 0 : rows.length - 1]!.row.address;
  return rows[Math.max(0, Math.min(rows.length - 1, at + delta))]!.row.address;
}

// ---- page operations ------------------------------------------------------------

export function emptyPage(): Page {
  return { trigger: "action", commands: [] };
}

export function addPageOp(map: string, event: string, index: number, page: Page = emptyPage()): SessionOperation {
  return { command: "add-page", args: { map, event, page: clone(page), index } };
}

export function pageCopyOp(map: string, event: GameEvent, page: number): SessionOperation | null {
  const source = event.pages[page];
  return source ? addPageOp(map, event.id, page + 1, source) : null;
}

export function pageDeleteOp(map: string, event: GameEvent, page: number): SessionOperation | null {
  return event.pages.length > 1 && event.pages[page] ? { command: "delete-page", args: { map, event: event.id, page } } : null;
}

/** Move page `from` to final index `to` as delete-page + add-page. */
export function pageMoveOps(map: string, event: GameEvent, from: number, to: number): SessionOperation[] | null {
  const page = event.pages[from];
  if (!page || from === to || to < 0 || to >= event.pages.length) return null;
  return [
    { command: "delete-page", args: { map, event: event.id, page: from } },
    addPageOp(map, event.id, to, page),
  ];
}

export function updatePageOp(ref: PageRef, value: Page): SessionOperation {
  return { command: "update-page", args: { ...ref, value: clone(value) } };
}

// ---- conditions -----------------------------------------------------------------

export function conditionSource(clause: PageConditionClause): ConditionSource {
  return clause.source === "all" ? { kind: "all", index: clause.index! } : { kind: "flat", key: clause.source };
}

/** Keys editPageConditionField accepts for a legacy flat clause. */
const FLAT_EDITABLE: Readonly<Record<string, readonly string[]>> = {
  switch: ["id"],
  selfSwitch: ["key"],
  item: ["id"],
  variable: ["id", "op", "value"],
};

/** Field descriptors for one clause; fields a flat (legacy) clause cannot
 * express are shown read-only, and a non-editable clause is all read-only. */
export function clauseFields(clause: PageConditionClause, fields: readonly EditableField[]): EditableField[] {
  if (clause.readOnly) return fields.map((field) => ({ ...field, readOnly: true }));
  if (clause.source === "all") return fields.slice();
  const editable = FLAT_EDITABLE[clause.source] ?? [];
  return fields.map((field) => (editable.includes(field.key) ? field : { ...field, readOnly: true }));
}

export function isConditionKind(value: string, kinds: readonly string[]): value is ConditionKind {
  return kinds.includes(value);
}

// ---- events ---------------------------------------------------------------------

/** First cell (by distance from the source, then reading order) where a
 * w×h copy fits on the map without overlapping any event; the source cell
 * when the map is full. */
export function nextFreeCell(map: Pick<MapDef, "width" | "height" | "events">, source: GameEvent): { x: number; y: number } {
  const w = Math.max(1, source.w ?? 1);
  const h = Math.max(1, source.h ?? 1);
  const occupied = new Uint8Array(map.width * map.height);
  for (const event of map.events ?? []) {
    for (let y = event.y; y < event.y + (event.h ?? 1); y++) {
      for (let x = event.x; x < event.x + (event.w ?? 1); x++) {
        if (x >= 0 && y >= 0 && x < map.width && y < map.height) occupied[y * map.width + x] = 1;
      }
    }
  }
  const fits = (px: number, py: number): boolean => {
    if (px < 0 || py < 0 || px + w > map.width || py + h > map.height) return false;
    for (let y = py; y < py + h; y++) {
      for (let x = px; x < px + w; x++) if (occupied[y * map.width + x]) return false;
    }
    return true;
  };
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = 0; y + h <= map.height; y++) {
    for (let x = 0; x + w <= map.width; x++) {
      const d = Math.abs(x - source.x) + Math.abs(y - source.y);
      if (best && d >= best.d) continue;
      if (fits(x, y)) best = { x, y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : { x: source.x, y: source.y };
}

/** add-event for a deep copy with a unique `<id>-copy` id at a free cell. */
export function eventCopyOp(map: MapDef, event: GameEvent): { op: SessionOperation; id: string } {
  const copy = clone(event);
  copy.id = uniqueEventId(map.events ?? [], `${event.id}-copy`);
  const cell = nextFreeCell(map, event);
  copy.x = cell.x;
  copy.y = cell.y;
  return { op: { command: "add-event", args: { map: map.id, event: copy } }, id: copy.id };
}

// ---- maps -----------------------------------------------------------------------

/** The `move-map` op for dragging map `id` to final position `index`. */
export function mapMoveOp(id: string, index: number): SessionOperation {
  return { command: "move-map", args: { map: id, index } };
}

// ---- map cells ------------------------------------------------------------------

export interface CellInfo {
  x: number;
  y: number;
  ground: string | null;
  upper: string | null;
  passage: "pass" | "block" | null;
}

export function cellInfo(map: MapDef, x: number, y: number): CellInfo | null {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
  const index = y * map.width + x;
  // Sparse layers: the last pair at an index wins (runtime rule).
  const upper = (map.upper ?? []).findLast(([at]) => at === index)?.[1] ?? null;
  const passage = (map.passage ?? []).findLast(([at]) => at === index)?.[1] ?? null;
  return { x, y, ground: map.ground[index] ?? null, upper, passage };
}

/** "a, b ,c" → ["a","b","c"] (empty entries dropped). */
export function parseSheetList(raw: string): string[] {
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

// ---- fields ---------------------------------------------------------------------

export type FieldControl = "select" | "checkbox" | "number" | "textarea" | "text";

export function fieldControl(field: EditableField): FieldControl {
  if (field.kind === "boolean") return "checkbox";
  if (field.kind === "enum") return "select";
  if (field.kind === "integer" || field.kind === "number") return "number";
  if (field.key === "lines" || (typeof field.value === "string" && field.value.includes("\n"))) return "textarea";
  return "text";
}

/** The editor text spelling of a field's current value. */
export function fieldText(field: EditableField): string {
  return field.value === null ? "null" : String(field.value);
}

// ---- resources ------------------------------------------------------------------

/** Resource hints for the current map. Sharded packs only parse the open
 * map, so they get a Project-like view of the globals plus that map, with
 * the map list taken from the pack's catalog. */
export function sessionResources(session: EditSession, map: MapDef): EventEditorResources {
  if (session.kind === "inline") return eventEditorResources(session.project(), map);
  const project = { ...session.globals(), maps: [map] } as Project;
  const resources = eventEditorResources(project, map);
  return { ...resources, maps: session.maps().map((item) => item.id).sort((a, b) => a.localeCompare(b)) };
}
