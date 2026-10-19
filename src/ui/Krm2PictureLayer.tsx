// Opt-in RPG Maker numbered-picture presentation. This module is kept out of
// GameView's static imports so games that never register KRM2 presentation do
// not bundle picture layout, tone projection or picture nodes.

import { createMemo } from "solid-js";
import { Image, View } from "@pocketjs/framework/components";
import type { PictureState } from "../engine/screen.ts";
import type { ScreenLayerVariant } from "./game-assets.ts";
import type { GameScreenPresentationProps } from "./GameView.tsx";
import {
  pictureImageEffects,
  pictureRenderStyle,
  pictureToneOverlays,
  sortedPictures,
  type PictureRenderStyle,
} from "./krm2-ui.ts";
import { nativeRenderEffectsSupported } from "./render-effects.ts";

export function Krm2PictureLayer(props: GameScreenPresentationProps) {
  const pictures = createMemo(() => sortedPictures(props.screen()?.pictures));
  const nativeEffects = nativeRenderEffectsSupported();

  const pictureVariant = (picture: Readonly<PictureState>): ScreenLayerVariant => {
    const layer = props.layers[picture.layer];
    if (!layer) {
      throw new Error(`GameView: picture layer ${JSON.stringify(picture.layer)} is not a screen layer`);
    }
    const variant = layer.variants[picture.variant];
    if (!variant) {
      throw new Error(
        `GameView: picture layer ${JSON.stringify(picture.layer)} has no variant ${JSON.stringify(picture.variant)}`,
      );
    }
    return variant;
  };

  return (
    <>
      {pictures().map((picture) => {
        const variant = (): ScreenLayerVariant => pictureVariant(picture);
        const layout = (): PictureRenderStyle =>
          pictureRenderStyle(picture, variant(), props.width(), props.height());
        const effects = () => pictureImageEffects(picture);
        const fallbackTone = () => pictureToneOverlays({
          r: effects().toneR,
          g: effects().toneG,
          b: effects().toneB,
          gray: effects().toneGray,
        });
        return (
          <View
            class="absolute"
            style={{
              posType: 1,
              insetL: layout().insetL,
              insetT: layout().insetT,
              width: layout().width,
              height: layout().height,
              scaleX: layout().scaleX,
              scaleY: layout().scaleY,
              rotate: layout().rotate,
              originX: layout().originX,
              originY: layout().originY,
              opacity: layout().opacity,
              overflow: 1,
              bgColor: variant().color ?? "#00000000",
            }}
            debugName={`rpgkit-picture-${picture.id}`}
          >
            <Image
              class="absolute w-full h-full"
              src={variant().image ?? ""}
              style={{
                posType: 1,
                display: variant().image ? 0 : 1,
                ...(nativeEffects
                  ? effects()
                  : { blendMode: 0, toneR: 0, toneG: 0, toneB: 0, toneGray: 0 }),
              }}
              debugName={`rpgkit-picture-${picture.id}-image`}
            />
            {!nativeEffects && fallbackTone().map((overlay) => (
              <View
                class="absolute w-full h-full"
                style={{ posType: 1, bgColor: overlay.color, opacity: overlay.opacity }}
                debugName={`rpgkit-picture-${picture.id}-tone-fallback-${overlay.kind}`}
              />
            ))}
          </View>
        );
      })}
    </>
  );
}
