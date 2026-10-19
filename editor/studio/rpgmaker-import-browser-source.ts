/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Browser-side access to an RPG Maker project selected with the File System
// Access API. Directory handles are indexed once, without reading file
// contents, so the importer can do the synchronous existence/listing probes
// its conversion pass needs while actual bytes remain lazy and async.

import type { RmMap, RmProject, RmSystem } from "../../tools/rpgmaker-import/rm-types.ts";
import { rpgMakerMediaEncryption } from "../../tools/rpgmaker-import/media-crypto.ts";
import { parseRmPlugins } from "../../tools/rpgmaker-import/semantics.ts";
import { browserRpgMakerImportEnvironment, type BrowserRpgMakerImageCodec } from "./rpgmaker-import-browser-io.ts";

export interface BrowserFileLike {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BrowserFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<BrowserFileLike>;
}

export interface BrowserDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
  /** Native directory handles support a targeted lookup without enumerating js/. */
  getFileHandle?(name: string): Promise<BrowserFileHandle>;
}

export interface IndexBrowserSourceOptions {
  signal?: AbortSignal;
  /** Called after each discovered file or directory. The total cannot be
   * known before enumeration, so this is intentionally just a count. */
  onEntry?(count: number, path: string): void;
}

function abortError(): DOMException {
  return new DOMException("The RPG Maker import was cancelled.", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Portable, root-relative path accepted by the virtual source. */
export function browserSourcePath(...parts: string[]): string {
  const path = parts.filter(Boolean).join("/").replace(/\/+/g, "/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." || part.includes("\\") || /[\x00-\x1f\x7f]/.test(part)) {
      throw new Error(`unsafe browser project path ${JSON.stringify(path)}`);
    }
    out.push(part);
  }
  return out.join("/");
}

/** A lazily-read, immutable view of one selected source directory. */
export class BrowserRpgMakerSource {
  readonly name: string;
  private constructor(
    root: BrowserDirectoryHandle,
    private readonly files: ReadonlyMap<string, BrowserFileHandle>,
    private readonly directories: ReadonlyMap<string, readonly string[]>,
    private readonly signal?: AbortSignal,
  ) {
    this.name = root.name;
  }

  static async index(root: BrowserDirectoryHandle, options: IndexBrowserSourceOptions = {}): Promise<BrowserRpgMakerSource> {
    const files = new Map<string, BrowserFileHandle>();
    const directories = new Map<string, string[]>();
    let count = 0;
    const neededDirectory = (path: string): boolean => {
      const parts = path.split("/");
      if (parts[0] === "data" || parts[0] === "img" || parts[0] === "audio") return true;
      if (parts[0] !== "www") return false;
      return parts.length === 1 || parts[1] === "data" || parts[1] === "img" || parts[1] === "audio";
    };
    const walk = async (directory: BrowserDirectoryHandle, base: string): Promise<void> => {
      checkAbort(options.signal);
      const names: string[] = [];
      const entries: (BrowserFileHandle | BrowserDirectoryHandle)[] = [];
      for await (const entry of directory.values()) {
        checkAbort(options.signal);
        entries.push(entry);
      }
      // File System Access iteration order is host-dependent. A stable index
      // gives case-insensitive lookups and tests the same result everywhere.
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        const path = browserSourcePath(base, entry.name);
        if (!path || names.includes(entry.name)) throw new Error(`${root.name}/: duplicate or invalid entry ${JSON.stringify(entry.name)}`);
        names.push(entry.name);
        count += 1;
        options.onEntry?.(count, path);
        // A deployed game can also contain a large js/ runtime, movies,
        // fonts, saves and other folders the importer never reads. Do not
        // enumerate them or let an unrelated permission error block maps.
        if ("values" in entry) {
          if (neededDirectory(path)) await walk(entry, path);
          else if ((path === "js" || path === "www/js") && entry.getFileHandle) {
            // Resolve only the registry; never enumerate or read plugin implementations.
            try {
              files.set(browserSourcePath(path, "plugins.js"), await entry.getFileHandle("plugins.js"));
            } catch (error) {
              if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
            }
          }
        } else files.set(path, entry);
      }
      directories.set(base, names);
    };
    await walk(root, "");
    return new BrowserRpgMakerSource(root, files, directories, options.signal);
  }

  has(path: string): boolean {
    const key = browserSourcePath(path);
    return this.files.has(key) || this.directories.has(key);
  }

  isFile(path: string): boolean {
    return this.files.has(browserSourcePath(path));
  }

  isDirectory(path: string): boolean {
    return this.directories.has(browserSourcePath(path));
  }

  list(path = ""): readonly string[] {
    return this.directories.get(browserSourcePath(path)) ?? [];
  }

  size(path: string): Promise<number> {
    return this.file(path).then((file) => file.size);
  }

  async readText(path: string): Promise<string> {
    const file = await this.file(path);
    checkAbort(this.signal);
    const text = await file.text();
    checkAbort(this.signal);
    return text;
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const file = await this.file(path);
    checkAbort(this.signal);
    const bytes = new Uint8Array(await file.arrayBuffer());
    checkAbort(this.signal);
    return bytes;
  }

  private async file(path: string): Promise<BrowserFileLike> {
    checkAbort(this.signal);
    const key = browserSourcePath(path);
    const handle = this.files.get(key);
    if (!handle) throw new Error(`${this.name}/: file not found: ${key}`);
    const file = await handle.getFile();
    checkAbort(this.signal);
    return file;
  }
}

