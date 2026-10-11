// Rendered follower/vehicle evidence. The procedural travel art makes each
// role identifiable in pixels, while reducer assertions prove the screenshot
// depicts a spaced party, a boarded boat, or a cruising elevated airship.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`travel visual tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

const COLOURS = {
  coral: [236, 96, 126],
  mint: [82, 204, 154],
  boat: [68, 190, 222],
  airship: [236, 92, 114],
} as const;

interface PixelBounds {
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function moveOne(world: BoundGameWorld, button: number): void {
  pump(world, 1, button);
  for (let frame = 0; frame < 120 && world.probes().state.move.moving; frame++) pump(world, 1);
  expect(world.probes().state.move.moving, "one-tile visual setup move settles").toBe(false);
}

function waitFor(world: BoundGameWorld, predicate: () => boolean, label: string): void {
  for (let frame = 0; frame < 180 && !predicate(); frame++) pump(world, 1);
  expect(predicate(), label).toBe(true);
}

function exactColourBounds(
  rgba: Uint8Array,
  width: number,
  colour: readonly [number, number, number],
): PixelBounds {
  let count = 0;
  let minX = width;
  let minY = rgba.length / 4 / width;
  let maxX = -1;
  let maxY = -1;
  for (let pixel = 0; pixel < rgba.length / 4; pixel++) {
    const at = pixel * 4;
    if (rgba[at] !== colour[0] || rgba[at + 1] !== colour[1] || rgba[at + 2] !== colour[2]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    count++;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { count, minX, minY, maxX, maxY };
}

async function golden(name: string, rgba: Uint8Array, width: number, height: number): Promise<void> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.TRAVEL_UPDATE_GOLDENS) await Bun.write(url, encodePNG(rgba, width, height));
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect([expected.width, expected.height]).toEqual([width, height]);
  expect(rgba).toEqual(expected.rgba);
}

type Scenario = "party-walk" | "boat" | "airship";

async function frameFor(
  scenario: Scenario,
  viewport: (typeof VIEWPORTS)[number],
): Promise<{ world: BoundGameWorld; frame: Uint8Array }> {
  const world = await bootGameWorld(appBundle("r2-ui"), 60, { __r2Travel: true }, undefined, viewport);
  pump(world, 3);
  if (scenario === "party-walk") {
    moveOne(world, BTN.UP);
    moveOne(world, BTN.UP);
    moveOne(world, BTN.UP);
    waitFor(world, () => world.probes().state.travel?.followers?.members.every((member) => !member.move.moving) === true,
      "the follower chain settles after walking");
  } else if (scenario === "boat") {
    pump(world, 1, BTN.CIRCLE);
    waitFor(world, () =>
      world.probes().state.travel?.vehicles?.riding === "boat" && !world.probes().state.move.moving,
    "boat boarding settles");
  } else {
    moveOne(world, BTN.LEFT);
    pump(world, 1, BTN.CIRCLE);
    waitFor(world, () => world.probes().state.travel?.vehicles?.airshipPhase === "cruising", "airship reaches cruise altitude");
  }
  pump(world, 2);
  return { world, frame: world.render().slice() };
}

simDescribe("follower and vehicle rendered goldens", () => {
  for (const viewport of VIEWPORTS) {
    for (const scenario of ["party-walk", "boat", "airship"] as const) {
      test(`${scenario} at ${viewport.width}x${viewport.height}`, async () => {
        const { world, frame } = await frameFor(scenario, viewport);
        const state = world.probes().state;
        const coral = exactColourBounds(frame, viewport.width, COLOURS.coral);
        const mint = exactColourBounds(frame, viewport.width, COLOURS.mint);
        const boat = exactColourBounds(frame, viewport.width, COLOURS.boat);
        const airship = exactColourBounds(frame, viewport.width, COLOURS.airship);
        const logicalWidth = Math.min(viewport.width, 480);

        expect(boat.count, "boat hull has visible cyan pixels").toBeGreaterThan(10);
        expect(airship.count, "airship balloon has visible coral-red pixels").toBeGreaterThan(20);
        if (scenario === "party-walk") {
          expect(state.travel?.vehicles?.riding).toBeNull();
          expect(state.travel?.followers?.members.map((member) => [member.move.tx, member.move.ty])).toEqual([
            [15, 10],
            [15, 11],
          ]);
          expect(coral.count, "first follower paints its coral body").toBeGreaterThan(50);
          expect(mint.count, "second follower paints its mint body").toBeGreaterThan(50);
          expect(coral.minY).toBeLessThan(mint.minY);
        } else {
          expect(coral.count, "followers hide while riding").toBe(0);
          expect(mint.count, "followers hide while riding").toBe(0);
        }

        if (scenario === "boat") {
          expect(state.travel?.vehicles?.riding).toBe("boat");
          expect([state.move.tx, state.move.ty]).toEqual([15, 13]);
          expect(Math.abs((boat.minX + boat.maxX) / 2 - logicalWidth / 2)).toBeLessThanOrEqual(16);
        }
        if (scenario === "airship") {
          expect(state.travel?.vehicles).toMatchObject({
            riding: "airship",
            airshipPhase: "cruising",
            airshipPhaseTick: 48,
            airshipAltitude: 16,
          });
          expect([state.move.tx, state.move.ty]).toEqual([14, 12]);
          expect(Math.abs((airship.minX + airship.maxX) / 2 - logicalWidth / 2)).toBeLessThanOrEqual(16);
          expect(airship.maxY, "the cruising balloon is visibly above the parked boat").toBeLessThan(boat.minY);
        }

        await golden(`travel-${scenario}.${viewport.width}x${viewport.height}`, frame, viewport.width, viewport.height);
      }, 60_000);
    }
  }
});
