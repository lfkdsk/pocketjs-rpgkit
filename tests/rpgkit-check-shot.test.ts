// tests/rpgkit-check-shot.test.ts — the screenshot driver: renders a
// schematic PNG at two resolutions on the sim host, asserts non-trivial
// pixels, determinism, and semantic content (player dot, passable cells).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureShotBundle, renderShots, shotPreflight } from "../tools/rpgkit-check/src/shot/render.ts";
import type { Project } from "../src/engine/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const CACHE = join(ROOT, ".cache", "rpgkit-check", "shot");
const preflight = shotPreflight();
const simDescribe = preflight.ok ? describe : describe.skip;
if (!preflight.ok) console.warn(`rpgkit-check shot tests skipped: ${preflight.reason}`);

const OUT = join(import.meta.dir, "..", "dist", "rpgkit-check-shot-test");

let meadow: Project;

beforeAll(async () => {
  meadow = (await Bun.file(join(import.meta.dir, "..", "examples", "meadow", "data", "meadow.json")).json()) as Project;
  mkdirSync(OUT, { recursive: true });
});

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

function countColors(fb: Uint8Array, pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < fb.length; i += 4) {
    if (pred(fb[i]!, fb[i + 1]!, fb[i + 2]!)) n++;
  }
  return n;
}

describe("rpgkit-check shot source bundle", () => {
  test("builds a missing source cache once and reuses it without dist", async () => {
    rmSync(CACHE, { recursive: true, force: true });
    const [first, concurrent] = await Promise.all([ensureShotBundle(), ensureShotBundle()]);
    expect(concurrent).toBe(first);
    expect(first).toBe(join(CACHE, "rpgkit-shot"));
    expect(first).not.toContain(`${join(ROOT, "dist")}/`);
    expect(existsSync(`${first}.js`)).toBe(true);
    expect(existsSync(`${first}.pak`)).toBe(true);
    const manifest = join(CACHE, "rpgkit-shot.inputs.json");
    const inputs = JSON.parse(readFileSync(manifest, "utf8")) as string[];
    expect(inputs).toContain(join(ROOT, "tests", "fixtures", "rpgkit-shot", "rpgkit-shot.tsx"));
    expect(inputs).toContain(join(ROOT, "vendor", "pocketjs", "tools", "build.ts"));

    const before = [statSync(`${first}.js`).mtimeMs, statSync(`${first}.pak`).mtimeMs];
    expect(await ensureShotBundle()).toBe(first);
    expect([statSync(`${first}.js`).mtimeMs, statSync(`${first}.pak`).mtimeMs]).toEqual(before);
  });
});

simDescribe("rpgkit-check shot", () => {
  test("renders meadow at two resolutions, non-trivial and deterministic", async () => {
    const a = await renderShots(meadow, { map: "meadow", x: 10, y: 7 }, OUT);
    expect(a).toHaveLength(2);
    expect(a[0]!.resolution).toEqual({ width: 480, height: 272 });
    expect(a[1]!.resolution).toEqual({ width: 960, height: 544 });
    for (const out of a) {
      expect(out.bytes).toBeGreaterThan(1000);
    }
    // Deterministic: a second render hashes identically.
    const b = await renderShots(meadow, { map: "meadow", x: 10, y: 7 }, OUT);
    expect(b[0]!.sha256).toBe(a[0]!.sha256);
    expect(b[1]!.sha256).toBe(a[1]!.sha256);
  });

  test("the schematic has passable cells, event markers and the player", async () => {
    const { decodePng } = await import("../vendor/pocketjs/framework/compiler/pak.ts");
    const [out] = await renderShots(meadow, { map: "meadow", x: 10, y: 7 }, OUT);
    const png = new Uint8Array(await Bun.file(out.file).arrayBuffer());
    const { rgba } = decodePng(png);
    // Passable green cells exist.
    const green = countColors(rgba, (r, g, b) => g > 60 && r < 80 && b < 80);
    expect(green).toBeGreaterThan(100);
    // The player's white marker exists.
    const white = countColors(rgba, (r, g, b) => r > 240 && g > 240 && b > 240);
    expect(white).toBeGreaterThan(0);
    // An amber action-event marker exists.
    const amber = countColors(rgba, (r, g, b) => r > 200 && g > 120 && g < 190 && b < 60);
    expect(amber).toBeGreaterThan(0);
  });

  test("a reach overlay tints reachable tiles blue", async () => {
    const { decodePng } = await import("../vendor/pocketjs/framework/compiler/pak.ts");
    // Every tile of the 20x12 meadow is reachable from (10,7).
    const reach: string[] = [];
    for (let y = 0; y < 12; y++) for (let x = 0; x < 20; x++) reach.push(`meadow@${x},${y}`);
    const [out] = await renderShots(meadow, { map: "meadow", x: 10, y: 7, reach }, OUT);
    const png = new Uint8Array(await Bun.file(out.file).arrayBuffer());
    const { rgba } = decodePng(png);
    const blue = countColors(rgba, (r, g, b) => b > 150 && r < 100 && g < 160);
    expect(blue).toBeGreaterThan(100);
  });

  test("registers noop rules for every scene id in the project", async () => {
    const project = structuredClone(meadow);
    project.maps[0]!.events![0]!.pages[0]!.commands.push({
      op: "scene",
      id: "fixture.journal",
      args: null,
    });
    const outputs = await renderShots(
      project,
      { map: "meadow", x: 10, y: 7, resolutions: [{ width: 160, height: 96 }] },
      OUT,
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.bytes).toBeGreaterThan(100);
  });

  test("uses function-bearing session options when selecting active pages", async () => {
    const project = (await Bun.file(join(
      import.meta.dir,
      "fixtures",
      "rpgkit-check",
      "session-project.json",
    )).json()) as Project;
    const render = async (enabled: boolean): Promise<number> => {
      const [out] = await renderShots(project, {
        map: "m1",
        x: 1,
        y: 1,
        resolutions: [{ width: 160, height: 96 }],
        ...(enabled
          ? { sessionOptions: { extensions: { conditions: { "fixture.open": () => true } } } }
          : {}),
      }, OUT);
      const { decodePng } = await import("../vendor/pocketjs/framework/compiler/pak.ts");
      const png = new Uint8Array(await Bun.file(out.file).arrayBuffer());
      const { rgba } = decodePng(png);
      return countColors(rgba, (r, g, b) => r > 200 && g > 120 && g < 190 && b < 60);
    };
    expect(await render(false)).toBe(0);
    expect(await render(true)).toBeGreaterThan(0);
  });
});
