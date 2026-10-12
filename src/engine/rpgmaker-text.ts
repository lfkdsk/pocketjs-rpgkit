import type {
  ParsedRpgMakerText,
  RpgMakerTextActor,
  RpgMakerTextColourSpan,
  RpgMakerTextConfig,
  RpgMakerTextContext,
  RpgMakerTextLayoutControl,
  RpgMakerTextRuntime,
  RpgMakerTextState,
} from "./rpgmaker-text-contract.ts";

export type {
  ParsedRpgMakerText,
  RpgMakerTextActor,
  RpgMakerTextColourSpan,
  RpgMakerTextConfig,
  RpgMakerTextContext,
  RpgMakerTextLayoutControl,
  RpgMakerTextRuntime,
  RpgMakerTextState,
} from "./rpgmaker-text-contract.ts";

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
  const layout: RpgMakerTextLayoutControl[] = [];
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

  const assignLayout = (property: "x" | "y" | "fontSize", value: number): void => {
    const previous = layout.at(-1);
    if (previous?.at === offset) {
      layout[layout.length - 1] = { ...previous, [property]: value };
    } else {
      layout.push({ at: offset, [property]: value });
    }
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
      } else if (code === "PX") {
        assignLayout("x", argument);
      } else if (code === "PY") {
        assignLayout("y", argument);
      } else {
        assignLayout("fontSize", argument);
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
  return {
    text,
    ...(spans.length > 0 ? { spans } : {}),
    ...(layout.length > 0 ? { layout } : {}),
    unsupported: [],
  };
}

function messageActors(
  state: Readonly<RpgMakerTextState>,
  config: Readonly<RpgMakerTextConfig>,
): readonly RpgMakerTextActor[] {
  const leaderDatabaseId = config.partyActorIds[0];
  return config.actors.map((actor) => {
    const variable = `actor${String(actor.databaseId).padStart(3, "0")}-name`;
    const renamed = state.variables[variable];
    const name = actor.databaseId === leaderDatabaseId
      ? state.playerName ?? actor.name
      : typeof renamed === "string" ? renamed : actor.name;
    return name === actor.name ? actor : { databaseId: actor.databaseId, name };
  });
}

/** Expand one RPG Maker message from the live reducer view. This is separate
 * from the low-level parser so actor rename conventions remain opt-in too. */
export function parseRpgMakerMessage(
  input: string,
  state: Readonly<RpgMakerTextState>,
  config: Readonly<RpgMakerTextConfig>,
): ParsedRpgMakerText {
  return parseRpgMakerText(input, {
    variables: state.variables,
    actors: messageActors(state, config),
    partyActorIds: config.partyActorIds,
    currencyUnit: config.currencyUnit,
    ...(config.colours ? { colours: config.colours } : {}),
  });
}

function numericActorId(id: string): number | null {
  const match = /(\d+)$/.exec(id);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Active RPG Maker party membership in the one saved formation order. */
export function resolveRpgMakerPartyOrder(
  state: Readonly<RpgMakerTextState>,
  config: Readonly<RpgMakerTextConfig>,
): number[] {
  const initial = config.partyActorIds;
  const initialSet = new Set(initial);
  const switches = state.switches ?? {};
  const active = [
    ...initial.filter((id) => switches[`party-out-actor${String(id).padStart(3, "0")}`] !== true),
    ...(state.actorIds ?? [])
      .map(numericActorId)
      .filter((id): id is number => id !== null && !initialSet.has(id) &&
        switches[`party-actor${String(id).padStart(3, "0")}`] === true)
      .sort((a, b) => a - b),
  ];
  if (!state.partyOrder) return active;
  const live = new Set(active);
  const ordered = state.partyOrder.filter((id, at, all) => live.has(id) && all.indexOf(id) === at);
  const held = new Set(ordered);
  for (const id of active) if (!held.has(id)) ordered.push(id);
  return ordered;
}

/** Explicit capability passed to sessions that opt into RPG Maker text. */
export const rpgMakerTextRuntime: RpgMakerTextRuntime = Object.freeze({
  parse: parseRpgMakerText,
  parseMessage: parseRpgMakerMessage,
  partyOrder: resolveRpgMakerPartyOrder,
});
