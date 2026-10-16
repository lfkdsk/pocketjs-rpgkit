import { expect, test } from "bun:test";

// The browser player is plain JavaScript and guards its boot block when no DOM
// exists, so its production paint method can be exercised without a browser.
// @ts-expect-error no declaration file for the browser-only host module
import { Player } from "../tools/web/player.js";

test("the Web player forwards retained pixels and damage without a full-frame copy", () => {
  const framebuffer = new Uint8Array(12 * 8 * 4);
  const damage = { rects: new Int32Array([2, 1, 5, 4]), count: 1, scale: 3 };
  const calls: Array<{ pixels: Uint8Array; damage: typeof damage }> = [];
  let renderScale = 0;
  let damageScale = 0;
  const player = {
    config: { rasterDensity: 3 },
    wasm: {
      renderScaledIncremental(scale: number) {
        renderScale = scale;
        return framebuffer;
      },
      damageRects(scale: number) {
        damageScale = scale;
        return damage;
      },
    },
    presenter: {
      present(pixels: Uint8Array, changed: typeof damage) {
        calls.push({ pixels, damage: changed });
      },
    },
  };

  Player.prototype.paint.call(player);

  expect([renderScale, damageScale]).toEqual([3, 3]);
  expect(calls).toEqual([{ pixels: framebuffer, damage }]);
});
