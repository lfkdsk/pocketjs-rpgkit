/// <reference lib="dom" />
// Browser codec and host-environment adapter for the RPG Maker importer.

import {
  unavailableAudioRecords,
  type RpgMakerImportEnvironment,
} from "../../tools/rpgmaker-import/environment.ts";
import type { RgbaImage } from "../../tools/rpgmaker-import/image.ts";
import {
  decodeRpgMakerMedia,
  type RpgMakerMediaEncryption,
} from "../../tools/rpgmaker-import/media-crypto.ts";
import { browserSourcePath, type BrowserRpgMakerSource } from "./rpgmaker-import-browser-source.ts";

export interface BrowserRpgMakerImageCodec {
  decode(bytes: Uint8Array): Promise<RgbaImage>;
  encode(image: RgbaImage): Promise<Uint8Array>;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The RPG Maker import was cancelled.", "AbortError");
}

async function bitmapCanvas(width: number, height: number): Promise<{
  draw(bitmap: ImageBitmap): RgbaImage;
  encode(image: RgbaImage): Promise<Uint8Array>;
}> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("browser PNG codec: 2D canvas is unavailable");
    return {
      draw(bitmap) {
        context.clearRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0);
        return { width, height, data: new Uint8Array(context.getImageData(0, 0, width, height).data) };
      },
      async encode(image) {
        context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
        return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      },
    };
  }
  if (typeof document === "undefined") throw new Error("browser PNG codec: canvas is unavailable");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("browser PNG codec: 2D canvas is unavailable");
  return {
    draw(bitmap) {
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0);
      return { width, height, data: new Uint8Array(context.getImageData(0, 0, width, height).data) };
    },
    async encode(image) {
      context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("browser PNG codec: canvas produced no PNG")),
        "image/png",
      ));
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}

export const BROWSER_RPGMAKER_IMAGE_CODEC: BrowserRpgMakerImageCodec = {
  async decode(bytes) {
    if (typeof createImageBitmap !== "function") throw new Error("browser PNG codec: createImageBitmap is unavailable");
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const bitmap = await createImageBitmap(new Blob([copy.buffer], { type: "image/png" }));
    try {
      return (await bitmapCanvas(bitmap.width, bitmap.height)).draw(bitmap);
    } finally {
      bitmap.close();
    }
  },
  async encode(image) {
    return (await bitmapCanvas(image.width, image.height)).encode(image);
  },
};

export interface BrowserImportEnvironmentOptions {
  signal?: AbortSignal;
  codec?: BrowserRpgMakerImageCodec;
}

/** Bind lazy DirectoryHandle reads to the import core. Audio remains an
 * explicit dropped conversion because Browser Studio cannot invoke the
 * system's ffmpeg process. */
export function browserRpgMakerImportEnvironment(
  source: BrowserRpgMakerSource,
  options: BrowserImportEnvironmentOptions = {},
): RpgMakerImportEnvironment {
  const codec = options.codec ?? BROWSER_RPGMAKER_IMAGE_CODEC;
  const readMedia = async (
    path: string,
    encryption?: RpgMakerMediaEncryption,
    kind: "image" | "audio" = "image",
  ): Promise<Uint8Array> => {
    checkAbort(options.signal);
    const bytes = decodeRpgMakerMedia(await source.readBytes(path), encryption, kind);
    checkAbort(options.signal);
    return bytes;
  };
  return {
    join: browserSourcePath,
    exists: (path) => source.has(path),
    list: (path) => source.list(path),
    async readPng(path, encryption) {
      const image = await codec.decode(await readMedia(path, encryption, "image"));
      checkAbort(options.signal);
      return image;
    },
    readMedia,
    convertAudio: (_root, requests) => unavailableAudioRecords(
      requests,
      "Browser Studio cannot invoke system ffmpeg, so Ogg/M4A audio is omitted while maps and images continue importing. Desktop Studio or the CLI can import this audio when ffmpeg is installed. 浏览器版 Studio 无法调用系统 ffmpeg，因此会省略 Ogg/M4A 音频，但地图和图片会继续导入；安装 ffmpeg 后，桌面版 Studio 或 CLI 可以导入这些音频。",
    ),
  };
}
