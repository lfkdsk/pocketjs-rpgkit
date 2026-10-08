// src/engine/screen.ts — deterministic, saveable map-presentation effects.
//
// Every duration is compiled to the fixed 60 Hz reference clock before it
// reaches this module. The reducer stores only JSON values and advances them
// one reference tick at a time: no host clock, CSS animation or random source
// participates. The UI merely projects these descriptors into pixels.

import { keyedRecord } from "./clone.ts";
import type {
  PictureBlendMode,
  PictureOrigin,
  PictureTone,
  ScreenColor,
} from "./types.ts";

export const TRANSPARENT_BLACK: Readonly<ScreenColor> = Object.freeze({ r: 0, g: 0, b: 0, a: 0 });
export const OPAQUE_BLACK: Readonly<ScreenColor> = Object.freeze({ r: 0, g: 0, b: 0, a: 255 });

export interface ColorTweenState {
  from: ScreenColor;
  to: ScreenColor;
  total: number;
  left: number;
}

export interface FadeEffectState extends ColorTweenState {
  /** Fade-in removes the retained mask at the end; fade-out keeps it. */
  clear: boolean;
}

export interface ShakeEffectState {
  strength: number;
  /** Complete horizontal cycles per virtual second. */
  speed: number;
  total: number;
  left: number;
}

export interface CameraEffectState {
  /** `follow` removes this descriptor at completion and resumes live player
   * follow. `fixed` retains the destination focus after the tween. */
  mode: "fixed" | "follow";
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  total: number;
  left: number;
}

export interface BalloonEffectState {
  target: "player" | { event: string };
  icon: string;
  /** Last resolved tile, used only if a followed event disappears. */
  x: number;
  y: number;
  /** Reference ticks already displayed. */
  age: number;
  /** null means persistent until an explicit clear. */
  left: number | null;
}

export interface ScreenBackdropState {
  /** GameAssets.layers key; it must have placement:"screen". */
  layer: string;
  /** Prepackaged variant in that screen layer. */
  variant: string;
}

export interface PictureTransformState {
  x: number;
  y: number;
  /** Percent, with 100 as identity. */
  scaleX: number;
  scaleY: number;
  /** 0..255. */
  opacity: number;
}

export interface PictureMoveState {
  from: PictureTransformState;
  to: PictureTransformState;
  total: number;
  left: number;
  easing: "linear" | "easeIn" | "easeOut" | "easeInOut";
}

export interface PictureToneTweenState {
  from: PictureTone;
  to: PictureTone;
  total: number;
  left: number;
}

/** One numbered viewport picture. `transform` and `tone` hold the last
 * committed values; optional tween records derive the in-flight values from
 * the saved reference clock. */
export interface PictureState {
  id: number;
  layer: string;
  variant: string;
  origin: PictureOrigin;
  blend: PictureBlendMode;
  transform: PictureTransformState;
  tone: PictureTone;
  /** Clockwise degrees, normalized to [0,360). */
  rotation: number;
  /** Clockwise degrees per fixed 60 Hz reference tick. */
  rotationSpeed: number;
  move?: PictureMoveState;
  tint?: PictureToneTweenState;
}

export interface MapNameBannerState {
  text: string;
  total: number;
  left: number;
}

/** Sparse presentation state. It is omitted entirely for projects which do
 * not use these commands, keeping their save shape and hot path unchanged. */
export interface ScreenEffectsState {
  fade?: FadeEffectState;
  tints?: Record<string, ColorTweenState>;
  flash?: ColorTweenState;
  shake?: ShakeEffectState;
  camera?: CameraEffectState;
  balloons?: Record<string, BalloonEffectState>;
  backdrop?: ScreenBackdropState;
  pictures?: Record<string, PictureState>;
  mapNameBanner?: MapNameBannerState;
}

function cloneColor(color: Readonly<ScreenColor>): ScreenColor {
  return { r: color.r, g: color.g, b: color.b, a: color.a };
}

function cloneTween<T extends ColorTweenState>(tween: T): T {
  return { ...tween, from: cloneColor(tween.from), to: cloneColor(tween.to) };
}

