// Structured field adapters for the event inspector. They translate the
// editor's small text/enum controls into schema-shaped Page, Condition and
// Command values without exposing raw JSON editing.

import type {
  ChoiceIcon,
  ChoiceOption,
  Command,
  Condition,
  Dir,
  JsonValue,
  MoveRoute,
  MoveSpeed,
  Page,
  PageCondition,
  PictureCoordinate,
  PictureTone,
  ScreenColor,
  TextBoxLayout,
  TransferCoordinate,
  TransferDirection,
  TransferMap,
} from "../../src/engine/types.ts";
import { validateSchema, type Schema } from "../../src/engine/schema-validate.ts";
import {
  BASIC_MOVE_STEPS,
  CONDITION_KINDS,
  defaultCondition,
  flattenCommands,
  isEditableCommand,
  isEditableCondition,
  type BasicMoveStep,
  type ConditionKind,
  type FlatCommandRow,
} from "./commands.ts";
import { PROJECT_SCHEMA } from "./projects.ts";
import {
  EMPTY_EVENT_EDITOR_RESOURCES,
  type EventEditorResources,
} from "./event-resources.ts";

export type FieldKind = "text" | "integer" | "number" | "boolean" | "enum";

export interface EditableField {
  key: string;
  label: string;
  value: string | number | boolean | null;
  kind: FieldKind;
  options?: readonly string[];
  /** Visible guidance for free-text fields, especially project resources. */
  hint?: string;
  /** The handheld editor draws `hint` under the field, wrapped (Studio
   *  shows every hint). Set on fields whose hint names them in Chinese. */
  inlineHint?: boolean;
  readOnly?: boolean;
}

export type FieldEdit<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const DIRS = ["down", "left", "right", "up"] as const;
// eventTouch is last so the long-standing action → playerTouch → autorun →
// parallel cycle order is unchanged; cycling from parallel reaches it.
const TRIGGERS = ["action", "playerTouch", "autorun", "parallel", "eventTouch"] as const;
const MOVE_TYPES = ["static", "random", "approach"] as const;
const BOOLS = ["true", "false"] as const;
const VAR_MODES = [
  "set", "add", "sub", "random", "copy:variable", "add:variable",
  "sub:variable", "mul:variable", "div:variable", "mod:variable",
] as const;
const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;
const SOUND_ID = /^[a-z0-9_-]+$/;
const EXTENSION_CALL = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/;
const OMIT = "(unset)";
const NULL = "null";
const OPTIONAL_BOOLEAN = [OMIT, "true", "false"] as const;
const NULLABLE_BOOLEAN = [OMIT, "true", "false", NULL] as const;
const OPTIONAL_PASSAGE = [OMIT, "pass", "block", NULL] as const;
const ICON_FRAMES = ["0", "1", "2"] as const;
const PICTURE_ORIGINS = ["topLeft", "center"] as const;
const PICTURE_BLENDS = ["normal", "add", "multiply", "screen"] as const;
const PICTURE_EASINGS = ["linear", "easeIn", "easeOut", "easeInOut"] as const;
/** The text window's optional layout fields (schema order) with the value an
 * absent key means. Choosing that default removes the key, so a default text
 * keeps its exact JSON. The hint names the field in Chinese and English. */
