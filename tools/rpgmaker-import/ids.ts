// tools/rpgmaker-import/ids.ts — how RPG Maker's numeric ids become
// rpgkit-project/v1 string ids. Every converter uses these so references
// (transfers, common event calls, page conditions, shop goods) agree.

const pad3 = (n: number): string => String(n).padStart(3, "0");

/** Map 1 -> "map001". */
export const mapId = (rmMapId: number): string => `map${pad3(rmMapId)}`;
/** Event 7 on its map -> "ev007". */
export const eventId = (rmEventId: number): string => `ev${pad3(rmEventId)}`;
/** Common event 2 -> "ce002". */
export const commonId = (rmCommonId: number): string => `ce${pad3(rmCommonId)}`;
/** Switch 1 -> "s001". */
export const switchId = (n: number): string => `s${pad3(n)}`;
/** Variable 1 -> "v001". */
export const variableId = (n: number): string => `v${pad3(n)}`;
/** Database items, weapons and armors share the kit's single item bank. */
export const itemId = (kind: "item" | "weapon" | "armor", n: number): string => `${kind}${pad3(n)}`;
/** Database animation 4 -> "anim004". */
export const animationId = (n: number): string => `anim${pad3(n)}`;
/** Database actor 4 -> "actor004". */
export const actorId = (n: number): string => `actor${pad3(n)}`;
/** Party membership is a switch per actor: Change Party Member writes it,
 *  the "actor in party" condition reads it. */
export const partySwitchId = (actorId: number): string => `party-actor${pad3(actorId)}`;
/** Scratch variables for importer lowerings (comparisons against another
 *  variable, constant multiplication). Never read across commands. */
export const tempVariableId = (k: number): string => `rmi-tmp${k}`;
/** Logical audio id for a BGM/BGS/ME/SE file name. */
export const audioId = (kind: "bgm" | "bgs" | "me" | "se", name: string): string =>
  `${kind}-${slug(name)}`;

/** Lower-case [a-z0-9_-] slug of a file name (other characters become "-"). */
export function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length > 0 ? s : "x";
}
