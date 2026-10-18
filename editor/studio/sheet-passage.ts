// editor/studio/sheet-passage.ts — pure tile-sheet passage resolution and
// update helpers shared by Studio controls and canvas overlays.

import type { Dir, Sheet } from "../../src/engine/types.ts";

/** Runtime direction/bit order from engine/passability.ts. Keep this explicit
 * so overlay and editor tests catch a direction being wired to the wrong edge. */
export const SHEET_PASSAGE_DIRECTIONS = ["down", "left", "up", "right"] as const satisfies readonly Dir[];

export const SHEET_PASSAGE_DIRECTION_BITS: Readonly<Record<Dir, number>> = {
  down: 1,
  left: 2,
  up: 4,
  right: 8,
};

export type SheetCellPassageOverride = "default" | "pass" | "block";

export interface ResolvedSheetCellPassage {
  /** Missing defaultPassage has always meant pass at runtime. */
  defaultPassage: "pass" | "block";
  authoredDefault: "pass" | "block" | null;
  value: "pass" | "block";
  source: "default" | "pass" | "block";
  blocked: boolean;
  dirBlock: Dir[];
  dirBlockMask: number;
}

/** The subset accepted by update-sheet. null removes an optional field. */
export interface SheetPassageChanges {
  defaultPassage?: "pass" | "block" | null;
  block?: number[] | null;
  pass?: number[] | null;
  dirBlock?: Record<string, Dir[]> | null;
}

function normalizedCells(values: readonly number[] | undefined): number[] {
  return [...new Set((values ?? []).filter((cell) => Number.isSafeInteger(cell) && cell >= 0))]
    .sort((a, b) => a - b);
}

function normalizedTargets(cells: number | readonly number[]): number[] {
  const normalized = normalizedCells(typeof cells === "number" ? [cells] : cells);
  if (normalized.length === 0) throw new Error("at least one non-negative sheet cell is required");
  return normalized;
}

function normalizedDirections(directions: readonly Dir[] | undefined): Dir[] {
  if (!directions) return [];
  const present = new Set(directions);
  return SHEET_PASSAGE_DIRECTIONS.filter((direction) => present.has(direction));
}

/** Remove empty entries, duplicate directions and non-canonical numeric keys.
 * Multiple spellings such as "1" and "01" merge onto the runtime key "1". */
export function normalizeSheetDirBlock(
  dirBlock: Readonly<Record<string, readonly Dir[]>> | undefined,
): Record<string, Dir[]> | undefined {
  if (!dirBlock) return undefined;
  const merged = new Map<number, Set<Dir>>();
  for (const [rawCell, directions] of Object.entries(dirBlock)) {
    const cell = Number(rawCell);
    if (!Number.isSafeInteger(cell) || cell < 0) continue;
    const entry = merged.get(cell) ?? new Set<Dir>();
    for (const direction of normalizedDirections(directions)) entry.add(direction);
    if (entry.size > 0) merged.set(cell, entry);
  }
  if (merged.size === 0) return undefined;
  const normalized: Record<string, Dir[]> = {};
  for (const cell of [...merged.keys()].sort((a, b) => a - b)) {
    normalized[String(cell)] = normalizedDirections([...merged.get(cell)!]);
  }
  return normalized;
}

export function sheetDirBlockMask(sheet: Pick<Sheet, "dirBlock">, cell: number): number {
  const directions = normalizedDirections(sheet.dirBlock?.[String(cell)]);
  return directions.reduce((mask, direction) => mask | SHEET_PASSAGE_DIRECTION_BITS[direction], 0);
}

/** Resolve exactly like engine/passability.ts: pass wins over block, then the
 * sheet default applies. The explicit source is useful for honest UI labels. */
