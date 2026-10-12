// tools/rpgmaker-import/load.ts — read one RPG Maker MV/MZ project's
// `data/*.json` into an RmProject. JSON remains plain in MV/MZ deployments;
// encrypted images/audio are decoded lazily by the media readers.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RmMap, RmProject, RmSystem } from "./rm-types.ts";
import { rpgMakerMediaEncryption } from "./media.ts";
import { NODE_RPGMAKER_IMPORT_ENVIRONMENT } from "./environment-node.ts";

export { rmParallaxSpeed, rmTileSize } from "./semantics.ts";

export class RmLoadError extends Error {}

function readJson<T>(path: string): T {
  const text = readFileSync(path, "utf8");
  try {
    // RM writes a UTF-8 BOM in some localized builds.
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
  } catch (e) {
    throw new RmLoadError(`${path}: not valid JSON (${(e as Error).message})`);
  }
}

function readOptional<T>(dataDir: string, name: string): (T | null)[] {
  const path = join(dataDir, name);
  if (!existsSync(path)) return [null];
  const value = readJson<(T | null)[]>(path);
  if (!Array.isArray(value)) throw new RmLoadError(`${path}: expected an array`);
  return value;
}

/** The project root holds `data/` (MV also ships projects under `www/`). */
export function findDataDir(root: string): string {
  for (const candidate of [join(root, "data"), join(root, "www", "data")]) {
    if (existsSync(join(candidate, "System.json"))) return candidate;
  }
  throw new RmLoadError(`${root}: no data/System.json (is this an RPG Maker MV/MZ project?)`);
}

export function loadRmProject(rootArg: string): RmProject {
  const root = resolve(rootArg);
  const dataDir = findDataDir(root);
  const projectRoot = resolve(dataDir, "..");
  const system = readJson<RmSystem>(
    join(dataDir, "System.json"),
  );
  let mediaEncryption;
  try {
    mediaEncryption = rpgMakerMediaEncryption(system, root);
  } catch (error) {
    throw new RmLoadError((error as Error).message);
  }
  const files = new Set(readdirSync(dataDir));
  const mapInfos = readOptional<RmProject["mapInfos"][number] & object>(dataDir, "MapInfos.json");
  const maps = new Map<number, RmMap>();
  for (const info of mapInfos) {
    if (!info) continue;
    const name = `Map${String(info.id).padStart(3, "0")}.json`;
    if (!files.has(name)) throw new RmLoadError(`${dataDir}: MapInfos lists map ${info.id} but ${name} is missing`);
    const map = readJson<RmMap>(join(dataDir, name));
    if (!Array.isArray(map.data) || map.data.length < map.width * map.height * 4) {
      throw new RmLoadError(`${name}: data must hold at least 4 z-planes of ${map.width}x${map.height}`);
    }
    maps.set(info.id, map);
  }
  const mz = system.tileSize !== undefined || system.advanced !== undefined ||
    existsSync(join(projectRoot, "game.rmmzproject"));
  return {
    root: projectRoot,
    flavor: mz ? "MZ" : "MV",
    environment: NODE_RPGMAKER_IMPORT_ENVIRONMENT,
    ...(mediaEncryption ? { mediaEncryption } : {}),
    system,
    mapInfos,
    maps,
    tilesets: readOptional(dataDir, "Tilesets.json"),
    commonEvents: readOptional(dataDir, "CommonEvents.json"),
    items: readOptional(dataDir, "Items.json"),
    weapons: readOptional(dataDir, "Weapons.json"),
    armors: readOptional(dataDir, "Armors.json"),
    actors: readOptional(dataDir, "Actors.json"),
    classes: readOptional(dataDir, "Classes.json"),
    skills: readOptional(dataDir, "Skills.json"),
    states: readOptional(dataDir, "States.json"),
    enemies: readOptional(dataDir, "Enemies.json"),
    troops: readOptional(dataDir, "Troops.json"),
    animations: readOptional(dataDir, "Animations.json"),
  };
}
