// tests/fixtures/text-layout/fixture-data.ts — the text box layouts the
// text layout sim (tests/text-layout-sim.test.ts) steps through: one
// autorun event whose texts place the box at the bands, corners and sides,
// align their rows, and draw the window, dim and transparent backgrounds,
// in English and in Chinese. The Chinese strings use only characters of the
// cjk-text fixture's font subset (fonts.json bakes it). The last texts are
// spoken by KEEPER, who has a portrait: the corner and side windows keep
// their size and place with it.

import type { Command, GameEvent, MapDef } from "../../../src/engine/types.ts";

export const MAP_ID = "layout-field";
export const MAP_SIZE = { width: 4, height: 4 } as const;

type TextCommand = Extract<Command, { op: "text" }>;

/** The texts in order; the test reads them for the expected geometry. */
export const TEXTS: readonly TextCommand[] = [
  // 0: the default box (no layout fields).
  { op: "text", lines: ["The default box: bottom band, rows from the top left."] },
  // 1: top band, centred rows in the middle of the text area.
  { op: "text", lines: ["Centred at the top.", "Two rows, in the middle."], position: "top", align: "center", valign: "center" },
  // 2: bottom right corner, right-aligned.
  { op: "text", lines: ["Right aligned in the corner."], position: "bottomRight", align: "right" },
  // 3: top left corner on the dim background, Chinese.
  { op: "text", lines: ["欢迎来到帕帕镇！灯塔守护人在等你。"], position: "topLeft", background: "dim" },
  // 4: an item pickup: centre of the screen, centred both ways, no window.
  { op: "text", lines: ["你得到了伤药！"], position: "center", align: "center", valign: "center", background: "transparent" },
  // 5: a message too long for the narrow left box: it takes pages.
  {
    op: "text",
    position: "left",
    lines: [
      "{name}，灯塔守护人说：你每天清晨都会去海边散步，看着白色的小帆船从港口开出去，又一艘一艘地回来。",
      "沙滩上的礁石都很黑，浪花一层一层地拍打着岸边，风吹过草地和小桥，花都开了。",
      "训练师们都说，HP 120的Bigfin是Route 1里很好的怪兽，你还没有见过它。",
    ],
  },
  // 6: right side, a Latin line that wraps in the narrow box, centred rows
  //    at the bottom of the text area.
  {
    op: "text",
    lines: ["A long line that wraps inside the narrow right window, kept whole."],
    position: "right",
    align: "center",
    valign: "bottom",
  },
  // 7: bottom left corner, centred Chinese row.
  { op: "text", lines: ["灯塔守护人站在门口，笑着挥了挥手。"], position: "bottomLeft", align: "center" },
  // 8, 9: the same words twice at the fastest typing, first in the top
  //    right corner, then in the top band: a host frame that folds several
  //    ticks shows the second box complete right after the first, with no
  //    empty frame between them, and only the layout differs.
  { op: "text", lines: ["Same words, new place."], cps: 120, position: "topRight", align: "right" },
  { op: "text", lines: ["Same words, new place."], cps: 120, position: "top" },
  // 10-15: a speaker with a portrait in each corner and on each side.
  { op: "text", lines: ["KEEPER: The lamp is lit tonight."], position: "topLeft" },
  { op: "text", lines: ["KEEPER: The lamp is lit tonight."], position: "topRight", align: "right" },
  { op: "text", lines: ["KEEPER: The lamp is lit tonight."], position: "bottomLeft" },
  { op: "text", lines: ["KEEPER: The lamp is lit tonight."], position: "bottomRight", valign: "bottom" },
  { op: "text", lines: ["KEEPER: The lamp is lit tonight."], position: "left", align: "center" },
  { op: "text", lines: ["KEEPER: The lamp is lit tonight."], position: "right" },
  // 16: a long Chinese message with the portrait in the top left corner:
  //     the narrower text column takes more pages, nothing is cut.
  {
    op: "text",
    position: "topLeft",
    lines: [
      "KEEPER: 欢迎来到帕帕镇！灯塔守护人每天清晨都会去海边散步，看着白色的小帆船从港口开出去，又一艘一艘地回来。",
      "沙滩上的礁石都很黑，浪花一层一层地拍打着岸边，风吹过草地和小桥，花都开了。",
      "训练师们都说，灯塔守护人很好，你还没有见过他。",
    ],
  },
  // 17, 18: the bands with the portrait: the top band and the default box.
  { op: "text", lines: ["KEEPER: The lamp is lit tonight.", "Climb while the light holds."], position: "top" },
  { op: "text", lines: ["KEEPER: The lamp is lit tonight.", "Climb while the light holds."] },
];

/** The speakers with a portrait (gen-assets.ts draws it). */
export const FACES: Readonly<Record<string, string>> = { KEEPER: "assets/face-keeper.png" };

/** The index of the long message spoken in the top left corner. */
export const SPEAKER_LONG = 16;

/** The index of the first of the two boxes that differ only in layout. */
export const SAME_WORDS_FIRST = 8;

export function layoutEvent(): GameEvent {
  return {
    id: "layout-dialog",
    x: 1,
    y: 1,
    pages: [
      {
        trigger: "autorun",
        commands: [...TEXTS.map((text) => ({ ...text, lines: [...text.lines] })), { op: "switch", id: "layout-done", value: true }],
      },
      { condition: { switch: "layout-done" }, trigger: "action", commands: [] },
    ],
  };
}

export const MAP: MapDef = {
  id: MAP_ID,
  name: "Layout field",
  width: MAP_SIZE.width,
  height: MAP_SIZE.height,
  sheets: ["plain"],
  ground: new Array(MAP_SIZE.width * MAP_SIZE.height).fill("plain.0"),
  events: [layoutEvent()],
};
