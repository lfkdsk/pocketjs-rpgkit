// A component-owned replacement for Wander's QuickJS benchmark load.
//
// This uses the real world-bounded fixture and production cache policy:
// twelve placed, sharded maps; seamless playerTouch handoffs; the
// active/visible/imminent working sets; staged compilation; and layered
// parsed/compiled/runtime eviction. Each portal also applies a real
// tileProperty command on a cell outside the walking lane, so the effective
// passage table is rebuilt for that visit and evicted after the handoff.

import { followCamera } from "../src/engine/camera.ts";
import { createJsonMapRepository } from "../src/engine/map-repository.ts";
import {
  createSession,
  sessionPassageTable,
  startSession,
  stepSession,
  type Session,
  type SessionState,
} from "../src/engine/session.ts";
import type { Project, WorldComponent, WorldPlacement } from "../src/engine/types.ts";
import { createWorldHandoffResolver } from "../src/engine/world-handoff.ts";
import {
  createWorldCacheDriver,
  type WorldCacheDriver,
  type WorldCacheStats,
} from "../src/ui/world-cache-driver.ts";
import {
  MAP_IDS,
  WORLD_BOUNDED_PROJECT,
} from "../tests/fixtures/world-bounded/fixture-data.ts";
import { splitProjectMaps } from "./lib/map-project.ts";

const RIGHT = 0x0020;
const LEFT = 0x0080;
const VIEWPORT = { w: 480, h: 272 } as const;

export interface StreamedRoamStats {
  steps: number;
  mapChanges: number;
  handoffTicks: number;
  tablePublishes: number;
  tableEvictions: number;
  runtimeBuilds: number;
  runtimeEvictions: number;
  visitedMaps: number;
  maxMaps: number;
  maxTables: number;
  maxRuntime: number;
  driver: WorldCacheStats;
}

/** Clone the JSON project and make every real portal update one passage
 * cell before transferring. The cell (1,3) is outside the y=1 travel lane,
 * so it exercises recooking without changing the route. */
function benchmarkProject(): Project {
  const project = JSON.parse(JSON.stringify(WORLD_BOUNDED_PROJECT)) as Project;
  for (let mapIndex = 0; mapIndex < project.maps.length; mapIndex++) {
    const map = project.maps[mapIndex]!;
    for (const event of map.events ?? []) {
      const page = event.pages[0];
      if (!page || (event.id !== "east" && event.id !== "west")) continue;
      page.commands.unshift({
        op: "tileProperty",
        x: 1,
        y: 3,
        passage: mapIndex % 2 === 0 ? "block" : "pass",
      });
    }
  }
  return project;
}

function placementOf(component: Readonly<WorldComponent>, mapId: string): Readonly<WorldPlacement> {
  const placement = component.placements.find((entry) => entry.mapId === mapId);
  if (!placement) throw new Error("streamed roam: no placement for " + mapId);
  return placement;
}

export class StreamedRoam {
  readonly session: Session;
  private state: SessionState;
  private readonly component: Readonly<WorldComponent>;
  private readonly cache: WorldCacheDriver;
  private direction = RIGHT;
  private turnFrames = 0;
  private nextDirection = RIGHT;
  private lastTables: Set<string>;
  private lastDriver: WorldCacheStats;
  private readonly visited = new Set<string>();
  private steps = 0;
  private mapChanges = 0;
  private handoffTicks = 0;
  private tablePublishes = 0;
  private tableEvictions = 0;
  private runtimeBuilds = 0;
  private runtimeEvictions = 0;
  private maxMaps = 0;
  private maxTables = 0;
  private maxRuntime = 0;

  constructor() {
    const project = benchmarkProject();
    const split = splitProjectMaps(project);
    const files = new Map(split.entries.map((entry) => [entry.path, entry.bytes]));
    const repository = createJsonMapRepository(split.shell.mapIndex, {
      read: (entry) => files.get(entry),
    });
    const layout = split.shell.worldLayout!;
    this.component = layout.components[0]!;
    this.session = createSession(split.shell, 60, {
      maps: repository,
      handoff: createWorldHandoffResolver(layout),
    });
    this.state = startSession(split.shell, this.session);
    this.lastDriver = {
      active: this.state.mapId,
      visible: [],
      parsedKeep: [this.state.mapId],
      compiledKeep: [this.state.mapId],
      maps: this.session.maps.size,
      worlds: this.session.worlds.size,
      tables: this.session.tables.size,
      staged: 0,
      pending: 0,
      preparing: 0,
      runtime: 0,
      repoCached: 0,
      failures: {},
    };
    this.cache = createWorldCacheDriver(this.session, layout, {
      // A frozen clock lets one sync finish each tiny map's fixed staging
      // units. The work itself is still real; only wall-clock slicing is
      // removed from this deterministic per-frame microbenchmark.
      budgetMs: 1,
      now: () => 0,
      onStats: (stats) => {
        this.lastDriver = stats;
      },
    });
    this.cache.sync(this.state, this.camera(), VIEWPORT);
    this.lastTables = new Set(this.session.tables.keys());
    this.visited.add(this.state.mapId);
    this.sampleMaxima();
  }

