// tools/rpgmaker-import/animation.ts — deterministic build-time compositor
// for RPG Maker MV's legacy 192 px cell animations. The runtime receives one
// already-composited static image per animation frame; it never needs to know
// about MV cells, transforms, hues, or blend modes.

import { downscale } from "./tile-render.ts";
import { blankImage, compositePixel, type RgbaImage } from "./image.ts";
import type { RmAnimation } from "./rm-types.ts";

export const MV_ANIMATION_CELL = 192;
export const MV_ANIMATION_COLUMNS = 5;
export const MV_ANIMATION_PATTERNS_PER_SHEET = 100;
export const MV_ANIMATION_RATE = 4;
export const MAX_COOKED_ANIMATION_FRAME = 256;

export interface MvAnimationSources {
  /** Decoded img/animations/<animation1Name>.png, or null when absent. */
  animation1?: RgbaImage | null;
  /** Decoded img/animations/<animation2Name>.png, or null when absent. */
  animation2?: RgbaImage | null;
}

/** The source sheet AnimationDef can reference plus render-only placement
 * metadata. offsetX/offsetY place the cooked frame's top-left relative to the
 * target tile's top-left; they are deliberately not project schema fields. */
export interface CookedMvAnimation {
  sheet: RgbaImage;
  frameW: number;
  frameH: number;
  cols: number;
  count: number;
  offsetX: number;
  offsetY: number;
  /** Semantic losses that should make command coverage Degraded. */
  degradations: string[];
  /** Non-fatal source facts worth surfacing in the import report. */
  warnings: string[];
}

export class MvAnimationCookError extends Error {
  readonly animationId: number;

  constructor(animation: Pick<RmAnimation, "id" | "name">, problem: string) {
    super(`animation ${animation.id}${animation.name ? ` (${animation.name})` : ""}: ${problem}`);
    this.name = "MvAnimationCookError";
    this.animationId = animation.id;
  }
}

type SourceSlot = 1 | 2;
type BlendMode = 0 | 1 | 2 | 3;

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Cell {
  slot: SourceSlot;
  pattern: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  mirror: boolean;
  opacity: number;
  blendMode: BlendMode;
  bounds: Bounds;
}

interface ValidatedSource {
  image: RgbaImage;
  hue: number;
}

const BLEND_NAMES: Readonly<Record<Exclude<BlendMode, 0>, string>> = {
  1: "add",
  2: "multiply",
  3: "screen",
};

function reject(animation: RmAnimation, problem: string): never {
  throw new MvAnimationCookError(animation, problem);
}

function finite(animation: RmAnimation, value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) reject(animation, `${at} must be a finite number`);
  return value;
}

function sourceName(animation: RmAnimation, slot: SourceSlot): string {
  return slot === 1 ? animation.animation1Name : animation.animation2Name;
}

function sourceHue(animation: RmAnimation, slot: SourceSlot): number {
  return slot === 1 ? animation.animation1Hue : animation.animation2Hue;
}

function suppliedSource(sources: MvAnimationSources, slot: SourceSlot): RgbaImage | null | undefined {
  return slot === 1 ? sources.animation1 : sources.animation2;
}

function validateSource(
  animation: RmAnimation,
  sources: MvAnimationSources,
  slot: SourceSlot,
  localPattern: number,
): ValidatedSource {
  const name = sourceName(animation, slot);
  if (typeof name !== "string" || name.length === 0) {
    reject(animation, `pattern ${slot === 1 ? localPattern : localPattern + 100} needs animation${slot}Name`);
  }
  const image = suppliedSource(sources, slot);
  if (!image) reject(animation, `missing img/animations/${name}.png`);
  const expectedWidth = MV_ANIMATION_CELL * MV_ANIMATION_COLUMNS;
  if (
    !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
    image.width !== expectedWidth || image.height < MV_ANIMATION_CELL ||
    image.height % MV_ANIMATION_CELL !== 0 ||
    image.height > MV_ANIMATION_CELL * (MV_ANIMATION_PATTERNS_PER_SHEET / MV_ANIMATION_COLUMNS)
  ) {
    reject(
      animation,
      `img/animations/${name}.png is ${image.width}x${image.height}; expected ${expectedWidth}px wide and 1..20 rows of ${MV_ANIMATION_CELL}px cells`,
    );
  }
  if (!(image.data instanceof Uint8Array) || image.data.length !== image.width * image.height * 4) {
    reject(animation, `img/animations/${name}.png has malformed RGBA data`);
  }
  const patterns = MV_ANIMATION_COLUMNS * (image.height / MV_ANIMATION_CELL);
  if (localPattern >= patterns) {
    reject(animation, `pattern ${slot === 1 ? localPattern : localPattern + 100} is outside img/animations/${name}.png (${patterns} patterns)`);
  }
  return { image, hue: sourceHue(animation, slot) };
}

