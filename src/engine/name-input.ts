// src/engine/name-input.ts — the built-in name-input scene.
//
// A generic, MV-style "Name Input Processing" scene the game registers like
// battle rules: an event opens it with `{ op: "scene", id: NAME_INPUT_SCENE_ID,
// args: {...} }`, the player edits a buffer on a charset grid, and the result
// writes a variable or the player name. It is a deliberately generic
// simplification, not a byte-for-byte port of either RPG Maker MV or Tuxemon:
//
// - Cancel closes the scene and runs onCancel (MV's Name Input maps the back
//   key to delete-char and restores the entry default on an empty confirm;
//   neither is implemented here). `swallowCancel: true` instead swallows the
//   cancel key, matching Tuxemon's InputMenu opened with escape_key_exits=False
//   (rename_player/rename_monster).
// - The buffer prefills from the live variable/player-name value, or from
//   `default`. Tuxemon's player rename starts empty and its monster rename
//   starts from the translated species name; adapters pass `default` to match.
// - `maxLength` clamps to 1..24 (Tuxemon uses 15 via char_limit). An empty
//   commit is refused unless `allowEmpty` is set with a variable target.
// - Held-key repeat is 30/6 reference ticks (0.50 s / 0.10 s); Tuxemon uses
//   0.50 s / 0.08 s. The schedule is on the reference clock, so the cursor is
//   identical at 60/30/20/4 Hz for the same virtual time.
//
// Pure reducer: every visual fact (buffer, cursor, charset, held-key
// repeat) lives in the JSON state, so replay/rewind reproduce the same
// screen.

import { deepClone } from "./clone.ts";
import type { ExtensionReadContext } from "./extensions.ts";
import { rngNext } from "./interpreter.ts";
import type { SceneCompletion, SceneRules, SceneStart } from "./scene.ts";
import type { JsonValue } from "./types.ts";
import type { UiTextTable } from "./ui-text.ts";

export const NAME_INPUT_SCENE_ID = "rpgkit.nameInput";

/** Held-key repeat: after REPEAT_DELAY reference ticks, the cursor moves
 *  every REPEAT_RATE ticks while a direction stays held. */
const REPEAT_DELAY = 30;
const REPEAT_RATE = 6;

const DEFAULT_MAX_LENGTH = 8;
const DEFAULT_COLUMNS = 10;
/** The caption a scene started without `title` stores. NameInputScene
 *  draws the ui-text table's `nameInput.title` in its place (English
 *  "Name"), so the stored state stays the same in every language. */
export const NAME_INPUT_DEFAULT_TITLE = "Name";

/** English defaults of NameInputScene's words (engine/ui-text.ts keys):
 *  the default caption and the BACK / OK / CANCEL / RANDOM cells. */
export const NAME_INPUT_UI_TEXT = {
  "nameInput.title": NAME_INPUT_DEFAULT_TITLE,
  "nameInput.back": "<",
  "nameInput.ok": "OK",
  "nameInput.cancel": "X",
  "nameInput.random": "RANDOM",
} as const satisfies Partial<UiTextTable>;
const DEFAULT_TITLE = NAME_INPUT_DEFAULT_TITLE;
/** 67 chars + BACK/OK/CANCEL = 70 entries = a neat 7×10 grid. */
const DEFAULT_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'-.!?";

/** BACK, OK, CANCEL always follow the charset; RANDOM joins them only when
 *  the scene resolved a non-empty random-name candidate list. */
export const NAME_INPUT_ACTION_BACK = 0;
export const NAME_INPUT_ACTION_OK = 1;
export const NAME_INPUT_ACTION_CANCEL = 2;
export const NAME_INPUT_ACTION_RANDOM = 3;

/** Action entries following the charset: BACK, OK, CANCEL, and RANDOM when
 *  the scene carries a candidate list. */
export function nameInputActionCount(state: Readonly<NameInputState>): number {
  return state.random ? 4 : 3;
}

