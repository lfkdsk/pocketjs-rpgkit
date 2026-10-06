// tools/web/icon.ts — generate the site's install icons at build time, with
// no image dependency: a tiny PNG encoder (zlib via Bun.deflateSync) and the
// same plus mark the favicon draws. When the site has a preview image, the
// icons are drawn from it (cover-cropped to a square) instead of the mark.
// The web app manifest and the Apple touch icon link point at these files,
// so "Add to Home Screen" gets a real icon.
//
// Bytes are deterministic: same size in, same PNG out.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Bun.deflateSync returns raw DEFLATE; PNG IDAT wants the zlib wrapper
 *  (CMF/FLG header and an ADLER32 trailer over the uncompressed bytes). */
function zlibWrap(deflated: Uint8Array, original: Uint8Array): Uint8Array {
  const out = new Uint8Array(deflated.length + 6);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(deflated, 2);
  new DataView(out.buffer).setUint32(2 + deflated.length, adler32(original));
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/** One RGBA PNG (8-bit, filter 0) of `size` by `size` pixels. */
export function encodePngRgba(size: number, pixels: Uint8Array): Uint8Array {
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new RangeError(`icon size out of range: ${size}`);
  if (pixels.length !== size * size * 4) throw new RangeError(`icon pixels must be ${size * size * 4} bytes`);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlibWrap(Bun.deflateSync(raw), raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Decode an 8-bit, non-interlaced PNG (RGB or RGBA) to RGBA pixels. The
 *  previews the site ships are all 8-bit non-interlaced; anything else
 *  throws, and the caller falls back to the kit mark. */
export function decodePngRgba(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error("not a PNG");
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const view = new DataView(data.buffer, data.byteOffset, data.length);
      width = view.getUint32(0);
      height = view.getUint32(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`unsupported PNG color type ${colorType}`);
  const compressed = idat.length === 1 ? new Uint8Array(idat[0]!) : concatBytes(idat);
  // IDAT carries a zlib wrapper (2-byte header, 4-byte ADLER32 trailer);
  // Bun.inflateSync is raw DEFLATE, so strip the wrapper.
  const raw = Bun.inflateSync(new Uint8Array(compressed.subarray(2, compressed.length - 4)));
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1) + 1;
    const filter = raw[rowStart - 1]!;
    for (let x = 0; x < stride; x++) {
      const byte = raw[rowStart + x]!;
      const a = x >= channels ? raw[rowStart + x - channels]! : 0;
      const b = y > 0 ? raw[(y - 1) * (stride + 1) + 1 + x]! : 0;
      const c = x >= channels && y > 0 ? raw[(y - 1) * (stride + 1) + 1 + x - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = byte; break;
        case 1: value = byte + a; break;
        case 2: value = byte + b; break;
        case 3: value = byte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          value = byte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unsupported PNG filter ${filter}`);
      }
      raw[rowStart + x] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const si = rowStart + x * channels;
      const di = (y * width + x) * 4;
      pixels[di] = raw[si]!;
      pixels[di + 1] = raw[si + 1]!;
      pixels[di + 2] = raw[si + 2]!;
      pixels[di + 3] = channels === 4 ? raw[si + 3]! : 255;
    }
  }
  return { width, height, pixels };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The kit mark: the favicon's yellow plus on the dark page background,
 *  scaled to fill the square (maskable icons need a full-bleed background). */
export function drawIcon(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const [br, bg, bb] = rgb("#0d0f14");
  const [yr, yg, yb] = rgb("#f4c35a");
  const [hr, hg, hb] = rgb("#fff3c4");
  const band = (lo: number, hi: number) => {
    const a = Math.floor(size * lo);
    const b = Math.ceil(size * hi);
    return [Math.max(0, a), Math.min(size, b)] as const;
  };
  const fill = (r0: number, r1: number, g0: number, g1: number, color: [number, number, number]) => {
    for (let y = r0; y < r1; y++) {
      for (let x = g0; x < g1; x++) {
        const i = (y * size + x) * 4;
        pixels[i] = color[0];
        pixels[i + 1] = color[1];
        pixels[i + 2] = color[2];
        pixels[i + 3] = 255;
      }
    }
  };
  fill(0, size, 0, size, [br, bg, bb]);
  const [vx0, vx1] = band(2 / 8, 6 / 8);
  const [vy0, vy1] = band(1 / 8, 7 / 8);
  const [hx0, hx1] = band(1 / 8, 7 / 8);
  const [hy0, hy1] = band(2 / 8, 6 / 8);
  fill(vy0, vy1, vx0, vx1, [yr, yg, yb]);
  fill(hy0, hy1, hx0, hx1, [yr, yg, yb]);
  const [cx0, cx1] = band(3 / 8, 5 / 8);
  fill(cx0, cx1, cx0, cx1, [hr, hg, hb]);
  return encodePngRgba(size, pixels);
}

/** Draw the icon from a preview image: cover-crop to a centred square, then
 *  nearest-neighbour scale to the icon size. The previews are pixel-art
 *  screenshots, so nearest neighbour keeps them crisp; maskable icons need
 *  a full-bleed image, so the preview fills the whole square. */
export function drawIconFromPreview(size: number, width: number, height: number, source: Uint8Array): Uint8Array {
  if (source.length !== width * height * 4) {
    throw new RangeError(`preview pixels must be ${width * height * 4} bytes, got ${source.length}`);
  }
  const side = Math.min(width, height);
  const sx = Math.floor((width - side) / 2);
  const sy = Math.floor((height - side) / 2);
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sourceY = sy + Math.floor((y * side) / size);
    for (let x = 0; x < size; x++) {
      const sourceX = sx + Math.floor((x * side) / size);
      const si = (sourceY * width + sourceX) * 4;
      const di = (y * size + x) * 4;
      pixels[di] = source[si]!;
      pixels[di + 1] = source[si + 1]!;
      pixels[di + 2] = source[si + 2]!;
      pixels[di + 3] = source[si + 3]!;
    }
  }
  return encodePngRgba(size, pixels);
}

/** Icon sizes the site ships: the manifest's two, plus Apple's touch icon. */
export const SITE_ICONS = {
  "icon-192.png": 192,
  "icon-512.png": 512,
  "apple-touch-icon.png": 180,
} as const;

/** Write the install icons next to the site's other root files. When a
 *  preview PNG is given and decodes, the icons are drawn from it; otherwise
 *  they fall back to the kit mark. */
export function writeSiteIcons(outdir: string, write: (path: string, bytes: Uint8Array) => void, previewPath?: string): void {
  let preview: { width: number; height: number; pixels: Uint8Array } | undefined;
  if (previewPath) {
    try {
      preview = decodePngRgba(readFileSync(previewPath));
    } catch (error) {
      console.warn(`web: icon preview ${previewPath} unreadable (${error instanceof Error ? error.message : error}); using the kit mark`);
    }
  }
  for (const [name, size] of Object.entries(SITE_ICONS)) {
    write(
      join(outdir, name),
      preview ? drawIconFromPreview(size, preview.width, preview.height, preview.pixels) : drawIcon(size),
    );
  }
}
