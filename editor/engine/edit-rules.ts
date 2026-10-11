// editor/engine/edit-rules.ts — the editing rules behind every project edit:
// tile strokes, event/page transactions, map structure and sheet dirEdges.
// History-free and host-free. editor/api executes every edit operation with
// these reducers on a fresh state; the editor's model.ts uses the same
// stroke reducers for its live paint preview and commits through editor/api.

import type { Command, Dir, GameEvent, MapDef, Page, Project, TileId } from "../../src/engine/types.ts";
import {
  battleBranchPath,
  choiceBranchPath,
  commandAddressKey,
  ifBranchPath,
  loopBodyPath,
  sceneBranchPath,
  ROOT_COMMAND_PATH,
  type CommandListPath,
} from "./commands.ts";

export type Layer = "ground" | "upper" | "passage" | "regions";

/** Dense upper layer, length width*height: null = no star-layer cell. */
export type DenseUpper = (TileId | null)[];

/** Dense passage overrides, length width*height: null = no override. */
export type PassageValue = "pass" | "block" | null;
export type DensePassage = PassageValue[];

/** Dense RPG Maker region layer: null = region id 0 / no sparse entry. */
export type RegionValue = number | null;
export type DenseRegions = RegionValue[];

type CellLayerValue = TileId | PassageValue | RegionValue;

/** The brush an edge stroke paints on the sheet of a cell's ground tile. */
export type EdgeBrush = { kind: "enter" | "exit"; dir: Dir } | { kind: "clear" };

interface EventSelection {
  selectedEventId: string | null;
  selectedPageIndex: number;
}

interface OpenStroke {
  mapIndex: number;
  layer: Layer;
  /** Tile painted by this stroke; null = an erase stroke. Fixed at press
   *  time so changing the palette selection mid-drag cannot mix brushes. */
  brush: CellLayerValue;
  /** Private copy-on-stroke buffer. It is installed into the current state
   *  on the first changed cell, then updated in place while parent objects
   *  are replaced so UI dependents still observe every painted cell. This
   *  keeps large maps from copying their whole layer on every pointer frame. */
  working: CellLayerValue[];
  before: CellLayerValue[];
  /** Row-major cells this stroke changed, in paint order (appended in
   *  place with `working`). Each changed exactly once: the brush is fixed. */
  cells: number[];
}

interface OpenEdgeStroke {
  brush: EdgeBrush;
  /** Map cells (row-major) whose sample toggled a sheet entry, in order.
   *  Replaying the brush over exactly these cells reproduces the stroke. */
  cells: number[];
  /** Canonical `sheet/cell` keys already sampled by this drag. Pointer
   *  jitter and distinct map cells that use the same tile must not toggle
   *  the same sheet entry more than once per stroke. */
  visited: string[];
}

export interface EditRulesState {
  project: Project;
  mapIndex: number;
  layer: Layer;
  /** Selected paint tile ("town.43"); null = eraser. */
  tile: TileId;
  /** Event/page selection belongs to the active map. A map switch clears it. */
  selectedEventId: string | null;
  selectedPageIndex: number;
  /** Per-map dense upper caches; a map enters the touched set the first
   *  time its upper layer is painted, and export compacts ONLY touched
   *  maps back to sparse pairs — untouched maps serialize their original
   *  [index, tile] ordering byte-for-byte. */
  upperDense: DenseUpper[];
  upperTouched: boolean[];
  /** Per-map dense passage caches with the same touched/export contract. */
  passageDense: DensePassage[];
  passageTouched: boolean[];
  /** Per-map dense region caches with the same touched/export contract. */
  regionDense: DenseRegions[];
  regionTouched: boolean[];
  groundTouched: boolean[];
  /** Brush for passage strokes ("pass"/"block"); erase strokes clear. */
  passageBrush: "pass" | "block";
  /** RPG Maker region id painted by region strokes. */
  regionBrush: number;
  stroke: OpenStroke | null;
  /** Open sheet-dirEdges stroke (PASS mode edge tools), exclusive of stroke. */
  edgeStroke: OpenEdgeStroke | null;
}

export function toDenseUpper(map: MapDef): DenseUpper {
  const dense: DenseUpper = new Array(map.width * map.height).fill(null);
  for (const [index, tile] of map.upper ?? []) {
    if (index >= 0 && index < dense.length) dense[index] = tile;
  }
  return dense;
}

export function fromDenseUpper(dense: DenseUpper): [number, TileId][] {
  const pairs: [number, TileId][] = [];
  dense.forEach((tile, index) => {
    if (tile !== null) pairs.push([index, tile]);
  });
  return pairs;
}

export function toDensePassage(map: MapDef): DensePassage {
  const dense: DensePassage = new Array(map.width * map.height).fill(null);
  for (const [index, value] of map.passage ?? []) {
    if (index >= 0 && index < dense.length) dense[index] = value;
  }
  return dense;
}

export function fromDensePassage(dense: DensePassage): [number, "pass" | "block"][] {
  const pairs: [number, "pass" | "block"][] = [];
  dense.forEach((value, index) => {
    if (value !== null) pairs.push([index, value]);
  });
  return pairs;
}

export function toDenseRegions(map: MapDef): DenseRegions {
  const dense: DenseRegions = new Array(map.width * map.height).fill(null);
  for (const [index, value] of map.regions ?? []) {
    if (index >= 0 && index < dense.length) dense[index] = value;
  }
  return dense;
}

export function fromDenseRegions(dense: DenseRegions): [number, number][] {
  const pairs: [number, number][] = [];
  dense.forEach((value, index) => {
    if (value !== null) pairs.push([index, value]);
  });
  return pairs;
}

/** `lazyCaches` leaves the dense upper/passage/region caches unbuilt; a stroke
 *  derives the one it paints on demand. editor/api uses it for its
 *  one-operation scratch states. */
