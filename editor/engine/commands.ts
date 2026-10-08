// editor/engine/commands.ts — pure helpers for presenting and editing the
// recursive event-command tree. This module deliberately knows nothing about
// the editor store or host: a page/common-event command array goes in and a
// structurally shared replacement comes out.

import type {
  Command,
  Condition,
  MoveStep,
  PageCondition,
} from "../../src/engine/types.ts";

/** A segment says which child list of a command to enter. `index` is always
 * relative to the list reached by the preceding segments. The root list is
 * represented by the empty path, so paths are serializable and easy to use as
 * selection state. */
export type CommandListPathSegment =
  | { readonly kind: "if"; readonly index: number; readonly branch: "then" | "else" }
  | { readonly kind: "choices"; readonly index: number; readonly branch: "option"; readonly option: number }
  | { readonly kind: "choices"; readonly index: number; readonly branch: "cancel" }
  | { readonly kind: "battle"; readonly index: number; readonly branch: "win" | "lose" | "escape" }
  | { readonly kind: "scene"; readonly index: number; readonly branch: "done" | "cancel" }
  | { readonly kind: "loop"; readonly index: number; readonly branch: "body" };

export type CommandListPath = readonly CommandListPathSegment[];

/** The address of one command. For insertion functions, `index` is a slot in
 * the addressed list and may equal its length. */
export interface CommandAddress {
  readonly path: CommandListPath;
  readonly index: number;
}

export const ROOT_COMMAND_PATH: CommandListPath = Object.freeze([]);

export function commandAddress(path: CommandListPath, index: number): CommandAddress {
  return { path, index };
}

export function ifBranchPath(
  parent: CommandAddress,
  branch: "then" | "else",
): CommandListPath {
  return [...parent.path, { kind: "if", index: parent.index, branch }];
}

export function choiceBranchPath(
  parent: CommandAddress,
  option: number | "cancel",
): CommandListPath {
  return option === "cancel"
    ? [...parent.path, { kind: "choices", index: parent.index, branch: "cancel" }]
    : [...parent.path, { kind: "choices", index: parent.index, branch: "option", option }];
}

export function battleBranchPath(
  parent: CommandAddress,
  branch: "win" | "lose" | "escape",
): CommandListPath {
  return [...parent.path, { kind: "battle", index: parent.index, branch }];
}

export function sceneBranchPath(
  parent: CommandAddress,
  branch: "done" | "cancel",
): CommandListPath {
  return [...parent.path, { kind: "scene", index: parent.index, branch }];
}

/** The body of a `loop` command. */
export function loopBodyPath(parent: CommandAddress): CommandListPath {
  return [...parent.path, { kind: "loop", index: parent.index, branch: "body" }];
}

function segmentKey(segment: CommandListPathSegment): string {
  if (segment.kind === "loop") return `l${segment.index}:body`;
  if (segment.kind === "if") return `i${segment.index}:${segment.branch}`;
  if (segment.kind === "battle") return `b${segment.index}:${segment.branch}`;
  if (segment.kind === "scene") return `s${segment.index}:${segment.branch}`;
  return segment.branch === "cancel"
    ? `c${segment.index}:cancel`
    : `c${segment.index}:option:${segment.option}`;
}

/** A stable, human-readable key suitable for keyed UI rows. */
export function commandPathKey(path: CommandListPath): string {
  return path.length === 0 ? "root" : path.map(segmentKey).join("/");
}

export function commandAddressKey(address: CommandAddress): string {
  return `${commandPathKey(address.path)}#${address.index}`;
}

export const EDITABLE_COMMAND_OPS = [
  "text",
  "choices",
  "switch",
  "variable",
  "selfSwitch",
  "if",
  "transfer",
  "moveRoute",
  "moveControl",
  "appearance",
  "layer",
  "changeParallax",
  "tileProperty",
  "screenFade",
  "screenTint",
  "screenFlash",
  "screenShake",
  "camera",
  "scrollMap",
  "balloon",
  "screenBackdrop",
  "showPicture",
  "movePicture",
  "rotatePicture",
  "tintPicture",
  "erasePicture",
  "timer",
  "inputNumber",
  "selectItem",
  "openMenu",
  "openSave",
  "autosave",
  "gameOver",
  "returnTitle",
  "changeName",
  "mapNameDisplay",
  "menuAccess",
  "saveAccess",
  "locationInfo",
  "wait",
  "gold",
  "item",
  "se",
  "playBgm",
  "fadeoutBgm",
  "stopBgm",
  "pauseBgm",
  "resumeBgm",
  "playBgs",
  "fadeoutBgs",
  "playMe",
  "playSe",
  "stopSe",
  "saveBgm",
  "replayBgm",
  "erase",
  "exit",
  "common",
  "shop",
  "mapAnim",
  "stopAnim",
  "lockInput",
  "unlockInput",
  "place",
  "ext",
  "extChoice",
  "battle",
  "scene",
  "loop",
  "break",
  "label",
  "jumpLabel",
] as const;

export type EditableCommandOp = (typeof EDITABLE_COMMAND_OPS)[number];
export type EditableCommand = Extract<Command, { op: EditableCommandOp }>;
type AssertNoMissing<T extends never> = T;
type _EveryCommandOpIsOwned = AssertNoMissing<Exclude<Command["op"], EditableCommandOp>>;

const EDITABLE_OP_SET: ReadonlySet<string> = new Set(EDITABLE_COMMAND_OPS);

