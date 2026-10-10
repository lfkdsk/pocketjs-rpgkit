import { describe, expect, test } from "bun:test";
import schema from "../src/data/schema.json" with { type: "json" };
import {
  clampCamera,
  createVisibleWorldMapsReader,
  followCamera,
  localToWorld,
  validateWorldLayout,
  worldToLocal,
  type MapDef,
  type Project,
  type WorldLayout,
  type WorldPlacement,
} from "../src/engine/index.ts";
import { validateSchema } from "../src/engine/schema-validate.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const WEST: WorldPlacement = {
  mapId: "west",
  originTileX: -12,
  originTileY: -7,
  width: 12,
  height: 9,
};

const LAYOUT: WorldLayout = {
  topologyHash: HASH_A,
  components: [{
    worldId: "overworld",
    componentId: "west",
    bounds: { minTileX: -12, minTileY: -11, maxTileX: 8, maxTileY: 2 },
    placements: [
      { mapId: "east", originTileX: 0, originTileY: -7, width: 8, height: 9 },
      { mapId: "north", originTileX: -12, originTileY: -11, width: 12, height: 4 },
      WEST,
    ],
    seams: [
      {
        mapA: "north",
        sideA: "south",
        spanA: { start: 0, end: 12 },
        mapB: "west",
        sideB: "north",
        spanB: { start: 0, end: 12 },
        axis: "x",
        offsetAtoB: 0,
        openingIds: [],
      },
      {
        mapA: "west",
        sideA: "east",
        spanA: { start: 0, end: 9 },
        mapB: "east",
        sideB: "west",
        spanB: { start: 0, end: 9 },
        axis: "y",
        offsetAtoB: 0,
        openingIds: ["west:east:fixed", "west:east:safe"],
      },
    ],
    openings: [
      {
        portalId: "west:east:fixed",
        source: { mapId: "west", side: "east", span: { start: 4, end: 6 } },
        target: { mapId: "east", side: "west", span: { start: 4, end: 6 } },
        axis: "y",
        offset: 0,
        compatibility: "portal-only",
      },
      {
        portalId: "west:east:safe",
        source: { mapId: "west", side: "east", span: { start: 2, end: 3 } },
        target: { mapId: "east", side: "west", span: { start: 2, end: 3 } },
        axis: "y",
        offset: 0,
        compatibility: "coordinate-preserving",
        movementCapability: "surf",
      },
    ],
  }],
};

function map(id: string): MapDef {
  return {
    id,
    name: id,
    width: 2,
    height: 2,
    sheets: ["tiles"],
    ground: ["tiles.0", "tiles.0", "tiles.0", "tiles.0"],
    events: [],
  };
}

function project(worldLayout: WorldLayout = LAYOUT): Project {
  return {
    format: "rpgkit-project/v1",
    title: "World layout fixture",
    tileSize: 16,
    start: { map: "west", x: 0, y: 0, dir: "right" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1 }],
    items: [],
    worldLayout,
    maps: [map("west"), map("east"), map("north")],
  };
}

