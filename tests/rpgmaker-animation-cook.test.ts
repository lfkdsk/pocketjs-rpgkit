import { describe, expect, test } from "bun:test";
import {
  cookMvAnimation,
  MvAnimationCookError,
  type MvAnimationSources,
} from "../tools/rpgmaker-import/animation.ts";
import { blankImage, type RgbaImage } from "../tools/rpgmaker-import/png.ts";
import type { RmAnimation, RmAnimationCell } from "../tools/rpgmaker-import/rm-types.ts";

const CELL = 192;
const SHEET_W = CELL * 5;
type Rgba = readonly [number, number, number, number];

function animation(overrides: Partial<RmAnimation> = {}): RmAnimation {
  return {
    id: 1,
    name: "Test",
    animation1Name: "First",
    animation1Hue: 0,
    animation2Name: "Second",
    animation2Hue: 0,
    position: 1,
    frames: [],
    timings: [],
    ...overrides,
  };
}

function cell(
  pattern: number,
  overrides: Partial<{
    x: number;
    y: number;
    scale: number;
    rotation: number;
    mirror: boolean;
    opacity: number;
    blendMode: number;
  }> = {},
): RmAnimationCell {
  return [
    pattern,
    overrides.x ?? 0,
    overrides.y ?? 0,
    overrides.scale ?? 100,
    overrides.rotation ?? 0,
    overrides.mirror ?? false,
    overrides.opacity ?? 255,
    overrides.blendMode ?? 0,
  ];
}

function source(rows = 1): RgbaImage {
  return blankImage(SHEET_W, rows * CELL);
}

function fillPattern(image: RgbaImage, pattern: number, colour: Rgba): void {
  const left = (pattern % 5) * CELL;
  const top = Math.floor(pattern / 5) * CELL;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      image.data.set(colour, ((top + y) * image.width + left + x) * 4);
    }
  }
}

function quadrants(image: RgbaImage, pattern: number): void {
  const colours: readonly Rgba[] = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 255, 255],
  ];
  const left = (pattern % 5) * CELL;
  const top = Math.floor(pattern / 5) * CELL;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const quadrant = (y >= CELL / 2 ? 2 : 0) + (x >= CELL / 2 ? 1 : 0);
      image.data.set(colours[quadrant]!, ((top + y) * image.width + left + x) * 4);
    }
  }
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
}

