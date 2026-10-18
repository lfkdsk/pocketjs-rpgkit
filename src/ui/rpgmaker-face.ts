// Shared, presentation-only lookup for importer-cut RPG Maker face cells.
// Optional renderers import this helper; the base UI and engine stay unaware
// of the RPG Maker actor extension shape.

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** ImportAssets.faces uses the exact stock face identity as its key. */
export function rpgMakerFaceKey(faceName: unknown, faceIndex: unknown): string | undefined {
  if (typeof faceName !== "string" || faceName.length === 0) return undefined;
  if (typeof faceIndex !== "number" || !Number.isSafeInteger(faceIndex) || faceIndex < 0) return undefined;
  return `${faceName}:${faceIndex}`;
}

export function rpgMakerFaceSource(
  faces: Readonly<Record<string, string>> | undefined,
  faceName: unknown,
  faceIndex: unknown,
): string | undefined {
  if (!faces) return undefined;
  const key = rpgMakerFaceKey(faceName, faceIndex);
  return key ? faces[key] : undefined;
}

/** Formation runs outside the battle scene, so it reads the same saved actor
 * runtime that Change Actor Images mutates. Old/malformed extension payloads
 * simply have no portrait rather than creating a presentation error. */
export function rpgMakerRuntimeActorFaceSource(
  faces: Readonly<Record<string, string>> | undefined,
  ext: unknown,
  actorId: number,
): string | undefined {
  if (!faces) return undefined;
  const runtime = record(record(ext)?.rpgmakerBattle);
  const actors = record(runtime?.actors);
  const actor = record(actors?.[String(actorId)]);
  return rpgMakerFaceSource(faces, actor?.faceName, actor?.faceIndex);
}
