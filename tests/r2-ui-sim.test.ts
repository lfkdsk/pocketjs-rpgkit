import { describe, expect, test } from "bun:test";
import { decodePng } from "../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../vendor/pocketjs/tests/png.ts";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { PROP } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { chunkWindow } from "../src/engine/chunk-window.ts";
import { walkPose } from "../src/engine/movement.ts";
import { TILE } from "../src/engine/tiles.ts";
import type { AnimatedTilesStats } from "../src/ui/AnimatedTiles.tsx";
import {
  ABOVE_ANIMATION,
  CANOPY_NPC,
  DEPTH_SOUTH,
  LATE_NPC,
  OCCLUSION_CASES,
  PLAYER_START,
  R2_MAP_ID,
  R2_MAP_SIZE,
  R2_SECOND_MAP,
  R2_SECOND_MAP_ID,
  SECOND_NPC,
} from "./fixtures/r2-ui/fixture-data.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`r2-ui sim tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

type Rgba = readonly [number, number, number, number];
type FacingName = "down" | "left" | "up" | "right";

const VIEWPORT = { width: 480, height: 272 } as const;
const FACING_COLOURS: Record<FacingName, Rgba> = {
  down: [246, 92, 92, 255],
  left: [86, 216, 116, 255],
  up: [246, 206, 74, 255],
  right: [74, 132, 246, 255],
};
const ANIMATION_COLOURS: readonly Rgba[] = [
  [22, 190, 214, 255],
  [246, 188, 58, 255],
  [124, 96, 238, 255],
  [236, 72, 104, 255],
];
const IDLE_FEET: Rgba = [238, 238, 244, 255];
const CANOPY_COLOUR: Rgba = [174, 48, 142, 255];

