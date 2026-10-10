// Four placed outdoor maps plus one unplaced indoor map exercise every W4
// opening class without tying the reducer tests to a game importer.

import type {
  Command,
  GameEvent,
  MapDef,
  Project,
  TileId,
  WorldLayout,
} from "../../../src/engine/types.ts";

const TILE: TileId = "plain.0";
export const MAP_SIZE = 4;

export const SAFE_EAST = "west:east:safe";
export const SAFE_WEST = "east:west:safe";
export const SAFE_SOUTH = "north:west:safe";
export const CAPABILITY_EAST = "west:east:capability";
export const PORTAL_ONLY_EAST = "west:east:portal-only";

export const HANDOFF_LAYOUT: WorldLayout = {
  topologyHash: "d".repeat(64),
  components: [{
    worldId: "fixture-world",
    componentId: "outdoors",
    bounds: { minTileX: 0, minTileY: -4, maxTileX: 8, maxTileY: 8 },
    placements: [
      { mapId: "east", originTileX: 4, originTileY: 0, width: 4, height: 4 },
      { mapId: "north", originTileX: 0, originTileY: -4, width: 4, height: 4 },
      { mapId: "south", originTileX: 4, originTileY: 4, width: 4, height: 4 },
      { mapId: "west", originTileX: 0, originTileY: 0, width: 4, height: 4 },
    ],
    seams: [
      {
        mapA: "east",
        sideA: "south",
        spanA: { start: 0, end: 4 },
        mapB: "south",
        sideB: "north",
        spanB: { start: 0, end: 4 },
        axis: "x",
        offsetAtoB: 0,
        openingIds: [],
      },
      {
        mapA: "north",
        sideA: "south",
        spanA: { start: 0, end: 4 },
        mapB: "west",
        sideB: "north",
        spanB: { start: 0, end: 4 },
        axis: "x",
        offsetAtoB: 0,
        openingIds: [SAFE_SOUTH],
      },
      {
        mapA: "west",
        sideA: "east",
        spanA: { start: 0, end: 4 },
        mapB: "east",
        sideB: "west",
        spanB: { start: 0, end: 4 },
        axis: "y",
        offsetAtoB: 0,
        openingIds: [SAFE_WEST, CAPABILITY_EAST, PORTAL_ONLY_EAST, SAFE_EAST],
      },
    ],
    openings: [
      {
        portalId: SAFE_WEST,
        source: { mapId: "east", side: "west", span: { start: 1, end: 2 } },
        target: { mapId: "west", side: "east", span: { start: 1, end: 2 } },
        axis: "y",
        offset: 0,
        compatibility: "coordinate-preserving",
      },
      {
        portalId: SAFE_SOUTH,
        source: { mapId: "north", side: "south", span: { start: 1, end: 2 } },
        target: { mapId: "west", side: "north", span: { start: 1, end: 2 } },
        axis: "x",
        offset: 0,
        compatibility: "coordinate-preserving",
      },
      {
        portalId: CAPABILITY_EAST,
        source: { mapId: "west", side: "east", span: { start: 1, end: 2 } },
        target: { mapId: "east", side: "west", span: { start: 1, end: 2 } },
        axis: "y",
        offset: 0,
        compatibility: "coordinate-preserving",
        movementCapability: "surf",
      },
      {
        portalId: PORTAL_ONLY_EAST,
        source: { mapId: "west", side: "east", span: { start: 2, end: 3 } },
        target: { mapId: "east", side: "west", span: { start: 2, end: 3 } },
        axis: "y",
        offset: 0,
        compatibility: "portal-only",
      },
      {
        portalId: SAFE_EAST,
        source: { mapId: "west", side: "east", span: { start: 1, end: 2 } },
        target: { mapId: "east", side: "west", span: { start: 1, end: 2 } },
        axis: "y",
        offset: 0,
        compatibility: "coordinate-preserving",
      },
    ],
  }],
};

export function handoffMap(id: string, events: GameEvent[] = []): MapDef {
  return {
    id,
    name: id,
    width: MAP_SIZE,
    height: MAP_SIZE,
    sheets: ["plain"],
    ground: new Array(MAP_SIZE * MAP_SIZE).fill(TILE),
    events,
  };
}

export function autorunTransfer(command: Extract<Command, { op: "transfer" }>): GameEvent {
  return {
    id: "transfer",
    x: 0,
    y: 0,
    pages: [{ trigger: "autorun", commands: [command] }],
  };
}

export function playerTouchTransfer(
  id: string,
  x: number,
  y: number,
  command: Extract<Command, { op: "transfer" }>,
): GameEvent {
  return {
    id,
    x,
    y,
    pages: [{ trigger: "playerTouch", commands: [command] }],
  };
}

export function handoffProject(options: {
  start?: Project["start"];
  sourceEvent?: GameEvent;
  mapEvents?: Partial<Record<"east" | "north" | "south" | "west" | "indoor", GameEvent[]>>;
  traversal?: Project["worldTraversal"];
} = {}): Project {
  const mapEvents = options.mapEvents ?? {};
  const start = options.start ?? { map: "west", x: 3, y: 1, dir: "right" };
  const sourceEvents = [...(mapEvents[start.map as keyof typeof mapEvents] ?? [])];
  if (options.sourceEvent) sourceEvents.unshift(options.sourceEvent);
  const eventsFor = (id: keyof typeof mapEvents): GameEvent[] =>
    id === start.map ? sourceEvents : [...(mapEvents[id] ?? [])];
  return {
    format: "rpgkit-project/v1",
    title: "Seamless handoff fixture",
    tileSize: 16,
    start,
    worldTraversal: options.traversal ?? "seamless-v1",
    worldLayout: HANDOFF_LAYOUT,
    sheets: [{ id: "plain", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [
      handoffMap("east", eventsFor("east")),
      handoffMap("indoor", eventsFor("indoor")),
      handoffMap("north", eventsFor("north")),
      handoffMap("south", eventsFor("south")),
      handoffMap("west", eventsFor("west")),
    ],
  };
}

export function markedTransfer(
  map: string,
  x: number,
  y: number,
  dir: "up" | "down" | "left" | "right" | "keep",
  portalId: string,
): Extract<Command, { op: "transfer" }> & { map: string; x: number; y: number } {
  return {
    op: "transfer",
    map,
    x,
    y,
    dir,
    handoff: { mode: "seamless-v1", portalId },
  };
}