export function createEditorState(project: Project, options: { lazyCaches?: boolean } = {}): EditRulesState {
  const lazy = options.lazyCaches === true;
  return {
    project,
    mapIndex: 0,
    layer: "ground",
    tile: null,
    selectedEventId: null,
    selectedPageIndex: 0,
    upperDense: lazy ? new Array<DenseUpper>(project.maps.length) : project.maps.map(toDenseUpper),
    upperTouched: project.maps.map(() => false),
    passageDense: lazy ? new Array<DensePassage>(project.maps.length) : project.maps.map(toDensePassage),
    passageTouched: project.maps.map(() => false),
    regionDense: lazy ? new Array<DenseRegions>(project.maps.length) : project.maps.map(toDenseRegions),
    regionTouched: project.maps.map(() => false),
    groundTouched: project.maps.map(() => false),
    passageBrush: "pass",
    regionBrush: 1,
    stroke: null,
    edgeStroke: null,
  };
}

export function currentMap(state: EditRulesState): MapDef {
  return state.project.maps[state.mapIndex]!;
}

const TILE_RE = /^([a-z0-9_-]+)\.(\d+)$/;

/** A tile paints on a map only when its sheet is one of that map's sheets
 *  and the cell index is inside the sheet grid (src/data/schema.json patterns
 *  catch the shape; this catches cross-sheet references the schema cannot). */
export function canPaint(state: EditRulesState, tile: string): boolean {
  const m = TILE_RE.exec(tile);
  if (!m) return false;
  const map = currentMap(state);
  const sheetId = m[1]!;
  if (!(map.sheets ?? []).includes(sheetId)) return false;
  const sheet = state.project.sheets.find((s) => s.id === sheetId);
  if (!sheet) return false;
  const cell = Number(m[2]!);
  return cell >= 0 && cell < sheet.cols * sheet.rows;
}

function layerArray(state: EditRulesState, mapIndex: number, layer: Layer): CellLayerValue[] {
  const map = state.project.maps[mapIndex]!;
  if (layer === "ground") return map.ground;
  if (layer === "upper") return state.upperDense[mapIndex] ?? toDenseUpper(map);
  if (layer === "passage") return state.passageDense[mapIndex] ?? toDensePassage(map);
  return state.regionDense[mapIndex] ?? toDenseRegions(map);
}

export function selectTile(state: EditRulesState, tile: TileId): EditRulesState {
  if (tile === null) return { ...state, tile: null };
  if (!TILE_RE.test(tile) || !canPaint(state, tile)) return state;
  return { ...state, tile };
}

export function selectPassageBrush(state: EditRulesState, brush: "pass" | "block"): EditRulesState {
  if (state.passageBrush === brush) return state;
  return { ...state, passageBrush: brush };
}

export function selectRegionBrush(state: EditRulesState, brush: number): EditRulesState {
  if (!Number.isInteger(brush) || brush < 1 || brush > 255 || state.regionBrush === brush) return state;
  return { ...state, regionBrush: brush };
}

export function selectLayer(state: EditRulesState, layer: Layer): EditRulesState {
  if (state.layer === layer) return state;
  // A switch mid-stroke commits it (one history step) rather than dropping
  // its already-applied cells without an undo entry.
  if (state.stroke) state = strokeEnd(state);
  if (state.edgeStroke) state = edgeStrokeEnd(state);
  return { ...state, layer };
}

export function selectMap(state: EditRulesState, mapIndex: number): EditRulesState {
  if (mapIndex === state.mapIndex || mapIndex < 0 || mapIndex >= state.project.maps.length) {
    return state;
  }
  if (state.stroke) state = strokeEnd(state);
  if (state.edgeStroke) state = edgeStrokeEnd(state);
  return {
    ...state,
    mapIndex,
    selectedEventId: null,
    selectedPageIndex: 0,
    stroke: null,
    edgeStroke: null,
  };
}

function withLayer(state: EditRulesState, mapIndex: number, layer: Layer, next: CellLayerValue[]): EditRulesState {
  if (layer === "ground") {
    const maps = state.project.maps.slice();
    maps[mapIndex] = { ...maps[mapIndex]!, ground: next as (string | null)[] };
    const groundTouched = state.groundTouched.slice();
    groundTouched[mapIndex] = true;
    return { ...state, project: { ...state.project, maps }, groundTouched };
  }
  if (layer === "upper") {
    const upperDense = state.upperDense.slice();
    upperDense[mapIndex] = next as DenseUpper;
    const upperTouched = state.upperTouched.slice();
    upperTouched[mapIndex] = true;
    return { ...state, upperDense, upperTouched };
  }
  if (layer === "passage") {
    const passageDense = state.passageDense.slice();
    passageDense[mapIndex] = next as DensePassage;
    const passageTouched = state.passageTouched.slice();
    passageTouched[mapIndex] = true;
    return { ...state, passageDense, passageTouched };
  }
  const regionDense = state.regionDense.slice();
  regionDense[mapIndex] = next as DenseRegions;
  const regionTouched = state.regionTouched.slice();
  regionTouched[mapIndex] = true;
  return { ...state, regionDense, regionTouched };
}

/** Begin a drag stroke on the active map/layer. `erase` selects the eraser
 *  brush for this stroke regardless of the palette selection (right button
 *  / modifier). The pre-stroke array is captured once for the undo log. */
export function strokeStart(state: EditRulesState, erase = false): EditRulesState {
  if (state.stroke || state.edgeStroke) return state;
  const brush = erase
    ? null
    : state.layer === "passage"
      ? state.passageBrush
      : state.layer === "regions"
        ? state.regionBrush
      : state.tile;
  const before = layerArray(state, state.mapIndex, state.layer);
  return {
    ...state,
    stroke: {
      mapIndex: state.mapIndex,
      layer: state.layer,
      brush,
      working: before.slice(),
      before,
      cells: [],
    },
  };
}

/** Paint (or erase, when the stroke's brush is null) one cell. Cells outside
 *  the map and non-eraser strokes with an unselected tile are no-ops. */
