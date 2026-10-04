// Read-only neighbour preview in the real GameView + connected-world
// renderer: what is painted across a seam, how it is ordered against the
// active map's actors and the upper band, and that a seamless handoff swaps
// the preview for the authoritative characters with no duplicate and no gap.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { WorldNpcPreviewStats } from "../src/ui/WorldNpcPreview.tsx";
import {
  COLOURS,
  FACER_COLOURS,
  MAP_H,
  MAP_W,
  PLACED,
  PLAYER_COLOUR,
  type Rgba,
} from "./fixtures/world-preview/fixture-data.ts";
import type { WorldPreviewFixtureProbe } from "./fixtures/world-preview/world-preview.tsx";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation, type BoundGameWorld } from "./helpers/sim-session.ts";

const preflight = appPreflight("world-preview");
if (!preflight.ok) console.warn(`world-preview sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface Viewport {
  width: number;
  height: number;
}

const VIEWPORTS: readonly Viewport[] = [
  { width: 480, height: 272 },
  { width: 960, height: 544 },
];
const RIGHT = 0x0020;
const LEFT = 0x0080;
const UP = 0x0010;
const DOWN = 0x0040;
const TILE = 16;
const COMPONENT_W = MAP_W * 2 * TILE;
const COMPONENT_H = MAP_H * 3 * TILE;
const ground = (id: string): Rgba => PLACED.find((map) => map.id === id)!.ground;
const upper = (id: string): Rgba => PLACED.find((map) => map.id === id)!.upper;
const FACER_LEFT = FACER_COLOURS[1]!;

/** World tile of a map-local cell. */
const east = (x: number, y: number): [number, number] => [MAP_W + x, y];
const south = (x: number, y: number): [number, number] => [x, MAP_H + y];
const north = (x: number, y: number): [number, number] => [x, y - MAP_H];

/** Paint order: north's character is in the behind band, the rest in the
 * front band, each by world (y, x) depth. */
const INITIAL_ACTORS = [
  "north/n-row",
  "east/e-z-short", "east/e-wander", "east/e-a-tall", "east/e-static", "east/e-under", "east/e-removed",
  "south/s-tall",
];
const GATED_ACTORS = [
  "north/n-row",
  "east/e-z-short", "east/e-wander", "east/e-a-tall", "east/e-static", "east/e-under", "east/e-gated",
  "south/s-tall",
];

function probe(): WorldPreviewFixtureProbe {
  const value = globalThis.__worldPreviewProbe;
  if (!value) throw new Error("world-preview fixture did not mount");
  return value;
}

function lastPreview(): WorldNpcPreviewStats {
  const stats = probe().previews.at(-1);
  if (!stats) throw new Error("no preview repaint was reported");
  return stats;
}

async function boot(
  viewport: Viewport,
  hz = 60,
  mode: "preview" | "off" | "legacy" = "preview",
): Promise<BoundGameWorld> {
  return bootGameWorld(appBundle("world-preview"), hz, { __worldPreviewMode: mode }, undefined, viewport);
}

function step(world: BoundGameWorld, buttons = 0, frames = 1): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    world.tick();
  }
}

/** Screen pixel of a component-world point for this frame's camera. */
function screenOf(world: BoundGameWorld, viewport: Viewport, worldX: number, worldY: number): [number, number] {
  const camera = world.probes().camera;
  const frameX = COMPONENT_W < viewport.width ? (viewport.width - COMPONENT_W) / 2 : 0;
  const frameY = COMPONENT_H < viewport.height ? (viewport.height - COMPONENT_H) / 2 : 0;
  return [frameX + worldX - camera.x, frameY + worldY - camera.y];
}

function rgbaAt(frame: Uint8Array, viewport: Viewport, x: number, y: number): number[] {
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThan(viewport.width);
  expect(y).toBeLessThan(viewport.height);
  const offset = (Math.floor(y) * viewport.width + Math.floor(x)) * 4;
  return [...frame.subarray(offset, offset + 4)];
}

/** Colour at a pixel offset inside a world tile. */
function tilePixel(
  world: BoundGameWorld,
  frame: Uint8Array,
  viewport: Viewport,
  [tileX, tileY]: [number, number],
  dx = 8,
  dy = 8,
): number[] {
  const [x, y] = screenOf(world, viewport, tileX * TILE + dx, tileY * TILE + dy);
  return rgbaAt(frame, viewport, x, y);
}

function countColour(frame: Uint8Array, colour: Rgba): number {
  let count = 0;
  for (let offset = 0; offset < frame.length; offset += 4) {
    if (frame[offset] === colour[0] && frame[offset + 1] === colour[1] &&
        frame[offset + 2] === colour[2] && frame[offset + 3] === colour[3]) count++;
  }
  return count;
}

/** Component-world top-left of the single 16px sprite painted in `colour`. */
function spriteWorldPos(world: BoundGameWorld, viewport: Viewport, frame: Uint8Array, colour: Rgba): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  for (let offset = 0; offset < frame.length; offset += 4) {
    if (frame[offset] !== colour[0] || frame[offset + 1] !== colour[1] ||
        frame[offset + 2] !== colour[2] || frame[offset + 3] !== colour[3]) continue;
    const pixel = offset / 4;
    minX = Math.min(minX, pixel % viewport.width);
    minY = Math.min(minY, Math.floor(pixel / viewport.width));
  }
  const [originX, originY] = screenOf(world, viewport, 0, 0);
  return [minX - originX, minY - originY];
}

/** Hold `buttons` until the player rests on (x, y) of `mapId`. */
function walkTo(world: BoundGameWorld, buttons: number, mapId: string, x: number, y: number): void {
  for (let frame = 0; frame < 600; frame++) {
    const state = world.probes().state;
    if (state.mapId === mapId && state.move.tx === x && state.move.ty === y &&
        !state.move.moving && state.handoff === undefined) return;
    step(world, buttons);
  }
  const state = world.probes().state;
  throw new Error(`did not reach ${mapId} (${x}, ${y}); at ${state.mapId} (${state.move.tx}, ${state.move.ty})`);
}

/** West → east, wait until east's wanderer has left its authored cell, and
 * stop on east (1, 7), one step from the way back. */
function crossAndWander(world: BoundGameWorld): void {
  walkTo(world, RIGHT, "east", 0, 6);
  for (let frame = 0; ; frame++) {
    const wander = world.probes().state.chars.chars["e-wander"];
    if (wander && (wander.tx !== 4 || wander.ty !== 3) && !wander.moving) break;
    expect(frame).toBeLessThan(600);
    step(world);
  }
  walkTo(world, RIGHT, "east", 1, 6);
  walkTo(world, DOWN, "east", 1, 7);
}

async function golden(name: string, viewport: Viewport, frame: Uint8Array): Promise<void> {
  const url = new URL(`./goldens/world-preview.${name}.${viewport.width}x${viewport.height}.png`, import.meta.url);
  if (process.env.WORLD_PREVIEW_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(frame, viewport.width, viewport.height));
  }
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect({ width: expected.width, height: expected.height }).toEqual(viewport);
  expect(frame.findIndex((value, index) => value !== expected.rgba[index])).toBe(-1);
}

simDescribe("world renderer neighbour preview", () => {
  for (const viewport of VIEWPORTS) {
    const size = `${viewport.width}x${viewport.height}`;

    test(`${size}: paints the map-entry snapshot of every visible neighbour`, async () => {
      const world = await boot(viewport);
      step(world);
      const stats = lastPreview();
      expect(stats).toMatchObject({
        activeMapId: "west",
        maps: ["east", "north", "south"],
        unavailable: [],
        actors: INITIAL_ACTORS,
        painted: 8,
        behind: 1,
        front: 7,
        frozen: null,
        rejected: 3,
        hidden: 3,
      });
      expect(stats.reasons["facing-condition"]).toBe(1);
      expect(stats.reasons["entry-state-write"]).toBe(1);
      expect(stats.reasons["entry-actor-command"]).toBe(1);
      const frame = world.render().slice();
      const at = (tile: [number, number], dx?: number, dy?: number) => tilePixel(world, frame, viewport, tile, dx, dy);
      // Authored cell, page facing (the walker's "left" frame) and sprite.
      expect(at(east(2, 6))).toEqual([...FACER_LEFT]);
      expect(at(east(4, 3))).toEqual([...COLOURS.wander]);
      expect(at(east(5, 9))).toEqual([...COLOURS.removed]);
      // Switch-off page, entry-written switch and facing condition: nothing.
      expect(at(east(3, 9))).toEqual([...ground("east")]);
      expect(at(east(1, 3))).toEqual([...ground("east")]);
      expect(at(east(1, 8))).toEqual([...ground("east")]);
      // Within one band, world (y, x) depth orders overlapping previews.
      expect(at(east(8, 2))).toEqual([...COLOURS.atall]);
      expect(at(east(8, 3))).toEqual([...COLOURS.atall]);
      expect(at(east(8, 1))).toEqual([...ground("east")]);
      // The neighbour's upper band covers its previewed character.
      expect(at(east(6, 6))).toEqual([...upper("east")]);
      // South's 32px character overflows into west's last row and is drawn
      // in front of the active-map character standing there (larger y).
      expect(at(south(5, 0))).toEqual([...COLOURS.tall]);
      expect(at(south(5, -1), 8, 4)).toEqual([...COLOURS.tall]);
      expect(at(south(5, -2), 8, 8)).toEqual([...ground("west")]);
      // North's character sits above the active map, so the active 32px
      // character overflowing into north's last row is drawn in front of it.
      expect(at(north(5, MAP_H - 1))).toEqual([...COLOURS.wtall]);
      expect(at(north(5, MAP_H))).toEqual([...COLOURS.wtall]);
      expect(at(north(4, MAP_H - 1))).toEqual([...ground("north")]);
      expect(probe().actors?.mapId).toBe("west");
      // The active player is unaffected.
      expect(at([17, 6])).toEqual([...PLAYER_COLOUR]);
      await golden("start", viewport, frame);
    });

    test(`${size}: dynamic create and remove follow durable state before entry`, async () => {
      const world = await boot(viewport);
      step(world, 0, 30);
      expect(world.probes().state.sw.switches["gate.on"]).toBe(true);
      expect(lastPreview().actors).toEqual(GATED_ACTORS);
      const frame = world.render().slice();
      expect(tilePixel(world, frame, viewport, east(3, 9))).toEqual([...COLOURS.gated]);
      expect(tilePixel(world, frame, viewport, east(5, 9))).toEqual([...ground("east")]);
      expect(countColour(frame, COLOURS.removed)).toBe(0);
      expect(countColour(frame, COLOURS.gated)).toBe(256);
    });

    test(`${size}: a seamless handoff swaps the preview for live characters without a duplicate or gap`, async () => {
      const world = await boot(viewport);
      step(world, 0, 30);
      let frames = 0;
      let commitFrame = -1;
      const observe = (label: string, live: boolean): void => {
        const frame = world.render().slice();
        const state = world.probes().state;
        // One sprite each, at its authored cell, on every frame.
        expect(countColour(frame, FACER_LEFT), `${label} static`).toBe(256);
        expect(countColour(frame, COLOURS.gated), `${label} gated`).toBe(256);
        expect(countColour(frame, COLOURS.wander), `${label} wanderer`).toBe(256);
        expect(tilePixel(world, frame, viewport, east(2, 6)), `${label} static cell`).toEqual([...FACER_LEFT]);
        expect(tilePixel(world, frame, viewport, east(3, 9)), `${label} gated cell`).toEqual([...COLOURS.gated]);
        if (!live) {
          // Until the commit frame the wanderer is the static snapshot.
          expect(tilePixel(world, frame, viewport, east(4, 3)), `${label} wanderer cell`).toEqual([...COLOURS.wander]);
          // The target's programs have not run.
          expect(Object.hasOwn(state.sw.variables, "east.ran"), `${label} east.ran`).toBe(false);
          expect(countColour(frame, COLOURS.rejected), `${label} rejected`).toBe(0);
        }
      };
      while (world.probes().state.mapId === "west") {
        observe(`frame ${frames}`, false);
        step(world, RIGHT);
        frames++;
        expect(frames).toBeLessThan(120);
      }
      commitFrame = frames;
      const committed = world.probes().state;
      expect(committed.move).toMatchObject({ tx: 0, ty: 6 });
      expect(Object.keys(committed.chars.chars)).toHaveLength(0);
      // The commit frame paints east from the actor pool's entry fallback,
      // and the preview layer has already dropped east.
      expect(lastPreview().activeMapId).toBe("east");
      expect(lastPreview().actors.filter((id) => id.startsWith("east/"))).toEqual([]);
      expect(probe().actors?.mapId).toBe("east");
      observe("commit", false);
      for (let after = 1; after <= 3; after++) {
        step(world);
        observe(`commit+${after}`, true);
      }
      const live = world.probes().state;
      expect(live.chars.chars["e-static"]).toMatchObject({ tx: 2, ty: 6, facing: 1, pageIndex: 0 });
      expect(live.chars.chars["e-gated"]).toMatchObject({ tx: 3, ty: 9, pageIndex: 1 });
      // The rejected character appears only after its writer ran on east.
      expect(live.sw.variables["east.ran"]).toBe(1);
      expect(countColour(world.render().slice(), COLOURS.rejected)).toBe(256);
      expect(commitFrame).toBeGreaterThan(0);
    });

    test(`${size}: the map just left keeps its characters where they were until re-entry`, async () => {
      const world = await boot(viewport);
      crossAndWander(world);
      const authored: [number, number] = [(MAP_W + 4) * TILE, 3 * TILE];
      // Step back across the seam, checking every presented frame: one
      // wanderer, painted where the reducer has it, and no jump at commit.
      let previous: [number, number] | undefined;
      let frozenAt: [number, number] | undefined;
      // e-ghost is drawn half transparent by the live actor pool; the frozen
      // snapshot must paint exactly the same blended pixels.
      let ghostLive: number[] | undefined;
      for (let after = 0; after < 12;) {
        const frame = world.render().slice();
        const state = world.probes().state;
        const ghost = tilePixel(world, frame, viewport, east(10, 10));
        expect(ghost).not.toEqual([...ground("east")]);
        expect(ghost).not.toEqual([...COLOURS.ghost]);
        if (state.mapId === "east") ghostLive = ghost;
        else expect(ghost, `frozen ghost commit+${after}`).toEqual(ghostLive!);
        expect(countColour(frame, COLOURS.wander), `${state.mapId} wanderer`).toBe(256);
        expect(countColour(frame, FACER_LEFT), `${state.mapId} static`).toBe(256);
        const pos = spriteWorldPos(world, viewport, frame, COLOURS.wander);
        if (state.mapId === "east") {
          const live = state.chars.chars["e-wander"]!;
          expect(pos).toEqual([MAP_W * TILE + live.px, live.py]);
        } else {
          expect(state.leftMap?.mapId).toBe("east");
          expect(lastPreview().frozen).toBe("east");
          const frozen = state.leftMap!.actors.find((actor) => actor.eventId === "e-wander")!;
          expect(pos).toEqual([MAP_W * TILE + frozen.px, frozen.py]);
          if (frozenAt === undefined) {
            // The commit frame: at most one reference tick of motion away
            // from the last live frame.
            frozenAt = pos;
            expect(Math.abs(pos[0] - previous![0]) + Math.abs(pos[1] - previous![1])).toBeLessThanOrEqual(2);
          } else {
            expect(pos, `commit+${after}`).toEqual(frozenAt);
          }
          after++;
        }
        previous = pos;
        step(world, frozenAt === undefined ? LEFT : 0);
      }
      // The entry preview would have put it back on its authored cell.
      expect(frozenAt).not.toEqual(authored);

      // Re-enter east: the frozen snapshot hands over to the entry
      // characters in one frame, with the expected jump back to the
      // authored cell, and never a second or a missing wanderer.
      walkTo(world, LEFT, "west", MAP_W - 2, 7);
      walkTo(world, UP, "west", MAP_W - 2, 6);
      let reentered = -1;
      for (let index = 0; reentered < 0 || index <= reentered + 3; index++) {
        const frame = world.render().slice();
        const state = world.probes().state;
        expect(countColour(frame, COLOURS.wander), `re-entry frame ${index}`).toBe(256);
        expect(countColour(frame, FACER_LEFT), `re-entry frame ${index}`).toBe(256);
        const pos = spriteWorldPos(world, viewport, frame, COLOURS.wander);
        if (state.mapId === "west") {
          expect(pos).toEqual(frozenAt!);
        } else {
          if (reentered < 0) {
            reentered = index;
            expect(Object.keys(state.chars.chars)).toHaveLength(0);
            expect(pos).toEqual(authored);
            expect(state.leftMap?.mapId).toBe("west");
            expect(lastPreview().frozen).toBe("west");
            expect(lastPreview().actors.some((id) => id.startsWith("east/"))).toBe(false);
          } else {
            const live = state.chars.chars["e-wander"]!;
            expect(pos).toEqual([MAP_W * TILE + live.px, live.py]);
          }
        }
        step(world, reentered < 0 ? RIGHT : 0);
        expect(index).toBeLessThan(120);
      }
    });
  }

  test("save, load, an older save and a rewind agree on the frozen map", async () => {
    const viewport = VIEWPORTS[0]!;
    const world = await boot(viewport);
    crossAndWander(world);
    walkTo(world, LEFT, "west", MAP_W - 1, 7);
    step(world, 0, 2);
    const left = world.probes().state.leftMap!;
    probe().queue.push("save");
    step(world);
    const saved = world.render().slice();
    expect(lastPreview().frozen).toBe("east");
    // Walk away (still within the ring) and come back by loading.
    walkTo(world, LEFT, "west", MAP_W - 3, 7);
    probe().queue.push("load");
    step(world);
    expect(probe().error).toBeNull();
    expect(world.probes().state.leftMap).toEqual(left);
    expect(world.render().slice()).toEqual(saved);
    walkTo(world, LEFT, "west", MAP_W - 3, 7);
    probe().queue.push("rewind");
    step(world);
    expect(world.probes().state.leftMap).toBe(left);
    expect(world.render().slice()).toEqual(saved);
    // A save without the snapshot loads without error and shows east's
    // map-entry preview: the wanderer back on its authored cell.
    probe().queue.push("load-older");
    step(world);
    expect(probe().error).toBeNull();
    expect(world.probes().state.leftMap).toBeUndefined();
    expect(lastPreview().frozen).toBeNull();
    const older = world.render().slice();
    expect(countColour(older, COLOURS.wander)).toBe(256);
    expect(spriteWorldPos(world, viewport, older, COLOURS.wander)).toEqual([(MAP_W + 4) * TILE, 3 * TILE]);
  });

  test("save, load and a rewound reducer state repaint the preview from the restored state", async () => {
    const viewport = VIEWPORTS[0]!;
    const world = await boot(viewport);
    step(world);
    probe().queue.push("save");
    step(world);
    expect(lastPreview().actors).toEqual(INITIAL_ACTORS);
    step(world, 0, 30);
    expect(lastPreview().actors).toEqual(GATED_ACTORS);
    const gatedFrame = world.render().slice();

    probe().queue.push("load");
    step(world);
    expect(probe().error).toBeNull();
    expect(world.probes().state.sw.switches["gate.on"]).toBeUndefined();
    expect(lastPreview().actors).toEqual(INITIAL_ACTORS);
    let frame = world.render().slice();
    expect(tilePixel(world, frame, viewport, east(5, 9))).toEqual([...COLOURS.removed]);
    expect(countColour(frame, COLOURS.gated)).toBe(0);

    step(world, 0, 30);
    expect(lastPreview().actors).toEqual(GATED_ACTORS);
    expect(world.render().slice()).toEqual(gatedFrame);

    probe().queue.push("rewind");
    step(world);
    expect(lastPreview().actors).toEqual(INITIAL_ACTORS);
    frame = world.render().slice();
    expect(tilePixel(world, frame, viewport, east(5, 9))).toEqual([...COLOURS.removed]);
    expect(countColour(frame, COLOURS.gated)).toBe(0);
  });

  test("20, 30 and 60 Hz present identical frames at the same reference tick", async () => {
    const viewport = VIEWPORTS[0]!;
    // Reference ticks (60 Hz) at which every rate presents a frame: before
    // the dynamic switch, after it, mid-walk, and after the handoff.
    const samples = [6, 60, 72, 96, 120];
    const walkFrom = 60;
    const runs: { hz: number; frames: Uint8Array[]; maps: string[]; frozen: (string | null)[] }[] = [];
    for (const hz of [20, 30, 60]) {
      const world = await boot(viewport, hz);
      const perFrame = 60 / hz;
      const frames: Uint8Array[] = [];
      const maps: string[] = [];
      const frozen: (string | null)[] = [];
      for (let tick = perFrame; tick <= samples.at(-1)!; tick += perFrame) {
        step(world, tick > walkFrom ? RIGHT : 0);
        if (samples.includes(tick)) {
          frames.push(world.render().slice());
          maps.push(world.probes().state.mapId);
          frozen.push(lastPreview().frozen);
        }
      }
      runs.push({ hz, frames, maps, frozen });
    }
    expect(runs[2]!.maps).toEqual(["west", "west", "west", "east", "east"]);
    // After the handoff west is painted from its frozen snapshot.
    expect(runs[2]!.frozen).toEqual([null, null, null, "west", "west"]);
    for (const run of runs) {
      expect(run.maps, `${run.hz} Hz`).toEqual(runs[2]!.maps);
      expect(run.frozen, `${run.hz} Hz`).toEqual(runs[2]!.frozen);
      run.frames.forEach((frame, index) => {
        const reference = runs[2]!.frames[index]!;
        expect(frame.findIndex((value, offset) => value !== reference[offset]), `${run.hz} Hz sample ${index}`).toBe(-1);
      });
    }
  });

  test("a legacy zero-fade transfer presents the same first frame as before the preview", async () => {
    const viewport = VIEWPORTS[0]!;
    const world = await boot(viewport, 60, "legacy");
    let frames = 0;
    while (world.probes().state.mapId === "west") {
      step(world, RIGHT);
      expect(++frames).toBeLessThan(120);
    }
    // The ordinary transfer entered east on this frame; page sync has not
    // created its characters yet.
    expect(world.probes().state.handoff).toBeUndefined();
    expect(world.probes().state.leftMap).toBeUndefined();
    expect(Object.keys(world.probes().state.chars.chars)).toHaveLength(0);
    const first = world.render().slice();
    // The not-yet-spawned walkers authored left, up and right are drawn in
    // the down pose at their authored cells, exactly as before; the golden
    // was recorded from the base branch's GameView.
    expect(countColour(first, FACER_COLOURS[0]!)).toBe(3 * 256);
    for (const facing of [1, 2, 3]) expect(countColour(first, FACER_COLOURS[facing]!)).toBe(0);
    await golden("legacy-entry", viewport, first);
    // One frame later the characters exist and face their page direction.
    step(world);
    const next = world.render().slice();
    expect(countColour(next, FACER_COLOURS[0]!)).toBe(0);
    for (const facing of [1, 2, 3]) expect(countColour(next, FACER_COLOURS[facing]!)).toBe(256);
  });

  test("an opted-out renderer and the legacy view paint no neighbour characters", async () => {
    const viewport = VIEWPORTS[0]!;
    const shown = await boot(viewport);
    step(shown);
    const previewFrame = shown.render().slice();
    const painted = lastPreview();

    const off = await boot(viewport, 60, "off");
    step(off);
    expect(probe().previews).toEqual([]);
    const offFrame = off.render().slice();
    // The only differences are the preview sprites' own pixels.
    const camera = off.probes().camera;
    const rects = painted.actors.map((id) => {
      const [map, event] = id.split("/") as [string, string];
      const tile = map === "south" ? south(5, 0) : map === "north" ? north(5, MAP_H - 1)
        : event === "e-a-tall" ? east(8, 3) : event === "e-z-short" ? east(8, 2)
        : event === "e-static" ? east(2, 6)
        : event === "e-wander" ? east(4, 3) : event === "e-removed" ? east(5, 9) : east(6, 6);
      const height = event === "s-tall" || event === "e-a-tall" ? 32 : 16;
      return { x: tile[0] * TILE - camera.x, y: tile[1] * TILE + TILE - height - camera.y, w: TILE, h: height };
    });
    let differing = 0;
    for (let y = 0; y < viewport.height; y++) {
      for (let x = 0; x < viewport.width; x++) {
        const offset = (y * viewport.width + x) * 4;
        let same = true;
        for (let channel = 0; channel < 4; channel++) {
          if (previewFrame[offset + channel] !== offFrame[offset + channel]) same = false;
        }
        if (same) continue;
        differing++;
        const inside = rects.some((rect) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
        if (!inside) throw new Error(`unexpected difference at (${x}, ${y})`);
      }
    }
    // Three visible 16px east sprites plus the 32px south and east ones;
    // e-under is under the upper band, n-row under the active 32px
    // character and e-z-short under e-a-tall.
    expect(differing).toBe(3 * 256 + 2 * 256 + 2 * 256);
    expect(tilePixel(off, offFrame, viewport, east(2, 6))).toEqual([...ground("east")]);

    const legacy = await boot(viewport, 60, "legacy");
    step(legacy);
    expect(probe().previews).toEqual([]);
    const legacyFrame = legacy.render().slice();
    expect(countColour(legacyFrame, FACER_LEFT)).toBe(0);
    expect(countColour(legacyFrame, COLOURS.tall)).toBe(0);
  });
});
