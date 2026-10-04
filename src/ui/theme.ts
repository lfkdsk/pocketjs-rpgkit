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
  for (const key of Object.keys(theme) as (keyof UiTheme)[]) {
    const value = theme[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
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
