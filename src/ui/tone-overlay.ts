// Backend-independent approximation of RPG Maker tone using ordinary
// source-over layers. Kept separate from opt-in KRM2 picture presentation so
// the built-in screen layer does not pull timer/picture helpers into its graph.

import type { PictureTone, ScreenColor } from "../engine/types.ts";

export interface ToneOverlay {
  kind: "gray" | "darken" | "brighten";
  color: string;
  opacity: number;
}

function channelHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function screenColorHex(color: Readonly<ScreenColor>): string {
  return `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`;
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Fixed GPU/console walkers do not execute PocketJS tone operations, so their
 * fallback uses a stable order: gray, darken, then brighten. */
export function toneOverlays(tone: Readonly<PictureTone>): ToneOverlay[] {
  const overlays: ToneOverlay[] = [];
  const gray = unit(tone.gray / 255);
  if (gray > 0) overlays.push({ kind: "gray", color: "#808080", opacity: gray });

  const negative = [Math.max(0, -tone.r), Math.max(0, -tone.g), Math.max(0, -tone.b)] as const;
  const dark = Math.max(...negative);
  if (dark > 0) {
    const complement = (amount: number): number => 255 * (1 - amount / dark);
    overlays.push({
      kind: "darken",
      color: screenColorHex({
        r: complement(negative[0]),
        g: complement(negative[1]),
        b: complement(negative[2]),
        a: 255,
      }),
      opacity: unit(dark / 255),
    });
  }

  const positive = [Math.max(0, tone.r), Math.max(0, tone.g), Math.max(0, tone.b)] as const;
  const bright = Math.max(...positive);
  if (bright > 0) {
    const normalized = (amount: number): number => 255 * amount / bright;
    overlays.push({
      kind: "brighten",
      color: screenColorHex({
        r: normalized(positive[0]),
        g: normalized(positive[1]),
        b: normalized(positive[2]),
        a: 255,
      }),
      opacity: unit(bright / 255),
    });
  }
  return overlays;
}