export function cloneScreenEffects(source: ScreenEffectsState | undefined): ScreenEffectsState | undefined {
  if (!source) return undefined;
  const out: ScreenEffectsState = {};
  if (source.fade) out.fade = cloneTween(source.fade);
  if (source.tints) {
    const tints = keyedRecord<ColorTweenState>();
    for (const id of Object.keys(source.tints)) tints[id] = cloneTween(source.tints[id]!);
    out.tints = tints;
  }
  if (source.flash) out.flash = cloneTween(source.flash);
  if (source.shake) out.shake = { ...source.shake };
  if (source.camera) out.camera = { ...source.camera };
  if (source.balloons) {
    const balloons = keyedRecord<BalloonEffectState>();
    for (const id of Object.keys(source.balloons)) {
      const balloon = source.balloons[id]!;
      balloons[id] = {
        ...balloon,
        target: typeof balloon.target === "string" ? balloon.target : { ...balloon.target },
      };
    }
    out.balloons = balloons;
  }
  if (source.backdrop) out.backdrop = { ...source.backdrop };
  if (source.pictures) {
    const pictures = keyedRecord<PictureState>();
    for (const id of Object.keys(source.pictures)) {
      const picture = source.pictures[id]!;
      pictures[id] = {
        ...picture,
        transform: { ...picture.transform },
        tone: { ...picture.tone },
        ...(picture.move ? {
          move: {
            ...picture.move,
            from: { ...picture.move.from },
            to: { ...picture.move.to },
          },
        } : {}),
        ...(picture.tint ? {
          tint: {
            ...picture.tint,
            from: { ...picture.tint.from },
            to: { ...picture.tint.to },
          },
        } : {}),
      };
    }
    out.pictures = pictures;
  }
  if (source.mapNameBanner) out.mapNameBanner = { ...source.mapNameBanner };
  return out;
}

export function screenEffectsEmpty(screen: ScreenEffectsState): boolean {
  return screen.fade === undefined && screen.tints === undefined &&
    screen.flash === undefined && screen.shake === undefined &&
    screen.camera === undefined && screen.balloons === undefined &&
    screen.backdrop === undefined && screen.pictures === undefined &&
    screen.mapNameBanner === undefined;
}

export function colorAt(tween: Readonly<ColorTweenState>): ScreenColor {
  if (tween.total <= 0 || tween.left <= 0) return cloneColor(tween.to);
  const elapsed = tween.total - tween.left;
  const channel = (from: number, to: number): number =>
    Math.round((from * (tween.total - elapsed) + to * elapsed) / tween.total);
  return {
    r: channel(tween.from.r, tween.to.r),
    g: channel(tween.from.g, tween.to.g),
    b: channel(tween.from.b, tween.to.b),
    a: channel(tween.from.a, tween.to.a),
  };
}

/** Flatten named tint layers in stable id order. Because every layer is a
 * uniform source-over colour, one equivalent RGBA overlay is sufficient for
 * the renderer and avoids a variable number of native nodes. */
export function compositeScreenTints(
  tints: Readonly<Record<string, ColorTweenState>> | undefined,
): ScreenColor {
  if (!tints) return { ...TRANSPARENT_BLACK };
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const id of Object.keys(tints).sort()) {
    const color = colorAt(tints[id]!);
    const sourceAlpha = color.a / 255;
    const keep = 1 - sourceAlpha;
    red = color.r * sourceAlpha + red * keep;
    green = color.g * sourceAlpha + green * keep;
    blue = color.b * sourceAlpha + blue * keep;
    alpha = sourceAlpha + alpha * keep;
  }
  if (alpha <= 0) return { ...TRANSPARENT_BLACK };
  return {
    r: Math.round(red / alpha),
    g: Math.round(green / alpha),
    b: Math.round(blue / alpha),
    a: Math.round(alpha * 255),
  };
}

function tween(from: Readonly<ScreenColor>, to: Readonly<ScreenColor>, frames: number): ColorTweenState {
  return { from: cloneColor(from), to: cloneColor(to), total: frames, left: frames };
}

const ZERO_TONE: Readonly<PictureTone> = Object.freeze({ r: 0, g: 0, b: 0, gray: 0 });

