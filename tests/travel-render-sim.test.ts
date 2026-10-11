// Followers and vehicles through GameView's actual PocketJS node tree. The
// pure projection suite catches state mapping; this sim fixture proves those
// optional images mount beside the pooled NPCs and the ridden vehicle replaces
// the player's ordinary pixels without rebuilding the actor subtree.

import { describe, expect, test } from "bun:test";
import { BTN } from "../vendor/pocketjs/contracts/spec/spec.ts";
import { fnv1a } from "../vendor/pocketjs/hosts/sim/sim.ts";
import { appBundle, appPreflight } from "./helpers/boot.ts";
import { bootGameWorld, installGameSimIsolation } from "./helpers/sim-session.ts";

const preflight = appPreflight("r2-ui");
if (!preflight.ok) console.warn(`travel render sim skipped: ${preflight.reason}`);
const simDescribe = preflight.ok ? describe : describe.skip;
installGameSimIsolation();

interface TreeNode {
  i: number;
  t: string;
  n?: string;
  k?: TreeNode[];
}

function findNode(tree: unknown, name: string): TreeNode | undefined {
  const node = tree as TreeNode | undefined;
  if (node?.n === name) return node;
  for (const child of node?.k ?? []) {
    const found = findNode(child, name);
    if (found) return found;
  }
  return undefined;
}

function pump(world: Awaited<ReturnType<typeof bootGameWorld>>, frames: number, buttons = 0): void {
  for (let frame = 0; frame < frames; frame++) {
    world.frame(buttons);
    for (let tick = 0; tick < world.ticksPerFrame; tick++) world.tick();
  }
}

simDescribe("travel actor GameView layer", () => {
  test("mounts stable follower/vehicle nodes and paints the boarded boat through the hero", async () => {
    const world = await bootGameWorld(appBundle("r2-ui"), 60, { __r2Travel: true });
    pump(world, 3);
    const beforePixels = fnv1a(world.render());
    const before = world.getTree();
    const actorRoot = findNode(before, "rpgkit-actors-r2-ui-field");
    expect((actorRoot?.k ?? []).filter((node) => node.t === "image")).toHaveLength(9);
    for (const name of [
      "rpgkit-follower-party-two",
      "rpgkit-follower-party-three",
      "rpgkit-vehicle-boat",
      "rpgkit-vehicle-airship",
    ]) expect(findNode(before, name), name).toBeDefined();
    const nodeIds = Object.fromEntries(
      ["rpgkit-player", "rpgkit-follower-party-two", "rpgkit-follower-party-three", "rpgkit-vehicle-boat"]
        .map((name) => [name, findNode(before, name)!.i]),
    );

    pump(world, 1, BTN.CIRCLE);
    pump(world, 20);
    expect(world.probes().state.travel?.vehicles?.riding).toBe("boat");
    expect([world.probes().state.move.tx, world.probes().state.move.ty]).toEqual([15, 13]);
    expect(fnv1a(world.render())).not.toBe(beforePixels);

    const after = world.getTree();
    for (const [name, id] of Object.entries(nodeIds)) {
      expect(findNode(after, name)?.i, name).toBe(id);
    }
  });
});