function cellBounds(x: number, y: number, scale: number, rotation: number, mirror: boolean): Bounds {
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = (mirror ? -1 : 1) * scale / 100;
  const sy = scale / 100;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const half = MV_ANIMATION_CELL / 2;
  for (const py of [-half, half]) {
    for (const px of [-half, half]) {
      const tx = x + px * sx * cos - py * sy * sin;
      const ty = y + px * sx * sin + py * sy * cos;
      minX = Math.min(minX, tx);
      minY = Math.min(minY, ty);
      maxX = Math.max(maxX, tx);
      maxY = Math.max(maxY, ty);
    }
  }
  return { minX, minY, maxX, maxY };
}

function rotateHue(image: RgbaImage, degrees: number): RgbaImage {
  const hue = ((degrees % 360) + 360) % 360;
  if (hue === 0) return image;
  const data = image.data.slice();
  const shift = hue / 360;
  const hueToRgb = (p: number, q: number, t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const light = (max + min) / 2;
    if (max === min) continue;
    const delta = max - min;
    const saturation = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let h = max === r
      ? (g - b) / delta + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
    h = (h / 6 + shift) % 1;
    const q = light < 0.5 ? light * (1 + saturation) : light + saturation - light * saturation;
    const p = 2 * light - q;
    data[i] = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
    data[i + 1] = Math.round(hueToRgb(p, q, h) * 255);
    data[i + 2] = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);
  }
  return { width: image.width, height: image.height, data };
}

/** Blend one straight-alpha source pixel over the baked frame. Non-normal
 * modes use the separable blend formula inside this transparent canvas. The
 * caller still reports them as degraded because a flattened PNG cannot retain
 * their blend interaction with the eventual map below it. */
function blendPixel(
  dst: Uint8Array,
  i: number,
  sr: number,
  sg: number,
  sb: number,
  saByte: number,
  mode: BlendMode,
): void {
  if (saByte <= 0) return;
  if (mode === 0) {
    compositePixel(dst, i, sr, sg, sb, saByte);
    return;
  }
  const as = saByte / 255;
  const ab = dst[i + 3]! / 255;
  const ao = as + ab * (1 - as);
  if (ao <= 0) return;
  const blend = (backdrop: number, source: number): number => {
    const cb = backdrop / 255;
    const cs = source / 255;
    if (mode === 1) return Math.min(1, cb + cs);
    if (mode === 2) return cb * cs;
    return 1 - (1 - cb) * (1 - cs);
  };
  const channel = (offset: number, source: number): number => {
    const backdrop = dst[i + offset]!;
    const cb = backdrop / 255;
    const cs = source / 255;
    const premultiplied = as * (1 - ab) * cs + as * ab * blend(backdrop, source) + (1 - as) * ab * cb;
    return Math.round(255 * premultiplied / ao);
  };
  dst[i] = channel(0, sr);
  dst[i + 1] = channel(1, sg);
  dst[i + 2] = channel(2, sb);
  dst[i + 3] = Math.round(ao * 255);
}

