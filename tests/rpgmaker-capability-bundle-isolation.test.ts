// RPG Maker text/choice styling and follower/vehicle code are explicit
// capabilities. Ordinary GameView consumers must not admit their concrete
// implementations to PocketJS's pass-1 graph or the final QuickJS bundle;
// the imported RPG Maker fixture opts into every capability as the positive
// control. Build meadow, sunstone and rmi-play before this test.

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
  "/src/ui/TravelActors.tsx",
  "/src/ui/choice-colour.ts",
  "/src/ui/travel-actors.ts",
] as const;

const BUNDLE_NEEDLES = [
  "// src/engine/rpgmaker-screen.ts",
  "// src/engine/rpgmaker-text.ts",
  "// src/engine/travel-session.ts",
  "// src/engine/travel.ts",
  "// src/ui/ChoiceColourLine.tsx",
  "// src/ui/TravelActors.tsx",
  "// src/ui/choice-colour.ts",
  "// src/ui/travel-actors.ts",
] as const;

const EXPECTED_BYTES = {
  // Immediate facing/routes and bounded backdrop history add 8,898 B to the
  // plain control, 10,485 B where save/demo code is already reachable, and
  // 10,901 B to the positive fixture that also reaches travel reconciliation.
  // The implementation-graph and bundle needles below still prove that the
  // optional RPG Maker and travel implementations stay out of both controls.
  meadow: 676_764,
  sunstone: 1_111_540,
  "rmi-play": 1_289_432,
} as const;

function implementationModules(app: string): string[] {
  const paths = JSON.parse(readFileSync(inputs(app), "utf8")) as string[];
  return paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => IMPLEMENTATION_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .map((path) => path.slice(path.lastIndexOf("/src/") + 5))
    .sort();
}

describe("RPG Maker text and travel capabilities remain opt-in", () => {
  test("exports separate engine and presentation entries", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json() as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./rpgmaker-text"]).toBe("./src/engine/rpgmaker-text.ts");
    expect(pkg.exports["./rpgmaker-screen"]).toBe("./src/engine/rpgmaker-screen.ts");
    expect(pkg.exports["./travel"]).toBe("./src/travel.ts");
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

  builtTest("the imported-project fixture reaches all eight implementations", () => {
    expect(implementationModules("rmi-play")).toEqual([
      "engine/rpgmaker-screen.ts",
      "engine/rpgmaker-text.ts",
      "engine/travel-session.ts",
      "engine/travel.ts",
      "ui/ChoiceColourLine.tsx",
      "ui/TravelActors.tsx",
      "ui/choice-colour.ts",
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
