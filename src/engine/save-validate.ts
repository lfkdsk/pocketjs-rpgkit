// src/engine/save-validate.ts — deep structural validation for a
// decoded save snapshot (F4/task-1173).
//
// The FNV checksum proves a file was not truncated or typoed; it does not
// prove the content is a legal session, because a hand-crafted file can
// carry a correct checksum over structurally invalid state. The reducer
// indexes fiber stacks and compiled programs without further guards, so a
// snapshot missing `parallels` or carrying facing=99 is accepted by the
// checksum and then crashes the NEXT frame. validateSnapshot() rejects such
// input with a reason before any live state is replaced.
//
// This checker is deliberately map-agnostic (the core has no World): it
// verifies types, value ranges, internal cross-references and the save
// safe-point invariant. Whether `map` is a map THIS build runs is decided
// by the host when restoring (MapView compares against its runtime map).

import { MAX_FIBER_STACK_DEPTH } from "./interpreter.ts";
import { extensionCallNameValid, jsonValueProblem } from "./extensions.ts";

const INTEGER_OPS = new Set([
  "text", "choices", "switch", "variable", "selfSwitch", "if", "jmp", "repeat", "break",
  "label", "jumpLabel",
  "wait", "gold", "item", "se",
  "playBgm", "fadeoutBgm", "stopBgm", "pauseBgm", "resumeBgm",
  "playBgs", "fadeoutBgs", "playMe", "playSe", "saveBgm", "replayBgm", "stopSe",
  "erase", "exit", "transfer",
  "moveRoute", "moveControl", "common", "lockInput", "unlockInput", "place", "shop",
  "mapAnim", "stopAnim", "appearance", "layer", "changeParallax", "tileProperty",
  "screenFade", "screenTint", "screenFlash", "screenShake", "camera", "scrollMap", "balloon", "screenBackdrop",
  "showPicture", "movePicture", "rotatePicture", "tintPicture", "erasePicture",
  "timer", "hostAction", "changeName", "mapNameDisplay", "menuAccess", "saveAccess", "locationInfo",
  "ext", "extChoice", "battle", "scene",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isU32(v: unknown): v is number {
  return isNonNegInt(v) && v <= 0xffffffff;
}

/** B1 (fix 3): the four numeric SwitchState banks
 *  (items/variables/gold/shopStock) must be SAFE integers, not merely
 *  finite, because every runtime write and every construction/restore
 *  entry point normalizes through interpreter.ts's clampFiniteVar, which
 *  never produces a value outside +/-Number.MAX_SAFE_INTEGER. A save
 *  carrying e.g. 1e308 in one of these banks cannot come from normal play;
 *  it is a hand-crafted file this checker must refuse. */
function isSafeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const CHOICE_ICON_KEYS = new Set(["sprite", "dir", "frame"]);

/** A choices icon column (compiled instruction or open modal): exactly one
 *  entry per option, each null (text-only row) or {sprite, dir?, frame?}
 *  with no other keys — the shape compile() emits from the schema-checked
 *  `choices.options[].icon`. */
function validateChoiceIcons(v: unknown, count: number, path: string): string | null {
  if (!Array.isArray(v) || v.length !== count) {
    return fail(path, "one icon entry (object or null) per option required");
  }
  for (let i = 0; i < v.length; i++) {
    const icon = v[i];
    if (icon === null) continue;
    const at = `${path}[${i}]`;
    if (!isRecord(icon)) return fail(at, "icon must be an object or null");
    for (const key of Object.keys(icon)) {
      if (!CHOICE_ICON_KEYS.has(key)) return fail(`${at}.${key}`, "unknown icon field");
    }
    if (typeof icon.sprite !== "string" || icon.sprite.length === 0) {
      return fail(`${at}.sprite`, "non-empty string required");
    }
    if (icon.dir !== undefined && !["down", "left", "right", "up"].includes(icon.dir as string)) {
      return fail(`${at}.dir`, "down|left|right|up required");
    }
    if (icon.frame !== undefined && icon.frame !== 0 && icon.frame !== 1 && icon.frame !== 2) {
      return fail(`${at}.frame`, "0|1|2 required");
    }
  }
  return null;
}

function fail(path: string, msg: string): string {
  return `${path}: ${msg}`;
}

function validateAppearanceTarget(v: unknown, path: string): string | null {
  if (v === "player" || v === "this") return null;
  if (isRecord(v) && typeof v.event === "string" && v.event.length > 0) return null;
  return fail(path, "player|this|{event: id} required");
}

function validateColor(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "RGBA object required");
  for (const channel of ["r", "g", "b", "a"] as const) {
    if (!isNonNegInt(v[channel]) || v[channel] > 255) {
      return fail(`${path}.${channel}`, "integer 0..255 required");
    }
  }
  return null;
}

function validatePictureId(v: unknown, path: string): string | null {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100
    ? null
    : fail(path, "integer 1..100 required");
}

function validatePictureCoordinate(v: unknown, path: string): string | null {
  return isFiniteNumber(v) ? null : validateVariableRef(v, path);
}

function validatePictureTransform(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "picture transform object required");
  if (!isFiniteNumber(v.x)) return fail(`${path}.x`, "number required");
  if (!isFiniteNumber(v.y)) return fail(`${path}.y`, "number required");
  for (const key of ["scaleX", "scaleY"] as const) {
    if (!isFiniteNumber(v[key]) || v[key] < -2000 || v[key] > 2000) {
      return fail(`${path}.${key}`, "number -2000..2000 required");
    }
  }
  if (!isFiniteNumber(v.opacity) || v.opacity < 0 || v.opacity > 255) {
    return fail(`${path}.opacity`, "number 0..255 required");
  }
  return null;
}

function validatePictureTone(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "picture tone object required");
  for (const key of ["r", "g", "b"] as const) {
    if (!Number.isInteger(v[key]) || (v[key] as number) < -255 || (v[key] as number) > 255) {
      return fail(`${path}.${key}`, "integer -255..255 required");
    }
  }
  if (!isNonNegInt(v.gray) || v.gray > 255) {
    return fail(`${path}.gray`, "integer 0..255 required");
  }
  return null;
}

function validateCameraTarget(v: unknown, path: string): string | null {
  if (v === "player" || v === "this") return null;
  if (!isRecord(v)) return fail(path, "player|this|{event: id}|{x,y} required");
  if (typeof v.event === "string" && v.event.length > 0) return null;
  if (isNonNegInt(v.x) && isNonNegInt(v.y)) return null;
  return fail(path, "player|this|{event: id}|{x,y} required");
}

function validateDirections(v: unknown, path: string): string | null {
  if (!Array.isArray(v) || !v.every((dir) => ["down", "left", "right", "up"].includes(dir as string))) {
    return fail(path, "direction array required");
  }
  if (new Set(v).size !== v.length) return fail(path, "directions must be unique");
  return null;
}

// Condition vocabulary (engine/types.ts Condition). The reducer's
// evalCondition switches on `kind` without a default guard, so an unknown
// kind silently evaluates false; a malformed comparison field would feed
// undefined to a relational check. Saves carry compiled programs only, but
// programs are attacker-controlled JSON, so the vocabulary is checked.
function validateCondition(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "condition must be an object");
  switch (v.kind) {
    case "switch":
      if (typeof v.id !== "string") return fail(`${path}.id`, "string required");
      if (v.value !== undefined && typeof v.value !== "boolean") {
        return fail(`${path}.value`, "boolean required");
      }
      return null;
    case "selfSwitch":
      if (!["A", "B", "C", "D"].includes(v.key as string)) {
        return fail(`${path}.key`, "self switch must be A..D");
      }
      if (v.value !== undefined && typeof v.value !== "boolean") {
        return fail(`${path}.value`, "boolean required");
      }
      return null;
    case "variable": {
      if (typeof v.id !== "string") return fail(`${path}.id`, "string required");
      if (![">=", "<=", "==", "!="].includes(v.op as string)) {
        return fail(`${path}.op`, "unknown variable comparison");
      }
      if (!isFiniteNumber(v.value)) return fail(`${path}.value`, "number required");
      return null;
    }
    case "item":
      if (typeof v.id !== "string") return fail(`${path}.id`, "string required");
      if (!isNonNegInt(v.count)) return fail(`${path}.count`, "non-negative integer required");
      return null;
    case "gold":
      if (!isFiniteNumber(v.amount)) return fail(`${path}.amount`, "number required");
      return null;
    case "facing":
      if (!["down", "left", "right", "up"].includes(v.dir as string)) {
        return fail(`${path}.dir`, "bad direction");
      }
      return null;
    case "appearance": {
      const target = validateAppearanceTarget(v.target, `${path}.target`);
      if (target) return target;
      if (v.sprite !== null && typeof v.sprite !== "string") {
        return fail(`${path}.sprite`, "string or null required");
      }
      return null;
    }
    case "tileProperty": {
      if (!isNonNegInt(v.x) || !isNonNegInt(v.y)) return fail(path, "x/y non-negative integers required");
      if (v.passage === undefined && v.enter === undefined && v.exit === undefined) {
        return fail(path, "at least one tile property required");
      }
      if (v.passage !== undefined && v.passage !== null && v.passage !== "pass" && v.passage !== "block") {
        return fail(`${path}.passage`, "pass|block|null required");
      }
      for (const field of ["enter", "exit"] as const) {
        if (v[field] !== undefined && v[field] !== null) {
          const dirs = validateDirections(v[field], `${path}.${field}`);
          if (dirs) return dirs;
        }
      }
      return null;
    }
    case "worldIdle":
      if (v.negate !== undefined && typeof v.negate !== "boolean") {
        return fail(`${path}.negate`, "boolean required");
      }
      return null;
    case "playerMoving":
      if (v.negate !== undefined && typeof v.negate !== "boolean") {
        return fail(`${path}.negate`, "boolean required");
      }
      return null;
    case "region":
      if (!isNonNegInt(v.x) || !isNonNegInt(v.y)) {
        return fail(`${path}.x`, "non-negative integers required");
      }
      if (!isNonNegInt(v.id) || (v.id as number) > 255) {
        return fail(`${path}.id`, "integer 0..255 required");
      }
      return null;
    case "bgmPlaying":
      if (v.id !== undefined && (typeof v.id !== "string" || v.id.length === 0)) {
        return fail(`${path}.id`, "non-empty string required");
      }
      if (v.negate !== undefined && typeof v.negate !== "boolean") {
        return fail(`${path}.negate`, "boolean required");
      }
      return null;
    case "timer":
      if (v.op !== ">=" && v.op !== "<=") {
        return fail(`${path}.op`, ">=|<= required");
      }
      if (!isFiniteNumber(v.seconds) || v.seconds < 0) {
        return fail(`${path}.seconds`, "non-negative number required");
      }
      return null;
    case "ext":
      if (typeof v.call !== "string" || !extensionCallNameValid(v.call)) {
        return fail(`${path}.call`, "namespaced extension call required");
      }
      {
        const problem = jsonValueProblem(v.args, `${path}.args`);
        if (problem) return problem;
      }
      return null;
    default:
      return fail(`${path}.kind`, "unknown condition kind");
  }
}

// PageCondition vocabulary (engine/types.ts PageCondition), reused by a
// compiled shop's ShopGood.condition (T2-10/B1): the goods list is
// embedded literally in the compiled Instr, unlike a page's own
// `condition`, which lives in the MapDef rather than a fiber stack.
function validatePageCondition(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "condition must be an object");
  if (v.switch !== undefined && typeof v.switch !== "string") {
    return fail(`${path}.switch`, "string required");
  }
  if (v.selfSwitch !== undefined && !["A", "B", "C", "D"].includes(v.selfSwitch as string)) {
    return fail(`${path}.selfSwitch`, "self switch must be A..D");
  }
  if (v.variable !== undefined) {
    const vv = v.variable;
    if (
      !isRecord(vv) || typeof vv.id !== "string" ||
      ![">=", "<=", "==", "!="].includes(vv.op as string) || !isFiniteNumber(vv.value)
    ) {
      return fail(`${path}.variable`, "{id, op, value} required");
    }
  }
  if (v.item !== undefined && typeof v.item !== "string") return fail(`${path}.item`, "string required");
  if (v.all !== undefined) {
    if (!Array.isArray(v.all) || v.all.length === 0) return fail(`${path}.all`, "non-empty array required");
    for (let i = 0; i < v.all.length; i++) {
      const e = validateCondition(v.all[i], `${path}.all[${i}]`);
      if (e) return e;
    }
  }
  return null;
}

const MOVE_STEPS = new Set([
  "moveDown", "moveLeft", "moveRight", "moveUp",
  "stepForward",
  "faceDown", "faceLeft", "faceRight", "faceUp",
  "wait", "turnRandom",
  "turnTowardPlayer",
]);

const MOVE_DIRS = new Set(["down", "left", "right", "up"]);

