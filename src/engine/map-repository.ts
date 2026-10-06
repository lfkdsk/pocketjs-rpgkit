// src/engine/map-repository.ts — validated, independently addressable maps.
//
// Map bytes and parsed MapDefs are derived cache data. They live here (or in
// Session's compile cache), never in SessionState. The canonical JSON and
// SHA-256 routines are host-neutral so Bun, QuickJS and a future web byte
// source all accept exactly the same entries.

import PROJECT_SCHEMA from "../data/schema.json";
import { startupProfileMark } from "../startup-profile.ts";
import { decodeCompactMap, isCompactMapValue } from "./compact-map.ts";
import { canonicalJson, utf8Encode } from "./save.ts";
import { validateSchema, type VError } from "./schema-validate.ts";
import {
  MAP_SCHEMA_COMPATIBLE_HASHES,
  MAP_SCHEMA_HASH,
  describeMapSchemaRefusal,
  isCompatibleMapSchemaHash,
} from "./schema-identity.ts";
import type {
  MapDef,
  MapIndexEntry,
  MapRepository,
  ProjectShell,
  ProjectSource,
} from "./types.ts";

const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** SHA-256 over bytes, returned as 64 lowercase hex digits. */
export function sha256Bytes(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  const end = paddedLength - 8;
  bytes[end] = high >>> 24;
  bytes[end + 1] = high >>> 16;
  bytes[end + 2] = high >>> 8;
  bytes[end + 3] = high;
  bytes[end + 4] = low >>> 24;
  bytes[end + 5] = low >>> 16;
  bytes[end + 6] = low >>> 8;
  bytes[end + 7] = low;

  // Keep the compression state in locals and inline rotates. QuickJS has no
  // JIT, so the old helper calls and per-block array destructuring dominated
  // startup for large project shells even though the digest itself is small.
  let h0: number = SHA256_INIT[0];
  let h1: number = SHA256_INIT[1];
  let h2: number = SHA256_INIT[2];
  let h3: number = SHA256_INIT[3];
  let h4: number = SHA256_INIT[4];
  let h5: number = SHA256_INIT[5];
  let h6: number = SHA256_INIT[6];
  let h7: number = SHA256_INIT[7];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = ((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let hh = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + hh) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, "0"))
    .join("");
}