function easingProgress(kind: PictureMoveState["easing"], elapsed: number, total: number): number {
  if (total <= 0) return 1;
  const t = Math.max(0, Math.min(1, elapsed / total));
  switch (kind) {
    case "easeIn": return t * t;
    case "easeOut": return 1 - (1 - t) * (1 - t);
    case "easeInOut": return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    case "linear": return t;
  }
}

/** In-flight transform at this saved tick. Exported for the renderer and
 * tests; it never mutates the descriptor. */
export function pictureTransformAt(picture: Readonly<PictureState>): PictureTransformState {
  const move = picture.move;
  if (!move || move.total <= 0 || move.left <= 0) return { ...picture.transform };
  const progress = easingProgress(move.easing, move.total - move.left, move.total);
  const channel = (from: number, to: number): number => from + (to - from) * progress;
  return {
    x: channel(move.from.x, move.to.x),
    y: channel(move.from.y, move.to.y),
    scaleX: channel(move.from.scaleX, move.to.scaleX),
    scaleY: channel(move.from.scaleY, move.to.scaleY),
    opacity: channel(move.from.opacity, move.to.opacity),
  };
}

export function pictureToneAt(picture: Readonly<PictureState>): PictureTone {
  const tint = picture.tint;
  if (!tint || tint.total <= 0 || tint.left <= 0) return { ...picture.tone };
  const elapsed = tint.total - tint.left;
  const channel = (from: number, to: number): number =>
    Math.round((from * (tint.total - elapsed) + to * elapsed) / tint.total);
  return {
    r: channel(tint.from.r, tint.to.r),
    g: channel(tint.from.g, tint.to.g),
    b: channel(tint.from.b, tint.to.b),
    gray: channel(tint.from.gray, tint.to.gray),
  };
}

export interface ShowPictureOptions extends PictureTransformState {
  id: number;
  layer: string;
  variant: string;
  origin: PictureOrigin;
  blend: PictureBlendMode;
}

export function showPicture(screen: ScreenEffectsState, options: Readonly<ShowPictureOptions>): void {
  if (!screen.pictures) screen.pictures = keyedRecord();
  screen.pictures[String(options.id)] = {
    id: options.id,
    layer: options.layer,
    variant: options.variant,
    origin: options.origin,
    blend: options.blend,
    transform: {
      x: options.x,
      y: options.y,
      scaleX: options.scaleX,
      scaleY: options.scaleY,
      opacity: options.opacity,
    },
    tone: { ...ZERO_TONE },
    rotation: 0,
    rotationSpeed: 0,
  };
}

export function movePicture(
  screen: ScreenEffectsState,
  id: number,
  target: Readonly<PictureTransformState>,
  frames: number,
  origin?: PictureOrigin,
  blend?: PictureBlendMode,
  easing: PictureMoveState["easing"] = "linear",
): void {
  const picture = screen.pictures?.[String(id)];
  if (!picture) return;
  const from = pictureTransformAt(picture);
  picture.transform = frames === 0 ? { ...target } : from;
  if (origin !== undefined) picture.origin = origin;
  if (blend !== undefined) picture.blend = blend;
  if (frames === 0) delete picture.move;
  else picture.move = { from, to: { ...target }, total: frames, left: frames, easing };
}

export function rotatePicture(screen: ScreenEffectsState, id: number, speed: number): void {
  const picture = screen.pictures?.[String(id)];
  if (picture) picture.rotationSpeed = speed;
}

export function tintPicture(
  screen: ScreenEffectsState,
  id: number,
  tone: Readonly<PictureTone>,
  frames: number,
): void {
  const picture = screen.pictures?.[String(id)];
  if (!picture) return;
  const from = pictureToneAt(picture);
  picture.tone = frames === 0 ? { ...tone } : from;
  if (frames === 0) delete picture.tint;
  else picture.tint = { from, to: { ...tone }, total: frames, left: frames };
}

export function erasePicture(screen: ScreenEffectsState, id: number): void {
  if (!screen.pictures) return;
  delete screen.pictures[String(id)];
  if (Object.keys(screen.pictures).length === 0) delete screen.pictures;
}