function validateMoveControl(v: unknown, path: string): string | null {
  if (!isRecord(v) || typeof v.kind !== "string") {
    return fail(path, "movement control object required");
  }
  switch (v.kind) {
    case "wander":
      if (v.bounds !== undefined) {
        const b = v.bounds;
        if (!isRecord(b) || !isNonNegInt(b.x) || !isNonNegInt(b.y) ||
          !isNonNegInt(b.width) || b.width < 1 || !isNonNegInt(b.height) || b.height < 1) {
          return fail(`${path}.bounds`, "non-empty {x,y,width,height} tile rectangle required");
        }
      }
      if (v.frequency !== undefined && (!isNonNegInt(v.frequency) || v.frequency < 1 || v.frequency > 5)) {
        return fail(`${path}.frequency`, "movement frequency grade 1..5 required");
      }
      if (v.intervalTicks !== undefined && (!isNonNegInt(v.intervalTicks) || v.intervalTicks < 1)) {
        return fail(`${path}.intervalTicks`, "positive reference-tick interval required");
      }
      return null;
    case "moveType":
      return ["page", "static", "approach"].includes(v.value as string)
        ? null
        : fail(`${path}.value`, "page|static|approach required");
    case "stop":
      return null;
    case "speed":
      return isNonNegInt(v.value) && v.value >= 1 && v.value <= 6
        ? null
        : fail(`${path}.value`, "movement speed grade 1..6 required");
    case "routeSpeed":
      return isNonNegInt(v.value) && v.value >= 1 && v.value <= 6
        ? null
        : fail(`${path}.value`, "movement speed grade 1..6 required");
    case "frequency":
      return isNonNegInt(v.value) && v.value >= 1 && v.value <= 5
        ? null
        : fail(`${path}.value`, "movement frequency grade 1..5 required");
    case "run":
    case "directionFix":
    case "through":
      return typeof v.value === "boolean" ? null : fail(`${path}.value`, "boolean required");
    case "facingMode":
      return ["followMovement", "locked", "scripted"].includes(v.value as string)
        ? null
        : fail(`${path}.value`, "followMovement|locked|scripted required");
    default:
      return fail(`${path}.kind`, "unknown movement control kind");
  }
}

/** One route step: a legacy verb string or an object step
 *  ({turnToward}/{pathTo}/{approach}). */
function validateMoveStep(step: unknown, path: string): string | null {
  if (typeof step === "string") {
    return MOVE_STEPS.has(step) ? null : fail(path, "unknown move-step verb");
  }
  if (!isRecord(step)) return fail(path, "move step must be a string or object");
  if ("turnToward" in step) {
    const t = step.turnToward;
    if (t !== "player" && !(isRecord(t) && typeof t.event === "string" && t.event.length > 0)) {
      return fail(`${path}.turnToward`, "'player' or {event} required");
    }
    return null;
  }
  if ("pathTo" in step) {
    const p = step.pathTo;
    if (!isRecord(p) || !isNonNegInt(p.x) || !isNonNegInt(p.y)) {
      return fail(`${path}.pathTo`, "{x,y} non-negative integers required");
    }
    if (p.retries !== undefined && !isNonNegInt(p.retries)) {
      return fail(`${path}.pathTo.retries`, "non-negative integer required");
    }
    return null;
  }
  if ("approach" in step) {
    const a = step.approach;
    if (!isRecord(a)) return fail(`${path}.approach`, "object required");
    if (a.target !== "player" && !(isRecord(a.target) && typeof a.target.event === "string" && a.target.event.length > 0)) {
      return fail(`${path}.approach.target`, "'player' or {event} required");
    }
    if (a.side !== undefined && !MOVE_DIRS.has(a.side as string)) {
      return fail(`${path}.approach.side`, "down|left|right|up required");
    }
    if (a.distance !== undefined && (!isNonNegInt(a.distance) || a.distance < 1)) {
      return fail(`${path}.approach.distance`, "positive integer required");
    }
    if (a.retries !== undefined && !isNonNegInt(a.retries)) {
      return fail(`${path}.approach.retries`, "non-negative integer required");
    }
    return null;
  }
  if ("control" in step) return validateMoveControl(step.control, `${path}.control`);
  return fail(path, "unknown move-step object");
}

function validateMoveRoute(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "move route must be an object");
  if (!Array.isArray(v.steps)) return fail(`${path}.steps`, "array of move steps required");
  for (let i = 0; i < v.steps.length; i++) {
    const e = validateMoveStep(v.steps[i], `${path}.steps[${i}]`);
    if (e) return e;
  }
  if (typeof v.repeat !== "boolean") return fail(`${path}.repeat`, "boolean required");
  if (typeof v.skippable !== "boolean") return fail(`${path}.skippable`, "boolean required");
  return null;
}

function validateVariableRef(v: unknown, path: string): string | null {
  if (!isRecord(v) || Object.keys(v).length !== 1 || typeof v.variable !== "string" || v.variable.length === 0) {
    return fail(path, "{variable: non-empty string} required");
  }
  return null;
}

type AudioTrackShape = "track" | "me" | "savedBgm";

function validateAudioTrack(v: unknown, path: string, shape: AudioTrackShape): string | null {
  if (!isRecord(v)) return fail(path, "audio track object required");
  const allowed = new Set(["id", "volume", "pitch", "positionTicks"]);
  if (shape !== "savedBgm") {
    allowed.add("paused");
    allowed.add("fade");
  }
  if (shape === "me") {
    allowed.add("durationTicks");
    allowed.add("leftTicks");
  }
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) return fail(`${path}.${key}`, "unknown audio track field");
  }
  if (typeof v.id !== "string" || v.id.length === 0) {
    return fail(`${path}.id`, "non-empty string required");
  }
  if (!isNonNegInt(v.volume) || v.volume > 100) {
    return fail(`${path}.volume`, "integer 0..100 required");
  }
  if (!Number.isInteger(v.pitch) || (v.pitch as number) < 50 || (v.pitch as number) > 150) {
    return fail(`${path}.pitch`, "integer 50..150 required");
  }
  if (!isNonNegInt(v.positionTicks)) {
    return fail(`${path}.positionTicks`, "non-negative integer required");
  }
  if (shape === "savedBgm") return null;
  if (v.paused !== undefined && v.paused !== true) {
    return fail(`${path}.paused`, "true or omitted required");
  }
  if (v.fade !== undefined) {
    if (!isRecord(v.fade)) return fail(`${path}.fade`, "fade object required");
    for (const key of Object.keys(v.fade)) {
      if (key !== "totalTicks" && key !== "leftTicks") {
        return fail(`${path}.fade.${key}`, "unknown fade field");
      }
    }
    if (!isNonNegInt(v.fade.totalTicks) || v.fade.totalTicks === 0) {
      return fail(`${path}.fade.totalTicks`, "positive integer required");
    }
    if (!isNonNegInt(v.fade.leftTicks) || v.fade.leftTicks === 0 ||
        v.fade.leftTicks > v.fade.totalTicks) {
      return fail(`${path}.fade.leftTicks`, "positive integer no greater than totalTicks required");
    }
  }
  if (shape === "me") {
    if (!isNonNegInt(v.durationTicks) || v.durationTicks === 0) {
      return fail(`${path}.durationTicks`, "positive integer required");
    }
    if (!isNonNegInt(v.leftTicks) || v.leftTicks === 0 || v.leftTicks > v.durationTicks) {
      return fail(`${path}.leftTicks`, "positive integer no greater than durationTicks required");
    }
  }
  return null;
}

function validateAudioState(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "audio state object required");
  const allowed = new Set(["bgm", "bgs", "me", "savedBgm"]);
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) return fail(`${path}.${key}`, "unknown audio state field");
  }
  if (v.bgm !== undefined) {
    const e = validateAudioTrack(v.bgm, `${path}.bgm`, "track");
    if (e) return e;
  }
  if (v.bgs !== undefined) {
    const e = validateAudioTrack(v.bgs, `${path}.bgs`, "track");
    if (e) return e;
  }
  if (v.me !== undefined) {
    const e = validateAudioTrack(v.me, `${path}.me`, "me");
    if (e) return e;
  }
  if (v.savedBgm !== undefined) {
    const e = validateAudioTrack(v.savedBgm, `${path}.savedBgm`, "savedBgm");
    if (e) return e;
  }
  return null;
}

function validateCompiledAudioTrack(v: Record<string, unknown>, path: string): string | null {
  if (typeof v.id !== "string" || v.id.length === 0) {
    return fail(`${path}.id`, "non-empty string required");
  }
  if (!isNonNegInt(v.volume) || v.volume > 100) {
    return fail(`${path}.volume`, "integer 0..100 required");
  }
  if (!Number.isInteger(v.pitch) || (v.pitch as number) < 50 || (v.pitch as number) > 150) {
    return fail(`${path}.pitch`, "integer 50..150 required");
  }
  return null;
}

/** Validate a compiled instruction tree (the programs serialized inside
 *  fiber stacks). An unknown op would wedge the run loop (pc never
 *  advances), so the vocabulary is checked exhaustively. */
