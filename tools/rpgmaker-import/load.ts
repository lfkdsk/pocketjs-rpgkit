// tools/rpgmaker-import/load.ts — read one RPG Maker MV/MZ project's
// `data/*.json` into an RmProject. Only plain (unencrypted) JSON is read;
// a deployed game whose data or images were encrypted by the editor's
// deployment option is refused, never decrypted.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RmMap, RmProject, RmSystem } from "./rm-types.ts";

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
  const system = readJson<RmSystem & { hasEncryptedImages?: boolean; hasEncryptedAudio?: boolean }>(
    join(dataDir, "System.json"),
  );
  if (system.hasEncryptedImages || system.hasEncryptedAudio) {
    // The importer only reads plain files; it does not decrypt deployed
    // games. Images are only needed for art, so refuse up front.
    throw new RmLoadError(
      `${root}: System.json marks encrypted images/audio; the importer reads unencrypted projects only`,
    );
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

/** MV is always 48 px; MZ stores the tile size in System.json. */
export function rmTileSize(rm: RmProject): number {
  return rm.system.tileSize ?? 48;
}

/** MV/MZ scroll a looping parallax by speed/4 source pixels per frame at
 *  any tile size; the kit scrolls speed/4 kit pixels per reference tick.
 *  Converting source pixels to 16 px kit pixels keeps the on-screen rate
 *  (a third of the source speed for 48 px tiles). */
export function rmParallaxSpeed(rm: RmProject, speed: number): number {
  return speed * 16 / rmTileSize(rm);
}