simDescribe("GameView world overlay slot", () => {
  test("mounts below screen effects, dialogs, and fade", async () => {
    const world = await bootGameWorld(
      appBundle("r2-ui"),
      60,
      { __r2WorldOverlay: true },
      undefined,
      VIEWPORT,
    );
    pump(world, 1);

    const tree = world.getTree();
    const overlayName = `rpgkit-fixture-world-overlay-${R2_MAP_ID}`;
    const overlay = findNode(tree, overlayName);
    expect(overlay).toBeDefined();

    const serialized = JSON.stringify(tree);
    const order = [
      "rpgkit-world-frame",
      overlayName,
      "rpgkit-screen-tint",
      "rpgkit-message-layer",
      "rpgkit-screen-fade",
    ].map((name) => serialized.indexOf(name));
    expect(order.every((index) => index >= 0)).toBeTrue();
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

interface R2Stats {
  below?: AnimatedTilesStats;
  above?: AnimatedTilesStats;
}

const stats = (): R2Stats =>
  structuredClone((globalThis as { __r2UiStats?: R2Stats }).__r2UiStats ?? {});

function pump(world: BoundGameWorld, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
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

async function golden(
  name: string,
  frame: Uint8Array,
  width: number = VIEWPORT.width,
  height: number = VIEWPORT.height,
): Promise<string> {
  const url = new URL(`./goldens/${name}.png`, import.meta.url);
  if (process.env.R2_UI_UPDATE_GOLDENS) {
    await Bun.write(url, encodePNG(frame, width, height));
  }
  const bytes = new Uint8Array(await Bun.file(url).arrayBuffer());
  expect(frame).toEqual(decodePng(bytes).rgba);
  return fnv1a(frame);
}

function playerHead(world: BoundGameWorld, frame: Uint8Array, colour: Rgba): void {
  const { state, camera } = world.probes();
  expectPixel(frame, VIEWPORT.width, state.move.px - camera.x + 8, state.move.py - camera.y - 8, colour);
  expectPixel(frame, VIEWPORT.width, state.move.px - camera.x + 6, state.move.py - camera.y + 13, IDLE_FEET);
}

function moveOne(world: BoundGameWorld, buttons: number, x: number, y: number): void {
  for (let frames = 0; frames < 20; frames++) {
    pump(world, 1, buttons);
    const move = world.probes().state.move;
    if (move.tx === x && move.ty === y && !move.moving) break;
  }
  pump(world, 1);
  const move = world.probes().state.move;
  expect({ x: move.tx, y: move.ty, moving: move.moving }).toEqual({ x, y, moving: false });
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

function findNodes(tree: unknown, prefix: string): any[] {
  const out: any[] = [];
  (function visit(value: unknown): void {
    const node = value as { n?: string; k?: unknown[] };
    if (node?.n?.startsWith(prefix)) out.push(node);
    for (const child of node?.k ?? []) visit(child);
  })(tree);
  return out;
}

function countMatchingSpritePixels(
  frame: Uint8Array,
  frameWidth: number,
  screenX: number,
  screenY: number,
  sprite: Uint8Array,
  maxSpriteY = 32,
): number {
  let count = 0;
  for (let y = 0; y < maxSpriteY; y++) {
    for (let x = 0; x < TILE; x++) {
      const source = (y * TILE + x) * 4;
      if (sprite[source + 3] === 0) continue;
      const target = ((screenY + y) * frameWidth + screenX + x) * 4;
      if (
        frame[target] === sprite[source]
        && frame[target + 1] === sprite[source + 1]
        && frame[target + 2] === sprite[source + 2]
        && frame[target + 3] === sprite[source + 3]
      ) count++;
    }
  }
  return count;
}

type PositionTrace = Map<number, { x?: number; y?: number }>;

function tracePositionBatches(positions: PositionTrace): (ops: Record<string, unknown>) => void {
  return (ops) => {
    const original = ops.setPropBatch as ((records: ArrayBuffer) => void) | undefined;
    expect(original).toBeDefined();
    ops.setPropBatch = (records: ArrayBuffer): void => {
      const values = new Float64Array(records);
      for (let i = 0; i < values.length; i += 3) {
        const id = values[i]!;
        const prop = values[i + 1]!;
        const value = values[i + 2]!;
        if (prop !== PROP.translateX && prop !== PROP.translateY) continue;
        const point = positions.get(id) ?? {};
        if (prop === PROP.translateX) point.x = value;
        else point.y = value;
        positions.set(id, point);
      }
      original!(records);
    };
  };
}

function traceStaleNativeOps(stale: string[]): (ops: Record<string, unknown>) => void {
  return (ops) => {
    const destroyed = new Set<number>();
    const destroyNode = ops.destroyNode as (id: number) => void;
    const createNode = ops.createNode as (type: number) => number;
    ops.destroyNode = (id: number): void => {
      destroyed.add(id);
      destroyNode.call(ops, id);
    };
    ops.createNode = (type: number): number => {
      const id = createNode.call(ops, type);
      destroyed.delete(id);
      return id;
    };

    const nodeArgs: Record<string, readonly number[]> = {
      setProp: [0],
      setImage: [0],
      setSprite: [0],
      insertBefore: [0, 1],
      removeChild: [0, 1],
      setStyle: [0],
      setText: [0],
      animate: [0],
    };
    for (const [name, indices] of Object.entries(nodeArgs)) {
      const original = ops[name] as ((...args: unknown[]) => unknown) | undefined;
      if (!original) continue;
      ops[name] = (...args: unknown[]): unknown => {
        for (const index of indices) {
          const id = args[index];
          if (typeof id === "number" && destroyed.has(id)) stale.push(`${name}(${id})`);
        }
        return original.apply(ops, args);
      };
    }

    const setPropBatch = ops.setPropBatch as ((records: ArrayBuffer) => void) | undefined;
    if (setPropBatch) {
      ops.setPropBatch = (records: ArrayBuffer): void => {
        const values = new Float64Array(records);
        for (let i = 0; i < values.length; i += 3) {
          const id = values[i]!;
          if (destroyed.has(id)) stale.push(`setPropBatch(${id})`);
        }
        setPropBatch.call(ops, records);
      };
    }
  };
}

simDescribe("animated tiles", () => {
  test("mounts only the viewport + one-tile ring and advances native atlas frame 6", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, undefined, undefined, VIEWPORT);
    pump(world, 1);

    const camera = world.probes().camera;
    const expected = chunkWindow(
      camera,
      { w: VIEWPORT.width, h: VIEWPORT.height },
      TILE,
      R2_MAP_SIZE.width,
      R2_MAP_SIZE.height,
      TILE,
    );
    const mounted = (expected.x1 - expected.x0 + 1) * (expected.y1 - expected.y0 + 1);
    expect(stats().below).toMatchObject({ mounted, created: mounted, pooled: 0 });
    expect(stats().above).toMatchObject({ mounted: 1, created: 1, pooled: 0 });

    const sampleX = 3 * TILE - camera.x + 8;
    const sampleY = 3 * TILE - camera.y + 8;
    expectPixel(world.render(), VIEWPORT.width, sampleX, sampleY, ANIMATION_COLOURS[0]!);
    pump(world, 5);
    const sixth = world.render().slice();
    expectPixel(sixth, VIEWPORT.width, sampleX, sampleY, ANIMATION_COLOURS[1]!);
    expect(await golden("r2-ui.animation-frame-6", sixth)).toBe("b5c6b149");

    const tree = findNode(world.getTree(), "rpgkit-world");
    const names = (tree.k as { n?: string }[]).map((node) => node.n ?? "");
    expect(names.indexOf("rpgkit-anim-below")).toBeLessThan(names.indexOf("rpgkit-actors-r2-ui-field"));
    const actors = findNode(tree, "rpgkit-actors-r2-ui-field");
    expect(findNode(actors, "rpgkit-upper-row-11")).toBeDefined();
    expect(findNode(actors, `rpgkit-anim-above-tile-${ABOVE_ANIMATION.x},${ABOVE_ANIMATION.y}`)).toBeDefined();
  }, 30_000);

  test("native animation and reducer-owned walkers agree at 60/30/20/4 Hz", async () => {
    const samples: Array<{ hash: string; stateJson: string; player: unknown; npc: unknown }> = [];
    for (const hz of [60, 30, 20, 4] as const) {
      const world = await bootGameWorld(appBundle("r2-ui"), hz, undefined, undefined, VIEWPORT);
      pump(world, hz * 2);
      const state = world.probes().state;
      samples.push({
        hash: fnv1a(world.render()),
        // SessionState.frame counts host frames; all reducer-owned virtual
        // state (including interp.frame) must otherwise be byte-identical.
        stateJson: JSON.stringify({ ...state, frame: 0 }),
        player: {
          tx: state.move.tx,
          ty: state.move.ty,
          px: state.move.px,
          py: state.move.py,
          facing: state.move.facing,
          phase: state.move.phase,
        },
        npc: state.chars.chars["walking-npc"],
      });
    }
    expect(samples[1]).toEqual(samples[0]);
    expect(samples[2]).toEqual(samples[0]);
    expect(samples[3]).toEqual(samples[0]);
  }, 30_000);
});

simDescribe("16x32 walkers", () => {
  test("keeps a page-swapped NPC on its cell and mounts only the current map actors", async () => {
    const positions: PositionTrace = new Map();
    const world = await bootGameWorld(
      appBundle("r2-ui"),
      60,
      undefined,
      tracePositionBatches(positions),
      VIEWPORT,
    );
    const beforeTree = world.getTree();
    const before = findNode(beforeTree, "rpgkit-npc-late-npc");
    expect(before).toBeDefined();
    expect(findNodes(beforeTree, "rpgkit-actors-").map((node) => node.n)).toEqual([
      "rpgkit-actors-r2-ui-field",
    ]);
    // KV1 reserves a stable hidden slot for every event, including the
    // sprite-less transfer trigger, so a later appearance command can show it.
    expect(findNodes(beforeTree, "rpgkit-npc-")).toHaveLength(4);

    pump(world, 1);
    const after = findNode(world.getTree(), "rpgkit-npc-late-npc");
    expect(after.i).toBe(before.i);
    expect(positions.get(after.i)).toEqual({ x: LATE_NPC.x * TILE, y: LATE_NPC.y * TILE });
    for (const id of ["canopy-npc", "walking-npc"]) {
      const node = findNode(world.getTree(), `rpgkit-npc-${id}`);
      const actor = world.probes().state.chars.chars[id]!;
      expect(positions.get(node.i)).toEqual({ x: actor.px, y: actor.py });
    }
  }, 30_000);

  test("rebinds stable actor slots and their position batch on transfer", async () => {
    const positions: PositionTrace = new Map();
    const world = await bootGameWorld(
      appBundle("r2-ui"),
      60,
      undefined,
      tracePositionBatches(positions),
      VIEWPORT,
    );
    pump(world, 1);
    const firstIds = new Set(findNodes(world.getTree(), "rpgkit-npc-").map((node) => node.i));
    moveOne(world, BTN.RIGHT, PLAYER_START.x + 1, PLAYER_START.y);
    for (let frame = 0; frame < 20 && world.probes().state.mapId !== R2_SECOND_MAP_ID; frame++) {
      pump(world, 1, BTN.RIGHT);
    }
    pump(world, 1);

    expect(world.probes().state.mapId).toBe(R2_SECOND_MAP_ID);
    const tree = world.getTree();
    expect(findNodes(tree, "rpgkit-actors-").map((node) => node.n)).toEqual([
      `rpgkit-actors-${R2_SECOND_MAP_ID}`,
    ]);
    const destinationNpcs = findNodes(tree, "rpgkit-npc-");
    // The sprite-less return trigger also owns a hidden runtime-appearance slot.
    expect(destinationNpcs).toHaveLength(21);
    const destinationIds = new Set(destinationNpcs.map((node) => node.i));
    expect([...firstIds].every((id) => destinationIds.has(id))).toBe(true);
    const destination = findNode(tree, "rpgkit-npc-second-npc");
    expect(destination).toBeDefined();
    expect(positions.get(destination.i)).toEqual({
      x: SECOND_NPC.x * TILE,
      y: SECOND_NPC.y * TILE,
    });
  }, 30_000);

  test("keeps pooled upper rows alive across a 400-frame scroll away and back", async () => {
    const stale: string[] = [];
    const world = await bootGameWorld(
      appBundle("r2-ui"),
      60,
      undefined,
      traceStaleNativeOps(stale),
      VIEWPORT,
    );
    pump(world, 1);
    pump(world, 400, BTN.DOWN);
    expect(world.probes().camera.y).toBeGreaterThan(0);
    pump(world, 400, BTN.UP);

    const { camera } = world.probes();
    expect(camera.y).toBe(0);
    expectPixel(
      world.render(),
      VIEWPORT.width,
      CANOPY_NPC.x * TILE - camera.x,
      (CANOPY_NPC.y - 1) * TILE - camera.y,
      CANOPY_COLOUR,
    );
    expect(stale).toEqual([]);
  }, 30_000);

  test("reuses an upper-row pool across maps without touching destroyed ids", async () => {
    const stale: string[] = [];
    const world = await bootGameWorld(
      appBundle("r2-ui"),
      60,
      undefined,
      traceStaleNativeOps(stale),
      VIEWPORT,
    );
    pump(world, 1);
    moveOne(world, BTN.RIGHT, PLAYER_START.x + 1, PLAYER_START.y);
    for (let frame = 0; frame < 20 && world.probes().state.mapId !== R2_SECOND_MAP_ID; frame++) {
      pump(world, 1, BTN.RIGHT);
    }
    expect(world.probes().state.mapId).toBe(R2_SECOND_MAP_ID);

    // Leave any surplus row/slice nodes detached across several sweeps before
    // the smaller camera window transfers back and needs them again.
    pump(world, 3);
    for (let frame = 0; frame < 20 && world.probes().state.mapId === R2_SECOND_MAP_ID; frame++) {
      pump(world, 1, BTN.LEFT);
    }
    pump(world, 1);
    expect(world.probes().state.mapId).toBe(R2_MAP_ID);

    const { camera } = world.probes();
    expectPixel(
      world.render(),
      VIEWPORT.width,
      CANOPY_NPC.x * TILE - camera.x,
      (CANOPY_NPC.y - 1) * TILE - camera.y,
      CANOPY_COLOUR,
    );
    expect(stale).toEqual([]);
  }, 30_000);

  test("renders four idle facings, bottom-anchors feet, and keeps head-row upper art behind a tall actor", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, undefined, undefined, VIEWPORT);
    pump(world, 1);

    const down = world.render().slice();
    playerHead(world, down, FACING_COLOURS.down);
    expect(await golden("r2-ui.walker-down", down)).toBe("62242623");

    moveOne(world, BTN.RIGHT, PLAYER_START.x + 1, PLAYER_START.y);
    const right = world.render().slice();
    playerHead(world, right, FACING_COLOURS.right);
    expect(await golden("r2-ui.walker-right", right)).toBe("fe03c8a7");

    moveOne(world, BTN.UP, PLAYER_START.x + 1, PLAYER_START.y - 1);
    const up = world.render().slice();
    playerHead(world, up, FACING_COLOURS.up);
    expect(await golden("r2-ui.walker-up", up)).toBe("6915acb1");

    moveOne(world, BTN.LEFT, PLAYER_START.x, PLAYER_START.y - 1);
    const left = world.render().slice();
    playerHead(world, left, FACING_COLOURS.left);
    expect(await golden("r2-ui.walker-left", left)).toBe("404129c9");

    moveOne(world, BTN.DOWN, PLAYER_START.x, PLAYER_START.y);
    const camera = world.probes().camera;
    const visibleHead = {
      x: CANOPY_NPC.x * TILE - camera.x + 8,
      y: (CANOPY_NPC.y - 1) * TILE - camera.y + 8,
    };
    const visibleBody = {
      x: CANOPY_NPC.x * TILE - camera.x + 8,
      y: CANOPY_NPC.y * TILE - camera.y + 4,
    };
    expectPixel(world.render(), VIEWPORT.width, visibleHead.x, visibleHead.y, FACING_COLOURS.down);
    expectPixel(world.render(), VIEWPORT.width, visibleBody.x, visibleBody.y, FACING_COLOURS.down);

    const aboveX = ABOVE_ANIMATION.x * TILE - camera.x + 8;
    const aboveY = ABOVE_ANIMATION.y * TILE - camera.y + 8;
    expect(ANIMATION_COLOURS.map((colour) => [...colour])).toContainEqual(
      rgbaAt(world.render(), VIEWPORT.width, aboveX, aboveY),
    );
  }, 30_000);

  test("matches the two-pixel foot model at 13 representative positions and y-sorts overlapping actors", async () => {
    const wide = { width: 960, height: 544 } as const;
    expect((R2_SECOND_MAP.events ?? []).filter((event) => event.pages.some((page) => page.sprite))).toHaveLength(20);
    const world = await bootGameWorld(appBundle("r2-ui"), 60, undefined, undefined, wide);
    pump(world, 1);
    moveOne(world, BTN.RIGHT, PLAYER_START.x + 1, PLAYER_START.y);
    for (let frame = 0; frame < 20 && world.probes().state.mapId !== R2_SECOND_MAP_ID; frame++) {
      pump(world, 1, BTN.RIGHT);
    }
    pump(world, 1);
    expect(world.probes().state.mapId).toBe(R2_SECOND_MAP_ID);
    expect(world.probes().camera).toMatchObject({ x: 0, y: 0 });

    const frame = world.render().slice();
    const sprite = decodePng(
      new Uint8Array(await Bun.file(new URL("./fixtures/r2-ui/assets/walker-idle-0.png", import.meta.url)).arrayBuffer()),
    ).rgba;
    const full = countMatchingSpritePixels(sprite, TILE, 0, 0, sprite);
    const aboveFoot = countMatchingSpritePixels(sprite, TILE, 0, 0, sprite, TILE);
    expect(full).toBeGreaterThan(aboveFoot);

    for (const entry of OCCLUSION_CASES) {
      const visible = countMatchingSpritePixels(
        frame,
        wide.width,
        entry.x * TILE,
        entry.y * TILE - TILE,
        sprite,
      );
      expect(visible, entry.id).toBe(entry.foot ? aboveFoot : full);
    }

    // The south actor's green head overlaps the north actor's yellow feet.
    // A (y,x) painter must leave the green actor on top.
    expectPixel(
      frame,
      wide.width,
      DEPTH_SOUTH.x * TILE + 8,
      DEPTH_SOUTH.y * TILE - 8,
      FACING_COLOURS.left,
    );

    const tree = world.getTree();
    const rows = findNodes(tree, "rpgkit-upper-row-").filter((node) => /^rpgkit-upper-row-\d+$/.test(node.n));
    const slices = findNodes(tree, "rpgkit-upper-row-").filter((node) => node.n.includes("-chunk-"));
    expect(rows).toHaveLength(35);
    expect(slices).toHaveLength(70);
    expect(await golden("r2-ui.occlusion-reference", frame, wide.width, wide.height)).toBe("c5397b89");
  }, 30_000);

  test("selects both walking poses for an NPC from its live CharState phase", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, undefined, undefined, VIEWPORT);
    let guard = 0;
    while (walkPose(world.probes().state.chars.chars["walking-npc"]?.phase ?? 0) !== 1 && guard++ < 20) {
      pump(world, 1);
    }
    let { state, camera } = world.probes();
    let npc = state.chars.chars["walking-npc"]!;
    expect(npc.facing).toBe(3);
    expect(walkPose(npc.phase)).toBe(1);
    expectPixel(world.render(), VIEWPORT.width, npc.px - camera.x + 3, npc.py - camera.y + 13, [252, 72, 214, 255]);

    guard = 0;
    while (walkPose(world.probes().state.chars.chars["walking-npc"]!.phase) !== 2 && guard++ < 20) {
      pump(world, 1);
    }
    ({ state, camera } = world.probes());
    npc = state.chars.chars["walking-npc"]!;
    expect(walkPose(npc.phase)).toBe(2);
    expectPixel(world.render(), VIEWPORT.width, npc.px - camera.x + 13, npc.py - camera.y + 13, [68, 232, 248, 255]);
  }, 30_000);
});