function validateProg(prog: unknown, path: string): string | null {
  if (!Array.isArray(prog)) return fail(path, "stack program must be an array");
  for (let i = 0; i < prog.length; i++) {
    const ins = prog[i];
    const here = `${path}[${i}]`;
    if (!isRecord(ins) || typeof ins.op !== "string" || !INTEGER_OPS.has(ins.op)) {
      return fail(here, "unknown instruction op");
    }
    const needNum = (key: string): string | null =>
      isFiniteNumber(ins[key]) ? null : fail(`${here}.${key}`, "number required");
    const needStr = (key: string): string | null =>
      typeof ins[key] === "string" ? null : fail(`${here}.${key}`, "string required");
    const needBool = (key: string): string | null =>
      typeof ins[key] === "boolean" ? null : fail(`${here}.${key}`, "boolean required");
    switch (ins.op) {
      case "text": {
        if (!Array.isArray(ins.lines) || !ins.lines.every((l) => typeof l === "string")) {
          return fail(`${here}.lines`, "string array required");
        }
        if (!isFiniteNumber(ins.cps)) return fail(`${here}.cps`, "number required");
        if (ins.box !== undefined) {
          const e = validateTextBox(ins.box, `${here}.box`);
          if (e) return e;
        }
        break;
      }
      case "choices": {
        const e = needStr("prompt");
        if (e) return e;
        if (!Array.isArray(ins.texts) || !ins.texts.every((t) => typeof t === "string")) {
          return fail(`${here}.texts`, "string array required");
        }
        if (!Array.isArray(ins.branches) || ins.branches.length !== ins.texts.length) {
          return fail(`${here}.branches`, "one program per choice required");
        }
        if (ins.icons !== undefined) {
          // Omitted (never null) when no option has an icon.
          const e = validateChoiceIcons(ins.icons, ins.texts.length, `${here}.icons`);
          if (e) return e;
        }
        for (const b of ins.branches) {
          const e = validateProg(b, `${here}.branches`);
          if (e) return e;
        }
        if (ins.cancel !== null && !Array.isArray(ins.cancel)) {
          return fail(`${here}.cancel`, "cancel program must be an array or null");
        }
        if (Array.isArray(ins.cancel)) {
          const e = validateProg(ins.cancel, `${here}.cancel`);
          if (e) return e;
        }
        break;
      }
      case "switch": {
        const e = needStr("id") || needBool("value");
        if (e) return e;
        break;
      }
      case "variable": {
        if (needStr("id")) return fail(`${here}.id`, "string required");
        const set = ins.set;
        if (!isRecord(set)) return fail(`${here}.set`, "object required");
        if (set.op === "random") {
          const { min, max } = set;
          if (!isFiniteNumber(min) || !isFiniteNumber(max) || min > max) {
            return fail(`${here}.set`, "random needs min <= max numbers");
          }
        } else if (typeof set.from === "string") {
          // T2-16 variable-operand variant: shares "add"/"sub" spellings
          // with the literal-value variant below, disambiguated by the
          // presence of `from` rather than `value`.
          if (!["copy", "add", "sub", "mul", "div", "mod"].includes(set.op as string)) {
            return fail(`${here}.set.op`, "unknown variable-ref op");
          }
        } else if (set.op === "set" || set.op === "add" || set.op === "sub") {
          if (!isFiniteNumber(set.value)) return fail(`${here}.set.value`, "number required");
        } else {
          return fail(`${here}.set.op`, "unknown variable set op");
        }
        break;
      }
      case "selfSwitch": {
        if (!["A", "B", "C", "D"].includes(ins.key as string)) {
          return fail(`${here}.key`, "self switch must be A..D");
        }
        if (typeof ins.value !== "boolean") return fail(`${here}.value`, "boolean required");
        break;
      }
      case "if":
        if (!isRecord(ins.cond)) return fail(`${here}.cond`, "object required");
        {
          const ce = validateCondition(ins.cond, `${here}.cond`);
          if (ce) return ce;
        }
        // compile() emits onFalse STRICTLY AFTER the IF and
        // pc=length is the "past the end" sentinel (the run loop pops the
        // frame). A backward/self edge is therefore compiler-impossible,
        // and accepting one lets a checksum-valid save enter a cycle the
        // runtime can only stop via the runaway backstop (review 1274 B1).
        // The only backward edge is a `loop` back-edge ("repeat"), whose
        // runtime yields the fiber at most every LOOP_YIELD_STEPS steps.
        if (typeof ins.onFalse !== "number" || !Number.isInteger(ins.onFalse) ||
          ins.onFalse <= i || ins.onFalse > prog.length) {
          return fail(`${here}.onFalse`, "forward integer target after the if required");
        }
        break;
      case "jmp":
        // compile() emits the post-then JMP strictly after itself (it
        // skips the else block); end-of-program jumps compile to
        // prog.length. A self/backward jmp is a cycle (a direct self jump
        // or part of a multi-instruction loop) and is refused here.
        if (typeof ins.to !== "number" || !Number.isInteger(ins.to) ||
          ins.to <= i || ins.to > prog.length) {
          return fail(`${here}.to`, "forward integer target after the jmp required");
        }
        break;
      case "repeat":
        // A loop back-edge targets its loop's first instruction, at or
        // before itself (an empty loop repeats onto itself).
        if (!isNonNegInt(ins.to) || ins.to > i) {
          return fail(`${here}.to`, "loop start at or before the repeat required");
        }
        break;
      case "break":
        // Frame-relative: the runtime refuses a break whose `up` exceeds the
        // live stack or whose target lies past the target program.
        if (!isNonNegInt(ins.up)) return fail(`${here}.up`, "non-negative integer required");
        if (ins.to !== null && !isNonNegInt(ins.to)) {
          return fail(`${here}.to`, "non-negative integer or null required");
        }
        if (ins.up === 0 && ins.to !== null && (ins.to <= i || ins.to > prog.length)) {
          return fail(`${here}.to`, "forward integer target after the break required");
        }
        break;
      case "label":
        // A name is free-form; the runtime resolves it against the list's
        // label table (a missing label is a no-op, so no target check here).
        if (typeof ins.name !== "string" || ins.name.length === 0 || ins.name.length > 100) {
          return fail(`${here}.name`, "string of 1..100 characters required");
        }
        // `ord` records the label's flat source position for first-in-source-
        // order resolution; absent for hand-authored lists.
        if (ins.ord !== undefined && !isNonNegInt(ins.ord)) {
          return fail(`${here}.ord`, "non-negative integer or absent required");
        }
        break;
      case "jumpLabel": {
        if (typeof ins.name !== "string" || ins.name.length === 0 || ins.name.length > 100) {
          return fail(`${here}.name`, "string of 1..100 characters required");
        }
        break;
      }
      case "wait":
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        break;
      case "gold":
        if (ins.set !== "add" && ins.set !== "sub") return fail(`${here}.set`, "add|sub required");
        if (needNum("amount")) return fail(`${here}.amount`, "number required");
        break;
      case "item": {
        const e = needStr("item");
        if (e) return e;
        if (ins.set !== "add" && ins.set !== "sub") return fail(`${here}.set`, "add|sub required");
        if (!isFiniteNumber(ins.count)) return fail(`${here}.count`, "number required");
        break;
      }
      case "se": {
        const e = needStr("name") || needNum("volume") || needNum("pitch");
        if (e) return e;
        break;
      }
      case "playBgm":
      case "playBgs":
      case "playSe": {
        const e = validateCompiledAudioTrack(ins, here);
        if (e) return e;
        break;
      }
      case "playMe": {
        const e = validateCompiledAudioTrack(ins, here);
        if (e) return e;
        if (!isNonNegInt(ins.durationFrames)) {
          return fail(`${here}.durationFrames`, "non-negative integer required");
        }
        break;
      }
      case "fadeoutBgm":
      case "fadeoutBgs":
        if (!isNonNegInt(ins.frames)) {
          return fail(`${here}.frames`, "non-negative integer required");
        }
        break;
      case "stopBgm":
      case "pauseBgm":
      case "resumeBgm":
      case "saveBgm":
      case "replayBgm":
        break;
      case "erase":
      case "exit":
        break;
      case "lockInput":
      case "unlockInput":
        break;
      case "place": {
        if (ins.target !== "player" && ins.target !== "this" &&
          !(isRecord(ins.target) && typeof ins.target.event === "string")) {
          return fail(`${here}.target`, '"player", "this", or {event: id} required');
        }
        if (!isNonNegInt(ins.x) || !isNonNegInt(ins.y)) {
          return fail(`${here}`, "x/y non-negative integers required");
        }
        if (ins.dir !== null && !["down", "left", "right", "up"].includes(ins.dir as string)) {
          return fail(`${here}.dir`, "bad direction");
        }
        break;
      }
      case "transfer": {
        if (typeof ins.map !== "string") {
          const e = validateVariableRef(ins.map, `${here}.map`);
          if (e) return e;
        }
        if (!isFiniteNumber(ins.x)) {
          const e = validateVariableRef(ins.x, `${here}.x`);
          if (e) return e;
        }
        if (!isFiniteNumber(ins.y)) {
          const e = validateVariableRef(ins.y, `${here}.y`);
          if (e) return e;
        }
        if (ins.dir !== "keep" && !["down", "left", "right", "up"].includes(ins.dir as string)) {
          const e = validateVariableRef(ins.dir, `${here}.dir`);
          if (e) return e;
        }
        if (!isFiniteNumber(ins.fadeFrames)) return fail(`${here}.fadeFrames`, "number required");
        if (ins.handoff !== undefined) {
          if (!isRecord(ins.handoff)) return fail(`${here}.handoff`, "object required");
          if (ins.handoff.mode !== "seamless-v1") {
            return fail(`${here}.handoff.mode`, '"seamless-v1" required');
          }
          if (typeof ins.handoff.portalId !== "string" || ins.handoff.portalId.length === 0) {
            return fail(`${here}.handoff.portalId`, "non-empty string required");
          }
        }
        if (ins.completion !== undefined && ins.completion !== true) {
          return fail(`${here}.completion`, "true or absent required");
        }
        break;
      }
      case "moveRoute": {
        if (
          ins.target !== "player" &&
          ins.target !== "this" &&
          !(isRecord(ins.target) && typeof ins.target.event === "string" && ins.target.event.length > 0)
        ) {
          return fail(`${here}.target`, "player|this|{event: id} required");
        }
        const e = validateMoveRoute(ins.route, `${here}.route`);
        if (e) return e;
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "moveControl": {
        if (
          ins.target !== "player" && ins.target !== "this" &&
          !(isRecord(ins.target) && typeof ins.target.event === "string" && ins.target.event.length > 0)
        ) {
          return fail(`${here}.target`, "player|this|{event: id} required");
        }
        const e = validateMoveControl(ins.control, `${here}.control`);
        if (e) return e;
        break;
      }
      case "appearance": {
        const target = validateAppearanceTarget(ins.target, `${here}.target`);
        if (target) return target;
        if (ins.sprite !== undefined && ins.sprite !== null && typeof ins.sprite !== "string") {
          return fail(`${here}.sprite`, "string or null required");
        }
        if (ins.opacity !== undefined && ins.opacity !== null &&
            (!isNonNegInt(ins.opacity) || ins.opacity > 255)) {
          return fail(`${here}.opacity`, "integer 0..255 or null required");
        }
        if (ins.visible !== undefined && ins.visible !== null && typeof ins.visible !== "boolean") {
          return fail(`${here}.visible`, "boolean or null required");
        }
        if (typeof ins.saveDefault !== "boolean") return fail(`${here}.saveDefault`, "boolean required");
        if (ins.saveDefault && ins.target !== "player") {
          return fail(`${here}.saveDefault`, "only valid for player");
        }
        if (ins.saveDefault && ins.sprite === undefined) {
          return fail(`${here}.sprite`, "required with saveDefault");
        }
        break;
      }
      case "layer":
        if (typeof ins.layer !== "string" || ins.layer.length === 0) {
          return fail(`${here}.layer`, "non-empty string required");
        }
        if (ins.visible !== undefined && ins.visible !== null && typeof ins.visible !== "boolean") {
          return fail(`${here}.visible`, "boolean or null required");
        }
        if (ins.variant !== undefined && ins.variant !== null && typeof ins.variant !== "string") {
          return fail(`${here}.variant`, "string or null required");
        }
        break;
      case "changeParallax":
        for (const key of Object.keys(ins)) {
          if (!["op", "image", "loopX", "loopY", "sx", "sy", "zero"].includes(key)) {
            return fail(`${here}.${key}`, "unknown changeParallax field");
          }
        }
        if (ins.image !== null && typeof ins.image !== "string") {
          return fail(`${here}.image`, "string or null required");
        }
        if (typeof ins.loopX !== "boolean" || typeof ins.loopY !== "boolean") {
          return fail(here, "loopX/loopY booleans required");
        }
        if (!isFiniteNumber(ins.sx) || !isFiniteNumber(ins.sy)) {
          return fail(here, "sx/sy finite numbers required");
        }
        if (ins.zero !== undefined && typeof ins.zero !== "boolean") {
          return fail(`${here}.zero`, "boolean required");
        }
        break;
      case "tileProperty":
        if (!isNonNegInt(ins.x) || !isNonNegInt(ins.y)) {
          return fail(here, "x/y non-negative integers required");
        }
        if (ins.passage === undefined && ins.enter === undefined && ins.exit === undefined) {
          return fail(here, "at least one tile property required");
        }
        if (ins.passage !== undefined && ins.passage !== null &&
            ins.passage !== "pass" && ins.passage !== "block") {
          return fail(`${here}.passage`, "pass|block|null required");
        }
        for (const field of ["enter", "exit"] as const) {
          if (ins[field] !== undefined && ins[field] !== null) {
            const dirs = validateDirections(ins[field], `${here}.${field}`);
            if (dirs) return dirs;
          }
        }
        break;
      case "screenFade": {
        if (ins.direction !== "out" && ins.direction !== "in") {
          return fail(`${here}.direction`, "out|in required");
        }
        const color = validateColor(ins.color, `${here}.color`);
        if (color) return color;
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "screenTint": {
        if (typeof ins.layer !== "string" || ins.layer.length === 0) {
          return fail(`${here}.layer`, "non-empty string required");
        }
        const color = validateColor(ins.color, `${here}.color`);
        if (color) return color;
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "screenFlash": {
        const color = validateColor(ins.color, `${here}.color`);
        if (color) return color;
        if (!isNonNegInt(ins.intensity) || ins.intensity > 255) {
          return fail(`${here}.intensity`, "integer 0..255 required");
        }
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "screenShake":
        if (!isFiniteNumber(ins.strength) || ins.strength < 0) {
          return fail(`${here}.strength`, "non-negative number required");
        }
        if (!isFiniteNumber(ins.speed) || ins.speed < 0) {
          return fail(`${here}.speed`, "non-negative number required");
        }
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      case "camera": {
        const target = validateCameraTarget(ins.target, `${here}.target`);
        if (target) return target;
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "scrollMap":
        if (!["down", "left", "right", "up"].includes(ins.direction as string)) {
          return fail(`${here}.direction`, "bad direction");
        }
        if (!isFiniteNumber(ins.distance) || ins.distance < 0) {
          return fail(`${here}.distance`, "non-negative number required");
        }
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      case "balloon": {
        const target = validateAppearanceTarget(ins.target, `${here}.target`);
        if (target) return target;
        if (ins.icon !== null && (typeof ins.icon !== "string" || ins.icon.length === 0)) {
          return fail(`${here}.icon`, "non-empty string or null required");
        }
        if (ins.frames !== null && !isNonNegInt(ins.frames)) {
          return fail(`${here}.frames`, "non-negative integer or null required");
        }
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        if (ins.wait && (ins.icon === null || ins.frames === null || ins.frames === 0)) {
          return fail(here, "a waited balloon requires an icon and positive finite duration");
        }
        break;
      }
      case "screenBackdrop":
        if (typeof ins.layer !== "string" || ins.layer.length === 0) {
          return fail(`${here}.layer`, "non-empty string required");
        }
        if (ins.variant !== null && (typeof ins.variant !== "string" || ins.variant.length === 0)) {
          return fail(`${here}.variant`, "non-empty string or null required");
        }
        break;
      case "showPicture": {
        const id = validatePictureId(ins.id, `${here}.id`);
        if (id) return id;
        if (typeof ins.layer !== "string" || ins.layer.length === 0) {
          return fail(`${here}.layer`, "non-empty string required");
        }
        if (typeof ins.variant !== "string" || ins.variant.length === 0) {
          return fail(`${here}.variant`, "non-empty string required");
        }
        if (ins.origin !== "topLeft" && ins.origin !== "center") {
          return fail(`${here}.origin`, "topLeft|center required");
        }
        const x = validatePictureCoordinate(ins.x, `${here}.x`);
        if (x) return x;
        const y = validatePictureCoordinate(ins.y, `${here}.y`);
        if (y) return y;
        for (const key of ["scaleX", "scaleY"] as const) {
          const value = ins[key];
          if (!isFiniteNumber(value) || value < -2000 || value > 2000) {
            return fail(`${here}.${key}`, "number -2000..2000 required");
          }
        }
        if (!isFiniteNumber(ins.opacity) || ins.opacity < 0 || ins.opacity > 255) {
          return fail(`${here}.opacity`, "number 0..255 required");
        }
        if (!["normal", "add", "multiply", "screen"].includes(ins.blend as string)) {
          return fail(`${here}.blend`, "normal|add|multiply|screen required");
        }
        break;
      }
      case "movePicture": {
        const id = validatePictureId(ins.id, `${here}.id`);
        if (id) return id;
        if (ins.origin !== null && ins.origin !== "topLeft" && ins.origin !== "center") {
          return fail(`${here}.origin`, "topLeft|center|null required");
        }
        const x = validatePictureCoordinate(ins.x, `${here}.x`);
        if (x) return x;
        const y = validatePictureCoordinate(ins.y, `${here}.y`);
        if (y) return y;
        for (const key of ["scaleX", "scaleY"] as const) {
          const value = ins[key];
          if (!isFiniteNumber(value) || value < -2000 || value > 2000) {
            return fail(`${here}.${key}`, "number -2000..2000 required");
          }
        }
        if (!isFiniteNumber(ins.opacity) || ins.opacity < 0 || ins.opacity > 255) {
          return fail(`${here}.opacity`, "number 0..255 required");
        }
        if (ins.blend !== null && !["normal", "add", "multiply", "screen"].includes(ins.blend as string)) {
          return fail(`${here}.blend`, "normal|add|multiply|screen|null required");
        }
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        if (!["linear", "easeIn", "easeOut", "easeInOut"].includes(ins.easing as string)) {
          return fail(`${here}.easing`, "known easing required");
        }
        break;
      }
      case "rotatePicture": {
        const id = validatePictureId(ins.id, `${here}.id`);
        if (id) return id;
        if (!isFiniteNumber(ins.speed)) return fail(`${here}.speed`, "number required");
        break;
      }
      case "tintPicture": {
        const id = validatePictureId(ins.id, `${here}.id`);
        if (id) return id;
        const tone = validatePictureTone(ins.tone, `${here}.tone`);
        if (tone) return tone;
        if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "erasePicture": {
        const id = validatePictureId(ins.id, `${here}.id`);
        if (id) return id;
        break;
      }
      case "timer":
        if (ins.action === "start") {
          if (!isNonNegInt(ins.frames)) return fail(`${here}.frames`, "non-negative integer required");
        } else if (ins.action === "read") {
          if (typeof ins.variable !== "string" || ins.variable.length === 0) {
            return fail(`${here}.variable`, "non-empty string required");
          }
        } else if (ins.action !== "stop") {
          return fail(`${here}.action`, "start|stop|read required");
        }
        break;
      case "hostAction":
        if (!["menu", "save", "autosave", "gameOver", "title"].includes(ins.action as string)) {
          return fail(`${here}.action`, "menu|save|autosave|gameOver|title required");
        }
        break;
      case "changeName":
        if (typeof ins.name !== "string" || ins.name.length < 1 || ins.name.length > 24) {
          return fail(`${here}.name`, "string of length 1..24 required");
        }
        break;
      case "mapNameDisplay":
        if (typeof ins.visible !== "boolean") return fail(`${here}.visible`, "boolean required");
        break;
      case "menuAccess":
      case "saveAccess":
        if (typeof ins.enabled !== "boolean") return fail(`${here}.enabled`, "boolean required");
        break;
      case "locationInfo": {
        if (needStr("variable")) return fail(`${here}.variable`, "string required");
        const coord = (key: string): string | null => {
          const v = ins[key];
          if (typeof v === "number") return Number.isInteger(v) ? null : fail(`${here}.${key}`, "integer required");
          if (isRecord(v) && typeof v.variable === "string" && v.variable.length > 0) return null;
          return fail(`${here}.${key}`, "integer or {variable} required");
        };
        const cx = coord("x");
        if (cx) return cx;
        const cy = coord("y");
        if (cy) return cy;
        if (!["terrain", "event", "tile", "region"].includes(ins.kind as string)) {
          return fail(`${here}.kind`, "terrain|event|tile|region required");
        }
        if (![0, 1, 2, 3].includes(ins.layer as number)) return fail(`${here}.layer`, "0|1|2|3 required");
        break;
      }
      case "common":
        if (needStr("id")) return fail(`${here}.id`, "string required");
        break;
      case "shop": {
        {
          const e = needStr("id");
          if (e) return e;
        }
        if (!Array.isArray(ins.goods) || ins.goods.length === 0) {
          return fail(`${here}.goods`, "non-empty array required");
        }
        for (const g of ins.goods) {
          if (!isRecord(g) || typeof g.item !== "string") {
            return fail(`${here}.goods`, "each good needs an item id");
          }
          if (g.price !== undefined && !isFiniteNumber(g.price)) {
            return fail(`${here}.goods`, "price must be a number when present");
          }
          if (g.sellPrice !== undefined && !isFiniteNumber(g.sellPrice)) {
            return fail(`${here}.goods`, "sellPrice must be a number when present");
          }
          if (g.stock !== undefined && !isNonNegInt(g.stock)) {
            return fail(`${here}.goods`, "stock must be a non-negative integer when present");
          }
          if (g.condition !== undefined) {
            const e = validatePageCondition(g.condition, `${here}.goods.condition`);
            if (e) return e;
          }
        }
        if (typeof ins.sell !== "boolean") return fail(`${here}.sell`, "boolean required");
        if (ins.sellList !== "disable" && ins.sellList !== "hide") {
          return fail(`${here}.sellList`, "'disable' or 'hide' required");
        }
        break;
      }
      case "ext": {
        if (typeof ins.call !== "string" || !extensionCallNameValid(ins.call)) {
          return fail(`${here}.call`, "namespaced extension call required");
        }
        const problem = jsonValueProblem(ins.args, `${here}.args`);
        if (problem) return problem;
        break;
      }
      case "mapAnim": {
        if (needStr("id")) return fail(`${here}.id`, "string required");
        if (needStr("anim")) return fail(`${here}.anim`, "string required");
        if (ins.target === null) {
          if (!isNonNegInt(ins.x) || !isNonNegInt(ins.y)) {
            return fail(`${here}`, "x/y non-negative integers required without a target");
          }
        } else if (
          ins.target !== "player" &&
          ins.target !== "this" &&
          !(isRecord(ins.target) && typeof ins.target.event === "string" && ins.target.event.length > 0)
        ) {
          return fail(`${here}.target`, '"player", "this", or {event: id} required');
        }
        if (ins.layer !== "below" && ins.layer !== "above") {
          return fail(`${here}.layer`, "'below' or 'above' required");
        }
        if (typeof ins.follow !== "boolean") {
          return fail(`${here}.follow`, "boolean required");
        }
        if (ins.loop !== null && typeof ins.loop !== "boolean") {
          return fail(`${here}.loop`, "boolean or null required");
        }
        if (typeof ins.wait !== "boolean") return fail(`${here}.wait`, "boolean required");
        break;
      }
      case "stopAnim":
        if (ins.id !== null && typeof ins.id !== "string") {
          return fail(`${here}.id`, "string or null required");
        }
        if (ins.anim !== null && typeof ins.anim !== "string") {
          return fail(`${here}.anim`, "string or null required");
        }
        break;
      case "extChoice": {
        if (typeof ins.call !== "string" || !extensionCallNameValid(ins.call)) {
          return fail(`${here}.call`, "namespaced extension call required");
        }
        if (typeof ins.prompt !== "string") return fail(`${here}.prompt`, "string required");
        if (typeof ins.cancel !== "boolean") return fail(`${here}.cancel`, "boolean required");
        const problem = jsonValueProblem(ins.args, `${here}.args`);
        if (problem) return problem;
        if (ins.write !== null) {
          if (!isRecord(ins.write)) return fail(`${here}.write`, "record or null required");
          const ids: string[] = [];
          for (const field of ["index", "key", "cancelled"] as const) {
            const id = ins.write[field];
            if (id === undefined) continue;
            if (typeof id !== "string" || id.length === 0) {
              return fail(`${here}.write.${field}`, "non-empty variable id required");
            }
            ids.push(id);
          }
          if (ids.length === 0) return fail(`${here}.write`, "at least one destination required");
          if (new Set(ids).size !== ids.length) {
            return fail(`${here}.write`, "destinations must be distinct");
          }
        }
        break;
      }
      case "battle": {
        const problem = jsonValueProblem(ins.setup, `${here}.setup`);
        if (problem) return problem;
        for (const branch of ["onWin", "onLose", "onEscape"] as const) {
          if (ins[branch] !== null && !Array.isArray(ins[branch])) {
            return fail(`${here}.${branch}`, "program array or null required");
          }
          if (Array.isArray(ins[branch])) {
            const e = validateProg(ins[branch], `${here}.${branch}`);
            if (e) return e;
          }
        }
        break;
      }
      case "scene": {
        if (typeof ins.id !== "string" || ins.id.length === 0) {
          return fail(`${here}.id`, "non-empty string required");
        }
        const problem = jsonValueProblem(ins.args, `${here}.args`);
        if (problem) return problem;
        for (const branch of ["onDone", "onCancel"] as const) {
          if (ins[branch] !== null && !Array.isArray(ins[branch])) {
            return fail(`${here}.${branch}`, "program array or null required");
          }
          if (Array.isArray(ins[branch])) {
            const e = validateProg(ins[branch], `${here}.${branch}`);
            if (e) return e;
          }
        }
        break;
      }
    }
  }
  return null;
}

const FIBER_MODES = new Set([
  "run", "text", "choices", "shop", "wait", "animWait", "screenWait", "external",
]);

/** Keys a frame completion transfer may carry: a PendingTransfer minus the
 *  `fiber` key, which the runtime fills in from the owning fiber. */
const COMPLETION_KEYS = ["map", "x", "y", "dir", "fadeFrames", "handoff", "playerTouch"];

/** Validate one entry of a frame's `onDone` completion queue (a
 *  PendingTransfer without the fiber key, which the runtime fills in from
 *  the owning fiber). Mirrors the transfer instruction's field checks and
 *  rejects the `fiber` key (the runtime owns it) and any unknown key, so a
 *  save cannot inject an owner or smuggle extra state into the completion. */
function validateCompletionTransfer(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "completion transfer must be an object");
  for (const key of Object.keys(v)) {
    if (!COMPLETION_KEYS.includes(key)) {
      return fail(`${path}.${key}`, key === "fiber" ? "fiber is owned by the runtime" : "unknown completion field");
    }
  }
  if (typeof v.map !== "string" || v.map.length === 0) {
    return fail(`${path}.map`, "non-empty string required");
  }
  if (!isFiniteNumber(v.x)) return fail(`${path}.x`, "number required");
  if (!isFiniteNumber(v.y)) return fail(`${path}.y`, "number required");
  if (v.dir !== "keep" && !["down", "left", "right", "up"].includes(v.dir as string)) {
    return fail(`${path}.dir`, 'Dir or "keep" required');
  }
  if (!isFiniteNumber(v.fadeFrames)) return fail(`${path}.fadeFrames`, "number required");
  if (v.handoff !== undefined) {
    if (!isRecord(v.handoff)) return fail(`${path}.handoff`, "object required");
    if (v.handoff.mode !== "seamless-v1") {
      return fail(`${path}.handoff.mode`, '"seamless-v1" required');
    }
    if (typeof v.handoff.portalId !== "string" || v.handoff.portalId.length === 0) {
      return fail(`${path}.handoff.portalId`, "non-empty string required");
    }
  }
  if (v.playerTouch !== undefined && v.playerTouch !== true) {
    return fail(`${path}.playerTouch`, "true or absent required");
  }
  return null;
}

function validateFiber(
  v: unknown,
  path: string,
  wantParallel: boolean,
  mapId: string,
  routeWaiters: ReadonlySet<string> = new Set(),
  autosave = false,
  modal: unknown = null,
): string | null {
  if (!isRecord(v)) return fail(path, "fiber must be an object");
  if (typeof v.key !== "string" || !v.key.includes("/")) {
    return fail(`${path}.key`, "fiber key must be map/event-id");
  }
  if (v.key !== `${mapId}/${v.key.slice(v.key.indexOf("/") + 1)}`) {
    return fail(`${path}.key`, "fiber key does not belong to the saved map");
  }
  if (typeof v.parallel !== "boolean" || v.parallel !== wantParallel) {
    return fail(`${path}.parallel`, "fiber parallel flag mismatch");
  }
  if (!isNonNegInt(v.pageIndex)) return fail(`${path}.pageIndex`, "non-negative integer required");
  if (!FIBER_MODES.has(v.mode as string)) return fail(`${path}.mode`, "unknown fiber mode");
  if (!isNonNegInt(v.since)) return fail(`${path}.since`, "non-negative integer required");
  if (typeof v.erase !== "boolean") return fail(`${path}.erase`, "boolean required");
  if (!Array.isArray(v.stack) || v.stack.length === 0) {
    return fail(`${path}.stack`, "non-empty stack array required");
  }
  if (v.stack.length > MAX_FIBER_STACK_DEPTH) {
    return fail(`${path}.stack`, `at most ${MAX_FIBER_STACK_DEPTH} frames allowed`);
  }
  for (let i = 0; i < v.stack.length; i++) {
    const frame = v.stack[i];
    const here = `${path}.stack[${i}]`;
    if (!isRecord(frame)) return fail(here, "stack frame must be an object");
    if (!Array.isArray(frame.prog)) return fail(`${here}.prog`, "program array required");
    if (frame.unit !== undefined && frame.unit !== true) {
      return fail(`${here}.unit`, "true or absent required");
    }
    const pc = frame.pc;
    if (typeof pc !== "number" || !Number.isInteger(pc) || pc < 0 || pc > frame.prog.length) {
      return fail(`${here}.pc`, "pc must index inside the program");
    }
    if (frame.onDone !== undefined) {
      if (!Array.isArray(frame.onDone)) return fail(`${here}.onDone`, "completion queue must be an array");
      for (let i = 0; i < frame.onDone.length; i++) {
        const e = validateCompletionTransfer(frame.onDone[i], `${here}.onDone[${i}]`);
        if (e) return e;
      }
    }
    const e = validateProg(frame.prog, `${here}.prog`);
    if (e) return e;
  }
  // Mode / pc / current-instruction cross-check. On resume the reducer
  // indexes stack[0].prog[pc] WITHOUT a guard for the suspending modes:
  //   wait    -> reads prog[pc].frames
  //   text    -> reads prog[pc].op/lines
  //   choices -> reads prog[pc].op/texts
  // so a suspended fiber whose pc sits at (or past) end of program crashes
  // the next frame even though every field is well-typed (R1202-1).
  const top = v.stack[0]! as { prog: unknown[]; pc: number };
  switch (v.mode) {
    case "run":
      // pc == length is the normal "pop this frame" sentinel the run loop
      // handles; only the suspended modes below need a live instruction.
      break;
    case "wait": {
      const ins = top.pc < top.prog.length ? top.prog[top.pc] : undefined;
      if (!isRecord(ins) || ins.op !== "wait") {
        return fail(`${path}.mode`, "a wait fiber must park on a wait instruction");
      }
      break;
    }
    case "animWait": {
      const ins = top.pc < top.prog.length ? top.prog[top.pc] : undefined;
      if (!isRecord(ins) || ins.op !== "mapAnim" || ins.wait !== true) {
        return fail(`${path}.mode`, "an animWait fiber must park on a waited mapAnim instruction");
      }
      break;
    }
    case "screenWait": {
      const ins = top.pc < top.prog.length ? top.prog[top.pc] : undefined;
      if (!isRecord(ins) || ![
        "screenFade", "screenTint", "screenFlash", "screenShake", "camera", "scrollMap",
        "movePicture", "tintPicture", "balloon",
      ].includes(ins.op as string) || ins.wait !== true) {
        return fail(`${path}.mode`, "a screenWait fiber must park on a waited screen instruction");
      }
      const frames = ins.op === "balloon" ? ins.frames : ins.frames;
      if (!isNonNegInt(frames) || frames === 0) {
        return fail(`${path}.mode`, "a screenWait fiber needs a positive finite duration");
      }
      break;
    }
    case "external": {
      // At a safe point the only external work left is a waited move route
      // already running. It resumes when the saved map runtime carries the
      // route that names this fiber; a save without it cannot.
      const ins = top.pc < top.prog.length ? top.prog[top.pc] : undefined;
      if (routeWaiters.has(v.key) && isRecord(ins) && ins.op === "moveRoute" && ins.wait === true) break;
      return fail(`${path}.mode`, "a save cannot park a fiber in external mode unless a saved route resumes it");
    }
    case "text":
    case "choices":
    case "shop": {
      const ins = top.pc < top.prog.length ? top.prog[top.pc] : undefined;
      const instructionMatches = isRecord(ins) && (
        v.mode === "text" ? ins.op === "text" :
        v.mode === "choices" ? ins.op === "choices" || ins.op === "extChoice" :
        ins.op === "shop"
      );
      if (autosave && isRecord(modal) && modal.fiber === v.key &&
          modal.kind === v.mode && instructionMatches) break;
      return fail(`${path}.mode`, `a save cannot park a fiber in ${v.mode as string} mode without its autosave modal`);
    }
  }
  return null;
}

function validateColorTween(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "colour tween object required");
  const from = validateColor(v.from, `${path}.from`);
  if (from) return from;
  const to = validateColor(v.to, `${path}.to`);
  if (to) return to;
  if (!isNonNegInt(v.total) || !isNonNegInt(v.left) || v.left > v.total) {
    return fail(path, "total/left must be non-negative integers with left <= total");
  }
  return null;
}

function validatePictureMove(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "picture move tween object required");
  const from = validatePictureTransform(v.from, `${path}.from`);
  if (from) return from;
  const to = validatePictureTransform(v.to, `${path}.to`);
  if (to) return to;
  if (!isNonNegInt(v.total) || v.total === 0 ||
      !isNonNegInt(v.left) || v.left === 0 || v.left > v.total) {
    return fail(path, "live move needs positive total/left with left <= total");
  }
  if (!["linear", "easeIn", "easeOut", "easeInOut"].includes(v.easing as string)) {
    return fail(`${path}.easing`, "known easing required");
  }
  return null;
}

function validatePictureTint(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "picture tint tween object required");
  const from = validatePictureTone(v.from, `${path}.from`);
  if (from) return from;
  const to = validatePictureTone(v.to, `${path}.to`);
  if (to) return to;
  if (!isNonNegInt(v.total) || v.total === 0 ||
      !isNonNegInt(v.left) || v.left === 0 || v.left > v.total) {
    return fail(path, "live tint needs positive total/left with left <= total");
  }
  return null;
}

function validatePicture(v: unknown, key: string, path: string): string | null {
  if (!isRecord(v)) return fail(path, "picture object required");
  const id = validatePictureId(v.id, `${path}.id`);
  if (id) return id;
  if (key !== String(v.id)) return fail(path, "picture key must match its id");
  if (typeof v.layer !== "string" || v.layer.length === 0) {
    return fail(`${path}.layer`, "non-empty string required");
  }
  if (typeof v.variant !== "string" || v.variant.length === 0) {
    return fail(`${path}.variant`, "non-empty string required");
  }
  if (v.origin !== "topLeft" && v.origin !== "center") {
    return fail(`${path}.origin`, "topLeft|center required");
  }
  if (!["normal", "add", "multiply", "screen"].includes(v.blend as string)) {
    return fail(`${path}.blend`, "normal|add|multiply|screen required");
  }
  const transform = validatePictureTransform(v.transform, `${path}.transform`);
  if (transform) return transform;
  const tone = validatePictureTone(v.tone, `${path}.tone`);
  if (tone) return tone;
  if (!isFiniteNumber(v.rotation) || v.rotation < 0 || v.rotation >= 360) {
    return fail(`${path}.rotation`, "number in [0,360) required");
  }
  if (!isFiniteNumber(v.rotationSpeed)) {
    return fail(`${path}.rotationSpeed`, "number required");
  }
  if (v.move !== undefined) {
    const move = validatePictureMove(v.move, `${path}.move`);
    if (move) return move;
  }
  if (v.tint !== undefined) {
    const tint = validatePictureTint(v.tint, `${path}.tint`);
    if (tint) return tint;
  }
  return null;
}

function validateScreenEffects(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "screen effects object required");
  const known = new Set([
    "fade", "tints", "flash", "shake", "camera", "balloons", "backdrop", "pictures", "mapNameBanner",
  ]);
  for (const key of Object.keys(v)) {
    if (!known.has(key)) return fail(`${path}.${key}`, "unknown screen effect field");
  }
  if (Object.keys(v).length === 0) return fail(path, "empty screen effects state must be omitted");

  if (v.fade !== undefined) {
    const tween = validateColorTween(v.fade, `${path}.fade`);
    if (tween) return tween;
    if (!isRecord(v.fade) || typeof v.fade.clear !== "boolean") {
      return fail(`${path}.fade.clear`, "boolean required");
    }
  }
  if (v.tints !== undefined) {
    if (!isRecord(v.tints) || Object.keys(v.tints).length === 0) {
      return fail(`${path}.tints`, "non-empty record required");
    }
    for (const [id, tint] of Object.entries(v.tints)) {
      if (id.length === 0) return fail(`${path}.tints`, "layer ids must be non-empty");
      const tween = validateColorTween(tint, `${path}.tints.${id}`);
      if (tween) return tween;
    }
  }
  if (v.flash !== undefined) {
    const tween = validateColorTween(v.flash, `${path}.flash`);
    if (tween) return tween;
  }
  if (v.shake !== undefined) {
    const shake = v.shake;
    if (!isRecord(shake)) return fail(`${path}.shake`, "shake object required");
    if (!isFiniteNumber(shake.strength) || shake.strength < 0) {
      return fail(`${path}.shake.strength`, "non-negative number required");
    }
    if (!isFiniteNumber(shake.speed) || shake.speed < 0) {
      return fail(`${path}.shake.speed`, "non-negative number required");
    }
    if (!isNonNegInt(shake.total) || shake.total === 0 ||
        !isNonNegInt(shake.left) || shake.left === 0 || shake.left > shake.total) {
      return fail(`${path}.shake`, "live shake needs positive total/left with left <= total");
    }
  }
  if (v.camera !== undefined) {
    const camera = v.camera;
    if (!isRecord(camera) || (camera.mode !== "fixed" && camera.mode !== "follow")) {
      return fail(`${path}.camera.mode`, "fixed|follow required");
    }
    for (const key of ["fromX", "fromY", "toX", "toY"] as const) {
      if (!isFiniteNumber(camera[key])) return fail(`${path}.camera.${key}`, "number required");
    }
    if (!isNonNegInt(camera.total) || !isNonNegInt(camera.left) || camera.left > camera.total) {
      return fail(`${path}.camera`, "total/left must be non-negative integers with left <= total");
    }
    if (camera.mode === "follow" && (camera.total === 0 || camera.left === 0)) {
      return fail(`${path}.camera`, "completed follow camera state must be omitted");
    }
  }
  if (v.balloons !== undefined) {
    if (!isRecord(v.balloons) || Object.keys(v.balloons).length === 0) {
      return fail(`${path}.balloons`, "non-empty record required");
    }
    for (const [id, balloon] of Object.entries(v.balloons)) {
      const at = `${path}.balloons.${id}`;
      if (!isRecord(balloon)) return fail(at, "balloon object required");
      const target = balloon.target;
      const expected = target === "player"
        ? "player"
        : isRecord(target) && typeof target.event === "string" && target.event.length > 0
          ? `event:${target.event}`
          : null;
      if (expected === null) return fail(`${at}.target`, "player|{event: id} required");
      if (id !== expected) return fail(at, "balloon key must match its target");
      if (typeof balloon.icon !== "string" || balloon.icon.length === 0) {
        return fail(`${at}.icon`, "non-empty string required");
      }
      if (!isNonNegInt(balloon.x) || !isNonNegInt(balloon.y)) {
        return fail(at, "x/y non-negative integers required");
      }
      if (!isNonNegInt(balloon.age)) return fail(`${at}.age`, "non-negative integer required");
      if (balloon.left !== null && (!isNonNegInt(balloon.left) || balloon.left === 0)) {
        return fail(`${at}.left`, "positive integer or null required");
      }
    }
  }
  if (v.backdrop !== undefined) {
    const backdrop = v.backdrop;
    if (!isRecord(backdrop) || typeof backdrop.layer !== "string" || backdrop.layer.length === 0 ||
        typeof backdrop.variant !== "string" || backdrop.variant.length === 0) {
      return fail(`${path}.backdrop`, "non-empty layer and variant strings required");
    }
  }
  if (v.pictures !== undefined) {
    if (!isRecord(v.pictures) || Object.keys(v.pictures).length === 0) {
      return fail(`${path}.pictures`, "non-empty record required");
    }
    for (const [id, picture] of Object.entries(v.pictures)) {
      const e = validatePicture(picture, id, `${path}.pictures.${id}`);
      if (e) return e;
    }
  }
  if (v.mapNameBanner !== undefined) {
    const banner = v.mapNameBanner;
    if (!isRecord(banner)) return fail(`${path}.mapNameBanner`, "map-name banner object required");
    if (typeof banner.text !== "string" || banner.text.length === 0) {
      return fail(`${path}.mapNameBanner.text`, "non-empty string required");
    }
    if (!isNonNegInt(banner.total) || banner.total === 0 ||
        !isNonNegInt(banner.left) || banner.left === 0 || banner.left > banner.total) {
      return fail(`${path}.mapNameBanner`, "live banner needs positive total/left with left <= total");
    }
  }
  return null;
}

function validateSwitchState(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "switch state must be an object");
  const booleanRecord = (key: string): string | null => {
    const rec = v[key];
    if (!isRecord(rec)) return fail(`${path}.${key}`, "record required");
    for (const [k, val] of Object.entries(rec)) {
      if (typeof val !== "boolean") return fail(`${path}.${key}.${k}`, "boolean required");
    }
    return null;
  };
  const numberRecord = (key: string): string | null => {
    const rec = v[key];
    if (!isRecord(rec)) return fail(`${path}.${key}`, "record required");
    for (const [k, val] of Object.entries(rec)) {
      if (!isSafeInt(val)) return fail(`${path}.${key}.${k}`, "safe integer required");
    }
    return null;
  };
  const variableRecord = (key: string): string | null => {
    const rec = v[key];
    if (!isRecord(rec)) return fail(`${path}.${key}`, "record required");
    for (const [k, val] of Object.entries(rec)) {
      if (typeof val !== "string" && !isSafeInt(val)) {
        return fail(`${path}.${key}.${k}`, "string or safe integer required");
      }
    }
    return null;
  };
  let e = booleanRecord("switches");
  if (e) return e;
  e = numberRecord("items");
  if (e) return e;
  e = variableRecord("variables");
  if (e) return e;
  // T2-10/B1: absent (an older bank without any shop stock) is allowed and
  // defaults to empty at load, matching playerName's back-compat rule
  // below; a present entry must be a non-negative safe integer (units
  // remaining; B1 (fix 3) tightened this from a merely
  // non-negative integer).
  if (v.shopStock !== undefined) {
    if (!isRecord(v.shopStock)) return fail(`${path}.shopStock`, "record required");
    for (const [k, val] of Object.entries(v.shopStock)) {
      if (!isSafeInt(val) || val < 0) return fail(`${path}.shopStock.${k}`, "non-negative safe integer required");
    }
  }
  if (!isRecord(v.self)) return fail(`${path}.self`, "record required");
  for (const [k, val] of Object.entries(v.self)) {
    if (val !== undefined && !["A", "B", "C", "D"].includes(val as string)) {
      return fail(`${path}.self.${k}`, "self switch must be A..D or absent");
    }
  }
  if (!isSafeInt(v.gold)) return fail(`${path}.gold`, "safe integer required");
  if (!isU32(v.rng)) return fail(`${path}.rng`, "u32 RNG cursor required");
  // The player name is present in every snapshot a current runtime writes;
  // an older bank without it is allowed and defaults at load, but a present
  // value must be a non-empty, bounded string.
  if (v.playerName !== undefined) {
    if (typeof v.playerName !== "string" || v.playerName.length < 1 || v.playerName.length > 24) {
      return fail(`${path}.playerName`, "string of length 1..24 required");
    }
  }
  if (v.timer !== undefined) {
    const timer = v.timer;
    if (!isRecord(timer)) return fail(`${path}.timer`, "timer object required");
    if (!isNonNegInt(timer.remaining)) {
      return fail(`${path}.timer.remaining`, "non-negative integer required");
    }
    if (timer.running !== true) return fail(`${path}.timer.running`, "true required");
    if (typeof timer.expired !== "boolean") {
      return fail(`${path}.timer.expired`, "boolean required");
    }
    if (timer.expired !== (timer.remaining === 0)) {
      return fail(`${path}.timer.expired`, "must be true exactly when remaining is zero");
    }
  }
  if (v.mapNameDisplay !== undefined && v.mapNameDisplay !== true) {
    return fail(`${path}.mapNameDisplay`, "true or absent required");
  }
  // Menu/save access default to enabled; only an explicit disable is stored.
  if (v.menuAccess !== undefined && v.menuAccess !== false) {
    return fail(`${path}.menuAccess`, "false or absent required");
  }
  if (v.saveAccess !== undefined && v.saveAccess !== false) {
    return fail(`${path}.saveAccess`, "false or absent required");
  }
  if (v.playerAppearance !== undefined) {
    if (!isRecord(v.playerAppearance)) return fail(`${path}.playerAppearance`, "object required");
    for (const field of ["defaultSprite", "sprite"] as const) {
      const value = v.playerAppearance[field];
      if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
        return fail(`${path}.playerAppearance.${field}`, "non-empty string required");
      }
    }
    if (v.playerAppearance.opacity !== undefined &&
        (!isNonNegInt(v.playerAppearance.opacity) || v.playerAppearance.opacity > 255)) {
      return fail(`${path}.playerAppearance.opacity`, "integer 0..255 required");
    }
    if (v.playerAppearance.visible !== undefined && typeof v.playerAppearance.visible !== "boolean") {
      return fail(`${path}.playerAppearance.visible`, "boolean required");
    }
  }
  return null;
}

