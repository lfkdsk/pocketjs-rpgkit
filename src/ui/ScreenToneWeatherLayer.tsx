// Shared map/battle projection for RPG Maker screen tone and weather.

import { createMemo, Index, Show, type Accessor } from "solid-js";
import { View } from "@pocketjs/framework/components";
import type { ScreenEffectsState } from "../engine/screen.ts";
import {
  screenToneFallbackOverlays,
  screenToneStyle,
  WEATHER_DIMMER_COLOR,
  weatherDimmerOpacity,
  weatherParticles,
} from "./screen-presentation.ts";
import { nativeRenderEffectsSupported } from "./render-effects.ts";

export interface ScreenToneWeatherLayerProps {
  screen: Accessor<Readonly<ScreenEffectsState> | undefined>;
  width: Accessor<number>;
  height: Accessor<number>;
}

/** Screen tone is one exact destination operation; weather remains a stable
 * pool of ordinary View nodes because PocketJS has no particle emitter. */
export function ScreenToneWeatherLayer(props: ScreenToneWeatherLayerProps) {
  const tone = createMemo(() => screenToneStyle(props.screen()?.tone));
  const fallbackTone = createMemo(() => screenToneFallbackOverlays(props.screen()?.tone));
  const nativeTone = nativeRenderEffectsSupported();
  const dimmer = createMemo(() => weatherDimmerOpacity(props.screen()?.weather));
  const particles = createMemo(() =>
    weatherParticles(props.screen()?.weather, props.width(), props.height()));

  return (
    <>
      <Show when={props.screen()?.tone}>
        <Show
          when={nativeTone}
          fallback={
            <Index each={fallbackTone()}>
              {(overlay) => (
                <View
                  class="absolute w-full h-full"
                  style={{ posType: 1, bgColor: overlay().color, opacity: overlay().opacity }}
                  debugName={`rpgkit-screen-tone-fallback-${overlay().kind}`}
                />
              )}
            </Index>
          }
        >
          <View
            class="absolute w-full h-full"
            style={{ posType: 1, ...tone() }}
            debugName="rpgkit-screen-tone-filter"
          />
        </Show>
      </Show>
      <Show when={dimmer() > 0}>
        <View
          class="absolute w-full h-full"
          style={{ posType: 1, bgColor: WEATHER_DIMMER_COLOR, opacity: dimmer() }}
          debugName="rpgkit-weather-dimmer"
        />
      </Show>
      <Index each={particles()}>
        {(particle, index) => (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: particle().x,
              insetT: particle().y,
              width: particle().width,
              height: particle().height,
              radius: particle().radius,
              rotate: particle().rotate,
              bgColor: particle().color,
              opacity: particle().opacity,
            }}
            debugName={`rpgkit-weather-particle-${index}`}
          />
        )}
      </Index>
    </>
  );
}
