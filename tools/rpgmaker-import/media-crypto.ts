// Browser-safe RPG Maker deployment-media crypto. Filesystem discovery lives
// in media.ts (Node/Bun) or an injected browser import environment.

export interface RpgMakerMediaEncryption {
  key: Uint8Array;
  images: boolean;
  audio: boolean;
}

const HEADER = Uint8Array.of(
  0x52, 0x50, 0x47, 0x4d, 0x56, 0x00, 0x00, 0x00,
  0x00, 0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
);

export function hasRpgMakerMediaHeader(bytes: Uint8Array): boolean {
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
  if (!hasRpgMakerMediaHeader(bytes)) throw new Error("rpgmaker media: encrypted file has an invalid deployment header");
  const out = bytes.slice(HEADER.length);
  for (let index = 0; index < Math.min(key.length, out.length); index++) out[index] ^= key[index]!;
  return out;
}

/** Decode bytes already read by a host. Plain files pass through unchanged. */
export function decodeRpgMakerMedia(
  bytes: Uint8Array,
  encryption?: RpgMakerMediaEncryption,
  kind: "image" | "audio" = "image",
): Uint8Array {
  if (!hasRpgMakerMediaHeader(bytes)) return bytes;
  if (!encryption || (kind === "image" ? !encryption.images : !encryption.audio)) {
    throw new Error(`rpgmaker media: ${kind} file is encrypted but System.json does not enable ${kind} decryption`);
  }
  return decryptRpgMakerMedia(bytes, encryption.key);
}

/** Whether a path carries one of the editor's encrypted deployment suffixes. */
export function encryptedRpgMakerAudioFormat(path: string): "ogg" | "m4a" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".ogg_") || lower.endsWith(".rpgmvo")) return "ogg";
  if (lower.endsWith(".m4a_") || lower.endsWith(".rpgmvm")) return "m4a";
  return null;
}