function validateLatchRecord(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "record required");
  for (const [k, val] of Object.entries(v)) {
    if (val !== true) return fail(`${path}.${k}`, "latch values must be true");
  }
  return null;
}

/** Durable `place` overrides: event id -> {x, y, dir|null}. */
function validatePlacements(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "record required");
  for (const [id, p] of Object.entries(v)) {
    const at = `${path}.${id}`;
    if (!isRecord(p)) return fail(at, "placement must be an object");
    if (!isNonNegInt(p.x) || !isNonNegInt(p.y)) return fail(`${at}`, "x/y non-negative integers required");
    if (p.dir !== null && !["down", "left", "right", "up"].includes(p.dir as string)) {
      return fail(`${at}.dir`, "bad direction or null");
    }
  }
  return null;
}

const MOVE_OVERRIDE_KEYS = new Set([
  "moveType", "bounds", "speed", "frequency", "wanderIntervalTicks", "running",
  "directionFix", "through", "facingMode", "routeStopped", "cooldown", "routeSpeed",
]);

function validateMoveOverride(v: unknown, path: string, event: boolean): string | null {
  if (!isRecord(v)) return fail(path, "movement override object required");
  for (const key of Object.keys(v)) {
    if (key === "pageIndex" && event) continue;
    if (!MOVE_OVERRIDE_KEYS.has(key)) return fail(`${path}.${key}`, "unknown movement override field");
  }
  if (event && !isNonNegInt(v.pageIndex)) {
    return fail(`${path}.pageIndex`, "non-negative integer required");
  }
  if (v.moveType !== undefined && !["static", "random", "approach"].includes(v.moveType as string)) {
    return fail(`${path}.moveType`, "static|random|approach required");
  }
  if (v.bounds !== undefined) {
    const b = v.bounds;
    if (!isRecord(b) || !isNonNegInt(b.x) || !isNonNegInt(b.y) ||
      !isNonNegInt(b.width) || b.width < 1 || !isNonNegInt(b.height) || b.height < 1) {
      return fail(`${path}.bounds`, "non-empty {x,y,width,height} tile rectangle required");
    }
  }
  if (v.speed !== undefined && (!isNonNegInt(v.speed) || v.speed < 1 || v.speed > 6)) {
    return fail(`${path}.speed`, "movement speed grade 1..6 required");
  }
  if (v.routeSpeed !== undefined && (!isNonNegInt(v.routeSpeed) || v.routeSpeed < 1 || v.routeSpeed > 6)) {
    return fail(`${path}.routeSpeed`, "movement speed grade 1..6 required");
  }
  if (v.frequency !== undefined && (!isNonNegInt(v.frequency) || v.frequency < 1 || v.frequency > 5)) {
    return fail(`${path}.frequency`, "movement frequency grade 1..5 required");
  }
  if (v.wanderIntervalTicks !== undefined &&
      (!isNonNegInt(v.wanderIntervalTicks) || v.wanderIntervalTicks < 1)) {
    return fail(`${path}.wanderIntervalTicks`, "positive reference-tick interval required");
  }
  for (const key of ["running", "directionFix", "through", "routeStopped"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "boolean") {
      return fail(`${path}.${key}`, "boolean required");
    }
  }
  if (v.facingMode !== undefined &&
    !["followMovement", "locked", "scripted"].includes(v.facingMode as string)) {
    return fail(`${path}.facingMode`, "followMovement|locked|scripted required");
  }
  if (v.cooldown !== undefined && !isNonNegInt(v.cooldown)) {
    return fail(`${path}.cooldown`, "non-negative integer required");
  }
  return null;
}

