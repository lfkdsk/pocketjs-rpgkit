// Image preparation shared by build-time cookers that feed PocketJS pak
// textures. The host accepts power-of-two edges no larger than 512 pixels,
// while authored RPG art is allowed to use arbitrary dimensions.

export interface RgbaBitmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Bake RPG Maker's bush-depth presentation into one otherwise-identical
 * actor texture. The bottom `depth` logical rows keep their RGB channels and
 * receive the same 128/255 opacity that the stock renderer applies to its
 * lower-body sprite. Returning a separate bitmap lets GameView retain one
 * image node per actor and switch only its source while standing in bush.
 */
export function bakeBushDepth(
  image: RgbaBitmap,
  depth = 4,
  opacity = 128,
): RgbaBitmap {
  if (!Number.isInteger(image.width) || image.width <= 0 ||
      !Number.isInteger(image.height) || image.height <= 0 ||
      image.data.length !== image.width * image.height * 4) {
    throw new Error(`bush depth: invalid RGBA source ${image.width}x${image.height}`);
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > image.height) {
    throw new Error(`bush depth: invalid depth ${depth} for ${image.width}x${image.height}`);
  }
  if (!Number.isInteger(opacity) || opacity < 0 || opacity > 255) {
    throw new Error(`bush depth: invalid opacity ${opacity}`);
  }

  const data = image.data.slice();
  const firstAlpha = (image.height - depth) * image.width * 4 + 3;
  for (let at = firstAlpha; at < data.length; at += 4) {
    data[at] = Math.round(data[at]! * opacity / 255);
  }
  return { width: image.width, height: image.height, data };
}

const isPowerOfTwo = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;

const nextPowerOfTwo = (value: number): number => {
  let edge = 1;
  while (edge < value) edge *= 2;
  return edge;
};

/** Nearest-neighbour RGBA resampling with no dependency on importer code. */
export function resampleRgba(image: RgbaBitmap, width: number, height: number): RgbaBitmap {
  if (!Number.isInteger(image.width) || image.width <= 0 ||
      !Number.isInteger(image.height) || image.height <= 0 ||
      image.data.length !== image.width * image.height * 4) {
    throw new Error(`pak image: invalid RGBA source ${image.width}x${image.height}`);
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`pak image: invalid target ${width}x${height}`);
  }
  if (width === image.width && height === image.height) return image;

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor(y * image.height / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * image.width / width));
      const source = (sourceY * image.width + sourceX) * 4;
      data.set(image.data.subarray(source, source + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/**
 * Resample an authored bitmap to legal PocketJS texture dimensions. Returning
 * the original object on the already-legal path keeps fixture output stable.
 */
export function fitPakTexture(image: RgbaBitmap, maxEdge = 512): RgbaBitmap {
  if (!isPowerOfTwo(maxEdge)) throw new Error(`pak image: max edge must be a power of two, got ${maxEdge}`);
  const width = image.width > maxEdge ? maxEdge : nextPowerOfTwo(image.width);
  const height = image.height > maxEdge ? maxEdge : nextPowerOfTwo(image.height);
  return resampleRgba(image, width, height);
}
