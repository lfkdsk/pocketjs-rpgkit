/// <reference lib="dom" />
// editor/studio/canvas.ts — the map view: cached layer bitmaps, zoom/pan,
// overlays and the pointer tools.
//
// Ground and upper layers are cached as native-resolution (16 px per cell)
// offscreen canvases and rebuilt only when the document, map or art changes.
// A frame is then two scaled drawImage calls plus overlays clipped to the
// visible cells, so zoom and pan cost the same on a 100×100 map as on a
// small one. A brush stroke previews by painting straight into the cached
// bitmap; on release the whole stroke is committed as one protocol
// operation and the cache is rebuilt from the resulting document.

import type { GameEvent, MapDef, Sheet, SpriteDef, TileId } from "../../src/engine/types.ts";
import { uniqueEventId } from "../engine/model.ts";
import type { StudioApp, ViewState } from "./app.ts";
import { ArtRegistry, TILE, parseTileId } from "./art.ts";
import { emptyState } from "./dom.ts";
import { resolveSheetCellPassage, sheetDirBlockLine } from "./sheet-passage.ts";

export const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8] as const;

interface Theme {
  backdrop: string;
  void: string;
  grid: string;
  gridMajor: string;
  accent: string;
  select: string;
  event: string;
  eventFill: string;
  hover: string;
  danger: string;
}

type Drag =
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number; lastX: number; lastY: number; lastAt: number; vx: number; vy: number }
  | { kind: "paint"; erase: boolean; cells: Map<number, true>; origin: { x: number; y: number }; last: { x: number; y: number } }
  | { kind: "rect"; erase: boolean; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: "move"; eventId: string; grabDX: number; grabDY: number; at: { x: number; y: number }; moved: boolean };

export interface FrameStats {
  frames: number;
  /** Recent frame durations in ms (draw call only). */
  recent: number[];
}

/** A map with sparse passage/region data still contains authored content even when
 * every visual layer is empty. Keep this pure so the empty-guide contract is
 * cheap to exercise without constructing a browser canvas. */
export function isStudioMapBlank(map: Pick<MapDef, "ground" | "upper" | "events" | "passage" | "regions">): boolean {
  return map.ground.every((tile) => tile === null) &&
    (map.upper?.length ?? 0) === 0 &&
    (map.events?.length ?? 0) === 0 &&
    (map.passage?.length ?? 0) === 0 &&
    (map.regions?.length ?? 0) === 0;
}