export function paintCell(state: EditRulesState, index: number): EditRulesState {
  const stroke = state.stroke;
  if (!stroke || stroke.mapIndex !== state.mapIndex || stroke.layer !== state.layer) return state;
  const map = state.project.maps[stroke.mapIndex]!;
  if (index < 0 || index >= map.width * map.height) return state;
  const layer = stroke.layer;
  const next = stroke.brush;
  const working = stroke.working;
  if ((layer === "ground" || layer === "upper") && next !== null && !canPaint(state, next as string)) return state;
  if (working[index] === next) return state;
  working[index] = next;
  stroke.cells.push(index);
  return withLayer(state, stroke.mapIndex, layer, working);
}

/** Close the stroke. Its cells are already in the layer. */
export function strokeEnd(state: EditRulesState): EditRulesState {
  if (!state.stroke) return state;
  return { ...state, stroke: null };
}


function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneJson(item);
    return copy as T;
  }
  return value;
}

function withEvents(
  state: EditRulesState,
  mapIndex: number,
  events: GameEvent[] | undefined,
): EditRulesState {
  const maps = state.project.maps.slice();
  const map: MapDef = { ...maps[mapIndex]! };
  if (events === undefined) delete map.events;
  else map.events = cloneJson(events);
  maps[mapIndex] = map;
  return { ...state, project: { ...state.project, maps } };
}

/** Rebuild the per-map dense caches from a (flushed) project. A structural
 *  snapshot always carries its layers compacted, so the caches are pure
 *  derivations and every touched flag resets. */
function rebuildCaches(project: Project): Pick<EditRulesState, "upperDense" | "upperTouched" | "passageDense" | "passageTouched" | "regionDense" | "regionTouched" | "groundTouched"> {
  return {
    upperDense: project.maps.map(toDenseUpper),
    upperTouched: project.maps.map(() => false),
    passageDense: project.maps.map(toDensePassage),
    passageTouched: project.maps.map(() => false),
    regionDense: project.maps.map(toDenseRegions),
    regionTouched: project.maps.map(() => false),
    groundTouched: project.maps.map(() => false),
  };
}

// --- event/page editing ----------------------------------------------------

const EVENT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function emptyActionPage(): Page {
  return { trigger: "action", commands: [] };
}

export function clampInteger(value: number, min: number, max: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, integer));
}

export function schemaSafeEventId(value: string): string {
  if (EVENT_ID_RE.test(value)) return value;
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-");
  return safe || "event";
}

/** Return a map-local, schema-safe id, retaining `preferred` when possible. */
export function uniqueEventId(
  events: readonly GameEvent[],
  preferred = "event",
): string {
  const base = schemaSafeEventId(preferred);
  const used = new Set(events.map((event) => event.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

function eventIndex(state: EditRulesState): number {
  if (state.selectedEventId === null) return -1;
  return (currentMap(state).events ?? []).findIndex((event) => event.id === state.selectedEventId);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function commitEvents(
  state: EditRulesState,
  events: GameEvent[],
  selection: EventSelection,
): EditRulesState {
  if (state.stroke) return state;
  const before = currentMap(state).events;
  if (jsonEqual(before, events)) return state;
  const updated = withEvents(state, state.mapIndex, events);
  return {
    ...updated,
    selectedEventId: selection.selectedEventId,
    selectedPageIndex: selection.selectedPageIndex,
  };
}

function normalizeEvent(
  map: MapDef,
  events: readonly GameEvent[],
  event: GameEvent,
  replacingIndex: number,
): GameEvent {
  const otherEvents = events.filter((_, index) => index !== replacingIndex);
  const normalized = cloneJson(event);
  normalized.id = uniqueEventId(otherEvents, normalized.id);
  if (!normalized.pages.length) normalized.pages = [emptyActionPage()];

  const width = clampInteger(normalized.w ?? 1, 1, map.width);
  const height = clampInteger(normalized.h ?? 1, 1, map.height);
  normalized.x = clampInteger(normalized.x, 0, map.width - width);
  normalized.y = clampInteger(normalized.y, 0, map.height - height);
  if (normalized.w !== undefined) normalized.w = width;
  if (normalized.h !== undefined) normalized.h = height;
  return normalized;
}

/** Select an event and one of its pages. Invalid ids are ignored; null
 * clears selection. Selection changes are deliberately not undo steps. */
export function selectEvent(
  state: EditRulesState,
  selectedEventId: string | null,
  selectedPageIndex = 0,
): EditRulesState {
  if (selectedEventId === null) {
    if (state.selectedEventId === null && state.selectedPageIndex === 0) return state;
    return { ...state, selectedEventId: null, selectedPageIndex: 0 };
  }
  const event = (currentMap(state).events ?? []).find((candidate) => candidate.id === selectedEventId);
  if (!event) return state;
  const pageIndex = clampInteger(selectedPageIndex, 0, event.pages.length - 1);
  if (state.selectedEventId === selectedEventId && state.selectedPageIndex === pageIndex) return state;
  return { ...state, selectedEventId, selectedPageIndex: pageIndex };
}

/** Change only the selected page within the selected event. */
export function selectPage(state: EditRulesState, pageIndex: number): EditRulesState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  const next = clampInteger(pageIndex, 0, event.pages.length - 1);
  if (next === state.selectedPageIndex) return state;
  return { ...state, selectedPageIndex: next };
}

/** Apply one event-level transaction. The callback receives a deep copy,
 * so accidental callback mutation cannot mutate the current/history state. */
export function updateSelectedEvent(
  state: EditRulesState,
  update: (event: GameEvent) => GameEvent,
): EditRulesState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const map = currentMap(state);
  const events = map.events ?? [];
  const proposed = update(cloneJson(events[index]!));
  const nextEvent = normalizeEvent(map, events, proposed, index);
  const nextEvents = events.slice();
  nextEvents[index] = nextEvent;
  return commitEvents(state, nextEvents, {
    selectedEventId: nextEvent.id,
    selectedPageIndex: clampInteger(state.selectedPageIndex, 0, nextEvent.pages.length - 1),
  });
}

/** Apply one page-level transaction to the selected page. */
export function updateSelectedPage(
  state: EditRulesState,
  update: (page: Page) => Page,
): EditRulesState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const event = currentMap(state).events![index]!;
  if (state.selectedPageIndex < 0 || state.selectedPageIndex >= event.pages.length) return state;
  const page = update(cloneJson(event.pages[state.selectedPageIndex]!));
  return updateSelectedEvent(state, (nextEvent) => {
    nextEvent.pages[state.selectedPageIndex] = cloneJson(page);
    return nextEvent;
  });
}

function withTransactionPageSelection(
  previous: EditRulesState,
  next: EditRulesState,
  selectedPageIndex: number,
): EditRulesState {
  if (next === previous) return previous;
  return { ...next, selectedPageIndex };
}

/** Create a 1x1 event with one empty action page and select it. */
export function createEventAt(state: EditRulesState, x: number, y: number): EditRulesState {
  if (state.stroke) return state;
  const map = currentMap(state);
  const events = map.events ?? [];
  const event: GameEvent = {
    id: uniqueEventId(events),
    x: clampInteger(x, 0, map.width - 1),
    y: clampInteger(y, 0, map.height - 1),
    pages: [emptyActionPage()],
  };
  return commitEvents(state, [...events, event], {
    selectedEventId: event.id,
    selectedPageIndex: 0,
  });
}

/** Move the selected event's top-left corner, preserving its effective size. */
export function moveSelectedEvent(state: EditRulesState, x: number, y: number): EditRulesState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const map = currentMap(state);
  const event = map.events![index]!;
  const width = clampInteger(event.w ?? 1, 1, map.width);
  const height = clampInteger(event.h ?? 1, 1, map.height);
  return updateSelectedEvent(state, (next) => ({
    ...next,
    x: clampInteger(x, 0, map.width - width),
    y: clampInteger(y, 0, map.height - height),
  }));
}

