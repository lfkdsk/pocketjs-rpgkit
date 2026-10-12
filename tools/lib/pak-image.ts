// Image preparation shared by build-time cookers that feed PocketJS pak
// textures. The host accepts power-of-two edges no larger than 512 pixels,
// while authored RPG art is allowed to use arbitrary dimensions.

export interface RgbaBitmap {
  width: number;
  height: number;
  data: Uint8Array;
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
