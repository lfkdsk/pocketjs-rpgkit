// Visible acceptance fixture for same-tick scripted motion and the bounded
// Tuxemon-style backdrop stack at handheld and doubled logical resolutions.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { PLAYER_START } from "./fixtures/ka1-anim/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("ka1-anim");
if (!preflight.ok) console.warn(`ktux1 render sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
const GOLDEN_HASHES: Readonly<Record<string, string>> = {
  "ktux1-immediate-480x272": "33b69da9",
  "ktux1-stack-pushed-480x272": "bd5cedc5",
  "ktux1-stack-exposed-480x272": "e1f86dc5",
  "ktux1-immediate-960x544": "a952ded9",
  "ktux1-stack-pushed-960x544": "d61dddc5",
  "ktux1-stack-exposed-960x544": "c88bddc5",
};

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(offset, offset + 4)];
}

function expectPixel(frame: Uint8Array, width: number, x: number, y: number, colour: Rgba): void {
  expect(rgbaAt(frame, width, x, y), `pixel (${x},${y})`).toEqual([...colour]);
}

function colourCount(frame: Uint8Array, colour: Rgba): number {
  let count = 0;
  for (let i = 0; i < frame.length; i += 4) {
    if (frame[i] === colour[0] && frame[i + 1] === colour[1] &&
        frame[i + 2] === colour[2] && frame[i + 3] === colour[3]) count++;
  }
  return count;
}

async function golden(name: string, frame: Uint8Array, width: number, height: number): Promise<void> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  const updating = Boolean(process.env.KTUX1_UPDATE_GOLDENS);
  if (updating) await Bun.write(url, encodePNG(frame, width, height));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
  const hash = fnv1a(frame);
  if (updating) console.log(`${name}: ${hash}`);
  else expect(hash).toBe(GOLDEN_HASHES[name]);
}

simDescribe("immediate motion and backdrop stack rendering", () => {
  for (const viewport of [
    { width: 480, height: 272 },
    { width: 960, height: 544 },
  ] as const) {
    test(`visible same-tick turn/start and stack expose at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("ka1-anim"),
        60,
        { __ktux1: true },
        undefined,
        viewport,
      );
      pump(world, 1);

      // One input/reference tick: both the explicit face and the first route
      // step are already in the saved/rendered state.
      pump(world, 1, BTN.CIRCLE);
      const movingState = world.probes().state;
      expect(movingState.move).toMatchObject({
        tx: PLAYER_START.x,
        ty: PLAYER_START.y,
        facing: 3,
        moving: true,
      });
      expect(movingState.move.px).toBeGreaterThan(PLAYER_START.x * 16);
      const moving = world.render().slice();
      // Right-facing walker body is authored blue; this catches a frame
      // that rendered the old down-facing red sprite despite reducer state.
      expect(colourCount(moving, [74, 132, 246, 255])).toBeGreaterThan(20);
      await golden(
        `ktux1-immediate-${viewport.width}x${viewport.height}`,
        moving,
        viewport.width,
        viewport.height,
      );

      for (let frame = 0; frame < 20 && !world.probes().state.sw.switches["ktux.stage.pushed"]; frame++) {
        pump(world, 1);
      }
      const pushedState = world.probes().state;
      expect(pushedState.sw.switches["ktux.stage.pushed"]).toBe(true);
      expect(pushedState.interp.modal).toBeNull();
      expect(pushedState.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "red" });
      expect(pushedState.interp.screen?.backdropStack).toEqual([{ layer: "cutscene", variant: "blue" }]);
      const pushed = world.render().slice();
      for (const [x, y] of [[0, 0], [viewport.width - 1, 0], [0, viewport.height - 1], [viewport.width - 1, viewport.height - 1]]) {
        expectPixel(pushed, viewport.width, x, y, [112, 24, 24, 255]);
      }
      await golden(
        `ktux1-stack-pushed-${viewport.width}x${viewport.height}`,
        pushed,
        viewport.width,
        viewport.height,
      );

      for (let frame = 0; frame < 80 && !world.probes().state.sw.switches["ktux.stage.popped"]; frame++) {
        pump(world, 1);
      }
      const exposedState = world.probes().state;
      expect(exposedState.sw.switches["ktux.stage.popped"]).toBe(true);
      expect(exposedState.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "blue" });
      expect(exposedState.interp.screen?.backdropStack).toBeUndefined();
      const exposed = world.render().slice();
      expectPixel(exposed, viewport.width, 0, 0, [24, 64, 112, 255]);
      await golden(
        `ktux1-stack-exposed-${viewport.width}x${viewport.height}`,
        exposed,
        viewport.width,
        viewport.height,
      );
    }, 30_000);
  }
});