/** Resize the selected event within the space remaining from its top-left. */
export function resizeSelectedEvent(state: EditRulesState, w: number, h: number): EditRulesState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const map = currentMap(state);
  const event = map.events![index]!;
  const x = clampInteger(event.x, 0, map.width - 1);
  const y = clampInteger(event.y, 0, map.height - 1);
  return updateSelectedEvent(state, (next) => ({
    ...next,
    x,
    y,
    w: clampInteger(w, 1, map.width - x),
    h: clampInteger(h, 1, map.height - y),
  }));
}

/** Rename the selected event's optional human-readable label (not its id). */
export function renameSelectedEvent(state: EditRulesState, name: string): EditRulesState {
  return updateSelectedEvent(state, (event) => ({ ...event, name }));
}

/** Duplicate beside the source in array order and select the copy. */
export function duplicateSelectedEvent(state: EditRulesState): EditRulesState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const events = currentMap(state).events ?? [];
  const copy = cloneJson(events[index]!);
  copy.id = uniqueEventId(events, `${schemaSafeEventId(copy.id)}-copy`);
  const nextEvents = events.slice();
  nextEvents.splice(index + 1, 0, copy);
  return commitEvents(state, nextEvents, {
    selectedEventId: copy.id,
    selectedPageIndex: clampInteger(state.selectedPageIndex, 0, copy.pages.length - 1),
  });
}

/** Delete the selected event and select the adjacent surviving event. */
export function deleteSelectedEvent(state: EditRulesState): EditRulesState {
  const index = eventIndex(state);
  if (index < 0 || state.stroke) return state;
  const events = (currentMap(state).events ?? []).slice();
  events.splice(index, 1);
  const adjacent = events[Math.min(index, events.length - 1)];
  return commitEvents(state, events, {
    selectedEventId: adjacent?.id ?? null,
    selectedPageIndex: adjacent
      ? clampInteger(state.selectedPageIndex, 0, adjacent.pages.length - 1)
      : 0,
  });
}

/** Append a page (an empty action page by default) and select it. */
export function addPage(state: EditRulesState, page: Page = emptyActionPage()): EditRulesState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const selectedPageIndex = currentMap(state).events![index]!.pages.length;
  const nextState = updateSelectedEvent(state, (event) => {
    event.pages.push(cloneJson(page));
    return event;
  });
  return withTransactionPageSelection(state, nextState, selectedPageIndex);
}

/** Delete the selected page. Events must retain at least one page. */
export function deletePage(state: EditRulesState): EditRulesState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  if (event.pages.length <= 1) return state;
  const pageIndex = state.selectedPageIndex;
  const nextState = updateSelectedEvent(state, (nextEvent) => {
    nextEvent.pages.splice(pageIndex, 1);
    return nextEvent;
  });
  return withTransactionPageSelection(
    state,
    nextState,
    Math.min(pageIndex, event.pages.length - 2),
  );
}

/** Move the selected page to an absolute page index and keep it selected. */
export function movePage(state: EditRulesState, toIndex: number): EditRulesState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  const fromIndex = state.selectedPageIndex;
  const target = clampInteger(toIndex, 0, event.pages.length - 1);
  if (target === fromIndex) return state;
  const nextState = updateSelectedEvent(state, (nextEvent) => {
    const [page] = nextEvent.pages.splice(fromIndex, 1);
    nextEvent.pages.splice(target, 0, page!);
    return nextEvent;
  });
  return withTransactionPageSelection(state, nextState, target);
}

/** Insert a deep copy of the selected page immediately after it. */
export function copyPage(state: EditRulesState): EditRulesState {
  const index = eventIndex(state);
  if (index < 0) return state;
  const event = currentMap(state).events![index]!;
  const pageIndex = state.selectedPageIndex;
  const nextState = updateSelectedEvent(state, (nextEvent) => {
    nextEvent.pages.splice(pageIndex + 1, 0, cloneJson(event.pages[pageIndex]!));
    return nextEvent;
  });
  return withTransactionPageSelection(state, nextState, pageIndex + 1);
}

/** Compact one touched dense layer back to sparse pairs. The runtime's
 *  dense rule is "the last pair at an index wins", so an UNEDITED index can
 *  legitimately hold several authored pairs (the village fences do): keep
 *  every one of those pairs verbatim. An edited index drops its authored
 *  pairs and emits the single new pair; an erased index emits nothing.
 *  Brand-new cells append in row-major order. */