export interface NameInputArgs {
  /** Variable id to write the committed name to. Omitted → write the
   *  player name (sw.playerName, the {name} text token). */
  variable?: string;
  /** Buffer capacity. Default 8 (MV); clamped to 1..24 (the save-validated
   *  player-name range; Tuxemon uses 15). */
  maxLength?: number;
  /** Initial buffer. Overrides the live prefill (the variable's current
   *  string value, or the current player name). Truncated to maxLength. */
  default?: string;
  /** Caption above the edit box. Default "Name". */
  title?: string;
  /** Flat single-character table. Defaults to A-Z a-z 0-9 '-.!? (67 chars). */
  charset?: string[];
  /** Grid columns. Default 10. */
  columns?: number;
  /** Allow committing an empty buffer. Only meaningful with `variable`;
   *  a player name must stay non-empty (saves require 1..24 chars). */
  allowEmpty?: boolean;
  /** Swallow the cancel key (physical cancel and the grid CANCEL action)
   *  instead of closing the scene, matching Tuxemon's InputMenu opened with
   *  escape_key_exits=False (rename_player/rename_monster). Default false:
   *  cancel closes the scene and runs onCancel. */
  swallowCancel?: boolean;
  /** Random-name candidates. A flat list is used directly. A table is
   *  indexed by `randomNamesKey` (static) or by the string value of
   *  `randomNamesKeyVariable` at scene start; a key absent from the table
   *  falls back to `randomNamesFallbackKey`. When the resolved list is
   *  non-empty, a RANDOM action cell appears after CANCEL: each confirm on
   *  it draws one candidate through the scene's own seeded RNG cursor and
   *  replaces the buffer (truncated to maxLength), so save/load and rewind
   *  reproduce the same pick. */
  randomNames?: string[] | Record<string, string[]>;
  /** Static key into a `randomNames` table. */
  randomNamesKey?: string;
  /** Variable whose string value selects a `randomNames` table row at
   *  scene start. Ignored when `randomNamesKey` is set. */
  randomNamesKeyVariable?: string;
  /** Table key used when the selected key is absent or its row is empty. */
  randomNamesFallbackKey?: string;
}

export interface NameInputState {
  buffer: string;
  /** Index into entries: [0, charset.length) chars, then BACK/OK/CANCEL. */
  cursor: number;
  charset: string[];
  columns: number;
  rows: number;
  maxLength: number;
  title: string;
  /** True when the scene set `title` itself (no `title` arg): the view
   *  draws the ui-text table's `nameInput.title` in its place, so the
   *  stored state stays the same in every language. A game that passes an
   *  explicit title (even the literal "Name") sets this false and keeps
   *  its own wording. */
  titleIsDefault: boolean;
  variable: string | null;
  allowEmpty: boolean;
  phase: "edit" | "done";
  cancelled: boolean;
  swallowCancel: boolean;
  /** Held-direction repeat bookkeeping: BTN direction bit + ticks held. */
  holdDir: number;
  holdTicks: number;
  lastButtons: number;
  /** Per-scene mulberry32 cursor, seeded once from the session RNG. Advances
   *  only on a RANDOM pick, so the drawn name is a pure function of the
   *  state and reproduces under save/load and rewind. */
  rng: number;
  /** True when the RANDOM action cell is present (a non-empty candidate
   *  list resolved at start). */
  random: boolean;
  /** The resolved candidate list, stored in state for deterministic replay. */
  randomPool: string[];
  ext: JsonValue;
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function normalizeCharset(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    // Keep only printable single code units: every non-printable code point
    // is dropped, not just C0/C1 and DEL — format characters (zero-width,
    // BOM), line/paragraph separators, private-use, unassigned and surrogate
    // code units would all render an invisible or line-breaking grid cell
    // (Tuxemon renders NUL as a disabled cell, never a writable char), so a
    // custom charset cannot smuggle one into the buffer or the grid.
    const chars = value.filter((c): c is string =>
      typeof c === "string" && c.length === 1 && isPrintableChar(c));
    if (chars.length > 0) return chars;
  }
  return DEFAULT_CHARSET.split("");
}

// A single UTF-16 code unit is printable only when its code point is outside
// Unicode's C* categories (Cc controls, Cf format, Cs surrogates, Co private
// use, Cn unassigned) and not a line (Zl) or paragraph (Zp) separator. Space
// separators (Zs, e.g. U+0020 and U+00A0) render a visible cell and stay.
const NON_PRINTABLE_CODEUNIT = /[\p{C}\p{Zl}\p{Zp}]/u;

function isPrintableChar(c: string): boolean {
  return !NON_PRINTABLE_CODEUNIT.test(c);
}

/** Clamp an integer argument into [min, max]; a non-integer or a non-number
 *  falls back to `fallback`. Unlike a membership test, an out-of-range
 *  integer clamps to the nearest bound (25 -> 24, 0 -> 1). */
