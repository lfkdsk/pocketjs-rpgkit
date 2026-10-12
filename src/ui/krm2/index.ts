// Explicit KRM2 presentation entry. Import from `pocket-rpgkit/ui/krm2` and
// pass `krm2ScreenPresentation` to GameView; the base UI entry does not pull
// these picture/HUD components into games that do not opt in.

import type { GameScreenPresentation } from "../GameView.tsx";
import { Krm2HudLayer } from "../Krm2HudLayer.tsx";
import { Krm2ScreenEffectsLayer } from "../Krm2ScreenEffectsLayer.tsx";
import { screenEffectsFingerprint } from "../krm2-ui.ts";

export const krm2ScreenPresentation: Readonly<GameScreenPresentation> = {
  fingerprint: screenEffectsFingerprint,
  effects: Krm2ScreenEffectsLayer,
  hud: Krm2HudLayer,
};

export { Krm2HudLayer, type Krm2HudLayerProps } from "../Krm2HudLayer.tsx";
export { Krm2PictureLayer } from "../Krm2PictureLayer.tsx";
export { Krm2ScreenEffectsLayer } from "../Krm2ScreenEffectsLayer.tsx";
export {
  ScreenToneWeatherLayer,
  type ScreenToneWeatherLayerProps,
} from "../ScreenToneWeatherLayer.tsx";
export {
  mapNameBannerOpacity,
  pictureRenderStyle,
  pictureToneOverlays,
  screenEffectsFingerprint,
  sortedPictures,
  timerHudText,
  type PictureRenderStyle,
  type PictureToneOverlay,
} from "../krm2-ui.ts";
export {
  screenToneOverlays,
  screenToneWeatherActive,
  WEATHER_DIMMER_COLOR,
  weatherDimmerOpacity,
  weatherParticleCount,
  weatherParticleGeometry,
  weatherParticleVector,
  weatherParticles,
  type WeatherParticle,
  type WeatherParticleGeometry,
  type WeatherParticleVector,
} from "../screen-presentation.ts";