function drawCell(dst: RgbaImage, rawMinX: number, rawMinY: number, cell: Cell, source: RgbaImage): void {
  if (cell.scale === 0 || cell.opacity === 0) return;
  const radians = cell.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = (cell.mirror ? -1 : 1) * cell.scale / 100;
  const sy = cell.scale / 100;
  const x0 = Math.max(0, Math.floor(cell.bounds.minX) - rawMinX);
  const y0 = Math.max(0, Math.floor(cell.bounds.minY) - rawMinY);
  const x1 = Math.min(dst.width, Math.ceil(cell.bounds.maxX) - rawMinX);
  const y1 = Math.min(dst.height, Math.ceil(cell.bounds.maxY) - rawMinY);
  const patternX = (cell.pattern % MV_ANIMATION_COLUMNS) * MV_ANIMATION_CELL;
  const patternY = Math.floor(cell.pattern / MV_ANIMATION_COLUMNS) * MV_ANIMATION_CELL;
  const half = MV_ANIMATION_CELL / 2;
  for (let dy = y0; dy < y1; dy++) {
    const worldY = rawMinY + dy + 0.5 - cell.y;
    for (let dx = x0; dx < x1; dx++) {
      const worldX = rawMinX + dx + 0.5 - cell.x;
      // Inverse of scale followed by clockwise-on-screen rotation.
      const localX = (worldX * cos + worldY * sin) / sx + half;
      const localY = (-worldX * sin + worldY * cos) / sy + half;
      if (localX < 0 || localY < 0 || localX >= MV_ANIMATION_CELL || localY >= MV_ANIMATION_CELL) continue;
      const sourceX = patternX + Math.floor(localX);
      const sourceY = patternY + Math.floor(localY);
      const si = (sourceY * source.width + sourceX) * 4;
      const alpha = Math.round(source.data[si + 3]! * cell.opacity / 255);
      const di = (dy * dst.width + dx) * 4;
      blendPixel(dst.data, di, source.data[si]!, source.data[si + 1]!, source.data[si + 2]!, alpha, cell.blendMode);
    }
  }
}

/** Cook one decoded MV animation into a uniform-frame source sheet.
 *
 * `tileSize` is the source project's tile size (48 for MV). The completed
 * frames are area-downscaled by tileSize/16, matching the rest of the RPG
 * Maker importer. The function is pure: inputs are never mutated and equal
 * inputs produce byte-identical RGBA output. */
