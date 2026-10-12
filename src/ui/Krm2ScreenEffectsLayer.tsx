// Opt-in RPG Maker Game_Screen presentation. Keeping tone/weather and
// numbered pictures behind one injected component prevents ordinary
// GameView consumers from admitting their projection code to the bundle.

import { Show } from "solid-js";
import type { GameScreenPresentationProps } from "./GameView.tsx";
import { Krm2PictureLayer } from "./Krm2PictureLayer.tsx";
import { ScreenToneWeatherLayer } from "./ScreenToneWeatherLayer.tsx";
import { screenToneWeatherActive } from "./screen-presentation.ts";

export function Krm2ScreenEffectsLayer(props: GameScreenPresentationProps) {
  return (
    <>
      <Show when={screenToneWeatherActive(props.screen())}>
        <ScreenToneWeatherLayer
          screen={props.screen}
          width={props.width}
          height={props.height}
        />
      </Show>
      {/* MV creates weather and its tone changer in the lower spriteset,
          then mounts numbered pictures in the upper layer. */}
      <Krm2PictureLayer {...props} />
    </>
  );
}
