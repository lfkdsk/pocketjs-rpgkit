// Pure semantic checks for portable K-RPGM5 screen/window presentation.

import { describe, expect, test } from "bun:test";
import type { WeatherEffectState } from "../src/engine/screen.ts";
import {
  screenToneOverlays,
  screenToneWeatherActive,
  WEATHER_DIMMER_COLOR,
  weatherDimmerOpacity,
  weatherParticleCount,
  weatherParticleGeometry,
  weatherParticleVector,
  weatherParticles,
} from "../src/ui/screen-presentation.ts";
import { windowToneTheme, type UiTheme } from "../src/ui/theme.ts";
import {
  mapScopedAnimatedSource,
  mapScopedLayerSource,
  tilesetEventSprite,
  tilesetLayerSource,
  type AnimatedTile,
  type EagerMapLayerVariant,
  type StreamedMapLayerVariant,
} from "../src/ui/game-assets.ts";

function weather(overrides: Partial<WeatherEffectState> = {}): WeatherEffectState {
  return {
    kind: "rain",
    fromPower: 4,
    targetPower: 4,
    total: 0,
    left: 0,
    seed: 0x12345678,
    clock: 20,
    ...overrides,
  };
}

describe("portable screen tone", () => {
  test("projects neutral, gray and signed RGB channels in stable order", () => {
    expect(screenToneOverlays(undefined)).toEqual([]);
    expect(screenToneOverlays({
      from: { r: 0, g: 0, b: 0, gray: 0 },
      to: { r: 128, g: 64, b: 0, gray: 128 },
      total: 10,
      left: 5,
    })).toEqual([
      { kind: "gray", color: "#808080", opacity: 64 / 255 },
      { kind: "brighten", color: "#ff8000", opacity: 64 / 255 },
    ]);
    expect(screenToneOverlays({
      from: { r: -128, g: 0, b: -64, gray: 0 },
      to: { r: -128, g: 0, b: -64, gray: 0 },
      total: 0,
      left: 0,
    })).toEqual([
      { kind: "darken", color: "#00ff80", opacity: 128 / 255 },
    ]);
  });
});

describe("deterministic weather projection", () => {
  test("particle count follows tweened RPG Maker power", () => {
    expect(weatherParticleCount(0)).toBe(0);
    expect(weatherParticleCount(0.09)).toBe(0);
    expect(weatherParticleCount(0.1)).toBe(1);
    expect(weatherParticleCount(4)).toBe(40);
    expect(weatherParticleCount(99)).toBe(90);

    const halfway = weather({ fromPower: 2, targetPower: 6, total: 8, left: 4 });
    expect(weatherParticles(halfway, 480, 272)).toHaveLength(40);
    expect(weatherParticles(undefined, 480, 272)).toEqual([]);
    expect(weatherParticles(weather({ kind: "none" }), 480, 272)).toEqual([]);
  });

  test("particle geometry and motion match the pinned RPG Maker rules", () => {
    const rain = weatherParticleGeometry("rain");
    expect(rain).toMatchObject({ width: 1, height: 60, radius: 0, rotate: 11.25, opacityDecay: 6 });
    expect(rain.dx).toBeCloseTo(-6 * Math.sin(Math.PI / 16), 12);
    expect(rain.dy).toBeCloseTo(6 * Math.cos(Math.PI / 16), 12);

    const storm = weatherParticleGeometry("storm");
    expect(storm).toMatchObject({ width: 2, height: 100, radius: 0, rotate: 22.5, opacityDecay: 8 });
    expect(storm.dx).toBeCloseTo(-8 * Math.sin(Math.PI / 8), 12);
    expect(storm.dy).toBeCloseTo(8 * Math.cos(Math.PI / 8), 12);

    const snow = weatherParticleGeometry("snow");
    expect(snow).toMatchObject({ width: 9, height: 9, radius: 4, rotate: 11.25, opacityDecay: 3 });
    expect(snow.dx).toBeCloseTo(-3 * Math.sin(Math.PI / 16), 12);
    expect(snow.dy).toBeCloseTo(3 * Math.cos(Math.PI / 16), 12);
    expect(weatherParticleVector("snow", 0)).toEqual(weatherParticleVector("snow", 48));
  });

  test("particles move and fade from deterministic respawn state", () => {
    for (const kind of ["rain", "storm", "snow"] as const) {
      const geometry = weatherParticleGeometry(kind);
      const atZero = weatherParticles(weather({ kind, clock: 0 }), 480, 272)[0]!;
      const atOne = weatherParticles(weather({ kind, clock: 1 }), 480, 272)[0]!;
      expect(atZero).toMatchObject({
        width: geometry.width,
        height: geometry.height,
        radius: geometry.radius,
        rotate: geometry.rotate,
        color: "#ffffff",
      });
      expect(atZero).not.toHaveProperty("tailColor");
      expect(atOne.x - atZero.x).toBeCloseTo(geometry.dx, 12);
      expect(atOne.y - atZero.y).toBeCloseTo(geometry.dy, 12);
      expect(atZero.opacity - atOne.opacity).toBeCloseTo(geometry.opacityDecay / 255, 12);
    }
  });

  test("opacity below 40 respawns from the deterministic random stream", () => {
    const frames = Array.from({ length: 80 }, (_, clock) =>
      weatherParticles(weather({ fromPower: 0.1, targetPower: 0.1, kind: "rain", clock }), 480, 272)[0]!);
    const respawn = frames.findIndex((particle, clock) =>
      clock > 0 && particle.opacity > frames[clock - 1]!.opacity);
    expect(respawn).toBeGreaterThan(0);
    expect(frames[respawn - 1]!.opacity).toBeGreaterThanOrEqual(40 / 255);
    expect(frames[respawn]!.opacity).toBeGreaterThanOrEqual(160 / 255);
    expect(frames[respawn]!.opacity).toBeLessThan(220 / 255);
    expect(frames[respawn]!.x).toBeGreaterThanOrEqual(-100);
    expect(frames[respawn]!.x).toBeLessThan(480);
    expect(frames[respawn]!.y).toBeGreaterThanOrEqual(-200);
    expect(frames[respawn]!.y).toBeLessThan(272);
  });

  test("weather dimmer uses tweened power independently of particles", () => {
    expect(WEATHER_DIMMER_COLOR).toBe("#505050");
    expect(weatherDimmerOpacity(undefined)).toBe(0);
    expect(weatherDimmerOpacity(weather({ fromPower: 2, targetPower: 6, total: 8, left: 4 })))
      .toBe(24 / 255);
  });

  test("seed, clock and viewport are the only particle inputs", () => {
    const descriptor = weather();
    const first = weatherParticles(descriptor, 480, 272);
    expect(weatherParticles({ ...descriptor }, 480, 272)).toEqual(first);
    expect(weatherParticles({ ...descriptor, clock: descriptor.clock + 1 }, 480, 272)).not.toEqual(first);
    expect(weatherParticles({ ...descriptor, seed: descriptor.seed + 1 }, 480, 272)).not.toEqual(first);
    expect(screenToneWeatherActive(undefined)).toBe(false);
    expect(screenToneWeatherActive({ weather: descriptor })).toBe(true);
  });
});

