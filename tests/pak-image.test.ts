import { describe, expect, test } from "bun:test";
import { fitPakTexture, resampleRgba } from "../tools/lib/pak-image.ts";

const pixel = (data: Uint8Array, width: number, x: number, y: number): number[] =>
  [...data.subarray((y * width + x) * 4, (y * width + x + 1) * 4)];

describe("pak image fitting", () => {
  test("keeps an already legal texture byte-for-byte", () => {
    const image = { width: 2, height: 4, data: new Uint8Array(2 * 4 * 4).fill(19) };
    expect(fitPakTexture(image)).toBe(image);
  });

  test("turns a self-authored non-power-of-two battler into a legal texture", () => {
    const data = new Uint8Array(3 * 5 * 4);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 3; x++) data.set([x, y, x + y, 255], (y * 3 + x) * 4);
    }

    const fitted = fitPakTexture({ width: 3, height: 5, data });
    expect([fitted.width, fitted.height]).toEqual([4, 8]);
    expect(pixel(fitted.data, fitted.width, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(fitted.data, fitted.width, 3, 7)).toEqual([2, 4, 6, 255]);
    expect(data.byteLength).toBe(3 * 5 * 4);
  });

  test("fits oversized art inside the 512 pixel host limit", () => {
    const image = { width: 513, height: 1, data: new Uint8Array(513 * 4).fill(7) };
    expect(fitPakTexture(image)).toMatchObject({ width: 512, height: 1 });
  });

  test("rejects malformed RGBA and target dimensions", () => {
    expect(() => fitPakTexture({ width: 3, height: 5, data: new Uint8Array(4) })).toThrow("invalid RGBA source");
    expect(() => resampleRgba({ width: 1, height: 1, data: new Uint8Array(4) }, 0, 1)).toThrow("invalid target");
    expect(() => fitPakTexture({ width: 1, height: 1, data: new Uint8Array(4) }, 500)).toThrow("max edge");
  });
});
