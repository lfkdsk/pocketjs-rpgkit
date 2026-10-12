// Viewport-space projection of reducer-owned screen presentation. Backdrops,
// tone/weather, tint and flash sit below dialogs (matching RPG Maker's
// spriteset effects); the independent fade is mounted separately above
// dialogs by GameView.

import { createMemo, Show, type Accessor, type JSX } from "solid-js";
import { Image, View } from "@pocketjs/framework/components";
import {
  colorAt,
  compositeScreenTints,
  type ScreenEffectsState,
} from "../engine/screen.ts";
import type { ScreenColor } from "../engine/types.ts";
import type { GameScreenLayerAssets, ScreenLayerVariant } from "./game-assets.ts";
import { ScreenToneWeatherLayer } from "./ScreenToneWeatherLayer.tsx";
import { screenToneWeatherActive } from "./screen-presentation.ts";

export interface ScreenEffectsLayerProps {
  screen: Accessor<ScreenEffectsState | undefined>;
  layers: Readonly<Record<string, GameScreenLayerAssets>>;
  /** Live logical viewport used only while deterministic weather exists.
   * Direct legacy callers may omit these and retain the 480x272 design size. */
  width?: Accessor<number>;
  height?: Accessor<number>;
  /** Optional opt-in screen content (for example RPG Maker numbered
   * pictures). It paints above the backdrop and below tint/flash. */
  children?: JSX.Element;
}

const DESIGN_WIDTH = (): number => 480;
const DESIGN_HEIGHT = (): number => 272;

function channelHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

export function screenColorHex(color: Readonly<ScreenColor>): string {
  return `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`;
}

function visibleColor(color: Readonly<ScreenColor>): {
  color: string;
  opacity: number;
  display: 0 | 1;
} {
  return {
    color: screenColorHex(color),
    opacity: color.a / 255,
    display: color.a > 0 ? 0 : 1,
  };
}

export function ScreenEffectsLayer(props: ScreenEffectsLayerProps) {
  const backdrop = createMemo((): ScreenLayerVariant | undefined => {
    const descriptor = props.screen()?.backdrop;
    if (!descriptor) return undefined;
    const layer = props.layers[descriptor.layer];
    if (!layer) {
      throw new Error(`GameView: backdrop layer ${JSON.stringify(descriptor.layer)} is not a screen layer`);
    }
    const variant = layer.variants[descriptor.variant];
    if (!variant) {
      throw new Error(
        `GameView: backdrop layer ${JSON.stringify(descriptor.layer)} has no variant ${JSON.stringify(descriptor.variant)}`,
      );
    }
    return variant;
  });
  const tint = createMemo(() => visibleColor(compositeScreenTints(props.screen()?.tints)));
  const flash = createMemo(() => visibleColor(
    props.screen()?.flash ? colorAt(props.screen()!.flash!) : { r: 0, g: 0, b: 0, a: 0 },
  ));

  return (
    <>
      <View
        class="absolute w-full h-full"
        style={{
          posType: 1,
          bgColor: backdrop()?.color ?? "#00000000",
          opacity: backdrop()?.opacity ?? 1,
          display: backdrop() === undefined ? 1 : 0,
        }}
        debugName="rpgkit-screen-backdrop"
      >
        <Image
          class="absolute w-full h-full"
          src={backdrop()?.image ?? ""}
          style={{ posType: 1, display: backdrop()?.image ? 0 : 1 }}
        />
      </View>
      <Show when={screenToneWeatherActive(props.screen())}>
        <ScreenToneWeatherLayer
          screen={props.screen}
          width={props.width ?? DESIGN_WIDTH}
          height={props.height ?? DESIGN_HEIGHT}
        />
      </Show>
      {/* MV creates weather and its tone changer in the lower spriteset,
          then mounts numbered pictures in the upper layer. Keep imported
          pictures unfiltered and above weather for the same painter order. */}
      {props.children}
      <View
        class="absolute w-full h-full"
        style={{ posType: 1, bgColor: tint().color, opacity: tint().opacity, display: tint().display }}
        debugName="rpgkit-screen-tint"
      />
      <View
        class="absolute w-full h-full"
        style={{ posType: 1, bgColor: flash().color, opacity: flash().opacity, display: flash().display }}
        debugName="rpgkit-screen-flash"
      />
    </>
  );
}

export function ScreenFadeLayer(props: { screen: Accessor<ScreenEffectsState | undefined> }) {
  const fade = createMemo(() => visibleColor(
    props.screen()?.fade ? colorAt(props.screen()!.fade!) : { r: 0, g: 0, b: 0, a: 0 },
  ));
  return (
    <View
      class="absolute w-full h-full"
      style={{ posType: 1, bgColor: fade().color, opacity: fade().opacity, display: fade().display }}
      debugName="rpgkit-screen-fade"
    />
  );
}
