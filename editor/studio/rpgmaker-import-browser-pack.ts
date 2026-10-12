// Turn one in-memory browser import into the self-contained sharded pack
// Studio can stage and open. Generated art and copied picture PNGs are
// embedded, so the selected source directory need not stay authorized.

import { encodeBase64, type PackAsset } from "../api/pack-format.ts";
import { parseShardedPack, serializeShardedPack } from "../api/pack.ts";
import { splitProjectMaps } from "../../tools/lib/map-project.ts";
import type { ImportResult } from "../../tools/rpgmaker-import/project.ts";
import {
  BROWSER_RPGMAKER_IMAGE_CODEC,
  type BrowserRpgMakerImageCodec,
} from "./rpgmaker-import-browser-io.ts";

export interface PackBrowserImportOptions {
  codec?: BrowserRpgMakerImageCodec;
  signal?: AbortSignal;
  onAsset?(completed: number, total: number, path: string): void;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The RPG Maker import was cancelled.", "AbortError");
}

/** Encode generated RGBA art, retain already-PNG source media, then serialize
 * a map-sharded pack in stable path order. */
export async function packBrowserRpgMakerImport(
  result: ImportResult,
  options: PackBrowserImportOptions = {},
): Promise<string> {
  const codec = options.codec ?? BROWSER_RPGMAKER_IMAGE_CODEC;
  const generated = [...result.images].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const copied = [...result.mediaFiles].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const total = generated.length + copied.length;
  const assets = new Map<string, PackAsset>();
  let completed = 0;
  for (const [path, image] of generated) {
    checkAbort(options.signal);
    const bytes = await codec.encode(image);
    checkAbort(options.signal);
    assets.set(path, { type: "image/png", data: encodeBase64(bytes) });
    options.onAsset?.(++completed, total, path);
  }
  for (const [path, bytes] of copied) {
    checkAbort(options.signal);
    assets.set(path, { type: "image/png", data: encodeBase64(bytes) });
    options.onAsset?.(++completed, total, path);
  }
  const split = splitProjectMaps(result.project, { entryEncoding: "json" });
  const text = serializeShardedPack(
    split.shellText,
    split.shell.mapIndex,
    new Map(split.entries.map((entry) => [entry.meta.entry, entry.text])),
    assets,
  );
  // Apply the same pack/art/count/size gate Studio will use on Open result,
  // so an oversized browser import fails in the import dialog rather than
  // producing a staged result that cannot be opened.
  parseShardedPack(text);
  return text;
}
