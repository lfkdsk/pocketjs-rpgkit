// Editor-only playtest helpers. This module owns the boundary between the
// mutable-looking live reducer snapshot used by GameView and the editor's
// immutable document/history model; runtime entries never import it.

import { createSwitchState, eventKey, type SelfKey, type SwitchState } from "../../src/engine/interpreter.ts";
import type { SessionState } from "../../src/engine/session.ts";
import type {
  Command,
  Condition,
  PageCondition,
  Project,
  VariableValue,
} from "../../src/engine/types.ts";
import { currentMap, exportProject, type EditorState } from "./model.ts";

export interface PlaytestCell {
  x: number;
  y: number;
}

export interface PlaytestCarry {
  switches: Record<string, boolean>;
  variables: Record<string, VariableValue>;
}

export type PlaytestDebugEdit =
  | { kind: "switch"; id: string; value: boolean }
  | { kind: "variable"; id: string; value: VariableValue }
  | { kind: "selfSwitch"; mapId: string; eventId: string; value: SelfKey | undefined }
  | { kind: "item"; id: string; value: number }
  | { kind: "gold"; value: number };

export interface PlaytestDebugCatalog {
  switches: string[];
  variables: string[];
  items: string[];
  events: string[];
}

export interface PlaytestFiberFrame {
  depth: number;
  pc: number;
  length: number;
  op: string;
}

export interface PlaytestFiberInfo {
  key: string;
  eventId: string;
  pageIndex: number;
  mode: string;
  parallel: boolean;
  frames: PlaytestFiberFrame[];
}

export interface PlaytestEventPage {
  eventId: string;
  pageIndex: number;
}

export type PlaytestDebugRow =
  | { kind: "switch"; id: string; label: string; value: boolean }
  | { kind: "variable"; id: string; label: string; value: VariableValue }
  | { kind: "selfSwitch"; mapId: string; eventId: string; label: string; value: SelfKey | undefined }
  | { kind: "item"; id: string; label: string; value: number }
  | { kind: "gold"; label: string; value: number }
  | { kind: "run"; label: string; value: string };

export interface PlaytestIssue {
  kind: "extension" | "battle" | "backdrop" | "scene";
  key: string;
  message: string;
}

interface FiberShape {
  key: string;
  pageIndex: number;
  parallel: boolean;
  mode: string;
  stack: { prog: readonly { op?: unknown }[]; pc: number }[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The remembered canvas cell to start PLAY from, or null for the authored
 * start: the cell must belong to the current map and still lie inside it
 * (a resize can crop it away after it was selected). */
export function playtestStartCell(
  state: EditorState,
  chosen: { mapId: string; x: number; y: number } | null,
): PlaytestCell | null {
  if (chosen === null) return null;
  const map = currentMap(state);
  if (chosen.mapId !== map.id) return null;
  if (chosen.x < 0 || chosen.y < 0 || chosen.x >= map.width || chosen.y >= map.height) return null;
  return { x: chosen.x, y: chosen.y };
}

/** Build the exact in-memory document used for PLAY. The optional selected
 * cell changes only the disposable preview clone; editor history and the
 * authored start remain untouched. */
export function buildPlaytestProject(state: EditorState, cell: PlaytestCell | null): Project {
  const project = cloneJson(exportProject(state));
  if (cell === null) return project;
  const map = currentMap(state);
  if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y) ||
    cell.x < 0 || cell.y < 0 || cell.x >= map.width || cell.y >= map.height) {
    throw new Error(`playtest start ${cell.x},${cell.y} is outside map ${map.id}`);
  }
  project.start = { map: map.id, x: cell.x, y: cell.y, dir: project.start.dir };
  return project;
}

/** Only the explicitly promised cross-run banks survive LAST mode. */
export function capturePlaytestCarry(state: SessionState): PlaytestCarry {
  return {
    switches: { ...state.sw.switches },
    variables: { ...state.sw.variables },
  };
}

/** Apply LAST-mode values to a freshly started session without retaining a
 * previous map visit, inventory, wallet, scene, RNG cursor or extension
 * state. */
