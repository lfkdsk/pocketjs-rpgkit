import { describe, expect, test } from "bun:test";
import { TILE } from "../src/engine/tiles.ts";
import { actorDepth, actorDepthInSpace, upperRowDepth } from "../src/ui/occlusion-depth.ts";

const REFERENCE_CELLS = [
  [7, 9], [10, 7], [19, 13], [8, 3], [20, 16], [24, 5], [21, 9],
  [15, 12], [5, 7], [12, 15], [34, 9], [14, 12], [9, 2],
] as const;

describe("pyscroll-compatible actor depth", () => {
  test("orders actors lexicographically by (y, x) at all reference cells", () => {
    const worldWidth = 64 * TILE;
    for (const [x, y] of REFERENCE_CELLS) {
      const here = actorDepth(x * TILE, y * TILE, worldWidth);
      expect(actorDepth(x * TILE + 1, y * TILE, worldWidth)).toBeGreaterThan(here);
      expect(actorDepth(x * TILE, y * TILE + 1, worldWidth)).toBeGreaterThan(
        actorDepth((x + 1) * TILE, y * TILE, worldWidth),
      );
    }
  });

  test("puts exactly the upper rows hit by the bottom two sprite pixels above a moving actor", () => {
    const worldWidth = 64 * TILE;
    const x = 11 * TILE;
    for (let offset = 0; offset < TILE; offset++) {
      const py = 10 * TILE + offset;
      const spriteTop = py - TILE;
      const spriteBottom = py + TILE;
      const footTop = spriteBottom - 2;
      for (let row = 8; row <= 12; row++) {
        const rowTop = row * TILE;
        const overlapsSprite = rowTop < spriteBottom && rowTop + TILE > spriteTop;
        if (!overlapsSprite) continue;
        const hitsFeet = rowTop < spriteBottom && rowTop + TILE > footTop;
        expect(
          upperRowDepth(row, worldWidth) > actorDepth(x, py, worldWidth),
          `offset=${offset} row=${row}`,
        ).toBe(hitsFeet);
      }
    }
  });

  test("normalizes signed component placements into the same depth plane", () => {
    const space = { offsetX: -384, offsetY: -256, minX: -384, minY: -256, width: 768 };
    const localX = 24 * TILE;
    const row = 16;
    expect(actorDepthInSpace(localX, row * TILE + 1, space))
      .toBeLessThan(upperRowDepth(row, space.width));
    expect(actorDepthInSpace(localX, row * TILE + 2, space))
      .toBeGreaterThan(upperRowDepth(row, space.width));
    expect(actorDepthInSpace(localX, row * TILE + 2, space)).toBe(
      actorDepth(localX, row * TILE + 2, space.width),
    );
  });
});
