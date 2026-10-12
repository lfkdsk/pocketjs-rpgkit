// Pure, portable projection of reducer-owned RPG Maker screen presentation.
//
// The reducer stores only a tone tween and one compact weather emitter. This
// module turns those JSON descriptors into ordinary source-over overlays and
// viewport-space particles. No host clock, random source or component-local
// state participates, so a save/rewind at the same screen clock paints the
// same result on every backend.

import type {
  ScreenEffectsState,
  ToneTweenState,
  WeatherEffectState,
} from "../engine/screen.ts";
import type { ScreenTone, WeatherKind } from "../engine/types.ts";
import { toneOverlays, type ToneOverlay } from "./tone-overlay.ts";

const ZERO_SCREEN_TONE: Readonly<ScreenTone> = Object.freeze({ r: 0, g: 0, b: 0, gray: 0 });

function screenToneAt(tone: Readonly<ToneTweenState> | undefined): ScreenTone {
  if (!tone) return { ...ZERO_SCREEN_TONE };
  if (tone.total <= 0 || tone.left <= 0) return { ...tone.to };
  const elapsed = tone.total - tone.left;
  const channel = (from: number, to: number): number =>
    (from * (tone.total - elapsed) + to * elapsed) / tone.total;
  return {
    r: channel(tone.from.r, tone.to.r),
    g: channel(tone.from.g, tone.to.g),
    b: channel(tone.from.b, tone.to.b),
    gray: channel(tone.from.gray, tone.to.gray),
  };
}

function weatherPowerAt(weather: Readonly<WeatherEffectState> | undefined): number {
  if (!weather) return 0;
  if (weather.total <= 0 || weather.left <= 0) return weather.targetPower;
  const elapsed = weather.total - weather.left;
  return (weather.fromPower * (weather.total - elapsed) + weather.targetPower * elapsed) /
    weather.total;
}

export interface WeatherParticleVector {
  dx: number;
  dy: number;
}

export interface WeatherParticleGeometry extends WeatherParticleVector {
  width: number;
  height: number;
  radius: number;
  rotate: number;
  opacityDecay: number;
}

export interface WeatherParticle {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  rotate: number;
  color: string;
  opacity: number;
}

const WEATHER_PARTICLES_PER_POWER = 10;
const WEATHER_RANDOM_PERIOD = 64;
const WEATHER_RESPAWN_OPACITY = 40;
export const WEATHER_DIMMER_COLOR = "#505050";

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** Stable 32-bit mixer. Inputs are serialized integers, never host entropy. */
function weatherHash(seed: number, index: number, salt: number): number {
  let value = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b) >>> 0;
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

/** RPG Maker floors `power * 10` for its weather sprite pool. */
export function weatherParticleCount(power: number): number {
  const bounded = clamp(Number.isFinite(power) ? power : 0, 0, 9);
  return Math.floor(bounded * WEATHER_PARTICLES_PER_POWER);
}

/** Exact RPG Maker bitmap geometry, rotation and per-tick motion/fade. */
export function weatherParticleGeometry(
  kind: Exclude<WeatherKind, "none">,
): WeatherParticleGeometry {
  if (kind === "rain") {
    return {
      width: 1,
      height: 60,
      radius: 0,
      rotate: 11.25,
      dx: -6 * Math.sin(Math.PI / 16),
      dy: 6 * Math.cos(Math.PI / 16),
      opacityDecay: 6,
    };
  }
  if (kind === "storm") {
    return {
      width: 2,
      height: 100,
      radius: 0,
      rotate: 22.5,
      dx: -8 * Math.sin(Math.PI / 8),
      dy: 8 * Math.cos(Math.PI / 8),
      opacityDecay: 8,
    };
  }
  return {
    width: 9,
    height: 9,
    radius: 4,
    rotate: 11.25,
    dx: -3 * Math.sin(Math.PI / 16),
    dy: 3 * Math.cos(Math.PI / 16),
    opacityDecay: 3,
  };
}

export function weatherParticleVector(
  kind: Exclude<WeatherKind, "none">,
  _clock = 0,
  _phase = 0,
): WeatherParticleVector {
  const { dx, dy } = weatherParticleGeometry(kind);
  return { dx, dy };
}

function spawnHash(seed: number, index: number, generation: number, salt: number): number {
  return weatherHash(
    seed ^ Math.imul((generation + 1) >>> 0, 0x27d4eb2d),
    index,
    salt,
  );
}

