// tests/rpgkit-grow-render.test.ts — D6e settlement render budget.
//
// The shipped path repeats four build-baked 256x256 Ninja Adventure terrain
// fills and mounts 16x16 cells only at jagged biome seams or authored sparse
// overlays. The window follows the derived camera and unmounts cells behind
// it, so residency is a function of viewport size rather than the 4,096-
// column backing strip.
//
// The comparison path is computed from the same reducer: a 512x512 chunked
// renderer would upload every dirty ground/upper chunk as packed PSM_4444.
// It needs fewer scene nodes, but a single dirty layer costs 524,288 bytes.

// Both measurements use the built grow bundle or the exact reducer fold;
// they are executable acceptance limits rather than copied estimates.

import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { bootWorld } from "../vendor/pocketjs/hosts/sim/sim.ts";
import {
  createGrow,
  DEFAULT_PARAMS,
  stepGrowTick,
  tickEveryFrames,
  totalTicks,
  type GrowState,
} from "../examples/grow/grow.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";

// Without the built bundle/wasm these host tests cannot boot; register
// them as skips with the build command printed once.
const preflight = appPreflight("grow");
if (!preflight.ok) console.warn(`grow sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;

const COUNTED = [
  "createNode", "destroyNode", "insertBefore", "removeChild", "setStyle",
  "setProp", "setPropBatch", "setText", "replaceText", "setImage",
  "setSprite", "uploadTexture", "uploadImgEntry", "freeTexture",
] as const;
type Counts = Record<(typeof COUNTED)[number], number>;
const zero = (): Counts => Object.fromEntries(COUNTED.map((op) => [op, 0])) as Counts;
const sum = (c: Counts): number => COUNTED.reduce((n, op) => n + c[op], 0);
const structural = (c: Counts): number => c.createNode + c.destroyNode + c.insertBefore + c.removeChild;

interface GrowPub {
  mode: "grow" | "play";
  tick: number;
  total: number;
  auto: boolean;
  seed: number;
  hash: string;
  cameraX: number;
  frontierX: number;
  caravans?: number;
  mounted: number;
  visibleX0: number;
  visibleX1: number;
}

type World = {
  frame: (buttons: number) => void;
  tick: () => void;
  getTree: () => unknown;
};

interface WindowRun {
  cumulative: Counts;
  bootMounts: number;
  peakMounted: number;
  peakCreate: number;
  peakDestroy: number;
  peakStructural: number;
  structuralFrames: number;
  cameraOnlyFrames: number;
  final: GrowPub;
  tree: unknown;
  idle: Counts;
}

const published = (): GrowPub =>
  structuredClone((globalThis as { __rpgGrowState: GrowPub }).__rpgGrowState);

async function measureWindow(width: number, height: number): Promise<WindowRun> {
  const cumulative = zero();
  let frameCounts = zero();
  const world = (await bootWorld(
    appBundle("grow"),
    60,
    undefined,
    (ops) => {
      for (const op of COUNTED) {
        const fn = (ops as Record<string, unknown>)[op];
        if (typeof fn !== "function") continue;
        (ops as Record<string, unknown>)[op] = (...args: unknown[]) => {
          cumulative[op]++;
          frameCounts[op]++;
          return (fn as (...values: unknown[]) => unknown).apply(ops, args);
        };
      }
    },
    { width, height },
  )) as unknown as World;

  const frames = totalTicks(DEFAULT_PARAMS) * tickEveryFrames(DEFAULT_PARAMS, 60) + 24;
  let bootMounts = 0;
  let peakMounted = 0;
  let peakCreate = 0;
  let peakDestroy = 0;
  let peakStructural = 0;
  let structuralFrames = 0;
  let cameraOnlyFrames = 0;
  let previousCamera = 0;
  let previousTick = -1;
  for (let frame = 0; frame < frames; frame++) {
    frameCounts = zero();
    world.frame(0);
    world.tick();
    const pub = published();
    if (frame === 0) bootMounts = cumulative.createNode;
    peakMounted = Math.max(peakMounted, pub.mounted);
    peakCreate = Math.max(peakCreate, frameCounts.createNode);
    peakDestroy = Math.max(peakDestroy, frameCounts.destroyNode);
    peakStructural = Math.max(peakStructural, structural(frameCounts));
    if (structural(frameCounts) > 0) structuralFrames++;
    if (pub.cameraX !== previousCamera && pub.tick === previousTick && structural(frameCounts) === 0) {
      // Between cell-boundary crossings the entire scroll is one camera
      // property update. Growth deadlines can also replace HUD text.
      // The reducer's 480px camera can keep easing while a wide desktop
      // presentation is still clamped at x=0. In that case no visual prop
      // changes; once the presented camera moves it is one property update,
      // plus x and y for each trade caravan walking its route on screen.
      expect(frameCounts.setProp).toBeLessThanOrEqual(1 + 2 * (pub.caravans ?? 0));
      expect(frameCounts.createNode + frameCounts.destroyNode + frameCounts.setImage).toBe(0);
      cameraOnlyFrames++;
    }
    previousCamera = pub.cameraX;
    previousTick = pub.tick;
  }

  frameCounts = zero();
  world.frame(0);
  world.tick();
  const idle = { ...frameCounts };
  return {
    cumulative, bootMounts, peakMounted, peakCreate, peakDestroy,
    peakStructural, structuralFrames, cameraOnlyFrames,
    final: published(), tree: world.getTree(), idle,
  };
}

function countNames(tree: unknown, name: string): number {
  const json = JSON.stringify(tree);
  return (json.match(new RegExp(`\"n\":\"${name}\"`, "g")) ?? []).length;
}

