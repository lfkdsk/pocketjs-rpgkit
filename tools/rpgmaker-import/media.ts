// tools/rpgmaker-import/media.ts — resolve and decode RPG Maker deployment
// media. MV/MZ deployment encryption is obfuscation rather than an archive:
// a fixed 16-byte header is removed and the first 16 payload bytes are XORed
// with the key stored in System.json. The source project remains untouched.

import { existsSync, readFileSync } from "node:fs";
import {
  decodeRpgMakerMedia,
  type RpgMakerMediaEncryption,
} from "./media-crypto.ts";

export {
  decryptRpgMakerMedia,
  encryptedRpgMakerAudioFormat,
  hasRpgMakerMediaHeader,
  rpgMakerMediaEncryption,
  type RpgMakerMediaEncryption,
} from "./media-crypto.ts";

/** Read either a normal media file or an encrypted deployment file. */
export function readRpgMakerMedia(
  path: string,
  encryption?: RpgMakerMediaEncryption,
  kind: "image" | "audio" = "image",
): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  return decodeRpgMakerMedia(bytes, encryption, kind);
}

/** Resolve an authored foo.png against plain projects and MV/MZ deployments. */
export function findRpgMakerPng(path: string, encryption?: RpgMakerMediaEncryption): string | null {
  if (existsSync(path)) return path;
  if (!encryption?.images || !path.toLowerCase().endsWith(".png")) return null;
  const candidates = [`${path}_`, `${path.slice(0, -4)}.rpgmvp`];
  return candidates.find(existsSync) ?? null;
}