const TEXT_LAYOUT = {
  position: { label: "POSITION", hint: "窗口位置 · window position, default bottom", fallback: "bottom", values: ["top", "center", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"] },
  align: { label: "ALIGN", hint: "水平对齐 · row alignment, default left", fallback: "left", values: ["left", "center", "right"] },
  valign: { label: "V-ALIGN", hint: "垂直对齐 · vertical alignment, default top", fallback: "top", values: ["top", "center", "bottom"] },
  background: { label: "BACKGROUND", hint: "窗口背景 · window background, default window", fallback: "window", values: ["window", "dim", "transparent"] },
} as const satisfies Record<keyof TextBoxLayout, { label: string; hint: string; fallback: string; values: readonly string[] }>;
const TEXT_LAYOUT_KEYS = Object.keys(TEXT_LAYOUT) as (keyof TextBoxLayout)[];
const TIMER_ACTIONS = ["start", "stop", "read"] as const;
const CHOICE_OPTION_KEY = /^option:(\d+)(?:\.(icon|icon\.dir|icon\.frame))?$/;
const COMMAND_SCHEMA = (PROJECT_SCHEMA as { $defs: { command: Schema } }).$defs.command;
const CONDITION_SCHEMA = (PROJECT_SCHEMA as { $defs: { condition: Schema } }).$defs.condition;

const field = (
  key: string,
  label: string,
  value: EditableField["value"],
  kind: FieldKind = "text",
  options?: readonly string[],
  readOnly = false,
  hint?: string,
): EditableField => ({
  key,
  label,
  value,
  kind,
  ...(options ? { options } : {}),
  ...(hint ? { hint } : {}),
  ...(readOnly ? { readOnly } : {}),
});

function optionValue(value: unknown): string | number | boolean | null {
  return value === undefined ? OMIT : value === null ? NULL : value as string | number | boolean;
}

function choicesHint(label: string, options: readonly string[]): string {
  return options.length > 0
    ? `${label}: ${options.join(", ")}`
    : `No ${label.toLowerCase()} are declared in this project`;
}

function resourceField(
  key: string,
  label: string,
  value: EditableField["value"],
  options: readonly string[],
  noun: string,
): EditableField {
  return field(key, label, value, "text", options, false, choicesHint(noun, options));
}

function good<T>(value: T): FieldEdit<T> {
  return { ok: true, value };
}

function bad<T>(error: string): FieldEdit<T> {
  return { ok: false, error };
}

function bool(raw: string): boolean | null {
  if (raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "false" || raw === "off" || raw === "no") return false;
  return null;
}

function integer(raw: string, label: string, min?: number, max?: number): FieldEdit<number> {
  if (!/^-?\d+$/.test(raw.trim())) return bad(`${label} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return bad(`${label} is outside the safe integer range`);
  if (min !== undefined && value < min) return bad(`${label} must be at least ${min}`);
  if (max !== undefined && value > max) return bad(`${label} must be at most ${max}`);
  return good(value);
}

function finite(raw: string, label: string, min?: number, max?: number): FieldEdit<number> {
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value)) return bad(`${label} must be a number`);
  if (min !== undefined && value < min) return bad(`${label} must be at least ${min}`);
  if (max !== undefined && value > max) return bad(`${label} must be at most ${max}`);
  return good(value);
}

function enumValue<T extends string>(raw: string, values: readonly T[], label: string): FieldEdit<T> {
  return values.includes(raw as T) ? good(raw as T) : bad(`${label} must be ${values.join(", ")}`);
}

function identifier(raw: string, label: string, pattern = IDENTIFIER): FieldEdit<string> {
  return raw.length > 0 && pattern.test(raw) ? good(raw) : bad(`${label} has invalid characters`);
}

function jsonValue(raw: string, label: string): FieldEdit<JsonValue> {
  try {
    return good(JSON.parse(raw) as JsonValue);
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^JSON\.parse: /, "") : String(error);
    return bad(`${label} must be valid JSON (${reason})`);
  }
}

function schemaError(value: unknown, schema: Schema): string | null {
  const errors = validateSchema(PROJECT_SCHEMA as Schema, value, schema);
  if (errors.length === 0) return null;
  const first = errors[0]!;
  return `${first.path}: ${first.msg}`;
}

function schemaCommand(command: Command): FieldEdit<Command> {
  const error = schemaError(command, COMMAND_SCHEMA);
  return error ? bad(`command does not match the project schema (${error})`) : good(command);
}

function schemaCondition(condition: Condition): FieldEdit<Condition> {
  const error = schemaError(condition, CONDITION_SCHEMA);
  return error ? bad(`condition does not match the project schema (${error})`) : good(condition);
}

function optionalBoolean(raw: string, label: string, nullable: boolean): FieldEdit<boolean | null | undefined> {
  if (raw === OMIT || raw.trim() === "") return good(undefined);
  if (nullable && raw === NULL) return good(null);
  const value = bool(raw);
  return value === null ? bad(`${label} must be true, false${nullable ? ", null" : ""}, or ${OMIT}`) : good(value);
}

function optionalString(raw: string, label: string, nullable: boolean): FieldEdit<string | null | undefined> {
  if (raw === OMIT || raw.trim() === "") return good(undefined);
  if (nullable && raw === NULL) return good(null);
  return raw.length > 0 ? good(raw) : bad(`${label} is required`);
}

function optionalInteger(
  raw: string,
  label: string,
  min?: number,
  max?: number,
  nullable = false,
): FieldEdit<number | null | undefined> {
  if (raw === OMIT || raw.trim() === "") return good(undefined);
  if (nullable && raw === NULL) return good(null);
  return integer(raw, label, min, max);
}

function optionalNumber(raw: string, label: string, min?: number): FieldEdit<number | undefined> {
  if (raw === OMIT || raw.trim() === "") return good(undefined);
  return finite(raw, label, min);
}

function setOptional<T extends object>(value: T, key: string, next: unknown): T {
  const copy = { ...value } as unknown as Record<string, unknown>;
  if (next === undefined) delete copy[key];
  else copy[key] = next;
  return copy as unknown as T;
}

function directionList(raw: string, label: string): FieldEdit<Dir[] | null | undefined> {
  if (raw === OMIT || raw.trim() === "") return good(undefined);
  if (raw === NULL) return good(null);
  if (raw === "[]" || raw.toLowerCase() === "none") return good([]);
  let values: string[];
  if (raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
        return bad(`${label} must be a JSON array of directions`);
      }
      values = parsed;
    } catch {
      return bad(`${label} must be a comma list or JSON array of directions`);
    }
  } else {
    values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  }
  const invalid = values.find((value) => !DIRS.includes(value as Dir));
  if (invalid) return bad(`${label} contains invalid direction ${invalid}`);
  if (new Set(values).size !== values.length) return bad(`${label} directions must be unique`);
  return good(values as Dir[]);
}

function directionListValue(value: Dir[] | null | undefined): string {
  if (value === undefined) return OMIT;
  if (value === null) return NULL;
  return value.length === 0 ? "[]" : value.join(",");
}

function colorFields(color: ScreenColor, prefix = "color."): EditableField[] {
  return (["r", "g", "b", "a"] as const).map((channel) =>
    field(`${prefix}${channel}`, channel.toUpperCase(), color[channel], "integer"));
}

function editColor(color: ScreenColor, key: string, raw: string): FieldEdit<ScreenColor> {
  if (!(key === "r" || key === "g" || key === "b" || key === "a")) return bad(`unknown color channel ${key}`);
  const value = integer(raw, key, 0, 255);
  return value.ok ? good({ ...color, [key]: value.value }) : value;
}

function pictureToneFields(tone: PictureTone): EditableField[] {
  return (["r", "g", "b", "gray"] as const).map((channel) =>
    field(`tone.${channel}`, channel.toUpperCase(), tone[channel], "integer"));
}

function editPictureTone(tone: PictureTone, key: string, raw: string): FieldEdit<PictureTone> {
  if (!(key === "r" || key === "g" || key === "b" || key === "gray")) return bad(`unknown picture tone channel ${key}`);
  const value = integer(raw, key, key === "gray" ? 0 : -255, 255);
  return value.ok ? good({ ...tone, [key]: value.value }) : value;
}

function cameraTarget(value: Extract<Command, { op: "camera" }>["target"]): string {
  if (typeof value === "object" && "x" in value) return `tile:${value.x},${value.y}`;
  return target(value);
}

function parseCameraTarget(raw: string): FieldEdit<Extract<Command, { op: "camera" }>["target"]> {
  if (raw.startsWith("tile:")) {
    const match = /^tile:(\d+),(\d+)$/.exec(raw);
    return match ? good({ x: Number(match[1]), y: Number(match[2]) }) : bad("camera target tile must use tile:<x>,<y>");
  }
  return parseTarget(raw, true);
}

export function nextFieldValue(field: EditableField, delta = 1): string {
  if (field.kind === "boolean") return field.value === true || String(field.value).toLowerCase() === "true" ? "false" : "true";
  if (field.kind !== "enum" || !field.options?.length) return String(field.value ?? "");
  const at = Math.max(0, field.options.indexOf(String(field.value)));
  return field.options[(at + delta + field.options.length) % field.options.length]!;
}

function variableMode(command: Extract<Command, { op: "variable" }>): string {
  return "from" in command.set ? `${command.set.op}:variable` : command.set.op;
}

function operand(value: TransferMap | TransferCoordinate | TransferDirection): string | number {
  return typeof value === "object" ? `$${value.variable}` : value;
}

function target(value: "player" | "this" | { event: string }): string {
  return typeof value === "object" ? `event:${value.event}` : value;
}

function routeSteps(route: MoveRoute): string {
  return route.steps.map((step) => typeof step === "string" ? step : JSON.stringify(step)).join(",");
}

/** One choice row: its label, then an icon sprite (OMIT = text only). Facing
 * and pose fields exist only once a sprite is chosen. */
function choiceOptionFields(option: ChoiceOption, i: number, resources: EventEditorResources): EditableField[] {
  const key = `option:${i}`;
  const fields = [
    field(key, `OPTION ${i + 1}`, option.text),
    resourceField(`${key}.icon`, `ICON ${i + 1}`, option.icon?.sprite ?? OMIT, resources.sprites, `Project sprites; use ${OMIT} for a text-only option`),
  ];
  if (option.icon) {
    fields.push(
      field(`${key}.icon.dir`, `ICON ${i + 1} DIR`, option.icon.dir ?? "down", "enum", DIRS),
      field(`${key}.icon.frame`, `ICON ${i + 1} FRAME`, String(option.icon.frame ?? 0), "enum", ICON_FRAMES),
    );
  }
  return fields;
}

/** Canonical icon spelling: sprite, dir, frame in schema order, with the
 * runtime defaults (down, frame 0) omitted. */
function choiceIcon(sprite: string, dir: Dir | undefined, frame: ChoiceIcon["frame"]): ChoiceIcon {
  return {
    sprite,
    ...(dir === undefined || dir === "down" ? {} : { dir }),
    ...(frame === undefined || frame === 0 ? {} : { frame }),
  };
}

/** Replace an option's icon while keeping `text` first and `icon` before
 * `commands`; `undefined` removes the key entirely. */
function withChoiceIcon(option: ChoiceOption, icon: ChoiceIcon | undefined): ChoiceOption {
  const { text, icon: _, ...rest } = option;
  return { text, ...(icon ? { icon } : {}), ...rest };
}

function editChoiceIcon(option: ChoiceOption, part: string, raw: string): FieldEdit<ChoiceOption> {
  if (part === "icon") {
    const sprite = optionalString(raw, "icon sprite", false);
    if (!sprite.ok) return sprite;
    if (sprite.value == null) return good(withChoiceIcon(option, undefined));
    return good(withChoiceIcon(option, choiceIcon(sprite.value, option.icon?.dir, option.icon?.frame)));
  }
  if (!option.icon) return bad("choose an icon sprite before its direction or frame");
  if (part === "icon.dir") {
    const dir = enumValue(raw, DIRS, "icon direction");
    return dir.ok ? good(withChoiceIcon(option, choiceIcon(option.icon.sprite, dir.value, option.icon.frame))) : dir;
  }
  const frame = enumValue(raw, ICON_FRAMES, "icon frame");
  return frame.ok
    ? good(withChoiceIcon(option, choiceIcon(option.icon.sprite, option.icon.dir, Number(frame.value) as ChoiceIcon["frame"])))
    : frame;
}

export function conditionFields(
  condition: Condition,
  prefix = "",
  resources: EventEditorResources = EMPTY_EVENT_EDITOR_RESOURCES,
): EditableField[] {
  const p = (name: string) => `${prefix}${name}`;
  switch (condition.kind) {
    case "switch":
      return [field(p("id"), "ID", condition.id), field(p("value"), "VALUE", condition.value ?? true, "boolean", BOOLS)];
    case "variable":
      return [
        field(p("id"), "ID", condition.id),
        field(p("op"), "OP", condition.op, "enum", [">=", "<=", "==", "!="]),
        field(p("value"), "VALUE", condition.value, "integer"),
      ];
    case "selfSwitch":
      return [field(p("key"), "KEY", condition.key, "enum", ["A", "B", "C", "D"]), field(p("value"), "VALUE", condition.value ?? true, "boolean", BOOLS)];
    case "item":
      return [resourceField(p("id"), "ITEM", condition.id, resources.items, "Project items"), field(p("count"), "COUNT", condition.count, "integer")];
    case "gold":
      return [field(p("amount"), "AMOUNT", condition.amount, "integer")];
    case "facing":
      return [field(p("dir"), "DIR", condition.dir, "enum", DIRS)];
    case "worldIdle":
      return [field(p("negate"), "NEGATE", condition.negate ?? false, "boolean", BOOLS)];
    case "playerMoving":
      return [field(p("negate"), "NEGATE", condition.negate ?? false, "boolean", BOOLS)];
    case "bgmPlaying":
      return [
        resourceField(p("id"), "BGM", condition.id ?? "(any)", resources.audio, "Project audio ids; use (any) for any BGM"),
        field(p("negate"), "NEGATE", condition.negate ?? false, "boolean", BOOLS),
      ];
    case "timer":
      return [
        field(p("op"), "OP", condition.op, "enum", [">=", "<="]),
        field(p("seconds"), "SECONDS", condition.seconds, "number"),
      ];
    case "ext":
      return [
        resourceField(p("call"), "CALL", condition.call, resources.extensionCalls, "Authored extension calls"),
        field(p("args"), "ARGS JSON", JSON.stringify(condition.args)),
      ];
    case "appearance":
      return [
        field(p("target"), "TARGET", target(condition.target)),
        resourceField(p("sprite"), "SPRITE", condition.sprite ?? NULL, resources.sprites, "Project sprites; use null for the default"),
      ];
    case "tileProperty":
      return [
        field(p("x"), "X", condition.x, "integer"), field(p("y"), "Y", condition.y, "integer"),
        field(p("passage"), "PASSAGE", optionValue(condition.passage), "enum", OPTIONAL_PASSAGE),
        field(p("enter"), "ENTER", directionListValue(condition.enter)),
        field(p("exit"), "EXIT", directionListValue(condition.exit)),
      ];
    case "region":
      return [
        field(p("x"), "X", condition.x, "integer"),
        field(p("y"), "Y", condition.y, "integer"),
        field(p("id"), "REGION", condition.id, "integer"),
      ];
  }
}

export function commandFields(
  command: Command,
  resources: EventEditorResources = EMPTY_EVENT_EDITOR_RESOURCES,
): EditableField[] {
  switch (command.op) {
    case "text":
      return [
        field("lines", "LINES", command.lines.join("\n")),
        field("cps", "CPS", command.cps ?? "", "integer"),
        ...TEXT_LAYOUT_KEYS.map((key) => {
          const { label, hint, fallback, values } = TEXT_LAYOUT[key];
          return { ...field(key, label, command[key] ?? fallback, "enum", values), hint, inlineHint: true };
        }),
      ];
    case "choices":
      return [
        field("prompt", "PROMPT", command.prompt),
        field("optionCount", "OPTIONS", command.options.length, "integer"),
        ...command.options.flatMap((option, i) => choiceOptionFields(option, i, resources)),
        field("cancel", "CANCEL", command.cancel !== undefined, "boolean", BOOLS),
      ];
    case "switch":
      return [field("id", "ID", command.id), field("value", "VALUE", command.value, "boolean", BOOLS)];
    case "variable": {
      const fields = [field("id", "ID", command.id), field("mode", "MODE", variableMode(command), "enum", VAR_MODES)];
      if (command.set.op === "random") {
        fields.push(field("min", "MIN", command.set.min, "integer"), field("max", "MAX", command.set.max, "integer"));
      } else if ("from" in command.set) {
        fields.push(field("from", "FROM", command.set.from));
      } else {
        fields.push(field("value", "VALUE", command.set.value, "integer"));
      }
      return fields;
    }
    case "selfSwitch":
      return [field("key", "KEY", command.key, "enum", ["A", "B", "C", "D"]), field("value", "VALUE", command.value, "boolean", BOOLS)];
    case "if": {
      const conditionReadOnly = !isEditableCondition(command.if);
      return [
        field("if.kind", "KIND", command.if.kind, "enum", CONDITION_KINDS, conditionReadOnly),
        ...conditionFields(command.if, "if.", resources),
        field("else", "ELSE", command.else !== undefined, "boolean", BOOLS),
      ];
    }
    case "transfer":
      return [
        resourceField("map", "MAP", operand(command.map), resources.maps, "Project maps"), field("x", "X", operand(command.x)),
        field("y", "Y", operand(command.y)), field("dir", "DIR", command.dir ? operand(command.dir) : "keep"),
        field("fade", "FADE", command.fade ?? "", "number"),
      ];
    case "moveRoute":
      return [
        field("target", "TARGET", target(command.target)), field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
        field("steps", "STEPS", routeSteps(command.route)),
        field("repeat", "REPEAT", command.route.repeat, "boolean", BOOLS),
        field("skippable", "SKIP", command.route.skippable, "boolean", BOOLS),
      ];
    case "wait": return [field("seconds", "SECONDS", command.seconds, "number")];
    case "gold": return [field("set", "MODE", command.set, "enum", ["add", "sub"]), field("amount", "AMOUNT", command.amount, "integer")];
    case "item": return [resourceField("item", "ITEM", command.item, resources.items, "Project items"), field("set", "MODE", command.set, "enum", ["add", "sub"]), field("count", "COUNT", command.count, "integer")];
    case "se": return [resourceField("name", "NAME", command.name, resources.audio, "Project audio ids"), field("volume", "VOLUME", command.volume ?? "", "integer"), field("pitch", "PITCH", command.pitch ?? "", "integer")];
    case "playBgm":
    case "playBgs":
    case "playSe":
      return [
        resourceField("id", "ID", command.id, resources.audio, "Project audio ids"),
        field("volume", "VOLUME", command.volume ?? "", "integer"),
        field("pitch", "PITCH", command.pitch ?? "", "integer"),
      ];
    case "playMe":
      return [
        resourceField("id", "ID", command.id, resources.audio, "Project audio ids"),
        field("duration", "DURATION", command.duration, "number"),
        field("volume", "VOLUME", command.volume ?? "", "integer"),
        field("pitch", "PITCH", command.pitch ?? "", "integer"),
      ];
    case "fadeoutBgm":
    case "fadeoutBgs":
      return [field("duration", "DURATION", command.duration, "number")];
    case "common": return [resourceField("id", "ID", command.id, resources.commonEvents, "Common events")];
    case "place": return [field("target", "TARGET", target(command.target)), field("x", "X", command.x, "integer"), field("y", "Y", command.y, "integer"), field("dir", "DIR", command.dir ?? "down", "enum", DIRS)];
    case "erase":
    case "exit":
    case "openMenu":
    case "openSave":
    case "autosave":
    case "gameOver":
    case "returnTitle":
    case "lockInput":
    case "unlockInput":
    case "break":
    case "stopSe":
    // A loop's only payload is its body, edited as a nested command branch.
    case "loop": return [];
    case "label":
    case "jumpLabel":
      return [field("name", "NAME", command.name)];
    case "moveControl": {
      const fields = [
        field("target", "TARGET", target(command.target)),
        field("control.kind", "CONTROL", command.control.kind, "enum", [
          "wander", "moveType", "stop", "speed", "routeSpeed", "run", "frequency", "directionFix", "through", "facingMode",
        ]),
      ];
      switch (command.control.kind) {
        case "wander":
          fields.push(
            field("control.bounds", "BOUNDS", command.control.bounds
              ? `${command.control.bounds.x},${command.control.bounds.y},${command.control.bounds.width},${command.control.bounds.height}`
              : OMIT),
            field("control.frequency", "FREQUENCY", command.control.frequency ?? OMIT, "integer"),
            field("control.intervalTicks", "INTERVAL TICKS", command.control.intervalTicks ?? OMIT, "integer"),
          );
          break;
        case "moveType":
          fields.push(field("control.value", "VALUE", command.control.value, "enum", ["page", "static", "approach"]));
          break;
        case "speed":
        case "routeSpeed":
        case "frequency":
          fields.push(field("control.value", "VALUE", command.control.value, "integer"));
          break;
        case "run":
        case "directionFix":
        case "through":
          fields.push(field("control.value", "VALUE", command.control.value, "boolean", BOOLS));
          break;
        case "facingMode":
          fields.push(field("control.value", "VALUE", command.control.value, "enum", ["followMovement", "locked", "scripted"]));
          break;
        case "stop":
          break;
      }
      return fields;
    }
    case "appearance":
      return [
        field("target", "TARGET", target(command.target)),
        resourceField("sprite", "SPRITE", optionValue(command.sprite), resources.sprites, `Project sprites; use ${NULL} to reset or ${OMIT} to leave unchanged`),
        field("opacity", "OPACITY", optionValue(command.opacity), "text", undefined, false, `0-255, ${NULL}, or ${OMIT}`),
        field("visible", "VISIBLE", optionValue(command.visible), "enum", NULLABLE_BOOLEAN),
        field("saveDefault", "SAVE DEFAULT", command.saveDefault ?? false, "boolean", BOOLS),
      ];
    case "layer":
      return [
        resourceField("layer", "LAYER", command.layer, resources.layers, "Authored presentation layers"),
        field("visible", "VISIBLE", optionValue(command.visible), "enum", NULLABLE_BOOLEAN),
        resourceField("variant", "VARIANT", optionValue(command.variant), resources.layerVariants[command.layer] ?? [], `Authored variants for ${command.layer}; use ${NULL} to reset or ${OMIT} to leave unchanged`),
      ];
    case "changeParallax":
      return [
        resourceField("image", "IMAGE", command.image ?? NULL, resources.parallaxes, `Authored parallax ids; use ${NULL} to clear`),
        field("loopX", "LOOP X", command.loopX, "boolean", BOOLS),
        field("loopY", "LOOP Y", command.loopY, "boolean", BOOLS),
        field("sx", "SPEED X", command.sx, "number"),
        field("sy", "SPEED Y", command.sy, "number"),
        field("zero", "ZERO PARALLAX", command.zero ?? false, "boolean", BOOLS),
      ];
    case "tileProperty":
      return [
        field("x", "X", command.x, "integer"), field("y", "Y", command.y, "integer"),
        field("passage", "PASSAGE", optionValue(command.passage), "enum", OPTIONAL_PASSAGE),
        field("enter", "ENTER", directionListValue(command.enter), "text", undefined, false, `Comma-separated directions, [], ${NULL}, or ${OMIT}`),
        field("exit", "EXIT", directionListValue(command.exit), "text", undefined, false, `Comma-separated directions, [], ${NULL}, or ${OMIT}`),
      ];
    case "screenFade":
      return [
        field("direction", "DIRECTION", command.direction, "enum", ["out", "in"]),
        field("duration", "DURATION", command.duration, "number"),
        field("color", "COLOR", command.color === undefined ? OMIT : `${command.color.r},${command.color.g},${command.color.b},${command.color.a}`),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "screenTint":
      return [
        resourceField("layer", "LAYER", command.layer, resources.layers, "Authored presentation layers"),
        ...colorFields(command.color),
        field("duration", "DURATION", command.duration, "number"),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "screenFlash":
      return [
        ...colorFields(command.color),
        field("intensity", "INTENSITY", command.intensity, "integer"),
        field("duration", "DURATION", command.duration, "number"),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "screenShake":
      return [
        field("strength", "STRENGTH", command.strength, "number"),
        field("speed", "SPEED", command.speed, "number"),
        field("duration", "DURATION", command.duration, "number"),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "camera":
      return [
        field("target", "TARGET", cameraTarget(command.target), "text", undefined, false, "player, this, event:<id>, or tile:<x>,<y>"),
        field("duration", "DURATION", command.duration, "number"),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "scrollMap":
      return [
        field("direction", "DIRECTION", command.direction, "enum", DIRS),
        field("distance", "DISTANCE", command.distance, "number"),
        field("speed", "SPEED", String(command.speed), "enum", ["1", "2", "3", "4", "5", "6"]),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "balloon":
      return [
        field("target", "TARGET", target(command.target)),
        resourceField("icon", "ICON", command.icon ?? OMIT, resources.animations, `Project animations; use ${OMIT} to clear`),
        field("duration", "DURATION", command.duration ?? OMIT, "number", undefined, false, `Non-negative seconds or ${OMIT}`),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "screenBackdrop":
      return [
        resourceField("layer", "LAYER", command.layer, resources.layers, "Authored backdrop layers"),
        resourceField("variant", "BACKGROUND", optionValue(command.variant), resources.layerVariants[command.layer] ?? [], `Authored backgrounds for ${command.layer}; use ${NULL} or ${OMIT} to close`),
      ];
    case "showPicture":
      return [
        field("id", "PICTURE", command.id, "integer"),
        resourceField("layer", "LAYER", command.layer, resources.layers, "Authored picture layers"),
        resourceField("variant", "IMAGE", command.variant, resources.layerVariants[command.layer] ?? [], `Authored variants for ${command.layer}`),
        field("origin", "ORIGIN", command.origin ?? "topLeft", "enum", PICTURE_ORIGINS),
        field("x", "X", operand(command.x)),
        field("y", "Y", operand(command.y)),
        field("scaleX", "SCALE X", command.scaleX ?? 100, "number"),
        field("scaleY", "SCALE Y", command.scaleY ?? 100, "number"),
        field("opacity", "OPACITY", command.opacity ?? 255, "number"),
        field("blend", "BLEND", command.blend ?? "normal", "enum", PICTURE_BLENDS),
      ];
    case "movePicture":
      return [
        field("id", "PICTURE", command.id, "integer"),
        field("origin", "ORIGIN", command.origin ?? "topLeft", "enum", PICTURE_ORIGINS),
        field("x", "X", operand(command.x)),
        field("y", "Y", operand(command.y)),
        field("scaleX", "SCALE X", command.scaleX, "number"),
        field("scaleY", "SCALE Y", command.scaleY, "number"),
        field("opacity", "OPACITY", command.opacity, "number"),
        field("blend", "BLEND", command.blend ?? "normal", "enum", PICTURE_BLENDS),
        field("duration", "DURATION", command.duration, "number"),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
        field("easing", "EASING", command.easing ?? "linear", "enum", PICTURE_EASINGS),
      ];
    case "rotatePicture":
      return [field("id", "PICTURE", command.id, "integer"), field("speed", "SPEED", command.speed, "number")];
    case "tintPicture":
      return [
        field("id", "PICTURE", command.id, "integer"),
        ...pictureToneFields(command.tone),
        field("duration", "DURATION", command.duration, "number"),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "erasePicture":
      return [field("id", "PICTURE", command.id, "integer")];
    case "timer":
      return [
        field("action", "ACTION", command.action, "enum", TIMER_ACTIONS),
        ...(command.action === "start"
          ? [field("seconds", "SECONDS", command.seconds, "number")]
          : command.action === "read"
            ? [field("variable", "VARIABLE", command.variable)]
            : []),
      ];
    case "inputNumber":
      return [field("variable", "VARIABLE", command.variable), field("digits", "DIGITS", command.digits, "integer")];
    case "selectItem":
      return [
        field("variable", "VARIABLE", command.variable),
        field("itemType", "TYPE", command.itemType, "enum", ["regular", "key", "hiddenA", "hiddenB"]),
      ];
    case "changeName":
      return [field("name", "NAME", command.name)];
    case "mapNameDisplay":
      return [field("visible", "VISIBLE", command.visible, "boolean", BOOLS)];
    case "menuAccess":
      return [field("enabled", "ENABLED", command.enabled, "boolean", BOOLS)];
    case "saveAccess":
      return [field("enabled", "ENABLED", command.enabled, "boolean", BOOLS)];
    case "locationInfo":
      return [
        field("variable", "VARIABLE", command.variable),
        field("x", "X", operand(command.x)),
        field("y", "Y", operand(command.y)),
        field("kind", "KIND", command.kind, "enum", ["terrain", "event", "tile", "region"]),
        field("layer", "LAYER", command.layer ?? 0, "integer"),
      ];
    case "shop":
      return [
        field("id", "ID", command.id),
        field("goods", "GOODS JSON", JSON.stringify(command.goods), "text", resources.items, false, choicesHint("Project item ids", resources.items)),
        field("sell", "SELL", command.sell ?? true, "boolean", BOOLS),
        field("sellList", "SELL LIST", command.sellList ?? "disable", "enum", ["disable", "hide"]),
      ];
    case "mapAnim":
      return [
        field("id", "INSTANCE", command.id),
        resourceField("anim", "ANIMATION", command.anim, resources.animations, "Project animations"),
        field("placement", "PLACEMENT", command.target === undefined ? "tile" : "target", "enum", ["tile", "target"]),
        ...(command.target === undefined
          ? [field("x", "X", command.x ?? 0, "integer"), field("y", "Y", command.y ?? 0, "integer")]
          : [field("target", "TARGET", target(command.target))]),
        field("follow", "FOLLOW", command.follow ?? true, "boolean", BOOLS),
        field("layer", "LAYER", command.layer ?? "above", "enum", ["below", "above"]),
        field("loop", "LOOP", command.loop ?? OMIT, "enum", OPTIONAL_BOOLEAN),
        field("wait", "WAIT", command.wait ?? false, "boolean", BOOLS),
      ];
    case "stopAnim":
      return [
        field("selector", "SELECTOR", command.id !== undefined ? "id" : command.anim !== undefined ? "anim" : "all", "enum", ["all", "id", "anim"]),
        ...(command.id !== undefined
          ? [resourceField("id", "INSTANCE", command.id, resources.animationInstances, "Authored animation instance ids")]
          : command.anim !== undefined
            ? [resourceField("anim", "ANIMATION", command.anim, resources.animations, "Project animations")]
            : []),
      ];
    case "ext":
      return [
        resourceField("call", "CALL", command.call, resources.extensionCalls, "Authored extension calls"),
        field("args", "ARGS JSON", JSON.stringify(command.args)),
      ];
    case "extChoice":
      return [
        resourceField("call", "CALL", command.call, resources.extensionCalls, "Authored extension calls"),
        field("args", "ARGS JSON", JSON.stringify(command.args)),
        field("prompt", "PROMPT", command.prompt),
        field("cancel", "CANCEL", command.cancel ?? false, "boolean", BOOLS),
        field("write", "WRITE JSON", command.write === undefined ? OMIT : JSON.stringify(command.write), "text", undefined, false, `Object with index/key/cancelled variable ids, or ${OMIT}`),
      ];
    case "battle":
      return [field("setup", "SETUP JSON", JSON.stringify(command.setup))];
    case "stopBgm":
    case "pauseBgm":
    case "resumeBgm":
    case "saveBgm":
    case "replayBgm": return [];
    case "scene":
      return [
        field("id", "SCENE ID", command.id),
        field("args", "ARGS JSON", command.args === undefined ? OMIT : JSON.stringify(command.args), "text", undefined, false, `JSON value passed to the scene, or ${OMIT}`),
      ];
  }
}

export type InspectorCommandRow = FlatCommandRow & {
  fields: readonly EditableField[];
  supported: boolean;
};

export function commandInspectorRows(
  commands: readonly Command[],
  resources: EventEditorResources = EMPTY_EVENT_EDITOR_RESOURCES,
): InspectorCommandRow[] {
  return flattenCommands(commands).map((row) => ({
    ...row,
    fields: commandFields(row.command, resources),
    supported: isEditableCommand(row.command),
  }));
}

function editConditionUnchecked(condition: Condition, key: string, raw: string): FieldEdit<Condition> {
  if (condition.kind === "switch") {
    if (key === "id") return identifier(raw, "switch id").ok ? good({ ...condition, id: raw }) : bad("switch id has invalid characters");
    if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...condition, value }); }
  } else if (condition.kind === "variable") {
    if (key === "id") return identifier(raw, "variable id").ok ? good({ ...condition, id: raw }) : bad("variable id has invalid characters");
    if (key === "op") { const value = enumValue(raw, [">=", "<=", "==", "!="] as const, "operator"); return value.ok ? good({ ...condition, op: value.value }) : value; }
    if (key === "value") { const value = integer(raw, "value"); return value.ok ? good({ ...condition, value: value.value }) : value; }
  } else if (condition.kind === "selfSwitch") {
    if (key === "key") { const value = enumValue(raw, ["A", "B", "C", "D"] as const, "self switch"); return value.ok ? good({ ...condition, key: value.value }) : value; }
    if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...condition, value }); }
  } else if (condition.kind === "item") {
    if (key === "id") return raw ? good({ ...condition, id: raw }) : bad("item id is required");
    if (key === "count") { const value = integer(raw, "count", 1); return value.ok ? good({ ...condition, count: value.value }) : value; }
  } else if (condition.kind === "gold" && key === "amount") {
    const value = integer(raw, "amount", 0); return value.ok ? good({ ...condition, amount: value.value }) : value;
  } else if (condition.kind === "facing" && key === "dir") {
    const value = enumValue(raw, DIRS, "direction"); return value.ok ? good({ ...condition, dir: value.value }) : value;
  } else if (condition.kind === "worldIdle" && key === "negate") {
    const value = bool(raw); return value === null ? bad("negate must be true or false") : good({ ...condition, negate: value });
  } else if (condition.kind === "bgmPlaying") {
    if (key === "id") {
      if (raw === "(any)" || raw.trim() === "") return good(setOptional(condition, "id", undefined));
      return good({ ...condition, id: raw });
    }
    if (key === "negate") {
      const value = bool(raw); return value === null ? bad("negate must be true or false") : good({ ...condition, negate: value });
    }
  } else if (condition.kind === "timer") {
    if (key === "op") {
      const value = enumValue(raw, [">=", "<="] as const, "timer operator");
      return value.ok ? good({ ...condition, op: value.value }) : value;
    }
    if (key === "seconds") {
      const value = finite(raw, "timer seconds", 0);
      return value.ok ? good({ ...condition, seconds: value.value }) : value;
    }
  } else if (condition.kind === "ext") {
    if (key === "call") {
      const value = identifier(raw, "extension call", EXTENSION_CALL);
      return value.ok ? good({ ...condition, call: value.value }) : value;
    }
    if (key === "args") {
      const value = jsonValue(raw, "extension args");
      return value.ok ? good({ ...condition, args: value.value }) : value;
    }
  } else if (condition.kind === "appearance") {
    if (key === "target") {
      const value = parseTarget(raw, true);
      return value.ok ? good({ ...condition, target: value.value }) : value;
    }
    if (key === "sprite") {
      if (raw === NULL) return good({ ...condition, sprite: null });
      return raw.length > 0 ? good({ ...condition, sprite: raw }) : bad("sprite is required; use null for the default");
    }
  } else if (condition.kind === "tileProperty") {
    if (key === "x" || key === "y") {
      const value = integer(raw, key, 0);
      return value.ok ? good({ ...condition, [key]: value.value }) : value;
    }
    if (key === "passage") {
      const value = raw === OMIT || raw.trim() === ""
        ? good(undefined)
        : raw === NULL
          ? good(null)
          : enumValue(raw, ["pass", "block"] as const, "passage");
      return value.ok ? good(setOptional(condition, key, value.value)) : value;
    }
    if (key === "enter" || key === "exit") {
      const value = directionList(raw, key);
      return value.ok ? good(setOptional(condition, key, value.value)) : value;
    }
  } else if (condition.kind === "region") {
    if (key === "x" || key === "y") {
      const value = integer(raw, key, 0);
      return value.ok ? good({ ...condition, [key]: value.value }) : value;
    }
    if (key === "id") {
      // Region 0 is schema-valid: it matches every unmarked cell (the
      // regions plane only lists nonzero ids), so the editor must accept it.
      const value = integer(raw, "region id", 0, 255);
      return value.ok ? good({ ...condition, id: value.value }) : value;
    }
  }
  return bad(`field ${key} is not editable`);
}

function editCondition(condition: Condition, key: string, raw: string): FieldEdit<Condition> {
  const edited = editConditionUnchecked(condition, key, raw);
  return edited.ok ? schemaCondition(edited.value) : edited;
}

function parseTarget(raw: string, allowPlayer: boolean): FieldEdit<"player" | "this" | { event: string }> {
  if (raw === "this" || (allowPlayer && raw === "player")) return good(raw);
  const id = raw.startsWith("event:") ? raw.slice(6) : raw;
  return identifier(id, "event id").ok ? good({ event: id }) : bad("target must be this, player, or event:<id>");
}

function parseOperand(raw: string, label: string, numeric: boolean): FieldEdit<string | number | { variable: string }> {
  if (raw.startsWith("$") && raw.length > 1) return good({ variable: raw.slice(1) });
  if (!numeric) return raw ? good(raw) : bad(`${label} is required`);
  return integer(raw, label, 0);
}

function parsePictureCoordinate(raw: string, label: string): FieldEdit<PictureCoordinate> {
  if (raw.startsWith("$") && raw.length > 1) return good({ variable: raw.slice(1) });
  return finite(raw, label);
}

function parseSteps(raw: string, requireOne: boolean): FieldEdit<BasicMoveStep[]> {
  const steps = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (requireOne && steps.length === 0) return bad("route needs at least one step");
  const unknown = steps.find((step) => !BASIC_MOVE_STEPS.includes(step as BasicMoveStep));
  return unknown ? bad(`unsupported move step ${unknown}`) : good(steps as BasicMoveStep[]);
}

function commaIntegers(
  raw: string,
  label: string,
  count: number,
  ranges: readonly { min: number; max?: number }[],
): FieldEdit<number[]> {
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length !== count) return bad(`${label} must contain ${count} comma-separated integers`);
  const values: number[] = [];
  for (let index = 0; index < parts.length; index++) {
    const parsed = integer(parts[index]!, `${label} value ${index + 1}`, ranges[index]!.min, ranges[index]!.max);
    if (!parsed.ok) return parsed;
    values.push(parsed.value);
  }
  return good(values);
}

function parseOptionalColor(raw: string): FieldEdit<ScreenColor | undefined> {
  if (raw === OMIT || raw.trim() === "") return good(undefined);
  const values = commaIntegers(raw, "color", 4, [
    { min: 0, max: 255 }, { min: 0, max: 255 }, { min: 0, max: 255 }, { min: 0, max: 255 },
  ]);
  return values.ok
    ? good({ r: values.value[0]!, g: values.value[1]!, b: values.value[2]!, a: values.value[3]! })
    : values;
}

function parseWanderBounds(raw: string): FieldEdit<{ x: number; y: number; width: number; height: number } | undefined> {
  if (raw === OMIT || raw.trim() === "") return good(undefined);
  const values = commaIntegers(raw, "bounds", 4, [
    { min: 0 }, { min: 0 }, { min: 1 }, { min: 1 },
  ]);
  return values.ok
    ? good({ x: values.value[0]!, y: values.value[1]!, width: values.value[2]!, height: values.value[3]! })
    : values;
}

function editCommandFieldUnchecked(command: Command, key: string, raw: string): FieldEdit<Command> {
  switch (command.op) {
    case "text": {
      if (key === "lines") {
        const lines = raw.split("\n");
        if (lines.length < 1 || lines.length > 4 || lines.some((line) => line.length > 52)) return bad("text needs 1-4 lines of at most 52 characters");
        return good({ ...command, lines });
      }
      if (key === "cps") {
        if (raw.trim() === "") { const { cps: _, ...rest } = command; return good(rest); }
        const value = integer(raw, "cps", 1, 120); return value.ok ? good({ ...command, cps: value.value }) : value;
      }
      if (Object.hasOwn(TEXT_LAYOUT, key)) {
        const layoutKey = key as keyof TextBoxLayout;
        const { fallback, values } = TEXT_LAYOUT[layoutKey];
        const value = enumValue<string>(raw, values, `text ${layoutKey}`);
        if (!value.ok) return value;
        if (value.value !== fallback) return good({ ...command, [layoutKey]: value.value });
        const { [layoutKey]: _, ...rest } = command;
        return good(rest);
      }
      break;
    }
    case "choices": {
      if (key === "prompt") return raw.length <= 52 ? good({ ...command, prompt: raw }) : bad("prompt is longer than 52 characters");
      if (key === "optionCount") {
        const count = integer(raw, "option count", 2, 8);
        if (!count.ok) return count;
        const options = command.options.slice(0, count.value);
        while (options.length < count.value) options.push({ text: `Option ${options.length + 1}`, commands: [] });
        return good({ ...command, options });
      }
      if (key.startsWith("option:")) {
        const match = CHOICE_OPTION_KEY.exec(key);
        const at = match ? Number(match[1]) : NaN;
        if (!Number.isInteger(at) || !command.options[at]) return bad("choice option does not exist");
        const options = command.options.slice();
        if (match![2]) {
          const edited = editChoiceIcon(options[at]!, match![2], raw);
          if (!edited.ok) return edited;
          options[at] = edited.value;
          return good({ ...command, options });
        }
        if (raw.length < 1 || raw.length > 64) return bad("choice text needs 1-64 characters");
        options[at] = { ...options[at]!, text: raw };
        return good({ ...command, options });
      }
      if (key === "cancel") {
        const value = bool(raw);
        if (value === null) return bad("cancel must be true or false");
        if (value) return good({ ...command, cancel: command.cancel ?? { commands: [] } });
        const { cancel: _, ...rest } = command;
        return good(rest);
      }
      break;
    }
    case "switch": {
      if (key === "id") { const value = identifier(raw, "switch id"); return value.ok ? good({ ...command, id: value.value }) : value; }
      if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...command, value }); }
      break;
    }
    case "variable": {
      if (key === "id") { const value = identifier(raw, "variable id"); return value.ok ? good({ ...command, id: value.value }) : value; }
      if (key === "mode") {
        const mode = enumValue(raw, VAR_MODES, "variable mode");
        if (!mode.ok) return mode;
        if (mode.value === "random") return good({ ...command, set: { op: "random", min: 0, max: 1 } });
        if (mode.value.endsWith(":variable")) return good({ ...command, set: { op: mode.value.slice(0, -9) as "copy" | "add" | "sub" | "mul" | "div" | "mod", from: "variable" } });
        return good({ ...command, set: { op: mode.value as "set" | "add" | "sub", value: 0 } });
      }
      if (key === "value" && !("from" in command.set) && command.set.op !== "random") { const value = integer(raw, "value"); return value.ok ? good({ ...command, set: { ...command.set, value: value.value } }) : value; }
      if (key === "from" && "from" in command.set) { const value = identifier(raw, "source variable"); return value.ok ? good({ ...command, set: { ...command.set, from: value.value } }) : value; }
      if ((key === "min" || key === "max") && command.set.op === "random") { const value = integer(raw, key); return value.ok ? good({ ...command, set: { ...command.set, [key]: value.value } }) : value; }
      break;
    }
    case "selfSwitch": {
      if (key === "key") { const value = enumValue(raw, ["A", "B", "C", "D"] as const, "self switch"); return value.ok ? good({ ...command, key: value.value }) : value; }
      if (key === "value") { const value = bool(raw); return value === null ? bad("value must be true or false") : good({ ...command, value }); }
      break;
    }
    case "if": {
      if (key === "if.kind") {
        const kind = enumValue(raw, CONDITION_KINDS, "condition kind");
        return kind.ok ? good({ ...command, if: defaultCondition(kind.value) }) : kind;
      }
      if (key.startsWith("if.")) {
        const edited = editCondition(command.if, key.slice(3), raw);
        return edited.ok ? good({ ...command, if: edited.value }) : edited;
      }
      if (key === "else") {
        const value = bool(raw);
        if (value === null) return bad("else must be true or false");
        if (value) return good({ ...command, else: command.else ?? [] });
        const { else: _, ...rest } = command;
        return good(rest);
      }
      break;
    }
    case "transfer": {
      if (key === "map") { const value = parseOperand(raw, "map", false); return value.ok ? good({ ...command, map: value.value as TransferMap }) : value; }
      if (key === "x" || key === "y") { const value = parseOperand(raw, key, true); return value.ok ? good({ ...command, [key]: value.value as TransferCoordinate }) : value; }
      if (key === "dir") {
        if (raw.startsWith("$") && raw.length > 1) return good({ ...command, dir: { variable: raw.slice(1) } });
        const value = enumValue(raw, [...DIRS, "keep"] as const, "direction"); return value.ok ? good({ ...command, dir: value.value }) : value;
      }
      if (key === "fade") {
        if (raw.trim() === "") { const { fade: _, ...rest } = command; return good(rest); }
        const value = finite(raw, "fade", 0, 2); return value.ok ? good({ ...command, fade: value.value }) : value;
      }
      break;
    }
    case "moveRoute": {
      if (key === "target") { const value = parseTarget(raw, true); return value.ok ? good({ ...command, target: value.value }) : value; }
      if (key === "wait") { const value = bool(raw); return value === null ? bad("wait must be true or false") : good({ ...command, wait: value }); }
      if (key === "steps") { const value = parseSteps(raw, false); return value.ok ? good({ ...command, route: { ...command.route, steps: value.value } }) : value; }
      if (key === "repeat" || key === "skippable") { const value = bool(raw); return value === null ? bad(`${key} must be true or false`) : good({ ...command, route: { ...command.route, [key]: value } }); }
      break;
    }
    case "moveControl": {
      if (key === "target") {
        const value = parseTarget(raw, true);
        return value.ok ? good({ ...command, target: value.value }) : value;
      }
      if (key === "control.kind") {
        const kind = enumValue(raw, [
          "wander", "moveType", "stop", "speed", "routeSpeed", "run", "frequency", "directionFix", "through", "facingMode",
        ] as const, "control kind");
        if (!kind.ok) return kind;
        switch (kind.value) {
          case "wander": return good({ ...command, control: { kind: "wander" } });
          case "moveType": return good({ ...command, control: { kind: "moveType", value: "page" } });
          case "stop": return good({ ...command, control: { kind: "stop" } });
          case "speed": return good({ ...command, control: { kind: "speed", value: 4 } });
          case "routeSpeed": return good({ ...command, control: { kind: "routeSpeed", value: 4 } });
          case "run": return good({ ...command, control: { kind: "run", value: false } });
          case "frequency": return good({ ...command, control: { kind: "frequency", value: 3 } });
          case "directionFix": return good({ ...command, control: { kind: "directionFix", value: false } });
          case "through": return good({ ...command, control: { kind: "through", value: false } });
          case "facingMode": return good({ ...command, control: { kind: "facingMode", value: "followMovement" } });
        }
      }
      if (command.control.kind === "wander") {
        if (key === "control.bounds") {
          const value = parseWanderBounds(raw);
          return value.ok ? good({ ...command, control: setOptional(command.control, "bounds", value.value) }) : value;
        }
        if (key === "control.frequency") {
          const value = optionalInteger(raw, "frequency", 1, 5);
          return value.ok ? good({ ...command, control: setOptional(command.control, "frequency", value.value) }) : value;
        }
        if (key === "control.intervalTicks") {
          const value = optionalInteger(raw, "interval ticks", 1);
          return value.ok
            ? good({ ...command, control: setOptional(command.control, "intervalTicks", value.value) })
            : value;
        }
      }
      if (key === "control.value") {
        switch (command.control.kind) {
          case "moveType": {
            const value = enumValue(raw, ["page", "static", "approach"] as const, "move type");
            return value.ok ? good({ ...command, control: { ...command.control, value: value.value } }) : value;
          }
          case "speed":
          case "routeSpeed": {
            const value = integer(raw, "speed", 1, 6);
            return value.ok ? good({ ...command, control: { ...command.control, value: value.value as 1 | 2 | 3 | 4 | 5 | 6 } }) : value;
          }
          case "frequency": {
            const value = integer(raw, "frequency", 1, 5);
            return value.ok ? good({ ...command, control: { ...command.control, value: value.value as 1 | 2 | 3 | 4 | 5 } }) : value;
          }
          case "run":
          case "directionFix":
          case "through": {
            const value = bool(raw);
            return value === null ? bad("value must be true or false") : good({ ...command, control: { ...command.control, value } });
          }
          case "facingMode": {
            const value = enumValue(raw, ["followMovement", "locked", "scripted"] as const, "facing mode");
            return value.ok ? good({ ...command, control: { ...command.control, value: value.value } }) : value;
          }
          case "wander":
          case "stop":
            break;
        }
      }
      break;
    }
    case "appearance": {
      if (key === "target") {
        const value = parseTarget(raw, true);
        return value.ok ? good({ ...command, target: value.value }) : value;
      }
      if (key === "sprite") {
        const value = optionalString(raw, "sprite", true);
        return value.ok ? good(setOptional(command, "sprite", value.value)) : value;
      }
      if (key === "opacity") {
        const value = optionalInteger(raw, "opacity", 0, 255, true);
        return value.ok ? good(setOptional(command, "opacity", value.value)) : value;
      }
      if (key === "visible") {
        const value = optionalBoolean(raw, "visible", true);
        return value.ok ? good(setOptional(command, "visible", value.value)) : value;
      }
      if (key === "saveDefault") {
        const value = bool(raw);
        return value === null ? bad("saveDefault must be true or false") : good({ ...command, saveDefault: value });
      }
      break;
    }
    case "layer": {
      if (key === "layer") return raw.length > 0 ? good({ ...command, layer: raw }) : bad("layer is required");
      if (key === "visible") {
        const value = optionalBoolean(raw, "visible", true);
        return value.ok ? good(setOptional(command, "visible", value.value)) : value;
      }
      if (key === "variant") {
        const value = optionalString(raw, "variant", true);
        return value.ok ? good(setOptional(command, "variant", value.value)) : value;
      }
      break;
    }
    case "changeParallax": {
      if (key === "image") {
        if (raw === NULL || raw.trim() === "") return good({ ...command, image: null });
        return raw.length > 0 ? good({ ...command, image: raw }) : bad("parallax image is required or null");
      }
      if (key === "loopX" || key === "loopY" || key === "zero") {
        const value = bool(raw);
        return value === null ? bad(`${key} must be true or false`) : good({ ...command, [key]: value });
      }
      if (key === "sx" || key === "sy") {
        const value = finite(raw, key, -32, 32);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      break;
    }
    case "tileProperty": {
      if (key === "x" || key === "y") {
        const value = integer(raw, key, 0);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "passage") {
        const value: FieldEdit<"pass" | "block" | null | undefined> = raw === OMIT || raw.trim() === ""
          ? good(undefined)
          : raw === NULL
            ? good(null)
            : enumValue(raw, ["pass", "block"] as const, "passage");
        return value.ok ? good(setOptional(command, key, value.value)) : value;
      }
      if (key === "enter" || key === "exit") {
        const value = directionList(raw, key);
        return value.ok ? good(setOptional(command, key, value.value)) : value;
      }
      break;
    }
    case "screenFade": {
      if (key === "direction") {
        const value = enumValue(raw, ["out", "in"] as const, "direction");
        return value.ok ? good({ ...command, direction: value.value }) : value;
      }
      if (key === "duration") {
        const value = finite(raw, "duration", 0);
        return value.ok ? good({ ...command, duration: value.value }) : value;
      }
      if (key === "color") {
        const value = parseOptionalColor(raw);
        return value.ok ? good(setOptional(command, "color", value.value)) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      break;
    }
    case "screenTint":
    case "screenFlash": {
      if (key.startsWith("color.")) {
        const value = editColor(command.color, key.slice(6), raw);
        return value.ok ? good({ ...command, color: value.value }) : value;
      }
      if (key === "duration") {
        const value = finite(raw, "duration", 0);
        return value.ok ? good({ ...command, duration: value.value }) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      if (command.op === "screenTint" && key === "layer") {
        return raw.length > 0 ? good({ ...command, layer: raw }) : bad("layer is required");
      }
      if (command.op === "screenFlash" && key === "intensity") {
        const value = integer(raw, "intensity", 0, 255);
        return value.ok ? good({ ...command, intensity: value.value }) : value;
      }
      break;
    }
    case "screenShake": {
      if (key === "strength" || key === "speed" || key === "duration") {
        const value = finite(raw, key, 0);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      break;
    }
    case "camera": {
      if (key === "target") {
        const value = parseCameraTarget(raw);
        return value.ok ? good({ ...command, target: value.value }) : value;
      }
      if (key === "duration") {
        const value = finite(raw, "duration", 0);
        return value.ok ? good({ ...command, duration: value.value }) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      break;
    }
    case "scrollMap": {
      if (key === "direction") {
        const value = enumValue(raw, DIRS, "direction");
        return value.ok ? good({ ...command, direction: value.value }) : value;
      }
      if (key === "distance") {
        const value = finite(raw, "distance", 0);
        return value.ok ? good({ ...command, distance: value.value }) : value;
      }
      if (key === "speed") {
        const value = integer(raw, "speed", 1, 6);
        return value.ok ? good({ ...command, speed: value.value as MoveSpeed }) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      break;
    }
    case "balloon": {
      if (key === "target") {
        const value = parseTarget(raw, true);
        return value.ok ? good({ ...command, target: value.value }) : value;
      }
      if (key === "icon") {
        const value = optionalString(raw, "icon", false);
        return value.ok ? good(setOptional(command, "icon", value.value)) : value;
      }
      if (key === "duration") {
        const value = optionalNumber(raw, "duration", 0);
        return value.ok ? good(setOptional(command, "duration", value.value)) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      break;
    }
    case "screenBackdrop": {
      if (key === "layer") return raw.length > 0 ? good({ ...command, layer: raw }) : bad("layer is required");
      if (key === "variant") {
        const value = optionalString(raw, "variant", true);
        return value.ok ? good(setOptional(command, "variant", value.value)) : value;
      }
      break;
    }
    case "showPicture": {
      if (key === "id") {
        const value = integer(raw, "picture id", 1, 100);
        return value.ok ? good({ ...command, id: value.value }) : value;
      }
      if (key === "layer" || key === "variant") {
        return raw.length > 0 ? good({ ...command, [key]: raw }) : bad(`${key} is required`);
      }
      if (key === "origin") {
        const value = enumValue(raw, PICTURE_ORIGINS, "picture origin");
        return value.ok ? good({ ...command, origin: value.value }) : value;
      }
      if (key === "x" || key === "y") {
        const value = parsePictureCoordinate(raw, key);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "scaleX" || key === "scaleY") {
        const value = finite(raw, key, -2000, 2000);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "opacity") {
        const value = finite(raw, "opacity", 0, 255);
        return value.ok ? good({ ...command, opacity: value.value }) : value;
      }
      if (key === "blend") {
        const value = enumValue(raw, PICTURE_BLENDS, "picture blend");
        return value.ok ? good({ ...command, blend: value.value }) : value;
      }
      break;
    }
    case "movePicture": {
      if (key === "id") {
        const value = integer(raw, "picture id", 1, 100);
        return value.ok ? good({ ...command, id: value.value }) : value;
      }
      if (key === "origin") {
        const value = enumValue(raw, PICTURE_ORIGINS, "picture origin");
        return value.ok ? good({ ...command, origin: value.value }) : value;
      }
      if (key === "x" || key === "y") {
        const value = parsePictureCoordinate(raw, key);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "scaleX" || key === "scaleY") {
        const value = finite(raw, key, -2000, 2000);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "opacity") {
        const value = finite(raw, "opacity", 0, 255);
        return value.ok ? good({ ...command, opacity: value.value }) : value;
      }
      if (key === "blend") {
        const value = enumValue(raw, PICTURE_BLENDS, "picture blend");
        return value.ok ? good({ ...command, blend: value.value }) : value;
      }
      if (key === "duration") {
        const value = finite(raw, "duration", 0);
        return value.ok ? good({ ...command, duration: value.value }) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      if (key === "easing") {
        const value = enumValue(raw, PICTURE_EASINGS, "picture easing");
        return value.ok ? good({ ...command, easing: value.value }) : value;
      }
      break;
    }
    case "rotatePicture": {
      if (key === "id") {
        const value = integer(raw, "picture id", 1, 100);
        return value.ok ? good({ ...command, id: value.value }) : value;
      }
      if (key === "speed") {
        const value = finite(raw, "speed");
        return value.ok ? good({ ...command, speed: value.value }) : value;
      }
      break;
    }
    case "tintPicture": {
      if (key === "id") {
        const value = integer(raw, "picture id", 1, 100);
        return value.ok ? good({ ...command, id: value.value }) : value;
      }
      if (key.startsWith("tone.")) {
        const value = editPictureTone(command.tone, key.slice(5), raw);
        return value.ok ? good({ ...command, tone: value.value }) : value;
      }
      if (key === "duration") {
        const value = finite(raw, "duration", 0);
        return value.ok ? good({ ...command, duration: value.value }) : value;
      }
      if (key === "wait") {
        const value = bool(raw);
        return value === null ? bad("wait must be true or false") : good({ ...command, wait: value });
      }
      break;
    }
    case "erasePicture": {
      if (key === "id") {
        const value = integer(raw, "picture id", 1, 100);
        return value.ok ? good({ ...command, id: value.value }) : value;
      }
      break;
    }
    case "timer": {
      if (key === "action") {
        const action = enumValue(raw, TIMER_ACTIONS, "timer action");
        if (!action.ok) return action;
        if (action.value === "start") return good({ op: "timer", action: "start", seconds: 60 });
        if (action.value === "read") return good({ op: "timer", action: "read", variable: "variable" });
        return good({ op: "timer", action: "stop" });
      }
      if (command.action === "start" && key === "seconds") {
        const value = finite(raw, "timer seconds", 0);
        return value.ok ? good({ ...command, seconds: value.value }) : value;
      }
      if (command.action === "read" && key === "variable") {
        const value = identifier(raw, "variable id");
        return value.ok ? good({ ...command, variable: value.value }) : value;
      }
      break;
    }
    case "inputNumber": {
      if (key === "variable") {
        const value = identifier(raw, "variable id");
        return value.ok ? good({ ...command, variable: value.value }) : value;
      }
      if (key === "digits") {
        const value = integer(raw, "digits", 1, 8);
        return value.ok ? good({ ...command, digits: value.value }) : value;
      }
      break;
    }
    case "selectItem": {
      if (key === "variable") {
        const value = identifier(raw, "variable id");
        return value.ok ? good({ ...command, variable: value.value }) : value;
      }
      if (key === "itemType") {
        const value = enumValue(raw, ["regular", "key", "hiddenA", "hiddenB"] as const, "item type");
        return value.ok ? good({ ...command, itemType: value.value }) : value;
      }
      break;
    }
    case "changeName": {
      if (key === "name") return raw.length >= 1 && raw.length <= 24
        ? good({ ...command, name: raw })
        : bad("name needs 1-24 characters");
      break;
    }
    case "mapNameDisplay": {
      if (key === "visible") {
        const value = bool(raw);
        return value === null ? bad("visible must be true or false") : good({ ...command, visible: value });
      }
      break;
    }
    case "menuAccess":
    case "saveAccess": {
      if (key === "enabled") {
        const value = bool(raw);
        return value === null ? bad("enabled must be true or false") : good({ ...command, enabled: value });
      }
      break;
    }
    case "locationInfo": {
      if (key === "variable") {
        const value = identifier(raw, "variable id");
        return value.ok ? good({ ...command, variable: value.value }) : value;
      }
      if (key === "x" || key === "y") {
        const value = parsePictureCoordinate(raw, key);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "kind") {
        const value = enumValue(raw, ["terrain", "event", "tile", "region"] as const, "kind");
        return value.ok ? good({ ...command, kind: value.value }) : value;
      }
      if (key === "layer") {
        const value = integer(raw, "layer", 0, 3);
        return value.ok ? good({ ...command, layer: value.value as 0 | 1 | 2 | 3 }) : value;
      }
      break;
    }
    case "label":
    case "jumpLabel": {
      if (key === "name") return raw.length >= 1 && raw.length <= 100
        ? good({ ...command, name: raw })
        : bad("label name needs 1-100 characters");
      break;
    }
    case "wait": { if (key === "seconds") { const value = finite(raw, "seconds", Number.MIN_VALUE, 30); return value.ok ? good({ ...command, seconds: value.value }) : value; } break; }
    case "gold": {
      if (key === "set") { const value = enumValue(raw, ["add", "sub"] as const, "mode"); return value.ok ? good({ ...command, set: value.value }) : value; }
      if (key === "amount") { const value = integer(raw, "amount", 0); return value.ok ? good({ ...command, amount: value.value }) : value; }
      break;
    }
    case "item": {
      if (key === "item") return raw ? good({ ...command, item: raw }) : bad("item id is required");
      if (key === "set") { const value = enumValue(raw, ["add", "sub"] as const, "mode"); return value.ok ? good({ ...command, set: value.value }) : value; }
      if (key === "count") { const value = integer(raw, "count", 1, 99); return value.ok ? good({ ...command, count: value.value }) : value; }
      break;
    }
    case "se": {
      if (key === "name") { const value = identifier(raw, "sound name", SOUND_ID); return value.ok ? good({ ...command, name: value.value }) : value; }
      if (key === "volume" || key === "pitch") {
        if (raw.trim() === "") { const next = { ...command }; delete next[key]; return good(next); }
        const value = integer(raw, key, key === "volume" ? 0 : 50, key === "volume" ? 100 : 150);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      break;
    }
    case "playBgm":
    case "playBgs":
    case "playSe": {
      if (key === "id") return raw.length > 0 ? good({ ...command, id: raw }) : bad("audio id is required");
      if (key === "volume" || key === "pitch") {
        const value = optionalInteger(raw, key, key === "volume" ? 0 : 50, key === "volume" ? 100 : 150);
        return value.ok ? good(setOptional(command, key, value.value)) : value;
      }
      break;
    }
    case "playMe": {
      if (key === "id") return raw.length > 0 ? good({ ...command, id: raw }) : bad("audio id is required");
      if (key === "duration") {
        const value = finite(raw, "duration", 0);
        return value.ok ? good({ ...command, duration: value.value }) : value;
      }
      if (key === "volume" || key === "pitch") {
        const value = optionalInteger(raw, key, key === "volume" ? 0 : 50, key === "volume" ? 100 : 150);
        return value.ok ? good(setOptional(command, key, value.value)) : value;
      }
      break;
    }
    case "fadeoutBgm":
    case "fadeoutBgs": {
      if (key === "duration") {
        const value = finite(raw, "duration", 0);
        return value.ok ? good({ ...command, duration: value.value }) : value;
      }
      break;
    }
    case "common": return key === "id" && raw ? good({ ...command, id: raw }) : bad("common event id is required");
    case "place": {
      if (key === "target") { const value = parseTarget(raw, false); return value.ok ? good({ ...command, target: value.value === "player" ? "this" : value.value }) : value; }
      if (key === "x" || key === "y") { const value = integer(raw, key, 0); return value.ok ? good({ ...command, [key]: value.value }) : value; }
      if (key === "dir") { const value = enumValue(raw, DIRS, "direction"); return value.ok ? good({ ...command, dir: value.value }) : value; }
      break;
    }
    case "shop": {
      if (key === "id") {
        const value = identifier(raw, "shop id");
        return value.ok ? good({ ...command, id: value.value }) : value;
      }
      if (key === "goods") {
        const value = jsonValue(raw, "shop goods");
        return value.ok ? good({ ...command, goods: value.value as unknown as Extract<Command, { op: "shop" }>["goods"] }) : value;
      }
      if (key === "sell") {
        const value = bool(raw);
        return value === null ? bad("sell must be true or false") : good({ ...command, sell: value });
      }
      if (key === "sellList") {
        const value = enumValue(raw, ["disable", "hide"] as const, "sell list");
        return value.ok ? good({ ...command, sellList: value.value }) : value;
      }
      break;
    }
    case "mapAnim": {
      if (key === "id" || key === "anim") {
        const value = identifier(raw, key);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "placement") {
        const value = enumValue(raw, ["tile", "target"] as const, "placement");
        if (!value.ok) return value;
        if (value.value === "target") {
          const { x: _x, y: _y, ...rest } = command;
          return good({ ...rest, target: "player" });
        }
        const { target: _target, ...rest } = command;
        return good({ ...rest, x: 0, y: 0 });
      }
      if (key === "x" || key === "y") {
        if (command.target !== undefined) return bad("x/y are only editable for tile placement");
        const value = integer(raw, key, 0);
        return value.ok ? good({ ...command, [key]: value.value }) : value;
      }
      if (key === "target") {
        if (command.target === undefined) return bad("target is only editable for target placement");
        const value = parseTarget(raw, true);
        if (!value.ok) return value;
        return good({ ...command, target: value.value });
      }
      if (key === "follow" || key === "wait") {
        const value = bool(raw);
        return value === null ? bad(`${key} must be true or false`) : good({ ...command, [key]: value });
      }
      if (key === "loop") {
        const value = optionalBoolean(raw, "loop", false);
        return value.ok ? good(setOptional(command, "loop", value.value)) : value;
      }
      if (key === "layer") {
        const value = enumValue(raw, ["below", "above"] as const, "layer");
        return value.ok ? good({ ...command, layer: value.value }) : value;
      }
      break;
    }
    case "stopAnim": {
      if (key === "selector") {
        const value = enumValue(raw, ["all", "id", "anim"] as const, "selector");
        if (!value.ok) return value;
        if (value.value === "id") return good({ op: "stopAnim", id: "animation" });
        if (value.value === "anim") return good({ op: "stopAnim", anim: "animation" });
        return good({ op: "stopAnim" });
      }
      if (key === "id" && command.id !== undefined) {
        const value = identifier(raw, "animation instance id");
        return value.ok ? good({ op: "stopAnim", id: value.value }) : value;
      }
      if (key === "anim" && command.anim !== undefined) {
        const value = identifier(raw, "animation id");
        return value.ok ? good({ op: "stopAnim", anim: value.value }) : value;
      }
      break;
    }
    case "ext": {
      if (key === "call") {
        const value = identifier(raw, "extension call", EXTENSION_CALL);
        return value.ok ? good({ ...command, call: value.value }) : value;
      }
      if (key === "args") {
        const value = jsonValue(raw, "extension args");
        return value.ok ? good({ ...command, args: value.value }) : value;
      }
      break;
    }
    case "extChoice": {
      if (key === "call") {
        const value = identifier(raw, "extension choice call", EXTENSION_CALL);
        return value.ok ? good({ ...command, call: value.value }) : value;
      }
      if (key === "args") {
        const value = jsonValue(raw, "extension choice args");
        return value.ok ? good({ ...command, args: value.value }) : value;
      }
      if (key === "prompt") return raw.length <= 52 ? good({ ...command, prompt: raw }) : bad("prompt is longer than 52 characters");
      if (key === "cancel") {
        const value = bool(raw);
        return value === null ? bad("cancel must be true or false") : good({ ...command, cancel: value });
      }
      if (key === "write") {
        if (raw === OMIT || raw.trim() === "") return good(setOptional(command, "write", undefined));
        const value = jsonValue(raw, "extension choice write");
        if (!value.ok) return value;
        if (value.value === null || Array.isArray(value.value) || typeof value.value !== "object") {
          return bad("extension choice write must be a JSON object");
        }
        const destinations = Object.values(value.value);
        if (new Set(destinations).size !== destinations.length) return bad("extension choice write destinations must be distinct");
        return good({ ...command, write: value.value as Extract<Command, { op: "extChoice" }>["write"] });
      }
      break;
    }
    case "battle": {
      if (key === "setup") {
        const value = jsonValue(raw, "battle setup");
        return value.ok ? good({ ...command, setup: value.value }) : value;
      }
      break;
    }
    case "scene": {
      if (key === "id") {
        const id = raw.trim();
        return id === "" ? bad("scene id must not be empty") : good({ ...command, id });
      }
      if (key === "args") {
        if (raw === OMIT || raw.trim() === "") return good(setOptional(command, "args", undefined));
        const value = jsonValue(raw, "scene args");
        return value.ok ? good(setOptional(command, "args", value.value)) : value;
      }
      break;
    }
    case "erase":
    case "exit":
    case "openMenu":
    case "openSave":
    case "autosave":
    case "gameOver":
    case "returnTitle":
    case "lockInput":
    case "unlockInput":
    case "stopBgm":
    case "pauseBgm":
    case "resumeBgm":
    case "saveBgm":
    case "replayBgm":
    case "loop":
    case "break": break;
  }
  return bad(`field ${key} is not editable for ${command.op}`);
}

/** Parse one editor text spelling and reject any result that violates the
 * normative project schema before it can enter UI or CLI state. */
export function editCommandField(command: Command, key: string, raw: string): FieldEdit<Command> {
  const edited = editCommandFieldUnchecked(command, key, raw);
  return edited.ok ? schemaCommand(edited.value) : edited;
}

export type ConditionSource =
  | { kind: "flat"; key: "switch" | "selfSwitch" | "variable" | "item" }
  | { kind: "all"; index: number };

function cleanPageCondition(condition: PageCondition): PageCondition | undefined {
  const next = { ...condition };
  if (next.all?.length === 0) delete next.all;
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Add every new clause to `all`, preserving all authored flat spellings. */
export function addPageCondition(page: Page, kind: ConditionKind): Page {
  const condition = page.condition ?? {};
  return { ...page, condition: { ...condition, all: [...(condition.all ?? []), defaultCondition(kind)] } };
}

export function deletePageCondition(page: Page, source: ConditionSource): Page {
  if (!page.condition) return page;
  const condition: PageCondition = { ...page.condition };
  if (source.kind === "flat") delete condition[source.key];
  else if (condition.all?.[source.index]) condition.all = condition.all.filter((_, i) => i !== source.index);
  const cleaned = cleanPageCondition(condition);
  if (cleaned) return { ...page, condition: cleaned };
  const { condition: _, ...rest } = page;
  return rest;
}

export function editPageConditionField(
  page: Page,
  source: ConditionSource,
  key: string,
  raw: string,
): FieldEdit<Page> {
  const condition = page.condition;
  if (!condition) return bad("condition no longer exists");
  if (source.kind === "all") {
    const current = condition.all?.[source.index];
    if (!current) return bad("condition no longer exists");
    const edited = editCondition(current, key, raw);
    if (!edited.ok) return edited;
    const all = condition.all!.slice();
    all[source.index] = edited.value;
    return good({ ...page, condition: { ...condition, all } });
  }
  if (source.key === "switch" && key === "id" && condition.switch !== undefined) {
    const value = identifier(raw, "switch id"); return value.ok ? good({ ...page, condition: { ...condition, switch: value.value } }) : value;
  }
  if (source.key === "selfSwitch" && key === "key" && condition.selfSwitch !== undefined) {
    const value = enumValue(raw, ["A", "B", "C", "D"] as const, "self switch"); return value.ok ? good({ ...page, condition: { ...condition, selfSwitch: value.value } }) : value;
  }
  if (source.key === "item" && key === "id" && condition.item !== undefined) {
    return raw ? good({ ...page, condition: { ...condition, item: raw } }) : bad("item id is required");
  }
  if (source.key === "variable" && condition.variable !== undefined) {
    const edited = editCondition({ kind: "variable", ...condition.variable }, key, raw);
    return edited.ok && edited.value.kind === "variable"
      ? good({ ...page, condition: { ...condition, variable: { id: edited.value.id, op: edited.value.op, value: edited.value.value } } })
      : edited.ok ? bad("condition changed kind") : edited;
  }
  return bad(`field ${key} is not editable`);
}

export function editPageField(page: Page, key: string, raw: string): FieldEdit<Page> {
  if (key === "trigger") { const value = enumValue(raw, TRIGGERS, "trigger"); return value.ok ? good({ ...page, trigger: value.value }) : value; }
  if (key === "sprite") return good({ ...page, sprite: raw === "" || raw.toLowerCase() === "none" ? null : raw });
  if (key === "direction") { const value = enumValue(raw, DIRS, "direction"); return value.ok ? good({ ...page, dir: value.value }) : value; }
  if (key === "moveType") { const value = enumValue(raw, MOVE_TYPES, "move type"); return value.ok ? good({ ...page, moveType: value.value }) : value; }
  if (key === "blocks") { const value = bool(raw); return value === null ? bad("blocks must be true or false") : good({ ...page, blocks: value }); }
  return bad(`unknown page field ${key}`);
}

export function editPageRouteField(page: Page, key: string, raw: string): FieldEdit<Page> {
  if (key === "enabled") {
    const value = bool(raw);
    if (value === null) return bad("route enabled must be true or false");
    if (value) return good({ ...page, moveRoute: page.moveRoute ?? { steps: ["moveDown"], repeat: false, skippable: false } });
    const { moveRoute: _, ...rest } = page;
    return good(rest);
  }
  const route = page.moveRoute ?? { steps: ["moveDown"], repeat: false, skippable: false };
  if (key === "steps") { const value = parseSteps(raw, true); return value.ok ? good({ ...page, moveRoute: { ...route, steps: value.value } }) : value; }
  if (key === "repeat" || key === "skippable") { const value = bool(raw); return value === null ? bad(`${key} must be true or false`) : good({ ...page, moveRoute: { ...route, [key]: value } }); }
  return bad(`unknown route field ${key}`);
}

export function pageFieldDescriptors(page: Page): EditableField[] {
  return [
    field("trigger", "TRIGGER", page.trigger, "enum", TRIGGERS),
    field("sprite", "SPRITE", page.sprite ?? "NONE"),
    field("direction", "DIR", page.dir ?? "down", "enum", DIRS),
    field("moveType", "MOVE", page.moveType ?? "static", "enum", MOVE_TYPES),
    field("blocks", "BLOCKS", page.blocks ?? false, "boolean", BOOLS),
  ];
}

export function pageRouteFieldDescriptors(page: Page): EditableField[] {
  return [
    field("enabled", "ROUTE", page.moveRoute !== undefined, "boolean", BOOLS),
    field("repeat", "REPEAT", page.moveRoute?.repeat ?? false, "boolean", BOOLS),
    field("skippable", "SKIP", page.moveRoute?.skippable ?? false, "boolean", BOOLS),
    field("steps", "STEPS", page.moveRoute ? routeSteps(page.moveRoute) : "moveDown"),
  ];
}

export function eventGeometryValue(raw: string, label: string): FieldEdit<number> {
  return integer(raw, label, label === "x" || label === "y" ? 0 : 1);
}

export function directionOptions(): readonly Dir[] {
  return DIRS;
}