function dirtyChunkCost(): {
  ticks: number;
  groundUploads: number;
  upperUploads: number;
  peakUploadsPerTick: number;
} {
  let state = createGrow(DEFAULT_PARAMS);
  let groundUploads = 0;
  let upperUploads = 0;
  let peakUploadsPerTick = 0;
  while (state.phase !== "done") {
    const before = state;
    const after = stepGrowTick(state);
    const groundChunks = new Set<number>();
    const upperChunks = new Set<number>();
    for (let i = 0; i < before.ground.length; i++) {
      const x = i % DEFAULT_PARAMS.width;
      if (before.ground[i] !== after.ground[i]) groundChunks.add(Math.floor(x / 32));
      if (before.upper[i] !== after.upper[i]) upperChunks.add(Math.floor(x / 32));
    }
    groundUploads += groundChunks.size;
    upperUploads += upperChunks.size;
    peakUploadsPerTick = Math.max(peakUploadsPerTick, groundChunks.size + upperChunks.size);
    state = after;
  }
  return { ticks: state.tick, groundUploads, upperUploads, peakUploadsPerTick };
}

simDescribe("D6e grow render: viewport-windowed sparse tiles", () => {
  test("480x272 residency stays bounded while old columns unmount", async () => {
    const run = await measureWindow(480, 272);
    if (process.env.GROW_METRICS) console.log("METRICS480", JSON.stringify({ ...run, tree: undefined }));
    // The causal world's camera rests where the director last panned: the
    // sand village, focus column 86 at 60 percent of the screen.
    expect(run.final).toMatchObject({
      tick: 240, cameraX: 1104, frontierX: 86, visibleX0: 68, visibleX1: 99,
    });
    expect(run.final.frontierX).toBeGreaterThanOrEqual(run.final.visibleX0);
    expect(run.final.frontierX).toBeLessThanOrEqual(run.final.visibleX1);
    expect(run.final.visibleX0).toBeGreaterThan(0);
    // Six repeated fill blocks cover this window; 62 seed-dependent
    // seam cells need individual terrain nodes.
    expect(countNames(run.tree, "rpgkit-grow-terrain-block")).toBe(6);
    expect(countNames(run.tree, "rpgkit-grow-terrain-seam")).toBe(62);
    // A worn-in village: trails, dirt and paved roads, fields and the stream
    // are ground cells; houses, stumps, saplings and the woods are upper.
    expect(countNames(run.tree, "rpgkit-grow-gcell")).toBe(243);
    expect(countNames(run.tree, "rpgkit-grow-ucell")).toBe(212);
    expect(countNames(run.tree, "rpgkit-grow-gvillager")).toBe(6);
    expect(run.final.mounted).toBe(529);
    expect(run.peakMounted).toBe(587);
    // Column zero left the window: destruction proves old cells are not
    // retained, and peak residency is below 650 rather than the tens of thousands of
    // nodes an unwindowed full backing strip would require.
    expect(run.cumulative.destroyNode).toBeGreaterThan(1_000);
    expect(run.peakMounted).toBeLessThan(650);
    // The director camera pans at most six columns a tick, so one frame
    // mounts at most about a column of both layers.
    expect(run.peakCreate).toBeLessThanOrEqual(60);
    expect(run.peakDestroy).toBeLessThanOrEqual(60);
    expect(run.peakStructural).toBeLessThanOrEqual(160);
    // Footfall repaints ground somewhere on most ticks; still, most frames
    // between ticks only move the camera.
    expect(run.structuralFrames).toBeLessThan(900);
    expect(run.cameraOnlyFrames).toBeGreaterThan(250);
    expect(run.cumulative.uploadTexture).toBe(0);
    expect(sum(run.idle)).toBe(0);
  });

  test("960x544 desktop viewport scales with the visible window, not world length", async () => {
    const run = await measureWindow(960, 544);
    if (process.env.GROW_METRICS) console.log("METRICS960", JSON.stringify({ ...run, tree: undefined }));
    // A 33-row field plus the 16px timeline fills 544px exactly. Sixty-two
    // columns include one-column overscan on each side; this window lines up
    // with four 256px fill-block columns (twelve blocks).
    expect(countNames(run.tree, "rpgkit-grow-terrain-block")).toBe(12);
    expect(countNames(run.tree, "rpgkit-grow-terrain-seam")).toBe(218);
    expect(run.final.mounted).toBe(1_454);
    expect(run.peakMounted).toBe(1_540);
    expect(run.cumulative.destroyNode).toBeGreaterThan(1_300);
    expect(run.peakMounted).toBeLessThan(1_600);
    expect(run.peakCreate).toBeLessThanOrEqual(80);
    expect(run.peakDestroy).toBeLessThanOrEqual(80);
    expect(run.peakStructural).toBeLessThanOrEqual(240);
    expect(run.cumulative.uploadTexture).toBe(0);
    expect(sum(run.idle)).toBe(0);
  });
});

