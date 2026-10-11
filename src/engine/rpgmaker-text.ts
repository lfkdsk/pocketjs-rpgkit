/** The 32 text colours in RPG Maker MV's stock Window.png palette. */
export const DEFAULT_MV_COLOURS: readonly string[] = Object.freeze([
  "#FFFFFF", "#20A0D6", "#FF784C", "#66CC40",
  "#99CCFF", "#CCC0FF", "#FFFFA0", "#808080",
  "#C0C0C0", "#2080CC", "#FF3810", "#00A010",
  "#3E9ADE", "#A098FF", "#FFCC20", "#000000",
  "#84AAFF", "#FFFF40", "#FF2020", "#202040",
  "#E08040", "#F0C040", "#4080C0", "#40C0F0",
  "#80FF80", "#C08080", "#8080FF", "#FF80FF",
  "#00A040", "#00E060", "#A060E0", "#C080FF",
]);

/** US-English alias for callers that use `color` elsewhere. */
export const DEFAULT_MV_COLORS = DEFAULT_MV_COLOURS;

export interface RpgMakerTextActor {
  readonly databaseId: number;
  readonly name: string;
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

export type UnsupportedRpgMakerTextCode = "\\PX" | "\\PY" | "\\FS";

export interface ParsedRpgMakerText {
  /** Visible text only: recognized escape codes are not included. */
  readonly text: string;
  /** Present only when at least one colour escape styles visible text. */
  readonly spans?: readonly RpgMakerTextColourSpan[];
  /** Unsupported codes encountered, normalized and de-duplicated in source order. */
  readonly unsupported: readonly UnsupportedRpgMakerTextCode[];
}

const PARAMETER_ESCAPE = /^\\(V|N|P|C|PX|PY|FS)\[([0-9]+)\]/i;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeColour(value: string | undefined): string | undefined {
  return value !== undefined && HEX_COLOUR.test(value) ? value.toUpperCase() : undefined;
}

function colourAt(context: RpgMakerTextContext, index: number): string {
  const palette = context.colours ?? DEFAULT_MV_COLOURS;
  return normalizeColour(palette[index]) ?? normalizeColour(palette[0]) ?? DEFAULT_MV_COLOURS[0]!;
}

function variableId(context: RpgMakerTextContext, databaseId: number): string {
  return context.variableIds?.[databaseId] ?? `v${String(databaseId).padStart(3, "0")}`;
}

/**
 * Convert the supported RPG Maker MV/MZ message escapes in one left-to-right
 * pass. Replacement values are appended as visible text and are never parsed
 * again, even when they contain backslashes that resemble escape codes.
 */
export function parseRpgMakerText(input: string, context: RpgMakerTextContext): ParsedRpgMakerText {
  const actorNames = new Map(context.actors.map((actor) => [actor.databaseId, actor.name] as const));
  const spans: RpgMakerTextColourSpan[] = [];
  const unsupported: UnsupportedRpgMakerTextCode[] = [];
  const seenUnsupported = new Set<UnsupportedRpgMakerTextCode>();
  let text = "";
  let offset = 0;
  let activeColour: string | undefined;
  let activeColourStart = 0;

  const appendVisible = (value: string): void => {
    text += value;
    offset += codePointLength(value);
  };

  const closeColourSpan = (): void => {
    if (activeColour === undefined || activeColourStart === offset) return;
    const previous = spans.at(-1);
    if (previous !== undefined && previous.end === activeColourStart && previous.colour === activeColour) {
      spans[spans.length - 1] = { ...previous, end: offset };
    } else {
      spans.push({ start: activeColourStart, end: offset, colour: activeColour });
    }
  };

  const selectColour = (colour: string): void => {
    closeColourSpan();
    activeColour = colour;
    activeColourStart = offset;
  };

  const recordUnsupported = (code: UnsupportedRpgMakerTextCode): void => {
    if (seenUnsupported.has(code)) return;
    seenUnsupported.add(code);
    unsupported.push(code);
  };

  for (let position = 0; position < input.length;) {
    if (input[position] !== "\\") {
      const scalarLength = input.codePointAt(position)! > 0xffff ? 2 : 1;
      appendVisible(input.slice(position, position + scalarLength));
      position += scalarLength;
      continue;
    }

    // RPG Maker uses two backslashes to print one literal backslash. Handling
    // this first also prevents the second slash from starting an escape.
    if (input[position + 1] === "\\") {
      appendVisible("\\");
      position += 2;
      continue;
    }

    const rest = input.slice(position);
    const parameterMatch = PARAMETER_ESCAPE.exec(rest);
    if (parameterMatch !== null) {
      const raw = parameterMatch[0];
      const code = parameterMatch[1]!.toUpperCase();
      const argument = Number(parameterMatch[2]);
      // Treat integers that cannot be represented exactly as malformed. The
      // whole source spelling stays visible, just like any other malformed code.
      if (!Number.isSafeInteger(argument)) {
        appendVisible(raw);
        position += raw.length;
        continue;
      }

      position += raw.length;
      if (code === "V") {
        const id = variableId(context, argument);
        const value = Object.prototype.hasOwnProperty.call(context.variables, id)
          ? context.variables[id]
          : undefined;
        appendVisible(value === undefined ? "0" : String(value));
      } else if (code === "N") {
        appendVisible(actorNames.get(argument) ?? "");
      } else if (code === "P") {
        const actorId = context.partyActorIds[argument - 1];
        appendVisible(actorId === undefined ? "" : actorNames.get(actorId) ?? "");
      } else if (code === "C") {
        selectColour(colourAt(context, argument));
      } else {
        recordUnsupported(`\\${code}` as UnsupportedRpgMakerTextCode);
      }
      continue;
    }

    if (input[position + 1]?.toUpperCase() === "G") {
      appendVisible(context.currencyUnit);
      position += 2;
      continue;
    }

    // Unknown and malformed escapes remain byte-for-byte visible. Only the
    // slash is consumed here, so any later valid escape is still recognized.
    appendVisible("\\");
    position++;
  }

  closeColourSpan();
  return spans.length === 0 ? { text, unsupported } : { text, spans, unsupported };
}