export function applyPlaytestCarry(state: SessionState, carry: PlaytestCarry | null): SessionState {
  if (carry === null) return state;
  const sw = createSwitchState({
    ...state.sw,
    switches: carry.switches,
    variables: carry.variables,
  });
  return { ...state, sw, interp: { ...state.interp, sw } };
}

/** Immutable debug edit. Session and interpreter must share one SwitchState
 * object, matching startSession/stepSession's reducer invariant. */
export function editPlaytestState(state: SessionState, edit: PlaytestDebugEdit): SessionState {
  const switches = { ...state.sw.switches };
  const variables = { ...state.sw.variables };
  const self = { ...state.sw.self };
  const items = { ...state.sw.items };
  let gold = state.sw.gold;

  switch (edit.kind) {
    case "switch":
      switches[edit.id] = edit.value;
      break;
    case "variable":
      variables[edit.id] = edit.value;
      break;
    case "selfSwitch": {
      const key = eventKey(edit.mapId, edit.eventId);
      if (edit.value === undefined) delete self[key];
      else self[key] = edit.value;
      break;
    }
    case "item":
      if (edit.value <= 0) delete items[edit.id];
      else items[edit.id] = edit.value;
      break;
    case "gold":
      gold = edit.value;
      break;
  }

  const sw = createSwitchState({ ...state.sw, switches, variables, self, items, gold });
  return { ...state, sw, interp: { ...state.interp, sw } };
}

function addCondition(
  condition: Condition,
  switches: Set<string>,
  variables: Set<string>,
  items: Set<string>,
  extensions?: Set<string>,
): void {
  if (condition.kind === "switch") switches.add(condition.id);
  else if (condition.kind === "variable") variables.add(condition.id);
  else if (condition.kind === "item") items.add(condition.id);
  else if (condition.kind === "ext") extensions?.add(`condition ${condition.call}`);
}

function addPageCondition(
  condition: PageCondition | undefined,
  switches: Set<string>,
  variables: Set<string>,
  items: Set<string>,
  extensions?: Set<string>,
): void {
  if (!condition) return;
  if (condition.switch) switches.add(condition.switch);
  if (condition.variable) variables.add(condition.variable.id);
  if (condition.item) items.add(condition.item);
  for (const clause of condition.all ?? []) {
    addCondition(clause, switches, variables, items, extensions);
  }
}

interface CommandScan {
  switches: Set<string>;
  variables: Set<string>;
  items: Set<string>;
  extensions?: Set<string>;
  battles?: Set<string>;
  backdrops?: Set<string>;
  scenes?: Set<string>;
  /** project.system.textVariables: `{v:<id>}` in text and scrolling-text
   *  lines, choices prompts/options and extChoice prompts names a variable. */
  textVariables?: boolean;
}

/** {v:<id>} token grammar (the runtime's expandTextTokens in
 * src/engine/player-name.ts also expands {x:} keys, but those are answered
 * by game-side session code and name no project entity, so the playtest
 * scanner tracks {v:} only). */
const TEXT_VARIABLE_TOKEN = /\{v:([^{}]*)\}/g;

function addTextVariables(value: string, scan: CommandScan): void {
  if (!scan.textVariables || !value.includes("{v:")) return;
  for (const match of value.matchAll(TEXT_VARIABLE_TOKEN)) {
    if (match[1]) scan.variables.add(match[1]);
  }
}

