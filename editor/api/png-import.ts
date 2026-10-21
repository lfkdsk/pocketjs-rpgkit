// Portable PNG grid geometry and catalog import. Pixels are cropped into the
// engine's fixed 16px tile grid; walker cells use the existing 3x4 layout.
import type { EditSession, SessionOperation } from "./session.ts";
import { PNG_HEADER_BYTES, pngProblem, readPngSize } from "./limits.ts";
import { encodeBase64, type PackAsset } from "./pack-format.ts";

export type PngImportKind = "sheet" | "walker";
export interface PngGrid {
  cellWidth: number;
  cellHeight: number;
  offsetX: number;
  offsetY: number;
  spacingX: number;
  spacingY: number;
}
export interface PngImportRequest {
  kind: PngImportKind;
  id: string;
  bytes: Uint8Array;
  grid: PngGrid;
  /** Source label for validation messages; project identity remains `id`. */
  sourceName?: string;
  /** Tile sheets are attached to this map so the map brush can paint them. */
  map?: string;
  /** Explicit replacement; callers must ask the user before setting this. */
  replace?: boolean;
}

export function gridCount(size: number, cell: number, offset: number, spacing: number): number {
  if (![size, cell, offset, spacing].every(Number.isInteger) || cell < 1 || offset < 0 || spacing < 0 || offset + cell > size) return 0;
  return 1 + Math.floor((size - offset - cell) / (cell + spacing));
}

export function pngGridProblem(width: number, height: number, grid: PngGrid, kind: PngImportKind): string | null {
  const { cellWidth, cellHeight, offsetX, offsetY, spacingX, spacingY } = grid;
  if (![cellWidth, cellHeight, offsetX, offsetY, spacingX, spacingY].every(Number.isInteger) ||
      cellWidth < 1 || cellHeight < 1 || offsetX < 0 || offsetY < 0 || spacingX < 0 || spacingY < 0) {
    return "Grid sizes must be positive integers; offsets and spacing must be non-negative integers.";
  }
  const cols = gridCount(width, cellWidth, offsetX, spacingX);
  const rows = gridCount(height, cellHeight, offsetY, spacingY);
  if (!cols || !rows) return "No complete grid cell fits inside the PNG.";
  if (kind === "walker" && (cols !== 3 || rows !== 4 || cellWidth !== 16 || (cellHeight !== 16 && cellHeight !== 32))) {
    return "Walker sheets need exactly 3 columns × 4 rows of 16×16 or 16×32 cells (down, left, right, up).";
  }
  if (kind === "sheet" && cols * rows > 65536) return "A tile sheet can have at most 65,536 cells.";
  return null;
}

export function pngImportProblem(request: PngImportRequest): string | null {
  const { bytes, grid, kind, id } = request;
  const problem = pngProblem(request.sourceName ?? `${id || "asset"}.png`, bytes.length, bytes.subarray(0, PNG_HEADER_BYTES));
  if (problem) return problem;
  if (!/^[a-z0-9_-]+$/.test(id)) return "Asset id needs only lowercase letters, digits, underscore or hyphen.";
  const size = readPngSize(bytes)!;
  return pngGridProblem(size.width, size.height, grid, kind);
}

/** Pixel buffer is RGBA, row-major. Source coordinates MUST include offset
 * and spacing. Exported PNG is tightly packed; engine art always uses 16px
 * tile cells, and walker art uses 16px wide cells. */
