// Browser-safe RGBA image primitives shared by the Node/Bun and web RPG
// Maker import adapters. Codecs and filesystem access live outside this file.

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major, straight (not premultiplied)
   * alpha. */
  data: Uint8Array;
}

export function blankImage(w: number, h: number): RgbaImage {
  return { width: w, height: h, data: new Uint8Array(w * h * 4) };
}

/** Draw a clipped source rectangle with source-over alpha compositing. */
export function blit(
  dst: RgbaImage,
  dx: number,
  dy: number,
  src: RgbaImage,
  sx: number,
  sy: number,
  w: number,
  h: number,
): void {
  for (let y = 0; y < h; y++) {
    const syy = sy + y;
    const dyy = dy + y;
    if (syy < 0 || syy >= src.height || dyy < 0 || dyy >= dst.height) continue;
    for (let x = 0; x < w; x++) {
      const sxx = sx + x;
      const dxx = dx + x;
      if (sxx < 0 || sxx >= src.width || dxx < 0 || dxx >= dst.width) continue;
      const si = (syy * src.width + sxx) * 4;
      const di = (dyy * dst.width + dxx) * 4;
      compositePixel(dst.data, di, src.data[si]!, src.data[si + 1]!, src.data[si + 2]!, src.data[si + 3]!);
    }
  }
}

/** Source-over one straight-alpha pixel onto `d` at byte offset `i`. */
export function compositePixel(d: Uint8Array, i: number, r: number, g: number, b: number, a: number): void {
  if (a === 0) return;
  if (a === 255) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
    return;
  }
  const sa = a / 255;
  const da = d[i + 3]! / 255;
  const oa = sa + da * (1 - sa);
  const mix = (s: number, t: number): number => Math.round((s * sa + t * da * (1 - sa)) / oa);
  d[i] = mix(r, d[i]!);
  d[i + 1] = mix(g, d[i + 1]!);
  d[i + 2] = mix(b, d[i + 2]!);
  d[i + 3] = Math.round(oa * 255);
}