export const sha256Text = (text: string): string => sha256Bytes(utf8Encode(text));
const escapeNonAscii = (text: string): string => text.replace(
  /[^\x00-\x7f]/g,
  (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
);

/** Canonical map JSON with every non-ASCII UTF-16 code unit escaped. This is
 * JSON-equivalent to canonicalJson(map), byte-stable, and lets packaged map
 * entries take the repository's fast ASCII decode path. */
export const canonicalMapJson = (map: MapDef): string => escapeNonAscii(canonicalJson(map));
export const mapChecksum = (map: MapDef): string => sha256Text(canonicalMapJson(map));

/** The schema identity: any normative project-schema change produces a new
 * hash, including command definitions reachable from a map payload. Shells and
 * saves naming a listed, purely additive predecessor stay loadable; see
 * schema-identity.ts for the rules. */
export { MAP_SCHEMA_COMPATIBLE_HASHES, MAP_SCHEMA_HASH, describeMapSchemaRefusal, isCompatibleMapSchemaHash };

export interface MapContentIdentity {
  manifest: string;
  schema: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Root shell fields that are presentation only and therefore excluded from
 * the manifest content identity. A field qualifies only when it is proven
 * never to reach the reducer, the session, the interpreter or the save
 * codec: no engine module reads it, so changing it (another language's
 * interface words, a restyled label table) cannot alter a save, a tape or a
 * replay, and a save taken under one value loads under another. The map
 * payloads (dialogue, events, commands) are hashed separately through
 * `mapIndex`, so per-language map content still changes the identity — only
 * the root presentation table is exempt. Each addition here needs a test
 * that a save survives the field's change (tests/map-repository.test.ts,
 * "a save survives a change of the presentation-only uiText table").
 */
const MANIFEST_EXCLUDED_ROOT_FIELDS: readonly string[] = ["uiText"];

function shellWithoutDeclaredHashes(shell: ProjectShell): Record<string, unknown> {
  const value = { ...shell } as Record<string, unknown>;
  delete value.mapManifestHash;
  delete value.mapSchemaHash;
  for (const field of MANIFEST_EXCLUDED_ROOT_FIELDS) delete value[field];
  return value;
}

export function mapManifestHash(shell: ProjectShell): string {
  const canonical = canonicalJson(shellWithoutDeclaredHashes(shell));
  startupProfileMark("map-manifest:canonical");
  return sha256Text(canonical);
}

/** Resolve the build identity of a project shell. Splitter output already
 * carries this SHA-256, just as trusted package map entries carry their own
 * checksums, so the synchronous runtime need not hash the whole shell again.
 * Hand-authored shells without a declared value retain the computed fallback;
 * callers admitting untrusted/mutable shells can request a full recheck. */
export function resolveMapManifestHash(shell: ProjectShell, verify = false): string {
  const declared = shell.mapManifestHash;
  if (declared !== undefined && !SHA256_HEX.test(declared)) {
    throw new Error("map repository: invalid shell manifest hash");
  }
  if (declared === undefined) return mapManifestHash(shell);
  if (verify && mapManifestHash(shell) !== declared) {
    throw new Error("map repository: shell manifest hash mismatch");
  }
  return declared;
}

/** The content identity a session over `shell` stamps on its saves. A shell
 * from a compatible earlier schema is read, and saved, under the current
 * identity; an incompatible declaration is kept so the mismatch surfaces. */
export function shellContentIdentity(shell: ProjectShell, verify = false): MapContentIdentity {
  const declared = shell.mapSchemaHash;
  return {
    manifest: resolveMapManifestHash(shell, verify),
    schema: declared === undefined || isCompatibleMapSchemaHash(declared) ? MAP_SCHEMA_HASH : declared,
  };
}

/** Build/test-time freshness check for a packaged ProjectShell. Recomputes
 * the manifest hash over the shell's actual content and compares it against
 * the declared `mapManifestHash`, throwing with both digests when they
 * differ. The runtime trusts a declared hash by default (see
 * `resolveMapManifestHash`), so an application that packages a ProjectShell
 * must call this in its build or test pipeline — right after the importer
 * writes the shell — to catch stale or hand-edited shells before release.
 * A hand-authored shell without a declared hash is hashed at startup and has
 * no build identity to verify. */
export function assertShellManifestFresh(shell: ProjectShell): void {
  const declared = shell.mapManifestHash;
  if (declared === undefined) {
    throw new Error("map repository: shell declares no mapManifestHash to verify");
  }
  if (!SHA256_HEX.test(declared)) {
    throw new Error("map repository: invalid shell manifest hash");
  }
  const computed = mapManifestHash(shell);
  if (computed !== declared) {
    throw new Error(
      `map repository: shell manifest hash mismatch: declared ${declared}, computed ${computed}`,
    );
  }
}

export function isProjectShell(project: ProjectSource): project is ProjectShell {
  return "mapIndex" in project;
}

function formatErrors(errors: readonly VError[]): string {
  return errors.slice(0, 3).map((e) => `${e.path}: ${e.msg}`).join("; ");
}

function mapStructureError(detail: string): never {
  throw new Error(`map repository: structure mismatch: ${detail}`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Cheap runtime safety check for a map already validated when it was split.
 * It covers every array shape/index used before or during compilation without
 * walking the command schema or matching tile-id regular expressions. */
export function validateMapDefStructure(map: unknown): asserts map is MapDef {
  if (!isObject(map)) mapStructureError("map must be an object");
  const value = map as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length === 0) {
    mapStructureError("id must be a non-empty string");
  }
  if (!Number.isInteger(value.width) || (value.width as number) < 1) {
    mapStructureError(`${value.id} width must be a positive integer`);
  }
  if (!Number.isInteger(value.height) || (value.height as number) < 1) {
    mapStructureError(`${value.id} height must be a positive integer`);
  }
  const ground = value.ground;
  if (!Array.isArray(ground)) mapStructureError(`${value.id} ground must be an array`);
  const cells = (value.width as number) * (value.height as number);
  if (ground.length !== cells) {
    throw new Error(`map repository: ${value.id} ground has ${ground.length} cells, expected ${cells}`);
  }
  for (let index = 0; index < ground.length; index++) {
    const tile = ground[index];
    if (tile !== null && typeof tile !== "string") {
      mapStructureError(`${value.id} ground cell ${index} must be a string or null`);
    }
  }
  const sparseLayer = (name: "upper" | "passage"): void => {
    const layer = value[name];
    if (layer === undefined) return;
    if (!Array.isArray(layer)) mapStructureError(`${value.id} ${name} must be an array`);
    for (const item of layer) {
      if (!Array.isArray(item) || item.length !== 2 || !Number.isInteger(item[0])) {
        mapStructureError(`${value.id} ${name} entries must be [integer, value] pairs`);
      }
      const index = item[0] as number;
      if (index < 0 || index >= cells) {
        throw new Error(`map repository: ${value.id} ${name} index ${index} out of range`);
      }
    }
  };
  sparseLayer("upper");
  sparseLayer("passage");
  // Sparse cell planes the compiler reads through sparseCellMap/sparseTileMap:
  // regions/terrain are [index, tag] pairs with a bounded tag, tiles is an
  // [index, [l0..l3]] quad. A malformed entry (the review's `[1]`, `[2]`,
  // `[3]` payloads) would otherwise reach `new Map(entries)` in createWorld
  // and die there with a context-less TypeError.
  const sparseCellLayer = (name: "regions" | "terrain", maxTag: number): void => {
    const layer = value[name];
    if (layer === undefined) return;
    if (!Array.isArray(layer)) mapStructureError(`${value.id} ${name} must be an array`);
    for (const item of layer) {
      if (!Array.isArray(item) || item.length !== 2 ||
        !Number.isInteger(item[0]) || !Number.isInteger(item[1])) {
        mapStructureError(`${value.id} ${name} entries must be [integer, integer] pairs`);
      }
      const index = item[0] as number;
      if (index < 0 || index >= cells) {
        throw new Error(`map repository: ${value.id} ${name} index ${index} out of range`);
      }
      const tag = item[1] as number;
      if (tag < 1 || tag > maxTag) {
        throw new Error(`map repository: ${value.id} ${name} tag ${tag} out of range 1..${maxTag}`);
      }
    }
  };
  sparseCellLayer("regions", 255);
  sparseCellLayer("terrain", 7);
  const tiles = value.tiles;
  if (tiles !== undefined) {
    if (!Array.isArray(tiles)) mapStructureError(`${value.id} tiles must be an array`);
    for (const item of tiles) {
      if (!Array.isArray(item) || item.length !== 2 || !Number.isInteger(item[0]) ||
        !Array.isArray(item[1]) || item[1].length !== 4 ||
        !(item[1] as unknown[]).every((v) => Number.isInteger(v) && (v as number) >= 0)) {
        mapStructureError(`${value.id} tiles entries must be [integer, [integer, integer, integer, integer]] pairs`);
      }
      const index = item[0] as number;
      if (index < 0 || index >= cells) {
        throw new Error(`map repository: ${value.id} tiles index ${index} out of range`);
      }
    }
  }
  const events = value.events;
  if (!Array.isArray(events)) mapStructureError(`${value.id} events must be an array`);
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (!isObject(event) || !Array.isArray(event.pages)) {
      mapStructureError(`${value.id} event ${eventIndex} pages must be an array`);
    }
    for (let pageIndex = 0; pageIndex < event.pages.length; pageIndex++) {
      const page = event.pages[pageIndex];
      if (!isObject(page) || !Array.isArray(page.commands)) {
        mapStructureError(`${value.id} event ${eventIndex} page ${pageIndex} commands must be an array`);
      }
    }
  }
}

/** Validate one map against the normative map schema plus the row-major/index
 * bounds that JSON Schema cannot express. Splitters use this full check. */
export function validateMapDef(map: unknown): asserts map is MapDef {
  const mapSchema = (PROJECT_SCHEMA as { $defs: { map: Record<string, unknown> } }).$defs.map;
  const errors = validateSchema(PROJECT_SCHEMA, map, mapSchema);
  if (errors.length > 0) throw new Error(`map repository: schema mismatch: ${formatErrors(errors)}`);
  validateMapDefStructure(map);
}

export function validateMapIndex(entries: readonly MapIndexEntry[]): Map<string, MapIndexEntry> {
  if (entries.length === 0) throw new Error("map repository: mapIndex must not be empty");
  const index = new Map<string, MapIndexEntry>();
  const names = new Set<string>();
  for (const meta of entries) {
    if (!meta.id || !meta.entry || !Number.isInteger(meta.width) || meta.width < 1 ||
      !Number.isInteger(meta.height) || meta.height < 1 || !SHA256_HEX.test(meta.sha256)) {
      throw new Error(`map repository: invalid mapIndex entry ${JSON.stringify(meta.id)}`);
    }
    if (index.has(meta.id)) throw new Error(`map repository: duplicate map id ${meta.id}`);
    if (names.has(meta.entry)) throw new Error(`map repository: duplicate entry ${meta.entry}`);
    index.set(meta.id, meta);
    names.add(meta.entry);
  }
  return index;
}

export class MapNotReadyError extends Error {
  constructor(readonly mapId: string, readonly entry: string) {
    super(`map repository: ${mapId} is not ready (${entry})`);
    this.name = "MapNotReadyError";
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index++]!;
    if (first < 0x80) {
      out += String.fromCharCode(first);
      continue;
    }
    let code: number;
    let extra: number;
    if ((first & 0xe0) === 0xc0) {
      code = first & 0x1f;
      extra = 1;
    } else if ((first & 0xf0) === 0xe0) {
      code = first & 0x0f;
      extra = 2;
    } else if ((first & 0xf8) === 0xf0) {
      code = first & 0x07;
      extra = 3;
    } else {
      throw new Error("map repository: invalid UTF-8 entry");
    }
    if (index + extra > bytes.length) throw new Error("map repository: invalid UTF-8 entry");
    for (let offset = 0; offset < extra; offset++) {
      const next = bytes[index++]!;
      if ((next & 0xc0) !== 0x80) throw new Error("map repository: invalid UTF-8 entry");
      code = (code << 6) | (next & 0x3f);
    }
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ||
      (extra === 1 && code < 0x80) || (extra === 2 && code < 0x800) ||
      (extra === 3 && code < 0x10000)) {
      throw new Error("map repository: invalid UTF-8 entry");
    }
    if (code < 0x10000) {
      out += String.fromCharCode(code);
    } else {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
  }
  return out;
}

