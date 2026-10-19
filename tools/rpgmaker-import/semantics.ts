// Small browser-safe RPG Maker project semantics shared by all loaders.

import type { RmPluginDeclaration, RmProject } from "./rm-types.ts";

/** Parse only RPG Maker's JSON-serialized plugin registry assignment. No JS is run. */
export function parseRmPlugins(text: string): RmPluginDeclaration[] {
  const match = /^(?:\uFEFF)?(?:\s|\/\/[^\r\n]*(?:\r?\n|$))*var\s+\$plugins\s*=\s*(\[[\s\S]*\])\s*;?\s*$/.exec(text);
  if (!match) throw new Error("js/plugins.js: expected a JSON plugin registry assignment");
  let value: unknown;
  try {
    value = JSON.parse(match[1]!);
  } catch {
    throw new Error("js/plugins.js: invalid JSON plugin registry");
  }
  if (!Array.isArray(value) || !value.every((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) &&
    typeof entry.name === "string" && typeof entry.status === "boolean" &&
    typeof entry.description === "string" && entry.parameters &&
    typeof entry.parameters === "object" && !Array.isArray(entry.parameters) &&
    Object.values(entry.parameters).every((parameter) => typeof parameter === "string")
  )) throw new Error("js/plugins.js: invalid plugin declaration");
  return value.map((entry) => ({
    name: entry.name,
    status: entry.status,
    description: entry.description,
    parameters: entry.parameters,
  }));
}

/** MV is always 48 px; MZ stores the tile size in System.json. */
export function rmTileSize(rm: RmProject): number {
  return rm.system.tileSize ?? 48;
}

/** Convert RPG Maker's source-pixel parallax rate to the kit's 16 px grid. */
export function rmParallaxSpeed(rm: RmProject, speed: number): number {
  return speed * 16 / rmTileSize(rm);
}
