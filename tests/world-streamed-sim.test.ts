// Component-world rendering proof: signed placement origins, seams, world
// plane ordering, viewport-bounded pools and deterministic full-frame pixels.

import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import type { WorldStreamedTerrainStats } from "../src/ui/WorldStreamedTerrain.tsx";
import {
  ABOVE_ANIM_COLOUR,
  BELOW_ANIM_COLOUR,
  MAPS,
  PLAYER_COLOUR,
  type Rgba,
} from "./fixtures/world-streamed/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";
import type {
  WorldStreamedTileLoads,
  WorldStreamedTransitionApi,
} from "./fixtures/world-streamed/world-streamed.tsx";

const preflight = appPreflight("world-streamed");
if (!preflight.ok) console.warn(`world-streamed sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface FixtureStats {
  ground?: WorldStreamedTerrainStats;
  upper?: WorldStreamedTerrainStats;
  below?: { mounted: number; created: number; pooled: number };
  above?: { mounted: number; created: number; pooled: number };
  worldView: { mounts: number; unmounts: number };
}
interface Viewport {
  width: number;
  height: number;
}

interface Shot {
  name: "horizontal" | "vertical" | "negative-origin" | "four-corner" | "small-edge";
  camera: (viewport: Viewport) => { x: number; y: number };
}

const SHOTS: readonly Shot[] = [
  { name: "horizontal", camera: ({ width, height }) => ({ x: -width / 2, y: -320 - height / 2 }) },
  { name: "vertical", camera: ({ width, height }) => ({ x: -512 - width / 2, y: -height / 2 }) },
  { name: "negative-origin", camera: () => ({ x: -1024, y: -640 }) },
  { name: "four-corner", camera: ({ width, height }) => ({ x: -width / 2, y: -height / 2 }) },
  { name: "small-edge", camera: ({ width, height }) => ({ x: 1280 - width, y: 320 - height / 2 }) },
];

const rgbaAt = (frame: Uint8Array, width: number, x: number, y: number): number[] => {
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
  return [...frame.subarray(offset, offset + 4)];
};

const expectPixel = (
  frame: Uint8Array,
  viewport: Viewport,
  x: number,
  y: number,
  colour: Rgba,
): void => {
  expect(rgbaAt(frame, viewport.width, x, y)).toEqual([...colour]);
};

const screenPoint = (camera: { x: number; y: number }, worldX: number, worldY: number) => ({
  x: worldX - camera.x,
  y: worldY - camera.y,
});

async function golden(name: string, viewport: Viewport, frame: Uint8Array): Promise<void> {
  const size = `${viewport.width}x${viewport.height}`;
  const url = new URL(`./goldens/world-streamed.${name}.${size}.png`, import.meta.url);
  if (process.env.WORLD_STREAMED_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(frame, viewport.width, viewport.height));
  }
  const expected = decodePng(new Uint8Array(await Bun.file(url).arrayBuffer()));
  expect({ width: expected.width, height: expected.height }).toEqual(viewport);
  expect(frame).toEqual(expected.rgba);
}

const fixtureStats = (): FixtureStats =>
  structuredClone(
    (globalThis as { __worldStreamedStats?: FixtureStats }).__worldStreamedStats ??
      { worldView: { mounts: 0, unmounts: 0 } },
  );

const tileLoads = (): WorldStreamedTileLoads =>
  structuredClone(
    (globalThis as { __worldStreamedTileLoads?: WorldStreamedTileLoads }).__worldStreamedTileLoads ??
      { ground: 0, upper: 0 },
  );

const preFrameCleanupReads = (): number | undefined =>
  (globalThis as { __worldStreamedPreFrameCleanupReads?: number })
    .__worldStreamedPreFrameCleanupReads;

function expectSolidRow(
  frame: Uint8Array,
  viewport: Viewport,
  y: number,
  colour: Rgba,
): void {
  const row = Math.floor(y);
  expect(row).toBeGreaterThanOrEqual(0);
  expect(row).toBeLessThan(viewport.height);
  for (let x = 0; x < viewport.width; x++) {
    const offset = (row * viewport.width + x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      if (frame[offset + channel] !== colour[channel]) {
        throw new Error(
          `expected solid ${colour.join(",")} row at (${x}, ${row}), got ` +
          [...frame.subarray(offset, offset + 4)].join(","),
        );
      }
    }
  }
}

function expectSolidColumn(
  frame: Uint8Array,
  viewport: Viewport,
  x: number,
  colour: Rgba,
): void {
  const column = Math.floor(x);
  expect(column).toBeGreaterThanOrEqual(0);
  expect(column).toBeLessThan(viewport.width);
  for (let y = 0; y < viewport.height; y++) {
    const offset = (y * viewport.width + column) * 4;
    for (let channel = 0; channel < 4; channel++) {
      if (frame[offset + channel] !== colour[channel]) {
        throw new Error(
          `expected solid ${colour.join(",")} column at (${column}, ${y}), got ` +
          [...frame.subarray(offset, offset + 4)].join(","),
        );
      }
    }
  }
}

const map = (id: string) => MAPS.find((entry) => entry.id === id)!;

const transitionApi = (): WorldStreamedTransitionApi => {
  const api = globalThis.__worldStreamedTransition;
  if (!api) throw new Error("world-streamed transition fixture did not mount");
  return api;
};

const step = (world: BoundGameWorld): void => {
  world.frame(0, 0x8080);
  world.tick();
};

async function bootTransitionWorld(
  viewport: Viewport,
  initialMap?: string,
  legacy = false,
): Promise<BoundGameWorld> {
  return bootGameWorld(
    appBundle("world-streamed"),
    60,
    {
      __worldStreamedCamera: undefined,
      __worldStreamedInitialMap: initialMap,
      __worldStreamedLegacy: legacy,
    },
    undefined,
    viewport,
  );
}

async function legacyFrame(viewport: Viewport, mapId: string): Promise<Uint8Array> {
  const world = await bootTransitionWorld(viewport, mapId, true);
  step(world);
  return world.render().slice();
}

function expectSameFrame(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(actual.findIndex((value, index) => value !== expected[index])).toBe(-1);
}

function transition(world: BoundGameWorld, ...mapIds: string[]): void {
  transitionApi().transition(...mapIds);
  step(world);
  expect(transitionApi().error).toBeNull();
}

function assertUnplacedOutdoorPixels(frame: Uint8Array, viewport: Viewport): void {
  const colour = map("unplaced-field").ground;
  expectPixel(frame, viewport, 8, 8, colour);
  expectPixel(frame, viewport, viewport.width / 2, viewport.height / 2, colour);
  expectPixel(frame, viewport, viewport.width - 8, viewport.height - 8, colour);
}

function assertIndoorPixels(frame: Uint8Array, viewport: Viewport): void {
  const originX = (viewport.width - map("indoor-room").width * 16) / 2;
  const originY = (viewport.height - map("indoor-room").height * 16) / 2;
  expectPixel(frame, viewport, 0, 0, [0, 0, 0, 255]);
  expectPixel(frame, viewport, originX - 1, originY + 8, [0, 0, 0, 255]);
  expectPixel(frame, viewport, originX + 8, originY + 8, map("indoor-room").ground);
  expectPixel(frame, viewport, originX + 4 * 16 + 8, originY + 4 * 16 + 8, BELOW_ANIM_COLOUR);
  expectPixel(frame, viewport, originX + 5 * 16 + 8, originY + 4 * 16 + 8, ABOVE_ANIM_COLOUR);
  expectPixel(
    frame,
    viewport,
    viewport.width / 2,
    viewport.height / 2,
    map("indoor-room").ground,
  );
  expectPixel(
    frame,
    viewport,
    originX + map("indoor-room").width * 16,
    originY + 8,
    [0, 0, 0, 255],
  );
  expectPixel(frame, viewport, viewport.width - 1, viewport.height - 1, [0, 0, 0, 255]);
}

function assertPlacedNortheastPixels(frame: Uint8Array, viewport: Viewport): void {
  expectPixel(
    frame,
    viewport,
    viewport.width / 2 + 48,
    viewport.height / 2,
    map("b-northeast").ground,
  );
}

function assertShotPixels(
  name: Shot["name"],
  frame: Uint8Array,
  viewport: Viewport,
  camera: { x: number; y: number },
): void {
  const at = (worldX: number, worldY: number, colour: Rgba): void => {
    const point = screenPoint(camera, worldX, worldY);
    expectPixel(frame, viewport, point.x, point.y, colour);
  };
  if (name === "horizontal") {
    at(-8, -320, map("a-northwest").ground);
    at(8, -320, map("b-northeast").ground);
  } else if (name === "vertical") {
    at(-512, -8, map("a-northwest").ground);
    at(-512, 8, map("c-southwest").ground);
  } else if (name === "negative-origin") {
    expectPixel(frame, viewport, 8, 8, map("a-northwest").ground);
  } else if (name === "four-corner") {
    // The four authored upper markers meet with no crack or overlap.
    at(-8, -8, map("a-northwest").upper);
    at(8, -8, map("b-northeast").upper);
    at(-8, 8, map("c-southwest").upper);
    at(8, 8, map("d-southeast").upper);
    // Ground -> player -> upper is observable on one active-map tile.
    at(-28, -24, PLAYER_COLOUR);
    at(-20, -24, map("a-northwest").upper);
    at(-40, -24, map("a-northwest").ground);
    // Both animation bands use placement-qualified coordinates on all four maps.
    for (const [worldX, worldY] of [[-72, -56], [56, -56], [-72, 56], [56, 56]] as const) {
      at(worldX, worldY, BELOW_ANIM_COLOUR);
    }
    for (const [worldX, worldY] of [[-56, -56], [72, -56], [-56, 56], [72, 56]] as const) {
      at(worldX, worldY, ABOVE_ANIM_COLOUR);
    }
  } else {
    at(1016, 320, map("d-southeast").ground);
    at(1152, 320, map("e-small").ground);
    at(1048, 312, map("e-small").upper);
    // The unplaced world area above the small edge map remains transparent,
    // revealing the black frame instead of stretching its terrain.
    at(1152, 224, [0, 0, 0, 255]);
  }
}

for (const viewport of [{ width: 480, height: 272 }, { width: 960, height: 544 }] as const) {
  simDescribe(`connected world renderer ${viewport.width}x${viewport.height}`, () => {
    test("renders signed seams, the four-map corner and the small component edge", async () => {
      const debugCamera = { ...SHOTS[0]!.camera(viewport) };
      const world = await bootGameWorld(
        appBundle("world-streamed"),
        60,
        { __worldStreamedCamera: debugCamera },
        undefined,
        viewport,
      );
      expect(preFrameCleanupReads()).toBe(0);
      const advance = (): void => step(world);
      advance();

      for (const shot of SHOTS) {
        Object.assign(debugCamera, shot.camera(viewport));
        advance();
        expect(world.probes().camera).toMatchObject(debugCamera);
        const frame = world.render().slice();
        assertShotPixels(shot.name, frame, viewport, debugCamera);
        await golden(shot.name, viewport, frame);
      }
    }, 60_000);

    test("one-pixel seam scrolling on both axes never clears or grows the warmed pools", async () => {
      const debugCamera = { x: -viewport.width / 2 - 32, y: -320 - viewport.height / 2 };
      const world = await bootGameWorld(
        appBundle("world-streamed"),
        60,
        { __worldStreamedCamera: debugCamera },
        undefined,
        viewport,
      );
      const advance = (): void => step(world);
      advance();
      debugCamera.x = -viewport.width / 2 + 32;
      advance();
      debugCamera.x = -viewport.width / 2 - 32;
      advance();
      const warmGround = fixtureStats().ground!;
      const warmUpper = fixtureStats().upper!;

      for (let delta = -32; delta <= 32; delta++) {
        debugCamera.x = -viewport.width / 2 + delta;
        advance();
        const frame = world.render();
        const seamX = -debugCamera.x;
        expectSolidColumn(frame, viewport, seamX - 1, map("a-northwest").ground);
        expectSolidColumn(frame, viewport, seamX, map("b-northeast").ground);
        const stats = fixtureStats();
        expect(stats.ground).toMatchObject({
          created: warmGround.created,
          uploads: warmGround.uploads,
          frees: warmGround.frees,
          pending: 0,
        });
        expect(stats.upper).toMatchObject({
          created: warmUpper.created,
          uploads: warmUpper.uploads,
          frees: warmUpper.frees,
          pending: 0,
        });
        expect(stats.ground!.resident).toBeGreaterThan(0);
        expect(stats.ground!.textures).toBeGreaterThan(0);
        expect(stats.ground!.visibleMaps).toEqual(["a-northwest", "b-northeast"]);
      }

      debugCamera.x = -512 - viewport.width / 2;
      debugCamera.y = -viewport.height / 2 - 32;
      advance();
      debugCamera.y = -viewport.height / 2 + 32;
      advance();
      debugCamera.y = -viewport.height / 2 - 32;
      advance();
      const warmVerticalGround = fixtureStats().ground!;
      const warmVerticalUpper = fixtureStats().upper!;

      for (let delta = -32; delta <= 32; delta++) {
        debugCamera.y = -viewport.height / 2 + delta;
        advance();
        const frame = world.render();
        const seamY = -debugCamera.y;
        expectSolidRow(frame, viewport, seamY - 1, map("a-northwest").ground);
        expectSolidRow(frame, viewport, seamY, map("c-southwest").ground);
        const stats = fixtureStats();
        expect(stats.ground).toMatchObject({
          created: warmVerticalGround.created,
          uploads: warmVerticalGround.uploads,
          frees: warmVerticalGround.frees,
          pending: 0,
        });
        expect(stats.upper).toMatchObject({
          created: warmVerticalUpper.created,
          uploads: warmVerticalUpper.uploads,
          frees: warmVerticalUpper.frees,
          pending: 0,
        });
        expect(stats.ground!.resident).toBeGreaterThan(0);
        expect(stats.ground!.textures).toBeGreaterThan(0);
        expect(stats.ground!.visibleMaps).toEqual(["a-northwest", "c-southwest"]);
      }
    }, 60_000);

    test("placed to an unplaced outdoor map matches the legacy frame", async () => {
      const world = await bootTransitionWorld(viewport);
      step(world);
      expect(fixtureStats().worldView).toEqual({ mounts: 1, unmounts: 0 });
      transition(world, "unplaced-field");
      expect(world.probes().state.mapId).toBe("unplaced-field");
      expect(transitionApi().loads).toBe(1);
      const frame = world.render().slice();
      const lifecycle = fixtureStats().worldView;
      assertUnplacedOutdoorPixels(frame, viewport);
      expectSameFrame(frame, await legacyFrame(viewport, "unplaced-field"));
      expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
    }, 60_000);

    test("placed to an indoor map matches the centered legacy frame", async () => {
      const world = await bootTransitionWorld(viewport);
      step(world);
      expect(fixtureStats().worldView).toEqual({ mounts: 1, unmounts: 0 });
      transition(world, "indoor-room");
      expect(world.probes().state.mapId).toBe("indoor-room");
      expect(transitionApi().loads).toBe(1);
      const frame = world.render().slice();
      const lifecycle = fixtureStats().worldView;
      assertIndoorPixels(frame, viewport);
      await golden("transition-indoor", viewport, frame);
      expectSameFrame(frame, await legacyFrame(viewport, "indoor-room"));
      expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
    }, 60_000);

    test("an unplaced map can return to a placed component", async () => {
      const world = await bootTransitionWorld(viewport, "unplaced-field");
      step(world);
      expect(world.probes().state.mapId).toBe("unplaced-field");
      expect(fixtureStats().worldView).toEqual({ mounts: 1, unmounts: 0 });
      assertUnplacedOutdoorPixels(world.render(), viewport);
      transition(world, "b-northeast");
      expect(world.probes().state.mapId).toBe("b-northeast");
      expect(transitionApi().loads).toBe(2);
      expect(fixtureStats().worldView).toEqual({ mounts: 1, unmounts: 0 });
      assertPlacedNortheastPixels(world.render(), viewport);
    }, 60_000);

    test("two save-backed replacements in one host frame paint the final placed map", async () => {
      const world = await bootTransitionWorld(viewport);
      step(world);
      expect(fixtureStats().worldView).toEqual({ mounts: 1, unmounts: 0 });
      transition(world, "indoor-room", "b-northeast");
      expect(world.probes().state.mapId).toBe("b-northeast");
      expect(transitionApi().loads).toBe(2);
      expect(fixtureStats().worldView).toEqual({ mounts: 1, unmounts: 0 });
      assertPlacedNortheastPixels(world.render(), viewport);
    }, 60_000);

    test("a save restored directly into an indoor map matches the legacy frame", async () => {
      const world = await bootTransitionWorld(viewport, "indoor-room");
      step(world);
      expect(world.probes().state.mapId).toBe("indoor-room");
      expect(transitionApi().loads).toBe(1);
      expect(fixtureStats().worldView).toEqual({ mounts: 1, unmounts: 0 });
      const frame = world.render().slice();
      assertIndoorPixels(frame, viewport);
      await golden("transition-indoor", viewport, frame);
      expectSameFrame(frame, await legacyFrame(viewport, "indoor-room"));
    }, 60_000);
  });
}

simDescribe("connected world upper-row resources", () => {
  test("shares one uploaded handle across viewport-bounded row slices", async () => {
    const viewport = { width: 480, height: 272 } as const;
    const camera = SHOTS.find((shot) => shot.name === "four-corner")!.camera(viewport);
    const world = await bootGameWorld(
      appBundle("world-streamed"),
      60,
      { __worldStreamedCamera: camera },
      undefined,
      viewport,
    );
    step(world);
    const upper = fixtureStats().upper!;
    const loads = tileLoads();
    expect(upper.pending).toBe(0);
    expect(upper.uploads).toBe(loads.upper);
    expect(upper.uploads).toBe(upper.textures);
    expect(upper.resident).toBe(upper.textures);
    expect(upper.textureBindings).toBeGreaterThan(upper.textures);
    expect(upper.sliceNodes).toBeGreaterThanOrEqual(upper.textureBindings!);
    expect(upper.rowNodes).toBeLessThanOrEqual(Math.ceil(viewport.height / 16) + 3);
    expect(upper.sliceNodes).toBeLessThanOrEqual(upper.rowNodes! * 4);
  });
});