  private camera() {
    const placement = placementOf(this.component, this.state.mapId);
    const bounds = this.component.bounds;
    return followCamera(
      placement.originTileX * this.session.cfg.tile + this.state.move.px,
      placement.originTileY * this.session.cfg.tile + this.state.move.py,
      this.session.cfg.tile,
      this.state.move.facing,
      {
        worldX: bounds.minTileX * this.session.cfg.tile,
        worldY: bounds.minTileY * this.session.cfg.tile,
        worldW: (bounds.maxTileX - bounds.minTileX) * this.session.cfg.tile,
        worldH: (bounds.maxTileY - bounds.minTileY) * this.session.cfg.tile,
        viewportW: VIEWPORT.w,
        viewportH: VIEWPORT.h,
      },
    );
  }

  private sampleMaxima(): void {
    this.maxMaps = Math.max(this.maxMaps, this.session.maps.size);
    this.maxTables = Math.max(this.maxTables, this.session.tables.size);
    this.maxRuntime = Math.max(this.maxRuntime, this.session.runtimeTables.size);
  }

  private countTableChurn(): void {
    const current = new Set(this.session.tables.keys());
    for (const id of current) if (!this.lastTables.has(id)) this.tablePublishes++;
    for (const id of this.lastTables) if (!current.has(id)) this.tableEvictions++;
    this.lastTables = current;
  }

  step(): number {
    const previousMap = this.state.mapId;
    this.state = stepSession(this.session, this.state, { buttons: this.direction });
    this.steps++;
    if (this.state.handoff) this.handoffTicks++;

    // A tileProperty command produces a new immutable override record. Force
    // the same effective-table read movement/pathfinding uses and count only
    // the first derived view for this map visit.
    const hadRuntime = this.session.runtimeTables.has(this.state.mapId);
    sessionPassageTable(this.session, this.state);
    if (!hadRuntime && this.session.runtimeTables.has(this.state.mapId)) {
      this.runtimeBuilds++;
    }

    const runtimeBeforeSync = this.session.runtimeTables.size;
    this.cache.sync(this.state, this.camera(), VIEWPORT);
    if (this.session.runtimeTables.size < runtimeBeforeSync) {
      this.runtimeEvictions += runtimeBeforeSync - this.session.runtimeTables.size;
    }

    const mapChanged = this.state.mapId !== previousMap;
    if (mapChanged) {
      this.mapChanges++;
      this.visited.add(this.state.mapId);
      this.countTableChurn();
      // A seamless arrival occupies the target portal cell. Keep walking
      // inward for one tile before reversing at either end, otherwise a
      // playerTouch page cannot retrigger from the cell it already occupies.
      if (this.state.mapId === MAP_IDS[MAP_IDS.length - 1] && this.direction === RIGHT) {
        this.turnFrames = 8;
        this.nextDirection = LEFT;
      } else if (this.state.mapId === MAP_IDS[0] && this.direction === LEFT) {
        this.turnFrames = 8;
        this.nextDirection = RIGHT;
      }
    } else if (this.turnFrames > 0 && --this.turnFrames === 0) {
      this.direction = this.nextDirection;
    }
    this.sampleMaxima();

    const mapIndex = MAP_IDS.indexOf(this.state.mapId);
    return (
      this.state.frame ^
      (mapIndex << 8) ^
      (this.session.maps.size << 16) ^
      (this.session.tables.size << 20) ^
      (this.session.runtimeTables.size << 24)
    ) | 0;
  }

  stats(): StreamedRoamStats {
    return {
      steps: this.steps,
      mapChanges: this.mapChanges,
      handoffTicks: this.handoffTicks,
      tablePublishes: this.tablePublishes,
      tableEvictions: this.tableEvictions,
      runtimeBuilds: this.runtimeBuilds,
      runtimeEvictions: this.runtimeEvictions,
      visitedMaps: this.visited.size,
      maxMaps: this.maxMaps,
      maxTables: this.maxTables,
      maxRuntime: this.maxRuntime,
      driver: this.lastDriver,
    };
  }
}