/** Live mapAnim instances: a save may carry mid-animation state (the frame
 *  clock restores it pixel-identically), so each entry is range-checked and
 *  instance ids must stay unique (the reducer replaces same-id replays). */
function validateMapAnims(v: unknown, path: string): string | null {
  if (!Array.isArray(v)) return fail(path, "array required");
  const seen = new Set<string>();
  for (let i = 0; i < v.length; i++) {
    const at = `${path}[${i}]`;
    const a = v[i];
    if (!isRecord(a)) return fail(at, "animation instance must be an object");
    if (typeof a.id !== "string" || a.id.length === 0) return fail(`${at}.id`, "non-empty string required");
    if (seen.has(a.id)) return fail(`${at}.id`, "duplicate animation instance id");
    seen.add(a.id);
    if (typeof a.anim !== "string" || a.anim.length === 0) return fail(`${at}.anim`, "non-empty string required");
    if (!isNonNegInt(a.start)) return fail(`${at}.start`, "non-negative integer required");
    if (!isNonNegInt(a.x) || !isNonNegInt(a.y)) return fail(`${at}`, "x/y non-negative integers required");
    if (
      a.target !== null && a.target !== "player" &&
      !(isRecord(a.target) && typeof a.target.event === "string" && a.target.event.length > 0)
    ) {
      return fail(`${at}.target`, '"player" or {event: id} or null required');
    }
    if (a.layer !== "below" && a.layer !== "above") return fail(`${at}.layer`, "'below' or 'above' required");
    if (typeof a.loop !== "boolean") return fail(`${at}.loop`, "boolean required");
  }
  return null;
}