export class BrowserRmLoadError extends Error {}

function parseJson<T>(path: string, text: string): T {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
  } catch (error) {
    throw new BrowserRmLoadError(`${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function readJson<T>(source: BrowserRpgMakerSource, path: string): Promise<T> {
  return parseJson<T>(path, await source.readText(path));
}

async function readOptional<T>(source: BrowserRpgMakerSource, dataDir: string, name: string): Promise<(T | null)[]> {
  const path = browserSourcePath(dataDir, name);
  if (!source.isFile(path)) return [null];
  const value = await readJson<(T | null)[]>(source, path);
  if (!Array.isArray(value)) throw new BrowserRmLoadError(`${path}: expected an array`);
  return value;
}

export interface BrowserLoadedRmProject {
  project: RmProject;
  source: BrowserRpgMakerSource;
  /** Selected-root-relative directory holding `data/` and `img/`. */
  projectRoot: string;
  dataDir: string;
}

/** Load the JSON database from either `<selected>/data` or
 * `<selected>/www/data`. Media stays lazy in `source`. */
export async function loadBrowserRmProject(
  source: BrowserRpgMakerSource,
  options: { signal?: AbortSignal; codec?: BrowserRpgMakerImageCodec } = {},
): Promise<BrowserLoadedRmProject> {
  const dataDir = ["data", "www/data"].find((candidate) => source.isFile(browserSourcePath(candidate, "System.json")));
  if (!dataDir) {
    throw new BrowserRmLoadError(`${source.name}/: no data/System.json (is this an RPG Maker MV/MZ project?)`);
  }
  const projectRoot = dataDir === "data" ? "" : "www";
  const system = await readJson<RmSystem>(source, browserSourcePath(dataDir, "System.json"));
  let mediaEncryption;
  try {
    mediaEncryption = rpgMakerMediaEncryption(system, `${source.name}/`);
  } catch (error) {
    throw new BrowserRmLoadError(error instanceof Error ? error.message : String(error));
  }
  const mapInfos = await readOptional<RmProject["mapInfos"][number] & object>(source, dataDir, "MapInfos.json");
  const maps = new Map<number, RmMap>();
  for (const info of mapInfos) {
    if (!info) continue;
    const name = `Map${String(info.id).padStart(3, "0")}.json`;
    const path = browserSourcePath(dataDir, name);
    if (!source.isFile(path)) throw new BrowserRmLoadError(`${dataDir}: MapInfos lists map ${info.id} but ${name} is missing`);
    const map = await readJson<RmMap>(source, path);
    if (!Array.isArray(map.data) || map.data.length < map.width * map.height * 4) {
      throw new BrowserRmLoadError(`${name}: data must hold at least 4 z-planes of ${map.width}x${map.height}`);
    }
    maps.set(info.id, map);
  }
  const mz = system.tileSize !== undefined || system.advanced !== undefined ||
    source.isFile(browserSourcePath(projectRoot, "game.rmmzproject"));
  const project: RmProject = {
    // Browser paths are virtual and selected-root-relative. The injected IO
    // adapter resolves them; no native path is ever exposed to the page.
    root: projectRoot,
    flavor: mz ? "MZ" : "MV",
    environment: browserRpgMakerImportEnvironment(source, options),
    ...(mediaEncryption ? { mediaEncryption } : {}),
    system,
    ...(source.isFile(browserSourcePath(projectRoot, "js/plugins.js"))
      ? { plugins: parseRmPlugins(await source.readText(browserSourcePath(projectRoot, "js/plugins.js"))) }
      : {}),
    mapInfos,
    maps,
    tilesets: await readOptional(source, dataDir, "Tilesets.json"),
    commonEvents: await readOptional(source, dataDir, "CommonEvents.json"),
    items: await readOptional(source, dataDir, "Items.json"),
    weapons: await readOptional(source, dataDir, "Weapons.json"),
    armors: await readOptional(source, dataDir, "Armors.json"),
    actors: await readOptional(source, dataDir, "Actors.json"),
    classes: await readOptional(source, dataDir, "Classes.json"),
    skills: await readOptional(source, dataDir, "Skills.json"),
    states: await readOptional(source, dataDir, "States.json"),
    enemies: await readOptional(source, dataDir, "Enemies.json"),
    troops: await readOptional(source, dataDir, "Troops.json"),
    animations: await readOptional(source, dataDir, "Animations.json"),
  };
  return { project, source, projectRoot, dataDir };
}
