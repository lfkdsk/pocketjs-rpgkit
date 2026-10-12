// src/ui/krm2-ui.ts — pure KRM2 presentation projections.
//
// Kept free of JSX and host imports so picture layout, tone approximation,
// HUD formatting and host-action ordering can be tested without a renderer.

import { timerSeconds, type TimerState } from "../engine/interpreter.ts";
import {
  pictureTransformAt,
  type MapNameBannerState,
  type PictureState,
  type ScreenEffectsState,
} from "../engine/screen.ts";
import type { PictureTone, ScreenColor } from "../engine/types.ts";
import type { ScreenLayerVariant } from "./game-assets.ts";
import { toneOverlays, type ToneOverlay } from "./tone-overlay.ts";

export type PictureToneOverlay = ToneOverlay;

export interface PictureRenderStyle {
  insetL: number;
  insetT: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  rotate: number;
  originX: number;
  originY: number;
  opacity: number;
}

function channelHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

export function screenColorHex(color: Readonly<ScreenColor>): string {
  return `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`;
}

function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Portable approximation of RPG Maker's per-picture tone. PocketJS has no
 * backend-independent colour-matrix primitive, so the result is expressed
 * as ordinary source-over overlays in a documented stable order:
 *
 * 1. gray blends toward neutral gray;
 * 2. negative RGB uses a complementary overlay (exact for white pixels);
 * 3. positive RGB uses a coloured overlay (exact for black pixels).
 *
 * This cannot be pixel-identical to a colour matrix on every source colour,
 * but it is deterministic and renders the same on every PocketJS backend. */
export function pictureToneOverlays(tone: Readonly<PictureTone>): PictureToneOverlay[] {
  return toneOverlays(tone);
}

/** Stable painter order for numbered pictures. Record insertion order is not
 * part of the visual contract: smaller RPG Maker picture ids paint first. */
export function sortedPictures(
  pictures: Readonly<Record<string, PictureState>> | undefined,
): PictureState[] {
  return pictures ? Object.values(pictures).sort((a, b) => a.id - b.id) : [];
}

/** Resolve a picture's viewport-space layout and transform. `originX/Y`
 * follow PocketJS's normalized convention: -0.5 is the top-left pivot and
 * 0 is the centre pivot. */
export function pictureRenderStyle(
  picture: Readonly<PictureState>,
  variant: Readonly<ScreenLayerVariant>,
  parentWidth: number,
  parentHeight: number,
): PictureRenderStyle {
  const transform = pictureTransformAt(picture);
  const width = variant.w ?? parentWidth;
  const height = variant.h ?? parentHeight;
  const centered = picture.origin === "center";
  return {
    insetL: transform.x - (centered ? width / 2 : 0),
    insetT: transform.y - (centered ? height / 2 : 0),
    width,
    height,
    scaleX: transform.scaleX / 100,
    scaleY: transform.scaleY / 100,
    rotate: picture.rotation,
    originX: centered ? 0 : -0.5,
    originY: centered ? 0 : -0.5,
    opacity: unit((transform.opacity / 255) * (variant.opacity ?? 1)),
  };
}

/** Exact cache key for the visible opt-in KRM2 presentation. Timer lives
 * outside the screen slice; key its displayed whole seconds so sub-second
 * countdown ticks do not re-evaluate an unchanged HUD. */
export function screenEffectsFingerprint(
  screen: Readonly<ScreenEffectsState> | undefined,
  timer: Readonly<TimerState> | undefined,
): string {
  const visibleScreen = screen && (screen.pictures || screen.mapNameBanner);
  return visibleScreen || timer
    ? JSON.stringify([
        screen?.pictures,
        screen?.mapNameBanner,
        timer === undefined ? undefined : timerSeconds(timer),
      ])
    : "";
}

/** RPG Maker-style MM:SS display. Minutes have a two-character minimum but
 * are never truncated when a project starts a longer timer. */
export function timerHudText(timer: Readonly<TimerState> | undefined): string {
  const seconds = timerSeconds(timer);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Deterministic 15-tick fade-in and 30-tick fade-out for the saved banner. */
export function mapNameBannerOpacity(banner: Readonly<MapNameBannerState>): number {
  const age = Math.max(0, banner.total - banner.left);
  return Math.max(0, Math.min(1, age / 15, banner.left / 30));
}
