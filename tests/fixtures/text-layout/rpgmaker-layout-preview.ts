// Synthetic MZ Show Text used only by the render-level layout regression.
// Distinct colours make PX, PY, and FS independently observable in pixels:
// BASE stays at the cursor origin, RIGHT jumps right, and BIG jumps back
// left, down, and onto the 24 px baked font slot.

import type { GameEvent, MapDef } from "../../../src/engine/types.ts";

export const RPG_MAKER_LAYOUT_RAW = String.raw`\C[1]BASE\PX[130]\C[2]RIGHT\PY[78]\FS[52]\PX[52]\C[3]BIG`;

// FS[52] maps to PocketJS's 24 px regular slot. The compiler bakes only
// class-referenced font slots, so this fixture declares that same slot while
// DialogBox continues to select it dynamically through `fontSlot`.
export const RPG_MAKER_LAYOUT_FONT_CLASS = "text-2xl";

const EVENT: GameEvent = {
  id: "mz-layout-dialog",
  x: 1,
  y: 1,
  pages: [{
    trigger: "autorun",
    commands: [{ op: "text", lines: [RPG_MAKER_LAYOUT_RAW], cps: 120 }],
  }],
};

export const RPG_MAKER_LAYOUT_MAP: MapDef = {
  // Reuse the generated map art keyed by the normal fixture's map id; only
  // the event program differs under the preview global.
  id: "layout-field",
  name: "MZ layout preview",
  width: 4,
  height: 4,
  sheets: ["plain"],
  ground: new Array(16).fill("plain.0"),
  events: [EVENT],
};
