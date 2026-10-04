// Connected-world presentation is an explicit `pocket-rpgkit/ui/world`
// entry. Sunstone and the CJK fixture mount the real GameView without opting
// in; the world-streamed fixture imports the entry and supplies its factory.
// PocketJS's pass-1 input manifests prove module reachability before final
// tree shaking, while the final-bundle needles guard the same boundary.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BASE_INPUTS = join(ROOT, "dist", "cjk-text.inputs.json");
const WORLD_INPUTS = join(ROOT, "dist", "world-streamed.inputs.json");
const BASE_JS = join(ROOT, "dist", "cjk-text.js");
const WORLD_JS = join(ROOT, "dist", "world-streamed.js");
const SUNSTONE_INPUTS = join(ROOT, "dist", "sunstone.inputs.json");
const SUNSTONE_JS = join(ROOT, "dist", "sunstone.js");
const preflight = [
  BASE_INPUTS,
  BASE_JS,
  SUNSTONE_INPUTS,
  SUNSTONE_JS,
  WORLD_INPUTS,
  WORLD_JS,
].every(existsSync);
if (!preflight) {
  console.warn(
    "world UI bundle isolation test skipped: run `bun run build:example cjk-text sunstone world-streamed`",
  );
}
const bundleTest = preflight ? test : test.skip;

function paths(file: string): string[] {
  return (JSON.parse(readFileSync(file, "utf8")) as string[])
    .map((path) => path.replaceAll("\\", "/"));
}

function worldModules(file: string): string[] {
  return paths(file).filter((path) =>
    path.includes("/src/ui/world/") ||
    path.endsWith("/src/ui/WorldStreamedTerrain.tsx") ||
    path.endsWith("/src/ui/WorldAnimatedTiles.tsx") ||
    path.endsWith("/src/ui/WorldNpcPreview.tsx") ||
    path.endsWith("/src/engine/world-preview.ts") ||
    path.endsWith("/src/engine/world-handoff.ts") ||
    path.endsWith("/src/engine/world-layout.ts")
  );
}

describe("ui/world bundle isolation", () => {
  test("the package exposes one explicit opt-in entry", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json() as { exports: Record<string, string> };
    expect(pkg.exports["./ui/world"]).toBe("./src/ui/world/index.ts");
    expect(Bun.resolveSync("pocket-rpgkit/ui/world", ROOT).replaceAll("\\", "/"))
      .toEndWith("/src/ui/world/index.ts");
  });

  bundleTest("base GameView apps reach no connected-world implementation", () => {
    for (const [inputs, js] of [[BASE_INPUTS, BASE_JS], [SUNSTONE_INPUTS, SUNSTONE_JS]]) {
      expect(worldModules(inputs)).toEqual([]);
      const bundle = readFileSync(js, "utf8");
      expect(bundle).not.toContain("rpgkit-world-terrain");
      expect(bundle).not.toContain("visible world maps:");
      expect(bundle).not.toContain("rpgkit-world-preview-front");
    }
  });

  bundleTest("an opted-in app reaches the connected-world implementation", () => {
    const names = worldModules(WORLD_INPUTS)
      .map((path) => path.slice(path.lastIndexOf("/") + 1))
      .sort();
    expect(names).toEqual([
      "WorldAnimatedTiles.tsx",
      "WorldNpcPreview.tsx",
      "WorldStreamedTerrain.tsx",
      "index.ts",
      "renderer.tsx",
      "world-handoff.ts",
      "world-layout.ts",
      "world-preview.ts",
    ]);
    const world = readFileSync(WORLD_JS, "utf8");
    expect(world).toContain("rpgkit-world-terrain");
    expect(world).toContain("rpgkit-world-preview-front");
  });
});
