// KRM2 numbered pictures and HUD are an explicit UI entry. A GameView-only
// app keeps their JSX and text-measure helpers out of its static bundle,
// while the fixture that passes krm2ScreenPresentation contains them.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SUNSTONE_JS = join(ROOT, "dist", "sunstone.js");
const KRM2_JS = join(ROOT, "dist", "krm2-ui.js");
const preflight = existsSync(SUNSTONE_JS) && existsSync(KRM2_JS)
  ? { ok: true as const }
  : { ok: false as const, reason: "run `bun run build:example sunstone krm2-ui`" };
if (!preflight.ok) console.warn(`KRM2 UI bundle isolation test skipped: ${preflight.reason}`);
const maybeTest = preflight.ok ? test : test.skip;

const KRM2_UI_NEEDLES = [
  "rpgkit-screen-tone-",
  "rpgkit-weather-particle-",
  "rpgkit-picture-",
  "rpgkit-timer-hud",
  "rpgkit-map-name-banner",
  "rpgkit-number-input-scene",
];

describe("KRM2 screen and number-input presentation remains opt-in", () => {
  maybeTest("keeps KRM2 UI out of a GameView-only bundle", () => {
    const ordinary = readFileSync(SUNSTONE_JS, "utf8");
    const optedIn = readFileSync(KRM2_JS, "utf8");
    for (const needle of KRM2_UI_NEEDLES) {
      expect(ordinary.includes(needle), `sunstone.js contains ${JSON.stringify(needle)}`).toBe(false);
      expect(optedIn.includes(needle), `krm2-ui.js lacks ${JSON.stringify(needle)}`).toBe(true);
    }
  });
});
