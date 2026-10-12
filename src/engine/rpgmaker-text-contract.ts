/** Type-only boundary for the optional RPG Maker message grammar. */

import type { ScreenEffectsState } from "./screen.ts";
import type { ScreenTone, WeatherKind } from "./types.ts";

export interface RpgMakerTextActor {
  readonly databaseId: number;
  readonly name: string;
}

/** Imported database facts retained only by projects that opt into the RPG
 * Maker message grammar. */
export interface RpgMakerTextConfig {
  readonly actors: readonly RpgMakerTextActor[];
  readonly partyActorIds: readonly number[];
  readonly currencyUnit: string;
  readonly colours?: readonly string[];
}

/** Live reducer facts needed by RPG Maker name escapes and formation order.
 * Keeping their interpretation behind the capability boundary prevents
 * ordinary projects from evaluating actor-id and switch-name conventions. */
export interface RpgMakerTextState {
  readonly variables: Readonly<Record<string, number | string>>;
  readonly switches?: Readonly<Record<string, boolean>>;
  readonly playerName?: string;
  readonly partyOrder?: readonly number[];
  readonly actorIds?: readonly string[];
  readonly formationAccess?: boolean;
}

export interface RpgMakerTextContext {
  readonly variables: Readonly<Record<string, number | string>>;
  readonly variableIds?: Readonly<Record<number, string | undefined>> | readonly (string | undefined)[];
  readonly actors: readonly RpgMakerTextActor[];
  /** Actor database ids, in current party order. */
  readonly partyActorIds: readonly number[];
  readonly currencyUnit: string;
  /** A replacement palette. Missing or invalid indices fall back to colour 0. */
  readonly colours?: readonly string[] | Readonly<Record<number, string | undefined>>;
}

export interface RpgMakerTextColourSpan {
  /** Inclusive global Unicode-code-point offset in `text`. */
  readonly start: number;
  /** Exclusive global Unicode-code-point offset in `text`. */
  readonly end: number;
  /** Normalized six-digit hexadecimal colour. */
  readonly colour: string;
}

/** A zero-width MZ layout control at a Unicode-code-point offset in `text`.
 * Controls at the same offset are folded together in source order; a later
 * assignment to the same property wins, like Window_Base's text state. */
export interface RpgMakerTextLayoutControl {
  readonly at: number;
  readonly x?: number;
  readonly y?: number;
  readonly fontSize?: number;
}

export interface ParsedRpgMakerText {
  /** Visible text only: recognized escape codes are not included. */
  readonly text: string;
  /** Present only when at least one colour escape styles visible text. */
  readonly spans?: readonly RpgMakerTextColourSpan[];
  /** Present only when an MZ PX/PY/FS escape changes the live text state. */
  readonly layout?: readonly RpgMakerTextLayoutControl[];
  /** Retained for API compatibility; every built-in code recognized here is supported. */
  readonly unsupported: readonly [];
}

export interface ParsedRpgMakerChoices {
  readonly prompt: string;
  readonly promptColours?: readonly RpgMakerTextColourSpan[];
  readonly options: string[];
  readonly optionColours?: (readonly RpgMakerTextColourSpan[] | null)[];
}

export interface ExpandedRpgMakerMessage {
  readonly text: string;
  readonly colours?: readonly RpgMakerTextColourSpan[];
  readonly rpgMakerLayout?: readonly RpgMakerTextLayoutControl[];
}

export interface ExpandedRpgMakerLines {
  readonly lines: string[];
  readonly colours?: readonly RpgMakerTextColourSpan[];
  readonly rpgMakerLayout?: readonly RpgMakerTextLayoutControl[];
}

export interface RpgMakerTextSourceActor {
  readonly id: string;
  readonly name: string;
  readonly databaseId?: number;
}

export interface RpgMakerTextProjectConfig {
  readonly party: readonly number[];
  readonly currencyUnit: string;
  readonly colours?: readonly string[];
}

export interface PreparedRpgMakerText {
  readonly config: RpgMakerTextConfig;
  readonly playerActor?: string;
}

/** Parser supplied only by applications that enable `system.rpgMakerText`. */
export interface RpgMakerTextRuntime {
  prepare(
    actors: readonly RpgMakerTextSourceActor[],
    config: Readonly<RpgMakerTextProjectConfig>,
  ): PreparedRpgMakerText;
  parse(input: string, context: RpgMakerTextContext): ParsedRpgMakerText;
  parseMessage(
    input: string,
    state: Readonly<RpgMakerTextState>,
    config: Readonly<RpgMakerTextConfig>,
  ): ParsedRpgMakerText;
  expandMessage(
    input: string,
    state: Readonly<RpgMakerTextState>,
    config: Readonly<RpgMakerTextConfig>,
  ): ExpandedRpgMakerMessage;
  expandLines(
    lines: readonly string[],
    state: Readonly<RpgMakerTextState>,
    config: Readonly<RpgMakerTextConfig>,
  ): ExpandedRpgMakerLines;
  parseChoices(
    prompt: string,
    options: readonly string[],
    state: Readonly<RpgMakerTextState>,
    config: Readonly<RpgMakerTextConfig>,
  ): ParsedRpgMakerChoices;
  partyOrder(
    state: Readonly<RpgMakerTextState>,
    config: Readonly<RpgMakerTextConfig>,
  ): number[];
  swapParty(
    state: Readonly<RpgMakerTextState>,
    config: Readonly<RpgMakerTextConfig>,
    first: number,
    second: number,
  ): number[] | null;
  startScreenTone(
    screen: ScreenEffectsState,
    target: Readonly<ScreenTone>,
    frames: number,
  ): void;
  startWeather(
    screen: ScreenEffectsState,
    kind: WeatherKind,
    power: number,
    frames: number,
    seed: number,
  ): void;
  advanceScreenEffects(screen: ScreenEffectsState): void;
}
