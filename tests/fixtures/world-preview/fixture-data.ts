// Four placed maps for the read-only neighbour preview. West is the start
// map; east sits across a vertical seam with one coordinate-preserving
// opening on row 6, north sits above west and south under it. Each previewable character has
// its own solid colour so pixel probes can tell exactly which one painted.

import type { GameEvent, MapDef, Project, TileId, WorldLayout } from "../../../src/engine/types.ts";

export type Rgba = readonly [number, number, number, number];

export const MAP_W = 20;
export const MAP_H = 12;
export const OPENING = "west:east:row-6";
/** The way back: east's row 7 opens onto west's row 7. */
export const RETURN_OPENING = "east:west:row-7";

export const PLACED = [
  { id: "west", originTileX: 0, originTileY: 0, ground: [46, 92, 60, 255] as Rgba, upper: [240, 220, 120, 255] as Rgba },
  { id: "east", originTileX: MAP_W, originTileY: 0, ground: [60, 70, 120, 255] as Rgba, upper: [250, 250, 250, 255] as Rgba },
  { id: "south", originTileX: 0, originTileY: MAP_H, ground: [110, 80, 50, 255] as Rgba, upper: [200, 120, 220, 255] as Rgba },
  { id: "north", originTileX: 0, originTileY: -MAP_H, ground: [70, 110, 110, 255] as Rgba, upper: [90, 90, 40, 255] as Rgba },
] as const;

/** Upper-band markers (map-local tiles) that paint above characters. */
export const UPPER_MARKERS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  west: [],
  east: [[6, 6]],
  south: [],
  north: [],
};

export const PLAYER_COLOUR: Rgba = [250, 244, 248, 255];
/** One idle colour per facing (down, left, up, right) for the walker. */
export const FACER_COLOURS: readonly Rgba[] = [
  [220, 40, 40, 255],
  [40, 200, 60, 255],
  [40, 80, 230, 255],
  [240, 210, 30, 255],
];
export const COLOURS = {
  wander: [255, 140, 0, 255] as Rgba,
  gated: [0, 220, 220, 255] as Rgba,
  removed: [180, 0, 180, 255] as Rgba,
  rejected: [255, 0, 120, 255] as Rgba,
  facing: [130, 255, 130, 255] as Rgba,
  under: [10, 10, 10, 255] as Rgba,
  row: [255, 255, 0, 255] as Rgba,
  tall: [0, 255, 160, 255] as Rgba,
  nrow: [120, 60, 255, 255] as Rgba,
  wtall: [255, 200, 200, 255] as Rgba,
  atall: [100, 200, 255, 255] as Rgba,
  zshort: [200, 100, 40, 255] as Rgba,
  ghost: [200, 255, 0, 255] as Rgba,
} as const;

/** Walker sprites cooked as 16x32 frames. */
export const TALL_SPRITES = ["tall", "wtall", "atall"] as const;

export const WORLD_LAYOUT: WorldLayout = {
  topologyHash: "5".repeat(64),
  components: [{
    worldId: "preview-world",
    componentId: "three-maps",
    bounds: { minTileX: 0, minTileY: -MAP_H, maxTileX: MAP_W * 2, maxTileY: MAP_H * 2 },
    placements: [
      { mapId: "east", originTileX: MAP_W, originTileY: 0, width: MAP_W, height: MAP_H },
      { mapId: "north", originTileX: 0, originTileY: -MAP_H, width: MAP_W, height: MAP_H },
      { mapId: "south", originTileX: 0, originTileY: MAP_H, width: MAP_W, height: MAP_H },
      { mapId: "west", originTileX: 0, originTileY: 0, width: MAP_W, height: MAP_H },
    ],
    seams: [
      {
        mapA: "north", sideA: "south", spanA: { start: 0, end: MAP_W },
        mapB: "west", sideB: "north", spanB: { start: 0, end: MAP_W },
        axis: "x", offsetAtoB: 0, openingIds: [],
      },
      {
        mapA: "west", sideA: "east", spanA: { start: 0, end: MAP_H },
        mapB: "east", sideB: "west", spanB: { start: 0, end: MAP_H },
        axis: "y", offsetAtoB: 0, openingIds: [RETURN_OPENING, OPENING],
      },
      {
        mapA: "west", sideA: "south", spanA: { start: 0, end: MAP_W },
        mapB: "south", sideB: "north", spanB: { start: 0, end: MAP_W },
        axis: "x", offsetAtoB: 0, openingIds: [],
      },
    ],
    openings: [
      {
        portalId: RETURN_OPENING,
        source: { mapId: "east", side: "west", span: { start: 7, end: 8 } },
        target: { mapId: "west", side: "east", span: { start: 7, end: 8 } },
        axis: "y",
        offset: 0,
        compatibility: "coordinate-preserving",
      },
      {
        portalId: OPENING,
        source: { mapId: "west", side: "east", span: { start: 6, end: 7 } },
        target: { mapId: "east", side: "west", span: { start: 6, end: 7 } },
        axis: "y",
        offset: 0,
        compatibility: "coordinate-preserving",
      },
    ],
  }],
};

