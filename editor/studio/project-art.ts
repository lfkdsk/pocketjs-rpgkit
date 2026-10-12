// editor/studio/project-art.ts — where a project's own art lives. Projects
// do not embed pixels: tile sheets and parallax images are named by id,
// image sprites carry a `src` path, and walker sprites and animations a
// `sheet` path. This module turns those references into the relative PNG
// paths to look for, by convention, so a folder host can find the files and
// a pack can carry them (its `assets`, keyed by the same paths).
//
// Pure and host-neutral: no DOM, no file access. Callers probe the paths.

import type { AnimationDef, Sheet, SpriteDef } from "../../src/engine/types.ts";
import { packEntryProblem } from "../api/pack-format.ts";

export type ProjectArtKind = "sheet" | "sprite" | "animation" | "parallax";

export interface ProjectArtRef {
  kind: ProjectArtKind;
  id: string;
  /** Relative POSIX paths to try, in order. */
  candidates: string[];
}

/** A path a project may name for its art: portable and relative (the pack
 * entry-key rule) and a PNG. */
function usable(path: string): boolean {
  return packEntryProblem(path) === null && path.toLowerCase().endsWith(".png");
}

function ref(kind: ProjectArtKind, id: string, paths: readonly (string | undefined)[]): ProjectArtRef {
  const candidates: string[] = [];
  for (const path of paths) if (typeof path === "string" && usable(path) && !candidates.includes(path)) candidates.push(path);
  return { kind, id, candidates };
}

/** Where a project's art lives, by convention, in project order (sheets,
 * sprites, animations, parallaxes):
 * - tile sheet S: "art/sheets/S.png", then "sheets/S.png", then the RPG
 *   Maker importer's "tiles/S.png";
 * - image sprite: its `src`, then "art/sprites/<id>.png";
 * - walker sheet sprite: its `sheet`, then "art/sprites/<id>.png";
 * - animation: its `sheet`;
 * - parallax: an explicit PNG id, else "art/parallaxes/<id>.png", then
 *   "parallaxes/<id>.png".
 * Candidates that are not safe portable relative paths or not ".png" files
 * are dropped, as are duplicates; a ref may end up with no candidates.
 * Legacy walker sprites (one `atlases` image per facing) are skipped: Studio
 * draws a sprite from one image, which those do not have. */
export function projectArtRefs(globals: {
  sheets?: readonly Sheet[];
  sprites?: Readonly<Record<string, SpriteDef>>;
  animations?: readonly AnimationDef[];
  /** Authored parallax image ids collected from map payloads. */
  parallaxes?: readonly string[];
}): ProjectArtRef[] {
  const refs: ProjectArtRef[] = [];
  for (const sheet of globals.sheets ?? []) {
    refs.push(ref("sheet", sheet.id, [`art/sheets/${sheet.id}.png`, `sheets/${sheet.id}.png`, `tiles/${sheet.id}.png`]));
  }
  for (const [id, sprite] of Object.entries(globals.sprites ?? {})) {
    if (sprite.kind === "image") refs.push(ref("sprite", id, [sprite.src, `art/sprites/${id}.png`]));
    else if ("sheet" in sprite) refs.push(ref("sprite", id, [sprite.sheet, `art/sprites/${id}.png`]));
  }
  for (const animation of globals.animations ?? []) refs.push(ref("animation", animation.id, [animation.sheet]));
  for (const id of globals.parallaxes ?? []) {
    // A project may use a portable PNG path as the image id. Imported
    // projects use a logical id and put the file in parallaxes/<id>.png.
    refs.push(ref("parallax", id, id.toLowerCase().endsWith(".png")
      ? [id]
      : [`art/parallaxes/${id}.png`, `parallaxes/${id}.png`]));
  }
  return refs;
}

/** First candidate present in `has`, per ref; refs with none are left out. */
export function resolveProjectArt(refs: readonly ProjectArtRef[], has: (path: string) => boolean): { ref: ProjectArtRef; path: string }[] {
  const found: { ref: ProjectArtRef; path: string }[] = [];
  for (const art of refs) {
    const path = art.candidates.find(has);
    if (path !== undefined) found.push({ ref: art, path });
  }
  return found;
}
