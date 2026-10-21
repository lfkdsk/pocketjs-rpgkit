// Imported K-RPGM5 presentation through the real cooker, GameView and wasm
// sim renderer. Goldens are paired with semantic state/tree/pixel assertions
// so a stable blank frame or a misplaced full-screen overlay cannot pass.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import type { SessionState } from "../src/engine/session.ts";
import { screenToneAt } from "../src/engine/rpgmaker-screen.ts";
import {
  weatherDimmerOpacity,
  weatherParticleGeometry,
  weatherParticles,
} from "../src/ui/screen-presentation.ts";
import { windowToneTheme } from "../src/ui/theme.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("rmi-play");
if (!preflight.ok) console.warn(`K-RPGM5 visual tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];

interface TreeNode {
  n?: string;
  t?: string;
  x?: string;
  k?: TreeNode[];
}

const VIEWPORTS = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
] as const;

function pump(world: BoundGameWorld, buttons = 0): void {
  world.frame(buttons, 0x8080);
  for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
}

function tap(world: BoundGameWorld, button: number): void {
  pump(world, button);
  pump(world, 0);
}

function waitFor(
  world: BoundGameWorld,
  predicate: (state: SessionState) => boolean,
  label: string,
  limit = 240,
): SessionState {
  for (let frame = 0; frame < limit; frame++) {
    const state = world.probes().state;
    if (predicate(state)) return state;
    pump(world);
  }
  throw new Error(`K-RPGM5 visual fixture did not reach ${label}`);
}

function waitForMessage(world: BoundGameWorld, text: string): SessionState {
  return waitFor(
    world,
    (state) => state.interp.modal?.kind === "text" && JSON.stringify(state.interp.modal).includes(text),
    `message ${JSON.stringify(text)}`,
  );
}

function dismissMessage(world: BoundGameWorld, text: string): void {
  for (let press = 0; press < 8; press++) {
    const modal = world.probes().state.interp.modal;
    if (modal?.kind !== "text" || !JSON.stringify(modal).includes(text)) return;
    tap(world, BTN.CIRCLE);
  }
  throw new Error(`K-RPGM5 visual fixture did not dismiss ${JSON.stringify(text)}`);
}

function findNode(node: TreeNode, name: string): TreeNode | null {
  if (node.n === name) return node;
  for (const child of node.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return null;
}

function nodesWithPrefix(node: TreeNode, prefix: string): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (entry: TreeNode): void => {
    if (entry.n?.startsWith(prefix)) out.push(entry);
    for (const child of entry.k ?? []) visit(child);
  };
  visit(node);
  return out;
}

function allText(node: TreeNode | null): string {
  if (!node) return "";
  if (node.t === "#text") return node.x ?? "";
  return (node.k ?? []).map(allText).join("\n");
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 4;
  return [...frame.subarray(at, at + 4)];
}

function countColour(frame: Uint8Array, colour: Rgba): number {
  let count = 0;
  for (let at = 0; at < frame.length; at += 4) {
    if (
      frame[at] === colour[0] && frame[at + 1] === colour[1] &&
      frame[at + 2] === colour[2] && frame[at + 3] === colour[3]
    ) count++;
  }
  return count;
}

function over(
  destination: readonly number[],
  source: readonly [number, number, number],
  opacity: number,
): number[] {
  return source.map((channel, index) =>
    Math.round(channel * opacity + destination[index]! * (1 - opacity)));
}

function projectedTonePixel(pixel: readonly number[], state: Readonly<SessionState>): Rgba {
  return exactTonePixel(pixel, screenToneAt(state.interp.screen?.tone));
}

/** Independent integer form of the PocketJS/MZ HSL-gray then signed-offset
 * equation. One common-denominator round avoids floating tie drift. */
function exactTonePixel(
  pixel: readonly number[],
  tone: Readonly<{ r: number; g: number; b: number; gray: number }>,
): Rgba {
  const alpha = pixel[3] ?? 255;
  const gray = Math.max(0, Math.min(255, Math.trunc(tone.gray)));
  const offsets = [tone.r, tone.g, tone.b].map((value) =>
    Math.max(-255, Math.min(255, Math.trunc(value))));
  const rgb = pixel.slice(0, 3);
  const loHi = Math.min(...rgb) + Math.max(...rgb);
  const toned = rgb.map((channel, index) => {
      const numerator = 2 * channel! * (255 - gray) + loHi * gray + 2 * offsets[index]! * alpha;
      const bounded = Math.max(0, Math.min(2 * 255 * alpha, numerator));
      return Math.floor((bounded + 255) / (2 * 255));
    });
  return [toned[0]!, toned[1]!, toned[2]!, alpha];
}

function expectRgbClose(actual: readonly number[], expected: readonly number[], label: string): void {
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(actual[channel]! - expected[channel]!), `${label} channel ${channel}`).toBeLessThanOrEqual(2);
  }
  expect(actual[3], `${label} alpha`).toBe(255);
}

function dimmed(pixel: readonly number[], opacity: number): number[] {
  return over(pixel, [0x50, 0x50, 0x50], opacity);
}

function particleRasterHits(
  base: Uint8Array,
  effect: Uint8Array,
  width: number,
  height: number,
  state: Readonly<SessionState>,
): { visible: number; hits: number; changed: number } {
  const particles = weatherParticles(state.interp.screen?.weather, width, height);
  const dimmer = weatherDimmerOpacity(state.interp.screen?.weather);
  let visible = 0;
  let hits = 0;
  for (const particle of particles) {
    const x = Math.round(particle.x + particle.width / 2);
    const y = Math.round(particle.y + particle.height / 2);
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 96) continue;
    visible++;
    let hit = false;
    for (let py = y - 2; py <= y + 2 && !hit; py++) {
      for (let px = x - 2; px <= x + 2; px++) {
        const want = dimmed(rgbaAt(base, width, px, py), dimmer);
        const got = rgbaAt(effect, width, px, py);
        if (Math.abs(got[0]! - want[0]!) + Math.abs(got[1]! - want[1]!) + Math.abs(got[2]! - want[2]!) > 4) {
          hit = true;
          break;
        }
      }
    }
    if (hit) hits++;
  }

  let changed = 0;
  for (let y = 0; y < height - 96; y++) {
    for (let x = 0; x < width; x++) {
      const want = dimmed(rgbaAt(base, width, x, y), dimmer);
      const got = rgbaAt(effect, width, x, y);
      if (Math.abs(got[0]! - want[0]!) + Math.abs(got[1]! - want[1]!) + Math.abs(got[2]! - want[2]!) > 4) changed++;
    }
  }
  return { visible, hits, changed };
}

async function golden(
  name: string,
  frame: Uint8Array,
  width: number,
  height: number,
): Promise<void> {
  const url = new URL(`./goldens/krm5-${name}.${width}x${height}.png`, import.meta.url);
  if (process.env.KRM5_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect([expected.width, expected.height]).toEqual([width, height]);
  expect(frame).toEqual(expected.rgba);
}

simDescribe("K-RPGM5 imported map presentation", () => {
  for (const viewport of VIEWPORTS) {
    test(`bush depth keeps one actor node and fades only four foot rows at ${viewport.width}x${viewport.height}`, async () => {
      const capture = async (preview: "bush" | "bush-base" | "bush-ground") => {
        const world = await bootGameWorld(
          appBundle("rmi-play"),
          60,
          { __rmiGame: "hollow", __rmiScreenPreview: preview },
          undefined,
          viewport,
        );
        waitFor(world, (state) => state.sw.self["map001/ev001"] === "A", `${preview} setup`);
        pump(world); // paint the reducer state that completed during the prior tick
        return {
          state: world.probes().state,
          frame: world.render().slice(),
          tree: world.getTree() as TreeNode,
        };
      };

      const base = await capture("bush-base");
      const bush = await capture("bush");
      const ground = await capture("bush-ground");
      const baseState = base.state;
      const bushState = bush.state;
      expect([bushState.move.tx, bushState.move.ty]).toEqual([20, 12]);
      expect(bushState.frame).toBe(baseState.frame);
      expect(ground.state.frame).toBe(baseState.frame);
      expect(nodesWithPrefix(base.tree, "rpgkit-player")).toHaveLength(1);
      expect(nodesWithPrefix(bush.tree, "rpgkit-player")).toHaveLength(1);
      expect(nodesWithPrefix(ground.tree, "rpgkit-player")).toHaveLength(1);

      const baseFrame = base.frame;
      const bushFrame = bush.frame;
      const groundFrame = ground.frame;
      const mapX = Math.max(0, Math.floor((viewport.width - 384) / 2));
      const mapY = Math.max(0, Math.floor((viewport.height - 256) / 2));
      const actorX = mapX + 20 * 16;
      const actorY = mapY + 12 * 16;
      const changed: [number, number][] = [];
      for (let y = 0; y < viewport.height; y++) {
        for (let x = 0; x < viewport.width; x++) {
          if (rgbaAt(baseFrame, viewport.width, x, y).some((value, channel) =>
            value !== rgbaAt(bushFrame, viewport.width, x, y)[channel])) changed.push([x, y]);
        }
      }
      expect(changed.length, "visible half-alpha foot pixels").toBeGreaterThan(6);
      expect(changed.every(([x, y]) =>
        x >= actorX && x < actorX + 16 && y >= actorY + 12 && y < actorY + 16),
      "all visual changes stay inside the bottom four logical sprite rows").toBe(true);

      let composited = 0;
      for (let y = actorY + 12; y < actorY + 16; y++) {
        for (let x = actorX; x < actorX + 16; x++) {
          const normal = rgbaAt(baseFrame, viewport.width, x, y);
          const backdrop = rgbaAt(groundFrame, viewport.width, x, y);
          if (normal.slice(0, 3).every((value, channel) => value === backdrop[channel])) continue;
          const expected = normal.slice(0, 3).map((value, channel) =>
            Math.round(value! * 128 / 255 + backdrop[channel]! * 127 / 255));
          expectRgbClose(rgbaAt(bushFrame, viewport.width, x, y), expected, `bush foot ${x},${y}`);
          composited++;
        }
      }
      expect(composited, "normal actor ink under the bush alpha mask").toBeGreaterThan(6);
      await golden("bush-depth", bushFrame, viewport.width, viewport.height);
    }, 60_000);

    test(`weather and tileset art at ${viewport.width}x${viewport.height}`, async () => {
      const base = await bootGameWorld(
        appBundle("rmi-play"),
        60,
        { __rmiGame: "hollow", __rmiScreenPreview: "weather-base" },
        undefined,
        viewport,
      );
      waitForMessage(base, "Rain drums");
      tap(base, BTN.CIRCLE); // reveal the imported line without dismissing it
      const baseState = base.probes().state;
      const baseFrame = base.render().slice();

      const world = await bootGameWorld(
        appBundle("rmi-play"),
        60,
        { __rmiGame: "hollow", __rmiScreenPreview: "weather" },
        undefined,
        viewport,
      );
      waitForMessage(world, "Rain drums");
      tap(world, BTN.CIRCLE);
      const rainState = world.probes().state;
      expect(rainState.frame).toBe(baseState.frame);
      expect(rainState.interp.screen?.weather).toMatchObject({ kind: "rain", fromPower: 3, targetPower: 3, left: 0 });
      const rainParticles = weatherParticles(rainState.interp.screen?.weather, viewport.width, viewport.height);
      expect(rainParticles).toHaveLength(30);
      expect(nodesWithPrefix(world.getTree() as TreeNode, "rpgkit-weather-particle-")).toHaveLength(30);
      expect(weatherParticleGeometry("rain")).toMatchObject({ width: 1, height: 60, rotate: 11.25 });
      expect(weatherParticleGeometry("rain").dx).toBeLessThan(0);
      expect(weatherParticleGeometry("rain").dy).toBeGreaterThan(0);

      const rainFrame = world.render().slice();
      const raster = particleRasterHits(baseFrame, rainFrame, viewport.width, viewport.height, rainState);
      expect(raster.visible).toBeGreaterThan(5);
      expect(raster.hits).toBeGreaterThanOrEqual(Math.floor(raster.visible * 0.7));
      expect(raster.changed, "rain raster contains diagonal particle ink").toBeGreaterThan(80);
      await golden("rain", rainFrame, viewport.width, viewport.height);

      dismissMessage(world, "Rain drums");
      waitForMessage(world, "frost seals");
      tap(world, BTN.CIRCLE);
      const snowState = world.probes().state;
      expect(snowState.interp.tileset).toBe("ts3");
      expect(snowState.interp.screen?.weather).toMatchObject({ kind: "snow", fromPower: 5, targetPower: 5, left: 0 });
      expect(weatherParticles(snowState.interp.screen?.weather, viewport.width, viewport.height)).toHaveLength(50);
      expect(nodesWithPrefix(world.getTree() as TreeNode, "rpgkit-weather-particle-")).toHaveLength(50);
      expect(weatherParticleGeometry("snow")).toMatchObject({ width: 9, height: 9, radius: 4, rotate: 11.25 });
      expect(weatherParticleGeometry("snow").dx).toBeLessThan(0);
      expect(weatherParticleGeometry("snow").dy).toBeGreaterThan(0);

      const snowFrame = world.render().slice();
      const mapX = Math.max(0, Math.floor((viewport.width - 384) / 2));
      const mapY = Math.max(0, Math.floor((viewport.height - 256) / 2));
      const snowDimmer = weatherDimmerOpacity(snowState.interp.screen?.weather);
      const frostGround = dimmed([184, 216, 220, 255], snowDimmer);
      let frostGroundSamples = 0;
      for (const x of [0, 8, 16, 24, 32, 40]) {
        const actual = rgbaAt(snowFrame, viewport.width, mapX + x, mapY);
        if (actual.slice(0, 3).every((channel, index) => Math.abs(channel! - frostGround[index]!) <= 2)) {
          frostGroundSamples++;
        }
      }
      expect(frostGroundSamples, "frost ground source replaces base grass").toBeGreaterThanOrEqual(3);

      const frostUpper = dimmed([216, 244, 255, 255], snowDimmer);
      let frostUpperSamples = 0;
      for (let y = 4; y < 10; y++) {
        for (let x = 244; x < 252; x++) {
          const actual = rgbaAt(snowFrame, viewport.width, mapX + x, mapY + y);
          if (actual.slice(0, 3).every((channel, index) => Math.abs(channel! - frostUpper[index]!) <= 2)) {
            frostUpperSamples++;
          }
        }
      }
      expect(frostUpperSamples, "frost upper source replaces the base star tile").toBeGreaterThan(8);
      await golden("snow-tileset", snowFrame, viewport.width, viewport.height);
    }, 60_000);

    test(`tone, window chrome and formation at ${viewport.width}x${viewport.height}`, async () => {
      const base = await bootGameWorld(
        appBundle("rmi-play"),
        60,
        { __rmiGame: "stage", __rmiScreenPreview: "tone-base" },
        undefined,
        viewport,
      );
      waitForMessage(base, "show begins");
      tap(base, BTN.CIRCLE);
      const baseState = base.probes().state;
      const baseFrame = base.render().slice();

      const world = await bootGameWorld(
        appBundle("rmi-play"),
        60,
        { __rmiGame: "stage", __rmiScreenPreview: "tone" },
        undefined,
        viewport,
      );
      waitForMessage(world, "show begins");
      tap(world, BTN.CIRCLE);
      const state = world.probes().state;
      const windowTone = state.sw.windowTone!;
      expect(state.frame).toBe(baseState.frame);
      expect(state.sw.formationAccess).toBe(false);
      expect(windowTone).toEqual({ r: -72, g: 36, b: -18, gray: 96 });
      expect(state.interp.screen?.tone?.to).toEqual({ r: -68, g: 34, b: -17, gray: 96 });
      expect(nodesWithPrefix(world.getTree() as TreeNode, "rpgkit-screen-tone-").map((node) => node.n)).toEqual([
        "rpgkit-screen-tone-filter",
      ]);

      const frame = world.render().slice();
      for (const [x, y] of [[2, 2], [Math.floor(viewport.width / 2), Math.floor(viewport.height / 3)]]) {
        expectRgbClose(
          rgbaAt(frame, viewport.width, x, y),
          projectedTonePixel(rgbaAt(baseFrame, viewport.width, x, y), state),
          `tone sample ${x},${y}`,
        );
      }

      const themed = windowToneTheme(undefined, windowTone, true)!;
      expect(themed.windowTone).toEqual(windowTone);
      const paper = exactTonePixel([0x0b, 0x16, 0x26, 0xff], windowTone);
      const border = exactTonePixel([0x5d, 0x7f, 0xa3, 0xff], windowTone);
      expect(countColour(frame, paper), "toned window paper pixels").toBeGreaterThan(8_000);
      expect(countColour(frame, border), "toned window frame pixels").toBeGreaterThan(700);
      await golden("tone-window", frame, viewport.width, viewport.height);

      dismissMessage(world, "show begins");
      waitFor(world, (candidate) => candidate.interp.main === null && candidate.interp.modal === null, "tone preview completion");
      expect(world.probes().state.sw.formationAccess).toBeUndefined();
      tap(world, BTN.CROSS);
      let tree = world.getTree() as TreeNode;
      const formation = findNode(tree, "rpgmaker-formation-overlay");
      expect(formation).not.toBeNull();
      expect(allText(formation)).toContain("Ivy");
      expect(allText(formation)).toContain("Rowan");

      tap(world, BTN.CIRCLE);
      tap(world, BTN.DOWN);
      tap(world, BTN.CIRCLE);
      expect(world.probes().state.sw.partyOrder).toEqual([2, 1]);
      tree = world.getTree() as TreeNode;
      expect(allText(findNode(tree, "rpgmaker-formation-overlay"))).toContain("Rowan");
      await golden("formation", world.render().slice(), viewport.width, viewport.height);
    }, 60_000);
  }
});

simDescribe("K-RPGM5 battle presentation", () => {
  for (const viewport of VIEWPORTS) {
    test(`tone/weather cover battle sprites but remain below windows at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("rmi-play"),
        60,
        { __rmiGame: "hollow", __rmiBattlePreview: "en", __rmiBattleScreenEffects: true },
        undefined,
        viewport,
      );
      for (let frame = 0; frame < 12; frame++) pump(world, frame % 2 === 0 ? BTN.CIRCLE : 0);
      expect(world.probes().state.scene).toMatchObject({
        kind: "battle",
        state: { format: "rpgmaker-battle-state/v1", phase: "target" },
      });
      const tree = world.getTree() as TreeNode;
      const battle = findNode(tree, "rpgmaker-battle-scene");
      expect(battle).not.toBeNull();
      expect(nodesWithPrefix(battle!, "rpgkit-weather-particle-")).toHaveLength(30);
      expect(nodesWithPrefix(battle!, "rpgkit-screen-tone-")).toHaveLength(1);
      expect(findNode(battle!, "rpgmaker-target-menu")).not.toBeNull();

      const frame = world.render().slice();
      expect(rgbaAt(frame, viewport.width, 2, 2)).not.toEqual([0x16, 0x25, 0x36, 0xff]);
      // Exact target-window paper survives: presentation is inside the
      // battle spriteset and therefore below the battle windows.
      expect(countColour(frame, [0x0b, 0x16, 0x26, 0xff])).toBeGreaterThan(13_000);
      await golden("battle", frame, viewport.width, viewport.height);
    }, 60_000);
  }
});