const WEST_EVENTS: GameEvent[] = [
  {
    id: "w-portal",
    x: MAP_W - 1,
    y: 6,
    pages: [{
      trigger: "playerTouch",
      commands: [{
        op: "transfer",
        map: "east",
        x: 0,
        y: 6,
        dir: "right",
        handoff: { mode: "seamless-v1", portalId: OPENING },
      }],
    }],
  },
  // Dynamic create/remove on the far side: after a short wait the west
  // parallel turns `gate.on` on (east's gated NPC appears) and `gone` on
  // (east's removable NPC disappears), then stops via its self switch.
  {
    id: "w-script",
    x: 0,
    y: 0,
    pages: [
      {
        trigger: "parallel",
        commands: [
          { op: "wait", seconds: 0.25 },
          { op: "switch", id: "gate.on", value: true },
          { op: "switch", id: "gone", value: true },
          { op: "selfSwitch", key: "A", value: true },
        ],
      },
      { condition: { selfSwitch: "A" }, trigger: "action", commands: [] },
    ],
  },
  // An active-map character on the last row, overlapped by south's 32px one.
  { id: "w-row", x: 5, y: MAP_H - 1, pages: [{ trigger: "action", sprite: "row", commands: [] }] },
  // A 32px active-map character on the first row overlapping north's last row.
  { id: "w-tall", x: 5, y: 0, pages: [{ trigger: "action", sprite: "wtall", commands: [] }] },
];

const EAST_EVENTS: GameEvent[] = [
  {
    id: "e-portal",
    x: 0,
    y: 7,
    pages: [{
      trigger: "playerTouch",
      commands: [{
        op: "transfer",
        map: "west",
        x: MAP_W - 1,
        y: 7,
        dir: "left",
        handoff: { mode: "seamless-v1", portalId: RETURN_OPENING },
      }],
    }],
  },
  { id: "e-static", x: 2, y: 6, pages: [{ trigger: "action", sprite: "facer", dir: "left", blocks: true, commands: [] }] },
  { id: "e-wander", x: 4, y: 3, pages: [{ trigger: "action", sprite: "wander", moveType: "random", commands: [] }] },
  {
    id: "e-gated",
    x: 3,
    y: 9,
    pages: [
      { trigger: "action", commands: [] },
      { condition: { switch: "gate.on" }, trigger: "action", sprite: "gated", commands: [] },
    ],
  },
  {
    id: "e-removed",
    x: 5,
    y: 9,
    pages: [
      { trigger: "action", sprite: "removed", commands: [] },
      { condition: { switch: "gone" }, trigger: "action", commands: [] },
    ],
  },
  { id: "e-rejected", x: 1, y: 3, pages: [{ condition: { switch: "east.spawned" }, trigger: "action", sprite: "rejected", commands: [] }] },
  // Runs only once east is active: proves target programs do not run early.
  {
    id: "e-script",
    x: 0,
    y: 0,
    pages: [
      {
        trigger: "parallel",
        commands: [
          { op: "switch", id: "east.spawned", value: true },
          { op: "variable", id: "east.ran", set: { op: "add", value: 1 } },
          { op: "appearance", target: { event: "e-ghost" }, opacity: 128 },
          { op: "selfSwitch", key: "A", value: true },
        ],
      },
      { condition: { selfSwitch: "A" }, trigger: "action", commands: [] },
    ],
  },
  {
    id: "e-facing",
    x: 1,
    y: 8,
    pages: [{ condition: { all: [{ kind: "facing", dir: "right" }] }, trigger: "action", sprite: "facing", commands: [] }],
  },
  { id: "e-under", x: 6, y: 6, pages: [{ trigger: "action", sprite: "under", commands: [] }] },
  // Made half transparent by e-script once east is active (so its entry
  // preview is rejected); the frozen snapshot must keep that opacity.
  { id: "e-ghost", x: 10, y: 10, pages: [{ trigger: "action", sprite: "ghost", commands: [] }] },
  // Two previews in one band overlap: the 32px one stands a row lower and
  // sorts first by id, so only world-y depth puts it in front.
  { id: "e-a-tall", x: 8, y: 3, pages: [{ trigger: "action", sprite: "atall", commands: [] }] },
  { id: "e-z-short", x: 8, y: 2, pages: [{ trigger: "action", sprite: "zshort", commands: [] }] },
];

const NORTH_EVENTS: GameEvent[] = [
  { id: "n-row", x: 5, y: MAP_H - 1, pages: [{ trigger: "action", sprite: "nrow", commands: [] }] },
];

const SOUTH_EVENTS: GameEvent[] = [
  { id: "s-tall", x: 5, y: 0, pages: [{ trigger: "action", sprite: "tall", dir: "down", commands: [] }] },
];