export function startMapNameBanner(screen: ScreenEffectsState, text: string, frames = 180): void {
  if (text.length === 0 || frames <= 0) {
    delete screen.mapNameBanner;
    return;
  }
  screen.mapNameBanner = { text, total: frames, left: frames };
}

/** Advance one visible map-presentation reference tick. */
export function advanceScreenEffects(
  screen: ScreenEffectsState | undefined,
): ScreenEffectsState | undefined {
  if (!screen) return undefined;

  const advanceTween = (value: ColorTweenState): void => {
    if (value.left > 0) value.left--;
  };

  if (screen.fade) {
    advanceTween(screen.fade);
    if (screen.fade.left === 0) {
      if (screen.fade.clear) delete screen.fade;
      else screen.fade = { ...tween(screen.fade.to, screen.fade.to, 0), clear: false };
    }
  }

  if (screen.tints) {
    for (const id of Object.keys(screen.tints)) {
      const tint = screen.tints[id]!;
      advanceTween(tint);
      if (tint.left === 0) {
        if (tint.to.a === 0) delete screen.tints[id];
        else screen.tints[id] = tween(tint.to, tint.to, 0);
      }
    }
    if (Object.keys(screen.tints).length === 0) delete screen.tints;
  }

  if (screen.flash) {
    advanceTween(screen.flash);
    if (screen.flash.left === 0) delete screen.flash;
  }
  if (screen.shake) {
    if (screen.shake.left > 0) screen.shake.left--;
    if (screen.shake.left === 0) delete screen.shake;
  }
  if (screen.camera) {
    if (screen.camera.left > 0) screen.camera.left--;
    if (screen.camera.left === 0) {
      if (screen.camera.mode === "follow") delete screen.camera;
      else {
        const { toX, toY } = screen.camera;
        screen.camera = {
          mode: "fixed",
          fromX: toX,
          fromY: toY,
          toX,
          toY,
          total: 0,
          left: 0,
        };
      }
    }
  }
  if (screen.balloons) {
    for (const id of Object.keys(screen.balloons)) {
      const balloon = screen.balloons[id]!;
      balloon.age++;
      if (balloon.left !== null) {
        balloon.left--;
        if (balloon.left <= 0) delete screen.balloons[id];
      }
    }
    if (Object.keys(screen.balloons).length === 0) delete screen.balloons;
  }
  if (screen.pictures) {
    for (const id of Object.keys(screen.pictures)) {
      const picture = screen.pictures[id]!;
      if (picture.move) {
        if (picture.move.left > 0) picture.move.left--;
        if (picture.move.left === 0) {
          picture.transform = { ...picture.move.to };
          delete picture.move;
        }
      }
      if (picture.tint) {
        if (picture.tint.left > 0) picture.tint.left--;
        if (picture.tint.left === 0) {
          picture.tone = { ...picture.tint.to };
          delete picture.tint;
        }
      }
      if (picture.rotationSpeed !== 0) {
        picture.rotation = ((picture.rotation + picture.rotationSpeed) % 360 + 360) % 360;
      }
    }
  }
  if (screen.mapNameBanner) {
    if (screen.mapNameBanner.left > 0) screen.mapNameBanner.left--;
    if (screen.mapNameBanner.left === 0) delete screen.mapNameBanner;
  }
  return screenEffectsEmpty(screen) ? undefined : screen;
}

/** Preserve global layers across a transfer. Projects may opt their camera
 * and player balloon into world ownership; otherwise both keep the original
 * per-map lifetime. Event balloons always name map-local characters. */
export function screenEffectsAfterTransfer(
  source: ScreenEffectsState | undefined,
  retainPresentation = false,
): ScreenEffectsState | undefined {
  const screen = cloneScreenEffects(source);
  if (!screen) return undefined;
  delete screen.flash;
  delete screen.shake;
  if (!retainPresentation) {
    delete screen.camera;
    delete screen.balloons;
  } else if (screen.balloons) {
    for (const id of Object.keys(screen.balloons)) {
      if (screen.balloons[id]!.target !== "player") delete screen.balloons[id];
    }
    if (Object.keys(screen.balloons).length === 0) delete screen.balloons;
  }
  delete screen.mapNameBanner;
  return screenEffectsEmpty(screen) ? undefined : screen;
}