export function isEditableCommand(command: unknown): command is EditableCommand {
  return isRecord(command) && typeof command.op === "string" && EDITABLE_OP_SET.has(command.op);
}

type CommandOf<Op extends EditableCommandOp> = Extract<Command, { op: Op }>;

/** Schema-valid starting values for every command form the editor owns. */
export function defaultCommand<Op extends EditableCommandOp>(op: Op): CommandOf<Op> {
  let command: EditableCommand;
  switch (op) {
    case "text":
      command = { op, lines: [""] };
      break;
    case "choices":
      command = {
        op,
        prompt: "",
        options: [
          { text: "Option 1", commands: [] },
          { text: "Option 2", commands: [] },
        ],
      };
      break;
    case "switch":
      command = { op, id: "switch", value: true };
      break;
    case "variable":
      command = { op, id: "variable", set: { op: "set", value: 0 } };
      break;
    case "selfSwitch":
      command = { op, key: "A", value: true };
      break;
    case "if":
      command = { op, if: defaultCondition("switch"), then: [] };
      break;
    case "transfer":
      command = { op, map: "map", x: 0, y: 0, dir: "keep", fade: 0 };
      break;
    case "moveRoute":
      command = {
        op,
        target: "this",
        wait: true,
        route: { steps: [], repeat: false, skippable: false },
      };
      break;
    case "moveControl":
      command = { op, target: "this", control: { kind: "stop" } };
      break;
    case "appearance":
      command = { op, target: "this", sprite: null };
      break;
    case "layer":
      command = { op, layer: "layer", visible: true };
      break;
    case "changeParallax":
      command = { op, image: null, loopX: false, loopY: false, sx: 0, sy: 0 };
      break;
    case "tileProperty":
      command = { op, x: 0, y: 0, passage: null };
      break;
    case "screenFade":
      command = { op, direction: "out", duration: 0 };
      break;
    case "screenTint":
      command = { op, layer: "tint", color: { r: 0, g: 0, b: 0, a: 0 }, duration: 0 };
      break;
    case "screenFlash":
      command = { op, color: { r: 255, g: 255, b: 255, a: 255 }, intensity: 255, duration: 0 };
      break;
    case "screenShake":
      command = { op, strength: 0, speed: 0, duration: 0 };
      break;
    case "camera":
      command = { op, target: "player", duration: 0 };
      break;
    case "scrollMap":
      command = { op, direction: "down", distance: 1, speed: 4, wait: true };
      break;
    case "balloon":
      command = { op, target: "this" };
      break;
    case "screenBackdrop":
      command = { op, layer: "backdrop" };
      break;
    case "showPicture":
      command = { op, id: 1, layer: "picture", variant: "picture", x: 0, y: 0 };
      break;
    case "movePicture":
      command = { op, id: 1, x: 0, y: 0, scaleX: 100, scaleY: 100, opacity: 255, duration: 0 };
      break;
    case "rotatePicture":
      command = { op, id: 1, speed: 0 };
      break;
    case "tintPicture":
      command = { op, id: 1, tone: { r: 0, g: 0, b: 0, gray: 0 }, duration: 0 };
      break;
    case "erasePicture":
      command = { op, id: 1 };
      break;
    case "timer":
      command = { op, action: "start", seconds: 60 };
      break;
    case "inputNumber":
      command = { op, variable: "variable", digits: 1 };
      break;
    case "selectItem":
      command = { op, variable: "variable", itemType: "regular" };
      break;
    case "openMenu":
    case "openSave":
    case "autosave":
    case "gameOver":
    case "returnTitle":
      command = { op };
      break;
    case "changeName":
      command = { op, name: "Player" };
      break;
    case "mapNameDisplay":
      command = { op, visible: true };
      break;
    case "menuAccess":
    case "saveAccess":
      command = { op, enabled: true };
      break;
    case "locationInfo":
      command = { op, variable: "variable", x: 0, y: 0, kind: "terrain" };
      break;
    case "wait":
      command = { op, seconds: 1 };
      break;
    case "gold":
      command = { op, set: "add", amount: 0 };
      break;
    case "item":
      command = { op, item: "item", set: "add", count: 1 };
      break;
    case "se":
      command = { op, name: "sound", volume: 100, pitch: 100 };
      break;
    case "playBgm":
    case "playBgs":
    case "playSe":
      command = { op, id: "audio", volume: 100, pitch: 100 };
      break;
    case "stopSe":
      command = { op };
      break;
    case "fadeoutBgm":
    case "fadeoutBgs":
      command = { op, duration: 0 };
      break;
    case "playMe":
      command = { op, id: "audio", duration: 1, volume: 100, pitch: 100 };
      break;
    case "stopBgm":
    case "pauseBgm":
    case "resumeBgm":
    case "saveBgm":
    case "replayBgm":
    case "erase":
    case "exit":
    case "lockInput":
    case "unlockInput":
      command = { op };
      break;
    case "common":
      command = { op, id: "common" };
      break;
    case "shop":
      command = { op, id: "shop", goods: [{ item: "item" }] };
      break;
    case "mapAnim":
      command = { op, id: "animation", anim: "animation", x: 0, y: 0 };
      break;
    case "stopAnim":
      command = { op };
      break;
    case "place":
      command = { op, target: "this", x: 0, y: 0, dir: "down" };
      break;
    case "ext":
      command = { op, call: "game.command", args: null };
      break;
    case "extChoice":
      command = { op, call: "game.choice", args: null, prompt: "" };
      break;
    case "battle":
      command = { op, setup: null };
      break;
    case "scene":
      command = { op, id: "game.scene" };
      break;
    case "loop":
      command = { op, commands: [] };
      break;
    case "break":
      command = { op };
      break;
    case "label":
    case "jumpLabel":
      command = { op, name: "label" };
      break;
  }
  return command as CommandOf<Op>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = "?"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function boolText(value: unknown): string {
  return value === true ? "ON" : value === false ? "OFF" : "?";
}

function truncate(value: string, max = 64, full = false): string {
  return full || value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function jsonPreview(value: unknown, max = 48, full = false): string {
  try {
    const encoded = JSON.stringify(value);
    return truncate(encoded === undefined ? String(value) : encoded, max, full);
  } catch {
    return "[opaque]";
  }
}

function signed(set: unknown, amount: unknown): string {
  const prefix = set === "sub" ? "−" : set === "add" ? "+" : "";
  return `${prefix}${numberText(amount)}`;
}

function operandSummary(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (isRecord(value) && typeof value.variable === "string") return `$${value.variable}`;
  return "?";
}

function targetSummary(value: unknown): string {
  if (value === "this" || value === "player") return value;
  if (isRecord(value) && typeof value.event === "string") return `event ${value.event}`;
  return "?";
}

function cameraTargetSummary(value: unknown): string {
  if (isRecord(value) && typeof value.x === "number" && typeof value.y === "number") {
    return `tile (${numberText(value.x)}, ${numberText(value.y)})`;
  }
  return targetSummary(value);
}

function colorSummary(value: unknown): string {
  if (!isRecord(value)) return "rgba(?)";
  return `rgba(${numberText(value.r)},${numberText(value.g)},${numberText(value.b)},${numberText(value.a)})`;
}

/** A compact single-line display. It is deliberately total over unknown and
 * malformed data so an editor can still open and preserve newer projects.
 * With `{ full: true }` no text is shortened: callers that wrap lines
 * themselves (the event explanation) get the complete content, while list
 * rows and hover cards keep the 64-character default. */
export function commandSummary(command: unknown, opts: { full?: boolean } = {}): string {
  const full = opts.full === true;
  if (!isRecord(command)) return "Unknown command";
  switch (command.op) {
    case "text": {
      const lines = Array.isArray(command.lines)
        ? command.lines.filter((line): line is string => typeof line === "string")
        : [];
      // Only the layout fields an author set; a default box reads as before.
      const layout = (["position", "align", "valign", "background"] as const)
        .map((key) => command[key])
        .filter((value): value is string => typeof value === "string");
      return `Text: ${truncate(lines.join(" / ") || "(empty)", 64, full)}${layout.length > 0 ? ` [${layout.join(", ")}]` : ""}`;
    }
    case "choices":
      return `Choices: ${truncate(text(command.prompt, "(no prompt)"), 64, full)} (${Array.isArray(command.options) ? command.options.length : 0})`;
    case "switch":
      return `Switch ${text(command.id)} = ${boolText(command.value)}`;
    case "variable": {
      const set = isRecord(command.set) ? command.set : {};
      if (set.op === "random") {
        return `Variable ${text(command.id)} = random ${numberText(set.min)}…${numberText(set.max)}`;
      }
      if (typeof set.from === "string") {
        return `Variable ${text(command.id)} ${text(set.op)} $${set.from}`;
      }
      return `Variable ${text(command.id)} ${text(set.op)} ${numberText(set.value)}`;
    }
    case "selfSwitch":
      return `Self switch ${text(command.key)} = ${boolText(command.value)}`;
    case "if":
      // The full flag must reach the nested condition too: a long extension
      // condition inside an `if` is part of the explanation's text and must
      // not be truncated at the model layer.
      return `If ${conditionSummary(command.if, { full })}`;
    case "transfer":
      return `Transfer ${operandSummary(command.map)} (${operandSummary(command.x)}, ${operandSummary(command.y)})`;
    case "wait":
      return `Wait ${numberText(command.seconds)}s`;
    case "gold":
      return `Gold ${signed(command.set, command.amount)}`;
    case "item":
      return `Item ${text(command.item)} ${signed(command.set, command.count)}`;
    case "se":
      return `Sound ${text(command.name)}`;
    case "playBgm":
      return `Play BGM ${text(command.id)}`;
    case "fadeoutBgm":
      return `Fade out BGM over ${numberText(command.duration)}s`;
    case "stopBgm":
      return "Stop BGM";
    case "pauseBgm":
      return "Pause BGM";
    case "resumeBgm":
      return "Resume BGM";
    case "playBgs":
      return `Play BGS ${text(command.id)}`;
    case "fadeoutBgs":
      return `Fade out BGS over ${numberText(command.duration)}s`;
    case "playMe":
      return `Play ME ${text(command.id)} for ${numberText(command.duration)}s`;
    case "playSe":
      return `Play SE ${text(command.id)}`;
    case "stopSe":
      return "Stop SE";
    case "saveBgm":
      return "Save BGM";
    case "replayBgm":
      return "Replay BGM";
    case "erase":
      return "Erase event";
    case "exit":
      return "Exit event";
    case "common":
      return `Common event ${text(command.id)}`;
    case "lockInput":
      return "Lock input";
    case "unlockInput":
      return "Unlock input";
    case "place":
      return `Place ${targetSummary(command.target)} at (${numberText(command.x)}, ${numberText(command.y)})`;
    case "moveRoute": {
      const route = isRecord(command.route) ? command.route : {};
      const count = Array.isArray(route.steps) ? route.steps.length : 0;
      return `Move route ${targetSummary(command.target)} (${count} step${count === 1 ? "" : "s"})`;
    }
    case "moveControl": {
      const control = isRecord(command.control) ? command.control : {};
      return `Move control ${targetSummary(command.target)}: ${text(control.kind)}${control.value === undefined ? "" : ` ${jsonPreview(control.value, 48, full)}`}`;
    }
    case "shop":
      return `Shop ${text(command.id)} (${Array.isArray(command.goods) ? command.goods.length : 0} goods)`;
    case "ext":
      return `Extension ${text(command.call)} ${jsonPreview(command.args, 48, full)}`;
    case "extChoice":
      return `Extension choice ${text(command.call)}: ${text(command.prompt)}`;
    case "appearance":
      return `Appearance ${jsonPreview(command.target, 48, full)} ${jsonPreview({ sprite: command.sprite, opacity: command.opacity, visible: command.visible }, 48, full)}`;
    case "layer":
      return `Layer ${text(command.layer)} ${jsonPreview({ visible: command.visible, variant: command.variant }, 48, full)}`;
    case "changeParallax":
      return command.image === null
        ? "Clear parallax"
        : `Parallax ${text(command.image)} loop ${command.loopX ? "X" : "-"}${command.loopY ? "Y" : "-"} speed (${numberText(command.sx)}, ${numberText(command.sy)})`;
    case "tileProperty":
      return `Tile property (${numberText(command.x)}, ${numberText(command.y)}) ${jsonPreview({ passage: command.passage, enter: command.enter, exit: command.exit }, 48, full)}`;
    case "screenFade":
      return `Screen fade ${text(command.direction)} ${numberText(command.duration)}s${command.color === undefined ? "" : ` ${colorSummary(command.color)}`}`;
    case "screenTint":
      return `Screen tint ${text(command.layer)} ${colorSummary(command.color)} ${numberText(command.duration)}s`;
    case "screenFlash":
      return `Screen flash ${colorSummary(command.color)} ×${numberText(command.intensity)} ${numberText(command.duration)}s`;
    case "screenShake":
      return `Screen shake ${numberText(command.strength)}px @ ${numberText(command.speed)}Hz for ${numberText(command.duration)}s`;
    case "camera":
      return `Camera ${cameraTargetSummary(command.target)} ${numberText(command.duration)}s`;
    case "scrollMap":
      return `Scroll map ${text(command.direction)} ${numberText(command.distance)} tiles at speed ${numberText(command.speed)}`;
    case "balloon":
      return command.icon === undefined
        ? `Clear balloon on ${targetSummary(command.target)}`
        : `Balloon ${text(command.icon)} on ${targetSummary(command.target)}${command.duration === undefined ? "" : ` for ${numberText(command.duration)}s`}`;
    case "screenBackdrop":
      return command.variant === undefined || command.variant === null
        ? `Close backdrop ${text(command.layer)}`
        : `Backdrop ${text(command.layer)} = ${text(command.variant)}`;
    case "showPicture":
      return `Show picture ${numberText(command.id)}: ${text(command.variant)} at (${operandSummary(command.x)}, ${operandSummary(command.y)})`;
    case "movePicture":
      return `Move picture ${numberText(command.id)} to (${operandSummary(command.x)}, ${operandSummary(command.y)}) over ${numberText(command.duration)}s`;
    case "rotatePicture":
      return `Rotate picture ${numberText(command.id)} at ${numberText(command.speed)}`;
    case "tintPicture":
      return `Tint picture ${numberText(command.id)} ${jsonPreview(command.tone, 48, full)} over ${numberText(command.duration)}s`;
    case "erasePicture":
      return `Erase picture ${numberText(command.id)}`;
    case "timer":
      if (command.action === "start") return `Start timer at ${numberText(command.seconds)}s`;
      if (command.action === "read") return `Read timer into ${text(command.variable)}`;
      return "Stop timer";
    case "inputNumber":
      return `Input ${numberText(command.digits)} digit number into ${text(command.variable)}`;
    case "selectItem":
      return `Select ${text(command.itemType)} item into ${text(command.variable)}`;
    case "openMenu":
      return "Open menu";
    case "openSave":
      return "Open save screen";
    case "autosave":
      return "Autosave";
    case "gameOver":
      return "Game over";
    case "returnTitle":
      return "Return to title";
    case "changeName":
      return `Change player name to ${text(command.name)}`;
    case "mapNameDisplay":
      return `Map name display ${boolText(command.visible)}`;
    case "menuAccess":
      return `Menu access ${boolText(command.enabled)}`;
    case "saveAccess":
      return `Save access ${boolText(command.enabled)}`;
    case "locationInfo":
      return `Location ${text(command.kind)} at (${operandSummary(command.x)}, ${operandSummary(command.y)}) into ${text(command.variable)}`;
    case "mapAnim": {
      const at = command.target === undefined
        ? `tile (${numberText(command.x)}, ${numberText(command.y)})`
        : targetSummary(command.target);
      return `Map animation ${text(command.anim)} as ${text(command.id)} on ${at}`;
    }
    case "stopAnim":
      if (typeof command.id === "string") return `Stop map animation ${text(command.id)}`;
      if (typeof command.anim === "string") return `Stop map animations using ${text(command.anim)}`;
      return "Stop all map animations";
    case "battle":
      return `Battle ${jsonPreview(command.setup, 48, full)}`;
    case "scene":
      return `Scene ${text(command.id)}`;
    case "loop": {
      const count = Array.isArray(command.commands) ? command.commands.length : 0;
      return `Loop (${count} command${count === 1 ? "" : "s"})`;
    }
    case "break":
      return "Break loop";
    case "label":
      return `Label ${text(command.name)}`;
    case "jumpLabel":
      return `Jump to label ${text(command.name)}`;
    default:
      return `Unknown command${typeof command.op === "string" ? ` (${command.op})` : ""}`;
  }
}

export interface FlatCommandRow {
  readonly key: string;
  readonly address: CommandAddress;
  readonly path: CommandListPath;
  readonly index: number;
  readonly depth: number;
  /** Label of this command's immediate containing branch. */
  readonly branch?: string;
  readonly branchLabel?: string;
  readonly command: Command;
  readonly summary: string;
  readonly editable: boolean;
  readonly readOnly: boolean;
}

interface ChildBranch {
  path: CommandListPath;
  label: string;
  commands: readonly Command[];
}

function childBranches(command: Command, address: CommandAddress): ChildBranch[] {
  const value = command as Command & Record<string, unknown>;
  const children: ChildBranch[] = [];
  if (value.op === "if") {
    children.push({
      path: ifBranchPath(address, "then"),
      label: "Then",
      commands: Array.isArray(value.then) ? value.then as Command[] : [],
    });
    if (Array.isArray(value.else)) {
      children.push({ path: ifBranchPath(address, "else"), label: "Else", commands: value.else as Command[] });
    }
  } else if (value.op === "choices" && Array.isArray(value.options)) {
    value.options.forEach((option, optionIndex) => {
      if (!isRecord(option)) return;
      children.push({
        path: choiceBranchPath(address, optionIndex),
        label: `Option ${optionIndex + 1}: ${text(option.text)}`,
        commands: Array.isArray(option.commands) ? option.commands as Command[] : [],
      });
    });
    if (isRecord(value.cancel) && Array.isArray(value.cancel.commands)) {
      children.push({ path: choiceBranchPath(address, "cancel"), label: "Cancel", commands: value.cancel.commands as Command[] });
    }
  } else if (value.op === "battle") {
    for (const [branch, property, label] of [
      ["win", "onWin", "Win"],
      ["escape", "onEscape", "Escape"],
      ["lose", "onLose", "Lose"],
    ] as const) {
      const commands = value[property];
      if (Array.isArray(commands)) {
        children.push({ path: battleBranchPath(address, branch), label, commands: commands as Command[] });
      }
    }
  } else if (value.op === "loop") {
    children.push({
      path: loopBodyPath(address),
      label: "Body",
      commands: Array.isArray(value.commands) ? value.commands as Command[] : [],
    });
  } else if (value.op === "scene") {
    for (const [branch, property, label] of [
      ["done", "onDone", "Done"],
      ["cancel", "onCancel", "Cancel"],
    ] as const) {
      const commands = value[property];
      if (Array.isArray(commands)) {
        children.push({ path: sceneBranchPath(address, branch), label, commands: commands as Command[] });
      }
    }
  }
  return children;
}

/** Pre-order flattening: a container appears before all of its branches, and
 * branches appear in authored order (then/else, options/cancel,
 * win/lose/escape, a loop's body). With `fullSummary` the row summaries keep
 * the complete command text instead of the compact 64-character form, for
 * callers that wrap lines themselves (the event explanation). */
export function flattenCommands(commands: readonly Command[], opts: { fullSummary?: boolean } = {}): FlatCommandRow[] {
  const full = opts.fullSummary === true;
  const rows: FlatCommandRow[] = [];

  const visit = (list: readonly Command[], path: CommandListPath, branch?: string): void => {
    list.forEach((command, index) => {
      const address: CommandAddress = { path, index };
      const editable = isEditableCommand(command);
      rows.push({
        key: commandAddressKey(address),
        address,
        path,
        index,
        depth: path.length,
        ...(branch === undefined ? {} : { branch, branchLabel: branch }),
        command,
        summary: commandSummary(command, { full }),
        editable,
        readOnly: !editable,
      });
      for (const child of childBranches(command, address)) {
        visit(child.commands, child.path, child.label);
      }
    });
  };

  visit(commands, ROOT_COMMAND_PATH);
  return rows;
}

interface BranchRef {
  readonly commands: readonly Command[];
  readonly present: boolean;
}

const EMPTY_COMMANDS: readonly Command[] = Object.freeze([]);

function validIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0;
}

function branchOf(command: Command, segment: CommandListPathSegment): BranchRef | null {
  if (!validIndex(segment.index)) return null;
  if (segment.kind === "if") {
    if (command.op !== "if") return null;
    if (segment.branch === "then") return { commands: command.then, present: true };
    return Array.isArray(command.else)
      ? { commands: command.else, present: true }
      : { commands: EMPTY_COMMANDS, present: false };
  }
  if (segment.kind === "choices") {
    if (command.op !== "choices") return null;
    if (segment.branch === "cancel") {
      return command.cancel
        ? { commands: command.cancel.commands, present: true }
        : { commands: EMPTY_COMMANDS, present: false };
    }
    if (!validIndex(segment.option) || segment.option >= command.options.length) return null;
    return { commands: command.options[segment.option]!.commands, present: true };
  }
  if (segment.kind === "loop") {
    if (command.op !== "loop" || segment.branch !== "body") return null;
    return { commands: Array.isArray(command.commands) ? command.commands : EMPTY_COMMANDS, present: true };
  }
  if (segment.kind === "scene") {
    if (command.op !== "scene") return null;
    const commands = segment.branch === "done" ? command.onDone : command.onCancel;
    return Array.isArray(commands)
      ? { commands, present: true }
      : { commands: EMPTY_COMMANDS, present: false };
  }
  if (command.op !== "battle") return null;
  const property = segment.branch === "win"
    ? "onWin"
    : segment.branch === "lose"
      ? "onLose"
      : "onEscape";
  const branch = command[property];
  return Array.isArray(branch)
    ? { commands: branch, present: true }
    : { commands: EMPTY_COMMANDS, present: false };
}

function replaceBranch(
  command: Command,
  segment: CommandListPathSegment,
  commands: Command[],
): Command | null {
  if (segment.kind === "if") {
    if (command.op !== "if") return null;
    return segment.branch === "then"
      ? { ...command, then: commands }
      : { ...command, else: commands };
  }
  if (segment.kind === "choices") {
    if (command.op !== "choices") return null;
    if (segment.branch === "cancel") {
      return { ...command, cancel: { ...(command.cancel ?? {}), commands } };
    }
    if (!validIndex(segment.option) || segment.option >= command.options.length) return null;
    const options = command.options.slice();
    options[segment.option] = { ...options[segment.option]!, commands };
    return { ...command, options };
  }
  if (segment.kind === "loop") {
    if (command.op !== "loop" || segment.branch !== "body") return null;
    return { ...command, commands };
  }
  if (segment.kind === "scene") {
    if (command.op !== "scene") return null;
    return segment.branch === "done"
      ? { ...command, onDone: commands }
      : { ...command, onCancel: commands };
  }
  if (command.op !== "battle") return null;
  if (segment.branch === "win") return { ...command, onWin: commands };
  if (segment.branch === "lose") return { ...command, onLose: commands };
  return { ...command, onEscape: commands };
}

/** Returns null for a structurally invalid path. Optional branches that have
 * not yet been authored resolve to an empty list and are materialized by the
 * first successful insertion. */
export function getCommandList(
  commands: readonly Command[],
  path: CommandListPath,
): readonly Command[] | null {
  let list = commands;
  for (const segment of path) {
    if (!validIndex(segment.index) || segment.index >= list.length) return null;
    const branch = branchOf(list[segment.index]!, segment);
    if (!branch) return null;
    list = branch.commands;
  }
  return list;
}

export function getCommand(
  commands: readonly Command[],
  address: CommandAddress,
): Command | null {
  const list = getCommandList(commands, address.path);
  return list && validIndex(address.index) && address.index < list.length
    ? list[address.index]!
    : null;
}

type ListUpdate = (commands: readonly Command[]) => Command[] | null;

/** null means invalid path/update; the original list means a valid no-op. */
function updateListAtPath(
  commands: readonly Command[],
  path: CommandListPath,
  update: ListUpdate,
  depth = 0,
): Command[] | null {
  if (depth === path.length) return update(commands);
  const segment = path[depth]!;
  if (!validIndex(segment.index) || segment.index >= commands.length) return null;
  const command = commands[segment.index]!;
  const branch = branchOf(command, segment);
  if (!branch) return null;
  const nextBranch = updateListAtPath(branch.commands, path, update, depth + 1);
  if (!nextBranch) return null;
  if (nextBranch === branch.commands || (!branch.present && nextBranch.length === 0)) {
    return commands as Command[];
  }
  const nextCommand = replaceBranch(command, segment, nextBranch);
  if (!nextCommand) return null;
  const next = commands.slice();
  next[segment.index] = nextCommand;
  return next;
}

export function insertCommand(
  commands: readonly Command[],
  address: CommandAddress,
  command: Command,
): Command[] {
  const next = updateListAtPath(commands, address.path, (list) => {
    if (!validIndex(address.index) || address.index > list.length) return null;
    const replacement = list.slice();
    replacement.splice(address.index, 0, command);
    return replacement;
  });
  return next ?? commands as Command[];
}

export function deleteCommand(
  commands: readonly Command[],
  address: CommandAddress,
): Command[] {
  const next = updateListAtPath(commands, address.path, (list) => {
    if (!validIndex(address.index) || address.index >= list.length) return null;
    return [...list.slice(0, address.index), ...list.slice(address.index + 1)];
  });
  return next ?? commands as Command[];
}

export type CommandUpdater = Command | ((command: EditableCommand) => Command);

/** Only editor-owned commands can be field-updated. Opaque commands may still
 * be inserted, deleted, copied and reordered as intact values. */
export function updateCommand(
  commands: readonly Command[],
  address: CommandAddress,
  update: CommandUpdater,
): Command[] {
  const next = updateListAtPath(commands, address.path, (list) => {
    if (!validIndex(address.index) || address.index >= list.length) return null;
    const before = list[address.index]!;
    if (!isEditableCommand(before)) return list as Command[];
    const after = typeof update === "function" ? update(before) : update;
    if (after === before) return list as Command[];
    const replacement = list.slice();
    replacement[address.index] = after;
    return replacement;
  });
  return next ?? commands as Command[];
}

function samePath(a: CommandListPath, b: CommandListPath): boolean {
  if (a.length !== b.length) return false;
  return a.every((segment, index) => segmentKey(segment) === segmentKey(b[index]!));
}

/** Rebase a destination path after deleting `removed`. null means the
 * destination was inside the command being moved. */
export function pathAfterDelete(
  path: CommandListPath,
  removed: CommandAddress,
): CommandListPath | null {
  if (path.length <= removed.path.length) return path;
  for (let i = 0; i < removed.path.length; i++) {
    if (segmentKey(path[i]!) !== segmentKey(removed.path[i]!)) return path;
  }
  const child = path[removed.path.length]!;
  if (child.index === removed.index) return null;
  if (child.index < removed.index) return path;
  const rebased = path.slice();
  rebased[removed.path.length] = { ...child, index: child.index - 1 };
  return rebased;
}

/** Move to a final index in the same list, or to an insertion address in a
 * different list. A move into the moved command's own descendant is a no-op. */
export function moveCommand(
  commands: readonly Command[],
  from: CommandAddress,
  to: number | CommandAddress,
): Command[] {
  const command = getCommand(commands, from);
  if (!command) return commands as Command[];
  const destination: CommandAddress = typeof to === "number" ? { path: from.path, index: to } : to;
  const destinationList = getCommandList(commands, destination.path);
  if (!destinationList || !validIndex(destination.index)) return commands as Command[];

  if (samePath(from.path, destination.path)) {
    if (destination.index >= destinationList.length || destination.index === from.index) {
      return commands as Command[];
    }
    const next = updateListAtPath(commands, from.path, (list) => {
      const replacement = list.slice();
      replacement.splice(from.index, 1);
      replacement.splice(destination.index, 0, command);
      return replacement;
    });
    return next ?? commands as Command[];
  }

  if (destination.index > destinationList.length) return commands as Command[];
  const rebasedPath = pathAfterDelete(destination.path, from);
  if (!rebasedPath) return commands as Command[];
  const without = deleteCommand(commands, from);
  if (without === commands) return commands as Command[];
  const moved = insertCommand(without, { path: rebasedPath, index: destination.index }, command);
  return moved === without ? commands as Command[] : moved;
}

/** Duplicate immediately after the source, or intact at an explicit insertion
 * address. Immutable updates make sharing the command object safe and keep
 * opaque payloads byte-for-byte untouched. */
export function copyCommand(
  commands: readonly Command[],
  from: CommandAddress,
  to: CommandAddress = { path: from.path, index: from.index + 1 },
): Command[] {
  const command = getCommand(commands, from);
  return command ? insertCommand(commands, to, command) : commands as Command[];
}

export const CONDITION_KINDS = [
  "switch",
  "variable",
  "selfSwitch",
  "item",
  "gold",
  "facing",
  "appearance",
  "tileProperty",
  "worldIdle",
  "bgmPlaying",
  "timer",
  "region",
  "ext",
] as const;

/** Runtime-derived conditions remain visible and round-trip intact in the
 * editor, but are not offered by the generic condition form yet. */
const READ_ONLY_CONDITION_KINDS = ["playerMoving"] as const;

export type ConditionKind = (typeof CONDITION_KINDS)[number];
type ReadOnlyConditionKind = (typeof READ_ONLY_CONDITION_KINDS)[number];
type ConditionOf<Kind extends ConditionKind> = Extract<Condition, { kind: Kind }>;
type _EveryConditionKindIsOwned = AssertNoMissing<
  Exclude<Condition["kind"], ConditionKind | ReadOnlyConditionKind>
>;

export function defaultCondition<Kind extends ConditionKind>(kind: Kind): ConditionOf<Kind> {
  let condition: Condition;
  switch (kind) {
    case "switch":
      condition = { kind, id: "switch", value: true };
      break;
    case "variable":
      condition = { kind, id: "variable", op: ">=", value: 0 };
      break;
    case "selfSwitch":
      condition = { kind, key: "A", value: true };
      break;
    case "item":
      condition = { kind, id: "item", count: 1 };
      break;
    case "gold":
      condition = { kind, amount: 0 };
      break;
    case "facing":
      condition = { kind, dir: "down" };
      break;
    case "appearance":
      condition = { kind, target: "this", sprite: null };
      break;
    case "tileProperty":
      condition = { kind, x: 0, y: 0, passage: null };
      break;
    case "worldIdle":
      condition = { kind, negate: false };
      break;
    case "bgmPlaying":
      condition = { kind, negate: false };
      break;
    case "timer":
      condition = { kind, op: ">=", seconds: 0 };
      break;
    case "region":
      condition = { kind, x: 0, y: 0, id: 0 };
      break;
    case "ext":
      condition = { kind, call: "game.condition", args: null };
      break;
  }
  return condition as ConditionOf<Kind>;
}

export function isEditableCondition(
  condition: unknown,
): condition is Condition {
  return isRecord(condition) && CONDITION_KINDS.includes(condition.kind as ConditionKind);
}

export function conditionSummary(condition: unknown, opts: { full?: boolean } = {}): string {
  const full = opts.full === true;
  if (!isRecord(condition)) return "Unknown condition";
  switch (condition.kind) {
    case "switch":
      return `Switch ${text(condition.id)} is ${condition.value === false ? "OFF" : "ON"}`;
    case "variable":
      return `Variable ${text(condition.id)} ${text(condition.op)} ${numberText(condition.value)}`;
    case "selfSwitch":
      return `Self switch ${text(condition.key)} is ${condition.value === false ? "OFF" : "ON"}`;
    case "item":
      return `Item ${text(condition.id)} ×${numberText(condition.count)}`;
    case "gold":
      return `Gold ≥ ${numberText(condition.amount)}`;
    case "facing":
      return `Facing ${text(condition.dir)}`;
    case "appearance":
      return `Appearance ${targetSummary(condition.target)} uses ${condition.sprite === null ? "default sprite" : text(condition.sprite)}`;
    case "tileProperty":
      return `Tile property (${numberText(condition.x)}, ${numberText(condition.y)}) ${jsonPreview({ passage: condition.passage, enter: condition.enter, exit: condition.exit }, 48, full)}`;
    case "region":
      return `Region ${numberText(condition.id)} at (${numberText(condition.x)}, ${numberText(condition.y)})`;
    case "worldIdle":
      return condition.negate === true ? "World is busy" : "World is idle";
    case "playerMoving":
      return condition.negate === true ? "Player is resting" : "Player is moving";
    case "bgmPlaying": {
      const target = typeof condition.id === "string" && condition.id.length > 0
        ? `BGM ${condition.id}`
        : "Any BGM";
      return condition.negate === true ? `${target} is not playing` : `${target} is playing`;
    }
    case "timer":
      return `Timer ${text(condition.op)} ${numberText(condition.seconds)}s`;
    case "ext":
      return `Extension ${text(condition.call)} ${jsonPreview(condition.args, 48, full)}`;
    default:
      return `Unknown condition${typeof condition.kind === "string" ? ` (${condition.kind})` : ""}`;
  }
}

export interface PageConditionClause {
  readonly source: "switch" | "selfSwitch" | "variable" | "item" | "all";
  readonly index?: number;
  readonly condition: Condition;
  readonly summary: string;
  readonly editable: boolean;
  readonly readOnly: boolean;
}

/** Expand legacy flat page gates and compound `all` gates in their evaluation
 * order without mutating or normalizing the authored PageCondition. Entries
 * from `all` (notably extension conditions) retain their original identity. */
export function pageConditionClauses(pageCondition?: PageCondition): PageConditionClause[] {
  if (!pageCondition) return [];
  const clauses: Array<Omit<PageConditionClause, "summary" | "editable" | "readOnly">> = [];
  if (pageCondition.switch !== undefined) {
    clauses.push({ source: "switch", condition: { kind: "switch", id: pageCondition.switch, value: true } });
  }
  if (pageCondition.selfSwitch !== undefined) {
    clauses.push({ source: "selfSwitch", condition: { kind: "selfSwitch", key: pageCondition.selfSwitch, value: true } });
  }
  if (pageCondition.variable !== undefined) {
    clauses.push({ source: "variable", condition: { kind: "variable", ...pageCondition.variable } });
  }
  if (pageCondition.item !== undefined) {
    clauses.push({ source: "item", condition: { kind: "item", id: pageCondition.item, count: 1 } });
  }
  for (const [index, condition] of (pageCondition.all ?? []).entries()) {
    clauses.push({ source: "all", index, condition });
  }
  return clauses.map((entry) => {
    const editable = isEditableCondition(entry.condition);
    return {
      ...entry,
      summary: conditionSummary(entry.condition),
      editable,
      readOnly: !editable,
    };
  });
}

export function pageConditionSummary(pageCondition?: PageCondition, opts: { full?: boolean } = {}): string {
  const clauses = pageConditionClauses(pageCondition);
  return clauses.length === 0 ? "Always" : clauses.map((entry) => conditionSummary(entry.condition, opts)).join(" AND ");
}

/** A page condition containing one default clause. The four legacy kinds use
 * their compact flat spelling; other kinds use `all`. */
export function defaultPageCondition(kind: ConditionKind): PageCondition {
  const condition = defaultCondition(kind);
  switch (condition.kind) {
    case "switch": return { switch: condition.id };
    case "selfSwitch": return { selfSwitch: condition.key };
    case "variable": return { variable: { id: condition.id, op: condition.op, value: condition.value } };
    case "item": return { item: condition.id };
    default: return { all: [condition] };
  }
}

export const BASIC_MOVE_STEPS = [
  "moveDown",
  "moveLeft",
  "moveRight",
  "moveUp",
  "stepForward",
  "faceDown",
  "faceLeft",
  "faceRight",
  "faceUp",
  "wait",
  "turnRandom",
  "turnTowardPlayer",
] as const satisfies readonly MoveStep[];

export type BasicMoveStep = (typeof BASIC_MOVE_STEPS)[number];

export function defaultMoveStep(step: BasicMoveStep = "moveDown"): BasicMoveStep {
  return step;
}

const MOVE_STEP_LABELS: Readonly<Record<BasicMoveStep, string>> = {
  moveDown: "Move down",
  moveLeft: "Move left",
  moveRight: "Move right",
  moveUp: "Move up",
  stepForward: "Step forward",
  faceDown: "Face down",
  faceLeft: "Face left",
  faceRight: "Face right",
  faceUp: "Face up",
  wait: "Wait",
  turnRandom: "Turn randomly",
  turnTowardPlayer: "Turn toward player",
};

export function moveStepSummary(step: unknown): string {
  if (typeof step === "string") return MOVE_STEP_LABELS[step as BasicMoveStep] ?? `Unknown step (${step})`;
  if (!isRecord(step)) return "Unknown step";
  if (isRecord(step.turnToward)) return `Turn toward ${targetSummary(step.turnToward)}`;
  if (step.turnToward === "player") return "Turn toward player";
  if (isRecord(step.pathTo)) {
    return `Path to (${numberText(step.pathTo.x)}, ${numberText(step.pathTo.y)})`;
  }
  if (isRecord(step.approach)) {
    return `Approach ${targetSummary(step.approach.target)}`;
  }
  return `Unknown step ${jsonPreview(step)}`;
}