function clampArgInt(value: JsonValue, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: JsonValue, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

function prefill(args: Record<string, JsonValue>, ctx: ExtensionReadContext, maxLength: number): string {
  const source = typeof args.default === "string"
    ? args.default
    : typeof args.variable === "string"
      ? ctx.variables[args.variable]
      : ctx.playerName;
  const text = typeof source === "string" ? source : "";
  return text.slice(0, maxLength);
}

/** Keep only non-empty strings from a JSON value claimed to be a name list. */
function nameList(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];
}

/** Resolve the random-name candidate list per the args documented on
 *  NameInputArgs. A flat list is used directly; a table is indexed by the
 *  static key or the key variable's live string value, falling back to the
 *  fallback key's row. Returns [] when no candidate is available. */
function resolveRandomPool(args: Record<string, JsonValue>, ctx: ExtensionReadContext): string[] {
  const raw = args.randomNames;
  if (Array.isArray(raw)) return nameList(raw);
  if (raw === null || typeof raw !== "object") return [];
  const table = raw as Record<string, JsonValue>;
  let key = typeof args.randomNamesKey === "string" ? args.randomNamesKey : "";
  if (!key && typeof args.randomNamesKeyVariable === "string") {
    const v = ctx.variables[args.randomNamesKeyVariable];
    key = typeof v === "string" || typeof v === "number" ? String(v) : "";
  }
  const pool = nameList(table[key]);
  if (pool.length > 0) return pool;
  return typeof args.randomNamesFallbackKey === "string"
    ? nameList(table[args.randomNamesFallbackKey])
    : [];
}

function stateOf(value: JsonValue): NameInputState {
  return value as unknown as NameInputState;
}

function moveCursor(state: NameInputState, delta: number): void {
  const total = state.charset.length + nameInputActionCount(state);
  state.cursor = (state.cursor + delta + total) % total;
}

/** The built-in name-input SceneRules. Register it as
 *  `{ [NAME_INPUT_SCENE_ID]: nameInputRules }` in createSession's `scenes`
 *  and `NameInputScene` in GameView's `sceneViews`. */
