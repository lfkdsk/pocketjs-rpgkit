// Rendered evidence for RPG Maker colour escapes. The real imported Stage
// fixture is driven to its first message at both supported viewport tiers;
// semantic pixel assertions prove the theme ink, yellow run, and explicit
// white reset glyph are drawn, while committed PNGs catch layout/typewriter
// regressions.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { TextModal } from "../src/engine/interpreter.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("rmi-play");
if (!preflight.ok) console.warn(`RPG Maker colour visual tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

function pump(world: BoundGameWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function modal(world: BoundGameWorld): TextModal | null {
  const value = world.probes().state.interp.modal;
  return value?.kind === "text" ? value : null;
}

function colourPixels(
  rgba: Uint8Array,
  width: number,
  height: number,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  let count = 0;
  const top = height - 100;
  for (let y = top; y < height; y++) {
    for (let x = 8; x < width - 8; x++) {
      const at = (y * width + x) * 4;
      if (predicate(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!)) count++;
    }
  }
  return count;
}

async function golden(name: string, rgba: Uint8Array, width: number, height: number): Promise<void> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.RPGM1_UPDATE_GOLDENS) await Bun.write(url, encodePNG(rgba, width, height));
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect([expected.width, expected.height]).toEqual([width, height]);
  expect(rgba).toEqual(expected.rgba);
}

simDescribe("RPG Maker coloured message rendering", () => {
  for (const viewport of VIEWPORTS) {
    test(`the imported colour run is visible at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(appBundle("rmi-play"), 60, { __rmiGame: "stage" }, undefined, viewport);
      for (let frame = 0; frame < 600; frame++) {
        const text = modal(world)?.lines.join("\n") ?? "";
        if (text.includes("Lantern Stage!")) break;
        pump(world, 1);
      }
      for (let frame = 0; frame < 180 && modal(world)?.complete !== true; frame++) pump(world, 1);

      const message = modal(world);
      expect(message?.lines).toEqual(["Ladies and gentlemen, welcome to the", "Lantern Stage!"]);
      expect(message?.colours).toEqual([
        { start: 37, end: 50, colour: "#FFFFA0" },
        { start: 50, end: 51, colour: "#FFFFFF" },
      ]);
      const frame = world.render().slice();
      const yellow = colourPixels(frame, viewport.width, viewport.height,
        (r, g, b) => r > 205 && g > 195 && b < 190 && r - b > 35);
      const ink = colourPixels(frame, viewport.width, viewport.height,
        (r, g, b) => r > 195 && g > 215 && b > 240 && b - r > 15);
      const white = colourPixels(frame, viewport.width, viewport.height,
        (r, g, b) => r > 210 && g > 210 && b > 210 && Math.max(r, g, b) - Math.min(r, g, b) < 18);
      expect(yellow, "the colour-6 glyph run paints yellow pixels").toBeGreaterThan(30);
      expect(ink, "ordinary text paints the blue-white theme ink").toBeGreaterThan(80);
      expect(white, "the reset-colour exclamation paints white pixels").toBeGreaterThan(2);
      await golden(`rpgmaker-text-colour.${viewport.width}x${viewport.height}`, frame, viewport.width, viewport.height);
    }, 60_000);
  }
});