const ground = (): TileId[] => Array.from({ length: MAP_W * MAP_H }, () => "fixture.0");

const mapDef = (id: string, events: GameEvent[]): MapDef => ({
  id,
  name: id,
  width: MAP_W,
  height: MAP_H,
  sheets: ["fixture"],
  ground: ground(),
  events,
});

export const WORLD_PREVIEW_PROJECT: Project = {
  format: "rpgkit-project/v1",
  title: "Neighbour preview fixture",
  tileSize: 16,
  start: { map: "west", x: 17, y: 6, dir: "right" },
  worldTraversal: "seamless-v1",
  sheets: [{ id: "fixture", cols: 1, rows: 1, pak: "fixture", defaultPassage: "pass" }],
  sprites: {
    facer: { kind: "walker", sheet: "facer", h: 16 },
    wander: { kind: "image", src: "assets/npc/wander.png" },
    gated: { kind: "image", src: "assets/npc/gated.png" },
    removed: { kind: "image", src: "assets/npc/removed.png" },
    rejected: { kind: "image", src: "assets/npc/rejected.png" },
    facing: { kind: "image", src: "assets/npc/facing.png" },
    under: { kind: "image", src: "assets/npc/under.png" },
    row: { kind: "image", src: "assets/npc/row.png" },
    tall: { kind: "walker", sheet: "tall", h: 32 },
    nrow: { kind: "image", src: "assets/npc/nrow.png" },
    wtall: { kind: "walker", sheet: "wtall", h: 32 },
    atall: { kind: "walker", sheet: "atall", h: 32 },
    zshort: { kind: "image", src: "assets/npc/zshort.png" },
    ghost: { kind: "image", src: "assets/npc/ghost.png" },
  },
  items: [],
  worldLayout: WORLD_LAYOUT,
  maps: [
    mapDef("west", WEST_EVENTS),
    mapDef("east", EAST_EVENTS),
    mapDef("north", NORTH_EVENTS),
    mapDef("south", SOUTH_EVENTS),
  ],
};

/** The legacy view's project: east also holds walkers authored facing up
 * and right, so the first frame after an ordinary transfer shows how the
 * not-yet-spawned characters are painted for every non-down facing. */
export const WORLD_PREVIEW_LEGACY_PROJECT: Project = {
  ...WORLD_PREVIEW_PROJECT,
  maps: WORLD_PREVIEW_PROJECT.maps.map((map) => map.id !== "east" ? map : {
    ...map,
    events: [
      ...map.events!,
      { id: "e-up", x: 6, y: 9, pages: [{ trigger: "action", sprite: "facer", dir: "up", commands: [] }] },
      { id: "e-right", x: 7, y: 9, pages: [{ trigger: "action", sprite: "facer", dir: "right", commands: [] }] },
    ],
  }),
};

/** The sandboxed-entry preview's project: east also places a character from
 * an entry-time parallel, the way an importer's `create_npc` does — a
 * per-visit variable selects its visible page and the same program moves it
 * off its authored cell. The static preview must reject it; the sandbox shows
 * it where the first target tick puts it. */
export const SPAWNED_AUTHORED: readonly [number, number] = [6, 8];
export const SPAWNED_CELL: readonly [number, number] = [7, 10];
/** West spawns one the same way, for re-entering the map just left. */
export const WEST_SPAWNED_CELL: readonly [number, number] = [10, 9];
const spawnedPair = (prefix: string, authored: readonly [number, number], cell: readonly [number, number], sprite: string) => [
  {
    id: `${prefix}-npc`,
    x: authored[0],
    y: authored[1],
    pages: [
      { trigger: "action" as const, commands: [] },
      {
        condition: { variable: { id: `local.npc.${prefix}-npc`, op: "==" as const, value: 1 } },
        trigger: "action" as const,
        sprite,
        commands: [],
      },
    ],
  },
  {
    id: `${prefix}-spawner`,
    x: 0,
    y: 1,
    pages: [{
      condition: { variable: { id: `local.npc.${prefix}-npc`, op: "==" as const, value: 0 } },
      trigger: "parallel" as const,
      commands: [
        { op: "variable" as const, id: `local.npc.${prefix}-npc`, set: { op: "set" as const, value: 1 } },
        { op: "place" as const, target: { event: `${prefix}-npc` }, x: cell[0], y: cell[1] },
      ],
    }],
  },
] satisfies GameEvent[];

export const WORLD_PREVIEW_SANDBOX_PROJECT: Project = {
  ...WORLD_PREVIEW_PROJECT,
  maps: WORLD_PREVIEW_PROJECT.maps.map((map) => map.id === "west"
    ? { ...map, events: [...map.events!, ...spawnedPair("w", [10, 3], WEST_SPAWNED_CELL, "nrow")] }
    : map.id !== "east" ? map : {
    ...map,
    events: [...map.events!, ...spawnedPair("e", SPAWNED_AUTHORED, SPAWNED_CELL, "row")],
  }),
};
