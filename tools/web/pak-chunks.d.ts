export interface PakChunkAsset {
  file: string;
  encoding: "gzip";
  bytes: number;
  unpackedBytes: number;
  sha256: string;
}

export interface PakChunk extends PakChunkAsset {
  id: string;
  entries: string[];
  background: boolean;
}

export interface PakChunkManifest {
  version: 1;
  format: "pocket-pak-chunks/v1";
  startup: PakChunkAsset;
  chunks: PakChunk[];
}

export interface PakChunkStats {
  startupBytes: number;
  resident: string[];
  pending: string[];
  queued: string[];
  blocking: string[];
  failures: Record<string, string>;
  compressedBytes: number;
}

export interface PakChunkLoader {
  readonly manifest: PakChunkManifest;
  readonly blocking: boolean;
  startup(): Promise<ArrayBuffer>;
  ready(key: string): boolean;
  read(key: string, start: number, end?: number): ArrayBuffer | undefined;
  prepare(key: string): Promise<void>;
  prefetch(key: string): Promise<void>;
  startBackground(): void;
  stats(): PakChunkStats;
}

export interface PakChunkLoaderOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  sha256?: (bytes: ArrayBuffer) => Promise<string>;
  gunzip?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  baseUrl?: string | URL;
  /** Maximum number of low-priority post-first-frame fetches. Default 2. */
  backgroundConcurrency?: number;
}

export function parsePakChunkManifest(value: unknown): PakChunkManifest;
export function openPakChunkLoader(
  manifestUrl: string | URL,
  options?: PakChunkLoaderOptions,
): Promise<PakChunkLoader>;
