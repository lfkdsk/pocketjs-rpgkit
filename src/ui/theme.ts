// src/ui/theme.ts — the palette the kit's framed UI draws with (DialogBox,
// SaveMenu, Panel), and the speaker-prefix rule behind DialogBox portraits.
// Plain TypeScript with no JSX, so a game's non-UI modules (and the root
// "pocket-rpgkit" entry) can import it.
//
// Every framed panel is layered the same way:
//
//   border   the outer 2 px frame
//   rim      optional 1 px ring just inside the border
//   paper    the fill the text sits on
//
// The rim is drawn as an inset border on the paper layer, so adding one
// does not move or shrink the content: a themed box lays out its text on
// exactly the same pixels as the default one.

import type { ScreenTone } from "../engine/types.ts";

export interface UiTheme {
  /** Outer frame of every panel; also the fill of the speaker name tab. */
  border: string;
  /** Optional ring 1 px wide just inside the border. Absent: no ring. */
  rim?: string;
  /** Panel fill; also the text colour of the speaker name tab. */
  paper: string;
  /** Body text: message rows, unselected choices, menu rows. */
  ink: string;
  /** Secondary text: choice prompt, button legends, hints. */
  dim: string;
  /** Titles and the selected choice / menu row. */
  accent: string;
  /** Full-screen backdrop behind the save menu. */
  backdrop: string;
  /** Runtime tone applied to window chrome, never to its text/children. */
  windowTone?: Readonly<ScreenTone>;
}

/** The kit's own look: steel-blue frame on a navy panel. */
export const DEFAULT_UI_THEME: Readonly<UiTheme> = Object.freeze({
  border: "#5d7fa3",
  paper: "#0b1626",
  ink: "#dce8ff",
  dim: "#8aa4c4",
  accent: "#ffe97a",
  backdrop: "#00000a",
});

/** Fill a partial theme from DEFAULT_UI_THEME. Keys set to undefined keep
 *  the default, so `{ ...base, paper: maybe }` is safe to pass. */
export function resolveUiTheme(theme?: Partial<UiTheme>): UiTheme {
  const out: UiTheme = { ...DEFAULT_UI_THEME };
  if (!theme) return out;
  if (theme.border !== undefined) out.border = theme.border;
  if (theme.rim !== undefined) out.rim = theme.rim;
  if (theme.paper !== undefined) out.paper = theme.paper;
  if (theme.ink !== undefined) out.ink = theme.ink;
  if (theme.dim !== undefined) out.dim = theme.dim;
  if (theme.accent !== undefined) out.accent = theme.accent;
  if (theme.backdrop !== undefined) out.backdrop = theme.backdrop;
  if (theme.windowTone !== undefined) out.windowTone = theme.windowTone;
  return out;
}

export interface WindowToneStyle {
  toneR: number;
  toneG: number;
  toneB: number;
  toneGray: number;
}

const ZERO_WINDOW_TONE_STYLE: Readonly<WindowToneStyle> = Object.freeze({
  toneR: 0,
  toneG: 0,
  toneB: 0,
  toneGray: 0,
});

function toneChannel(value: number): number {
  return Math.max(-255, Math.min(255, Math.trunc(value)));
}

function toneGray(value: number): number {
  return Math.max(0, Math.min(255, Math.trunc(value)));
}

function normalizedWindowTone(tone: Readonly<ScreenTone>): ScreenTone {
  return {
    r: toneChannel(tone.r),
    g: toneChannel(tone.g),
    b: toneChannel(tone.b),
    gray: toneGray(tone.gray),
  };
}

interface ParsedThemeColor {
  rgb: readonly [number, number, number];
  alpha: string;
  opaque: boolean;
}

