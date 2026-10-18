/// <reference lib="dom" />
// editor/studio/palette.ts — the brush panel under the map list: tile sheets
// of the current map (with zoom and a recently-used strip), or the passage /
// one-way edge brushes when those layers are active.

import type { Sheet, TileId } from "../../src/engine/types.ts";
import type { EdgeBrushValue, StudioApp, TileSelection } from "./app.ts";
import { ArtRegistry, TILE, parseTileId } from "./art.ts";
import { emptyState, h, icon, replace } from "./dom.ts";
import {
  clearSheetCellsDirBlock,
  resolveSheetCellPassage,
  setSheetCellsDirBlocked,
  setSheetCellsPassage,
  setSheetDefaultPassage,
  updateSheetPassageOperation,
  type SheetPassageChanges,
} from "./sheet-passage.ts";

const DIRS = ["up", "down", "left", "right"] as const;
const ARROWS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };

export interface TileSearchResult {
  tile: string;
  sheet: string;
  cell: number;
}

/** Search only the sheets declared by the open map. Numeric queries match a
 * cell exactly; other queries match a sheet id or full `sheet.cell` id. */
export function searchPaletteTiles(
  sheets: readonly Sheet[],
  query: string,
  limit = 256,
): { matches: TileSearchResult[]; total: number } {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return { matches: [], total: 0 };
  const numeric = /^#?\d+$/.test(normalized) ? Number(normalized.replace(/^#/, "")) : null;
  const matches: TileSearchResult[] = [];
  let total = 0;
  for (const sheet of sheets) {
    const sheetName = sheet.id.toLocaleLowerCase();
    const count = sheet.cols * sheet.rows;
    for (let cell = 0; cell < count; cell++) {
      const tile = `${sheet.id}.${cell}`;
      const hit = numeric === null
        ? sheetName.includes(normalized) || tile.toLocaleLowerCase().includes(normalized)
        : cell === numeric;
      if (!hit) continue;
      total++;
      if (matches.length < limit) matches.push({ tile, sheet: sheet.id, cell });
    }
  }
  return { matches, total };
}

export function rectangularTileSelection(
  sheet: Sheet,
  from: { x: number; y: number },
  to: { x: number; y: number },
): TileSelection {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const width = Math.abs(from.x - to.x) + 1;
  const height = Math.abs(from.y - to.y) + 1;
  const tiles: string[] = [];
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) tiles.push(`${sheet.id}.${py * sheet.cols + px}`);
  }
  return { sheet: sheet.id, x, y, width, height, tiles };
}

