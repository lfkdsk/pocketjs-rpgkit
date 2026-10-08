// KS1 presentation integration: scripted camera + shake transform, balloon
// sprites, colour layers, cutscene backdrop and fade at both supported
// logical viewport shapes.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { TILE } from "../src/engine/tiles.ts";
import { PLAYER_START } from "./fixtures/ka1-anim/fixture-data.ts";
import { KS1_PERSIST_TARGET_ID } from "./fixtures/ka1-anim/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("ka1-anim");
if (!preflight.ok) console.warn(`ks1 render sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
const GOLDEN_HASHES: Readonly<Record<string, string>> = {
  "480x272": "05580e6d",
  "640x360": "954dbd6d",
};

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function action(world: BoundGameWorld): void {
  pump(world, 1, BTN.CIRCLE);
  pump(world, 1);
}

function rgbaAt(frame: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return [...frame.subarray(i, i + 4)];
}

function expectPixel(
  frame: Uint8Array,
  width: number,
  x: number,
  y: number,
  colour: Rgba,
): void {
  expect(rgbaAt(frame, width, x, y), `pixel (${x},${y})`).toEqual([...colour]);
}

function findNode(tree: unknown, name: string): any {
  const node = tree as { n?: string; k?: unknown[] };
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

async function golden(name: string, frame: Uint8Array, width: number, height: number): Promise<string> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.KS1_UPDATE_GOLDENS) await Bun.write(url, encodePNG(frame, width, height));
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
  return fnv1a(frame);
}

simDescribe("KS1 rendered screen effects", () => {
  for (const viewport of [
    { width: 480, height: 272, camera: { x: 160, y: 64 } },
    { width: 640, height: 360, camera: { x: 0, y: 20 } },
  ] as const) {
    test(`camera, balloon and overlays at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("ka1-anim"),
        60,
        { __ka1Ks1: true },
        undefined,
        viewport,
      );
      pump(world, 1);

      // Stage 1: fixed camera, persistent animated balloon and a named tint.
      action(world);
      expect(world.probes().camera).toMatchObject(viewport.camera);
      expect(world.probes().state.interp.screen).toMatchObject({
        camera: { mode: "fixed", left: 0 },
        balloons: { player: { icon: "pulse", left: null } },
        tints: { night: { left: 0 } },
      });
      const first = world.render().slice();
      const balloonX = PLAYER_START.x * TILE - viewport.camera.x + 8;
      const balloonY = PLAYER_START.y * TILE - viewport.camera.y - 24;
      // Pulse frame 0 is red; the blue tint keeps it visibly red-purple.
      const balloonPixel = rgbaAt(first, viewport.width, balloonX, balloonY);
      expect(balloonPixel[0]).toBeGreaterThan(balloonPixel[2]!);
      expect(balloonPixel[2]).toBeGreaterThan(balloonPixel[1]!);
      expect(findNode(world.getTree(), "rpgkit-balloon-player")).toBeDefined();
      const hash = await golden(
        `ks1-screen-${viewport.width}x${viewport.height}`,
        first,
        viewport.width,
        viewport.height,
      );
      expect(hash).toBe(GOLDEN_HASHES[`${viewport.width}x${viewport.height}`]);

      // Stage 2: the flash is viewport-wide while shake offsets only the map
      // camera (HUD/overlays stay fixed).
      action(world);
      expect(world.probes().state.interp.screen?.flash?.left).toBe(59);
      expect(world.probes().state.interp.screen?.shake?.left).toBe(59);
      expect(world.probes().camera.x).toBe(viewport.camera.x - 7);
      const flashed = world.render().slice();
      const flashPixel = rgbaAt(flashed, viewport.width, 4, 4);
      expect(flashPixel[0]).toBeGreaterThan(flashPixel[2]!);
      expect(findNode(world.getTree(), "rpgkit-screen-flash")).toBeDefined();

      pump(world, 59);
      expect(world.probes().state.interp.screen?.flash).toBeUndefined();
      expect(world.probes().state.interp.screen?.shake).toBeUndefined();
      expect(world.probes().camera).toMatchObject(viewport.camera);

      // Stage 3: change_bg-style backdrop replaces the map below an active
      // dialog; the named tint still applies to the backdrop, not the box.
      action(world);
      expect(world.probes().state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "blue" });
      expect(world.probes().state.interp.modal?.kind).toBe("text");
      for (let frame = 0; frame < 10 && !world.probes().state.sw.switches["ks1.backdrop.attempted"]; frame++) {
        pump(world, 1);
      }
      expect(world.probes().state.sw.switches["ks1.backdrop.attempted"]).toBe(true);
      expect(world.probes().state.interp.modal?.kind).toBe("text");
      expect(world.probes().state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "blue" });
      const backed = world.render().slice();
      expectPixel(backed, viewport.width, 4, 4, [15, 64, 142, 255]);
      expect(rgbaAt(backed, viewport.width, viewport.width >> 1, viewport.height - 20))
        .not.toEqual([15, 64, 142, 255]);

      action(world); // reveal all
      action(world); // close and let the following autorun begin its fade
      for (let i = 0; i < 5 && !world.probes().state.interp.screen?.fade; i++) pump(world, 1);
      expect(world.probes().state.interp.screen?.backdrop).toBeUndefined();
      expect(world.probes().state.interp.screen?.fade).toBeDefined();
      pump(world, 30);
      const faded = world.render().slice();
      const fadedPixel = rgbaAt(faded, viewport.width, 4, 4);
      expect(fadedPixel[0]).toBeLessThan(15);
      expect(fadedPixel[1]).toBeLessThan(64);
      expect(fadedPixel[2]).toBeLessThan(142);

      for (let i = 0; i < 40 && !world.probes().state.sw.switches["ks1.stage.4"]; i++) pump(world, 1);
      expect(world.probes().state.sw.switches["ks1.stage.4"]).toBe(true);
      action(world);
      for (let i = 0; i < 70 && !world.probes().state.sw.switches["ks1.stage.5"]; i++) pump(world, 1);
      expect(world.probes().state.sw.switches["ks1.stage.5"]).toBe(true);
      expect(world.probes().state.interp.screen).toBeUndefined();
    }, 30_000);
  }

  for (const viewport of [
    {
      width: 480,
      height: 272,
      camera: { x: 160, y: 64 },
      animPixel: { x: 168, y: 136 },
      balloonPixel: { x: 168, y: 104 },
    },
    {
      width: 960,
      height: 544,
      camera: { x: 0, y: 0 },
      animPixel: { x: 488, y: 272 },
      balloonPixel: { x: 488, y: 240 },
    },
  ] as const) {
    test(`transfer-persistent presentation at ${viewport.width}x${viewport.height}`, async () => {
      const world = await bootGameWorld(
        appBundle("ka1-anim"),
        60,
        { __ka1Persist: true },
        undefined,
        viewport,
      );
      pump(world, 1);
      action(world);

      const landed = world.probes();
      expect(landed.state.mapId).toBe(KS1_PERSIST_TARGET_ID);
      expect(landed.camera).toMatchObject(viewport.camera);
      expect(landed.state.interp.anims).toContainEqual(expect.objectContaining({
        id: "persist-pulse",
        target: "player",
        loop: true,
      }));
      expect(landed.state.interp.screen).toMatchObject({
        camera: { mode: "fixed", left: 0 },
        balloons: { player: { target: "player", icon: "pulse", left: null } },
      });
      expect(findNode(world.getTree(), "rpgkit-map-anim-above-persist-pulse")).toBeDefined();
      expect(findNode(world.getTree(), "rpgkit-balloon-player")).toBeDefined();

      const visible = world.render().slice();
      expectPixel(visible, viewport.width, viewport.animPixel.x, viewport.animPixel.y, [226, 62, 62, 255]);
      expectPixel(visible, viewport.width, viewport.balloonPixel.x, viewport.balloonPixel.y, [226, 62, 62, 255]);
      await golden(
        `ks1-persist-world-${viewport.width}x${viewport.height}`,
        visible,
        viewport.width,
        viewport.height,
      );

      for (let frame = 0; frame < 40 && !world.probes().state.interp.screen?.backdrop; frame++) pump(world, 1);
      expect(world.probes().state.interp.screen?.backdrop).toEqual({ layer: "cutscene", variant: "red" });
      const backdrop = world.render().slice();
      for (const [x, y] of [[0, 0], [viewport.width - 1, 0], [0, viewport.height - 1], [viewport.width - 1, viewport.height - 1]]) {
        expectPixel(backdrop, viewport.width, x, y, [112, 24, 24, 255]);
      }
      await golden(
        `ks1-persist-backdrop-${viewport.width}x${viewport.height}`,
        backdrop,
        viewport.width,
        viewport.height,
      );
    }, 30_000);
  }
});