export function cropGrid(rgba: Uint8Array, width: number, height: number, grid: PngGrid): { rgba: Uint8Array; width: number; height: number; cols: number; rows: number } {
  const cols = gridCount(width, grid.cellWidth, grid.offsetX, grid.spacingX);
  const rows = gridCount(height, grid.cellHeight, grid.offsetY, grid.spacingY);
  const outWidth = cols * grid.cellWidth;
  const outHeight = rows * grid.cellHeight;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const sx = grid.offsetX + col * (grid.cellWidth + grid.spacingX);
    const sy = grid.offsetY + row * (grid.cellHeight + grid.spacingY);
    for (let y = 0; y < grid.cellHeight; y++) {
      const src = ((sy + y) * width + sx) * 4;
      const dest = ((row * grid.cellHeight + y) * outWidth + col * grid.cellWidth) * 4;
      out.set(rgba.subarray(src, src + grid.cellWidth * 4), dest);
    }
  }
  return { rgba: out, width: outWidth, height: outHeight, cols, rows };
}

/** The edit API commits catalog JSON + pack art as one undoable history step.
 * `cooked` must be the cropped PNG; the original is checked first, preserving
 * the same local PNG limit messages used by Studio's existing picker. */
export function importPng(session: EditSession, request: PngImportRequest, cooked: Uint8Array): { ok: boolean; message: string } {
  const problem = pngImportProblem(request);
  if (problem) return { ok: false, message: problem };
  const { kind, id, replace, grid } = request;
  if (kind === "sheet" && (grid.cellWidth !== 16 || grid.cellHeight !== 16)) return { ok: false, message: "Tile sheets need 16×16 cells for the map brush." };
  const size = readPngSize(request.bytes)!;
  const cols = gridCount(size.width, grid.cellWidth, grid.offsetX, grid.spacingX);
  const rows = gridCount(size.height, grid.cellHeight, grid.offsetY, grid.spacingY);
  const cookedProblem = pngProblem(`${id}.png`, cooked.length, cooked.subarray(0, PNG_HEADER_BYTES));
  if (cookedProblem) return { ok: false, message: cookedProblem };
  const cookedSize = readPngSize(cooked)!;
  if (cookedSize.width !== cols * grid.cellWidth || cookedSize.height !== rows * grid.cellHeight) {
    return { ok: false, message: `Cropped PNG must be ${cols * grid.cellWidth}×${rows * grid.cellHeight} px.` };
  }
  const existing = kind === "sheet" ? session.sheets().find((sheet) => sheet.id === id) : session.sprites()[id];
  if (existing && !replace) return { ok: false, message: `${id} already exists; rename it or confirm replacement.` };
  if (kind === "sheet" && existing && "cols" in existing && existing.cols !== undefined && existing.rows !== undefined &&
      cols * rows < existing.cols * existing.rows &&
      session.maps().some(({ id: map }) => session.map(map)?.sheets?.includes(id))) {
    return { ok: false, message: `Cannot replace ${id}: ${cols * rows} cells is fewer than ${existing.cols * existing.rows} cells used by a map.` };
  }
  const path = kind === "sheet" ? `art/sheets/${id}.png` : `art/sprites/${id}.png`;
  const asset: PackAsset = { type: "image/png", data: encodeBase64(cooked) };
  const op = kind === "sheet"
    ? existing ? { command: "update-sheet" as const, args: { sheet: id, changes: { cols, rows } } }
      : { command: "add-sheet" as const, args: { sheet: { id, pak: "chunks", cols, rows } } }
    : existing ? { command: "update-sprite" as const, args: { sprite: id, value: { kind: "walker", sheet: path, h: grid.cellHeight, cols: 3, rows: 4 } } }
      : { command: "add-sprite" as const, args: { sprite: id, value: { kind: "walker", sheet: path, h: grid.cellHeight, cols: 3, rows: 4 } } };
  const operations: SessionOperation[] = [op];
  if (kind === "sheet" && request.map) {
    const map = session.map(request.map);
    if (!map) return { ok: false, message: `Unknown map: ${request.map}` };
    if (!map.sheets?.includes(id)) operations.push({ command: "update-map", args: { map: request.map, changes: { sheets: [...(map.sheets ?? []), id] } } });
  }
  return session.importPngAsset(operations, path, asset, `${replace ? "Replace" : "Import"} ${kind === "sheet" ? "tile sheet" : "walker"} ${id}`);
}