function spawnOpacity(seed: number, index: number, generation: number): number {
  return 160 + spawnHash(seed, index, generation % WEATHER_RANDOM_PERIOD, 0xd3a2646c) % 60;
}

function particleLife(opacity: number, decay: number): number {
  return Math.floor((opacity - WEATHER_RESPAWN_OPACITY) / decay) + 1;
}

/** Resolve one particle's respawn generation and age without replaying every
 * reference tick. Opacity/lifetime uses a 64-entry deterministic random
 * stream; period skipping is O(64), while absolute generations still produce
 * fresh deterministic x/y coordinates. */
function particleGeneration(
  seed: number,
  index: number,
  clock: number,
  decay: number,
): { generation: number; age: number; opacity: number } {
  let periodTicks = 0;
  for (let generation = 0; generation < WEATHER_RANDOM_PERIOD; generation++) {
    periodTicks += particleLife(spawnOpacity(seed, index, generation), decay);
  }
  const safeClock = Math.max(0, Math.floor(clock));
  const period = Math.floor(safeClock / periodTicks);
  let age = safeClock % periodTicks;
  let slot = 0;
  let opacity = spawnOpacity(seed, index, slot);
  let ticks = particleLife(opacity, decay);
  while (slot < WEATHER_RANDOM_PERIOD - 1 && age >= ticks) {
    age -= ticks;
    slot++;
    opacity = spawnOpacity(seed, index, slot);
    ticks = particleLife(opacity, decay);
  }
  return {
    generation: period * WEATHER_RANDOM_PERIOD + slot,
    age,
    opacity,
  };
}

function particleAt(
  weather: Readonly<WeatherEffectState>,
  index: number,
  viewportWidth: number,
  viewportHeight: number,
): WeatherParticle {
  if (weather.kind === "none") throw new Error("weather particle projection requires a visible kind");
  const geometry = weatherParticleGeometry(weather.kind);
  const life = particleGeneration(weather.seed, index, weather.clock, geometry.opacityDecay);
  const xRange = Math.max(1, Math.floor(viewportWidth) + 100);
  const yRange = Math.max(1, Math.floor(viewportHeight) + 200);
  const baseX = spawnHash(weather.seed, index, life.generation, 0x51ed270b) % xRange - 100;
  const baseY = spawnHash(weather.seed, index, life.generation, 0x7f4a7c15) % yRange - 200;
  return {
    x: baseX + geometry.dx * life.age,
    y: baseY + geometry.dy * life.age,
    width: geometry.width,
    height: geometry.height,
    radius: geometry.radius,
    rotate: geometry.rotate,
    color: "#ffffff",
    opacity: (life.opacity - geometry.opacityDecay * life.age) / 255,
  };
}

/** RPG Maker's weather dimmer sits behind particles and scales with tweened
 * power independently of the integer particle count. */
export function weatherDimmerOpacity(weather: Readonly<WeatherEffectState> | undefined): number {
  return weather && weather.kind !== "none"
    ? Math.floor(clamp(weatherPowerAt(weather), 0, 9) * 6) / 255
    : 0;
}

/** Pure particle projection. The result is empty for an absent/zero emitter,
 * and its count, placement and direction depend only on serialized state and
 * the logical viewport. */
export function weatherParticles(
  weather: Readonly<WeatherEffectState> | undefined,
  viewportWidth: number,
  viewportHeight: number,
): WeatherParticle[] {
  if (!weather || weather.kind === "none" || viewportWidth <= 0 || viewportHeight <= 0) return [];
  const count = weatherParticleCount(weatherPowerAt(weather));
  return Array.from({ length: count }, (_, index) =>
    particleAt(weather, index, viewportWidth, viewportHeight));
}

/** Screen tone uses the same documented PocketJS source-over approximation
 * as picture tone: neutral gray, complementary darkening, then brightening. */
export function screenToneOverlays(
  tone: Readonly<ToneTweenState> | undefined,
): ToneOverlay[] {
  return tone ? toneOverlays(screenToneAt(tone)) : [];
}

/** Cheap gate used by both map and battle render stacks. */
export function screenToneWeatherActive(
  screen: Readonly<ScreenEffectsState> | undefined,
): boolean {
  return screen?.tone !== undefined || screen?.weather !== undefined;
}
