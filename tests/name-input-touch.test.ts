// tests/name-input-touch.test.ts — direct touch activation of the built-in
// name-input grid through the real sim host hit-test -> Focusable ->
// GameView -> SessionInput.selectIndex path. Coordinates are logical viewport
// pixels at both supported integer scales, not node ids or synthetic reducer
// input, so a scale or cell-bounds regression misses the intended entry.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { __packTouch, __packTouchWide } from "../vendor/pocketjs/framework/src/touch.ts";
import type { NameInputState } from "../src/engine/name-input.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import {
  bootGameWorld,
  installGameSimIsolation,
  type BoundGameWorld,
} from "./helpers/sim-session.ts";

const preflight = appPreflight("kg1-name-input");
if (!preflight.ok) console.warn(`name input touch tests skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

function pump(
  world: BoundGameWorld,
  frames: number,
  buttons = 0,
  touches?: readonly number[],
): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons, 0x8080, touches);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

function press(world: BoundGameWorld, button: number): void {
  pump(world, 1, button);
  pump(world, 1);
}

/** Touch down, release (which delivers onPress after GameView's frame hook),
 * then one frame for GameView to fold the pending semantic selection. */
function touchCell(world: BoundGameWorld, index: number, scale: number): void {
  const columns = 10;
  const col = index % columns;
  const row = Math.floor(index / columns);
  const x = (40 + col * 40 + 20) * scale;
  const y = (80 + row * 20 + 10) * scale;
  const contact = scale > 1 ? __packTouchWide(1, x, y) : __packTouch(1, x, y);
  pump(world, 1, 0, [contact]);
  pump(world, 1);
  pump(world, 1);
}

function nameState(world: BoundGameWorld): NameInputState {
  const scene = world.probes().state.scene;
  if (scene?.kind !== "scene") throw new Error("name-input scene is not open");
  return scene.state as unknown as NameInputState;
}

async function boot(viewport: { width: number; height: number }): Promise<BoundGameWorld> {
  const world = await bootGameWorld(
    appBundle("kg1-name-input"),
    60,
    {
      __kg1NameArgs: {
        variable: "player.nick",
        default: "",
        maxLength: 8,
        randomNames: ["Mira"],
      },
    },
    undefined,
    viewport,
  );
  pump(world, 1);
  return world;
}

simDescribe("name input touch", () => {
  for (const viewport of [
    { width: 480, height: 272 },
    { width: 960, height: 544 },
  ] as const) {
    test(`hits characters, BACK, RANDOM and OK at ${viewport.width}x${viewport.height}`, async () => {
      const world = await boot(viewport);
      const scale = viewport.width / 480;
      const charsetLength = nameState(world).charset.length;
      const back = charsetLength;
      const ok = charsetLength + 1;
      const random = charsetLength + 3;

      // Letter cells use their scaled screen bounds, and direct selection
      // also moves the reducer-owned cursor to the tapped entry.
      touchCell(world, 1, scale); // B
      expect(nameState(world)).toMatchObject({ cursor: 1, buffer: "B" });
      touchCell(world, 0, scale); // A
      expect(nameState(world)).toMatchObject({ cursor: 0, buffer: "BA" });

      touchCell(world, back, scale);
      expect(nameState(world)).toMatchObject({ cursor: back, buffer: "B" });

      touchCell(world, random, scale);
      expect(nameState(world)).toMatchObject({ cursor: random, buffer: "Mira" });

      touchCell(world, back, scale);
      expect(nameState(world)).toMatchObject({ cursor: back, buffer: "Mir" });

      touchCell(world, ok, scale);
      expect(world.probes().state.scene).toBeNull();
      expect(world.probes().state.sw.variables["player.nick"]).toBe("Mir");

      // GameView retains the scene subtree, but active=false removes its
      // cells from hit/focus participation. The old grid coordinate is inert.
      touchCell(world, 0, scale);
      expect(world.probes().state.scene).toBeNull();
      expect(world.probes().state.sw.variables["player.nick"]).toBe("Mir");
    }, 30_000);
  }

  test("CIRCLE keeps the existing controller confirm path single-shot", async () => {
    const world = await boot({ width: 480, height: 272 });

    // Focus traversal sees the new focusable cells too, but its CIRCLE
    // onPress must not enqueue a second selectIndex after the reducer already
    // handled this frame's controller confirm edge.
    press(world, BTN.RIGHT);
    press(world, BTN.CIRCLE);
    pump(world, 1); // would consume an accidentally queued second activation
    expect(nameState(world)).toMatchObject({ cursor: 1, buffer: "B" });
  }, 30_000);
});