function parseThemeColor(color: string): ParsedThemeColor | null {
  let hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((part) => part + part).join("");
  if ((hex.length !== 6 && hex.length !== 8) || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const alpha = hex.length === 8 ? hex.slice(6).toLowerCase() : "";
  return {
    rgb: [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ],
    alpha,
    opaque: alpha === "" || alpha === "ff",
  };
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** Exact straight-colour equivalent of PocketJS's destination-tone equation.
 * It is used only when a translucent decoration or a fixed backend cannot
 * safely execute destination tone; the source alpha is preserved verbatim. */
function windowToneColor(color: string, tone: Readonly<ScreenTone>): string {
  const parsed = parseThemeColor(color);
  if (!parsed) return color;
  const [r, g, b] = parsed.rgb;
  const loHi = Math.min(r, g, b) + Math.max(r, g, b);
  const gray = tone.gray;
  const channels = parsed.rgb.map((channel, index) => {
    const offset = index === 0 ? tone.r : index === 1 ? tone.g : tone.b;
    const numerator = 2 * channel * (255 - gray) + loHi * gray + 2 * offset * 255;
    const bounded = Math.max(0, Math.min(2 * 255 * 255, numerator));
    return Math.floor((bounded + 255) / (2 * 255));
  });
  return `#${channels.map(byteHex).join("")}${parsed.alpha}`;
}

/** Exact source-colour projection for chrome drawn by a Text node or an
 * extension component that cannot carry the View-only tone primitive. */
export function windowTonePaletteColor(
  theme: Pick<UiTheme, "windowTone">,
  color: string,
): string {
  return theme.windowTone ? windowToneColor(color, theme.windowTone) : color;
}

export interface WindowToneDecoration extends WindowToneStyle {
  bgColor: string;
  borderColor?: string;
}

/** Project tone onto one flat piece of window chrome. Opaque rectangles use
 * the native primitive; translucent/invalid colours are pre-toned so the
 * destination behind them is never filtered. Zero fields are deliberately
 * retained to clear a previously toned inline style. */
export function windowToneDecoration(
  theme: Pick<UiTheme, "windowTone">,
  decoration: Readonly<{ bgColor: string; borderColor?: string }>,
): WindowToneDecoration {
  const tone = theme.windowTone;
  if (!tone) return { ...decoration, ...ZERO_WINDOW_TONE_STYLE };
  const bg = parseThemeColor(decoration.bgColor);
  const border = decoration.borderColor === undefined ? undefined : parseThemeColor(decoration.borderColor);
  if (bg?.opaque && (decoration.borderColor === undefined || border?.opaque)) {
    return {
      ...decoration,
      toneR: tone.r,
      toneG: tone.g,
      toneB: tone.b,
      toneGray: tone.gray,
    };
  }
  return {
    bgColor: windowToneColor(decoration.bgColor, tone),
    ...(decoration.borderColor === undefined
      ? {}
      : { borderColor: windowToneColor(decoration.borderColor, tone) }),
    ...ZERO_WINDOW_TONE_STYLE,
  };
}

/** Runtime window tone for message/choice/menu chrome. The full tone is
 * carried to Panel on exact software targets. Fixed backends retain the exact
 * palette projection, including gray-before-RGB ordering. Neutral state keeps
 * the caller's exact reference and allocation-free path. */
export function windowToneTheme(
  theme: Partial<UiTheme> | undefined,
  tone: Readonly<ScreenTone> | undefined,
  nativeEffects?: boolean,
): Partial<UiTheme> | undefined {
  if (!tone || (tone.r === 0 && tone.g === 0 && tone.b === 0 && tone.gray === 0)) return theme;
  const normalized = normalizedWindowTone(tone);
  const resolved = resolveUiTheme(theme);
  if (nativeEffects === true) {
    return { ...resolved, windowTone: normalized };
  }
  return {
    ...resolved,
    windowTone: undefined,
    border: windowToneColor(resolved.border, normalized),
    ...(resolved.rim === undefined ? {} : { rim: windowToneColor(resolved.rim, normalized) }),
    paper: windowToneColor(resolved.paper, normalized),
  };
}

/** A fully transparent colour: a layer that draws nothing. */
export const CLEAR_COLOR = "#00000000";

/** `color` ("#rgb", "#rgba", "#rrggbb" or "#rrggbbaa") at `alpha` (0..1) of
 *  its own opacity, as "#rrggbbaa". Anything else comes back unchanged. */
export function translucentColor(color: string, alpha: number): string {
  let hex = color.startsWith("#") ? color.slice(1) : "";
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
  if ((hex.length !== 6 && hex.length !== 8) || !/^[0-9a-fA-F]+$/.test(hex)) return color;
  const own = hex.length === 8 ? parseInt(hex.slice(6), 16) : 255;
  const a = Math.round(own * Math.min(1, Math.max(0, alpha)));
  return `#${hex.slice(0, 6)}${a.toString(16).padStart(2, "0")}`;
}

export interface SpeakerSplit {
  /** The speaker's key in the faces table, or null for a plain line. */
  name: string | null;
  /** The line without its "NAME: " prefix (the whole line when no speaker). */
  rest: string;
  /** Characters dropped from the front of the line (0 when no speaker). */
  cut: number;
}

const SPEAKER_PREFIX = /^([A-Z][A-Z]+): /;

/** "KEEPER: The lamp is lit." -> { name: "KEEPER", rest: "The lamp is lit.",
 *  cut: 8 }. Only names that have an entry in `faces` count as speakers:
 *  any other line, "MAYOR: ..." included, comes back unchanged. */
export function splitSpeaker(line: string, faces: Readonly<Record<string, string>>): SpeakerSplit {
  const m = SPEAKER_PREFIX.exec(line);
  // All-caps names never collide with Object.prototype keys.
  if (!m || !faces[m[1]!]) return { name: null, rest: line, cut: 0 };
  return { name: m[1]!, rest: line.slice(m[0].length), cut: m[0].length };
}

/** The name tab's label: "POSTMASTER" -> "Postmaster". */
export function speakerLabel(name: string): string {
  return name.charAt(0) + name.slice(1).toLowerCase();
}