export function cookMvAnimation(
  animation: RmAnimation,
  sources: MvAnimationSources,
  tileSize: number,
): CookedMvAnimation {
  if (!Number.isInteger(tileSize) || tileSize < 16 || tileSize % 16 !== 0) {
    reject(animation, `tile size ${tileSize} must be a positive multiple of 16`);
  }
  const reduction = tileSize / 16;
  finite(animation, animation.animation1Hue, "animation1Hue");
  finite(animation, animation.animation2Hue, "animation2Hue");
  if (animation.position === 3) reject(animation, "screen-position animations are not supported by mapAnim");
  if (![0, 1, 2].includes(animation.position)) reject(animation, `position ${animation.position} must be 0, 1, 2, or 3`);
  if (!Array.isArray(animation.frames) || animation.frames.length === 0) reject(animation, "frames must contain at least one frame");

  const warnings: string[] = [];
  const blendModes = new Set<Exclude<BlendMode, 0>>();
  const validated = new Map<SourceSlot, ValidatedSource>();
  const normalized: Cell[][] = [];
  let globalMinX = Number.POSITIVE_INFINITY;
  let globalMinY = Number.POSITIVE_INFINITY;
  let globalMaxX = Number.NEGATIVE_INFINITY;
  let globalMaxY = Number.NEGATIVE_INFINITY;

  for (let frameIndex = 0; frameIndex < animation.frames.length; frameIndex++) {
    const rawFrame: unknown = animation.frames[frameIndex];
    if (!Array.isArray(rawFrame)) reject(animation, `frame ${frameIndex} must be an array of cells`);
    const frame: Cell[] = [];
    let visible = 0;
    for (let cellIndex = 0; cellIndex < rawFrame.length; cellIndex++) {
      const raw: unknown = rawFrame[cellIndex];
      const at = `frame ${frameIndex} cell ${cellIndex}`;
      if (!Array.isArray(raw) || raw.length !== 8) reject(animation, `${at} must have exactly 8 fields`);
      const pattern = finite(animation, raw[0], `${at} pattern`);
      const x = finite(animation, raw[1], `${at} x`);
      const y = finite(animation, raw[2], `${at} y`);
      const scale = finite(animation, raw[3], `${at} scale`);
      const rotation = finite(animation, raw[4], `${at} rotation`);
      const mirror = raw[5];
      const opacity = finite(animation, raw[6], `${at} opacity`);
      const blendMode = finite(animation, raw[7], `${at} blendMode`);
      if (!Number.isInteger(pattern) || (pattern !== -1 && (pattern < 0 || pattern >= 200))) {
        reject(animation, `${at} pattern ${pattern} must be -1 or an integer from 0 to 199`);
      }
      if (scale < 0) reject(animation, `${at} scale must be non-negative`);
      if (typeof mirror !== "boolean") reject(animation, `${at} mirror must be boolean`);
      if (!Number.isInteger(opacity) || opacity < 0 || opacity > 255) reject(animation, `${at} opacity must be an integer from 0 to 255`);
      if (!Number.isInteger(blendMode) || blendMode < 0 || blendMode > 3) {
        reject(animation, `${at} blendMode must be an integer from 0 to 3`);
      }
      if (pattern < 0) continue;
      const slot: SourceSlot = pattern < 100 ? 1 : 2;
      const localPattern = pattern % 100;
      if (!validated.has(slot)) validated.set(slot, validateSource(animation, sources, slot, localPattern));
      else {
        const source = validated.get(slot)!.image;
        const patterns = MV_ANIMATION_COLUMNS * (source.height / MV_ANIMATION_CELL);
        if (localPattern >= patterns) {
          const name = sourceName(animation, slot);
          reject(animation, `pattern ${pattern} is outside img/animations/${name}.png (${patterns} patterns)`);
        }
      }
      const bounds = cellBounds(x, y, scale, rotation, mirror);
      const cell: Cell = {
        slot,
        pattern: localPattern,
        x,
        y,
        scale,
        rotation,
        mirror,
        opacity,
        blendMode: blendMode as BlendMode,
        bounds,
      };
      frame.push(cell);
      if (scale > 0 && opacity > 0) {
        if (blendMode !== 0) blendModes.add(blendMode as Exclude<BlendMode, 0>);
        visible++;
        globalMinX = Math.min(globalMinX, bounds.minX);
        globalMinY = Math.min(globalMinY, bounds.minY);
        globalMaxX = Math.max(globalMaxX, bounds.maxX);
        globalMaxY = Math.max(globalMaxY, bounds.maxY);
      }
    }
    if (visible === 0) warnings.push(`frame ${frameIndex} has no visible cells; emitted a transparent frame`);
    normalized.push(frame);
  }

  if (!Number.isFinite(globalMinX)) {
    globalMinX = 0;
    globalMinY = 0;
    globalMaxX = reduction;
    globalMaxY = reduction;
  }
  const rawMinX = Math.floor(globalMinX / reduction) * reduction;
  const rawMinY = Math.floor(globalMinY / reduction) * reduction;
  const rawMaxX = Math.ceil(globalMaxX / reduction) * reduction;
  const rawMaxY = Math.ceil(globalMaxY / reduction) * reduction;
  const rawW = rawMaxX - rawMinX;
  const rawH = rawMaxY - rawMinY;
  const frameW = rawW / reduction;
  const frameH = rawH / reduction;
  if (
    !Number.isSafeInteger(frameW) || !Number.isSafeInteger(frameH) || frameW < 1 || frameH < 1 ||
    frameW > MAX_COOKED_ANIMATION_FRAME || frameH > MAX_COOKED_ANIMATION_FRAME
  ) {
    reject(animation, `cooked frame bounds ${frameW}x${frameH} exceed ${MAX_COOKED_ANIMATION_FRAME}x${MAX_COOKED_ANIMATION_FRAME}`);
  }

  const hued = new Map<SourceSlot, RgbaImage>();
  for (const [slot, source] of validated) hued.set(slot, rotateHue(source.image, source.hue));
  const frames: RgbaImage[] = [];
  for (const cells of normalized) {
    const raw = blankImage(rawW, rawH);
    for (const cell of cells) drawCell(raw, rawMinX, rawMinY, cell, hued.get(cell.slot)!);
    frames.push(downscale(raw, reduction));
  }

  const count = frames.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const sheet = blankImage(frameW * cols, frameH * rows);
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index]!;
    const left = (index % cols) * frameW;
    const top = Math.floor(index / cols) * frameH;
    for (let y = 0; y < frameH; y++) {
      const src = y * frameW * 4;
      const dst = ((top + y) * sheet.width + left) * 4;
      sheet.data.set(frame.data.subarray(src, src + frameW * 4), dst);
    }
  }

  const originY = animation.position === 0 ? 0 : animation.position === 1 ? tileSize / 2 : tileSize;
  const degradations = ([1, 2, 3] as const)
    .filter((mode) => blendModes.has(mode))
    .map((mode) => `${BLEND_NAMES[mode]} blend is baked within the animation but cannot blend against the map`);
  return {
    sheet,
    frameW,
    frameH,
    cols,
    count,
    offsetX: tileSize / 2 / reduction + rawMinX / reduction,
    offsetY: originY / reduction + rawMinY / reduction,
    degradations,
    warnings,
  };
}