export const nameInputRules: SceneRules = {
  start(ext, rawArgs, seed, ctx): SceneStart {
    const args = record(rawArgs);
    const maxLength = clampArgInt(args.maxLength, 1, 24, DEFAULT_MAX_LENGTH);
    const columns = clampInt(args.columns, 1, 20, DEFAULT_COLUMNS);
    const charset = normalizeCharset(args.charset);
    const variable = typeof args.variable === "string" && args.variable.length > 0
      ? args.variable
      : null;
    const titleArg = typeof args.title === "string" && args.title.length > 0 ? args.title : null;
    const randomPool = resolveRandomPool(args, ctx);
    const state: NameInputState = {
      buffer: prefill(args, ctx, maxLength),
      cursor: 0,
      charset,
      columns,
      rows: Math.ceil((charset.length + (randomPool.length > 0 ? 4 : 3)) / columns),
      maxLength,
      title: titleArg ?? DEFAULT_TITLE,
      titleIsDefault: titleArg === null,
      variable,
      allowEmpty: args.allowEmpty === true,
      swallowCancel: args.swallowCancel === true,
      phase: "edit",
      cancelled: false,
      holdDir: 0,
      holdTicks: 0,
      lastButtons: 0,
      rng: seed >>> 0,
      random: randomPool.length > 0,
      randomPool,
      ext: deepClone(ext),
    };
    return { ext: deepClone(ext), state: state as unknown as JsonValue };
  },

  step(rawState, input, ticks): JsonValue {
    const state = stateOf(rawState);
    if (state.phase !== "edit") return rawState;
    const buttons = input.buttons >>> 0;
    state.lastButtons = buttons;

    // A pointer/touch selects and activates one cell atomically. Keeping the
    // index in reducer input (rather than mutating view state) makes the
    // resulting edit reproducible by any host that records semantic scene
    // input. A malformed index is ignored and cannot accidentally activate
    // the previously focused cell.
    const totalEntries = state.charset.length + nameInputActionCount(state);
    const hasSelection = input.selectIndex !== undefined;
    const selected = Number.isInteger(input.selectIndex) &&
      input.selectIndex! >= 0 && input.selectIndex! < totalEntries;
    if (hasSelection && !selected) return rawState;
    if (selected) {
      state.cursor = input.selectIndex!;
      state.holdDir = 0;
      state.holdTicks = 0;
    }

    if (!selected && input.cancelEdge === true) {
      // swallowCancel (Tuxemon escape_key_exits=False): the cancel key is
      // consumed but does not close the scene.
      if (!state.swallowCancel) {
        state.phase = "done";
        state.cancelled = true;
      }
      return rawState;
    }

    // Edge navigation (one move per press). Direction bits match the
    // pocket button contract (UP 0x10, RIGHT 0x20, DOWN 0x40, LEFT 0x80).
    const dirDelta = (dir: number): number =>
      dir === 0x0010 ? -state.columns
        : dir === 0x0040 ? state.columns
          : dir === 0x0080 ? -1
            : 1;
    const edgeDir = selected ? 0
      : input.upEdge ? 0x0010
      : input.downEdge ? 0x0040
      : input.leftEdge ? 0x0080
      : input.rightEdge ? 0x0020
      : 0;
    if (edgeDir !== 0) {
      moveCursor(state, dirDelta(edgeDir));
      state.holdDir = edgeDir;
      state.holdTicks = 0;
    } else if (state.holdDir !== 0 && (buttons & state.holdDir) !== 0) {
      // Held-direction repeat on the fixed reference clock, so the repeat
      // schedule is identical at 60/30/20/4 Hz. A low-rate frame carries
      // many ticks and can cross several repeat periods: fold every repeat
      // that fell due inside the consumed ticks, keeping the residual so
      // the next repeat stays 6 ticks away at every host rate.
      state.holdTicks += ticks;
      while (state.holdTicks >= REPEAT_DELAY) {
        moveCursor(state, dirDelta(state.holdDir));
        state.holdTicks -= REPEAT_RATE;
      }
    } else {
      state.holdDir = 0;
      state.holdTicks = 0;
    }

    if (!selected && input.confirmEdge !== true) return rawState;
    if (state.cursor < state.charset.length) {
      if (state.buffer.length < state.maxLength) {
        state.buffer += state.charset[state.cursor]!;
      }
      return rawState;
    }
    const action = state.cursor - state.charset.length;
    if (action === NAME_INPUT_ACTION_BACK) {
      state.buffer = state.buffer.slice(0, -1);
    } else if (action === NAME_INPUT_ACTION_OK) {
      if (state.buffer.length > 0 || (state.allowEmpty && state.variable !== null)) {
        state.phase = "done";
      }
    } else if (action === NAME_INPUT_ACTION_CANCEL) {
      if (!state.swallowCancel) {
        state.phase = "done";
        state.cancelled = true;
      }
    } else if (action === NAME_INPUT_ACTION_RANDOM && state.randomPool.length > 0) {
      // One mulberry32 draw per pick, cursor kept in state: the same scene
      // state always draws the same name (save/load, rewind, replay).
      const draw = rngNext(state.rng);
      state.rng = draw.next;
      const pick = state.randomPool[Math.floor(draw.value * state.randomPool.length)] ?? "";
      // Upstream InputController.set_string truncates to the char limit.
      state.buffer = pick.slice(0, state.maxLength);
    }
    return rawState;
  },

  done(rawState): SceneCompletion | null {
    const state = stateOf(rawState);
    if (state.phase !== "done") return null;
    if (state.cancelled) return { cancelled: true, ext: state.ext };
    return state.variable !== null
      ? { ext: state.ext, writes: { [state.variable]: state.buffer } }
      : { ext: state.ext, playerName: state.buffer };
  },
};

/** The charset char at a state cursor, or "" for an action entry. The UI
 *  uses this to label grid cells. */
export function nameInputCharAt(state: Readonly<NameInputState>, index: number): string {
  return index >= 0 && index < state.charset.length ? state.charset[index]! : "";
}

/** Ui-text keys of the action cells in grid order: BACK, OK, CANCEL, then
 *  RANDOM when the scene resolved a candidate list. */
export const NAME_INPUT_ACTION_KEYS = [
  "nameInput.back",
  "nameInput.ok",
  "nameInput.cancel",
  "nameInput.random",
] as const;

/** The ui-text key of the action cell at a state cursor, or null for a
 *  charset cell. Index 3 (RANDOM) exists only when state.random. */
export function nameInputActionKey(
  state: Readonly<NameInputState>,
  index: number,
): (typeof NAME_INPUT_ACTION_KEYS)[number] | null {
  const action = index - state.charset.length;
  if (action < 0 || action >= nameInputActionCount(state)) return null;
  return NAME_INPUT_ACTION_KEYS[action] ?? null;
}
