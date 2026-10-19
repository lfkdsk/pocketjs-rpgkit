// Built GameView proof for the KRM2 timer/map banner/numbered picture and
// explicit number-input scene. Golden frames are paired with semantic pixel
// and node assertions so a stable but clipped/blank image cannot pass.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { numberInputText, type NumberInputState } from "../src/engine/number-input.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("krm2-ui");
if (!preflight.ok) console.warn(`KRM2 UI sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
const WHITE: Rgba = [255, 255, 255, 255];
const BACKDROP: Rgba = [0x05, 0x09, 0x14, 255];
const PANEL_BG: Rgba = [0x14, 0x1c, 0x30, 255];
const CELL_BG: Rgba = [0x0b, 0x16, 0x26, 255];
const CURSOR: Rgba = [0xff, 0xe1, 0x7a, 255];
const EFFECT_SOURCE: Rgba = [120, 80, 40, 255];
const EFFECT_DESTINATION: Rgba = [60, 40, 20, 255];

type EffectMode = "normal" | "add" | "multiply" | "screen";

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/** Independent opaque-pixel oracle for MZ's HSL-lightness gray projection
 * followed by Pixi's blend factors. It intentionally works from the public
 * equations rather than PocketJS command words or renderer helpers. */
function expectedEffectPixel(
  mode: EffectMode,
  tone: readonly [number, number, number, number] = [0, 0, 0, 0],
): number[] {
  const source = EFFECT_SOURCE.slice(0, 3);
  const lo = Math.min(...source);
  const hi = Math.max(...source);
  const gray = clampByte(tone[3]);
  const toned = source.map((channel, index) => clampByte(Math.round(
    (channel * (255 - gray) + ((lo + hi) / 2) * gray) / 255 + tone[index]!,
  )));
  const destination = EFFECT_DESTINATION.slice(0, 3);
  const rgb = toned.map((channel, index) => {
    const under = destination[index]!;
    switch (mode) {
      case "add": return Math.min(255, channel + under);
      case "multiply": return Math.round((channel * under) / 255);
      case "screen": return Math.round(channel + under * (1 - channel / 255));
      case "normal": return channel;
    }
  });
  return [...rgb, 255];
}

const FINAL_HASHES: Readonly<Record<string, string>> = {
  "hud.480x272": "2a1f4e3c",
  "number.480x272": "83ea1dd3",
  "hud.960x544": "af4ce01c",
  "number.960x544": "8fcbf623",
};

function pump(world: BoundGameWorld, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(0, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(i, i + 4)];
}

function countColour(
  frame: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colour: Rgba,
): number {
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const pixel = rgbaAt(frame, width, x, y);
      if (pixel.every((value, channel) => value === colour[channel])) count++;
    }
  }
  return count;
}

function countBright(
  frame: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  threshold = 600,
): number {
  let count = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const [r, g, b, a] = rgbaAt(frame, width, x, y);
      if (a === 255 && r! + g! + b! > threshold) count++;
    }
  }
  return count;
}

async function golden(
  name: string,
  frame: Uint8Array,
  width: number,
  height: number,
): Promise<string> {
  const url = new URL(`./goldens/krm2-ui.${name}.png`, import.meta.url);
  if (process.env.KRM2_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const png = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect(png.width).toBe(width);
  expect(png.height).toBe(height);
  expect(frame).toEqual(png.rgba);
  return fnv1a(frame);
}

simDescribe("KRM2 HUD and number-input visuals", () => {
  for (const viewport of [
    { width: 480, height: 272 },
    { width: 960, height: 544 },
  ] as const) {
    test(`renders an uncut timer/banner and all eight digits at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(appBundle("krm2-ui"), 60, undefined, undefined, viewport);
      pump(world, 30);

      const state = world.probes().state;
      expect(state.scene).toBeNull();
      expect(state.sw.timer).toMatchObject({ running: true, expired: false });
      expect(state.interp.screen?.pictures?.["7"]).toBeDefined();
      expect(Object.keys(state.interp.screen?.pictures ?? {})).toEqual(["1", "2", "3", "4", "7"]);
      expect(state.interp.screen?.mapNameBanner?.text).toContain("Unbroken Lanterns");

      const hud = world.render().slice();
      const tree = JSON.stringify(world.getTree());
      // Both wrapped map-name rows exist, and the full 123:26 timer text is
      // retained in the node tree rather than shortened to a fixed MM:SS box.
      expect(tree).toContain("rpgkit-map-name-line-1");
      expect(tree).toContain("123:26");
      expect(countBright(hud, viewport.width, viewport.width - 90, 8, 82, 24)).toBeGreaterThan(15);
      expect(countBright(hud, viewport.width, Math.round(viewport.width / 2) - 180, 40, 360, 60)).toBeGreaterThan(80);
      // The moving/tinted/rotated picture contributes many bright opaque
      // pixels below the banner; a blank effects layer cannot satisfy this.
      let bright = 0;
      for (let y = 100; y < Math.min(240, viewport.height); y++) {
        for (let x = 40; x < Math.min(340, viewport.width); x++) {
          const [r, g, b, a] = rgbaAt(hud, viewport.width, x, y);
          if (a === 255 && r! + g! + b! > 650) bright++;
        }
      }
      expect(bright).toBeGreaterThan(150);
      const scale = viewport.width / 480;
      const swatches = [
        { x: 16, mode: "add" as const, tone: [0, 0, 0, 0] as const },
        { x: 40, mode: "multiply" as const, tone: [0, 0, 0, 0] as const },
        { x: 64, mode: "screen" as const, tone: [0, 0, 0, 0] as const },
        { x: 88, mode: "normal" as const, tone: [20, -30, 100, 255] as const },
      ];
      for (const swatch of swatches) {
        const pixel = rgbaAt(
          hud,
          viewport.width,
          swatch.x + 8,
          232 + 8,
        );
        expect(pixel, `${swatch.mode} effect pixel`).toEqual(expectedEffectPixel(swatch.mode, swatch.tone));
      }
      const hudHash = await golden(`hud.${viewport.width}x${viewport.height}`, hud, viewport.width, viewport.height);
      if (!process.env.KRM2_UPDATE_GOLDENS) expect(hudHash).toBe(FINAL_HASHES[`hud.${viewport.width}x${viewport.height}`]);

      pump(world, 40);
      const numberState = world.probes().state.scene?.state as unknown as NumberInputState;
      expect(world.probes().state.scene).toMatchObject({ kind: "scene", id: "rpgkit.numberInput" });
      expect(numberInputText(numberState)).toBe("12345678");
      const number = world.render().slice();
      const numberTree = JSON.stringify(world.getTree());
      expect(numberTree).toContain("rpgkit-number-input-digit-7");

      const panelX = (viewport.width - 360 * scale) / 2;
      const panelY = (viewport.height - 112 * scale) / 2;
      // A full-screen game scene owns the foreground: HUD/pictures from the
      // parked map must not bleed through around the compact input panel.
      expect(rgbaAt(number, viewport.width, 4 * scale, 4 * scale)).toEqual([...BACKDROP]);
      expect(rgbaAt(number, viewport.width, panelX + 8 * scale, panelY + 8 * scale)).toEqual([...PANEL_BG]);
      expect(rgbaAt(number, viewport.width, panelX + 25 * scale, panelY + 47 * scale)).toEqual([...CURSOR]);
      expect(rgbaAt(number, viewport.width, panelX + 305 * scale, panelY + 47 * scale)).toEqual([...CELL_BG]);
      expect(countColour(number, viewport.width, panelX + 20 * scale, panelY + 42 * scale, 320 * scale, 42 * scale, WHITE))
        .toBeGreaterThan(30);
      const numberHash = await golden(`number.${viewport.width}x${viewport.height}`, number, viewport.width, viewport.height);
      if (!process.env.KRM2_UPDATE_GOLDENS) expect(numberHash).toBe(FINAL_HASHES[`number.${viewport.width}x${viewport.height}`]);
    }, 30_000);
  }

  test("60/20/4 Hz present the same mid-tween HUD at the same virtual instant", async () => {
    const outcomes: Array<{ state: unknown; pixels: string }> = [];
    for (const hz of [60, 20, 4] as const) {
      const world = await bootGameWorld(appBundle("krm2-ui"), hz);
      pump(world, hz / 2);
      const state = world.probes().state;
      outcomes.push({
        state: {
          timer: state.sw.timer,
          picture: state.interp.screen?.pictures?.["7"],
          banner: state.interp.screen?.mapNameBanner,
          mode: state.interp.main?.mode,
        },
        pixels: fnv1a(world.render()),
      });
    }
    for (const outcome of outcomes.slice(1)) expect(outcome).toEqual(outcomes[0]);
  }, 30_000);
});