/** Decode a map entry without paying the general UTF-8 loop for the ASCII
 * output emitted by splitProjectMaps. The bounded chunks avoid engine
 * argument limits; legacy/non-ASCII bytes fall back to strict UTF-8. */
export function decodeMapEntryBytes(bytes: Uint8Array): string {
  let out = "";
  const chunkSize = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index]! > 0x7f) return decodeUtf8(bytes);
    }
    out += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return out;
}

/** Parse either canonical MapDef JSON or the self-describing compact map
 * transport. Callers that admit untrusted authoring input still validate the
 * returned value with validateMapDef; keeping transport detection here avoids
 * authoring tools accidentally treating an rpgkit-map/1 envelope as MapDef. */
export function decodeMapEntryText(text: string): unknown {
  const value = JSON.parse(text) as unknown;
  return isCompactMapValue(value) ? decodeCompactMap(value) : value;
}

export interface MapEntrySource {
  read(entry: string): string | Uint8Array | undefined;
  /** Optional host text fast path. When present it is authoritative: an
   *  undefined result has the same missing/not-ready meaning as read(). */
  readText?(entry: string): string | undefined;
  prepare?(entry: string): Promise<void>;
}

export interface JsonMapRepositoryOptions {
  /** Recompute each entry's build-time SHA-256 before parsing it.
   * Defaults to false for synchronous package sources and true when the
   * source exposes async preparation (normally a browser/network source). */
  verify?: boolean;
  /** Full schema validation is useful for untrusted authoring inputs. Runtime
   * entries default to the cheaper structural safety check because the kit
   * splitter has already run the full normative schema. */
  validate?: "structure" | "full";
}

