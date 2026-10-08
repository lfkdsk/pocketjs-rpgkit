// src/engine/player-name.ts — the player's name and the {name} text token.
//
// The name lives in the switch bank (interpreter.ts SwitchState.playerName),
// so it is part of every save snapshot and survives transfers. A fresh
// session seeds it from Project.playerName (a game-configurable default);
// there is no rename op in rpgkit-project/v1 yet, but substituting at fold
// time instead of compile time keeps that door open without recompiling the
// map programs.
//
// Substitution runs inside the reducer when a text or choices modal is
// built. The typewriter reveal is counted over the EXPANDED string, so a
// 3-letter name and the 6-character "{name}" token type out over the right
// number of ticks. Pure and fold-only: no host clock, so it replays
// identically at every host rate.

import { deepClone } from "./clone.ts";
import type { JsonValue } from "./types.ts";

/** The in-text token replaced with the player's name. */
export const NAME_TOKEN = "{name}";

/** Name a fresh playthrough uses when a project sets no playerName. */
export const DEFAULT_PLAYER_NAME = "Player";

/** Replace every literal {name} token with `name`. Other braces pass
 *  through unchanged; a name containing "{name}" is substituted once (the
 *  result is not rescanned), so expansion always terminates. */
export function substitutePlayerName(text: string, name: string): string {
  if (!text.includes(NAME_TOKEN)) return text;
  return text.split(NAME_TOKEN).join(name);
}

/** Apply the name token to every line of a text page. */
export function substituteLines(lines: readonly string[], name: string): string[] {
  return lines.map((line) => substitutePlayerName(line, name));
}

// --- text tokens ------------------------------------------------------------
//
// With Project.system.textVariables a text or choices string may also carry
// `{v:<id>}`: the live value of variable `id` (0 when unset, the RPG Maker
// \V[n] default). A session may additionally register a TextTokenResolver:
// `{x:<key>}` then expands to the resolver's answer for `key`. {name},
// {v:…} and {x:…} are expanded in ONE left-to-right pass and the result is
// never rescanned, so a name, a string variable or a resolver answer that
// itself contains a token prints it literally. Expansion runs once, when
// the box opens; the dialog box wraps and pages the expanded text.
//
// `{x:}` is an explicit opt-in: a project declares `system.textTokens` (the
// key allowlist) to switch it on. A document without the declaration keeps
// the pre-{x:} behavior — its braces print verbatim — so the schema change
// is purely additive. The opt-in is the `xEnabled` flag below.

/** A built-in character-name token resolver. `target` is `player`, `this`,
 *  or a map event id. Returning undefined displays UNKNOWN_TEXT_TOKEN. */
export type CharacterNameResolver = (target: string) => string | undefined;

/** A `{v:<id>}`, `{x:<key>}` or `{char:<target>}` token: the selector runs
 *  to the next brace. */
const TEXT_TOKEN = /\{name\}|\{v:([^{}]*)\}|\{x:([^{}]*)\}|\{char:([^{}]*)\}/g;

/** What an unanswered `{x:<key>}` token shows (no resolver, or the
 *  resolver returns undefined for the key). */
export const UNKNOWN_TEXT_TOKEN = "???";

/** Read-only session state handed to a game's `{x:}` resolver. It is a
 *  deterministic slice of the session at box open: the resolver must be a
 *  pure function of it (no host clock, no randomness, no mutation), because
 *  the expanded text enters the dialog state and has to survive saves,
 *  rewind and host-rate changes. */
export interface TextTokenView {
  /** The player's name, as substituted for `{name}`. */
  readonly playerName: string;
  /** The live variable bank, as read by `{v:}`. */
  readonly variables: Readonly<Record<string, number | string>>;
  /** The party's money. */
  readonly gold: number;
  /** The map the box is opening on. */
  readonly mapId: string;
  /** A deep-frozen snapshot of the game's own extension state
   *  (`SessionState.ext`) at box open — where a game keeps its party,
   *  quest journal and other bespoke state. Built lazily on first read, so
   *  a resolver that never looks at it pays nothing. The snapshot is a
   *  frozen copy: a resolver can read it but cannot mutate the live
   *  session through it. */
  readonly ext?: JsonValue;
}

