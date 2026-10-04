// src/engine/ui-text.ts — the kit's own interface words, replaceable.
//
// Every fixed word the kit's components draw (button legends, the shop box,
// the save menu, the name input, demo chrome, the event-error screen) is a
// key of UiTextTable. A game replaces any subset: Project.uiText in the
// project document (a language shard ships its own table), or GameView's /
// a standalone component's `uiText` prop (wins over the project). A missing
// key keeps the English default.
//
// The English defaults live next to the component that draws them
// (KIT_UI_TEXT below for GameView and DialogBox, SAVE_MENU_UI_TEXT in
// engine/save-menu.ts, NAME_INPUT_UI_TEXT in engine/name-input.ts,
// DEMO_MENU_UI_TEXT in ui/demo/text.ts, STAT_BAR_UI_TEXT in
// ui/battle/text.ts), so a game that
// never mounts, say, the demo menu does not bundle its words.
//
// A sentence with values in it is one template with {placeholders}
// ("Gold: {gold}", "SLOT {slot} IS EMPTY"), filled by formatUiText before
// the component wraps it to its box, so a translation is free to move the
// value anywhere in the sentence. The {name} player-name token of message
// text is unrelated: these templates never see it.
//
// Pure data: no Solid, no host. The table is presentation only — it never
// enters SessionState, saves, tapes or the reducer, so swapping it (another
// language shard, an override prop) cannot change a save or a replay.

/** Every replaceable word, by key. `{x}` marks a parameter. The English
 *  default of each key is in the module named on its group. */
export interface UiTextTable {
  // KIT_UI_TEXT (here): GameView's button legend labels (the shell prefixes
  // each with its button glyph), DialogBox's shop box, GameView's attract
  // chrome and its event-error screen.
  "legend.talk": string;
  "legend.next": string;
  "legend.ok": string;
  "legend.back": string;
  "shop.buy": string;
  "shop.sell": string;
  /** {gold} */
  "shop.gold": string;
  "shop.rowSell": string;
  "shop.rowLeave": string;
  "shop.rowBack": string;
  /** {price} */
  "shop.price": string;
  /** {price} {stock} */
  "shop.priceStock": string;
  /** {frame} (zero-padded to 3 digits) {frames} */
  "demo.badge": string;
  "demo.control": string;
  /** {seconds} */
  "demo.rewind": string;
  "error.event": string;

  // SAVE_MENU_UI_TEXT (engine/save-menu.ts): SaveMenu and menuStep.
  "save.title": string;
  "save.toSlot": string;
  "save.fromSlot": string;
  "save.codeExport": string;
  "save.codeImport": string;
  "save.slotsSaveTitle": string;
  "save.slotsLoadTitle": string;
  "save.autosave": string;
  "save.slotEmpty": string;
  "save.slotDamaged": string;
  /** {map} {frame} */
  "save.slotSummary": string;
  /** {slot} */
  "save.emptyTitle": string;
  "save.emptyBody": string;
  /** {page} {pages} */
  "save.codeTitle": string;
  "save.codeHint": string;
  "save.importTitle": string;
  "save.importHint": string;

  // NAME_INPUT_UI_TEXT (engine/name-input.ts): NameInputScene.
  "nameInput.title": string;
  "nameInput.back": string;
  "nameInput.ok": string;
  "nameInput.cancel": string;

  // DEMO_MENU_UI_TEXT (ui/demo/text.ts): the demo menu and its toast.
  "demo.menuTitle": string;
  "demo.tabChapters": string;
  "demo.tabWarp": string;
  "demo.tabAutoplay": string;
  /** {tab} */
  "demo.tabSelected": string;
  "demo.empty": string;
  /** {speed} */
  "demo.speed": string;
  "demo.speedHint": string;
  "demo.legend": string;
  "demo.legendBack": string;
  "demo.loading": string;
  "demo.warped": string;
  "demo.error": string;
  "demo.badLink": string;
  /** {id} */
  "demo.errorUnknownChapter": string;
  /** {id} */
  "demo.errorUnknownMap": string;
  /** {id} */
  "demo.errorUnknownAutoplay": string;
  "demo.errorXY": string;
  "demo.badLinkChooseOne": string;
  "demo.badLinkSpeed": string;

  // STAT_BAR_UI_TEXT (ui/battle/text.ts): StatBar's numeric readout.
  /** {current} {max} */
  "battle.statValue": string;
}

export type UiTextKey = keyof UiTextTable;

/** A game's replacements: any subset of the keys. */
export type UiTextOverrides = Readonly<Partial<UiTextTable>>;

/** English defaults of the words GameView and DialogBox draw. */
export const KIT_UI_TEXT = {
  "legend.talk": "talk",
  "legend.next": "next",
  "legend.ok": "ok",
  "legend.back": "back",
  "shop.buy": "Buy",
  "shop.sell": "Sell",
  "shop.gold": "Gold: {gold}",
  "shop.rowSell": "Sell",
  "shop.rowLeave": "Leave",
  "shop.rowBack": "Back",
  "shop.price": "{price}g",
  "shop.priceStock": "{price}g ({stock})",
  "demo.badge": "DEMO {frame}/{frames}",
  "demo.control": "YOU HAVE CONTROL",
  "demo.rewind": "REWIND {seconds} SEC",
  "error.event": "EVENT ERROR",
} as const satisfies Partial<UiTextTable>;

/**
 * Merge override layers, later layers winning, into one override table.
 * Undefined when no layer sets anything (the common case: a game that never
 * sets a table builds nothing). Keys are not checked here; non-string
 * values are dropped.
 */
export function mergeUiText(...layers: (UiTextOverrides | null | undefined)[]): UiTextOverrides | undefined {
  let out: Record<string, string> | undefined;
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of Object.keys(layer)) {
      const value = (layer as Record<string, unknown>)[key];
      if (typeof value !== "string") continue;
      out ??= {};
      out[key] = value;
    }
  }
  return out;
}

/**
 * A component's words: its English `defaults`, each replaced by the
 * override's string for that key when there is one. With no override for
 * any of them the result is `defaults` itself.
 */
export function withUiText<T extends Partial<UiTextTable>>(
  defaults: T,
  overrides: UiTextOverrides | null | undefined,
): { readonly [K in keyof T]: string } {
  if (!overrides) return defaults as { readonly [K in keyof T]: string };
  let out: Record<string, string> | undefined;
  for (const key of Object.keys(defaults)) {
    const value = (overrides as Record<string, unknown>)[key];
    if (typeof value !== "string") continue;
    out ??= { ...(defaults as Record<string, string>) };
    out[key] = value;
  }
  return (out ?? defaults) as { readonly [K in keyof T]: string };
}

/**
 * Fill a template's {placeholders} from `params`. A placeholder without a
 * matching param, and any other brace, stays as written; values are not
 * rescanned. Callers wrap the result to their box afterwards.
 */
export function formatUiText(template: string, params: Readonly<Record<string, string | number>>): string {
  if (!template.includes("{")) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  );
}