function validateEventAppearances(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "record required");
  for (const [id, appearance] of Object.entries(v)) {
    const at = `${path}.${id}`;
    if (!isRecord(appearance) || !isNonNegInt(appearance.pageIndex)) {
      return fail(at, "appearance with non-negative pageIndex required");
    }
    if (appearance.sprite !== undefined &&
        (typeof appearance.sprite !== "string" || appearance.sprite.length === 0)) {
      return fail(`${at}.sprite`, "non-empty string required");
    }
    if (appearance.opacity !== undefined &&
        (!isNonNegInt(appearance.opacity) || appearance.opacity > 255)) {
      return fail(`${at}.opacity`, "integer 0..255 required");
    }
    if (appearance.visible !== undefined && typeof appearance.visible !== "boolean") {
      return fail(`${at}.visible`, "boolean required");
    }
  }
  return null;
}

function validateMoveControls(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "movement control state required");
  const player = validateMoveOverride(v.player, `${path}.player`, false);
  if (player) return player;
  if (!isRecord(v.events)) return fail(`${path}.events`, "record required");
  for (const [id, override] of Object.entries(v.events)) {
    if (id.length === 0) return fail(`${path}.events`, "event ids must be non-empty");
    const problem = validateMoveOverride(override, `${path}.events.${id}`, true);
    if (problem) return problem;
  }
  return null;
}

function validateLayers(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "record required");
  for (const [id, layer] of Object.entries(v)) {
    const at = `${path}.${id}`;
    if (id.length === 0 || !isRecord(layer)) return fail(at, "non-empty layer id and object required");
    if (layer.visible !== undefined && typeof layer.visible !== "boolean") {
      return fail(`${at}.visible`, "boolean required");
    }
    if (layer.variant !== undefined && (typeof layer.variant !== "string" || layer.variant.length === 0)) {
      return fail(`${at}.variant`, "non-empty string required");
    }
  }
  return null;
}

function validateParallax(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "parallax state required");
  for (const key of Object.keys(v)) {
    if (!["image", "loopX", "loopY", "sx", "sy", "zero", "phaseX", "phaseY"].includes(key)) {
      return fail(`${path}.${key}`, "unknown parallax state field");
    }
  }
  if (typeof v.image !== "string") return fail(`${path}.image`, "string required");
  if (typeof v.loopX !== "boolean" || typeof v.loopY !== "boolean") {
    return fail(path, "loopX/loopY booleans required");
  }
  for (const field of ["sx", "sy", "phaseX", "phaseY"] as const) {
    if (!isFiniteNumber(v[field])) return fail(`${path}.${field}`, "finite number required");
  }
  if (v.zero !== undefined && typeof v.zero !== "boolean") {
    return fail(`${path}.zero`, "boolean required");
  }
  return null;
}

function validateTileProperties(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "record required");
  for (const [index, tile] of Object.entries(v)) {
    const at = `${path}.${index}`;
    const parsed = Number(index);
    if (!isNonNegInt(parsed) || String(parsed) !== index || !isRecord(tile)) {
      return fail(at, "canonical non-negative cell index and object required");
    }
    if (tile.passage !== undefined && tile.passage !== "pass" && tile.passage !== "block") {
      return fail(`${at}.passage`, "pass|block required");
    }
    for (const field of ["enter", "exit"] as const) {
      if (tile[field] !== undefined) {
        const dirs = validateDirections(tile[field], `${at}.${field}`);
        if (dirs) return dirs;
      }
    }
    if (tile.passage === undefined && tile.enter === undefined && tile.exit === undefined) {
      return fail(at, "at least one tile property required");
    }
  }
  return null;
}

const TEXT_BOX_FIELDS: Readonly<Record<string, readonly string[]>> = {
  position: ["top", "center", "bottom", "topLeft", "topRight", "bottomLeft", "bottomRight", "left", "right"],
  align: ["left", "center", "right"],
  valign: ["top", "center", "bottom"],
  background: ["window", "dim", "transparent"],
};

/** A text box layout (TextBoxLayout): a non-empty record of known fields
 *  with their schema values. */
function validateTextBox(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "object required");
  const keys = Object.keys(v);
  if (keys.length === 0) return fail(path, "an absent box, not an empty one");
  for (const key of keys) {
    const allowed = Object.hasOwn(TEXT_BOX_FIELDS, key) ? TEXT_BOX_FIELDS[key]! : null;
    if (!allowed) return fail(`${path}.${key}`, "unknown text box field");
    if (!allowed.includes(v[key] as string)) return fail(`${path}.${key}`, `one of ${allowed.join(", ")} required`);
  }
  return null;
}