export function startScreenFade(
  screen: ScreenEffectsState,
  direction: "out" | "in",
  color: Readonly<ScreenColor>,
  frames: number,
): void {
  const current = screen.fade ? colorAt(screen.fade) : null;
  if (direction === "out") {
    const from = current ?? { ...color, a: 0 };
    screen.fade = { ...tween(from, color, frames), clear: false };
    if (frames === 0) screen.fade = { ...tween(color, color, 0), clear: false };
    return;
  }
  const from = current ?? color;
  if (frames === 0) {
    delete screen.fade;
    return;
  }
  screen.fade = { ...tween(from, { ...color, a: 0 }, frames), clear: true };
}

export function startScreenTint(
  screen: ScreenEffectsState,
  layer: string,
  color: Readonly<ScreenColor>,
  frames: number,
): void {
  if (!screen.tints) screen.tints = keyedRecord();
  const prior = screen.tints[layer];
  const from = prior ? colorAt(prior) : { ...color, a: 0 };
  if (frames === 0 && color.a === 0) {
    delete screen.tints[layer];
    if (Object.keys(screen.tints).length === 0) delete screen.tints;
    return;
  }
  screen.tints[layer] = tween(frames === 0 ? color : from, color, frames);
}

export function startScreenFlash(
  screen: ScreenEffectsState,
  color: Readonly<ScreenColor>,
  intensity: number,
  frames: number,
): void {
  if (frames === 0 || intensity === 0 || color.a === 0) {
    delete screen.flash;
    return;
  }
  const peak = { ...color, a: Math.round(color.a * intensity / 255) };
  screen.flash = tween(peak, { ...peak, a: 0 }, frames);
}

export function startScreenShake(
  screen: ScreenEffectsState,
  strength: number,
  speed: number,
  frames: number,
): void {
  if (frames === 0 || strength === 0 || speed === 0) {
    delete screen.shake;
    return;
  }
  screen.shake = { strength, speed, total: frames, left: frames };
}

export interface Point {
  x: number;
  y: number;
}

export function cameraFocusAt(
  camera: Readonly<CameraEffectState> | undefined,
  player: Readonly<Point>,
): Point {
  if (!camera) return { x: player.x, y: player.y };
  if (camera.total <= 0 || camera.left <= 0) {
    return camera.mode === "follow" ? { x: player.x, y: player.y } : { x: camera.toX, y: camera.toY };
  }
  const elapsed = camera.total - camera.left;
  const toX = camera.mode === "follow" ? player.x : camera.toX;
  const toY = camera.mode === "follow" ? player.y : camera.toY;
  return {
    x: Math.round((camera.fromX * (camera.total - elapsed) + toX * elapsed) / camera.total),
    y: Math.round((camera.fromY * (camera.total - elapsed) + toY * elapsed) / camera.total),
  };
}

export function startCameraEffect(
  screen: ScreenEffectsState,
  mode: "fixed" | "follow",
  from: Readonly<Point>,
  to: Readonly<Point>,
  frames: number,
): void {
  if (mode === "follow" && frames === 0) {
    delete screen.camera;
    return;
  }
  screen.camera = {
    mode,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    total: frames,
    left: frames,
  };
}

/** Horizontal deterministic triangle wave. Screen overlays and HUD are not
 * displaced; GameView adds this after camera clamping to the map scene. */
export function screenShakeOffset(shake: Readonly<ShakeEffectState> | undefined): Point {
  if (!shake || shake.left <= 0 || shake.total <= 0) return { x: 0, y: 0 };
  const elapsed = shake.total - shake.left;
  const quarter = Math.floor(elapsed * shake.speed * 4 / 60) & 3;
  const phase = quarter === 1 ? 1 : quarter === 3 ? -1 : 0;
  return { x: Math.round(shake.strength * phase), y: 0 };
}

/** One stable key per target, matching Tuxemon's one-bubble-per-entity map. */
export function balloonTargetKey(target: BalloonEffectState["target"]): string {
  return target === "player" ? "player" : `event:${target.event}`;
}
