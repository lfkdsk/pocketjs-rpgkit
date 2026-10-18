import { describe, expect, test } from "bun:test";
import {
  battleAnimationColor,
  battleAnimationFrameTicks,
  battleAnimationPlacement,
  battleAnimationPresentationAt,
  RPGMAKER_MV_ANIMATION_FRAME_TICKS,
  type RpgMakerBattleAnimationAsset,
} from "../src/ui/rpgmaker-battle/animation-presentation.ts";

const BASE: RpgMakerBattleAnimationAsset = {
  frames: ["frame-0.png", "frame-1.png", "frame-2.png"],
  w: 40,
  h: 48,
  position: 1,
  originOffsetX: -20,
  originOffsetY: -24,
  frameDuration: 4 / 60,
};

describe("RPG Maker battle animation frame projection", () => {
  test("legacy MV frames advance every four saved reference ticks and disappear at the end", () => {
    expect(battleAnimationFrameTicks(BASE.frameDuration)).toBe(RPGMAKER_MV_ANIMATION_FRAME_TICKS);
    expect(battleAnimationPresentationAt(BASE, 100, 99).frameIndex).toBe(-1);
    expect(battleAnimationPresentationAt(BASE, 100, 100).frameIndex).toBe(0);
    expect(battleAnimationPresentationAt(BASE, 100, 103).frameIndex).toBe(0);
    expect(battleAnimationPresentationAt(BASE, 100, 104).frameIndex).toBe(1);
    expect(battleAnimationPresentationAt(BASE, 100, 108).frameIndex).toBe(2);
    expect(battleAnimationPresentationAt(BASE, 100, 111).frameIndex).toBe(2);
    expect(battleAnimationPresentationAt(BASE, 100, 112).frameIndex).toBe(-1);
  });

  test("invalid optional frame durations retain the MV four-tick fallback", () => {
    expect(battleAnimationFrameTicks(0)).toBe(4);
    expect(battleAnimationFrameTicks(Number.NaN)).toBe(4);
  });

  test("the same saved ticks always recover the same frame after arbitrary seeks", () => {
    const sequence = [107, 100, 111, 104, 107, 112, 107]
      .map((nowTick) => battleAnimationPresentationAt(BASE, 100, nowTick).frameIndex);
    expect(sequence).toEqual([1, 0, 2, 1, 1, -1, 1]);
  });
});

describe("RPG Maker battle animation placement", () => {
  const viewport = { width: 480, height: 272 };
  const target = { x: 100, y: 50, width: 40, height: 60 };

  test.each([
    [0, { x: 110, y: 30 }],
    [1, { x: 110, y: 60 }],
    [2, { x: 110, y: 90 }],
  ] as const)("position %i anchors to target head/centre/feet", (position, expected) => {
    expect(battleAnimationPlacement({ position, originOffsetX: -10, originOffsetY: -20, w: 40 }, viewport, target))
      .toEqual(expected);
  });

  test("position 3 anchors to viewport centre and ignores a target", () => {
    expect(battleAnimationPlacement({ position: 3, originOffsetX: -10, originOffsetY: -20, w: 40 }, viewport, target))
      .toEqual({ x: 230, y: 116 });
  });

  test("request-level mirror reflects asymmetric cooked bounds around the animation origin", () => {
    const animation = { position: 1 as const, originOffsetX: -10, originOffsetY: -20, w: 40 };
    expect(battleAnimationPlacement(animation, viewport, target, true)).toEqual({ x: 90, y: 60 });
    expect(battleAnimationPlacement({ ...animation, position: 3 }, viewport, target, true))
      .toEqual({ x: 210, y: 116 });
  });
});

describe("RPG Maker battle animation timing approximations", () => {
  const timed: RpgMakerBattleAnimationAsset = {
    ...BASE,
    frames: ["frame-0.png", "frame-1.png"],
    timings: [
      {
        frame: 0,
        flash: {
          scope: "target",
          color: { r: 255, g: 224, b: 160, a: 128 },
          intensity: 128,
          duration: 5 / 60,
        },
      },
      {
        frame: 1,
        flash: {
          // Scope omission is the existing AnimationTimingDef screen cue.
          color: { r: 160, g: 208, b: 255, a: 255 },
          intensity: 120,
          duration: 3 / 60,
        },
        hide: { duration: 2 / 60 },
      },
    ],
  };

  test("target and screen flashes fade from their authored frame ticks", () => {
    const start = battleAnimationPresentationAt(timed, 20, 20);
    const targetLater = battleAnimationPresentationAt(timed, 20, 22);
    expect(start.targetFlash).toMatchObject({ color: "#ffe0a0" });
    expect(start.targetFlash!.opacity).toBeCloseTo(128 / 255 * (128 / 255) * 4 / 5);
    expect(targetLater.targetFlash!.opacity).toBeLessThan(start.targetFlash!.opacity);

    const secondFrame = battleAnimationPresentationAt(timed, 20, 24);
    expect(secondFrame.screenFlash).toMatchObject({ color: "#a0d0ff" });
    expect(secondFrame.screenFlash!.opacity).toBeCloseTo(120 / 255 * 2 / 3);
    expect(secondFrame.hideTargets).toBe(true);
    expect(battleAnimationPresentationAt(timed, 20, 25).hideTargets).toBe(false);
    expect(battleAnimationPresentationAt(timed, 20, 26).hideTargets).toBe(false);
    expect(battleAnimationPresentationAt(timed, 20, 27).screenFlash).toBeUndefined();
  });

  test("one-tick flash and hide timings finish before the first painted sample", () => {
    const oneTick: RpgMakerBattleAnimationAsset = {
      ...BASE,
      timings: [{
        frame: 0,
        flash: {
          scope: "target",
          color: { r: 255, g: 255, b: 255, a: 255 },
          intensity: 255,
          duration: 1 / 60,
        },
        hide: { duration: 1 / 60 },
      }],
    };
    expect(battleAnimationPresentationAt(oneTick, 10, 10)).toEqual({
      frameIndex: 0,
      hideTargets: false,
    });
  });

  test("timing windows expire independently of a retained reducer marker", () => {
    expect(battleAnimationPresentationAt(timed, 20, 28)).toEqual({
      frameIndex: -1,
      hideTargets: false,
    });
    expect(battleAnimationPresentationAt(timed, 20, 1_000)).toEqual({
      frameIndex: -1,
      hideTargets: false,
    });
  });

  test("flash colours clamp to portable six-digit RGB", () => {
    expect(battleAnimationColor({ r: -1, g: 128.4, b: 999, a: 255 })).toBe("#0080ff");
  });
});