function validateModal(v: unknown, path: string, liveKeys: ReadonlySet<string>): string | null {
  if (v === null) return null;
  if (!isRecord(v)) return fail(path, "modal must be an object or null");
  if (typeof v.fiber !== "string" || !liveKeys.has(v.fiber)) {
    return fail(`${path}.fiber`, "modal must reference a live fiber");
  }
  if (v.kind === "text") {
    if (!Array.isArray(v.lines) || !v.lines.every((l) => typeof l === "string")) {
      return fail(`${path}.lines`, "string array required");
    }
    if (!isNonNegInt(v.revealed) || !isNonNegInt(v.total) || v.revealed > v.total) {
      return fail(`${path}`, "revealed must be within 0..total");
    }
    if (typeof v.complete !== "boolean") return fail(`${path}.complete`, "boolean required");
    if (v.pageStarts !== undefined || v.page !== undefined) {
      const starts = v.pageStarts;
      if (!Array.isArray(starts) || starts.length < 2 || starts[0] !== 0 ||
        !starts.every((at, i) => isNonNegInt(at) && at <= (v.total as number) && (i === 0 || at > starts[i - 1]))) {
        return fail(`${path}.pageStarts`, "ascending page offsets from 0 within total required");
      }
      if (!isNonNegInt(v.page) || v.page >= starts.length) {
        return fail(`${path}.page`, "an index into pageStarts required");
      }
    }
    if (v.box !== undefined) return validateTextBox(v.box, `${path}.box`);
    return null;
  }
  if (v.kind === "choices") {
    if (typeof v.prompt !== "string") return fail(`${path}.prompt`, "string required");
    if (!Array.isArray(v.options) || !v.options.every((o) => typeof o === "string")) {
      return fail(`${path}.options`, "string array required");
    }
    if (typeof v.cancellable !== "boolean") return fail(`${path}.cancellable`, "boolean required");
    const dynamic = v.keys !== undefined || v.enabled !== undefined;
    if (dynamic) {
      if (!Array.isArray(v.keys) || v.keys.length !== v.options.length ||
        !v.keys.every((key) => typeof key === "string" && key.length > 0)) {
        return fail(`${path}.keys`, "one non-empty string key per option required");
      }
      if (new Set(v.keys).size !== v.keys.length) {
        return fail(`${path}.keys`, "choice keys must be unique");
      }
      if (!Array.isArray(v.enabled) || v.enabled.length !== v.options.length ||
        !v.enabled.every((enabled) => typeof enabled === "boolean")) {
        return fail(`${path}.enabled`, "one boolean per option required");
      }
      if (!v.cancellable && !v.enabled.some((enabled) => enabled === true)) {
        return fail(`${path}.enabled`, "a non-cancellable dynamic choice needs an enabled option");
      }
    } else if (v.options.length === 0) {
      return fail(`${path}.options`, "non-empty string array required");
    }
    if (v.icons !== undefined) {
      // Authored choices only; an extChoice modal never carries icons.
      if (dynamic) return fail(`${path}.icons`, "icons are only valid on an authored choices modal");
      const e = validateChoiceIcons(v.icons, v.options.length, `${path}.icons`);
      if (e) return e;
    }
    if (!isNonNegInt(v.index) || (
      v.options.length === 0 ? v.index !== 0 : v.index >= v.options.length
    )) {
      return fail(`${path}.index`, "choice index out of range");
    }
    return null;
  }
  if (v.kind === "shop") {
    if (!isNonNegInt(v.gold)) return fail(`${path}.gold`, "non-negative integer required");
    if (typeof v.sell !== "boolean") return fail(`${path}.sell`, "boolean required");
    if (v.stage !== "buy" && v.stage !== "sell") return fail(`${path}.stage`, "'buy' or 'sell' required");
    if (!Array.isArray(v.rows) || v.rows.length === 0) {
      return fail(`${path}.rows`, "non-empty array required");
    }
    for (const row of v.rows) {
      if (!isRecord(row)) return fail(`${path}.rows`, "row must be an object");
      if (row.kind === "item") {
        if (typeof row.item !== "string") return fail(`${path}.rows`, "item row requires an item id");
        if (!isNonNegInt(row.price) || !isNonNegInt(row.owned)) {
          return fail(`${path}.rows`, "item row requires non-negative price/owned");
        }
        if (typeof row.canAfford !== "boolean" || typeof row.atCap !== "boolean") {
          return fail(`${path}.rows`, "item row requires canAfford/atCap booleans");
        }
        if (row.stock !== null && !isNonNegInt(row.stock)) {
          return fail(`${path}.rows`, "item row requires stock: non-negative integer or null");
        }
        if (typeof row.sellable !== "boolean") {
          return fail(`${path}.rows`, "item row requires a sellable boolean");
        }
      } else if (row.kind !== "sell" && row.kind !== "leave" && row.kind !== "back") {
        return fail(`${path}.rows`, "unknown row kind");
      }
    }
    if (!isNonNegInt(v.index) || v.index >= v.rows.length) {
      return fail(`${path}.index`, "shop row index out of range");
    }
    return null;
  }
  return fail(`${path}.kind`, "unknown modal kind");
}

/** Deep-validate a decoded snapshot and its save-time invariants. Returns
 *  null when the session is safe to restore, otherwise a reason string. */
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isDir4(v: unknown): v is number {
  return isNonNegInt(v) && v <= 3;
}

function validateTarget(v: unknown, path: string): string | null {
  if (v === "player") return null;
  if (isRecord(v) && typeof v.event === "string" && v.event.length > 0) return null;
  return fail(path, "'player' or {event} required");
}

/** An incremental BFS in flight (pathfind.ts). Beyond types, the visited
 *  cells must form the tree the search itself builds: the queue holds each
 *  parented cell once, in order, and every cell's parent is an adjacent cell
 *  queued before it. That rules out the parent cycles a crafted file could
 *  use to hang the path backtrack. */
function validatePathSearch(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "path search object required");
  const { W, N, start, goal, qh, qt } = v;
  if (!isNonNegInt(W) || W < 1 || !isNonNegInt(N) || N < 1 || N % W !== 0) {
    return fail(path, "positive W and N (a multiple of W) required");
  }
  if (!isNonNegInt(start) || start >= N || !isNonNegInt(goal) || goal >= N) {
    return fail(path, "start/goal cells inside the map required");
  }
  if (!isNonNegInt(qt) || qt < 1 || qt > N || !isNonNegInt(qh) || qh > qt) {
    return fail(path, "queue cursors 0 <= qh <= qt <= N required");
  }
  if (v.through !== undefined && v.through !== true) return fail(`${path}.through`, "true or absent required");
  const ints = (key: string, min: number, max: number): number[] | string => {
    const arr = v[key];
    if (!Array.isArray(arr) || arr.length !== N) return fail(`${path}.${key}`, `array of ${N} integers required`);
    for (let i = 0; i < N; i++) {
      const x = arr[i];
      if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) {
        return fail(`${path}.${key}[${i}]`, `integer ${min}..${max} required`);
      }
    }
    return arr as number[];
  };
  const parent = ints("parent", -2, 4 * N - 1);
  if (typeof parent === "string") return parent;
  const queue = ints("queue", -0x80000000, 0x7fffffff);
  if (typeof queue === "string") return queue;
  if (v.blockedMask !== null) {
    const mask = ints("blockedMask", 0, 1);
    if (typeof mask === "string") return mask;
  }
  const order = new Int32Array(N).fill(-1);
  for (let k = 0; k < qt; k++) {
    const cell = queue[k]!;
    if (cell < 0 || cell >= N || order[cell] !== -1) {
      return fail(`${path}.queue[${k}]`, "distinct cells inside the map required");
    }
    order[cell] = k;
    const word = parent[cell]!;
    if (k === 0) {
      if (cell !== start || word !== -2) return fail(`${path}.queue[0]`, "the search must start at its start cell");
      continue;
    }
    if (word < 0) return fail(`${path}.parent[${cell}]`, "a queued cell needs a parent");
    const from = word >> 2;
    const dir = word & 3;
    const adjacent = dir === 0 ? cell === from + W
      : dir === 1 ? cell === from - 1 && from % W > 0
      : dir === 2 ? cell === from - W
      : cell === from + 1 && from % W + 1 < W;
    // order[] is filled as the queue is walked, so a parent not yet seen
    // (-1) is one queued later or never.
    if (!adjacent || order[from] === -1) {
      return fail(`${path}.parent[${cell}]`, "parent must be an adjacent cell queued earlier");
    }
  }
  for (let i = 0; i < N; i++) {
    if (order[i] === -1 && parent[i] !== -1) return fail(`${path}.parent[${i}]`, "only queued cells may have a parent");
  }
  return null;
}

function validatePathPlan(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (!isRecord(v)) return fail(path, "path plan object or null required");
  if (v.search !== null) {
    const e = validatePathSearch(v.search, `${path}.search`);
    if (e) return e;
  }
  if (!Array.isArray(v.dirs) || !v.dirs.every(isDir4)) return fail(`${path}.dirs`, "array of directions 0..3 required");
  if (!isNonNegInt(v.blockedTicks)) return fail(`${path}.blockedTicks`, "non-negative integer required");
  if (!isBool(v.done)) return fail(`${path}.done`, "boolean required");
  if (v.approach !== null) {
    const a = v.approach;
    if (!isRecord(a)) return fail(`${path}.approach`, "object or null required");
    const t = validateTarget(a.target, `${path}.approach.target`);
    if (t) return t;
    if (!isDir4(a.side)) return fail(`${path}.approach.side`, "direction 0..3 required");
    if (!isNonNegInt(a.distance) || a.distance < 1) return fail(`${path}.approach.distance`, "positive integer required");
  }
  return null;
}

/** Fields shared by a character route (chars.ts RouteRun) and the player's
 *  forced route (session.ts PlayerRoute). */
function validateRouteCommon(v: Record<string, unknown>, path: string): string | null {
  if (!Array.isArray(v.steps)) return fail(`${path}.steps`, "array of move steps required");
  for (let i = 0; i < v.steps.length; i++) {
    const e = validateMoveStep(v.steps[i], `${path}.steps[${i}]`);
    if (e) return e;
  }
  if (!isNonNegInt(v.pc) || v.pc > v.steps.length) return fail(`${path}.pc`, "step index 0..steps.length required");
  if (!isBool(v.repeat) || !isBool(v.skippable)) return fail(path, "repeat/skippable booleans required");
  // A waited route names the fiber it resumes. The fiber may already be gone
  // (its own page stopped); resuming a missing or unparked fiber is a no-op,
  // so only the type is checked.
  if (v.waiter !== null && (typeof v.waiter !== "string" || v.waiter.length === 0)) {
    return fail(`${path}.waiter`, "null or a fiber key required");
  }
  if (v.pathRetriesLeft !== null && !isNonNegInt(v.pathRetriesLeft)) {
    return fail(`${path}.pathRetriesLeft`, "null or non-negative integer required");
  }
  if (v.speed !== undefined && (!isNonNegInt(v.speed) || v.speed < 1 || v.speed > 6)) {
    return fail(`${path}.speed`, "movement speed grade 1..6 required");
  }
  return validatePathPlan(v.plan, `${path}.plan`);
}

function validateRouteRun(v: unknown, path: string): string | null {
  if (v === null) return null;
  if (!isRecord(v)) return fail(path, "route object or null required");
  if (!isBool(v.patrol)) return fail(`${path}.patrol`, "boolean required");
  if (!isNonNegInt(v.waitLeft)) return fail(`${path}.waitLeft`, "non-negative integer required");
  return validateRouteCommon(v, path);
}

const CHAR_INTS = ["tx", "ty", "facing", "phase", "stepDir", "pageIndex", "thinkIn"] as const;

/** project.tileSize is fixed at 16 by the schema. */
const SAVE_TILE = 16;
/** The slowest step the runtime can latch: the 8-tick base step (2 px per
 *  reference tick) at MV speed grade 1, four halvings below the default 5. */
const MAX_STEP_FRAMES = 128;
const STEP_DX = [0, -1, 0, 1] as const; // down, left, up, right (Dir4)
const STEP_DY = [1, 0, -1, 0] as const;

/** Joint motion invariants of one character (chars.ts CharState), mirroring
 *  how the step loop reads them back: at rest the pixel position is the tile
 *  origin; mid-step it lies on the stepDir axis, strictly between the origin
 *  and the target tile, and the speed recovered from it (movement.ts
 *  activeStepConfig) divides the tile into a whole number of ticks. A
 *  pair that fails would land the character somewhere its fields never said,
 *  or make the next tick throw. */
function motionProblem(
  ch: Record<string, unknown>,
  at: string,
  subject: "character" | "player" = "character",
): string | null {
  const { tx, ty, px, py, phase, stepDir } = ch as Record<string, number>;
  const ox = tx * SAVE_TILE;
  const oy = ty * SAVE_TILE;
  if (ch.moving !== true) {
    if (phase !== 0) return fail(`${at}.phase`, `a ${subject} at rest must have phase 0`);
    if (px !== ox || py !== oy) return fail(at, `a ${subject} at rest must sit on its tile origin`);
    return null;
  }
  if (phase < 1) return fail(`${at}.phase`, `a moving ${subject} needs phase >= 1`);
  if (tx + STEP_DX[stepDir]! < 0 || ty + STEP_DY[stepDir]! < 0) {
    return fail(at, `a moving ${subject} must step into a cell with non-negative coordinates`);
  }
  const dx = px - ox;
  const dy = py - oy;
  const along = dx * STEP_DX[stepDir]! + dy * STEP_DY[stepDir]!;
  const across = STEP_DX[stepDir] === 0 ? dx : dy;
  if (across !== 0 || !(along > 0 && along < SAVE_TILE)) {
    return fail(at, `a moving ${subject}'s pixel position must lie between its tile and the stepDir neighbour`);
  }
  // along < SAVE_TILE already makes frames > phase.
  const frames = SAVE_TILE / (along / phase);
  if (!Number.isInteger(frames) || frames > MAX_STEP_FRAMES) {
    return fail(`${at}.phase`, `phase and pixel offset must describe a step the runtime can finish (${subject})`);
  }
  return null;
}

/** Fiber keys the saved routes will resume when they finish. Shape errors
 *  are left to validateMapRuntime. */
function savedRouteWaiters(v: unknown): Set<string> {
  const out = new Set<string>();
  if (!isRecord(v)) return out;
  const add = (route: unknown): void => {
    if (isRecord(route) && typeof route.waiter === "string") out.add(route.waiter);
  };
  if (isRecord(v.chars) && isRecord(v.chars.chars)) {
    for (const ch of Object.values(v.chars.chars)) {
      if (isRecord(ch)) add(ch.route);
    }
  }
  add(v.playerRoute);
  return out;
}