function addCommands(commands: readonly Command[], scan: CommandScan): void {
  for (const command of commands) {
    if (command.op === "text" || command.op === "scrollText") {
      for (const line of command.lines) addTextVariables(line, scan);
    } else if (command.op === "switch") scan.switches.add(command.id);
    else if (command.op === "variable") {
      scan.variables.add(command.id);
      if ("from" in command.set) scan.variables.add(command.set.from);
    } else if (command.op === "item") scan.items.add(command.item);
    else if (command.op === "shop") {
      for (const good of command.goods) {
        scan.items.add(good.item);
        addPageCondition(good.condition, scan.switches, scan.variables, scan.items, scan.extensions);
      }
    } else if (command.op === "ext") scan.extensions?.add(`command ${command.call}`);
    else if (command.op === "extChoice") {
      scan.extensions?.add(`choice ${command.call}`);
      addTextVariables(command.prompt, scan);
      for (const id of Object.values(command.write ?? {})) scan.variables.add(id);
    } else if (command.op === "screenBackdrop" && typeof command.variant === "string") {
      scan.backdrops?.add(`${command.layer}/${command.variant}`);
    } else if (command.op === "if") {
      addCondition(command.if, scan.switches, scan.variables, scan.items, scan.extensions);
      addCommands(command.then, scan);
      addCommands(command.else ?? [], scan);
    } else if (command.op === "choices") {
      addTextVariables(command.prompt, scan);
      for (const option of command.options) {
        addTextVariables(option.text, scan);
        addCommands(option.commands, scan);
      }
      addCommands(command.cancel?.commands ?? [], scan);
    } else if (command.op === "loop") {
      addCommands(command.commands, scan);
    } else if (command.op === "battle") {
      scan.battles?.add(JSON.stringify(command.setup));
      addCommands(command.onWin ?? [], scan);
      addCommands(command.onEscape ?? [], scan);
      addCommands(command.onLose ?? [], scan);
    } else if (command.op === "scene") {
      scan.scenes?.add(command.id);
      addCommands(command.onDone ?? [], scan);
      addCommands(command.onCancel ?? [], scan);
    }
  }
}

function scanProject(project: Project): Required<CommandScan> {
  const scan: Required<CommandScan> = {
    switches: new Set<string>(),
    variables: new Set<string>(),
    items: new Set(project.items.map((item) => item.id)),
    extensions: new Set<string>(),
    battles: new Set<string>(),
    backdrops: new Set<string>(),
    scenes: new Set<string>(),
    textVariables: project.system?.textVariables === true,
  };
  for (const common of project.commonEvents ?? []) {
    if (common.conditionSwitch) scan.switches.add(common.conditionSwitch);
    addCommands(common.commands, scan);
  }
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) {
        addPageCondition(page.condition, scan.switches, scan.variables, scan.items, scan.extensions);
        addCommands(page.commands, scan);
      }
    }
  }
  return scan;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** Every scene id referenced by the document (map events, common events,
 *  nested branches). The playtest session registers a placeholder for each
 *  so an unregistered scene id previews instead of throwing. */
export function playtestSceneIds(project: Project): string[] {
  const scan = scanProject(project);
  return sorted(scan.scenes);
}

/** Stable rows for the debug panel: authored ids plus values introduced by
 * extensions/debugging, and only the current map's event self-switch rows. */
export function playtestDebugCatalog(project: Project, state: SessionState): PlaytestDebugCatalog {
  const scan = scanProject(project);
  for (const id of Object.keys(state.sw.switches)) scan.switches.add(id);
  for (const id of Object.keys(state.sw.variables)) scan.variables.add(id);
  for (const id of Object.keys(state.sw.items)) scan.items.add(id);
  const map = project.maps.find((candidate) => candidate.id === state.mapId);
  return {
    switches: sorted(scan.switches),
    variables: sorted(scan.variables),
    items: sorted(scan.items),
    events: sorted((map?.events ?? []).map((event) => event.id)),
  };
}

/** Visible capability notices for behavior the editor intentionally runs
 * through deterministic preview fallbacks. */
export function diagnosePlaytestProject(project: Project): PlaytestIssue[] {
  const scan = scanProject(project);
  const issues: PlaytestIssue[] = [];
  for (const entry of sorted(scan.extensions)) {
    issues.push({
      kind: "extension",
      key: entry,
      message: `Preview fallback: unregistered extension ${entry} is disabled.`,
    });
  }
  if (scan.battles.size > 0) {
    issues.push({
      kind: "battle",
      key: "battle",
      message: "Preview fallback: battle uses the editor WIN / ESCAPE placeholder.",
    });
  }
  for (const id of sorted(scan.scenes)) {
    issues.push({
      kind: "scene",
      key: id,
      message: `Preview fallback: scene ${id} uses the editor OK / CANCEL placeholder.`,
    });
  }
  for (const key of sorted(scan.backdrops)) {
    issues.push({
      kind: "backdrop",
      key,
      message: `Preview fallback: screen backdrop ${key} uses a placeholder.`,
    });
  }
  return issues;
}