describe("MV animation compositor", () => {
  test("maps pattern 99 to source 1, pattern 100 to source 2, and preserves cell order", () => {
    const first = source(20);
    const second = source();
    fillPattern(first, 99, [255, 0, 0, 255]);
    fillPattern(second, 0, [0, 0, 255, 255]);
    const def = animation({
      frames: [
        [cell(99, { scale: 10 }), cell(100, { scale: 10, opacity: 128 })],
        [cell(99, { scale: 10 })],
      ],
    });

    const cooked = cookMvAnimation(def, { animation1: first, animation2: second }, 16);
    expect(cooked).toMatchObject({ frameW: 20, frameH: 20, cols: 2, count: 2, offsetX: -2, offsetY: -2 });
    expect(pixel(cooked.sheet, 10, 10)).toEqual([127, 0, 128, 255]);
    expect(pixel(cooked.sheet, cooked.frameW + 10, 10)).toEqual([255, 0, 0, 255]);
    expect(cooked.degradations).toEqual([]);
    expect(cooked.warnings).toEqual([]);

    const again = cookMvAnimation(def, { animation1: first, animation2: second }, 16);
    expect(Buffer.from(again.sheet.data).equals(Buffer.from(cooked.sheet.data))).toBe(true);
  });

  test("applies scale, mirror, clockwise rotation, opacity, and hue without mutating sources", () => {
    const first = source();
    quadrants(first, 0);
    const transformed = cookMvAnimation(animation({
      frames: [
        [cell(0, { scale: 50, mirror: true })],
        [cell(0, { scale: 50, rotation: 90 })],
        [cell(0, { scale: 50, opacity: 128 })],
      ],
    }), { animation1: first }, 16);
    expect(transformed).toMatchObject({ frameW: 96, frameH: 96, cols: 2, count: 3 });
    expect(pixel(transformed.sheet, 24, 24)).toEqual([0, 255, 0, 255]);
    expect(pixel(transformed.sheet, 96 + 24, 24)).toEqual([0, 0, 255, 255]);
    expect(pixel(transformed.sheet, 24, 96 + 24)).toEqual([255, 0, 0, 128]);

    const red = source();
    fillPattern(red, 0, [255, 0, 0, 255]);
    const hued = cookMvAnimation(animation({ animation1Hue: 120, frames: [[cell(0, { scale: 10 })]] }), { animation1: red }, 16);
    expect(pixel(hued.sheet, 10, 10)).toEqual([0, 255, 0, 255]);
    expect(pixel(red, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  test("area-downscales MV pixels and returns head, center, and feet anchors", () => {
    const first = source();
    fillPattern(first, 0, [20, 80, 160, 255]);
    const offsets = [0, 1, 2].map((position) => cookMvAnimation(
      animation({ position, frames: [[cell(0)]] }),
      { animation1: first },
      48,
    ));
    for (const cooked of offsets) {
      expect([cooked.frameW, cooked.frameH, cooked.offsetX]).toEqual([64, 64, -24]);
      expect(pixel(cooked.sheet, 32, 32)).toEqual([20, 80, 160, 255]);
    }
    expect(offsets.map((entry) => entry.offsetY)).toEqual([-32, -24, -16]);
  });

  test("implements add, multiply, and screen inside the baked canvas and reports their map loss", () => {
    const first = source();
    fillPattern(first, 0, [100, 100, 100, 255]);
    fillPattern(first, 1, [200, 50, 20, 255]);
    const expected: Readonly<Record<number, number[]>> = {
      1: [255, 150, 120, 255],
      2: [78, 20, 8, 255],
      3: [222, 130, 112, 255],
    };
    const names = ["add", "multiply", "screen"];
    for (const mode of [1, 2, 3] as const) {
      const cooked = cookMvAnimation(
        animation({ frames: [[cell(0, { scale: 10 }), cell(1, { scale: 10, blendMode: mode })]] }),
        { animation1: first },
        16,
      );
      expect(pixel(cooked.sheet, 10, 10)).toEqual(expected[mode]);
      expect(cooked.degradations).toEqual([
        `${names[mode - 1]} blend is baked within the animation but cannot blend against the map`,
      ]);
    }
  });

  test("keeps blank authored frames as transparent uniform frames with diagnostics", () => {
    const cooked = cookMvAnimation(animation({ frames: [[], []] }), {}, 48);
    expect(cooked).toMatchObject({ frameW: 1, frameH: 1, cols: 2, count: 2, offsetX: 8, offsetY: 8 });
    expect([...cooked.sheet.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cooked.warnings).toEqual([
      "frame 0 has no visible cells; emitted a transparent frame",
      "frame 1 has no visible cells; emitted a transparent frame",
    ]);
  });

  test("accepts screen placement and exposes viewport-origin offsets", () => {
    const first = source();
    fillPattern(first, 0, [255, 255, 255, 255]);
    const cooked = cookMvAnimation(
      animation({ position: 3, frames: [[cell(0)]] }),
      { animation1: first },
      48,
    );

    expect(cooked).toMatchObject({
      frameW: 64,
      frameH: 64,
      count: 1,
      originOffsetX: -32,
      originOffsetY: -32,
    });
    expect(pixel(cooked.sheet, 32, 32)).toEqual([255, 255, 255, 255]);
  });

  test("rejects malformed placement or missing source data", () => {
    const first = source();
    expect(() => cookMvAnimation(animation({ position: 4, frames: [[cell(0)]] }), { animation1: first }, 48))
      .toThrow(/position 4 must be 0, 1, 2, or 3/);
    expect(() => cookMvAnimation(animation({ frames: [] }), {}, 48))
      .toThrow(/at least one frame/);
    expect(() => cookMvAnimation(animation({ frames: [[cell(0)]] }), {}, 48))
      .toThrow(/missing img\/animations\/First\.png/);
    expect(() => cookMvAnimation(animation({ frames: [[cell(0)]] }), { animation1: blankImage(959, 192) }, 48))
      .toThrow(/expected 960px wide/);
    expect(() => cookMvAnimation(animation({ frames: [[cell(5)]] }), { animation1: first }, 48))
      .toThrow(/pattern 5 is outside/);
    expect(() => cookMvAnimation(animation({ frames: [[cell(200) as RmAnimationCell]] }), { animation1: first }, 48))
      .toThrow(/0 to 199/);
    const malformed = [0, 0, 0, 100, 0, false, 255] as unknown as RmAnimationCell;
    expect(() => cookMvAnimation(animation({ frames: [[malformed]] }), { animation1: first }, 48))
      .toThrow(/exactly 8 fields/);
  });

  test("rejects cooked frame bounds above the project schema limit", () => {
    const first = source();
    fillPattern(first, 0, [255, 255, 255, 255]);
    expect(() => cookMvAnimation(
      animation({ frames: [[cell(0, { scale: 200 })]] }),
      { animation1: first },
      16,
    )).toThrow(/384x384 exceed 256x256/);
  });

  test("exposes a typed diagnostic carrying the source animation id", () => {
    let error: unknown;
    try {
      cookMvAnimation(animation({ id: 17, name: "Burst", frames: [[cell(0)]] }), {} as MvAnimationSources, 48);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MvAnimationCookError);
    expect(error).toMatchObject({ animationId: 17, name: "MvAnimationCookError" });
    expect((error as Error).message).toContain("animation 17 (Burst)");
  });
});