/** The map runtime a session save records beside the interpreter
 *  (save.ts SaveMapRuntime). Map-specific checks (event ids, pages, map
 *  bounds) happen in save-restore.ts. */
function validateLeftMap(v: unknown, path: string): string | null {
  if (!isRecord(v)) return fail(path, "object required");
  if (typeof v.mapId !== "string" || v.mapId.length === 0) return fail(`${path}.mapId`, "non-empty string required");
  if (!isSafeInt(v.originX) || !isSafeInt(v.originY)) return fail(path, "integer originX/originY required");
  if (!isNonNegInt(v.width) || v.width < 1 || !isNonNegInt(v.height) || v.height < 1) {
    return fail(path, "positive integer width/height required");
  }
  if (!Array.isArray(v.actors)) return fail(`${path}.actors`, "array required");
  for (let i = 0; i < v.actors.length; i++) {
    const a: unknown = v.actors[i];
    const at = `${path}.actors[${i}]`;
    if (!isRecord(a)) return fail(at, "object required");
    if (typeof a.eventId !== "string" || a.eventId.length === 0) return fail(`${at}.eventId`, "non-empty string required");
    if (!isFiniteNumber(a.px) || !isFiniteNumber(a.py)) return fail(at, "finite px/py required");
    if (!isDir4(a.facing)) return fail(`${at}.facing`, "direction 0..3 required");
    if (a.pose !== 0 && a.pose !== 1 && a.pose !== 2) return fail(`${at}.pose`, "walk pose 0..2 required");
    if (typeof a.sprite !== "string" || a.sprite.length === 0) return fail(`${at}.sprite`, "non-empty string required");
    if (!isNonNegInt(a.opacity) || a.opacity > 255) return fail(`${at}.opacity`, "integer 0..255 required");
  }
  return null;
}

function validateMapRuntime(v: unknown, path: string, autosave: boolean): string | null {
  if (!isRecord(v)) return fail(path, "object required");
  const chars = v.chars;
  if (!isRecord(chars)) return fail(`${path}.chars`, "character table object required");
  if (!isU32(chars.rng)) return fail(`${path}.chars.rng`, "u32 RNG cursor required");
  if (!isRecord(chars.chars)) return fail(`${path}.chars.chars`, "record required");
  for (const [id, ch] of Object.entries(chars.chars)) {
    const at = `${path}.chars.chars.${id}`;
    if (!isRecord(ch)) return fail(at, "character object required");
    if (ch.id !== id) return fail(`${at}.id`, "must match its table key");
    for (const key of CHAR_INTS) {
      if (!isNonNegInt(ch[key])) return fail(`${at}.${key}`, "non-negative integer required");
    }
    if (!isDir4(ch.facing) || !isDir4(ch.stepDir)) return fail(at, "facing/stepDir must be 0..3");
    if (!isFiniteNumber(ch.px) || !isFiniteNumber(ch.py)) return fail(at, "finite px/py required");
    if (!isBool(ch.moving) || !isBool(ch.visible) || !isBool(ch.blocks)) {
      return fail(at, "moving/visible/blocks booleans required");
    }
    const motion = motionProblem(ch, at);
    if (motion) return motion;
    const route = validateRouteRun(ch.route, `${at}.route`);
    if (route) return route;
    const patrol = validateRouteRun(ch.patrol, `${at}.patrol`);
    if (patrol) return patrol;
  }
  if (v.playerRoute !== null) {
    const r = v.playerRoute;
    const at = `${path}.playerRoute`;
    if (!isRecord(r)) return fail(at, "route object or null required");
    // Manual saves rest at a boundary. An autosave can preserve the exact
    // positive route phase published by a parallel command while the route
    // is moving; zero is idle and a negative phase counts down a route wait.
    if (typeof r.phase !== "number" || !Number.isSafeInteger(r.phase) || (!autosave && r.phase > 0)) {
      return fail(`${at}.phase`, autosave ? "safe integer required" : "integer <= 0 required (the player rests at a save)");
    }
    if (!isDir4(r.dir)) return fail(`${at}.dir`, "direction 0..3 required");
    if (!isBool(r.takeOver)) return fail(`${at}.takeOver`, "boolean required");
    const e = validateRouteCommon(r, at);
    if (e) return e;
  }
  if (v.leftMap !== undefined) {
    const e = validateLeftMap(v.leftMap, `${path}.leftMap`);
    if (e) return e;
  }
  if (v.fade !== null) {
    const f = v.fade;
    // The fade-out half always carries a pending transfer, which is never a
    // save point; only the fade-in after a transfer can be saved.
    if (!isRecord(f) || f.phase !== "in" || !isNonNegInt(f.half) || f.half < 1 ||
      !isNonNegInt(f.left) || f.left < 1 || f.left > f.half) {
      return fail(`${path}.fade`, "null or a fade-in {phase:'in', left 1..half, half} required");
    }
  }
  return null;
}

export function validateSnapshot(snap: unknown): string | null {
  if (!isRecord(snap)) return "state: snapshot must be an object";
  if (snap.autosave !== undefined && snap.autosave !== true) {
    return "state.autosave: true or omitted required";
  }
  if (typeof snap.map !== "string" || snap.map.length === 0) {
    return "state.map: non-empty string required";
  }
  if (!isU32(snap.held)) return "state.held: u32 button mask required";
  const extProblem = jsonValueProblem(snap.ext, "state.ext");
  if (extProblem) return extProblem;

  // player
  const p = snap.player;
  if (!isRecord(p)) return "state.player: object required";
  const ints = ["tx", "ty", "facing", "phase", "stepDir"] as const;
  for (const key of ints) {
    if (!isNonNegInt(p[key])) return `state.player.${key}: non-negative integer required`;
  }
  if (!isFiniteNumber(p.px) || !isFiniteNumber(p.py)) {
    return "state.player: px/py must be finite numbers";
  }
  // The loop above proved these are non-negative integers.
  const { facing, stepDir, tx, ty } = p as Record<(typeof ints)[number], number>;
  const { px, py } = p as Record<"px" | "py", number>;
  if (facing > 3 || stepDir > 3) return "state.player: facing/stepDir must be 0..3";
  if (typeof p.moving !== "boolean" || typeof p.walking !== "boolean") {
    return "state.player: moving/walking must be booleans";
  }
  if (snap.autosave === true) {
    const route = isRecord(snap.mapRuntime) && isRecord(snap.mapRuntime.playerRoute)
      ? snap.mapRuntime.playerRoute
      : null;
    const routePhase = route && isNonNegInt(route.phase) && route.phase > 0 ? route.phase : null;
    const routeDir = routePhase !== null && isDir4(route!.dir) ? route!.dir : stepDir;
    if (routePhase !== null && p.phase !== 0) {
      return "state.player.phase: must be 0 while an in-flight player route owns interpolation";
    }
    if (routePhase !== null && stepDir !== routeDir) {
      return "state.player.stepDir: must match an in-flight player route";
    }
    const motion = motionProblem(
      { ...p, phase: routePhase ?? p.phase, stepDir: routeDir },
      "state.player",
      "player",
    );
    if (motion) return motion;
  } else {
    // Manual-save safe point: interpolation is finished and px/py sit
    // exactly on an origin tile.
    if (p.moving !== false || p.phase !== 0) {
      return "state.player: a save must rest on a tile boundary (moving=false, phase=0)";
    }
    if (px !== tx * 16 || py !== ty * 16) {
      return "state.player: pixel position must match the tile origin";
    }
  }

  // interp
  const it = snap.interp;
  if (!isRecord(it)) return "state.interp: object required";
  if (!isNonNegInt(it.frame)) return "state.interp.frame: non-negative integer required";
  // A fatalized interpreter is frozen runtime state, never a save point:
  // loading one would restore a hung session (review 1274 B1 backstop).
  if (it.error !== undefined) {
    return "state.interp.error: a fatal interpreter state cannot be saved";
  }
  const e = validateSwitchState(it.sw, "state.interp.sw");
  if (e) return e;

  // A waited screen presentation is the one resumable blocking safe point:
  // it has no modal/external owner and its remaining reducer state is fully
  // serializable. Other blocking fibers remain forbidden. Parallel fibers
  // serialize live, including one parked mid-wait.
  const routeWaiters = savedRouteWaiters(snap.mapRuntime);
  if (it.main !== null) {
    const fe = validateFiber(it.main, "state.interp.main", false, snap.map, routeWaiters, snap.autosave === true, it.modal);
    if (fe) return fe;
    if (!isRecord(it.main) || (it.main.mode !== "screenWait" && snap.autosave !== true)) {
      return "state.interp.main: only a waited screen effect may be saved mid-command";
    }
  }
  if (!isRecord(it.parallels)) return "state.interp.parallels: record required";
  for (const [key, fiber] of Object.entries(it.parallels)) {
    if (typeof key !== "string") return "state.interp.parallels: string keys required";
    // The reducer resolves modal ownership, erasure and page state through
    // the fiber's OWN .key, while scanTriggers indexes the dictionary by the
    // map/event key it computes; a mismatched pair would resume a fiber
    // under an event the live world does not own.
    if (isRecord(fiber) && fiber.key !== key) {
      return "state.interp.parallels: fiber key must match its dictionary key";
    }
    const fe = validateFiber(
      fiber,
      `state.interp.parallels.${key}`,
      true,
      snap.map,
      routeWaiters,
      snap.autosave === true,
      it.modal,
    );
    if (fe) return fe;
  }

  const liveKeys = new Set(Object.keys(it.parallels));
  if (isRecord(it.main) && typeof it.main.key === "string") liveKeys.add(it.main.key);
  const me = validateModal(it.modal, "state.interp.modal", liveKeys);
  if (me) return me;
  if (it.modal !== null && snap.autosave !== true) {
    return "state.interp.modal: a save cannot hold an open modal";
  }

  const er = validateLatchRecord(it.erased, "state.interp.erased");
  if (er) return er;
  const tt = validateLatchRecord(it.touched, "state.interp.touched");
  if (tt) return tt;
  if (typeof it.inputLocked !== "boolean") {
    return "state.interp.inputLocked: boolean required";
  }
  const pl = validatePlacements(it.placements, "state.interp.placements");
  if (pl) return pl;
  if (it.moveControls !== undefined) {
    const mc = validateMoveControls(it.moveControls, "state.interp.moveControls");
    if (mc) return mc;
  }
  if (it.anims !== undefined) {
    const al = validateMapAnims(it.anims, "state.interp.anims");
    if (al) return al;
  }
  if (it.eventAppearances !== undefined) {
    const appearances = validateEventAppearances(it.eventAppearances, "state.interp.eventAppearances");
    if (appearances) return appearances;
  }
  if (it.layers !== undefined) {
    const layers = validateLayers(it.layers, "state.interp.layers");
    if (layers) return layers;
  }
  if (it.parallax !== undefined) {
    const parallax = validateParallax(it.parallax, "state.interp.parallax");
    if (parallax) return parallax;
  }
  if (it.tileProperties !== undefined) {
    const tiles = validateTileProperties(it.tileProperties, "state.interp.tileProperties");
    if (tiles) return tiles;
  }
  if (it.screen !== undefined) {
    const screen = validateScreenEffects(it.screen, "state.interp.screen");
    if (screen) return screen;
  }
  if (it.audio !== undefined) {
    const audio = validateAudioState(it.audio, "state.interp.audio");
    if (audio) return audio;
  }
  if (!Array.isArray(it.cues)) return "state.interp.cues: array required";
  if (it.cues.length !== 0) return "state.interp.cues: cues must drain before save";
  if (it.hostActions !== undefined) {
    if (!Array.isArray(it.hostActions)) return "state.interp.hostActions: array required";
    if (it.hostActions.length !== 0) {
      return "state.interp.hostActions: host actions must drain before save";
    }
  }
  if (it.pendingTransfer !== null) {
    return "state.interp.pendingTransfer: no parked transfer at a save point";
  }
  if (!Array.isArray(it.pendingMoveRoutes) || it.pendingMoveRoutes.length !== 0) {
    return "state.interp.pendingMoveRoutes: no parked move routes at a save point";
  }
  if (!Array.isArray(it.pendingBattles) || it.pendingBattles.length !== 0) {
    return "state.interp.pendingBattles: no queued battles at a save point";
  }
  if (it.pendingScenes !== undefined && (!Array.isArray(it.pendingScenes) || it.pendingScenes.length !== 0)) {
    return "state.interp.pendingScenes: no queued scenes at a save point";
  }
  if (!Array.isArray(it.pendingPlacements) || it.pendingPlacements.length !== 0) {
    return "state.interp.pendingPlacements: no pending event placements at a save point";
  }
  if (!Array.isArray(it.abortedRoutes) || it.abortedRoutes.length !== 0) {
    return "state.interp.abortedRoutes: route aborts must drain before save";
  }
  if (snap.mapRuntime !== undefined) {
    const rt = validateMapRuntime(snap.mapRuntime, "state.mapRuntime", snap.autosave === true);
    if (rt) return rt;
    if (isRecord(snap.mapRuntime) && isRecord(snap.mapRuntime.leftMap) && snap.mapRuntime.leftMap.mapId === snap.map) {
      return "state.mapRuntime.leftMap.mapId: must name a map other than the current one";
    }
  }
  return null;
}

/** Validate the envelope-level cross fields F5 requires: the advertised
 *  frame clock must be the snapshot's own frame. */
export function envelopeConsistent(
  envelope: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): boolean {
  return envelope.frame === (snapshot.interp as Record<string, unknown>).frame;
}