export function mountPalette(root: HTMLElement, app: StudioApp, art: ArtRegistry): void {
  let sheetId = "";
  let query = "";
  let composingSearch = false;
  let atlasCursor: { sheet: string; x: number; y: number; anchor: { x: number; y: number } | null } | null = null;
  /** Display scale; null fits the sheet to the panel width. */
  let zoom: number | null = null;
  const header = h("div", { class: "panel-header" });
  const body = h("div", { class: "palette-body" });
  root.append(header, body);

  function sheetsOfMap(): Sheet[] {
    const map = app.currentMap();
    const all = app.session?.sheets() ?? [];
    const declared = map?.sheets ?? all.map((sheet) => sheet.id);
    return declared.map((id) => all.find((sheet) => sheet.id === id)).filter((sheet): sheet is Sheet => !!sheet);
  }

  /** Largest scale (at least 1) that shows the whole sheet width. */
  function fitZoom(sheet = sheetsOfMap().find((item) => item.id === sheetId)): number {
    const width = root.clientWidth - 22;
    return sheet && width > 0 ? Math.max(1, width / (sheet.cols * TILE)) : 2;
  }

  function tileThumb(tile: string, size: number): HTMLCanvasElement {
    const canvas = h("canvas", { class: "tile-thumb", width: TILE, height: TILE, title: tile });
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    const parsed = parseTileId(tile);
    const sheet = parsed && app.session?.sheets().find((item) => item.id === parsed.sheet);
    if (parsed && sheet) {
      const ctx = canvas.getContext("2d")!;
      const image = art.sheetImage(sheet.id) ?? art.placeholderSheet(sheet.id, sheet.cols, sheet.rows);
      ctx.drawImage(image, (parsed.cell % sheet.cols) * TILE, Math.floor(parsed.cell / sheet.cols) * TILE, TILE, TILE, 0, 0, TILE, TILE);
    }
    return canvas;
  }

  function chooseTile(tile: string): void {
    sheetId = parseTileId(tile)?.sheet ?? sheetId;
    app.setBrush(tile);
    if (app.tool !== "pencil" && app.tool !== "rect" && app.tool !== "fill") app.setTool("pencil");
  }

  function renderTiles(): void {
    const activeSearch = document.activeElement instanceof HTMLInputElement && document.activeElement.dataset.testid === "tile-search"
      ? document.activeElement
      : null;
    // A brush choice rebuilds this panel synchronously. Remember the sheet,
    // then find the newest canvas after all same-turn rebuilds have finished.
    const restoreAtlasFocus = document.activeElement instanceof HTMLCanvasElement && document.activeElement.classList.contains("palette-canvas")
      ? document.activeElement.dataset.sheet ?? null
      : null;
    const restoreSearch = activeSearch ? {
      start: activeSearch.selectionStart,
      end: activeSearch.selectionEnd,
      direction: activeSearch.selectionDirection,
    } : null;
    const sheets = sheetsOfMap();
    if (!sheets.some((sheet) => sheet.id === sheetId)) {
      const brushSheet = app.brush ? parseTileId(app.brush)?.sheet : undefined;
      sheetId = sheets.find((sheet) => sheet.id === brushSheet)?.id ?? sheets[0]?.id ?? "";
    }
    const sheet = sheets.find((item) => item.id === sheetId);
    const declared = new Map(sheets.map((item) => [item.id, item]));
    const isAvailable = (tile: string): boolean => {
      const parsed = parseTileId(tile);
      const owner = parsed ? declared.get(parsed.sheet) : undefined;
      return !!owner && parsed!.cell < owner.cols * owner.rows;
    };
    const recent = app.recentTiles.filter((tile): tile is string => tile !== null && isAvailable(tile));
    const favorites = app.favoriteTiles.filter(isAvailable);
    const strip = (label: string, tiles: string[], role: string): HTMLElement => h("div", { class: "tile-strip", "aria-label": role },
      h("span", { class: "tile-strip-label muted" }, label),
      tiles.length === 0 ? h("span", { class: "muted tile-strip-empty" }, "—") : tiles.map((tile) => h("button", {
        type: "button",
        class: `recent-tile${tile === app.brush ? " active" : ""}`,
        title: tile,
        "aria-label": `Tile ${tile}`,
        dataset: { tile },
        onclick: () => chooseTile(tile),
      }, tileThumb(tile, 24))),
    );
    replace(header,
      h("span", { class: "panel-title" }, "Tiles"),
      h("div", { class: "segmented small", role: "tablist", "aria-label": "Tile sheet" },
        sheets.map((item) => h("button", {
          type: "button",
          role: "tab",
          class: item.id === sheetId ? "active" : "",
          "aria-selected": String(item.id === sheetId),
          title: `Sheet ${item.id} (${item.cols}×${item.rows})`,
          onclick: () => { sheetId = item.id; render(); },
        }, item.id))),
      h("div", { class: "spacer" }),
      h("button", { type: "button", class: "icon-button tiny", title: "Smaller tiles", "aria-label": "Smaller tiles", onclick: () => { zoom = Math.max(1, Math.round((zoom ?? fitZoom()) - 1)); render(); } }, icon("zoomOut")),
      h("button", { type: "button", class: "icon-button tiny", title: "Larger tiles", "aria-label": "Larger tiles", onclick: () => { zoom = Math.min(4, Math.round((zoom ?? fitZoom()) + 1)); render(); } }, icon("zoomIn")),
    );

    const search = h("input", {
      type: "search",
      class: "tile-search",
      value: query,
      placeholder: "Find sheet, tile id or #",
      "aria-label": "Search tiles by sheet name or cell number",
      dataset: { testid: "tile-search" },
      oninput: (event: Event) => {
        query = (event.currentTarget as HTMLInputElement).value;
        if (!composingSearch && !(event as InputEvent).isComposing) renderTiles();
      },
      oncompositionstart: () => { composingSearch = true; },
      oncompositionend: (event: CompositionEvent) => {
        composingSearch = false;
        query = (event.currentTarget as HTMLInputElement).value;
        renderTiles();
      },
    });
    const searchWrap = h("label", { class: "tile-search-wrap" }, icon("search"), search,
      query ? h("button", {
        type: "button", class: "icon-button tiny tile-search-clear", title: "Clear tile search", "aria-label": "Clear tile search",
        onclick: () => { query = ""; renderTiles(); },
      }, icon("close")) : null);
    const strips = h("div", { class: "tile-strips" },
      strip("Favorites", favorites, "Favorite tiles"),
      strip("Recent", recent, "Recently used tiles"));

    if (!sheet) {
      replace(body, searchWrap, strips, emptyState("image", "No tile sheets", "Add a sheet to this map before painting tiles."));
      if (restoreSearch) queueMicrotask(() => {
        search.focus();
        search.setSelectionRange(restoreSearch.start, restoreSearch.end, restoreSearch.direction ?? undefined);
      });
      return;
    }

    let atlasDrag: { pointer: number; from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
    const canvas = h("canvas", {
      class: "palette-canvas",
      width: sheet.cols * TILE,
      height: sheet.rows * TILE,
      tabIndex: 0,
      "aria-label": `Tile sheet ${sheet.id}; drag to select a rectangular pattern`,
    });
    canvas.dataset.sheet = sheet.id;
    const scale = zoom ?? fitZoom(sheet);
    canvas.style.width = `${Math.floor(sheet.cols * TILE * scale)}px`;
    canvas.style.height = `${Math.floor(sheet.rows * TILE * scale)}px`;
    const ctx = canvas.getContext("2d")!;
    const selectionColor = getComputedStyle(root).getPropertyValue("--canvas-select").trim() || "#f0b429";
    if (!atlasCursor || atlasCursor.sheet !== sheet.id) {
      const selection = app.tileSelection?.sheet === sheet.id ? app.tileSelection : null;
      if (selection) {
        atlasCursor = {
          sheet: sheet.id,
          x: selection.x + selection.width - 1,
          y: selection.y + selection.height - 1,
          anchor: selection.width === 1 && selection.height === 1 ? null : { x: selection.x, y: selection.y },
        };
      } else {
        const brush = app.brush ? parseTileId(app.brush) : null;
        atlasCursor = {
          sheet: sheet.id,
          x: brush?.sheet === sheet.id ? brush.cell % sheet.cols : 0,
          y: brush?.sheet === sheet.id ? Math.floor(brush.cell / sheet.cols) : 0,
          anchor: null,
        };
      }
    }
    const drawAtlas = (preview = atlasDrag
      ? rectangularTileSelection(sheet, atlasDrag.from, atlasDrag.to)
      : document.activeElement === canvas && atlasCursor
        ? rectangularTileSelection(sheet, atlasCursor.anchor ?? atlasCursor, atlasCursor)
        : app.tileSelection): void => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(art.sheetImage(sheet.id) ?? art.placeholderSheet(sheet.id, sheet.cols, sheet.rows), 0, 0);
      const selected = preview?.sheet === sheet.id ? preview : null;
      if (selected) {
        ctx.save();
        ctx.globalAlpha = 0.24;
        ctx.fillStyle = selectionColor;
        ctx.fillRect(selected.x * TILE, selected.y * TILE, selected.width * TILE, selected.height * TILE);
        ctx.restore();
        ctx.strokeStyle = selectionColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(selected.x * TILE + 0.5, selected.y * TILE + 0.5, selected.width * TILE - 1, selected.height * TILE - 1);
      } else {
        const brush = app.brush ? parseTileId(app.brush) : null;
        if (brush && brush.sheet === sheet.id) {
          ctx.strokeStyle = selectionColor;
          ctx.lineWidth = 1;
          ctx.strokeRect((brush.cell % sheet.cols) * TILE + 0.5, Math.floor(brush.cell / sheet.cols) * TILE + 0.5, TILE - 1, TILE - 1);
        }
      }
    };
    const atlasCell = (event: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(sheet.cols - 1, Math.floor(((event.clientX - rect.left) / rect.width) * sheet.cols))),
        y: Math.max(0, Math.min(sheet.rows - 1, Math.floor(((event.clientY - rect.top) / rect.height) * sheet.rows))),
      };
    };
    drawAtlas();
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const cell = atlasCell(event);
      atlasDrag = { pointer: event.pointerId, from: cell, to: cell };
      drawAtlas();
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!atlasDrag || atlasDrag.pointer !== event.pointerId) return;
      const cell = atlasCell(event);
      if (cell.x === atlasDrag.to.x && cell.y === atlasDrag.to.y) return;
      atlasDrag.to = cell;
      drawAtlas();
    });
    canvas.addEventListener("pointerup", (event) => {
      if (!atlasDrag || atlasDrag.pointer !== event.pointerId) return;
      const selected = rectangularTileSelection(sheet, atlasDrag.from, atlasCell(event));
      atlasDrag = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (selected.width === 1 && selected.height === 1) chooseTile(selected.tiles[0]!);
      else {
        app.setTileSelection(selected);
        if (app.tool !== "pencil" && app.tool !== "rect") app.setTool("pencil");
        app.notify("ok", `Selected ${selected.width}×${selected.height} tile pattern.`);
      }
    });
    canvas.addEventListener("pointercancel", (event) => {
      if (atlasDrag?.pointer !== event.pointerId) return;
      atlasDrag = null;
      drawAtlas();
    });
    canvas.addEventListener("focus", () => drawAtlas());
    canvas.addEventListener("blur", () => drawAtlas());
    canvas.addEventListener("keydown", (event) => {
      if (!atlasCursor) return;
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -1;
      else if (event.key === "ArrowRight") dx = 1;
      else if (event.key === "ArrowUp") dy = -1;
      else if (event.key === "ArrowDown") dy = 1;
      else if (event.key === "Escape") {
        event.preventDefault();
        atlasCursor.anchor = null;
        drawAtlas();
        return;
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const selected = rectangularTileSelection(sheet, atlasCursor.anchor ?? atlasCursor, atlasCursor);
        if (selected.width === 1 && selected.height === 1) chooseTile(selected.tiles[0]!);
        else {
          app.setTileSelection(selected);
          if (app.tool !== "pencil" && app.tool !== "rect") app.setTool("pencil");
          app.notify("ok", `Selected ${selected.width}×${selected.height} tile pattern.`);
        }
        return;
      } else return;
      event.preventDefault();
      if (event.shiftKey && !atlasCursor.anchor) atlasCursor.anchor = { x: atlasCursor.x, y: atlasCursor.y };
      if (!event.shiftKey) atlasCursor.anchor = null;
      atlasCursor.x = Math.max(0, Math.min(sheet.cols - 1, atlasCursor.x + dx));
      atlasCursor.y = Math.max(0, Math.min(sheet.rows - 1, atlasCursor.y + dy));
      const selected = rectangularTileSelection(sheet, atlasCursor.anchor ?? atlasCursor, atlasCursor);
      canvas.setAttribute("aria-label", `Tile sheet ${sheet.id}; ${selected.width} by ${selected.height} selection at ${selected.x}, ${selected.y}. Press Enter to use.`);
      drawAtlas();
    });

    const searchResult = searchPaletteTiles(sheets, query);
    const searchContent = query.trim() ? h("div", { class: "palette-scroll tile-results-wrap" },
      searchResult.matches.length === 0
        ? emptyState("search", "No matching tiles", "Try a sheet name, full tile id, or numeric cell id.", { label: "Clear search", onClick: () => { query = ""; renderTiles(); }, id: "clear-tile-search" })
        : h("div", { class: "tile-results", role: "list", "aria-label": "Tile search results" }, searchResult.matches.map((match) => h("div", {
          class: `tile-result${match.tile === app.brush ? " active" : ""}`,
          role: "listitem",
          dataset: { tile: match.tile },
        },
        h("button", { type: "button", class: "tile-result-pick", title: `Use ${match.tile}`, onclick: () => chooseTile(match.tile) },
          tileThumb(match.tile, 32), h("code", null, match.tile)),
        h("button", {
          type: "button",
          class: `icon-button tiny tile-favorite${app.favoriteTiles.includes(match.tile) ? " pressed" : ""}`,
          title: app.favoriteTiles.includes(match.tile) ? `Remove ${match.tile} from favorites` : `Favorite ${match.tile}`,
          "aria-label": app.favoriteTiles.includes(match.tile) ? `Remove ${match.tile} from favorites` : `Favorite ${match.tile}`,
          "aria-pressed": String(app.favoriteTiles.includes(match.tile)),
          onclick: () => app.toggleFavoriteTile(match.tile),
        }, icon("star"))))),
      searchResult.total > searchResult.matches.length
        ? h("p", { class: "hint tile-result-limit" }, `Showing ${searchResult.matches.length} of ${searchResult.total} matches. Refine the search to see more.`)
        : null)
      : h("div", { class: "palette-scroll" }, canvas);
    const status = art.sheetStatus(sheet.id);
    const favorite = app.brush !== null && app.favoriteTiles.includes(app.brush);
    const selection = app.tileSelection;
    replace(body,
      searchWrap,
      strips,
      !query.trim() && (status.source === "missing" || status.source === "broken")
        ? h("p", { class: "art-missing" }, icon("image"), ` No art for sheet “${sheet.id}” — showing numbered placeholders. Use Art… to choose a PNG.`)
        : null,
      searchContent,
      h("div", { class: "brush-line" },
        h("span", { class: "muted" }, selection ? `${selection.width}×${selection.height} pattern` : "Brush"),
        app.brush ? tileThumb(app.brush, 20) : null,
        h("code", { "data-testid": "brush" }, app.brush ?? "eraser"),
        h("div", { class: "spacer" }),
        app.brush ? h("button", {
          type: "button",
          class: `icon-button tiny tile-favorite${favorite ? " pressed" : ""}`,
          title: favorite ? "Remove brush from favorites" : "Favorite brush",
          "aria-label": favorite ? `Remove ${app.brush} from favorites` : `Favorite ${app.brush}`,
          "aria-pressed": String(favorite),
          dataset: { testid: "favorite-tile" },
          onclick: () => app.toggleFavoriteTile(app.brush!),
        }, icon("star")) : null),
    );
    if (restoreSearch) queueMicrotask(() => {
      search.focus();
      search.setSelectionRange(restoreSearch.start, restoreSearch.end, restoreSearch.direction ?? undefined);
    });
    if (restoreAtlasFocus) queueMicrotask(() => {
      const replacement = [...body.querySelectorAll<HTMLCanvasElement>(".palette-canvas")]
        .find((item) => item.dataset.sheet === restoreAtlasFocus);
      replacement?.focus();
    });
  }

  function renderPassage(): void {
    const sheets = sheetsOfMap();
    if (!sheets.some((sheet) => sheet.id === sheetId)) {
      const brushSheet = app.brush ? parseTileId(app.brush)?.sheet : undefined;
      sheetId = sheets.find((sheet) => sheet.id === brushSheet)?.id ?? sheets[0]?.id ?? "";
    }
    const sheet = sheets.find((item) => item.id === sheetId);
    replace(header,
      h("span", { class: "panel-title" }, "Passage"),
      h("div", { class: "segmented small", role: "tablist", "aria-label": "Tile sheet passage" },
        sheets.map((item) => h("button", {
          type: "button",
          role: "tab",
          class: item.id === sheetId ? "active" : "",
          "aria-selected": String(item.id === sheetId),
          title: `Edit passage for sheet ${item.id}`,
          onclick: () => {
            sheetId = item.id;
            app.setBrush(`${item.id}.0`);
          },
        }, item.id))),
    );
    const options: [typeof app.passageBrush, string, string][] = [
      ["block", "Block", "Cells cannot be entered"],
      ["pass", "Pass", "Cells can always be entered"],
      ["clear", "Clear", "Remove the per-cell override"],
    ];
    const mapBrushes = h("div", null,
      h("div", { class: "brush-grid" }, options.map(([value, label, hint]) => h("button", {
        type: "button",
        class: `brush-choice passage-${value}${app.passageBrush === value ? " active" : ""}`,
        "aria-pressed": String(app.passageBrush === value),
        title: hint,
        dataset: { brush: value },
        onclick: () => { app.passageBrush = value; app.emit("brush"); },
      }, h("span", { class: "swatch" }), label))),
      h("p", { class: "hint" }, "Map override brush. Right-click clears; X = block and ○ = pass."));
    if (!sheet) {
      replace(body, mapBrushes, emptyState("image", "No tile sheets", "Add a sheet to this map before editing sheet passage."));
      return;
    }

    const selection = app.tileSelection?.sheet === sheet.id ? app.tileSelection : null;
    const brush = app.brush ? parseTileId(app.brush) : null;
    const selectedTargets = selection
      ? [...new Set(selection.tiles.flatMap((tile) => {
          const parsed = typeof tile === "string" ? parseTileId(tile) : null;
          return parsed?.sheet === sheet.id ? [parsed.cell] : [];
        }))]
      : [];
    const targets = selectedTargets.length > 0
      ? selectedTargets
      : brush?.sheet === sheet.id && brush.cell < sheet.cols * sheet.rows
        ? [brush.cell]
        : [0];
    const resolved = targets.map((cell) => resolveSheetCellPassage(sheet, cell));
    const allSource = (source: "default" | "pass" | "block") => resolved.every((entry) => entry.source === source);
    const allBlocked = (dir: typeof DIRS[number]) => resolved.every((entry) => entry.dirBlock.includes(dir));
    const anyBlocked = (dir: typeof DIRS[number]) => resolved.some((entry) => entry.dirBlock.includes(dir));
    const runUpdate = (changes: SheetPassageChanges, label: string): void => {
      const operation = updateSheetPassageOperation(sheet.id, changes);
      app.run(operation.command, operation.args, label);
    };
    const defaultSelect = h("select", {
      dataset: { testid: "sheet-default-passage" },
      "aria-label": `Default passage for sheet ${sheet.id}`,
      onchange: (event: Event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        runUpdate(setSheetDefaultPassage(value === "" ? null : value as "pass" | "block"), `Default passage for ${sheet.id}`);
      },
    },
    h("option", { value: "", selected: sheet.defaultPassage === undefined }, "Unset (pass)"),
    h("option", { value: "pass", selected: sheet.defaultPassage === "pass" }, "Pass"),
    h("option", { value: "block", selected: sheet.defaultPassage === "block" }, "Block"));
    const cellInput = h("input", {
      type: "number",
      min: 0,
      max: sheet.cols * sheet.rows - 1,
      value: targets[0],
      dataset: { testid: "sheet-passage-cell" },
      "aria-label": `Tile cell in sheet ${sheet.id}`,
      onchange: (event: Event) => {
        const raw = Number((event.currentTarget as HTMLInputElement).value);
        const cell = Number.isFinite(raw) ? Math.max(0, Math.min(sheet.cols * sheet.rows - 1, Math.trunc(raw))) : 0;
        app.setBrush(`${sheet.id}.${cell}`);
      },
    });
    const passageChoice = (value: "default" | "pass" | "block", label: string) => h("button", {
      type: "button",
      class: `brush-choice${allSource(value) ? " active" : ""}`,
      "aria-pressed": allSource(value) ? "true" : "false",
      dataset: { testid: `sheet-cell-passage-${value}` },
      onclick: () => runUpdate(setSheetCellsPassage(sheet, targets, value), `${label} ${sheet.id} sheet cell passage`),
    }, label);
    const wallChoice = (dir: typeof DIRS[number]) => {
      const every = allBlocked(dir);
      const some = anyBlocked(dir);
      return h("button", {
        type: "button",
        class: `brush-choice${every ? " active" : ""}`,
        "aria-pressed": every ? "true" : some ? "mixed" : "false",
        dataset: { testid: `sheet-dir-block-${dir}` },
        title: `${every ? "Open" : "Block"} the ${dir} edge in both directions`,
        onclick: () => runUpdate(setSheetCellsDirBlocked(sheet, targets, dir, !every), `${every ? "Open" : "Block"} ${dir} edge on ${sheet.id}`),
      }, `${ARROWS[dir]} ${dir}`);
    };
    const resolvedValue = new Set(resolved.map((entry) => entry.value));
    const targetLabel = targets.length === 1 ? `${sheet.id}.${targets[0]}` : `${targets.length} selected ${sheet.id} cells`;
    const sheetControls = h("div", { class: "palette-scroll", dataset: { testid: "sheet-passage-controls" } },
      h("div", { class: "brush-line" },
        h("span", { class: "muted" }, "Sheet default"),
        defaultSelect),
      h("div", { class: "brush-line" },
        h("span", { class: "muted" }, selection ? "Atlas selection" : "Sheet cell"),
        selection ? h("code", null, targetLabel) : cellInput,
        h("div", { class: "spacer" }),
        h("code", null, `resolved: ${resolvedValue.size === 1 ? [...resolvedValue][0] : "mixed"}`)),
      h("div", { class: "brush-grid" },
        passageChoice("default", "Use default"),
        passageChoice("pass", "Pass exception"),
        passageChoice("block", "Block exception")),
      h("p", { class: "hint" }, "These are tile-sheet rules: every map using the selected tile changes. Pass wins over block, then the sheet default applies."),
      h("div", { class: "edge-grid", role: "group", "aria-label": `Symmetric walls for ${targetLabel}` },
        h("span", { class: "muted" }, "Two-way wall on edge"),
        DIRS.map(wallChoice),
        h("button", {
          type: "button",
          class: "brush-choice",
          dataset: { testid: "sheet-dir-block-clear" },
          onclick: () => runUpdate(clearSheetCellsDirBlock(sheet, targets), `Clear two-way walls on ${sheet.id}`),
        }, "Clear walls")),
      h("p", { class: "hint" }, "Purple solid edges are authored dirBlock walls and block crossing both ways. Blue/orange arrows remain one-way enter/exit rules."));
    replace(body, mapBrushes, sheetControls);
  }

  function renderRegions(): void {
    replace(header, h("span", { class: "panel-title" }, "Region brush"));
    const input = h("input", {
      type: "number",
      class: "region-brush-input",
      min: "0",
      max: "255",
      step: "1",
      inputmode: "numeric",
      value: String(app.regionBrush),
      "aria-label": "Region id",
      "data-testid": "region-brush",
    });
    input.addEventListener("change", () => {
      const value = Number(input.value);
      app.setRegionBrush(Number.isFinite(value) ? value : 0);
      if (app.tool !== "pencil" && app.tool !== "rect") app.setTool("pencil");
    });
    replace(body,
      h("div", { class: "region-brush-control" },
        h("label", null, "Region id", input),
        h("span", { class: `region-brush-swatch${app.regionBrush === 0 ? " erase" : ""}` }, app.regionBrush === 0 ? "×" : String(app.regionBrush))),
      h("p", { class: "hint" }, "Paint region ids 1–255. Region 0, the eraser tool, or right-click removes the sparse region entry."));
  }

  function renderEdges(): void {
    replace(header, h("span", { class: "panel-title" }, "One-way edges"));
    const isPack = app.session?.kind === "pack";
    const same = (a: EdgeBrushValue, b: EdgeBrushValue) => JSON.stringify(a) === JSON.stringify(b);
    const choice = (brush: EdgeBrushValue, label: string, hint: string) => h("button", {
      type: "button",
      class: `brush-choice${same(app.edgeBrush, brush) ? " active" : ""}`,
      "aria-pressed": String(same(app.edgeBrush, brush)),
      title: hint,
      disabled: isPack,
      onclick: () => { app.edgeBrush = brush; app.emit("brush"); },
    }, label);
    replace(body,
      isPack ? h("p", { class: "art-missing" }, icon("warn"), " One-way map strokes are unavailable in sharded packs. Symmetric sheet walls remain editable under Passage.") : null,
      h("div", { class: "edge-grid" },
        h("span", { class: "muted" }, "No entry from"),
        DIRS.map((dir) => choice({ kind: "enter", dir }, `${ARROWS[dir]} ${dir}`, `Forbid entering the tile from ${dir}`)),
        h("span", { class: "muted" }, "No exit to"),
        DIRS.map((dir) => choice({ kind: "exit", dir }, `${ARROWS[dir]} ${dir}`, `Forbid leaving the tile ${dir}`)),
        choice({ kind: "clear" }, "Clear edges", "Remove one-way edges from the tile"),
      ),
      h("p", { class: "hint" }, "Edges belong to the painted cell's ground tile in its sheet, so every cell with that tile changes. Blue arrows point in (no entry), orange point out (no exit)."));
  }

  function render(): void {
    if (!app.session) {
      replace(header, h("span", { class: "panel-title" }, "Tiles"));
      replace(body, emptyState("image", "No tiles yet", "Open or drop a project to browse its tile sheets."));
      return;
    }
    if (app.layer === "passage") renderPassage();
    else if (app.layer === "regions") renderRegions();
    else if (app.layer === "edges") renderEdges();
    else renderTiles();
  }

  app.on((reason) => {
    if (reason === "hover" || reason === "view" || reason === "notice" || reason === "selection") return;
    if (reason === "brush" || reason === "load" || reason === "map" || reason === "document") atlasCursor = null;
    render();
  });
  art.onChange(render);
  let lastWidth = 0;
  new ResizeObserver(() => {
    if (zoom === null && root.clientWidth !== lastWidth) {
      lastWidth = root.clientWidth;
      render();
    }
  }).observe(root);
  render();
}