function projectFiber(fiber: FiberShape, mapId: string): PlaytestFiberInfo {
  const prefix = `${mapId}/`;
  return {
    key: fiber.key,
    eventId: fiber.key.startsWith(prefix) ? fiber.key.slice(prefix.length) : fiber.key,
    pageIndex: fiber.pageIndex,
    mode: fiber.mode,
    parallel: fiber.parallel,
    frames: fiber.stack.map((frame, depth) => ({
      depth,
      pc: frame.pc,
      length: frame.prog.length,
      op: String(frame.prog[frame.pc]?.op ?? "end"),
    })),
  };
}

/** Read-only projection of the private interpreter fibers for editor
 * diagnostics. No program object or mutable reducer record escapes. */
export function playtestFibers(state: SessionState): PlaytestFiberInfo[] {
  const interp = state.interp as unknown as {
    main: FiberShape | null;
    parallels: Record<string, FiberShape>;
  };
  const out: PlaytestFiberInfo[] = [];
  if (interp.main) out.push(projectFiber(interp.main, state.mapId));
  for (const key of Object.keys(interp.parallels).sort()) {
    out.push(projectFiber(interp.parallels[key]!, state.mapId));
  }
  return out;
}

export function playtestEventPages(state: SessionState): PlaytestEventPage[] {
  return Object.keys(state.chars.chars)
    .sort()
    .map((eventId) => ({ eventId, pageIndex: state.chars.chars[eventId]!.pageIndex }));
}

export function playtestDebugRows(
  project: Project,
  state: SessionState,
  tab: "switch" | "variable" | "self" | "item" | "gold" | "run",
): PlaytestDebugRow[] {
  const catalog = playtestDebugCatalog(project, state);
  if (tab === "switch") {
    return catalog.switches.map((id) => ({ kind: "switch", id, label: id, value: state.sw.switches[id] === true }));
  }
  if (tab === "variable") {
    return catalog.variables.map((id) => ({ kind: "variable", id, label: id, value: state.sw.variables[id] ?? 0 }));
  }
  if (tab === "self") {
    return catalog.events.map((eventId) => ({
      kind: "selfSwitch",
      mapId: state.mapId,
      eventId,
      label: eventId,
      value: state.sw.self[eventKey(state.mapId, eventId)],
    }));
  }
  if (tab === "item") {
    return catalog.items.map((id) => ({ kind: "item", id, label: id, value: state.sw.items[id] ?? 0 }));
  }
  if (tab === "gold") return [{ kind: "gold", label: "wallet", value: state.sw.gold }];
  return [
    ...playtestEventPages(state).map((page): PlaytestDebugRow => ({
      kind: "run",
      label: `PAGE ${page.eventId}`,
      value: String(page.pageIndex + 1),
    })),
    ...playtestFibers(state).map((fiber): PlaytestDebugRow => {
      const frame = fiber.frames[fiber.frames.length - 1];
      const address = fiber.frames.map((entry) => entry.pc).join("/");
      return {
        kind: "run",
        label: `FIBER ${fiber.eventId} P${fiber.pageIndex + 1}`,
        value: `${fiber.mode} @${address || "-"} ${frame?.op ?? "end"}`,
      };
    }),
  ];
}

export function playtestRowEdit(row: PlaytestDebugRow, delta: -1 | 1): PlaytestDebugEdit | null {
  if (row.kind === "switch") return { kind: "switch", id: row.id, value: !row.value };
  if (row.kind === "variable") {
    const value = typeof row.value === "number" ? row.value : 0;
    return { kind: "variable", id: row.id, value: value + delta };
  }
  if (row.kind === "selfSwitch") {
    const values: readonly (SelfKey | undefined)[] = [undefined, "A", "B", "C", "D"];
    const index = values.indexOf(row.value);
    return {
      kind: "selfSwitch",
      mapId: row.mapId,
      eventId: row.eventId,
      value: values[(index + delta + values.length) % values.length],
    };
  }
  if (row.kind === "item") return { kind: "item", id: row.id, value: Math.max(0, row.value + delta) };
  if (row.kind === "gold") return { kind: "gold", value: Math.max(0, row.value + delta) };
  return null;
}
