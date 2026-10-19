// The authored RPG Maker MV/MZ fixture projects (tests/fixtures/rpgmaker):
// the committed bytes are exactly what gen-fixtures.ts writes, and the data
// is shaped the way the MV/MZ runtime and editor expect (map planes, event
// ids, stored autotile shapes, sheet geometry, well-formed command lists,
// resolvable references). The walkthrough paths in the README are checked
// against the tile passage flags with the runtime's checkPassage rule.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAutotile, reshapeAutotiles } from "../tools/rpgmaker-import/autotile.ts";
import type {
  RmActor,
  RmCommand,
  RmCommonEvent,
  RmEventPage,
  RmItem,
  RmMap,
  RmMapInfo,
  RmMoveRoute,
  RmSystem,
  RmTileset,
  RmTroop,
} from "../tools/rpgmaker-import/rm-types.ts";
import { FIXTURE_PROJECTS, generateFixtures } from "./fixtures/rpgmaker/gen-fixtures.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "rpgmaker");

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function pngSize(path: string): [number, number] {
  const b = readFileSync(path);
  expect(b.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(b.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

interface Project {
  root: string;
  system: RmSystem;
  mapInfos: (RmMapInfo | null)[];
  maps: Map<number, RmMap>;
  tilesets: (RmTileset | null)[];
  commonEvents: (RmCommonEvent | null)[];
  items: (RmItem | null)[];
  weapons: (RmItem | null)[];
  armors: (RmItem | null)[];
  actors: (RmActor | null)[];
  troops: (RmTroop | null)[];
  animations: ({ id: number; name: string } | null)[];
}

function load(name: string): Project {
  const root = join(FIXTURES, name);
  const data = (file: string) => join(root, "data", file);
  const mapInfos = readJson<(RmMapInfo | null)[]>(data("MapInfos.json"));
  const maps = new Map<number, RmMap>();
  for (const info of mapInfos) {
    if (info) maps.set(info.id, readJson<RmMap>(data(`Map${String(info.id).padStart(3, "0")}.json`)));
  }
  return {
    root,
    system: readJson(data("System.json")),
    mapInfos,
    maps,
    tilesets: readJson(data("Tilesets.json")),
    commonEvents: readJson(data("CommonEvents.json")),
    items: readJson(data("Items.json")),
    weapons: readJson(data("Weapons.json")),
    armors: readJson(data("Armors.json")),
    actors: readJson(data("Actors.json")),
    troops: readJson(data("Troops.json")),
    animations: readJson(data("Animations.json")),
  };
}

/** Every command list in a project with a label for messages. */
function allLists(p: Project): { where: string; list: RmCommand[] }[] {
  const out: { where: string; list: RmCommand[] }[] = [];
  for (const [id, map] of p.maps) {
    for (const ev of map.events) {
      if (!ev) continue;
      ev.pages.forEach((pg, i) => out.push({ where: `map ${id} event ${ev.id} page ${i + 1}`, list: pg.list }));
    }
  }
  for (const ce of p.commonEvents) if (ce) out.push({ where: `common event ${ce.id}`, list: ce.list });
  return out;
}

function allPages(p: Project): { mapId: number; page: RmEventPage }[] {
  const out: { mapId: number; page: RmEventPage }[] = [];
  for (const [mapId, map] of p.maps) for (const ev of map.events) if (ev) for (const page of ev.pages) out.push({ mapId, page });
  return out;
}

// Commands whose body follows one indent deeper.
const BODY_OPENERS = new Set([111, 112, 402, 403, 411, 601, 602, 603]);
// Continuation lines and the commands they may follow.
const CONTINUES: Record<number, number[]> = {
  401: [101, 401],
  402: [102, 0],
  403: [0],
  404: [0],
  408: [108, 408],
  411: [0],
  412: [0],
  413: [0],
  505: [205, 505],
  601: [301],
  602: [0],
  603: [0],
  604: [0],
  605: [302, 605],
  655: [355, 655],
  657: [357, 657],
};

/** Structural problems in one command list (empty when well formed). */
function listProblems(list: RmCommand[]): string[] {
  const bad: string[] = [];
  const last = list[list.length - 1];
  if (!last || last.code !== 0 || last.indent !== 0) bad.push("does not end with code 0 at indent 0");
  list.forEach((c, i) => {
    const prev = list[i - 1];
    if (!Array.isArray(c.parameters)) bad.push(`#${i} code ${c.code} has no parameter array`);
    if (!prev) {
      if (c.indent !== 0) bad.push(`#0 starts at indent ${c.indent}`);
      return;
    }
    if (c.indent > prev.indent && !(c.indent === prev.indent + 1 && BODY_OPENERS.has(prev.code))) {
      bad.push(`#${i} code ${c.code} indents after code ${prev.code}`);
    }
    if (c.indent < prev.indent && !(prev.code === 0 && c.indent === prev.indent - 1)) {
      bad.push(`#${i} code ${c.code} dedents without closing the body`);
    }
    const allowed = CONTINUES[c.code];
    if (allowed && !allowed.includes(prev.code)) bad.push(`#${i} code ${c.code} follows code ${prev.code}`);
    if (c.code === 205) {
      const r = c.parameters[1] as RmMoveRoute;
      const lines = list.slice(i + 1).findIndex((n) => n.code !== 505);
      if (lines !== r.list.length - 1) bad.push(`#${i} route has ${r.list.length - 1} moves but ${lines} 505 lines`);
    }
  });
  return bad;
}

/** Game_Map.checkPassage: the topmost non-star tile decides. */
function passage(map: RmMap, flags: number[], x: number, y: number, bit: number): boolean {
  for (let z = 3; z >= 0; z--) {
    const flag = flags[map.data[(z * map.height + y) * map.width + x]!]!;
    if (flag & 0x10) continue;
    if ((flag & bit) === 0) return true;
    if ((flag & bit) === bit) return false;
  }
  return false;
}

const STEP: Record<string, [number, number, number]> = {
  D: [0, 1, 2],
  L: [-1, 0, 4],
  R: [1, 0, 6],
  U: [0, -1, 8],
};
const reverse = (d: number): number => 10 - d;
const dirBit = (d: number): number => (1 << (d / 2 - 1)) & 0x0f;

/** Walk `moves` (e.g. "UUUR") from (x, y) by tile passage alone; returns the
 *  end position or throws at the first blocked step. */
function walkTiles(p: Project, mapId: number, x: number, y: number, moves: string): [number, number] {
  const map = p.maps.get(mapId)!;
  const flags = p.tilesets[map.tilesetId]!.flags;
  for (const m of moves) {
    const [dx, dy, d] = STEP[m]!;
    const nx = x + dx;
    const ny = y + dy;
    const ok =
      nx >= 0 && ny >= 0 && nx < map.width && ny < map.height &&
      passage(map, flags, x, y, dirBit(d)) && passage(map, flags, nx, ny, dirBit(reverse(d)));
    if (!ok) throw new Error(`map ${mapId}: blocked moving ${m} from (${x}, ${y})`);
    x = nx;
    y = ny;
  }
  return [x, y];
}

const eventAt = (p: Project, mapId: number, x: number, y: number) =>
  p.maps.get(mapId)!.events.find((e) => e && e.x === x && e.y === y) ?? null;

// The README walkthrough legs: [map, from x, from y, moves, to x, to y].
const WALKS: Record<string, [number, number, number, string, number, number][]> = {
  "hollow-mz": [
    [1, 11, 9, "R", 12, 9], // to the elder
    [1, 12, 9, "LUUU", 11, 6], // to the house door (the next Up bumps the door)
    [2, 6, 8, "UUUU", 6, 4], // to the chest
    [2, 6, 4, "DDRRR", 9, 6], // optional: the counter in front of the shopkeeper
    [2, 6, 4, "DDDDD", 6, 9], // onto the exit mat
    [1, 11, 6, "DDDDRRRRRRRRUUU", 19, 7], // to the guard's side of the gate
    [1, 19, 7, "UUUUUUU", 19, 0], // through the open gate onto the cave mouth
    [3, 10, 13, "UUUUUUUU", 10, 5], // up to the golem
    [3, 10, 5, "DDDDDDDDD", 10, 14], // back onto the cave exit
    [1, 19, 1, "DDDDDDDDDLLLLLL", 13, 10], // back below the elder
  ],
  "stage-mv": [
    [1, 8, 10, "UU", 8, 8], // the cutscene's player route
    [1, 8, 8, "DDRRRRR", 13, 10], // to the usher
  ],
  "sideview-mz": [
    [1, 11, 9, "R", 12, 9], // the copied authored Hollow map
    [1, 12, 9, "LUUU", 11, 6],
  ],
};

test("regenerating the fixtures reproduces the committed files byte for byte", () => {
  const out = mkdtempSync(join(tmpdir(), "rpgkit-rm-fixtures-"));
  temporary.push(out);
  const written = generateFixtures(out);
  expect(written.length).toBeGreaterThan(40);
  for (const name of FIXTURE_PROJECTS) {
    const committed = walk(join(FIXTURES, name));
    expect(walk(join(out, name))).toEqual(committed);
    const differing = committed.filter(
      (rel) => !readFileSync(join(FIXTURES, name, rel)).equals(readFileSync(join(out, name, rel))),
    );
    expect(differing).toEqual([]);
  }
});

for (const name of FIXTURE_PROJECTS) {
  describe(name, () => {
    const p = load(name);
    const ts = p.system.tileSize ?? 48;

    test("flavour markers", () => {
      if (name !== "stage-mv") {
        expect(p.system.tileSize).toBe(16);
        expect(p.system.advanced).toBeDefined();
        expect(existsSync(join(p.root, "game.rmmzproject"))).toBe(true);
        expect(p.system.optSideView).toBe(name === "sideview-mz");
      } else {
        expect(p.system.tileSize).toBeUndefined();
        expect(p.system.advanced).toBeUndefined();
        expect(existsSync(join(p.root, "Game.rpgproject"))).toBe(true);
      }
    });

    test("the start map exists and the start position is on it", () => {
      const { startMapId, startX, startY } = p.system;
      expect(p.mapInfos[startMapId]?.id).toBe(startMapId);
      const map = p.maps.get(startMapId)!;
      expect(map).toBeDefined();
      expect(startX).toBeGreaterThanOrEqual(0);
      expect(startY).toBeGreaterThanOrEqual(0);
      expect(startX).toBeLessThan(map.width);
      expect(startY).toBeLessThan(map.height);
    });

    test("database arrays are id-indexed with a null head", () => {
      const tables: ({ id: number } | null)[][] = [
        p.mapInfos, p.tilesets, p.commonEvents, p.items, p.weapons, p.armors, p.actors, p.troops, p.animations,
      ];
      for (const t of tables) {
        expect(t[0]).toBeNull();
        t.forEach((r, i) => {
          if (r) expect(r.id).toBe(i);
        });
      }
    });

    test("every map's data holds six planes of in-range values", () => {
      for (const [id, map] of p.maps) {
        expect(map.width).toBeLessThanOrEqual(30);
        expect(map.height).toBeLessThanOrEqual(20);
        const plane = map.width * map.height;
        expect(map.data.length, `map ${id}`).toBe(6 * plane);
        map.data.forEach((v, i) => {
          const z = Math.floor(i / plane);
          const max = z < 4 ? 8191 : z === 4 ? 15 : 255;
          if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`map ${id} data[${i}] = ${v} (z ${z})`);
        });
      }
    });

    test("every event id indexes its array and sits on the map", () => {
      for (const [id, map] of p.maps) {
        expect(map.events[0]).toBeNull();
        map.events.forEach((ev, i) => {
          if (!ev) return;
          expect(ev.id, `map ${id}`).toBe(i);
          expect(ev.pages.length).toBeGreaterThan(0);
          expect(ev.x >= 0 && ev.y >= 0 && ev.x < map.width && ev.y < map.height).toBe(true);
        });
      }
    });

    test("stored autotile shapes are the ones the editor computes", () => {
      for (const [id, map] of p.maps) {
        expect(map.data.some(isAutotile), `map ${id} uses autotiles`).toBe(true);
        expect(reshapeAutotiles(map.data, map.width, map.height), `map ${id}`).toEqual(map.data);
      }
    });

    test("every tile id a map uses has a sheet image and a flag table", () => {
      for (const [id, map] of p.maps) {
        const tileset = p.tilesets[map.tilesetId]!;
        expect(tileset.flags.length).toBe(8192);
        expect(tileset.flags[0]! & 0x10).toBe(0x10);
        const plane = map.width * map.height;
        for (let i = 0; i < plane * 4; i++) {
          const t = map.data[i]!;
          if (t === 0) continue;
          const slot =
            t >= 5888 ? 3 : t >= 4352 ? 2 : t >= 2816 ? 1 : t >= 2048 ? 0 : t >= 1536 ? 4 : 5 + Math.floor(t / 256);
          expect(tileset.tilesetNames[slot], `map ${id} tile ${t}`).not.toBe("");
        }
      }
    });

    test("every image has the geometry its sheet slot requires", () => {
      const k = ts / 48;
      const SLOT_48: [number, number][] = [
        [768, 576], [768, 576], [768, 384], [768, 720], [384, 768],
        [768, 768], [768, 768], [768, 768], [768, 768],
      ];
      const usedSheets = new Set(p.tilesets.filter((t) => t !== null).map((t) => t.tilesetNames));
      for (const names of usedSheets) {
        names.forEach((n, slot) => {
          if (!n) return;
          const [w, h] = SLOT_48[slot]!;
          expect(pngSize(join(p.root, "img", "tilesets", `${n}.png`)), n).toEqual([w * k, h * k]);
        });
      }
      const characters = new Set<string>();
      for (const a of p.actors) if (a?.characterName) characters.add(a.characterName);
      for (const { page } of allPages(p)) {
        if (page.image.characterName) characters.add(page.image.characterName);
        for (const m of page.moveRoute.list) if (m.code === 41) characters.add(m.parameters![0] as string);
      }
      for (const { list } of allLists(p)) {
        for (const c of list) {
          if (c.code !== 205) continue;
          for (const m of (c.parameters[1] as RmMoveRoute).list) if (m.code === 41) characters.add(m.parameters![0] as string);
        }
      }
      expect(characters.size).toBeGreaterThan(1);
      let singles = 0;
      for (const n of characters) {
        const single = /^[!$]+/.exec(n)?.[0].includes("$") ?? false;
        if (single) singles++;
        const size = pngSize(join(p.root, "img", "characters", `${n}.png`));
        expect(size, n).toEqual(single ? [3 * ts, 4 * ts] : [12 * ts, 8 * ts]);
      }
      expect(singles).toBeGreaterThan(0);
      expect(pngSize(join(p.root, "img", "system", "Balloon.png"))).toEqual([8 * ts, 15 * ts]);
      const screen: [number, number] = [p.system.advanced?.screenWidth ?? 816, p.system.advanced?.screenHeight ?? 624];
      for (const { list } of allLists(p)) {
        for (const c of list) {
          if (c.code === 231) expect(pngSize(join(p.root, "img", "pictures", `${c.parameters[1]}.png`))).toEqual(screen);
        }
      }
    });

    test("command lists are well formed", () => {
      const problems = allLists(p).flatMap(({ where, list }) => listProblems(list).map((b) => `${where}: ${b}`));
      expect(problems).toEqual([]);
    });

    test("references resolve", () => {
      const bad: string[] = [];
      const need = (ok: boolean, what: string) => {
        if (!ok) bad.push(what);
      };
      for (const { where, list } of allLists(p)) {
        for (const c of list) {
          const q = c.parameters;
          switch (c.code) {
            case 201: {
              const map = p.maps.get(q[1] as number);
              need(!!map && (q[2] as number) < map.width && (q[3] as number) < map.height, `${where}: transfer ${q}`);
              break;
            }
            case 117: need(!!p.commonEvents[q[0] as number], `${where}: common event ${q[0]}`); break;
            case 126: need(!!p.items[q[0] as number], `${where}: item ${q[0]}`); break;
            case 129: case 303: need(!!p.actors[q[0] as number], `${where}: actor ${q[0]}`); break;
            case 301: need(!!p.troops[q[1] as number], `${where}: troop ${q[1]}`); break;
            case 212: need(!!p.animations[q[1] as number], `${where}: animation ${q[1]}`); break;
            case 302: case 605: {
              const table = [p.items, p.weapons, p.armors][q[0] as number]!;
              need(!!table[q[1] as number], `${where}: goods ${q}`);
              break;
            }
          }
        }
      }
      for (const { mapId, page } of allPages(p)) {
        if (page.conditions.itemValid) need(!!p.items[page.conditions.itemId], `map ${mapId}: page item`);
      }
      for (const ce of p.commonEvents) if (ce && ce.trigger !== 0) need(ce.switchId > 0, `common event ${ce.id} switch`);
      expect(bad).toEqual([]);
    });

    test("the README walkthrough legs are walkable by tile passage", () => {
      for (const [mapId, x, y, moves, tx, ty] of WALKS[name]!) {
        expect(walkTiles(p, mapId, x, y, moves)).toEqual([tx, ty]);
      }
    });

    if (name !== "stage-mv") {
      test("walkthrough landmarks", () => {
        expect([p.system.startX, p.system.startY]).toEqual([11, 9]);
        expect(eventAt(p, 1, 13, 9)?.name).toBe("Elder");
        expect(eventAt(p, 1, 11, 5)?.name).toBe("House Door");
        expect(eventAt(p, 2, 6, 3)?.name).toBe("Chest");
        expect(eventAt(p, 2, 6, 9)?.name).toBe("Exit");
        expect(eventAt(p, 2, 9, 4)?.name).toBe("Shopkeeper");
        expect(eventAt(p, 1, 18, 7)?.name).toBe("Guard");
        expect(eventAt(p, 1, 19, 6)?.name).toBe("Gate");
        expect(eventAt(p, 1, 19, 0)?.name).toBe("To Cave");
        expect(eventAt(p, 3, 10, 4)?.name).toBe("Golem");
        expect(eventAt(p, 3, 10, 14)?.name).toBe("Exit");
        // The shop still carries an RPG Maker counter tile beside its
        // service opening, exercising the flag without requiring its
        // cross-counter action-button rule in the imported journey.
        const house = p.maps.get(2)!;
        const counter = house.data[4 * house.width + 8]!;
        expect(p.tilesets[house.tilesetId]!.flags[counter]! & 0x80).toBe(0x80);
        // The fence blocks only the crossing of its bottom edge.
        expect(() => walkTiles(p, 1, 17, 7, "U")).toThrow();
        expect(walkTiles(p, 1, 16, 5, "D")).toEqual([16, 6]);
        expect(walkTiles(p, 1, 16, 6, "R")).toEqual([17, 6]);
      });
    } else {
      test("walkthrough landmarks", () => {
        expect([p.system.startX, p.system.startY]).toEqual([8, 10]);
        expect(eventAt(p, 1, 14, 10)?.name).toBe("Usher");
        expect(p.maps.get(1)!.events[1]!.pages[0]!.trigger).toBe(3);
      });
    }
  });
}
