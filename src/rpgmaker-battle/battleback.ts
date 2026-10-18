import type { RpgMakerBattleMapSettings } from "./types.ts";

/** Stock MV/MZ overworld battle-floor name for one recognized autotile kind. */
function battleback1ForKind(kind: number): string | undefined {
  if (kind === 24 || kind === 25) return "Wasteland";
  if (kind === 26 || kind === 27) return "DirtField";
  if (kind === 32 || kind === 33) return "Desert";
  if (kind === 34) return "Lava1";
  if (kind === 35) return "Lava2";
  if (kind === 40 || kind === 41) return "Snowfield";
  if (kind === 42) return "Clouds";
  if (kind === 4 || kind === 5) return "PoisonSwamp";
  return undefined;
}

/** Stock MV/MZ overworld battle-wall name for one recognized autotile kind. */
function battleback2ForKind(kind: number): string | undefined {
  if (kind === 20 || kind === 21) return "Forest";
  if (kind === 22 || kind === 30 || kind === 38) return "Cliff";
  if (kind >= 24 && kind <= 27) return "Wasteland";
  if (kind === 32 || kind === 33) return "Desert";
  if (kind === 34 || kind === 35) return "Lava";
  if (kind === 40 || kind === 41) return "Snowfield";
  if (kind === 42) return "Clouds";
  if (kind === 4 || kind === 5) return "PoisonSwamp";
  return undefined;
}

/** Stock public helpers retain the final normal-battleback fallback. */
export const rpgMakerBattleback1ForKind = (kind: number): string =>
  battleback1ForKind(kind) ?? "Grassland";
export const rpgMakerBattleback2ForKind = (kind: number): string =>
  battleback2ForKind(kind) ?? "Grassland";

export interface RpgMakerBattlebackSelection {
  battleback1Name: string;
  battleback2Name: string;
}

/** Resolve stock battleback priority for an ordinary (non battle-test)
 * battle. Explicit empty names remain empty; only an unspecified overworld
 * map falls back to vehicle/terrain defaults. */
export function resolveRpgMakerBattlebacks(
  setting: Readonly<RpgMakerBattleMapSettings> | undefined,
  cell: Readonly<{ x: number; y: number }> | undefined,
  vehicle: string | null | undefined,
): RpgMakerBattlebackSelection {
  if (!setting) return { battleback1Name: "", battleback2Name: "" };
  // Databases imported before `specified` existed already treated the two
  // retained names as explicit. Preserve that save/content behavior.
  if (setting.specified !== false) {
    return {
      battleback1Name: setting.battleback1Name,
      battleback2Name: setting.battleback2Name,
    };
  }
  if (setting.overworld !== true) return { battleback1Name: "", battleback2Name: "" };
  if (vehicle !== null && vehicle !== undefined) {
    return { battleback1Name: "Ship", battleback2Name: "Ship" };
  }
  const index = cell && setting.width && setting.width > 0 ? cell.y * setting.width + cell.x : -1;
  const kinds = setting.autotileKinds?.find((entry) => entry[0] === index);
  const upper = kinds?.[1] ?? -1;
  // Two-field rows are databases imported before independent layer fallback
  // was retained. Reuse their selected kind for both layers.
  const lower = kinds?.[2] ?? upper;
  return {
    battleback1Name: battleback1ForKind(upper) ?? battleback1ForKind(lower) ?? "Grassland",
    battleback2Name: battleback2ForKind(upper) ?? battleback2ForKind(lower) ?? "Grassland",
  };
}