function compactSparse<T>(original: [number, T][] | undefined, dense: (T | null)[]): [number, T][] {
  const originalIndices = new Set<number>();
  const lastOriginal = new Map<number, T>();
  for (const [index, value] of original ?? []) {
    originalIndices.add(index);
    lastOriginal.set(index, value);
  }
  const pairs: [number, T][] = [];
  // 1. authored pairs: untouched indices keep every pair verbatim (duplicate
  //    indices are legal; the last pair is what the runtime paints).
  for (const [index, value] of original ?? []) {
    if (dense[index] === lastOriginal.get(index)) pairs.push([index, value]);
  }
  // 2. edited indices emit their single new pair (erased = null, nothing).
  for (const index of originalIndices) {
    const value = dense[index];
    if (value !== null && value !== lastOriginal.get(index)) pairs.push([index, value]);
  }
  // 3. brand-new cells append in row-major order.
  dense.forEach((value, index) => {
    if (value !== null && !originalIndices.has(index)) pairs.push([index, value]);
  });
  return pairs;
}

export function compactUpper(original: [number, TileId][] | undefined, dense: DenseUpper): [number, TileId][] {
  return compactSparse(original, dense);
}

export function compactPassage(
  original: [number, "pass" | "block"][] | undefined,
  dense: DensePassage,
): [number, "pass" | "block"][] {
  return compactSparse(original, dense);
}

export function compactRegions(original: [number, number][] | undefined, dense: DenseRegions): [number, number][] {
  return compactSparse(original, dense);
}

/** Export form: only touched layers compact (preserving authored pair
 *  order); untouched maps keep their original arrays. The result is then
 *  validated by engine/document.ts before leaving the editor. */
export function exportProject(state: EditRulesState): Project {
  if (state.stroke) state = strokeEnd(state);
  if (state.edgeStroke) state = edgeStrokeEnd(state);
  const maps = state.project.maps.map((map, i) => {
    let next = map;
    if (state.upperTouched[i]) next = { ...next, upper: compactUpper(next.upper, state.upperDense[i]!) };
    if (state.passageTouched[i]) next = { ...next, passage: compactPassage(next.passage, state.passageDense[i]!) };
    if (state.regionTouched[i]) next = { ...next, regions: compactRegions(next.regions, state.regionDense[i]!) };
    return next;
  });
  return { ...state.project, maps };
}

/** Event rectangles the canvas overlays, sorted for stable z-order. */
export function eventMarkers(map: MapDef): { id: string; x: number; y: number; w: number; h: number }[] {
  return (map.events ?? [])
    .map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.w ?? 1, h: e.h ?? 1 }))
    .sort((a, b) => (a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1)));
}

/** Palette contents for a map: eraser (null) first, then every cell of
 *  every sheet the map draws from, in sheet/grid order. Slot 0 is always
 *  the eraser; slot n maps to paletteTiles(state)[n]. */
export function paletteTiles(state: EditRulesState): TileId[] {
  const map = currentMap(state);
  const tiles: TileId[] = [null];
  for (const sheetId of map.sheets ?? []) {
    const sheet = state.project.sheets.find((s) => s.id === sheetId);
    if (!sheet) continue;
    for (let cell = 0; cell < sheet.cols * sheet.rows; cell++) tiles.push(`${sheetId}.${cell}`);
  }
  return tiles;
}

/** Palette slot holding a tile id, or -1 when it is not in the current
 *  map's palette (map switch made the selection stale). */
export function slotForTile(tiles: TileId[], tile: TileId): number {
  if (tile === null) return 0;
  const i = tiles.indexOf(tile);
  return i >= 0 ? i : -1;
}

// --- structural edits (map properties + map management) --------------------
//
// Every structural edit transforms the FLUSHED project (pending sparse-layer
// strokes compacted in) and rebuilds the dense caches from the result. Open
// tile/edge strokes are refused here.

export type StructuralResult =
  | { ok: true; state: EditRulesState }
  | { ok: false; error: string };

export type ResizeResult =
  | { ok: true; state: EditRulesState; croppedEvents: string[] }
  | { ok: false; error: string };

export type DeleteMapResult =
  | { ok: true; state: EditRulesState }
  | { ok: false; error: string; references: MapReference[] };

interface StructuralTransform {
  project: Project;
  mapIndex: number;
  selectedEventId: string | null;
  selectedPageIndex: number;
}

function commitStructural(
  state: EditRulesState,
  transform: (project: Project) => StructuralTransform | null,
): EditRulesState | null {
  if (state.stroke || state.edgeStroke) return null;
  const flushed = exportProject(state);
  // exportProject intentionally preserves untouched nested objects. Give
  // mutating structural transforms their own deep copy so neither the
  // loaded project nor any prior EditRulesState can be changed in place.
  const result = transform(cloneJson(flushed));
  if (!result) return state;
  if (jsonEqual(flushed, result.project)) return state;
  return {
    ...state,
    project: result.project,
    ...rebuildCaches(result.project),
    mapIndex: result.mapIndex,
    selectedEventId: result.selectedEventId,
    selectedPageIndex: result.selectedPageIndex,
  };
}

/** Unwrap a structural result, turning a stroke-open refusal into an error. */
function structural(state: EditRulesState, next: EditRulesState | null): StructuralResult {
  return next === null
    ? { ok: false, error: "finish the current stroke first" }
    : { ok: true, state: next };
}

const MAP_ID_RE = /^[a-z0-9_-]+$/;

function schemaSafeMapId(value: string): string {
  if (MAP_ID_RE.test(value)) return value;
  const safe = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "map";
}