export function resolveSheetCellPassage(
  sheet: Pick<Sheet, "defaultPassage" | "block" | "pass" | "dirBlock">,
  cell: number,
): ResolvedSheetCellPassage {
  const defaultPassage = sheet.defaultPassage ?? "pass";
  const source = sheet.pass?.includes(cell)
    ? "pass"
    : sheet.block?.includes(cell)
      ? "block"
      : "default";
  const value = source === "default" ? defaultPassage : source;
  // Runtime lookup uses the canonical String(cell) key too. Normalize only
  // this small direction list here; normalizing a whole sheet per map cell
  // would make canvas overlay cost quadratic in authored entries.
  const dirBlock = normalizedDirections(sheet.dirBlock?.[String(cell)]);
  return {
    defaultPassage,
    authoredDefault: sheet.defaultPassage ?? null,
    value,
    source,
    blocked: value === "block",
    dirBlock,
    dirBlockMask: dirBlock.reduce((mask, direction) => mask | SHEET_PASSAGE_DIRECTION_BITS[direction], 0),
  };
}

/** Set or clear a sheet-wide default without rewriting the rest of the sheet. */
export function setSheetDefaultPassage(value: "pass" | "block" | null): SheetPassageChanges {
  return { defaultPassage: value };
}

/** Build one update-sheet changes object for one or many atlas cells. Setting
 * either exception always removes those cells from the opposite list. */
export function setSheetCellsPassage(
  sheet: Pick<Sheet, "block" | "pass">,
  cells: number | readonly number[],
  value: SheetCellPassageOverride,
): SheetPassageChanges {
  const targets = normalizedTargets(cells);
  const selected = new Set(targets);
  const pass = normalizedCells(sheet.pass).filter((cell) => !selected.has(cell));
  const block = normalizedCells(sheet.block).filter((cell) => !selected.has(cell));
  if (value === "pass") pass.push(...targets);
  else if (value === "block") block.push(...targets);
  pass.sort((a, b) => a - b);
  block.sort((a, b) => a - b);
  return {
    pass: pass.length > 0 ? pass : null,
    block: block.length > 0 ? block : null,
  };
}

/** Add/remove one symmetric wall direction on one or many atlas cells. */
export function setSheetCellsDirBlocked(
  sheet: Pick<Sheet, "dirBlock">,
  cells: number | readonly number[],
  direction: Dir,
  blocked: boolean,
): SheetPassageChanges {
  const targets = normalizedTargets(cells);
  const dirBlock = normalizeSheetDirBlock(sheet.dirBlock) ?? {};
  for (const cell of targets) {
    const key = String(cell);
    const directions = new Set(dirBlock[key] ?? []);
    if (blocked) directions.add(direction);
    else directions.delete(direction);
    const normalized = normalizedDirections([...directions]);
    if (normalized.length > 0) dirBlock[key] = normalized;
    else delete dirBlock[key];
  }
  return { dirBlock: Object.keys(dirBlock).length > 0 ? dirBlock : null };
}

/** Remove every symmetric wall direction from the selected atlas cells. */
export function clearSheetCellsDirBlock(
  sheet: Pick<Sheet, "dirBlock">,
  cells: number | readonly number[],
): SheetPassageChanges {
  const targets = new Set(normalizedTargets(cells).map(String));
  const dirBlock = normalizeSheetDirBlock(sheet.dirBlock) ?? {};
  for (const key of targets) delete dirBlock[key];
  return { dirBlock: Object.keys(dirBlock).length > 0 ? dirBlock : null };
}

/** Stable protocol operation used by both inline and sharded Studio sessions. */
export function updateSheetPassageOperation(sheet: string, changes: SheetPassageChanges) {
  return { command: "update-sheet" as const, args: { sheet, changes } };
}

export interface SheetEdgeLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Geometry for the distinct solid line used by the authored dirBlock overlay. */
export function sheetDirBlockLine(direction: Dir, px: number, py: number, size: number): SheetEdgeLine {
  if (direction === "up") return { x1: px, y1: py, x2: px + size, y2: py };
  if (direction === "down") return { x1: px, y1: py + size, x2: px + size, y2: py + size };
  if (direction === "left") return { x1: px, y1: py, x2: px, y2: py + size };
  return { x1: px + size, y1: py, x2: px + size, y2: py + size };
}
