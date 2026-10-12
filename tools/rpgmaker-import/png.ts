// tools/rpgmaker-import/png.ts — the small RGBA image toolkit the tile
// renderer works in: read and write PNGs, blank canvases, and an
// alpha-compositing blit.
//
// Decoding reuses the pak compiler's PNG reader (8-bit grey, RGB, grey+alpha,
// RGBA). RPG Maker projects also ship palette PNGs (colour type 3, often
// with a tRNS chunk for the transparent index), which that reader rejects;
// those are decoded here. Encoding reuses the shared golden-test encoder.

import { inflateSync } from "node:zlib";
import { decodePng } from "../../vendor/pocketjs/framework/compiler/pak.ts";
import { encodePNG } from "../../vendor/pocketjs/tests/png.ts";
import { readRpgMakerMedia, type RpgMakerMediaEncryption } from "./media.ts";
import { blankImage, type RgbaImage } from "./image.ts";

export { blankImage, blit, compositePixel, type RgbaImage } from "./image.ts";

export async function readPng(path: string, encryption?: RpgMakerMediaEncryption): Promise<RgbaImage> {
  const bytes = readRpgMakerMedia(path, encryption, "image");
  return decodePngBytes(bytes);
}

/** Decode PNG bytes to RGBA (palette images included). */
export function decodePngBytes(bytes: Uint8Array): RgbaImage {
  if (isPalettePng(bytes)) return decodePalettePng(bytes);
  const img = decodePng(bytes);
  return { width: img.width, height: img.height, data: img.rgba };
}

export function writePngBytes(img: RgbaImage): Uint8Array {
  return new Uint8Array(encodePNG(img.data, img.width, img.height));
}

// --- palette PNGs -------------------------------------------------------------

function isPalettePng(bytes: Uint8Array): boolean {
  // Signature (8) + IHDR length (4) + "IHDR" (4) + width, height (8) +
  // bit depth (1): colour type is byte 25.
  return bytes.length > 25 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[25] === 3;
}

function decodePalettePng(bytes: Uint8Array): RgbaImage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let palette: Uint8Array = new Uint8Array(0);
  let alpha: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  while (o + 8 <= bytes.length) {
    const len = dv.getUint32(o, false);
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
    const body = bytes.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(o + 8, false);
      height = dv.getUint32(o + 12, false);
      depth = bytes[o + 16]!;
      if (bytes[o + 20] !== 0) throw new Error("png: interlaced PNGs unsupported");
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  if (![1, 2, 4, 8].includes(depth)) throw new Error(`png: bad palette bit depth ${depth}`);
  const total = idat.reduce((n, c) => n + c.length, 0);
  const z = new Uint8Array(total);
  let zo = 0;
  for (const c of idat) {
    z.set(c, zo);
    zo += c.length;
  }
  const raw = new Uint8Array(inflateSync(z));
  const stride = Math.ceil((width * depth) / 8);
  // Sub-byte and 8-bit palette rows filter with a one-byte pixel step.
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  const out = blankImage(width, height);
  let ro = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[ro++]!;
    for (let x = 0; x < stride; x++) {
      const cur = raw[ro + x]!;
      const a = x >= 1 ? line[x - 1]! : 0;
      const b = prev[x]!;
      const c = x >= 1 ? prev[x - 1]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`png: bad filter ${filter}`);
      }
      line[x] = v & 0xff;
    }
    ro += stride;
    const perByte = 8 / depth;
    const mask = (1 << depth) - 1;
    for (let x = 0; x < width; x++) {
      const byte = line[Math.floor(x / perByte)]!;
      const shift = 8 - depth * ((x % perByte) + 1);
      const idx = (byte >> shift) & mask;
      const i = (y * width + x) * 4;
      out.data[i] = palette[idx * 3] ?? 0;
      out.data[i + 1] = palette[idx * 3 + 1] ?? 0;
      out.data[i + 2] = palette[idx * 3 + 2] ?? 0;
      out.data[i + 3] = alpha[idx] ?? 255;
    }
    prev.set(line);
  }
  return out;
}
