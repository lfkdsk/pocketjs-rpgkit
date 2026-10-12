// Viewport-space projection of reducer-owned base screen presentation.
// Backdrops, optional capability-owned children, tint and flash sit below
// dialogs; the independent fade is mounted separately above dialogs by
// GameView.

import { createMemo, type Accessor, type JSX } from "solid-js";
import { Image, View } from "@pocketjs/framework/components";
import {
  colorAt,
  compositeScreenTints,
  type ScreenEffectsState,
} from "../engine/screen.ts";
import type { ScreenColor } from "../engine/types.ts";
import type { GameScreenLayerAssets, ScreenLayerVariant } from "./game-assets.ts";

export interface ScreenEffectsLayerProps {
  screen: Accessor<ScreenEffectsState | undefined>;
  layers: Readonly<Record<string, GameScreenLayerAssets>>;
  /** Optional opt-in screen content (for example RPG Maker numbered
   * pictures, tone and weather). It paints above the backdrop and below
   * kit-native tint/flash. */
  children?: JSX.Element;
}

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
