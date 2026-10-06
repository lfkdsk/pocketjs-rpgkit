// Shared validation for proposal attachments and sharded-pack assets.
// Kept pure so proposal parsing remains usable in the browser editor.

import {
  PNG_HEADER_BYTES,
  packAssetBytesProblem,
  packAssetCountProblem,
  pngProblem,
  readPngSize,
} from "./limits.ts";
import {
  base64DecodedBound,
  decodeBase64,
  packEntryProblem,
  type PackAsset,
} from "./pack-format.ts";

export interface PngAssetIssue {
  code: "INVALID_ASSET" | "TOO_LARGE";
  path: string;
  message: string;
}

export type PngAssetValidation =
  | { ok: true; assets: Map<string, PackAsset> }
  | { ok: false; issue: PngAssetIssue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate a path-keyed record of strict, canonical-base64 PNG assets.
 * Count, individual decoded size/dimensions, and aggregate decoded size use
 * the same limits for packs and proposal attachments. */
export function validatePngAssetRecord(
  supplied: unknown,
  rootPath = "$.assets",
): PngAssetValidation {
  if (!isRecord(supplied)) {
    return { ok: false, issue: { code: "INVALID_ASSET", path: rootPath, message: "assets must be an object" } };
  }
  const assets = new Map<string, PackAsset>();
  const paths = Object.keys(supplied);
  const countProblem = packAssetCountProblem(paths.length);
  if (countProblem !== null) {
    return { ok: false, issue: { code: "TOO_LARGE", path: rootPath, message: countProblem } };
  }
  let total = 0;
  for (const path of paths) {
    const at = `${rootPath}[${JSON.stringify(path)}]`;
    if (packEntryProblem(path) !== null) {
      return {
        ok: false,
        issue: {
          code: "INVALID_ASSET",
          path: rootPath,
          message: `unsafe asset path ${JSON.stringify(path)}; asset keys must be portable relative paths`,
        },
      };
    }
    const value = supplied[path];
    if (!isRecord(value) || typeof value.data !== "string" ||
        Object.keys(value).some((key) => key !== "type" && key !== "data")) {
      return {
        ok: false,
        issue: { code: "INVALID_ASSET", path: at, message: `asset ${JSON.stringify(path)} must be an object with only "type" and "data"` },
      };
    }
    if (value.type !== "image/png") {
      return {
        ok: false,
        issue: { code: "INVALID_ASSET", path: `${at}.type`, message: `asset ${JSON.stringify(path)} has type ${JSON.stringify(value.type)}; only "image/png" is supported` },
      };
    }
    const data = value.data;
    const decodedBound = base64DecodedBound(data.length) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    const boundProblem = pngProblem(`asset ${JSON.stringify(path)}`, decodedBound);
    if (boundProblem !== null) {
      return { ok: false, issue: { code: "TOO_LARGE", path: `${at}.data`, message: boundProblem } };
    }
    const bytes = decodeBase64(data);
    if (bytes === null) {
      return { ok: false, issue: { code: "INVALID_ASSET", path: `${at}.data`, message: `asset ${JSON.stringify(path)} is not valid base64 (standard padded canonical spelling required)` } };
    }
    total += bytes.length;
    const totalProblem = packAssetBytesProblem(total);
    if (totalProblem !== null) {
      return { ok: false, issue: { code: "TOO_LARGE", path: rootPath, message: totalProblem } };
    }
    const header = bytes.subarray(0, PNG_HEADER_BYTES);
    const size = readPngSize(header);
    const imageProblem = pngProblem(`asset ${JSON.stringify(path)}`, bytes.length, header);
    if (imageProblem !== null) {
      return {
        ok: false,
        issue: {
          code: size === null || size.width === 0 || size.height === 0 ? "INVALID_ASSET" : "TOO_LARGE",
          path: `${at}.data`,
          message: imageProblem,
        },
      };
    }
    assets.set(path, { type: "image/png", data });
  }
  return { ok: true, assets };
}
