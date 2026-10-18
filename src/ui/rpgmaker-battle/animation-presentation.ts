// Pure projection of one reducer-owned legacy MV battle animation. The
// importer/cooker supplies immutable per-frame images; every visible choice
// below is derived from the saved start tick and the fixed reference clock.

import type { ScreenColor } from "../../engine/types.ts";
import type { RpgImageSource } from "../LazyImage.tsx";

export const RPGMAKER_MV_ANIMATION_FRAME_TICKS = 4;
const REFERENCE_TICKS_PER_SECOND = 60;

export interface RpgMakerBattleAnimationTiming {
  /** Authored MV frame on which the cue begins. */
  frame: number;
  /** Current project timings omit scope and therefore mean screen flash. */
  flash?: {
    scope?: "target" | "screen";
    color: ScreenColor;
    intensity: number;
    /** Virtual seconds, matching AnimationTimingDef. */
    duration: number;
  };
  /** Additive battle-only spelling for MV flashScope 3. */
  hide?: {
    /** Virtual seconds for which the selected targets stay hidden. */
    duration: number;
  };
}

/** Immutable render assets combined from Project.animations and the
 * importer's placement table. Frames are already sliced static images: the
 * renderer never samples an auto-play atlas or reconstructs MV cells. */
export interface RpgMakerBattleAnimationAsset {
  frames: readonly RpgImageSource[];
  w: number;
  h: number;
  position: 0 | 1 | 2 | 3;
  /** Cooked frame top-left relative to the selected animation origin. */
  originOffsetX: number;
  originOffsetY: number;
  /** Virtual seconds per frame; imported MV animations use 4/60. */
  frameDuration: number;
  timings?: readonly RpgMakerBattleAnimationTiming[];
}

export interface BattleAnimationTargetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BattleAnimationFlash {
  color: string;
  opacity: number;
}

export interface BattleAnimationPresentation {
  /** -1 before start and after the non-looping strip finishes. */
  frameIndex: number;
  targetFlash?: BattleAnimationFlash;
  screenFlash?: BattleAnimationFlash;
  hideTargets: boolean;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function channelHex(value: number): string {
  return Math.round(clamp(Number.isFinite(value) ? value : 0, 0, 255)).toString(16).padStart(2, "0");
}

export function battleAnimationColor(color: Readonly<ScreenColor>): string {
  return `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`;
}

/** Cumulative compilation is unnecessary for imported MV's exact 4/60 s
 * rate, but honoring the option keeps the public render contract useful for
 * other cooked legacy strips without consulting a host clock. */
export function battleAnimationFrameTicks(frameDuration: number): number {
  if (!Number.isFinite(frameDuration) || frameDuration <= 0) return RPGMAKER_MV_ANIMATION_FRAME_TICKS;
  return Math.max(1, Math.round(frameDuration * REFERENCE_TICKS_PER_SECOND));
}

function durationTicks(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(1, Math.round(seconds * REFERENCE_TICKS_PER_SECOND));
}

function flashAt(
  flash: NonNullable<RpgMakerBattleAnimationTiming["flash"]>,
  elapsed: number,
  cueStart: number,
): BattleAnimationFlash | undefined {
  const total = durationTicks(flash.duration);
  const local = elapsed - cueStart;
  if (total <= 0 || local < 0 || local >= total) return undefined;
  const alpha = clamp(flash.color.a, 0, 255) / 255;
  const intensity = clamp(flash.intensity, 0, 255) / 255;
  return {
    color: battleAnimationColor(flash.color),
    opacity: alpha * intensity * (total - local) / total,
  };
}

export function battleAnimationPresentationAt(
  animation: Readonly<RpgMakerBattleAnimationAsset>,
  startTick: number,
  nowTick: number,
): BattleAnimationPresentation {
  const frameTicks = battleAnimationFrameTicks(animation.frameDuration);
  const elapsed = nowTick - startTick;
  const total = animation.frames.length * frameTicks;
  const frameIndex = elapsed < 0 || animation.frames.length === 0 || elapsed >= total
    ? -1
    : Math.floor(elapsed / frameTicks);
  let targetFlash: BattleAnimationFlash | undefined;
  let screenFlash: BattleAnimationFlash | undefined;
  let hideTargets = false;
  for (const timing of animation.timings ?? []) {
    if (!Number.isInteger(timing.frame) || timing.frame < 0) continue;
    const cueStart = timing.frame * frameTicks;
    if (timing.flash) {
      const flash = flashAt(timing.flash, elapsed, cueStart);
      if (flash) {
        if (timing.flash.scope === "target") targetFlash = flash;
        else screenFlash = flash;
      }
    }
    if (timing.hide) {
      const hiddenFor = durationTicks(timing.hide.duration);
      const local = elapsed - cueStart;
      if (hiddenFor > 0 && local >= 0 && local < hiddenFor) hideTargets = true;
    }
  }
  return {
    frameIndex,
    ...(targetFlash ? { targetFlash } : {}),
    ...(screenFlash ? { screenFlash } : {}),
    hideTargets,
  };
}

/** Position 0/1/2 select target head/centre/feet. Position 3 ignores the
 * target and uses viewport centre, matching legacy MV screen animations. */
export function battleAnimationPlacement(
  animation: Pick<RpgMakerBattleAnimationAsset, "position" | "originOffsetX" | "originOffsetY">,
  viewport: { width: number; height: number },
  target?: Readonly<BattleAnimationTargetRect>,
): { x: number; y: number } {
  if (animation.position === 3 || !target) {
    return {
      x: Math.round(viewport.width / 2 + animation.originOffsetX),
      y: Math.round(viewport.height / 2 + animation.originOffsetY),
    };
  }
  const vertical = animation.position === 0 ? 0 : animation.position === 1 ? 0.5 : 1;
  return {
    x: Math.round(target.x + target.width / 2 + animation.originOffsetX),
    y: Math.round(target.y + target.height * vertical + animation.originOffsetY),
  };
}
