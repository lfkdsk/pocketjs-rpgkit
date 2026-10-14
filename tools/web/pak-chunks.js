// Content-addressed Web pak chunks. The guest-facing reader stays synchronous:
// async fetch/decompression happens in prepare()/prefetch(), then __pakRead
// serves a fresh bounded copy from resident chunk bytes.

const PAK_MAGIC = 0x4b504344; // 'DCPK' little-endian
const PAK_VERSION = 1;
const PAK_HEADER_SIZE = 32;
const PAK_ENTRY_SIZE = 24;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(`Web pak chunks: ${message}`);
}

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function asString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function asBytes(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function parseAsset(value, label) {
  const asset = asRecord(value, label);
  const file = asString(asset.file, `${label}.file`);
  if (asset.encoding !== "gzip") fail(`${label}.encoding must be gzip`);
  const bytes = asBytes(asset.bytes, `${label}.bytes`);
  const unpackedBytes = asBytes(asset.unpackedBytes, `${label}.unpackedBytes`);
  const sha256 = asString(asset.sha256, `${label}.sha256`);
  if (!SHA256.test(sha256)) fail(`${label}.sha256 must be lowercase SHA-256`);
  if (!file.includes(sha256)) fail(`${label}.file must contain its SHA-256`);
  return { file, encoding: "gzip", bytes, unpackedBytes, sha256 };
}

export function parsePakChunkManifest(value) {
  const source = asRecord(value, "manifest");
  if (source.version !== 1 || source.format !== "pocket-pak-chunks/v1") {
    fail("unsupported manifest");
  }
  const startup = parseAsset(source.startup, "manifest.startup");
  if (!Array.isArray(source.chunks)) fail("manifest.chunks must be an array");
  const ids = new Set();
  const entryOwners = new Map();
  const chunks = source.chunks.map((raw, index) => {
    const record = asRecord(raw, `manifest.chunks[${index}]`);
    const id = asString(record.id, `manifest.chunks[${index}].id`);
    if (ids.has(id)) fail(`duplicate chunk id ${id}`);
    ids.add(id);
    const asset = parseAsset(record, `manifest.chunks[${index}]`);
    if (!Array.isArray(record.entries) || record.entries.length === 0) {
      fail(`manifest.chunks[${index}].entries must be a non-empty array`);
    }
    const entries = record.entries.map((entry, entryIndex) => {
      const key = asString(entry, `manifest.chunks[${index}].entries[${entryIndex}]`);
      const previous = entryOwners.get(key);
      if (previous) fail(`entry ${key} belongs to both ${previous} and ${id}`);
      entryOwners.set(key, id);
      return key;
    });
    return { id, ...asset, entries, background: record.background === true };
  });
  return { version: 1, format: "pocket-pak-chunks/v1", startup, chunks };
}

function hex(bytes) {
  let out = "";
  for (const byte of new Uint8Array(bytes)) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function sha256(bytes) {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "function") fail("this browser has no gzip decompressor");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

function parsePak(bytes, expectedKeys) {
  const data = new Uint8Array(bytes);
  if (data.byteLength < PAK_HEADER_SIZE) fail("chunk pak is shorter than its header");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== PAK_MAGIC || view.getUint16(4, true) !== PAK_VERSION) {
    fail("chunk pak has an invalid header");
  }
  const count = view.getUint32(8, true);
  const directory = view.getUint32(12, true);
  const names = view.getUint32(16, true);
  const fileLength = view.getUint32(24, true);
  if (fileLength !== data.length || directory > data.length ||
    count > Math.floor((data.length - directory) / PAK_ENTRY_SIZE) || names > data.length) {
    fail("chunk pak has an invalid directory");
  }
  const decoder = new TextDecoder();
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    const row = directory + index * PAK_ENTRY_SIZE;
    const offset = view.getUint32(row + 4, true);
    const length = view.getUint32(row + 8, true);
    const nameOffset = view.getUint32(row + 12, true);
    const nameLength = view.getUint16(row + 16, true);
    const nameStart = names + nameOffset;
    if (nameStart > data.length || nameLength > data.length - nameStart || offset > data.length || length > data.length - offset) {
      fail("chunk pak entry is out of bounds");
    }
    const key = decoder.decode(data.subarray(nameStart, nameStart + nameLength));
    if (entries.has(key)) fail(`chunk pak repeats ${key}`);
    entries.set(key, { offset, length });
  }
  if (entries.size !== expectedKeys.length || expectedKeys.some((key) => !entries.has(key))) {
    fail("chunk pak entries do not match its manifest");
  }
  return { data, entries };
}