/** A deep-frozen copy of a JSON value. A resolver can read the result but
 *  any write throws (strict mode), and it is a copy, so the live session
 *  state is unreachable through it. */
export function frozenJsonSnapshot(value: JsonValue): JsonValue {
  const copy = deepClone(value);
  deepFreezeJson(copy);
  return copy;
}

function deepFreezeJson(value: JsonValue): void {
  if (value === null || typeof value !== "object") return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else {
    for (const key of Object.keys(value)) {
      deepFreezeJson((value as Record<string, JsonValue>)[key]!);
    }
  }
}

/** Answers an `{x:<key>}` token when a box opens. Return undefined (or
 *  register no resolver at all) to show UNKNOWN_TEXT_TOKEN. */
export type TextTokenResolver = (key: string, view: TextTokenView) => string | undefined;

/** Expand {name}, {v:<id>} and, when a resolver is given, {x:<key>}
 *  tokens. Without `variables` the {v:} braces pass through verbatim (the
 *  pre-textVariables behavior); without a resolver {x:} tokens show
 *  UNKNOWN_TEXT_TOKEN. A text that carries no {x:} and a session without a
 *  resolver take the exact pre-{x:} path, so games that never use the token
 *  pay nothing.
 *
 *  `xEnabled` is the project's `system.textTokens` opt-in. When it is false
 *  the {x:…} alternative matches but returns the token verbatim, so a
 *  document written before the token existed keeps its braces and the
 *  resolver/view are never touched. */
export function expandTextTokens(
  text: string,
  name: string,
  variables: Readonly<Record<string, number | string>> | null,
  resolver?: TextTokenResolver | null,
  view?: TextTokenView | null,
  xEnabled = true,
  characterName?: CharacterNameResolver | null,
  characterNamesEnabled = true,
): string {
  if (resolver == null && !text.includes("{x:") && !text.includes("{char:")) {
    if (variables === null) return substitutePlayerName(text, name);
    if (!text.includes("{")) return text;
  }
  if (!text.includes("{")) return text;
  return text.replace(TEXT_TOKEN, (
    token,
    vid: string | undefined,
    xkey: string | undefined,
    charTarget: string | undefined,
  ) => {
    if (charTarget !== undefined) {
      if (!characterNamesEnabled) return token;
      return characterName?.(charTarget) ?? UNKNOWN_TEXT_TOKEN;
    }
    if (xkey !== undefined) {
      if (!xEnabled) return token; // no declaration: braces print verbatim
      if (resolver == null) return UNKNOWN_TEXT_TOKEN;
      const v: TextTokenView = view ?? { playerName: name, variables: variables ?? {}, gold: 0, mapId: "" };
      return resolver(xkey, v) ?? UNKNOWN_TEXT_TOKEN;
    }
    if (vid !== undefined) {
      if (variables === null) return token;
      const value = Object.prototype.hasOwnProperty.call(variables, vid) ? variables[vid] : undefined;
      return value === undefined ? "0" : String(value);
    }
    return name;
  });
}

/** Apply expandTextTokens to every line of a text page. */
export function expandTextLines(
  lines: readonly string[],
  name: string,
  variables: Readonly<Record<string, number | string>> | null,
  resolver?: TextTokenResolver | null,
  view?: TextTokenView | null,
  xEnabled = true,
  characterName?: CharacterNameResolver | null,
  characterNamesEnabled = true,
): string[] {
  return lines.map((line) =>
    expandTextTokens(line, name, variables, resolver, view, xEnabled, characterName, characterNamesEnabled));
}
