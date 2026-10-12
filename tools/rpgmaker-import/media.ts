// tools/rpgmaker-import/media.ts — resolve and decode RPG Maker deployment
// media. MV/MZ deployment encryption is obfuscation rather than an archive:
// a fixed 16-byte header is removed and the first 16 payload bytes are XORed
// with the key stored in System.json. The source project remains untouched.

import { existsSync, readFileSync } from "node:fs";

export interface RpgMakerMediaEncryption {
  key: Uint8Array;
  images: boolean;
  audio: boolean;
}

const HEADER = Uint8Array.of(
  0x52, 0x50, 0x47, 0x4d, 0x56, 0x00, 0x00, 0x00,
  0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
);

function hasHeader(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER.length && HEADER.every((byte, index) => bytes[index] === byte);
}

/** Parse System.json's deployment key without ever including it in errors. */
export function rpgMakerMediaEncryption(
  system: { hasEncryptedImages?: boolean; hasEncryptedAudio?: boolean; encryptionKey?: string },
  source: string,
): RpgMakerMediaEncryption | undefined {
  const images = system.hasEncryptedImages === true;
  const audio = system.hasEncryptedAudio === true;
  if (!images && !audio) return undefined;
  const hex = system.encryptionKey ?? "";
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`${source}: encrypted media requires a 32-digit hexadecimal System.json encryptionKey`);
  }
  const key = new Uint8Array(16);
  for (let index = 0; index < key.length; index++) key[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return { key, images, audio };
}

/** Remove the deployment header and decrypt the short XOR prefix. */
export function decryptRpgMakerMedia(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error("rpgmaker media: decryption key must contain 16 bytes");
  if (!hasHeader(bytes)) throw new Error("rpgmaker media: encrypted file has an invalid deployment header");
  const out = bytes.slice(HEADER.length);
  for (let index = 0; index < Math.min(key.length, out.length); index++) out[index] ^= key[index]!;
  return out;
}

/** Read either a normal media file or an encrypted deployment file. */
export function readRpgMakerMedia(
  path: string,
  encryption?: RpgMakerMediaEncryption,
  kind: "image" | "audio" = "image",
): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  if (!hasHeader(bytes)) return bytes;
  if (!encryption || (kind === "image" ? !encryption.images : !encryption.audio)) {
    throw new Error(`rpgmaker media: ${kind} file is encrypted but System.json does not enable ${kind} decryption`);
  }
  return decryptRpgMakerMedia(bytes, encryption.key);
}

/** Resolve an authored foo.png against plain projects and MV/MZ deployments. */
export function findRpgMakerPng(path: string, encryption?: RpgMakerMediaEncryption): string | null {
  if (existsSync(path)) return path;
  if (!encryption?.images || !path.toLowerCase().endsWith(".png")) return null;
  const candidates = [`${path}_`, `${path.slice(0, -4)}.rpgmvp`];
  return candidates.find(existsSync) ?? null;
}

/** Whether a path carries one of the editor's encrypted deployment suffixes. */
export function encryptedRpgMakerAudioFormat(path: string): "ogg" | "m4a" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ogg_") || lower.endsWith(".rpgmvo")) return "ogg";
  if (lower.endsWith(".m4a_") || lower.endsWith(".rpgmvm")) return "m4a";
  return null;
}