/** A runtime-validated repository over local strings/bytes or asynchronously
 * prepared web entries. Entries may be canonical MapDef JSON or the
 * self-describing rpgkit-map/1 compact JSON transport. Parsed maps are
 * evicted exactly when releaseExcept requests it. */
export function createJsonMapRepository(
  entries: readonly MapIndexEntry[],
  source: MapEntrySource,
  options: JsonMapRepositoryOptions = {},
): MapRepository {
  const index = validateMapIndex(entries);
  const cache = new Map<string, MapDef>();
  const pending = new Map<string, { input: string | Uint8Array; value: unknown }>();
  const verify = options.verify ?? source.prepare !== undefined;
  const acquireStep = (id: string): MapDef | undefined => {
    const hit = cache.get(id);
    if (hit) return hit;
    const meta = index.get(id);
    if (!meta) throw new Error(`map repository: unknown map ${id}`);
    const staged = pending.get(id);
    if (!staged) {
      const input = source.readText
        ? source.readText(meta.entry)
        : source.read(meta.entry);
      if (input === undefined) {
        if (source.prepare) throw new MapNotReadyError(id, meta.entry);
        throw new Error(`map repository: missing entry for ${id} (${meta.entry})`);
      }
      const text = typeof input === "string" ? input : decodeMapEntryBytes(input);
      let value: unknown;
      try {
        value = decodeMapEntryText(text);
      } catch {
        throw new Error(`map repository: ${id} (${meta.entry}) is not JSON`);
      }
      pending.set(id, { input, value });
      return undefined;
    }
    if (verify && (typeof staged.input === "string"
      ? sha256Text(staged.input)
      : sha256Bytes(staged.input)) !== meta.sha256) {
      throw new Error(`map repository: checksum mismatch for ${id} (${meta.entry})`);
    }
    const decoded = staged.value;
    if (options.validate === "full") validateMapDef(decoded);
    else validateMapDefStructure(decoded);
    const map = decoded as MapDef;
    if (map.id !== meta.id || map.width !== meta.width || map.height !== meta.height) {
      throw new Error(`map repository: metadata mismatch for ${id}`);
    }
    pending.delete(id);
    cache.set(id, map);
    return map;
  };
  return {
    meta: (id) => index.get(id),
    acquire(id) {
      let map: MapDef | undefined;
      while (map === undefined) map = acquireStep(id);
      return map;
    },
    ...(source.prepare ? {} : { acquireStep }),
    releaseExcept(ids) {
      const keep = new Set(ids);
      for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
      for (const id of [...pending.keys()]) if (!keep.has(id)) pending.delete(id);
    },
    stats: () => ({ cached: cache.size, pending: pending.size }),
    ...(source.prepare ? {
      prepare: async (id: string) => {
        const meta = index.get(id);
        if (!meta) throw new Error(`map repository: unknown map ${id}`);
        await source.prepare!(meta.entry);
      },
    } : {}),
  };
}

/** Format-neutral name for new code. The historical export remains source-
 * compatible; both accept JSON and rpgkit-map/1 entries. */
export const createMapRepository = createJsonMapRepository;