describe("WorldLayout coordinate contract", () => {
  test("round-trips negative origins without clamping or mutating inputs", () => {
    const local = Object.freeze({ x: 3, y: 5 });
    const placement = Object.freeze({ ...WEST });
    const before = JSON.stringify({ placement, local });

    const world = localToWorld(placement, local);
    expect(world).toEqual({ x: -9, y: -2 });
    expect(worldToLocal(placement, world)).toEqual(local);
    expect(worldToLocal(placement, { x: -13, y: -8 })).toEqual({ x: -1, y: -1 });
    expect(JSON.stringify({ placement, local })).toBe(before);
  });

  test("component camera clamps signed bounds and pins an undersized axis to its minimum", () => {
    const component = LAYOUT.components[0]!;
    const cfg = {
      worldX: component.bounds.minTileX * 16,
      worldY: component.bounds.minTileY * 16,
      worldW: (component.bounds.maxTileX - component.bounds.minTileX) * 16,
      worldH: (component.bounds.maxTileY - component.bounds.minTileY) * 16,
      viewportW: 160,
      viewportH: 480,
    };
    expect(clampCamera(-10_000, -10_000, cfg)).toEqual({ x: -192, y: -176 });
    expect(clampCamera(10_000, 10_000, cfg)).toEqual({ x: -32, y: -176 });
    expect(followCamera(-16, -32, 16, 3, cfg)).toEqual({ x: -88, y: -176, facing: 3 });
  });

  test("visible-map query is half-open, ordered and stable within a tile boundary", () => {
    const component = LAYOUT.components[0]!;
    const read = createVisibleWorldMapsReader(component, 16);
    const camera = { x: -32, y: -96 };
    const viewport = { w: 32, h: 32 };

    const westOnly = read(camera, viewport);
    expect(westOnly.map((placement) => placement.mapId)).toEqual(["west"]);
    expect(read({ x: -32.5, y: -95.5 }, viewport)).toBe(westOnly);

    camera.x = -16;
    const straddling = read(camera, viewport);
    expect(straddling.map((placement) => placement.mapId)).toEqual(["east", "west"]);
    expect(straddling).not.toBe(westOnly);

    camera.x = 0;
    expect(read(camera, viewport).map((placement) => placement.mapId)).toEqual(["east"]);
    camera.x = -32;
    viewport.w = 48;
    expect(read(camera, viewport, 16).map((placement) => placement.mapId)).toEqual(["east", "west"]);
  });

  test("visible-map query observes in-place inputs and returns one shared empty result", () => {
    const read = createVisibleWorldMapsReader(LAYOUT.components[0]!, 16);
    const camera = { x: -192, y: -176 };
    const viewport = { w: 16, h: 16 };
    expect(read(camera, viewport).map((placement) => placement.mapId)).toEqual(["north"]);
    camera.x = 10_000;
    const empty = read(camera, viewport);
    expect(empty).toEqual([]);
    viewport.w = 0;
    expect(read(camera, viewport)).toBe(empty);
    expect(() => createVisibleWorldMapsReader(LAYOUT.components[0]!, 0)).toThrow("tileSize must be positive");
    expect(() => read(camera, { w: 1, h: 1 }, -1)).toThrow("margin must be non-negative");
  });

  test("the optional project field represents component bounds and mixed opening safety", () => {
    expect(validateWorldLayout(LAYOUT)).toBe(LAYOUT);
    expect(validateSchema(schema, project())).toEqual([]);
    expect(LAYOUT.components[0]!.seams[0]!.openingIds).toEqual([]);
    expect(new Set(LAYOUT.components[0]!.openings.map((opening) => opening.compatibility))).toEqual(
      new Set(["coordinate-preserving", "portal-only"]),
    );
    expect(LAYOUT.components[0]!.openings[1]!.movementCapability).toBe("surf");

    const fractionalOrigin = structuredClone(project()) as Project;
    fractionalOrigin.worldLayout!.components[0]!.placements[0]!.originTileX = -11.5;
    expect(validateSchema(schema, fractionalOrigin).some((error) =>
      error.path.endsWith(".originTileX") && error.msg.includes("integer")
    )).toBeTrue();

    const unsafeDefault = structuredClone(project()) as Project;
    (unsafeDefault.worldLayout!.components[0]!.openings[0] as { compatibility: string }).compatibility = "seamless";
    expect(validateSchema(schema, unsafeDefault).some((error) =>
      error.path.endsWith(".compatibility")
    )).toBeTrue();

    const emptyCapability = structuredClone(project()) as Project;
    emptyCapability.worldLayout!.components[0]!.openings[1]!.movementCapability = "";
    expect(validateSchema(schema, emptyCapability).some((error) =>
      error.path.endsWith(".movementCapability")
    )).toBeTrue();
  });

  test("seamless traversal and transfer provenance are explicit optional contract fields", () => {
    const enabled = project();
    enabled.worldTraversal = "seamless-v1";
    enabled.maps[0]!.events = [{
      id: "safe-opening",
      x: 1,
      y: 1,
      pages: [{
        trigger: "playerTouch",
        commands: [{
          op: "transfer",
          map: "east",
          x: 0,
          y: 2,
          handoff: { mode: "seamless-v1", portalId: "west:east:safe" },
        }],
      }],
    }];
    expect(validateSchema(schema, enabled)).toEqual([]);

    const missingPortal = structuredClone(enabled) as unknown as Record<string, unknown>;
    const transfer = ((missingPortal.maps as Project["maps"])[0]!.events![0]!.pages[0]!.commands[0] as unknown) as Record<string, unknown>;
    transfer.handoff = { mode: "seamless-v1" };
    expect(validateSchema(schema, missingPortal).length).toBeGreaterThan(0);

    const legacy = project();
    expect(legacy.worldTraversal).toBeUndefined();
    expect(validateSchema(schema, legacy)).toEqual([]);
  });

  test("semantic validation rejects drifted bounds, overlap and opening mappings", () => {
    const driftedBounds = structuredClone(LAYOUT);
    driftedBounds.components[0]!.bounds.minTileX++;
    expect(() => validateWorldLayout(driftedBounds)).toThrow("bounds do not equal the placement union");

    const overlap = structuredClone(LAYOUT);
    overlap.components[0]!.placements[0]!.originTileX = -1;
    expect(() => validateWorldLayout(overlap)).toThrow("overlap");

    const badOpening = structuredClone(LAYOUT);
    badOpening.components[0]!.openings[0]!.offset = 1;
    expect(() => validateWorldLayout(badOpening)).toThrow("target span does not equal source span plus offset");

    const unreferenced = structuredClone(LAYOUT);
    unreferenced.components[0]!.seams[1]!.openingIds = ["west:east:fixed"];
    expect(() => validateWorldLayout(unreferenced)).toThrow("opening west:east:safe is not referenced by a seam");
  });

  test("topology participates in shell identity without changing map shards", () => {
    const first = splitProjectMaps(project());
    const second = splitProjectMaps(project({ ...LAYOUT, topologyHash: HASH_B }));

    expect(first.shell.worldLayout).toEqual(LAYOUT);
    expect(first.shell.mapManifestHash).not.toBe(second.shell.mapManifestHash);
    expect(first.entries.map((entry) => [entry.meta.id, entry.meta.sha256])).toEqual(
      second.entries.map((entry) => [entry.meta.id, entry.meta.sha256]),
    );
  });
});
