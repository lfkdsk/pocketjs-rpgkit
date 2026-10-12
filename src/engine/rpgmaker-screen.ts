// Optional RPG Maker tone/weather rules. Keeping interpolation and emitter
// clocks out of screen.ts prevents ordinary projects from evaluating them.

import type {
  ScreenEffectsState,
  ToneTweenState,
  WeatherEffectState,
} from "./screen.ts";
import type { ScreenTone, WeatherKind } from "./types.ts";

const ZERO_SCREEN_TONE: Readonly<ScreenTone> = Object.freeze({ r: 0, g: 0, b: 0, gray: 0 });

export function screenToneAt(tone: Readonly<ToneTweenState> | undefined): ScreenTone {
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

export function weatherPowerAt(weather: Readonly<WeatherEffectState> | undefined): number {
  if (!weather) return 0;
  if (weather.total <= 0 || weather.left <= 0) return weather.targetPower;
  const elapsed = weather.total - weather.left;
  return (weather.fromPower * (weather.total - elapsed) + weather.targetPower * elapsed) /
    weather.total;
}

export function startScreenTone(
  screen: ScreenEffectsState,
  target: Readonly<ScreenTone>,
  frames: number,
): void {
  const from = screenToneAt(screen.tone);
  if (frames === 0 && target.r === 0 && target.g === 0 && target.b === 0 && target.gray === 0) {
    delete screen.tone;
    return;
  }
  screen.tone = {
    from: frames === 0 ? { ...target } : from,
    to: { ...target },
    total: frames,
    left: frames,
  };
}

export function startWeather(
  screen: ScreenEffectsState,
  kind: WeatherKind,
  power: number,
  frames: number,
  seed: number,
): void {
  const prior = screen.weather;
  const fromPower = weatherPowerAt(prior);
  const targetPower = kind === "none" ? 0 : Math.max(0, Math.min(9, power));
  if (frames === 0 && kind === "none") {
    delete screen.weather;
    return;
  }
  const visibleKind = kind === "none" && frames > 0 ? prior?.kind ?? "none" : kind;
  if (visibleKind === "none" && targetPower === 0) {
    delete screen.weather;
    return;
  }
  screen.weather = {
    kind: visibleKind,
    fromPower: frames === 0 ? targetPower : fromPower,
    targetPower,
    total: frames,
    left: frames,
    seed: prior && prior.kind === visibleKind ? prior.seed : seed >>> 0,
    clock: prior?.clock ?? 0,
  };
}

export function advanceRpgMakerScreenEffects(screen: ScreenEffectsState): void {
  if (screen.tone) {
    if (screen.tone.left > 0) screen.tone.left--;
    if (screen.tone.left === 0) {
      const to = { ...screen.tone.to };
      if (to.r === 0 && to.g === 0 && to.b === 0 && to.gray === 0) delete screen.tone;
      else screen.tone = { from: to, to: { ...to }, total: 0, left: 0 };
    }
  }
  if (screen.weather) {
    screen.weather.clock++;
    if (screen.weather.left > 0) screen.weather.left--;
    if (screen.weather.left === 0) {
      const power = screen.weather.targetPower;
      if (power <= 0) delete screen.weather;
      else {
        screen.weather.fromPower = power;
        screen.weather.total = 0;
      }
    }
  }
}