export class MapCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly emptyGuide: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  private ground: HTMLCanvasElement = document.createElement("canvas");
  private upper: HTMLCanvasElement = document.createElement("canvas");
  private cacheKey = "";
  private cacheRevision = "";
  /** Tile drawn in each cell of the cached bitmaps (undefined = not drawn). */
  private drawnGround: (TileId | null | undefined)[] = [];
  private drawnUpper: (TileId | null | undefined)[] = [];
  /** Derived while refreshing the layer cache, so animated camera frames do
   * not rescan every ground cell just to decide whether to show the guide. */
  private mapBlank = false;
  private drag: Drag | null = null;
  /** A pulse around a cell rectangle that reveal() points at. */
  private flash: { x: number; y: number; w: number; h: number; start: number } | null = null;
  private cameraTarget: ViewState | null = null;
  private cameraAnchor: { x: number; y: number; mapX: number; mapY: number } | null = null;
  private inertia: { vx: number; vy: number } | null = null;
  private cameraFrame = 0;
  private cameraAt = 0;
  private spaceHeld = false;
  private pending = false;
  private theme!: Theme;
  private cssWidth = 1;
  private cssHeight = 1;
  readonly stats: FrameStats = { frames: 0, recent: [] };
  /** Duration of the last full layer rebuild in ms. */
  lastRebuildMs = 0;
  /** Cells redrawn by the last cache update. */
  lastRebuildCells = 0;

  /** True only after camera interpolation/inertia and the requested canvas
   * repaint have all finished. Verification captures use this state instead
   * of racing animation frames with a fixed delay. */
  get settled(): boolean {
    return this.cameraTarget === null && this.inertia === null && this.cameraFrame === 0 && !this.pending;
  }

  constructor(private host: HTMLElement, private app: StudioApp, private art: ArtRegistry) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "map-canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Map canvas");
    host.appendChild(this.canvas);
    this.emptyGuide = emptyState("pencil", "Start with the ground", "Choose a tile, then paint with B or drag a rectangle with R.");
    this.emptyGuide.classList.add("canvas-empty");
    this.emptyGuide.hidden = true;
    host.appendChild(this.emptyGuide);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.readTheme();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.bindPointer();
    app.on((reason) => {
      if (reason === "load" || reason === "map") this.fit(true);
      this.requestDraw();
    });
    art.onChange(() => this.requestDraw());
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !isTyping(event)) {
        this.spaceHeld = true;
        this.canvas.classList.add("panning");
        if (event.target === this.canvas || event.target === document.body) event.preventDefault();
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        this.spaceHeld = false;
        this.canvas.classList.remove("panning");
      }
    });
  }

  readTheme(): void {
    const style = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    this.theme = {
      backdrop: v("--canvas-bg", "#15171c"),
      void: v("--canvas-void", "#0c0d10"),
      grid: v("--canvas-grid", "rgba(255,255,255,0.10)"),
      gridMajor: v("--canvas-grid-major", "rgba(255,255,255,0.22)"),
      accent: v("--accent", "#6c8cff"),
      select: v("--canvas-select", "#ffd166"),
      event: v("--canvas-event", "#7ce0c3"),
      eventFill: v("--canvas-event-fill", "rgba(124,224,195,0.18)"),
      hover: v("--canvas-hover", "rgba(255,255,255,0.35)"),
      danger: v("--danger", "#ff6b6b"),
    };
    this.requestDraw();
  }

  private resize(): void {
    const rect = this.host.getBoundingClientRect();
    this.cssWidth = Math.max(1, Math.floor(rect.width));
    this.cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssWidth * dpr);
    this.canvas.height = Math.round(this.cssHeight * dpr);
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.requestDraw();
  }

  // ---- view -------------------------------------------------------------------

  /** Center the map at the largest preset zoom that fits. */
  fit(immediate = false): void {
    const map = this.app.currentMap();
    if (!map) return;
    const fitZoom = Math.min((this.cssWidth - 48) / (map.width * TILE), (this.cssHeight - 48) / (map.height * TILE));
    const zoom = Math.max(0.0625, [...ZOOM_LEVELS].reverse().find((level) => level <= fitZoom) ?? fitZoom);
    this.moveCamera({
      zoom,
      panX: (map.width * TILE) / 2 - this.cssWidth / 2 / zoom,
      panY: (map.height * TILE) / 2 - this.cssHeight / 2 / zoom,
    }, !immediate);
  }

  setZoom(zoom: number, anchorX = this.cssWidth / 2, anchorY = this.cssHeight / 2, center = false, immediate = false): void {
    zoom = Math.min(8, Math.max(0.0625, zoom));
    const view = this.cameraTarget ?? this.app.view;
    const map = this.app.currentMap();
    if (center && map) {
      this.moveCamera({
        zoom,
        panX: (map.width * TILE) / 2 - this.cssWidth / 2 / zoom,
        panY: (map.height * TILE) / 2 - this.cssHeight / 2 / zoom,
      }, !immediate);
    } else {
      const mx = view.panX + anchorX / view.zoom;
      const my = view.panY + anchorY / view.zoom;
      this.moveCamera(
        { zoom, panX: mx - anchorX / zoom, panY: my - anchorY / zoom },
        !immediate,
        { x: anchorX, y: anchorY, mapX: mx, mapY: my },
      );
    }
  }

  zoomStep(direction: 1 | -1, anchorX?: number, anchorY?: number): void {
    const current = (this.cameraTarget ?? this.app.view).zoom;
    const next = direction > 0
      ? ZOOM_LEVELS.find((level) => level > current + 1e-6)
      : [...ZOOM_LEVELS].reverse().find((level) => level < current - 1e-6);
    if (next !== undefined) this.setZoom(next, anchorX, anchorY);
  }

  private moveCamera(target: ViewState, smooth = true, anchor: { x: number; y: number; mapX: number; mapY: number } | null = null): void {
    this.inertia = null;
    this.cameraAnchor = anchor;
    this.clearHover();
    if (!smooth || this.app.reducedMotion) {
      this.cameraTarget = null;
      this.cameraAnchor = null;
      Object.assign(this.app.view, target);
      this.app.emit("view");
      return;
    }
    this.cameraTarget = target;
    this.scheduleCamera();
  }

  private scheduleCamera(): void {
    if (this.cameraFrame) return;
    this.cameraAt = performance.now();
    const step = (now: number): void => {
      const dt = Math.max(1, Math.min(40, now - this.cameraAt));
      this.cameraAt = now;
      const view = this.app.view;
      const target = this.cameraTarget;
      if (target) {
        const amount = 1 - Math.exp(-dt / 72);
        view.zoom += (target.zoom - view.zoom) * amount;
        if (this.cameraAnchor) {
          view.panX = this.cameraAnchor.mapX - this.cameraAnchor.x / view.zoom;
          view.panY = this.cameraAnchor.mapY - this.cameraAnchor.y / view.zoom;
        } else {
          view.panX += (target.panX - view.panX) * amount;
          view.panY += (target.panY - view.panY) * amount;
        }
        if (Math.abs(target.zoom - view.zoom) < 0.0005 && Math.abs(target.panX - view.panX) < 0.02 && Math.abs(target.panY - view.panY) < 0.02) {
          Object.assign(view, target);
          this.cameraTarget = null;
          this.cameraAnchor = null;
        }
      } else if (this.inertia) {
        view.panX += this.inertia.vx * dt;
        view.panY += this.inertia.vy * dt;
        const decay = Math.exp(-dt / 150);
        this.inertia.vx *= decay;
        this.inertia.vy *= decay;
        if (Math.hypot(this.inertia.vx, this.inertia.vy) < 0.008) this.inertia = null;
      }
      this.app.emit("view");
      if (this.cameraTarget || this.inertia) this.cameraFrame = requestAnimationFrame(step);
      else this.cameraFrame = 0;
    };
    this.cameraFrame = requestAnimationFrame(step);
  }

  private stopCamera(): void {
    this.cameraTarget = null;
    this.cameraAnchor = null;
    this.inertia = null;
  }

  private clearHover(): void {
    if (!this.app.hover) return;
    this.app.hover = null;
    this.app.emit("hover");
  }

  private startInertia(vx: number, vy: number): void {
    if (this.app.reducedMotion || Math.hypot(vx, vy) < 0.02) return;
    this.cameraTarget = null;
    this.cameraAnchor = null;
    this.inertia = { vx, vy };
    this.scheduleCamera();
  }

  /** Move a map pixel to the viewport center. Minimap drags use the immediate
   * path; clicks use the same smooth camera as wheel zoom. */
  centerAt(mapX: number, mapY: number, immediate = false): void {
    const zoom = this.app.view.zoom;
    this.moveCamera({ zoom, panX: mapX - this.cssWidth / (2 * zoom), panY: mapY - this.cssHeight / (2 * zoom) }, !immediate);
  }

  viewport(): { x: number; y: number; width: number; height: number; mapWidth: number; mapHeight: number } | null {
    const map = this.app.currentMap();
    if (!map) return null;
    const view = this.app.view;
    return { x: view.panX, y: view.panY, width: this.cssWidth / view.zoom, height: this.cssHeight / view.zoom, mapWidth: map.width * TILE, mapHeight: map.height * TILE };
  }

  /** Paint the cached ground layer into a small destination canvas. */
  drawGroundThumbnail(target: HTMLCanvasElement): void {
    const map = this.app.currentMap();
    const ctx = target.getContext("2d")!;
    ctx.clearRect(0, 0, target.width, target.height);
    if (!map) return;
    this.ensureLayers(map);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.ground, 0, 0, target.width, target.height);
  }

  /** Bring a cell rectangle into view (a short glide when it is off screen)
   * and pulse a ring around it, e.g. after jumping to a problem. */
  reveal(rect: { x: number; y: number; w?: number; h?: number }): void {
    const w = rect.w ?? 1;
    const h = rect.h ?? 1;
    const view = this.app.view;
    const viewW = this.cssWidth / view.zoom;
    const viewH = this.cssHeight / view.zoom;
    const margin = TILE;
    const inside = rect.x * TILE >= view.panX + margin && rect.y * TILE >= view.panY + margin &&
      (rect.x + w) * TILE <= view.panX + viewW - margin && (rect.y + h) * TILE <= view.panY + viewH - margin;
    if (!inside) {
      const toX = (rect.x + w / 2) * TILE - viewW / 2;
      const toY = (rect.y + h / 2) * TILE - viewH / 2;
      this.moveCamera({ zoom: view.zoom, panX: toX, panY: toY });
    }
    this.flash = { x: rect.x, y: rect.y, w, h, start: performance.now() };
    this.requestDraw();
  }

  /** Viewport-relative CSS pixel of a cell's center (for tests and popovers). */
  cellToClient(x: number, y: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.app.view;
    return {
      x: rect.left + ((x + 0.5) * TILE - view.panX) * view.zoom,
      y: rect.top + ((y + 0.5) * TILE - view.panY) * view.zoom,
    };
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number; inside: boolean } {
    const rect = this.canvas.getBoundingClientRect();
    const view = this.app.view;
    const mx = view.panX + (clientX - rect.left) / view.zoom;
    const my = view.panY + (clientY - rect.top) / view.zoom;
    const x = Math.floor(mx / TILE);
    const y = Math.floor(my / TILE);
    const map = this.app.currentMap();
    const inside = !!map && x >= 0 && y >= 0 && x < map.width && y < map.height;
    return { x, y, inside };
  }

  // ---- layer cache ------------------------------------------------------------

  private sheetFor(id: string): Sheet | undefined {
    return this.app.session?.sheets().find((sheet) => sheet.id === id);
  }

  private drawTile(ctx: CanvasRenderingContext2D, tile: TileId | null, dx: number, dy: number): void {
    if (tile === null) return;
    const parsed = parseTileId(tile);
    if (!parsed) return;
    const sheet = this.sheetFor(parsed.sheet);
    const cols = sheet?.cols ?? 16;
    const rows = sheet?.rows ?? Math.max(1, Math.ceil((parsed.cell + 1) / cols));
    const image = this.art.sheetImage(parsed.sheet) ?? this.art.placeholderSheet(parsed.sheet, cols, rows);
    ctx.drawImage(image, (parsed.cell % cols) * TILE, Math.floor(parsed.cell / cols) * TILE, TILE, TILE, dx, dy, TILE, TILE);
  }

  /** Bring the cached layer bitmaps up to date with the document. The cache
   * remembers which tile it drew in each cell; after an edit (or undo) only
   * cells whose tile differs are redrawn. A different map, size or art
   * revision redraws everything. */
  private ensureLayers(map: MapDef): void {
    const revision = `${this.app.session?.revision}`;
    const key = `${this.app.mapId}|${this.art.revision}|${map.width}x${map.height}|${this.app.session?.sheets().length}`;
    if (revision === this.cacheRevision && key === this.cacheKey) return;
    const started = performance.now();
    const full = key !== this.cacheKey;
    if (full) {
      for (const canvas of [this.ground, this.upper]) {
        canvas.width = map.width * TILE;
        canvas.height = map.height * TILE;
      }
      this.drawnGround = new Array(map.width * map.height).fill(undefined);
      this.drawnUpper = new Array(map.width * map.height).fill(undefined);
    }
    const upper: (TileId | null)[] = new Array(map.width * map.height).fill(null);
    for (const [index, tile] of map.upper ?? []) upper[index] = tile;
    const g = this.ground.getContext("2d")!;
    const u = this.upper.getContext("2d")!;
    let redrawn = 0;
    const blank = isStudioMapBlank(map);
    for (let i = 0; i < map.width * map.height; i++) {
      const x = (i % map.width) * TILE;
      const y = Math.floor(i / map.width) * TILE;
      const ground = map.ground[i] ?? null;
      if (this.drawnGround[i] !== ground) {
        g.clearRect(x, y, TILE, TILE);
        this.drawTile(g, ground, x, y);
        this.drawnGround[i] = ground;
        redrawn++;
      }
      const top = upper[i] ?? null;
      if (this.drawnUpper[i] !== top) {
        u.clearRect(x, y, TILE, TILE);
        this.drawTile(u, top, x, y);
        this.drawnUpper[i] = top;
        redrawn++;
      }
    }
    this.cacheKey = key;
    this.cacheRevision = revision;
    this.mapBlank = blank;
    this.lastRebuildMs = performance.now() - started;
    this.lastRebuildCells = redrawn;
  }

  /** Preview one stroke cell in the cached bitmap (ground/upper layers).
   * The cell is recorded as drawn with the preview tile, so the next cache
   * update repaints it if the committed document disagrees (a refused
   * stroke reverts itself). */
  private previewCell(map: MapDef, x: number, y: number, tile: TileId | null): void {
    const upper = this.app.layer === "upper";
    const layer = upper ? this.upper : this.ground;
    const ctx = layer.getContext("2d")!;
    ctx.clearRect(x * TILE, y * TILE, TILE, TILE);
    this.drawTile(ctx, tile, x * TILE, y * TILE);
    (upper ? this.drawnUpper : this.drawnGround)[y * map.width + x] = tile;
  }

  // ---- drawing ----------------------------------------------------------------

  requestDraw(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  draw(): void {
    const started = performance.now();
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const t = this.theme;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.backdrop;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const map = this.app.currentMap();
    if (!map) {
      this.emptyGuide.hidden = true;
      return;
    }
    this.ensureLayers(map);
    // Hide while a first stroke is only a bitmap preview; the committed edit
    // changes the session revision and refreshes mapBlank on pointer-up.
    this.emptyGuide.hidden = !this.mapBlank || this.drag !== null;
    const { zoom, panX, panY } = this.app.view;
    const scale = dpr * zoom;
    ctx.setTransform(scale, 0, 0, scale, -panX * scale, -panY * scale);
    ctx.imageSmoothingEnabled = false;
    const W = map.width * TILE;
    const H = map.height * TILE;
    ctx.fillStyle = t.void;
    ctx.fillRect(0, 0, W, H);
    this.drawParallax(ctx, map, W, H);
    const visible = this.app.visible;
    const opacity = this.app.opacity;
    if (visible.ground && opacity.ground > 0) {
      ctx.save();
      ctx.globalAlpha = opacity.ground;
      ctx.drawImage(this.ground, 0, 0);
      ctx.restore();
    }
    if (visible.events && opacity.events > 0) {
      ctx.save();
      ctx.globalAlpha = opacity.events;
      this.drawEvents(ctx, map);
      ctx.restore();
    }
    if (visible.upper && opacity.upper > 0) {
      ctx.save();
      ctx.globalAlpha = opacity.upper;
      ctx.drawImage(this.upper, 0, 0);
      ctx.restore();
    }

    // Visible cell range for per-cell overlays.
    const x0 = Math.max(0, Math.floor(panX / TILE));
    const y0 = Math.max(0, Math.floor(panY / TILE));
    const x1 = Math.min(map.width, Math.ceil((panX + this.cssWidth / zoom) / TILE));
    const y1 = Math.min(map.height, Math.ceil((panY + this.cssHeight / zoom) / TILE));
    if (visible.passage && opacity.passage > 0) {
      ctx.save();
      ctx.globalAlpha = opacity.passage;
      this.drawPassage(ctx, map, x0, y0, x1, y1);
      ctx.restore();
    }
    if (visible.regions && opacity.regions > 0) {
      ctx.save();
      ctx.globalAlpha = opacity.regions;
      this.drawRegions(ctx, map, x0, y0, x1, y1);
      ctx.restore();
    }
    if (visible.grid && zoom * TILE >= 6) this.drawGrid(ctx, map, x0, y0, x1, y1, scale);
    if (visible.events && opacity.events > 0) {
      ctx.save();
      ctx.globalAlpha = opacity.events;
      this.drawEventFrames(ctx, map, scale);
      ctx.restore();
    }
    this.drawSelection(ctx, map, scale);
    this.drawFlash(ctx, scale);
    this.drawDrag(ctx, scale);
    this.drawHover(ctx, scale);
    // Map border.
    ctx.strokeStyle = t.gridMajor;
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(0, 0, W, H);

    const elapsed = performance.now() - started;
    this.stats.frames++;
    this.stats.recent.push(elapsed);
    if (this.stats.recent.length > 240) this.stats.recent.shift();
  }

  /** Authored editor-visible parallax is presentation behind the ground,
   * never part of either tile cache. At phase zero its image begins at the
   * map origin; loop axes repeat using the same authored flags as runtime. */
  private drawParallax(ctx: CanvasRenderingContext2D, map: MapDef, width: number, height: number): void {
    const def = map.parallax;
    if (!def?.showInEditor || !def.image) return;
    const art = this.art.parallaxImage(def.image);
    if (!art) return;
    const repeat = def.loopX && def.loopY ? "repeat" : def.loopX ? "repeat-x" : def.loopY ? "repeat-y" : "no-repeat";
    const pattern = ctx.createPattern(art.image, repeat);
    if (!pattern) return;
    ctx.save();
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  private pageForDisplay(event: GameEvent): GameEvent["pages"][number] | undefined {
    const selection = this.app.selection;
    if (selection.kind === "event" && selection.eventId === event.id) return event.pages[selection.page] ?? event.pages[0];
    return event.pages.find((page) => page.sprite) ?? event.pages[0];
  }

  private drawEvents(ctx: CanvasRenderingContext2D, map: MapDef): void {
    const sprites = this.app.session?.sprites() ?? {};
    const drag = this.drag;
    const moving = drag?.kind === "move" && drag.moved ? drag.eventId : null;
    const layerAlpha = ctx.globalAlpha;
    for (const event of map.events ?? []) {
      // While an event is dragged its old place shows a faint ghost; the
      // event itself is drawn at the drop position by drawDrag().
      if (event.id === moving) ctx.globalAlpha = layerAlpha * 0.3;
      this.drawEventBody(ctx, event, event.x, event.y, sprites);
      ctx.globalAlpha = layerAlpha;
    }
  }

  private drawEventBody(ctx: CanvasRenderingContext2D, event: GameEvent, cellX: number, cellY: number, sprites: Record<string, SpriteDef>): void {
    const page = this.pageForDisplay(event);
    const w = (event.w ?? 1) * TILE;
    const h = (event.h ?? 1) * TILE;
    const x = cellX * TILE;
    const y = cellY * TILE;
    ctx.fillStyle = this.theme.eventFill;
    ctx.fillRect(x, y, w, h);
    const spriteId = page?.sprite;
    if (!spriteId) return;
    const frame = this.art.spriteFrame(spriteId, sprites[spriteId]);
    if (frame) {
      // Bottom-anchored like the runtime: tall walkers overflow upward.
      const dw = frame.sw;
      const dh = frame.sh;
      ctx.drawImage(frame.image, frame.sx, frame.sy, frame.sw, frame.sh, x + (TILE - dw) / 2, y + TILE - dh, dw, dh);
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
      ctx.fillStyle = this.theme.event;
      ctx.font = "bold 7px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(spriteId.slice(0, 3).toUpperCase(), x + TILE / 2, y + TILE / 2);
    }
  }

  private drawEventFrames(ctx: CanvasRenderingContext2D, map: MapDef, scale: number): void {
    ctx.strokeStyle = this.theme.event;
    const showLabels = this.app.view.zoom >= 3;
    const hovered = this.hoveredEvent(map)?.id ?? this.app.highlight;
    for (const event of map.events ?? []) {
      const w = (event.w ?? 1) * TILE;
      const h = (event.h ?? 1) * TILE;
      ctx.lineWidth = (event.id === hovered ? 3 : 1.5) / scale;
      ctx.strokeRect(event.x * TILE + 0.5 / scale, event.y * TILE + 0.5 / scale, w - 1 / scale, h - 1 / scale);
      if (showLabels) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const dpr = window.devicePixelRatio || 1;
        const { zoom, panX, panY } = this.app.view;
        const px = (event.x * TILE - panX) * zoom * dpr;
        const py = (event.y * TILE - panY) * zoom * dpr;
        const label = event.name ?? event.id;
        ctx.font = `${10 * dpr}px system-ui, sans-serif`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(10,12,16,0.72)";
        ctx.fillRect(px, py - 13 * dpr, tw + 8 * dpr, 13 * dpr);
        ctx.fillStyle = this.theme.event;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, px + 4 * dpr, py - 6.5 * dpr);
        ctx.restore();
      }
    }
  }

  private drawPassage(ctx: CanvasRenderingContext2D, map: MapDef, x0: number, y0: number, x1: number, y1: number): void {
    const sheets = new Map((this.app.session?.sheets() ?? []).map((sheet) => [sheet.id, sheet]));
    const overrides = new Map<number, "pass" | "block">(map.passage ?? []);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const index = y * map.width + x;
        const tile = map.ground[index] ?? null;
        const parsed = tile ? parseTileId(tile) : null;
        const sheet = parsed ? sheets.get(parsed.sheet) : undefined;
        const sheetPassage = sheet && parsed ? resolveSheetCellPassage(sheet, parsed.cell) : undefined;
        const override = overrides.get(index);
        const px = x * TILE;
        const py = y * TILE;
        if (override === "block") {
          ctx.fillStyle = "rgba(255,72,72,0.30)";
          ctx.fillRect(px, py, TILE, TILE);
          ctx.strokeStyle = "rgba(255,110,110,0.80)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + 5, py + 5); ctx.lineTo(px + 11, py + 11);
          ctx.moveTo(px + 11, py + 5); ctx.lineTo(px + 5, py + 11);
          ctx.stroke();
        } else if (override === "pass") {
          ctx.fillStyle = "rgba(64,220,120,0.40)";
          ctx.fillRect(px, py, TILE, TILE);
          ctx.strokeStyle = "rgba(140,255,170,0.95)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(px + 8, py + 8, 3.5, 0, Math.PI * 2);
          ctx.stroke();
        } else if (sheetPassage?.blocked) {
          ctx.fillStyle = "rgba(255,72,72,0.20)";
          ctx.fillRect(px, py, TILE, TILE);
        }
        if (sheetPassage) for (const dir of sheetPassage.dirBlock) drawDirBlockEdge(ctx, px, py, dir);
        const edges = sheet && parsed ? sheet.dirEdges?.[String(parsed.cell)] : undefined;
        if (edges) {
          for (const dir of edges.enter ?? []) drawEdgeArrow(ctx, px, py, dir, true);
          for (const dir of edges.exit ?? []) drawEdgeArrow(ctx, px, py, dir, false);
        }
      }
    }
    // Stroke preview for passage/edge painting.
    const drag = this.drag;
    if (drag?.kind === "paint" && (this.app.layer === "passage" || this.app.layer === "edges")) {
      ctx.fillStyle = "rgba(255,209,102,0.45)";
      for (const index of drag.cells.keys()) ctx.fillRect((index % map.width) * TILE, Math.floor(index / map.width) * TILE, TILE, TILE);
    }
  }

  private drawRegions(ctx: CanvasRenderingContext2D, map: MapDef, x0: number, y0: number, x1: number, y1: number): void {
    const regions = new Map<number, number>(map.regions ?? []);
    const drag = this.drag?.kind === "paint" && this.app.layer === "regions" ? this.drag : null;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const index = y * map.width + x;
        const previewed = drag?.cells.has(index) === true;
        const value = previewed
          ? (drag!.erase || this.app.regionBrush === 0 ? undefined : this.app.regionBrush)
          : regions.get(index);
        if (value === undefined) continue;
        const px = x * TILE;
        const py = y * TILE;
        const hue = (value * 47) % 360;
        ctx.fillStyle = `hsla(${hue}, 78%, 52%, 0.48)`;
        ctx.fillRect(px, py, TILE, TILE);
        ctx.strokeStyle = `hsla(${hue}, 90%, 76%, 0.95)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
        ctx.fillStyle = "rgba(255,255,255,0.96)";
        ctx.font = "700 7px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(value), px + TILE / 2, py + TILE / 2);
      }
    }
    if (drag && (drag.erase || this.app.regionBrush === 0)) {
      ctx.fillStyle = "rgba(255,209,102,0.35)";
      for (const index of drag.cells.keys()) {
        ctx.fillRect((index % map.width) * TILE, Math.floor(index / map.width) * TILE, TILE, TILE);
      }
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, map: MapDef, x0: number, y0: number, x1: number, y1: number, scale: number): void {
    ctx.lineWidth = 1 / scale;
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? this.theme.gridMajor : this.theme.grid;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        if ((x % 10 === 0) !== major) continue;
        ctx.moveTo(x * TILE, y0 * TILE);
        ctx.lineTo(x * TILE, y1 * TILE);
      }
      for (let y = y0; y <= y1; y++) {
        if ((y % 10 === 0) !== major) continue;
        ctx.moveTo(x0 * TILE, y * TILE);
        ctx.lineTo(x1 * TILE, y * TILE);
      }
      ctx.stroke();
    }
    void map;
  }

  private drawSelection(ctx: CanvasRenderingContext2D, map: MapDef, scale: number): void {
    const selection = this.app.selection;
    if (selection.kind === "event" && !this.app.visible.events) return;
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    if (selection.kind === "cell") rect = { x: selection.x, y: selection.y, w: selection.w ?? 1, h: selection.h ?? 1 };
    if (selection.kind === "event") {
      const event = map.events?.find((item) => item.id === selection.eventId);
      if (event) rect = { x: event.x, y: event.y, w: event.w ?? 1, h: event.h ?? 1 };
    }
    if (!rect) return;
    if (selection.kind === "event") {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = this.theme.select;
      ctx.fillRect(rect.x * TILE, rect.y * TILE, rect.w * TILE, rect.h * TILE);
      ctx.restore();
    }
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = this.theme.select;
    ctx.setLineDash([4 / scale, 3 / scale]);
    ctx.strokeRect(rect.x * TILE, rect.y * TILE, rect.w * TILE, rect.h * TILE);
    ctx.setLineDash([]);
  }

  /** Three fading rings closing in on the revealed rectangle (about 1 s). */
  private drawFlash(ctx: CanvasRenderingContext2D, scale: number): void {
    const flash = this.flash;
    if (!flash) return;
    const t = (performance.now() - flash.start) / 1000;
    if (t >= 1) {
      this.flash = null;
      return;
    }
    const phase = (t * 3) % 1;
    const grow = (1 - phase) * 10 / this.app.view.zoom;
    ctx.save();
    ctx.globalAlpha = (1 - t) * (0.4 + 0.6 * (1 - phase));
    ctx.lineWidth = 3 / scale;
    ctx.strokeStyle = this.theme.select;
    ctx.strokeRect(flash.x * TILE - grow, flash.y * TILE - grow, flash.w * TILE + grow * 2, flash.h * TILE + grow * 2);
    ctx.globalAlpha = (1 - t) * 0.25;
    ctx.fillStyle = this.theme.select;
    ctx.fillRect(flash.x * TILE, flash.y * TILE, flash.w * TILE, flash.h * TILE);
    ctx.restore();
    this.requestDraw();
  }

  /** True while reveal()'s pulse is on screen (tests wait for it). */
  get flashing(): boolean {
    return this.flash !== null;
  }

  private drawDrag(ctx: CanvasRenderingContext2D, scale: number): void {
    const drag = this.drag;
    if (drag?.kind === "rect") {
      const x = Math.min(drag.from.x, drag.to.x);
      const y = Math.min(drag.from.y, drag.to.y);
      const w = Math.abs(drag.from.x - drag.to.x) + 1;
      const h = Math.abs(drag.from.y - drag.to.y) + 1;
      const patterned = !drag.erase && (this.app.layer === "ground" || this.app.layer === "upper") && this.app.tileSelection;
      if (patterned) {
        ctx.save();
        ctx.globalAlpha = 0.68;
        for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
          this.drawTile(ctx, this.app.tileAtBrushOffset(px - x, py - y), px * TILE, py * TILE);
        }
        ctx.restore();
      } else {
        ctx.fillStyle = "rgba(255,209,102,0.22)";
        ctx.fillRect(x * TILE, y * TILE, w * TILE, h * TILE);
      }
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = this.theme.select;
      ctx.strokeRect(x * TILE, y * TILE, w * TILE, h * TILE);
    } else if (drag?.kind === "move" && drag.moved) {
      const map = this.app.currentMap();
      const event = map?.events?.find((item) => item.id === drag.eventId);
      if (!map || !event) return;
      const w = (event.w ?? 1) * TILE;
      const h = (event.h ?? 1) * TILE;
      // Dashed outline where it was, a line to where it goes, the event
      // drawn at the drop cell, and a red frame when it would share a cell
      // with another event (allowed, but usually a mistake).
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = this.theme.accent;
      ctx.setLineDash([3 / scale, 3 / scale]);
      ctx.strokeRect(event.x * TILE, event.y * TILE, w, h);
      ctx.beginPath();
      ctx.moveTo(event.x * TILE + w / 2, event.y * TILE + h / 2);
      ctx.lineTo(drag.at.x * TILE + w / 2, drag.at.y * TILE + h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.85;
      this.drawEventBody(ctx, event, drag.at.x, drag.at.y, this.app.session?.sprites() ?? {});
      ctx.globalAlpha = 1;
      const overlap = this.overlapping(map, event, drag.at.x, drag.at.y);
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = overlap ? this.theme.danger : this.theme.accent;
      ctx.strokeRect(drag.at.x * TILE, drag.at.y * TILE, w, h);
      this.screenLabel(ctx, drag.at.x * TILE, drag.at.y * TILE + h, overlap ? `(${drag.at.x}, ${drag.at.y}) shares a cell with ${overlap.id}` : `(${drag.at.x}, ${drag.at.y})`, overlap ? this.theme.danger : this.theme.accent);
    }
  }

  /** Another event covering any cell of `event` placed at (x, y). */
  private overlapping(map: MapDef, event: GameEvent, x: number, y: number): GameEvent | undefined {
    const w = event.w ?? 1;
    const h = event.h ?? 1;
    return (map.events ?? []).find((other) => other.id !== event.id &&
      other.x < x + w && x < other.x + (other.w ?? 1) && other.y < y + h && y < other.y + (other.h ?? 1));
  }

  /** A small text tag in screen pixels just under map point (mx, my). */
  private screenLabel(ctx: CanvasRenderingContext2D, mx: number, my: number, text: string, color: string): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    const { zoom, panX, panY } = this.app.view;
    const px = (mx - panX) * zoom * dpr;
    const py = (my - panY) * zoom * dpr + 3 * dpr;
    ctx.font = `600 ${10.5 * dpr}px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = "rgba(10,12,16,0.82)";
    ctx.fillRect(px, py, tw + 10 * dpr, 15 * dpr);
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, px + 5 * dpr, py + 7.5 * dpr);
    ctx.restore();
  }

  /** The event under the pointer when the select or event tool would pick
   * it up (not while dragging). */
  private hoveredEvent(map: MapDef): GameEvent | undefined {
    const hover = this.app.hover;
    if (!hover || this.drag || !this.app.visible.events) return undefined;
    if (this.app.tool !== "select" && this.app.tool !== "event") return undefined;
    return this.eventAt(map, hover.x, hover.y);
  }

  /** Drop an event drag without moving it (Esc). */
  cancelDrag(): boolean {
    if (this.drag?.kind !== "move" && this.drag?.kind !== "rect" && this.drag?.kind !== "paint") return false;
    this.drag = null;
    this.cacheRevision = "";
    this.requestDraw();
    return true;
  }

  private drawHover(ctx: CanvasRenderingContext2D, scale: number): void {
    const hover = this.app.hover;
    const map = this.app.currentMap();
    const overEvent = map ? this.hoveredEvent(map) : undefined;
    this.canvas.classList.toggle("over-event", !!overEvent);
    this.canvas.classList.toggle("moving-event", this.drag?.kind === "move");
    if (!hover || this.drag?.kind === "pan") return;
    const tool = this.app.tool;
    const tileLayer = this.app.layer === "ground" || this.app.layer === "upper";
    if (!this.drag && tileLayer && (tool === "pencil" || tool === "rect") && this.app.brush) {
      // Pencil stamps the complete atlas selection. Rectangle uses the
      // selected pattern to fill its bounds, so an idle click previews the
      // single cell that a one-cell rectangle will actually commit.
      const selection = this.app.tileSelection;
      const width = tool === "pencil" ? selection?.width ?? 1 : 1;
      const height = tool === "pencil" ? selection?.height ?? 1 : 1;
      ctx.globalAlpha = 0.6;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (hover.x + x >= (map?.width ?? 0) || hover.y + y >= (map?.height ?? 0)) continue;
        this.drawTile(ctx, this.app.tileAtBrushOffset(x, y), (hover.x + x) * TILE, (hover.y + y) * TILE);
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = this.theme.hover;
      ctx.strokeRect(hover.x * TILE, hover.y * TILE, Math.min(width, (map?.width ?? 0) - hover.x) * TILE, Math.min(height, (map?.height ?? 0) - hover.y) * TILE);
    }
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = this.theme.hover;
    ctx.strokeRect(hover.x * TILE, hover.y * TILE, TILE, TILE);
  }

  // ---- pointer tools ----------------------------------------------------------

  private bindPointer(): void {
    const canvas = this.canvas;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const ax = event.clientX - rect.left;
      const ay = event.clientY - rect.top;
      if (event.ctrlKey || event.metaKey || !event.shiftKey) {
        // Wheel and trackpad pinch (ctrlKey) zoom around the pointer;
        // continuous for pinch, preset steps for a mouse wheel.
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.cssHeight : 1;
        if (event.ctrlKey && Math.abs(event.deltaY * unit) < 80) {
          const zoom = Math.min(8, Math.max(0.0625, (this.cameraTarget ?? this.app.view).zoom * Math.exp(-event.deltaY * unit * 0.01)));
          this.setZoom(zoom, ax, ay);
        } else {
          this.zoomStep(event.deltaY < 0 ? 1 : -1, ax, ay);
        }
      } else {
        const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.cssHeight : 1;
        const base = this.cameraTarget ?? this.app.view;
        this.moveCamera({ zoom: base.zoom, panX: base.panX + event.deltaX * unit / base.zoom, panY: base.panY + event.deltaY * unit / base.zoom });
      }
    }, { passive: false });
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", () => {
      this.drag = null;
      this.cacheRevision = "";
      this.requestDraw();
    });
    canvas.addEventListener("pointerleave", () => {
      if (!this.drag) {
        this.app.hover = null;
        this.app.emit("hover");
      }
    });
  }

  private eventAt(map: MapDef, x: number, y: number): GameEvent | undefined {
    const events = map.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (x >= event.x && y >= event.y && x < event.x + (event.w ?? 1) && y < event.y + (event.h ?? 1)) return event;
    }
    return undefined;
  }

  private pointerDown(event: PointerEvent): void {
    this.canvas.focus();
    const map = this.app.currentMap();
    if (!map) return;
    this.stopCamera();
    if (event.button === 1 || (event.button === 0 && this.spaceHeld)) {
      event.preventDefault();
      this.clearHover();
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = {
        kind: "pan", startX: event.clientX, startY: event.clientY, panX: this.app.view.panX, panY: this.app.view.panY,
        lastX: event.clientX, lastY: event.clientY, lastAt: performance.now(), vx: 0, vy: 0,
      };
      this.canvas.classList.add("panning");
      return;
    }
    const cell = this.cellAt(event.clientX, event.clientY);
    if (!cell.inside) return;
    const tool = this.app.tool;
    const erase = event.button === 2 || tool === "eraser";
    if (event.button !== 0 && event.button !== 2) return;
    this.canvas.setPointerCapture(event.pointerId);

    if (tool === "select" || tool === "event") {
      if (event.button === 2) return;
      const hit = this.app.visible.events ? this.eventAt(map, cell.x, cell.y) : undefined;
      if (hit) {
        const current = this.app.selection;
        const page = current.kind === "event" && current.eventId === hit.id ? current.page : 0;
        this.app.select({ kind: "event", eventId: hit.id, page });
        this.drag = { kind: "move", eventId: hit.id, grabDX: cell.x - hit.x, grabDY: cell.y - hit.y, at: { x: hit.x, y: hit.y }, moved: false };
        return;
      }
      if (tool === "event") {
        this.createEvent(map, cell.x, cell.y);
        return;
      }
      this.app.select({ kind: "cell", x: cell.x, y: cell.y });
      return;
    }
    if (tool === "picker") {
      this.pick(map, cell.x, cell.y);
      return;
    }
    if (tool === "fill") {
      if (event.button === 2) return;
      this.fill(map, cell.x, cell.y);
      return;
    }
    if (tool === "rect") {
      this.drag = { kind: "rect", erase, from: { x: cell.x, y: cell.y }, to: { x: cell.x, y: cell.y } };
      this.requestDraw();
      return;
    }
    // pencil / eraser
    this.drag = { kind: "paint", erase, cells: new Map(), origin: { x: cell.x, y: cell.y }, last: { x: cell.x, y: cell.y } };
    this.addStrokeCell(map, cell.x, cell.y);
    this.requestDraw();
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag?.kind === "pan") {
      const now = performance.now();
      const dt = Math.max(1, now - drag.lastAt);
      const sampleX = -(event.clientX - drag.lastX) / this.app.view.zoom / dt;
      const sampleY = -(event.clientY - drag.lastY) / this.app.view.zoom / dt;
      drag.vx = drag.vx * 0.65 + sampleX * 0.35;
      drag.vy = drag.vy * 0.65 + sampleY * 0.35;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      drag.lastAt = now;
      this.app.view.panX = drag.panX - (event.clientX - drag.startX) / this.app.view.zoom;
      this.app.view.panY = drag.panY - (event.clientY - drag.startY) / this.app.view.zoom;
      this.app.emit("view");
      return;
    }
    const map = this.app.currentMap();
    if (!map) return;
    const cell = this.cellAt(event.clientX, event.clientY);
    const hover = cell.inside ? { x: cell.x, y: cell.y } : null;
    if (hover?.x !== this.app.hover?.x || hover?.y !== this.app.hover?.y) {
      this.app.hover = hover;
      this.app.emit("hover");
    }
    if (!drag) return;
    const cx = Math.max(0, Math.min(map.width - 1, cell.x));
    const cy = Math.max(0, Math.min(map.height - 1, cell.y));
    if (drag.kind === "paint") {
      // Bresenham from the previous cell so fast strokes stay continuous.
      let x = drag.last.x;
      let y = drag.last.y;
      const dx = Math.abs(cx - x);
      const dy = -Math.abs(cy - y);
      const sx = x < cx ? 1 : -1;
      const sy = y < cy ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        this.addStrokeCell(map, x, y);
        if (x === cx && y === cy) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
      }
      drag.last = { x: cx, y: cy };
      this.requestDraw();
    } else if (drag.kind === "rect") {
      drag.to = { x: cx, y: cy };
      this.requestDraw();
    } else if (drag.kind === "move") {
      const event = map.events?.find((item) => item.id === drag.eventId);
      if (!event) return;
      const nx = Math.max(0, Math.min(map.width - (event.w ?? 1), cx - drag.grabDX));
      const ny = Math.max(0, Math.min(map.height - (event.h ?? 1), cy - drag.grabDY));
      if (nx !== drag.at.x || ny !== drag.at.y) {
        drag.at = { x: nx, y: ny };
        drag.moved = nx !== event.x || ny !== event.y;
        this.requestDraw();
      }
    }
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    this.canvas.classList.toggle("panning", this.spaceHeld);
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    const map = this.app.currentMap();
    if (!drag || !map) return;
    if (drag.kind === "pan") {
      this.startInertia(drag.vx, drag.vy);
      return;
    }
    if (drag.kind === "paint") this.commitStroke(map, drag.cells, drag.erase, drag.origin);
    else if (drag.kind === "rect") this.commitRect(map, drag);
    else if (drag.kind === "move" && drag.moved) {
      this.app.run("update-event", { map: map.id, event: drag.eventId, changes: { x: drag.at.x, y: drag.at.y } }, `Move event ${drag.eventId}`);
    }
    this.requestDraw();
  }

  private strokeValue(erase: boolean): TileId | "pass" | "block" | number | null {
    if (this.app.layer === "passage") return erase || this.app.passageBrush === "clear" ? null : this.app.passageBrush;
    if (this.app.layer === "regions") return erase || this.app.regionBrush === 0 ? null : this.app.regionBrush;
    return erase ? null : this.app.brush;
  }

  private addStrokeCell(map: MapDef, x: number, y: number): void {
    const drag = this.drag;
    if (drag?.kind !== "paint") return;
    const patterned = !drag.erase && (this.app.layer === "ground" || this.app.layer === "upper") ? this.app.tileSelection : null;
    const width = patterned?.width ?? 1;
    const height = patterned?.height ?? 1;
    for (let oy = 0; oy < height; oy++) for (let ox = 0; ox < width; ox++) {
      const px = x + ox;
      const py = y + oy;
      if (px < 0 || py < 0 || px >= map.width || py >= map.height) continue;
      const index = py * map.width + px;
      if (drag.cells.has(index)) continue;
      drag.cells.set(index, true);
      if (this.app.layer === "ground" || this.app.layer === "upper") {
        const tile = drag.erase ? null : this.app.tileAtBrushOffset(px - drag.origin.x, py - drag.origin.y);
        this.previewCell(map, px, py, tile);
      }
    }
  }

  private commitStroke(map: MapDef, cells: Map<number, true>, erase: boolean, origin?: { x: number; y: number }): void {
    const list = [...cells.keys()].map((index) => [index % map.width, Math.floor(index / map.width)]);
    if (list.length === 0) return;
    const noun = list.length === 1 ? "cell" : "cells";
    if (this.app.layer === "edges") {
      const brush = erase ? { kind: "clear" } : this.app.edgeBrush;
      this.app.run("paint-edges", { map: map.id, cells: list, brush }, `Edges on ${list.length} ${noun}`);
    } else {
      const value = this.strokeValue(erase);
      const verb = value === null ? "Erase" : "Paint";
      const patterned = !erase && origin && (this.app.layer === "ground" || this.app.layer === "upper") && this.app.tileSelection;
      const args = patterned
        ? { map: map.id, layer: this.app.layer, cells: list, values: list.map(([x, y]) => this.app.tileAtBrushOffset(x - origin.x, y - origin.y)) }
        : { map: map.id, layer: this.app.layer, cells: list, value };
      const response = this.app.run("paint-cells", args, `${verb} ${list.length} ${this.app.layer} ${noun}`);
      // A refused stroke leaves the document unchanged; force a cache pass
      // so the preview cells are compared with it and repainted.
      if (response && !response.ok) this.cacheRevision = "";
    }
  }

  private commitRect(map: MapDef, drag: Extract<Drag, { kind: "rect" }>): void {
    const x = Math.min(drag.from.x, drag.to.x);
    const y = Math.min(drag.from.y, drag.to.y);
    const width = Math.abs(drag.from.x - drag.to.x) + 1;
    const height = Math.abs(drag.from.y - drag.to.y) + 1;
    if (this.app.layer === "ground" || this.app.layer === "upper") {
      const tile = drag.erase ? null : this.app.brush;
      if (!drag.erase && this.app.tileSelection) {
        const cells: [number, number][] = [];
        const values: TileId[] = [];
        for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) {
          cells.push([px, py]);
          values.push(this.app.tileAtBrushOffset(px - x, py - y));
        }
        this.app.run("paint-cells", { map: map.id, layer: this.app.layer, cells, values }, `Paint ${width}×${height} patterned rectangle`);
        return;
      }
      this.app.run("paint-rect", { map: map.id, layer: this.app.layer, x, y, width, height, tile }, `${tile === null ? "Erase" : "Paint"} ${width}×${height} rectangle`);
      return;
    }
    const cells: Map<number, true> = new Map();
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) cells.set(py * map.width + px, true);
    this.commitStroke(map, cells, drag.erase);
  }

  private fill(map: MapDef, x: number, y: number): void {
    if (this.app.layer !== "ground" && this.app.layer !== "upper") {
      this.app.notify("info", "Fill works on the ground and upper layers; use the brush or rectangle for passage and regions.");
      return;
    }
    this.app.run("fill-region", { map: map.id, layer: this.app.layer, x, y, tile: this.app.brush }, `Fill from (${x},${y})`);
  }

  private pick(map: MapDef, x: number, y: number): void {
    const index = y * map.width + x;
    if (this.app.layer === "passage") {
      const override = (map.passage ?? []).find(([cell]) => cell === index)?.[1];
      this.app.passageBrush = override ?? "clear";
      this.app.setTool("pencil");
      return;
    }
    if (this.app.layer === "regions") {
      const region = (map.regions ?? []).findLast(([cell]) => cell === index)?.[1] ?? 0;
      this.app.setRegionBrush(region);
      this.app.setTool("pencil");
      if (region === 0) this.app.notify("info", `(${x},${y}) has no region; region 0 erases.`);
      return;
    }
    const tile = this.app.layer === "upper"
      ? (map.upper ?? []).find(([cell]) => cell === index)?.[1] ?? null
      : map.ground[index] ?? null;
    if (tile === null) {
      this.app.notify("info", `(${x},${y}) is empty on the ${this.app.layer} layer.`);
      return;
    }
    this.app.setBrush(tile);
    this.app.setTool("pencil");
  }

  private createEvent(map: MapDef, x: number, y: number): void {
    const id = uniqueEventId(map.events ?? []);
    const response = this.app.run("add-event", {
      map: map.id,
      event: { id, x, y, pages: [{ trigger: "action", commands: [] }] },
    }, `New event ${id}`);
    if (response?.ok) this.app.select({ kind: "event", eventId: id, page: 0 });
  }
}