/** Return a project-unique, schema-safe map id, retaining `preferred`. */
export function uniqueMapId(project: Project, preferred = "map"): string {
  const base = schemaSafeMapId(preferred);
  const used = new Set(project.maps.map((m) => m.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

export interface MapReference {
  /** Map containing the referencing command ("(common)" for common events). */
  mapId: string;
  eventId: string;
  page: number;
  /** Stable command-tree address, shared with the command editor. */
  command: string;
}

/** Every transfer command (all event pages, all branch kinds, and common
 *  events) whose map operand is the literal `mapId`. Variable operands are
 *  not references. */
export function mapReferences(project: Project, mapId: string): MapReference[] {
  const refs: MapReference[] = [];
  const scan = (
    commands: readonly Command[] | undefined,
    ctx: Omit<MapReference, "command">,
    path: CommandListPath = ROOT_COMMAND_PATH,
  ) => {
    if (!commands) return;
    commands.forEach((command, index) => {
      const address = { path, index };
      if (command.op === "transfer" && typeof command.map === "string" && command.map === mapId) {
        refs.push({ ...ctx, command: commandAddressKey(address) });
      }
      if (command.op === "if") {
        scan(command.then, ctx, ifBranchPath(address, "then"));
        scan(command.else, ctx, ifBranchPath(address, "else"));
      } else if (command.op === "choices") {
        command.options.forEach((option, optionIndex) =>
          scan(option.commands, ctx, choiceBranchPath(address, optionIndex))
        );
        scan(command.cancel?.commands, ctx, choiceBranchPath(address, "cancel"));
      } else if (command.op === "battle") {
        scan(command.onWin, ctx, battleBranchPath(address, "win"));
        scan(command.onLose, ctx, battleBranchPath(address, "lose"));
        scan(command.onEscape, ctx, battleBranchPath(address, "escape"));
      } else if (command.op === "scene") {
        scan(command.onDone, ctx, sceneBranchPath(address, "done"));
        scan(command.onCancel, ctx, sceneBranchPath(address, "cancel"));
      } else if (command.op === "loop") {
        scan(command.commands, ctx, loopBodyPath(address));
      }
    });
  };
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      event.pages.forEach((page, pageIndex) =>
        scan(page.commands, { mapId: map.id, eventId: event.id, page: pageIndex }),
      );
    }
  }
  for (const common of project.commonEvents ?? []) {
    scan(common.commands, { mapId: "(common)", eventId: common.id, page: 0 });
  }
  return refs;
}

/** Rewrite every literal transfer operand `oldId` -> `newId` in place. */
function rewriteTransferMapIds(project: Project, oldId: string, newId: string): void {
  const scan = (commands: readonly Command[] | undefined) => {
    if (!commands) return;
    for (const command of commands) {
      if (command.op === "transfer" && typeof command.map === "string" && command.map === oldId) {
        command.map = newId;
      }
      if (command.op === "if") {
        scan(command.then);
        scan(command.else);
      } else if (command.op === "choices") {
        for (const option of command.options) scan(option.commands);
        scan(command.cancel?.commands);
      } else if (command.op === "battle") {
        scan(command.onWin);
        scan(command.onLose);
        scan(command.onEscape);
      } else if (command.op === "scene") {
        scan(command.onDone);
        scan(command.onCancel);
      } else if (command.op === "loop") {
        scan(command.commands);
      }
    }
  };
  for (const map of project.maps) {
    for (const event of map.events ?? []) {
      for (const page of event.pages) scan(page.commands);
    }
  }
  for (const common of project.commonEvents ?? []) scan(common.commands);
}

/** Rename the active map's id. The start position and every transfer
 *  command that names the old id follow. One undo step. */
export function renameMap(state: EditRulesState, rawId: string): StructuralResult {
  const map = state.project.maps[state.mapIndex];
  if (!map) return { ok: false, error: "no map selected" };
  const id = rawId.trim();
  if (!MAP_ID_RE.test(id)) return { ok: false, error: "map id must match [a-z0-9_-]+" };
  if (state.project.maps.some((m, i) => i !== state.mapIndex && m.id === id)) {
    return { ok: false, error: `map id ${id} is already used` };
  }
  if (map.id === id) return { ok: true, state };
  const mapIndex = state.mapIndex;
  return structural(state, commitStructural(state, (project) => {
    const oldId = project.maps[mapIndex]!.id;
    project.maps[mapIndex]!.id = id;
    if (project.start.map === oldId) project.start.map = id;
    rewriteTransferMapIds(project, oldId, id);
    return {
      project,
      mapIndex,
      selectedEventId: state.selectedEventId,
      selectedPageIndex: state.selectedPageIndex,
    };
  }));
}

/** Rename the active map's display name. One undo step. */
export function setMapName(state: EditRulesState, rawName: string): StructuralResult {
  const name = rawName.trim();
  if (name.length === 0) return { ok: false, error: "name is required" };
  if (name.length > 40) return { ok: false, error: "name must be at most 40 characters" };
  const mapIndex = state.mapIndex;
  if (state.project.maps[mapIndex]!.name === name) return { ok: true, state };
  return structural(state, commitStructural(state, (project) => {
    project.maps[mapIndex]!.name = name;
    return {
      project,
      mapIndex,
      selectedEventId: state.selectedEventId,
      selectedPageIndex: state.selectedPageIndex,
    };
  }));
}

function resizeSparse<T>(
  pairs: [number, T][] | undefined,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): [number, T][] | undefined {
  if (!pairs) return undefined;
  const out: [number, T][] = [];
  for (const [index, value] of pairs) {
    const x = index % oldW;
    const y = Math.floor(index / oldW);
    if (x < newW && y < newH) out.push([y * newW + x, value]);
  }
  return out;
}

/** Resize the active map. Expansion fills new ground cells with void
 *  (null); cropping drops out-of-range tiles and sparse pairs. Events whose
 *  top-left leaves the map are cropped (their ids are returned so the UI
 *  can warn); events partially outside keep their top-left and shrink. The
 *  top-left corner is fixed — content is never translated. One undo step. */
export function resizeMap(state: EditRulesState, rawW: number, rawH: number): ResizeResult {
  const map = state.project.maps[state.mapIndex];
  if (!map) return { ok: false, error: "no map selected" };
  if (!Number.isFinite(rawW) || rawW !== Math.trunc(rawW) || rawW < 1 || rawW > 256) {
    return { ok: false, error: "width must be an integer from 1 to 256" };
  }
  if (!Number.isFinite(rawH) || rawH !== Math.trunc(rawH) || rawH < 1 || rawH > 256) {
    return { ok: false, error: "height must be an integer from 1 to 256" };
  }
  const width = rawW;
  const height = rawH;
  if (width === map.width && height === map.height) {
    return { ok: true, state, croppedEvents: [] };
  }
  const mapIndex = state.mapIndex;
  const oldW = map.width;
  const oldH = map.height;
  const croppedEvents: string[] = [];
  const next = commitStructural(state, (project) => {
    const target = project.maps[mapIndex]!;
    const ground: (string | null)[] = new Array(width * height).fill(null);
    for (let y = 0; y < Math.min(oldH, height); y++) {
      for (let x = 0; x < Math.min(oldW, width); x++) {
        ground[y * width + x] = target.ground[y * oldW + x] ?? null;
      }
    }
    target.ground = ground;
    target.width = width;
    target.height = height;
    const upper = resizeSparse(target.upper, oldW, oldH, width, height);
    if (upper === undefined) delete target.upper;
    else target.upper = upper;
    const passage = resizeSparse(target.passage, oldW, oldH, width, height);
    if (passage === undefined) delete target.passage;
    else target.passage = passage;
    const regions = resizeSparse(target.regions, oldW, oldH, width, height);
    if (regions === undefined) delete target.regions;
    else target.regions = regions;
    const events = (target.events ?? []).flatMap((event): GameEvent[] => {
      if (event.x >= width || event.y >= height) {
        croppedEvents.push(event.id);
        return [];
      }
      const w = event.w ?? 1;
      const h = event.h ?? 1;
      const nw = Math.min(w, width - event.x);
      const nh = Math.min(h, height - event.y);
      const adjusted: GameEvent = { ...event };
      if (nw !== w) adjusted.w = nw;
      if (nh !== h) adjusted.h = nh;
      return [adjusted];
    });
    // A resize always materializes the post-resize event collection. Keep
    // [] both when expanding an empty map and when cropping its last event.
    target.events = events;
    const selectedSurvives = state.selectedEventId !== null
      && events.some((event) => event.id === state.selectedEventId);
    return {
      project,
      mapIndex,
      selectedEventId: selectedSurvives ? state.selectedEventId : null,
      selectedPageIndex: selectedSurvives ? state.selectedPageIndex : 0,
    };
  });
  if (next === null) return { ok: false, error: "finish the current stroke first" };
  return { ok: true, state: next, croppedEvents };
}

/** Replace the active map's sheet list. Every id must name a project sheet
 *  and the list must stay non-empty. One undo step. */
export function setMapSheets(state: EditRulesState, sheets: string[]): StructuralResult {
  if (sheets.length === 0) return { ok: false, error: "a map needs at least one sheet" };
  const unknown = sheets.find((id) => !state.project.sheets.some((sheet) => sheet.id === id));
  if (unknown) return { ok: false, error: `unknown sheet "${unknown}"` };
  const deduped = [...new Set(sheets)];
  const mapIndex = state.mapIndex;
  const current = state.project.maps[mapIndex]!.sheets ?? [];
  if (deduped.length === current.length && deduped.every((id, i) => id === current[i])) {
    return { ok: true, state };
  }
  return structural(state, commitStructural(state, (project) => {
    project.maps[mapIndex]!.sheets = deduped;
    return {
      project,
      mapIndex,
      selectedEventId: state.selectedEventId,
      selectedPageIndex: state.selectedPageIndex,
    };
  }));
}

export interface NewMapOptions {
  id?: string;
  name?: string;
  width?: number;
  height?: number;
  sheets?: string[];
  /** Ground tile for every cell ("town.0"); null leaves the map void. */
  fill?: string | null;
}

/** Create an empty map after the active one and select it. Event ids are
 *  not involved (a fresh map has no events). One undo step. */
export function newMap(state: EditRulesState, options: NewMapOptions = {}): StructuralResult {
  const project = state.project;
  const width = clampInteger(options.width ?? 20, 1, 256);
  const height = clampInteger(options.height ?? 14, 1, 256);
  const sheets = options.sheets
    ?? project.maps[state.mapIndex]?.sheets
    ?? project.sheets.slice(0, 1).map((sheet) => sheet.id);
  if (sheets.length === 0) return { ok: false, error: "no sheets available for a new map" };
  const unknown = sheets.find((id) => !project.sheets.some((sheet) => sheet.id === id));
  if (unknown) return { ok: false, error: `unknown sheet "${unknown}"` };
  const fill = options.fill ?? null;
  if (fill !== null) {
    const m = TILE_RE.exec(fill);
    const sheetOk = m !== null && sheets.includes(m[1]!)
      && project.sheets.some((sheet) => sheet.id === m[1]);
    if (!sheetOk) return { ok: false, error: `fill tile ${fill} is not on this map's sheets` };
    const cell = Number(m![2]!);
    const sheet = project.sheets.find((s) => s.id === m![1])!;
    if (cell < 0 || cell >= sheet.cols * sheet.rows) {
      return { ok: false, error: `fill tile ${fill} is outside its sheet grid` };
    }
  }
  const id = uniqueMapId(project, options.id ?? "map");
  const name = options.name?.trim() || `Map ${project.maps.length + 1}`;
  if (name.length > 40) return { ok: false, error: "name must be at most 40 characters" };
  const map: MapDef = {
    id,
    name,
    width,
    height,
    sheets: [...new Set(sheets)],
    ground: new Array<string | null>(width * height).fill(fill),
    events: [],
  };
  const insertAt = Math.min(state.mapIndex + 1, project.maps.length);
  return structural(state, commitStructural(state, (flushed) => {
    const maps = flushed.maps.slice();
    maps.splice(insertAt, 0, map);
    return { project: { ...flushed, maps }, mapIndex: insertAt, selectedEventId: null, selectedPageIndex: 0 };
  }));
}

/** Duplicate the active map directly after it and select the copy.
 *
 * Event-id renumbering rule: event ids are MAP-LOCAL in this format (only
 * transfer map operands and the start position reference maps; nothing
 * references an event across maps), so the copy KEEPS every event id
 * verbatim — they remain unique inside the copy and intra-map references
 * (`place`/`moveRoute` {event}) stay valid. Only the map id gets a unique
 * `-copy` suffix. One undo step. */
export function duplicateMap(state: EditRulesState): StructuralResult {
  const map = state.project.maps[state.mapIndex];
  if (!map) return { ok: false, error: "no map selected" };
  const insertAt = state.mapIndex + 1;
  return structural(state, commitStructural(state, (flushed) => {
    // Build the copy only after commitStructural has flushed the dense
    // upper/passage caches into this transaction's isolated project.
    const source = flushed.maps[state.mapIndex]!;
    const copy = cloneJson(source);
    copy.id = uniqueMapId(flushed, `${source.id}-copy`);
    const maps = flushed.maps.slice();
    maps.splice(insertAt, 0, copy);
    return { project: { ...flushed, maps }, mapIndex: insertAt, selectedEventId: null, selectedPageIndex: 0 };
  }));
}

/** Delete the active map. Refuses the only map and the start map. When
 *  transfers reference the map and `confirm` is false, returns the
 *  references so the UI can list them and ask for a second confirmation;
 *  with `confirm: true` the map is deleted anyway. One undo step. */
export function deleteMap(state: EditRulesState, confirm = false): DeleteMapResult {
  const project = state.project;
  const map = project.maps[state.mapIndex];
  if (!map) return { ok: false, error: "no map selected", references: [] };
  if (project.maps.length <= 1) return { ok: false, error: "cannot delete the only map", references: [] };
  if (project.start.map === map.id) {
    return { ok: false, error: "cannot delete the start map", references: [] };
  }
  const references = mapReferences(project, map.id);
  if (references.length > 0 && !confirm) {
    return { ok: false, error: `${references.length} transfer(s) target this map`, references };
  }
  const mapIndex = state.mapIndex;
  const next = commitStructural(state, (flushed) => {
    const maps = flushed.maps.slice();
    maps.splice(mapIndex, 1);
    return {
      project: { ...flushed, maps },
      mapIndex: Math.max(0, Math.min(mapIndex, maps.length - 1)),
      selectedEventId: null,
      selectedPageIndex: 0,
    };
  });
  if (next === null) return { ok: false, error: "finish the current stroke first", references: [] };
  return { ok: true, state: next };
}

// --- sheet dirEdges strokes (PASS mode edge tools) --------------------------

/** Begin a stroke that toggles one-sided passage edges on the SHEET of the
 *  painted cell's ground tile (dirEdges is sheet-level in this format). The
 *  brush toggles an `enter`/`exit` direction, or clears the cell's entry.
 *  Void cells (no ground tile) are ignored while painting. */
export function edgeStrokeStart(state: EditRulesState, brush: EdgeBrush): EditRulesState {
  if (state.stroke || state.edgeStroke) return state;
  // Flush pending sparse-layer paints into the project first, so the
  // cache rebuild below cannot drop them.
  const flushed = exportProject(state);
  return {
    ...state,
    project: flushed,
    ...rebuildCaches(flushed),
    edgeStroke: { brush, cells: [], visited: [] },
  };
}

export function edgePaintCell(state: EditRulesState, index: number): EditRulesState {
  const stroke = state.edgeStroke;
  if (!stroke) return state;
  const map = currentMap(state);
  if (index < 0 || index >= map.width * map.height) return state;
  const tile = map.ground[index];
  if (typeof tile !== "string") return state;
  const m = TILE_RE.exec(tile);
  if (!m) return state;
  const sheetId = m[1]!;
  // Normalize the cell key the way the runtime does (String(Number(cell))),
  // so a hand-authored "town.00" paints the same entry as "town.0".
  const cell = String(Number(m[2]!));
  const sheetIndex = state.project.sheets.findIndex((sheet) => sheet.id === sheetId);
  if (sheetIndex < 0) return state;
  const visitedKey = `${sheetId}\u0000${cell}`;
  if (stroke.visited.includes(visitedKey)) return state;
  const visited = [...stroke.visited, visitedKey];
  const sheet = state.project.sheets[sheetIndex]!;
  const dirEdges: Record<string, { enter?: Dir[]; exit?: Dir[] }> = { ...(sheet.dirEdges ?? {}) };
  if (stroke.brush.kind === "clear") {
    if (dirEdges[cell] === undefined) return { ...state, edgeStroke: { ...stroke, visited } };
    delete dirEdges[cell];
  } else {
    const kind = stroke.brush.kind;
    const entry: { enter?: Dir[]; exit?: Dir[] } = { ...(dirEdges[cell] ?? {}) };
    const list = (entry[kind] ?? []).slice();
    const at = list.indexOf(stroke.brush.dir);
    if (at >= 0) list.splice(at, 1);
    else list.push(stroke.brush.dir);
    if (list.length === 0) delete entry[kind];
    else entry[kind] = list;
    if (Object.keys(entry).length === 0) delete dirEdges[cell];
    else dirEdges[cell] = entry;
  }
  const sheets = state.project.sheets.slice();
  const nextSheet: typeof sheet = { ...sheet };
  if (Object.keys(dirEdges).length === 0) delete nextSheet.dirEdges;
  else nextSheet.dirEdges = dirEdges;
  sheets[sheetIndex] = nextSheet;
  const edgeStroke: OpenEdgeStroke = { ...stroke, cells: [...stroke.cells, index], visited };
  return { ...state, project: { ...state.project, sheets }, edgeStroke };
}

/** Close an edge stroke. Its toggles are already in the sheets. */
export function edgeStrokeEnd(state: EditRulesState): EditRulesState {
  if (!state.edgeStroke) return state;
  return { ...state, edgeStroke: null };
}
