// RPG Maker battle rules and presentation are explicit package entries.
// Pass-1 input manifests prove that ordinary GameView consumers do not even
// admit these modules to their source graph; rmi-play opts into both.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const inputs = (app: string): string => join(ROOT, "dist", `${app}.inputs.json`);
const ready = ["meadow", "sunstone", "rmi-play"].every((app) => existsSync(inputs(app)));
if (!ready) console.warn("RPG Maker battle isolation test skipped: build meadow, sunstone and rmi-play first");
const builtTest = ready ? test : test.skip;

const modules = (app: string): string[] =>
  (JSON.parse(readFileSync(inputs(app), "utf8")) as string[]).map((path) => path.replaceAll("\\", "/"));

const battleModules = (app: string): string[] => modules(app).filter((path) =>
  path.includes("/src/rpgmaker-battle/") || path.includes("/src/ui/rpgmaker-battle/"));

describe("RPG Maker battle remains opt-in", () => {
  test("exports separate rules and presentation entries", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json() as { exports: Record<string, string> };
    expect(pkg.exports["./rpgmaker-battle"]).toBe("./src/rpgmaker-battle/index.ts");
    expect(pkg.exports["./ui/rpgmaker-battle"]).toBe("./src/ui/rpgmaker-battle/index.tsx");
  });

  builtTest("ordinary projects reach no RPG Maker battle implementation", () => {
    expect(battleModules("meadow")).toEqual([]);
    expect(battleModules("sunstone")).toEqual([]);
  });

  builtTest("the imported-project fixture reaches rules and presentation", () => {
    const names = battleModules("rmi-play").map((path) => path.slice(path.lastIndexOf("/src/") + 5)).sort();
    expect(names).toContain("rpgmaker-battle/rules.ts");
    expect(names).toContain("ui/rpgmaker-battle/index.tsx");
  });
});
