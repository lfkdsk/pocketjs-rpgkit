// The safe Script recognizer is build-time importer code. Ordinary runtime
// consumers must not pay for its tokenizer or the formula AST adapter.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const inputs = (app: string): string => join(ROOT, "dist", `${app}.inputs.json`);
const ready = ["meadow", "sunstone"].every((app) => existsSync(inputs(app)));
if (!ready) console.warn("RPG Maker Script isolation test skipped: build meadow and sunstone first");
const builtTest = ready ? test : test.skip;

function modules(app: string): string[] {
  return (JSON.parse(readFileSync(inputs(app), "utf8")) as string[])
    .map((path) => path.replaceAll("\\", "/"));
}

describe("RPG Maker safe Script recognition remains importer-only", () => {
  builtTest("ordinary consumer graphs contain no Script recognizer", () => {
    for (const app of ["meadow", "sunstone"]) {
      const names = modules(app);
      expect(names.some((path) => path.endsWith("/tools/rpgmaker-import/script-subset.ts")), app).toBe(false);
      expect(readFileSync(join(ROOT, "dist", `${app}.js`), "utf8"), app)
        .not.toContain("unsupported action shape");
    }
  });
});