simDescribe("D6e grow render: measured 512x512 chunk-rebake alternative", () => {
  test("dirty chunks would upload 478 MB during one default growth", () => {
    const cost = dirtyChunkCost();
    if (process.env.GROW_METRICS) console.log("CHUNKS", JSON.stringify(cost));
    // The causal world changes something in every village on most ticks
    // (footfall, logging, regrowth), so far more chunks go dirty than the
    // stamp rules' one-site-a-tick growth (113 + 40 over 156 ticks).
    expect(cost).toEqual({
      ticks: 240, groundUploads: 243, upperUploads: 669, peakUploadsPerTick: 8,
    });
    const bytesPerUpload = 512 * 512 * 2; // one packed PSM_4444 layer
    expect((cost.groundUploads + cost.upperUploads) * bytesPerUpload).toBe(478_150_656);
    // Sixteen terrain cells, sixteen ground cells, fifty-nine upper cells,
    // 224 Ninja stamp cells (trees, houses, props), ten causal-world cells
    // (worn ground, paved road, gravel, ruins), the villager and the
    // caravan remain a 163 KiB tile vocabulary. Four repeated fill blocks
    // add 512 KiB without scaling with world length.
    expect((16 + 16 + 59 + 224 + 10 + 2) * 16 * 16 * 2).toBe(167_424);
    expect(4 * 256 * 256 * 2).toBe(524_288);
    const fullWorldChunkNodes = Math.ceil(DEFAULT_PARAMS.width / 32)
      * Math.ceil(DEFAULT_PARAMS.height / 32) * 2;
    expect(fullWorldChunkNodes).toBe(512);
    expect(fullWorldChunkNodes * bytesPerUpload).toBe(268_435_456);
  });

  test("the Ninja tile bundle stays small", () => {
    const pak = statSync(appBundle("grow") + ".pak");
    // +130,816 B over D6h for the 224 stamp cells of the art pass.
    // +16 B for K4's new shop-box string literals ("Buy"/"Sell"/"Leave"/
    // "Back"/"Gold: "), reachable through GrowView's DialogBox import and
    // widening the baked font's glyph coverage by one codepoint.
    // +6,432 B for the causal world: eleven new 16x16 cells (six ground,
    // four ruin pieces, the caravan; 5,632 B) and 800 B of other baked data.
    // +16 B because the shared RPG Maker text parser adds one codepoint to
    // Grow's source-scanned ASCII font archive.
    expect(pak.size).toBe(805_712);
    expect(pak.size).toBeLessThan(850_000);
  });
});
