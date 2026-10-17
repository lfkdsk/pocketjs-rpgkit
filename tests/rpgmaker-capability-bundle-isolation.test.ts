// RPG Maker screen, text/choice styling and follower/vehicle code are
// explicit capabilities. Ordinary GameView consumers must not admit their
// concrete implementations to PocketJS's pass-1 graph or the final QuickJS
// bundle; the imported RPG Maker fixture opts into every capability as the
// positive control. Build meadow, sunstone and rmi-play before this test.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const apps = ["meadow", "sunstone", "rmi-play"] as const;
const inputs = (app: string): string => join(ROOT, "dist", `${app}.inputs.json`);
const bundle = (app: string): string => join(ROOT, "dist", `${app}.js`);
const ready = apps.every((app) => existsSync(inputs(app)) && existsSync(bundle(app)));
if (!ready) {
  console.warn(
    "RPG Maker capability isolation test skipped: build meadow, sunstone and rmi-play first",
  );
}
const builtTest = ready ? test : test.skip;

const IMPLEMENTATION_SUFFIXES = [
  "/src/engine/rpgmaker-screen.ts",
  "/src/engine/rpgmaker-text.ts",
  "/src/engine/travel-session.ts",
  "/src/engine/travel.ts",
  "/src/ui/ChoiceColourLine.tsx",
  "/src/ui/Krm2ScreenEffectsLayer.tsx",
  "/src/ui/ScreenToneWeatherLayer.tsx",
  "/src/ui/TravelActors.tsx",
  "/src/ui/choice-colour.ts",
  "/src/ui/screen-presentation.ts",
  "/src/ui/travel-actors.ts",
] as const;

const BUNDLE_NEEDLES = [
  "// src/engine/rpgmaker-screen.ts",
  "// src/engine/rpgmaker-text.ts",
  "// src/engine/travel-session.ts",
  "// src/engine/travel.ts",
  "// src/ui/ChoiceColourLine.tsx",
  "// src/ui/Krm2ScreenEffectsLayer.tsx",
  "// src/ui/ScreenToneWeatherLayer.tsx",
  "// src/ui/TravelActors.tsx",
  "// src/ui/choice-colour.ts",
  "// src/ui/screen-presentation.ts",
  "// src/ui/travel-actors.ts",
] as const;

// Presentation-only audio gain projection adds 312 B to each audio-enabled
// graph (Sunstone and the opted-in fixture); Meadow does not reach it.
const EXPECTED_BYTES = {
  // Immediate facing/routes and bounded backdrop history add 8,898 B to the
  // plain control, 10,485 B where save/demo code is already reachable, and
  // 10,901 B to the positive fixture that also reaches travel reconciliation.
  // Frozen-battle capability routing then adds about 1.2 KiB to the shared
  // session reducer. Moving tone/weather behind the optional KRM2 entry
  // removes about 11.1 KiB from GameView-only Sunstone; rmi-play retains it.
  // Load-time RPG Maker screen-capability admission adds a measured 4,205 B
  // to Meadow, 4,422 B to Sunstone and 4,659 B to the opted-in fixture. It
  // does not link either optional screen implementation into the controls;
  // the graph and bundle needles below keep that boundary.
  // The ordinary tileset-passage fast path then adds 798 B of shared session
  // code to all three while keeping sparse runtime overrides allocation-free.
  // The implementation-graph and bundle needles below still prove that the
  // optional RPG Maker and travel implementations stay out of both controls.
  // Effective first-step config for immediate event routes adds 161 B to each
  // shared session graph without admitting an optional capability module.
  // Compile-time worldIdle context admission adds 534 B to each graph while
  // the implementation and bundle needles below retain the same boundary.
  // Immutable scene/session allocation fast paths add 732 B to every shared
  // engine graph; the implementation and bundle needles remain unchanged.
  // The synced PocketJS style ABI and capability table add 146 B to each app
  // for contain, its enum values, and text.glyphs.runtime; graph reachability
  // and the implementation needles below remain unchanged.
  // Optional connected-world actor projection adds 1,795 B to GameView-only
  // Sunstone and 2,169 B to the travel-enabled positive control. The branch
  // is dormant unless a world renderer supplies an actor space; Meadow does
  // not reach GameView, and the capability needles below remain unchanged.
  meadow: 684_525,
  // Bucketed upper rows and ordinary-row write suppression add 159 B to both
  // GameView graphs without changing their capability boundaries.
  sunstone: 1_110_662,
  "rmi-play": 1_300_388,
} as const;

function implementationModules(app: string): string[] {
  const paths = JSON.parse(readFileSync(inputs(app), "utf8")) as string[];
  return paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => IMPLEMENTATION_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .map((path) => path.slice(path.lastIndexOf("/src/") + 5))
    .sort();
}

describe("RPG Maker screen, text and travel capabilities remain opt-in", () => {
  test("exports separate engine and presentation entries", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json() as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./rpgmaker-text"]).toBe("./src/engine/rpgmaker-text.ts");
    expect(pkg.exports["./rpgmaker-screen"]).toBe("./src/engine/rpgmaker-screen.ts");
    expect(pkg.exports["./travel"]).toBe("./src/travel.ts");
    expect(pkg.exports["./ui/krm2"]).toBe("./src/ui/krm2/index.ts");
    expect(pkg.exports["./ui/rpgmaker-text"]).toBe("./src/ui/ChoiceColourLine.tsx");
    expect(pkg.exports["./ui/travel"]).toBe("./src/ui/TravelActors.tsx");
  });

  builtTest("ordinary projects reach no concrete implementation", () => {
    for (const app of ["meadow", "sunstone"] as const) {
      expect(implementationModules(app), `${app} implementation graph`).toEqual([]);
      const js = readFileSync(bundle(app), "utf8");
      for (const needle of BUNDLE_NEEDLES) {
        expect(js.includes(needle), `${app}.js contains ${needle}`).toBe(false);
      }
    }
  });

  builtTest("the imported-project fixture reaches all eleven implementations", () => {
    expect(implementationModules("rmi-play")).toEqual([
      "engine/rpgmaker-screen.ts",
      "engine/rpgmaker-text.ts",
      "engine/travel-session.ts",
      "engine/travel.ts",
      "ui/ChoiceColourLine.tsx",
      "ui/Krm2ScreenEffectsLayer.tsx",
      "ui/ScreenToneWeatherLayer.tsx",
      "ui/TravelActors.tsx",
      "ui/choice-colour.ts",
      "ui/screen-presentation.ts",
      "ui/travel-actors.ts",
    ]);
    const js = readFileSync(bundle("rmi-play"), "utf8");
    for (const needle of BUNDLE_NEEDLES) expect(js).toContain(needle);
    expect(js).toContain("#20A0D6");
    expect(js).toContain("vehicle location: integer x/y required");
    expect(js).toContain("rpgkit-airship-shadow");
  });

  builtTest("pins the negative controls and opted-in fixture byte sizes", () => {
    for (const app of apps) expect(statSync(bundle(app)).size, app).toBe(EXPECTED_BYTES[app]);
  });
});
