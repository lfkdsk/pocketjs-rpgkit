// Rendered evidence for RPG Maker colour escapes inside choice prompts and
// rows. The isolated fixture opens one authored choice immediately, so the
// normal imported-project journeys remain unchanged.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { ChoiceModal } from "../src/engine/interpreter.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`RPG Maker choice-colour visual tests skipped: ${preflight.reason}`);
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

function choiceModal(world: BoundGameWorld): ChoiceModal | null {
  const value = world.probes().state.interp.modal;
  return value?.kind === "choices" ? value : null;
}

function choiceColourPixels(
  rgba: Uint8Array,
  width: number,
  height: number,
  predicate: (r: number, g: number, b: number) => boolean,
): number {
  let count = 0;
  for (let y = Math.max(0, height - 180); y < height - 90; y++) {
    for (let x = Math.max(0, width - 270); x < width - 8; x++) {
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

simDescribe("RPG Maker coloured choice rendering", () => {
  for (const viewport of VIEWPORTS) {
    test(`prompt and rows at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("r2-ui"),
        60,
        { __r2ChoiceColour: true },
        undefined,
        viewport,
      );
      for (let frame = 0; frame < 120 && choiceModal(world) === null; frame++) pump(world, 1);
      pump(world, 2);

      const choice = choiceModal(world);
      expect(choice?.prompt).toBe("Choose a lantern glow");
      expect(choice?.options).toEqual(["Golden lantern — selected", "Blue lantern — waiting"]);
      expect(choice?.promptColours).toEqual([
        { start: 0, end: 9, colour: "#20A0D6" },
        { start: 9, end: 16, colour: "#FFFFA0" },
        { start: 16, end: 21, colour: "#FFFFFF" },
      ]);
      expect(choice?.optionColours).toEqual([
        [
          { start: 0, end: 14, colour: "#FFFFA0" },
          { start: 14, end: 25, colour: "#FFFFFF" },
        ],
        [
          { start: 0, end: 12, colour: "#20A0D6" },
          { start: 12, end: 22, colour: "#FFFFFF" },
        ],
      ]);
      expect(JSON.stringify(world.getTree())).toContain("Golden lantern");

      const frame = world.render().slice();
      const yellow = choiceColourPixels(frame, viewport.width, viewport.height,
        (r, g, b) => r > 205 && g > 195 && b < 190 && r - b > 35);
      const blue = choiceColourPixels(frame, viewport.width, viewport.height,
        (r, g, b) => r < 120 && g > 115 && g < 215 && b > 175 && b - r > 80);
      const white = choiceColourPixels(frame, viewport.width, viewport.height,
        (r, g, b) => r > 210 && g > 210 && b > 210 && Math.max(r, g, b) - Math.min(r, g, b) < 18);
      expect(yellow, "the selected row keeps its explicit yellow escape colour").toBeGreaterThan(45);
      expect(blue, "the prompt and unselected row paint their explicit blue runs").toBeGreaterThan(35);
      expect(white, "reset runs still paint the stock white text colour").toBeGreaterThan(20);
      await golden(`rpgmaker-choice-colour.${viewport.width}x${viewport.height}`, frame, viewport.width, viewport.height);
    }, 60_000);
  }
});
