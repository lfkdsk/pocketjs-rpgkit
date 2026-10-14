import { describe, expect, test } from "bun:test";
import {
  acquireSessionMap,
  createSession,
  releaseSessionMapLayers,
  startSession,
  type Session,
} from "../src/engine/session.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import { createWorldPrefetcher } from "../src/engine/world-prefetch.ts";
import { splitProjectMaps } from "../tools/lib/map-project.ts";
import type { MapDef, MapRepository, Project } from "../src/engine/types.ts";
import type { WorldWorkingSet } from "../src/engine/world-working-set.ts";

function map(id: string): MapDef {
  return {
    id,
    name: id,
    width: 4,
    height: 4,
    sheets: ["tiles"],
    ground: new Array(16).fill("tiles.0"),
    events: [],
  };
}

function project(): Project {
  return {
    format: "rpgkit-project/v1",
    title: "prefetch fixture",
    tileSize: 16,
    start: { map: "map_a", x: 1, y: 1, dir: "up" },
    sheets: [{ id: "tiles", pak: "tiles", cols: 1, rows: 1, defaultPassage: "pass" }],
    items: [],
    maps: [map("map_a"), map("map_b"), map("map_c")],
  };
}

const SET: WorldWorkingSet = {
  active: "map_a",
  visible: ["map_a"],
  imminent: [
    { mapId: "map_b", portalId: "p1", side: "east", distance: 0, compatibility: "coordinate-preserving" },
    { mapId: "map_c", portalId: "p2", side: "north", distance: 3, compatibility: "portal-only" },
  ],
  parsedKeep: ["map_a", "map_b", "map_c"],
  compiledKeep: ["map_a", "map_b", "map_c"],
};

interface Harness {
  session: Session;
  repository: MapRepository;
  fullAcquires: () => number;
}

function setup(wrap?: (base: MapRepository) => MapRepository): Harness {
  const split = splitProjectMaps(project());
  const files = new Map(split.entries.map((entry) => [entry.meta.id, entry.bytes]));
  const base = createJsonMapRepository(split.shell.mapIndex, {
    read: (entry) => {
      const meta = split.shell.mapIndex.find((m) => m.entry === entry);
      return meta ? files.get(meta.id) : undefined;
    },
  });
  const repository = wrap ? wrap(base) : base;
  const session = createSession(split.shell, 60, repository);
  startSession(split.shell, session);
  let fullAcquires = 0;
  return {
    session,
    repository,
    fullAcquires: () => fullAcquires,
  };
}

describe("createWorldPrefetcher", () => {
  test("stages the compiled keep-set across updates and publishes without a full acquire", () => {
    let fullAcquires = 0;
    const { session } = setup((base) => ({
      meta: base.meta,
      acquire: (id) => { fullAcquires++; return base.acquire(id); },
      acquireStep: base.acquireStep,
      releaseExcept: base.releaseExcept,
    }));
    fullAcquires = 0; // createSession acquires the start map through the wrapper
    let clock = 0;
    const prefetcher = createWorldPrefetcher(session, { budgetMs: 0, now: () => clock });

    // Two maps x four fixed stages (parse, validate, world, passage): with a
    // zero budget exactly one stage runs per update.
    let updates = 0;
    let stats;
    do {
      stats = prefetcher.update(SET);
      expect(stats.stages).toBe(1);
      updates++;
    } while (stats.pending > 0);
    expect(updates).toBe(8);
    expect(prefetcher.update(SET).stages).toBe(0);
    // Staged data stays unpublished until the transfer boundary.
    expect(session.maps.has("map_b")).toBe(false);
    expect(session.maps.has("map_c")).toBe(false);

    acquireSessionMap(session, "map_b");
    acquireSessionMap(session, "map_c");
    expect(fullAcquires).toBe(0); // publish path, no repository acquire
    expect(session.maps.has("map_b")).toBe(true);
  });

  test("a large budget stages everything in one update", () => {
    const { session } = setup();
    const prefetcher = createWorldPrefetcher(session, { budgetMs: 1000, now: () => 0 });
    const stats = prefetcher.update(SET);
    expect(stats.stages).toBe(8);
    expect(stats.pending).toBe(0);
    expect(stats.staged).toBe(2);
  });

  test("records a failing map once, keeps staging the rest, and never throws", () => {
    const fire = (id: string): void => {
      if (id === "map_b") throw new Error("map b shard is on fire");
    };
    const { session } = setup((base) => ({
      meta: base.meta,
      acquire: (id) => { fire(id); return base.acquire(id); },
      acquireStep: (id) => { fire(id); return base.acquireStep!(id); },
      releaseExcept: base.releaseExcept,
    }));
    const prefetcher = createWorldPrefetcher(session, { budgetMs: 1000, now: () => 0 });

    const first = prefetcher.update(SET);
    expect(first.failures.map_b).toBe("map b shard is on fire");
    expect(first.pending).toBe(1); // map_b failed; map_c staged
    expect(session.preparingMaps.has("map_b")).toBe(false);

    // The failure is stable: no retry, no throw, map_c stays staged.
    const second = prefetcher.update(SET);
    expect(second.stages).toBe(0);
    expect(second.failures.map_b).toBe("map b shard is on fire");
    // The stable error surfaces at the real transfer boundary.
    expect(() => acquireSessionMap(session, "map_b")).toThrow("map b shard is on fire");
  });

  test("re-stages a map whose preparation was released by a layered eviction", () => {
    const { session } = setup();
    const prefetcher = createWorldPrefetcher(session, { budgetMs: 1000, now: () => 0 });
    expect(prefetcher.update(SET).staged).toBe(2);

    releaseSessionMapLayers(session, ["map_a"], ["map_a"], "map_a");
    expect(session.preparingMaps.size).toBe(0);
    // The evicted map stages again instead of being treated as ready.
    expect(prefetcher.update(SET).stages).toBe(8);
  });

  test("does no work when the compiled keep-set is just the resident active map", () => {
    const { session } = setup();
    const prefetcher = createWorldPrefetcher(session);
    const stats = prefetcher.update({ ...SET, imminent: [], parsedKeep: ["map_a"], compiledKeep: ["map_a"] });
    expect(stats).toEqual({ staged: 0, pending: 0, stages: 0, failures: {}, stageMs: 0 });
  });

  test("promotes async working-set bytes one hint per zero-budget frame without blocking", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const { session } = setup((base) => ({
      meta: base.meta,
      acquire: base.acquire,
      releaseExcept: base.releaseExcept,
      prefetch: (id) => {
        started.push(id);
        return new Promise<void>((resolve) => { releases.set(id, resolve); });
      },
    }));
    const prefetcher = createWorldPrefetcher(session, { budgetMs: 0, now: () => 0 });

    const first = prefetcher.update(SET);
    expect(first.stages).toBe(1);
    expect(first.pending).toBe(2);
    expect(started).toEqual(["map_b"]);

    releases.get("map_b")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = prefetcher.update(SET);
    expect(second.stages).toBe(1);
    expect(started).toEqual(["map_b", "map_c"]);

    releases.get("map_c")!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prefetcher.update(SET)).toMatchObject({ staged: 2, pending: 0, stages: 0, failures: {} });
    expect(session.maps.has("map_b")).toBe(false);
    expect(session.preparingMaps.has("map_b")).toBe(false);
  });
});