function drawDirBlockEdge(ctx: CanvasRenderingContext2D, px: number, py: number, dir: "down" | "left" | "right" | "up"): void {
  const line = sheetDirBlockLine(dir, px, py, TILE);
  ctx.save();
  ctx.lineCap = "butt";
  // A dark keyline keeps the authored symmetric wall legible over bright art;
  // purple deliberately differs from the blue/orange one-sided arrows.
  ctx.strokeStyle = "rgba(22,16,34,0.90)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(line.x1, line.y1);
  ctx.lineTo(line.x2, line.y2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(202,142,255,0.98)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(line.x1, line.y1);
  ctx.lineTo(line.x2, line.y2);
  ctx.stroke();
  ctx.restore();
}

function drawEdgeArrow(ctx: CanvasRenderingContext2D, px: number, py: number, dir: string, enter: boolean): void {
  // A small triangle on the named edge: blue pointing in (no entry from that
  // side), orange pointing out (no exit that way).
  ctx.fillStyle = enter ? "rgba(90,170,255,0.95)" : "rgba(255,160,64,0.95)";
  const c = TILE / 2;
  const tip = enter ? 4 : 0;
  const base = enter ? 0 : 4;
  ctx.beginPath();
  if (dir === "up") { ctx.moveTo(px + c, py + tip); ctx.lineTo(px + c - 3, py + base); ctx.lineTo(px + c + 3, py + base); }
  else if (dir === "down") { ctx.moveTo(px + c, py + TILE - tip); ctx.lineTo(px + c - 3, py + TILE - base); ctx.lineTo(px + c + 3, py + TILE - base); }
  else if (dir === "left") { ctx.moveTo(px + tip, py + c); ctx.lineTo(px + base, py + c - 3); ctx.lineTo(px + base, py + c + 3); }
  else { ctx.moveTo(px + TILE - tip, py + c); ctx.lineTo(px + TILE - base, py + c - 3); ctx.lineTo(px + TILE - base, py + c + 3); }
  ctx.closePath();
  ctx.fill();
}

export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