describe("runtime window tone", () => {
  test("missing and RGB-neutral tones keep the caller's exact theme reference", () => {
    const theme: Partial<UiTheme> = { paper: "#102030" };
    expect(windowToneTheme(theme, undefined)).toBe(theme);
    expect(windowToneTheme(theme, { r: 0, g: 0, b: 0, gray: 0 })).toBe(theme);
    expect(windowToneTheme(theme, { r: 0, g: 0, b: 0, gray: 255 })).toBe(theme);
    expect(windowToneTheme(undefined, undefined)).toBeUndefined();
  });

  test("tones chrome with RGB only while preserving text colours and alpha", () => {
    const theme: Partial<UiTheme> = {
      border: "#10203080",
      paper: "#ff0000",
      ink: "#abcdef",
      accent: "#fedcba",
    };
    const toned = windowToneTheme(theme, { r: -16, g: 16, b: 32, gray: 255 })!;
    expect(toned.paper).toBe("#ef1020");
    expect(toned.border).toBe("#00305080");
    expect(toned.ink).toBe("#abcdef");
    expect(toned.accent).toBe("#fedcba");

    const shifted = windowToneTheme({ paper: "#102030" }, { r: 32, g: -16, b: 100, gray: 0 })!;
    expect(shifted.paper).toBe("#301094");
  });
});

describe("atomic tileset presentation", () => {
  test("active tileset art takes precedence over generic built-in layer variants", () => {
    const generic: EagerMapLayerVariant = { chunks: { field: ["generic.png"] }, columns: { field: 1 } };
    const ground: EagerMapLayerVariant = { chunks: { field: ["frost-ground.png"] }, columns: { field: 1 } };
    const upper: EagerMapLayerVariant = { chunks: { field: ["frost-upper.png"] }, columns: { field: 1 } };
    const tileset = { ground, upper, animated: {} };
    expect(tilesetLayerSource(undefined, "ground", generic)).toBe(generic);
    expect(tilesetLayerSource(tileset, "ground", generic)).toBe(ground);
    expect(tilesetLayerSource(tileset, "upper", generic)).toBe(upper);
  });

  test("tile-image events resolve only when their active tileset has cooked art", () => {
    const variants = {
      "tile-1-4": { ts1: "tile-1-4", ts3: "tile-3-4" },
    };
    expect(tilesetEventSprite("tile-1-4", undefined, variants)).toBe("tile-1-4");
    expect(tilesetEventSprite("tile-1-4", "ts3", variants)).toBe("tile-3-4");
    expect(tilesetEventSprite("tile-1-4", "ts999", variants)).toBe("tile-1-4");
    expect(tilesetEventSprite("chr-hero", "ts3", variants)).toBe("chr-hero");
    expect(tilesetEventSprite(null, "ts3", variants)).toBeNull();
  });

  test("connected-world variants replace only the active map", () => {
    const base: StreamedMapLayerVariant = {
      refs: { left: ["left-base"], center: ["center-base"], right: ["right-base"] },
      columns: { left: 1, center: 1, right: 1 },
      chunkPx: 256,
    };
    const alternate: StreamedMapLayerVariant = {
      refs: { center: ["center-frost"] },
      columns: { center: 2 },
      chunkPx: 256,
    };
    expect(mapScopedLayerSource(base, alternate, "center")).toEqual({
      refs: { left: ["left-base"], center: ["center-frost"], right: ["right-base"] },
      columns: { left: 1, center: 2, right: 1 },
      chunkPx: 256,
    });

    const tile = (sprite: string): AnimatedTile => ({ x: 0, y: 0, above: false, sprite });
    expect(mapScopedAnimatedSource(
      { left: [tile("left-base")], center: [tile("center-base")], right: [tile("right-base")] },
      { center: [tile("center-frost")] },
      "center",
    )).toEqual({
      left: [tile("left-base")],
      center: [tile("center-frost")],
      right: [tile("right-base")],
    });
  });
});
