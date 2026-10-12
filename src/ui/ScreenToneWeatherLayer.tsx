// Shared map/battle projection for RPG Maker screen tone and weather.

import { createMemo, Index, Show, type Accessor } from "solid-js";
import { View } from "@pocketjs/framework/components";
import type { ScreenEffectsState } from "../engine/screen.ts";
import {
  screenToneOverlays,
  WEATHER_DIMMER_COLOR,
  weatherDimmerOpacity,
  weatherParticles,
} from "./screen-presentation.ts";

export interface ScreenToneWeatherLayerProps {
  screen: Accessor<Readonly<ScreenEffectsState> | undefined>;
  width: Accessor<number>;
  height: Accessor<number>;
}

/** Ordinary View nodes only: PocketJS currently has no portable colour
 * matrix/desaturation primitive or backend-independent particle emitter. */
export function ScreenToneWeatherLayer(props: ScreenToneWeatherLayerProps) {
  const tone = createMemo(() => screenToneOverlays(props.screen()?.tone));
  const dimmer = createMemo(() => weatherDimmerOpacity(props.screen()?.weather));
  const particles = createMemo(() =>
    weatherParticles(props.screen()?.weather, props.width(), props.height()));

  return (
    <>
      <Index each={tone()}>
        {(overlay) => (
          <View
            class="absolute w-full h-full"
            style={{ posType: 1, bgColor: overlay().color, opacity: overlay().opacity }}
            debugName={`rpgkit-screen-tone-${overlay().kind}`}
          />
        )}
      </Index>
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