async function fetchAsset(asset, manifestUrl, fetchImpl, digest, decompress) {
  const url = new URL(asset.file, manifestUrl);
  const response = await fetchImpl(url);
  if (!response.ok) fail(`${asset.file} returned ${response.status}`);
  const compressed = await response.arrayBuffer();
  if (compressed.byteLength !== asset.bytes) {
    fail(`${asset.file} has ${compressed.byteLength} bytes, expected ${asset.bytes}`);
  }
  const actual = await digest(compressed);
  if (actual !== asset.sha256) fail(`${asset.file} failed SHA-256 verification`);
  const unpacked = await decompress(compressed);
  if (unpacked.byteLength !== asset.unpackedBytes) {
    fail(`${asset.file} expands to ${unpacked.byteLength} bytes, expected ${asset.unpackedBytes}`);
  }
  return unpacked;
}

export async function openPakChunkLoader(manifestUrl, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const digest = options.sha256 ?? sha256;
  const decompress = options.gunzip ?? gunzip;
  const baseUrl = options.baseUrl ?? globalThis.document?.baseURI;
  const absoluteManifestUrl = baseUrl === undefined
    ? new URL(manifestUrl)
    : new URL(manifestUrl, baseUrl);
  const manifestResponse = await fetchImpl(absoluteManifestUrl);
  if (!manifestResponse.ok) fail(`manifest returned ${manifestResponse.status}`);
  const manifest = parsePakChunkManifest(await manifestResponse.json());
  const byId = new Map(manifest.chunks.map((chunk) => [chunk.id, chunk]));
  const entryToChunk = new Map();
  for (const chunk of manifest.chunks) for (const key of chunk.entries) entryToChunk.set(key, chunk.id);
  const resident = new Map();
  const pending = new Map();
  const failures = new Map();
  const blockers = new Set();
  let startupBytes = null;

  const load = (id) => {
    if (resident.has(id)) return Promise.resolve();
    const existing = pending.get(id);
    if (existing) return existing;
    const chunk = byId.get(id);
    if (!chunk) return Promise.reject(new Error(`Web pak chunks: unknown chunk ${id}`));
    const promise = fetchAsset(chunk, absoluteManifestUrl, fetchImpl, digest, decompress)
      .then((bytes) => {
        resident.set(id, parsePak(bytes, chunk.entries));
        failures.delete(id);
      })
      .catch((error) => {
        failures.set(id, error instanceof Error ? error.message : String(error));
        throw error;
      })
      .finally(() => pending.delete(id));
    pending.set(id, promise);
    return promise;
  };

  const prepare = (key) => {
    const id = entryToChunk.get(key);
    if (!id || resident.has(id)) return Promise.resolve();
    blockers.add(id);
    return load(id).finally(() => blockers.delete(id));
  };

  const prefetch = (key) => {
    const id = entryToChunk.get(key);
    if (!id || resident.has(id)) return Promise.resolve();
    return load(id);
  };

  return {
    manifest,
    get blocking() {
      return blockers.size > 0;
    },
    async startup() {
      if (startupBytes === null) {
        startupBytes = await fetchAsset(
          manifest.startup,
          absoluteManifestUrl,
          fetchImpl,
          digest,
          decompress,
        );
      }
      return startupBytes.slice(0);
    },
    ready(key) {
      const id = entryToChunk.get(key);
      return id === undefined || resident.has(id);
    },
    read(key, start, end) {
      const id = entryToChunk.get(key);
      const pack = id ? resident.get(id) : undefined;
      const entry = pack?.entries.get(key);
      if (!pack || !entry) return undefined;
      const stop = end ?? entry.length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || stop < start || stop > entry.length) {
        return undefined;
      }
      const value = pack.data.slice(entry.offset + start, entry.offset + stop);
      return value.buffer;
    },
    prepare,
    prefetch,
    startBackground() {
      for (const chunk of manifest.chunks) {
        if (chunk.background) void load(chunk.id).catch((error) => console.error(error));
      }
    },
    stats() {
      return {
        startupBytes: manifest.startup.bytes,
        resident: [...resident.keys()].sort(),
        pending: [...pending.keys()].sort(),
        blocking: [...blockers].sort(),
        failures: Object.fromEntries([...failures].sort(([a], [b]) => a.localeCompare(b))),
        compressedBytes: manifest.startup.bytes + [...resident.keys()]
          .reduce((sum, id) => sum + byId.get(id).bytes, 0),
      };
    },
  };
}
